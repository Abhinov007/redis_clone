const fs = require("fs");
const { appendToAOF } = require("./aof");
const database = require("./database");
const expiry = require("./expiry");
const { save_Rdb } = require("./rdb");
const { subscribe, publish, unsubscribe } = require("./pubsub");

function wrongArity(command) {
    return `-ERR wrong number of arguments for '${command.toLowerCase()}' command\r\n`;
}

function handleCoreCommand(args, socket) {
    if (!args || args.length === 0) {
        return "-ERR unknown command\r\n";
    }

    const command = args[0].toUpperCase();

    if (command === "PING") {
        if (args.length !== 1) {
            return wrongArity("PING");
        }
        return "+PONG\r\n";
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
                return "-ERR value is not an integer or out of range\r\n";
            }
        } else if (args.length !== 3) {
            // Extra args that are not a valid EX option
            return wrongArity("SET");
        }

        database.setKey(key, value);
        appendToAOF(args.join(" "));

        if (ttl !== null) {
            expiry.setExpiry(key, ttl);
        }

        save_Rdb(database.getAll());
        return "+OK\r\n";
    }

    if (command === "GET") {
        if (args.length !== 2) {
            return wrongArity("GET");
        }

        const key = args[1];

        if (expiry.isExpired(key)) {
            appendToAOF(`DEL ${key}`);
            return "$-1\r\n";
        }

        const value = database.getKey(key);
        if (value == null) {
            return "$-1\r\n";
        }

        return `$${value.length}\r\n${value}\r\n`;
    }

    if (command === "DEL") {
        if (args.length !== 2) {
            return wrongArity("DEL");
        }

        const key = args[1];
        database.deleteKey(key);
        appendToAOF(`DEL ${key}`);
        save_Rdb(database.getAll());
        return ":1\r\n";
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

        return "+OK\r\n";
    }

    return `-ERR unknown command '${command.toLowerCase()}'\r\n`;
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

    if (command === "PUBLISH") {
        if (args.length < 3) {
            return wrongArity("PUBLISH");
        }

        const channel = args[1];
        const message = args.slice(2).join(" ");

        // publish returns number of subscribers
        const count = publish(channel, message);

        // Publisher must receive integer reply
        return `:${count}\r\n`;
    }

    return `-ERR unknown command '${command.toLowerCase()}'\r\n`;
}

function handleCommand(args, socket) {
    if (!args || args.length === 0) {
        return "-ERR unknown command\r\n";
    }

    const command = args[0].toUpperCase();

    if (["SUBSCRIBE", "PUBLISH"].includes(command)) {
        return handlePubSubCommand(args, socket);
    }

    return handleCoreCommand(args, socket);
}

module.exports = handleCommand;