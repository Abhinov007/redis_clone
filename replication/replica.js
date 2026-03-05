// replication/replica.js

const net = require("net");
const database = require("../storage/database");
const { loadRDBFromBuffer } = require("../persistence/rdb");
const RESPParser = require("../RESPParser");
const handleCommand = require("../commands/command");

// ─── State ────────────────────────────────────────────────────────────────────

let masterSocket = null;
let masterHost = null;
let masterPort = null;
let reconnectTimer = null;
let ackInterval = null;

// Replication state (persisted across reconnects for partial resync)
let masterReplId = null;     // saved from FULLRESYNC/CONTINUE
let replicaOffset = 0;       // bytes of RESP commands consumed

// Sync state machine
// WAIT_WELCOME → REPLCONF_PORT → REPLCONF_CAPA → PSYNC → WAIT_SYNC_RESPONSE
//   → (FULLRESYNC path: WAIT_RDB_LEN → WAIT_RDB_DATA)
//   → (CONTINUE path: straight to STREAMING)
//   → STREAMING
let syncState = "WAIT_WELCOME";
let rdbExpectedLen = -1;
let rdbBuffer = "";

const RECONNECT_DELAY_MS = 3000;
const ACK_INTERVAL_MS = 1000;
let localPort = null; // our listening port (set from server.js)

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the replica — connect to the master and begin replication.
 * @param {string} host - Master hostname
 * @param {number} port - Master port
 * @param {number} [myPort] - This server's listening port (for REPLCONF)
 */
function startReplica(host, port, myPort) {
    masterHost = host;
    masterPort = port;
    localPort = myPort || 0;
    connectToMaster();
}

// ─── Connection ───────────────────────────────────────────────────────────────

function connectToMaster() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ackInterval) {
        clearInterval(ackInterval);
        ackInterval = null;
    }

    syncState = "WAIT_WELCOME";
    rdbExpectedLen = -1;
    rdbBuffer = "";

    console.log(`[replica] Connecting to master at ${masterHost}:${masterPort}...`);

    masterSocket = net.createConnection({ host: masterHost, port: masterPort }, () => {
        console.log("[replica] Connected to master.");
    });

    masterSocket.on("data", handleMasterData);

    masterSocket.on("error", (err) => {
        console.error("[replica] Connection error:", err.message);
    });

    masterSocket.on("close", () => {
        console.log("[replica] Disconnected from master.");
        if (ackInterval) {
            clearInterval(ackInterval);
            ackInterval = null;
        }
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`[replica] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToMaster();
    }, RECONNECT_DELAY_MS);
}

// ─── RESP Encoder ─────────────────────────────────────────────────────────────

function encodeRESP(args) {
    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
        const str = String(arg);
        resp += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return resp;
}

// ─── Data Handler (state machine) ─────────────────────────────────────────────

let lineBuffer = "";
const respParser = new RESPParser();

function handleMasterData(data) {
    const chunk = data.toString();

    // During sync phases, use line-based parsing
    if (syncState !== "STREAMING") {
        lineBuffer += chunk;
        processLineBuffer();
        return;
    }

    // During streaming, parse RESP commands
    applyReplicatedCommands(chunk);
}

function processLineBuffer() {
    while (true) {
        const nlIndex = lineBuffer.indexOf("\r\n");
        if (nlIndex === -1) break;

        const line = lineBuffer.slice(0, nlIndex);
        lineBuffer = lineBuffer.slice(nlIndex + 2);

        // ── WAIT_WELCOME ──
        if (syncState === "WAIT_WELCOME") {
            console.log("[replica] Master says:", line);
            syncState = "REPLCONF_PORT";

            // Step 1: Send REPLCONF listening-port
            masterSocket.write(encodeRESP(["REPLCONF", "listening-port", String(localPort)]));
            console.log(`[replica] Sent REPLCONF listening-port ${localPort}`);
            continue;
        }

        // ── REPLCONF_PORT — waiting for +OK ──
        if (syncState === "REPLCONF_PORT") {
            if (line === "+OK") {
                syncState = "REPLCONF_CAPA";

                // Step 2: Send REPLCONF capa psync2
                masterSocket.write(encodeRESP(["REPLCONF", "capa", "psync2"]));
                console.log("[replica] Sent REPLCONF capa psync2");
            } else {
                console.error("[replica] Unexpected response (expected +OK for listening-port):", line);
            }
            continue;
        }

        // ── REPLCONF_CAPA — waiting for +OK ──
        if (syncState === "REPLCONF_CAPA") {
            if (line === "+OK") {
                syncState = "WAIT_SYNC_RESPONSE";

                // Step 3: Send PSYNC
                const psyncReplId = masterReplId || "?";
                const psyncOffset = masterReplId ? String(replicaOffset) : "-1";

                masterSocket.write(encodeRESP(["PSYNC", psyncReplId, psyncOffset]));
                console.log(`[replica] Sent PSYNC ${psyncReplId} ${psyncOffset}`);
            } else {
                console.error("[replica] Unexpected response (expected +OK for capa):", line);
            }
            continue;
        }

        // ── WAIT_SYNC_RESPONSE — expecting +FULLRESYNC or +CONTINUE ──
        if (syncState === "WAIT_SYNC_RESPONSE") {
            if (line.startsWith("+FULLRESYNC")) {
                // Full resync path
                const parts = line.split(" ");
                masterReplId = parts[1];
                replicaOffset = parseInt(parts[2], 10) || 0;
                console.log(`[replica] FULLRESYNC — replid=${masterReplId}, offset=${replicaOffset}`);
                syncState = "WAIT_RDB_LEN";
            } else if (line.startsWith("+CONTINUE")) {
                // Partial resync — no RDB transfer needed!
                const parts = line.split(" ");
                if (parts[1]) masterReplId = parts[1];
                console.log(`[replica] CONTINUE — partial resync! replid=${masterReplId}, offset=${replicaOffset}`);

                // Go straight to streaming
                syncState = "STREAMING";
                startAckHeartbeat();
                console.log("[replica] Partial sync complete. Now streaming commands from master.");

                // Any remaining data in lineBuffer is RESP commands
                if (lineBuffer.length > 0) {
                    const remaining = lineBuffer;
                    lineBuffer = "";
                    applyReplicatedCommands(remaining);
                }
                return;
            } else {
                console.error("[replica] Unexpected sync response:", line);
            }
            continue;
        }

        // ── WAIT_RDB_LEN — expecting "$<length>" ──
        if (syncState === "WAIT_RDB_LEN") {
            if (line.startsWith("$")) {
                rdbExpectedLen = parseInt(line.slice(1), 10);
                rdbBuffer = "";
                console.log(`[replica] Expecting RDB snapshot of ${rdbExpectedLen} bytes.`);

                if (rdbExpectedLen === 0) {
                    console.log("[replica] Empty snapshot — starting with empty database.");
                    syncState = "STREAMING";
                    startAckHeartbeat();
                    console.log("[replica] Sync complete. Now streaming commands from master.");

                    if (lineBuffer.length > 0) {
                        const remaining = lineBuffer;
                        lineBuffer = "";
                        applyReplicatedCommands(remaining);
                    }
                } else {
                    syncState = "WAIT_RDB_DATA";
                    if (lineBuffer.length > 0) {
                        rdbBuffer += lineBuffer;
                        lineBuffer = "";
                        checkRDBComplete();
                    }
                }
            } else {
                console.error("[replica] Unexpected response (expected $<len>):", line);
            }
            return; // stop processing lines — remaining data is binary RDB
        }
    }

    // ── WAIT_RDB_DATA — accumulate raw RDB bytes ──
    if (syncState === "WAIT_RDB_DATA" && lineBuffer.length > 0) {
        rdbBuffer += lineBuffer;
        lineBuffer = "";
        checkRDBComplete();
    }
}

function checkRDBComplete() {
    if (rdbBuffer.length >= rdbExpectedLen) {
        const snapshotData = rdbBuffer.slice(0, rdbExpectedLen);
        let remaining = rdbBuffer.slice(rdbExpectedLen);

        // Strip trailing \r\n sent by master after RDB data
        if (remaining.startsWith("\r\n")) {
            remaining = remaining.slice(2);
        }

        // Clear and load the snapshot
        database.clearDatabase();
        loadRDBFromBuffer(snapshotData, database.getAll());
        console.log("[replica] RDB snapshot loaded successfully.");

        // Transition to streaming
        syncState = "STREAMING";
        startAckHeartbeat();
        console.log("[replica] Sync complete. Now streaming commands from master.");

        // Any leftover data is RESP commands
        if (remaining.length > 0) {
            applyReplicatedCommands(remaining);
        }
    }
}

// ─── ACK Heartbeat ────────────────────────────────────────────────────────────

function startAckHeartbeat() {
    if (ackInterval) clearInterval(ackInterval);

    ackInterval = setInterval(() => {
        if (masterSocket && !masterSocket.destroyed) {
            masterSocket.write(encodeRESP(["REPLCONF", "ACK", String(replicaOffset)]));
        }
    }, ACK_INTERVAL_MS);

    console.log(`[replica] ACK heartbeat started (every ${ACK_INTERVAL_MS}ms)`);
}

// ─── Apply Replicated Commands ────────────────────────────────────────────────

function applyReplicatedCommands(chunk) {
    // Track the byte length for offset calculation
    const chunkByteLen = Buffer.byteLength(chunk);

    const commands = respParser.push(chunk);

    for (const args of commands) {
        if (!Array.isArray(args) || args.length === 0) continue;

        const cmd = args[0].toUpperCase();
        console.log("[replica] Applying replicated command:", args.join(" "));

        // Create a fake socket so handleCommand doesn't crash
        const fakeSocket = {
            write: () => {},
            isReplica: true,
            tx: { active: false, queue: [] }
        };

        try {
            handleCommand(args, fakeSocket);
        } catch (err) {
            console.error("[replica] Error applying command:", cmd, err.message);
        }
    }

    // Update offset by the byte length of the data we consumed
    replicaOffset += chunkByteLen;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    startReplica,
};