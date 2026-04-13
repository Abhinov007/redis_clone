// Mirrors commands/command.js
// Every exported function returns: { response, isWrite, affectedKey? }
// `response` uses a "type:value" string format consumed by <ResponseLine> for color coding:
//   ok:OK  |  error:ERR …  |  bulk:<value>  |  int:<n>  |  null:nil  |  array:[…]
//   simple:<msg>  |  queued:QUEUED  |  subscribe:[…]  |  unsubscribe:[…]

import {
  setString, getString, getOrCreateList, getList,
  getOrCreateHash, getHash, deleteKey, clearDatabase
} from './database.js'
import { setExpiry, isExpired, clearExpiry } from './expiry.js'
import { appendAOF, clearAOF } from './aof.js'
import { publish, subscribe, unsubscribe } from './pubsub.js'

/**
 * Returns a standard WRONGTYPE error result.
 * Triggered whenever a command is used against a key that holds the wrong data type
 * (e.g. calling LPUSH on a key that already holds a string).
 * @example
 * // db has: SET name Alice
 * // Then:   LPUSH name x  → wrongType() fires
 * // response: 'error:WRONGTYPE Operation against a key holding the wrong kind of value'
 */
function wrongType() {
  return { response: 'error:WRONGTYPE Operation against a key holding the wrong kind of value', isWrite: false }
}

/**
 * Central command dispatcher. Parses the args array, routes to the correct handler,
 * and returns a result object. Also manages MULTI/EXEC transaction queuing.
 *
 * @param {string[]} args            - Tokenised command, e.g. ['SET', 'name', 'Alice']
 * @param {Map}      db              - The in-memory database (from createDatabase)
 * @param {Map}      expiryStore     - The TTL store (from createExpiryStore)
 * @param {Array}    aof             - The AOF log array (from createAOF)
 * @param {Map}      pubsub          - The pub/sub registry (from createPubSub)
 * @param {Object}   transactionState - { active: bool, queue: string[][] }
 * @param {Object}   pubsubState      - { subscriptions: Set, inbox: Array }
 *
 * @example
 * processCommand(['PING'], db, exp, aof, ps, tx, pss)
 * // → { response: 'simple:PONG', isWrite: false }
 *
 * processCommand(['SET', 'color', 'red'], db, exp, aof, ps, tx, pss)
 * // → { response: 'ok:OK', isWrite: true, affectedKey: 'color' }
 *
 * processCommand(['GET', 'color'], db, exp, aof, ps, tx, pss)
 * // → { response: 'bulk:red', isWrite: false, affectedKey: 'color' }
 *
 * processCommand(['GET', 'ghost'], db, exp, aof, ps, tx, pss)
 * // → { response: 'null:nil', isWrite: false }
 *
 * // Inside a MULTI block, all commands are queued:
 * processCommand(['MULTI'], ...)  // → { response: 'ok:OK' }
 * processCommand(['SET', 'x', '1'], ...)  // → { response: 'queued:QUEUED' }
 * processCommand(['EXEC'], ...)   // → { response: 'array:["ok:OK"]', isWrite: true }
 */
export function processCommand(args, db, expiryStore, aof, pubsub, transactionState, pubsubState) {
  if (!args || args.length === 0) return { response: 'error:ERR empty command', isWrite: false }

  const cmd = args[0].toUpperCase()

  // Lazily check expiry on every key access — mirrors Redis's passive expiry strategy
  const checkKey = (key) => isExpired(expiryStore, db, key)

  // ─── TRANSACTION HANDLING ───────────────────────────────────────────────
  // While a MULTI block is active, commands are queued rather than executed.
  // EXEC flushes the queue atomically; DISCARD discards it.
  if (transactionState.active) {
    if (cmd === 'EXEC') {
      transactionState.active = false
      const queue = transactionState.queue.slice()
      transactionState.queue = []
      const results = queue.map(qArgs => {
        const r = processCommand(qArgs, db, expiryStore, aof, pubsub, { active: false, queue: [] }, pubsubState)
        return r.response
      })
      return { response: `array:${JSON.stringify(results)}`, isWrite: true }
    }
    if (cmd === 'DISCARD') {
      transactionState.active = false
      transactionState.queue = []
      return { response: 'ok:OK', isWrite: false }
    }
    if (cmd === 'MULTI') {
      return { response: 'error:ERR MULTI calls can not be nested', isWrite: false }
    }
    // Any other command is queued during an active MULTI
    transactionState.queue.push(args)
    return { response: 'queued:QUEUED', isWrite: false }
  }

  // ─── COMMANDS ────────────────────────────────────────────────────────────
  switch (cmd) {

    // PING [message]
    // Returns PONG (or the optional message). Useful for health checks.
    // @example  PING         → +PONG
    // @example  PING hello   → +hello
    case 'PING': {
      const msg = args[1] ?? 'PONG'
      return { response: `simple:${msg}`, isWrite: false }
    }

    // SET key value [EX seconds]
    // Stores a string. Optionally sets a TTL with EX.
    // @example  SET name Alice         → +OK
    // @example  SET token abc EX 60    → +OK  (expires in 60s)
    case 'SET': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for SET', isWrite: false }
      const key = args[1], value = args[2]
      setString(db, key, value)
      if (args[3]?.toUpperCase() === 'EX' && args[4]) {
        const ttl = parseInt(args[4])
        if (isNaN(ttl) || ttl <= 0) return { response: 'error:ERR invalid expire time', isWrite: false }
        setExpiry(expiryStore, key, ttl)
      }
      appendAOF(aof, `SET ${key} ${value}${args[3]?.toUpperCase() === 'EX' ? ' EX ' + args[4] : ''}`)
      return { response: 'ok:OK', isWrite: true, affectedKey: key }
    }

    // GET key
    // Returns the string value, nil if the key doesn't exist, or WRONGTYPE if not a string.
    // Also performs lazy expiry: if the key is past its TTL it is deleted and nil is returned.
    // @example  GET name    → "Alice"
    // @example  GET ghost   → (nil)
    case 'GET': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for GET', isWrite: false }
      const key = args[1]
      if (checkKey(key)) return { response: 'null:nil', isWrite: false }
      const val = getString(db, key)
      if (val === 'WRONGTYPE') return wrongType()
      if (val === null) return { response: 'null:nil', isWrite: false }
      return { response: `bulk:${val}`, isWrite: false, affectedKey: key }
    }

    // DEL key
    // Removes a key. Returns 1 if deleted, 0 if it didn't exist.
    // @example  DEL name    → (integer) 1
    // @example  DEL ghost   → (integer) 0
    case 'DEL': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for DEL', isWrite: false }
      const key = args[1]
      const deleted = deleteKey(db, key) ? 1 : 0
      if (deleted) {
        appendAOF(aof, `DEL ${key}`)
        expiryStore.delete(key)
      }
      return { response: `int:${deleted}`, isWrite: deleted > 0, affectedKey: key }
    }

    // FLUSHALL
    // Wipes the entire database, all TTLs, and the AOF log.
    // @example  FLUSHALL    → +OK
    case 'FLUSHALL': {
      clearDatabase(db)
      clearExpiry(expiryStore)
      clearAOF(aof)
      return { response: 'ok:OK', isWrite: true }
    }

    // ─── LISTS ──────────────────────────────────────────────────────────────

    // LPUSH key value [value …]
    // Prepends one or more values to the head of a list (right-to-left insertion order).
    // Creates the list if it doesn't exist. Returns the new length.
    // @example  LPUSH queue a b c   → (integer) 3  (list is now: ['c','b','a'])
    case 'LPUSH': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for LPUSH', isWrite: false }
      const key = args[1]
      const list = getOrCreateList(db, key)
      if (!list) return wrongType()
      const vals = args.slice(2)
      vals.forEach(v => list.unshift(v))
      appendAOF(aof, `LPUSH ${key} ${vals.join(' ')}`)
      return { response: `int:${list.length}`, isWrite: true, affectedKey: key }
    }

    // RPUSH key value [value …]
    // Appends one or more values to the tail of a list.
    // Creates the list if it doesn't exist. Returns the new length.
    // @example  RPUSH queue a b c   → (integer) 3  (list is now: ['a','b','c'])
    case 'RPUSH': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for RPUSH', isWrite: false }
      const key = args[1]
      const list = getOrCreateList(db, key)
      if (!list) return wrongType()
      const vals = args.slice(2)
      vals.forEach(v => list.push(v))
      appendAOF(aof, `RPUSH ${key} ${vals.join(' ')}`)
      return { response: `int:${list.length}`, isWrite: true, affectedKey: key }
    }

    // LPOP key
    // Removes and returns the first (head) element of a list.
    // Returns nil if the list doesn't exist or is empty.
    // @example  LPOP queue   → "task3"  (removes from the front)
    case 'LPOP': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for LPOP', isWrite: false }
      const key = args[1]
      const list = getList(db, key)
      if (list === 'WRONGTYPE') return wrongType()
      if (!list || list.length === 0) return { response: 'null:nil', isWrite: false }
      const val = list.shift()
      if (list.length === 0) deleteKey(db, key) // auto-delete empty list
      appendAOF(aof, `LPOP ${key}`)
      return { response: `bulk:${val}`, isWrite: true, affectedKey: key }
    }

    // RPOP key
    // Removes and returns the last (tail) element of a list.
    // Returns nil if the list doesn't exist or is empty.
    // @example  RPOP queue   → "task1"  (removes from the back)
    case 'RPOP': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for RPOP', isWrite: false }
      const key = args[1]
      const list = getList(db, key)
      if (list === 'WRONGTYPE') return wrongType()
      if (!list || list.length === 0) return { response: 'null:nil', isWrite: false }
      const val = list.pop()
      if (list.length === 0) deleteKey(db, key) // auto-delete empty list
      appendAOF(aof, `RPOP ${key}`)
      return { response: `bulk:${val}`, isWrite: true, affectedKey: key }
    }

    // LLEN key
    // Returns the number of elements in a list, or 0 if the key doesn't exist.
    // @example  LLEN queue   → (integer) 3
    // @example  LLEN ghost   → (integer) 0
    case 'LLEN': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for LLEN', isWrite: false }
      const key = args[1]
      const list = getList(db, key)
      if (list === 'WRONGTYPE') return wrongType()
      return { response: `int:${list ? list.length : 0}`, isWrite: false, affectedKey: key }
    }

    // LRANGE key start stop
    // Returns a slice of the list between start and stop (both inclusive).
    // Negative indices count from the tail: -1 is the last element, -2 is second-to-last, etc.
    // @example  LRANGE queue 0 -1   → all elements
    // @example  LRANGE queue 0  1   → first two elements
    // @example  LRANGE queue -2 -1  → last two elements
    case 'LRANGE': {
      if (args.length < 4) return { response: 'error:ERR wrong number of arguments for LRANGE', isWrite: false }
      const key = args[1]
      let start = parseInt(args[2]), stop = parseInt(args[3])
      const list = getList(db, key)
      if (list === 'WRONGTYPE') return wrongType()
      if (!list) return { response: 'array:[]', isWrite: false }
      const len = list.length
      if (start < 0) start = Math.max(0, len + start)
      if (stop < 0) stop = len + stop
      stop = Math.min(stop, len - 1)
      const slice = start > stop ? [] : list.slice(start, stop + 1)
      return { response: `array:${JSON.stringify(slice)}`, isWrite: false, affectedKey: key }
    }

    // ─── HASHES ─────────────────────────────────────────────────────────────

    // HSET key field value [field value …]
    // Sets one or more fields on a hash. Creates the hash if it doesn't exist.
    // Returns the number of NEW fields added (existing fields that were updated don't count).
    // @example  HSET user:1 name Bob age 30   → (integer) 2  (2 new fields)
    // @example  HSET user:1 age 31            → (integer) 0  (field existed, just updated)
    case 'HSET': {
      if (args.length < 4 || (args.length - 2) % 2 !== 0) return { response: 'error:ERR wrong number of arguments for HSET', isWrite: false }
      const key = args[1]
      const hash = getOrCreateHash(db, key)
      if (!hash) return wrongType()
      let added = 0
      for (let i = 2; i < args.length; i += 2) {
        if (!hash.has(args[i])) added++
        hash.set(args[i], args[i + 1])
      }
      appendAOF(aof, `HSET ${args.slice(1).join(' ')}`)
      return { response: `int:${added}`, isWrite: true, affectedKey: key }
    }

    // HGET key field
    // Returns the value of a single field from a hash, or nil if the field/key doesn't exist.
    // @example  HGET user:1 name   → "Bob"
    // @example  HGET user:1 ghost  → (nil)
    case 'HGET': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for HGET', isWrite: false }
      const key = args[1], field = args[2]
      const hash = getHash(db, key)
      if (hash === 'WRONGTYPE') return wrongType()
      if (!hash) return { response: 'null:nil', isWrite: false }
      const val = hash.get(field)
      return val != null ? { response: `bulk:${val}`, isWrite: false, affectedKey: key } : { response: 'null:nil', isWrite: false }
    }

    // HDEL key field [field …]
    // Removes one or more fields from a hash. Returns the number of fields actually deleted.
    // Auto-deletes the key if the hash becomes empty.
    // @example  HDEL user:1 age        → (integer) 1
    // @example  HDEL user:1 ghost      → (integer) 0  (field didn't exist)
    case 'HDEL': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for HDEL', isWrite: false }
      const key = args[1]
      const hash = getHash(db, key)
      if (hash === 'WRONGTYPE') return wrongType()
      if (!hash) return { response: 'int:0', isWrite: false }
      let count = 0
      for (let i = 2; i < args.length; i++) if (hash.delete(args[i])) count++
      if (hash.size === 0) deleteKey(db, key) // auto-delete empty hash
      if (count) appendAOF(aof, `HDEL ${args.slice(1).join(' ')}`)
      return { response: `int:${count}`, isWrite: count > 0, affectedKey: key }
    }

    // HGETALL key
    // Returns all fields and values in a hash as a flat array: [field, value, field, value, …]
    // @example  HGETALL user:1   → ["name", "Bob", "age", "30"]
    // @example  HGETALL ghost    → (empty array)
    case 'HGETALL': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for HGETALL', isWrite: false }
      const key = args[1]
      const hash = getHash(db, key)
      if (hash === 'WRONGTYPE') return wrongType()
      if (!hash || hash.size === 0) return { response: 'array:[]', isWrite: false }
      const pairs = []
      for (const [f, v] of hash) { pairs.push(f); pairs.push(v) }
      return { response: `array:${JSON.stringify(pairs)}`, isWrite: false, affectedKey: key }
    }

    // HLEN key
    // Returns the number of fields in a hash, or 0 if the key doesn't exist.
    // @example  HLEN user:1   → (integer) 2
    // @example  HLEN ghost    → (integer) 0
    case 'HLEN': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for HLEN', isWrite: false }
      const key = args[1]
      const hash = getHash(db, key)
      if (hash === 'WRONGTYPE') return wrongType()
      return { response: `int:${hash ? hash.size : 0}`, isWrite: false, affectedKey: key }
    }

    // HEXISTS key field
    // Returns 1 if the field exists in the hash, 0 otherwise.
    // @example  HEXISTS user:1 name    → (integer) 1
    // @example  HEXISTS user:1 ghost   → (integer) 0
    case 'HEXISTS': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for HEXISTS', isWrite: false }
      const key = args[1], field = args[2]
      const hash = getHash(db, key)
      if (hash === 'WRONGTYPE') return wrongType()
      return { response: `int:${hash && hash.has(field) ? 1 : 0}`, isWrite: false, affectedKey: key }
    }

    // ─── TRANSACTIONS ────────────────────────────────────────────────────────

    // MULTI
    // Begins a transaction block. All subsequent commands are queued until EXEC or DISCARD.
    // @example  MULTI   → +OK   (transactionState.active is now true)
    case 'MULTI': {
      transactionState.active = true
      transactionState.queue = []
      return { response: 'ok:OK', isWrite: false }
    }

    // EXEC (outside MULTI)
    // Returns an error if called without a preceding MULTI.
    // @example  EXEC   → -ERR EXEC without MULTI
    case 'EXEC': {
      return { response: 'error:ERR EXEC without MULTI', isWrite: false }
    }

    // DISCARD (outside MULTI)
    // Returns an error if called without a preceding MULTI.
    // @example  DISCARD   → -ERR DISCARD without MULTI
    case 'DISCARD': {
      return { response: 'error:ERR DISCARD without MULTI', isWrite: false }
    }

    // ─── PUB/SUB ────────────────────────────────────────────────────────────

    // SUBSCRIBE channel [channel …]
    // Registers the terminal client as a subscriber on one or more channels.
    // Incoming messages are pushed to pubsubState.inbox and rendered in the terminal.
    // @example  SUBSCRIBE news alerts   → Subscribed to: news, alerts
    case 'SUBSCRIBE': {
      if (args.length < 2) return { response: 'error:ERR wrong number of arguments for SUBSCRIBE', isWrite: false }
      const channels = args.slice(1)
      channels.forEach(ch => {
        subscribe(pubsub, ch, 'terminal', (channel, message) => {
          pubsubState.inbox.push({ channel, message, ts: Date.now() })
        })
        pubsubState.subscriptions.add(ch)
      })
      return { response: `subscribe:${JSON.stringify(channels)}`, isWrite: false }
    }

    // UNSUBSCRIBE [channel …]
    // Removes the terminal client from the given channels (or all channels if none specified).
    // @example  UNSUBSCRIBE news         → Unsubscribed from: news
    // @example  UNSUBSCRIBE              → Unsubscribed from all active channels
    case 'UNSUBSCRIBE': {
      const channels = args.length > 1 ? args.slice(1) : [...pubsubState.subscriptions]
      channels.forEach(ch => {
        unsubscribe(pubsub, ch, 'terminal')
        pubsubState.subscriptions.delete(ch)
      })
      return { response: `unsubscribe:${JSON.stringify(channels)}`, isWrite: false }
    }

    // PUBLISH channel message
    // Sends a message to all subscribers of a channel.
    // Returns the number of clients that received the message.
    // @example  PUBLISH news "Hello World"   → (integer) 1  (1 subscriber received it)
    // @example  PUBLISH ghost "anyone?"      → (integer) 0  (no subscribers)
    case 'PUBLISH': {
      if (args.length < 3) return { response: 'error:ERR wrong number of arguments for PUBLISH', isWrite: false }
      const channel = args[1], message = args[2]
      const count = publish(pubsub, channel, message)
      return { response: `int:${count}`, isWrite: false, pubsubEvent: { channel, message } }
    }

    default:
      return { response: `error:ERR unknown command '${cmd}'`, isWrite: false }
  }
}

/**
 * Tokenises a raw command-line string into an args array.
 * Handles quoted strings (single or double quotes) so values with spaces work correctly.
 *
 * @example
 * parseCommandLine('SET name Alice')
 * // → ['SET', 'name', 'Alice']
 *
 * parseCommandLine('SET greeting "Hello World"')
 * // → ['SET', 'greeting', 'Hello World']
 *
 * parseCommandLine("HSET user:1 name 'Bob Smith' age 30")
 * // → ['HSET', 'user:1', 'name', 'Bob Smith', 'age', '30']
 *
 * parseCommandLine('  PING  ')
 * // → ['PING']   (trims extra whitespace)
 */
export function parseCommandLine(line) {
  const tokens = []
  let current = ''
  let inQuote = false
  let quoteChar = ''
  for (const char of line.trim()) {
    if (inQuote) {
      if (char === quoteChar) { inQuote = false }
      else current += char
    } else if (char === '"' || char === "'") {
      inQuote = true; quoteChar = char
    } else if (char === ' ') {
      if (current) { tokens.push(current); current = '' }
    } else {
      current += char
    }
  }
  if (current) tokens.push(current)
  return tokens
}
