import { useState } from 'react'

const drag = { WebkitAppRegion: 'drag' }
const noDrag = { WebkitAppRegion: 'no-drag' }

export default function App() {
  const [status, setStatus] = useState('Idle')
  const [imagePath, setImagePath] = useState('')
  const [answer, setAnswer] = useState('')
  const [question, setQuestion] = useState('')

  async function handleCapture() {
    setStatus('Capturing…')
    setImagePath('')
    setAnswer('')
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
    setAnswer('')
    const off = window.native.onAnswerChunk((chunk) => {
      setAnswer((prev) => prev + chunk)
    })
    try {
      const result = await window.native.understandScreen(question)
      if (result.changed) {
        setAnswer(result.answer)
        setStatus('Done')
      } else {
        setStatus('No change')
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`)
    } finally {
      off()
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

        <input
          style={noDrag}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleUnderstand() }}
          placeholder="Ask something..."
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-white/20"
        />

        <p className="text-xs text-neutral-400">{status}</p>

        {imagePath && (
          <p className="break-all text-xs text-neutral-300">{imagePath}</p>
        )}

        {answer && (
          <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-200">
            {answer}
          </pre>
        )}
      </main>
    </div>
  )
}
