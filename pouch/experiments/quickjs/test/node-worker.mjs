// Node stand-in for worker-browser.js: same serve(), worker_threads port.
import { parentPort } from 'node:worker_threads';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { serve } from '../src/worker.js';

serve({
  set onmessage(f) { parentPort.on('message', (data) => f({ data })); },
  postMessage: (m, transfer) => parentPort.postMessage(m, transfer),
}, variant);
