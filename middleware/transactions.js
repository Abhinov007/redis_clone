/**
 * Transaction middleware — handles MULTI / EXEC / DISCARD and the
 * per-socket command queue that sits between them.
 *
 * Consumed by server.js inside _processCommand().
 *
 * @example
 * // In _processCommand():
 * const tx = require("./middleware/transactions");
 * if (tx.handleIfTransactionCommand(command, args, socket, handleCommand, replication))
 *     return;
 */

"use strict";

const replication = require("../replication/master");

const WRITE_COMMANDS = new Set([
    "SET", "DEL", "HSET", "HDEL", "LPUSH", "RPUSH", "LPOP", "RPOP",
    "FLUSHALL", "INCR", "DECR",
]);

/**
 * Ensure the transaction state object exists on the socket.
 * Called once per new connection.
 *
 * @param {net.Socket} socket
 */
function initTx(socket) {
    if (!socket.tx) {
        socket.tx = { active: false, queue: [] };
    }
}

/**
 * Try to handle the command as a transaction control (MULTI/EXEC/DISCARD)
 * or to queue it if a transaction is already active.
 *
 * Returns `true` if the command was handled (caller should return immediately).
 * Returns `false` if the command should be processed normally.
 *
 * @param {string}   command      - Uppercased command name
 * @param {string[]} args         - Full tokenised args including command name
 * @param {net.Socket} socket     - Client socket
 * @param {Function} handleCommand - The main command dispatcher
 * @returns {boolean}
 */
function handleIfTransactionCommand(command, args, socket, handleCommand) {
    initTx(socket);

    if (command === "MULTI") {
        if (socket.tx.active) {
            socket.write("-ERR MULTI calls can not be nested\r\n");
        } else {
            socket.tx.active = true;
            socket.tx.queue  = [];
            socket.write("+OK\r\n");
        }
        return true;
    }

    if (command === "DISCARD") {
        if (!socket.tx.active) {
            socket.write("-ERR DISCARD without MULTI\r\n");
        } else {
            socket.tx.active = false;
            socket.tx.queue  = [];
            socket.write("+OK\r\n");
        }
        return true;
    }

    if (command === "EXEC") {
        if (!socket.tx.active) {
            socket.write("-ERR EXEC without MULTI\r\n");
            return true;
        }

        const results = [];

        for (const queuedArgs of socket.tx.queue) {
            let res;
            try {
                res = handleCommand(queuedArgs, socket);
            } catch (err) {
                console.error(`[TX] EXEC command '${queuedArgs?.[0]}' failed:`, err);
                res = "-ERR internal server error\r\n";
            }
            results.push(res || "$-1\r\n");

            // Replicate write commands executed inside EXEC
            if (!socket.isReplica && WRITE_COMMANDS.has((queuedArgs[0] || "").toUpperCase())) {
                replication.propagateToReplicas(queuedArgs, socket);
            }
        }

        socket.tx.active = false;
        socket.tx.queue  = [];

        socket.write(`*${results.length}\r\n`);
        for (const r of results) socket.write(r);
        return true;
    }

    // If a transaction is open, queue the command instead of executing it
    if (socket.tx.active) {
        socket.tx.queue.push(args);
        socket.write("+QUEUED\r\n");
        return true;
    }

    return false;
}

module.exports = { initTx, handleIfTransactionCommand };
