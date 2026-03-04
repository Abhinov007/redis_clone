const database = new Map();

function getEntry(key) {
    return database.has(key) ? database.get(key) : null;
}

function setEntry(key, entry) {
    database.set(key, entry);
}

function deleteKey(key) {
    database.delete(key);
}

function clearDatabase() {
    database.clear();
}

function getAll() {
    return database;
}

function setString(key, value) {
    setEntry(key, { type: "string", value: String(value) });
}

function getString(key) {
    const entry = getEntry(key);
    if (!entry) return null;
    if (typeof entry === "string") return entry; // legacy in-memory shape
    if (entry.type !== "string") return undefined;
    return entry.value;
}

function getOrCreateList(key) {
    const entry = getEntry(key);
    if (!entry) {
        const newEntry = { type: "list", value: [] };
        setEntry(key, newEntry);
        return newEntry.value;
    }
    if (typeof entry === "string") return undefined;
    if (entry.type !== "list") return undefined;
    return entry.value;
}

function getList(key) {
    const entry = getEntry(key);
    if (!entry) return null;
    if (typeof entry === "string") return undefined;
    if (entry.type !== "list") return undefined;
    return entry.value;
}

function getOrCreateHash(key) {
    const entry = getEntry(key);
    if (!entry) {
        const newEntry = { type: "hash", value: new Map() };
        setEntry(key, newEntry);
        return newEntry.value;
    }
    if (typeof entry === "string") return undefined;
    if (entry.type !== "hash") return undefined;
    return entry.value;
}

function getHash(key) {
    const entry = getEntry(key);
    if (!entry) return null;
    if (typeof entry === "string") return undefined;
    if (entry.type !== "hash") return undefined;
    return entry.value;
}

module.exports = {
    getEntry,
    setEntry,
    setString,
    getString,
    getOrCreateList,
    getList,
    getOrCreateHash,
    getHash,
    deleteKey,
    clearDatabase,
    getAll
};
