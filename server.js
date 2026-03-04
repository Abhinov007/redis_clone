const net = require("net");
const handleCommand = require("./command");
const database = require("./database");
const expiry = require("./expiry");
const { loadAOF } = require("./aof");
const { load_Rdb } = require("./rdb");
const { unsubscribeAll } = require("./pubsub");

function parseRESPArray(buffer) {
    if (!buffer.startsWith("*")) return null;

    let idx = 1;

    const readLine = () => {
        const end = buffer.indexOf("\r\n", idx);
        if (end === -1) return null;
        const line = buffer.slice(idx, end);
        idx = end + 2;
        return line;
    };

    const countLine = readLine();
    if (countLine === null) return null;
    const count = parseInt(countLine, 10);
    if (isNaN(count) || count < 0) return null;

    const args = [];

    for (let i = 0; i < count; i++) {
        if (buffer[idx] !== "$") return null;
        idx += 1;

        const lenLine = readLine();
        if (lenLine === null) return null;
        const len = parseInt(lenLine, 10);
        if (isNaN(len) || len < 0) return null;

        if (buffer.length < idx + len + 2) {
            // Incomplete bulk string, wait for more data
            return null;
        }

        const value = buffer.slice(idx, idx + len);
        idx += len + 2; // Skip over bulk data and trailing CRLF
        args.push(value);
    }

    return { args, bytesUsed: idx };
}

const server = net.createServer((socket) => {
    console.log("New client connected:", socket.remoteAddress);
    socket.write("+Welcome to Redis clone!\r\n");

    let buffer = "";

    socket.on("data", (data) => {
        try {
            const chunk = data.toString();
            console.log("RAW:", JSON.stringify(chunk));
            buffer += chunk;

            while (buffer.length > 0) {
                let args = null;

                if (buffer.startsWith("*")) {
                    const parsed = parseRESPArray(buffer);
                    if (!parsed) {
                        // Need more data for a full RESP message
                        break;
                    }
                    args = parsed.args;
                    buffer = buffer.slice(parsed.bytesUsed);
                } else {
                    const newlineIndex = buffer.indexOf("\r\n");
                    if (newlineIndex === -1) {
                        // Wait for full line
                        break;
                    }

                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 2);

                    if (!line) {
                        continue;
                    }

                    args = line.split(" ");
                }

                if (!args || args.length === 0) {
                    continue;
                }

                console.log("Parsed:", args);
                const res = handleCommand(args, socket);

                if (res) {
                    socket.write(res);
                }
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
        console.log("Client disconnected:", socket.remoteAddress);
    });
});

const PORT = 6379;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

    try {
        loadAOF(database, expiry);
        load_Rdb(database.getAll());
        console.log("Persistence loaded successfully.");
    } catch (err) {
        console.error("Persistence loading failed:", err);
    }
});