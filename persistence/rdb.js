const fs = require("fs");

const rdb_file = "dump.rdb";

// ─── Async throttled write state ─────────────────────────────────────────────
// Ensures we never block the event loop and never queue more than one write.
// If a save is already in progress, any further calls mark _dirty = true.
// When the in-flight save finishes it checks _dirty and immediately starts
// another save to capture the latest state. Under a burst of writes this
// results in at most two fs.writeFile calls instead of thousands.

let _dirty  = false;   // new writes arrived since the last save started
let _saving = false;   // a fs.writeFile is currently in flight
let _latest = null;    // reference to the database Map at schedule time

function serializeEntry(entry) {
    if (entry == null) return null;

    // Legacy/accidental raw string shape
    if (typeof entry === "string") {
        return { type: "string", value: entry };
    }

    if (typeof entry !== "object") {
        return { type: "string", value: String(entry) };
    }

    if (entry.type === "string") {
        return { type: "string", value: String(entry.value) };
    }

    if (entry.type === "list") {
        const arr = Array.isArray(entry.value) ? entry.value.map((v) => String(v)) : [];
        return { type: "list", value: arr };
    }

    if (entry.type === "hash") {
        const map = entry.value instanceof Map ? entry.value : new Map(Object.entries(entry.value || {}));
        return { type: "hash", value: Object.fromEntries(map) };
    }

    // Unknown type fallback
    return { type: "string", value: String(entry.value ?? "") };
}

// ─── Internal async write ────────────────────────────────────────────────────
function _doSave() {
    _saving = true;
    _dirty  = false;

    const snapshotObj = {};
    for (const [key, entry] of _latest.entries()) {
        snapshotObj[key] = serializeEntry(entry);
    }

    fs.writeFile(rdb_file, JSON.stringify(snapshotObj), (err) => {
        _saving = false;
        if (err) {
            console.error("[RDB] Error saving snapshot:", err);
        }
        // If new writes arrived while we were saving, persist them now
        if (_dirty) _doSave();
    });
}

/**
 * Schedule an async RDB snapshot.
 * Safe to call after every write — debounced so it never piles up.
 * @param {Map} database - the live in-memory database Map
 */
function scheduleSave(database) {
    _latest = database;
    _dirty  = true;
    if (!_saving) _doSave();
}

/**
 * Synchronous RDB save — only for graceful shutdown.
 * Blocks intentionally: the process is about to exit anyway.
 * @param {Map} database - the live in-memory database Map
 */
function forceSave(database) {
    try {
        const snapshotObj = {};
        const db = database || _latest;
        if (!db) return;
        for (const [key, entry] of db.entries()) {
            snapshotObj[key] = serializeEntry(entry);
        }
        fs.writeFileSync(rdb_file, JSON.stringify(snapshotObj));
        console.log("[RDB] Final snapshot saved on shutdown.");
    } catch (err) {
        console.error("[RDB] Error saving final snapshot:", err);
    }
}

// Legacy alias — kept so any code that still calls save_Rdb() still works
// but now goes through the async path instead of blocking.
function save_Rdb(database) {
    scheduleSave(database);
}

function load_Rdb(database) {
    if (!fs.existsSync(rdb_file)) return;

    try {
        const data = fs.readFileSync(rdb_file, "utf-8");
        const parsed = JSON.parse(data);

        for (const [key, stored] of Object.entries(parsed || {})) {
            if (stored == null) continue;

            if (typeof stored === "string") {
                database.set(key, { type: "string", value: stored });
                continue;
            }

            if (typeof stored === "object" && stored.type) {
                if (stored.type === "string") {
                    database.set(key, { type: "string", value: String(stored.value) });
                } else if (stored.type === "list") {
                    const arr = Array.isArray(stored.value) ? stored.value.map((v) => String(v)) : [];
                    database.set(key, { type: "list", value: arr });
                } else if (stored.type === "hash") {
                    const obj = stored.value && typeof stored.value === "object" ? stored.value : {};
                    database.set(key, { type: "hash", value: new Map(Object.entries(obj)) });
                }
                continue;
            }

            // Fallback: unknown legacy shape
            database.set(key, { type: "string", value: String(stored) });
        }

        console.log(database);
        console.log(` Loaded ${database.size} keys from RDB.`);
    } catch (error) {
        console.error(" Error loading RDB:", error);
    }
}

/**
 * Load an RDB snapshot from a raw buffer/string (used by replica sync).
 * Same parsing logic as load_Rdb but reads from memory instead of a file.
 */
function loadRDBFromBuffer(buffer, database) {
    try {
        const data = typeof buffer === "string" ? buffer : buffer.toString("utf-8");
        if (!data || data.trim().length === 0) {
            console.log("Empty RDB snapshot received, starting with empty database.");
            return;
        }

        const parsed = JSON.parse(data);

        for (const [key, stored] of Object.entries(parsed || {})) {
            if (stored == null) continue;

            if (typeof stored === "string") {
                database.set(key, { type: "string", value: stored });
                continue;
            }

            if (typeof stored === "object" && stored.type) {
                if (stored.type === "string") {
                    database.set(key, { type: "string", value: String(stored.value) });
                } else if (stored.type === "list") {
                    const arr = Array.isArray(stored.value) ? stored.value.map((v) => String(v)) : [];
                    database.set(key, { type: "list", value: arr });
                } else if (stored.type === "hash") {
                    const obj = stored.value && typeof stored.value === "object" ? stored.value : {};
                    database.set(key, { type: "hash", value: new Map(Object.entries(obj)) });
                }
                continue;
            }

            // Fallback
            database.set(key, { type: "string", value: String(stored) });
        }

        console.log(`Loaded ${database.size} keys from RDB snapshot.`);
    } catch (error) {
        console.error("Error loading RDB from buffer:", error);
    }
}

module.exports = { save_Rdb, scheduleSave, forceSave, load_Rdb, loadRDBFromBuffer };
