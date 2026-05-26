/**
 * Base Layout and Shared Components (hono/jsx + hono/css)
 */

import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';
import { css, Style } from 'hono/css';
import { html } from 'hono/html';

// ── Global Styles ────────────────────────────────────────────────

const globalStyles = css`
  :-hono-global {
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
    h1, h2, h3 { color: #003c6c; }
    a { color: #006aad; }
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
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #767676;
      font-size: 0.85rem;
      color: #555;
    }
    a:focus-visible,
    button:focus-visible,
    summary:focus-visible,
    input:focus-visible {
      outline: 3px solid #fff;
      outline-offset: 0;
      box-shadow: 0 0 0 5px #2a5298;
      border-radius: 4px;
    }

    /* ── Global classes referenced by client-side JS innerHTML ── */
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
    .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
    }
    .copy-hint {
      font-size: 0.85em;
      color: #555;
      margin-left: 0.75em;
    }
    .success {
      background: #d4edda;
      border-color: #28a745;
      padding: 1rem;
      border-radius: 4px;
    }
  }
`;

// ── Shared Component Styles ──────────────────────────────────────

export const btnStyle = css`
  display: inline-block;
  padding: 0.75rem 1.5rem;
  background: #003c6c;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  &:hover { background: #005a9e; }
`;

export const btnDangerStyle = css`
  display: inline-block;
  padding: 0.75rem 1.5rem;
  background: #c41e3a;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  &:hover { background: #a01830; }
`;

export const cardStyle = css`
  background: white;
  border: 1px solid #767676;
  border-radius: 8px;
  padding: 1.5rem;
  margin: 1rem 0;
`;

export const copyBoxStyle = css`
  display: inline-block;
  background: #f4f4f4;
  border: 1px solid #767676;
  border-radius: 4px;
  padding: 0.5rem 1rem;
  font-family: monospace;
  font-size: 1rem;
  color: #333;
  cursor: pointer;
  position: relative;
  margin-bottom: 0.25rem;
  user-select: all;
  transition: background 0.2s;
  text-align: left;
  line-height: inherit;
  &:hover { background: #e0eaff; }
`;

export const statsStyle = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1rem;
`;

export const statStyle = css`
  text-align: center;
`;

export const statValueStyle = css`
  font-size: 1.5rem;
  font-weight: bold;
  color: #003c6c;
`;

export const statLabelStyle = css`
  font-size: 0.85rem;
  color: #555;
`;

export const errorStyle = css`
  background: #f8d7da;
  border-color: #dc3545;
  padding: 1rem;
  border-radius: 4px;
`;

// ── BaseLayout ───────────────────────────────────────────────────

export const BaseLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - BayLeaf API</title>
      <Style />
    </head>
    <body class={globalStyles}>
      <header style="display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap;">
        <h1 style="margin: 0;">BayLeaf API</h1>
        <nav aria-label="Documentation" style="display: flex; gap: 1rem;">
          <a href="/docs" style="font-size: 0.95rem;">API Reference</a>
          <a href="/llms.txt" style="font-size: 0.95rem;">llms.txt</a>
        </nav>
      </header>
      <main>
        {children}
      </main>
      <footer>
        <p>A service of the <a href="https://bayleaf.dev">BayLeaf AI Playground</a> for UC Santa Cruz. <a href="https://github.com/bayleaf-ucsc/bayleaf/tree/main/api">Source on GitHub</a>.</p>
      </footer>
    </body>
  </html>
);

// ── Shared Components ────────────────────────────────────────────

export const RecommendedModelHint: FC<{ model: string }> = ({ model }) => {
  // The model id is namespaced (e.g. "openrouter:z-ai/glm-5.1" or "vertex:gemini-3.1-pro").
  // For OpenRouter models we deep-link to the openrouter.ai model page; for Vertex
  // models we don't have a public catalog URL, so render the slug as plain code.
  const isOpenRouter = model.startsWith('openrouter:') || !model.includes(':');
  const orSlug = model.startsWith('openrouter:') ? model.slice('openrouter:'.length) : model;
  return (
    <p>
      If you aren't sure which model to use, we recommend{' '}
      {isOpenRouter ? (
        <code><a href={`https://openrouter.ai/${orSlug}`} target="_blank">{model}</a></code>
      ) : (
        <code>{model}</code>
      )}{' '}
      as a reasonable default. Browse all models at{' '}
      <a href="/v1/models" target="_blank">/v1/models</a> (BayLeaf catalog) or{' '}
      <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a>.
      {' '}Only zero-data-retention (ZDR) providers are available through BayLeaf API.
    </p>
  );
};

export const CodingAgentCard: FC<{ recommendedModel: string }> = ({ recommendedModel: _ }) => (
  <div class={cardStyle} style="background: #f5f0ff; border-color: #7c3aed;">
    <h2>Use the BayLeaf API in a coding agent</h2>
    <p>
      AI coding agents run in your terminal and can read, edit, and execute code on your behalf.
      (If you aren't ready for work in the command line, you can access coding agent features
      in <a href="https://chat.bayleaf.dev/">BayLeaf Chat</a> by enabling the <em>Code Sandbox</em> feature
      in a new chat. It is like a more powerful version of
      ChatGPT's <a href="https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt" target="_blank">code execution environment</a>.)
      BayLeaf works with several open-source options, a free alternative to commercial tools
      like <a href="https://claude.ai/code" target="_blank">Claude Code</a> or{' '}
      <a href="https://github.com/openai/codex" target="_blank">Codex CLI</a>.
    </p>
    <ul style="margin: 0.75rem 0; padding-left: 1.25rem; line-height: 1.8;">
      <li>
        <a href="https://opencode.ai/" target="_blank"><strong>OpenCode</strong></a>:{' '}
        good default; free models available via OpenCode Zen
      </li>
      <li>
        <a href="https://github.com/block/goose" target="_blank"><strong>Goose</strong></a>:{' '}
        includes free inference credit on first launch; optional desktop app
      </li>
      <li>
        <a href="https://shittycodingagent.ai/" target="_blank"><strong>pi</strong></a>:{' '}
        minimal core, strong extension model; bring your own API key
      </li>
    </ul>
    <p>
      Once you have a working agent, you can hand it the setup instructions and let it configure
      itself, or follow them yourself:
    </p>
    <p style="margin: 0.5rem 0 0 0;">
      <a href="/llms.txt" target="_blank" style="font-weight: 500;">
        https://api.bayleaf.dev/llms.txt
      </a>
    </p>
  </div>
);

/**
 * One-command OpenCode quickstart card. Uses OpenCode's `.well-known/opencode`
 * provider-onboarding mechanism (see api/src/routes/wellknown.ts) so the user
 * never edits opencode.json or pastes their key into a config file. The
 * dashboard's value-add over /llms.txt is the prominent Copy button on the
 * single command — the key is read interactively by OpenCode after the
 * command runs, so this card never needs to render the key value at all.
 */
export const OpenCodeQuickstartCard: FC = () => (
  <div class={cardStyle} style="background: #eef7ee; border-color: #2d7d46;">
    <h2>Connect <a href="https://opencode.ai/" target="_blank">OpenCode</a> in one command</h2>
    <p>
      OpenCode is a terminal coding agent. After you have it{' '}
      <a href="https://opencode.ai/docs/" target="_blank">installed</a>, run this command to register
      BayLeaf as a provider, no config files to edit:
    </p>
    <button type="button" class={copyBoxStyle} onclick="copyToClipboard(this)" style="margin-top: 0.5rem;">
      <code>opencode auth login https://api.bayleaf.dev</code>
      <span class="copy-hint">Click to copy</span>
    </button>
    <p style="margin-top: 0.75rem;">
      OpenCode will prompt you for your BayLeaf API key on the terminal (the key won't echo to screen).
      Paste it from the card above. After that, run <code>opencode</code>, pick a BayLeaf model with{' '}
      <code>/models</code>, and you're done. Re-running <code>opencode auth login …</code> any time
      rotates the stored key.
    </p>
    <details style="margin-top: 1rem;">
      <summary style="cursor: pointer; color: #006aad; font-weight: 500;">How it works</summary>
      <div style="margin-top: 0.5rem; font-size: 0.95em;">
        <p>
          OpenCode fetches{' '}
          <a href="/.well-known/opencode" target="_blank"><code>/.well-known/opencode</code></a>{' '}
          to learn how to authenticate, prompts you for the key locally, and stores it under your
          BayLeaf URL in <code>~/.local/share/opencode/auth.json</code> (mode 0600). On every launch
          it then fetches{' '}
          <a href="/.well-known/opencode/config" target="_blank"><code>/.well-known/opencode/config</code></a>{' '}
          (with your key as a Bearer token) and merges the returned provider definition into your
          OpenCode configuration. That means <strong>you don't edit <code>opencode.json</code></strong>,
          and the recommended model and curated picks update automatically as we change them on the server.
        </p>
        <p>
          <strong>Windows users:</strong> the auth command runs a POSIX shell script. Use{' '}
          <a href="https://learn.microsoft.com/en-us/windows/wsl/install" target="_blank">WSL</a>{' '}
          (or fall back to{' '}
          <a href="/llms.txt" target="_blank">manual <code>opencode.json</code> setup</a>).
        </p>
      </div>
    </details>
  </div>
);

// ── ErrorPage ────────────────────────────────────────────────────

export const ErrorPage: FC<{ title: string; message: string }> = ({ title, message }) => (
  <BaseLayout title={title}>
    <div class={errorStyle}>
      <h2>{title}</h2>
      <p>{message}</p>
      <p><a href="/">Return to home</a></p>
    </div>
  </BaseLayout>
);

/** Non-JSX wrapper for use in plain .ts files (index.ts, etc.) */
export function renderErrorPage(title: string, message: string) {
  return <ErrorPage title={title} message={message} />;
}

// ── renderPage ───────────────────────────────────────────────────

/**
 * Render a JSX page with a proper HTML5 doctype. Hono's `c.html()` does not
 * prepend `<!DOCTYPE html>` on its own, and a missing doctype triggers quirks
 * mode and a WCAG 4.1.1 (Parsing) validator error. Every browser-facing route
 * should route its response through this helper.
 */
// biome-ignore lint/suspicious/noExplicitAny: hono/jsx element / StatusCode passthrough
export function renderPage(c: Context, jsx: any, status?: number) {
  return c.html(html`<!DOCTYPE html>${jsx}`, status as any);
}
