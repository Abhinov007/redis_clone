/**
 * Phase 3 Completeness Tests
 *
 * Fix #9  — Key-space  : EXISTS, TYPE, RENAME, KEYS
 * Fix #10 — Strings    : MSET, MGET, SETNX, STRLEN, APPEND, INCRBY, DECRBY
 * Fix #11 — Lists      : LINDEX, LSET, LTRIM
 * Fix #13 — Sets       : SADD, SREM, SMEMBERS, SCARD, SISMEMBER, SUNION, SINTER, SDIFF
 */

"use strict";

const net    = require("net");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const SERVER   = path.join(__dirname, "../server.js");
const AOF_FILE = path.join(__dirname, "../database.aof");
const RDB_FILE = path.join(__dirname, "../dump.rdb");

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function pass(label)               { console.log(`  ✅  ${label}`); passed++; }
function fail(label, detail = "")  { console.error(`  ❌  ${label}`); if (detail) console.error(`       ${detail}`); failed++; }
function assert(ok, label, detail) { ok ? pass(label) : fail(label, detail); }

function resp(...args) {
    let s = `*${args.length}\r\n`;
    for (const a of args) s += `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`;
    return s;
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port }, () => {});
        socket.once("error", reject);
        let buf = "";
        socket.on("data", function drain(chunk) {
            buf += chunk.toString();
            if (buf.includes("\r\n")) { socket.removeListener("data", drain); resolve(socket); }
        });
    });
}

function readN(socket, count) {
    return new Promise((resolve, reject) => {
        const results = [];
        let buf = "", skipNext = false;
        const timer = setTimeout(() => {
            socket.removeListener("data", handler);
            reject(new Error(`Timeout waiting for ${count} responses (got ${results.length})`));
        }, 8000);

        function handler(chunk) {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\r\n")) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (skipNext) { skipNext = false; continue; }
                const t = line[0];
                if (t === "+" || t === "-" || t === ":") {
                    results.push(line);
                } else if (t === "$") {
                    const len = parseInt(line.slice(1), 10);
                    if (len === -1) results.push("$-1");
                    else { results.push(line); skipNext = true; }
                }
                // "*" array headers not counted
                if (results.length >= count) {
                    clearTimeout(timer);
                    socket.removeListener("data", handler);
                    resolve(results);
                    return;
                }
            }
        }
        socket.on("data", handler);
    });
}

/** Read a full RESP array response as an array of bulk strings */
function readArray(socket) {
    return new Promise((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => {
            socket.removeListener("data", handler);
            reject(new Error("Timeout reading array"));
        }, 8000);

        function handler(chunk) {
            buf += chunk.toString();
            // Wait until we have the array header
            const nl = buf.indexOf("\r\n");
            if (nl === -1) return;
            const header = buf.slice(0, nl);
            if (header[0] !== "*") {
                clearTimeout(timer);
                socket.removeListener("data", handler);
                resolve({ raw: header });
                return;
            }
            const count = parseInt(header.slice(1), 10);
            if (count === 0) {
                clearTimeout(timer);
                socket.removeListener("data", handler);
                resolve([]);
                return;
            }
            // Accumulate until we have count bulk strings
            const items = [];
            let pos = nl + 2;
            while (items.length < count) {
                const nl2 = buf.indexOf("\r\n", pos);
                if (nl2 === -1) return; // wait for more data
                const bHeader = buf.slice(pos, nl2);
                pos = nl2 + 2;
                if (bHeader === "$-1") { items.push(null); continue; }
                const len = parseInt(bHeader.slice(1), 10);
                const end = pos + len;
                if (buf.length < end + 2) return; // wait for more data
                items.push(buf.slice(pos, end));
                pos = end + 2;
            }
            clearTimeout(timer);
            socket.removeListener("data", handler);
            resolve(items);
        }
        socket.on("data", handler);
    });
}

function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER, "--port", String(port)], {
            cwd: path.join(__dirname, ".."),
        });
        child.stderr.on("data", () => {});
        child.stdout.on("data", d => { if (d.toString().includes("running on port")) resolve(child); });
        child.on("error", reject);
        setTimeout(() => reject(new Error("Server did not start in time")), 6000);
    });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function cleanup() {
    for (const f of [AOF_FILE, RDB_FILE])
        if (fs.existsSync(f)) fs.unlinkSync(f);
}

// ── Fix #9: Key-space ─────────────────────────────────────────────────────────

async function testFix9_KeySpace() {
    console.log("\n── Fix #9: Key-space (EXISTS, TYPE, RENAME, KEYS) ──");
    const PORT = 6374;
    let server, socket;
    try {
        cleanup();
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // Seed data of every type
        socket.write(resp("SET",   "str",  "hello"));
        socket.write(resp("LPUSH", "lst",  "a"));
        socket.write(resp("HSET",  "hsh",  "f", "v"));
        socket.write(resp("SADD",  "st",   "x"));
        await readN(socket, 4);

        // EXISTS — single key
        socket.write(resp("EXISTS", "str"));
        const [ex1] = await readN(socket, 1);
        assert(ex1 === ":1", `EXISTS on existing key → 1 (got ${ex1})`);

        // EXISTS — missing key
        socket.write(resp("EXISTS", "nope"));
        const [ex2] = await readN(socket, 1);
        assert(ex2 === ":0", `EXISTS on missing key → 0 (got ${ex2})`);

        // EXISTS — multi-key (duplicates count)
        socket.write(resp("EXISTS", "str", "str", "nope"));
        const [ex3] = await readN(socket, 1);
        assert(ex3 === ":2", `EXISTS multi-key with dup → 2 (got ${ex3})`);

        // TYPE
        for (const [key, expected] of [["str","string"],["lst","list"],["hsh","hash"],["st","set"],["nope","none"]]) {
            socket.write(resp("TYPE", key));
            const [t] = await readN(socket, 1);
            assert(t === `+${expected}`, `TYPE ${key} → ${expected} (got ${t})`);
        }

        // RENAME
        socket.write(resp("RENAME", "str", "str2"));
        const [ren1] = await readN(socket, 1);
        assert(ren1 === "+OK", `RENAME returns +OK (got ${ren1})`);

        socket.write(resp("EXISTS", "str"));
        socket.write(resp("EXISTS", "str2"));
        const [gone, here] = await readN(socket, 2);
        assert(gone === ":0", `Source key gone after RENAME (got ${gone})`);
        assert(here === ":1", `Dest key exists after RENAME (got ${here})`);

        // RENAME non-existent key → error
        socket.write(resp("RENAME", "nokey", "dst"));
        const [renErr] = await readN(socket, 1);
        assert(renErr.startsWith("-ERR"), `RENAME missing key → -ERR (got ${renErr})`);

        // KEYS with glob patterns
        socket.write(resp("SET", "user:1", "a"));
        socket.write(resp("SET", "user:2", "b"));
        socket.write(resp("SET", "post:1", "c"));
        await readN(socket, 3);

        socket.write(resp("KEYS", "user:*"));
        const userKeys = await readArray(socket);
        assert(Array.isArray(userKeys) && userKeys.length === 2,
            `KEYS user:* → 2 keys (got ${JSON.stringify(userKeys)})`);

        socket.write(resp("KEYS", "*:1"));
        const col1Keys = await readArray(socket);
        assert(Array.isArray(col1Keys) && col1Keys.length === 2,
            `KEYS *:1 → 2 keys (got ${JSON.stringify(col1Keys)})`);

        socket.write(resp("KEYS", "user:?"));
        const qKeys = await readArray(socket);
        assert(Array.isArray(qKeys) && qKeys.length === 2,
            `KEYS user:? → 2 keys (got ${JSON.stringify(qKeys)})`);

        socket.write(resp("KEYS", "nomatchwhatsoever"));
        const empty = await readArray(socket);
        assert(Array.isArray(empty) && empty.length === 0,
            `KEYS no-match → empty array (got ${JSON.stringify(empty)})`);

    } catch (err) {
        fail("Fix #9 threw unexpectedly", err.message);
    } finally {
        socket?.destroy(); server?.kill(); await wait(300); cleanup();
    }
}

// ── Fix #10: String completeness ─────────────────────────────────────────────

async function testFix10_Strings() {
    console.log("\n── Fix #10: String completeness (MSET, MGET, SETNX, STRLEN, APPEND, INCRBY, DECRBY) ──");
    const PORT = 6373;
    let server, socket;
    try {
        cleanup();
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // MSET
        socket.write(resp("MSET", "k1", "v1", "k2", "v2", "k3", "v3"));
        const [mset] = await readN(socket, 1);
        assert(mset === "+OK", `MSET → +OK (got ${mset})`);

        // MGET
        socket.write(resp("MGET", "k1", "k2", "k3", "missing"));
        const mget = await readArray(socket);
        assert(Array.isArray(mget) && mget[0] === "v1" && mget[1] === "v2" && mget[2] === "v3" && mget[3] === null,
            `MGET returns correct values (got ${JSON.stringify(mget)})`);

        // SETNX — key doesn't exist → sets it
        socket.write(resp("SETNX", "nx1", "val"));
        const [setnx1] = await readN(socket, 1);
        assert(setnx1 === ":1", `SETNX on new key → 1 (got ${setnx1})`);

        // SETNX — key exists → no-op
        socket.write(resp("SETNX", "nx1", "other"));
        const [setnx2] = await readN(socket, 1);
        assert(setnx2 === ":0", `SETNX on existing key → 0 (got ${setnx2})`);

        // STRLEN
        socket.write(resp("SET", "slen", "hello"));
        await readN(socket, 1);
        socket.write(resp("STRLEN", "slen"));
        const [strlen] = await readN(socket, 1);
        assert(strlen === ":5", `STRLEN "hello" → 5 (got ${strlen})`);

        socket.write(resp("STRLEN", "missing"));
        const [strlen0] = await readN(socket, 1);
        assert(strlen0 === ":0", `STRLEN missing key → 0 (got ${strlen0})`);

        // APPEND
        socket.write(resp("SET", "app", "Hello"));
        await readN(socket, 1);
        socket.write(resp("APPEND", "app", " World"));
        const [appLen] = await readN(socket, 1);
        assert(appLen === ":11", `APPEND → length 11 (got ${appLen})`);

        socket.write(resp("STRLEN", "app"));
        const [appStrLen] = await readN(socket, 1);
        assert(appStrLen === ":11", `STRLEN after APPEND → 11 (got ${appStrLen})`);

        // INCRBY / DECRBY
        socket.write(resp("SET", "ctr", "10"));
        await readN(socket, 1);
        socket.write(resp("INCRBY", "ctr", "5"));
        const [inc5] = await readN(socket, 1);
        assert(inc5 === ":15", `INCRBY 5 → 15 (got ${inc5})`);

        socket.write(resp("DECRBY", "ctr", "3"));
        const [dec3] = await readN(socket, 1);
        assert(dec3 === ":12", `DECRBY 3 → 12 (got ${dec3})`);

        // INCRBY on missing key starts at 0
        socket.write(resp("INCRBY", "newctr", "7"));
        const [new7] = await readN(socket, 1);
        assert(new7 === ":7", `INCRBY on missing key → 7 (got ${new7})`);

        // INCRBY with non-integer delta → error
        socket.write(resp("INCRBY", "ctr", "notnum"));
        const [incrErr] = await readN(socket, 1);
        assert(incrErr.startsWith("-ERR"), `INCRBY non-integer delta → -ERR (got ${incrErr})`);

    } catch (err) {
        fail("Fix #10 threw unexpectedly", err.message);
    } finally {
        socket?.destroy(); server?.kill(); await wait(300); cleanup();
    }
}

// ── Fix #11: List completeness ────────────────────────────────────────────────

async function testFix11_Lists() {
    console.log("\n── Fix #11: List completeness (LINDEX, LSET, LTRIM) ──");
    const PORT = 6372;
    let server, socket;
    try {
        cleanup();
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // Seed: list = [a, b, c, d, e]
        socket.write(resp("RPUSH", "lst", "a", "b", "c", "d", "e"));
        await readN(socket, 1);

        // LINDEX — positive
        socket.write(resp("LINDEX", "lst", "0"));
        const [li0] = await readN(socket, 1);
        assert(li0 === "$1", `LINDEX 0 returns bulk string (got ${li0})`);

        socket.write(resp("LINDEX", "lst", "4"));
        const [li4] = await readN(socket, 1);
        assert(li4 === "$1", `LINDEX 4 returns bulk string (got ${li4})`);

        // LINDEX — negative
        socket.write(resp("LINDEX", "lst", "-1"));
        const [liNeg] = await readN(socket, 1);
        assert(liNeg === "$1", `LINDEX -1 (last) returns bulk string (got ${liNeg})`);

        // LINDEX — out of range
        socket.write(resp("LINDEX", "lst", "99"));
        const [liOOB] = await readN(socket, 1);
        assert(liOOB === "$-1", `LINDEX out of range → null (got ${liOOB})`);

        // LSET
        socket.write(resp("LSET", "lst", "2", "C"));
        const [lset] = await readN(socket, 1);
        assert(lset === "+OK", `LSET → +OK (got ${lset})`);

        socket.write(resp("LINDEX", "lst", "2"));
        const [liAfterSet] = await readN(socket, 1);
        assert(liAfterSet === "$1", `LINDEX after LSET returns bulk string header (got ${liAfterSet})`);

        // LSET out of range
        socket.write(resp("LSET", "lst", "99", "x"));
        const [lsetErr] = await readN(socket, 1);
        assert(lsetErr.startsWith("-ERR"), `LSET out of range → -ERR (got ${lsetErr})`);

        // LTRIM — keep middle 3: [b, C, d]
        socket.write(resp("LTRIM", "lst", "1", "3"));
        const [ltrim] = await readN(socket, 1);
        assert(ltrim === "+OK", `LTRIM → +OK (got ${ltrim})`);

        socket.write(resp("LLEN", "lst"));
        const [llenAfter] = await readN(socket, 1);
        assert(llenAfter === ":3", `LLEN after LTRIM → 3 (got ${llenAfter})`);

        // LTRIM to empty range — deletes key
        socket.write(resp("LTRIM", "lst", "10", "20"));
        await readN(socket, 1);
        socket.write(resp("EXISTS", "lst"));
        const [exAfterTrim] = await readN(socket, 1);
        assert(exAfterTrim === ":0", `Key deleted after LTRIM empties list (got ${exAfterTrim})`);

        // LTRIM with negative indices
        socket.write(resp("RPUSH", "lst2", "x", "y", "z"));
        await readN(socket, 1);
        socket.write(resp("LTRIM", "lst2", "0", "-2"));
        await readN(socket, 1);
        socket.write(resp("LLEN", "lst2"));
        const [llen2] = await readN(socket, 1);
        assert(llen2 === ":2", `LTRIM with negative stop → 2 elements remain (got ${llen2})`);

    } catch (err) {
        fail("Fix #11 threw unexpectedly", err.message);
    } finally {
        socket?.destroy(); server?.kill(); await wait(300); cleanup();
    }
}

// ── Fix #13: Sets ─────────────────────────────────────────────────────────────

async function testFix13_Sets() {
    console.log("\n── Fix #13: Sets (SADD, SREM, SMEMBERS, SCARD, SISMEMBER, SUNION, SINTER, SDIFF) ──");
    const PORT = 6371;
    let server, socket;
    try {
        cleanup();
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // SADD
        socket.write(resp("SADD", "s1", "a", "b", "c"));
        const [sadd1] = await readN(socket, 1);
        assert(sadd1 === ":3", `SADD 3 new members → 3 (got ${sadd1})`);

        // SADD duplicate → 0 new
        socket.write(resp("SADD", "s1", "a", "a", "b"));
        const [sadd2] = await readN(socket, 1);
        assert(sadd2 === ":0", `SADD duplicates → 0 (got ${sadd2})`);

        // SCARD
        socket.write(resp("SCARD", "s1"));
        const [sc1] = await readN(socket, 1);
        assert(sc1 === ":3", `SCARD s1 → 3 (got ${sc1})`);

        socket.write(resp("SCARD", "noset"));
        const [sc0] = await readN(socket, 1);
        assert(sc0 === ":0", `SCARD missing key → 0 (got ${sc0})`);

        // SISMEMBER
        socket.write(resp("SISMEMBER", "s1", "a"));
        const [sim1] = await readN(socket, 1);
        assert(sim1 === ":1", `SISMEMBER existing member → 1 (got ${sim1})`);

        socket.write(resp("SISMEMBER", "s1", "z"));
        const [sim0] = await readN(socket, 1);
        assert(sim0 === ":0", `SISMEMBER missing member → 0 (got ${sim0})`);

        // SMEMBERS
        socket.write(resp("SMEMBERS", "s1"));
        const members = await readArray(socket);
        assert(Array.isArray(members) && members.length === 3 &&
               ["a","b","c"].every(m => members.includes(m)),
            `SMEMBERS s1 → {a,b,c} (got ${JSON.stringify(members)})`);

        // SREM
        socket.write(resp("SREM", "s1", "b"));
        const [srem1] = await readN(socket, 1);
        assert(srem1 === ":1", `SREM existing member → 1 (got ${srem1})`);

        socket.write(resp("SREM", "s1", "z"));
        const [srem0] = await readN(socket, 1);
        assert(srem0 === ":0", `SREM missing member → 0 (got ${srem0})`);

        socket.write(resp("SCARD", "s1"));
        const [scAfterRem] = await readN(socket, 1);
        assert(scAfterRem === ":2", `SCARD after SREM → 2 (got ${scAfterRem})`);

        // SREM all members deletes the key
        socket.write(resp("SREM", "s1", "a", "c"));
        await readN(socket, 1);
        socket.write(resp("EXISTS", "s1"));
        const [exAfterRem] = await readN(socket, 1);
        assert(exAfterRem === ":0", `Key deleted when set emptied via SREM (got ${exAfterRem})`);

        // Set-algebra: s2 = {a,b,c}, s3 = {b,c,d}
        socket.write(resp("SADD", "s2", "a", "b", "c"));
        socket.write(resp("SADD", "s3", "b", "c", "d"));
        await readN(socket, 2);

        // SUNION
        socket.write(resp("SUNION", "s2", "s3"));
        const union = await readArray(socket);
        assert(Array.isArray(union) && union.length === 4 &&
               ["a","b","c","d"].every(m => union.includes(m)),
            `SUNION {a,b,c}∪{b,c,d} → {a,b,c,d} (got ${JSON.stringify(union)})`);

        // SINTER
        socket.write(resp("SINTER", "s2", "s3"));
        const inter = await readArray(socket);
        assert(Array.isArray(inter) && inter.length === 2 &&
               ["b","c"].every(m => inter.includes(m)),
            `SINTER {a,b,c}∩{b,c,d} → {b,c} (got ${JSON.stringify(inter)})`);

        // SDIFF
        socket.write(resp("SDIFF", "s2", "s3"));
        const diff = await readArray(socket);
        assert(Array.isArray(diff) && diff.length === 1 && diff[0] === "a",
            `SDIFF {a,b,c}\\{b,c,d} → {a} (got ${JSON.stringify(diff)})`);

        // WRONGTYPE errors
        socket.write(resp("SET",    "strkey", "x"));
        await readN(socket, 1);
        socket.write(resp("SADD",   "strkey", "m"));
        const [typeErr] = await readN(socket, 1);
        assert(typeErr.startsWith("-WRONGTYPE"), `SADD on string key → -WRONGTYPE (got ${typeErr})`);

        // Sets survive a restart (AOF replay)
        socket.write(resp("SADD", "persist_set", "p", "q", "r"));
        await readN(socket, 1);
        await wait(400);
        socket.destroy();
        server.kill();
        await wait(400);

        const server2 = await startServer(PORT);
        await wait(400);
        const socket2 = await connect(PORT);

        socket2.write(resp("SMEMBERS", "persist_set"));
        const reloaded = await readArray(socket2);
        assert(Array.isArray(reloaded) && reloaded.length === 3 &&
               ["p","q","r"].every(m => reloaded.includes(m)),
            `Set survives server restart via AOF (got ${JSON.stringify(reloaded)})`);

        socket2.destroy();
        server2.kill();
        await wait(300);

    } catch (err) {
        fail("Fix #13 threw unexpectedly", err.message);
    } finally {
        socket?.destroy(); server?.kill(); await wait(300); cleanup();
    }
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
    console.log("=== Phase 3 Completeness Tests ===");
    await testFix9_KeySpace();
    await testFix10_Strings();
    await testFix11_Lists();
    await testFix13_Sets();
    console.log(`\n${"─".repeat(44)}`);
    console.log(`  ${passed} passed  |  ${failed} failed`);
    console.log("─".repeat(44));
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error("Runner crashed:", err); process.exit(1); });
