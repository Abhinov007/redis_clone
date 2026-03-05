/**
 * Replication Test Suite
 *
 * Tests master-replica replication functionality:
 *   - Replica registration (REPLICAOF)
 *   - Full sync (FULLRESYNC + RDB snapshot)
 *   - Write command propagation (SET, DEL, HSET, LPUSH, RPUSH, INCR, DECR, FLUSHALL)
 *   - Replication loop prevention (replica writes are NOT re-propagated)
 *   - Replica disconnect cleanup
 *   - Transaction (MULTI/EXEC) replication
 *   - Multiple replicas receiving the same commands
 *
 * Prerequisites:
 *   Start the master server on port 6379:  node server.js
 *
 * Run:
 *   node tests/replicationTest.js
 */

const net = require("net");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toRESP(args) {
    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
        const str = String(arg);
        resp += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
    }
    return resp;
}

function createConnection(port = 6379) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port }, () => resolve(socket));
        socket.on("error", reject);
    });
}

/**
 * Send a command and wait for the first complete RESP response.
 * For normal commands this works fine (+OK, $N, :N, etc).
 */
function sendCommand(socket, args) {
    return new Promise((resolve) => {
        let buf = "";
        const onData = (data) => {
            buf += data.toString();
            if (buf.endsWith("\r\n")) {
                socket.removeListener("data", onData);
                resolve(buf);
            }
        };
        socket.on("data", onData);
        socket.write(toRESP(args));
    });
}

/**
 * Send REPLICAOF and collect all data for `ms` milliseconds.
 * The server sends +OK, then +FULLRESYNC ..., then $<len> + RDB data.
 * We need to wait for all parts to arrive.
 */
function sendReplicaOf(socket, ms = 800) {
    return new Promise((resolve) => {
        let buf = "";
        const onData = (data) => { buf += data.toString(); };
        socket.on("data", onData);
        socket.write(toRESP(["REPLICAOF", "localhost", "6379"]));
        setTimeout(() => {
            socket.removeListener("data", onData);
            resolve(buf);
        }, ms);
    });
}

/** Collect any data that arrives within `ms` milliseconds. */
function collectData(socket, ms = 500) {
    return new Promise((resolve) => {
        let buf = "";
        const onData = (data) => { buf += data.toString(); };
        socket.on("data", onData);
        setTimeout(() => {
            socket.removeListener("data", onData);
            resolve(buf);
        }, ms);
    });
}

/** Drain the welcome banner so it doesn't interfere with later assertions. */
async function drainWelcome(socket) {
    await collectData(socket, 300);
}

/** Small delay helper */
function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ PASS: ${label}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${label}`);
        failed++;
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testReplicaRegistration() {
    console.log("\n═══ Test 1: Replica Registration (REPLICAOF) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    // Send REPLICAOF — collect all response parts (+OK + FULLRESYNC + snapshot)
    const resp = await sendReplicaOf(replica);

    assert(resp.includes("+OK"), "REPLICAOF returns +OK");
    assert(resp.includes("FULLRESYNC"), "Replica receives FULLRESYNC header");

    master.end();
    replica.end();
}

async function testFullSyncSnapshot() {
    console.log("\n═══ Test 2: Full Sync (RDB Snapshot Transfer) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    // Set a key BEFORE the replica connects so it's part of the snapshot
    await sendCommand(master, ["SET", "sync_key", "hello"]);

    const replica = await createConnection();
    await drainWelcome(replica);

    // Register replica and capture the FULLRESYNC payload
    const syncResp = await sendReplicaOf(replica);

    assert(syncResp.includes("+FULLRESYNC"), "FULLRESYNC header received");
    assert(syncResp.includes("$"), "RDB snapshot bulk string marker ($) present");

    // Clean up
    await sendCommand(master, ["DEL", "sync_key"]);
    master.end();
    replica.end();
}

async function testWritePropagationSET() {
    console.log("\n═══ Test 3: Write Propagation — SET ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    // Start collecting data on the replica side BEFORE the master writes
    const replicaData = collectData(replica, 600);

    // Master writes
    await sendCommand(master, ["SET", "rep_key", "42"]);

    const received = await replicaData;

    assert(received.includes("SET"), "Replica received SET command");
    assert(received.includes("rep_key"), "Replica received the key name");
    assert(received.includes("42"), "Replica received the value");

    // Clean up
    await sendCommand(master, ["DEL", "rep_key"]);
    master.end();
    replica.end();
}

async function testWritePropagationDEL() {
    console.log("\n═══ Test 4: Write Propagation — DEL ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    await sendCommand(master, ["SET", "del_key", "temp"]);
    await delay(200);

    const replicaData = collectData(replica, 600);
    await sendCommand(master, ["DEL", "del_key"]);

    const received = await replicaData;

    assert(received.includes("DEL"), "Replica received DEL command");
    assert(received.includes("del_key"), "Replica received the deleted key name");

    master.end();
    replica.end();
}

async function testWritePropagationINCR() {
    console.log("\n═══ Test 5: Write Propagation — INCR / DECR ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    await sendCommand(master, ["SET", "counter", "10"]);
    await delay(200);

    const replicaData = collectData(replica, 600);
    await sendCommand(master, ["INCR", "counter"]);

    const received = await replicaData;

    assert(received.includes("INCR"), "Replica received INCR command");
    assert(received.includes("counter"), "Replica received INCR key name");

    // DECR
    const replicaData2 = collectData(replica, 600);
    await sendCommand(master, ["DECR", "counter"]);
    const received2 = await replicaData2;

    assert(received2.includes("DECR"), "Replica received DECR command");

    await sendCommand(master, ["DEL", "counter"]);
    master.end();
    replica.end();
}

async function testWritePropagationLPUSH_RPUSH() {
    console.log("\n═══ Test 6: Write Propagation — LPUSH / RPUSH ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    const replicaData = collectData(replica, 800);

    await sendCommand(master, ["LPUSH", "mylist", "a"]);
    await sendCommand(master, ["RPUSH", "mylist", "b"]);

    const received = await replicaData;

    assert(received.includes("LPUSH"), "Replica received LPUSH command");
    assert(received.includes("RPUSH"), "Replica received RPUSH command");
    assert(received.includes("mylist"), "Replica received the list key name");

    await sendCommand(master, ["DEL", "mylist"]);
    master.end();
    replica.end();
}

async function testWritePropagationHSET() {
    console.log("\n═══ Test 7: Write Propagation — HSET ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    const replicaData = collectData(replica, 600);
    await sendCommand(master, ["HSET", "myhash", "field1", "value1"]);

    const received = await replicaData;

    assert(received.includes("HSET"), "Replica received HSET command");
    assert(received.includes("myhash"), "Replica received the hash key name");
    assert(received.includes("field1"), "Replica received the hash field name");
    assert(received.includes("value1"), "Replica received the hash field value");

    await sendCommand(master, ["DEL", "myhash"]);
    master.end();
    replica.end();
}

async function testWritePropagationFLUSHALL() {
    console.log("\n═══ Test 8: Write Propagation — FLUSHALL ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    const replicaData = collectData(replica, 600);
    await sendCommand(master, ["FLUSHALL"]);

    const received = await replicaData;

    assert(received.includes("FLUSHALL"), "Replica received FLUSHALL command");

    master.end();
    replica.end();
}

async function testMultipleReplicas() {
    console.log("\n═══ Test 9: Multiple Replicas ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica1 = await createConnection();
    await drainWelcome(replica1);

    const replica2 = await createConnection();
    await drainWelcome(replica2);

    await sendReplicaOf(replica1);
    await sendReplicaOf(replica2);

    const data1 = collectData(replica1, 600);
    const data2 = collectData(replica2, 600);

    await sendCommand(master, ["SET", "multi_rep", "hello"]);

    const received1 = await data1;
    const received2 = await data2;

    assert(received1.includes("SET") && received1.includes("multi_rep"),
        "Replica 1 received the SET command");
    assert(received2.includes("SET") && received2.includes("multi_rep"),
        "Replica 2 received the SET command");

    await sendCommand(master, ["DEL", "multi_rep"]);
    master.end();
    replica1.end();
    replica2.end();
}

async function testReplicaDisconnectCleanup() {
    console.log("\n═══ Test 10: Replica Disconnect Cleanup ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    // Disconnect replica
    replica.end();
    await delay(300);

    // Master should not crash when propagating after replica disconnect
    const resp = await sendCommand(master, ["SET", "after_disconnect", "ok"]);
    assert(resp.includes("+OK"), "Master handles writes after replica disconnect without crashing");

    await sendCommand(master, ["DEL", "after_disconnect"]);
    master.end();
}

async function testNoReplicationLoopFromReplica() {
    console.log("\n═══ Test 11: No Replication Loop (replica writes not re-propagated) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica1 = await createConnection();
    await drainWelcome(replica1);

    const replica2 = await createConnection();
    await drainWelcome(replica2);

    await sendReplicaOf(replica1);
    await sendReplicaOf(replica2);

    // Start collecting data on replica2 BEFORE replica1 sends its write
    const data2 = collectData(replica2, 800);

    // replica1 sends a SET — because it's marked as isReplica, the server
    // should execute it but NOT propagate to replica2
    replica1.write(toRESP(["SET", "loop_test", "val"]));
    await delay(500);

    const received2 = await data2;

    assert(!received2.includes("loop_test"),
        "Replica 2 did NOT receive re-propagated command from Replica 1 (no replication loop)");

    await sendCommand(master, ["DEL", "loop_test"]);
    master.end();
    replica1.end();
    replica2.end();
}

async function testTransactionReplication() {
    console.log("\n═══ Test 12: Transaction (MULTI/EXEC) Replication ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    const replicaData = collectData(replica, 1200);

    // Execute a transaction on master
    await sendCommand(master, ["MULTI"]);
    await sendCommand(master, ["SET", "tx_key1", "a"]);
    await sendCommand(master, ["SET", "tx_key2", "b"]);
    await sendCommand(master, ["EXEC"]);

    const received = await replicaData;

    assert(received.includes("tx_key1"), "Replica received tx_key1 from EXEC replication");
    assert(received.includes("tx_key2"), "Replica received tx_key2 from EXEC replication");

    await sendCommand(master, ["DEL", "tx_key1"]);
    await sendCommand(master, ["DEL", "tx_key2"]);
    master.end();
    replica.end();
}

async function testReadCommandsNotPropagated() {
    console.log("\n═══ Test 13: Read Commands NOT Propagated ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    await sendCommand(master, ["SET", "read_test", "123"]);
    await delay(300);

    // Drain any SET propagation that already arrived on the replica
    await collectData(replica, 300);

    // Now issue read commands and verify they are NOT propagated
    const replicaData = collectData(replica, 600);

    await sendCommand(master, ["GET", "read_test"]);

    const received = await replicaData;

    assert(!received.includes("GET"), "GET was NOT propagated to replica");

    await sendCommand(master, ["DEL", "read_test"]);
    master.end();
    replica.end();
}

async function testRapidFirePropagation() {
    console.log("\n═══ Test 14: Rapid-Fire Propagation (Burst Writes) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const replica = await createConnection();
    await drainWelcome(replica);

    await sendReplicaOf(replica);

    const replicaData = collectData(replica, 2000);

    // Fire multiple writes quickly
    for (let i = 0; i < 5; i++) {
        await sendCommand(master, ["SET", `burst_${i}`, `v${i}`]);
    }

    const received = await replicaData;

    let allReceived = true;
    for (let i = 0; i < 5; i++) {
        if (!received.includes(`burst_${i}`)) {
            allReceived = false;
            console.log(`    ⚠  Missing: burst_${i}`);
        }
    }

    assert(allReceived, "All 5 rapid-fire SET commands replicated to replica");

    // Clean up
    for (let i = 0; i < 5; i++) {
        await sendCommand(master, ["DEL", `burst_${i}`]);
    }
    master.end();
    replica.end();
}

async function testReplconfHandshake() {
    console.log("\n═══ Test 15: REPLCONF Handshake ═══");

    const master = await createConnection();
    await drainWelcome(master);

    const dataPort = await sendCommand(master, ["REPLCONF", "listening-port", "6380"]);
    assert(dataPort.includes("+OK"), "REPLCONF listening-port returns +OK");

    const dataCapa = await sendCommand(master, ["REPLCONF", "capa", "psync2"]);
    assert(dataCapa.includes("+OK"), "REPLCONF capa returns +OK");

    master.end();
}

async function testPsyncFullResync() {
    console.log("\n═══ Test 16: PSYNC ? -1 (Initial Full Resync) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    // PSYNC with unknown ID should trigger FULLRESYNC
    const data = await sendCommand(master, ["PSYNC", "?", "-1"]);
    
    assert(data.includes("+FULLRESYNC"), "PSYNC ? -1 returns +FULLRESYNC");
    assert(data.split(" ").length === 3, "FULLRESYNC response includes replId and offset");

    master.end();
}

async function testPartialResync() {
    console.log("\n═══ Test 17: Partial Resync (PSYNC +CONTINUE) ═══");

    const master = await createConnection();
    await drainWelcome(master);

    // 1. Get a valid replId and offset via an initial PSYNC
    const initData = await sendCommand(master, ["PSYNC", "?", "-1"]);
    assert(initData.includes("+FULLRESYNC"), "Got initial FULLRESYNC");

    const parts = initData.split("\r\n")[0].split(" "); // e.g. "+FULLRESYNC <id> <offset>"
    const replId = parts[1];
    const offset = parseInt(parts[2], 10);

    // Drain the RDB snapshot that follows
    await collectData(master, 200);

    // 2. Disconnect the replica
    master.end();

    // 3. Reconnect and send PSYNC with the saved replId and offset
    const replica2 = await createConnection();
    await drainWelcome(replica2);

    const contData = await sendCommand(replica2, ["PSYNC", replId, String(offset)]);
    
    assert(contData.includes("+CONTINUE"), "PSYNC with valid ID and offset returns +CONTINUE");
    
    replica2.end();
}

async function testAckHeartbeat() {
    console.log("\n═══ Test 18: REPLCONF ACK Heartbeat ═══");

    const master = await createConnection();
    await drainWelcome(master);

    // Register as replica
    await sendCommand(master, ["REPLCONF", "listening-port", "6380"]);
    await sendCommand(master, ["REPLCONF", "capa", "psync2"]);
    await sendCommand(master, ["PSYNC", "?", "-1"]);
    await collectData(master, 200); // drain FULLRESYNC + RDB

    // ACKs send no response back in Redis, so we just verify it doesn't error/disconnect
    master.write(toRESP(["REPLCONF", "ACK", "42"]));
    
    // Send a PING to ensure connection is still alive and parsing works
    const pingResp = await sendCommand(master, ["PING"]);
    
    assert(pingResp.includes("PONG"), "Connection alive after REPLCONF ACK");

    master.end();
}

// ─── Run all tests ────────────────────────────────────────────────────────────

async function runAll() {
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║       REPLICATION TEST SUITE — Redis Clone      ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("  Connecting to master at localhost:6379 ...\n");

    try {
        await testReplicaRegistration();
        await testFullSyncSnapshot();
        await testWritePropagationSET();
        await testWritePropagationDEL();
        await testWritePropagationINCR();
        await testWritePropagationLPUSH_RPUSH();
        await testWritePropagationHSET();
        await testWritePropagationFLUSHALL();
        await testMultipleReplicas();
        await testReplicaDisconnectCleanup();
        await testNoReplicationLoopFromReplica();
        await testTransactionReplication();
        await testReadCommandsNotPropagated();
        await testRapidFirePropagation();
        await testReplconfHandshake();
        await testPsyncFullResync();
        await testPartialResync();
        await testAckHeartbeat();
    } catch (err) {
        console.error("\n💥 Unexpected error:", err);
    }

    console.log("\n══════════════════════════════════════════════════");
    console.log(`  Results:  ${passed} passed  /  ${failed} failed  /  ${passed + failed} total`);
    console.log("══════════════════════════════════════════════════\n");

    process.exit(failed > 0 ? 1 : 0);
}

runAll();
