// Offline executable fixture: genuine SDK stdio transport, synthetic API only.
import { cli } from './main';
import { Client, SessionStore } from './client';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const transport = (async (url: string) => url.endsWith('/session')
  ? Response.json({ session: 'synthetic-session', expires_at: Math.floor(Date.now()/1000)+3600 })
  : url.includes('/screenshot') ? new Response(png, { headers: { 'Content-Type': 'image/png' } })
  : Response.json({ success: true })) as typeof fetch;
await cli(['mcp', '--groups', process.env.BAYLEAF_TEST_GROUPS ?? 'computer'], { client: new Client('dtn_secret_fixture', new SessionStore(process.argv[2]), transport) });
