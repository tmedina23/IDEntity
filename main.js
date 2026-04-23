const { app, Menu, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

let mainWindow;
const isMac = process.platform === 'darwin';

// --- Session State ---
let sessionMode = null; // 'solo' | 'host' | 'guest'
let wsClient = null; // guest: WS connection to host's term server

// --- PTY Management ---
const ptyMap = new Map(); // sessionId -> ptyProcess
const LOCAL_SID = 'local';
const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
let currentFolderPath = null;
let currentFilePath = null;

// --- Yjs Server State (host only) ---
const YPORT = 4444;
const TPORT = 4445;
const ydoc = new Y.Doc();
const awareness = new awarenessProtocol.Awareness(ydoc);

// --- Helpers ---
function getLocalIP() {
    for (const iface of Object.values(os.networkInterfaces())) {
        for (const alias of iface) {
            if (alias.family === 'IPv4' && !alias.internal) return alias.address;
        }
    }
    return '127.0.0.1';
}

function spawnPtyForSession(sid, cols, rows) {
    const cwd = currentFolderPath || os.homedir();
    const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env: process.env
    });
    ptyMap.set(sid, proc);
    return proc;
}

// --- Yjs WebSocket Server (host only) ---
function startYjsServer() {
    const yjsServer = new WebSocketServer({ port: YPORT });
    yjsServer.on('connection', (conn) => {
        conn.binaryType = 'arraybuffer';

        const send = (data) => {
            if (conn.readyState === WebSocket.OPEN) conn.send(data);
        };

        // Send sync step 1
        const enc1 = encoding.createEncoder();
        encoding.writeVarUint(enc1, 0);
        syncProtocol.writeSyncStep1(enc1, ydoc);
        send(encoding.toUint8Array(enc1));

        // Send current awareness states
        const states = awareness.getStates();
        if (states.size > 0) {
            const encA = encoding.createEncoder();
            encoding.writeVarUint(encA, 1);
            encoding.writeVarUint8Array(encA, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys())));
            send(encoding.toUint8Array(encA));
        }

        const awarenessListener = ({ added, updated, removed }) => {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, 1);
            encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
            send(encoding.toUint8Array(enc));
        };

        const updateListener = (update, origin) => {
            if (origin !== conn) {
                const enc = encoding.createEncoder();
                encoding.writeVarUint(enc, 0);
                syncProtocol.writeUpdate(enc, update);
                send(encoding.toUint8Array(enc));
            }
        };

        awareness.on('update', awarenessListener);
        ydoc.on('update', updateListener);

        conn.on('message', (data) => {
            try {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const decoder = decoding.createDecoder(new Uint8Array(buf));
                const msgType = decoding.readVarUint(decoder);
                if (msgType === 0) {
                    const enc = encoding.createEncoder();
                    encoding.writeVarUint(enc, 0);
                    syncProtocol.readSyncMessage(decoder, enc, ydoc, conn);
                    if (encoding.length(enc) > 1) send(encoding.toUint8Array(enc));
                } else if (msgType === 1) {
                    awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn);
                }
            } catch (_) {}
        });

        conn.on('close', () => {
            awareness.off('update', awarenessListener);
            ydoc.off('update', updateListener);
        });
    });
}

// --- Terminal / Session WebSocket Server (host only) ---
function startTermServer() {
    const termServer = new WebSocketServer({ port: TPORT });
    termServer.on('connection', (ws) => {
        const sid = crypto.randomUUID();
        ws.send(JSON.stringify({ type: 'session:assigned', sessionId: sid }));
        if (mainWindow) mainWindow.webContents.send('session:guest-joined', sid);

        ws.on('message', (raw) => {
            try {
                const m = JSON.parse(raw.toString());
                if (m.type === 'pty:create') {
                    const proc = spawnPtyForSession(sid, m.cols, m.rows);
                    proc.onData(data => {
                        if (ws.readyState === WebSocket.OPEN)
                            ws.send(JSON.stringify({ type: 'pty:data', data }));
                    });
                    proc.onExit(() => {
                        if (ws.readyState === WebSocket.OPEN)
                            ws.send(JSON.stringify({ type: 'pty:exit' }));
                        ptyMap.delete(sid);
                    });
                } else if (m.type === 'pty:write') {
                    ptyMap.get(sid)?.write(m.data);
                } else if (m.type === 'pty:resize') {
                    ptyMap.get(sid)?.resize(m.cols, m.rows);
                } else if (m.type === 'file:request') {
                    // Guest wants to open a file — have the host's renderer open it so it syncs via Yjs
                    const content = fs.readFileSync(m.path, 'utf-8');
                    mainWindow.webContents.send('file:open', { filePath: m.path, content });
                    mainWindow.setTitle('IDEntity - ' + m.path);
                }
            } catch (_) {}
        });

        ws.on('close', () => {
            ptyMap.get(sid)?.kill();
            ptyMap.delete(sid);
            if (mainWindow) mainWindow.webContents.send('session:guest-left', sid);
        });
    });
}

// --- Window ---
const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        webPreferences: {
            worldSafeExecuteJavaScript: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: './images/icon.ico',
        title: 'IDEntity'
    });
    mainWindow.loadFile('./dist/index.html');
    mainWindow.webContents.openDevTools();
    mainWindow.on('closed', () => { mainWindow = null; });
};

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (isMac) app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// --- File Operations ---
const openFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (canceled) return;
    currentFilePath = filePaths[0];
    const content = fs.readFileSync(currentFilePath, 'utf-8');
    mainWindow.webContents.send('file:open', { filePath: currentFilePath, content });
    mainWindow.setTitle('IDEntity - ' + currentFilePath);
};

const openFolder = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (canceled) return;
    currentFolderPath = filePaths[0];
    const fileTree = buildFileTree(currentFolderPath);
    mainWindow.webContents.send('folder:open', { folderPath: currentFolderPath, fileTree });
    mainWindow.setTitle('IDEntity - ' + currentFolderPath);
};

const buildFileTree = (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        children: entry.isDirectory() ? buildFileTree(path.join(dirPath, entry.name)) : null
    }));
};

ipcMain.on('file:select', (event, filePath) => {
    if (sessionMode === 'guest') {
        wsClient?.send(JSON.stringify({ type: 'file:request', path: filePath }));
        return;
    }
    currentFilePath = filePath;
    const content = fs.readFileSync(filePath, 'utf-8');
    mainWindow.webContents.send('file:open', { filePath, content });
    mainWindow.setTitle('IDEntity - ' + filePath);
});

ipcMain.on('file:content', async (event, { mode, content }) => {
    if (mode === 'saveAs' || !currentFilePath) {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {});
        if (canceled) return;
        currentFilePath = filePath;
        mainWindow.setTitle('IDEntity - ' + currentFilePath);
    }
    fs.writeFileSync(currentFilePath, content, 'utf-8');
});

// --- Session IPC ---
ipcMain.on('session:host', () => {
    sessionMode = 'host';
    startYjsServer();
    startTermServer();
    const ip = getLocalIP();
    mainWindow.webContents.send('session:started', { ip, yPort: YPORT, tPort: TPORT });
});

ipcMain.on('session:join', (event, { ip }) => {
    sessionMode = 'guest';
    wsClient = new WebSocket(`ws://${ip}:${TPORT}`);
    wsClient.on('open', () => {
        mainWindow.webContents.send('session:connected', { ip, yPort: YPORT });
    });
    wsClient.on('message', (raw) => {
        try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'pty:data') mainWindow.webContents.send('pty:data', m.data);
            else if (m.type === 'pty:exit') mainWindow.webContents.send('pty:exit');
        } catch (_) {}
    });
    wsClient.on('error', (err) => {
        mainWindow.webContents.send('session:error', err.message);
    });
});

ipcMain.on('session:solo', () => {
    sessionMode = 'solo';
    mainWindow.webContents.send('session:solo-started');
});

// --- PTY IPC (mode-aware) ---
ipcMain.on('pty:create', (event, { cols, rows }) => {
    if (sessionMode === 'guest') {
        wsClient?.send(JSON.stringify({ type: 'pty:create', cols, rows }));
        return;
    }
    if (ptyMap.has(LOCAL_SID)) { ptyMap.get(LOCAL_SID).kill(); ptyMap.delete(LOCAL_SID); }
    const proc = spawnPtyForSession(LOCAL_SID, cols, rows);
    proc.onData(data => { if (mainWindow) mainWindow.webContents.send('pty:data', data); });
    proc.onExit(() => { if (mainWindow) mainWindow.webContents.send('pty:exit'); ptyMap.delete(LOCAL_SID); });
});

ipcMain.on('pty:write', (event, data) => {
    if (sessionMode === 'guest') { wsClient?.send(JSON.stringify({ type: 'pty:write', data })); return; }
    ptyMap.get(LOCAL_SID)?.write(data);
});

ipcMain.on('pty:resize', (event, { cols, rows }) => {
    if (sessionMode === 'guest') { wsClient?.send(JSON.stringify({ type: 'pty:resize', cols, rows })); return; }
    ptyMap.get(LOCAL_SID)?.resize(cols, rows);
});

ipcMain.on('pty:kill', () => {
    if (sessionMode === 'guest') { wsClient?.close(); return; }
    ptyMap.get(LOCAL_SID)?.kill();
    ptyMap.delete(LOCAL_SID);
});

ipcMain.on('run:file', (event, { code, filePath }) => {
    if (sessionMode === 'guest') return;
    const tmpPath = path.join(os.tmpdir(), 'identity_run.py');
    fs.writeFileSync(tmpPath, code, 'utf-8');
    const runPath = filePath || tmpPath;
    ptyMap.get(LOCAL_SID)?.write(`python "${runPath}"\r`);
});

// --- Menu ---
const template = [
    {
        label: 'File',
        submenu: [
            { label: 'Open File', accelerator: isMac ? 'Cmd+O' : 'Ctrl+O', click: openFile },
            { label: 'Open Folder', accelerator: isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O', click: openFolder },
            { type: 'separator' },
            { label: 'Save', accelerator: isMac ? 'Cmd+S' : 'Ctrl+S', click: () => mainWindow.webContents.send('file:save', 'save') },
            { label: 'Save As', accelerator: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S', click: () => mainWindow.webContents.send('file:save', 'saveAs') },
            { type: 'separator' },
            isMac ? { role: 'close' } : { role: 'quit' }
        ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
];

Menu.setApplicationMenu(Menu.buildFromTemplate(template));
