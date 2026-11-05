// Local inbox tests do not install or wake compute. Supply explicit test-only
// fixtures for unrelated generated adapter assets in an isolated worktree where
// the submodule build products are absent. Never imported by a deploy build.
export const inboxTestAssets = {
  name: 'inbox-test-only-adapter-assets',
  setup(b) {
    b.onResolve({ filter: /\.sandbox-plugin-ref\.json$/ }, args => ({
      path: args.path, namespace: 'inbox-test-assets'
    }));
    b.onLoad({ filter: /.*/, namespace: 'inbox-test-assets' }, () => ({
      contents: JSON.stringify({ package: 'test-only:no-sandbox-plugin' }),
      loader: 'json'
    }));
  }
};
