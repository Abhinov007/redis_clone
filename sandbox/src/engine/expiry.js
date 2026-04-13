// Mirrors storage/expiry.js
// Stores absolute expiry timestamps (ms since epoch) keyed by the Redis key name.
// Expiry is checked lazily on every read — there is no background sweep.

/**
 * Creates a fresh expiry store.
 * @example
 * const expiryStore = createExpiryStore()
 * // expiryStore → Map {}
 */
export function createExpiryStore() {
  return new Map()
}

/**
 * Registers a TTL for a key by recording the absolute deadline timestamp.
 * @example
 * setExpiry(expiryStore, 'session', 60)
 * // expiryStore → Map { 'session' → <Date.now() + 60000> }
 *
 * setExpiry(expiryStore, 'otp', 5)
 * // key 'otp' will expire in 5 seconds
 */
export function setExpiry(expiryStore, key, ttlSeconds) {
  expiryStore.set(key, Date.now() + ttlSeconds * 1000)
}

/**
 * Lazily checks whether a key has expired.
 * If expired, deletes it from both the expiry store and the database immediately.
 * Returns true if the key was expired and removed, false otherwise.
 * @example
 * // Key 'otp' was set with EX 5 five seconds ago
 * isExpired(expiryStore, db, 'otp')    // → true  (deleted from db and expiryStore)
 * isExpired(expiryStore, db, 'name')   // → false (no TTL set)
 * isExpired(expiryStore, db, 'ghost')  // → false (key not in expiryStore)
 */
export function isExpired(expiryStore, db, key) {
  if (!expiryStore.has(key)) return false
  if (Date.now() >= expiryStore.get(key)) {
    expiryStore.delete(key)
    db.delete(key)
    return true
  }
  return false
}

/**
 * Removes all TTL entries (called on FLUSHALL).
 * @example
 * clearExpiry(expiryStore)
 * // expiryStore → Map {}
 */
export function clearExpiry(expiryStore) {
  expiryStore.clear()
}

/**
 * Returns the raw expiry timestamp (ms since epoch) for a key, or null if none.
 * @example
 * getExpiryTimestamp(expiryStore, 'session') // → 1713000060000  (some future epoch ms)
 * getExpiryTimestamp(expiryStore, 'name')    // → null           (no TTL set)
 */
export function getExpiryTimestamp(expiryStore, key) {
  return expiryStore.get(key) ?? null
}

/**
 * Returns the remaining TTL in seconds for a key, or null if no TTL is set.
 * Returns 0 if the key has already passed its deadline (not yet lazily cleaned up).
 * @example
 * // 'session' was set with EX 60, and 10 seconds have passed
 * getTTLSeconds(expiryStore, 'session') // → 50.0
 * getTTLSeconds(expiryStore, 'name')    // → null  (no TTL)
 */
export function getTTLSeconds(expiryStore, key) {
  const ts = expiryStore.get(key)
  if (!ts) return null
  const remaining = (ts - Date.now()) / 1000
  return remaining > 0 ? remaining : 0
}
