const fs = require("fs");

const AOF_FILE = "database.aof";

function appendToAOF(command) {
    fs.appendFile(AOF_FILE, command + "\n", (err) => {
        if (err) console.error("Failed to write to AOF:", err);
    });
}

function loadAOF(database, expiry) {
    if (!fs.existsSync(AOF_FILE)) return;

    const lines = fs.readFileSync(AOF_FILE, "utf-8").split(/\r?\n/);
    console.log(`Loading ${lines.length} commands from AOF...`);

    for (const line of lines) {
        const commandString = line.trim();
        if (!commandString) continue;

        console.log(`Executing AOF command: ${commandString}`);
        const parts = commandString.split(" ");
        const cmd = parts[0]?.toUpperCase();

        if (cmd === "SET") {
            const key = parts[1];
            const value = parts[2];
            if (key === undefined || value === undefined) continue;

            database.setString(key, value);

            if (parts.length >= 5 && parts[3]?.toUpperCase() === "EX") {
                const ttl = parseInt(parts[4], 10);
                if (!Number.isNaN(ttl) && ttl >= 0) {
                    expiry.setExpiry(key, ttl);
                }
            }
            continue;
        }

        if (cmd === "DEL") {
            const key = parts[1];
            if (key !== undefined) database.deleteKey(key);
            continue;
        }

        if (cmd === "FLUSHALL") {
            database.clearDatabase();
            expiry.clearExpiry();
            continue;
        }

        if (cmd === "LPUSH" || cmd === "RPUSH") {
            const key = parts[1];
            const elements = parts.slice(2);
            if (key === undefined || elements.length === 0) continue;

            const list = database.getOrCreateList(key);
            if (list === undefined) continue;

            if (cmd === "LPUSH") {
                for (const el of elements) list.unshift(String(el));
            } else {
                for (const el of elements) list.push(String(el));
            }
            continue;
        }

        if (cmd === "LPOP" || cmd === "RPOP") {
            const key = parts[1];
            if (key === undefined) continue;

            const list = database.getList(key);
            if (!Array.isArray(list) || list.length === 0) continue;

            if (cmd === "LPOP") list.shift();
            else list.pop();

            if (list.length === 0) database.deleteKey(key);
            continue;
        }

        if (cmd === "HSET") {
            const key = parts[1];
            const rest = parts.slice(2);
            if (key === undefined || rest.length < 2 || rest.length % 2 !== 0) continue;

            const hash = database.getOrCreateHash(key);
            if (hash === undefined) continue;

            for (let i = 0; i < rest.length; i += 2) {
                hash.set(String(rest[i]), String(rest[i + 1]));
            }
            continue;
        }

        if (cmd === "HDEL") {
            const key = parts[1];
            const fields = parts.slice(2);
            if (key === undefined || fields.length === 0) continue;

            const hash = database.getHash(key);
            if (!(hash instanceof Map)) continue;

            for (const f of fields) hash.delete(String(f));
            if (hash.size === 0) database.deleteKey(key);
            continue;
        }
    }

    console.log("AOF Replay Complete.");
}

module.exports = { appendToAOF, loadAOF };
