const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // File
    onOpenFile: (cb) => ipcRenderer.on('file:open', (_, data) => cb(data)),
    onOpenFolder: (cb) => ipcRenderer.on('folder:open', (_, data) => cb(data)),
    onSaveFile: (cb) => ipcRenderer.on('file:save', (_, data) => cb(data)),
    sendContent: (mode, content) => ipcRenderer.send('file:content', { mode, content }),
    selectFile: (filePath) => ipcRenderer.send('file:select', filePath),

    // Terminal
    createPty: (cols, rows) => ipcRenderer.send('pty:create', { cols, rows }),
    writePty: (data) => ipcRenderer.send('pty:write', data),
    resizePty: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
    killPty: () => ipcRenderer.send('pty:kill'),
    onPtyData: (cb) => ipcRenderer.on('pty:data', (_, data) => cb(data)),
    onPtyExit: (cb) => ipcRenderer.on('pty:exit', () => cb()),

    // Run
    runFile: (code, filePath) => ipcRenderer.send('run:file', { code, filePath }),

    // Menu actions (called from React toolbar dropdowns)
    openFile:      () => ipcRenderer.send('menu:open-file'),
    openFolder:    () => ipcRenderer.send('menu:open-folder'),
    triggerSave:   () => ipcRenderer.send('menu:save'),
    triggerSaveAs: () => ipcRenderer.send('menu:save-as'),
    quit:          () => ipcRenderer.send('menu:quit'),

    // Session
    hostSession: () => ipcRenderer.send('session:host'),
    joinSession: (ip) => ipcRenderer.send('session:join', { ip }),
    soloSession: () => ipcRenderer.send('session:solo'),
    onSessionStarted: (cb) => ipcRenderer.on('session:started', (_, data) => cb(data)),
    onSessionConnected: (cb) => ipcRenderer.on('session:connected', (_, data) => cb(data)),
    onSessionSoloStarted: (cb) => ipcRenderer.on('session:solo-started', () => cb()),
    onSessionError: (cb) => ipcRenderer.on('session:error', (_, msg) => cb(msg)),
    onGuestJoined: (cb) => ipcRenderer.on('session:guest-joined', (_, sid) => cb(sid)),
    onGuestLeft: (cb) => ipcRenderer.on('session:guest-left', (_, sid) => cb(sid)),
});
