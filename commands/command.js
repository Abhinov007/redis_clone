const fs = require("fs");
const { appendToAOF } = require("../persistence/aof");
const database = require("../storage/database");
const expiry = require("../storage/expiry");
const { scheduleSave } = require("../persistence/rdb");
const { subscribe, publish, unsubscribe } = require("../messaging/pubsub");
const { respSimpleString, respError, respInt, respBulk, respArray, respArrayOfBulks } = require("../protocol/resp");

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

function wrongArity(command) {
    return respError(`ERR wrong number of arguments for '${command.toLowerCase()}' command`);
}

function parseInteger(value) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return null;
    return n;
}

/**
 * Convert a Redis glob pattern to a RegExp.
 * Supports: * (any chars), ? (one char), [abc] / [a-z] (character classes).
 *
 * @param {string} pattern
 * @returns {RegExp}
 *
 * @example
 * globToRegex("h?llo").test("hello") // true
 * globToRegex("h*").test("helloworld") // true
 * globToRegex("h[ae]llo").test("hallo") // true
 */
function globToRegex(pattern) {
    let regStr = "^";
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "*")       regStr += ".*";
        else if (c === "?")  regStr += ".";
        else if (c === "[")  {
            // Pass character class through verbatim until closing ]
            const end = pattern.indexOf("]", i);
            if (end === -1) { regStr += "\\["; }
            else { regStr += pattern.slice(i, end + 1); i = end; }
        }
        else regStr += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(regStr + "$");
}

function handleMulti(socket) {
    if (socket.tx.active) {
        return respError("ERR MULTI calls can not be nested");
    }

    socket.tx.active = true;
    socket.tx.queue = [];

    return respSimpleString("OK");
}

function handleExec(socket) {
    if (!socket.tx.active) {
        return respError("ERR EXEC without MULTI");
    }

    const replies = [];

    for (const cmd of socket.tx.queue) {
        const reply = handleCoreCommand(cmd.args, socket);
        replies.push(reply);
    }

    socket.tx.active = false;
    socket.tx.queue = [];

    return respArray(replies);
}

function handleDiscard(socket) {
    if (!socket.tx.active) {
        return respError("ERR DISCARD without MULTI");
    }

    socket.tx.active = false;
    socket.tx.queue = [];

    return respSimpleString("OK");
}

/**
 * Execute a core (non-pub/sub, non-transaction) command.
 *
 * @param {string[]}  args   - Tokenised command e.g. ['SET', 'key', 'val']
 * @param {object}    socket - Client socket (used only by END command)
 * @param {object}    opts   - Options
 * @param {boolean}   opts.replay - When true, skip AOF append and RDB save.
 *                                  Used by loadAOF() to replay commands on
 *                                  startup without re-logging them.
 *
 * @example
 * // Normal execution (writes to AOF + schedules RDB)
 * handleCoreCommand(['SET', 'name', 'Alice'], socket)
 *
 * @example
 * // AOF replay (data mutation only, no persistence side-effects)
 * handleCoreCommand(['SET', 'name', 'Alice'], nullSocket, { replay: true })
 */
function handleCoreCommand(args, socket, opts = {}) {
    if (!args || args.length === 0) {
        return respError("ERR unknown command");
    }

    const command = args[0].toUpperCase();
    const replay  = opts.replay === true;

    if (command === "PING") {
        if (args.length !== 1) {
            return wrongArity("PING");
        }
        return respSimpleString("PONG");
    }

    if (command === "SET") {
        if (args.length < 3) {
            return wrongArity("SET");
        }

        const key = args[1];
        const value = args[2];
        let ttl = null;

        if (args.length >= 5 && args[3].toUpperCase() === "EX") {
            ttl = parseInt(args[4], 10);
            if (isNaN(ttl) || ttl < 0) {
                return respError("ERR value is not an integer or out of range");
            }
        } else if (args.length !== 3) {
            // Extra args that are not a valid EX option
            return wrongArity("SET");
        }

        // SET overwrites any existing type, like real Redis
        database.setString(key, value);
        if (ttl !== null) expiry.setExpiry(key, ttl);

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respSimpleString("OK");
    }

    if (command === "GET") {
        if (args.length !== 2) {
            return wrongArity("GET");
        }

        const key = args[1];

        if (expiry.isExpired(key)) {
            // Key expired lazily — log the deletion (only during live execution)
            if (!replay) appendToAOF(`DEL ${key}`);
            return respBulk(null);
        }

        const value = database.getString(key);
        if (value === undefined) {
            return respError("WRONGTYPE Operation against a key holding the wrong kind of value");
        }
        if (value == null) {
            return respBulk(null);
        }

        return respBulk(value);
    }

    if (command === "LPUSH" || command === "RPUSH") {
        if (args.length < 3) {
            return wrongArity(command);
        }

        const key = args[1];
        const list = database.getOrCreateList(key);
        if (list === undefined) {
            return respError(WRONGTYPE);
        }

        const elements = args.slice(2).map((v) => String(v));

        if (command === "LPUSH") {
            for (const el of elements) {
                list.unshift(el);
            }
        } else {
            for (const el of elements) {
                list.push(el);
            }
        }

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(list.length);
    }

    if (command === "LPOP" || command === "RPOP") {
        if (args.length !== 2) {
            return wrongArity(command);
        }

        const key = args[1];
        const list = database.getList(key);
        if (list === undefined) {
            return respError(WRONGTYPE);
        }
        if (list === null || list.length === 0) {
            return respBulk(null);
        }

        const value = command === "LPOP" ? list.shift() : list.pop();

        if (list.length === 0) database.deleteKey(key);

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respBulk(value);
    }

    if (command === "LLEN") {
        if (args.length !== 2) {
            return wrongArity("LLEN");
        }

        const key = args[1];
        const list = database.getList(key);
        if (list === undefined) {
            return respError(WRONGTYPE);
        }
        if (list === null) {
            return respInt(0);
        }

        return respInt(list.length);
    }

    if (command === "LRANGE") {
        if (args.length !== 4) {
            return wrongArity("LRANGE");
        }

        const key = args[1];
        const startRaw = parseInteger(args[2]);
        const stopRaw = parseInteger(args[3]);
        if (startRaw === null || stopRaw === null) {
            return respError("ERR value is not an integer or out of range");
        }

        const list = database.getList(key);
        if (list === undefined) {
            return respError(WRONGTYPE);
        }
        if (list === null || list.length === 0) return respArray([]);

        const len = list.length;
        let start = startRaw < 0 ? len + startRaw : startRaw;
        let stop = stopRaw < 0 ? len + stopRaw : stopRaw;

        if (start < 0) start = 0;
        if (stop < 0) return respArray([]);
        if (start >= len) {
            return respArray([]);
        }
        if (stop >= len) stop = len - 1;
        if (start > stop) {
            return respArray([]);
        }

        const slice = list.slice(start, stop + 1);
        return respArrayOfBulks(slice);
    }

    if (command === "HSET") {
        if (args.length < 4) {
            return wrongArity("HSET");
        }
        if ((args.length - 2) % 2 !== 0) {
            return wrongArity("HSET");
        }

        const key = args[1];
        const hash = database.getOrCreateHash(key);
        if (hash === undefined) {
            return respError(WRONGTYPE);
        }

        let newFields = 0;
        for (let i = 2; i < args.length; i += 2) {
            const field = String(args[i]);
            const value = String(args[i + 1]);
            if (!hash.has(field)) newFields++;
            hash.set(field, value);
        }

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }

        return respInt(newFields);
    }

    if (command === "HGET") {
        if (args.length !== 3) {
            return wrongArity("HGET");
        }

        const key = args[1];
        const field = String(args[2]);
        const hash = database.getHash(key);

        if (hash === undefined) {
            return respError(WRONGTYPE);
        }
        if (hash === null) {
            return respBulk(null);
        }

        return respBulk(hash.has(field) ? hash.get(field) : null);
    }

    if (command === "HDEL") {
        if (args.length < 3) {
            return wrongArity("HDEL");
        }

        const key = args[1];
        const hash = database.getHash(key);

        if (hash === undefined) {
            return respError(WRONGTYPE);
        }
        if (hash === null) {
            return respInt(0);
        }

        let removed = 0;
        for (let i = 2; i < args.length; i++) {
            const field = String(args[i]);
            if (hash.delete(field)) removed++;
        }

        if (hash.size === 0) {
            database.deleteKey(key);
        }

        if (removed > 0 && !replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }

        return respInt(removed);
    }

    if (command === "HGETALL") {
        if (args.length !== 2) {
            return wrongArity("HGETALL");
        }

        const key = args[1];
        const hash = database.getHash(key);

        if (hash === undefined) {
            return respError(WRONGTYPE);
        }
        if (hash === null) {
            return respArray([]);
        }

        const out = [];
        for (const [field, value] of hash.entries()) {
            out.push(respBulk(field));
            out.push(respBulk(value));
        }
        return respArray(out);
    }

    if (command === "HLEN") {
        if (args.length !== 2) {
            return wrongArity("HLEN");
        }

        const key = args[1];
        const hash = database.getHash(key);

        if (hash === undefined) {
            return respError(WRONGTYPE);
        }
        if (hash === null) {
            return respInt(0);
        }

        return respInt(hash.size);
    }

    if (command === "HEXISTS") {
        if (args.length !== 3) {
            return wrongArity("HEXISTS");
        }

        const key = args[1];
        const field = String(args[2]);
        const hash = database.getHash(key);

        if (hash === undefined) {
            return respError(WRONGTYPE);
        }
        if (hash === null) {
            return respInt(0);
        }

        return respInt(hash.has(field) ? 1 : 0);
    }

    if (command === "DEL") {
        if (args.length !== 2) {
            return wrongArity("DEL");
        }

        const key = args[1];
        const existed = database.getEntry(key) != null;
        database.deleteKey(key);
        expiry.clearEntryExpiry(key);
        if (!replay) {
            appendToAOF(`DEL ${key}`);
            scheduleSave(database.getAll());
        }
        return respInt(existed ? 1 : 0);
    }

    if (command === "END") {
        if (socket) {
            socket.write("+Closing connection...\r\n");
            socket.end();
        }
        return null;
    }

    if (command === "FLUSHALL") {
        if (args.length !== 1) {
            return wrongArity("FLUSHALL");
        }

        database.clearDatabase();
        expiry.clearExpiry();
        if (!replay) {
            // Truncate AOF asynchronously — no need to block for a housekeeping command
            fs.writeFile("database.aof", "", (err) => {
                if (err) console.error("[AOF] Error truncating on FLUSHALL:", err);
            });
            scheduleSave(database.getAll());
        }

        return respSimpleString("OK");
    }

    // =========================================================================
    // Fix #9 — Key-space commands
    // =========================================================================

    if (command === "EXISTS") {
        if (args.length < 2) return wrongArity("EXISTS");
        let count = 0;
        for (let i = 1; i < args.length; i++) {
            const k = args[i];
            if (!expiry.isExpired(k) && database.getEntry(k) !== null) count++;
        }
        return respInt(count);
    }

    if (command === "TYPE") {
        if (args.length !== 2) return wrongArity("TYPE");
        const key = args[1];
        if (expiry.isExpired(key)) return respSimpleString("none");
        return respSimpleString(database.getType(key));
    }

    if (command === "RENAME") {
        if (args.length !== 3) return wrongArity("RENAME");
        const src = args[1], dst = args[2];
        if (expiry.isExpired(src)) {
            expiry.clearEntryExpiry(src);
            return respError("ERR no such key");
        }
        const entry = database.getEntry(src);
        if (entry === null) return respError("ERR no such key");

        database.setEntry(dst, entry);
        database.deleteKey(src);

        // Transfer TTL if one exists
        const srcTTL = expiry.getRemainingMs(src);
        expiry.clearEntryExpiry(src);
        if (srcTTL !== null) expiry.setExpiryMs(dst, srcTTL);

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respSimpleString("OK");
    }

    if (command === "KEYS") {
        if (args.length !== 2) return wrongArity("KEYS");
        const pattern = args[1];
        const regex   = globToRegex(pattern);
        const matches = [];
        for (const [k] of database.getAll()) {
            if (!expiry.isExpired(k) && regex.test(k)) matches.push(k);
        }
        return respArrayOfBulks(matches);
    }

    // =========================================================================
    // Fix #10 — String completeness
    // =========================================================================

    if (command === "MSET") {
        if (args.length < 3 || (args.length - 1) % 2 !== 0) return wrongArity("MSET");
        for (let i = 1; i < args.length; i += 2) {
            database.setString(args[i], args[i + 1]);
        }
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respSimpleString("OK");
    }

    if (command === "MGET") {
        if (args.length < 2) return wrongArity("MGET");
        const out = [];
        for (let i = 1; i < args.length; i++) {
            const k = args[i];
            if (expiry.isExpired(k)) { out.push(respBulk(null)); continue; }
            const v = database.getString(k);
            // v === undefined means wrong type → Redis returns nil for MGET (no error)
            out.push(respBulk(v == null || v === undefined ? null : v));
        }
        return respArray(out);
    }

    if (command === "SETNX") {
        if (args.length !== 3) return wrongArity("SETNX");
        const key = args[1];
        if (!expiry.isExpired(key) && database.getEntry(key) !== null) return respInt(0);
        database.setString(key, args[2]);
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(1);
    }

    if (command === "STRLEN") {
        if (args.length !== 2) return wrongArity("STRLEN");
        const key = args[1];
        if (expiry.isExpired(key)) return respInt(0);
        const val = database.getString(key);
        if (val === undefined) return respError(WRONGTYPE);
        if (val === null) return respInt(0);
        return respInt(val.length);
    }

    if (command === "APPEND") {
        if (args.length !== 3) return wrongArity("APPEND");
        const key = args[1];
        if (expiry.isExpired(key)) expiry.clearEntryExpiry(key);
        const existing = database.getString(key);
        if (existing === undefined) return respError(WRONGTYPE);
        const newVal = (existing === null ? "" : existing) + args[2];
        database.setString(key, newVal);
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(newVal.length);
    }

    if (command === "INCRBY" || command === "DECRBY") {
        if (args.length !== 3) return wrongArity(command);
        const key = args[1];
        const delta = parseInt(args[2], 10);
        if (Number.isNaN(delta)) return respError("ERR value is not an integer or out of range");
        if (expiry.isExpired(key)) expiry.clearEntryExpiry(key);
        const existing = database.getString(key);
        if (existing === undefined) return respError(WRONGTYPE);
        const current = existing === null ? 0 : parseInt(existing, 10);
        if (Number.isNaN(current)) return respError("ERR value is not an integer or out of range");
        const next = command === "INCRBY" ? current + delta : current - delta;
        database.setString(key, String(next));
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(next);
    }

    // =========================================================================
    // Fix #11 — List completeness
    // =========================================================================

    if (command === "LINDEX") {
        if (args.length !== 3) return wrongArity("LINDEX");
        const key = args[1];
        const idx = parseInteger(args[2]);
        if (idx === null) return respError("ERR value is not an integer or out of range");
        const list = database.getList(key);
        if (list === undefined) return respError(WRONGTYPE);
        if (list === null || list.length === 0) return respBulk(null);
        const i = idx < 0 ? list.length + idx : idx;
        return respBulk(i >= 0 && i < list.length ? list[i] : null);
    }

    if (command === "LSET") {
        if (args.length !== 4) return wrongArity("LSET");
        const key = args[1];
        const idx = parseInteger(args[2]);
        if (idx === null) return respError("ERR value is not an integer or out of range");
        const list = database.getList(key);
        if (list === undefined) return respError(WRONGTYPE);
        if (list === null) return respError("ERR no such key");
        const i = idx < 0 ? list.length + idx : idx;
        if (i < 0 || i >= list.length) return respError("ERR index out of range");
        list[i] = String(args[3]);
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respSimpleString("OK");
    }

    if (command === "LTRIM") {
        if (args.length !== 4) return wrongArity("LTRIM");
        const key = args[1];
        const startRaw = parseInteger(args[2]);
        const stopRaw  = parseInteger(args[3]);
        if (startRaw === null || stopRaw === null)
            return respError("ERR value is not an integer or out of range");
        const list = database.getList(key);
        if (list === undefined) return respError(WRONGTYPE);
        if (list !== null) {
            const len   = list.length;
            let start   = startRaw < 0 ? len + startRaw : startRaw;
            let stop    = stopRaw  < 0 ? len + stopRaw  : stopRaw;
            if (start < 0) start = 0;
            if (stop >= len) stop = len - 1;
            const trimmed = (start > stop) ? [] : list.slice(start, stop + 1);
            list.length = 0;
            list.push(...trimmed);
            if (list.length === 0) database.deleteKey(key);
        }
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respSimpleString("OK");
    }

    // =========================================================================
    // Fix #13 — Sets
    // =========================================================================

    if (command === "SADD") {
        if (args.length < 3) return wrongArity("SADD");
        const key = args[1];
        const set = database.getOrCreateSet(key);
        if (set === undefined) return respError(WRONGTYPE);
        let added = 0;
        for (let i = 2; i < args.length; i++) {
            const m = String(args[i]);
            if (!set.has(m)) { set.add(m); added++; }
        }
        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(added);
    }

    if (command === "SREM") {
        if (args.length < 3) return wrongArity("SREM");
        const key = args[1];
        const set = database.getSet(key);
        if (set === undefined) return respError(WRONGTYPE);
        if (set === null) return respInt(0);
        let removed = 0;
        for (let i = 2; i < args.length; i++) {
            if (set.delete(String(args[i]))) removed++;
        }
        if (set.size === 0) database.deleteKey(key);
        if (removed > 0 && !replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(removed);
    }

    if (command === "SMEMBERS") {
        if (args.length !== 2) return wrongArity("SMEMBERS");
        const key = args[1];
        const set = database.getSet(key);
        if (set === undefined) return respError(WRONGTYPE);
        if (set === null) return respArrayOfBulks([]);
        return respArrayOfBulks([...set]);
    }

    if (command === "SCARD") {
        if (args.length !== 2) return wrongArity("SCARD");
        const key = args[1];
        const set = database.getSet(key);
        if (set === undefined) return respError(WRONGTYPE);
        return respInt(set === null ? 0 : set.size);
    }

    if (command === "SISMEMBER") {
        if (args.length !== 3) return wrongArity("SISMEMBER");
        const key = args[1];
        const set = database.getSet(key);
        if (set === undefined) return respError(WRONGTYPE);
        return respInt(set !== null && set.has(String(args[2])) ? 1 : 0);
    }

    if (command === "SUNION") {
        if (args.length < 2) return wrongArity("SUNION");
        const result = new Set();
        for (let i = 1; i < args.length; i++) {
            const set = database.getSet(args[i]);
            if (set === undefined) return respError(WRONGTYPE);
            if (set !== null) for (const m of set) result.add(m);
        }
        return respArrayOfBulks([...result]);
    }

    if (command === "SINTER") {
        if (args.length < 2) return wrongArity("SINTER");
        const sets = [];
        for (let i = 1; i < args.length; i++) {
            const set = database.getSet(args[i]);
            if (set === undefined) return respError(WRONGTYPE);
            sets.push(set === null ? new Set() : set);
        }
        // Start from the smallest set for efficiency
        sets.sort((a, b) => a.size - b.size);
        const result = new Set([...sets[0]].filter(m => sets.every(s => s.has(m))));
        return respArrayOfBulks([...result]);
    }

    if (command === "SDIFF") {
        if (args.length < 2) return wrongArity("SDIFF");
        const first = database.getSet(args[1]);
        if (first === undefined) return respError(WRONGTYPE);
        if (first === null) return respArrayOfBulks([]);
        const result = new Set(first);
        for (let i = 2; i < args.length; i++) {
            const set = database.getSet(args[i]);
            if (set === undefined) return respError(WRONGTYPE);
            if (set !== null) for (const m of set) result.delete(m);
        }
        return respArrayOfBulks([...result]);
    }

    if (command === "INCR" || command === "DECR") {
        if (args.length !== 2) return wrongArity(command);

        const key = args[1];

        // Lazy expiry — treat an expired key as if it never existed
        if (expiry.isExpired(key)) {
            if (!replay) appendToAOF(`DEL ${key}`);
        }

        const existing = database.getString(key);
        if (existing === undefined) {
            // Key holds a non-string type
            return respError(WRONGTYPE);
        }

        const current = existing == null ? 0 : parseInt(existing, 10);
        if (Number.isNaN(current)) {
            return respError("ERR value is not an integer or out of range");
        }

        const next = command === "INCR" ? current + 1 : current - 1;
        database.setString(key, String(next));

        if (!replay) {
            appendToAOF(args.join(" "));
            scheduleSave(database.getAll());
        }
        return respInt(next);
    }

    return respError(`ERR unknown command '${command.toLowerCase()}'`);
}

function handlePubSubCommand(args, socket) {
    const command = args[0].toUpperCase();

    if (command === "SUBSCRIBE") {
        if (args.length !== 2) {
            return wrongArity("SUBSCRIBE");
        }

        const channel = args[1];

        // subscribe() already writes RESP acknowledgement to socket
        subscribe(channel, socket);

        // Do NOT return string response here
        return null;
    }

    if (command === "UNSUBSCRIBE") {
        if (args.length !== 2) {
            return wrongArity("UNSUBSCRIBE");
        }

        const channel = args[1];

        // unsubscribe() writes RESP acknowledgement
        unsubscribe(channel, socket);

        return null;
    }

    if (command === "PUBLISH") {
        if (args.length < 3) {
            return wrongArity("PUBLISH");
        }

        const channel = args[1];
        const message = args.slice(2).join(" ");

        // publish returns number of subscribers
        const count = publish(channel, message);

        // Publisher must receive integer reply
        return respInt(count);
    }

    return respError(`ERR unknown command '${command.toLowerCase()}'`);
}

function handleCommand(args, socket) {
    if (!args || args.length === 0) {
        return respError("ERR unknown command");
    }
    
    const command = args[0].toUpperCase();

     // Ensure tx state exists
     if (!socket.tx) {
        socket.tx = { active: false, queue: [] };
    }

    // Transaction control commands
    if (command === "MULTI") return handleMulti(socket);
    if (command === "EXEC") return handleExec(socket);
    if (command === "DISCARD") return handleDiscard(socket);

        // If in transaction → queue
        if (command === "END") {
            return handleCoreCommand(args, socket);
        }

    if (["SUBSCRIBE", "UNSUBSCRIBE", "PUBLISH"].includes(command)) {
        return handlePubSubCommand(args, socket);
    }

    return handleCoreCommand(args, socket);
}

/**
 * Replay a single AOF command without writing back to AOF or triggering
 * an RDB save. Used exclusively by loadAOF() on startup.
 *
 * @param {string[]} args  - Tokenised command, e.g. ['SET', 'k', 'v']
 */
function replayCommand(args) {
    return handleCoreCommand(args, null, { replay: true });
}

module.exports = handleCommand;
module.exports.replayCommand = replayCommand;
