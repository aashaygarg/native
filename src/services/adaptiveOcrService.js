// Adaptive OCR (Phase 4D — production):
//   window context -> classify -> select engine -> extract text
//
// Native's OCR is no longer a single engine. We classify the intent window and
// route to the engine that wins on accuracy/latency for that content:
//   CODE  (editors, IDEs, terminals) -> RapidOCR
//   everything else                  -> Apple Vision OCR
//
// This choice comes from the Phase 4 OCR benchmark: on code/symbol-heavy
// content RapidOCR is far more faithful than Vision (96% vs 86%, robust on
// symbols/regex/tables) while still sub-0.3s; on prose/PDF/browser Vision is
// already ~100% and the fastest, so it stays the default.
//
// Deliberately simple: no managers, no registries, no plugin architecture, no
// machine learning. No qwen3-coder, no qwen3-vl. RapidOCR runs as one
// long-lived Python worker (model loaded once, served over stdio) — the same
// long-lived-helper pattern the click monitor already uses. If RapidOCR is
// unavailable it falls back to Vision so there is never a regression.

const { execFileSync, spawn } = require('child_process')
const readline = require('readline')
const os = require('os')
const path = require('path')
const fs = require('fs')

// --- Apple Vision OCR (baseline engine) ------------------------------------
// Same tiny Swift helper and binary the perception loop used before; reused
// here so Vision and RapidOCR live behind one entry point.
const VISION_SRC = '/tmp/native-visionocr.swift'
const VISION_BIN = '/tmp/native-visionocr'
const VISION_SWIFT = `
import Foundation
import Vision
import AppKit
let a = CommandLine.arguments
guard a.count > 1, let img = NSImage(contentsOfFile: a[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .fast
req.usesLanguageCorrection = false
let h = VNImageRequestHandler(cgImage: cg, options: [:])
try? h.perform([req])
var out = ""
for r in (req.results ?? []) { if let t = r.topCandidates(1).first { out += t.string + "\\n" } }
print(out)
`

let visionReady = false
function ensureVision() {
  if (visionReady) return
  if (!fs.existsSync(VISION_BIN)) {
    fs.writeFileSync(VISION_SRC, VISION_SWIFT)
    execFileSync('swiftc', [VISION_SRC, '-o', VISION_BIN])
  }
  visionReady = true
}

// OCR runs on the full-resolution capture on purpose: downscaling makes UI
// text too small for Vision to read.
function visionOcr(imagePath) {
  ensureVision()
  return execFileSync(VISION_BIN, [imagePath], { maxBuffer: 1 << 24 }).toString()
}

// --- RapidOCR (CODE engine) ------------------------------------------------
// A persistent worker keeps the model in memory so each OCR is ~0.3s instead
// of paying the cold model-load cost every call.
const OCR_DIR = path.join(os.homedir(), '.native')
const VENV_DIR = path.join(OCR_DIR, 'ocr-venv')
const VENV_PY = path.join(VENV_DIR, 'bin', 'python')
const RUNNER_PY = path.join(OCR_DIR, 'rapidocr_worker.py')

// Reads image paths on stdin, prints one JSON line per result. Library log
// output is redirected away from stdout so it never corrupts the protocol.
const RAPID_WORKER_SRC = `
import sys, os, json
_real = os.dup(1)
os.dup2(2, 1)
out = os.fdopen(_real, 'w')
try:
    from rapidocr_onnxruntime import RapidOCR
    engine = RapidOCR()
except Exception as e:
    out.write("FAILED\\n"); out.flush(); sys.exit(1)
out.write("READY\\n"); out.flush()
for line in sys.stdin:
    p = line.strip()
    if not p:
        continue
    try:
        res, _ = engine(p)
        text = "\\n".join(l[1] for l in res) if res else ""
        out.write(json.dumps({"text": text}) + "\\n")
    except Exception as e:
        out.write(json.dumps({"error": str(e)}) + "\\n")
    out.flush()
`

let rapidProc = null
let rapidReadyPromise = null
let installing = false
const pending = [] // FIFO of resolvers waiting for a worker response line

function hasUv() {
  try { execFileSync('which', ['uv'], { stdio: 'ignore' }); return true } catch (e) { return false }
}

// One-time, non-blocking venv setup. Until it finishes, code windows fall back
// to Vision. Resets the ready promise on completion so the worker starts on a
// later call.
function installRapidVenv(done) {
  const steps = hasUv()
    ? [['uv', ['venv', VENV_DIR, '--python', '3.12']],
       ['uv', ['pip', 'install', '--python', VENV_PY, 'rapidocr-onnxruntime']]]
    : [['python3.12', ['-m', 'venv', VENV_DIR]],
       [VENV_PY, ['-m', 'pip', 'install', 'rapidocr-onnxruntime']]]
  let i = 0
  const next = () => {
    if (i >= steps.length) { done(); return }
    const [cmd, args] = steps[i++]
    let c
    try { c = spawn(cmd, args, { stdio: 'ignore' }) } catch (e) { done(); return }
    c.on('error', () => done())
    c.on('exit', (code) => { code === 0 ? next() : done() })
  }
  next()
}

function spawnRapidWorker() {
  return new Promise((resolve) => {
    let settled = false
    let proc
    try {
      proc = spawn(VENV_PY, [RUNNER_PY], { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      resolve(false); return
    }
    rapidProc = proc
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!settled && line === 'READY') { settled = true; resolve(true); return }
      if (!settled && line === 'FAILED') { return } // wait for exit -> fail()
      const r = pending.shift()
      if (r) { try { r(JSON.parse(line)) } catch (e) { r({ error: 'parse' }) } }
    })
    const fail = () => {
      rapidProc = null
      rapidReadyPromise = null
      while (pending.length) pending.shift()({ error: 'worker gone' })
      if (!settled) { settled = true; resolve(false) }
    }
    proc.on('exit', fail)
    proc.on('error', fail)
    process.on('exit', () => { try { proc.kill() } catch (e) {} })
  })
}

function ensureRapidWorker() {
  if (rapidReadyPromise) return rapidReadyPromise
  try {
    fs.mkdirSync(OCR_DIR, { recursive: true })
    fs.writeFileSync(RUNNER_PY, RAPID_WORKER_SRC)
  } catch (e) {
    rapidReadyPromise = Promise.resolve(false)
    return rapidReadyPromise
  }
  if (!fs.existsSync(VENV_PY)) {
    if (!installing) {
      installing = true
      installRapidVenv(() => { installing = false; rapidReadyPromise = null })
    }
    rapidReadyPromise = Promise.resolve(false)
    return rapidReadyPromise
  }
  rapidReadyPromise = spawnRapidWorker()
  return rapidReadyPromise
}

// Returns recognized text, or null if RapidOCR is unavailable (caller falls
// back to Vision).
function rapidOcr(imagePath) {
  return ensureRapidWorker().then((ok) => {
    if (!ok || !rapidProc) return null
    return new Promise((resolve) => {
      pending.push(resolve)
      try { rapidProc.stdin.write(imagePath + '\n') } catch (e) { /* exit handler clears pending */ }
    }).then((r) => (r && !r.error && typeof r.text === 'string') ? r.text : null)
  })
}

// --- Window classification -------------------------------------------------
// Match on bundle id (substring) or exact app name. Title is intentionally not
// used: it produces false positives, and only CODE diverges from Vision, so a
// browser/pdf/video mislabel never changes the chosen engine.
const CODE_BUNDLES = ['com.microsoft.vscode', 'com.vscodium', 'com.todesktop',
  'com.exafunction', 'com.jetbrains', 'com.apple.terminal', 'dev.warp',
  'com.googlecode.iterm2', 'com.apple.dt.xcode']
const CODE_APPS = ['code', 'vscodium', 'cursor', 'windsurf', 'intellij idea',
  'idea', 'pycharm', 'webstorm', 'goland', 'clion', 'rider', 'phpstorm',
  'rubymine', 'xcode', 'terminal', 'warp', 'iterm', 'iterm2']

const BROWSER_BUNDLES = ['com.google.chrome', 'com.brave.browser',
  'com.apple.safari', 'org.mozilla.firefox', 'com.microsoft.edgemac']
const BROWSER_APPS = ['google chrome', 'chrome', 'brave browser', 'brave',
  'safari', 'firefox', 'microsoft edge']

const PDF_BUNDLES = ['com.apple.preview', 'com.readdle.pdfexpert']
const PDF_APPS = ['preview', 'pdf expert']

const VIDEO_BUNDLES = ['us.zoom.xos', 'com.microsoft.teams', 'com.microsoft.teams2']
const VIDEO_APPS = ['zoom.us', 'zoom', 'microsoft teams', 'teams', 'google meet', 'meet']

function classify(context) {
  if (!context) return 'unknown'
  const app = String(context.appName || '').toLowerCase().trim()
  const bundle = String(context.bundleId || '').toLowerCase().trim()
  const bundleHit = (keys) => bundle !== '' && keys.some(k => bundle.includes(k))
  const appHit = (keys) => app !== '' && keys.some(k => app === k)
  if (bundleHit(CODE_BUNDLES) || appHit(CODE_APPS)) return 'code'
  if (bundleHit(BROWSER_BUNDLES) || appHit(BROWSER_APPS)) return 'browser'
  if (bundleHit(PDF_BUNDLES) || appHit(PDF_APPS)) return 'pdf'
  if (bundleHit(VIDEO_BUNDLES) || appHit(VIDEO_APPS)) return 'video'
  return 'unknown'
}

// --- Entry point -----------------------------------------------------------
// image: path to the (already cropped) PNG to read.
// context: { appName, bundleId, windowTitle } of the intent window, or null.
async function extractText(image, context) {
  const windowType = classify(context)
  if (windowType === 'code') {
    const text = await rapidOcr(image)
    if (text != null) return { text: text.trim(), engine: 'rapidocr', windowType }
    // RapidOCR not ready / failed: fall back to Vision so there is no regression.
    return { text: visionOcr(image).trim(), engine: 'vision', windowType }
  }
  return { text: visionOcr(image).trim(), engine: 'vision', windowType }
}

module.exports = { extractText, classify }
