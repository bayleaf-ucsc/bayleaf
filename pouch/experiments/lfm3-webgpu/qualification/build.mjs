import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
await build({entryPoints:['tools-entry.js'],outfile:'tools.bundle.js',bundle:true,format:'esm',platform:'browser',minify:true,alias:{'node:zlib':'./zlib.js',zlib:'./zlib.js'}});
