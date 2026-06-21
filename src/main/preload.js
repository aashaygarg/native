const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('native', {
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  understandScreen: () => ipcRenderer.invoke('understand-screen'),
})
