/**
 * BayLeaf Courses — Teaser Page
 *
 * Minimal placeholder while the service is being redesigned.
 * See https://github.com/bayleaf-ucsc/bayleaf/issues/4
 */

import { Hono } from 'hono';
import { css, Style } from 'hono/css';

const app = new Hono();

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
    h1, h2 { color: #003c6c; }
    a { color: #006aad; }
    footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #ddd;
      font-size: 0.85rem;
      color: #666;
    }
  }
`;

const cardStyle = css`
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 1.5rem;
  margin: 1rem 0;
`;

app.get('*', (c) =>
  c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>BayLeaf Courses</title>
        <Style />
      </head>
      <body class={globalStyles}>
        <h1>BayLeaf Courses</h1>
        <p>
          Self-service course AI models for the UC Santa Cruz community.
          Instructors connect their Canvas courses to{' '}
          <a href="https://chat.bayleaf.dev">BayLeaf Chat</a>, and students
          install custom course models with one click.
        </p>
        <div class={cardStyle}>
          <h2 style="margin-top: 0;">Under Development</h2>
          <p>
            This service is being redesigned based on user stories gathered
            from an initial prototype. Follow progress on GitHub:
          </p>
          <p>
            <a href="https://github.com/bayleaf-ucsc/bayleaf/issues/4">
              github.com/bayleaf-ucsc/bayleaf — Issue #4
            </a>
          </p>
        </div>
        <footer>
          <p>
            A service of <a href="https://bayleaf.dev">BayLeaf</a> for UC Santa Cruz.{' '}
            <a href="https://github.com/bayleaf-ucsc/bayleaf">Source on GitHub</a>.
          </p>
        </footer>
      </body>
    </html>,
  ),
);

export default app;
