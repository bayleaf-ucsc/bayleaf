// Tar and zip, read and write, small enough to read in one sitting. just-bash's
// browser build has no tar, zip or gzip (its zlib is synchronous Node code), so
// Pouch brings its own. Zip compression uses the browser's own
// CompressionStream('deflate-raw'), which is asynchronous and needs no library.
// Both the shell (zip, unzip, tar commands) and the file browser use this.
import { normalize } from './vfs.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Collect a tree into entries ─────────────────────────────────────
// Entries are { path, dir, data? } with paths relative to `base` and '/'-separated.
export async function collect(fs, base, rel) {
  const out = [];
  const walk = async (r) => {
    const full = normalize(base + '/' + r);
    const st = await fs.stat(full);
    if (!st.isDirectory) return out.push({ path: r, dir: false, data: await fs.readFileBuffer(full) });
    out.push({ path: r, dir: true });
    for (const name of (await fs.readdir(full)).sort()) await walk(r + '/' + name);
  };
  await walk(rel);
  return out;
}

// Write entries under `dest`, refusing paths that climb out of it ("zip slip").
export async function extract(fs, dest, entries) {
  const written = [];
  for (const e of entries) {
    const clean = normalize('/' + e.path).slice(1);
    if (!clean || e.path.split('/').includes('..')) continue;
    const full = normalize(dest + '/' + clean);
    if (e.dir) { await fs.mkdir(full, { recursive: true }); continue; }
    await fs.mkdir(normalize(full + '/..'), { recursive: true });
    await fs.writeFile(full, e.data);
    written.push(full);
  }
  return written;
}

// ── tar (ustar) ─────────────────────────────────────────────────────
// One 512-byte ustar header. `type` is '0' file, '5' folder, 'x' PAX record.
function tarHeader(name, size, type, prefix = '') {
  const h = new Uint8Array(512);
  const put = (off, len, s) => h.set(enc.encode(s).subarray(0, len), off);
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0');
  put(0, 100, name); put(100, 8, oct(type === '5' ? 0o755 : 0o644, 8)); put(108, 8, oct(0, 8)); put(116, 8, oct(0, 8));
  put(124, 12, oct(size, 12)); put(136, 12, oct(Math.floor(Date.now() / 1000), 12));
  put(148, 8, '        '); put(156, 1, type); put(257, 6, 'ustar'); put(263, 2, '00'); put(345, 155, prefix);
  put(148, 8, oct(h.reduce((a, b) => a + b, 0), 7) + '\0');
  return h;
}

// Headers for one entry. ustar fits a path in prefix (155 bytes) / name (100
// bytes) split at a slash; longer paths ride in a PAX "path=" record first,
// which every modern tar (GNU, bsdtar, Python, 7-Zip) understands.
function entryHeaders(path, size, dir) {
  const full = dir ? path + '/' : path;
  const type = dir ? '5' : '0';
  if (enc.encode(full).length <= 100) return [tarHeader(full, size, type)];
  const i = full.lastIndexOf('/', full.length - 2);
  if (i > 0 && enc.encode(full.slice(0, i)).length <= 155 && enc.encode(full.slice(i + 1)).length <= 100) {
    return [tarHeader(full.slice(i + 1), size, type, full.slice(0, i))];
  }
  // A PAX record is "<len> path=<value>\n", where <len> counts its own digits.
  const body = ` path=${full}\n`;
  let len = enc.encode(body).length;
  len += String(len + String(len).length).length;
  const record = enc.encode(len + body);
  const pad = new Uint8Array((512 - (record.length % 512)) % 512);
  const short = enc.encode(full).slice(-99);
  return [tarHeader('PaxHeader', record.length, 'x'), record, pad, tarHeader(dec.decode(short).replace(/^[^/]*\//, ''), size, type)];
}

export function packTar(entries) {
  const parts = [];
  for (const e of entries) {
    const size = e.dir ? 0 : e.data.length;
    parts.push(...entryHeaders(e.path, size, e.dir));
    if (!e.dir) parts.push(e.data, new Uint8Array((512 - (size % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

export function unpackTar(bytes) {
  const out = [];
  const str = (off, len) => dec.decode(bytes.subarray(off, off + len)).replace(/\0.*$/s, '');
  let paxPath = null;
  for (let off = 0; off + 512 <= bytes.length;) {
    if (bytes.subarray(off, off + 512).every((b) => b === 0)) break;
    const prefix = str(off + 345, 155), name = str(off, 100);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[off + 156] || 48);
    off += 512;
    const data = bytes.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    // PAX extended header: its path= applies to the next entry.
    if (type === 'x') { paxPath = dec.decode(data).match(/\d+ path=([^\n]*)\n/)?.[1] ?? null; continue; }
    if (type === 'g') continue;
    const path = paxPath ?? (prefix ? prefix + '/' : '') + name;
    paxPath = null;
    if (type === '5') out.push({ path: path.replace(/\/$/, ''), dir: true });
    else if (type === '0' || type === '\0' || type === '7') out.push({ path, dir: false, data: data.slice() });
  }
  return out;
}

// ── zip ─────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function through(stream, data) {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function packZip(entries) {
  const files = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = enc.encode(e.dir ? e.path + '/' : e.path);
    const raw = e.dir ? new Uint8Array() : e.data;
    const deflated = raw.length ? await through(new CompressionStream('deflate-raw'), raw) : raw;
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    // Local file header; flag bit 11 marks UTF-8 names.
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, useDeflate ? 8 : 0, 2], [10, dosTime, 2], [12, dosDate, 2],
      [14, crc, 4], [18, body.length, 4], [22, raw.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    files.push(new Uint8Array(local.buffer), name, body);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, useDeflate ? 8 : 0, 2], [12, dosTime, 2], [14, dosDate, 2],
      [16, crc, 4], [20, body.length, 4], [24, raw.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2],
      [36, 0, 2], [38, e.dir ? 0x10 : 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true)));
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cd = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, cd.length, 4], [16, offset, 4]]
    .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return concat([...files, cd, new Uint8Array(end.buffer)]);
}

export async function unpackZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end-of-directory record)');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (path.endsWith('/')) { out.push({ path: path.slice(0, -1), dir: true }); continue; }
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ path, dir: false, data: body.slice() });
    else if (method === 8) out.push({ path, dir: false, data: await through(new DecompressionStream('deflate-raw'), body) });
    else throw new Error(`${path}: unsupported zip compression method ${method}`);
  }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── Shell commands ──────────────────────────────────────────────────
// Deliberately small option sets, with usage text an agent can act on.
export function archiveCommands(defineCommand) {
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  const fail = (msg) => ({ stdout: '', stderr: msg + '\n', exitCode: 1 });
  const abs = (ctx, p) => normalize(p.startsWith('/') ? p : ctx.cwd + '/' + p);
  const relOf = (p) => normalize(p).split('/').pop();

  const zip = defineCommand('zip', async (args, ctx) => {
    const a = args.filter((x) => x !== '-r' && x !== '-q');
    if (a.length < 2) return fail('usage: zip [-r] OUT.zip PATH...   (folders are always included recursively)');
    const entries = [];
    for (const src of a.slice(1)) {
      const full = abs(ctx, src);
      if (!(await ctx.fs.exists(full))) return fail(`zip: ${full}: no such file or directory`);
      entries.push(...await collect(ctx.fs, normalize(full + '/..'), relOf(full)));
    }
    await ctx.fs.writeFile(abs(ctx, a[0]), await packZip(entries));
    return ok(`zipped ${entries.filter((e) => !e.dir).length} files into ${abs(ctx, a[0])}\n`);
  });

  const unzip = defineCommand('unzip', async (args, ctx) => {
    const list = args.includes('-l');
    const a = args.filter((x) => x !== '-l' && x !== '-o' && x !== '-q');
    const d = a.indexOf('-d');
    const dest = d >= 0 ? abs(ctx, a[d + 1] ?? '.') : ctx.cwd;
    const file = a.find((x, i) => d < 0 || (i !== d && i !== d + 1));
    if (!file) return fail('usage: unzip [-l] FILE.zip [-d DIR]');
    let entries;
    try { entries = await unpackZip(await ctx.fs.readFileBuffer(abs(ctx, file))); } catch (e) { return fail(`unzip: ${e.message}`); }
    if (list) return ok(entries.map((e) => (e.dir ? e.path + '/' : `${e.data.length}\t${e.path}`)).join('\n') + '\n');
    const written = await extract(ctx.fs, dest, entries);
    return ok(`extracted ${written.length} files into ${dest}\n`);
  });

  // tar: -c/-x/-t with -f, optional -C; no compression (-z is refused clearly).
  const tar = defineCommand('tar', async (args, ctx) => {
    const flags = (args[0] ?? '').replace(/^-/, '');
    if (/z|j|J/.test(flags) || args.includes('-z')) return fail('tar: compression (-z/-j) is not available in Pouch; use plain .tar or zip');
    const rest = args.slice(1);
    const fi = flags.indexOf('f');
    if (fi < 0) return fail('usage: tar -cf OUT.tar PATH... | tar -xf IN.tar [-C DIR] | tar -tf IN.tar');
    const file = abs(ctx, rest.shift() ?? '');
    let cdir = ctx.cwd;
    const ci = rest.indexOf('-C');
    if (ci >= 0) { cdir = abs(ctx, rest[ci + 1]); rest.splice(ci, 2); }
    if (flags.includes('c')) {
      const entries = [];
      for (const src of rest) {
        const full = abs({ cwd: cdir }, src);
        if (!(await ctx.fs.exists(full))) return fail(`tar: ${full}: no such file or directory`);
        // Relative paths keep their shape inside the archive; absolute ones keep only their last part.
        const absolute = src.startsWith('/');
        entries.push(...(await collect(ctx.fs, absolute ? normalize(full + '/..') : cdir, absolute ? relOf(full) : normalize('/' + src).slice(1))));
      }
      await ctx.fs.writeFile(file, packTar(entries));
      return ok();
    }
    const entries = unpackTar(await ctx.fs.readFileBuffer(file));
    if (flags.includes('t')) return ok(entries.map((e) => e.path + (e.dir ? '/' : '')).join('\n') + '\n');
    if (flags.includes('x')) { await extract(ctx.fs, cdir, entries); return ok(); }
    return fail('tar: give one of -c, -x or -t');
  });

  return [zip, unzip, tar];
}
