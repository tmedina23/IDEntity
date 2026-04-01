import * as monaco from 'monaco-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

self.MonacoEnvironment = {
	getWorkerUrl: function (moduleId, label) {
		if (label === 'json') {
			return './json.worker.bundle.js';
		}
		if (label === 'css' || label === 'scss' || label === 'less') {
			return './css.worker.bundle.js';
		}
		if (label === 'html' || label === 'handlebars' || label === 'razor') {
			return './html.worker.bundle.js';
		}
		if (label === 'typescript' || label === 'javascript') {
			return './ts.worker.bundle.js';
		}
		return './editor.worker.bundle.js';
	}
};

// --- Monaco Editor ---
const editor = monaco.editor.create(document.getElementById('container'), {
	value: ['function x() {', '\tconsole.log("Hello world!");', '}'].join('\n'),
	language: 'javascript',
	theme: 'vs-dark',
});

var parentElement = document.getElementById('terminal');

if (parentElement) {
    var term = new Terminal();
    term.open(parentElement);
    term.write('Hello from the IDEntity terminal!\r\n');
} else {
    console.error('Parent element #terminal-container not found in the DOM.');
}

const extToLanguage = {
	js: 'javascript', ts: 'typescript',
	json: 'json', css: 'css', scss: 'scss',
	less: 'less', html: 'html', xml: 'xml',
	py: 'python', md: 'markdown',
};

let currentFilePath = null;

window.electronAPI.onOpenFile(({ filePath, content }) => {
	currentFilePath = filePath;
	const extension = filePath.split('.').pop().toLowerCase();
	const language = extToLanguage[extension] || 'plaintext';

	const newModel = monaco.editor.createModel(content, language);
	const oldModel = editor.getModel();
	editor.setModel(newModel);
	oldModel.dispose();
});

window.electronAPI.onOpenFolder(({ folderPath, fileTree }) => {
	const cont = document.getElementById('file-tree');
	cont.innerHTML = '';

	const renderTree = (nodes, parent) => {
		nodes.forEach(node => {
			const li = document.createElement('li');
			li.textContent = node.name;
			parent.appendChild(li);

			if (node.isDirectory) {
				li.textContent += '/';
			} 
			if (node.isDirectory && node.children) {
				const ul = document.createElement('ul');
				ul.style.display = 'none';
				li.appendChild(ul);
				renderTree(node.children, ul);

				li.addEventListener('click', (e) => {
					e.stopPropagation();
					ul.style.display = ul.style.display === 'none' ? 'block' : 'none';
				});
			} else {
				li.addEventListener('click', () => {
					window.electronAPI.selectFile(node.path);
				});
			}
		});
	};
	renderTree(fileTree, cont);
});

window.electronAPI.onSaveFile((mode) => {
	const content = editor.getValue();
	window.electronAPI.sendContent(mode, content);
});

// --- xterm.js Terminal ---
const term = new Terminal({
	theme: {
		background: '#111111',
		foreground: '#d4d4d4',
		cursor: '#d4d4d4',
	},
	fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
	fontSize: 13,
	scrollback: 1000,
	convertEol: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

// Send keystrokes from xterm to pty
term.onData(data => {
	window.electronAPI.writePty(data);
});

// Receive output from pty and write to xterm
window.electronAPI.onPtyData(data => {
	term.write(data);
});

window.electronAPI.onPtyExit(() => {
	term.writeln('\r\n\x1b[33m[process exited]\x1b[0m');
});

// Start the pty shell
window.electronAPI.createPty(term.cols, term.rows);

// Keep terminal sized to its container
const resizeObserver = new ResizeObserver(() => {
	fitAddon.fit();
	window.electronAPI.resizePty(term.cols, term.rows);
});
resizeObserver.observe(document.getElementById('terminal'));

// --- Run Button ---
const runBtn = document.getElementById('run-btn');

runBtn.addEventListener('click', () => {
	const code = editor.getValue();
	// Always pass current editor content — main process writes to temp file
	window.electronAPI.runFile(code, currentFilePath);
	// Focus the terminal so the user can see output / interact
	term.focus();
});
