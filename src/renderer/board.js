'use strict';
/* Infinite canvas board: text + image items, pan/zoom, paste, drag, resize, undo. */
(function () {
  const { esc, toast, contextMenu } = window.UI;
  const api = window.api;

  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const DRAG_THRESHOLD = 4;
  const DEFAULT_TEXT_W = 320;
  const MAX_PASTE_W = 900;
  const SAVE_DELAY = 350;

  // Named note colors are theme-aware (see --note-* in styles.css). Raw CSS colors also work.
  const NOTE_COLORS = ['yellow', 'tan', 'green', 'blue', 'pink', 'purple', 'gray'];
  const DRAW_TOOLS = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse'];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const r1 = (n) => Math.round(n * 10) / 10;

  /** Smooth SVG path through points (quadratic curves through midpoints). */
  function smoothPath(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}L${pts[0][0] + 0.01} ${pts[0][1]}`;
    if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]}L${pts[1][0]} ${pts[1][1]}`;
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += `Q${pts[i][0]} ${pts[i][1]} ${r1(mx)} ${r1(my)}`;
    }
    const last = pts[pts.length - 1];
    return `${d}L${last[0]} ${last[1]}`;
  }

  /** Geometry of a drawing in its own (item-relative) coordinates. */
  function drawGeometry(it) {
    const sw = (it.style && it.style.width) || 4;
    if (it.kind === 'rect') {
      return { d: `M0 0H${it.w}V${it.h}H0Z` };
    }
    if (it.kind === 'ellipse') {
      const rx = it.w / 2, ry = it.h / 2;
      return { d: `M0 ${ry}A${rx} ${ry} 0 1 0 ${it.w} ${ry}A${rx} ${ry} 0 1 0 0 ${ry}Z` };
    }
    if (it.kind === 'line' || it.kind === 'arrow') {
      const [a, b] = it.points;
      let d = `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
      let head = '';
      if (it.kind === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const len = Math.max(12, sw * 3.2);
        const spread = 0.45;
        const p1 = [b[0] - len * Math.cos(ang - spread), b[1] - len * Math.sin(ang - spread)];
        const p2 = [b[0] - len * Math.cos(ang + spread), b[1] - len * Math.sin(ang + spread)];
        head = `M${r1(p1[0])} ${r1(p1[1])}L${b[0]} ${b[1]}L${r1(p2[0])} ${r1(p2[1])}`;
        d += head;
      }
      return { d };
    }
    return { d: smoothPath(it.points || []) };
  }

  function strokeColor(c) {
    if (!c || c === 'ink') return 'var(--text)';
    return c;
  }

  const uid = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => new Date().toISOString();
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function textToHtml(text) {
    return String(text).replace(/\r\n/g, '\n').split('\n').map((l) => (l ? `<div>${esc(l)}</div>` : '<div><br></div>')).join('');
  }

  function isEditableTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  class BoardView {
    constructor({ wrap, world, onSelectionChange, onSaveState, onZoom, onExternalChange, onToolChange }) {
      this.wrap = wrap;
      this.world = world;
      this.cb = { onSelectionChange, onSaveState, onZoom, onExternalChange, onToolChange };
      this.game = null;
      this.board = null;
      this.items = new Map();
      this.els = new Map();
      this.selected = new Set();
      this.editingId = null;
      this.view = { x: 0, y: 0, zoom: 1 };
      this.dirty = new Set();
      this.deleted = new Set();
      this.undoStack = [];
      this.redoStack = [];
      this.saveTimer = null;
      this.saving = false;
      this.pointer = null; // last pointer pos in world coords
      this.pointerInside = false;
      this.savedRange = null;
      this.spaceDown = false;
      this.drag = null;
      this.loadToken = 0;
      this.tool = 'select';
      this.drawStyle = { color: '#e03131', width: 4, dash: false };
      this._bind();
    }

    // ================= open / close =================
    async open(game, board) {
      await this.flush();
      const token = ++this.loadToken;
      const data = await api.readBoard(game, board);
      if (token !== this.loadToken) return;
      this.game = data.game;
      this.board = data.name;
      this.items = new Map(data.items.map((it) => [it.id, it]));
      this.selected.clear();
      this.editingId = null;
      this.dirty.clear();
      this.deleted.clear();
      this.undoStack = [];
      this.redoStack = [];
      this.world.innerHTML = '';
      this.els.clear();
      this.wrap.classList.remove('no-board');
      this.renderAll();
      const saved = this._loadView();
      if (saved) this.setView(saved);
      else this.fitToContent(false);
      this._selectionChanged();
      this._updateHint();
      api.setActiveBoard({ game: this.game, board: this.board }).catch(() => {});
    }

    async close() {
      await this.flush();
      this.loadToken++;
      this.game = null;
      this.board = null;
      this.items.clear();
      this.els.clear();
      this.world.innerHTML = '';
      this.selected.clear();
      this.editingId = null;
      this.wrap.classList.add('no-board');
      this._selectionChanged();
      api.setActiveBoard(null).catch(() => {});
    }

    isOpen(game, board) {
      return this.game && this.game.toLowerCase() === String(game).toLowerCase() && this.board.toLowerCase() === String(board).toLowerCase();
    }

    renamed({ game, board }) {
      if (game) this.game = game;
      if (board) this.board = board;
      // Image URLs include game/board names.
      for (const it of this.items.values()) if (it.type === 'image') this._renderItem(it, true);
      api.setActiveBoard({ game: this.game, board: this.board }).catch(() => {});
    }

    // ================= persistence =================
    _markDirty(id) {
      this.dirty.add(id);
      this.deleted.delete(id);
      this._scheduleSave();
    }

    _markDeleted(id) {
      this.deleted.add(id);
      this.dirty.delete(id);
      this._scheduleSave();
    }

    _scheduleSave() {
      if (!this.game) return;
      this.cb.onSaveState && this.cb.onSaveState('saving');
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
    }

    _measure(it) {
      const el = this.els.get(it.id);
      if (el && it.type === 'text') {
        const h = el.offsetHeight;
        if (h) it.h = h;
      }
    }

    _buildPatch() {
      const upserts = [];
      for (const id of this.dirty) {
        const it = this.items.get(id);
        if (!it) continue;
        this._measure(it);
        upserts.push(clone(it));
      }
      const patch = { upserts, deletes: [...this.deleted] };
      this.dirty.clear();
      this.deleted.clear();
      return patch;
    }

    async flush() {
      clearTimeout(this.saveTimer);
      if (!this.game || (!this.dirty.size && !this.deleted.size)) return;
      const game = this.game;
      const board = this.board;
      const patch = this._buildPatch();
      try {
        await api.patchBoard(game, board, patch);
        if (!this.dirty.size && !this.deleted.size) this.cb.onSaveState && this.cb.onSaveState('saved');
      } catch (err) {
        // put it back so the next save retries
        if (this.game === game && this.board === board) {
          for (const u of patch.upserts) if (!this.deleted.has(u.id)) this.dirty.add(u.id);
          for (const d of patch.deletes) this.deleted.add(d);
        }
        this.cb.onSaveState && this.cb.onSaveState('error', err.message);
      }
    }

    flushSync() {
      clearTimeout(this.saveTimer);
      if (!this.game || (!this.dirty.size && !this.deleted.size)) return;
      api.patchBoardSync(this.game, this.board, this._buildPatch());
    }

    /** Another writer (Claude via MCP) changed the open board: merge without losing local edits. */
    async externalChange() {
      if (!this.game) return;
      const token = this.loadToken;
      const data = await api.readBoard(this.game, this.board);
      if (token !== this.loadToken) return;
      const incoming = new Map(data.items.map((it) => [it.id, it]));
      const added = [];
      const changed = [];
      for (const [id, it] of incoming) {
        if (this.dirty.has(id) || this.deleted.has(id)) continue;
        if (id === this.editingId) continue;
        const local = this.items.get(id);
        if (!local) added.push(id);
        else if (JSON.stringify(local) !== JSON.stringify(it)) changed.push(id);
        else continue;
        this.items.set(id, it);
        this._renderItem(it, true);
      }
      for (const id of [...this.items.keys()]) {
        if (!incoming.has(id) && !this.dirty.has(id) && id !== this.editingId) {
          this.items.delete(id);
          this.selected.delete(id);
          const el = this.els.get(id);
          if (el) el.remove();
          this.els.delete(id);
        }
      }
      // Undo history would otherwise resurrect / remove Claude's edits.
      this.undoStack = [];
      this.redoStack = [];
      for (const id of [...added, ...changed]) {
        const el = this.els.get(id);
        if (el) {
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
        }
      }
      this._selectionChanged();
      this._updateHint();
      if (this.cb.onExternalChange) this.cb.onExternalChange({ added: added.length, changed: changed.length });
    }

    // ================= undo =================
    checkpoint() {
      this.undoStack.push(clone([...this.items.values()]));
      if (this.undoStack.length > 120) this.undoStack.shift();
      this.redoStack = [];
    }

    _restore(snapshot) {
      const next = new Map(snapshot.map((it) => [it.id, it]));
      for (const id of this.items.keys()) {
        if (!next.has(id)) {
          const el = this.els.get(id);
          if (el) el.remove();
          this.els.delete(id);
          this._markDeleted(id);
        }
      }
      for (const [id, it] of next) {
        const cur = this.items.get(id);
        if (!cur || JSON.stringify(cur) !== JSON.stringify(it)) this._markDirty(id);
      }
      this.items = next;
      this.selected = new Set([...this.selected].filter((id) => next.has(id)));
      this.renderAll();
      this._selectionChanged();
    }

    undo() {
      if (!this.undoStack.length) return;
      this.stopEditing();
      this.redoStack.push(clone([...this.items.values()]));
      this._restore(this.undoStack.pop());
    }

    redo() {
      if (!this.redoStack.length) return;
      this.stopEditing();
      this.undoStack.push(clone([...this.items.values()]));
      this._restore(this.redoStack.pop());
    }

    // ================= view =================
    setView(v) {
      this.view = { x: v.x, y: v.y, zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM) };
      this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
      this.world.style.setProperty('--inv', String(1 / this.view.zoom));
      const g = 24 * this.view.zoom;
      this.wrap.style.backgroundSize = `${g}px ${g}px`;
      this.wrap.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
      this.cb.onZoom && this.cb.onZoom(this.view.zoom);
      clearTimeout(this._viewTimer);
      this._viewTimer = setTimeout(() => this._saveView(), 300);
    }

    _viewKey() { return `view:${this.game}/${this.board}`; }
    _saveView() { if (this.game) try { localStorage.setItem(this._viewKey(), JSON.stringify(this.view)); } catch { /* ignore */ } }
    _loadView() {
      try {
        const v = JSON.parse(localStorage.getItem(this._viewKey()));
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)) return v;
      } catch { /* ignore */ }
      return null;
    }

    zoomAt(factor, sx, sy) {
      const r = this.wrap.getBoundingClientRect();
      if (sx === undefined) { sx = r.left + r.width / 2; sy = r.top + r.height / 2; }
      const px = sx - r.left;
      const py = sy - r.top;
      const z = clamp(this.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = (px - this.view.x) / this.view.zoom;
      const wy = (py - this.view.y) / this.view.zoom;
      this.setView({ x: px - wx * z, y: py - wy * z, zoom: z });
    }

    resetZoom() { this.zoomAt(1 / this.view.zoom); }

    fitToContent(animate = true) {
      const r = this.wrap.getBoundingClientRect();
      const items = [...this.items.values()];
      if (!items.length) {
        this.setView({ x: 60, y: 60, zoom: 1 });
        return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const it of items) {
        this._measure(it);
        minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
        maxX = Math.max(maxX, it.x + (it.w || 0)); maxY = Math.max(maxY, it.y + (it.h || 40));
      }
      const pad = 60;
      const z = clamp(Math.min((r.width - pad * 2) / Math.max(1, maxX - minX), (r.height - pad * 2) / Math.max(1, maxY - minY), 1), MIN_ZOOM, MAX_ZOOM);
      this.setView({ x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z, zoom: z });
      void animate;
    }

    screenToWorld(sx, sy) {
      const r = this.wrap.getBoundingClientRect();
      return { x: (sx - r.left - this.view.x) / this.view.zoom, y: (sy - r.top - this.view.y) / this.view.zoom };
    }

    viewportCenter() {
      const r = this.wrap.getBoundingClientRect();
      return this.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    /** Where pasted content should go: the mouse if it's over the canvas, else the viewport center. */
    insertionPoint() {
      let p = this.pointerInside && this.pointer ? { ...this.pointer } : this.viewportCenter();
      // avoid stacking exactly on top of something just pasted
      for (let i = 0; i < 20; i++) {
        const hit = [...this.items.values()].some((it) => Math.abs(it.x - p.x) < 4 && Math.abs(it.y - p.y) < 4);
        if (!hit) break;
        p = { x: p.x + 24, y: p.y + 24 };
      }
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }

    _maxZ() { let m = 0; for (const it of this.items.values()) m = Math.max(m, it.z || 0); return m; }

    // ================= rendering =================
    renderAll() {
      const seen = new Set();
      for (const it of this.items.values()) {
        this._renderItem(it, true);
        seen.add(it.id);
      }
      for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
      this._applySelectionClasses();
      this._updateHint();
    }

    _imgUrl(src) {
      return `gdb://img/${encodeURIComponent(this.game)}/${encodeURIComponent(this.board)}/${src.split('/').map(encodeURIComponent).join('/')}`;
    }

    _renderItem(it, full) {
      let el = this.els.get(it.id);
      const created = !el;
      if (created) {
        el = document.createElement('div');
        el.className = `item item-${it.type}`;
        el.dataset.id = it.id;
        if (it.type === 'text') {
          el.innerHTML = '<div class="text-content" spellcheck="true"></div><div class="move-grip" data-handle="move" title="Drag to move"></div><div class="handle e" data-handle="e"></div>';
          const content = el.firstChild;
          content.addEventListener('input', () => this._onTextInput(it.id));
          content.addEventListener('focusout', (e) => this._onTextBlur(it.id, e));
        } else if (it.type === 'draw') {
          el.innerHTML = `<svg xmlns="${SVG_NS}"><path class="hit"/><path class="stroke"/></svg>`;
        } else {
          el.innerHTML = '<img draggable="false" alt="" /><div class="handle nw" data-handle="nw"></div><div class="handle ne" data-handle="ne"></div><div class="handle sw" data-handle="sw"></div><div class="handle se" data-handle="se"></div>';
          const img = el.querySelector('img');
          img.addEventListener('error', () => el.classList.add('missing'));
          img.addEventListener('load', () => {
            el.classList.remove('missing');
            const cur = this.items.get(it.id);
            if (cur && (!cur.h || !cur.w)) {
              cur.w = cur.w || Math.min(img.naturalWidth, MAX_PASTE_W);
              cur.h = Math.round(cur.w * (img.naturalHeight / img.naturalWidth));
              this._renderItem(cur);
              this._markDirty(cur.id);
            }
          });
        }
        this.world.appendChild(el);
        this.els.set(it.id, el);
      }
      el.style.left = `${it.x}px`;
      el.style.top = `${it.y}px`;
      el.style.width = `${it.w || DEFAULT_TEXT_W}px`;
      el.style.zIndex = String(it.z || 0);
      el.classList.toggle('by-claude', it.author === 'claude');

      let badge = el.querySelector('.author-badge');
      if (it.author === 'claude') {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'author-badge';
          el.appendChild(badge);
        }
        badge.textContent = 'Claude';
      } else if (badge) badge.remove();

      if (it.type === 'text') {
        const content = el.firstChild;
        if ((full || created) && this.editingId !== it.id) content.innerHTML = it.html || '';
        this._applyTextStyle(el, content, it.style || {});
      } else if (it.type === 'draw') {
        this._renderDraw(el, it);
      } else if (it.type === 'image') {
        el.style.height = it.h ? `${it.h}px` : 'auto';
        const img = el.querySelector('img');
        const url = this._imgUrl(it.src);
        if (img.getAttribute('src') !== url) img.setAttribute('src', url);
        let cap = el.querySelector('.caption');
        if (it.caption) {
          if (!cap) { cap = document.createElement('div'); cap.className = 'caption'; el.appendChild(cap); }
          cap.textContent = it.caption;
        } else if (cap) cap.remove();
      }
      return el;
    }

    _renderDraw(el, it) {
      el.style.height = `${it.h || 1}px`;
      el.className = el.className.replace(/\bkind-\S+/g, '').trim() + ` kind-${it.kind}`;
      const st = it.style || {};
      const sw = st.width || 4;
      const { d } = drawGeometry(it);
      const stroke = el.querySelector('.stroke');
      const hit = el.querySelector('.hit');
      stroke.setAttribute('d', d);
      hit.setAttribute('d', d);
      const isHi = it.kind === 'highlighter';
      Object.assign(stroke.style, {
        fill: 'none',
        stroke: strokeColor(st.color),
        strokeWidth: `${sw}px`,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        strokeDasharray: st.dash ? `${sw * 2.5} ${sw * 2}` : '',
        opacity: isHi ? '0.38' : (st.opacity != null ? String(st.opacity) : ''),
      });
      hit.style.strokeWidth = `calc(${sw}px + 14px * var(--inv))`;
      // Handles: endpoints for lines/arrows, corners for everything else.
      el.querySelectorAll('.handle').forEach((h) => h.remove());
      if (it.kind === 'line' || it.kind === 'arrow') {
        it.points.forEach((p, i) => {
          const h = document.createElement('div');
          h.className = 'handle pt';
          h.dataset.handle = `p${i}`;
          h.style.left = `${p[0]}px`;
          h.style.top = `${p[1]}px`;
          el.appendChild(h);
        });
      } else {
        for (const c of ['nw', 'ne', 'sw', 'se']) {
          const h = document.createElement('div');
          h.className = `handle ${c}`;
          h.dataset.handle = c;
          el.appendChild(h);
        }
      }
    }

    /** Set a drawing's bounding box from absolute world points and store points relative to it. */
    _setDrawPoints(it, abs) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of abs) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      it.x = r1(minX); it.y = r1(minY);
      it.w = Math.max(1, r1(maxX - minX)); it.h = Math.max(1, r1(maxY - minY));
      it.points = abs.map(([x, y]) => [r1(x - it.x), r1(y - it.y)]);
    }

    // ================= drawing tools =================
    setTool(tool) {
      if (this.editingId) this.stopEditing();
      this.tool = tool;
      this.wrap.classList.toggle('tool-draw', DRAW_TOOLS.includes(tool));
      this.wrap.classList.toggle('tool-eraser', tool === 'eraser');
      if (tool !== 'select') this.clearSelection();
      this.cb.onToolChange && this.cb.onToolChange(tool);
    }

    /** Change stroke settings; also applies to any selected drawings. */
    setDrawStyle(patch) {
      Object.assign(this.drawStyle, patch);
      const draws = [...this.selected].map((id) => this.items.get(id)).filter((it) => it && it.type === 'draw');
      if (draws.length) {
        this.checkpoint();
        for (const it of draws) {
          it.style = { ...(it.style || {}), ...patch };
          if (!it.style.dash) delete it.style.dash;
          it.updatedAt = now();
          this._renderItem(it);
          this._markDirty(it.id);
        }
      }
      this.cb.onToolChange && this.cb.onToolChange(this.tool);
    }

    selectedDrawItems() {
      return [...this.selected].map((id) => this.items.get(id)).filter((it) => it && it.type === 'draw');
    }

    _startDraw(e, wp) {
      const kind = this.tool;
      const st = { color: this.drawStyle.color, width: kind === 'highlighter' ? Math.max(12, this.drawStyle.width * 3) : this.drawStyle.width };
      if (this.drawStyle.dash && kind !== 'highlighter') st.dash = true;
      this.checkpoint();
      const it = {
        id: uid('drw'), type: 'draw', kind, x: wp.x, y: wp.y, w: 1, h: 1, points: [[0, 0]],
        style: st, author: 'user', z: this._maxZ() + 1, createdAt: now(), updatedAt: now(),
      };
      const abs = [[wp.x, wp.y]];
      if (kind === 'line' || kind === 'arrow') abs.push([wp.x, wp.y]);
      this._setDrawPoints(it, abs);
      this.items.set(it.id, it);
      this._renderItem(it, true);
      this._updateHint();
      this.drag = { kind: 'draw', id: it.id, start: wp, abs, sx: e.clientX, sy: e.clientY };
    }

    _moveDraw(e, wp) {
      const d = this.drag;
      const it = this.items.get(d.id);
      if (!it) return;
      if (it.kind === 'pen' || it.kind === 'highlighter') {
        const last = d.abs[d.abs.length - 1];
        if (Math.hypot(wp.x - last[0], wp.y - last[1]) < 1.5 / this.view.zoom) return;
        d.abs.push([wp.x, wp.y]);
        this._setDrawPoints(it, d.abs);
      } else if (it.kind === 'line' || it.kind === 'arrow') {
        const p = e.shiftKey ? this._snap45(d.start, wp) : wp;
        d.abs = [[d.start.x, d.start.y], [p.x, p.y]];
        this._setDrawPoints(it, d.abs);
      } else {
        let w = wp.x - d.start.x;
        let h = wp.y - d.start.y;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        it.x = r1(Math.min(d.start.x, d.start.x + w)); it.y = r1(Math.min(d.start.y, d.start.y + h));
        it.w = Math.max(1, r1(Math.abs(w))); it.h = Math.max(1, r1(Math.abs(h)));
        it.points = [];
      }
      this._renderItem(it);
    }

    _endDraw() {
      const d = this.drag;
      const it = this.items.get(d.id);
      if (!it) return;
      const tiny = (it.kind === 'pen' || it.kind === 'highlighter') ? false : Math.max(it.w, it.h) < 3;
      if (tiny) {
        // A click without a drag: discard and drop the checkpoint.
        this.items.delete(it.id);
        const el = this.els.get(it.id);
        if (el) el.remove();
        this.els.delete(it.id);
        this.undoStack.pop();
        this._updateHint();
        return;
      }
      it.updatedAt = now();
      this._markDirty(it.id);
    }

    _snap45(a, b) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }

    _eraseAt(clientX, clientY) {
      const els = document.elementsFromPoint(clientX, clientY);
      for (const node of els) {
        const itemEl = node.closest && node.closest('.item-draw');
        if (!itemEl) continue;
        const id = itemEl.dataset.id;
        if (!this.items.has(id)) continue;
        if (!this.drag.erased) { this.checkpoint(); this.drag.erased = true; }
        this.items.delete(id);
        itemEl.remove();
        this.els.delete(id);
        this.selected.delete(id);
        this._markDeleted(id);
      }
    }

    _applyTextStyle(el, content, st) {
      content.style.fontFamily = st.fontFamily ? `"${st.fontFamily}", var(--font)` : '';
      content.style.fontSize = st.fontSize ? `${st.fontSize}px` : '';
      content.style.color = st.color || '';
      const note = NOTE_COLORS.includes(st.background) ? st.background : null;
      content.style.background = note ? `var(--note-${note})` : (st.background || '');
      if (note && !st.color) content.style.color = 'var(--note-text)';
      content.style.fontWeight = st.bold ? '700' : '';
      content.style.fontStyle = st.italic ? 'italic' : '';
      const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
      content.style.textDecoration = deco;
      content.style.textAlign = st.align || '';
      el.classList.toggle('has-bg', !!st.background);
    }

    _updateHint() {
      let hint = this.wrap.querySelector('.board-hint');
      if (this.game && this.items.size === 0) {
        if (!hint) {
          hint = document.createElement('div');
          hint.className = 'board-hint';
          hint.innerHTML = 'This board is empty.<br/><kbd>Click</kbd> anywhere to start typing · <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste a screenshot<br/>or drop image files here.';
          this.wrap.appendChild(hint);
        }
      } else if (hint) hint.remove();
    }

    // ================= selection =================
    select(ids, additive = false) {
      if (!additive) this.selected.clear();
      for (const id of ids) this.selected.add(id);
      this._applySelectionClasses();
      this._selectionChanged();
    }

    toggleSelect(id) {
      if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
      this._applySelectionClasses();
      this._selectionChanged();
    }

    clearSelection() {
      if (!this.selected.size) return;
      this.selected.clear();
      this._applySelectionClasses();
      this._selectionChanged();
    }

    _applySelectionClasses() {
      const single = this.selected.size === 1;
      for (const [id, el] of this.els) {
        el.classList.toggle('selected', this.selected.has(id));
        el.classList.toggle('single', single && this.selected.has(id));
        el.classList.toggle('editing', id === this.editingId);
      }
    }

    selectedTextItems() {
      return [...this.selected].map((id) => this.items.get(id)).filter((it) => it && it.type === 'text');
    }

    _selectionChanged() {
      this.cb.onSelectionChange && this.cb.onSelectionChange({
        textItems: this.selectedTextItems(),
        drawItems: this.selectedDrawItems(),
        count: this.selected.size,
        editing: !!this.editingId,
      });
    }

    // ================= creating items =================
    addText(pos, { html = '', text = '', edit = true, style } = {}) {
      this.checkpoint();
      const it = {
        id: uid('txt'), type: 'text', x: Math.round(pos.x), y: Math.round(pos.y), w: DEFAULT_TEXT_W, h: 0,
        html, text, style: style ? { ...style } : { ...(this.lastTextStyle || {}) }, author: 'user',
        z: this._maxZ() + 1, createdAt: now(), updatedAt: now(),
      };
      // Delete stale background from remembered style; notes shouldn't all become sticky by surprise.
      if (!style && it.style) delete it.style.background;
      this.items.set(it.id, it);
      this._renderItem(it, true);
      this._updateHint();
      if (text || html) this._markDirty(it.id);
      if (edit) this.startEditing(it.id);
      else this.select([it.id]);
      return it;
    }

    async addImageBytes(bytes, mime, pos, natural) {
      const saved = await api.saveImage(this.game, this.board, bytes, mime);
      let nw = saved.width || (natural && natural.width) || 0;
      let nh = saved.height || (natural && natural.height) || 0;
      if (!nw || !nh) {
        try {
          const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }));
          nw = bmp.width; nh = bmp.height;
          bmp.close();
        } catch { nw = 640; nh = 480; }
      }
      // Screenshots from high-DPI screens are big; show them at a comfortable size.
      const dpr = window.devicePixelRatio || 1;
      let w = Math.round(nw / dpr);
      w = Math.min(w, MAX_PASTE_W);
      const h = Math.round(w * (nh / nw));
      this.checkpoint();
      const it = {
        id: uid('img'), type: 'image', x: Math.round(pos.x), y: Math.round(pos.y), w, h, src: saved.src,
        naturalWidth: nw, naturalHeight: nh, author: 'user', z: this._maxZ() + 1, createdAt: now(), updatedAt: now(),
      };
      this.items.set(it.id, it);
      this._renderItem(it, true);
      this._markDirty(it.id);
      this._updateHint();
      this.select([it.id]);
      return it;
    }

    async addImageBlob(blob, pos) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return this.addImageBytes(bytes, blob.type, pos);
    }

    async addImagesFromPaths(paths) {
      let p = this.insertionPoint();
      for (const fp of paths) {
        try {
          const saved = await api.saveImageFromPath(this.game, this.board, fp);
          const dpr = window.devicePixelRatio || 1;
          const nw = saved.width || 640;
          const nh = saved.height || 480;
          const w = Math.min(Math.round(nw / dpr), MAX_PASTE_W);
          this.checkpoint();
          const it = {
            id: uid('img'), type: 'image', x: p.x, y: p.y, w, h: Math.round(w * (nh / nw)), src: saved.src,
            naturalWidth: nw, naturalHeight: nh, author: 'user', z: this._maxZ() + 1, createdAt: now(), updatedAt: now(),
          };
          this.items.set(it.id, it);
          this._renderItem(it, true);
          this._markDirty(it.id);
          p = { x: p.x + w + 24, y: p.y };
        } catch (err) {
          toast(`Could not add image: ${err.message}`, 'error');
        }
      }
      this._updateHint();
    }

    /** Paste from the system clipboard (used by the context menu, where there is no paste event). */
    async pasteFromSystem() {
      const native = await api.readClipboardImage().catch(() => null);
      const pos = this.insertionPoint();
      if (native && native.bytes) {
        await this.addImageBytes(new Uint8Array(native.bytes), 'image/png', pos, native);
        return;
      }
      const text = await navigator.clipboard.readText().catch(() => '');
      if (text && text.trim()) this.addText(pos, { html: textToHtml(text), text, edit: false });
      else toast('Clipboard is empty');
    }

    async handlePaste(e) {
      if (!this.game) return;
      const cd = e.clipboardData;
      const files = [];
      if (cd) {
        for (const item of cd.items) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      const text = cd ? cd.getData('text/plain') : '';
      const editingEl = this.editingId && this.els.get(this.editingId);

      if (editingEl && text) {
        // Paste into a note as plain text (keeps formatting clean).
        e.preventDefault();
        document.execCommand('insertText', false, text);
        return;
      }
      e.preventDefault();
      if (files.length) {
        if (this.editingId) this.stopEditing();
        let pos = this.insertionPoint();
        for (const f of files) {
          try {
            const it = await this.addImageBlob(f, pos);
            pos = { x: pos.x + it.w + 24, y: pos.y };
          } catch (err) {
            toast(`Paste failed: ${err.message}`, 'error');
          }
        }
        return;
      }
      // No image in the DOM event: some apps only put a raw bitmap on the clipboard.
      const native = await api.readClipboardImage().catch(() => null);
      if (native && native.bytes && !(text && text.trim())) {
        if (this.editingId) this.stopEditing();
        await this.addImageBytes(new Uint8Array(native.bytes), 'image/png', this.insertionPoint(), native);
        return;
      }
      if (text && text.trim()) {
        this.addText(this.insertionPoint(), { html: textToHtml(text), text, edit: false });
      }
    }

    // ================= editing =================
    startEditing(id, clientX, clientY) {
      const it = this.items.get(id);
      const el = this.els.get(id);
      if (!it || it.type !== 'text' || !el) return;
      if (this.editingId && this.editingId !== id) this.stopEditing();
      this.checkpoint();
      this.editingId = id;
      this.selected = new Set([id]);
      const content = el.firstChild;
      content.contentEditable = 'true';
      content.focus({ preventScroll: true });
      const sel = window.getSelection();
      let range = null;
      if (clientX !== undefined && document.caretRangeFromPoint) range = document.caretRangeFromPoint(clientX, clientY);
      if (!range || !content.contains(range.startContainer)) {
        range = document.createRange();
        range.selectNodeContents(content);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
      this._applySelectionClasses();
      this._selectionChanged();
    }

    stopEditing() {
      const id = this.editingId;
      if (!id) return;
      this.editingId = null;
      const el = this.els.get(id);
      const it = this.items.get(id);
      if (el) {
        const content = el.firstChild;
        content.contentEditable = 'false';
        if (document.activeElement === content) content.blur();
      }
      window.getSelection().removeAllRanges();
      this.savedRange = null;
      if (it && !(it.text || '').trim() && !/<img/i.test(it.html || '')) {
        // Empty note: remove it silently and drop the checkpoint we took for it.
        this.items.delete(id);
        if (el) el.remove();
        this.els.delete(id);
        this.selected.delete(id);
        if (this.dirty.has(id) || it.createdAt !== it.updatedAt) this._markDeleted(id);
        else this.dirty.delete(id);
        this.undoStack.pop();
        this._updateHint();
      } else if (this.undoStack.length && it) {
        // If nothing changed during the edit session, drop the no-op checkpoint.
        const last = this.undoStack[this.undoStack.length - 1];
        const before = last.find((x) => x.id === id);
        if (before && before.html === it.html && JSON.stringify(before.style) === JSON.stringify(it.style)) this.undoStack.pop();
      }
      this._applySelectionClasses();
      this._selectionChanged();
    }

    _onTextInput(id) {
      const it = this.items.get(id);
      const el = this.els.get(id);
      if (!it || !el) return;
      const content = el.firstChild;
      it.html = content.innerHTML;
      it.text = content.innerText.replace(/\n$/, '');
      it.updatedAt = now();
      if (it.author === 'claude') it.editedBy = 'user';
      this._markDirty(id);
    }

    _onTextBlur(id, e) {
      if (this.editingId !== id) return;
      const to = e.relatedTarget;
      // Keep editing while the user interacts with the formatting toolbar.
      if (to && (to.closest('#toolbar') || to.closest('.context-menu'))) return;
      if (!document.hasFocus()) return; // window lost focus (alt-tab); keep editing state
      setTimeout(() => {
        if (this.editingId === id && !this.els.get(id)?.firstChild.contains(document.activeElement)) {
          const active = document.activeElement;
          if (active && active.closest && active.closest('#toolbar')) return;
          this.stopEditing();
        }
      }, 0);
    }

    _trackSelection() {
      if (!this.editingId) return;
      const el = this.els.get(this.editingId);
      const sel = window.getSelection();
      if (el && sel.rangeCount && el.firstChild.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange();
    }

    // ================= formatting =================
    /** Apply a format from the toolbar. Inline if text is selected in the editor, else to whole note(s). */
    applyFormat(prop, value) {
      const editingEl = this.editingId && this.els.get(this.editingId);
      const inline = editingEl && this.savedRange && !this.savedRange.collapsed && prop !== 'align' && prop !== 'background';
      if (prop === 'list') {
        if (!editingEl) {
          const only = this.selectedTextItems();
          if (only.length !== 1) return;
          this.startEditing(only[0].id);
        }
        const el = this.els.get(this.editingId);
        el.firstChild.focus();
        if (this.savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(this.savedRange); }
        document.execCommand('insertUnorderedList');
        this._onTextInput(this.editingId);
        return;
      }
      if (inline) {
        const content = editingEl.firstChild;
        content.focus({ preventScroll: true });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(this.savedRange);
        document.execCommand('styleWithCSS', false, true);
        switch (prop) {
          case 'bold': document.execCommand('bold'); break;
          case 'italic': document.execCommand('italic'); break;
          case 'underline': document.execCommand('underline'); break;
          case 'strike': document.execCommand('strikeThrough'); break;
          case 'color': document.execCommand('foreColor', false, value); break;
          case 'fontFamily': document.execCommand('fontName', false, value || 'inherit'); break;
          case 'fontSize': {
            document.execCommand('styleWithCSS', false, false);
            document.execCommand('fontSize', false, '7');
            content.querySelectorAll('font[size="7"]').forEach((f) => {
              const span = document.createElement('span');
              span.style.fontSize = `${value}px`;
              while (f.firstChild) span.appendChild(f.firstChild);
              f.replaceWith(span);
            });
            break;
          }
          default: break;
        }
        this._onTextInput(this.editingId);
        this._trackSelection();
        return;
      }
      const targets = this.selectedTextItems();
      if (!targets.length) return;
      this.checkpoint();
      const first = targets[0].style || {};
      for (const it of targets) {
        const st = { ...(it.style || {}) };
        if (['bold', 'italic', 'underline', 'strike'].includes(prop)) {
          const v = value !== undefined ? value : !first[prop];
          if (v) st[prop] = true; else delete st[prop];
        } else if (value === null || value === '' || value === undefined || value === 'none') {
          delete st[prop];
        } else {
          st[prop] = prop === 'fontSize' ? Number(value) : value;
        }
        it.style = st;
        it.updatedAt = now();
        this._renderItem(it);
        this._markDirty(it.id);
      }
      const remembered = { ...(targets[0].style || {}) };
      delete remembered.background;
      this.lastTextStyle = remembered;
      if (editingEl) {
        editingEl.firstChild.focus({ preventScroll: true });
        if (this.savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(this.savedRange); }
      }
      this._selectionChanged();
    }

    // ================= item operations =================
    deleteSelected() {
      if (!this.selected.size) return;
      this.checkpoint();
      for (const id of this.selected) {
        this.items.delete(id);
        const el = this.els.get(id);
        if (el) el.remove();
        this.els.delete(id);
        this._markDeleted(id);
      }
      this.selected.clear();
      this._updateHint();
      this._selectionChanged();
    }

    duplicateSelected() {
      if (!this.selected.size) return;
      this.checkpoint();
      const ids = [];
      let z = this._maxZ();
      for (const id of this.selected) {
        const src = this.items.get(id);
        if (!src) continue;
        const it = { ...clone(src), id: uid({ text: 'txt', image: 'img', draw: 'drw' }[src.type] || 'itm'), x: src.x + 24, y: src.y + 24, z: ++z, author: 'user', createdAt: now(), updatedAt: now() };
        delete it.editedBy;
        this.items.set(it.id, it);
        this._renderItem(it, true);
        this._markDirty(it.id);
        ids.push(it.id);
      }
      this.select(ids);
    }

    reorder(dir) {
      if (!this.selected.size) return;
      this.checkpoint();
      const all = [...this.items.values()];
      const zs = all.map((i) => i.z || 0);
      let next = dir > 0 ? Math.max(...zs) : Math.min(...zs);
      for (const id of this.selected) {
        const it = this.items.get(id);
        next += dir > 0 ? 1 : -1;
        it.z = next;
        this._renderItem(it);
        this._markDirty(id);
      }
    }

    nudge(dx, dy) {
      if (!this.selected.size) return;
      if (!this._nudging) { this.checkpoint(); this._nudging = true; }
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = setTimeout(() => { this._nudging = false; }, 600);
      for (const id of this.selected) {
        const it = this.items.get(id);
        it.x += dx; it.y += dy;
        this._renderItem(it);
        this._markDirty(id);
      }
    }

    async copySelected() {
      const items = [...this.selected].map((id) => this.items.get(id)).filter(Boolean);
      if (items.length === 1 && items[0].type === 'image') {
        await api.copyImage(this.game, this.board, items[0].src);
        toast('Image copied to clipboard');
        return;
      }
      const text = items.filter((i) => i.type === 'text').map((i) => i.text || '').join('\n\n');
      if (text) { await api.writeClipboardText(text); toast('Text copied'); }
    }

    // ================= input binding =================
    _bind() {
      const wrap = this.wrap;

      wrap.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      window.addEventListener('pointermove', (e) => this._onPointerMove(e));
      window.addEventListener('pointerup', (e) => this._onPointerUp(e));
      wrap.addEventListener('pointerenter', () => { this.pointerInside = true; });
      wrap.addEventListener('pointerleave', () => { this.pointerInside = false; });
      wrap.addEventListener('dblclick', (e) => {
        const itemEl = e.target.closest('.item');
        if (!itemEl) return;
        const it = this.items.get(itemEl.dataset.id);
        if (it && it.type === 'text' && this.editingId !== it.id) this.startEditing(it.id, e.clientX, e.clientY);
        else if (it && it.type === 'image') api.openImage(this.game, this.board, it.src).catch((err) => toast(err.message, 'error'));
      });

      wrap.addEventListener('wheel', (e) => {
        if (!this.game) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
          this.zoomAt(factor, e.clientX, e.clientY);
        } else {
          const k = e.deltaMode === 1 ? 32 : 1;
          const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
          const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
          this.setView({ x: this.view.x - dx * k, y: this.view.y - dy * k, zoom: this.view.zoom });
        }
      }, { passive: false });

      wrap.addEventListener('contextmenu', (e) => this._onContextMenu(e));

      // drag & drop image files
      wrap.addEventListener('dragover', (e) => {
        if (!this.game) return;
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          wrap.classList.add('drop-target');
        }
      });
      wrap.addEventListener('dragleave', (e) => { if (e.target === wrap) wrap.classList.remove('drop-target'); });
      wrap.addEventListener('drop', async (e) => {
        wrap.classList.remove('drop-target');
        if (!this.game) return;
        e.preventDefault();
        let pos = this.screenToWorld(e.clientX, e.clientY);
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
        if (!files.length) { toast('Only image files can be dropped on the board'); return; }
        for (const f of files) {
          try {
            const it = await this.addImageBlob(f, pos);
            pos = { x: pos.x + it.w + 24, y: pos.y };
          } catch (err) { toast(`Could not add ${f.name}: ${err.message}`, 'error'); }
        }
      });

      document.addEventListener('paste', (e) => {
        if (!this.game || window.UI.modalOpen) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        this.handlePaste(e);
      });
      document.addEventListener('selectionchange', () => this._trackSelection());
      document.addEventListener('keydown', (e) => this._onKeyDown(e));
      document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') { this.spaceDown = false; wrap.classList.remove('space'); }
      });
      window.addEventListener('blur', () => { this.spaceDown = false; wrap.classList.remove('space'); });
      window.addEventListener('beforeunload', () => this.flushSync());
    }

    _onPointerDown(e) {
      if (!this.game) return;
      const wp = this.screenToWorld(e.clientX, e.clientY);
      this.pointer = wp;
      const handle = e.target.closest('[data-handle]');
      const itemEl = e.target.closest('.item');

      // Middle button or space+left: pan anywhere.
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: true };
        this.wrap.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;

      // Drawing tools take over the left button everywhere on the canvas.
      if (DRAW_TOOLS.includes(this.tool)) {
        e.preventDefault();
        if (this.editingId) this.stopEditing();
        this.wrap.setPointerCapture && this.wrap.setPointerCapture(e.pointerId);
        this._startDraw(e, wp);
        return;
      }
      if (this.tool === 'eraser') {
        e.preventDefault();
        this.drag = { kind: 'erase', sx: e.clientX, sy: e.clientY };
        this._eraseAt(e.clientX, e.clientY);
        return;
      }

      if (handle && itemEl) {
        e.preventDefault();
        const id = itemEl.dataset.id;
        const it = this.items.get(id);
        if (handle.dataset.handle === 'move') {
          if (this.editingId === id) { /* keep editing; move the box */ }
          if (!this.selected.has(id)) this.select([id]);
          this._startMove(e, wp);
          return;
        }
        this.drag = { kind: 'resize', handle: handle.dataset.handle, id, start: wp, orig: clone(it), moved: false };
        return;
      }

      if (itemEl) {
        const id = itemEl.dataset.id;
        // Clicking inside the note being edited: let the browser place the caret / select text.
        if (this.editingId === id && e.target.closest('.text-content')) return;
        if (this.editingId && this.editingId !== id) this.stopEditing();
        e.preventDefault();
        const wasSelected = this.selected.has(id) && this.selected.size === 1;
        if (e.shiftKey || e.ctrlKey) {
          this.toggleSelect(id);
          return;
        }
        if (!this.selected.has(id)) this.select([id]);
        this._startMove(e, wp, { clickToEdit: wasSelected ? id : null });
        return;
      }

      // Empty canvas.
      e.preventDefault();
      const wasEditing = !!this.editingId;
      const hadSelection = this.selected.size > 0;
      if (wasEditing) this.stopEditing();
      this.wrap.focus({ preventScroll: true });
      if (e.shiftKey) {
        this.drag = { kind: 'marquee', start: wp, sx: e.clientX, sy: e.clientY, moved: false, base: new Set(this.selected) };
        return;
      }
      this.drag = {
        kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false,
        clickCreate: !wasEditing, clickDeselect: hadSelection, wp,
      };
    }

    _startMove(e, wp, extra = {}) {
      const origs = new Map();
      for (const id of this.selected) {
        const it = this.items.get(id);
        if (it) origs.set(id, { x: it.x, y: it.y });
      }
      this.drag = { kind: 'move', start: wp, sx: e.clientX, sy: e.clientY, origs, moved: false, ...extra };
    }

    _onPointerMove(e) {
      if (this.game && this.wrap.contains(e.target)) this.pointer = this.screenToWorld(e.clientX, e.clientY);
      const d = this.drag;
      if (!d) return;
      const dist = Math.hypot(e.clientX - (d.sx ?? e.clientX), e.clientY - (d.sy ?? e.clientY));
      if (d.kind === 'pan') {
        if (!d.moved && dist < DRAG_THRESHOLD) return;
        if (!d.moved) this.wrap.classList.add('panning');
        d.moved = true;
        this.setView({ x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy), zoom: this.view.zoom });
        return;
      }
      const wp = this.screenToWorld(e.clientX, e.clientY);
      if (d.kind === 'draw') { this._moveDraw(e, wp); return; }
      if (d.kind === 'erase') { this._eraseAt(e.clientX, e.clientY); return; }
      if (d.kind === 'move') {
        if (!d.moved && dist < DRAG_THRESHOLD) return;
        if (!d.moved) { this.checkpoint(); d.moved = true; }
        const dx = wp.x - d.start.x;
        const dy = wp.y - d.start.y;
        for (const [id, o] of d.origs) {
          const it = this.items.get(id);
          if (!it) continue;
          it.x = Math.round(o.x + dx);
          it.y = Math.round(o.y + dy);
          const el = this.els.get(id);
          if (el) { el.style.left = `${it.x}px`; el.style.top = `${it.y}px`; }
        }
        return;
      }
      if (d.kind === 'resize') {
        if (!d.moved) { this.checkpoint(); d.moved = true; }
        const it = this.items.get(d.id);
        if (!it) return;
        const o = d.orig;
        const dx = wp.x - d.start.x;
        const dy = wp.y - d.start.y;
        if (it.type === 'text') {
          it.w = Math.max(60, Math.round(o.w + dx));
        } else if (it.type === 'draw' && /^p\d$/.test(d.handle)) {
          // Drag one end of a line/arrow.
          const idx = Number(d.handle[1]);
          const abs = o.points.map(([px, py]) => [o.x + px, o.y + py]);
          const other = abs[1 - idx];
          const p = e.shiftKey ? this._snap45({ x: other[0], y: other[1] }, wp) : wp;
          abs[idx] = [p.x, p.y];
          this._setDrawPoints(it, abs);
        } else if (it.type === 'draw') {
          const left = d.handle.includes('w');
          const top = d.handle.includes('n');
          const lockAspect = it.kind === 'pen' || it.kind === 'highlighter' ? !e.shiftKey : e.shiftKey;
          let w = Math.max(4, o.w + (left ? -dx : dx));
          let h = Math.max(4, o.h + (top ? -dy : dy));
          if (lockAspect) h = Math.max(4, w * (o.h / o.w));
          it.x = r1(left ? o.x + (o.w - w) : o.x);
          it.y = r1(top ? o.y + (o.h - h) : o.y);
          const sx = w / o.w, sy = h / o.h;
          it.w = r1(w); it.h = r1(h);
          if (o.points) it.points = o.points.map(([px, py]) => [r1(px * sx), r1(py * sy)]);
        } else {
          const aspect = (o.h || 1) / (o.w || 1);
          const left = d.handle.includes('w');
          const top = d.handle.includes('n');
          let w = Math.max(24, o.w + (left ? -dx : dx));
          let h;
          if (e.shiftKey) h = Math.max(24, o.h + (top ? -dy : dy));
          else h = w * aspect;
          w = Math.round(w); h = Math.round(h);
          it.x = left ? o.x + (o.w - w) : o.x;
          it.y = top ? o.y + (o.h - h) : o.y;
          it.w = w; it.h = h;
        }
        this._renderItem(it);
        return;
      }
      if (d.kind === 'marquee') {
        if (!d.moved && dist < DRAG_THRESHOLD) return;
        d.moved = true;
        if (!d.el) { d.el = document.createElement('div'); d.el.className = 'marquee'; this.world.appendChild(d.el); }
        const x1 = Math.min(d.start.x, wp.x), y1 = Math.min(d.start.y, wp.y);
        const x2 = Math.max(d.start.x, wp.x), y2 = Math.max(d.start.y, wp.y);
        Object.assign(d.el.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
        const hits = [];
        for (const it of this.items.values()) {
          this._measure(it);
          if (it.x < x2 && it.x + it.w > x1 && it.y < y2 && it.y + (it.h || 30) > y1) hits.push(it.id);
        }
        this.selected = new Set([...d.base, ...hits]);
        this._applySelectionClasses();
      }
    }

    _onPointerUp(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.wrap.classList.remove('panning');
      if (d.kind === 'draw') { this.drag = d; this._endDraw(); this.drag = null; return; }
      if (d.kind === 'erase') return;
      if (d.kind === 'pan') {
        if (!d.moved) {
          if (d.clickDeselect) this.clearSelection();
          if (d.clickCreate) this.addText({ x: d.wp.x - 10, y: d.wp.y - 18 }, { edit: true });
        }
        return;
      }
      if (d.kind === 'move') {
        if (d.moved) {
          const ts = now();
          for (const id of d.origs.keys()) { const it = this.items.get(id); if (it) { it.updatedAt = ts; this._markDirty(id); } }
        } else if (d.clickToEdit) {
          const it = this.items.get(d.clickToEdit);
          if (it && it.type === 'text') this.startEditing(it.id, e.clientX, e.clientY);
        }
        return;
      }
      if (d.kind === 'resize') {
        if (d.moved) {
          const it = this.items.get(d.id);
          if (it) { it.updatedAt = now(); this._markDirty(d.id); }
        }
        return;
      }
      if (d.kind === 'marquee') {
        if (d.el) d.el.remove();
        this._selectionChanged();
      }
    }

    _onKeyDown(e) {
      if (!this.game || window.UI.modalOpen) return;
      const t = e.target;
      const inEditor = this.editingId && t && t.closest && t.closest('.text-content');
      if (inEditor) {
        if (e.key === 'Escape') { e.preventDefault(); const id = this.editingId; this.stopEditing(); if (this.items.has(id)) this.select([id]); }
        return; // native editing (Ctrl+B/I/U, undo, etc.)
      }
      if (isEditableTarget(t)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!ctrl && !e.altKey && !e.shiftKey) {
        const toolKeys = { v: 'select', p: 'pen', h: 'highlighter', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', e: 'eraser' };
        if (toolKeys[key]) { e.preventDefault(); this.setTool(toolKeys[key]); return; }
      }
      if (e.key === 'Escape' && this.tool !== 'select') { this.setTool('select'); return; }
      if (e.code === 'Space' && !ctrl) { this.spaceDown = true; this.wrap.classList.add('space'); e.preventDefault(); return; }
      if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (ctrl && key === 'd') { e.preventDefault(); this.duplicateSelected(); return; }
      if (ctrl && key === 'a') { e.preventDefault(); this.select([...this.items.keys()]); return; }
      if (ctrl && key === 'c') { if (this.selected.size) { e.preventDefault(); this.copySelected().catch((err) => toast(err.message, 'error')); } return; }
      if (ctrl && key === '0') { e.preventDefault(); this.resetZoom(); return; }
      if (ctrl && key === '1') { e.preventDefault(); this.fitToContent(); return; }
      if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); this.zoomAt(1.2); return; }
      if (ctrl && key === '-') { e.preventDefault(); this.zoomAt(1 / 1.2); return; }
      if (ctrl && key === 'b') { e.preventDefault(); this.applyFormat('bold'); return; }
      if (ctrl && key === 'i') { e.preventDefault(); this.applyFormat('italic'); return; }
      if (ctrl && key === 'u') { e.preventDefault(); this.applyFormat('underline'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); return; }
      if (e.key === 'Escape') { this.clearSelection(); return; }
      if (e.key === 'Enter' || e.key === 'F2') {
        const only = this.selectedTextItems();
        if (only.length === 1 && this.selected.size === 1) { e.preventDefault(); this.startEditing(only[0].id); }
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.nudge(-step, 0); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.nudge(step, 0); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.nudge(0, -step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.nudge(0, step); }
    }

    _onContextMenu(e) {
      if (!this.game) return;
      const itemEl = e.target.closest('.item');
      if (itemEl && this.editingId === itemEl.dataset.id && e.target.closest('.text-content')) return; // native spellcheck menu
      e.preventDefault();
      this.pointer = this.screenToWorld(e.clientX, e.clientY);
      this.pointerInside = true;
      if (itemEl) {
        const id = itemEl.dataset.id;
        if (!this.selected.has(id)) this.select([id]);
        const it = this.items.get(id);
        const isImage = it.type === 'image' && this.selected.size === 1;
        contextMenu(e.clientX, e.clientY, [
          it.type === 'text' && this.selected.size === 1 && { label: 'Edit text', kbd: 'Enter', action: () => this.startEditing(id) },
          isImage && { label: 'Copy image', kbd: 'Ctrl+C', action: () => this.copySelected() },
          isImage && { label: 'Open image', action: () => api.openImage(this.game, this.board, it.src) },
          isImage && { label: 'Show in folder', action: () => api.showImageInFolder(this.game, this.board, it.src) },
          isImage && { label: it.caption ? 'Edit caption…' : 'Add caption…', action: () => this._editCaption(id) },
          isImage && it.naturalWidth && { label: 'Reset to original size', action: () => this._resetImageSize(id) },
          'sep',
          { label: 'Bring to front', action: () => this.reorder(1) },
          { label: 'Send to back', action: () => this.reorder(-1) },
          { label: 'Duplicate', kbd: 'Ctrl+D', action: () => this.duplicateSelected() },
          'sep',
          { label: this.selected.size > 1 ? `Delete ${this.selected.size} items` : 'Delete', kbd: 'Del', danger: true, action: () => this.deleteSelected() },
        ]);
      } else {
        const wp = this.pointer;
        contextMenu(e.clientX, e.clientY, [
          { label: 'Add text here', action: () => this.addText({ x: wp.x, y: wp.y }) },
          { label: 'Paste here', kbd: 'Ctrl+V', action: () => this.pasteFromSystem().catch((err) => toast(err.message, 'error')) },
          { label: 'Add image from file…', action: () => window.App.pickImages() },
          'sep',
          { label: 'Fit to content', kbd: 'Ctrl+1', action: () => this.fitToContent() },
          { label: 'Reset zoom', kbd: 'Ctrl+0', action: () => this.resetZoom() },
          { label: 'Select all', kbd: 'Ctrl+A', action: () => this.select([...this.items.keys()]) },
        ]);
      }
    }

    async _editCaption(id) {
      const it = this.items.get(id);
      if (!it) return;
      const v = await window.UI.promptModal(it.caption ? 'Edit caption' : 'Add caption', 'Caption', it.caption || '', 'Save');
      if (v === null) return;
      this.checkpoint();
      it.caption = v;
      it.updatedAt = now();
      this._renderItem(it);
      this._markDirty(id);
    }

    _resetImageSize(id) {
      const it = this.items.get(id);
      if (!it || !it.naturalWidth) return;
      this.checkpoint();
      it.w = it.naturalWidth;
      it.h = it.naturalHeight;
      this._renderItem(it);
      this._markDirty(id);
    }
  }

  window.BoardView = BoardView;
})();
