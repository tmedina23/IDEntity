// I added a comment with IDEntity

const { app, Menu, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const { type } = require('os');
const path = require('path');

let mainWindow;
const isMac = process.platform === 'darwin'

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
        {
            label: 'Open File',
            accelerator: isMac ? 'Cmd+O' : 'Ctrl+O',
            click: openFile
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