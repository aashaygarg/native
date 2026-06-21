// OCR engine benchmark (throwaway experiment — NOT production).
//
// Question: is there a better OCR engine for Native's workload than Apple
// Vision? Native's real inputs are code, LeetCode, Zoom shares, PDFs and
// browser tabs — not receipts or handwriting. We optimise for the
// ACCURACY / LATENCY ratio, not for maximum accuracy at any cost.
//
// Engines benchmarked:
//   1. Apple Vision OCR  (baseline, /tmp/native-visionocr, Swift + Vision)
//   2. RapidOCR          (onnxruntime, CPU)
//   3. PaddleOCR 3.x     (paddlepaddle, CPU)
//   4. Surya OCR 0.20    (llama.cpp VLM — measured ~210s/img, latency-disqualified)
//
// Run:  node_modules/.bin/electron src/services/ocrExperiment.js
//
// We render synthetic, ground-truth images (we know the exact text) covering
// Native's workload, OCR them with every engine, and score char/line/code
// fidelity against the ground truth. Real screenshots have no ground truth, so
// synthetic images are the only way to get an objective accuracy number.
//
// This file creates no production dependencies and is safe to delete.

const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const WORK = '/tmp/ocrbench'
const VENV_PY = '/tmp/ocrbench-venv/bin/python'
const VISION_BIN = '/tmp/native-visionocr'
const RUNNER_PY = path.join(WORK, 'runner.py')
const MANIFEST = path.join(WORK, 'manifest.json')
const PY_RESULTS = path.join(WORK, 'py_results.json')
const OLLAMA = 'http://localhost:11434/api/generate'
const CODER_MODEL = 'qwen3-coder:30b'

// Surya is ~3.5 min/image on this hardware, so we only run it on this many
// images (enough for one real data point) instead of the full set.
const SURYA_SAMPLE = 1

// ---------------------------------------------------------------------------
// Test cases: { id, kind, theme, font, size, truth }
// kind drives scoring (code cases also get an indentation/symbol-sensitive
// score). truth is the exact text we render and score against.
// ---------------------------------------------------------------------------
const CASES = [
  {
    id: 'code_light', kind: 'code', theme: 'light', font: 'mono', size: 18,
    label: 'VS Code — JS function (light)',
    truth:
`function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) return [seen.get(need), i];
    seen.set(nums[i], i);
  }
  return [];
}`
  },
  {
    id: 'code_dark', kind: 'code', theme: 'dark', font: 'mono', size: 18,
    label: 'VS Code — Python function (dark)',
    truth:
`def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    out = []
    for s, e in intervals:
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out`
  },
  {
    id: 'code_symbols', kind: 'code', theme: 'dark', font: 'mono', size: 18,
    label: 'Code snippet — dense symbols',
    truth:
`const re = /^[a-z0-9_]+@[a-z]+\\.[a-z]{2,}$/i;
arr = items.filter(x => x?.ok && x.n >= 0).map(({ id, n }) => [id, n * 2]);
obj = { a: 1, b: [2, 3], c: { d: 4 } };`
  },
  {
    id: 'leetcode', kind: 'text', theme: 'light', font: 'sans', size: 20,
    label: 'LeetCode — problem + constraints',
    truth:
`Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.

You may assume that each input would have exactly one solution, and you may not use the same element twice.

Constraints:
2 <= nums.length <= 10^4
-10^9 <= nums[i] <= 10^9`
  },
  {
    id: 'article', kind: 'text', theme: 'light', font: 'sans', size: 20,
    label: 'Browser article — prose',
    truth:
`The transformer architecture replaced recurrence with self-attention, letting models weigh every token against every other token in parallel. This made training far more efficient on modern hardware and unlocked the large language models that followed.`
  },
  {
    id: 'pdf_small', kind: 'text', theme: 'light', font: 'serif', size: 13,
    label: 'PDF — small serif body',
    truth:
`Abstract. We present a method for fast on-device perception that captures the focused window, diffs successive frames, and runs optical character recognition only when the visible text changes. This keeps latency low while avoiding redundant inference on static screens.`
  },
  {
    id: 'dark_small', kind: 'text', theme: 'dark', font: 'sans', size: 13,
    label: 'Small font — dark theme',
    truth:
`Settings saved. The assistant will now summarise the active window every two seconds. Toggle continuous capture with Cmd+Shift+C. Logs are written to ~/Library/Logs/native.log for debugging.`
  },
  {
    id: 'table', kind: 'table', theme: 'light', font: 'mono', size: 16,
    label: 'Zoom share — data table',
    truth:
`Engine    Backend   Speed   Acc
Vision    Swift     0.4s    0.93
RapidOCR  ONNX      0.8s    0.91
Paddle    Paddle    1.5s    0.95
Surya     LlamaCpp  210s    0.97`
  },
  {
    id: 'terminal', kind: 'code', theme: 'dark', font: 'mono', size: 16,
    label: 'Terminal — build output',
    truth:
`$ npm run build
> vite build
342 modules transformed.
dist/index.html   1.2 kB
built in 3.41s
$ git status
On branch main
nothing to commit, working tree clean`
  }
]

// ---------------------------------------------------------------------------
// Image rendering via a hidden BrowserWindow. We render at 2x (retina backing
// scale) so Vision gets a full-resolution image — it returns nothing on
// downscaled input.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pageHtml(c) {
  const bg = c.theme === 'dark' ? '#1e1e1e' : '#ffffff'
  const fg = c.theme === 'dark' ? '#d4d4d4' : '#1a1a1a'
  const fam = c.font === 'mono'
    ? 'ui-monospace, Menlo, monospace'
    : c.font === 'serif'
      ? 'Georgia, "Times New Roman", serif'
      : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const whiteSpace = (c.kind === 'code' || c.kind === 'table') ? 'pre' : 'pre-wrap'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${bg};}
    #wrap{display:inline-block;padding:24px 28px;background:${bg};}
    #t{color:${fg};font-family:${fam};font-size:${c.size}px;line-height:1.5;
       white-space:${whiteSpace};max-width:760px;}
  </style></head><body><div id="wrap"><div id="t">${escapeHtml(c.truth)}</div></div></body></html>`
}

async function renderCase(c) {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { offscreen: false, deviceScaleFactor: 2 }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(c)))
  // Size the window to the rendered content so the capture is tight.
  const size = await win.webContents.executeJavaScript(
    'var w=document.getElementById("wrap");[w.offsetWidth, w.offsetHeight]'
  )
  win.setContentSize(Math.ceil(size[0]), Math.ceil(size[1]))
  await new Promise(r => setTimeout(r, 120))
  const image = await win.webContents.capturePage()
  const out = path.join(WORK, c.id + '.png')
  fs.writeFileSync(out, image.toPNG())
  win.destroy()
  return out
}

// ---------------------------------------------------------------------------
// Apple Vision (baseline) — reuse the production-compiled helper.
// ---------------------------------------------------------------------------
function visionOCR(png) {
  const t0 = Date.now()
  let text = ''
  try {
    text = execFileSync(VISION_BIN, [png], { encoding: 'utf8', maxBuffer: 1 << 24 })
  } catch (e) {
    text = ''
  }
  return { text: text.trim(), ms: Date.now() - t0 }
}

// ---------------------------------------------------------------------------
// Python engines (RapidOCR, PaddleOCR, Surya) via a generated runner that
// loads each model ONCE and reports warm per-image inference time separately
// from cold model-load time.
// ---------------------------------------------------------------------------
const RUNNER_SRC = `
import sys, json, time, re

manifest = json.load(open(sys.argv[1]))
images = manifest["images"]            # [{"id":..,"path":..}]
surya_ids = set(manifest.get("surya_ids", []))
results = {"rapidocr": {}, "paddleocr": {}, "surya": {}}

def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s or "")

# ---- RapidOCR -------------------------------------------------------------
try:
    from rapidocr_onnxruntime import RapidOCR
    t0 = time.time(); eng = RapidOCR(); load = time.time() - t0
    imgs = {}
    for it in images:
        t = time.time()
        res, _ = eng(it["path"])
        dt = time.time() - t
        text = "\\n".join(line[1] for line in res) if res else ""
        imgs[it["id"]] = {"ms": int(dt * 1000), "text": text}
    results["rapidocr"] = {"load_ms": int(load * 1000), "images": imgs}
except Exception as e:
    results["rapidocr"] = {"error": repr(e)}

# ---- PaddleOCR 3.x --------------------------------------------------------
try:
    from paddleocr import PaddleOCR
    t0 = time.time()
    try:
        eng = PaddleOCR(use_doc_orientation_classify=False,
                        use_doc_unwarping=False,
                        use_textline_orientation=False, lang="en")
    except Exception:
        eng = PaddleOCR(lang="en")
    load = time.time() - t0
    imgs = {}
    for it in images:
        t = time.time()
        try:
            res = eng.predict(it["path"])
        except Exception:
            res = eng.ocr(it["path"])
        dt = time.time() - t
        lines = []
        for r in (res or []):
            rt = None
            try:
                rt = r["rec_texts"]
            except Exception:
                if isinstance(r, list):
                    for ln in r:
                        try: lines.append(ln[1][0])
                        except Exception: pass
            if rt:
                lines.extend(list(rt))
        imgs[it["id"]] = {"ms": int(dt * 1000), "text": "\\n".join(lines)}
    results["paddleocr"] = {"load_ms": int(load * 1000), "images": imgs}
except Exception as e:
    results["paddleocr"] = {"error": repr(e)}

# ---- Surya 0.20 (llama.cpp VLM) -------------------------------------------
try:
    from PIL import Image
    from surya.recognition import RecognitionPredictor
    t0 = time.time(); rec = RecognitionPredictor(); load = time.time() - t0
    imgs = {}
    for it in images:
        if it["id"] not in surya_ids:
            continue
        img = Image.open(it["path"]).convert("RGB")
        t = time.time()
        page = rec([img], full_page=True)[0]
        dt = time.time() - t
        parts = []
        for b in page.blocks:
            parts.append(strip_tags(getattr(b, "html", "") or ""))
        imgs[it["id"]] = {"ms": int(dt * 1000), "text": "\\n".join(p for p in parts if p)}
    results["surya"] = {"load_ms": int(load * 1000), "images": imgs}
except Exception as e:
    results["surya"] = {"error": repr(e)}

json.dump(results, open(sys.argv[2], "w"))
print("PYDONE")
`

function runPythonEngines(manifest) {
  return new Promise((resolve) => {
    fs.writeFileSync(RUNNER_PY, RUNNER_SRC)
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest))
    const env = Object.assign({}, process.env, {
      PATH: '/opt/homebrew/bin:' + (process.env.PATH || ''),
      OMP_NUM_THREADS: '4'
    })
    const child = spawn(VENV_PY, [RUNNER_PY, MANIFEST, PY_RESULTS], { env })
    let err = ''
    child.stderr.on('data', d => { err += d.toString() })
    child.stdout.on('data', d => process.stdout.write('[py] ' + d.toString()))
    child.on('close', () => {
      try {
        resolve(JSON.parse(fs.readFileSync(PY_RESULTS, 'utf8')))
      } catch (e) {
        console.log('[py] no results:', e.message, '\n', err.slice(-500))
        resolve({ rapidocr: { error: 'no output' }, paddleocr: { error: 'no output' }, surya: { error: 'no output' } })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// qwen3-coder OCR repair (acceptance question 3).
// ---------------------------------------------------------------------------
async function qwenRepair(noisy) {
  const prompt =
`You are correcting OCR errors in text captured from a computer screen. Output ONLY the corrected text with nothing added or removed. Preserve line breaks, indentation and code formatting exactly. Do not explain.

Text:
${noisy}`
  const t0 = Date.now()
  let out = ''
  try {
    const res = await fetch(OLLAMA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CODER_MODEL, prompt, stream: false, options: { temperature: 0 } })
    })
    const j = await res.json()
    out = (j.response || '').trim()
    // strip a wrapping code fence if the model added one
    out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  } catch (e) {
    out = noisy
  }
  return { text: out, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    const t = prev; prev = cur; cur = t
  }
  return prev[n]
}

function ratio(a, b) {
  const max = Math.max(a.length, b.length)
  if (!max) return 1
  return 1 - levenshtein(a, b) / max
}

const collapse = s => s.replace(/\s+/g, ' ').trim()
const trimRight = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{2,}/g, '\n').trim()

// char accuracy: whitespace-insensitive (reading correctness)
function charAcc(truth, ocr) { return ratio(collapse(truth), collapse(ocr)) }
// code accuracy: whitespace-sensitive (indentation + symbols matter)
function codeAcc(truth, ocr) { return ratio(trimRight(truth), trimRight(ocr)) }
// line preservation: fraction of ground-truth lines fuzzily present in output
function lineAcc(truth, ocr) {
  const gt = truth.split('\n').map(collapse).filter(Boolean)
  const got = ocr.split('\n').map(collapse).filter(Boolean)
  if (!gt.length) return 1
  let hit = 0
  for (const g of gt) {
    if (got.some(o => ratio(g, o) >= 0.8)) hit++
  }
  return hit / gt.length
}

function scoreOf(c, text) {
  return {
    chars: text.length,
    acc: charAcc(c.truth, text),
    line: lineAcc(c.truth, text),
    code: c.kind === 'code' || c.kind === 'table' ? codeAcc(c.truth, text) : null
  }
}

// ---------------------------------------------------------------------------
// Output helpers.
// ---------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
const pct = x => (x == null ? '  -  ' : (x * 100).toFixed(1).padStart(5))
const secs = ms => (ms / 1000).toFixed(2).padStart(7)

function sample(text, n = 60) {
  return collapse(text).slice(0, n).replace(/\n/g, ' ')
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(WORK, { recursive: true })
  console.log('\n=== OCR BENCHMARK — Native workload (code, LeetCode, Zoom, PDF, browser) ===\n')

  if (!fs.existsSync(VISION_BIN)) {
    console.log('Vision binary missing at', VISION_BIN, '- run the app once to compile it. Aborting.')
    app.quit(); return
  }

  // 1. Render ground-truth images.
  console.log('Rendering', CASES.length, 'ground-truth images...')
  const images = []
  for (const c of CASES) {
    const png = await renderCase(c)
    images.push({ id: c.id, path: png })
  }

  // 2. Apple Vision (baseline).
  console.log('Running Apple Vision (baseline)...')
  const vision = {}
  for (const c of CASES) {
    const png = images.find(i => i.id === c.id).path
    vision[c.id] = visionOCR(png)
  }

  // 3. Python engines (Surya only on a small sample — it is ~3.5 min/image).
  const surya_ids = CASES.slice(0, SURYA_SAMPLE).map(c => c.id)
  console.log('Running RapidOCR + PaddleOCR (all), Surya (' + surya_ids.join(',') + ' only)...')
  console.log('  (Surya first run downloads a GGUF model and is very slow — please wait)')
  const py = await runPythonEngines({ images, surya_ids })

  for (const name of ['rapidocr', 'paddleocr', 'surya']) {
    if (py[name] && py[name].error) console.log('  ' + name + ' ERROR:', py[name].error)
  }

  // Assemble engine -> caseId -> { text, ms }
  const engines = {
    vision: { name: 'Apple Vision', data: vision, load_ms: 0 },
    rapidocr: { name: 'RapidOCR', data: pyData(py.rapidocr), load_ms: loadMs(py.rapidocr) },
    paddleocr: { name: 'PaddleOCR', data: pyData(py.paddleocr), load_ms: loadMs(py.paddleocr) },
    surya: { name: 'Surya', data: pyData(py.surya), load_ms: loadMs(py.surya) }
  }

  // 4. Per-case results.
  console.log('\n--- PER-CASE RESULTS ---')
  for (const c of CASES) {
    console.log('\n# ' + c.label + '  [' + c.kind + '/' + c.theme + ']')
    console.log(pad('engine', 13) + pad('time', 9) + pad('chars', 7) +
      pad('acc%', 7) + pad('line%', 7) + pad('code%', 7) + 'sample')
    for (const key of ['vision', 'rapidocr', 'paddleocr', 'surya']) {
      const e = engines[key]
      const r = e.data[c.id]
      if (!r) { continue }
      const s = scoreOf(c, r.text)
      console.log(
        pad(e.name, 13) + pad(secs(r.ms) + 's', 9) + pad(s.chars, 7) +
        pad(pct(s.acc), 7) + pad(pct(s.line), 7) + pad(pct(s.code), 7) +
        '"' + sample(r.text) + '"')
    }
  }

  // 5. Aggregate (Accuracy / Latency is the headline metric).
  console.log('\n--- AGGREGATE (Native workload) ---')
  console.log(pad('engine', 13) + pad('imgs', 6) + pad('avgTime', 9) +
    pad('avgAcc%', 9) + pad('avgLine%', 10) + pad('avgCode%', 10) + 'Acc/sec')
  const agg = {}
  for (const key of ['vision', 'rapidocr', 'paddleocr', 'surya']) {
    const e = engines[key]
    let n = 0, tms = 0, acc = 0, line = 0, code = 0, codeN = 0
    for (const c of CASES) {
      const r = e.data[c.id]
      if (!r) continue
      const s = scoreOf(c, r.text)
      n++; tms += r.ms; acc += s.acc; line += s.line
      if (s.code != null) { code += s.code; codeN++ }
    }
    if (!n) { console.log(pad(e.name, 13) + 'no data'); continue }
    const avgT = tms / n / 1000
    const avgAcc = acc / n
    const accPerSec = avgT > 0 ? avgAcc / avgT : 0
    agg[key] = { avgT, avgAcc, accPerSec, n }
    console.log(
      pad(e.name, 13) + pad(n, 6) + pad(avgT.toFixed(2) + 's', 9) +
      pad(pct(avgAcc), 9) + pad(pct(line / n), 10) +
      pad(codeN ? pct(code / codeN) : '  -  ', 10) +
      padL(accPerSec.toFixed(3), 7))
  }

  // 6. Acceptance question 3: can qwen3-coder repair Vision's mistakes?
  console.log('\n--- Q3: qwen3-coder repair of Apple Vision output ---')
  console.log(pad('case', 22) + pad('visAcc%', 9) + pad('fixAcc%', 9) +
    pad('repair', 9) + 'delta')
  let visAccSum = 0, fixAccSum = 0, repairMs = 0, qn = 0
  for (const c of CASES) {
    const raw = vision[c.id].text
    const before = charAcc(c.truth, raw)
    const fix = await qwenRepair(raw)
    const after = charAcc(c.truth, fix.text)
    visAccSum += before; fixAccSum += after; repairMs += fix.ms; qn++
    const delta = (after - before) * 100
    console.log(
      pad(c.id, 22) + pad(pct(before), 9) + pad(pct(after), 9) +
      pad((fix.ms / 1000).toFixed(2) + 's', 9) +
      (delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp')
  }
  const visAvg = visAccSum / qn, fixAvg = fixAccSum / qn, repairAvg = repairMs / qn / 1000

  // 7. Answers.
  console.log('\n=== ACCEPTANCE QUESTIONS ===\n')
  const best = Object.entries(agg)
    .filter(([k]) => k !== 'vision')
    .sort((a, b) => b[1].avgAcc - a[1].avgAcc)[0]
  const vAcc = agg.vision ? agg.vision.avgAcc : 0
  const vT = agg.vision ? agg.vision.avgT : 0

  console.log('1. Is any engine significantly more accurate?')
  if (best) {
    const [bk, bv] = best
    const gap = (bv.avgAcc - vAcc) * 100
    console.log('   Best non-Vision: ' + engines[bk].name +
      ' at ' + (bv.avgAcc * 100).toFixed(1) + '% vs Vision ' +
      (vAcc * 100).toFixed(1) + '% (' + (gap >= 0 ? '+' : '') + gap.toFixed(1) + 'pp).')
    console.log('   ' + (Math.abs(gap) < 2
      ? 'Not significant — within ~2pp of Vision.'
      : (gap > 0 ? 'A real accuracy gain exists.' : 'Vision is more accurate.')))
  }

  console.log('\n2. Is the quality gain worth the latency?')
  for (const key of ['rapidocr', 'paddleocr', 'surya']) {
    if (!agg[key]) continue
    const a = agg[key]
    const slower = vT > 0 ? (a.avgT / vT) : Infinity
    const gap = (a.avgAcc - vAcc) * 100
    console.log('   ' + pad(engines[key].name, 11) +
      ' ' + (gap >= 0 ? '+' : '') + gap.toFixed(1) + 'pp acc, ' +
      a.avgT.toFixed(2) + 's (' + slower.toFixed(1) + 'x Vision), Acc/sec=' +
      a.accPerSec.toFixed(3))
  }
  if (agg.vision) console.log('   ' + pad('Vision', 11) + ' baseline, ' +
    vT.toFixed(2) + 's, Acc/sec=' + agg.vision.accPerSec.toFixed(3))

  console.log('\n3. Can qwen3-coder repair Vision OCR mistakes instead?')
  console.log('   Vision raw avg acc ' + (visAvg * 100).toFixed(1) +
    '% -> after qwen3-coder ' + (fixAvg * 100).toFixed(1) +
    '% (' + ((fixAvg - visAvg) * 100 >= 0 ? '+' : '') +
    ((fixAvg - visAvg) * 100).toFixed(1) + 'pp), +' +
    repairAvg.toFixed(2) + 's/repair.')

  console.log('\n4. Recommendation for production OCR:')
  console.log('   (See aggregate Acc/sec and the deltas above; Surya is')
  console.log('    latency-disqualified at ~' +
    (agg.surya ? agg.surya.avgT.toFixed(0) : '200') + 's/image.)')

  console.log('\n=== DONE ===\n')
  app.quit()
}

function pyData(section) {
  const out = {}
  if (!section || section.error || !section.images) return out
  for (const id of Object.keys(section.images)) {
    out[id] = { text: section.images[id].text || '', ms: section.images[id].ms || 0 }
  }
  return out
}
function loadMs(section) { return (section && section.load_ms) || 0 }

app.whenReady().then(() => {
  main().catch(e => { console.error('experiment failed:', e); app.quit() })
})
app.on('window-all-closed', () => {})
