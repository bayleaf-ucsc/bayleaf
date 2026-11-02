# DuckDB-Wasm in a network-less blob worker (spike)

**Question.** Can DuckDB-Wasm's `eh` bundle run as Pouch's third heavy-tool runtime: in a
dedicated module worker started from a `blob:` URL under Pouch's production CSP, with its
network APIs removed, reading a registered CSV and a Parquet file, and writing `COPY ... TO`
output back? What does it cost (size, cold start), and can SQL reach the network?

**Method.** `spike.mjs` bundles `worker.mjs` with esbuild (DuckDB-Wasm's *blocking* browser
bindings, `dist/duckdb-browser-blocking.mjs`, which run DuckDB synchronously inside our own
worker instead of the library's async worker and message protocol), serves a page under
`pouch.html`'s CSP (script hash, `'wasm-unsafe-eval'`, `worker-src 'self' blob:`,
`connect-src 'self' ...`), and drives it with Playwright's Chromium. The page fetches the wasm
and passes the bytes to the worker; the worker compiles them itself (an `instantiateWasm`
override on the bindings instead of the library's `fetch(mainModuleURL)`), then removes
`fetch`, `WebSocket`, `EventSource` and `importScripts`. Fixtures: `test/fixtures/duckdb/`
(`people.csv` with a quoted comma; `trees.parquet` written by pyarrow, zstd, with a date and a
null).

```
# extensions, once (signed side modules; the build pins their SHA-256):
mkdir -p /tmp/ddb-ext && for e in parquet json; do curl -s --compressed -o /tmp/ddb-ext/$e.wasm \
  https://extensions.duckdb.org/v1.4.3/wasm_eh/$e.duckdb_extension.wasm; done
node experiments/duckdb-wasm/spike.mjs          # from pouch/; DUCKDB_PKG=<dir> tries another version
```

## Results (2026-11-01, M3 Max, Playwright Chromium)

Version: npm `latest` is a dev build (`1.33.1-dev57.0`); the newest real release is
**`@duckdb/duckdb-wasm` 1.32.0** (2025-12-16), `PRAGMA version` **v1.4.3** (`d1dc88f950`,
Andium). dev57 (v1.5.4) behaved the same in every probe below and is 1.6 MiB larger; dev111
has a different bundle layout (`duckdb-base.wasm`, no `eh`). Chosen: 1.32.0.

| | 1.32.0 |
|---|---|
| `duckdb-eh.wasm` | 32.66 MiB (7.34 MiB gzip): two parts under the 20 MiB part size |
| worker bundle (blocking bindings + apache-arrow 17) | 1.30 MiB (0.31 MiB gzip) |
| `parquet` / `json` extensions (v1.4.3, wasm_eh) | 2.90 / 0.78 MiB |
| compile (bytes in hand) | 42-51 ms |
| worker ready (instantiate, open, connect) | 255-310 ms |
| `LOAD parquet` + `LOAD json` (verified bytes) | 80 + 26 ms |
| fresh database per job (reset, open, LOAD both, settings, lock) x20 | 38-49 ms each, heap steady at 85 MiB |
| CSV group-by / Parquet scan / `COPY TO` CSV | 20 / 11 / 7 ms |

Findings:

1. **Works under Pouch's CSP unchanged**: no violations; the only requests are the page, the
   `blob:` worker, the wasm and the two extension files, all this origin.
2. **Only `core_functions` is statically linked** in the published bundles (the survey's
   "json, parquet statically linked" holds for upstream `main`'s cmake, not for npm builds).
   `parquet` and `json` are signed Emscripten side modules that DuckDB fetches with a
   *synchronous `XMLHttpRequest`* at `LOAD` or autoload, from
   `https://extensions.duckdb.org/v1.4.3/wasm_eh/<name>.duckdb_extension.wasm`. With the
   network gone, a Parquet query failed with a wasm trap ("function signature mismatch") and
   left the instance broken (the next `COPY TO` trapped too): **any wasm trap means the
   instance must be discarded**.
3. **Fix:** the worker installs a stand-in `XMLHttpRequest` that answers only `GET .../wasm_eh/
   <name>.duckdb_extension.wasm` for extensions the page handed over (verified bytes, in
   memory) and throws for anything else. It never touches the network. Both extensions then
   `LOAD` with signature checking on, and `duckdb_extensions()` reports them `REPOSITORY`.
4. **Two refusals, both clear:**
   - DuckDB's own: `SET allowed_directories=['/work/', '/tmp/']`, then
     `enable_external_access=false`, then `lock_configuration=true` (after `LOAD`ing the two
     extensions). `LOAD httpfs` gives "Permission Error: Loading external extensions is
     disabled through configuration". `read_csv('https://...')` and `/etc/passwd` give
     "Permission Error: Cannot access file ... file system operations are disabled by
     configuration". Registered buffers under the allowed directories still read, and
     `COPY TO` there still writes.
   - The worker's: without that configuration, `LOAD httpfs` is "Pouch's DuckDB has no
     network (GET https://.../httpfs.duckdb_extension.wasm)" and an `https://` read is the
     same message for `HEAD`. Either way the engine survives (`SELECT 1 + 1` still answers).
5. `COPY ... TO '/work/x.csv'` and `(FORMAT parquet)` write into DuckDB's buffered file
   system; `copyFileToBuffer(name)` gives the bytes to write back. Decimal (`sum()` of
   integers is `HUGEINT`, exported as Decimal(38,0)), dates and 64-bit integers need typed
   formatting on the way out of Arrow; the naive `toJSON()` mangles decimals.
6. `reset()` + `open()` per job costs about 40 ms with both extensions reloaded and no heap
   growth over 20 rounds, so each command can get a fresh in-memory database (no job sees
   another's tables or files) while the compiled engine stays warm.
7. The library bundle contains one CDN default (`getJsDelivrBundles`, unused here):
   `assertNoCdn` catches it, so the build rewrites that string (one exact match).

8. (Found while building, 2026-11-02.) A database file cannot be handed back: after
   `ATTACH '/work/t.duckdb'` (or opening it as the main database), `CHECKPOINT`, `DETACH`
   and even `reset()`, DuckDB's web file system still reports "File /work/t.duckdb is
   already locked exclusively", `copyFileToBuffer` throws a `WebAssembly.Exception`, and
   `read_blob` on it fails the same way. A new file also opens read-only unless
   `accessMode` is READ_WRITE. So `duckdb DBFILE` is refused with a Parquet recipe.

**Decision.** Build it: 1.32.0, `eh` only, blocking bindings in Pouch's own worker, wasm in two
parts, `parquet` and `json` pinned by SHA-256 and served from memory by the stand-in XHR, a
fresh locked database per job. The `json` extension is needed for `read_json` and `-json`
input; `-json` output is Pouch's own formatter.
