import * as monaco from 'monaco-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';

self.MonacoEnvironment = {
	getWorkerUrl: function (moduleId, label) {
		if (label === 'json') return './json.worker.bundle.js';
		if (label === 'css' || label === 'scss' || label === 'less') return './css.worker.bundle.js';
		if (label === 'html' || label === 'handlebars' || label === 'razor') return './html.worker.bundle.js';
		if (label === 'typescript' || label === 'javascript') return './ts.worker.bundle.js';
		return './editor.worker.bundle.js';
	}
};

// --- Monaco Editor ---
const editor = monaco.editor.create(document.getElementById('container'), {
	value: '',
	language: 'plaintext',
	theme: 'vs-dark',
});

const extToLanguage = {
	js: 'javascript', ts: 'typescript',
	json: 'json', css: 'css', scss: 'scss',
	less: 'less', html: 'html', xml: 'xml',
	py: 'python', md: 'markdown',
};

// --- xterm.js Terminal ---
const term = new Terminal({
	theme: { background: '#111111', foreground: '#d4d4d4', cursor: '#d4d4d4' },
	fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
	fontSize: 13,
	scrollback: 1000,
	convertEol: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

term.onData(data => window.electronAPI.writePty(data));
window.electronAPI.onPtyData(data => term.write(data));
window.electronAPI.onPtyExit(() => term.writeln('\r\n\x1b[33m[process exited]\x1b[0m'));

const resizeObserver = new ResizeObserver(() => {
	fitAddon.fit();
	window.electronAPI.resizePty(term.cols, term.rows);
});
resizeObserver.observe(document.getElementById('terminal'));

// --- Yjs ---
const ydoc = new Y.Doc();
const yFiles = ydoc.getMap('files');   // filePath -> Y.Text
const yFileTree = ydoc.getMap('fileTree'); // 'tree', 'folderPath'
const yState = ydoc.getMap('state');   // 'activeFile' -> { filePath, language }

let provider = null;
let monacoBinding = null;
let currentFilePath = null;
let sessionMode = null;
let guestCount = 0;

// Inject a <style> tag for dynamic per-user cursor colors
const cursorStyleEl = document.createElement('style');
cursorStyleEl.id = 'remote-cursor-styles';
document.head.appendChild(cursorStyleEl);

function clientColor(clientID) {
    const hue = (clientID * 137.508) % 360; // golden angle gives distinct hues
    return `hsl(${Math.round(hue)}, 80%, 60%)`;
}

function updateCursorStyles(awareness) {
    const rules = [];
    awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.doc.clientID) return;
        const color = (state.user && state.user.color) || clientColor(clientID);
        const name = (state.user && state.user.name) || 'Guest';
        rules.push(`.yRemoteSelection-${clientID} { background-color: ${color}; }`);
        rules.push(`.yRemoteSelectionHead-${clientID} { border-color: ${color}; }`);
        rules.push(`.yRemoteSelectionHead-${clientID}::before { background: ${color}; color: #111; content: "${name}"; }`);
    });
    cursorStyleEl.textContent = rules.join('\n');
}

function connectYjs(wsUrl, userName, userColor) {
	provider = new WebsocketProvider(wsUrl, 'identity', ydoc);

	provider.awareness.setLocalStateField('user', {
		name: userName,
		color: userColor || clientColor(ydoc.clientID),
	});

	provider.awareness.on('change', () => updateCursorStyles(provider.awareness));

	provider.on('sync', () => {
		// On initial sync, apply any state already in the doc (for guests joining mid-session)
		const tree = yFileTree.get('tree');
		const folderPath = yFileTree.get('folderPath');
		if (tree && folderPath) renderFileTree(folderPath, tree);

		const activeFile = yState.get('activeFile');
		if (activeFile && activeFile.filePath !== currentFilePath) {
			openSharedFile(activeFile.filePath, activeFile.language);
		}
	});

	yFileTree.observe(() => {
		const tree = yFileTree.get('tree');
		const folderPath = yFileTree.get('folderPath');
		if (tree && folderPath) renderFileTree(folderPath, tree);
	});

	yState.observe(() => {
		const activeFile = yState.get('activeFile');
		if (activeFile && activeFile.filePath !== currentFilePath) {
			openSharedFile(activeFile.filePath, activeFile.language);
		}
	});
}

// Opens a file that's already in the Yjs doc (called on guests, or when yState changes)
function openSharedFile(filePath, language) {
	const yText = yFiles.get(filePath);
	if (!yText) return;
	currentFilePath = filePath;
	const newModel = monaco.editor.createModel('', language || 'plaintext');
	const oldModel = editor.getModel();
	editor.setModel(newModel);
	if (oldModel) oldModel.dispose();
	if (monacoBinding) monacoBinding.destroy();
	monacoBinding = new MonacoBinding(yText, newModel, new Set([editor]), provider?.awareness);
}

// --- Session Overlay ---
const overlay = document.getElementById('session-overlay');
const sessionStatus = document.getElementById('session-status');
const sessionInfo = document.getElementById('session-info');

// Pending session data — filled in after connection, consumed on "Enter IDE"
let pendingSession = null;

// --- Identity picker setup ---
const PRESET_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e8c'];
let selectedColor = PRESET_COLORS[0];

const swatchContainer = document.getElementById('color-swatches');
PRESET_COLORS.forEach((color, i) => {
	const swatch = document.createElement('div');
	swatch.className = 'color-swatch' + (i === 0 ? ' selected' : '');
	swatch.style.background = color;
	swatch.addEventListener('click', () => {
		document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
		swatch.classList.add('selected');
		selectedColor = color;
	});
	swatchContainer.appendChild(swatch);
});

function showIdentityPicker(defaultName) {
	document.getElementById('session-buttons').style.display = 'none';
	document.getElementById('join-form').style.display = 'none';
	sessionStatus.textContent = '';
	const input = document.getElementById('user-name-input');
	input.value = defaultName;
	document.getElementById('identity-form').style.display = 'flex';
	input.focus();
	input.select();
}

function enterIDE() {
	const name = document.getElementById('user-name-input').value.trim() || pendingSession.defaultName;
	const { wsUrl, mode, ip } = pendingSession;

	sessionMode = mode;
	connectYjs(wsUrl, name, selectedColor);

	if (mode === 'host') {
		sessionInfo.textContent = `Hosting  •  ${ip}`;
		sessionInfo.className = 'hosting';
	} else {
		sessionInfo.textContent = `Connected to ${ip}  •  ${name}`;
		sessionInfo.className = 'connected';
	}
	sessionInfo.style.display = 'block';
	overlay.style.display = 'none';
	window.electronAPI.createPty(term.cols, term.rows);
}

document.getElementById('btn-enter').addEventListener('click', enterIDE);
document.getElementById('user-name-input').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') enterIDE();
});

// --- Session buttons ---
document.getElementById('btn-host').addEventListener('click', () => {
	sessionStatus.textContent = 'Starting server...';
	window.electronAPI.hostSession();
});

document.getElementById('btn-join').addEventListener('click', () => {
	document.getElementById('session-buttons').style.display = 'none';
	document.getElementById('join-form').style.display = 'flex';
});

document.getElementById('btn-solo').addEventListener('click', () => {
	window.electronAPI.soloSession();
});

document.getElementById('btn-connect').addEventListener('click', () => {
	const raw = document.getElementById('host-ip-input').value.trim();
	if (!raw) return;
	const ip = raw.split(':')[0];
	sessionStatus.textContent = 'Connecting...';
	window.electronAPI.joinSession(ip);
});

document.getElementById('btn-back').addEventListener('click', () => {
	document.getElementById('join-form').style.display = 'none';
	document.getElementById('session-buttons').style.display = 'flex';
	sessionStatus.textContent = '';
});

document.getElementById('host-ip-input').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') document.getElementById('btn-connect').click();
});

// --- Session events from main process ---
window.electronAPI.onSessionStarted(({ ip, yPort }) => {
	pendingSession = { wsUrl: `ws://localhost:${yPort}`, mode: 'host', ip, defaultName: 'Host' };
	showIdentityPicker('Host');
});

window.electronAPI.onSessionConnected(({ ip, yPort }) => {
	pendingSession = { wsUrl: `ws://${ip}:${yPort}`, mode: 'guest', ip, defaultName: 'Guest' };
	showIdentityPicker('Guest');
});

window.electronAPI.onSessionSoloStarted(() => {
	sessionMode = 'solo';
	overlay.style.display = 'none';
	window.electronAPI.createPty(term.cols, term.rows);
});

window.electronAPI.onSessionError((msg) => {
	sessionStatus.textContent = `Error: ${msg}`;
	sessionStatus.classList.add('error');
	document.getElementById('join-form').style.display = 'none';
	document.getElementById('session-buttons').style.display = 'flex';
});

window.electronAPI.onGuestJoined((_sid) => {
	guestCount++;
	sessionInfo.textContent = `Hosting  •  ${guestCount} guest${guestCount !== 1 ? 's' : ''} connected`;
});

window.electronAPI.onGuestLeft((_sid) => {
	guestCount = Math.max(0, guestCount - 1);
	sessionInfo.textContent = guestCount > 0
		? `Hosting  •  ${guestCount} guest${guestCount !== 1 ? 's' : ''} connected`
		: `Hosting  •  no guests`;
});

// --- File Events ---
const renderFileTree = (folderPath, fileTree) => {
	const cont = document.getElementById('file-tree');
	cont.innerHTML = '';
	const renderNodes = (nodes, parent) => {
		nodes.forEach(node => {
			const li = document.createElement('li');
			li.textContent = node.name;
			parent.appendChild(li);
			if (node.isDirectory && node.children) {
				const ul = document.createElement('ul');
				ul.style.display = 'none';
				li.appendChild(ul);
				renderNodes(node.children, ul);
				li.addEventListener('click', (e) => {
					e.stopPropagation();
					ul.style.display = ul.style.display === 'none' ? 'block' : 'none';
				});
			} else {
				li.addEventListener('click', () => window.electronAPI.selectFile(node.path));
			}
		});
	};
	renderNodes(fileTree, cont);
};

window.electronAPI.onOpenFolder(({ folderPath, fileTree }) => {
	if (provider) {
		yFileTree.set('folderPath', folderPath);
		yFileTree.set('tree', fileTree);
	}
	renderFileTree(folderPath, fileTree);
});

window.electronAPI.onOpenFile(({ filePath, content }) => {
	currentFilePath = filePath;
	const ext = filePath.split('.').pop().toLowerCase();
	const language = extToLanguage[ext] || 'plaintext';

	// Create or reuse Y.Text for this file
	let yText = yFiles.get(filePath);
	if (!yText) {
		yText = new Y.Text();
		yFiles.set(filePath, yText);
	}
	// Only insert content if Y.Text is empty (first open)
	if (yText.length === 0 && content.length > 0) {
		yText.insert(0, content);
	}

	// Sync active file to all clients (if Yjs is connected)
	if (provider) {
		yState.set('activeFile', { filePath, language });
	}

	const newModel = monaco.editor.createModel('', language);
	const oldModel = editor.getModel();
	editor.setModel(newModel);
	if (oldModel) oldModel.dispose();
	if (monacoBinding) monacoBinding.destroy();
	monacoBinding = new MonacoBinding(yText, newModel, new Set([editor]), provider?.awareness);
});

window.electronAPI.onSaveFile((mode) => {
	const content = editor.getValue();
	window.electronAPI.sendContent(mode, content);
});

// --- Run Button ---
document.getElementById('run-btn').addEventListener('click', () => {
	const code = editor.getValue();
	window.electronAPI.runFile(code, currentFilePath);
	term.focus();
});
