const fs = require("fs");
const AOF_FILE = "database.aof";
const expiry = require("./expiry");  
const database = require("./database");



function appendToAOF(command) {
    fs.appendFile(AOF_FILE, command + "\n", (err) => {
        if (err) console.error("Failed to write to AOF:", err);
    });
}

function loadAOF(database, expiry) {
    if (!fs.existsSync(AOF_FILE)) return;

    const commands = fs.readFileSync(AOF_FILE, "utf-8").split("\n");
    console.log(`Loading ${commands.length+1} commands from AOF...`);

    commands.forEach((command) => {
        if (command.trim() !== "") {
            console.log(`Executing AOF command: ${command}\r\n`);
            const parts = command.split(" ");
            if (parts[0].toUpperCase() === "SET") {
                const key = parts[1];
                const value = parts[2];
                let ttl = null;

                if (parts.length >= 5 && parts[3].toUpperCase() === "EX") {
                    ttl = parseInt(parts[4], 10);
                    if (!isNaN(ttl) && ttl > 0) {
                        expiry.setExpiry(key, ttl);
                    }
                    else {
                        console.error("Expiry module is not initialized properly.");
                    }
                }

                database.setKey(key, value);
            }
           
            }
            else if (command === "DEL") {
                if (commandParts.length !== 2) {
                    return "-ERROR: DEL requires a key\r\n";
                }
                const key = commandParts[1];
                database.deleteKey(key);
            
                
                appendToAOF(commandString);
                return ":1\r\n";
            }
            return "-ERROR: Unknown command\r\n";
        });

    console.log("AOF Replay Complete.");
}
module.exports = { appendToAOF, loadAOF };
