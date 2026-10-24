// Dedicated executable entry: importing CLI helpers must not start a process.
import { cli } from './main';
import { Failure } from './client';

if (process.platform !== 'linux') {
  process.stderr.write(JSON.stringify({ error: { code: 'linux_sandbox_only' } }) + '\n');
  process.exitCode = 2;
} else {
  cli().catch(e => {
    process.stderr.write(JSON.stringify({ error: { code: e instanceof Failure ? e.code : 'operation_failed',
      ...(e instanceof Failure && e.status ? { status: e.status } : {}) } }) + '\n');
    process.exitCode = e instanceof Failure && /arguments|input_|filter|output_required/.test(e.code) ? 2 : 1;
  });
}
