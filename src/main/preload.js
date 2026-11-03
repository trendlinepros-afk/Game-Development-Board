'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  appInfo: () => call('app:info'),

  listGames: () => call('games:list'),
  createGame: (name) => call('games:create', name),
  renameGame: (oldName, newName) => call('games:rename', oldName, newName),
  deleteGame: (name) => call('games:delete', name),

  createBoard: (game, name) => call('boards:create', game, name),
  renameBoard: (game, oldName, newName) => call('boards:rename', game, oldName, newName),
  deleteBoard: (game, name) => call('boards:delete', game, name),

  readBoard: (game, board) => call('board:read', game, board),
  patchBoard: (game, board, patch) => call('board:patch', game, board, patch),
  patchBoardSync: (game, board, patch) => ipcRenderer.sendSync('board:patchSync', game, board, patch),
  setActiveBoard: (ref) => call('board:setActive', ref),

  saveImage: (game, board, bytes, mime) => call('image:save', game, board, bytes, mime),
  saveImageFromPath: (game, board, filePath) => call('image:fromPath', game, board, filePath),
  copyImage: (game, board, src) => call('image:copyToClipboard', game, board, src),
  openImage: (game, board, src) => call('image:openExternal', game, board, src),
  showImageInFolder: (game, board, src) => call('image:showInFolder', game, board, src),
  readClipboardImage: () => call('clipboard:readImage'),
  writeClipboardText: (text) => call('clipboard:writeText', text),
  pickImages: () => call('dialog:pickImages'),

  chooseDataRoot: () => call('settings:chooseDataRoot'),
  openDataRoot: () => call('shell:openDataRoot'),
  openFolder: (game, board) => call('shell:openGameFolder', game, board),
  openExternal: (url) => call('shell:openExternal', url),

  mcpConnectionInfo: () => call('mcp:connectionInfo'),
  installClaudeDesktop: () => call('mcp:installClaudeDesktop'),

  updater: {
    getState: () => ipcRenderer.invoke('updater:getState'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
  },

  on: {
    treeChanged: (cb) => on('tree-changed', cb),
    boardChanged: (cb) => on('board-changed', cb),
    mcpStatus: (cb) => on('mcp-status', cb),
    updaterState: (cb) => on('updater:state', cb),
  },
});
