import { useState, useRef, useEffect } from 'react'

const drag = { WebkitAppRegion: 'drag' }
const noDrag = { WebkitAppRegion: 'no-drag' }

// Prompt-chip shortcuts. Clicking one appends its text to the question.
const CHIPS = {
  Coding: ['Java', 'Hints', 'Optimize', 'Complexity', 'Bug', 'Dry Run'],
  HLD: ['Requirements', 'APIs', 'DB Schema', 'Scale', 'Tradeoffs', 'Bottlenecks'],
  LLD: ['Classes', 'Patterns', 'Interfaces', 'Sequence', 'Thread Safety'],
  Behavioral: ['STAR', 'Shorter', 'Detailed'],
}

const HOTKEYS = [
  ['⌥⌘U', 'Understand screen'],
  ['⌥⌘F', 'Focus input'],
  ['⌥⌘X', 'Stop generation'],
  ['⌥⌘H', 'Hide / show overlay'],
  ['⌥⌘P', 'Pin current window'],
  ['⌥⌘J', 'Scroll answer down'],
  ['⌥⌘K', 'Scroll answer up'],
  ['⌥⌘M', 'Collapse / expand'],
  ['⌥⌘I', 'Interview mode'],
  ['⌥⌘R', 'Clear answer'],
  ['⌥⌘Y', 'Copy code'],
]

const TABS = ['Actions', 'Prompt Chips', 'History', 'Settings']
const FONTS = { Small: 'text-xs', Normal: 'text-sm', Large: 'text-base' }

const STATUS = {
  idle: '',
  ocr: '👁 OCR',
  thinking: '🧠 Thinking',
  streaming: '✍️ Streaming',
  done: '✓ Done',
  nochange: 'No change',
  error: '⚠ Error',
}

function prettyLabel(ctx) {
  if (!ctx || !ctx.appName) return 'Desktop'
  if (/zoom/i.test(ctx.appName)) return 'Zoom Interview'
  return ctx.appName
}

function extractCode(text) {
  const re = /```[a-zA-Z]*\n?([\s\S]*?)```/g
  const blocks = []
  let m
  while ((m = re.exec(text))) blocks.push(m[1].replace(/\n$/, ''))
  return blocks.join('\n\n')
}

export default function App() {
  const [status, setStatus] = useState('idle')
  const [answer, setAnswer] = useState('')
  const [question, setQuestion] = useState('')
  const [ctx, setCtx] = useState(null)
  const [ctxTime, setCtxTime] = useState('')
  const [pinned, setPinned] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [interview, setInterview] = useState(false)
  const [history, setHistory] = useState([])
  const [elapsed, setElapsed] = useState(0)
  const [tab, setTab] = useState(null) // only one open at a time; null = none
  const [font, setFont] = useState('Normal')

  const inputRef = useRef(null)
  const answerRef = useRef(null)
  const dispatchRef = useRef(() => {})
  const busy = status === 'ocr' || status === 'thinking' || status === 'streaming'
  const contextLabel = prettyLabel(ctx)

  async function handleUnderstand() {
    if (busy) return
    setStatus('ocr')
    setAnswer('')
    const offChunk = window.native.onAnswerChunk((chunk) => {
      setStatus('streaming')
      setAnswer((prev) => prev + chunk)
    })
    const offPhase = window.native.onPhase((p) => setStatus(p))
    try {
      const q = question
      const result = await window.native.understandScreen(q)
      if (result.changed) {
        setAnswer(result.answer)
        setStatus('done')
        setHistory((h) => [{ q, a: result.answer, ts: Date.now() }, ...h].slice(0, 10))
      } else {
        setStatus('nochange')
      }
    } catch (err) {
      setStatus('error')
    } finally {
      offChunk()
      offPhase()
    }
  }

  function handleStop() {
    window.native.stopGeneration()
    setStatus('done')
  }

  async function handlePin() {
    try {
      const r = await window.native.pinWindow()
      setPinned(!!r.pinned)
    } catch (err) {
      /* ignore */
    }
  }

  function toggleCollapse(next) {
    const v = typeof next === 'boolean' ? next : !collapsed
    setCollapsed(v)
    window.native.setCollapsed(v)
  }

  function toggleInterview() {
    const on = !interview
    setInterview(on)
    window.native.setInterview(on)
    if (on) {
      setTab(null)
      if (!pinned) handlePin()
      setTimeout(() => inputRef.current && inputRef.current.focus(), 0)
    }
  }

  function appendChip(t) {
    setQuestion((q) => (q.trim() ? q.trim() + ' ' : '') + t)
    inputRef.current && inputRef.current.focus()
  }

  function copy(text) {
    if (text) navigator.clipboard.writeText(text)
  }

  function restore(item) {
    setQuestion(item.q)
    setAnswer(item.a)
    setStatus('done')
    setTab(null)
  }

  function scroll(dy) {
    answerRef.current && answerRef.current.scrollBy({ top: dy })
  }

  // Toggle a tab: opening one closes the others; clicking the open one closes it.
  function toggleTab(t) {
    setTab((cur) => (cur === t ? null : t))
  }

  // Latest hotkey dispatch (listener registered once, always current state).
  dispatchRef.current = (action) => {
    switch (action) {
      case 'understand': handleUnderstand(); break
      case 'focus-input': inputRef.current && inputRef.current.focus(); break
      case 'stop': handleStop(); break
      case 'pin': handlePin(); break
      case 'scroll-down': scroll(140); break
      case 'scroll-up': scroll(-140); break
      case 'collapse': toggleCollapse(); break
      case 'interview': toggleInterview(); break
      case 'clear': setAnswer(''); break
      case 'copy-code': copy(extractCode(answer)); break
      default: break
    }
  }

  useEffect(() => {
    return window.native.onHotkey((a) => dispatchRef.current(a))
  }, [])

  // Poll the current intent-window context (the last touched window) for the
  // 📌 label and the debug panel.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const c = await window.native.currentContext()
        if (!alive) return
        setCtx(c)
        setPinned(!!(c && c.pinned))
        setCtxTime(new Date().toTimeString().slice(0, 8))
      } catch (err) {
        /* ignore */
      }
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Interview stopwatch.
  useEffect(() => {
    if (!interview) { setElapsed(0); return }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [interview])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  const btn = 'rounded-lg border border-white/10 bg-white/10 px-2.5 py-1.5 text-xs font-medium transition hover:bg-white/20 active:bg-white/5'
  const chip = 'rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-neutral-200 transition hover:bg-white/15'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/60 text-neutral-100 backdrop-blur-2xl">
      {/* 1. Current context (pin) */}
      <header style={drag} className="flex select-none items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${busy ? 'bg-amber-400/80' : 'bg-emerald-400/80'}`} />
          <span className="text-sm font-medium tracking-tight">Native</span>
          <button
            style={noDrag}
            onClick={handlePin}
            title="Pin current window"
            className={`text-xs ${pinned ? 'text-emerald-300' : 'text-neutral-300'} hover:text-neutral-100`}
          >
            📌 {contextLabel}{pinned ? ' • pinned' : ''}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {interview && <span className="text-xs tabular-nums text-neutral-300">{mm}:{ss}</span>}
          <span className="text-xs text-neutral-400">{STATUS[status]}</span>
        </div>
      </header>

      {/* Collapse only changes window size; nothing below ever disappears. */}
      <main className="flex flex-1 flex-col gap-2 overflow-hidden px-3 py-2">
        {/* 2. Input box */}
        <input
          ref={inputRef}
          style={noDrag}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleUnderstand() }}
          placeholder="Ask something..."
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-white/20"
        />

        {/* 3. Four horizontal tabs (one open at a time) */}
        <div style={noDrag} className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => toggleTab(t)}
              className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                tab === t
                  ? 'border-white/20 bg-white/15 text-neutral-100'
                  : 'border-white/10 bg-white/5 text-neutral-400 hover:bg-white/10'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'Actions' && (
          <div style={noDrag} className="flex flex-wrap gap-1.5">
            <button onClick={handleUnderstand} className={btn}>Understand</button>
            <button onClick={handleStop} className={btn}>Stop</button>
            <button onClick={handlePin} className={btn}>{pinned ? 'Unpin' : 'Pin'}</button>
            <button onClick={toggleInterview} className={btn}>{interview ? 'Exit Interview' : 'Interview Mode'}</button>
            <button onClick={() => toggleCollapse()} className={btn}>{collapsed ? 'Expand' : 'Collapse'}</button>
            <button onClick={() => scroll(-140)} className={btn}>Scroll Up</button>
            <button onClick={() => scroll(140)} className={btn}>Scroll Down</button>
            <button onClick={() => copy(extractCode(answer))} className={btn}>Copy Code</button>
            <button onClick={() => setAnswer('')} className={btn}>Clear Answer</button>
          </div>
        )}

        {tab === 'Prompt Chips' && (
          <div style={noDrag} className="flex flex-col gap-1">
            {Object.entries(CHIPS).map(([group, items]) => (
              <div key={group} className="flex flex-wrap items-center gap-1">
                <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-neutral-500">{group}</span>
                {items.map((c) => (
                  <button key={c} onClick={() => appendChip(c)} className={chip}>{c}</button>
                ))}
              </div>
            ))}
          </div>
        )}

        {tab === 'History' && (
          <div style={noDrag} className="flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">Last {history.length} answers</div>
            <div className="flex flex-wrap gap-1">
              {history.length === 0 && <span className="text-xs text-neutral-500">None yet</span>}
              {history.map((h) => (
                <button key={h.ts} onClick={() => restore(h)} className={chip} title={h.q || 'answer'}>
                  {(h.q || 'answer').slice(0, 20)}
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'Settings' && (
          <div style={noDrag} className="flex flex-col gap-2">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Debug · Current Context</div>
              <div className="space-y-0.5 rounded-md bg-black/20 px-2 py-1 text-[11px] text-neutral-300">
                <div>App: <span className="text-neutral-100">{ctx?.appName || '—'}</span></div>
                <div>Window: <span className="text-neutral-100">{ctx?.windowTitle || '—'}</span></div>
                <div>Monitor: <span className="text-neutral-100">{ctx?.monitor ? `Monitor ${ctx.monitor}` : '—'}</span></div>
                <div>Time: <span className="text-neutral-100">{ctxTime || '—'}</span></div>
                <div>Pinned: <span className="text-neutral-100">{ctx?.pinned ? 'Yes' : 'No'}</span></div>
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Hotkeys</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {HOTKEYS.map(([k, d]) => (
                  <div key={k} className="flex items-center justify-between text-[11px]">
                    <span className="text-neutral-400">{d}</span>
                    <span className="tabular-nums text-neutral-200">{k}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Preferences</div>
              <div className="flex items-center gap-2 text-[11px] text-neutral-300">
                <span>Answer text size</span>
                {Object.keys(FONTS).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFont(f)}
                    className={`rounded px-2 py-0.5 ${font === f ? 'bg-white/20 text-neutral-100' : 'bg-white/5 text-neutral-400 hover:bg-white/10'}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 4. Answer area — consumes the rest of the overlay */}
        <div ref={answerRef} style={noDrag} className="flex-1 overflow-auto rounded-lg bg-black/10 px-2 py-1">
          {answer
            ? <pre className={`whitespace-pre-wrap break-words leading-relaxed text-neutral-200 ${FONTS[font]}`}>{answer}</pre>
            : <p className="text-xs text-neutral-500">Answer will appear here.</p>}
        </div>
      </main>
    </div>
  )
}
