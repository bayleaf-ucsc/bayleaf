// Full local suite: fresh state, migrations, then three wrangler dev runs on :8791
// with different vars, because limits and the kill switch are read from env.
//   npm test
// Each phase restarts wrangler on the same persisted state, so the second phase's
// `spike.mjs verify` is also the restart-survival check.
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const PERSIST = "/tmp/rooms-prod-state";
const BASE_VARS = { ROOMS_ENABLED: "true", COMPACT_ENTRIES: "200" };
const PHASES = [
  { name: "main", vars: {}, run: [["test/spike.mjs"], ["test/prod.mjs", "main"]] },
  { name: "low", vars: { MAX_SOCKETS_PER_ROOM: "3", MAX_ROOM_BYTES: "4096", ROOMS_TELEMETRY_ENABLED: "true",
      ROOMS_TELEMETRY_WRITE_SECRET: "local-test-writer-not-a-secret", ROOMS_TELEMETRY_URL: "http://localhost:8799/v1/metrics" },
    run: [["test/spike.mjs", "verify"], ["test/prod.mjs", "low"]] },
  { name: "off", vars: { ROOMS_ENABLED: "false" }, run: [["test/prod.mjs", "off"]] },
];

rmSync(PERSIST, { recursive: true, force: true });
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "bayleaf-rooms", "--local", "--persist-to", PERSIST], { stdio: "ignore" });

let failed = 0;
for (const p of PHASES) {
  const vars = Object.entries({ ...BASE_VARS, ...p.vars }).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const dev = spawn("npx", ["wrangler", "dev", "--local", "--port", "8791", "--local-upstream", "localhost:8791",
    "--persist-to", PERSIST, "--test-scheduled", ...vars], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wrangler did not start")), 60_000);
    dev.stdout.on("data", (d) => { if (/Ready on/.test(d)) { clearTimeout(t); resolve(); } });
  });
  console.log(`\n=== phase ${p.name} ===`);
  for (const args of p.run) {
    try { execFileSync("node", args, { stdio: "inherit" }); } catch { failed++; }
  }
  process.kill(-dev.pid);
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(failed ? `\n${failed} test file(s) failed` : "\nall phases passed");
process.exit(failed ? 1 : 0);
