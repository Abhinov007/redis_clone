const database= new Map();

function setKey(key, value){
    database.set(key,value);
    console.log(key, value);
}
function getKey(key){
    return database.has(key) ? database.get(key) : null;
    
}
function deleteKey(key) {  
    database.delete(key);
}
function clearDatabase() {
    database.clear();  // Clears all stored keys
}
function getAll() {
    return database; // Return full dataset
}

module.exports = { setKey, getKey, deleteKey, clearDatabase, getAll};