/**
 * Base Layout and Shared Components (hono/jsx + hono/css)
 */

import type { FC, PropsWithChildren } from 'hono/jsx';
import { css, Style } from 'hono/css';

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
      border-top: 1px solid #ddd;
      font-size: 0.85rem;
      color: #666;
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
      color: #888;
      margin-left: 0.75em;
      opacity: 0.7;
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
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 1.5rem;
  margin: 1rem 0;
`;

export const copyBoxStyle = css`
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
  color: #666;
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
      <header style="display: flex; align-items: baseline; gap: 1rem;">
        <h1 style="margin: 0;">BayLeaf API</h1>
        <a href="/docs" style="font-size: 0.95rem;">API Reference</a>
      </header>
      <main>
        {children}
      </main>
      <footer>
        <p>A service of the <a href="https://bayleaf.dev">BayLeaf AI Playground</a> for UC Santa Cruz. <a href="https://github.com/rndmcnlly/bayleaf/tree/main/api">Source on GitHub</a>.</p>
      </footer>
    </body>
  </html>
);

// ── Shared Components ────────────────────────────────────────────

export const RecommendedModelHint: FC<{ model: string }> = ({ model }) => {
  const modelUrl = `https://openrouter.ai/${model}`;
  return (
    <p>
      If you aren't sure which model to use, we recommend{' '}
      <code><a href={modelUrl} target="_blank">{model}</a></code>{' '}
      as a reasonable default. Browse all models at{' '}
      <a href="https://openrouter.ai/models" target="_blank">openrouter.ai/models</a>
      {' '}&mdash; only zero data retention (ZDR) providers are available through BayLeaf API.
    </p>
  );
};

export const OpencodeOnboarding: FC<{ recommendedModel: string }> = ({ recommendedModel: _ }) => (
  <div class={cardStyle} style="background: #f5f0ff; border-color: #7c3aed;">
    <h3>Use BayLeaf with OpenCode</h3>
    <p>
      <a href="https://opencode.ai/" target="_blank">OpenCode</a> is an open-source AI coding
      agent that runs in your terminal. Connect it to BayLeaf for free LLM-powered coding assistance.
    </p>
    <ol>
      <li><a href="https://opencode.ai/docs" target="_blank">Install OpenCode</a></li>
      <li>
        Launch <code>opencode</code> and ask it:<br />
        <em>
          Help me set up BayLeaf as a provider. Load the skill from{' '}
          <a href="docs/SKILL.md" target="_blank">https://api.bayleaf.dev/docs/SKILL.md</a>
        </em>
      </li>
    </ol>
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
