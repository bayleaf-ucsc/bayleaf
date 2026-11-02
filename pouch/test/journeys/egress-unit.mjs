import { egressOf } from '../../src/egress.ts';
const out = "bayleaf: denied by the user (nothing was sent)\n1. X\n[left the pouch: BayLeaf operator (plaintext to BayLeaf; not logged by policy); Tavily (search provider)]\n[this call sent data outside the pouch: web search]";
const e = egressOf(out);
console.log(JSON.stringify(e));
const err = egressOf(out + "\n[exit code 1]");
const ok = e.audiences.length === 2 && e.commands[0] === 'web search' && !e.text.includes('this call sent') && err && err.text.endsWith('[exit code 1]') && egressOf('plain') === null;
console.log(ok ? 'PASS egress-unit' : 'FAIL egress-unit'); process.exit(ok ? 0 : 1);
