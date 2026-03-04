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
echo -ne "GET city\r\n"   # $5<CRLF>delhi<CRLF>
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
*3
$7
message
$4
news
$18
Hello, Redis Clone!
```

#### **Lists**

```sh
echo -ne "LPUSH mylist a b\r\n"     # :2
echo -ne "RPUSH mylist c\r\n"       # :3
echo -ne "LRANGE mylist 0 -1\r\n"   # *3 bulk strings
echo -ne "LPOP mylist\r\n"          # bulk string
echo -ne "LLEN mylist\r\n"          # integer
```

#### **Hashes**

```sh
echo -ne "HSET myhash f1 v1 f2 v2\r\n"  # :2
echo -ne "HGET myhash f1\r\n"           # bulk string
echo -ne "HEXISTS myhash f3\r\n"        # :0 or :1
echo -ne "HGETALL myhash\r\n"           # array [field, value, ...]
echo -ne "HLEN myhash\r\n"              # integer
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



