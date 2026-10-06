const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="BayLeaf Sandboxes: persistent workspaces for building, running, and previewing projects with an AI agent. A new home is coming soon.">
  <meta name="theme-color" content="#1e5a3a">
  <title>BayLeaf Sandboxes · A new home is coming soon</title>
  <style>
    * { box-sizing:border-box; }
    body { margin:0; background:#f6f8f4; color:#24352b; font:1rem/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:760px; margin:0 auto; padding:clamp(1.5rem,6vw,4rem) 1.5rem; }
    a { color:#1e5a3a; text-underline-offset:0.2em; }
    a:focus-visible { outline:3px solid #2a5298; outline-offset:5px; }
    nav { display:flex; flex-wrap:wrap; gap:1.5rem; font-size:0.95rem; }
    nav a:first-child { font-weight:700; margin-right:auto; }
    .eyebrow { display:inline-block; margin:3.5rem 0 0; padding:0.3rem 0.8rem;
      border:1px solid #a9b9aa; border-radius:2rem; font-size:0.85rem; color:#365a43; }
    h1 { font-size:clamp(2.4rem,8vw,4rem); line-height:1.08; letter-spacing:-0.045em; margin:1.2rem 0; font-weight:700; }
    .lede { font-size:clamp(1.1rem,3vw,1.35rem); max-width:36rem; }
    .workspace { margin:2rem 0; padding:1.5rem; background:#fff; border:1px solid #c6d2c5; border-radius:14px; }
    .steps { display:flex; gap:0.5rem; align-items:center; color:#365a43; font-size:0.85rem; }
    .steps span { flex:1; border-top:3px solid #b7cebe; padding-top:0.5rem; }
    h2 { font-size:1.2rem; margin:1.25rem 0 0.5rem; }
    .workspace p { margin:0.5rem 0 0; }
    .button { display:inline-block; background:#1e5a3a; color:#fff; padding:0.8rem 1.2rem;
      border-radius:6px; text-decoration:none; font-weight:600; margin:0.5rem 0; }
    .button:hover { background:#16432b; }
    .note,footer { font-size:0.9rem; color:#48594e; }
    footer { border-top:1px solid #c6d2c5; margin-top:2.5rem; padding-top:1rem; }
  </style>
</head>
<body>
  <main>
    <nav aria-label="BayLeaf services"><a href="https://bayleaf.dev">BayLeaf</a><a href="https://chat.bayleaf.dev">Chat</a><a href="https://api.bayleaf.dev">API</a></nav>
    <p class="eyebrow">A new home is coming soon</p>
    <h1>BayLeaf Sandboxes</h1>
    <p class="lede">A place to build, run, and try things out with an AI agent. Your files stay in your sandbox, ready for the next session.</p>
    <div class="workspace">
      <div class="steps" aria-hidden="true"><span>Build</span><span>Run</span><span>Preview</span><span>Return</span></div>
      <h2>One workspace, connected to BayLeaf</h2>
      <p>Work in your browser, use Chat’s sandbox tools, or connect through the API. They reach the same sandbox files and processes. Chat and your sandbox agent keep separate conversation histories.</p>
      <p>This will be the home for friendly setup, workspace status, and ideas for what to make next.</p>
    </div>
    <h2>You can already try it</h2>
    <p>BayLeaf Sandboxes is available to the UC Santa Cruz community through the API dashboard while this new home takes shape.</p>
    <a class="button" href="https://api.bayleaf.dev/dashboard#sandbox">Open your sandbox</a>
    <p class="note">Continues to BayLeaf API for UCSC sign-in and setup.</p>
    <p class="note">Files and agent histories persist; running tasks stop when your sandbox sleeps. Deleting your sandbox deletes its files and histories. Inference uses zero-data-retention providers, but workspace storage is retained and is not inaccessible to operators. <a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Read the privacy notice</a>.</p>
    <footer>Part of <a href="https://bayleaf.dev">BayLeaf</a>, a situated counterplatform for Generative AI at UC Santa Cruz. <a href="https://github.com/bayleaf-ucsc/bayleaf/issues/84">Follow the design</a>.</footer>
  </main>
</body>
</html>`;

export default {
  fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status:405, headers:{ Allow:'GET, HEAD' } });
    }
    if (new URL(request.url).pathname !== '/') return new Response('Not found', { status:404 });
    return new Response(request.method === 'HEAD' ? null : page, { headers: {
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'public, max-age=300',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy':'strict-origin-when-cross-origin',
      'X-Content-Type-Options':'nosniff',
    } });
  }
};
