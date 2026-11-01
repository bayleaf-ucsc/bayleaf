// Browser worker entry, bundled into a string and started from a blob: URL.
// The singlefile variant carries its wasm inline, so the worker never fetches.
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { serve } from './worker.js';

const DROP = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts',
  'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'navigator'];

serve(self, variant, {
  lockdown() {
    for (const k of DROP) { try { Object.defineProperty(self, k, { value: undefined, configurable: false }); } catch { /* not present here */ } }
  },
});
