// The runner protocol between src/run/host.ts (the page) and src/run/worker.ts.
// Types only: the worker imports it without pulling in the page side.
//
//   worker -> host  { type: 'ready' }                once the engine is loaded
//   host -> worker  { type: 'run', request, ns? }    exactly once; ns: a 9P MessagePort
//   worker -> host  { type: 'loaded', files, bytes } snapshot read over 9P (ns runs only)
//   worker -> host  { type: 'ran' }                  the guest is done; writing back
//   worker -> host  { type: 'result', result }       then the worker idles to be terminated
import type { RunRequest, RunResult } from './core.ts';

export interface RunMessage { type: 'run'; request: RunRequest; ns?: MessagePort }
export interface RunLoaded { type: 'loaded'; files: number; bytes: number }
export type RunWorkerMessage = { type: 'ready' } | RunLoaded | { type: 'ran' } | { type: 'result'; result: RunResult };
