import { firefox, webkit } from 'playwright';
for (const [n, b] of [['firefox', firefox], ['webkit', webkit]]) {
  try {
    const br = await b.launch(); const ctx = await br.newContext({ offline: true }); const p = await ctx.newPage();
    await p.goto('file:///tmp/pouch-qa/ro-saved/pouch.html'); await new Promise(r => setTimeout(r, 4000));
    const r = await p.evaluate(async () => { const o = {}; try { await navigator.storage.getDirectory(); o.opfs = 'yes'; } catch (e) { o.opfs = 'no ' + e.name; }
      try { await new Promise((res, rej) => { const q = indexedDB.open('x'); q.onsuccess = res; q.onerror = () => rej(q.error); }); o.idb = 'yes'; } catch (e) { o.idb = 'no ' + e.name; }
      o.tag = document.querySelector('#tree .row')?.textContent; o.badge = document.querySelector('#badge').className; o.status = document.querySelector('#status').textContent.slice(0, 60); return o; });
    console.log(n, JSON.stringify(r)); await br.close();
  } catch (e) { console.log(n, 'unavailable:', e.message.split('\n')[0]); }
}
