/**
 * Base Layout and Shared Templates
 */

export function baseLayout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - BayLeaf API</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.6;
      max-width: 700px;
      margin: 0 auto;
      padding: 2rem 1rem;
      background: #fafafa;
      color: #333;
    }
    h1, h2, h3 { color: #003c6c; } /* UCSC blue */
    a { color: #006aad; }
    .btn {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      background: #003c6c;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-size: 1rem;
    }
    .btn:hover { background: #005a9e; }
    .btn-danger { background: #c41e3a; }
    .btn-danger:hover { background: #a01830; }
    .card {
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 1.5rem;
      margin: 1rem 0;
    }
    .key-display {
      font-family: monospace;
      background: #1a1a1a;
      color: #0f0;
      padding: 1rem;
      border-radius: 4px;
      word-break: break-all;
      position: relative;
    }
    .key-display input {
      width: 100%;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      padding: 0;
    }
    .copy-box {
      display: inline-block;
      background: #f4f4f4;
      border: 1px solid #ccc;
      border-radius: 4px;
      padding: 0.5rem 1rem;
      font-family: monospace;
      cursor: pointer;
      position: relative;
      margin-bottom: 0.25rem;
      user-select: all;
      transition: background 0.2s;
    }
    .copy-box:hover {
      background: #e0eaff;
    }
    .copy-hint {
      font-size: 0.85em;
      color: #888;
      margin-left: 0.75em;
      opacity: 0.7;
    }
    .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
    }
    .key-display .copy-btn:nth-of-type(2) {
      right: 4rem;
    }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; }
    .stat { text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: bold; color: #003c6c; }
    .stat-label { font-size: 0.85rem; color: #666; }
    code {
      background: #f0f0f0;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
      font-size: 0.9em;
    }
    pre {
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 1rem;
      border-radius: 4px;
      overflow-x: auto;
    }
    pre code { background: transparent; padding: 0; }
    .warning { background: #fff3cd; border-color: #ffc107; padding: 1rem; border-radius: 4px; }
    .success { background: #d4edda; border-color: #28a745; padding: 1rem; border-radius: 4px; }
    .error { background: #f8d7da; border-color: #dc3545; padding: 1rem; border-radius: 4px; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 0.85rem; color: #666; }
  </style>
</head>
<body>
  <header style="display: flex; align-items: baseline; gap: 1rem;">
    <h1 style="margin: 0;">BayLeaf API</h1>
    <a href="/docs" style="font-size: 0.95rem;">API Reference</a>
  </header>
  <main>
    ${content}
  </main>
  <footer>
    <p>A service of <a href="https://bayleaf.dev">BayLeaf Chat</a> for UC Santa Cruz. <a href="https://github.com/rndmcnlly/bayleaf/tree/main/api">Source on GitHub</a>.</p>
  </footer>
</body>
</html>`;
}

export function recommendedModelHint(model: string): string {
  const modelUrl = `https://openrouter.ai/${model}`;
  return `<p>If you aren't sure which model to use, we recommend <code><a href="${modelUrl}" target="_blank">${model}</a></code> as a reasonable default. Browse all models at <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a> — only zero data retention (ZDR) providers are available through BayLeaf API.</p>`;
}

export function opencodeOnboardingSection(recommendedModel: string): string {
  return `
    <div class="card" style="background: #f5f0ff; border-color: #7c3aed;">
      <h3>Use BayLeaf with OpenCode</h3>
      <p><a href="https://opencode.ai/" target="_blank">OpenCode</a> is an open-source AI coding agent that runs in your terminal. Connect it to BayLeaf for free LLM-powered coding assistance.</p>
      <ol>
        <li><a href="https://opencode.ai/docs" target="_blank">Install OpenCode</a></li>
        <li>Launch <code>opencode</code> and ask it:<br>
          <em>Help me set up BayLeaf as a provider. Load the skill from <a href="docs/SKILL.md" target="_blank">https://api.bayleaf.dev/docs/SKILL.md</a></em>
        </li>
      </ol>
    </div>
  `;
}

export function errorPage(title: string, message: string): string {
  return baseLayout(title, `
    <div class="error">
      <h2>${title}</h2>
      <p>${message}</p>
      <p><a href="/">Return to home</a></p>
    </div>
  `);
}
