const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  understandScreen: () => ipcRenderer.invoke('understand-screen'),
  // Subscribe to streamed answer tokens; returns an unsubscribe function.
  onAnswerChunk: (cb) => {
    const listener = (_e, chunk) => cb(chunk)
    ipcRenderer.on('understand-screen-chunk', listener)
    return () => ipcRenderer.removeListener('understand-screen-chunk', listener)
  },
})
