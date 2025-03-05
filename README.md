# Redis Clone

A lightweight Redis clone built using Node.js, implementing core functionalities such as GET, SET, DEL, and advanced features like Pub/Sub, persistence (AOF & RDB), and expiry management.

## Features

- **Key-Value Store**: Supports `SET`, `GET`, and `DEL` commands.
- **Data Persistence**: Implements **Append-Only File (AOF)** and **RDB Snapshots**.
- **Expiration Management**: `SET key value EX seconds` for automatic expiry.
- **Pub/Sub Messaging**: `PUBLISH` and `SUBSCRIBE` functionality.
- **In-Memory Storage**: Stores data efficiently using a simple object-based system.

## Installation

### Prerequisites

- Node.js (v18 or later recommended)

### Clone the Repository

```sh
git clone https://github.com/Abhinov007/redis_clone.git
cd redis_clone
```

### Install Dependencies

```sh
npm install
```

## Usage

### Start the Redis Clone Server

```sh
node server.js
```

The server runs on **port 6379** by default.

### Testing Commands

Use `netcat` (nc) or `telnet` to interact with the Redis server.

#### **Basic Commands**

```sh
echo -ne "PING\r\n"   # PONG
echo -ne "SET city delhi\r\n"   # +OK
echo -ne "GET city\r\n"   # +delhi
echo -ne "DEL city\r\n"  # :1
echo -ne "FLUSHALL\r\n"   # +OK
```

#### **Persistence (AOF & RDB)**

- Data is stored in `database.aof` for AOF persistence.
- RDB snapshots are saved periodically.

#### **Pub/Sub Messaging**

*Open two terminals:*

**Terminal 1 (Subscriber):**

```sh
echo -ne "SUBSCRIBE news\r\n" | nc localhost 6379
```

**Terminal 2 (Publisher):**

```sh
echo -ne "PUBLISH news 'Hello, Redis Clone!'\r\n" | nc localhost 6379
```

The subscriber terminal should receive:

```
+Message received on news: Hello, Redis Clone!
```

## Code Structure

```
my-redis-clone/
│── server.js           # TCP server
│── command.js         # Command processing
│── database.js        # In-memory key-value store
│── expiry.js          # Expiry management
│── aof.js             # AOF persistence
│── rdb.js             # RDB snapshot handling
│── pubsub.js          # Pub/Sub implementation
│── logs/              # Server logs
│── tests/             # Unit tests
│── database.aof       # AOF file (if enabled)
│── dump.rdb           # RDB snapshot (if enabled)
```

## Contributing

Feel free to fork, open issues, and submit pull requests!

## License

MIT License



