// Mirrors storage/database.js
// Each entry in the Map is a typed object: { type: 'string'|'list'|'hash', value }

/**
 * Creates a fresh in-memory database.
 * @example
 * const db = createDatabase()
 * // db → Map {}
 */
export function createDatabase() {
  return new Map()
}

/**
 * Stores a string value under the given key.
 * Overwrites any existing value (including other types).
 * @example
 * setString(db, 'name', 'Alice')
 * // db → Map { 'name' → { type: 'string', value: 'Alice' } }
 */
export function setString(db, key, value) {
  db.set(key, { type: 'string', value })
}

/**
 * Retrieves the string value for a key.
 * Returns null if the key doesn't exist, or 'WRONGTYPE' if the key holds a non-string.
 * @example
 * getString(db, 'name')   // → 'Alice'
 * getString(db, 'ghost')  // → null       (key doesn't exist)
 * getString(db, 'mylist') // → 'WRONGTYPE' (mylist is a list, not a string)
 */
export function getString(db, key) {
  const entry = db.get(key)
  if (!entry) return null
  if (entry.type !== 'string') return 'WRONGTYPE'
  return entry.value
}

/**
 * Returns the array for a list key, creating it if it doesn't exist yet.
 * Returns null if the key exists but holds a non-list type.
 * @example
 * const list = getOrCreateList(db, 'queue')
 * list.push('task1')
 * // db → Map { 'queue' → { type: 'list', value: ['task1'] } }
 */
export function getOrCreateList(db, key) {
  if (!db.has(key)) db.set(key, { type: 'list', value: [] })
  const entry = db.get(key)
  if (entry.type !== 'list') return null
  return entry.value
}

/**
 * Retrieves the array for an existing list key.
 * Returns null if the key doesn't exist, or 'WRONGTYPE' if it holds a non-list.
 * @example
 * getList(db, 'queue')   // → ['task3', 'task2', 'task1']
 * getList(db, 'ghost')   // → null
 * getList(db, 'name')    // → 'WRONGTYPE' (name is a string)
 */
export function getList(db, key) {
  const entry = db.get(key)
  if (!entry) return null
  if (entry.type !== 'list') return 'WRONGTYPE'
  return entry.value
}

/**
 * Returns the Map of fields for a hash key, creating it if it doesn't exist yet.
 * Returns null if the key exists but holds a non-hash type.
 * @example
 * const hash = getOrCreateHash(db, 'user:1')
 * hash.set('name', 'Bob')
 * // db → Map { 'user:1' → { type: 'hash', value: Map { 'name' → 'Bob' } } }
 */
export function getOrCreateHash(db, key) {
  if (!db.has(key)) db.set(key, { type: 'hash', value: new Map() })
  const entry = db.get(key)
  if (entry.type !== 'hash') return null
  return entry.value
}

/**
 * Retrieves the field Map for an existing hash key.
 * Returns null if the key doesn't exist, or 'WRONGTYPE' if it holds a non-hash.
 * @example
 * getHash(db, 'user:1')  // → Map { 'name' → 'Bob', 'age' → '30' }
 * getHash(db, 'ghost')   // → null
 * getHash(db, 'name')    // → 'WRONGTYPE' (name is a string)
 */
export function getHash(db, key) {
  const entry = db.get(key)
  if (!entry) return null
  if (entry.type !== 'hash') return 'WRONGTYPE'
  return entry.value
}

/**
 * Removes a key from the database entirely.
 * Returns true if the key existed and was deleted, false otherwise.
 * @example
 * deleteKey(db, 'name')   // → true  (key existed)
 * deleteKey(db, 'ghost')  // → false (key didn't exist)
 */
export function deleteKey(db, key) {
  return db.delete(key)
}

/**
 * Wipes every key from the database (equivalent to FLUSHALL).
 * @example
 * clearDatabase(db)
 * // db → Map {}
 */
export function clearDatabase(db) {
  db.clear()
}

/**
 * Returns the entire database Map (used for iteration and snapshots).
 * @example
 * for (const [key, entry] of getAll(db)) {
 *   console.log(key, entry.type, entry.value)
 * }
 */
export function getAll(db) {
  return db
}
