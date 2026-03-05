// replication/master.js

const fs = require("fs");
const path = require("path");

const replicas = new Set();

/**
 * Register a replica connection
 */
function registerReplica(socket) {
    socket.isReplica = true;
    replicas.add(socket);
    console.log("Replica registered:", socket.remoteAddress);

    socket.on("close", () => {
        removeReplica(socket);
    });
}

/**
 * Remove replica on disconnect
 */
function removeReplica(socket) {
    if (replicas.has(socket)) {
        replicas.delete(socket);
        console.log("Replica disconnected:", socket.remoteAddress);
    }
}

/**
 * Send FULLRESYNC snapshot to replica
 */
function sendFullSync(socket) {
    try {
        const rdbPath = path.join(__dirname, "..", "dump.rdb");

        if (!fs.existsSync(rdbPath)) {
            console.log("No RDB found. Sending empty snapshot.");
            socket.write("+FULLRESYNC 0000000000000000000000000000000000000000 0\r\n");
            socket.write("$0\r\n\r\n");
            return;
        }

        const snapshot = fs.readFileSync(rdbPath);

        console.log("Sending FULLRESYNC. Snapshot size:", snapshot.length);

        socket.write("+FULLRESYNC 0000000000000000000000000000000000000000 0\r\n");
        socket.write(`$${snapshot.length}\r\n`);
        socket.write(snapshot);
        socket.write("\r\n");

    } catch (err) {
        console.error("Full sync failed:", err);
        socket.end();
    }
}

/**
 * Convert args array to RESP format
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

/**
 * Propagate write command to all replicas
 * Prevents replication loops
 */
function propagateToReplicas(args, sourceSocket = null) {
    if (!Array.isArray(args)) {
        console.error("Invalid replication payload:", args);
        return;
    }

    // Do not propagate commands coming from replicas
    if (sourceSocket && sourceSocket.isReplica) {
        return;
    }

    if (replicas.size === 0) {
        return;
    }

    const respCommand = toRESP(args);

    for (const replica of replicas) {
        if (!replica.destroyed) {
            replica.write(respCommand);
        }
    }

    console.log("Replicated command to", replicas.size, "replica(s):", args[0]);
}

module.exports = {
    registerReplica,
    removeReplica,
    sendFullSync,
    propagateToReplicas,
};