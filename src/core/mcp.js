'use strict';
/**
 * MCP (Model Context Protocol) server logic: JSON-RPC dispatch + tool definitions.
 * Transport-agnostic. Used by the in-app Streamable HTTP endpoint and by the stdio server.
 */
const fs = require('fs');
const path = require('path');
const {
  newId, htmlToText, markdownToHtml, normalizeStyle, estimateTextHeight, MIME_BY_EXT,
} = require('./store');

const SERVER_NAME = 'game-development-board';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_TEXT_WIDTH = 320;
const GAP = 32;

const INSTRUCTIONS = `Game Development Board: a canvas app where the user organizes game ideas.
Structure: Games (folders) contain Boards (infinite canvases). Boards hold "text" items (rich notes), "image" items (usually screenshots of bugs or feature ideas) and "draw" items (pen strokes, highlighter, lines, arrows, rectangles, ellipses the user drew, often marking up a screenshot).
Coordinates are canvas pixels: x grows right, y grows down. Each item has x, y, w, h.
Typical flow: list_games -> get_board (set include_images=true or call get_image to actually look at screenshots) -> add_text to write your own notes (use near_item_id to place a note right next to the screenshot or note it refers to).
Text you write supports light markdown (# headings, **bold**, *italic*, - bullets, - [ ] checkboxes, \`code\`). Your items are tagged author "claude" and highlighted for the user.
get_active_board tells you which board the user is looking at right now.
Use add_shape to point at or circle things in screenshots.`;

// ---------------- schema helpers ----------------
const S = {
  game: { type: 'string', description: 'Game (folder) name, case-insensitive.' },
  board: { type: 'string', description: 'Board name inside the game, case-insensitive.' },
  itemId: { type: 'string', description: 'Item id as returned by get_board.' },
  x: { type: 'number', description: 'Left position in canvas pixels.' },
  y: { type: 'number', description: 'Top position in canvas pixels.' },
  style: {
    font_family: { type: 'string', description: 'CSS font family, e.g. "Segoe UI", "Georgia", "Courier New".' },
    font_size: { type: 'number', description: 'Font size in px (default 18).' },
    color: { type: 'string', description: 'Text color, CSS color e.g. "#ffd166".' },
    background: { type: 'string', description: 'Sticky-note background. Prefer a theme-aware name: yellow, tan, green, blue, pink, purple, gray (readable in light and dark mode). Any CSS color also works. Use "none" to clear.' },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    strike: { type: 'boolean' },
    align: { type: 'string', enum: ['left', 'center', 'right'] },
  },
};

const TOOLS = [
  {
    name: 'list_games',
    description: 'List all games and the boards inside each game.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_active_board',
    description: 'Return which game/board the user currently has open in the app (null if none or app not running).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_boards',
    description: 'List the boards inside a game.',
    inputSchema: { type: 'object', properties: { game: S.game }, required: ['game'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_board',
    description: 'Get every item on a board: text notes (plain text + formatting) and images (id, position, size). Set include_images=true to also receive the image pixels so you can see screenshots.',
    inputSchema: {
      type: 'object',
      properties: {
        game: S.game,
        board: S.board,
        include_images: { type: 'boolean', description: 'Attach the actual images to the result (default false).' },
        max_images: { type: 'number', description: 'Max images to attach when include_images is true (default 10).' },
      },
      required: ['game', 'board'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_image',
    description: 'Fetch one image from a board so you can look at it (e.g. a bug screenshot).',
    inputSchema: { type: 'object', properties: { game: S.game, board: S.board, image_id: S.itemId }, required: ['game', 'board', 'image_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_boards',
    description: 'Full-text search across every game and board (game names, board names, note text, image captions).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_game',
    description: 'Create a new game (folder).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'create_board',
    description: 'Create a new empty board inside a game.',
    inputSchema: { type: 'object', properties: { game: S.game, name: { type: 'string' } }, required: ['game', 'name'] },
  },
  {
    name: 'add_text',
    description: 'Write a text note on a board. Supports light markdown. If no x/y is given it is placed automatically: next to near_item_id if provided, otherwise below existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        game: S.game,
        board: S.board,
        text: { type: 'string', description: 'Note content (markdown supported).' },
        x: S.x,
        y: S.y,
        width: { type: 'number', description: `Box width in px (default ${DEFAULT_TEXT_WIDTH}).` },
        near_item_id: { type: 'string', description: 'Place the note to the right of this item.' },
        ...S.style,
      },
      required: ['game', 'board', 'text'],
    },
  },
  {
    name: 'update_text',
    description: 'Edit an existing text note: replace its text and/or change formatting or position. Only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        game: S.game,
        board: S.board,
        item_id: S.itemId,
        text: { type: 'string', description: 'New content (markdown supported). Replaces existing text and inline formatting.' },
        append: { type: 'string', description: 'Text to append on new line(s) at the end, keeping existing content.' },
        x: S.x,
        y: S.y,
        width: { type: 'number' },
        ...S.style,
      },
      required: ['game', 'board', 'item_id'],
    },
  },
  {
    name: 'add_image',
    description: 'Place an image on a board, from a local file path or base64 data.',
    inputSchema: {
      type: 'object',
      properties: {
        game: S.game,
        board: S.board,
        file_path: { type: 'string', description: 'Absolute path to an image file on this computer.' },
        base64: { type: 'string', description: 'Base64-encoded image bytes (alternative to file_path).' },
        mime_type: { type: 'string', description: 'MIME type for base64 data, e.g. image/png.' },
        caption: { type: 'string', description: 'Optional caption shown under the image.' },
        x: S.x,
        y: S.y,
        width: { type: 'number', description: 'Display width in px (height keeps aspect ratio). Default: natural size up to 800.' },
        near_item_id: { type: 'string' },
      },
      required: ['game', 'board'],
    },
  },
  {
    name: 'add_shape',
    description: 'Draw on a board: an arrow, line, rectangle or ellipse, e.g. to point at or circle something in a screenshot. Coordinates are absolute canvas pixels (use get_board to find where images are). For arrow/line, (x1,y1) is the start and (x2,y2) the end (the arrowhead). For rect/ellipse they are opposite corners.',
    inputSchema: {
      type: 'object',
      properties: {
        game: S.game,
        board: S.board,
        kind: { type: 'string', enum: ['arrow', 'line', 'rect', 'ellipse'] },
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        color: { type: 'string', description: 'Stroke color, e.g. "#e03131" (red, default), "#1c7ed6", or "ink" for the theme text color.' },
        width: { type: 'number', description: 'Stroke width in px (default 4).' },
        dashed: { type: 'boolean' },
      },
      required: ['game', 'board', 'kind', 'x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'move_item',
    description: 'Move and/or resize any item (text or image). For images, giving only width keeps the aspect ratio.',
    inputSchema: {
      type: 'object',
      properties: { game: S.game, board: S.board, item_id: S.itemId, x: S.x, y: S.y, width: { type: 'number' }, height: { type: 'number' } },
      required: ['game', 'board', 'item_id'],
    },
  },
  {
    name: 'set_image_caption',
    description: 'Set or clear the caption shown under an image.',
    inputSchema: { type: 'object', properties: { game: S.game, board: S.board, item_id: S.itemId, caption: { type: 'string' } }, required: ['game', 'board', 'item_id', 'caption'] },
  },
  {
    name: 'delete_item',
    description: 'Delete an item from a board. Only do this when the user asked for it.',
    inputSchema: { type: 'object', properties: { game: S.game, board: S.board, item_id: S.itemId }, required: ['game', 'board', 'item_id'] },
    annotations: { destructiveHint: true },
  },
];

// ---------------- helpers ----------------
function styleFromArgs(args) {
  const st = {
    fontFamily: args.font_family,
    fontSize: args.font_size,
    color: args.color,
    background: args.background,
    bold: args.bold,
    italic: args.italic,
    underline: args.underline,
    strike: args.strike,
    align: args.align,
  };
  return st;
}

function mergeStyle(base, args) {
  const incoming = styleFromArgs(args);
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (v === null || v === 'none' || v === '') delete out[k];
    else out[k] = v;
  }
  return normalizeStyle(out);
}

function bounds(items) {
  if (!items.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + (it.w || 0));
    maxY = Math.max(maxY, it.y + (it.h || 0));
  }
  return { minX, minY, maxX, maxY };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Find a free spot: next to an anchor item, or below everything. */
function autoPlace(items, w, h, nearId) {
  if (nearId) {
    const anchor = items.find((it) => it.id === nearId);
    if (!anchor) throw new Error(`near_item_id "${nearId}" not found on this board`);
    const rect = { x: anchor.x + (anchor.w || 0) + GAP, y: anchor.y, w, h };
    // slide down until it doesn't collide
    for (let i = 0; i < 200 && items.some((it) => it.id !== nearId && overlaps(rect, { x: it.x, y: it.y, w: it.w || 0, h: it.h || 0 })); i++) {
      rect.y += 24;
    }
    return { x: Math.round(rect.x), y: Math.round(rect.y) };
  }
  const b = bounds(items);
  if (!b) return { x: 80, y: 80 };
  return { x: Math.round(b.minX), y: Math.round(b.maxY + GAP * 2) };
}

function maxZ(items) {
  return items.reduce((m, it) => Math.max(m, it.z || 0), 0);
}

function summarizeItem(it) {
  const base = { id: it.id, type: it.type, x: Math.round(it.x), y: Math.round(it.y), w: Math.round(it.w || 0), h: Math.round(it.h || 0), author: it.author || 'user' };
  if (it.type === 'text') {
    base.text = it.text != null && it.text !== '' ? it.text : htmlToText(it.html);
    if (it.style && Object.keys(it.style).length) base.style = it.style;
    if (it.html && /<(b|i|u|s|strong|em|span|font)\b/i.test(it.html)) base.html = it.html;
  } else if (it.type === 'draw') {
    base.kind = it.kind;
    if (it.style) base.style = it.style;
    if ((it.kind === 'line' || it.kind === 'arrow') && Array.isArray(it.points) && it.points.length === 2) {
      base.from = { x: Math.round(it.x + it.points[0][0]), y: Math.round(it.y + it.points[0][1]) };
      base.to = { x: Math.round(it.x + it.points[1][0]), y: Math.round(it.y + it.points[1][1]) };
    } else if (Array.isArray(it.points) && it.points.length) {
      base.point_count = it.points.length;
    }
  } else if (it.type === 'image') {
    base.src = it.src;
    if (it.caption) base.caption = it.caption;
  }
  if (it.updatedAt) base.updatedAt = it.updatedAt;
  return base;
}

function readingOrder(items) {
  return [...items].sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y));
}

const textResult = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

// ---------------- server ----------------
class McpServer {
  /**
   * @param {object} opts
   * @param {import('./store').BoardStore} opts.store
   * @param {() => ({game:string, board:string}|null)} [opts.getActiveBoard]
   * @param {string} [opts.version]
   * @param {string} [opts.mode] 'app' | 'standalone'
   */
  constructor({ store, getActiveBoard, version, mode }) {
    this.store = store;
    this.getActiveBoard = getActiveBoard || (() => null);
    this.version = version || '0.0.0';
    this.mode = mode || 'app';
  }

  /** Handle one JSON-RPC message (object). Returns a response object, or null for notifications. */
  async handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (!msg.method) return null; // a response from the client; ignore
    try {
      const result = await this._dispatch(msg.method, msg.params || {});
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (err) {
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, error: { code: err.rpcCode || -32603, message: err.message || String(err) } };
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: 'Game Development Board', version: this.version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        return this.callTool(params.name, params.arguments || {});
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        if (method.startsWith('notifications/')) return {};
        {
          const e = new Error(`Method not found: ${method}`);
          e.rpcCode = -32601;
          throw e;
        }
    }
  }

  async callTool(name, args) {
    const fn = this[`tool_${name}`];
    if (!fn) {
      const e = new Error(`Unknown tool: ${name}`);
      e.rpcCode = -32602;
      throw e;
    }
    try {
      return await fn.call(this, args || {});
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message || err}` }], isError: true };
    }
  }

  // ----- tools -----
  tool_list_games() {
    const games = this.store.listGames();
    return textResult({
      data_folder: this.store.dataRoot,
      games: games.map((g) => ({ name: g.name, boards: g.boards.map((b) => b.name) })),
      hint: games.length ? undefined : 'No games yet. Use create_game.',
    });
  }

  tool_get_active_board() {
    const active = this.getActiveBoard();
    if (!active) {
      return textResult({
        active: null,
        note: this.mode === 'standalone'
          ? 'The Game Development Board app is not running, so there is no active board.'
          : 'The user has no board open right now.',
      });
    }
    return textResult({ active });
  }

  tool_list_boards({ game }) {
    const boards = this.store.listBoards(game);
    return textResult({ game: path.basename(this.store.gameDir(game)), boards });
  }

  tool_get_board({ game, board, include_images, max_images }) {
    const data = this.store.readBoard(game, board);
    const items = readingOrder(data.items);
    const summary = {
      game: data.game,
      board: data.name,
      updatedAt: data.updatedAt,
      item_count: items.length,
      bounds: bounds(items),
      items: items.map(summarizeItem),
    };
    const content = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
    if (include_images) {
      const limit = Math.max(1, Math.min(50, Number(max_images) || 10));
      const imgs = items.filter((it) => it.type === 'image').slice(0, limit);
      for (const it of imgs) {
        try {
          const img = this.store.readImage(game, board, it.src);
          content.push({ type: 'text', text: `Image ${it.id}${it.caption ? ` — ${it.caption}` : ''}:` });
          content.push({ type: 'image', data: img.buffer.toString('base64'), mimeType: img.mime });
        } catch (err) {
          content.push({ type: 'text', text: `Image ${it.id}: could not be read (${err.message})` });
        }
      }
      const total = items.filter((it) => it.type === 'image').length;
      if (total > imgs.length) content.push({ type: 'text', text: `${total - imgs.length} more image(s) not attached; use get_image.` });
    }
    return { content };
  }

  tool_get_image({ game, board, image_id }) {
    const data = this.store.readBoard(game, board);
    const it = data.items.find((i) => i.id === image_id);
    if (!it) throw new Error(`Item "${image_id}" not found`);
    if (it.type !== 'image') throw new Error(`Item "${image_id}" is a ${it.type}, not an image`);
    const img = this.store.readImage(game, board, it.src);
    return {
      content: [
        { type: 'text', text: JSON.stringify(summarizeItem(it)) },
        { type: 'image', data: img.buffer.toString('base64'), mimeType: img.mime },
      ],
    };
  }

  tool_search_boards({ query }) {
    const results = this.store.search(query);
    return textResult({ query, count: results.length, results });
  }

  tool_create_game({ name }) {
    return textResult({ created: this.store.createGame(name) });
  }

  tool_create_board({ game, name }) {
    return textResult({ created: this.store.createBoard(game, name) });
  }

  tool_add_text(args) {
    const { game, board, text } = args;
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    const data = this.store.readBoard(game, board);
    const style = mergeStyle({}, args);
    const w = Math.max(60, Math.round(Number(args.width) || DEFAULT_TEXT_WIDTH));
    const h = estimateTextHeight(text, w, style.fontSize);
    let pos;
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) pos = { x: args.x, y: args.y };
    else {
      pos = autoPlace(data.items, w, h, args.near_item_id);
      if (Number.isFinite(args.x)) pos.x = args.x;
      if (Number.isFinite(args.y)) pos.y = args.y;
    }
    const now = new Date().toISOString();
    const item = {
      id: newId('txt'), type: 'text', x: pos.x, y: pos.y, w, h,
      html: markdownToHtml(text), text, style, author: 'claude',
      z: maxZ(data.items) + 1, createdAt: now, updatedAt: now,
    };
    this.store.applyPatch(game, board, { upserts: [item] }, 'mcp');
    return textResult({ added: summarizeItem(item) });
  }

  tool_update_text(args) {
    const { game, board, item_id } = args;
    const data = this.store.readBoard(game, board);
    const it = data.items.find((i) => i.id === item_id);
    if (!it) throw new Error(`Item "${item_id}" not found`);
    if (it.type !== 'text') throw new Error(`Item "${item_id}" is not a text item`);
    const next = { ...it };
    if (typeof args.text === 'string') {
      next.text = args.text;
      next.html = markdownToHtml(args.text);
    }
    if (typeof args.append === 'string' && args.append) {
      const current = next.text != null && next.text !== '' ? next.text : htmlToText(next.html);
      next.text = current ? `${current}\n${args.append}` : args.append;
      next.html = (next.html || '') + markdownToHtml(args.append);
    }
    next.style = mergeStyle(it.style, args);
    if (Number.isFinite(args.x)) next.x = args.x;
    if (Number.isFinite(args.y)) next.y = args.y;
    if (Number.isFinite(args.width)) next.w = Math.max(60, args.width);
    next.h = Math.max(it.h || 0, estimateTextHeight(next.text || htmlToText(next.html), next.w, next.style.fontSize));
    next.updatedAt = new Date().toISOString();
    if (it.author !== 'claude') next.editedBy = 'claude';
    this.store.applyPatch(game, board, { upserts: [next] }, 'mcp');
    return textResult({ updated: summarizeItem(next) });
  }

  tool_add_image(args) {
    const { game, board } = args;
    let buf;
    let mime = args.mime_type;
    if (args.file_path) {
      const p = path.resolve(args.file_path);
      buf = fs.readFileSync(p);
      mime = mime || MIME_BY_EXT[path.extname(p).slice(1).toLowerCase()];
    } else if (args.base64) {
      const b64 = String(args.base64).replace(/^data:([^;]+);base64,/, (m, t) => { mime = mime || t; return ''; });
      buf = Buffer.from(b64, 'base64');
    } else {
      throw new Error('Provide file_path or base64');
    }
    const saved = this.store.saveImage(game, board, buf, mime);
    const data = this.store.readBoard(game, board);
    const natW = saved.width || 640;
    const natH = saved.height || 480;
    const w = Math.round(Number(args.width) || Math.min(natW, 800));
    const h = Math.round(w * (natH / natW));
    let pos;
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) pos = { x: args.x, y: args.y };
    else pos = autoPlace(data.items, w, h, args.near_item_id);
    const now = new Date().toISOString();
    const item = {
      id: newId('img'), type: 'image', x: pos.x, y: pos.y, w, h, src: saved.src,
      naturalWidth: saved.width, naturalHeight: saved.height, author: 'claude',
      z: maxZ(data.items) + 1, createdAt: now, updatedAt: now,
    };
    if (args.caption) item.caption = String(args.caption);
    this.store.applyPatch(game, board, { upserts: [item] }, 'mcp');
    return textResult({ added: summarizeItem(item) });
  }

  tool_add_shape({ game, board, kind, x1, y1, x2, y2, color, width, dashed }) {
    if (!['arrow', 'line', 'rect', 'ellipse'].includes(kind)) throw new Error('kind must be arrow, line, rect or ellipse');
    for (const [k, v] of Object.entries({ x1, y1, x2, y2 })) if (!Number.isFinite(v)) throw new Error(`${k} must be a number`);
    const data = this.store.readBoard(game, board);
    const r = (n) => Math.round(n * 10) / 10;
    const x = Math.min(x1, x2), y = Math.min(y1, y2);
    const now = new Date().toISOString();
    const style = { color: color || '#e03131', width: Math.max(1, Math.min(60, Number(width) || 4)) };
    if (dashed) style.dash = true;
    const item = {
      id: newId('drw'), type: 'draw', kind, x: r(x), y: r(y),
      w: Math.max(1, r(Math.abs(x2 - x1))), h: Math.max(1, r(Math.abs(y2 - y1))),
      points: kind === 'arrow' || kind === 'line' ? [[r(x1 - x), r(y1 - y)], [r(x2 - x), r(y2 - y)]] : [],
      style, author: 'claude', z: maxZ(data.items) + 1, createdAt: now, updatedAt: now,
    };
    this.store.applyPatch(game, board, { upserts: [item] }, 'mcp');
    return textResult({ added: summarizeItem(item) });
  }

  tool_move_item({ game, board, item_id, x, y, width, height }) {
    const data = this.store.readBoard(game, board);
    const it = data.items.find((i) => i.id === item_id);
    if (!it) throw new Error(`Item "${item_id}" not found`);
    const next = { ...it };
    if (Number.isFinite(x)) next.x = x;
    if (Number.isFinite(y)) next.y = y;
    if (Number.isFinite(width)) {
      if (it.type === 'image' && !Number.isFinite(height) && it.w) next.h = Math.round(it.h * (width / it.w));
      next.w = Math.max(20, width);
    }
    if (Number.isFinite(height) && (it.type === 'image' || it.type === 'draw')) next.h = Math.max(1, height);
    if (it.type === 'draw' && Array.isArray(it.points) && it.w && it.h) {
      const sx = next.w / it.w, sy = next.h / it.h;
      next.points = it.points.map(([px, py]) => [Math.round(px * sx * 10) / 10, Math.round(py * sy * 10) / 10]);
    }
    next.updatedAt = new Date().toISOString();
    this.store.applyPatch(game, board, { upserts: [next] }, 'mcp');
    return textResult({ moved: summarizeItem(next) });
  }

  tool_set_image_caption({ game, board, item_id, caption }) {
    const data = this.store.readBoard(game, board);
    const it = data.items.find((i) => i.id === item_id);
    if (!it) throw new Error(`Item "${item_id}" not found`);
    if (it.type !== 'image') throw new Error('Captions are only for images; use update_text for notes');
    const next = { ...it, updatedAt: new Date().toISOString() };
    if (caption) next.caption = caption; else delete next.caption;
    this.store.applyPatch(game, board, { upserts: [next] }, 'mcp');
    return textResult({ updated: summarizeItem(next) });
  }

  tool_delete_item({ game, board, item_id }) {
    const data = this.store.readBoard(game, board);
    const it = data.items.find((i) => i.id === item_id);
    if (!it) throw new Error(`Item "${item_id}" not found`);
    this.store.applyPatch(game, board, { deletes: [item_id] }, 'mcp');
    return textResult({ deleted: item_id });
  }
}

module.exports = { McpServer, TOOLS, SERVER_NAME, INSTRUCTIONS };
