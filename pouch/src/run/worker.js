// Worker side of the runner protocol, written against a minimal port so the
// same code serves a browser Worker (self) and a Node worker_threads port.
//
//   worker -> host  { type: 'ready' }                once the engine is loaded
//   host -> worker  { type: 'run', request, ns? }    exactly once; ns: a 9P MessagePort
//   worker -> host  { type: 'loaded', files, bytes } snapshot read over 9P (ns runs only)
//   worker -> host  { type: 'ran' }                  the guest is done; writing back
//   worker -> host  { type: 'result', result }       then the worker idles to be terminated
//
// With ns, request.specs names the files (paths, folders, globs) and the
// worker reads them itself over 9P, then writes the diff back the same way
// (src/run/over9p.js); result.applied and result.conflicts say what landed.
// Without ns, request.files is a snapshot the host already read.
//
// One worker per run: a fresh engine every time, and terminate() is always a
// safe way to end it, whatever the guest did to its own state.
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { runRequest } from './core.js';
import { Client, NinepFs } from '../ns/9p.js';
import { load, writeBack } from './over9p.js';

const failed = (message) => ({ status: 'error', exitCode: 1, message, stdout: '', stderr: '', truncated: false, changes: [], ms: 0 });

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
    let result, fs = null;
    try {
      let request = msg.request;
      if (msg.ns) {
        fs = new NinepFs(await new Client(msg.ns).connect());
        let snap;
        try { snap = await load(fs, request.specs, request.cwd); }
        catch (err) { result = { ...failed(err.message), phase: 'load' }; }
        if (snap) {
          port.postMessage({ type: 'loaded', files: snap.files.length, bytes: snap.bytes });
          request = { ...request, files: snap.files };
        }
      }
      if (!result) result = await runRequest(quickjs, request);
    } catch (err) { result = failed(`rejected: ${err.message}`); }
    if (fs && result.changes.length && !['timeout', 'oom', 'cancelled'].includes(result.status)) {
      port.postMessage({ type: 'ran' });
      const { applied, conflicts } = await writeBack(fs, result.changes);
      result = { ...result, applied, conflicts };
    }
    port.postMessage({ type: 'result', result }, [...new Set(result.changes.flatMap((c) => (c.bytes ? [c.bytes.buffer] : [])))]);
  };
  port.postMessage({ type: 'ready' });
}
