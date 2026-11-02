// BayLeaf Sealed, the encrypting client: the only module that touches the
// Tinfoil SDK. Plaintext leaves Pouch only through sealedFetch, as EHBP
// ciphertext to an enclave whose attestation verified; arch.mjs fails the
// build if any other module imports tinfoil or reaches into its client
// (README "Architecture"). The shell holds the client as an opaque handle: it
// may wait for it (ready) and show its verification document, nothing more.
import { TinfoilAI } from 'tinfoil';
import { SEALED } from './bayleaf-api.ts';
import type { Attestation, SealedHandle } from './trust.ts';

// Must match the TinfoilAI client's baseURL: the SDK's encrypting fetch refuses
// any origin other than the one it attested for, which is a second guard.
export const BASE_URL = SEALED + '/v1/';

// One client per credential: a BayLeaf key, or 'campus' for Campus Pass.
// cacheSecret scopes Tinfoil's prompt cache to this device.
export function createSealedClient({ bearerToken, cacheSecret }: { bearerToken: string; cacheSecret: string }): SealedHandle {
  return new TinfoilAI({ bearerToken, baseURL: BASE_URL, attestationBundleURL: SEALED, userCacheSecret: cacheSecret });
}

// The encrypting fetch, resolved per request so sign-in/out takes effect at
// once. TinfoilAI keeps its SecureClient and bearer token in fields that are
// private in TypeScript only; tinfoil is exact-pinned, and we check the shape
// so an SDK change fails loudly instead of silently.
// What sealedFetch reaches behind a SealedHandle; every field is checked before use.
interface SealedInternals { getVerificationDocument(): Promise<Attestation | undefined>; secureClient?: { fetch?: unknown }; openAIOptions?: { apiKey?: unknown } }
export function sealedFetch(getClient: () => Promise<SealedHandle | null>, onRequest?: () => void): typeof fetch {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    // The one cast out of the opaque handle: every SealedHandle is a TinfoilAI
    // (createSealedClient), whose fields are private in TypeScript only.
    const client = (await getClient()) as unknown as SealedInternals | null;
    if (!client) throw new Error('Not connected to BayLeaf Sealed: sign in (or use campus access) and wait for verification.');
    const doc = await client.getVerificationDocument();
    if (!doc?.securityVerified) throw new Error('Enclave attestation is not verified; refusing to send.');
    const secure = client.secureClient, token = client.openAIOptions?.apiKey;
    if (typeof secure?.fetch !== 'function' || typeof token !== 'string') throw new Error('Unexpected Tinfoil SDK shape; refusing to send.');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(BASE_URL).origin) throw new Error(`Refusing to send to ${url.origin}`);
    // pi-ai's own OpenAI client carries a placeholder key; the real bearer is the
    // one the TinfoilAI was built with (a BayLeaf key or 'campus').
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    // Counted as it leaves (one request from the allowance), for the tray's live spend.
    if (init.signal?.aborted) throw new DOMException('Stopped before sending.', 'AbortError');
    onRequest?.();
    return (secure.fetch as typeof fetch)(input, { ...init, headers });
  };
}
