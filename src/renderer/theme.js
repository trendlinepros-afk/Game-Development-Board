'use strict';
// Apply the saved theme before first paint to avoid a flash.
try { if (localStorage.getItem('theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch { /* ignore */ }
