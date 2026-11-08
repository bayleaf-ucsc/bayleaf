/**
 * Campus directory lookup: GET /directory/{cruzid}
 *
 * Reflects one public campusdirectory.ucsc.edu detail page as JSON, on demand.
 * The detail page (`cd_detail?uid=`) needs no session; only the search form
 * carries the PHP session + CSRF dance, which is why there is no search here.
 *
 * Deliberate limits, each a choice about how cheap it should be to look people up:
 * - Personal access only (ordinary key or sandbox credential). Campus Pass is
 *   anonymous, and temporary inference tokens never pass the global grant gate.
 * - One person per call, no search or enumeration, per-account daily cap. Misses
 *   count against the cap so probing for valid CruzIDs is not free.
 * - Nothing cached or stored. The counter key is a hash of the caller's email and
 *   holds only a count, never whom they looked up. The photo is dropped.
 * - UCSC already withholds undergraduate emails and FERPA-restricted students;
 *   this reflects that page and never tries to recover what it withholds.
 *
 * The directory is a homebrew HTML app with no stability promise. An unknown
 * CruzID is HTTP 200 with "Could not find user"; a page with neither that marker
 * nor #profileHead is treated as a layout change (502), never as an empty profile.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { resolveAuth } from '../utils/auth';
import { parseLimit } from '../utils/campusRpd';
import { DirectoryEntrySchema } from '../schemas';

const DIRECTORY_ORIGIN = 'https://campusdirectory.ucsc.edu';
const COUNTER_TTL_SECONDS = 60 * 60 * 36;

export const directoryRoutes = new OpenAPIHono<AppEnv>();

const fail = (c: any, message: string, code: number) =>
  c.json({ error: { message, code } }, code, { 'Cache-Control': 'no-store' });

directoryRoutes.openapi(createRoute({ method: 'get', path: '/{cruzid}', tags: ['Directory'], operationId: 'lookupDirectoryEntry',
  summary: 'Look up one person in the UCSC campus directory',
  description: 'Reads the public campus directory page for one CruzID and returns its published fields. For an @ucsc.edu address, pass the part before @ (aliases will not resolve). Personal access only; uncached; counts against a per-account daily cap, including misses. Undergraduate emails and FERPA-restricted students are withheld by UCSC and stay withheld. For name search, use Google Workspace directory search.',
  security: [{ Bearer: [] }],
  request: { params: z.object({ cruzid: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).openapi({ param: { name: 'cruzid', in: 'path' }, example: 'amsmith' }) }) },
  responses: {
    200: { description: 'Published directory entry', content: { 'application/json': { schema: DirectoryEntrySchema } } },
    401: { description: 'Missing or invalid credential' },
    403: { description: 'Personal key required' },
    404: { description: 'No public directory entry for this CruzID' },
    429: { description: 'Daily lookup cap reached' },
    502: { description: 'Directory unavailable or its page layout changed' },
    503: { description: 'Directory lookup disabled' },
  } }), async c => {
  c.header('Cache-Control', 'no-store');
  if (c.env.DIRECTORY_ENABLED !== 'true') return fail(c, 'Directory lookup is disabled.', 503);
  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth as any;
  if (auth.credential !== 'key' && auth.credential !== 'sandbox') return fail(c, 'Personal key required.', 403);

  const limit = parseLimit(c.env.DIRECTORY_RPD_LIMIT);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(auth.userEmail!)));
  const account = Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  const counterKey = `directory-rpd:${account}:${new Date().toISOString().slice(0, 10)}`;
  const used = ((await c.env.CAMPUS_RPD.get(counterKey, 'json')) as { count: number } | null)?.count ?? 0;
  if (used >= limit) return fail(c, `Daily directory lookup cap (${limit}) reached; resets at midnight UTC.`, 429);
  // Same non-atomic get+put as Campus Pass: a burst can overshoot by a few, acceptable here.
  await c.env.CAMPUS_RPD.put(counterKey, JSON.stringify({ count: used + 1 }), { expirationTtl: COUNTER_TTL_SECONDS });

  const cruzid = c.req.valid('param').cruzid.toLowerCase();
  const sourceUrl = `${DIRECTORY_ORIGIN}/cd_detail?uid=${encodeURIComponent(cruzid)}`;
  let html: string;
  try {
    const res = await fetch(sourceUrl, { headers: { 'User-Agent': 'BayLeaf API directory lookup (https://bayleaf.dev)' },
      redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (!res.ok) { await res.body?.cancel(); return fail(c, 'Campus directory unavailable.', 502); }
    html = await res.text();
  } catch { return fail(c, 'Campus directory unavailable.', 502); }

  const entry = parseDetailPage(html);
  if (entry === 'not_found') return fail(c, 'No public directory entry for this CruzID.', 404);
  if (!entry) return fail(c, 'Campus directory page layout not recognized.', 502);
  return c.json({ cruzid, ...entry, source_url: sourceUrl }, 200);
});

// ── Parsing ───────────────────────────────────────────────────────
// Regex over a known, small page rather than a DOM: the markup nests <ul> inside
// <p>, which strict parsers rearrange. Exported for tests.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function text(fragment: string): string {
  return fragment
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()] ?? m)
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function parseDetailPage(html: string) {
  const head = html.match(/<div id="profileHead">([\s\S]*?)<!-- profileHead -->/)?.[1];
  if (!head) return html.includes('Could not find user') ? 'not_found' as const : null;
  const body = html.match(/<div id="profileBody">([\s\S]*?)<!-- profileBody -->/)?.[1] ?? '';

  const iconParagraph = (icon: string) => {
    const m = head.match(new RegExp(`<p>\\s*<i class="[^"]*${icon}[^"]*"[^>]*><\\/i>([\\s\\S]*?)<\\/p>`));
    return m ? text(m[1]) || null : null;
  };
  const name = text(head.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? '') || null;
  const email = head.match(/href="mailto:([^"]+)"/)?.[1]?.trim() ?? null;

  const details: Record<string, string | string[]> = {};
  for (const [, rawLabel, rawValue] of body.matchAll(/<p><label>([^<]*)<\/label>([\s\S]*?)<\/div>/g)) {
    const label = text(rawLabel);
    const withoutLinks = rawValue.replace(/<a\b[\s\S]*?<\/a>/gi, '');
    const items = [...withoutLinks.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(m => text(m[1])).filter(Boolean);
    const value = items.length ? items : text(withoutLinks);
    if (label && value.length) details[label] = value;
  }
  const links = [...body.matchAll(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, url, title]) => ({ title: text(title) || url, url }));

  return { name, title: iconParagraph('fa-address-book'), email, phone: iconParagraph('fa-phone'), details, links };
}
