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
const transfer = require('../src/core/transfer');

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

  console.log('export / import security');
  await test('sanitizeHtml strips scripts, handlers, links, svg, css url()', () => {
    const evil = [
      '<div>ok<script>alert(1)</script></div>',
      '<img src=x onerror=alert(1)>',
      '<b onclick="alert(1)">bold</b>',
      '<a href="javascript:alert(1)">link</a>',
      '<svg><script>alert(1)</script></svg>',
      '<iframe src="https://evil.example"></iframe>',
      '<span style="background:url(https://evil.example/x.png);color:red">c</span>',
      '<span style="color: expression(alert(1))">e</span>',
      '<div style="font-size: 20px; behavior: url(x.htc)">s</div>',
      '<style>*{background:url(//evil)}</style>',
      '<!-- <script>alert(1)</script> -->',
      '<scr<script>ipt>alert(1)</script>',
      '<img src=x onerror=alert(1)',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<font color="red" face="Arial" onmouseover="x()">f</font>',
      '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>',
    ].join('');
    const out = transfer.sanitizeHtml(evil);
    assert.ok(!/<script|<img|<a |<svg|<iframe|<style|<math|onerror|onclick|onmouseover|javascript:|url\(|expression|behavior/i.test(out), out);
    assert.ok(out.includes('<b>bold</b>'));
    assert.ok(out.includes('style="color: red"'));
    assert.ok(out.includes('style="font-size: 20px"'));
    assert.ok(out.includes('<font color="red" face="Arial">f</font>'));
    assert.ok(out.includes('&lt;script&gt;'), 'escaped text stays escaped');
  });
  await test('sanitizeHtml keeps app-generated formatting intact', () => {
    const html = '<div><b><span style="font-size: 1.35em;">Title</span></b></div><div>• item <i>x</i> <code>y</code></div><ul><li>a</li></ul>';
    const out = transfer.sanitizeHtml(html);
    assert.ok(out.includes('<span style="font-size: 1.35em">Title</span>'));
    assert.ok(out.includes('<ul><li>a</li></ul>'));
  });

  await test('export -> import round trip (board and game), with name conflicts', () => {
    const src = new BoardStore(tmpRoot());
    src.createGame('Dirt Digger'); src.createBoard('Dirt Digger', 'Ideas'); src.createBoard('Dirt Digger', 'Bugs');
    const img = src.saveImage('Dirt Digger', 'Ideas', PNG);
    src.applyPatch('Dirt Digger', 'Ideas', { upserts: [
      { id: 't1', type: 'text', x: 1, y: 2, w: 300, h: 40, html: '<b>Head</b> turn', text: 'Head turn', style: { background: 'yellow', bold: true }, author: 'user' },
      { id: 'i1', type: 'image', x: 10, y: 60, w: 2, h: 3, src: img.src, caption: 'loader' },
      { id: 'd1', type: 'draw', kind: 'arrow', x: 0, y: 0, w: 50, h: 20, points: [[0, 0], [50, 20]], style: { color: '#e03131', width: 4 } },
    ] }, 'test');
    const boardBuf = transfer.exportToBuffer(src, 'dirt digger', ['ideas'], '1.0.2');
    const gameBuf = transfer.exportToBuffer(src, 'Dirt Digger', null, '1.0.2');

    const dst = new BoardStore(tmpRoot());
    dst.createGame('Dirt Digger'); dst.createBoard('Dirt Digger', 'Ideas');
    const pb = transfer.parseExport(boardBuf);
    assert.strictEqual(pb.kind, 'board');
    assert.strictEqual(pb.imageCount, 1);
    const r1 = transfer.importParsed(dst, pb, { targetGame: 'Dirt Digger' });
    assert.deepStrictEqual(r1.boards, ['Ideas (2)']);
    const b = dst.readBoard('Dirt Digger', 'Ideas (2)');
    assert.strictEqual(b.items.length, 3);
    const im = b.items.find((i) => i.type === 'image');
    assert.ok(/^images\/img_[0-9a-f]+\.png$/.test(im.src));
    assert.ok(dst.readImage('Dirt Digger', 'Ideas (2)', im.src).buffer.equals(PNG));
    assert.ok(b.items.every((i) => !['t1', 'i1', 'd1'].includes(i.id)), 'ids are regenerated');
    assert.deepStrictEqual(b.items.find((i) => i.type === 'text').style, { background: 'yellow', bold: true });

    const pg = transfer.parseExport(gameBuf);
    assert.strictEqual(pg.kind, 'game');
    const r2 = transfer.importParsed(dst, pg, { newGameName: 'Dirt Digger' });
    assert.strictEqual(r2.game, 'Dirt Digger (2)');
    assert.deepStrictEqual(r2.boards.sort(), ['Bugs', 'Ideas']);
  });

  await test('malicious export: traversal, fake images, svg, bad items, prototype pollution', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
    const htmlAsPng = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const evil = {
      format: 'game-dev-board-export', formatVersion: 1, kind: 'game',
      game: '../../../Windows/System32',
      boards: [
        {
          name: '..\\..\\evil',
          images: {
            '../../../../evil.exe': { mime: 'image/png', data: PNG.toString('base64') },
            'images/x.svg': { mime: 'image/svg+xml', data: svg },
            'images/y.png': { mime: 'image/png', data: htmlAsPng },
          },
          items: [
            { type: 'image', src: '../../../../evil.exe', x: 0, y: 0, w: 10, h: 10 },
            { type: 'image', src: 'images/x.svg', x: 0, y: 0, w: 10, h: 10 },
            { type: 'image', src: 'images/y.png', x: 0, y: 0, w: 10, h: 10 },
            { type: 'image', src: 'C:/Windows/notepad.exe', x: 0, y: 0 },
            { type: 'script', code: 'alert(1)' },
            { type: 'text', x: 'NaN', y: 1e99, html: '<img src=x onerror=alert(1)>hi', style: { color: 'red;background:url(//evil)', fontFamily: 'x;}</style><script>', background: 'url(//x)' }, __proto__: { polluted: true } },
            { type: 'draw', kind: 'pen', points: [[0, 0], ['a', {}], [1, 2]], style: { color: 'javascript:alert(1)', width: 1e9 } },
            { type: 'draw', kind: 'arrow', points: [[0, 0]] },
          ],
        },
      ],
    };
    const json = JSON.stringify(evil)
      .replace('{"type":"text",', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"type":"text",')
      .replace('{"format":', '{"__proto__":{"polluted":true},"format":');
    assert.ok(json.includes('{"__proto__":{"polluted":true},"constructor"'));
    const p = transfer.parseExport(Buffer.from(json));
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.ok(!('polluted' in p.boards[0].items[1]));
    assert.ok(!p.game.includes('/') && !p.game.includes('\\') && !p.game.startsWith('.'));
    const b = p.boards[0];
    assert.ok(!b.name.includes('/') && !b.name.includes('\\') && !b.name.startsWith('.'));
    assert.strictEqual(b.images.size, 1, 'only the real PNG survives');
    const types = b.items.map((i) => i.type + (i.kind ? ':' + i.kind : ''));
    assert.deepStrictEqual(types, ['image', 'text', 'draw:pen']);
    const t = b.items[1];
    assert.strictEqual(t.html, 'hi');
    assert.deepStrictEqual(t.style, {});
    assert.strictEqual(t.x, 0);
    assert.strictEqual(t.y, 1e7);
    const d = b.items[2];
    assert.strictEqual(d.style.color, '#e03131');
    assert.strictEqual(d.style.width, 120);
    assert.ok(p.warnings.length >= 2);

    const root = tmpRoot();
    const dst = new BoardStore(root);
    const r = transfer.importParsed(dst, p, {});
    const gameDir = path.join(root, r.game);
    assert.ok(fs.existsSync(gameDir) && path.dirname(gameDir) === root, 'game created inside the data folder');
    const files = fs.readdirSync(path.join(gameDir, r.boards[0], 'images'));
    assert.strictEqual(files.length, 1);
    assert.ok(/^img_[0-9a-f]+\.png$/.test(files[0]));
    assert.ok(!fs.existsSync(path.join(root, '..', 'evil.exe')));
  });

  await test('non-exports and future versions are rejected', () => {
    assert.throws(() => transfer.parseExport(Buffer.from('MZ\x90\x00 not json')), /not a Game Development Board export/);
    assert.throws(() => transfer.parseExport(Buffer.from('{"hello":1}')), /not a Game Development Board export/);
    assert.throws(() => transfer.parseExport(Buffer.from('{"format":"game-dev-board-export","formatVersion":99,"boards":[{}]}')), /newer version/);
    assert.throws(() => transfer.parseExport(Buffer.from('{"format":"game-dev-board-export","formatVersion":1,"boards":[]}')), /no boards/);
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
