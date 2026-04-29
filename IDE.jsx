import React, { useState, useEffect, useRef, useCallback } from "react";
import * as monaco from "monaco-editor";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";
import "./IDE.css";
import banner_logo from "./images/Banner2.png";

self.MonacoEnvironment = {
  getWorkerUrl(moduleId, label) {
    if (label === "json") return "./json.worker.bundle.js";
    if (label === "css" || label === "scss" || label === "less") return "./css.worker.bundle.js";
    if (label === "html" || label === "handlebars" || label === "razor") return "./html.worker.bundle.js";
    if (label === "typescript" || label === "javascript") return "./ts.worker.bundle.js";
    return "./editor.worker.bundle.js";
  },
};

const EXT_TO_LANG = {
  js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
  json: "json", css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", py: "python", md: "markdown",
};

const PRESET_COLORS = ["#e74c3c","#e67e22","#f1c40f","#2ecc71","#1abc9c","#3498db","#9b59b6","#e91e8c"];

function clientColor(clientID) {
  return `hsl(${Math.round((clientID * 137.508) % 360)}, 80%, 60%)`;
}

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
              <TreeNode key={c.path} node={c} depth={depth + 1} activeFilePath={activeFilePath} onSelect={onSelect} />
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
  // --- IDE state ---
  const [fileTree,       setFileTree]       = useState([]);
  const [tabs,           setTabs]           = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [folderName,     setFolderName]     = useState(null);
  const [cursorPos,      setCursorPos]      = useState({ line: 1, col: 1 });
  const [language,       setLanguage]       = useState("plaintext");
  const [running,        setRunning]        = useState(false);
  const [termHeight,     setTermHeight]     = useState(220);

  // --- Menu dropdown state ---
  const [openMenu, setOpenMenu] = useState(null); // 'file' | 'edit' | 'view' | 'window' | null

  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = useCallback((name) => setOpenMenu(o => o === name ? null : name), []);

  // --- Session state ---
  const [sessionMode,     setSessionMode]     = useState(null); // null=overlay, 'solo','host','guest'
  const [overlayPanel,    setOverlayPanel]    = useState("main"); // 'main','join','identity'
  const [pendingSession,  setPendingSession]  = useState(null);
  const [userName,        setUserName]        = useState("");
  const [selectedColor,   setSelectedColor]   = useState(PRESET_COLORS[0]);
  const [hostIpInput,     setHostIpInput]     = useState("");
  const [sessionError,    setSessionError]    = useState("");
  const [guestCount,      setGuestCount]      = useState(0);
  const [sessionIp,       setSessionIp]       = useState("");
  const [sessionReady,    setSessionReady]    = useState(false);

  // --- DOM refs ---
  const monacoContainerRef = useRef(null);
  const xtermContainerRef  = useRef(null);

  // --- Instance refs ---
  const editorRef         = useRef(null);
  const termRef           = useRef(null);
  const fitAddonRef       = useRef(null);
  const activeFilePathRef = useRef(null);
  const cursorStyleRef    = useRef(null);

  // --- Yjs refs ---
  const ydocRef          = useRef(new Y.Doc());
  const providerRef      = useRef(null);
  const monacoBindingRef = useRef(null);

  const ydoc      = ydocRef.current;
  const yFiles    = ydoc.getMap("files");
  const yFileTree = ydoc.getMap("fileTree");
  const yState    = ydoc.getMap("state");

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  // --- Cursor style injection ---
  useEffect(() => {
    const el = document.createElement("style");
    document.head.appendChild(el);
    cursorStyleRef.current = el;
    return () => el.remove();
  }, []);

  function updateCursorStyles(awareness) {
    if (!cursorStyleRef.current) return;
    const rules = [];
    awareness.getStates().forEach((state, clientID) => {
      if (clientID === awareness.doc.clientID) return;
      const color = state.user?.color || clientColor(clientID);
      const name  = state.user?.name  || "Guest";
      rules.push(`.yRemoteSelection-${clientID} { background-color: ${color}44; }`);
      rules.push(`.yRemoteSelectionHead-${clientID} { border-color: ${color}; }`);
      rules.push(`.yRemoteSelectionHead-${clientID}::before { background: ${color}; color: #111; content: "${name}"; }`);
    });
    cursorStyleRef.current.textContent = rules.join("\n");
  }

  // --- Open a file already synced in the Yjs doc (guests / yState changes) ---
  function openSharedFile(filePath, language) {
    const yText = yFiles.get(filePath);
    if (!yText || !editorRef.current) return;

    const name = filePath.split(/[\\/]/).pop();
    const lang = language || "plaintext";

    activeFilePathRef.current = filePath;
    setActiveFilePath(filePath);
    setLanguage(lang);
    setTabs(prev => prev.find(t => t.path === filePath) ? prev : [...prev, { path: filePath, name, modified: false }]);

    const newModel = monaco.editor.createModel("", lang);
    const oldModel = editorRef.current.getModel();
    editorRef.current.setModel(newModel);
    oldModel?.dispose();

    monacoBindingRef.current?.destroy();
    monacoBindingRef.current = new MonacoBinding(
      yText, newModel, new Set([editorRef.current]), providerRef.current?.awareness
    );
  }

  // --- Connect to Yjs server ---
  function connectYjs(wsUrl, name, color) {
    const provider = new WebsocketProvider(wsUrl, "identity", ydoc);
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", { name, color });
    provider.awareness.on("change", () => updateCursorStyles(provider.awareness));

    provider.on("sync", () => {
      const tree       = yFileTree.get("tree");
      const folderPath = yFileTree.get("folderPath");
      if (tree && folderPath) {
        setFileTree(tree);
        setFolderName(folderPath.split(/[\\/]/).pop());
      }
      const activeFile = yState.get("activeFile");
      if (activeFile && activeFile.filePath !== activeFilePathRef.current) {
        openSharedFile(activeFile.filePath, activeFile.language);
      }
    });

    yFileTree.observe(() => {
      const tree       = yFileTree.get("tree");
      const folderPath = yFileTree.get("folderPath");
      if (tree && folderPath) {
        setFileTree(tree);
        setFolderName(folderPath.split(/[\\/]/).pop());
      }
    });

    yState.observe(() => {
      const activeFile = yState.get("activeFile");
      if (activeFile && activeFile.filePath !== activeFilePathRef.current) {
        openSharedFile(activeFile.filePath, activeFile.language);
      }
    });
  }

  // --- Identity picker confirm ---
  function enterIDE() {
    const name = userName.trim() || pendingSession.defaultName;
    const { wsUrl, mode, ip } = pendingSession;
    if (mode !== "solo") connectYjs(wsUrl, name, selectedColor);
    setSessionMode(mode);
    setSessionIp(ip || "");
    setSessionReady(true);
  }

  function handleConnect() {
    const ip = hostIpInput.trim().split(":")[0];
    if (!ip) return;
    setSessionError("");
    window.electronAPI.joinSession(ip);
  }

  // --- Keyboard shortcuts + click-outside to close menus ---
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'o' && !e.shiftKey) { e.preventDefault(); window.electronAPI.openFile(); }
      if (e.key === 'O' &&  e.shiftKey) { e.preventDefault(); window.electronAPI.openFolder(); }
      if (e.key === 's' && !e.shiftKey) { e.preventDefault(); window.electronAPI.triggerSave(); }
      if (e.key === 'S' &&  e.shiftKey) { e.preventDefault(); window.electronAPI.triggerSaveAs(); }
    };
    const onClickOutside = () => setOpenMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('click',   onClickOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click',   onClickOutside);
    };
  }, []);

  // --- Session IPC events ---
  useEffect(() => {
    window.electronAPI.onSessionStarted(({ ip, yPort }) => {
      setPendingSession({ wsUrl: `ws://localhost:${yPort}`, mode: "host", ip, defaultName: "Host" });
      setUserName("Host");
      setOverlayPanel("identity");
    });

    window.electronAPI.onSessionConnected(({ ip, yPort }) => {
      setPendingSession({ wsUrl: `ws://${ip}:${yPort}`, mode: "guest", ip, defaultName: "Guest" });
      setUserName("Guest");
      setOverlayPanel("identity");
    });

    window.electronAPI.onSessionSoloStarted(() => {
      setPendingSession({ mode: "solo", defaultName: "Solo" });
      setSessionMode("solo");
      setSessionReady(true);
    });

    window.electronAPI.onSessionError((msg) => {
      setSessionError(msg);
      setOverlayPanel("join");
    });

    window.electronAPI.onGuestJoined(() => setGuestCount(c => c + 1));
    window.electronAPI.onGuestLeft(()  => setGuestCount(c => Math.max(0, c - 1)));
  }, []);

  // --- Start PTY once session is ready ---
  useEffect(() => {
    if (sessionReady && termRef.current) {
      window.electronAPI.createPty(termRef.current.cols, termRef.current.rows);
    }
  }, [sessionReady]);

  // --- Monaco editor setup ---
  useEffect(() => {
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
        if (prev.find(t => t.path === filePath)) return prev.map(t => t.path === filePath ? { ...t, modified: false } : t);
        return [...prev, { path: filePath, name, modified: false }];
      });

      if (providerRef.current) {
        // Collaborative mode — bind Monaco to Y.Text
        let yText = yFiles.get(filePath);
        if (!yText) {
          yText = new Y.Text();
          yFiles.set(filePath, yText);
        }
        if (yText.length === 0 && content.length > 0) yText.insert(0, content);
        yState.set("activeFile", { filePath, language: lang });

        const newModel = monaco.editor.createModel("", lang);
        const oldModel = editor.getModel();
        editor.setModel(newModel);
        editor.focus();
        oldModel?.dispose();

        monacoBindingRef.current?.destroy();
        monacoBindingRef.current = new MonacoBinding(
          yText, newModel, new Set([editor]), providerRef.current.awareness
        );
      } else {
        // Solo mode — vanilla Monaco
        const newModel = monaco.editor.createModel(content, lang);
        const oldModel = editor.getModel();
        editor.setModel(newModel);
        editor.focus();
        oldModel?.dispose();
      }
    });

    window.electronAPI.onOpenFolder(({ folderPath, fileTree }) => {
      setFileTree(fileTree);
      setFolderName(folderPath.split(/[\\/]/).pop());
      if (providerRef.current) {
        yFileTree.set("folderPath", folderPath);
        yFileTree.set("tree", fileTree);
      }
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

  // --- xterm terminal setup ---
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

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      window.electronAPI.resizePty(term.cols, term.rows);
    });
    ro.observe(xtermContainerRef.current);

    return () => { term.dispose(); ro.disconnect(); };
  }, []);

  // --- Handlers ---
  const handleRun = useCallback(() => {
    if (!editorRef.current) return;
    window.electronAPI.runFile(editorRef.current.getValue(), activeFilePathRef.current);
    termRef.current?.focus();
    setRunning(true);
    setTimeout(() => setRunning(false), 30_000);
  }, []);

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
    const onMove = (ev) => setTermHeight(Math.max(80, Math.min(600, startH + (startY - ev.clientY))));
    const onUp   = () => {
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

  const sessionBadge = sessionMode && sessionMode !== "solo"
    ? sessionMode === "host"
      ? `Hosting  •  ${guestCount > 0 ? `${guestCount} guest${guestCount !== 1 ? "s" : ""}` : "no guests"}`
      : `Connected to ${sessionIp}`
    : null;

  return (
    <>
      {/* Session overlay — shown until a mode is chosen and identity confirmed */}
      {sessionMode === null && (
        <div className="session-overlay">
          <div className="session-modal">
            <div className="session-logo">IDEntity</div>
            <div className="session-subtitle">collaborative IDE</div>

            {overlayPanel === "main" && (
              <div className="session-btns">
                <button className="s-btn primary" onClick={() => window.electronAPI.hostSession()}>
                  Host Session
                </button>
                <button className="s-btn" onClick={() => setOverlayPanel("join")}>
                  Join Session
                </button>
                <button className="s-btn secondary" onClick={() => window.electronAPI.soloSession()}>
                  Solo Mode
                </button>
                {sessionError && <div className="session-err">{sessionError}</div>}
              </div>
            )}

            {overlayPanel === "join" && (
              <div className="session-btns">
                <input
                  className="session-input"
                  type="text"
                  placeholder="Host IP address"
                  value={hostIpInput}
                  onChange={e => setHostIpInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleConnect()}
                  autoFocus
                />
                {sessionError && <div className="session-err">{sessionError}</div>}
                <button className="s-btn primary" onClick={handleConnect}>Connect</button>
                <button className="s-btn secondary" onClick={() => { setOverlayPanel("main"); setSessionError(""); }}>
                  Back
                </button>
              </div>
            )}

            {overlayPanel === "identity" && (
              <div className="session-btns">
                <div className="identity-title">Choose your identity</div>
                <input
                  className="session-input"
                  type="text"
                  placeholder="Your name"
                  maxLength={20}
                  value={userName}
                  onChange={e => setUserName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && enterIDE()}
                  autoFocus
                />
                <div className="color-swatches">
                  {PRESET_COLORS.map(color => (
                    <div
                      key={color}
                      className={`color-swatch ${selectedColor === color ? "selected" : ""}`}
                      style={{ background: color }}
                      onClick={() => setSelectedColor(color)}
                    />
                  ))}
                </div>
                <button className="s-btn primary" onClick={enterIDE}>Enter IDE</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main IDE */}
      <div className="ide-shell" style={{ "--term-h": `${termHeight}px` }}>

        <header className="toolbar">
          <div className="toolbar-brand">
            <img src={banner_logo} alt="IDEntity" />
          </div>
          <nav className="menu-bar" onClick={e => e.stopPropagation()}>

            {/* File */}
            <div className="menu-item-wrap">
              <div className={`menu-item ${openMenu === "file" ? "active" : ""}`} onClick={() => toggleMenu("file")}>File</div>
              {openMenu === "file" && (
                <div className="dropdown">
                  <div className="dd-item" onClick={() => { closeMenu(); window.electronAPI.openFile(); }}>
                    Open File <span className="dd-shortcut">Ctrl+O</span>
                  </div>
                  <div className="dd-item" onClick={() => { closeMenu(); window.electronAPI.openFolder(); }}>
                    Open Folder <span className="dd-shortcut">Ctrl+Shift+O</span>
                  </div>
                  <div className="dd-sep" />
                  <div className="dd-item" onClick={() => { closeMenu(); window.electronAPI.triggerSave(); }}>
                    Save <span className="dd-shortcut">Ctrl+S</span>
                  </div>
                  <div className="dd-item" onClick={() => { closeMenu(); window.electronAPI.triggerSaveAs(); }}>
                    Save As <span className="dd-shortcut">Ctrl+Shift+S</span>
                  </div>
                  <div className="dd-sep" />
                  <div className="dd-item danger" onClick={() => { closeMenu(); window.electronAPI.quit(); }}>Quit</div>
                </div>
              )}
            </div>

            {/* Edit */}
            <div className="menu-item-wrap">
              <div className={`menu-item ${openMenu === "edit" ? "active" : ""}`} onClick={() => toggleMenu("edit")}>Edit</div>
              {openMenu === "edit" && (
                <div className="dropdown">
                  <div className="dd-item" onClick={() => { closeMenu(); document.execCommand("cut"); }}>Cut <span className="dd-shortcut">Ctrl+X</span></div>
                  <div className="dd-item" onClick={() => { closeMenu(); document.execCommand("copy"); }}>Copy <span className="dd-shortcut">Ctrl+C</span></div>
                  <div className="dd-item" onClick={() => { closeMenu(); document.execCommand("paste"); }}>Paste <span className="dd-shortcut">Ctrl+V</span></div>
                  <div className="dd-sep" />
                  <div className="dd-item" onClick={() => { closeMenu(); editorRef.current?.trigger("", "undo"); }}>Undo <span className="dd-shortcut">Ctrl+Z</span></div>
                  <div className="dd-item" onClick={() => { closeMenu(); editorRef.current?.trigger("", "redo"); }}>Redo <span className="dd-shortcut">Ctrl+Y</span></div>
                </div>
              )}
            </div>

            {/* View */}
            <div className="menu-item-wrap">
              <div className={`menu-item ${openMenu === "view" ? "active" : ""}`} onClick={() => toggleMenu("view")}>View</div>
              {openMenu === "view" && (
                <div className="dropdown">
                  <div className="dd-item" onClick={() => { closeMenu(); editorRef.current?.trigger("", "editor.action.toggleMinimap"); }}>Toggle Minimap</div>
                  <div className="dd-item" onClick={() => { closeMenu(); editorRef.current?.trigger("", "editor.action.toggleWordWrap"); }}>Toggle Word Wrap</div>
                </div>
              )}
            </div>

            {/* Window */}
            <div className="menu-item-wrap">
              <div className={`menu-item ${openMenu === "window" ? "active" : ""}`} onClick={() => toggleMenu("window")}>Window</div>
              {openMenu === "window" && (
                <div className="dropdown">
                  <div className="dd-item" onClick={() => { closeMenu(); window.electronAPI.quit(); }}>Close</div>
                </div>
              )}
            </div>

          </nav>
          <div className="toolbar-spacer" />
          {sessionBadge && (
            <div className={`session-badge ${sessionMode}`}>{sessionBadge}</div>
          )}
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

          <div ref={monacoContainerRef} className={`monaco-container${activeFilePath ? "" : " hidden"}`} />
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
              <span className="term-icon" title="New terminal"
                onClick={() => window.electronAPI.createPty(termRef.current?.cols, termRef.current?.rows)}>＋</span>
              <span className="term-icon" title="Clear terminal"
                onClick={() => termRef.current?.clear()}>⊟</span>
              <span className="term-icon" title="Kill pty"
                onClick={() => window.electronAPI.killPty()}>✕</span>
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
            <div className="status-item" style={{ color: running ? "var(--yellow)" : "var(--accent)", fontWeight: 700 }}>
              {running ? "● Running" : "● Ready"}
            </div>
          </div>
        </footer>

      </div>
    </>
  );
}
