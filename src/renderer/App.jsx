import { useState } from 'react'

const drag = { WebkitAppRegion: 'drag' }
const noDrag = { WebkitAppRegion: 'no-drag' }

export default function App() {
  const [status, setStatus] = useState('Idle')
  const [imagePath, setImagePath] = useState('')
  const [text, setText] = useState('')

  async function handleCapture() {
    setStatus('Capturing…')
    setImagePath('')
    setText('')
    try {
      const filePath = await window.native.captureScreen()
      setImagePath(filePath)
      setStatus('Saved')
    } catch (err) {
      setStatus(`Error: ${err.message}`)
    }
  }

  async function handleUnderstand() {
    setStatus('Understanding…')
    setImagePath('')
    setText('')
    try {
      const result = await window.native.understandScreen()
      setText(result.text)
      setStatus('Done')
    } catch (err) {
      setStatus(`Error: ${err.message}`)
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/60 text-neutral-100 backdrop-blur-2xl">
      <header
        style={drag}
        className="flex select-none items-center justify-between border-b border-white/10 px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
          <span className="text-sm font-medium tracking-tight">Native</span>
        </div>
        <span className="text-xs text-neutral-400">drag me</span>
      </header>

      <main className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <div style={noDrag} className="flex gap-2">
          <button
            onClick={handleCapture}
            className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium transition hover:bg-white/20 active:bg-white/5"
          >
            Capture Screen
          </button>
          <button
            onClick={handleUnderstand}
            className="rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-sm font-medium transition hover:bg-white/20 active:bg-white/5"
          >
            Understand Screen
          </button>
        </div>

        <p className="text-xs text-neutral-400">{status}</p>

        {imagePath && (
          <p className="break-all text-xs text-neutral-300">{imagePath}</p>
        )}

        {text && (
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-200">
            {text}
          </pre>
        )}
      </main>
    </div>
  )
}
