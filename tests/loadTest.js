/**
 * Load Test — Redis Clone
 *
 * Measures:
 *   - Throughput  : total commands per second
 *   - Latency     : avg / p50 / p95 / p99 / max  (per command)
 *   - Concurrency : behaviour under N simultaneous clients
 *   - Error rate  : % of commands that got an unexpected response
 *
 * Usage:
 *   node tests/loadTest.js [clients] [requestsPerClient] [command]
 *
 * Examples:
 *   node tests/loadTest.js                     # defaults: 50 clients, 200 req each, SET+GET mix
 *   node tests/loadTest.js 100 500             # 100 clients x 500 requests
 *   node tests/loadTest.js 200 1000 set        # only SET
 *   node tests/loadTest.js 50  200  get        # only GET (run SET first to seed data)
 *   node tests/loadTest.js 50  200  pipeline   # pipelined SET (16 at a time)
 */

"use strict";

const net  = require("net");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT               = parseInt(process.env.PORT || "6379", 10);
const NUM_CLIENTS        = parseInt(process.argv[2] || "50",  10);
const REQUESTS_PER_CLIENT = parseInt(process.argv[3] || "200", 10);
const COMMAND_MODE       = (process.argv[4] || "mix").toLowerCase();
const PIPELINE_SIZE      = 16;   // commands per batch in pipeline mode
const TOTAL_REQUESTS     = NUM_CLIENTS * REQUESTS_PER_CLIENT;

// ─── RESP helpers ─────────────────────────────────────────────────────────────

function resp(...args) {
    let s = `*${args.length}\r\n`;
    for (const a of args) s += `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`;
    return s;
}

// ─── Single-client runner ─────────────────────────────────────────────────────

/**
 * Opens a connection, sends `requests` commands one at a time (or in batches
 * for pipeline mode), records per-command latencies, then closes.
 * Returns { latencies: number[], errors: number }
 */
function runClient(clientId, requests, mode) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: PORT }, () => {});
        const latencies = [];
        let errors = 0;
        let buf = "";
        let pending = [];            // [ { sentAt, resolve } ]
        let sent = 0, received = 0;

        socket.once("error", reject);

        // Drain the welcome banner before starting
        socket.once("data", () => startSending());

        socket.on("data", (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf("\r\n")) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);

                // Skip bulk-string data lines
                if (line[0] === "$" && line !== "$-1") {
                    const dataLen = parseInt(line.slice(1), 10);
                    if (dataLen >= 0) {
                        // The next \r\n segment is the data — consume it
                        const dataEnd = buf.indexOf("\r\n");
                        if (dataEnd !== -1) buf = buf.slice(dataEnd + 2);
                        // else: partial — will be handled on next chunk
                    }
                }

                // Count any top-level response line
                if (line[0] === "+" || line[0] === "-" || line[0] === ":" || line[0] === "$") {
                    if (pending.length > 0) {
                        const { sentAt, resolve: res } = pending.shift();
                        const rtt = performance.now() - sentAt;
                        latencies.push(rtt);
                        if (line.startsWith("-")) errors++;
                        received++;
                        res();
                    }
                }

                if (received >= requests) {
                    socket.destroy();
                    resolve({ latencies, errors });
                }
            }
        });

        function sendOne(i) {
            const key   = `loadtest:${clientId}:${i}`;
            const value = `val${i}`;

            let cmd;
            if (mode === "set") {
                cmd = resp("SET", key, value);
            } else if (mode === "get") {
                cmd = resp("GET", key);
            } else {
                // mix: alternate SET and GET
                cmd = i % 2 === 0 ? resp("SET", key, value) : resp("GET", key);
            }

            return new Promise((res) => {
                pending.push({ sentAt: performance.now(), resolve: res });
                socket.write(cmd);
            });
        }

        async function startSending() {
            if (mode === "pipeline") {
                // Pipeline mode: send PIPELINE_SIZE commands without waiting,
                // then wait for all responses before sending the next batch
                for (let i = 0; i < requests; i += PIPELINE_SIZE) {
                    const batch = [];
                    const batchSize = Math.min(PIPELINE_SIZE, requests - i);
                    for (let j = 0; j < batchSize; j++) {
                        batch.push(sendOne(i + j));
                    }
                    await Promise.all(batch);
                }
            } else {
                // Sequential: send next command only after receiving previous response
                for (let i = 0; i < requests; i++) {
                    await sendOne(i);
                }
            }
            sent = requests;
        }
    });
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function stats(latencies) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const sum    = sorted.reduce((a, b) => a + b, 0);
    return {
        count : sorted.length,
        avg   : sum / sorted.length,
        p50   : percentile(sorted, 50),
        p95   : percentile(sorted, 95),
        p99   : percentile(sorted, 99),
        max   : sorted[sorted.length - 1] || 0,
        min   : sorted[0] || 0,
    };
}

function fmt(ms) { return `${ms.toFixed(2)} ms`; }
function bar(value, max, width = 30) {
    const filled = Math.round((value / max) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Progress indicator ───────────────────────────────────────────────────────

function startProgressBar(total) {
    let done = 0;
    const interval = setInterval(() => {
        const pct  = Math.floor((done / total) * 100);
        const fill = Math.round((done / total) * 30);
        process.stdout.write(`\r  Progress: [${"█".repeat(fill)}${"░".repeat(30 - fill)}] ${pct}% (${done}/${total})`);
    }, 250);
    return {
        increment(n = 1) { done += n; },
        stop()           { clearInterval(interval); process.stdout.write("\r" + " ".repeat(60) + "\r"); }
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║           Redis Clone — Load Test                ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log(`
  Target    : localhost:${PORT}
  Clients   : ${NUM_CLIENTS}
  Req/client: ${REQUESTS_PER_CLIENT}
  Total reqs: ${TOTAL_REQUESTS}
  Mode      : ${COMMAND_MODE}
  `);

    // ── Verify server is reachable ─────────────────────────────────────────
    await new Promise((resolve, reject) => {
        const probe = net.createConnection({ port: PORT }, () => {
            probe.once("data", () => { probe.destroy(); resolve(); });
        });
        probe.once("error", () =>
            reject(new Error(`Cannot connect to server on port ${PORT}. Is it running?\n  Run: node server.js`))
        );
    });

    console.log("  Server reachable ✓  starting test...\n");

    const progress = startProgressBar(TOTAL_REQUESTS);

    // ── Launch all clients in parallel ────────────────────────────────────
    const wallStart = performance.now();
    const clientPromises = [];

    for (let i = 0; i < NUM_CLIENTS; i++) {
        const p = runClient(i, REQUESTS_PER_CLIENT, COMMAND_MODE).then(result => {
            progress.increment(REQUESTS_PER_CLIENT);
            return result;
        });
        clientPromises.push(p);
    }

    let results;
    try {
        results = await Promise.all(clientPromises);
    } catch (err) {
        progress.stop();
        console.error("Load test failed:", err.message);
        process.exit(1);
    }

    const wallMs = performance.now() - wallStart;
    progress.stop();

    // ── Aggregate ─────────────────────────────────────────────────────────
    const allLatencies = results.flatMap(r => r.latencies);
    const totalErrors  = results.reduce((sum, r) => sum + r.errors, 0);
    const s            = stats(allLatencies);
    const opsPerSec    = (TOTAL_REQUESTS / wallMs) * 1000;
    const errorRate    = ((totalErrors / TOTAL_REQUESTS) * 100).toFixed(2);

    // ── Report ────────────────────────────────────────────────────────────
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│  Throughput                                     │");
    console.log("├─────────────────────────────────────────────────┤");
    console.log(`│  Total time   : ${fmt(wallMs).padEnd(32)}│`);
    console.log(`│  Ops/second   : ${Math.round(opsPerSec).toLocaleString().padEnd(32)}│`);
    console.log(`│  Errors       : ${totalErrors} (${errorRate}%)`.padEnd(50) + "│");
    console.log("├─────────────────────────────────────────────────┤");
    console.log("│  Latency (per command, ms)                      │");
    console.log("├─────────────────────────────────────────────────┤");
    console.log(`│  Min          : ${fmt(s.min).padEnd(32)}│`);
    console.log(`│  Avg          : ${fmt(s.avg).padEnd(32)}│`);
    console.log(`│  p50 (median) : ${fmt(s.p50).padEnd(32)}│`);
    console.log(`│  p95          : ${fmt(s.p95).padEnd(32)}│`);
    console.log(`│  p99          : ${fmt(s.p99).padEnd(32)}│`);
    console.log(`│  Max          : ${fmt(s.max).padEnd(32)}│`);
    console.log("├─────────────────────────────────────────────────┤");
    console.log("│  Latency distribution                           │");
    console.log("├─────────────────────────────────────────────────┤");

    // Histogram — bucket latencies into bands
    const bands = [
        { label: "< 1ms  ", max: 1 },
        { label: "1-5ms  ", max: 5 },
        { label: "5-10ms ", max: 10 },
        { label: "10-50ms", max: 50 },
        { label: "> 50ms ", max: Infinity },
    ];
    const buckets = bands.map(b => ({ label: b.label, count: 0 }));
    for (const lat of allLatencies) {
        for (let i = 0; i < bands.length; i++) {
            if (lat < bands[i].max) { buckets[i].count++; break; }
        }
    }
    const maxBucket = Math.max(...buckets.map(b => b.count));
    for (const b of buckets) {
        const pct = ((b.count / TOTAL_REQUESTS) * 100).toFixed(1).padStart(5);
        const b30 = bar(b.count, maxBucket);
        console.log(`│  ${b.label}  ${b30}  ${pct}%  │`);
    }

    console.log("└─────────────────────────────────────────────────┘");

    // ── Verdict ───────────────────────────────────────────────────────────
    console.log("\n  Verdict:");
    if (opsPerSec > 20000)      console.log("  🟢 Excellent  — > 20k ops/sec");
    else if (opsPerSec > 10000) console.log("  🟡 Good       — > 10k ops/sec");
    else if (opsPerSec > 3000)  console.log("  🟠 Moderate   — > 3k ops/sec");
    else                         console.log("  🔴 Low        — < 3k ops/sec (check bottlenecks)");

    if (s.p99 < 5)      console.log("  🟢 p99 latency excellent (< 5ms)");
    else if (s.p99 < 20) console.log("  🟡 p99 latency acceptable (< 20ms)");
    else                  console.log("  🔴 p99 latency high (> 20ms) — check event-loop blocking");

    if (totalErrors === 0) console.log("  🟢 Zero errors");
    else                   console.log(`  🔴 ${totalErrors} errors — investigate`);

    console.log();
}

main().catch(err => { console.error(err.message); process.exit(1); });
