const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFile: (callback) => ipcRenderer.on('file:open', (_event, data) => callback(data)),
  onSaveFile: (callback) => ipcRenderer.on('file:save', (_event, data) => callback(data)),
  sendContent: (mode, content) => ipcRenderer.send('file:content', { mode, content })
});