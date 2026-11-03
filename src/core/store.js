'use strict';
/**
 * Board store: pure Node.js file-system data layer.
 *
 * Layout on disk:
 *   <dataRoot>/<Game>/<Board>/board.json
 *   <dataRoot>/<Game>/<Board>/images/<id>.png
 *
 * Shared by the Electron main process and the standalone stdio MCP server,
 * so it must not depend on Electron or any npm package.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BOARD_FILE = 'board.json';
const IMAGES_DIR = 'images';
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeName(name) {
  if (typeof name !== 'string') throw new Error('Name must be a string');
  let clean = name.replace(INVALID_NAME, '').trim().replace(/[. ]+$/, '');
  if (clean.startsWith('.')) clean = clean.replace(/^\.+/, '');
  if (!clean) throw new Error('Name is empty or contains only invalid characters');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) throw new Error(`"${clean}" is a reserved name on Windows`);
  if (clean.length > 120) clean = clean.slice(0, 120).trim();
  return clean;
}

function isVisibleDir(dir, name) {
  if (name.startsWith('.') || name === IMAGES_DIR) return false;
  try {
    return fs.statSync(path.join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse rename over a file that is briefly locked (AV, indexer); fall back.
    try {
      fs.writeFileSync(file, data);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

// ---------- tiny image header parser (PNG / JPEG / GIF / WebP / BMP) ----------
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png', ext: 'png' };
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif', ext: 'gif' };
    }
    if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), mime: 'image/bmp', ext: 'bmp' };
    }
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      let width = 0, height = 0;
      if (chunk === 'VP8X') {
        width = 1 + buf.readUIntLE(24, 3);
        height = 1 + buf.readUIntLE(27, 3);
      } else if (chunk === 'VP8 ') {
        width = buf.readUInt16LE(26) & 0x3fff;
        height = buf.readUInt16LE(28) & 0x3fff;
      } else if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        width = 1 + (b & 0x3fff);
        height = 1 + ((b >> 14) & 0x3fff);
      }
      return { width, height, mime: 'image/webp', ext: 'webp' };
    }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), mime: 'image/jpeg', ext: 'jpg' };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
      return { width: 0, height: 0, mime: 'image/jpeg', ext: 'jpg' };
    }
  } catch { /* fallthrough */ }
  return null;
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

// ---------- text helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(div|p|h[1-6]|li|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => {
      if (ENTITIES[e] !== undefined) return ENTITIES[e];
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Light markdown -> HTML so notes written by Claude look nice on the board. */
function markdownToHtml(md) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      const size = { 1: 1.6, 2: 1.35, 3: 1.15 }[m[1].length];
      return `<div><b><span style="font-size: ${size}em;">${inline(m[2])}</span></b></div>`;
    }
    if ((m = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/))) {
      return `<div>${m[1].trim() ? '☑' : '☐'} ${inline(m[2])}</div>`;
    }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      const indent = m[1].length >= 2 ? '&nbsp;&nbsp;&nbsp;&nbsp;' : '';
      return `<div>${indent}• ${inline(m[2])}</div>`;
    }
    if (!line.trim()) return '<div><br></div>';
    return `<div>${inline(line)}</div>`;
  }).join('');
}

// ---------- style ----------
const STYLE_KEYS = ['fontFamily', 'fontSize', 'color', 'background', 'bold', 'italic', 'underline', 'strike', 'align'];

function normalizeStyle(style) {
  const out = {};
  if (!style || typeof style !== 'object') return out;
  for (const k of STYLE_KEYS) {
    if (style[k] === undefined || style[k] === null || style[k] === '') continue;
    out[k] = style[k];
  }
  if (out.fontSize !== undefined) out.fontSize = Math.max(6, Math.min(400, Number(out.fontSize) || 18));
  for (const b of ['bold', 'italic', 'underline', 'strike']) if (b in out) out[b] = !!out[b];
  if (out.align && !['left', 'center', 'right'].includes(out.align)) delete out.align;
  return out;
}

function estimateTextHeight(text, width, fontSize) {
  const fs_ = fontSize || 18;
  const charsPerLine = Math.max(8, Math.floor((width - 20) / (fs_ * 0.55)));
  const lines = String(text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / charsPerLine)), 0);
  return Math.round(lines * fs_ * 1.4 + 20);
}

// ---------- Store ----------
class BoardStore extends EventEmitter {
  constructor(dataRoot) {
    super();
    this.setDataRoot(dataRoot);
  }

  setDataRoot(dataRoot) {
    if (!dataRoot) throw new Error('dataRoot is required');
    this.dataRoot = path.resolve(dataRoot);
    fs.mkdirSync(this.dataRoot, { recursive: true });
  }

  // ----- paths -----
  gameDir(game) {
    return path.join(this.dataRoot, this._existingName(this.dataRoot, game, 'Game'));
  }

  boardDir(game, board) {
    const g = this.gameDir(game);
    return path.join(g, this._existingName(g, board, 'Board'));
  }

  /** Case-insensitive lookup of an existing child folder; throws a helpful error if missing. */
  _existingName(parent, name, kind) {
    if (typeof name !== 'string' || !name.trim()) throw new Error(`${kind} name is required`);
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') throw new Error(`Invalid ${kind.toLowerCase()} name`);
    const direct = path.join(parent, name);
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return name;
    let entries = [];
    try { entries = fs.readdirSync(parent).filter((n) => isVisibleDir(parent, n)); } catch { /* ignore */ }
    const hit = entries.find((n) => n.toLowerCase() === name.trim().toLowerCase());
    if (hit) return hit;
    const available = entries.length ? ` Available: ${entries.map((e) => `"${e}"`).join(', ')}` : '';
    throw new Error(`${kind} "${name}" not found.${available}`);
  }

  // ----- games -----
  listGames() {
    const root = this.dataRoot;
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => isVisibleDir(root, n)); } catch { /* ignore */ }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    return names.map((name) => ({ name, boards: this.listBoards(name) }));
  }

  createGame(name) {
    const clean = sanitizeName(name);
    const dir = path.join(this.dataRoot, clean);
    if (fs.existsSync(dir)) throw new Error(`A game named "${clean}" already exists`);
    fs.mkdirSync(dir, { recursive: true });
    this.emit('tree-changed');
    return { name: clean };
  }

  renameGame(oldName, newName) {
    const from = this.gameDir(oldName);
    const clean = sanitizeName(newName);
    const to = path.join(this.dataRoot, clean);
    if (from === to) return { name: clean };
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`A game named "${clean}" already exists`);
    fs.renameSync(from, to);
    this.emit('tree-changed');
    return { name: clean };
  }

  // ----- boards -----
  listBoards(game) {
    const g = this.gameDir(game);
    let names = [];
    try { names = fs.readdirSync(g).filter((n) => isVisibleDir(g, n)); } catch { /* ignore */ }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    return names.map((name) => {
      const file = path.join(g, name, BOARD_FILE);
      let updatedAt = null;
      try { updatedAt = fs.statSync(file).mtime.toISOString(); } catch { /* no board.json yet */ }
      return { name, updatedAt };
    });
  }

  createBoard(game, name) {
    const g = this.gameDir(game);
    const clean = sanitizeName(name);
    const dir = path.join(g, clean);
    if (fs.existsSync(dir)) throw new Error(`A board named "${clean}" already exists in "${path.basename(g)}"`);
    fs.mkdirSync(path.join(dir, IMAGES_DIR), { recursive: true });
    const now = new Date().toISOString();
    const data = { version: 1, name: clean, createdAt: now, updatedAt: now, rev: 0, items: [] };
    writeFileAtomic(path.join(dir, BOARD_FILE), JSON.stringify(data, null, 2));
    this.emit('tree-changed');
    return { game: path.basename(g), name: clean };
  }

  renameBoard(game, oldName, newName) {
    const from = this.boardDir(game, oldName);
    const clean = sanitizeName(newName);
    const to = path.join(path.dirname(from), clean);
    if (from === to) return { name: clean };
    if (fs.existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`A board named "${clean}" already exists`);
    fs.renameSync(from, to);
    this.emit('tree-changed');
    return { name: clean };
  }

  readBoard(game, board) {
    const dir = this.boardDir(game, board);
    const file = path.join(dir, BOARD_FILE);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt file: keep a backup and start fresh rather than crash.
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      const now = new Date().toISOString();
      data = { version: 1, name: path.basename(dir), createdAt: now, updatedAt: now, rev: 0, items: [] };
    }
    if (!Array.isArray(data.items)) data.items = [];
    data.name = path.basename(dir);
    data.game = path.basename(path.dirname(dir));
    data.rev = data.rev || 0;
    return data;
  }

  _writeBoard(game, board, data, source) {
    const dir = this.boardDir(game, board);
    data.updatedAt = new Date().toISOString();
    data.rev = (data.rev || 0) + 1;
    const toSave = { ...data };
    delete toSave.game;
    writeFileAtomic(path.join(dir, BOARD_FILE), JSON.stringify(toSave, null, 2));
    this.emit('board-changed', {
      game: path.basename(path.dirname(dir)),
      board: path.basename(dir),
      rev: data.rev,
      source: source || 'unknown',
    });
    return data;
  }

  /**
   * Apply a patch atomically: upsert full items and delete ids.
   * Used by the renderer (so concurrent MCP edits are never lost) and by MCP tools.
   */
  applyPatch(game, board, patch, source) {
    const data = this.readBoard(game, board);
    const byId = new Map(data.items.map((it) => [it.id, it]));
    for (const id of patch.deletes || []) byId.delete(id);
    for (const item of patch.upserts || []) {
      if (!item || !item.id) continue;
      byId.set(item.id, item);
    }
    data.items = [...byId.values()];
    return this._writeBoard(game, board, data, source);
  }

  // ----- images -----
  imagePath(game, board, src) {
    const dir = this.boardDir(game, board);
    const full = path.resolve(dir, src);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid image path');
    return full;
  }

  saveImage(game, board, buffer, mimeHint) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!buf.length) throw new Error('Image is empty');
    const info = imageSize(buf) || {};
    let ext = info.ext;
    if (!ext && mimeHint) ext = Object.keys(MIME_BY_EXT).find((k) => MIME_BY_EXT[k] === mimeHint) || 'png';
    ext = ext || 'png';
    const dir = path.join(this.boardDir(game, board), IMAGES_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const id = newId('img');
    const file = `${id}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    return { src: `${IMAGES_DIR}/${file}`, width: info.width || 0, height: info.height || 0, mime: info.mime || MIME_BY_EXT[ext] };
  }

  readImage(game, board, src) {
    const full = this.imagePath(game, board, src);
    const buf = fs.readFileSync(full);
    const ext = path.extname(full).slice(1).toLowerCase();
    return { buffer: buf, mime: (imageSize(buf) || {}).mime || MIME_BY_EXT[ext] || 'application/octet-stream', path: full };
  }

  // ----- search -----
  search(query, limit = 50) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const results = [];
    for (const game of this.listGames()) {
      if (game.name.toLowerCase().includes(q)) results.push({ game: game.name, match: 'game name' });
      for (const b of game.boards) {
        if (b.name.toLowerCase().includes(q)) results.push({ game: game.name, board: b.name, match: 'board name' });
        let data;
        try { data = this.readBoard(game.name, b.name); } catch { continue; }
        for (const it of data.items) {
          const text = it.type === 'text' ? (it.text || htmlToText(it.html)) : (it.caption || '');
          const idx = text.toLowerCase().indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 60);
            results.push({
              game: game.name, board: b.name, item_id: it.id, type: it.type,
              snippet: (start > 0 ? '…' : '') + text.slice(start, idx + q.length + 80).replace(/\s+/g, ' ') + '…',
            });
          }
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }
}

module.exports = {
  BoardStore,
  newId,
  sanitizeName,
  imageSize,
  htmlToText,
  markdownToHtml,
  escapeHtml,
  normalizeStyle,
  estimateTextHeight,
  MIME_BY_EXT,
};
