'use strict';
/* Tests for the data store + MCP server (plain Node, no framework). Run: npm test */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { BoardStore, imageSize, htmlToText, markdownToHtml, sanitizeName } = require('../src/core/store');
const { McpServer, TOOLS } = require('../src/core/mcp');
const { startHttpServer } = require('../src/core/http-transport');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DwnwGKGXAKAEnzA/1vXyY2AAAAAElFTkSuQmCC', 'base64');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack}`);
    process.exitCode = 1;
  }
}

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gdb-test-')); }
const call = async (mcp, name, args) => {
  const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.error) throw new Error(r.error.message);
  return r.result;
};
const json = (result) => JSON.parse(result.content[0].text);

(async () => {
  console.log('store');
  await test('sanitizeName strips invalid characters', () => {
    assert.strictEqual(sanitizeName('  My: Game?  '), 'My Game');
    assert.throws(() => sanitizeName('///'));
    assert.throws(() => sanitizeName('CON'));
  });
  await test('imageSize reads PNG header', () => {
    assert.deepStrictEqual(imageSize(PNG), { width: 2, height: 3, mime: 'image/png', ext: 'png' });
  });
  await test('markdown round trip to text', () => {
    const html = markdownToHtml('# Title\n- **bold** item\n- [x] done');
    assert.ok(html.includes('<b>bold</b>'));
    const text = htmlToText(html);
    assert.ok(text.includes('Title') && text.includes('• bold item') && text.includes('☑ done'));
  });
  await test('games, boards, patch, case-insensitive lookup', () => {
    const s = new BoardStore(tmpRoot());
    s.createGame('Space Game');
    s.createBoard('space game', 'Bugs');
    assert.throws(() => s.createGame('Space Game'));
    const games = s.listGames();
    assert.strictEqual(games[0].name, 'Space Game');
    assert.strictEqual(games[0].boards[0].name, 'Bugs');
    s.applyPatch('Space Game', 'BUGS', { upserts: [{ id: 'a', type: 'text', x: 0, y: 0, w: 100, html: 'hi', text: 'hi' }] }, 'test');
    s.applyPatch('Space Game', 'Bugs', { upserts: [{ id: 'b', type: 'text', x: 0, y: 0, w: 100, html: 'yo', text: 'yo' }] }, 'test');
    let b = s.readBoard('Space Game', 'Bugs');
    assert.strictEqual(b.items.length, 2);
    assert.strictEqual(b.rev, 2);
    s.applyPatch('Space Game', 'Bugs', { deletes: ['a'] }, 'test');
    b = s.readBoard('Space Game', 'Bugs');
    assert.deepStrictEqual(b.items.map((i) => i.id), ['b']);
    s.renameBoard('Space Game', 'Bugs', 'Known Bugs');
    s.renameGame('Space Game', 'Space Game 2');
    assert.strictEqual(s.readBoard('Space Game 2', 'Known Bugs').items.length, 1);
  });
  await test('folders created outside the app show up', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'Manual Game', 'Manual Board'), { recursive: true });
    const s = new BoardStore(root);
    assert.strictEqual(s.listGames()[0].boards[0].name, 'Manual Board');
    assert.deepStrictEqual(s.readBoard('Manual Game', 'Manual Board').items, []);
  });
  await test('image path traversal is blocked', () => {
    const s = new BoardStore(tmpRoot());
    s.createGame('G'); s.createBoard('G', 'B');
    assert.throws(() => s.imagePath('G', 'B', '../../../etc/passwd'));
    assert.throws(() => s.boardDir('G', '..'));
  });

  console.log('mcp');
  const root = tmpRoot();
  const store = new BoardStore(root);
  const mcp = new McpServer({ store, version: '9.9.9', getActiveBoard: () => ({ game: 'Racer', board: 'Bugs' }) });
  const events = [];
  store.on('board-changed', (e) => events.push(e));

  await test('initialize + tools/list', async () => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.strictEqual(r.result.protocolVersion, '2025-06-18');
    assert.strictEqual(r.result.serverInfo.version, '9.9.9');
    assert.strictEqual(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const l = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.strictEqual(l.result.tools.length, TOOLS.length);
    for (const t of l.result.tools) assert.strictEqual(t.inputSchema.type, 'object');
  });
  await test('unknown method -> -32601', async () => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' });
    assert.strictEqual(r.error.code, -32601);
  });
  await test('create game/board, add + read text', async () => {
    await call(mcp, 'create_game', { name: 'Racer' });
    await call(mcp, 'create_board', { game: 'Racer', name: 'Bugs' });
    const added = json(await call(mcp, 'add_text', { game: 'racer', board: 'bugs', text: '## Repro\n- **crash** on boost', background: 'yellow' }));
    assert.strictEqual(added.added.author, 'claude');
    assert.strictEqual(events.at(-1).source, 'mcp');
    const b = json(await call(mcp, 'get_board', { game: 'Racer', board: 'Bugs' }));
    assert.strictEqual(b.items.length, 1);
    assert.ok(b.items[0].text.includes('crash on boost') || b.items[0].text.includes('**crash** on boost'));
    assert.strictEqual(b.items[0].style.background, 'yellow');
  });
  await test('add image from base64 + near placement + get_image', async () => {
    const r = json(await call(mcp, 'add_image', { game: 'Racer', board: 'Bugs', base64: PNG.toString('base64'), width: 200, caption: 'boost crash' }));
    assert.strictEqual(r.added.w, 200);
    assert.strictEqual(r.added.h, 300);
    const note = json(await call(mcp, 'add_text', { game: 'Racer', board: 'Bugs', text: 'Looks like a null ref', near_item_id: r.added.id }));
    assert.strictEqual(note.added.x, r.added.x + 200 + 32);
    const img = await call(mcp, 'get_image', { game: 'Racer', board: 'Bugs', image_id: r.added.id });
    assert.strictEqual(img.content[1].type, 'image');
    assert.strictEqual(img.content[1].mimeType, 'image/png');
    const full = await call(mcp, 'get_board', { game: 'Racer', board: 'Bugs', include_images: true });
    assert.ok(full.content.some((c) => c.type === 'image'));
  });
  await test('update_text append + style, move, caption, search, delete', async () => {
    const b = json(await call(mcp, 'get_board', { game: 'Racer', board: 'Bugs' }));
    const txt = b.items.find((i) => i.type === 'text');
    const u = json(await call(mcp, 'update_text', { game: 'Racer', board: 'Bugs', item_id: txt.id, append: '- fixed in 1.2', bold: true, background: 'none' }));
    assert.ok(u.updated.text.includes('fixed in 1.2'));
    assert.strictEqual(u.updated.style.bold, true);
    assert.strictEqual(u.updated.style.background, undefined);
    const m = json(await call(mcp, 'move_item', { game: 'Racer', board: 'Bugs', item_id: txt.id, x: 5, y: 6 }));
    assert.strictEqual(m.moved.x, 5);
    const s = json(await call(mcp, 'search_boards', { query: 'null ref' }));
    assert.strictEqual(s.count, 1);
    const img = b.items.find((i) => i.type === 'image');
    await call(mcp, 'set_image_caption', { game: 'Racer', board: 'Bugs', item_id: img.id, caption: '' });
    await call(mcp, 'delete_item', { game: 'Racer', board: 'Bugs', item_id: txt.id });
    const after = json(await call(mcp, 'get_board', { game: 'Racer', board: 'Bugs' }));
    assert.strictEqual(after.items.length, 2);
  });
  await test('add_shape arrow is readable back with endpoints', async () => {
    const r = json(await call(mcp, 'add_shape', { game: 'Racer', board: 'Bugs', kind: 'arrow', x1: 500, y1: 400, x2: 300, y2: 250, color: '#1c7ed6' }));
    assert.strictEqual(r.added.kind, 'arrow');
    assert.deepStrictEqual(r.added.from, { x: 500, y: 400 });
    assert.deepStrictEqual(r.added.to, { x: 300, y: 250 });
    assert.strictEqual(r.added.x, 300);
    const m = json(await call(mcp, 'move_item', { game: 'Racer', board: 'Bugs', item_id: r.added.id, width: 400 }));
    assert.deepStrictEqual(m.moved.to, { x: 300, y: 250 });
    assert.deepStrictEqual(m.moved.from, { x: 700, y: 400 });
    const bad = await call(mcp, 'add_shape', { game: 'Racer', board: 'Bugs', kind: 'star', x1: 0, y1: 0, x2: 1, y2: 1 });
    assert.strictEqual(bad.isError, true);
    await call(mcp, 'delete_item', { game: 'Racer', board: 'Bugs', item_id: r.added.id });
  });
  await test('tool errors come back as isError results', async () => {
    const r = await call(mcp, 'get_board', { game: 'Nope', board: 'x' });
    assert.strictEqual(r.isError, true);
    assert.ok(r.content[0].text.includes('not found'));
  });
  await test('get_active_board', async () => {
    assert.deepStrictEqual(json(await call(mcp, 'get_active_board', {})).active, { game: 'Racer', board: 'Bugs' });
  });

  console.log('transports');
  const server = await startHttpServer(mcp, { port: 0 });
  const port = server.address().port;
  await test('HTTP: initialize returns session id, notifications get 202, bad origin 403', async () => {
    const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('mcp-session-id'));
    assert.strictEqual((await r.json()).result.protocolVersion, '2025-03-26');
    assert.strictEqual((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.strictEqual((await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, { Origin: 'https://evil.example' })).status, 403);
    const g = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.strictEqual(g.status, 405);
  });

  async function runStdio(env, messages) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'core', 'stdio-server.js')], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await new Promise((r) => child.on('exit', r));
    return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  await test('stdio: forwards to running app', async () => {
    const res = await runStdio({ GDB_MCP_PORT: String(port), GDB_USER_DATA: tmpRoot() }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_active_board', arguments: {} } },
    ]);
    assert.strictEqual(res.length, 2);
    assert.ok(res[1].result.content[0].text.includes('Racer'));
  });
  await test('stdio: falls back to files when app is not running', async () => {
    const res = await runStdio({ GDB_MCP_PORT: '1', GDB_DATA_ROOT: root, GDB_USER_DATA: tmpRoot() }, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_games', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_active_board', arguments: {} } },
    ]);
    assert.ok(JSON.parse(res[0].result.content[0].text).games.some((g) => g.name === 'Racer'));
    assert.ok(res[1].result.content[0].text.includes('not running'));
  });
  server.close();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
