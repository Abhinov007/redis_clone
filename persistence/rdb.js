const fs = require("fs");

const rdb_file = "dump.rdb";

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

function save_Rdb(database) {
    try {
        const snapshotObj = {};
        for (const [key, entry] of database.entries()) {
            snapshotObj[key] = serializeEntry(entry);
        }
        const snapshot = JSON.stringify(snapshotObj);
        fs.writeFileSync(rdb_file, snapshot);
        console.log("snapshot taken successfully");
    } catch (err) {
        console.error("Error saving RDB:", err);
    }
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

module.exports = { save_Rdb, load_Rdb, loadRDBFromBuffer };
