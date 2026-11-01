// The page is only a bridge: qualify.mjs calls window.call(action, args) through
// Playwright, and this forwards it to the module worker (CSP forbids inline script).
const worker = new Worker('./qualify-worker.js', { type: 'module' });
const pending = new Map(); let id = 0;
worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.error ? p.reject(Error(data.error)) : p.resolve(data.result); };
worker.onerror = (e) => { document.querySelector('#status').textContent = e.message; for (const p of pending.values()) p.reject(Error(e.message)); };
window.call = (action, args = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); worker.postMessage({ id: n, action, ...args }); });
window.ready = true; document.querySelector('#status').textContent = 'Ready';
