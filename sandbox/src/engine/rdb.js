// Mirrors persistence/rdb.js
// The RDB snapshot is simulated as a plain JSON-serialisable object.
// In the real server this is written to `dump.rdb` on disk after every write.
// Hashes require special handling because JS Maps are not JSON-serialisable directly.

/**
 * Serialises the entire in-memory database into a plain JSON-safe object.
 * - Strings and lists are stored as-is.
 * - Hashes (stored internally as Map) are converted to plain objects via Object.fromEntries.
 * This mirrors the structure written to `dump.rdb` in the real server.
 * @example
 * // Given db contains: name='Alice', queue=['task1'], user:1={name:'Bob'}
 * snapshotRDB(db)
 * // →
 * // {
 * //   "name":   { "type": "string", "value": "Alice" },
 * //   "queue":  { "type": "list",   "value": ["task1"] },
 * //   "user:1": { "type": "hash",   "value": { "name": "Bob", "age": "30" } }
 * // }
 *
 * // On FLUSHALL, db is empty:
 * snapshotRDB(db)  // → {}
 */
export function snapshotRDB(db) {
  const obj = {}
  for (const [key, entry] of db) {
    if (entry.type === 'hash') {
      // Convert Map → plain object so it can be JSON.stringify'd
      obj[key] = { type: 'hash', value: Object.fromEntries(entry.value) }
    } else {
      obj[key] = { type: entry.type, value: entry.value }
    }
  }
  return obj
}
