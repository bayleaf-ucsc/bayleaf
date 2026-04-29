/**
 * Base Layout and Shared Components (hono/jsx + hono/css)
 */

import type { FC, PropsWithChildren } from 'hono/jsx';
import { css, Style } from 'hono/css';

// -- Global Styles ----------------------------------------------------

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
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #ddd;
      font-size: 0.85rem;
      color: #666;
    }
  }
`;

// -- Shared Component Styles ------------------------------------------

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

export const cardStyle = css`
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 1.5rem;
  margin: 1rem 0;
`;

export const errorStyle = css`
  background: #f8d7da;
  border-color: #dc3545;
  padding: 1rem;
  border-radius: 4px;
`;

// -- BaseLayout -------------------------------------------------------

export const BaseLayout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} - BayLeaf Courses</title>
      <Style />
    </head>
    <body class={globalStyles}>
      <header style="display: flex; align-items: baseline; gap: 1rem;">
        <h1 style="margin: 0;"><a href="/" style="text-decoration: none; color: inherit;">BayLeaf Courses</a></h1>
      </header>
      <main>
        {children}
      </main>
      <footer>
        <p>
          A service of <a href="https://bayleaf.dev">BayLeaf</a> for UC Santa Cruz.{' '}
          <a href="https://github.com/bayleaf-ucsc/bayleaf">Source on GitHub</a>.
        </p>
      </footer>
    </body>
  </html>
);

// -- ErrorPage --------------------------------------------------------

export const ErrorPage: FC<{ title: string; message: string }> = ({ title, message }) => (
  <BaseLayout title={title}>
    <div class={errorStyle}>
      <h2>{title}</h2>
      <p>{message}</p>
      <p><a href="/">Return to home</a></p>
    </div>
  </BaseLayout>
);

/** Non-JSX wrapper for use in plain .ts files */
export function renderErrorPage(title: string, message: string) {
  return <ErrorPage title={title} message={message} />;
}
