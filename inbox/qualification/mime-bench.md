# MIME resource qualification, 2026-10-21

Historical baseline measurements. The [local hardening follow-up](hardening.md)
adds explicit resource rejection and records new regression results. The harness
now exercises that current guarded source; it does not reproduce this old table
unless run against the original baseline revision with its matching harness.

**Local evidence, not a passed production memory gate.** Source: main `12fe757`,
unmodified Worker, postal-mime 4.0.11, Miniflare 5.20260811.1-alpha / workerd
1.20260811.1, compatibility date 2026-08-01, Node 26.12.0, macOS on M3 Max.
Synthetic input only. No deployed endpoint was contacted.

## Reproduce

From `inbox/`, after `npm install`:

```sh
node qualification/mime-bench.mjs --json /path/to/private-results.json
BENCH_LIVE=1 node qualification/mime-bench.mjs --tier v8
node qualification/mime-bench.mjs --only near-limit-text-unicode-qp,boundary-prefix-lines
```

The harness creates a unique temporary fixture directory under `qualification/`
and removes it on normal completion. Do not commit generated mail or crash dumps.
All outbound Worker network is denied. D1/R2 are local, in-memory-lifetime stores.

The real `email()` handler is invoked by an HTTP wrapper with a streamed synthetic
message. This avoids Miniflare's email simulator parsing input first, which would
hide malformed MIME cases. It is **not SMTP**. The owner RPC binding exercises
metadata/attachment listing, text extraction, last *listed* attachment download,
and exact raw-body download. Reception parses MIME too: the premise that parsing
occurs only on read is not true of this implementation. Downloads reparse the
entire message, including attachments irrelevant to the requested text/part.
The workerd email wrapper buffers the input before building the synthetic event;
its extra buffers contribute to process RSS and do not model real SMTP chunking.

## Real workerd results

Times are one invocation, not percentiles. `R`, `T`, `A` are receipt, text read,
and last-listed attachment read wall times in ms. `CPU R/T/A` is the **whole local
workerd process** CPU delta from macOS `ps`, including local storage simulators,
rounded to roughly 10 ms, not billable per-isolate CPU. RSS is receipt-time
**process RSS growth**, not isolate memory, and depends heavily on GC and preceding
cases. MiB is 1,048,576 bytes. `raw-only` means accepted with `parse_error:true`,
not rejected; text returns `source:none` without reparsing those messages.

| Case | Raw MiB | Outcome | R ms | T ms | A ms | CPU R/T/A ms | Receipt RSS growth MiB |
|---|---:|---|---:|---:|---:|---|---:|
| Small plain text | 0.001 | stored | 11 | 3 | n/a | 10/10/n/a | 2.8 |
| One near-limit base64 attachment | 24.98 | stored | 408 | 202 | 221 | 420/220/210 | 172.8 |
| Near-limit base64 ASCII text | 24.98 | stored | 453 | 202 | n/a | 450/200/n/a | 2.0 |
| Near-limit QP Unicode text | 24.98 | stored | 386 | 152 | n/a | 400/160/n/a | 166.0 |
| Tag-dense HTML only | 24.98 | stored | 324 | 105 | n/a | 330/120/n/a | 14.9 |
| QP soft-break-only bomb | 24.98 | stored | 904 | 676 | n/a | 890/690/n/a | 0.1 |
| Dense QP escapes, binary attachment | 24.98 | stored | 346 | 102 | 108 | 350/110/100 | 16.8 |
| Base64 whitespace/junk after every symbol | 24.98 | stored | 480 | 236 | n/a | 480/240/n/a | 10.2 |
| One enormous text line | 24.98 | stored | 286 | 50 | n/a | 280/50/n/a | 14.8 |
| 9,000 tiny attachments | 0.90 | stored | 83 | 67 | 66 | 110/80/80 | 0.5 |
| 1,000,000 empty MIME parts | 6.68 | raw-only | 112 | 2 | n/a | 120/0/n/a | 3.0 |
| 9,000 inline text parts | 17.17 | stored | 265 | 98 | n/a | 280/120/n/a | 44.7 |
| 450 attachments × 40 KiB | 24.11 | stored | 436 | 197 | 198 | 450/210/200 | 24.2 |
| Multipart depth 250 | 0.02 | stored | 5 | 3 | n/a | 0/10/n/a | 0.2 |
| Multipart depth 20,000 | 1.38 | raw-only | 19 | 1 | n/a | 10/0/n/a | 0.1 |
| Nested message/rfc822, 12 levels | 1.00 | stored | 38 | 18 | 18 | 40/20/20 | 4.6 |
| One 20 MiB header | 20.00 | raw-only | 209 | 2 | n/a | 200/0/n/a | 1.3 |
| Folded header, 1.9 MiB | 1.90 | stored | 39 | 16 | n/a | 50/20/n/a | 5.3 |
| 1,000,000 short headers | 7.63 | raw-only | 87 | 2 | n/a | 90/0/n/a | 23.6 |
| Subject with ~1.9 MiB encoded words | 1.90 | raw-only | 27 | 2 | n/a | 30/0/n/a | 0.3 |
| 998 Unicode codepoints, Unicode filename | 0.01 | stored | 4 | 2 | 2 | 10/0/0 | 0.3 |
| 50,000 RFC 2231 filename continuations | 1.13 | raw-only | 21 | 1 | n/a | 20/0/n/a | 0.2 |
| 60,000 To addresses | 0.91 | raw-only | 17 | 1 | n/a | 20/0/n/a | 0.3 |
| Declared boundary never appears | 24.98 | stored | 277 | 35 | n/a | 270/40/n/a | 71.3 |
| Almost-matching boundary lines | 24.98 | stored | 619 | 347 | n/a | 620/360/n/a | 146.6 |
| 200 unclosed multiparts, empty inner boundary | 24.97 | stored | 296 | 67 | n/a | 300/70/n/a | 25.3 |
| Declared rawSize over 25 MiB, tiny stream | 0.0002 | size reject | 1 | n/a | n/a | 10/n/a/n/a | 0.0 |
| Stream over 25 MiB, falsely small rawSize | 25.00 | size reject | 51 | n/a | n/a | 40/n/a/n/a | 25.1 |

QP Unicode and almost-matching boundaries above were rerun after correcting the
QP fixture's raw-size calculation. The original QP fixture was 25.25 MiB and
correctly rejected; it is not counted as near-limit parse evidence. Other rows
come from the full run. The corrected boundary case reproduces the same behavior.
The two declared/stream-size cases return `5.3.4 Message too large` with no receipt.

All accepted cases also returned an exact-size raw body successfully. In the
full run, the large attachment's raw download took 35 ms wall / 20 ms process CPU
and grew process RSS by 107.3 MiB. This is buffered, not a streaming-memory proof.
The 9,000-part and 450-attachment listings contain only 200 entries and mark
`attachments_truncated:true`; the benchmark downloads index 199, not hidden parts.
Text results respect the 262,144-character output cap. Subject metadata is
clipped to 998 UTF-16 units, not necessarily 998 Unicode codepoints.

A supplementary real-workerd metadata-listing run measured `getMessage` (which
returns the saved attachment list) at **2 ms wall** for each of: the small
baseline, near-limit attachment, 9,000 tiny attachments and 450 × 40 KiB
attachments. Process CPU was below the 10 ms measurement resolution in each case.
This path reads bounded D1 metadata and does not reparse raw MIME, unlike text and
attachment downloads. These listing timings are separate from the full-run table.

## Memory warning: Miniflare does not enforce production limits

Open-source workerd/Miniflare does not model the production **128 MB per-isolate**
memory cap, CPU enforcement, shared-isolate concurrent traffic, SMTP ingress, or
remote D1/R2 latency/durability. Process RSS includes its other Workers and local
D1/R2. RSS growth above 128 MiB is a warning, not proof of an isolate OOM; a small
RSS delta after preceding tests is not proof of low memory usage.

The auxiliary V8 tier runs the same source parsing/metadata/text functions in a
fresh Node child with `--max-old-space-size=128`. That caps only V8 old-space,
**not total 128 MB memory**. It samples `heapUsed + arrayBuffers` at parser-line
intervals and subtracts the fixture file buffer. This is an estimate, not a
Cloudflare limit measurement. It includes some Node baseline overhead, may miss
transient peaks, and samples uncollected garbage. With `BENCH_LIVE=1`, forced GC
gives a lower-memory diagnostic, but destroys meaningful CPU timing.

| Case | Normal sampled receipt estimate MiB | Forced-GC receipt estimate MiB | Normal text-read estimate MiB |
|---|---:|---:|---:|
| Large base64 attachment | 131.3 | 122.7 | 106.3 |
| Large base64 text | 135.7 | 118.2 | 106.2 |
| HTML-only | 142.9 | 107.7 | 110.0 |
| 9,000 tiny attachments | 40.2 | 24.9 | 38.6 |
| 450 × 40 KiB attachments | 86.6 | 74.8 | 62.4 |
| Almost-matching boundary lines | **heap OOM** | **heap OOM** | **heap OOM** |

The boundary case aborts all three Node phases with a V8 heap-out-of-memory error,
even with forced-GC sampling. In real workerd it is accepted, then reparsed for
text. This is a concrete parser/resource vulnerability candidate, **not a small
fix**: raw-byte size, part count and header caps do not bound line-heavy parser
allocation. It also demonstrates why accepted input must be benchmarked on read.
The original double-buffer `readBounded` implementation remains unchanged: an
experimental presizing edit did not establish a material improvement and was
removed before the recorded full run.

Postal-mime's existing limits successfully turn excessive depth, part counts and
headers into raw-only storage. The encoded-word, RFC 2231 and address fixtures hit
the parser's cumulative header-size accounting even when raw input is under
2 MiB; they do not prove the full decoding path is safe just below every limit.

## Decision and next bounded experiment

**Keep campus rollout blocked.** These results do not establish safe concurrent
near-25 MiB parsing under 128 MB. Do not merely increase CPU or call local success
a memory pass. Candidate next work: explicitly bound MIME line/structure work,
qualify smaller service limits against representative legitimate mail, or move
parsing to separately bounded work. Apply the same policy on receipt and read,
preserve exact raw bytes on parser failures, and test concurrent near-limit reads.
Choosing a new public size limit or a new parsing architecture requires review.

References checked 2026-10-21:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[inbound Email Routing limits](https://developers.cloudflare.com/email-service/platform/limits/).
Workers Paid HTTP default CPU is 30 s, configurable up to 300 s; the local process
CPU numbers here do not measure that budget or guarantee email-trigger behavior.
