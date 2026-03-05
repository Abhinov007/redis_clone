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

// Sync state machine: WAIT_WELCOME → WAIT_OK → WAIT_FULLRESYNC → WAIT_RDB → STREAMING
let syncState = "WAIT_WELCOME";
let rdbExpectedLen = -1;
let rdbBuffer = "";

const RECONNECT_DELAY_MS = 3000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the replica — connect to the master and begin replication.
 */
function startReplica(host, port) {
    masterHost = host;
    masterPort = port;
    connectToMaster();
}

// ─── Connection ───────────────────────────────────────────────────────────────

function connectToMaster() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
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

// ─── RESP encoder (for sending commands to master) ────────────────────────────

function encodeRESP(args) {
    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
        const str = String(arg);
        resp += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return resp;
}

// ─── Data handler (state machine) ─────────────────────────────────────────────

let lineBuffer = "";
const respParser = new RESPParser();

function handleMasterData(data) {
    const chunk = data.toString();

    // ── Phase 1-3: Line-based protocol (welcome, +OK, +FULLRESYNC, $len) ──
    if (syncState !== "STREAMING") {
        lineBuffer += chunk;
        processLineBuffer();
        return;
    }

    // ── Phase 4: STREAMING — parse RESP commands from master ──
    applyReplicatedCommands(chunk);
}

function processLineBuffer() {
    while (true) {
        const nlIndex = lineBuffer.indexOf("\r\n");
        if (nlIndex === -1) break;

        const line = lineBuffer.slice(0, nlIndex);
        lineBuffer = lineBuffer.slice(nlIndex + 2);

        // ── WAIT_WELCOME: consume "+Welcome to Redis clone!" ──
        if (syncState === "WAIT_WELCOME") {
            console.log("[replica] Master says:", line);
            syncState = "WAIT_OK";

            // Send REPLICAOF to register as a replica
            masterSocket.write(encodeRESP(["REPLICAOF", masterHost, String(masterPort)]));
            console.log("[replica] Sent REPLICAOF to master.");
            continue;
        }

        // ── WAIT_OK: consume "+OK" ──
        if (syncState === "WAIT_OK") {
            if (line === "+OK") {
                console.log("[replica] Master accepted REPLICAOF.");
                syncState = "WAIT_FULLRESYNC";
            } else {
                console.error("[replica] Unexpected response (expected +OK):", line);
            }
            continue;
        }

        // ── WAIT_FULLRESYNC: consume "+FULLRESYNC <replid> <offset>" ──
        if (syncState === "WAIT_FULLRESYNC") {
            if (line.startsWith("+FULLRESYNC")) {
                const parts = line.split(" ");
                console.log(`[replica] FULLRESYNC — replid=${parts[1]}, offset=${parts[2]}`);
                syncState = "WAIT_RDB_LEN";
            } else {
                console.error("[replica] Unexpected response (expected +FULLRESYNC):", line);
            }
            continue;
        }

        // ── WAIT_RDB_LEN: consume "$<length>" ──
        if (syncState === "WAIT_RDB_LEN") {
            if (line.startsWith("$")) {
                rdbExpectedLen = parseInt(line.slice(1), 10);
                rdbBuffer = "";
                console.log(`[replica] Expecting RDB snapshot of ${rdbExpectedLen} bytes.`);

                if (rdbExpectedLen === 0) {
                    // Empty snapshot
                    console.log("[replica] Empty snapshot — starting with empty database.");
                    syncState = "STREAMING";
                    console.log("[replica] Sync complete. Now streaming commands from master.");
                    // Any remaining data in lineBuffer is RESP commands
                    if (lineBuffer.length > 0) {
                        const remaining = lineBuffer;
                        lineBuffer = "";
                        applyReplicatedCommands(remaining);
                    }
                } else {
                    syncState = "WAIT_RDB_DATA";
                    // Whatever is left in lineBuffer is part of the RDB data
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

    // ── WAIT_RDB_DATA: accumulate raw RDB bytes ──
    if (syncState === "WAIT_RDB_DATA" && lineBuffer.length > 0) {
        rdbBuffer += lineBuffer;
        lineBuffer = "";
        checkRDBComplete();
    }
}

function checkRDBComplete() {
    if (rdbBuffer.length >= rdbExpectedLen) {
        // Extract exactly rdbExpectedLen bytes
        const snapshotData = rdbBuffer.slice(0, rdbExpectedLen);
        let remaining = rdbBuffer.slice(rdbExpectedLen);

        // The master sends \r\n after the RDB data — strip it
        if (remaining.startsWith("\r\n")) {
            remaining = remaining.slice(2);
        }

        // Clear and load the snapshot into the local database
        database.clearDatabase();
        loadRDBFromBuffer(snapshotData, database.getAll());
        console.log("[replica] RDB snapshot loaded successfully.");

        // Transition to streaming
        syncState = "STREAMING";
        console.log("[replica] Sync complete. Now streaming commands from master.");

        // Any leftover data is RESP commands
        if (remaining.length > 0) {
            applyReplicatedCommands(remaining);
        }
    }
}

// ─── Apply replicated write commands ──────────────────────────────────────────

function applyReplicatedCommands(chunk) {
    const commands = respParser.push(chunk);

    for (const args of commands) {
        if (!Array.isArray(args) || args.length === 0) continue;

        const cmd = args[0].toUpperCase();
        console.log("[replica] Applying replicated command:", args.join(" "));

        // Create a fake socket so handleCommand doesn't crash
        // (it may try to write a response back — we discard it)
        const fakeSocket = {
            write: () => {},       // discard responses
            isReplica: true,
            tx: { active: false, queue: [] }
        };

        try {
            handleCommand(args, fakeSocket);
        } catch (err) {
            console.error("[replica] Error applying command:", cmd, err.message);
        }
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    startReplica,
};