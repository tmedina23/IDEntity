const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFile: (callback) => ipcRenderer.on('file:open', (_event, data) => callback(data)),
  onOpenFolder: (callback) => ipcRenderer.on('folder:open', (_event, data) => callback(data)),
  onSaveFile: (callback) => ipcRenderer.on('file:save', (_event, data) => callback(data)),
  sendContent: (mode, content) => ipcRenderer.send('file:content', { mode, content }),
  selectFile: (filePath) => ipcRenderer.send('file:select', filePath),

  // Terminal (node-pty <-> xterm.js)
  createPty: (cols, rows) => ipcRenderer.send('pty:create', { cols, rows }),
  writePty: (data) => ipcRenderer.send('pty:write', data),
  resizePty: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  killPty: () => ipcRenderer.send('pty:kill'),
  onPtyData: (callback) => ipcRenderer.on('pty:data', (_event, data) => callback(data)),
  onPtyExit: (callback) => ipcRenderer.on('pty:exit', () => callback()),

  // Run button — writes current editor code into the pty shell
  runFile: (code, filePath) => ipcRenderer.send('run:file', { code, filePath }),
});
