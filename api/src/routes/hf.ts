/**
 * HF artifact gateway (issue #121): read-only, keyless delivery of approved
 * Hugging Face model artifacts from api.bayleaf.dev, for clients whose egress
 * is limited to this origin.
 *
 *   GET      /hf/catalog                                      Approved releases
 *   GET      /hf/catalog/{namespace}/{repo}                   One repository's releases, with mirror status
 *   GET|HEAD /hf/{namespace}/{repo}/resolve/{revision}/{path} Approved file bytes (single byte ranges)
 *
 * Not a proxy: requests never reach Hugging Face. Bytes come from R2, where
 * the hourly mirror (hfMirror.ts) put them after R2 verified their SHA-256.
 * Unknown repositories, revisions and files are 404 (Transformers.js treats
 * 404 as "optional file absent"), other methods 405, query strings 400.
 * Credentials and cookies are ignored. Responses carry no upstream headers.
 * The resolve path mirrors the Hub's shape so Transformers.js works with
 * `env.remoteHost = 'https://api.bayleaf.dev/hf/'`; no other Hub API exists here.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { ApiErrorSchema, HfCatalogSchema } from '../schemas';
import { HF_RELEASES, blobKey, findFile, findRelease, type HfRelease } from '../hfRegistry';

export const hfRoutes = new OpenAPIHono<AppEnv>();

const NOTICE = 'Upstream artifacts mirrored by BayLeaf without modification. Repository IDs are the authors\' own; BayLeaf did not author or endorse them. Each release\'s license binds you. Verify downloads against hashes your client pins.';
const MIRROR_RETRY_SECONDS = '3600';

const fail = (c: Context<AppEnv>, status: 400 | 404 | 405 | 416 | 503, message: string, code: string, headers: Record<string, string> = {}) =>
  c.json({ error: { message, code } }, status, { 'Cache-Control': 'no-store', ...headers });

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

hfRoutes.use('*', async (c, next) => {
  if (c.env.HF_GATEWAY_ENABLED !== 'true' || !c.env.HF_ARTIFACTS) return fail(c, 503, 'The HF artifact gateway is disabled.', 'hf_gateway_disabled');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return fail(c, 405, 'The HF artifact gateway is read-only: GET and HEAD only.', 'hf_method_not_allowed', { Allow: 'GET, HEAD' });
  await next();
});

function describe(release: HfRelease, origin: string) {
  return {
    repo: release.repo, revision: release.revision, aliases: release.aliases, title: release.title,
    ...(release.base_model ? { base_model: release.base_model } : {}),
    task: release.task, library: release.library, architecture: release.architecture, formats: release.formats,
    variants: release.variants, license: release.license, distribution: release.distribution, qualification: release.qualification,
    files: release.files.map((f) => ({ ...f, url: `${origin}/hf/${release.repo}/resolve/${release.revision}/${encodePath(f.path)}` })),
    upstream_url: `https://huggingface.co/${release.repo}/tree/${release.revision}`,
  };
}

const CATALOG_FILTERS = ['task', 'library'] as const;

const catalogRoute = createRoute({
  method: 'get', path: '/catalog', operationId: 'listHfReleases', tags: ['Artifacts'], security: [],
  summary: 'List approved model artifact releases',
  description: 'Keyless. Lists the Hugging Face releases BayLeaf redistributes: each is one repository at one approved commit with an explicit file inventory, license and distribution basis. This is not Hub search. Optional exact-match filters: `task`, `library`.',
  request: { query: z.object({ task: z.string().optional(), library: z.string().optional() }) },
  responses: {
    200: { description: 'Approved releases', content: { 'application/json': { schema: HfCatalogSchema } } },
    400: { description: 'Unknown query parameter', content: { 'application/json': { schema: ApiErrorSchema } } },
    503: { description: 'Gateway disabled', content: { 'application/json': { schema: ApiErrorSchema } } },
  },
});

hfRoutes.openapi(catalogRoute, (c) => {
  const url = new URL(c.req.url);
  const unknown = [...url.searchParams.keys()].find((k) => !(CATALOG_FILTERS as readonly string[]).includes(k));
  if (unknown) return fail(c, 400, `Unknown query parameter: ${unknown}`, 'hf_query_not_allowed') as any;
  const { task, library } = c.req.valid('query');
  const releases = HF_RELEASES.filter((r) => (!task || r.task === task) && (!library || r.library === library));
  return c.json({ releases: releases.map((r) => describe(r, url.origin)), notice: NOTICE }, 200, { 'Cache-Control': 'public, max-age=300' });
});

const repoCatalogRoute = createRoute({
  method: 'get', path: '/catalog/{namespace}/{repo}', operationId: 'getHfRepoReleases', tags: ['Artifacts'], security: [],
  summary: 'Approved releases of one repository',
  description: 'Keyless. The approved releases of one upstream repository, with each file\'s `mirrored` status. 404 if BayLeaf approves no release of it.',
  request: { params: z.object({ namespace: z.string(), repo: z.string() }) },
  responses: {
    200: { description: 'Approved releases', content: { 'application/json': { schema: HfCatalogSchema } } },
    400: { description: 'Query parameters are not accepted', content: { 'application/json': { schema: ApiErrorSchema } } },
    404: { description: 'No approved release', content: { 'application/json': { schema: ApiErrorSchema } } },
    503: { description: 'Gateway disabled', content: { 'application/json': { schema: ApiErrorSchema } } },
  },
});

hfRoutes.openapi(repoCatalogRoute, async (c) => {
  const url = new URL(c.req.url);
  if (url.search) return fail(c, 400, 'Query parameters are not accepted.', 'hf_query_not_allowed') as any;
  const { namespace, repo } = c.req.valid('param');
  const releases = HF_RELEASES.filter((r) => r.repo === `${namespace}/${repo}`);
  if (!releases.length) return fail(c, 404, 'BayLeaf approves no release of this repository.', 'hf_not_approved') as any;
  const bucket = c.env.HF_ARTIFACTS!;
  const described = await Promise.all(releases.map(async (r) => {
    const d = describe(r, url.origin);
    const present = await Promise.all(r.files.map(async (f) => (await bucket.head(blobKey(f.sha256)))?.size === f.bytes));
    return { ...d, files: d.files.map((f, i) => ({ ...f, mirrored: present[i] })) };
  }));
  return c.json({ releases: described, notice: NOTICE }, 200, { 'Cache-Control': 'no-cache' });
});

/** A single byte range within `size`: the range, null if unsatisfiable or not a single range. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2]) || size === 0) return null;
  const first = m[1] ? Number(m[1]) : null, last = m[2] ? Number(m[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last! > 0 ? { start: Math.max(0, size - last!), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

// Decode each segment once; a segment that decodes to contain '/' is not a path we serve.
function segments(raw: string): string[] | null {
  try {
    const parts = raw.split('/').map(decodeURIComponent);
    return parts.some((p) => !p || p.includes('/')) ? null : parts;
  } catch { return null; }
}

hfRoutes.openAPIRegistry.registerPath({
  method: 'get', path: '/{namespace}/{repo}/resolve/{revision}/{path}', operationId: 'downloadHfArtifact', tags: ['Artifacts'], security: [],
  summary: 'Download an approved artifact',
  description: 'Keyless; HEAD is also supported. Hub-shaped so Transformers.js works with `env.remoteHost = \'https://api.bayleaf.dev/hf/\'`. `revision` is the approved commit or one of its aliases; `X-Repo-Commit` names the commit served. `path` may contain slashes. Supports one byte range (`bytes=a-b`, `bytes=a-`, `bytes=-n`); multiple ranges answer 416. `ETag` and `X-Linked-Etag` are the quoted SHA-256; `If-None-Match` and `If-Range` use it. Commit URLs are immutable; aliases revalidate. Unapproved repositories, revisions and files answer 404. Bytes never come from Hugging Face at request time: a file not yet mirrored answers 503 with `Retry-After`. Authorization headers and cookies are ignored.',
  request: { params: z.object({ namespace: z.string(), repo: z.string(), revision: z.string(), path: z.string() }) },
  responses: {
    200: { description: 'The whole file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    206: { description: 'One byte range', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    304: { description: 'Not modified (`If-None-Match`)' },
    400: { description: 'Query parameters are not accepted', content: { 'application/json': { schema: ApiErrorSchema } } },
    404: { description: 'Not an approved artifact', content: { 'application/json': { schema: ApiErrorSchema } } },
    416: { description: 'Unsatisfiable or multiple ranges', content: { 'application/json': { schema: ApiErrorSchema } } },
    503: { description: 'Gateway disabled, or file not yet mirrored', content: { 'application/json': { schema: ApiErrorSchema } } },
  },
});

hfRoutes.on(['GET', 'HEAD'], '/:namespace/:repo/resolve/:revision/*', async (c) => {
  const url = new URL(c.req.url);
  if (url.search) return fail(c, 400, 'Query parameters are not accepted.', 'hf_query_not_allowed');
  const m = /^\/hf\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
  const head = m && segments(`${m[1]}/${m[2]}/${m[3]}`), rest = m && segments(m[4]);
  if (!head || !rest) return fail(c, 404, 'Not an approved artifact.', 'hf_not_approved');
  const [namespace, repo, revision] = head;
  const release = findRelease(`${namespace}/${repo}`, revision);
  const file = release && findFile(release, rest.join('/'));
  if (!release || !file) return fail(c, 404, 'Not an approved artifact.', 'hf_not_approved');

  const etag = `"${file.sha256}"`;
  const name = rest[rest.length - 1];
  const headers: Record<string, string> = {
    ETag: etag, 'X-Linked-Etag': etag, 'X-Linked-Size': String(file.bytes), 'X-Repo-Commit': release.revision,
    'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': revision === release.revision ? 'public, max-age=31536000, immutable, no-transform' : 'no-cache, no-transform',
  };
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) {
    return new Response(null, { status: 304, headers });
  }
  const rangeHeader = c.req.header('Range'), ifRange = c.req.header('If-Range');
  const range = rangeHeader && (!ifRange || ifRange === etag) ? parseRange(rangeHeader, file.bytes) : undefined;
  if (range === null) return fail(c, 416, 'Only one satisfiable byte range is supported.', 'hf_range_not_satisfiable', { 'Content-Range': `bytes */${file.bytes}` });

  const bucket = c.env.HF_ARTIFACTS!, key = blobKey(file.sha256);
  const object = c.req.method === 'HEAD'
    ? await bucket.head(key)
    : await bucket.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object || object.size !== file.bytes) {
    if (object && 'body' in object) await (object as R2ObjectBody).body.cancel();
    return fail(c, 503, 'This approved file is not mirrored yet. Try again later.', 'hf_not_mirrored', { 'Retry-After': MIRROR_RETRY_SECONDS });
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.bytes}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else headers['Content-Length'] = String(file.bytes);
  const body = c.req.method === 'HEAD' ? null : (object as R2ObjectBody).body;
  return new Response(body, { status: range ? 206 : 200, headers });
});

hfRoutes.all('*', (c) => fail(c, 404, 'Not an HF artifact gateway route.', 'hf_not_found'));
