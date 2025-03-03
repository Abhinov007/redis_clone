const database= require("./database");
const expiryStore = new Map();

function setExpiry(key, ttl) {
    const expiryAt = Date.now() + ttl * 1000;
    
    expiryStore.set(key, expiryAt);
}

function isExpired(key) {
    if (!expiryStore.has(key)) return false;
    const expiryAt = expiryStore.get(key);
    if (Date.now() > expiryAt) {
        expiryStore.delete(key); 
        database.deleteKey(key); 
        return true;
    }
    return false;
}
function clearExpiry() {
    expiryStore.clear();  // Clears all expiry times
}

module.exports = { setExpiry, isExpired, clearExpiry };
