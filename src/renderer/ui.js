'use strict';
/* Small UI helpers: modals, prompt/confirm, context menu, toasts. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let openModals = 0;

  /**
   * showModal({ title, body: string|Node, buttons: [{label, value, primary, danger}], wide, onOpen })
   * Resolves with the clicked button's value (or null when dismissed).
   */
  function showModal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onOpen }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const modal = document.createElement('div');
      modal.className = `modal${wide ? ' wide' : ''}`;
      modal.innerHTML = `<div class="modal-head">${esc(title)}</div><div class="modal-body"></div><div class="modal-foot"></div>`;
      const bodyEl = $('.modal-body', modal);
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body) bodyEl.appendChild(body);
      const foot = $('.modal-foot', modal);
      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        openModals--;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(value);
      };
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.className = `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`;
        btn.textContent = b.label;
        btn.addEventListener('click', () => {
          const v = typeof b.value === 'function' ? b.value(modal) : b.value;
          if (v === undefined) return; // keep open
          close(v);
        });
        foot.appendChild(btn);
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          e.preventDefault();
          const primary = buttons.find((b) => b.primary);
          if (primary) {
            const v = typeof primary.value === 'function' ? primary.value(modal) : primary.value;
            if (v !== undefined) close(v);
          }
        }
        e.stopPropagation();
      };
      document.addEventListener('keydown', onKey, true);
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(null); });
      backdrop.appendChild(modal);
      document.getElementById('modalRoot').appendChild(backdrop);
      openModals++;
      if (onOpen) onOpen(modal, close);
    });
  }

  function promptModal(title, label, defaultValue = '', okLabel = 'Create') {
    return showModal({
      title,
      body: `<label>${esc(label)}</label><input type="text" spellcheck="false" value="${esc(defaultValue)}" />`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: okLabel, primary: true, value: (m) => { const v = $('input', m).value.trim(); return v ? v : undefined; } },
      ],
      onOpen: (m) => { const i = $('input', m); i.focus(); i.select(); },
    });
  }

  function confirmModal(title, message, okLabel = 'Delete', danger = true) {
    return showModal({
      title,
      body: `<p>${message}</p>`,
      buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
    }).then((v) => !!v);
  }

  // ---------- context menu ----------
  const menuEl = () => document.getElementById('contextMenu');
  function hideMenu() { menuEl().classList.add('hidden'); }

  /** items: [{label, action, kbd, danger} | 'sep'] */
  function contextMenu(x, y, items) {
    const el = menuEl();
    el.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it === 'sep') { el.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.innerHTML = `<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}`;
      b.addEventListener('click', () => { hideMenu(); it.action(); });
      el.appendChild(b);
    }
    el.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    el.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  }
  window.addEventListener('mousedown', (e) => { if (!menuEl().contains(e.target)) hideMenu(); }, true);
  window.addEventListener('blur', hideMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

  // ---------- toasts ----------
  function toast(message, kind = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = message;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity 0.25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, ms);
  }

  window.UI = {
    $, esc, showModal, promptModal, confirmModal, contextMenu, hideMenu, toast,
    get modalOpen() { return openModals > 0; },
  };
})();
