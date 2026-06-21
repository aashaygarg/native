// Perception loop (Phase 4 — frozen architecture):
//   resolve intent window -> capture window -> crop margins -> image diff ->
//   macOS Vision OCR -> text diff -> result
//
// "Intent window" is the window the user was working on before turning to
// Native. Resolution order: pinned -> last clicked non-Native -> frontmost app
// -> window under cursor -> current monitor -> desktop. Native's own overlay is
// always excluded (window level, bundle id, or title). No qwen3-vl, no
// qwen3-coder. State (previous thumbnail + previous text + last clicked window)
// is kept in module scope.

const { nativeImage, screen } = require('electron')
const { execFileSync, spawn } = require('child_process')
const readline = require('readline')
const fs = require('fs')

const { captureScreen } = require('./captureService')
const adaptiveOcr = require('./adaptiveOcrService')

const SCREENCAPTURE = '/usr/sbin/screencapture'
const WINDOW_PNG = '/tmp/native-window.png'

const WINQUERY_SRC = '/tmp/native-winquery.swift'
const WINQUERY_BIN = '/tmp/native-winquery-v2'
const CLICKMON_SRC = '/tmp/native-clickmon.swift'
const CLICKMON_BIN = '/tmp/native-clickmon-v2'

// Synchronous window query: frontmost app's largest window + the window under
// the cursor, each with the signals needed to recognise (and exclude) Native:
// owner, title, window level (layer), bundle id, window id, size.
const WINQUERY_SWIFT = `
import Foundation
import CoreGraphics
import AppKit

func bundleId(_ pid: Int) -> String {
  return NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
}
func windowsList() -> [[String: Any]] {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  return (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
}
func cursor() -> CGPoint { return CGEvent(source: nil)?.location ?? .zero }
func contains(_ b: [String: Any], _ p: CGPoint) -> Bool {
  let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
  let w = (b["Width"] as? Double) ?? 0, h = (b["Height"] as? Double) ?? 0
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h
}
func info(_ w: [String: Any]?) -> [String: Any] {
  guard let w = w else {
    return ["appName": "", "windowTitle": "", "windowId": -1, "layer": 0, "bundleId": "", "width": 0, "height": 0]
  }
  let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
  let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  return [
    "appName": (w[kCGWindowOwnerName as String] as? String) ?? "",
    "windowTitle": (w[kCGWindowName as String] as? String) ?? "",
    "windowId": (w[kCGWindowNumber as String] as? Int) ?? -1,
    "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
    "bundleId": bundleId(pid),
    "width": (b["Width"] as? Double) ?? 0,
    "height": (b["Height"] as? Double) ?? 0,
    "x": (b["X"] as? Double) ?? 0,
    "y": (b["Y"] as? Double) ?? 0
  ]
}

let list = windowsList()
let fpid = Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
var fchosen: [String: Any]? = nil
var bestArea = 0.0
for w in list {
  let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
  let owner = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
  if layer == 0 && owner == fpid {
    let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
    let area = ((b["Width"] as? Double) ?? 0) * ((b["Height"] as? Double) ?? 0)
    if area > bestArea { bestArea = area; fchosen = w }
  }
}
let p = cursor()
var uchosen: [String: Any]? = nil
for w in list {
  let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  if contains(b, p) { uchosen = w; break }
}
let out: [String: Any] = ["frontmost": info(fchosen), "underCursor": info(uchosen)]
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`

// Continuous global click monitor. Emits one JSON line per click: the topmost
// window under the cursor at click time, with the same signals as winquery.
// Mouse monitoring needs no Accessibility permission.
const CLICKMON_SWIFT = `
import AppKit
import CoreGraphics
import Foundation

setbuf(stdout, nil)
var clickMonitor: Any?

func bundleId(_ pid: Int) -> String {
  return NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
}
func windowsList() -> [[String: Any]] {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  return (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
}
func cursor() -> CGPoint { return CGEvent(source: nil)?.location ?? .zero }
func contains(_ b: [String: Any], _ p: CGPoint) -> Bool {
  let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
  let w = (b["Width"] as? Double) ?? 0, h = (b["Height"] as? Double) ?? 0
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h
}
func info(_ w: [String: Any]?) -> [String: Any] {
  guard let w = w else {
    return ["appName": "", "windowTitle": "", "windowId": -1, "layer": 0, "bundleId": "", "width": 0, "height": 0]
  }
  let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
  let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
  return [
    "appName": (w[kCGWindowOwnerName as String] as? String) ?? "",
    "windowTitle": (w[kCGWindowName as String] as? String) ?? "",
    "windowId": (w[kCGWindowNumber as String] as? Int) ?? -1,
    "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
    "bundleId": bundleId(pid),
    "width": (b["Width"] as? Double) ?? 0,
    "height": (b["Height"] as? Double) ?? 0,
    "x": (b["X"] as? Double) ?? 0,
    "y": (b["Y"] as? Double) ?? 0
  ]
}

let nsapp = NSApplication.shared
nsapp.setActivationPolicy(.accessory)
clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
  let p = cursor()
  var chosen: [String: Any]? = nil
  for w in windowsList() {
    let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
    if layer != 0 { continue }
    let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
    if contains(b, p) { chosen = w; break }
  }
  let j = try! JSONSerialization.data(withJSONObject: info(chosen))
  print(String(data: j, encoding: .utf8)!)
}
nsapp.run()
`

let winQueryReady = false
function ensureWinQuery() {
  if (winQueryReady) return
  if (!fs.existsSync(WINQUERY_BIN)) {
    fs.writeFileSync(WINQUERY_SRC, WINQUERY_SWIFT)
    execFileSync('swiftc', [WINQUERY_SRC, '-o', WINQUERY_BIN])
  }
  winQueryReady = true
}

// Synchronous { frontmost, underCursor } snapshot.
function winQuery() {
  ensureWinQuery()
  try {
    return JSON.parse(execFileSync(WINQUERY_BIN, [], { maxBuffer: 1 << 20 }).toString().trim())
  } catch (e) {
    return null
  }
}

// A window belongs to Native's own overlay if any of these match. Window level
// is the robust signal (the overlay floats above layer 0); bundle id and title
// are backups. Native must never be chosen as the intent window.
const NATIVE_BUNDLES = new Set(['com.github.Electron', 'org.electron.native', 'com.native.app'])
function isNative(w) {
  if (!w || w.windowId < 0) return false
  if (w.layer && w.layer !== 0) return true
  if (NATIVE_BUNDLES.has(w.bundleId)) return true
  if ((w.windowTitle || '') === 'Native') return true
  if ((w.appName || '').toLowerCase() === 'native') return true
  return false
}

// Last clicked non-Native window, tracked by a background click monitor so we
// know what the user was working on before clicking into Native.
let lastClicked = null
let clickChild = null
function startIntentTracking() {
  if (clickChild) return
  const launch = () => {
    clickChild = spawn(CLICKMON_BIN, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    readline.createInterface({ input: clickChild.stdout }).on('line', (line) => {
      let w
      try {
        w = JSON.parse(line)
      } catch (e) {
        return
      }
      if (w.windowId > 0 && !isNative(w)) {
        lastClicked = w
        console.log(
          'CLICK\n  app: ' + w.appName +
          '\n  title: ' + (w.windowTitle || '') +
          '\n  time: ' + new Date().toTimeString().slice(0, 8) +
          '\n  intent updated'
        )
      }
    })
    process.on('exit', () => clickChild && clickChild.kill())
  }
  // Compile off the main path so first launch never blocks on swiftc.
  if (fs.existsSync(CLICKMON_BIN)) {
    launch()
  } else {
    fs.writeFileSync(CLICKMON_SRC, CLICKMON_SWIFT)
    spawn('swiftc', [CLICKMON_SRC, '-o', CLICKMON_BIN]).on('exit', (code) => {
      if (code === 0) launch()
    })
  }
}

// Capture only the given window (no shadow). Ignores other windows/monitors.
function captureWindow(windowId, outPath) {
  execFileSync(SCREENCAPTURE, ['-x', '-o', '-l', String(windowId), outPath])
}

// No pin UI yet (Phase 5+); kept as the top of the hierarchy so a future pin
// can populate it without changing the resolution order.
let pinnedWindowId = null
let pinnedContext = null

// The window signals adaptive OCR classifies on. Pinned windows carry only an
// id (no metadata yet), so they resolve to null context -> unknown -> Vision.
function contextOf(w) {
  if (!w) return null
  return {
    appName: w.appName || '',
    bundleId: w.bundleId || '',
    windowTitle: w.windowTitle || '',
    x: w.x || 0,
    y: w.y || 0,
    width: w.width || 0,
    height: w.height || 0,
  }
}

// Intent-window hierarchy: pinned -> last clicked non-Native -> frontmost app
// -> window under cursor. Returns { windowId, context } — windowId is the
// window to capture (null to fall back to a full-screen capture) and context
// is the chosen window's { appName, bundleId, windowTitle } for OCR selection.
// The resolution order and conditions are unchanged; only the chosen window's
// metadata is surfaced alongside the id.
function resolveIntentWindow() {
  if (pinnedWindowId) return { windowId: pinnedWindowId, context: null }
  if (lastClicked && lastClicked.windowId > 0) {
    return { windowId: lastClicked.windowId, context: contextOf(lastClicked) }
  }

  const q = winQuery()
  if (q) {
    if (q.frontmost && q.frontmost.windowId > 0 && !isNative(q.frontmost)) {
      return { windowId: q.frontmost.windowId, context: contextOf(q.frontmost) }
    }
    if (q.underCursor && q.underCursor.windowId > 0 && !isNative(q.underCursor)) {
      return { windowId: q.underCursor.windowId, context: contextOf(q.underCursor) }
    }
  }
  return { windowId: null, context: null }
}

// Trim a small uniform margin to drop window borders/edges before OCR.
function cropMargins(image) {
  const { width, height } = image.getSize()
  const mx = Math.round(width * 0.01)
  const my = Math.round(height * 0.01)
  if (width - 2 * mx < 50 || height - 2 * my < 50) return image
  return image.crop({ x: mx, y: my, width: width - 2 * mx, height: height - 2 * my })
}

// 128px BGRA thumbnail used only for cheap image-change detection.
function thumbBitmap(image) {
  return image.resize({ width: 128 }).toBitmap()
}

// Fraction of thumbnail pixels whose colour changed noticeably.
function imageDiffFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let changed = 0
  const px = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    const d =
      Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    if (d > 30) changed++
  }
  return changed / px
}

// Cheap character-position difference ratio between two OCR results.
function textDiffFraction(a, b) {
  a = (a || '').replace(/\s+/g, ' ').trim()
  b = (b || '').replace(/\s+/g, ' ').trim()
  if (a === b) return 0
  const n = Math.max(a.length, b.length)
  if (n === 0) return 0
  let same = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++
  return 1 - same / n
}

let prevThumb = null
let prevText = null

async function captureAndUnderstand() {
  // Resolve the intent window (what the user was working on before Native) and
  // capture only it. Fall back to a full-screen capture (current monitor /
  // desktop) only when no window resolves.
  const { windowId, context } = resolveIntentWindow()
  console.log(
    'UNDERSTAND\n  context: ' +
    (context ? context.appName + ' — ' + (context.windowTitle || '') : '(fallback: monitor / desktop)') +
    '\n  time: ' + new Date().toTimeString().slice(0, 8)
  )
  let imagePath
  if (windowId) {
    captureWindow(windowId, WINDOW_PNG)
    imagePath = WINDOW_PNG
  } else {
    imagePath = await captureScreen()
  }

  const image = cropMargins(nativeImage.createFromPath(imagePath))
  fs.writeFileSync(WINDOW_PNG, image.toPNG())

  const thumb = thumbBitmap(image)
  const imgFrac = imageDiffFraction(prevThumb, thumb)
  prevThumb = thumb
  if (imgFrac <= 0.01) {
    return { changed: false }
  }

  // Adaptive OCR: classify the intent window, then pick the engine
  // (code -> RapidOCR, everything else -> Apple Vision).
  const { text } = await adaptiveOcr.extractText(WINDOW_PNG, context)
  const txtFrac = textDiffFraction(prevText, text)
  if (txtFrac <= 0.02) {
    return { changed: false }
  }
  prevText = text
  return { changed: true, text }
}

// Phase 7 (UX) read-only hooks. currentContext() exposes the window signals the
// overlay shows in its pin label; pinIntentWindow() toggles the pin using the
// existing pinnedWindowId hook. Neither changes how perception resolves, crops,
// diffs, or OCRs.
// Map a window's center point to a 1-based monitor index for the debug panel.
function monitorFor(ctx) {
  if (!ctx) return 0
  try {
    const cx = Math.round((ctx.x || 0) + (ctx.width || 0) / 2)
    const cy = Math.round((ctx.y || 0) + (ctx.height || 0) / 2)
    const d = screen.getDisplayNearestPoint({ x: cx, y: cy })
    const idx = screen.getAllDisplays().findIndex((m) => m.id === d.id)
    return idx >= 0 ? idx + 1 : 1
  } catch (e) {
    return 0
  }
}

function currentContext() {
  const pinned = !!pinnedWindowId
  const ctx = pinned ? pinnedContext : resolveIntentWindow().context
  if (!ctx) return { appName: '', windowTitle: '', monitor: 0, pinned }
  return { ...ctx, monitor: monitorFor(ctx), pinned }
}

function pinIntentWindow() {
  if (pinnedWindowId) {
    pinnedWindowId = null
    pinnedContext = null
    return { pinned: false }
  }
  const r = resolveIntentWindow()
  pinnedWindowId = r.windowId
  pinnedContext = r.context
  return { pinned: !!pinnedWindowId }
}

module.exports = {
  captureAndUnderstand,
  startIntentTracking,
  currentContext,
  pinIntentWindow,
}
