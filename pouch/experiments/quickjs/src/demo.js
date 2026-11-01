// Demo page: run guest JS against a small in-memory filesystem, show the
// output and proposed changes, then apply them with conflict detection.
import { runInWorker, applyChanges, snapshot, MemFS } from './host.js';

// WORKER_SRC is the bundled worker-browser.js, injected by build.mjs. It is a
// constant inside this hashed script, so the blob: worker can only ever run
// code that shipped in the page.
const makeWorker = () => {
  const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
};

const PRESETS = {
  hello: 'console.log("hello from QuickJS", args, stdin.length);\nfor (const name of fs.readdir("/src")) print(name, fs.readFile("/src/" + name).length);',
  write: 'const n = fs.readFile("/src/notes.md");\nfs.writeFile("/src/notes.md", n.toUpperCase());\nfs.writeFile("/out/count.json", JSON.stringify({ chars: n.length }));\nfs.rm("/src/old.txt");\nprint("done");',
  loop: 'let i = 0;\nfor (;;) i++;',
  oom: 'const a = [];\nfor (;;) a.push(new Array(1e5).fill(a.length));',
  escape: 'print(typeof fetch, typeof require, typeof postMessage, typeof WebAssembly);\nimport("x").catch((e) => print(String(e)));',
};

const $ = (id) => document.getElementById(id);
const fs = new MemFS({ '/src/notes.md': '# notes\nhello\n', '/src/old.txt': 'old\n' });
let controller = null, last = null;

function showFiles() {
  $('files').textContent = [...fs.files].map(([p, b]) => `${p}  (${b.length} B)`).join('\n');
}

async function run() {
  controller = new AbortController();
  $('run').disabled = true; $('cancel').disabled = false; $('apply').disabled = true;
  $('status').textContent = 'running';
  const request = {
    code: $('code').value,
    files: await snapshot(fs, [...fs.files.keys()]),
    args: ['demo'], stdin: '',
    limits: { timeMs: +$('time').value, memoryBytes: +$('mem').value << 20, maxOutputBytes: 16 << 10 },
  };
  last = await runInWorker(makeWorker, request, { signal: controller.signal });
  $('status').textContent = `${last.status} (exit ${last.exitCode}, ${last.ms} ms)${last.truncated ? ', output truncated' : ''}`;
  $('status').dataset.status = last.status;
  $('out').textContent = last.stdout + (last.stderr ? '\n[stderr]\n' + last.stderr : '') + (last.message ? '\n[' + last.status + '] ' + last.message : '');
  $('changes').textContent = last.changes.map((c) => `${c.op.padEnd(6)} ${c.path}`).join('\n') || '(none)';
  $('run').disabled = false; $('cancel').disabled = true; $('apply').disabled = !last.changes.length;
}

$('run').onclick = run;
$('cancel').onclick = () => controller?.abort();
$('apply').onclick = async () => {
  const r = await applyChanges(fs, last.changes, { atomic: $('atomic').checked });
  $('changes').textContent = [...r.applied.map((a) => `applied  ${a.op} ${a.path}`), ...r.conflicts.map((c) => `conflict ${c.path}: ${c.reason}`)].join('\n');
  $('apply').disabled = true;
  showFiles();
};
$('touch').onclick = async () => { await fs.writeFile('/src/notes.md', '# edited elsewhere\n'); showFiles(); };
for (const [name, code] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.textContent = name; b.dataset.preset = name;
  b.onclick = () => { $('code').value = code; };
  $('presets').append(b);
}
$('code').value = PRESETS.hello;
showFiles();
