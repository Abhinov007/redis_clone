import { useEffect, useState } from 'react'

const TYPE_COLORS = {
  string: 'bg-blue-900 text-blue-300 border-blue-700',
  list: 'bg-green-900 text-green-300 border-green-700',
  hash: 'bg-purple-900 text-purple-300 border-purple-700',
}

function TTLBadge({ expiryTs }) {
  const [remaining, setRemaining] = useState(((expiryTs - Date.now()) / 1000).toFixed(1))

  useEffect(() => {
    const interval = setInterval(() => {
      const r = (expiryTs - Date.now()) / 1000
      setRemaining(Math.max(0, r).toFixed(1))
    }, 100)
    return () => clearInterval(interval)
  }, [expiryTs])

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-yellow-400 mb-1">
        <span>⏱ TTL</span>
        <span>{remaining}s</span>
      </div>
      <div className="w-full h-1 bg-gray-700 rounded">
        <div
          className="h-1 bg-yellow-400 rounded transition-all"
          style={{ width: `${remaining > 0 ? 100 : 0}%` }}
        />
      </div>
    </div>
  )
}

function ValueDisplay({ entry }) {
  if (entry.type === 'string') {
    return <div className="text-sky-300 font-mono text-sm mt-1">"{entry.value}"</div>
  }
  if (entry.type === 'list') {
    return (
      <div className="flex flex-wrap gap-1 mt-2">
        {entry.value.map((item, i) => (
          <span key={i} className="text-xs bg-green-950 border border-green-800 text-green-300 px-1.5 py-0.5 rounded font-mono">
            [{i}] {item}
          </span>
        ))}
      </div>
    )
  }
  if (entry.type === 'hash') {
    return (
      <div className="mt-2 space-y-1">
        {[...entry.value.entries()].map(([field, val]) => (
          <div key={field} className="flex gap-2 text-xs font-mono">
            <span className="text-purple-400">{field}</span>
            <span className="text-gray-500">:</span>
            <span className="text-purple-200">{val}</span>
          </div>
        ))}
      </div>
    )
  }
  return null
}

export default function KeyCard({ keyName, entry, expiryTs, isFlashing }) {
  return (
    <div
      className={`
        rounded-lg border p-3 transition-all duration-300
        ${isFlashing
          ? 'border-yellow-400 bg-yellow-950 shadow-lg shadow-yellow-900/40'
          : 'border-[#2a2f3d] bg-[#161b22] hover:border-[#3a4155]'}
      `}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-white font-medium text-sm">{keyName}</span>
        <span className={`text-xs px-2 py-0.5 rounded border font-mono ${TYPE_COLORS[entry.type]}`}>
          {entry.type}
        </span>
      </div>
      <ValueDisplay entry={entry} />
      {expiryTs && <TTLBadge expiryTs={expiryTs} />}
    </div>
  )
}
