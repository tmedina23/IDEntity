// I added a comment with IDEntity

const { app, Menu, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

let mainWindow;
const isMac = process.platform === 'darwin'

let fileTreeEntries = [];
let currentFilePath = null;

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
    mainWindow.loadFile("./dist/index.html");
    mainWindow.webContents.openDevTools();
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (isMac) app.quit()
})

app.on('activate', () => {
    if (mainWindow === null) createWindow();
})

const openFile = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile']
    });
    if (canceled) return;

    currentFilePath = filePaths[0];
    const content = fs.readFileSync(currentFilePath, 'utf-8');
    mainWindow.webContents.send('file:open', { filePath: currentFilePath, content });
    mainWindow.setTitle("IDEntity - " + currentFilePath);
    console.log("opening" + currentFilePath)
}

const openFolder = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (canceled) return;

    const folderPath = filePaths[0];
    currentFolderPath = folderPath;
    const fileTree = buildFileTree(folderPath);
    mainWindow.webContents.send('folder:open', { folderPath, fileTree });
    mainWindow.setTitle("IDEntity - " + folderPath);
    console.log("opening folder: " + folderPath)
}

const buildFileTree = (dirPath) => {
    fileTreeEntries = fs.readdirSync(dirPath, { withFileTypes: true });
    return fileTreeEntries.map(entry => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        children: entry.isDirectory() ? buildFileTree(path.join(dirPath, entry.name)) : null
    }));
}

ipcMain.on('file:select', async (event, filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    currentFilePath = filePath;
    mainWindow.webContents.send('file:open', { filePath, content });
    mainWindow.setTitle("IDEntity - " + filePath);
    console.log("opening" + filePath)
});

let ptyProcess = null;
let currentFolderPath = null;

const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

ipcMain.on('pty:create', (event, { cols, rows }) => {
    if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
    }

    const cwd = currentFolderPath || os.homedir();
    ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env: process.env
    });

    ptyProcess.onData(data => {
        if (mainWindow) mainWindow.webContents.send('pty:data', data);
    });

    ptyProcess.onExit(() => {
        if (mainWindow) mainWindow.webContents.send('pty:exit');
        ptyProcess = null;
    });
});

ipcMain.on('pty:write', (event, data) => {
    if (ptyProcess) ptyProcess.write(data);
});

ipcMain.on('pty:resize', (event, { cols, rows }) => {
    if (ptyProcess) ptyProcess.resize(cols, rows);
});

ipcMain.on('pty:kill', () => {
    if (ptyProcess) {
        ptyProcess.kill();
        ptyProcess = null;
    }
});

// Run button: write editor content to temp file and execute via the pty shell
ipcMain.on('run:file', (event, { code, filePath }) => {
    const tmpPath = path.join(os.tmpdir(), 'identity_run.py');
    fs.writeFileSync(tmpPath, code, 'utf-8');
    const runPath = filePath || tmpPath;
    const cmd = `python "${runPath}"\r`;
    if (ptyProcess) ptyProcess.write(cmd);
});

ipcMain.on('file:content', async (event, { mode, content }) => {
    if (mode === 'saveAs' || !currentFilePath) {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {});
        if (canceled) return;
        currentFilePath = filePath;
        mainWindow.setTitle("IDEntity - " + currentFilePath);
    }

    fs.writeFileSync(currentFilePath, content, 'utf-8');
    console.log("saved to " + currentFilePath)
});

const template = [
  {
    label: 'File',
    submenu: [
        // New File
        {
            label: 'Open File',
            accelerator: isMac ? 'Cmd+O' : 'Ctrl+O',
            click: openFile
        },
        {
            label: 'Open Folder',
            accelerator: isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O',
            click: openFolder
        },
        {type: 'separator'},
        {
          label: 'Save',
          accelerator: isMac ? 'Cmd+S' : 'Ctrl+S',
          click: () => mainWindow.webContents.send('file:save', 'save')
        },
        {
          label: 'Save As',
          accelerator: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
          click: () => mainWindow.webContents.send('file:save', 'saveAs')
        },
        {type: 'separator'},
        (isMac ? { role: 'close' } : { role: 'quit' })
    ]
  },
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' }
]

const menu = Menu.buildFromTemplate(template)
Menu.setApplicationMenu(menu)