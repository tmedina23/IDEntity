import React, { useState, useEffect, useRef, useCallback } from "react";
import * as monaco from "monaco-editor";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./IDE.css";
import banner_logo from './images/Banner2.png';

self.MonacoEnvironment = {
  getWorkerUrl(moduleId, label) {
    if (label === "json"){
      return "./json.worker.bundle.js";
    }
    if (label === "css" || label === "scss" || label === "less"){
      return "./css.worker.bundle.js";
    }
    if (label === "html" || label === "handlebars" || label === "razor"){
      return "./html.worker.bundle.js";
    }
    if (label === "typescript" || label === "javascript"){
      return "./ts.worker.bundle.js";
    }
      return "./editor.worker.bundle.js";
    },
};

const EXT_TO_LANG = {
  js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
  json: "json", css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", py: "python", md: "markdown",
};

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="run-icon">
    <path d="M3 2.5l10 5.5-10 5.5V2.5z"/>
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="run-icon">
    <rect x="3" y="3" width="10" height="10" rx="1"/>
  </svg>
);

function FileIcon({ name = "" }) {
  const ext = name.split(".").pop().toLowerCase();
  const colors = {
    ts:"#3178c6", tsx:"#61dafb", js:"#f7df1e", jsx:"#61dafb",
    json:"#cbcb41", css:"#42a5f5", scss:"#c76494", py:"#4584b6",
    md:"#7a8090", html:"#e34c26",
  };
  return <span style={{ color: colors[ext] || "#7a8090", fontSize: 10 }}>◆</span>;
}

function TreeNode({ node, depth = 0, activeFilePath, onSelect }) {
  const [open, setOpen] = useState(false);
  const isActive = !node.isDirectory && node.path === activeFilePath;

  if (node.isDirectory) {
    return (
      <div>
        <div
          className="tree-node dir"
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => setOpen(o => !o)}
        >
          <span className="node-icon" style={{ color: "#f2c94c", fontSize: 11 }}>
            {open ? "▾ 📂" : "▸ 📁"}
          </span>
          {node.name}
        </div>
        {open && node.children && (
          <div className="tree-children">
            {node.children.map(c => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                activeFilePath={activeFilePath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`tree-node ${isActive ? "active" : ""}`}
      style={{ paddingLeft: 12 + depth * 14 }}
      onClick={() => onSelect(node.path)}
    >
      <span className="node-icon"><FileIcon name={node.name} /></span>
      {node.name}
    </div>
  );
}

export default function App() {
  const [fileTree,       setFileTree]       = useState([]);
  const [tabs,           setTabs]           = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [folderName,     setFolderName]     = useState(null);
  const [cursorPos,      setCursorPos]      = useState({ line: 1, col: 1 });
  const [language,       setLanguage]       = useState("plaintext");
  const [running,        setRunning]        = useState(false);
  const [termHeight,     setTermHeight]     = useState(220);

  const monacoContainerRef = useRef(null);
  const xtermContainerRef  = useRef(null);

  const editorRef   = useRef(null);
  const termRef     = useRef(null);
  const fitAddonRef = useRef(null);

  const activeFilePathRef = useRef(null);
  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  useEffect(() => {
    // create editor
    const editor = monaco.editor.create(monacoContainerRef.current, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderLineHighlight: "all",
      smoothScrolling: true,
    });
    editorRef.current = editor;

    editor.onDidChangeCursorPosition(e => {
      setCursorPos({ line: e.position.lineNumber, col: e.position.column });
    });

    editor.onDidChangeModelContent(() => {
      setTabs(prev => prev.map(t =>
        t.path === activeFilePathRef.current ? { ...t, modified: true } : t
      ));
    });

    window.electronAPI.onOpenFile(({ filePath, content }) => {
      const name = filePath.split(/[\\/]/).pop();
      const ext  = name.split(".").pop().toLowerCase();
      const lang = EXT_TO_LANG[ext] || "plaintext";

      setLanguage(lang);
      setActiveFilePath(filePath);
      activeFilePathRef.current = filePath;

      setTabs(prev => {
        if (prev.find(t => t.path === filePath)) {
          return prev.map(t => t.path === filePath ? { ...t, modified: false } : t);
        }
        return [...prev, { path: filePath, name, modified: false }];
      });

      const newModel = monaco.editor.createModel(content, lang);
      const oldModel = editor.getModel();
      editor.setModel(newModel);
      editor.focus();
      oldModel?.dispose();
    });

    window.electronAPI.onOpenFolder(({ folderPath, fileTree }) => {
      setFileTree(fileTree);
      setFolderName(folderPath.split(/[\\/]/).pop());
    });

    window.electronAPI.onSaveFile((mode) => {
      const content = editor.getValue();
      window.electronAPI.sendContent(mode, content);
      setTabs(prev => prev.map(t =>
        t.path === activeFilePathRef.current ? { ...t, modified: false } : t
      ));
    });

    return () => editor.dispose();
  }, []);

  // boot xterm
  useEffect(() => {
    const term = new Terminal({
      theme: { background: "#111111", foreground: "#d4d4d4", cursor: "#4af2a1" },
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontSize: 13,
      scrollback: 1000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermContainerRef.current);
    fitAddon.fit();

    termRef.current    = term;
    fitAddonRef.current = fitAddon;

    term.onData(data => window.electronAPI.writePty(data));

    window.electronAPI.onPtyData(data => term.write(data));

    window.electronAPI.onPtyExit(() => {
      term.writeln("\r\n\x1b[33m[process exited]\x1b[0m");
      setRunning(false);
    });

    window.electronAPI.createPty(term.cols, term.rows);

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      window.electronAPI.resizePty(term.cols, term.rows);
    });
    ro.observe(xtermContainerRef.current);

    return () => {
      term.dispose();
      ro.disconnect();
    };
  }, []);

  // run button
  const handleRun = useCallback(() => {
    if (!editorRef.current) return;
    const code = editorRef.current.getValue();
    window.electronAPI.runFile(code, activeFilePathRef.current);
    termRef.current?.focus();
    setRunning(true);
    setTimeout(() => setRunning(false), 30_000);
  }, []);

  // tabs
  const handleTabClick = useCallback((path) => {
    window.electronAPI.selectFile(path);
  }, []);

  const handleTabClose = useCallback((e, path) => {
    e.stopPropagation();
    setTabs(prev => {
      const next = prev.filter(t => t.path !== path);
      if (activeFilePathRef.current === path) {
        if (next.length > 0) {
          window.electronAPI.selectFile(next[next.length - 1].path);
        } else {
          setActiveFilePath(null);
          activeFilePathRef.current = null;
          const blank = monaco.editor.createModel("", "plaintext");
          const old   = editorRef.current?.getModel();
          editorRef.current?.setModel(blank);
          old?.dispose();
        }
      }
      return next;
    });
  }, []);

  const handleResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = termHeight;
    const onMove = (ev) => {
      setTermHeight(Math.max(80, Math.min(600, startH + (startY - ev.clientY))));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
      fitAddonRef.current?.fit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, [termHeight]);

  const breadcrumbs = activeFilePath
    ? activeFilePath.replace(/\\/g, "/").split("/").slice(-3)
    : [];

  // render
  return (
    <>
      <div className="ide-shell" style={{ "--term-h": `${termHeight}px` }}>

        <header className="toolbar">
          <div className="toolbar-brand">
            <img src={banner_logo} alt="IDEntity"/>
          </div>
          <nav className="menu-bar">
            {["File", "Edit", "View", "Window"].map(m => (
              <div key={m} className="menu-item">{m}</div>
            ))}
          </nav>
          <div className="toolbar-spacer" />
          <button
            className={`run-btn ${running ? "running" : ""}`}
            onClick={handleRun}
            disabled={!activeFilePath}
            title="Run file via Python"
          >
            {running ? <StopIcon /> : <PlayIcon />}
            {running ? "Running…" : "Run File"}
          </button>
          <div className="toolbar-actions">
            <button className="icon-btn" title="Settings">⚙</button>
            <button className="icon-btn" title="Split editor">◫</button>
          </div>
        </header>

        <aside className="sidebar">
          <div className="sidebar-tabs">
            {["EXPLORER", "SEARCH", "GIT"].map(t => (
              <div key={t} className={`sidebar-tab ${t === "EXPLORER" ? "active" : ""}`}>{t}</div>
            ))}
          </div>
          <div className="sidebar-header">{folderName || "No folder open"}</div>
          <div className="file-tree">
            {fileTree.length === 0 ? (
              <div style={{ padding: "12px", color: "var(--text-dim)", fontSize: 11 }}>
                Open a folder to browse files
              </div>
            ) : (
              fileTree.map(node => (
                <TreeNode
                  key={node.path}
                  node={node}
                  activeFilePath={activeFilePath}
                  onSelect={(path) => window.electronAPI.selectFile(path)}
                />
              ))
            )}
          </div>
        </aside>

        <main className="editor-area">
          <div className="tab-bar">
            {tabs.map(tab => (
              <div
                key={tab.path}
                className={`tab ${tab.path === activeFilePath ? "active" : ""}`}
                onClick={() => handleTabClick(tab.path)}
                title={tab.path}
              >
                {tab.modified && <span className="tab-modified" title="Unsaved changes" />}
                <FileIcon name={tab.name} />
                {tab.name}
                <span className="tab-close" onClick={e => handleTabClose(e, tab.path)}>✕</span>
              </div>
            ))}
          </div>

          <div className="breadcrumb">
            {activeFilePath ? breadcrumbs.map((seg, i) => (
              <span key={i}>
                {i > 0 && <span className="sep"> › </span>}
                <span className={i === breadcrumbs.length - 1 ? "cur" : ""}>{seg}</span>
              </span>
            )) : (
              <span style={{ color: "var(--text-dim)" }}>No file open</span>
            )}
          </div>

          <div
            ref={monacoContainerRef}
            className={`monaco-container${activeFilePath ? "" : " hidden"}`}
          />
          {!activeFilePath && (
            <div className="no-file">
              <span>No file open</span>
              <span className="no-file-hint">Open a file or folder from the File menu</span>
            </div>
          )}
        </main>

        <div
          style={{
            gridColumn: 2, gridRow: 3, alignSelf: "start",
            height: 5, background: "var(--border)",
            cursor: "ns-resize", zIndex: 10,
            transition: "background .15s",
          }}
          onMouseDown={handleResizeMouseDown}
          onMouseEnter={e => e.currentTarget.style.background = "var(--accent-dim)"}
          onMouseLeave={e => e.currentTarget.style.background = "var(--border)"}
        />

        <section className="terminal-area">
          <div className="term-header">
            {["TERMINAL", "PROBLEMS", "OUTPUT"].map(t => (
              <div key={t} className={`term-tab ${t === "TERMINAL" ? "active" : ""}`}>{t}</div>
            ))}
            <div className="term-spacer" />
            <div className="term-ctrl">
              <span
                className="term-icon"
                title="New terminal"
                onClick={() => window.electronAPI.createPty(termRef.current?.cols, termRef.current?.rows)}
              >＋</span>
              <span
                className="term-icon"
                title="Clear terminal"
                onClick={() => termRef.current?.clear()}
              >⊟</span>
              <span
                className="term-icon"
                title="Kill pty"
                onClick={() => window.electronAPI.killPty()}
              >✕</span>
            </div>
          </div>

          <div ref={xtermContainerRef} className="xterm-container" />
        </section>

        <footer className="status-bar">
          <div className="status-item">⎇ main</div>
          <span className="status-sep">│</span>
          <div className="status-item">
            <span style={{ color: "var(--red)" }}>✕</span> 0 &nbsp;
            <span style={{ color: "var(--yellow)" }}>⚠</span> 0
          </div>
          <span className="status-sep">│</span>
          <div className="status-item">{language}</div>
          <div className="status-right">
            <div className="status-item">Ln {cursorPos.line}, Col {cursorPos.col}</div>
            <span className="status-sep">│</span>
            <div className="status-item">UTF-8</div>
            <span className="status-sep">│</span>
            <div className="status-item">LF</div>
            <span className="status-sep">│</span>
            <div
              className="status-item"
              style={{ color: running ? "var(--yellow)" : "var(--accent)", fontWeight: 700 }}
            >
              {running ? "● Running" : "● Ready"}
            </div>
          </div>
        </footer>

      </div>
    </>
  );
}