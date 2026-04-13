import { useState, useCallback, useRef, useEffect } from 'react'
import { createDatabase } from '../engine/database.js'
import { createExpiryStore } from '../engine/expiry.js'
import { createAOF } from '../engine/aof.js'
import { createPubSub } from '../engine/pubsub.js'
import { snapshotRDB } from '../engine/rdb.js'
import { processCommand, parseCommandLine } from '../engine/commands.js'

export function useRedisEngine() {
  const dbRef = useRef(createDatabase())
  const expiryRef = useRef(createExpiryStore())
  const aofRef = useRef(createAOF())
  const pubsubRef = useRef(createPubSub())
  const txRef = useRef({ active: false, queue: [] })
  const pubsubStateRef = useRef({ subscriptions: new Set(), inbox: [] })

  const [dbSnapshot, setDbSnapshot] = useState(new Map())
  const [expirySnapshot, setExpirySnapshot] = useState(new Map())
  const [aofSnapshot, setAofSnapshot] = useState([])
  const [rdbSnapshot, setRdbSnapshot] = useState({})
  const [pubsubSnapshot, setPubsubSnapshot] = useState(new Map())
  const [lastAffectedKey, setLastAffectedKey] = useState(null)
  const [history, setHistory] = useState([
    { type: 'system', text: 'Redis Sandbox — type a command to get started' },
    { type: 'system', text: 'Try: SET name Alice  |  LPUSH queue a b c  |  HSET user:1 name Bob age 30' },
  ])

  const refreshState = useCallback((affectedKey) => {
    setDbSnapshot(new Map(dbRef.current))
    setExpirySnapshot(new Map(expiryRef.current))
    setAofSnapshot([...aofRef.current])
    setRdbSnapshot(snapshotRDB(dbRef.current))
    setPubsubSnapshot(new Map(pubsubRef.current))
    if (affectedKey) {
      setLastAffectedKey(affectedKey)
      setTimeout(() => setLastAffectedKey(null), 600)
    }
  }, [])

  // Tick expiry every second
  useEffect(() => {
    const interval = setInterval(() => {
      let changed = false
      for (const [key, ts] of [...expiryRef.current]) {
        if (Date.now() >= ts) {
          expiryRef.current.delete(key)
          dbRef.current.delete(key)
          changed = true
        }
      }
      if (changed) refreshState(null)
      else setExpirySnapshot(new Map(expiryRef.current))
    }, 1000)
    return () => clearInterval(interval)
  }, [refreshState])

  const runCommand = useCallback((line) => {
    const args = parseCommandLine(line)
    if (!args.length) return

    const result = processCommand(
      args,
      dbRef.current,
      expiryRef.current,
      aofRef.current,
      pubsubRef.current,
      txRef.current,
      pubsubStateRef.current
    )

    // Build history entry for the command
    const entries = [{ type: 'command', text: line }]

    // Handle pub/sub inbox messages
    if (pubsubStateRef.current.inbox.length > 0) {
      pubsubStateRef.current.inbox.forEach(msg => {
        entries.push({ type: 'pubsub-message', text: `Message on [${msg.channel}]: ${msg.message}` })
      })
      pubsubStateRef.current.inbox = []
    }

    entries.push({ type: 'response', response: result.response })

    setHistory(prev => [...prev, ...entries])
    refreshState(result.affectedKey)
  }, [refreshState])

  return {
    dbSnapshot,
    expirySnapshot,
    aofSnapshot,
    rdbSnapshot,
    pubsubSnapshot,
    pubsubState: pubsubStateRef.current,
    lastAffectedKey,
    txActive: txRef.current.active,
    txQueue: txRef.current.queue,
    history,
    runCommand,
  }
}
