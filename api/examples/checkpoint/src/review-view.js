import MarkdownIt from 'markdown-it';

// Model output is untrusted prose: no raw HTML, embedded images, or executable links.
const markdown = new MarkdownIt({ html: false, linkify: false }).disable('image');
const originalLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return originalLink ? originalLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
export const renderReview = text => markdown.render(text);

export function reviewPlaceholder() {
  const placeholder = document.createElement('div');
  placeholder.className = 'review-placeholder';
  const label = document.createElement('p');
  label.className = 'review-waiting';
  label.setAttribute('role', 'status');
  label.textContent = 'Reading this checkpoint…';
  const lines = document.createElement('div');
  lines.className = 'review-skeleton';
  lines.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 7; i++) lines.append(document.createElement('span'));
  placeholder.append(label, lines);
  return placeholder;
}
