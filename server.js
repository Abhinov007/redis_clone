const net = require("net");
const handleCommand = require("./command");
const database = require("./database");
const expiry = require("./expiry");
const { loadAOF } = require("./aof");
const { load_Rdb } = require("./rdb")


const server = net.createServer((socket) => {
    console.log("New client connected");
    socket.write("+Welcome to Redis clone!\r\n");
    let buffer = "";

    socket.on("data", (data) => {
        buffer+=data.toString();
        

if (buffer.includes("\r\n")) {
            const command = buffer.trim();
            buffer = ""; 

            console.log(`Processing command: ${command}`);
            let res = handleCommand(command);
            if (!res) res = "-ERROR: Internal server error\r\n";  

            socket.write(res);
        }
    });

    /*socket.on("end", () => {
        console.log("Client disconnected");
    });*/

    socket.on("error", (err) => {
        console.error("Socket error:", err);
    });
});

const PORT = 6379;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

    loadAOF(database, expiry);
    load_Rdb(database.getAll());
});
