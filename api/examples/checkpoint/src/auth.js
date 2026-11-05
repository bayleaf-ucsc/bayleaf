const PENDING = 'bayleaf-checkpoint-auth';
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));

export function apiOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS API origin, or HTTP localhost for development.');
  }
  return url.origin;
}
export async function json(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(`BayLeaf request failed (${response.status}).`);
  return data;
}
export async function authorize(origin, model) {
  if (!/^(openrouter|vertex|bedrock):[^\s]+$/.test(model)) throw new Error('Enter a backend-qualified model, such as openrouter:owner/model.');
  const redirect_uri = location.origin + location.pathname;
  const verifier = random(), state = random();
  const challenge = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const { client_id } = await json(origin + '/grants/clients', { client_name: 'Checkpoint writing prototype', redirect_uri });
  sessionStorage.setItem(PENDING, JSON.stringify({ origin, model, verifier, state, client_id, redirect_uri, started: Date.now() }));
  const query = new URLSearchParams({ client_id, response_type: 'code', models: JSON.stringify([model]), expires_in: '3600', state,
    code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(origin + '/grants/authorize?' + query);
}
export async function callback() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  history.replaceState(null, '', location.pathname);
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
  sessionStorage.removeItem(PENDING);
  if (!pending || params.get('state') !== pending.state || Date.now() - pending.started > 10 * 60 * 1000) throw new Error('Authorization state expired or did not match. Connect again.');
  if (params.has('error')) throw new Error('Authorization cancelled. Your local work is unchanged.');
  const origin = apiOrigin(pending.origin);
  const result = await json(origin + '/grants/token', { grant_type: 'authorization_code', code: params.get('code'), client_id: pending.client_id,
    redirect_uri: pending.redirect_uri, code_verifier: pending.verifier });
  if (!result.access_token || !result.models?.includes(pending.model)) throw new Error('BayLeaf returned an unexpected authorization.');
  return { token: result.access_token, origin, model: pending.model, expiresAt: result.expires_at * 1000 };
}

export async function infer(auth, messages, signal) {
  const response = await fetch(auth.origin + '/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ model: auth.model, messages, stream: false, max_tokens: 1400 }),
  });
  if (response.status === 401) throw new Error('Authorization expired or was revoked. Connect BayLeaf again.');
  if (!response.ok) throw new Error(`Review request failed (${response.status}). Your checkpoint is saved; you can retry.`);
  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned no text. You can retry this checkpoint.');
  return content;
}
