import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReview } from '../src/review-view.js';

test('review Markdown renders structure without making an editor', () => {
  const html = renderReview('## Evidence\n\nA **claim** and an *uncertainty*.\n\n- One question\n\n> A quotation');
  for (const fragment of ['<h2>Evidence</h2>', '<strong>claim</strong>', '<em>uncertainty</em>', '<li>One question</li>', '<blockquote>']) assert.ok(html.includes(fragment));
  assert.ok(!html.includes('contenteditable'));
});
test('review rendering escapes HTML, rejects executable links, and disables image loading', () => {
  const html = renderReview('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![tracking](https://example.com/pixel)\n\n[Source](https://example.com)');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('target="_blank"'));
});
