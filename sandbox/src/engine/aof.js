// Mirrors persistence/aof.js
// The AOF (Append-Only File) is simulated as an in-memory array of command strings.
// In the real server this is written to `database.aof` on disk after every write.

/**
 * Creates a fresh AOF log (empty array).
 * @example
 * const aof = createAOF()
 * // aof → []
 */
export function createAOF() {
  return []
}

/**
 * Appends a write command string to the AOF log.
 * Only write commands (SET, DEL, LPUSH, RPUSH, LPOP, RPOP, HSET, HDEL, FLUSHALL) are logged.
 * Read commands (GET, LLEN, HGET, …) are never appended.
 * @example
 * appendAOF(aof, 'SET name Alice')
 * appendAOF(aof, 'LPUSH queue task1 task2')
 * appendAOF(aof, 'HSET user:1 name Bob age 30')
 * // aof → ['SET name Alice', 'LPUSH queue task1 task2', 'HSET user:1 name Bob age 30']
 */
export function appendAOF(aof, command) {
  aof.push(command)
}

/**
 * Clears all entries from the AOF log (called on FLUSHALL).
 * Uses `length = 0` to clear in place, preserving the array reference held elsewhere.
 * @example
 * clearAOF(aof)
 * // aof → []
 */
export function clearAOF(aof) {
  aof.length = 0
}
