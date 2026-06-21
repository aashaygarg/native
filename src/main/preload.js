const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  understandScreen: (question) => ipcRenderer.invoke('understand-screen', question),
  stopGeneration: () => ipcRenderer.invoke('stop-generation'),
  currentContext: () => ipcRenderer.invoke('current-context'),
  pinWindow: () => ipcRenderer.invoke('pin-window'),
  setCollapsed: (collapsed) => ipcRenderer.invoke('set-collapsed', collapsed),
  setInterview: (on) => ipcRenderer.invoke('set-interview', on),
  identityState: () => ipcRenderer.invoke('identity-state'),
  setIdentityEnabled: (partial) => ipcRenderer.invoke('set-identity-enabled', partial),
  // Subscribe to streamed answer tokens; returns an unsubscribe function.
  onAnswerChunk: (cb) => {
    const listener = (_e, chunk) => cb(chunk)
    ipcRenderer.on('understand-screen-chunk', listener)
    return () => ipcRenderer.removeListener('understand-screen-chunk', listener)
  },
  // Generation phase updates (e.g. thinking); returns an unsubscribe function.
  onPhase: (cb) => {
    const listener = (_e, phase) => cb(phase)
    ipcRenderer.on('phase', listener)
    return () => ipcRenderer.removeListener('phase', listener)
  },
  // Global hotkey actions forwarded from main; returns an unsubscribe function.
  onHotkey: (cb) => {
    const listener = (_e, action) => cb(action)
    ipcRenderer.on('hotkey', listener)
    return () => ipcRenderer.removeListener('hotkey', listener)
  },
})
