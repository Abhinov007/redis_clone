const fs = require("fs");
const { appendToAOF } = require("../persistence/aof");
const database = require("../storage/database");
const expiry = require("../storage/expiry");
const { save_Rdb } = require("../persistence/rdb");
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

function handleCoreCommand(args, socket) {
    if (!args || args.length === 0) {
        return respError("ERR unknown command");
    }

    const command = args[0].toUpperCase();

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
        appendToAOF(args.join(" "));

        if (ttl !== null) {
            expiry.setExpiry(key, ttl);
        }

        save_Rdb(database.getAll());
        return respSimpleString("OK");
    }

    if (command === "GET") {
        if (args.length !== 2) {
            return wrongArity("GET");
        }

        const key = args[1];

        if (expiry.isExpired(key)) {
            appendToAOF(`DEL ${key}`);
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

        appendToAOF(args.join(" "));
        save_Rdb(database.getAll());

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

        if (list.length === 0) {
            database.deleteKey(key);
        }

        appendToAOF(args.join(" "));
        save_Rdb(database.getAll());

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

        appendToAOF(args.join(" "));
        save_Rdb(database.getAll());

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

        if (removed > 0) {
            appendToAOF(args.join(" "));
            save_Rdb(database.getAll());
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
        appendToAOF(`DEL ${key}`);
        save_Rdb(database.getAll());
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
        fs.writeFileSync("database.aof", "");
        save_Rdb(database.getAll());

        return respSimpleString("OK");
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

module.exports = handleCommand;
