import { useState, useEffect } from 'react'
import KeyCard from './KeyCard'

const TABS = ['Database', 'Expiry', 'AOF Log', 'RDB Snapshot', 'Pub/Sub']

function DatabaseTab({ dbSnapshot, expirySnapshot, lastAffectedKey }) {
  if (dbSnapshot.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <div className="text-4xl mb-3">🗄️</div>
        <div className="text-sm">Database is empty</div>
        <div className="text-xs mt-1 text-gray-600">Try: SET name Alice</div>
      </div>
    )
  }
  return (
    <div className="space-y-2 p-3">
      {[...dbSnapshot.entries()].map(([key, entry]) => (
        <KeyCard
          key={key}
          keyName={key}
          entry={entry}
          expiryTs={expirySnapshot.get(key)}
          isFlashing={lastAffectedKey === key}
        />
      ))}
    </div>
  )
}

function ExpiryTab({ expirySnapshot }) {
  if (expirySnapshot.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <div className="text-4xl mb-3">⏱️</div>
        <div className="text-sm">No keys with TTL</div>
        <div className="text-xs mt-1 text-gray-600">Try: SET token abc EX 60</div>
      </div>
    )
  }
  return (
    <div className="p-3 space-y-2">
      <div className="grid grid-cols-3 text-xs text-gray-500 pb-2 border-b border-[#2a2f3d] font-mono">
        <span>KEY</span>
        <span>EXPIRES AT</span>
        <span>REMAINING</span>
      </div>
      {[...expirySnapshot.entries()].map(([key, ts]) => (
        <ExpiryRow key={key} keyName={key} ts={ts} />
      ))}
    </div>
  )
}

function ExpiryRow({ keyName, ts }) {
  const [remaining, setRemaining] = useState(Math.max(0, (ts - Date.now()) / 1000))

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(Math.max(0, (ts - Date.now()) / 1000))
    }, 100)
    return () => clearInterval(interval)
  }, [ts])

  return (
    <div className="font-mono text-xs mb-3">
      <div className="grid grid-cols-3 items-center mb-1">
        <span className="text-white">{keyName}</span>
        <span className="text-gray-400">{new Date(ts).toLocaleTimeString()}</span>
        <span className={remaining < 5 ? 'text-red-400' : 'text-yellow-400'}>{remaining.toFixed(1)}s</span>
      </div>
      <div className="w-full h-1 bg-gray-800 rounded">
        <div
          className={`h-1 rounded transition-all ${remaining < 5 ? 'bg-red-500' : 'bg-yellow-400'}`}
          style={{ width: `${Math.min(100, (remaining / 60) * 100)}%` }}
        />
      </div>
    </div>
  )
}

function AOFTab({ aofSnapshot }) {
  if (aofSnapshot.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <div className="text-4xl mb-3">📝</div>
        <div className="text-sm">AOF log is empty</div>
        <div className="text-xs mt-1 text-gray-600">Write commands will appear here</div>
      </div>
    )
  }
  return (
    <div className="p-3 font-mono text-xs space-y-1">
      <div className="text-gray-500 text-xs mb-2 pb-2 border-b border-[#2a2f3d]">
        database.aof — {aofSnapshot.length} {aofSnapshot.length === 1 ? 'entry' : 'entries'}
      </div>
      {aofSnapshot.map((line, i) => (
        <div key={i} className="flex gap-3 items-start">
          <span className="text-gray-600 select-none w-6 text-right">{i + 1}</span>
          <span className="text-green-300">{line}</span>
        </div>
      ))}
    </div>
  )
}

function RDBTab({ rdbSnapshot }) {
  const isEmpty = Object.keys(rdbSnapshot).length === 0
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <div className="text-4xl mb-3">💾</div>
        <div className="text-sm">RDB snapshot is empty</div>
      </div>
    )
  }

  const json = JSON.stringify(rdbSnapshot, null, 2)

  return (
    <div className="p-3">
      <div className="text-gray-500 text-xs mb-2 pb-2 border-b border-[#2a2f3d] font-mono">
        dump.rdb (JSON) — {Object.keys(rdbSnapshot).length} {Object.keys(rdbSnapshot).length === 1 ? 'key' : 'keys'}
      </div>
      <pre className="font-mono text-xs text-sky-300 whitespace-pre-wrap overflow-auto">{json}</pre>
    </div>
  )
}

function PubSubTab({ pubsubSnapshot }) {
  if (pubsubSnapshot.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <div className="text-4xl mb-3">📡</div>
        <div className="text-sm">No active channels</div>
        <div className="text-xs mt-1 text-gray-600">Try: SUBSCRIBE news</div>
        <div className="text-xs text-gray-600">Then: PUBLISH news "Hello!"</div>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      <div className="text-gray-500 text-xs mb-2 pb-2 border-b border-[#2a2f3d]">
        {pubsubSnapshot.size} active {pubsubSnapshot.size === 1 ? 'channel' : 'channels'}
      </div>
      {[...pubsubSnapshot.entries()].map(([channel, subscribers]) => (
        <div key={channel} className="border border-[#2a2f3d] rounded-lg p-3 bg-[#161b22]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-orange-400">📡</span>
              <span className="font-mono text-orange-300 text-sm font-medium">{channel}</span>
            </div>
            <span className="text-xs bg-orange-950 text-orange-400 border border-orange-800 px-2 py-0.5 rounded">
              {subscribers.size} subscriber{subscribers.size !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="space-y-1">
            {[...subscribers.keys()].map(clientId => (
              <div key={clientId} className="flex items-center gap-2 text-xs font-mono">
                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                <span className="text-gray-400">{clientId}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function StorageInspector({
  dbSnapshot, expirySnapshot, aofSnapshot, rdbSnapshot, pubsubSnapshot, lastAffectedKey
}) {
  const [activeTab, setActiveTab] = useState('Database')

  const tabCounts = {
    Database: dbSnapshot.size,
    Expiry: expirySnapshot.size,
    'AOF Log': aofSnapshot.length,
    'RDB Snapshot': Object.keys(rdbSnapshot).length,
    'Pub/Sub': pubsubSnapshot.size,
  }

  return (
    <div className="flex flex-col h-full bg-[#0d1117] border border-[#2a2f3d] rounded-lg overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-[#2a2f3d] bg-[#161b22] overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-xs font-mono whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              activeTab === tab
                ? 'text-white border-b-2 border-[#e06c75] bg-[#0d1117]'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab}
            {tabCounts[tab] > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === tab ? 'bg-[#e06c75] text-white' : 'bg-[#2a2f3d] text-gray-400'
              }`}>
                {tabCounts[tab]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'Database' && (
          <DatabaseTab dbSnapshot={dbSnapshot} expirySnapshot={expirySnapshot} lastAffectedKey={lastAffectedKey} />
        )}
        {activeTab === 'Expiry' && <ExpiryTab expirySnapshot={expirySnapshot} />}
        {activeTab === 'AOF Log' && <AOFTab aofSnapshot={aofSnapshot} />}
        {activeTab === 'RDB Snapshot' && <RDBTab rdbSnapshot={rdbSnapshot} />}
        {activeTab === 'Pub/Sub' && <PubSubTab pubsubSnapshot={pubsubSnapshot} />}
      </div>
    </div>
  )
}
