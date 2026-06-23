const { app, BrowserWindow, screen, ipcMain, globalShortcut } = require('electron')
const path = require('path')
const {
  captureAndUnderstand,
  startIntentTracking,
  currentContext,
  pinIntentWindow,
} = require('../services/perceptionService')
const { streamSolve } = require('../services/reasoningService')
const { getEnabled, setEnabled, available } = require('../services/contextService')
const { startRecording, stopRecording, transcribe } = require('../services/speechService')

const isDev = process.env.NODE_ENV === 'development'
const isMac = process.platform === 'darwin'

// The overlay window and the in-flight generation, so hotkeys/IPC can reach
// them. Phase 7 (UX) only — no change to perception, OCR, reasoning, streaming.
let mainWin = null
let currentAbort = null
let savedBounds = null
let interviewBounds = null

// Reasoning cache (separate from perception's image/OCR cache). Perception
// decides when to re-OCR (image diff); these decide when to re-reason.
let lastScreenText = ''
let lastQuestion = null
let lastAnswer = ''

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const width = 440
  const height = 220
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + workArea.height * 0.06)

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 320,
    minHeight: 160,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    // macOS panel: floats above other apps (including fullscreen meetings)
    // without activating Native or stealing focus from the foreground app.
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Hide the overlay from screen capture and screen sharing (Zoom, Google
  // Meet, recorders). On macOS this applies NSWindowSharingNone, so the window
  // stays visible on screen but is absent from any shared/recorded stream.
  win.setContentProtection(true)
  mainWin = win

  // Keep the overlay floating on top across every space and fullscreen app.
  win.setAlwaysOnTop(true, 'floating')
  if (isMac) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setHiddenInMissionControl(true)
  }

  // Bring the overlay to the front on launch so the native window is clearly
  // visible (Phase 1/2 verification). Stealth (content protection,
  // always-on-top) still applies.
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(() => {
  startIntentTracking()
  // Perception caches OCR (re-runs only when the image changes). Reasoning is
  // cached separately: a new question on an identical screen must still answer.
  //   screen changed (+ any question) -> OCR (by perception) + reasoning
  //   same screen + different question -> reuse cached text + reasoning
  //   same screen + same question      -> reuse cached answer (skip everything)
  ipcMain.handle('understand-screen', async (event, question) => {
    const result = await captureAndUnderstand()
    const screenText = result.changed ? result.text : lastScreenText
    lastScreenText = screenText
    const q = question || ''

    if (!result.changed && q === lastQuestion) {
      return { changed: true, answer: lastAnswer }
    }
    lastQuestion = q

    event.sender.send('phase', 'thinking')
    const controller = new AbortController()
    currentAbort = controller
    try {
      const answer = await streamSolve(screenText, q, (chunk) => {
        event.sender.send('understand-screen-chunk', chunk)
      }, controller.signal)
      lastAnswer = answer
      return { changed: true, answer }
    } finally {
      currentAbort = null
    }
  })

  // Phase 7 (UX) IPC: stop generation, current pin context, pin toggle, and
  // overlay collapse / interview resizing. None of these alter perception.
  ipcMain.handle('stop-generation', () => {
    if (currentAbort) currentAbort.abort()
  })
  ipcMain.handle('current-context', () => currentContext())
  ipcMain.handle('pin-window', () => pinIntentWindow())
  ipcMain.handle('set-collapsed', (_e, collapsed) => {
    if (!mainWin) return
    if (collapsed) {
      savedBounds = mainWin.getBounds()
      mainWin.setMinimumSize(300, 120)
      mainWin.setSize(savedBounds.width, 160)
    } else {
      mainWin.setMinimumSize(320, 160)
      if (savedBounds) mainWin.setSize(savedBounds.width, savedBounds.height)
    }
  })
  ipcMain.handle('set-interview', (_e, on) => {
    if (!mainWin) return
    mainWin.setOpacity(on ? 0.82 : 1)
    if (on) {
      interviewBounds = mainWin.getBounds()
      mainWin.setMinimumSize(300, 120)
      mainWin.setSize(Math.min(interviewBounds.width, 400), Math.min(interviewBounds.height, 320))
    } else if (interviewBounds) {
      mainWin.setMinimumSize(320, 160)
      mainWin.setSize(interviewBounds.width, interviewBounds.height)
    }
  })

  // Identity context (Phase 8): which CV/JD/About docs Settings has enabled.
  ipcMain.handle('identity-state', () => ({ enabled: getEnabled(), available: available() }))
  ipcMain.handle('set-identity-enabled', (_e, partial) => setEnabled(partial))

  // Voice input (Phase 9): record the mic, then stop+transcribe -> text. Voice
  // only fills the renderer's input box; it never submits.
  ipcMain.handle('voice-start', () => startRecording())
  ipcMain.handle('voice-stop', async () => {
    await stopRecording()
    return transcribe()
  })

  createWindow()
  registerHotkeys()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Global shortcuts (Phase 7). They work while another app is focused, which is
// the whole point during an interview. Window-level actions run here; the rest
// are forwarded to the renderer, which owns the UI state.
function registerHotkeys() {
  const send = (action) => mainWin && mainWin.webContents.send('hotkey', action)
  const show = () => { if (mainWin) mainWin.show() }
  const map = {
    'Alt+Command+U': () => { show(); send('understand') },
    'Alt+Command+F': () => { show(); send('focus-input') },
    'Alt+Command+V': () => { show(); send('voice') },
    'Alt+Command+X': () => send('stop'),
    'Alt+Command+H': () => { if (mainWin) (mainWin.isVisible() ? mainWin.hide() : mainWin.show()) },
    'Alt+Command+P': () => send('pin'),
    'Alt+Command+J': () => send('scroll-down'),
    'Alt+Command+K': () => send('scroll-up'),
    'Alt+Command+M': () => send('collapse'),
    'Alt+Command+I': () => send('interview'),
    'Alt+Command+R': () => send('clear'),
    'Alt+Command+Y': () => send('copy-code'),
  }
  for (const [accel, fn] of Object.entries(map)) {
    globalShortcut.register(accel, fn)
  }
}

app.on('will-quit', () => globalShortcut.unregisterAll())

// Closing the window quits Native on every platform.
app.on('window-all-closed', () => {
  app.quit()
})
