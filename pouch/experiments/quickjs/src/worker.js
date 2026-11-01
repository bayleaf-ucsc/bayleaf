// Worker side of the runner protocol, written against a minimal port so the
// same code serves a browser Worker (self) and a Node worker_threads port.
//
//   worker -> host  { type: 'ready' }                once the engine is loaded
//   host -> worker  { type: 'run', request }         exactly once
//   worker -> host  { type: 'result', result }       then the worker idles to be terminated
//
// One worker per run: a fresh engine every time, and terminate() is always a
// safe way to end it, whatever the guest did to its own state.
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { runRequest } from './core.js';

export async function serve(port, variant, { lockdown = () => {} } = {}) {
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  // The engine is in memory now; drop what the worker itself could reach.
  // The guest cannot see these anyway; this narrows what a QuickJS escape
  // bug would find.
  lockdown();
  let used = false;
  port.onmessage = async (e) => {
    const msg = e.data ?? e; // Web MessageEvent or a Node payload
    if (msg?.type !== 'run' || used) return;
    used = true;
    let result;
    try { result = await runRequest(quickjs, msg.request); }
    catch (err) { result = { status: 'error', exitCode: 1, message: `rejected: ${err.message}`, stdout: '', stderr: '', truncated: false, changes: [], ms: 0 }; }
    port.postMessage({ type: 'result', result }, [...new Set(result.changes.flatMap((c) => (c.bytes ? [c.bytes.buffer] : [])))]);
  };
  port.postMessage({ type: 'ready' });
}
