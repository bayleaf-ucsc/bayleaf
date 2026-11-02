// PDF commands for the shell, on Pouch's first heavy-tool runtime (pdf.js):
//
//   pdfinfo  [-upw PW] FILE                     pages, metadata, encryption, JS, text layer
//   pdftotext [-f N] [-l N] [-layout] [-nopgbrk] [-nomarkers] [-upw PW] FILE [OUT|-]
//   pdftoppm [-f N] [-l N] [-r DPI] [-png|-jpeg] [-singlefile] [-x X -y Y -W W -H H] [-upw PW] FILE PREFIX
//
// Poppler's names and flags, so an agent's prior knowledge works (story AG5);
// what differs says so in an error. pdftotext marks each page ("[page N]") so
// answers can cite pages (AG3) and names pages with no text layer (AG4).
//
// The runtime (build-pdf.mjs, src/pdf/worker.ts) is fetched only when a pdf
// command first needs it, from this origin as content-hash parts checked
// against the manifest this page was built with (src/assets.ts partAssets),
// and then kept for offline use. Every command is an engine job
// (src/jobs.ts): a /task entry whose ctl stops it, one worker shared by every
// agent and the terminal. Commands read and write only the caller's own
// filesystem view (ctx.fs); the worker gets bytes, never a filesystem.
import { partAssets } from './assets.ts';
import { createJobs } from './jobs.ts';
import { normalize } from './vfs.ts';
import type { defineCommand as DefineCommand, ResolvedCommandContext, IFileSystem, ExecResult } from 'just-bash';
import type { Task, TaskFields, Tasks } from './ns/tasks.ts';
import type { EngineDef } from './jobs.ts';
import type { ObtainedRuntime, PartsPin, RuntimeAssets, RuntimeFiles } from './assets.ts';
import type { PdfAction, PdfInfo, PdfJob, PdfJobBody, PdfJobInput, PdfReply, PdfResult, PdfResultOf, PdfText } from './pdf/protocol.ts';
export type { PdfJob, PdfReply, PdfRequest, PdfResult } from './pdf/protocol.ts';

// ── Heavy-tool runtimes: what src/media.ts shares with this one ──────
// spawn: tests may pass their own worker.
export interface EngineOptions { assets?: RuntimeAssets | null; spawn?: (files: RuntimeFiles) => Worker; onLoad?: (got: ObtainedRuntime) => void }
export type Note = (line: string) => void;
// A job waiting for its reply.
export interface Pending<R> { resolve(result: R): void; reject(e: unknown): void; note?: Note; timer?: ReturnType<typeof setTimeout> }
// Who a job is for (the /task label); fs is the caller's own view (capability scoping).
export interface Who { name?: string; sid?: TaskFields['sid'] }
export interface RunOptions { who?: Who; fs?: IFileSystem; signal?: AbortSignal; label?: string }
export interface ServiceOptions<J, R> { tasks: Tasks; engine?: EngineDef<J, R>; budget?: number }
// The engine's answer is the caller's to read: jobs do not know its type.
export interface JobHandle { task: Task; result: Promise<unknown> }
export type WhoOf = Who | (() => Who | undefined);
export type CodedError = Error & { code?: string };
// A command's job: its failure as the shell's result, or the engine's answer.
export type JobOutcome<R> = { error: ExecResult; r?: undefined } | { error?: undefined; r: R; task: Task };

export const PDF_RUNTIME = typeof POUCH_PDF_RUNTIME !== 'undefined' ? POUCH_PDF_RUNTIME as PartsPin : null; // eslint-disable-line no-undef

// Caps, named so errors and the pdf skill can cite them.
export const MAX_PDF_BYTES = 256 * 2 ** 20; // a larger file is refused before anything loads
export const TEXT_MAX_PAGES = 2000;         // pages per pdftotext call
export const INFO_SCAN_PAGES = 500;         // pages pdfinfo checks for a text layer
export const RENDER_MAX_PAGES = 50;         // pages per pdftoppm call
export const DEFAULT_DPI = 150;             // poppler's default
export const MIN_DPI = 18;
export const MAX_DPI = 600;
export const MAX_PIXELS = 25_000_000;       // per rendered page (width x height), before any crop
export const RENDER_MAX_BYTES = 256 * 2 ** 20; // encoded images per pdftoppm call, together
export const ENGINE_MEMORY = 0.25 * 2 ** 30; // the jobs memory guard's estimate for the worker
const STOP_GRACE_MS = 3000;                 // after Stop, how long a page may take before the worker is ended

const ok = (stdout = '', stderr = '') => ({ stdout, stderr, exitCode: 0 });
const fail = (cmd: string, msg: string, code = 1) => ({ stdout: '', stderr: `${cmd}: ${msg}\n`, exitCode: code });

export type PdfCommand = 'pdfinfo' | 'pdftotext' | 'pdftoppm';
export const HELP: Record<PdfCommand, string> = {
  pdfinfo: `usage: pdfinfo [-upw PASSWORD] FILE.pdf
  Pages, title and author, page size, PDF version, whether it is encrypted,
  whether it carries JavaScript (never run here), and which pages have no text
  layer (checks the first ${INFO_SCAN_PAGES} pages).
`,
  pdftotext: `usage: pdftotext [-f FIRST] [-l LAST] [-layout] [-nopgbrk] [-nomarkers] [-upw PASSWORD] FILE.pdf [OUT.txt | -]
  Text in reading order. Each page starts with a "[page N]" line and ends with
  a form feed (-nopgbrk drops the form feed, -nomarkers the "[page N]" lines).
  A page with no text layer says so. -layout keeps columns roughly in place.
  OUT defaults to FILE.txt; "-" writes to standard output. At most
  ${TEXT_MAX_PAGES} pages per call.
`,
  pdftoppm: `usage: pdftoppm [-f FIRST] [-l LAST] [-r DPI] [-png | -jpeg] [-singlefile] [-x X -y Y -W WIDTH -H HEIGHT] [-upw PASSWORD] FILE.pdf PREFIX
  Renders pages to images: PREFIX-N.png (N zero-padded like poppler), or
  PREFIX.png with -singlefile (first page only). PNG unless -jpeg (no PPM).
  -r DPI (default ${DEFAULT_DPI}, ${MIN_DPI}-${MAX_DPI}); at most ${RENDER_MAX_PAGES} pages per call and
  ${MAX_PIXELS.toLocaleString('en-US')} pixels per page. -x -y -W -H crop the rendered page, in
  pixels from its top left.
`,
};

// Poppler-style arguments: flags are single-dash words; some take a value.
const SPEC = {
  pdfinfo: { values: ['upw', 'opw'], bools: ['q'], positional: [1, 1] },
  pdftotext: { values: ['f', 'l', 'upw', 'opw', 'enc'], bools: ['layout', 'nopgbrk', 'nomarkers', 'q', 'raw'], positional: [1, 2] },
  pdftoppm: { values: ['f', 'l', 'r', 'x', 'y', 'W', 'H', 'upw', 'opw'], bools: ['png', 'jpeg', 'singlefile', 'q'], positional: [2, 2] },
};
const UNSUPPORTED: Partial<Record<PdfCommand, Record<string, string>>> = {
  pdftoppm: { rx: 'use -r (one resolution for both axes)', ry: 'use -r (one resolution for both axes)', 'scale-to': 'use -r', 'scale-to-x': 'use -r', 'scale-to-y': 'use -r',
    tiff: 'PNG or JPEG only (-png, -jpeg)', ps: 'PNG or JPEG only (-png, -jpeg)', mono: 'not supported', gray: 'not supported', cropbox: 'not supported' },
  pdftotext: { bbox: 'not supported', 'bbox-layout': 'not supported', htmlmeta: 'not supported', tsv: 'not supported', eol: 'line ends are always \\n' },
};
const INT = /^\d+$/;

// Flags as parsed: page and pixel numbers are numbers by the time parseArgs returns.
export interface PdfOpts {
  [flag: string]: string | number | boolean | undefined;
  f?: number; l?: number; r?: number; x?: number; y?: number; W?: number; H?: number; upw?: string; opw?: string; enc?: string;
  layout?: boolean; nopgbrk?: boolean; nomarkers?: boolean; q?: boolean; png?: boolean; jpeg?: boolean; singlefile?: boolean;
}
// code 99: poppler's exit status for bad arguments.
export type PdfArgs = { help: true; error?: undefined; opts?: undefined; files?: undefined }
  | { error: string; code: number; help?: undefined; opts?: undefined; files?: undefined }
  | { opts: PdfOpts; files: string[]; help?: undefined; error?: undefined };
export function parseArgs(cmd: PdfCommand, args: string[]): PdfArgs {
  const spec = SPEC[cmd], opts: PdfOpts = {}, files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '-help' || a === '--help' || a === '-?') return { help: true };
    if (a === '-' || !a.startsWith('-') || /^-\d/.test(a)) { files.push(a); continue; }
    const name = a.replace(/^--?/, '');
    if (spec.bools.includes(name)) { opts[name] = true; continue; }
    if (spec.values.includes(name)) {
      if (i + 1 >= args.length) return { error: `${a} needs a value`, code: 99 };
      opts[name] = args[++i];
      continue;
    }
    const why = UNSUPPORTED[cmd]?.[name];
    return { error: why ? `${a}: ${why}` : `unknown option ${a}`, code: 99 };
  }
  const [lo, hi] = spec.positional;
  if (files.length < lo || files.length > hi) return { error: cmd === 'pdftoppm' ? 'needs FILE.pdf and an output PREFIX' : `needs ${lo === hi ? 'one' : `${lo} to ${hi}`} file argument${hi > 1 ? 's' : ''}`, code: 99 };
  for (const k of ['f', 'l', 'r', 'x', 'y', 'W', 'H']) {
    if (opts[k] === undefined) continue;
    if (!INT.test(opts[k] as string)) return { error: `-${k} needs a whole number, not "${opts[k]}"`, code: 99 };
    opts[k] = Number(opts[k]);
  }
  if (opts.f !== undefined && opts.f < 1) return { error: '-f counts pages from 1', code: 99 };
  if (opts.l !== undefined && opts.l < 1) return { error: '-l counts pages from 1', code: 99 };
  if (opts.f && opts.l && opts.l < opts.f) return { error: `-l ${opts.l} is before -f ${opts.f}`, code: 99 };
  if (cmd === 'pdftotext' && opts.enc && !/^utf-?8$/i.test(opts.enc)) return { error: `-enc ${opts.enc}: output is always UTF-8`, code: 99 };
  if (cmd === 'pdftoppm') {
    if (opts.png && opts.jpeg) return { error: 'choose one of -png and -jpeg', code: 99 };
    if (opts.r !== undefined && (opts.r < MIN_DPI || opts.r > MAX_DPI)) return { error: `-r ${opts.r} is outside ${MIN_DPI}-${MAX_DPI} DPI (MAX_DPI)`, code: 99 };
    const crop = ['x', 'y', 'W', 'H'].filter((k) => opts[k] !== undefined);
    if (crop.length && (opts.W === 0 || opts.H === 0)) return { error: '-W and -H must be at least 1', code: 99 };
  }
  return { opts, files };
}

// Pages first..last for a call, within its cap; null `last` means "to the end"
// (the worker clamps to the page count). A range over the cap is refused, not cut.
export type PageRange = { error: string; first?: undefined; last?: undefined } | { error?: undefined; first: number; last: number | null };
export function pageRange(opts: PdfOpts, cap: number, cmd: string): PageRange {
  const first = opts.f ?? 1, last = opts.singlefile ? first : opts.l ?? null; // -singlefile: the first page only, as poppler
  if (last != null && last - first + 1 > cap) return { error: `pages ${first}-${last} are ${last - first + 1} pages; ${cmd} takes at most ${cap} per call. Use -f and -l to go in batches.` };
  return { first, last };
}

const abs = (cwd: string, p: string) => normalize(p.startsWith('/') ? p : cwd + '/' + p);
const isPdf = (b: Uint8Array) => { const head = new TextDecoder('latin1').decode(b.subarray(0, 1024)); return head.includes('%PDF-'); };

async function readPdf(cmd: PdfCommand, ctx: ResolvedCommandContext, file: string): Promise<{ error: ExecResult; p?: undefined } | { error?: undefined; p: string; data: Uint8Array }> {
  const p = abs(ctx.cwd, file);
  let st;
  try { st = await ctx.fs.stat(p); } catch { return { error: fail(cmd, `${p}: no such file`) }; }
  if (st.isDirectory) return { error: fail(cmd, `${p} is a folder`) };
  if (st.size > MAX_PDF_BYTES) return { error: fail(cmd, `${p} is ${(st.size / 2 ** 20).toFixed(0)} MiB; the cap is ${MAX_PDF_BYTES / 2 ** 20} MiB (MAX_PDF_BYTES)`) };
  const data = await ctx.fs.readFileBuffer(p);
  if (!isPdf(data)) return { error: fail(cmd, `${p}: not a PDF file (no %PDF- header)`) };
  return { p, data };
}

const pad = (s: string, n: number) => (s + ':').padEnd(n);
const PAPER: [string, number, number][] = [['letter', 612, 792], ['legal', 612, 1008], ['A4', 595, 842], ['A3', 842, 1191], ['A5', 420, 595]];
const paperOf = ([w, h]: [number, number]) => PAPER.find(([, a, b]) => (Math.abs(a - w) < 2 && Math.abs(b - h) < 2) || (Math.abs(a - h) < 2 && Math.abs(b - w) < 2))?.[0];
const pdfDate = (d: PdfInfo['info'][string]) => typeof d === 'string' && /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.test(d)
  ? d.replace(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?.*$/, (_, y, m = '01', dd = '01', h = '00', mi = '00', s = '00') => `${y}-${m}-${dd} ${h}:${mi}:${s}`) : d;
const ranges = (ns: number[]) => ns.reduce<[number, number][]>((out, n) => { const r = out.at(-1); r && r[1] === n - 1 ? (r[1] = n) : out.push([n, n]); return out; }, []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');

// password: one was given (-upw or -opw), so the opening may have used it.
export function formatInfo(r: PdfInfo, { password = false }: { password?: boolean } = {}) {
  const lines: string[] = [], i = r.info ?? {};
  for (const k of ['Title', 'Subject', 'Keywords', 'Author', 'Creator', 'Producer']) if (i[k]) lines.push(pad(k, 16) + String(i[k]));
  for (const k of ['CreationDate', 'ModDate']) if (i[k]) lines.push(pad(k, 16) + pdfDate(i[k]));
  lines.push(pad('Pages', 16) + r.pages);
  lines.push(pad('Encrypted', 16) + (i.EncryptFilterName ? `yes (${i.EncryptFilterName}; ${password ? 'opened with the password given' : 'opened without a password'})` : 'no'));
  const [w, h] = r.size, paper = paperOf(r.size);
  lines.push(pad('Page size', 16) + `${+w.toFixed(2)} x ${+h.toFixed(2)} pts${paper ? ` (${paper})` : ''}`);
  lines.push(pad('Page rot', 16) + r.rotate);
  if (i.PDFFormatVersion) lines.push(pad('PDF version', 16) + i.PDFFormatVersion);
  lines.push(pad('Form', 16) + (i.IsXFAPresent ? 'XFA (not supported)' : i.IsAcroFormPresent ? 'AcroForm' : 'none'));
  lines.push(pad('JavaScript', 16) + (r.javascript ? 'yes (never run: Pouch has no PDF scripting)' : 'no'));
  const scanned = r.scanned < r.pages ? ` (checked pages 1-${r.scanned} of ${r.pages})` : '';
  const text = !r.noText.length ? `every page${scanned}`
    : r.noText.length === r.scanned ? `none${scanned}: a scan or images only; render pages with pdftoppm to see them`
    : `missing on page${r.noText.length > 1 ? 's' : ''} ${ranges(r.noText)}${scanned}; render those with pdftoppm`;
  lines.push(pad('Text layer', 16) + text);
  return lines.join('\n') + '\n';
}

export function formatText(r: PdfText, { nopgbrk, nomarkers }: { nopgbrk?: boolean; nomarkers?: boolean } = {}) {
  return r.pages.map(({ n, text, empty }) => {
    const body = empty ? `[page ${n}: no text layer; render it with pdftoppm -f ${n} -l ${n}]\n` : text.replace(/\s+$/, '') + '\n';
    return (nomarkers ? '' : `[page ${n}]\n`) + (empty && nomarkers ? '' : body) + (nopgbrk ? '' : '\f');
  }).join('');
}

// ── The engine: one worker from the verified runtime ─────────────────
const stopped = () => new DOMException('Stopped.', 'AbortError');
const codeError = (msg: string, code?: string) => Object.assign(new Error(msg), { code });

function defaultSpawn(files: RuntimeFiles) {
  const src = URL.createObjectURL(new Blob([files['worker.js']], { type: 'text/javascript' }));
  try { return new Worker(src, { type: 'module', name: 'pouch-pdf' }); } finally { URL.revokeObjectURL(src); }
}

export function pdfEngine({ assets = PDF_RUNTIME && partAssets(PDF_RUNTIME), spawn = defaultSpawn, onLoad }: EngineOptions = {}): EngineDef<PdfJob, PdfResult> {
  return {
    label: 'pdf.js', memory: ENGINE_MEMORY, concurrency: 1,
    create() {
      if (!assets) throw codeError('this build of Pouch has no pdf runtime (built with it left out)', 'ENOSYS');
      let worker: Worker | null = null, seq = 0;
      const pending = new Map<number, Pending<PdfResult>>();
      async function start(note: Note | undefined, signal: AbortSignal) {
        note?.('loading the pdf runtime');
        const got = await assets!.obtain({ network: globalThis.navigator?.onLine !== false, signal });
        if (signal?.aborted) throw stopped();
        onLoad?.(got);
        const w = spawn(got.files);
        w.onmessage = ({ data }: MessageEvent<PdfReply>) => {
          const p = pending.get(data.id);
          if (!p) return;
          if (data.note !== undefined) return p.note?.(data.note);
          pending.delete(data.id);
          data.error !== undefined ? p.reject(codeError(data.error, data.code)) : p.resolve(data.result);
        };
        w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'the pdf worker failed')); pending.clear(); worker = null; };
        worker = w;
        // A runtime that fails to load is not kept: the next job starts a fresh worker.
        try { await call('load', { pack: await got.files['data.pack'].arrayBuffer() }); }
        catch (e) { w.terminate(); if (worker === w) worker = null; throw e; }
      }
      function call(action: PdfAction | 'load', data: PdfJobBody | { pack: ArrayBuffer; data?: undefined }, { note, signal }: { note?: Note; signal?: AbortSignal } = {}) {
        return new Promise<PdfResult>((resolve, reject) => {
          const id = ++seq, w = worker!;
          pending.set(id, { resolve, reject, note });
          if (signal) signal.addEventListener('abort', () => {
            w.postMessage({ action: 'stop', job: id });
            // A page that does not finish within the grace period ends the worker; the next job starts a new one.
            const t = setTimeout(() => { if (pending.has(id)) { pending.delete(id); w.terminate(); if (worker === w) worker = null; reject(stopped()); } }, STOP_GRACE_MS);
            pending.get(id) && (pending.get(id)!.timer = t);
          }, { once: true });
          w.postMessage({ id, action, ...data }, data.data ? [data.data.buffer as ArrayBuffer] : []);
        });
      }
      return {
        async run({ action, data, ...opts }, { signal, note }) {
          // Stop also ends a first-run download (assets.obtain takes the signal).
          if (!worker) await start(note, signal).catch((e) => { throw signal.aborted ? stopped() : e; });
          if (signal.aborted) throw stopped();
          return call(action, { data: data.slice(), ...opts }, { note, signal });
        },
        dispose() { worker?.terminate(); worker = null; },
      };
    },
  };
}

// The service shared by the terminal and every agent: one engine, its jobs.
export function createPdfService({ tasks, engine = pdfEngine(), budget }: ServiceOptions<PdfJob, PdfResult> = {} as ServiceOptions<PdfJob, PdfResult>) {
  const jobs = createJobs({ tasks, engines: { pdf: engine }, ...(budget ? { budget } : {}) });
  return {
    jobs,
    run(input: PdfJob, { who = {}, fs, signal, label }: RunOptions = {}): JobHandle {
      const { task, result } = jobs.submit('pdf', input, { caller: { sid: who.sid ?? undefined, name: who.name, fs }, label });
      const kill = () => tasks.kill(task).catch(() => {});
      if (signal) { if (signal.aborted) kill(); else signal.addEventListener('abort', kill, { once: true }); }
      return { task, result };
    },
  };
}

// ── Shell commands ───────────────────────────────────────────────────
export type PdfService = ReturnType<typeof createPdfService>;
// whoOf: who the /task label names.
export function pdfCommands(defineCommand: typeof DefineCommand, service: PdfService | null | undefined, whoOf: WhoOf = () => ({ name: 'terminal' })) {
  const who = () => (typeof whoOf === 'function' ? whoOf() : whoOf) ?? {};
  async function job<A extends PdfAction>(cmd: PdfCommand, ctx: ResolvedCommandContext, file: string, input: PdfJobInput & { action: A }): Promise<JobOutcome<PdfResultOf<A>> & { p?: string }> {
    if (!service) return { error: fail(cmd, 'the pdf runtime is not available here') };
    const read = await readPdf(cmd, ctx, file);
    if (read.error) return read;
    const { task, result } = service.run({ ...input, data: read.data } as PdfJob, { who: who(), fs: ctx.fs, signal: ctx.signal, label: `${cmd} ${read.p.split('/').pop()}` });
    try { return { p: read.p, r: await result as PdfResultOf<A>, task }; }
    catch (e) {
      if ((e as CodedError)?.name === 'AbortError') return { error: fail(cmd, `stopped (/task/${task.id})`, 130) };
      const what = (e as CodedError).code === 'EENCRYPTED' ? `${read.p}: ${(e as CodedError).message}${input.password ? '' : ' (try -upw PASSWORD)'}`
        : (e as CodedError).code === 'ENOTPDF' ? `${read.p}: ${(e as CodedError).message}` : (e as CodedError).code === 'ERANGE' || (e as CodedError).code === 'ECAP' ? (e as CodedError).message : `${read.p}: ${(e as CodedError).message}`;
      return { error: fail(cmd, what, (e as CodedError).code === 'EENCRYPTED' ? 3 : 1) };
    }
  }
  const parse = (cmd: PdfCommand, args: string[]): { done: ExecResult; opts?: undefined; files?: undefined } | { done?: undefined; opts: PdfOpts; files: string[] } => {
    const a = parseArgs(cmd, args);
    if (a.help) return { done: ok(HELP[cmd]) };
    if (a.error) return { done: { stdout: '', stderr: `${cmd}: ${a.error}\n${HELP[cmd]}`, exitCode: a.code } };
    return a as Extract<PdfArgs, { opts: PdfOpts }>; // an empty error message cannot happen
  };

  const pdfinfo = defineCommand('pdfinfo', async (args, ctx) => {
    const a = parse('pdfinfo', args);
    if (a.done) return a.done;
    const j = await job('pdfinfo', ctx, a.files[0], { action: 'info', password: a.opts.upw ?? a.opts.opw, scan: INFO_SCAN_PAGES });
    return j.error ?? ok(formatInfo(j.r!, { password: a.opts.upw != null || a.opts.opw != null }));
  });

  // An open range (no -l) that reached the per-call cap still exits 0, but says so on
  // stdout, where an agent reads, as well as stderr, with the next batch to ask for.
  // Even -q keeps it: a silent cut reads as the whole document.
  const capNote = (cmd: PdfCommand, range: PageRange, cap: number, numPages: number, name: string) => {
    const end = range.first! + cap - 1;
    if (range.last != null || numPages <= end) return { out: '', err: '' };
    return { out: `[stopped at page ${end} of ${numPages}: pass -f ${end + 1} -l ${Math.min(end + cap, numPages)} for more]\n`,
      err: `${cmd}: stopped at page ${end} of ${numPages} (${name}); continue with -f ${end + 1}\n` };
  };

  const pdftotext = defineCommand('pdftotext', async (args, ctx) => {
    const a = parse('pdftotext', args);
    if (a.done) return a.done;
    const range = pageRange(a.opts, TEXT_MAX_PAGES, 'pdftotext');
    if (range.error) return fail('pdftotext', range.error, 99);
    const j = await job('pdftotext', ctx, a.files[0], { action: 'text', first: range.first!, last: range.last ?? range.first! + TEXT_MAX_PAGES - 1, layout: !!a.opts.layout, password: a.opts.upw ?? a.opts.opw });
    if (j.error) return j.error;
    const text = formatText(j.r, a.opts);
    const more = capNote('pdftotext', range, TEXT_MAX_PAGES, j.r.numPages, 'TEXT_MAX_PAGES');
    const out = a.files[1] ?? j.p!.replace(/\.pdf$/i, '') + '.txt';
    if (out === '-') return ok(text + more.out, more.err);
    const o = abs(ctx.cwd, out);
    await ctx.fs.writeFile(o, text);
    return ok((a.opts.q ? '' : `wrote ${o} (pages ${j.r.pages[0]?.n ?? '-'}-${j.r.pages.at(-1)?.n ?? '-'} of ${j.r.numPages})\n`) + more.out, more.err);
  });

  const pdftoppm = defineCommand('pdftoppm', async (args, ctx) => {
    const a = parse('pdftoppm', args);
    if (a.done) return a.done;
    const range = pageRange(a.opts, RENDER_MAX_PAGES, 'pdftoppm');
    if (range.error) return fail('pdftoppm', range.error, 99);
    const dpi = a.opts.r ?? DEFAULT_DPI, jpeg = !!a.opts.jpeg;
    const crop = ['x', 'y', 'W', 'H'].some((k) => a.opts[k] !== undefined) ? { x: a.opts.x ?? 0, y: a.opts.y ?? 0, W: a.opts.W, H: a.opts.H } : null;
    const j = await job('pdftoppm', ctx, a.files[0], { action: 'render', first: range.first!, last: range.last ?? range.first! + RENDER_MAX_PAGES - 1, dpi, maxPixels: MAX_PIXELS, maxBytes: RENDER_MAX_BYTES, type: jpeg ? 'image/jpeg' : 'image/png', crop, password: a.opts.upw ?? a.opts.opw });
    if (j.error) return j.error;
    const ext = jpeg ? 'jpg' : 'png', prefix = abs(ctx.cwd, a.files[1]), digits = String(j.r.numPages).length;
    const lines = [];
    for (const pg of j.r.pages) {
      const o = a.opts.singlefile ? `${prefix}.${ext}` : `${prefix}-${String(pg.n).padStart(digits, '0')}.${ext}`;
      await ctx.fs.mkdir(normalize(o + '/..'), { recursive: true }).catch(() => {});
      await ctx.fs.writeFile(o, pg.bytes);
      lines.push(`wrote ${o} (page ${pg.n}, ${pg.width}x${pg.height} at ${dpi} DPI)`);
    }
    const more = capNote('pdftoppm', range, RENDER_MAX_PAGES, j.r.numPages, 'RENDER_MAX_PAGES');
    return ok((a.opts.q ? '' : lines.join('\n') + '\n') + more.out, more.err);
  });

  return [pdfinfo, pdftotext, pdftoppm];
}
