const net = require("net");
const handleCommand = require("./commands/command");
const database = require("./storage/database");
const expiry = require("./storage/expiry");
const { loadAOF } = require("./persistence/aof");
const { load_Rdb } = require("./persistence/rdb");
const { unsubscribeAll } = require("./messaging/pubsub");
const RESPParser = require("./RESPParser");

const server = net.createServer((socket) => {
    console.log("New client connected:", socket.remoteAddress);
    socket.write("+Welcome to Redis clone!\r\n");

    // Mode is decided on the first non-whitespace byte:
    // - RESP mode: client speaks RESP arrays
    // - Inline mode: client speaks simple space-separated lines
    let mode = null;
    const respParser = new RESPParser();
    let inlineBuffer = "";

    socket.on("data", (data) => {
        try {
            const chunk = data.toString();
            console.log("RAW:", JSON.stringify(chunk));

            if (mode === null) {
                const combined = (inlineBuffer + chunk).replace(/^\s+/, "");
                const first = combined[0];
                mode = first === "*" ? "resp" : "inline";
            }

            if (mode === "resp") {
                const commands = respParser.push(chunk);
                for (const args of commands) {
                    if (!Array.isArray(args) || args.length === 0) continue;
                    console.log("Parsed:", args);
                    const res = handleCommand(args, socket);
                    if (res) socket.write(res);
                }
                return;
            }

            // inline mode
            inlineBuffer += chunk;
            while (inlineBuffer.length > 0) {
                const newlineIndex = inlineBuffer.indexOf("\r\n");
                if (newlineIndex === -1) break;

                const line = inlineBuffer.slice(0, newlineIndex).trim();
                inlineBuffer = inlineBuffer.slice(newlineIndex + 2);

                if (!line) continue;

                const args = line.split(" ");
                console.log("Parsed:", args);
                const res = handleCommand(args, socket);
                if (res) socket.write(res);
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

    server.on("connection", (socket) => {
        socket.tx = {
            active: false,
            queue: []
        };
    });
});

const PORT = 6379;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

    try {
        load_Rdb(database.getAll());
        loadAOF(database, expiry);
        console.log("Persistence loaded successfully.");
    } catch (err) {
        console.error("Persistence loading failed:", err);
    }
});