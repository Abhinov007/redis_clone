const { isUtf8 } = require("buffer");
const fs= require("fs");
const rdb_file= "dump.rdb";

function save_Rdb(database){
    try{
         const snapshot= JSON.stringify(Object.fromEntries(database));
         fs.writeFileSync(rdb_file, snapshot);
         console.log("snapshot taken successfully");
    }
    catch(err){
        console.error("Error saving RDB:", err);
    }
}

function load_Rdb(database){
    if(!fs.existsSync(rdb_file)) return;
        
        try {
            const data= fs.readFileSync(rdb_file,"utf-8");
            const parse_Data=JSON.parse(data);
            Object.entries(parse_Data).forEach(([key,value])=>{
                database.set(key,value);
            });
            console.log(database);
            console.log(` Loaded ${database.size} keys from RDB.`);

        } catch (error) {
            console.error(" Error loading RDB:", error);
        
    }

}
module.exports={save_Rdb, load_Rdb};
