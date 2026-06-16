# Redis Clone

A Redis-compatible server built from scratch in Node.js — implementing the RESP protocol, dual-layer persistence (AOF + RDB), master/replica replication, Pub/Sub messaging, and transactions. Comes with an **interactive React sandbox** to explore commands and visualise internal storage in real time.

---

## 🟢 Live Sandbox

**[Try it → https://abhinov007.github.io/Redis_Clone/](https://abhinov007.github.io/Redis_Clone/)**

Type Redis commands and watch the internal database, expiry store, AOF log, RDB snapshot, and Pub/Sub channels update live.

---

## Features

### Core
- **RESP Protocol** — full Redis Serialization Protocol parser with incremental TCP chunk handling
- **4 data types** — Strings, Lists, Hashes, Sets
- **Key expiry** — `SET key value EX seconds`, lazy eviction on read + active probabilistic sweep every 100 ms
- **60+ commands** across all data types

### Persistence (dual-layer, same as real Redis)
- **AOF** — every write appended to `database.aof`; replayed on startup via the live command handler (no duplicate parser)
- **RDB** — debounced async JSON snapshot to `dump.rdb`; blocks only on graceful shutdown
- **Priority rule** — AOF takes precedence over RDB on startup (matches Redis behaviour, prevents double-apply of mutations)

### Transactions
- `MULTI` / `EXEC` / `DISCARD` — commands queued and executed atomically; per-command error isolation inside `EXEC`

### Pub/Sub
- `SUBSCRIBE` / `UNSUBSCRIBE` / `PUBLISH`
- Channel → subscriber socket mapping with automatic cleanup on disconnect

### Replication
- Master generates a replication ID and maintains a 1 MB circular backlog
- Full resync (RDB snapshot) and partial resync (`+CONTINUE` from backlog offset)
- Replica 6-state handshake with auto-reconnect and `REPLCONF ACK` heartbeats
- Write commands propagated to all replicas in RESP format
- Replica enforces read-only mode for client connections

### Reliability
- **Error boundary** — any unhandled exception inside a command returns `-ERR` to the client; server keeps running
- **Graceful shutdown** — `SIGINT` / `SIGTERM` flush a final synchronous RDB snapshot before exit
- **Active expiry sweep** — probabilistic Fisher-Yates sample, re-sweeps immediately when >25 % of sample expired

---

## Commands

### Strings
| Command | Example |
|---|---|
| `SET key value [EX seconds]` | `SET name Alice EX 60` |
| `GET key` | `GET name` |
| `MSET key value [key value …]` | `MSET k1 v1 k2 v2` |
| `MGET key [key …]` | `MGET k1 k2 k3` |
| `SETNX key value` | `SETNX lock 1` |
| `STRLEN key` | `STRLEN name` |
| `APPEND key value` | `APPEND log " entry"` |
| `INCR key` | `INCR hits` |
| `DECR key` | `DECR stock` |
| `INCRBY key n` | `INCRBY score 10` |
| `DECRBY key n` | `DECRBY score 5` |

### Lists
| Command | Example |
|---|---|
| `LPUSH key val [val …]` | `LPUSH queue a b c` |
| `RPUSH key val [val …]` | `RPUSH queue a b c` |
| `LPOP key` | `LPOP queue` |
| `RPOP key` | `RPOP queue` |
| `LLEN key` | `LLEN queue` |
| `LRANGE key start stop` | `LRANGE queue 0 -1` |
| `LINDEX key index` | `LINDEX queue 0` |
| `LSET key index value` | `LSET queue 0 newval` |
| `LTRIM key start stop` | `LTRIM queue 0 99` |

### Hashes
| Command | Example |
|---|---|
| `HSET key field value [field value …]` | `HSET user:1 name Bob age 30` |
| `HGET key field` | `HGET user:1 name` |
| `HDEL key field [field …]` | `HDEL user:1 age` |
| `HGETALL key` | `HGETALL user:1` |
| `HLEN key` | `HLEN user:1` |
| `HEXISTS key field` | `HEXISTS user:1 name` |

### Sets
| Command | Example |
|---|---|
| `SADD key member [member …]` | `SADD tags redis nosql` |
| `SREM key member [member …]` | `SREM tags nosql` |
| `SMEMBERS key` | `SMEMBERS tags` |
| `SCARD key` | `SCARD tags` |
| `SISMEMBER key member` | `SISMEMBER tags redis` |
| `SUNION key [key …]` | `SUNION s1 s2` |
| `SINTER key [key …]` | `SINTER s1 s2` |
| `SDIFF key [key …]` | `SDIFF s1 s2` |

### Key Management
| Command | Example |
|---|---|
| `EXISTS key [key …]` | `EXISTS name age` |
| `TYPE key` | `TYPE mylist` |
| `RENAME key newkey` | `RENAME tmp result` |
| `KEYS pattern` | `KEYS user:*` |
| `DEL key` | `DEL name` |
| `FLUSHALL` | `FLUSHALL` |

### Transactions
| Command | Description |
|---|---|
| `MULTI` | Begin transaction block |
| `EXEC` | Execute all queued commands atomically |
| `DISCARD` | Cancel the transaction |

### Pub/Sub
| Command | Example |
|---|---|
| `SUBSCRIBE channel [channel …]` | `SUBSCRIBE news alerts` |
| `UNSUBSCRIBE [channel …]` | `UNSUBSCRIBE news` |
| `PUBLISH channel message` | `PUBLISH news "Hello World"` |

### Server
| Command | Description |
|---|---|
| `PING` | Returns `PONG` |
| `END` | Close the current connection |

---

## Project Structure

```
redis_clone/
├── server.js                     # TCP server entry point
├── startup.js                    # Persistence loading + replica init
├── RESPParser.js                 # Incremental RESP protocol parser
├── client.js                     # Interactive CLI client
│
├── commands/
│   └── command.js                # All 60+ command handlers
│
├── middleware/
│   ├── transactions.js           # MULTI/EXEC/DISCARD + command queue
│   └── replication.js            # Read-only guard, REPLCONF/PSYNC routing
│
├── storage/
│   ├── database.js               # In-memory Map store (string/list/hash/set)
│   └── expiry.js                 # TTL store, lazy + active sweep eviction
│
├── persistence/
│   ├── aof.js                    # Append-Only File (dependency-injected replay)
│   └── rdb.js                    # Debounced async JSON snapshot
│
├── protocol/
│   └── resp.js                   # RESP encoding helpers
│
├── messaging/
│   └── pubsub.js                 # Pub/Sub channel → socket mapping
│
├── replication/
│   ├── master.js                 # Replication ID, backlog, propagation
│   └── replica.js                # 6-state handshake + streaming state machine
│
├── tests/
│   ├── phase1Test.js             # Stability: async RDB, error boundary, shutdown (11 tests)
│   ├── phase2Test.js             # Correctness: expiry sweep, AOF replay, INCR/DECR (14 tests)
│   ├── phase3Test.js             # Completeness: key-space, strings, lists, sets (55 tests)
│   ├── loadTest.js               # Throughput / latency benchmark with histogram
│   ├── TestParser.js             # RESP parser smoke test
│   ├── clientTest.js             # SET/GET integration test
│   └── replicationTest.js        # Replication suite (18 tests)
│
├── workflow.html                 # Interactive Mermaid architecture diagrams
│
└── sandbox/                      # React + Vite interactive browser sandbox
    ├── src/
    │   ├── engine/               # Browser simulation of server internals
    │   │   ├── database.js
    │   │   ├── expiry.js
    │   │   ├── commands.js
    │   │   ├── aof.js
    │   │   ├── rdb.js
    │   │   └── pubsub.js
    │   ├── components/
    │   │   ├── Terminal.jsx      # REPL with command history
    │   │   ├── StorageInspector.jsx  # 5-tab storage visualiser
    │   │   ├── KeyCard.jsx       # Per-key card with live TTL countdown
    │   │   └── ResponseLine.jsx  # Colour-coded RESP response renderer
    │   ├── hooks/
    │   │   └── useRedisEngine.js # Central state hook (useRef engine, useState snapshots)
    │   └── App.jsx
    ├── vite.config.js
    └── package.json
```

---

## Getting Started

### Prerequisites
- Node.js v18+

### Run the Server

```bash
node server.js
```

Server starts on **port 6379** by default.

```bash
# Custom port
node server.js --port 6380

# Start as a replica of another instance
node server.js --port 6380 --replicaof localhost 6379
```

### Connect

```bash
# Built-in CLI client
node client.js

# netcat (inline commands)
echo -e "*1\r\n\$4\r\nPING\r\n" | nc localhost 6379
```

---

## Replication Setup

**Terminal 1 — Master**
```bash
node server.js
```

**Terminal 2 — Replica**
```bash
node server.js --port 6380 --replicaof localhost 6379
```

Writes on the master propagate automatically. The replica does a full RDB sync on first connect and a partial resync on reconnect using the replication backlog.

---

## Pub/Sub Example

**Terminal 1 — Subscriber**
```bash
node client.js   # then type: SUBSCRIBE news
```

**Terminal 2 — Publisher**
```bash
node client.js   # then type: PUBLISH news "Hello World"
```

---

## Running Tests

Each suite is self-contained — it spawns its own server instance(s) on isolated ports and cleans up after itself.

```bash
# Stability (async RDB, error boundary, graceful shutdown)
node tests/phase1Test.js

# Correctness (active expiry, AOF replay across all types, INCR/DECR)
node tests/phase2Test.js

# Completeness (60+ commands: key-space, strings, lists, sets)
node tests/phase3Test.js

# Performance benchmark (throughput, p50/p95/p99 latency, histogram)
node tests/loadTest.js [clients] [requestsPerClient] [set|get|mix|pipeline]
```

Run all suites in sequence:
```bash
node tests/phase1Test.js && node tests/phase2Test.js && node tests/phase3Test.js
```

### Load test modes

| Mode | Description |
|---|---|
| `mix` (default) | Alternating SET and GET |
| `set` | SET only |
| `get` | GET only (seed with `set` first) |
| `pipeline` | 16 commands per batch |

```bash
node tests/loadTest.js 100 500 mix
```

---

## Interactive Sandbox

The `sandbox/` directory is a React + Vite app that simulates the server entirely in the browser. No server or Node.js needed.

```bash
cd sandbox
npm install
npm run dev
```

Open **http://localhost:5173** to explore:

| Tab | What it shows |
|---|---|
| **Database** | Live key cards with type badges (string / list / hash / set), flashes on write |
| **Expiry** | Live TTL countdown bars for keys with `EX` |
| **AOF Log** | Append-only log updating after every write |
| **RDB Snapshot** | Full JSON snapshot regenerated after every write |
| **Pub/Sub** | Active channels and subscriber counts |

---

## Architecture

Open `workflow.html` in a browser for interactive Mermaid diagrams covering:

- Full system overview
- Request lifecycle (GET/SET → parser → middleware → command handler → AOF/RDB → replication)
- Replication handshake and replica state machine
- Pub/Sub message flow
- Persistence write and recovery paths (AOF priority rule)
- MULTI/EXEC transaction flow
- Module dependency map

---

## License

MIT
