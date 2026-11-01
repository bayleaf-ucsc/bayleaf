const { Bash } = await import(process.argv[2]);
const b = new Bash({});
for (const c of ['cat','ls','find','tree','grep','rg','sed','awk','head','tail','sort','uniq','wc','cut','tr','diff','jq','base64','sha256sum','seq','date','xargs','tee','mkdir','mv','cp','rm','touch','yq','xan','tar','gzip']) {
  const r = await b.exec(`command -v ${c} >/dev/null && echo yes || echo no`);
  const r2 = await b.exec(`echo a | ${c} --help 2>&1 | head -1`);
  process.stdout.write(`${c}:${/not available in browser/.test(r2.stdout+r2.stderr)?'EXCLUDED':'ok'} `);
}
