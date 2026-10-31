// Batch D, node-side: the allowance is outside state (Adam, 2026-10-31). The
// ledger counts what this browser sent; between two checks of the allowance
// it notes how far the allowance moved beyond that, up or down, and never
// reconciles the two into a negative "Other".
// Run: node test/batchD-node.mjs
import assert from 'node:assert/strict';
import { createLedger, outsideText, counted } from '../src/usage.js';

let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };
const mem = () => { let v = null; return { get: async () => v, set: async (x) => { v = structuredClone(x); } }; };

{
  const l = createLedger(mem(), () => 'day1');
  await l.observe(500);
  await l.add('a'); await l.add('a'); await l.add('b');
  await l.observe(497);
  assert.equal(outsideText(await l.snapshot()), null, 'exactly what this browser sent: nothing outside');
  // The same key used in another tool: 5 more gone.
  await l.add('a');
  await l.observe(491);
  assert.equal(outsideText(await l.snapshot()), 'down 5');
  ok('allowance down beyond what this browser sent reads "down 5"');
  // A top-up or a reset without a new reset time: it goes up.
  await l.observe(600);
  const s = await l.snapshot();
  assert.equal(outsideText(s), 'down 5 and up 109');
  assert.equal(counted(s), 4, 'this browser count is untouched by outside moves');
  ok('allowance going up mid-session reads "up 109"; nothing negative, nothing reconciled');
}
{
  // A request counted as it left but not yet booked by BayLeaf: carried, not reported as "up".
  const l = createLedger(mem(), () => 'day1');
  await l.observe(100);
  await l.add('a'); await l.add('a');
  await l.observe(99); // one of the two still in flight
  assert.equal(outsideText(await l.snapshot()), null, 'in-flight lag is not an outside change');
  await l.observe(98); // now booked
  assert.equal(outsideText(await l.snapshot()), null, 'lag settles to nothing');
  ok('in-flight lag is carried to the next check, never shown');
}
{
  // A new allowance day (resetsAt moved) starts a fresh ledger: no outside note for the reset.
  let day = 'day1';
  const l = createLedger(mem(), () => day);
  await l.observe(10); await l.add('a'); await l.observe(9);
  day = 'day2';
  await l.observe(500);
  const s = await l.snapshot();
  assert.equal(outsideText(s), null); assert.equal(counted(s), 0);
  ok('a daily reset with a new reset time starts clean');
}
{
  // Unknown allowance (null) is no observation at all.
  const l = createLedger(mem(), () => 'd');
  await l.observe(null); await l.add('a'); await l.observe(50); await l.observe(null); await l.observe(50);
  assert.equal(outsideText(await l.snapshot()), null);
  ok('unknown allowance is skipped, not read as zero');
}
console.log(`\n${passed} passed`);
