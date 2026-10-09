/** Private management adapter. Wake shares the owner's existing setup queue. */
import type { Bindings } from './types';

export async function wakeExistingSandbox(email: string, env: Bindings): Promise<Response> {
  const stub = env.SANDBOX_BROWSER.get(env.SANDBOX_BROWSER.idFromName(email));
  return stub.fetch('https://controller/wake-existing', {
    method: 'POST', headers: { 'X-BayLeaf-Owner': email },
  });
}
