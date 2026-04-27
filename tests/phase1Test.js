/**
 * Phase 1 Stability Tests
 *
 * Fix #1 — Async RDB  : burst writes must not block; dump.rdb must be correct after
 * Fix #2 — Error Boundary: server must survive a bad command and keep serving
 * Fix #3 — Graceful Shutdown: SIGINT/SIGTERM must save RDB and exit cleanly
 */

"use strict";

const net    = require("net");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const RDB_PATH = path.join(__dirname, "../dump.rdb");
const SERVER   = path.join(__dirname, "../server.js");
const IS_WIN   = process.platform === "win32";

// ─── Assertion helpers ────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function pass(label)               { console.log(`  ✅  ${label}`); passed++; }
function fail(label, detail = "")  { console.error(`  ❌  ${label}`); if (detail) console.error(`       ${detail}`); failed++; }
function assert(ok, label, detail) { ok ? pass(label) : fail(label, detail); }

// ─── RESP helpers ─────────────────────────────────────────────────────────────

/** Encode a command as a RESP array */
function resp(...args) {
    let s = `*${args.length}\r\n`;
    for (const a of args) s += `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`;
    return s;
}

/**
 * Connect to server and return the socket.
 * Waits until the welcome banner has been fully drained so subsequent
 * readN() calls only see real command responses.
 */
function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port }, () => {});
        socket.once("error", reject);
        // The server sends exactly one line on connect: +Welcome…\r\n
        // We drain it here so it never reaches readN().
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

/**
 * Collect exactly `count` top-level RESP responses from the socket.
 * Correctly handles:
 *   - multiple responses arriving in a single TCP chunk
 *   - a single response split across multiple chunks
 *   - bulk strings ($N\r\ndata\r\n) — skips the data line
 * Resolves with an array of the first-line of each response (e.g. "+OK", ":3", "-ERR …").
 */
function readN(socket, count) {
    return new Promise((resolve, reject) => {
        const results = [];
        let buf = "";
        let skipNextLine = false;   // true while consuming the data line of a bulk string

        const timer = setTimeout(() => {
            socket.removeListener("data", handler);
            reject(new Error(`Timeout: got ${results.length}/${count} responses`));
        }, 6000);

        function handler(chunk) {
            buf += chunk.toString();
            // Process as many complete \r\n-terminated lines as possible
            let idx;
            while ((idx = buf.indexOf("\r\n")) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                if (skipNextLine) {
                    // This is the bulk-string data line — discard it
                    skipNextLine = false;
                    continue;
                }

                const type = line[0];
                if (type === "+" || type === "-" || type === ":") {
                    results.push(line);
                } else if (type === "$") {
                    const len = parseInt(line.slice(1), 10);
                    if (len === -1) {
                        // Null bulk string counts as one response
                        results.push("$-1");
                    } else {
                        // The next \r\n-terminated line is the data — skip it
                        results.push(line);   // record the $N header
                        skipNextLine = true;
                    }
                } else if (type === "*") {
                    // Array header — not counted as a response itself
                }

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

/** Start a server on `port`, resolve with the child process once it is ready */
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
        setTimeout(() => reject(new Error("Server did not start")), 5000);
    });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fix #1: Async RDB ────────────────────────────────────────────────────────

async function testFix1_AsyncRDB() {
    console.log("\n── Fix #1: Async RDB (burst writes, event-loop must stay free) ──");

    const PORT  = 6393;
    const BURST = 50;
    let server, socket;

    try {
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        const t0 = Date.now();

        // Fire all BURST SET commands without waiting for responses
        for (let i = 0; i < BURST; i++) {
            socket.write(resp("SET", `burst_key_${i}`, `value_${i}`));
        }

        // Now collect exactly BURST responses
        const responses = await readN(socket, BURST);
        const elapsed   = Date.now() - t0;

        assert(
            responses.length === BURST,
            `Received all ${BURST} +OK responses (got ${responses.length})`
        );
        assert(
            responses.every(r => r === "+OK"),
            "Every response is +OK",
            `Non-OK: ${responses.filter(r => r !== "+OK")}`
        );
        // A sync writeFileSync on every command would take several seconds.
        // 5 s is a very generous ceiling even on slow disks.
        assert(
            elapsed < 5000,
            `All ${BURST} responses arrived in < 5 s  (actual: ${elapsed} ms)`
        );

        // Give the debounced async save time to flush to disk
        await wait(600);

        assert(fs.existsSync(RDB_PATH), "dump.rdb exists after burst");

        let rdbValid = false;
        try {
            const parsed = JSON.parse(fs.readFileSync(RDB_PATH, "utf-8"));
            // At least some of the burst keys must be present
            rdbValid = Object.keys(parsed).some(k => k.startsWith("burst_key_"));
        } catch (_) {}
        assert(rdbValid, "dump.rdb is valid JSON and contains burst keys");

    } catch (err) {
        fail("Fix #1 threw unexpectedly", err.message);
    } finally {
        socket?.destroy();
        server?.kill();
        await wait(300);
    }
}

// ─── Fix #2: Error Boundary ───────────────────────────────────────────────────

async function testFix2_ErrorBoundary() {
    console.log("\n── Fix #2: Error Boundary (server survives malformed commands) ──");

    const PORT = 6392;
    let server, socket;

    try {
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // 1. Send an unknown command — should return -ERR, not crash the server.
        //    (*0\r\n is silently ignored by design; a named unknown command
        //     always generates a response which exercises the error path.)
        socket.write(resp("NOTACOMMAND", "arg1"));
        const [errResp] = await readN(socket, 1);
        assert(
            errResp.startsWith("-ERR"),
            "Unknown command returns -ERR (not a crash)",
            `Got: ${errResp}`
        );

        // 2. Server must still be alive — send a normal SET
        socket.write(resp("SET", "health", "ok"));
        const [setResp] = await readN(socket, 1);
        assert(setResp === "+OK", "Server responds +OK to SET after the bad command");

        // 3. EXEC without MULTI → -ERR
        socket.write(resp("EXEC"));
        const [execResp] = await readN(socket, 1);
        assert(
            execResp.startsWith("-ERR"),
            "EXEC without MULTI returns -ERR"
        );

        // 4. Server still healthy after all the above
        socket.write(resp("GET", "health"));
        const [getHeader] = await readN(socket, 1);
        assert(
            getHeader.startsWith("$"),
            "GET returns bulk-string header (server still healthy)"
        );

    } catch (err) {
        fail("Fix #2 threw unexpectedly", err.message);
    } finally {
        socket?.destroy();
        server?.kill();
        await wait(300);
    }
}

// ─── Fix #3: Graceful Shutdown ────────────────────────────────────────────────

async function testFix3_GracefulShutdown() {
    console.log("\n── Fix #3: Graceful Shutdown (SIGTERM → save RDB → clean exit) ──");

    // Windows note: child.kill('SIGINT') bypasses Node.js signal handlers on
    // Windows and terminates the process immediately (exit code null, signal
    // 'SIGINT'). We test SIGTERM which has the same handler and behaves the
    // same way cross-platform for our purposes.
    if (IS_WIN) {
        console.log("  ⚠️  Windows detected — signal-handler test uses SIGTERM.");
    }

    const PORT   = 6391;
    const SIGNAL = IS_WIN ? "SIGTERM" : "SIGINT";
    let server, socket;

    try {
        server = await startServer(PORT);
        await wait(300);
        socket = await connect(PORT);

        // Write data that must be present in dump.rdb after shutdown
        socket.write(resp("SET", "shutdown_key", "persisted_value"));
        await readN(socket, 1);

        // Give the async scheduleSave time to complete at least once
        await wait(600);

        socket.destroy();

        // Capture stdout lines for the shutdown banner check
        let shutdownLog = "";
        server.stdout.on("data", d => { shutdownLog += d.toString(); });

        // Trigger graceful shutdown
        const exitResult = await new Promise((resolve) => {
            server.on("exit", (code, signal) => resolve({ code, signal }));
            server.kill(SIGNAL);
        });

        // On Unix: our handler calls process.exit(0) → code=0, signal=null
        // On Windows: process is killed immediately  → code=null, signal=SIGNAL
        // Either way the process must terminate
        assert(
            exitResult.code === 0 || exitResult.signal === SIGNAL,
            `Server terminated after ${SIGNAL}  (code=${exitResult.code}, signal=${exitResult.signal})`
        );

        if (!IS_WIN) {
            // Signal handlers run on Unix — verify the log output
            assert(
                shutdownLog.includes(SIGNAL),
                "Shutdown log mentions the signal name"
            );
            assert(
                shutdownLog.includes("Final snapshot saved"),
                "Shutdown log confirms RDB was written"
            );
        }

        // dump.rdb must contain the key we wrote (saved either by scheduleSave
        // during the 600 ms wait, or by forceSave during shutdown on Unix)
        let persisted = false;
        try {
            const parsed = JSON.parse(fs.readFileSync(RDB_PATH, "utf-8"));
            persisted = parsed["shutdown_key"]?.value === "persisted_value";
        } catch (_) {}
        assert(persisted, "dump.rdb contains data written before shutdown");

    } catch (err) {
        fail("Fix #3 threw unexpectedly", err.message);
    } finally {
        server?.kill();
        await wait(300);
    }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
    console.log("=== Phase 1 Stability Tests ===");
    await testFix1_AsyncRDB();
    await testFix2_ErrorBoundary();
    await testFix3_GracefulShutdown();
    console.log(`\n${"─".repeat(44)}`);
    console.log(`  ${passed} passed  |  ${failed} failed`);
    console.log("─".repeat(44));
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error("Runner crashed:", err); process.exit(1); });
