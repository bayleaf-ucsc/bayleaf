// Browser stub for node:zlib (just-bash gzip/gunzip/zcat and tar -z). Throws at call time only.
const no = () => { throw new Error("gzip unavailable in browser build"); };
export const gunzipSync = no, gzipSync = no;
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
export default { gunzipSync, gzipSync, constants };
