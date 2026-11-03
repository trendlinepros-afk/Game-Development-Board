'use strict';
/**
 * Auto-update via GitHub Releases (electron-updater).
 * The release workflow publishes Game-Development-Board-Setup.exe + latest.yml;
 * electron-updater reads latest.yml from the newest GitHub release.
 */
const { ipcMain, app } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

let win = null;
let isDev = false;
let state = { status: 'idle' }; // idle | checking | available | not-available | downloading | downloaded | error | dev
let checkingManually = false;

function push(next) {
  state = { ...next, currentVersion: app.getVersion(), at: Date.now() };
  if (win && !win.isDestroyed()) win.webContents.send('updater:state', state);
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return 'Could not reach GitHub. Check your internet connection.';
  if (/404|Cannot find latest\.yml|No published versions/i.test(msg)) return 'No published release found on GitHub yet.';
  if (/rate limit/i.test(msg)) return 'GitHub rate limit hit. Try again in a few minutes.';
  return msg.split('\n')[0].slice(0, 300);
}

async function check(manual) {
  if (isDev) {
    push({ status: 'dev', message: 'Updates are only available in the installed app.' });
    return state;
  }
  if (state.status === 'downloading' || state.status === 'downloaded') {
    push(state);
    return state;
  }
  checkingManually = !!manual;
  push({ status: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.error('checkForUpdates failed', err);
    push({ status: 'error', message: friendlyError(err) });
  }
  return state;
}

function init(mainWindow, dev) {
  win = mainWindow;
  isDev = dev;
  log.transports.file.level = 'info';
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => push({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => push({ status: 'available', version: info.version, releaseNotes: info.releaseNotes || null, releaseDate: info.releaseDate }));
  autoUpdater.on('update-not-available', (info) => push({ status: 'not-available', version: info && info.version, manual: checkingManually }));
  autoUpdater.on('download-progress', (p) => push({ status: 'downloading', percent: Math.round(p.percent || 0), transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
  autoUpdater.on('update-downloaded', (info) => push({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => {
    log.error('updater error', err);
    push({ status: 'error', message: friendlyError(err) });
  });

  ipcMain.handle('updater:getState', () => ({ ...state, currentVersion: app.getVersion() }));
  ipcMain.handle('updater:check', () => check(true));
  ipcMain.handle('updater:download', async () => {
    try {
      push({ status: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (err) {
      log.error('downloadUpdate failed', err);
      push({ status: 'error', message: friendlyError(err) });
    }
    return state;
  });
  ipcMain.handle('updater:install', () => {
    // Silent install, then relaunch the app.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  // Quiet check shortly after startup so the button can show a badge.
  if (!isDev) setTimeout(() => check(false), 4000);
}

module.exports = { init, check };
