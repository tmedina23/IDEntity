const { app, Menu, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
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
let yjsServer = null;
let termServer = null;

// --- PTY Management ---
const ptyMap = new Map(); // sessionId -> ptyProcess
const LOCAL_SID = 'local';
const guestSockets = new Map(); // sid -> WebSocket (guests mirroring host terminal)
let runProcess = null; // active child_process for Run button
const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');
let currentFolderPath = null;
let currentFilePath = null;
let ptySize = { cols: 80, rows: 24 };

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

function createLocalPty(cols, rows) {
    if (ptyMap.has(LOCAL_SID)) {
        ptyMap.get(LOCAL_SID).kill();
        ptyMap.delete(LOCAL_SID);
    }
    const proc = spawnPtyForSession(LOCAL_SID, cols, rows);
    proc.onData(data => {
        if (mainWindow) mainWindow.webContents.send('pty:data', data);
        broadcastGuests({ type: 'pty:data', data });
    });
    proc.onExit(() => {
        if (mainWindow) mainWindow.webContents.send('pty:exit');
        broadcastGuests({ type: 'pty:exit' });
        ptyMap.delete(LOCAL_SID);
    });
    return proc;
}

function setWorkingDirectory(folderPath) {
    if (!folderPath) return;
    currentFolderPath = folderPath;
    process.chdir(folderPath);
    if (sessionMode === 'guest') return;
    if (ptyMap.has(LOCAL_SID)) {
        createLocalPty(ptySize.cols, ptySize.rows);
    }
}

// --- Yjs WebSocket Server (host only) ---
function startYjsServer() {
    if (yjsServer) {
        yjsServer.close();
        yjsServer = null;
    }

    yjsServer = new WebSocketServer({ port: YPORT });
    yjsServer.on('error', (err) => {
        if (mainWindow) mainWindow.webContents.send('session:error', `Yjs server error: ${err.message}`);
    });

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
// Guests get a read-only mirror of the host terminal — no per-guest PTY.
function startTermServer() {
    if (termServer) {
        termServer.close();
        termServer = null;
    }

    termServer = new WebSocketServer({ port: TPORT });
    termServer.on('error', (err) => {
        if (mainWindow) mainWindow.webContents.send('session:error', `Terminal server error: ${err.message}`);
    });

    termServer.on('connection', (ws) => {
        const sid = crypto.randomUUID();
        guestSockets.set(sid, ws);
        ws.send(JSON.stringify({ type: 'session:assigned', sessionId: sid }));
        if (mainWindow) mainWindow.webContents.send('session:guest-joined', sid);

        ws.on('message', (raw) => {
            try {
                const m = JSON.parse(raw.toString());
                if (m.type === 'run:file') {
                    // Guest triggered Run — execute on host on their behalf
                    hostRunFile(m.code, m.filePath);
                } else if (m.type === 'file:request') {
                    const content = fs.readFileSync(m.path, 'utf-8');
                    mainWindow.webContents.send('file:open', { filePath: m.path, content });
                    mainWindow.setTitle('IDEntity - ' + m.path);
                }
            } catch (_) {}
        });

        ws.on('close', () => {
            guestSockets.delete(sid);
            if (mainWindow) mainWindow.webContents.send('session:guest-left', sid);
        });
    });
}

// Broadcast a message to all connected guests
function broadcastGuests(msg) {
    const payload = JSON.stringify(msg);
    guestSockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    });
}

function closeWebSocketServer(server) {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
    });
}

async function stopSession() {
    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }
    guestSockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
    guestSockets.clear();
    await Promise.all([
        closeWebSocketServer(termServer),
        closeWebSocketServer(yjsServer)
    ]);
    termServer = null;
    yjsServer = null;
    if (ptyMap.has(LOCAL_SID)) {
        ptyMap.get(LOCAL_SID).kill();
        ptyMap.delete(LOCAL_SID);
    }
    if (runProcess) {
        runProcess.kill();
        runProcess = null;
    }
    sessionMode = null;
    currentFolderPath = null;
    currentFilePath = null;
    if (mainWindow) mainWindow.webContents.send('session:reset');
}

ipcMain.on('session:reset', async () => await stopSession());

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
    mainWindow.on('closed', () => { app.quit(); });
};

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (isMac) app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// --- File Operations ---
const openFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (canceled) return;
    currentFilePath = filePaths[0];
    setWorkingDirectory(path.dirname(currentFilePath));
    const content = fs.readFileSync(currentFilePath, 'utf-8');
    mainWindow.webContents.send('file:open', { filePath: currentFilePath, content });
    mainWindow.setTitle('IDEntity - ' + currentFilePath);
};

const openFolder = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (canceled) return;
    currentFolderPath = filePaths[0];
    setWorkingDirectory(currentFolderPath);
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
ipcMain.on('session:host', async () => {
    if (sessionMode !== null) {
        await stopSession();
    }

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
            else if (m.type === 'run:done') mainWindow.webContents.send('run:done', m.code);
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
    if (sessionMode === 'guest') return; // guests mirror host — no local PTY
    ptySize = { cols, rows };
    createLocalPty(cols, rows);
});

ipcMain.on('pty:write', (event, data) => {
    if (sessionMode === 'guest') return; // guests are read-only
    ptyMap.get(LOCAL_SID)?.write(data);
});

ipcMain.on('pty:resize', (event, { cols, rows }) => {
    if (sessionMode === 'guest') return;
    ptyMap.get(LOCAL_SID)?.resize(cols, rows);
});

ipcMain.on('pty:kill', () => {
    if (sessionMode === 'guest') return;
    ptyMap.get(LOCAL_SID)?.kill();
    ptyMap.delete(LOCAL_SID);
});

// Shared run logic used by both host IPC and guest WS requests
function hostRunFile(code, filePath) {
    if (runProcess) { runProcess.kill(); runProcess = null; }

    // Save to actual file path (or temp) — this is the "save before run"
    const targetPath = filePath || path.join(os.tmpdir(), 'identity_run.py');
    fs.writeFileSync(targetPath, code, 'utf-8');

    const sendData = (str) => {
        if (mainWindow) mainWindow.webContents.send('pty:data', str);
        broadcastGuests({ type: 'pty:data', data: str });
    };

    sendData(`\r\n\x1b[36m▶ Running ${path.basename(targetPath)}...\x1b[0m\r\n`);

    runProcess = spawn('python', [targetPath]);
    runProcess.stdout.on('data', d => sendData(d.toString()));
    runProcess.stderr.on('data', d => sendData(`\x1b[31m${d.toString()}\x1b[0m`));
    runProcess.on('close', (code) => {
        runProcess = null;
        const msg = code === 0
            ? `\r\n\x1b[32m✓ Exited (0)\x1b[0m\r\n`
            : `\r\n\x1b[31m✗ Exited (${code})\x1b[0m\r\n`;
        sendData(msg);
        if (mainWindow) mainWindow.webContents.send('run:done', code);
        broadcastGuests({ type: 'run:done', code });
    });
}

ipcMain.on('run:file', (event, { code, filePath }) => {
    if (sessionMode === 'guest') {
        wsClient?.send(JSON.stringify({ type: 'run:file', code, filePath }));
        return;
    }
    hostRunFile(code, filePath);
});

ipcMain.on('run:kill', () => {
    if (sessionMode === 'guest') {
        wsClient?.send(JSON.stringify({ type: 'run:kill' }));
        return;
    }
    if (runProcess) { runProcess.kill(); runProcess = null; }
});

// Remove native menu bar — UI is handled by React
Menu.setApplicationMenu(null);

// --- Menu IPC (called from React toolbar) ---
ipcMain.on('menu:open-file',   () => openFile());
ipcMain.on('menu:open-folder', () => openFolder());
ipcMain.on('menu:save',        () => mainWindow.webContents.send('file:save', 'save'));
ipcMain.on('menu:save-as',     () => mainWindow.webContents.send('file:save', 'saveAs'));
ipcMain.on('menu:quit',        () => app.quit());
