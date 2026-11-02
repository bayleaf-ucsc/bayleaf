import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';

process.chdir(import.meta.dirname);
const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}` };
// Apple's ar can produce empty archives for Wasm objects. Use LLVM's archiver.
if (!env.AR_wasm32_unknown_unknown) {
  env.AR_wasm32_unknown_unknown = existsSync('/opt/homebrew/opt/llvm/bin/llvm-ar')
    ? '/opt/homebrew/opt/llvm/bin/llvm-ar' : 'llvm-ar';
}
execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'], { env, stdio: 'inherit' });
const bindgen = existsSync('tools/bin/wasm-bindgen') ? 'tools/bin/wasm-bindgen' : 'wasm-bindgen';
execFileSync(bindgen, ['--target', 'web', '--out-dir', 'pkg', 'target/wasm32-unknown-unknown/release/pouch_sendme_experiment.wasm'], { stdio: 'inherit' });
await build({ stdin: { contents: "export { default } from 'qrcode';", resolveDir: process.cwd() }, bundle: true, format: 'esm', outfile: 'qr.js', minify: true });
