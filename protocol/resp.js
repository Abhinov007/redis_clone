function respSimpleString(str) {
    return `+${str}\r\n`;
}

function respError(message) {
    return `-${message}\r\n`;
}

function respInt(n) {
    return `:${Number(n)}\r\n`;
}

function respBulk(str) {
    if (str === null || str === undefined) return "$-1\r\n";
    const s = String(str);
    return `$${s.length}\r\n${s}\r\n`;
}

function respArray(items) {
    if (!Array.isArray(items)) return "*0\r\n";
    let out = `*${items.length}\r\n`;
    for (const item of items) {
        out += item;
    }
    return out;
}

function respArrayOfBulks(values) {
    return respArray((values || []).map((v) => respBulk(v)));
}

module.exports = {
    respSimpleString,
    respError,
    respInt,
    respBulk,
    respArray,
    respArrayOfBulks
};
