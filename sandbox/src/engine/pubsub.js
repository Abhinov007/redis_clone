// Mirrors messaging/pubsub.js
// In the browser simulation, "subscribers" are named virtual clients.
// Internal structure: Map<channel, Map<clientId, onMessage>>

/**
 * Creates a fresh pub/sub registry.
 * @example
 * const pubsub = createPubSub()
 * // pubsub → Map {}
 */
export function createPubSub() {
  return new Map() // channel -> Map<clientId, onMessage>
}

/**
 * Subscribes a named client to a channel.
 * If the channel doesn't exist yet it is created automatically.
 * Returns the total number of subscribers on that channel after adding this one.
 * @example
 * subscribe(pubsub, 'news', 'client-1', (ch, msg) => console.log(ch, msg))
 * // pubsub → Map { 'news' → Map { 'client-1' → [Function] } }
 * // returns 1
 *
 * subscribe(pubsub, 'news', 'client-2', (ch, msg) => console.log(ch, msg))
 * // returns 2
 */
export function subscribe(pubsub, channel, clientId, onMessage) {
  if (!pubsub.has(channel)) pubsub.set(channel, new Map())
  pubsub.get(channel).set(clientId, onMessage)
  return pubsub.get(channel).size
}

/**
 * Unsubscribes a client from a specific channel.
 * Removes the channel entry entirely if no subscribers remain.
 * Returns the number of subscribers still on the channel after removal.
 * @example
 * unsubscribe(pubsub, 'news', 'client-1')
 * // client-1 removed from 'news'; returns remaining subscriber count
 *
 * unsubscribe(pubsub, 'ghost', 'client-1')
 * // channel doesn't exist → returns 0 (no-op)
 */
export function unsubscribe(pubsub, channel, clientId) {
  if (!pubsub.has(channel)) return 0
  pubsub.get(channel).delete(clientId)
  const size = pubsub.get(channel).size
  if (size === 0) pubsub.delete(channel)
  return size
}

/**
 * Unsubscribes a client from every channel it is currently on.
 * Cleans up any channels that become empty as a result.
 * Called automatically when a client disconnects.
 * @example
 * // client-1 is subscribed to 'news' and 'alerts'
 * unsubscribeAll(pubsub, 'client-1')
 * // client-1 removed from both channels; empty channels are deleted
 */
export function unsubscribeAll(pubsub, clientId) {
  for (const [channel, subscribers] of pubsub) {
    subscribers.delete(clientId)
    if (subscribers.size === 0) pubsub.delete(channel)
  }
}

/**
 * Publishes a message to all subscribers of a channel.
 * Calls each subscriber's onMessage callback with (channel, message).
 * Returns the number of subscribers the message was delivered to (0 if none).
 * @example
 * publish(pubsub, 'news', 'Hello World')
 * // → fires onMessage('news', 'Hello World') for every subscriber
 * // → returns 2  (if two clients are subscribed)
 *
 * publish(pubsub, 'ghost', 'No one is here')
 * // → returns 0  (channel has no subscribers)
 */
export function publish(pubsub, channel, message) {
  if (!pubsub.has(channel)) return 0
  const subscribers = pubsub.get(channel)
  let count = 0
  for (const [, onMessage] of subscribers) {
    onMessage(channel, message)
    count++
  }
  return count
}

/**
 * Returns the full pub/sub registry Map (used by the UI to render the Pub/Sub tab).
 * @example
 * getChannels(pubsub)
 * // → Map { 'news' → Map { 'terminal' → [Function] }, 'alerts' → Map { ... } }
 */
export function getChannels(pubsub) {
  return pubsub
}
