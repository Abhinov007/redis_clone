// Renders a single REPL output line with color coding
export default function ResponseLine({ response }) {
  if (!response) return null
  const [type, ...rest] = response.split(':')
  const text = rest.join(':')

  if (type === 'ok') return <span className="text-green-400">+{text}</span>
  if (type === 'error') return <span className="text-red-400">-{text}</span>
  if (type === 'int') return <span className="text-yellow-300">:{text}</span>
  if (type === 'null') return <span className="text-gray-500">(nil)</span>
  if (type === 'bulk') return <span className="text-sky-300">"{text}"</span>
  if (type === 'simple') return <span className="text-green-300">+{text}</span>
  if (type === 'queued') return <span className="text-purple-300">QUEUED</span>
  if (type === 'subscribe') {
    const channels = JSON.parse(text)
    return <span className="text-orange-300">Subscribed to: {channels.join(', ')}</span>
  }
  if (type === 'unsubscribe') {
    const channels = JSON.parse(text)
    return <span className="text-orange-300">Unsubscribed from: {channels.join(', ')}</span>
  }
  if (type === 'array') {
    const arr = JSON.parse(text)
    if (arr.length === 0) return <span className="text-gray-400">(empty array)</span>
    return (
      <span className="text-sky-200">
        {arr.map((item, i) => (
          <span key={i} className="block ml-4 text-sky-300">{i + 1}) "{item}"</span>
        ))}
      </span>
    )
  }
  return <span className="text-gray-300">{response}</span>
}
