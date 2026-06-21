const { app, BrowserWindow, screen, ipcMain } = require('electron')
const path = require('path')
const { captureScreen } = require('../services/captureService')

const isDev = process.env.NODE_ENV === 'development'
const isMac = process.platform === 'darwin'

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
  ipcMain.handle('capture-screen', () => captureScreen())

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Closing the window quits Native on every platform.
app.on('window-all-closed', () => {
  app.quit()
})
