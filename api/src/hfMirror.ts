/**
 * HF artifact gateway mirror (issue #121): copies approved blobs from the
 * Hugging Face Hub into R2, from the hourly cron. Downloads are never served
 * from Hugging Face; a blob that is not yet mirrored answers 503.
 *
 * Boundaries:
 * - Only registry entries are fetched, by commit, never caller input.
 * - The operator's read token (HF_TOKEN) goes only to huggingface.co. HF
 *   redirects large files to signed storage URLs on *.hf.co, which are fetched
 *   without it; any other redirect target is refused.
 * - R2 verifies the registry's SHA-256 on write (put's `sha256` option), so
 *   bytes that differ from the approved release never land under its key.
 * - Objects hold public model artifacts only, never request content.
 */
import type { Bindings } from './types';
import { approvedBlobs, blobKey, type HfFile, type HfRelease } from './hfRegistry';

const HUB = 'https://huggingface.co';
const MAX_HOPS = 4;
// The hourly cron's wall limit is 15 minutes; start no new blob after this.
const BUDGET_MS = 10 * 60_000;

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Hosts HF's resolver may send us to. Exported for tests. */
export function allowedUpstream(url: URL): 'hub' | 'storage' | null {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.hostname === 'huggingface.co') return 'hub';
  if (url.hostname.endsWith('.hf.co')) return 'storage';
  return null;
}

/** The pinned file's bytes from upstream, following only validated redirects. */
async function fetchUpstream(env: Bindings, release: HfRelease, file: HfFile): Promise<Response | string> {
  let url = new URL(`${HUB}/${release.repo}/resolve/${release.revision}/${encodePath(file.path)}`);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const kind = allowedUpstream(url);
    if (!kind) return `refused redirect to ${url.hostname}`;
    const headers: Record<string, string> = { 'User-Agent': 'bayleaf-api-hf-mirror (+https://api.bayleaf.dev/llms.txt)' };
    if (kind === 'hub' && env.HF_TOKEN) headers.Authorization = `Bearer ${env.HF_TOKEN}`;
    const response = await fetch(url.href, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('Location');
      if (!location) return `HTTP ${response.status} without Location`;
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return `HTTP ${response.status}`;
    }
    return response;
  }
  return 'too many redirects';
}

export interface MirrorReport { approved: number; present: number; mirrored: number; failed: number; deferred: number }

/** Mirror every approved blob missing from R2, oldest registry entry first. */
export async function mirrorHfReleases(env: Bindings, now: () => number = Date.now): Promise<MirrorReport> {
  const report: MirrorReport = { approved: 0, present: 0, mirrored: 0, failed: 0, deferred: 0 };
  const bucket = env.HF_ARTIFACTS;
  if (env.HF_GATEWAY_ENABLED !== 'true' || !bucket) return report;
  const started = now();
  for (const { release, file } of approvedBlobs()) {
    report.approved++;
    const key = blobKey(file.sha256);
    const existing = await bucket.head(key);
    if (existing && existing.size === file.bytes) { report.present++; continue; }
    if (now() - started > BUDGET_MS) { report.deferred++; continue; }
    const upstream = await fetchUpstream(env, release, file);
    if (typeof upstream === 'string') {
      console.warn('HF mirror failed', { key, reason: upstream }); // Public artifact metadata only.
      report.failed++;
      continue;
    }
    const declared = upstream.headers.get('Content-Length');
    if (declared !== null && Number(declared) !== file.bytes) {
      await upstream.body?.cancel();
      console.warn('HF mirror failed', { key, reason: `size ${declared} != ${file.bytes}` });
      report.failed++;
      continue;
    }
    try {
      // FixedLengthStream gives R2 the length up front and errors on any
      // shortfall or excess; the sha256 option makes R2 reject other bytes.
      const sized = new FixedLengthStream(file.bytes);
      const piping = upstream.body!.pipeTo(sized.writable);
      piping.catch(() => {}); // Surfaced through Promise.all below.
      await Promise.all([bucket.put(key, sized.readable, {
        sha256: file.sha256,
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { repo: release.repo, revision: release.revision, path: file.path },
      }), piping]);
      report.mirrored++;
    } catch (e) {
      console.warn('HF mirror failed', { key, reason: String((e as Error)?.message ?? e) });
      report.failed++;
    }
  }
  return report;
}
