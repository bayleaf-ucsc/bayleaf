/**
 * HTML Utilities
 */

/**
 * Strip HTML tags from a string, returning plain text.
 * Used to extract system prompts from Canvas page bodies.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')  // replace tags with spaces
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();
}

/**
 * Extract a Canvas course ID from a URL like:
 *   https://canvas.ucsc.edu/courses/85291
 *   https://canvas.ucsc.edu/courses/85291/assignments
 * Returns null if the URL doesn't match.
 */
export function extractCanvasCourseId(url: string): number | null {
  const match = url.match(/canvas\.ucsc\.edu\/courses\/(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Generate a short claim code for course verification.
 */
export function generateClaimCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'CLAIM:' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
