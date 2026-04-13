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
- **3 data types** — Strings, Lists, Hashes
- **Key expiry** — `SET key value EX seconds` with lazy expiry on access
- **PING / DEL / FLUSHALL**

### Persistence (dual-layer, same as real Redis)
- **AOF** — every write command appended to `database.aof`; replayed line-by-line on startup
- **RDB** — full JSON snapshot written to `dump.rdb` after every write; loaded first on startup

### Transactions
- `MULTI` / `EXEC` / `DISCARD` — commands queued during a MULTI block and executed atomically on EXEC

### Pub/Sub
- `SUBSCRIBE` / `UNSUBSCRIBE` / `PUBLISH`
- Channel → subscriber socket mapping with automatic cleanup on disconnect

### Replication
- Master generates a replication ID and maintains a 1 MB circular backlog
- Full resync (sends RDB snapshot) and partial resync (`+CONTINUE` from backlog offset)
- Replica 6-state handshake state machine with auto-reconnect and `REPLCONF ACK` heartbeats
- Write commands propagated to all replicas in RESP format
- Replica enforces read-only mode for client connections

---

## Commands

### Strings
| Command | Example |
|---|---|
| `SET key value [EX seconds]` | `SET name Alice EX 60` |
| `GET key` | `GET name` |

### Lists
| Command | Example |
|---|---|
| `LPUSH key val [val …]` | `LPUSH queue a b c` |
| `RPUSH key val [val …]` | `RPUSH queue a b c` |
| `LPOP key` | `LPOP queue` |
| `RPOP key` | `RPOP queue` |
| `LLEN key` | `LLEN queue` |
| `LRANGE key start stop` | `LRANGE queue 0 -1` |

### Hashes
| Command | Example |
|---|---|
| `HSET key field value [field value …]` | `HSET user:1 name Bob age 30` |
| `HGET key field` | `HGET user:1 name` |
| `HDEL key field [field …]` | `HDEL user:1 age` |
| `HGETALL key` | `HGETALL user:1` |
| `HLEN key` | `HLEN user:1` |
| `HEXISTS key field` | `HEXISTS user:1 name` |

### Key Management
| Command | Example |
|---|---|
| `DEL key` | `DEL name` |
| `FLUSHALL` | `FLUSHALL` |
| `PING [message]` | `PING` |

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

---

## Project Structure

```
redis_clone/
├── redis_clone/                      # Node.js Redis server
│   ├── server.js                     # TCP server entry point (port 6379)
│   ├── client.js                     # Interactive CLI client
│   ├── RESPParser.js                 # Incremental RESP protocol parser
│   ├── commands/
│   │   └── command.js                # All command handlers
│   ├── storage/
│   │   ├── database.js               # In-memory Map store
│   │   └── expiry.js                 # TTL / lazy expiry management
│   ├── persistence/
│   │   ├── aof.js                    # Append-Only File
│   │   └── rdb.js                    # JSON snapshot (RDB-style)
│   ├── protocol/
│   │   └── resp.js                   # RESP encoding helpers
│   ├── messaging/
│   │   └── pubsub.js                 # Pub/Sub engine
│   ├── replication/
│   │   ├── master.js                 # Master replication state machine
│   │   └── replica.js                # Replica sync + streaming state machine
│   ├── tests/
│   │   ├── TestParser.js             # RESP parser smoke test
│   │   ├── clientTest.js             # SET/GET integration test
│   │   └── replicationTest.js        # 18-test replication suite
│   ├── workflow.html                 # Interactive architecture diagrams (Mermaid)
│   ├── database.aof                  # Live AOF log
│   └── dump.rdb                      # Live RDB snapshot
│
└── sandbox/                          # React interactive sandbox
    ├── src/
    │   ├── engine/                   # Browser simulation of server internals
    │   │   ├── database.js
    │   │   ├── expiry.js
    │   │   ├── commands.js
    │   │   ├── aof.js
    │   │   ├── rdb.js
    │   │   └── pubsub.js
    │   ├── components/
    │   │   ├── Terminal.jsx          # REPL with command history
    │   │   ├── StorageInspector.jsx  # 5-tab storage visualiser
    │   │   ├── KeyCard.jsx           # Per-key card with live TTL countdown
    │   │   └── ResponseLine.jsx      # Color-coded RESP response renderer
    │   ├── hooks/
    │   │   └── useRedisEngine.js     # Central state hook
    │   └── App.jsx
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## Getting Started

### Prerequisites
- Node.js v18+

### Run the Server

```bash
cd redis_clone
npm install
node server.js
```

Server starts on **port 6379** by default.

```bash
# Custom port
node server.js --port 6380

# Start as a replica of another instance
node server.js --port 6380 --replicaof localhost 6379
```

### Connect with the CLI Client

```bash
node client.js
```

### Connect with netcat

```bash
echo -e "PING\r\n" | nc localhost 6379
echo -e "SET name Alice\r\n" | nc localhost 6379
echo -e "GET name\r\n" | nc localhost 6379
```

---

## Replication Setup

**Terminal 1 — Master (port 6379)**
```bash
node server.js
```

**Terminal 2 — Replica (port 6380)**
```bash
node server.js --port 6380 --replicaof localhost 6379
```

Writes on the master are automatically propagated to the replica. The replica performs a full RDB sync on first connect and attempts a partial resync on reconnect.

---

## Pub/Sub Example

**Terminal 1 — Subscriber**
```bash
echo -e "SUBSCRIBE news\r\n" | nc localhost 6379
```

**Terminal 2 — Publisher**
```bash
echo -e "PUBLISH news 'Hello World'\r\n" | nc localhost 6379
```

---

## Running Tests

```bash
cd redis_clone

# RESP parser smoke test
node tests/TestParser.js

# SET/GET integration test (requires server running on 6379)
node tests/clientTest.js

# Full replication suite — 18 tests (requires server running)
node tests/replicationTest.js
```

---

## Interactive Sandbox

The `sandbox/` directory is a React + Vite app that simulates the server entirely in the browser. No server needed.

```bash
cd sandbox
npm install
npm run dev
```

Open **http://localhost:5173** to explore:

| Tab | What it shows |
|---|---|
| **Database** | Live key cards with type badges (string / list / hash), flashes on write |
| **Expiry** | Live TTL countdown bars for keys set with `EX` |
| **AOF Log** | Append-only log updating after every write |
| **RDB Snapshot** | Full JSON snapshot regenerated after every write |
| **Pub/Sub** | Active channels and subscriber counts |

---

## Architecture

Open `redis_clone/workflow.html` in a browser for interactive Mermaid diagrams covering:

- Full system overview
- Request lifecycle (GET/SET flow through parser → command → DB → AOF/RDB → replication)
- Replication handshake & replica state machine
- Pub/Sub message flow
- Persistence (AOF + RDB) write and recovery paths
- MULTI/EXEC transaction flow
- Module map

---

## License

MIT
