import * as monaco from 'monaco-editor';

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

const editor = monaco.editor.create(document.getElementById('container'), {
	value: ['function x() {', '\tconsole.log("Hello world!");', '}'].join('\n'),
	language: 'javascript',
	theme: 'vs-dark',
});

const extToLanguage = {
	js: 'javascript', ts: 'typescript',
	json: 'json', css: 'css', scss: 'scss',
	less: 'less', html: 'html', xml: 'xml',
	py: 'python', md: 'markdown',
};

window.electronAPI.onOpenFile(({ filePath, content }) => {
	console.log("Opening: " + filePath)
	const extension = filePath.split('.').pop().toLowerCase();
	const language = extToLanguage[extension] || 'plaintext';

	const newModel = monaco.editor.createModel(content, language);
	const oldModel = editor.getModel();
	editor.setModel(newModel);
	oldModel.dispose();
});

window.electronAPI.onSaveFile((mode) => {
	const content = editor.getValue();
	console.log("Saving content with mode: " + mode);
	window.electronAPI.sendContent(mode, content);
});