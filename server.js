"use strict";

const net = require("net");
const handleCommand             = require("./commands/command");
const database                  = require("./storage/database");
const { forceSave }             = require("./persistence/rdb");
const { unsubscribeAll }        = require("./messaging/pubsub");
const RESPParser                = require("./RESPParser");
const replication               = require("./replication/master");
const { handleIfReplicationCommand } = require("./middleware/replication");
const { handleIfTransactionCommand } = require("./middleware/transactions");
const { loadPersistence, maybeStartReplica } = require("./startup");

// ── CLI arguments ─────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
let PORT           = 6379;
let replicaOfHost  = null;
let replicaOfPort  = null;

for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--port" && cliArgs[i + 1]) {
        PORT = parseInt(cliArgs[i + 1], 10);
        i++;
    } else if (cliArgs[i] === "--replicaof" && cliArgs[i + 1] && cliArgs[i + 2]) {
        replicaOfHost = cliArgs[i + 1];
        replicaOfPort = parseInt(cliArgs[i + 2], 10);
        i += 2;
    }
}

const isReplicaServer = replicaOfHost !== null;

// Write commands that should be propagated to replicas
const WRITE_COMMANDS = new Set([
    "SET", "DEL", "HSET", "HDEL", "LPUSH", "RPUSH", "LPOP", "RPOP",
    "FLUSHALL", "INCR", "DECR",
]);

// ── TCP server ────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
    console.log("New client connected:", socket.remoteAddress);
    socket.write("+Welcome to Redis clone!\r\n");

    socket.tx       = { active: false, queue: [] };
    socket.isReplica = false;

    let mode         = null;        // "resp" | "inline"
    const respParser = new RESPParser();
    let inlineBuffer = "";

    socket.on("data", (data) => {
        try {
            const chunk = data.toString();
            console.log("RAW:", JSON.stringify(chunk));

            // Auto-detect protocol on first byte
            if (mode === null) {
                const combined = (inlineBuffer + chunk).replace(/^\s+/, "");
                mode = combined[0] === "*" ? "resp" : "inline";
            }

            if (mode === "resp") {
                const commands = respParser.push(chunk);
                for (const cmdArgs of commands) {
                    if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) continue;
                    processCommand(cmdArgs, socket);
                }
                return;
            }

            // ── Inline (telnet-style) mode ────────────────────────────────────
            inlineBuffer += chunk;
            let nl;
            while ((nl = inlineBuffer.indexOf("\r\n")) !== -1) {
                const line = inlineBuffer.slice(0, nl).trim();
                inlineBuffer = inlineBuffer.slice(nl + 2);
                if (!line) continue;
                processCommand(line.split(" "), socket);
            }

        } catch (err) {
            console.error("[SERVER] Data handler error:", err);
            socket.write("-ERR internal server error\r\n");
        }
    });

    socket.on("error", (err) => console.error("[SOCKET] Error:", err));

    socket.on("close", () => {
        unsubscribeAll(socket);
        replication.removeReplica(socket);
        console.log("Client disconnected:", socket.remoteAddress);
    });
});

// ── Command processor ─────────────────────────────────────────────────────────

/**
 * Outer error boundary — any unhandled exception inside a command handler
 * sends a clean error to the client and keeps the server alive (Fix #2).
 */
function processCommand(args, socket) {
    try {
        _processCommand(args, socket);
    } catch (err) {
        console.error(`[ERROR] Unexpected error in command '${args?.[0]}':`, err);
        try { socket.write("-ERR internal server error\r\n"); } catch (_) {}
    }
}

function _processCommand(args, socket) {
    const command = args[0].toUpperCase();
    console.log("Parsed:", args);

    // ── Replication layer (read-only guard + REPLCONF/PSYNC/REPLICAOF) ───────
    if (handleIfReplicationCommand(command, args, socket, isReplicaServer)) return;

    // ── Transaction layer (MULTI/EXEC/DISCARD + queue-while-open) ────────────
    if (handleIfTransactionCommand(command, args, socket, handleCommand)) return;

    // ── Normal execution ──────────────────────────────────────────────────────
    const res = handleCommand(args, socket);
    if (res) socket.write(res);

    // Propagate write commands to replicas (master only)
    if (!socket.isReplica && WRITE_COMMANDS.has(command)) {
        replication.propagateToReplicas(args, socket);
    }
}

// ── Start ─────────────────────────────────────────────────────────────────────

replication.initMaster();

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}${isReplicaServer ? " (REPLICA)" : " (MASTER)"}`);
    loadPersistence();
    maybeStartReplica(replicaOfHost, replicaOfPort, PORT);
});

// ── Graceful shutdown (Fix #3) ────────────────────────────────────────────────
// SIGINT (Ctrl-C) and SIGTERM (Docker stop / PM2) both trigger a final
// synchronous RDB snapshot before exiting so dump.rdb is never left corrupt.

function gracefulShutdown(signal) {
    console.log(`\n[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    server.close(() => console.log("[SHUTDOWN] Server closed — no new connections."));
    forceSave(database.getAll());
    setTimeout(() => {
        console.log("[SHUTDOWN] Final snapshot saved. Clean exit.");
        process.exit(0);
    }, 200);
}

process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
