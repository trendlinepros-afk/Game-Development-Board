'use strict';
/* App shell: sidebar tree, toolbar, MCP + updater UI. */
(function () {
  const { $, esc, showModal, promptModal, confirmModal, contextMenu, toast } = window.UI;
  const api = window.api;

  const NOTE_SWATCHES = ['none', 'yellow', 'tan', 'green', 'blue', 'pink', 'purple', 'gray'];
  const ICONS = {
    caret: '<svg class="caret" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    game: '<svg class="tree-icon" viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="13" height="8" rx="3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5 7v3M3.5 8.5h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="10.5" cy="7.6" r=".9" fill="currentColor"/><circle cx="12" cy="9.4" r=".9" fill="currentColor"/></svg>',
    board: '<svg class="tree-icon" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5 5.5h4M5 8h6M5 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    dots: '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  };

  const state = {
    games: [],
    expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
    current: null, // {game, board}
    info: null,
  };

  const wrap = $('#canvasWrap');
  const boardView = new window.BoardView({
    wrap,
    world: $('#world'),
    onSelectionChange: updateFormatBar,
    onSaveState: (s, msg) => {
      const el = $('#saveState');
      el.className = s === 'saving' ? 'saving' : s === 'error' ? 'error' : '';
      el.textContent = s === 'saving' ? 'Saving…' : s === 'error' ? `Save failed: ${msg}` : 'Saved';
    },
    onToolChange: () => renderDrawbar(),
    onZoom: (z) => { $('#zoomLabel').textContent = `${Math.round(z * 100)}%`; },
    onExternalChange: ({ added, changed }) => {
      if (added || changed) {
        const parts = [];
        if (added) parts.push(`added ${added} item${added > 1 ? 's' : ''}`);
        if (changed) parts.push(`updated ${changed} item${changed > 1 ? 's' : ''}`);
        toast(`Claude ${parts.join(' and ')}`, 'claude');
      }
    },
  });

  // ================= theme =================
  function setTheme(theme) {
    if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
    updateFormatBar();
  }
  $('#themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  // ================= tree =================
  function saveExpanded() { localStorage.setItem('expanded', JSON.stringify([...state.expanded])); }

  async function refreshTree() {
    try {
      state.games = await api.listGames();
    } catch (err) {
      toast(`Could not read games: ${err.message}`, 'error');
      state.games = [];
    }
    // If the open board vanished (deleted/renamed outside the app), close it.
    if (state.current) {
      const g = state.games.find((x) => x.name === state.current.game);
      if (!g || !g.boards.some((b) => b.name === state.current.board)) {
        await boardView.close();
        state.current = null;
      }
    }
    renderTree();
    renderCrumbs();
    renderEmptyState();
  }

  function renderTree() {
    const tree = $('#gameTree');
    tree.innerHTML = '';
    if (!state.games.length) {
      tree.innerHTML = '<div class="tree-empty">No games yet.<br/>Click <b>+</b> above to create one.</div>';
      return;
    }
    for (const g of state.games) {
      const open = state.expanded.has(g.name);
      const row = document.createElement('div');
      row.className = `tree-row game${open ? ' expanded' : ''}`;
      row.innerHTML = `${ICONS.caret}${ICONS.game}<span class="name" title="${esc(g.name)}">${esc(g.name)}</span>
        <span class="row-actions"><button class="icon-btn" data-act="add" title="New board">${ICONS.plus}</button><button class="icon-btn" data-act="menu" title="More">${ICONS.dots}</button></span>`;
      row.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'add') { e.stopPropagation(); newBoard(g.name); return; }
        if (act === 'menu') { e.stopPropagation(); const r = e.target.closest('button').getBoundingClientRect(); gameMenu(g.name, r.left, r.bottom + 4); return; }
        if (open) state.expanded.delete(g.name); else state.expanded.add(g.name);
        saveExpanded();
        renderTree();
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); gameMenu(g.name, e.clientX, e.clientY); });
      tree.appendChild(row);
      if (!open) continue;
      if (!g.boards.length) {
        const empty = document.createElement('div');
        empty.className = 'tree-children-empty';
        empty.innerHTML = 'No boards · <a>create one</a>';
        empty.querySelector('a').addEventListener('click', () => newBoard(g.name));
        tree.appendChild(empty);
      }
      for (const b of g.boards) {
        const active = state.current && state.current.game === g.name && state.current.board === b.name;
        const br = document.createElement('div');
        br.className = `tree-row board${active ? ' active' : ''}`;
        br.innerHTML = `${ICONS.board}<span class="name" title="${esc(b.name)}">${esc(b.name)}</span><span class="row-actions"><button class="icon-btn" data-act="menu" title="More">${ICONS.dots}</button></span>`;
        br.addEventListener('click', (e) => {
          if (e.target.closest('[data-act="menu"]')) {
            e.stopPropagation();
            const r = e.target.closest('button').getBoundingClientRect();
            boardMenu(g.name, b.name, r.left, r.bottom + 4);
            return;
          }
          openBoard(g.name, b.name);
        });
        br.addEventListener('contextmenu', (e) => { e.preventDefault(); boardMenu(g.name, b.name, e.clientX, e.clientY); });
        tree.appendChild(br);
      }
    }
  }

  function gameMenu(game, x, y) {
    contextMenu(x, y, [
      { label: 'New board…', action: () => newBoard(game) },
      { label: 'Rename game…', action: () => renameGame(game) },
      { label: 'Open folder', action: () => api.openFolder(game) },
      'sep',
      { label: 'Export game…', action: () => exportItem(game, null) },
      'sep',
      { label: 'Delete game', danger: true, action: () => deleteGame(game) },
    ]);
  }

  function boardMenu(game, board, x, y) {
    contextMenu(x, y, [
      { label: 'Open', action: () => openBoard(game, board) },
      { label: 'Rename board…', action: () => renameBoard(game, board) },
      { label: 'Open folder', action: () => api.openFolder(game, board) },
      'sep',
      { label: 'Export board…', action: () => exportItem(game, board) },
      'sep',
      { label: 'Delete board', danger: true, action: () => deleteBoard(game, board) },
    ]);
  }

  async function openBoard(game, board) {
    try {
      await boardView.open(game, board);
      state.current = { game: boardView.game, board: boardView.board };
      state.expanded.add(boardView.game);
      saveExpanded();
      localStorage.setItem('lastBoard', JSON.stringify(state.current));
      renderTree();
      renderCrumbs();
      renderEmptyState();
      wrap.focus({ preventScroll: true });
    } catch (err) {
      toast(`Could not open board: ${err.message}`, 'error');
    }
  }

  async function newGame() {
    const name = await promptModal('New game', 'Game name', '');
    if (!name) return;
    try {
      const g = await api.createGame(name);
      const b = await api.createBoard(g.name, 'Ideas');
      state.expanded.add(g.name);
      saveExpanded();
      await refreshTree();
      await openBoard(g.name, b.name);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function newBoard(game) {
    const name = await promptModal(`New board in “${game}”`, 'Board name', '');
    if (!name) return;
    try {
      const b = await api.createBoard(game, name);
      state.expanded.add(game);
      saveExpanded();
      await refreshTree();
      await openBoard(game, b.name);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function renameGame(game) {
    const name = await promptModal('Rename game', 'Game name', game, 'Rename');
    if (!name || name === game) return;
    try {
      await boardView.flush();
      const r = await api.renameGame(game, name);
      if (state.expanded.delete(game)) state.expanded.add(r.name);
      saveExpanded();
      if (state.current && state.current.game === game) {
        state.current.game = r.name;
        boardView.renamed({ game: r.name });
        localStorage.setItem('lastBoard', JSON.stringify(state.current));
      }
      await refreshTree();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function renameBoard(game, board) {
    const name = await promptModal('Rename board', 'Board name', board, 'Rename');
    if (!name || name === board) return;
    try {
      await boardView.flush();
      const r = await api.renameBoard(game, board, name);
      if (state.current && state.current.game === game && state.current.board === board) {
        state.current.board = r.name;
        boardView.renamed({ board: r.name });
        localStorage.setItem('lastBoard', JSON.stringify(state.current));
      }
      await refreshTree();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteGame(game) {
    const ok = await confirmModal('Delete game?', `“<b>${esc(game)}</b>” and all of its boards will be moved to the Recycle Bin.`);
    if (!ok) return;
    try {
      if (state.current && state.current.game === game) { await boardView.close(); state.current = null; }
      await api.deleteGame(game);
      await refreshTree();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteBoard(game, board) {
    const ok = await confirmModal('Delete board?', `“<b>${esc(board)}</b>” will be moved to the Recycle Bin.`);
    if (!ok) return;
    try {
      if (state.current && state.current.game === game && state.current.board === board) { await boardView.close(); state.current = null; }
      await api.deleteBoard(game, board);
      await refreshTree();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ================= export / import =================
  async function exportItem(game, board) {
    try {
      if (state.current && state.current.game === game) await boardView.flush();
      const r = await (board ? api.exportBoard(game, board) : api.exportGame(game));
      if (!r) return;
      const mb = (r.bytes / 1e6).toFixed(1);
      showModal({
        title: 'Export ready',
        body: `<p>Saved <b>${esc(r.file.split(/[\\/]/).pop())}</b> (${mb} MB).</p><p>Send this file to whoever should get it. They import it with the <b>Import</b> button at the top of the sidebar, or by dragging the file onto the app.</p>`,
        buttons: [{ label: 'Show in folder', value: 'show' }, { label: 'Done', value: true, primary: true }],
      }).then((v) => { if (v === 'show') api.showFile(r.file); });
    } catch (err) { toast(`Export failed: ${err.message}`, 'error', 6000); }
  }

  async function importFile(fileOrPath) {
    let filePath = null;
    if (fileOrPath && typeof fileOrPath === 'object') {
      filePath = api.pathForFile(fileOrPath);
      if (!filePath) { toast('Could not read that file', 'error'); return; }
    } else if (typeof fileOrPath === 'string') filePath = fileOrPath;
    let info;
    try {
      info = await api.importPrepare(filePath);
    } catch (err) {
      showModal({ title: 'Can’t import this file', body: `<p>${esc(err.message)}</p>`, buttons: [{ label: 'OK', value: true, primary: true }] });
      return;
    }
    if (!info) return;
    const body = document.createElement('div');
    const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString() : 'unknown date';
    const boardList = info.boards.map((b) => `<li><b>${esc(b.name)}</b> <span style="color:var(--faint)">· ${b.items} item${b.items === 1 ? '' : 's'}${b.images ? `, ${b.images} image${b.images === 1 ? '' : 's'}` : ''}</span></li>`).join('');
    const options = [];
    if (info.existingGame) options.push(`<option value="existing:${esc(info.existingGame)}" selected>Add to existing game “${esc(info.existingGame)}”</option>`);
    options.push(`<option value="new" ${info.existingGame ? '' : 'selected'}>New game “${esc(info.newGameName)}”</option>`);
    for (const g of info.games) if (g !== info.existingGame) options.push(`<option value="existing:${esc(g)}">Add to “${esc(g)}”</option>`);
    body.innerHTML = `
      <p>${info.kind === 'board' ? 'A board' : 'A game'} from <b>${esc(info.game)}</b>, exported ${esc(when)}${info.appVersion ? ` (app v${esc(info.appVersion)})` : ''}.</p>
      <ul style="margin:0 0 12px; padding-left:18px; max-height:180px; overflow:auto">${boardList}</ul>
      <label>Import into</label>
      <select id="importTarget" style="width:100%;height:36px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:0 8px;font:inherit">${options.join('')}</select>
      <p style="margin-top:10px;font-size:12px">Boards with the same name as one you already have are added alongside it, e.g. “Ideas (2)”. Nothing of yours is overwritten.</p>
      ${info.warnings.length ? `<p style="color:var(--warn);font-size:12px">${info.warnings.map(esc).join('<br/>')}</p>` : ''}`;
    let target = null;
    const ok = await showModal({
      title: `Import “${info.fileName}”`,
      body,
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'Import', primary: true, value: (m) => { target = m.querySelector('#importTarget').value; return true; } },
      ],
    });
    if (!ok) { api.importCancel(info.token).catch(() => {}); return; }
    try {
      const opts = target && target.startsWith('existing:') ? { targetGame: target.slice(9) } : { newGameName: info.newGameName };
      const r = await api.importCommit(info.token, opts);
      state.expanded.add(r.game);
      saveExpanded();
      await refreshTree();
      if (r.boards[0]) await openBoard(r.game, r.boards[0]);
      toast(`Imported ${r.boards.length} board${r.boards.length === 1 ? '' : 's'} into “${r.game}”`);
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error', 6000);
    }
  }
  $('#importBtn').addEventListener('click', () => importFile(null));

  // Dropping a .gdboard file anywhere on the window imports it. Any other drop outside
  // the canvas is ignored (and never opened by the browser).
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (boardView.game && wrap.contains(e.target)) return; // an open board's canvas handles its own drops
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.gdboard$/i.test(x.name));
    if (f) importFile(f);
    else if (e.dataTransfer?.files?.length) toast('Drop images on the canvas, or .gdboard files to import');
  });

  function renderCrumbs() {
    const c = $('#crumbs');
    if (!state.current) { c.innerHTML = '<span class="crumb-game">No board open</span>'; return; }
    c.innerHTML = `<span class="crumb-game">${esc(state.current.game)}</span><span class="crumb-sep">/</span><span class="crumb-board" title="Double-click to rename">${esc(state.current.board)}</span>`;
    c.querySelector('.crumb-board').addEventListener('dblclick', () => renameBoard(state.current.game, state.current.board));
  }

  function renderEmptyState() {
    const el = $('#emptyState');
    const hasBoard = !!state.current;
    wrap.classList.toggle('no-board', !hasBoard);
    $('#toolbar').querySelectorAll('.toolbar-group').forEach((g) => g.classList.toggle('disabled', !hasBoard));
    $('#drawbar').classList.toggle('disabled', !hasBoard);
    if (hasBoard) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const hasGames = state.games.length > 0;
    el.innerHTML = `<div>
      <img src="icon.png" alt="" />
      <h2>${hasGames ? 'Pick a board' : 'Welcome to Game Dev Board'}</h2>
      <div>${hasGames
        ? 'Choose a board from a game on the left, or create a new one.'
        : 'Create a game, then fill its boards with ideas and screenshots.<br/>Paste images with <kbd>Ctrl</kbd>+<kbd>V</kbd>, click anywhere to type, and let Claude read and write notes over MCP.'}</div>
      ${hasGames ? '' : '<button class="btn btn-primary" id="emptyNewGame">Create your first game</button>'}
    </div>`;
    const b = el.querySelector('#emptyNewGame');
    if (b) b.addEventListener('click', newGame);
  }

  // ================= format toolbar =================
  const formatBar = $('#formatBar');
  const swatchesEl = $('#noteSwatches');
  for (const n of NOTE_SWATCHES) {
    const s = document.createElement('button');
    s.className = `swatch${n === 'none' ? ' none' : ''}`;
    s.dataset.note = n;
    s.title = n === 'none' ? 'No background' : `${n[0].toUpperCase()}${n.slice(1)} note`;
    swatchesEl.appendChild(s);
  }

  // Keep focus in the note editor while clicking toolbar buttons.
  formatBar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  formatBar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.note) { boardView.applyFormat('background', b.dataset.note === 'none' ? null : b.dataset.note); return; }
    if (b.dataset.fmt === 'align') { boardView.applyFormat('align', b.dataset.value); return; }
    if (b.dataset.fmt) boardView.applyFormat(b.dataset.fmt);
  });
  $('#fontFamily').addEventListener('change', (e) => boardView.applyFormat('fontFamily', e.target.value));
  $('#fontSize').addEventListener('change', (e) => boardView.applyFormat('fontSize', Number(e.target.value)));
  $('#textColor').addEventListener('input', (e) => {
    $('#colorSwatch').style.background = e.target.value;
  });
  $('#textColor').addEventListener('change', (e) => boardView.applyFormat('color', e.target.value));

  function rgbToHex(c) {
    c = String(c).trim();
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`;
    const m = c.match(/\d+/g);
    if (!m) return '#000000';
    return `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  }

  function updateFormatBar(sel) {
    sel = sel || { textItems: boardView.selectedTextItems() };
    if (typeof renderDrawbar === 'function' && document.getElementById('drawbar')) try { renderDrawbar(); } catch { /* during init */ }
    const items = sel.textItems || [];
    const has = items.length > 0 && !!state.current;
    formatBar.classList.toggle('disabled', !has);
    const st = (items[0] && items[0].style) || {};
    for (const k of ['bold', 'italic', 'underline', 'strike']) {
      const b = formatBar.querySelector(`[data-fmt="${k}"]`);
      if (b) b.classList.toggle('on', !!st[k]);
    }
    formatBar.querySelectorAll('[data-fmt="align"]').forEach((b) => b.classList.toggle('on', (st.align || 'left') === b.dataset.value && has));
    $('#fontFamily').value = st.fontFamily || '';
    $('#fontSize').value = String(st.fontSize || 18);
    if (![...$('#fontSize').options].some((o) => o.value === String(st.fontSize || 18))) {
      const o = document.createElement('option'); o.textContent = String(st.fontSize); $('#fontSize').appendChild(o); $('#fontSize').value = String(st.fontSize);
    }
    const defColor = rgbToHex(getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#2d2a26');
    const color = st.color && st.color.startsWith('#') ? st.color : defColor;
    $('#textColor').value = color.length === 7 ? color : defColor;
    $('#colorSwatch').style.background = st.color || 'var(--text)';
    swatchesEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', has && (s.dataset.note === (st.background || 'none'))));
  }

  // ================= drawing toolbar =================
  const STROKE_COLORS = [
    ['#e03131', 'Red'], ['#f08c00', 'Orange'], ['#f5c400', 'Yellow'], ['#2f9e44', 'Green'],
    ['#1c7ed6', 'Blue'], ['#7048e8', 'Purple'], ['ink', 'Ink (black in light mode, white in dark)'], ['#ffffff', 'White'],
  ];
  const strokeColorsEl = $('#strokeColors');
  for (const [c, name] of STROKE_COLORS) {
    const b = document.createElement('button');
    b.className = 'stroke-swatch';
    b.dataset.color = c;
    b.title = name;
    b.style.background = c === 'ink' ? 'var(--text)' : c;
    strokeColorsEl.appendChild(b);
  }
  const TOOL_HINTS = {
    select: '',
    pen: 'Draw freely · Esc to stop',
    highlighter: 'Highlight over screenshots · Esc to stop',
    line: 'Drag to draw a line · Shift snaps to 45°',
    arrow: 'Drag to draw an arrow · Shift snaps to 45°',
    rect: 'Drag to draw a box · Shift for a square',
    ellipse: 'Drag to draw an ellipse · Shift for a circle',
    eraser: 'Click or drag over drawings to erase them',
  };
  const drawbar = $('#drawbar');
  drawbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  drawbar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) boardView.setTool(b.dataset.tool);
    else if (b.dataset.color) boardView.setDrawStyle({ color: b.dataset.color });
    else if (b.dataset.width) boardView.setDrawStyle({ width: Number(b.dataset.width) });
    else if (b.id === 'dashBtn') boardView.setDrawStyle({ dash: !boardView.drawStyle.dash });
  });
  $('#strokeCustom').addEventListener('change', (e) => boardView.setDrawStyle({ color: e.target.value }));

  function renderDrawbar() {
    const sel = boardView.selectedDrawItems();
    // When drawings are selected, show their style so changes are predictable.
    const st = sel.length ? { ...boardView.drawStyle, ...(sel[0].style || {}), dash: !!(sel[0].style || {}).dash } : boardView.drawStyle;
    drawbar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === boardView.tool));
    drawbar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === st.color));
    const widthForUi = sel.length && sel[0].kind === 'highlighter' ? null : st.width;
    drawbar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('on', Number(b.dataset.width) === widthForUi));
    $('#dashBtn').classList.toggle('on', !!st.dash);
    $('#drawHint').textContent = sel.length && boardView.tool === 'select'
      ? `${sel.length} drawing${sel.length > 1 ? 's' : ''} selected · pick a color or width to change ${sel.length > 1 ? 'them' : 'it'}`
      : TOOL_HINTS[boardView.tool] || '';
  }

  // ================= toolbar actions =================
  $('#zoomInBtn').addEventListener('click', () => boardView.zoomAt(1.2));
  $('#zoomOutBtn').addEventListener('click', () => boardView.zoomAt(1 / 1.2));
  $('#zoomLabel').addEventListener('click', () => boardView.resetZoom());
  $('#fitBtn').addEventListener('click', () => boardView.fitToContent());
  $('#addTextBtn').addEventListener('click', () => {
    if (!state.current) return;
    const c = boardView.viewportCenter();
    boardView.addText({ x: c.x - 160, y: c.y - 20 });
  });
  async function pickImages() {
    if (!state.current) return;
    const paths = await api.pickImages().catch(() => []);
    if (paths.length) await boardView.addImagesFromPaths(paths);
  }
  $('#addImageBtn').addEventListener('click', pickImages);
  $('#newGameBtn').addEventListener('click', newGame);

  // ================= data folder =================
  $('#dataFolderBtn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left + 10, r.top - 90, [
      { label: 'Open data folder', action: () => api.openDataRoot() },
      { label: 'Change data folder…', action: async () => {
        await boardView.close();
        state.current = null;
        const root = await api.chooseDataRoot().catch((err) => { toast(err.message, 'error'); return null; });
        if (root) { $('#dataRootLabel').textContent = root; toast('Data folder changed'); }
        await refreshTree();
      } },
    ]);
  });

  // ================= MCP =================
  function renderMcpStatus(s) {
    const dot = $('#mcpDot');
    dot.className = `dot ${s.running ? 'ok' : s.error ? 'err' : ''}`;
    $('#mcpLabel').textContent = s.running ? `MCP on :${s.port}` : s.error ? 'MCP error' : 'MCP starting…';
    $('#mcpBtn').title = s.error || `MCP server running at http://127.0.0.1:${s.port}/mcp`;
  }

  function codeBlock(text) {
    return `<div class="code-block"><pre>${esc(text)}</pre><button class="btn copy" data-copy="${esc(text)}">Copy</button></div>`;
  }

  async function showConnectClaude() {
    let info;
    try { info = await api.mcpConnectionInfo(); } catch (err) { toast(err.message, 'error'); return; }
    const s = info.status;
    const body = document.createElement('div');
    body.innerHTML = `
      <p><span class="status-pill"><span class="dot ${s.running ? 'ok' : 'err'}"></span>${s.running ? `Running at ${esc(info.httpUrl)}` : esc(s.error || 'Not running')}</span></p>
      <p>Claude can list your games, read boards (including screenshots) and write its own notes onto them. Changes appear live while the app is open.</p>
      <h4>Claude Desktop</h4>
      <p>One click adds this app to <code>claude_desktop_config.json</code>. Restart Claude Desktop afterwards.</p>
      <button class="btn btn-primary" id="installDesktop">Add to Claude Desktop</button>
      <details style="margin-top:8px"><summary style="cursor:pointer">Or add it manually</summary>
        <p style="margin-top:8px">Config file: <code>${esc(info.claudeDesktopConfigPath)}</code></p>
        ${codeBlock(info.claudeDesktopSnippet)}
      </details>
      <h4>Claude Code</h4>
      <p>Run once in a terminal (the app must be running while you use it):</p>
      ${codeBlock(info.claudeCodeCommand)}
      <h4>Any other MCP client</h4>
      <p>Streamable HTTP endpoint:</p>
      ${codeBlock(info.httpUrl)}`;
    body.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        await api.writeClipboardText(copy.dataset.copy);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      }
      if (e.target.id === 'installDesktop') {
        try {
          const r = await api.installClaudeDesktop();
          e.target.textContent = 'Added ✓';
          e.target.disabled = true;
          toast(`Added to ${r.file}. Restart Claude Desktop.`);
        } catch (err) { toast(err.message, 'error', 6000); }
      }
    });
    showModal({ title: 'Connect Claude', body, wide: true, buttons: [{ label: 'Done', value: true, primary: true }] });
  }
  $('#mcpBtn').addEventListener('click', showConnectClaude);

  // ================= updater =================
  let upd = { status: 'idle' };
  function fmtBytes(n) { return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round((n || 0) / 1e3)} KB`; }

  function renderUpdater(s) {
    upd = s || upd;
    const btn = $('#updateBtn');
    const label = $('#updateBtnLabel');
    const status = $('#updateStatus');
    const prog = $('#updateProgress');
    const badge = $('#updateBadge');
    btn.disabled = false;
    btn.classList.remove('btn-primary');
    prog.classList.add('hidden');
    badge.classList.add('hidden');
    status.className = 'update-status';
    status.textContent = '';
    if (upd.currentVersion) $('#versionLabel').textContent = `v${upd.currentVersion}`;
    switch (upd.status) {
      case 'checking':
        btn.disabled = true;
        label.innerHTML = '<span class="spinner"></span> Checking…';
        break;
      case 'available':
        label.textContent = `Download v${upd.version}`;
        btn.classList.add('btn-primary');
        badge.classList.remove('hidden');
        status.textContent = `A new version is available (you have v${upd.currentVersion}).`;
        break;
      case 'downloading':
        btn.disabled = true;
        label.textContent = `Downloading… ${upd.percent || 0}%`;
        prog.classList.remove('hidden');
        $('#updateProgressBar').style.width = `${upd.percent || 0}%`;
        if (upd.total) status.textContent = `${fmtBytes(upd.transferred)} of ${fmtBytes(upd.total)}`;
        break;
      case 'downloaded':
        label.textContent = `Restart & install v${upd.version}`;
        btn.classList.add('btn-primary');
        status.className = 'update-status ok';
        status.textContent = 'Update ready. The app will restart.';
        break;
      case 'not-available':
        label.textContent = 'Check for updates';
        if (upd.manual) { status.className = 'update-status ok'; status.textContent = 'You’re on the latest version.'; }
        break;
      case 'error':
        label.textContent = 'Check again';
        status.className = 'update-status error';
        status.textContent = upd.message || 'Update check failed.';
        break;
      case 'dev':
        label.textContent = 'Check for updates';
        status.textContent = upd.message;
        break;
      default:
        label.textContent = 'Check for updates';
    }
  }

  $('#updateBtn').addEventListener('click', async () => {
    if (upd.status === 'available') { renderUpdater({ ...upd, status: 'downloading', percent: 0 }); await api.updater.download(); return; }
    if (upd.status === 'downloaded') {
      await boardView.flush();
      await api.updater.install();
      return;
    }
    renderUpdater({ ...upd, status: 'checking' });
    const s = await api.updater.check();
    if (s) renderUpdater(s);
  });

  // ================= events from main =================
  api.on.treeChanged(() => refreshTree());
  api.on.boardChanged((evt) => {
    if (boardView.isOpen(evt.game, evt.board)) boardView.externalChange();
  });
  api.on.mcpStatus(renderMcpStatus);
  api.on.updaterState(renderUpdater);

  // ================= init =================
  async function init() {
    try {
      state.info = await api.appInfo();
      $('#versionLabel').textContent = `v${state.info.version}`;
      $('#dataRootLabel').textContent = state.info.dataRoot;
      $('#dataRootLabel').title = state.info.dataRoot;
      renderMcpStatus(state.info.mcp);
    } catch (err) {
      toast(err.message, 'error');
    }
    renderUpdater(await api.updater.getState());
    await refreshTree();
    let last = null;
    try { last = JSON.parse(localStorage.getItem('lastBoard')); } catch { /* ignore */ }
    if (last) {
      const g = state.games.find((x) => x.name === last.game);
      if (g && g.boards.some((b) => b.name === last.board)) await openBoard(last.game, last.board);
    }
    if (!state.current) {
      const first = state.games.find((g) => g.boards.length);
      if (first && state.games.length === 1) await openBoard(first.name, first.boards[0].name);
    }
    updateFormatBar();
  }

  window.App = { importFile, pickImages, openBoard, refreshTree, boardView };
  init();
})();
