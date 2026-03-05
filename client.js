const net = require("net");
const readline = require("readline");

// Parse --port argument
const args = process.argv.slice(2);
let port = 6379;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
        port = parseInt(args[i + 1], 10);
        i++;
    }
}

// Create a connection to the server
const client = net.createConnection({ port }, () => {
    console.log(`Connected to Redis Clone Server on port ${port}`);
});

// Read input from the terminal
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function promptUser() {
    rl.question("> ", (command) => {
        if (command.trim().toLowerCase() === "exit") {
            console.log("Closing connection...");
            client.end(); // Close the connection
            rl.close();
            return;
        }
        client.write(command + "\r\n"); // Send command to server
        promptUser();
    });
}

client.on("data", (data) => {
    console.log(data.toString()); // Print server response
});

client.on("end", () => {
    console.log("Disconnected from server");
});

client.on("error", (err) => {
    console.error("Connection error:", err);
});

// Start prompting user
promptUser();
