/** Synthetic Sandboxes dashboard and 26-second setup timeline, without providers.
 * Run from api/: node scripts/preview-sandbox-status.mjs
 */
process.env.SANDBOX_PREVIEW_PORT ||= '8766';
if (!process.argv.includes('--serve')) process.argv.push('--serve');
await import('./test-sandbox-policy.mjs');
