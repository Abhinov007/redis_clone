const net = require("net");
const handleCommand = require("./command");
const database = require("./database");
const expiry = require("./expiry");
const { loadAOF } = require("./aof");
const { load_Rdb } = require("./rdb");
const RESPParser = require("./RESPParser");

const server = net.createServer((socket) => {
    console.log("New client connected:", socket.remoteAddress);

    socket.write("+Welcome to Redis clone!\r\n");

    // Each client gets its own parser
    const parser = new RESPParser();

    socket.on("data", (data) => {
        try {
            // Debug raw TCP payload
            console.log("RAW:", JSON.stringify(data.toString()));

            const commands = parser.push(data.toString());

            if (commands.length === 0) {
                // Incomplete frame — waiting for more TCP data
                return;
            }

            for (const args of commands) {
                if (!Array.isArray(args) || args.length === 0) continue;

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
        console.log("Client disconnected:", socket.remoteAddress);
    });
});

const PORT = 6379;

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

    // 🔹 Load persistence on startup
    try {
        loadAOF(database, expiry);
        load_Rdb(database.getAll());
        console.log("Persistence loaded successfully.");
    } catch (err) {
        console.error("Persistence loading failed:", err);
    }
});