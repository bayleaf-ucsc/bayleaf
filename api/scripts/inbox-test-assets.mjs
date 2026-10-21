// Local inbox tests do not install or wake compute. Supply explicit test-only
// fixtures for unrelated generated adapter assets in an isolated worktree where
// the submodule build products are absent. Never imported by a deploy build.
export const inboxTestAssets = {
  name: 'inbox-test-only-adapter-assets',
  setup(b) {
    b.onResolve({ filter: /(?:\.sandbox-plugin-ref|\.nanobot-assets)\.json$/ }, args => ({
      path: args.path, namespace: 'inbox-test-assets'
    }));
    b.onLoad({ filter: /.*/, namespace: 'inbox-test-assets' }, args => ({
      contents: JSON.stringify(args.path.includes('.sandbox-plugin-ref')
        ? { package: 'test-only:no-sandbox-plugin' }
        : { _source: { mode: 'fixture' }, 'nanobot-mcp.mjs': '// Test only: not an adapter.' }),
      loader: 'json'
    }));
  }
};
