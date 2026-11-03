'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage, protocol, net, Menu,
} = require('electron');

// Deterministic userData folder (the stdio MCP server reads settings.json from here).
app.setPath('userData', path.join(app.getPath('appData'), 'GameDevBoard'));

const { BoardStore } = require('../core/store');
const { McpServer } = require('../core/mcp');
const { startHttpServer, DEFAULT_PORT } = require('../core/http-transport');
const transfer = require('../core/transfer');
const crypto = require('crypto');
const updater = require('./updater');

const IS_DEV = !app.isPackaged;
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'gdb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let store = null;
let mcp = null;
let httpServer = null;
let settings = {};
let activeBoard = null;
const mcpState = { running: false, port: DEFAULT_PORT, error: null };

// ---------------- settings ----------------
function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    settings = {};
  }
  if (!settings.dataRoot) settings.dataRoot = path.join(app.getPath('documents'), 'Game Development Board');
  if (!settings.mcpPort) settings.mcpPort = DEFAULT_PORT;
  saveSettings();
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- data folder watching ----------------
let watcher = null;
let treeTimer = null;
function notifyTreeChanged() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => send('tree-changed'), 250);
}

function watchDataRoot() {
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  try {
    watcher = fs.watch(store.dataRoot, { recursive: process.platform !== 'linux' }, (evt, filename) => {
      if (!filename) return notifyTreeChanged();
      const f = String(filename);
      if (f.endsWith('.tmp') || f.endsWith('board.json') || f.includes(`${path.sep}images`)) return;
      notifyTreeChanged();
    });
    watcher.on('error', () => { /* folder removed etc. */ });
  } catch { /* watching is best-effort */ }
}

function initStore() {
  store = new BoardStore(settings.dataRoot);
  store.on('tree-changed', notifyTreeChanged);
  store.on('board-changed', (evt) => {
    if (evt.source !== 'renderer') send('board-changed', evt);
  });
  if (mcp) mcp.store = store;
  watchDataRoot();
}

// ---------------- MCP ----------------
async function startMcp() {
  mcp = new McpServer({ store, getActiveBoard: () => activeBoard, version: app.getVersion(), mode: 'app' });
  mcpState.port = settings.mcpPort;
  try {
    httpServer = await startHttpServer(mcp, { port: settings.mcpPort, log: console.error });
    mcpState.running = true;
    mcpState.error = null;
  } catch (err) {
    mcpState.running = false;
    mcpState.error = err.code === 'EADDRINUSE'
      ? `Port ${settings.mcpPort} is already in use (is another copy of the app running?)`
      : String(err.message || err);
  }
  send('mcp-status', mcpState);
}

function mcpServerScriptPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'core', 'stdio-server.js')
    : path.join(process.resourcesPath, 'mcp-server', 'stdio-server.js');
}

function claudeDesktopEntry() {
  return {
    command: process.execPath,
    args: [mcpServerScriptPath()],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function claudeDesktopConfigPath() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || path.join(app.getPath('home'), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(app.getPath('home'), 'Library', 'Application Support')
      : path.join(app.getPath('home'), '.config');
  return path.join(base, 'Claude', 'claude_desktop_config.json');
}

// ---------------- window ----------------
function createWindow() {
  const bounds = settings.windowBounds || { width: 1440, height: 900 };
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#17181c',
    title: 'Game Development Board',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });
  if (settings.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    settings.maximized = mainWindow.isMaximized();
    if (!settings.maximized && !mainWindow.isMinimized()) settings.windowBounds = mainWindow.getBounds();
    saveSettings();
  };
  mainWindow.on('close', saveBounds);

  // Open external links in the browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the app itself. Block every navigation (e.g. a file
  // dropped outside the canvas would otherwise be opened in place of the app).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  installEditContextMenu(mainWindow.webContents);
  updater.init(mainWindow, IS_DEV);
}

/**
 * Electron shows no context menu by default. For text being edited (notes in edit
 * mode, dialog inputs) show a native one with spelling suggestions + clipboard actions.
 * The canvas and sidebar have their own menus and call preventDefault, so this only
 * fires for editable text.
 */
function installEditContextMenu(wc) {
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const template = [];
    const word = params.misspelledWord;
    if (word) {
      const suggestions = (params.dictionarySuggestions || []).slice(0, 6);
      if (suggestions.length) {
        for (const s of suggestions) template.push({ label: s, click: () => wc.replaceMisspelling(s) });
      } else {
        template.push({ label: 'No spelling suggestions', enabled: false });
      }
      template.push({ type: 'separator' });
      template.push({ label: `Add "${word}" to dictionary`, click: () => wc.session.addWordToSpellCheckerDictionary(word) });
      template.push({ type: 'separator' });
    }
    const f = params.editFlags || {};
    template.push(
      { label: 'Undo', role: 'undo', enabled: f.canUndo },
      { label: 'Redo', role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: f.canCut },
      { label: 'Copy', role: 'copy', enabled: f.canCopy },
      { label: 'Paste', role: 'paste', enabled: f.canPaste },
      { type: 'separator' },
      { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll },
    );
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) });
  });
}

// ---------------- IPC ----------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    isDev: IS_DEV,
    platform: process.platform,
    dataRoot: store.dataRoot,
    mcp: mcpState,
  }));

  handle('games:list', () => store.listGames());
  handle('games:create', (name) => store.createGame(name));
  handle('games:rename', (oldName, newName) => store.renameGame(oldName, newName));
  handle('games:delete', async (name) => {
    await shell.trashItem(store.gameDir(name));
    notifyTreeChanged();
    return true;
  });

  handle('boards:create', (game, name) => store.createBoard(game, name));
  handle('boards:rename', (game, oldName, newName) => store.renameBoard(game, oldName, newName));
  handle('boards:delete', async (game, name) => {
    await shell.trashItem(store.boardDir(game, name));
    notifyTreeChanged();
    return true;
  });

  handle('board:read', (game, board) => store.readBoard(game, board));
  handle('board:patch', (game, board, patch) => {
    const data = store.applyPatch(game, board, patch, 'renderer');
    return { rev: data.rev };
  });
  handle('board:setActive', (ref) => {
    activeBoard = ref && ref.game && ref.board ? { game: ref.game, board: ref.board } : null;
    return true;
  });
  // Synchronous flush used while the window is closing.
  ipcMain.on('board:patchSync', (e, game, board, patch) => {
    try {
      store.applyPatch(game, board, patch, 'renderer');
      e.returnValue = true;
    } catch (err) {
      e.returnValue = String(err.message || err);
    }
  });

  handle('image:save', (game, board, bytes, mime) => store.saveImage(game, board, Buffer.from(bytes), mime));
  handle('image:fromPath', (game, board, filePath) => store.saveImage(game, board, fs.readFileSync(filePath)));
  handle('image:copyToClipboard', (game, board, src) => {
    const img = nativeImage.createFromPath(store.imagePath(game, board, src));
    if (img.isEmpty()) throw new Error('Could not read image');
    clipboard.writeImage(img);
    return true;
  });
  handle('image:openExternal', async (game, board, src) => {
    const err = await shell.openPath(store.imagePath(game, board, src));
    if (err) throw new Error(err);
    return true;
  });
  handle('image:showInFolder', (game, board, src) => {
    shell.showItemInFolder(store.imagePath(game, board, src));
    return true;
  });

  // Fallback clipboard read: some apps put only a bitmap on the clipboard that
  // the DOM paste event doesn't expose as a file. Read it natively.
  handle('clipboard:readImage', () => {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    return { bytes: img.toPNG(), width: size.width, height: size.height };
  });

  handle('dialog:pickImages', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Add images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  handle('settings:chooseDataRoot', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the folder that holds your games',
      defaultPath: store.dataRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.dataRoot = r.filePaths[0];
    saveSettings();
    initStore();
    return store.dataRoot;
  });
  handle('shell:openDataRoot', () => shell.openPath(store.dataRoot));
  handle('shell:openGameFolder', (game, board) => shell.openPath(board ? store.boardDir(game, board) : store.gameDir(game)));
  handle('shell:openExternal', (url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return true;
  });

  handle('mcp:connectionInfo', () => {
    const url = `http://127.0.0.1:${settings.mcpPort}/mcp`;
    const entry = claudeDesktopEntry();
    return {
      status: mcpState,
      httpUrl: url,
      claudeCodeCommand: `claude mcp add --transport http --scope user game-dev-board ${url}`,
      claudeDesktopConfigPath: claudeDesktopConfigPath(),
      claudeDesktopSnippet: JSON.stringify({ mcpServers: { 'game-dev-board': entry } }, null, 2),
    };
  });
  handle('mcp:installClaudeDesktop', () => {
    const file = claudeDesktopConfigPath();
    let config = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      try {
        config = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`Could not parse ${file}. Fix or remove it, then try again.`);
      }
      fs.copyFileSync(file, `${file}.bak`);
    }
    config.mcpServers = config.mcpServers || {};
    config.mcpServers['game-dev-board'] = claudeDesktopEntry();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    return { file };
  });
  // ---------- export / import ----------
  const pendingImports = new Map();
  const safeFileName = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'export';

  handle('transfer:export', async (game, board) => {
    const gameName = path.basename(store.gameDir(game));
    const boardName = board ? path.basename(store.boardDir(game, board)) : null;
    const base = boardName ? `${gameName} - ${boardName}` : gameName;
    const r = await dialog.showSaveDialog(mainWindow, {
      title: boardName ? 'Export board' : 'Export game',
      defaultPath: path.join(app.getPath('desktop'), `${safeFileName(base)}.${transfer.FILE_EXT}`),
      filters: [{ name: 'Game Dev Board export', extensions: [transfer.FILE_EXT] }],
    });
    if (r.canceled || !r.filePath) return null;
    const buf = transfer.exportToBuffer(store, gameName, boardName ? [boardName] : null, app.getVersion());
    fs.writeFileSync(r.filePath, buf);
    return { file: r.filePath, bytes: buf.length };
  });
  handle('transfer:showFile', (file) => { shell.showItemInFolder(file); return true; });

  // Images from an import are decoded and re-encoded so only clean pixels are kept.
  const reencodeImage = (buf, info) => {
    if (info.ext !== 'png' && info.ext !== 'jpg') return undefined; // GIF/WebP/BMP: header-validated, kept
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    return info.ext === 'jpg' ? img.toJPEG(92) : img.toPNG();
  };

  handle('transfer:prepare', async (filePath) => {
    let file = filePath;
    if (!file) {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: 'Import board or game',
        properties: ['openFile'],
        filters: [{ name: 'Game Dev Board export', extensions: [transfer.FILE_EXT] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      file = r.filePaths[0];
    }
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > transfer.LIMITS.fileBytes) throw new Error('File is too large to import');
    const parsed = transfer.parseExport(fs.readFileSync(file), reencodeImage);
    const token = crypto.randomUUID();
    pendingImports.clear(); // only one pending import at a time
    pendingImports.set(token, parsed);
    const games = store.listGames().map((g) => g.name);
    return {
      token,
      fileName: path.basename(file),
      kind: parsed.kind,
      game: parsed.game,
      exportedAt: parsed.exportedAt,
      appVersion: parsed.appVersion,
      boards: parsed.boards.map((b) => ({ name: b.name, items: b.items.length, images: b.images.size })),
      itemCount: parsed.itemCount,
      imageCount: parsed.imageCount,
      warnings: parsed.warnings,
      existingGame: games.find((g) => g.toLowerCase() === parsed.game.toLowerCase()) || null,
      games,
      newGameName: transfer.uniqueName(games, parsed.game),
    };
  });
  handle('transfer:commit', (token, opts) => {
    const parsed = pendingImports.get(token);
    if (!parsed) throw new Error('This import has expired. Please import the file again.');
    pendingImports.delete(token);
    const result = transfer.importParsed(store, parsed, {
      targetGame: opts && opts.targetGame ? String(opts.targetGame) : undefined,
      newGameName: opts && opts.newGameName ? String(opts.newGameName) : undefined,
    });
    notifyTreeChanged();
    return result;
  });
  handle('transfer:cancel', (token) => { pendingImports.delete(token); return true; });

  handle('clipboard:writeText', (text) => {
    clipboard.writeText(String(text));
    return true;
  });
}

// ---------------- lifecycle ----------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  loadSettings();
  initStore();
  if (process.platform === 'linux') {
    try { require('electron').session.defaultSession.setSpellCheckerLanguages(['en-US']); } catch { /* ignore */ }
  }

  // gdb://img/<game>/<board>/<src>  -> image file inside the board folder
  protocol.handle('gdb', (request) => {
    try {
      const u = new URL(request.url);
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (u.hostname !== 'img' || parts.length < 3) return new Response('Not found', { status: 404 });
      const [game, board, ...rest] = parts;
      const file = store.imagePath(game, board, rest.join('/'));
      return net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      return new Response(String(err.message || err), { status: 404 });
    }
  });

  registerIpc();
  await startMcp();
  createWindow();
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  app.quit();
});
