const net = require("net");
const handleCommand = require("./commands/command");
const database = require("./storage/database");
const expiry = require("./storage/expiry");
const { loadAOF } = require("./persistence/aof");
const { load_Rdb } = require("./persistence/rdb");
const { unsubscribeAll } = require("./messaging/pubsub");
const RESPParser = require("./RESPParser");
const replication = require("./replication/master");
const { startReplica } = require("./replication/replica");

// ================= CLI ARGUMENTS =================
const args = process.argv.slice(2);
let PORT = 6379;
let replicaOfHost = null;
let replicaOfPort = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
        PORT = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === "--replicaof" && args[i + 1] && args[i + 2]) {
        replicaOfHost = args[i + 1];
        replicaOfPort = parseInt(args[i + 2], 10);
        i += 2;
    }
}

const isReplicaServer = replicaOfHost !== null;

// ================= WRITE COMMAND CHECK =================
const WRITE_COMMANDS = new Set([
    "SET", "DEL", "HSET", "LPUSH", "RPUSH", "FLUSHALL", "INCR", "DECR"
]);

function isWriteCommand(command) {
    return WRITE_COMMANDS.has(command.toUpperCase());
}

// ================= SERVER =================
const server = net.createServer((socket) => {
    console.log("New client connected:", socket.remoteAddress);
    socket.write("+Welcome to Redis clone!\r\n");

    socket.tx = {
        active: false,
        queue: []
    };

    socket.isReplica = false;

    let mode = null;
    const respParser = new RESPParser();
    let inlineBuffer = "";

    socket.on("data", (data) => {
        try {
            const chunk = data.toString();
            console.log("RAW:", JSON.stringify(chunk));

            if (mode === null) {
                const combined = (inlineBuffer + chunk).replace(/^\s+/, "");
                const first = combined[0];
                mode = first === "*" ? "resp" : "inline";
            }

            if (mode === "resp") {
                const commands = respParser.push(chunk);
                for (const args of commands) {
                    if (!Array.isArray(args) || args.length === 0) continue;
                    processCommand(args, socket);
                }
                return;
            }

            // Inline mode
            inlineBuffer += chunk;

            while (inlineBuffer.length > 0) {
                const newlineIndex = inlineBuffer.indexOf("\r\n");
                if (newlineIndex === -1) break;

                const line = inlineBuffer.slice(0, newlineIndex).trim();
                inlineBuffer = inlineBuffer.slice(newlineIndex + 2);

                if (!line) continue;

                const args = line.split(" ");
                processCommand(args, socket);
            }

        } catch (err) {
            console.error("Command processing error:", err);
            socket.write("-ERR internal server error\r\n");
        }
    });

    socket.on("error", (err) => {
        console.error("Socket error:", err);
    });

    socket.on("close", () => {
        unsubscribeAll(socket);
        replication.removeReplica(socket);
        console.log("Client disconnected:", socket.remoteAddress);
    });
});

// ================= COMMAND PROCESSOR =================
function processCommand(args, socket) {
    const command = args[0].toUpperCase();
    console.log("Parsed:", args);

    // 🔒 Read-only enforcement for replica servers
    if (isReplicaServer && !socket.isReplica && isWriteCommand(command)) {
        socket.write("-READONLY You can't write against a read only replica\r\n");
        return;
    }

    // ─── REPLCONF handling (master side) ───
    if (command === "REPLCONF") {
        const resp = replication.handleReplconf(args, socket);
        if (resp) socket.write(resp);
        return;
    }

    // ─── PSYNC handling (master side) ───
    if (command === "PSYNC") {
        const resp = replication.handlePsync(args, socket);
        if (resp) socket.write(resp);
        return;
    }

    // 🔥 REPLICAOF handling (backward compat — triggers full sync via PSYNC)
    if (command === "REPLICAOF") {
        // Treat as PSYNC ? -1 (full sync)
        const resp = replication.handlePsync(["PSYNC", "?", "-1"], socket);
        socket.write("+OK\r\n");
        if (resp) socket.write(resp);
        return;
    }

    // ================= TRANSACTIONS =================
    if (command === "MULTI") {
        socket.tx.active = true;
        socket.tx.queue = [];
        socket.write("+OK\r\n");
        return;
    }

    if (command === "DISCARD") {
        socket.tx.active = false;
        socket.tx.queue = [];
        socket.write("+OK\r\n");
        return;
    }

    if (command === "EXEC") {
        if (!socket.tx.active) {
            socket.write("-ERR EXEC without MULTI\r\n");
            return;
        }

        const results = [];

        for (const queuedArgs of socket.tx.queue) {
            const res = handleCommand(queuedArgs, socket);
            results.push(res || "$-1\r\n");

            // ✅ replicate write commands inside EXEC
            if (!socket.isReplica && isWriteCommand(queuedArgs[0])) {
                replication.propagateToReplicas(queuedArgs, socket);
            }
        }

        socket.tx.active = false;
        socket.tx.queue = [];

        socket.write(`*${results.length}\r\n`);
        for (const r of results) {
            socket.write(r);
        }

        return;
    }

    if (socket.tx.active) {
        socket.tx.queue.push(args);
        socket.write("+QUEUED\r\n");
        return;
    }

    // ================= NORMAL EXECUTION =================
    const res = handleCommand(args, socket);
    if (res) socket.write(res);

    // 🔥 Propagate write commands (master only)
    if (!socket.isReplica && isWriteCommand(command)) {
        replication.propagateToReplicas(args, socket);
    }
}

// ================= START SERVER =================

// Initialize master replication state (replid, offset, backlog)
replication.initMaster();

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}${isReplicaServer ? " (REPLICA)" : " (MASTER)"}`);

    try {
        load_Rdb(database.getAll());
        loadAOF(database, expiry);
        console.log("Persistence loaded successfully.");
    } catch (err) {
        console.error("Persistence loading failed:", err);
    }

    // 🔁 If --replicaof was specified, start replication
    if (isReplicaServer) {
        console.log(`Starting replication: connecting to master at ${replicaOfHost}:${replicaOfPort}`);
        startReplica(replicaOfHost, replicaOfPort, PORT);
    }
});