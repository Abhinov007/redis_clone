/**
 * Replication middleware — handles REPLCONF, PSYNC, REPLICAOF on the master
 * side, and enforces read-only mode when the server is running as a replica.
 *
 * Returns `true` if the command was handled (caller should return immediately).
 * Returns `false` if the command should be processed normally.
 *
 * @example
 * // In _processCommand():
 * const replMiddleware = require("./middleware/replication");
 * if (replMiddleware.handleIfReplicationCommand(command, args, socket, isReplicaServer))
 *     return;
 */

"use strict";

const replication = require("../replication/master");

const WRITE_COMMANDS = new Set([
    "SET", "DEL", "HSET", "HDEL", "LPUSH", "RPUSH", "LPOP", "RPOP",
    "FLUSHALL", "INCR", "DECR",
]);

/**
 * Check write-guard for replica servers, and dispatch replication control
 * commands (REPLCONF / PSYNC / REPLICAOF) back to the master replication module.
 *
 * @param {string}     command        - Uppercased command name
 * @param {string[]}   args           - Full tokenised args
 * @param {net.Socket} socket         - Client socket
 * @param {boolean}    isReplicaServer - True when this process started with --replicaof
 * @returns {boolean}
 */
function handleIfReplicationCommand(command, args, socket, isReplicaServer) {
    // ── Read-only guard ──────────────────────────────────────────────────────
    if (isReplicaServer && !socket.isReplica && WRITE_COMMANDS.has(command)) {
        socket.write("-READONLY You can't write against a read only replica\r\n");
        return true;
    }

    // ── REPLCONF (master side) ───────────────────────────────────────────────
    if (command === "REPLCONF") {
        const resp = replication.handleReplconf(args, socket);
        if (resp) socket.write(resp);
        return true;
    }

    // ── PSYNC (master side) ──────────────────────────────────────────────────
    if (command === "PSYNC") {
        const resp = replication.handlePsync(args, socket);
        if (resp) socket.write(resp);
        return true;
    }

    // ── REPLICAOF (backward compat — triggers full sync via PSYNC) ──────────
    if (command === "REPLICAOF") {
        const resp = replication.handlePsync(["PSYNC", "?", "-1"], socket);
        socket.write("+OK\r\n");
        if (resp) socket.write(resp);
        return true;
    }

    return false;
}

module.exports = { handleIfReplicationCommand };
