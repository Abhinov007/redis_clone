const fs= require("fs");
const { appendToAOF } = require("./aof");
const database= require("./database");
const expiry= require("./expiry");
const {save_Rdb}= require("./rdb");

function handleCommand(commandString){
    if (!commandString) return "-ERROR: Empty command\r\n";

    commandParts=commandString.split(" ");
    const command = commandParts[0].toUpperCase();

        if (command === "PING") {
            return "+PONG\r\n";
        }

        else if (command === "SET") {
            if (commandParts.length < 3) {
                return "-ERROR: SET requires a key and a value\r\n";
            }
       
        const key=commandParts[1];
        const value=commandParts[2];
        let ttl = null;

        if(commandParts.length>=5 && commandParts[3].toUpperCase()==="EX"){
            ttl=parseInt(commandParts[4],10);
            if(isNaN(ttl)|| ttl<0)
            return "-error: it is not a valid number\r\n"; 
        }
        database.setKey(key,value)
        if(ttl){
            expiry.setExpiry(key,ttl);
            appendToAOF(commandString);
            save_Rdb(database.getAll());
        }
        return "+OK\r\n";
    }

    else if (command === "GET") {
        if (commandParts.length != 2) {
            return "-ERROR: SET requires a key and a value\r\n";
        }
        const key= commandParts[1];
        if(expiry.isExpired(key)){
            database.deleteKey(key);
            appendToAOF(commandString);
            return "$-1\r\n";
        }
        const value=database.getKey(key);
        if(value==null){
            return "$-1\r\n";
        }
        
        return `+${value}\r\n`;

    }
    if (command === "DEL") {
        if (commandParts.length !== 2) {
            return "-ERROR: DEL requires a key\r\n";
        }

        const key = commandParts[1];
        database.deleteKey(key);
        appendToAOF(`DEL ${key}`);
        save_Rdb(database.getAll()); 
        return ":1\r\n"; // Redis-like response
    }
    
    else if (command === "END") {
        socket.write("+Closing connection...\r\n");
        socket.end(); 
        return null;  
    }
    else if (command === "FLUSHALL") {
        database.clearDatabase();  
        expiry.clearExpiry();      
    
        fs.writeFileSync("database.aof", " ");  // Clear AOF file
    
        return "+OK\r\n";  
    }

    return "-ERROR: Unknown command\r\n";
    

}    

    module.exports = handleCommand;