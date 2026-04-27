/**
 * Phase 2 Correctness Tests
 *
 * Fix #4 — Active expiry sweep  : keys with TTLs are evicted even without reads
 * Fix #5 — AOF replay merge     : restart rebuilds all data types correctly
 * Fix #6 — INCR / DECR          : integer counters work & persist
 */

"use strict";

const net    = require("net");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const SERVER   = path.join(__dirname, "../server.js");
const AOF_FILE = path.join(__dirname, "../database.aof");
const RDB_FILE = path.join(__dirname, "../dump.rdb");

// ── Assertion helpers ─────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function pass(label)              { console.log(`  ✅  ${label}`); passed++; }
function fail(label, detail = "") { console.error(`  ❌  ${label}`); if (detail) console.error(`       ${detail}`); failed++; }
function assert(ok, label, detail){ ok ? pass(label) : fail(label, detail); }

// ── RESP helpers ──────────────────────────────────────────────────────────────

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
            if (buf.includes("\r\n")) {
                socket.removeListener("data", drain);
                resolve(socket);
            }
        });
    });
}

function readN(socket, count) {
    return new Promise((resolve, reject) => {
        const results = [];
        let buf = "";
        let skipNextLine = false;

        const timer = setTimeout(() => {
            socket.removeListener("data", handler);
            reject(new Error(`Timeout: got ${results.length}/${count} responses`));
        }, 8000);

        function handler(chunk) {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\r\n")) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                if (skipNextLine) { skipNextLine = false; continue; }

                const type = line[0];
                if (type === "+" || type === "-" || type === ":") {
                    results.push(line);
                } else if (type === "$") {
                    const len = parseInt(line.slice(1), 10);
                    if (len === -1) {
                        results.push("$-1");
                    } else {
                        results.push(line);
                        skipNextLine = true;
                    }
                }
                // "*" array headers are not counted

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

function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER, "--port", String(port)], {
            cwd: path.join(__dirname, ".."),
        });
        child.stderr.on("data", () => {});
        child.stdout.on("data", (d) => {
            if (d.toString().includes("running on port")) resolve(child);
        });
        child.on("error", reject);
        setTimeout(() => reject(new Error("Server did not start")), 6000);
    });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fix #4: Active expiry sweep ───────────────────────────────────────────────

async function testFix4_ActiveExpiry() {
    console.log("\n── Fix #4: Active expiry sweep (keys expire without being read) ──");

    const PORT = 6382;
    let server, socket;

    try {
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // Write 5 keys with a 1-second TTL, never read them back
        for (let i = 0; i < 5; i++) {
            socket.write(resp("SET", `ttl_key_${i}`, `val_${i}`, "EX", "1"));
        }
        await readN(socket, 5);     // drain the +OK responses

        // Wait >1 s for TTLs to expire, then another 200 ms for the sweep tick
        await wait(1400);

        // The sweep should have evicted all five keys — GETs should return null
        for (let i = 0; i < 5; i++) {
            socket.write(resp("GET", `ttl_key_${i}`));
        }
        const gets = await readN(socket, 5);

        const allNull = gets.every(r => r === "$-1");
        assert(allNull, "All TTL-expired keys return null bulk after sweep", `Got: ${gets.join(", ")}`);

    } catch (err) {
        fail("Fix #4 threw unexpectedly", err.message);
    } finally {
        socket?.destroy();
        server?.kill();
        await wait(300);
    }
}

// ── Fix #5: AOF replay correctness ───────────────────────────────────────────

async function testFix5_AOFReplay() {
    console.log("\n── Fix #5: AOF replay (all data types survive a restart) ──");

    const PORT  = 6381;
    let server1, server2, socket;

    try {
        // Clean slate
        if (fs.existsSync(AOF_FILE)) fs.unlinkSync(AOF_FILE);
        if (fs.existsSync(RDB_FILE)) fs.unlinkSync(RDB_FILE);

        // ── Phase A: write diverse data ───────────────────────────────────────
        server1 = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        socket.write(resp("SET",   "str_key",  "hello"));
        socket.write(resp("INCR",  "counter"));
        socket.write(resp("INCR",  "counter"));
        socket.write(resp("LPUSH", "mylist",   "c", "b", "a"));
        socket.write(resp("HSET",  "myhash",   "field1", "one", "field2", "two"));
        await readN(socket, 5);

        // Important: AOF uses async appendFile — wait while server1 is STILL ALIVE
        // so its I/O loop can flush the writes before the process is killed.
        await wait(400);
        socket.destroy();
        server1.kill();
        await wait(400);   // wait for server1 process to exit

        // ── Phase B: restart and verify ───────────────────────────────────────
        server2 = await startServer(PORT);
        await wait(400);
        socket = await connect(PORT);

        // String
        socket.write(resp("GET", "str_key"));
        const [strHeader] = await readN(socket, 1);
        assert(strHeader.startsWith("$"), `GET str_key returns bulk string (got ${strHeader})`);

        // INCR counter — was INCRed twice from 0 → should be "2"
        socket.write(resp("GET", "counter"));
        const [ctrHeader] = await readN(socket, 1);
        assert(ctrHeader === "$1", `counter bulk header is $1 (got ${ctrHeader})`);

        // List length
        socket.write(resp("LLEN", "mylist"));
        const [llenResp] = await readN(socket, 1);
        assert(llenResp === ":3", `LLEN mylist = 3 (got ${llenResp})`);

        // Hash field
        socket.write(resp("HGET", "myhash", "field1"));
        const [hgetHeader] = await readN(socket, 1);
        assert(hgetHeader.startsWith("$"), `HGET myhash field1 returns bulk string (got ${hgetHeader})`);

        socket.write(resp("HLEN", "myhash"));
        const [hlenResp] = await readN(socket, 1);
        assert(hlenResp === ":2", `HLEN myhash = 2 (got ${hlenResp})`);

    } catch (err) {
        fail("Fix #5 threw unexpectedly", err.message);
    } finally {
        socket?.destroy();
        server1?.kill();
        server2?.kill();
        await wait(300);
        // Cleanup
        if (fs.existsSync(AOF_FILE)) fs.unlinkSync(AOF_FILE);
        if (fs.existsSync(RDB_FILE)) fs.unlinkSync(RDB_FILE);
    }
}

// ── Fix #6: INCR / DECR ──────────────────────────────────────────────────────

async function testFix6_IncrDecr() {
    console.log("\n── Fix #6: INCR / DECR (integer counter semantics) ──");

    const PORT = 6380;
    let server, socket;

    try {
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // 1. INCR on missing key → 1
        socket.write(resp("INCR", "hits"));
        const [r1] = await readN(socket, 1);
        assert(r1 === ":1", `INCR on new key → 1 (got ${r1})`);

        // 2. INCR again → 2
        socket.write(resp("INCR", "hits"));
        const [r2] = await readN(socket, 1);
        assert(r2 === ":2", `INCR twice → 2 (got ${r2})`);

        // 3. DECR → 1
        socket.write(resp("DECR", "hits"));
        const [r3] = await readN(socket, 1);
        assert(r3 === ":1", `DECR → 1 (got ${r3})`);

        // 4. DECR below 0 is allowed (no underflow protection)
        socket.write(resp("DECR", "hits"));
        socket.write(resp("DECR", "hits"));
        const [r4, r5] = await readN(socket, 2);
        assert(r4 === ":0", `DECR → 0 (got ${r4})`);
        assert(r5 === ":-1", `DECR → -1 (got ${r5})`);

        // 5. INCR on a non-integer string → error
        socket.write(resp("SET",  "badkey", "notanumber"));
        socket.write(resp("INCR", "badkey"));
        const [, incrErr] = await readN(socket, 2);
        assert(incrErr.startsWith("-ERR"), `INCR on non-integer → -ERR (got ${incrErr})`);

        // 6. INCR on a list key → WRONGTYPE
        socket.write(resp("LPUSH", "listkey", "x"));
        socket.write(resp("INCR",  "listkey"));
        const [, typeErr] = await readN(socket, 2);
        assert(typeErr.startsWith("-WRONGTYPE"), `INCR on list key → -WRONGTYPE (got ${typeErr})`);

        // 7. INCR/DECR persist to AOF (server restart check)
        socket.write(resp("SET",  "persist_ctr", "10"));
        socket.write(resp("INCR", "persist_ctr"));
        socket.write(resp("INCR", "persist_ctr"));
        await readN(socket, 3);

        // Let async AOF writes flush while the process is still alive
        await wait(400);
        socket.destroy();
        server.kill();
        await wait(400);

        const server2 = await startServer(PORT);
        await wait(400);
        const socket2 = await connect(PORT);

        socket2.write(resp("GET", "persist_ctr"));
        const [persisted] = await readN(socket2, 1);
        assert(persisted.startsWith("$"), `persist_ctr survived restart (header: ${persisted})`);

        socket2.destroy();
        server2.kill();
        await wait(300);

    } catch (err) {
        fail("Fix #6 threw unexpectedly", err.message);
    } finally {
        socket?.destroy();
        server?.kill();
        await wait(300);
        if (fs.existsSync(AOF_FILE)) fs.unlinkSync(AOF_FILE);
        if (fs.existsSync(RDB_FILE)) fs.unlinkSync(RDB_FILE);
    }
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
    console.log("=== Phase 2 Correctness Tests ===");
    await testFix4_ActiveExpiry();
    await testFix5_AOFReplay();
    await testFix6_IncrDecr();
    console.log(`\n${"─".repeat(44)}`);
    console.log(`  ${passed} passed  |  ${failed} failed`);
    console.log("─".repeat(44));
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error("Runner crashed:", err); process.exit(1); });
