/**
 * Startup helpers — loads persisted data and optionally starts replication.
 * Called once by server.js after the TCP server begins listening.
 *
 * Extracted here so server.js stays focused on TCP lifecycle only.
 *
 * @example
 * const { loadPersistence, maybeStartReplica } = require("./startup");
 * server.listen(PORT, () => {
 *     loadPersistence();
 *     maybeStartReplica(replicaOfHost, replicaOfPort, PORT);
 * });
 */

"use strict";

const fs                = require("fs");
const path              = require("path");
const database          = require("./storage/database");
const expiry            = require("./storage/expiry");
const { load_Rdb }      = require("./persistence/rdb");
const { loadAOF }       = require("./persistence/aof");
const { startReplica }  = require("./replication/replica");

const AOF_FILE = path.join(process.cwd(), "database.aof");

/**
 * Load persisted data using the same priority rule as Redis:
 *
 *   • AOF exists  → replay AOF exclusively (it is always the most up-to-date
 *                   record of every write; loading RDB first and then replaying
 *                   AOF on top would double-apply mutations like LPUSH / INCR).
 *
 *   • AOF absent  → load RDB snapshot (faster binary restore, no AOF overhead).
 *
 * Errors are caught and logged so a missing or corrupt file never crashes startup.
 */
function loadPersistence() {
    try {
        if (fs.existsSync(AOF_FILE)) {
            // AOF is the source of truth — replay from scratch.
            // Dependency injection breaks the aof ↔ command circular-require.
            const { replayCommand } = require("./commands/command");
            loadAOF(replayCommand);
        } else {
            // No AOF — load the last RDB snapshot.
            load_Rdb(database.getAll());
        }

        console.log("[STARTUP] Persistence loaded successfully.");
    } catch (err) {
        console.error("[STARTUP] Persistence loading failed:", err);
    }

    // Start background active-expiry sweep after data is loaded so the sweep
    // sees the right initial key set and doesn't immediately evict freshly
    // loaded keys with already-elapsed TTLs (those will be caught lazily on
    // the first GET, which is fine).
    expiry.startExpirySweep();
}

/**
 * If replicaOfHost is truthy, connect to the master and start replication.
 *
 * @param {string|null} replicaOfHost
 * @param {number|null} replicaOfPort
 * @param {number}      localPort      - This server's port (sent in REPLCONF)
 */
function maybeStartReplica(replicaOfHost, replicaOfPort, localPort) {
    if (!replicaOfHost) return;
    console.log(`[STARTUP] Connecting to master at ${replicaOfHost}:${replicaOfPort}`);
    startReplica(replicaOfHost, replicaOfPort, localPort);
}

module.exports = { loadPersistence, maybeStartReplica };
