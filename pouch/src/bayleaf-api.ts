// The BayLeaf API's account plane, in plaintext: device claim, a key's
// allowance, Campus Pass and the Sealed model list. Only metadata goes here,
// never a prompt, a reply or a file: content leaves only through sealed.js
// (EHBP ciphertext), and the agent's `bayleaf` command through bayleaf-cli.js
// after egress.js's consent. arch.mjs fails the build if any other module
// calls the network (README "Architecture").
export const API = 'https://api.bayleaf.dev';
export const SEALED = API + '/sealed';

// Device claim (RFC 8628 shape): start, then poll until approved or expired.
export const claimInitiate = () => fetch(API + '/auth/claim/initiate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client: 'BayLeaf Pouch' }),
});
export const claimPoll = (deviceCode, signal) => fetch(API + '/auth/claim/poll?d=' + encodeURIComponent(deviceCode), { signal });

// A key's budgets (also BayLeaf's verdict on the key), and Campus Pass's quota.
export const usageOf = (key) => fetch(API + '/usage', { headers: { Authorization: 'Bearer ' + key } });
export const campusPass = () => fetch(API + '/campus-pass');

// The Sealed model list: small and unauthenticated, so it doubles as the reachability probe.
export const sealedModels = (init) => fetch(SEALED + '/models', init);
