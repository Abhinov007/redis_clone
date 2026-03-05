// replication/master.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Master Replication State ─────────────────────────────────────────────────

let masterReplId = null;
let masterReplOffset = 0;

// Replica tracking
const replicas = new Map(); // socket → { offset, listeningPort, capabilities }

// Replication backlog
const BACKLOG_MAX_SIZE = 1 * 1024 * 1024; // 1 MB
let backlogBuffer = Buffer.alloc(0);
let backlogStartOffset = 0; // the replication offset of the first byte in the backlog

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the master — generate a replication ID and reset state.
 * Must be called once at server startup.
 */
function initMaster() {
    masterReplId = crypto.randomBytes(20).toString("hex"); // 40-char hex
    masterReplOffset = 0;
    backlogBuffer = Buffer.alloc(0);
    backlogStartOffset = 0;
    console.log(`[master] Replication ID: ${masterReplId}`);
    console.log(`[master] Replication offset: ${masterReplOffset}`);
}

// ─── Replica Management ──────────────────────────────────────────────────────

/**
 * Register a replica connection (called internally after PSYNC succeeds).
 */
function registerReplica(socket) {
    socket.isReplica = true;
    replicas.set(socket, {
        offset: 0,
        listeningPort: null,
        capabilities: [],
    });
    console.log("[master] Replica registered:", socket.remoteAddress);

    socket.on("close", () => {
        removeReplica(socket);
    });
}

/**
 * Remove replica on disconnect.
 */
function removeReplica(socket) {
    if (replicas.has(socket)) {
        replicas.delete(socket);
        console.log("[master] Replica disconnected:", socket.remoteAddress);
    }
}

// ─── RESP Encoding ────────────────────────────────────────────────────────────

/**
 * Convert args array to RESP format.
 */
function toRESP(args) {
    if (!Array.isArray(args)) {
        throw new Error("Replication expects args as array");
    }

    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
        const str = String(arg);
        resp += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return resp;
}

// ─── Backlog ──────────────────────────────────────────────────────────────────

/**
 * Append RESP data to the replication backlog.
 * Trims old data from the front if the backlog exceeds BACKLOG_MAX_SIZE.
 */
function appendToBacklog(respData) {
    const newData = Buffer.from(respData);
    backlogBuffer = Buffer.concat([backlogBuffer, newData]);

    // Trim if over max size — keep the most recent bytes
    if (backlogBuffer.length > BACKLOG_MAX_SIZE) {
        const trimBytes = backlogBuffer.length - BACKLOG_MAX_SIZE;
        backlogBuffer = backlogBuffer.slice(trimBytes);
        backlogStartOffset += trimBytes;
    }
}

/**
 * Try to get backlog data from a given offset.
 * Returns { found: true, data: Buffer } if the offset is within the backlog,
 * or { found: false } if the offset has been trimmed.
 */
function getBacklogFrom(offset) {
    const backlogEndOffset = backlogStartOffset + backlogBuffer.length;

    // Check if the requested offset is still in our backlog
    if (offset < backlogStartOffset || offset > backlogEndOffset) {
        return { found: false };
    }

    const relativeStart = offset - backlogStartOffset;
    const data = backlogBuffer.slice(relativeStart);
    return { found: true, data };
}

// ─── REPLCONF Handler ─────────────────────────────────────────────────────────

/**
 * Handle REPLCONF command from a replica.
 * Subcommands:
 *   REPLCONF listening-port <port>
 *   REPLCONF capa <capability> [<capability> ...]
 *   REPLCONF ACK <offset>
 */
function handleReplconf(args, socket) {
    if (args.length < 2) {
        return "-ERR wrong number of arguments for 'REPLCONF'\r\n";
    }

    const subcommand = args[1].toLowerCase();

    if (subcommand === "listening-port") {
        const port = args[2];
        const info = replicas.get(socket);
        if (info) {
            info.listeningPort = parseInt(port, 10);
        }
        console.log(`[master] REPLCONF listening-port ${port} from`, socket.remoteAddress);
        return "+OK\r\n";
    }

    if (subcommand === "capa") {
        const caps = args.slice(2);
        const info = replicas.get(socket);
        if (info) {
            info.capabilities.push(...caps);
        }
        console.log(`[master] REPLCONF capa ${caps.join(" ")} from`, socket.remoteAddress);
        return "+OK\r\n";
    }

    if (subcommand === "ack") {
        const offset = parseInt(args[2], 10);
        const info = replicas.get(socket);
        if (info) {
            info.offset = offset;
        }
        // ACK does NOT send a response (same as real Redis)
        return null;
    }

    return "-ERR Unrecognized REPLCONF subcommand\r\n";
}

// ─── PSYNC Handler ────────────────────────────────────────────────────────────

/**
 * Handle PSYNC command from a replica.
 *   PSYNC <replid> <offset>
 *   PSYNC ? -1          → always triggers full resync
 *
 * On success, registers the socket as a replica.
 */
function handlePsync(args, socket) {
    const requestedReplId = args[1] || "?";
    const requestedOffset = parseInt(args[2], 10);

    // Register the socket as a replica if not already
    if (!replicas.has(socket)) {
        registerReplica(socket);
    }

    // ── Attempt partial resync ──
    if (requestedReplId === masterReplId && !isNaN(requestedOffset) && requestedOffset >= 0) {
        const backlogResult = getBacklogFrom(requestedOffset);

        if (backlogResult.found) {
            // Partial resync — send missed data from backlog
            console.log(`[master] Partial resync for offset ${requestedOffset} (backlog hit, ${backlogResult.data.length} bytes to send)`);

            socket.write(`+CONTINUE ${masterReplId}\r\n`);
            socket.write(backlogResult.data);

            // Update replica's offset to current
            const info = replicas.get(socket);
            if (info) info.offset = masterReplOffset;

            return null; // response already sent
        }

        console.log(`[master] Partial resync failed — offset ${requestedOffset} not in backlog (backlog starts at ${backlogStartOffset})`);
    }

    // ── Full resync ──
    console.log(`[master] Initiating FULLRESYNC for replica ${socket.remoteAddress}`);
    sendFullSync(socket);
    return null; // response already sent by sendFullSync
}

// ─── Full Sync ────────────────────────────────────────────────────────────────

/**
 * Send FULLRESYNC + RDB snapshot to a replica.
 */
function sendFullSync(socket) {
    try {
        const rdbPath = path.join(__dirname, "..", "dump.rdb");

        if (!fs.existsSync(rdbPath)) {
            console.log("[master] No RDB found. Sending empty snapshot.");
            socket.write(`+FULLRESYNC ${masterReplId} ${masterReplOffset}\r\n`);
            socket.write("$0\r\n\r\n");

            const info = replicas.get(socket);
            if (info) info.offset = masterReplOffset;
            return;
        }

        const snapshot = fs.readFileSync(rdbPath);
        console.log("[master] Sending FULLRESYNC. Snapshot size:", snapshot.length);

        socket.write(`+FULLRESYNC ${masterReplId} ${masterReplOffset}\r\n`);
        socket.write(`$${snapshot.length}\r\n`);
        socket.write(snapshot);
        socket.write("\r\n");

        // After full sync, replica's offset is at master's current offset
        const info = replicas.get(socket);
        if (info) info.offset = masterReplOffset;

    } catch (err) {
        console.error("[master] Full sync failed:", err);
        socket.end();
    }
}

// ─── Command Propagation ──────────────────────────────────────────────────────

/**
 * Propagate write command to all replicas.
 * Also appends to the backlog and increments masterReplOffset.
 * Prevents replication loops (commands from replicas are not re-propagated).
 */
function propagateToReplicas(args, sourceSocket = null) {
    if (!Array.isArray(args)) {
        console.error("[master] Invalid replication payload:", args);
        return;
    }

    // Do not propagate commands coming from replicas
    if (sourceSocket && sourceSocket.isReplica) {
        return;
    }

    const respCommand = toRESP(args);
    const respBytes = Buffer.byteLength(respCommand);

    // Append to backlog and update offset
    appendToBacklog(respCommand);
    masterReplOffset += respBytes;

    // Send to all connected replicas
    if (replicas.size === 0) return;

    for (const [replica] of replicas) {
        if (!replica.destroyed) {
            replica.write(respCommand);
        }
    }

    console.log(`[master] Replicated ${args[0]} to ${replicas.size} replica(s) | offset: ${masterReplOffset}`);
}

// ─── Replication Info ─────────────────────────────────────────────────────────

/**
 * Return replication info (for INFO replication command).
 */
function getReplicationInfo() {
    const lines = [
        "# Replication",
        "role:master",
        `master_replid:${masterReplId}`,
        `master_repl_offset:${masterReplOffset}`,
        `connected_slaves:${replicas.size}`,
        `repl_backlog_active:${backlogBuffer.length > 0 ? 1 : 0}`,
        `repl_backlog_size:${BACKLOG_MAX_SIZE}`,
        `repl_backlog_first_byte_offset:${backlogStartOffset}`,
        `repl_backlog_histlen:${backlogBuffer.length}`,
    ];

    let idx = 0;
    for (const [socket, info] of replicas) {
        lines.push(
            `slave${idx}:ip=${socket.remoteAddress},port=${info.listeningPort || "?"},state=online,offset=${info.offset},lag=0`
        );
        idx++;
    }

    return lines.join("\r\n");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    initMaster,
    registerReplica,
    removeReplica,
    sendFullSync,
    propagateToReplicas,
    handleReplconf,
    handlePsync,
    getReplicationInfo,
    toRESP,
};