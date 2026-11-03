#!/usr/bin/env node
'use strict';
/**
 * Game Development Board — stdio MCP server (for Claude Desktop and other stdio clients).
 *
 * Runs with plain Node, or with the app's own executable via ELECTRON_RUN_AS_NODE=1:
 *   "Game Development Board.exe" "<resources>\mcp-server\stdio-server.js"
 *
 * If the desktop app is running, every request is forwarded to it (so the open board
 * updates live). If the app is closed, requests are served directly from the data folder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { BoardStore } = require('./store');
const { McpServer } = require('./mcp');
const { DEFAULT_PORT } = require('./http-transport');

function appDataDir() {
  if (process.env.GDB_USER_DATA) return process.env.GDB_USER_DATA;
  const base = process.env.APPDATA
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')));
  return path.join(base, 'GameDevBoard');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDataDir(), 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

const settings = loadSettings();
const port = Number(process.env.GDB_MCP_PORT) || settings.mcpPort || DEFAULT_PORT;
const dataRoot = process.env.GDB_DATA_ROOT || settings.dataRoot || path.join(os.homedir(), 'Documents', 'Game Development Board');
let version = '0.0.0';
try { version = require('../../package.json').version; } catch { /* packaged: package.json not next to us */ }

let localServer = null;
function local() {
  if (!localServer) localServer = new McpServer({ store: new BoardStore(dataRoot), version, mode: 'standalone' });
  return localServer;
}

function forward(msg) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(msg));
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': body.length },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 202) return resolve(null);
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { fallback: true }));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => { err.fallback = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code); reject(err); });
    req.end(body);
  });
}

async function handle(msg) {
  try {
    return await forward(msg);
  } catch (err) {
    if (err.fallback || err.code === 'ECONNREFUSED') return local().handle(msg);
    if (msg && msg.id !== undefined) return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err.message || err) } };
    return null;
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let closing = false;
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  pending++;
  try {
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  } finally {
    pending--;
    if (closing && pending === 0) process.exit(0);
  }
});
rl.on('close', () => { closing = true; if (pending === 0) process.exit(0); });
process.on('uncaughtException', (err) => { process.stderr.write(`[game-dev-board mcp] ${err.stack || err}\n`); });
