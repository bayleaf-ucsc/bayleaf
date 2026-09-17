/** Server-set application cookies transported under host-only, generation-bound
 * names. The browser never receives a parent-domain cookie from an application.
 * Original cookie names are restored upstream. document.cookie applications
 * that need to mutate their original names are outside this transport contract.
 */
const PREFIX = '__Host-bl-app-';
const encoder = new TextEncoder();

function encode(value: string): string {
  return Array.from(encoder.encode(value), b => b.toString(16).padStart(2, '0')).join('');
}
function decode(value: string): string {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) return '';
  return new TextDecoder().decode(Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16)));
}
function pathMatches(path: string, requestPath: string): boolean {
  return requestPath === path || (requestPath.startsWith(path) && (path.endsWith('/') || requestPath[path.length] === '/'));
}

export function upstreamCookies(raw: string, generation: string, pathname: string): string {
  const prefix = `${PREFIX}${generation}-`;
  const cookies: { name: string; value: string; path: string }[] = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (eq < 0 || !key.startsWith(prefix) || key.length > 2048) continue;
    try {
      const [name, path] = JSON.parse(decode(key.slice(prefix.length)));
      if (typeof name !== 'string' || typeof path !== 'string' ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.startsWith('__Host-bl-') ||
          !path.startsWith('/') || /[\x00-\x20;\x7f]/.test(value) || !pathMatches(path, pathname)) continue;
      cookies.push({ name, path, value });
    } catch { /* Forged or malformed application cookie. */ }
  }
  return cookies.sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
}

export function wrapApplicationCookies(
  upstream: Headers, outgoing: Headers, generation: string, requestPath: string,
  expiresAt: number, upstreamHostname: string,
): void {
  for (const raw of upstream.getSetCookie()) {
    if (raw.includes(upstreamHostname) || raw.length > 4096) continue;
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (eq < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.startsWith('__Host-bl-') ||
        /[\x00-\x20;\x7f]/.test(value)) continue;
    let path = requestPath.slice(0, requestPath.lastIndexOf('/')) || '/';
    let maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
    let expires: number | undefined;
    let upstreamMaxAge: number | undefined;
    for (const attr of attrs) {
      const split = attr.indexOf('=');
      const key = (split < 0 ? attr : attr.slice(0, split)).trim().toLowerCase();
      const v = split < 0 ? '' : attr.slice(split + 1).trim();
      if (key === 'path' && v.startsWith('/')) path = v;
      if (key === 'max-age' && /^-?\d+$/.test(v)) upstreamMaxAge = Number(v);
      if (key === 'expires' && Number.isFinite(Date.parse(v))) expires = Math.floor(Date.parse(v) / 1000);
    }
    if (upstreamMaxAge !== undefined) maxAge = Math.max(0, Math.min(maxAge, upstreamMaxAge));
    else if (expires !== undefined) maxAge = Math.max(0, Math.min(maxAge, expires - Math.floor(Date.now() / 1000)));
    if (path.length > 256) continue;
    const cookieName = `${PREFIX}${generation}-${encode(JSON.stringify([name, path]))}`;
    outgoing.append('Set-Cookie', `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
  }
}
