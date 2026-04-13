import { useState, useRef, useEffect } from 'react'
import ResponseLine from './ResponseLine'

const EXAMPLES = [
  { label: 'String', cmd: 'SET name Alice' },
  { label: 'With TTL', cmd: 'SET session abc123 EX 30' },
  { label: 'List', cmd: 'RPUSH queue task1 task2 task3' },
  { label: 'Hash', cmd: 'HSET user:1 name Bob age 30 city NYC' },
  { label: 'Pub/Sub', cmd: 'SUBSCRIBE news' },
  { label: 'Publish', cmd: 'PUBLISH news "Hello World"' },
  { label: 'Transaction', cmd: 'MULTI' },
]

export default function Terminal({ history, runCommand, txActive }) {
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [cmdHistory, setCmdHistory] = useState([])
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  const submit = () => {
    const line = input.trim()
    if (!line) return
    setCmdHistory(prev => [line, ...prev])
    setHistoryIndex(-1)
    runCommand(line)
    setInput('')
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { submit(); return }
    if (e.key === 'ArrowUp') {
      const idx = historyIndex + 1
      if (idx < cmdHistory.length) { setHistoryIndex(idx); setInput(cmdHistory[idx]) }
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') {
      const idx = historyIndex - 1
      if (idx < 0) { setHistoryIndex(-1); setInput('') }
      else { setHistoryIndex(idx); setInput(cmdHistory[idx]) }
      e.preventDefault()
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0d1117] border border-[#2a2f3d] rounded-lg overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#161b22] border-b border-[#2a2f3d]">
        <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-xs text-gray-400 font-mono">redis-sandbox</span>
        {txActive && (
          <span className="ml-auto text-xs bg-purple-900 text-purple-300 px-2 py-0.5 rounded">MULTI active</span>
        )}
      </div>

      {/* Example buttons */}
      <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-[#2a2f3d] bg-[#0d1117]">
        {EXAMPLES.map(ex => (
          <button
            key={ex.label}
            onClick={() => runCommand(ex.cmd)}
            className="text-xs px-2 py-1 rounded bg-[#1c2333] hover:bg-[#2a3447] text-gray-300 hover:text-white border border-[#3a4155] transition-colors"
          >
            {ex.label}
          </button>
        ))}
        <button
          onClick={() => runCommand('FLUSHALL')}
          className="text-xs px-2 py-1 rounded bg-red-950 hover:bg-red-900 text-red-400 border border-red-800 transition-colors ml-auto"
        >
          FLUSHALL
        </button>
      </div>

      {/* Output */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm">
        {history.map((entry, i) => (
          <div key={i} className="leading-relaxed">
            {entry.type === 'system' && (
              <span className="text-gray-500 text-xs"># {entry.text}</span>
            )}
            {entry.type === 'command' && (
              <span className="text-white">
                <span className="text-[#e06c75]">❯</span>{' '}
                <span className="text-gray-100">{entry.text}</span>
              </span>
            )}
            {entry.type === 'response' && (
              <div className="ml-4">
                <ResponseLine response={entry.response} />
              </div>
            )}
            {entry.type === 'pubsub-message' && (
              <div className="ml-4 text-orange-300">📨 {entry.text}</div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-t border-[#2a2f3d] bg-[#0d1117] cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        <span className="text-[#e06c75] font-bold select-none">❯</span>
        <input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 bg-transparent outline-none text-gray-100 font-mono text-sm caret-green-400 placeholder-gray-600"
          placeholder="Type a Redis command..."
        />
      </div>
    </div>
  )
}
