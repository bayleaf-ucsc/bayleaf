/**
 * Landing Page Component (hono/jsx)
 */

import type { FC } from 'hono/jsx';
import {
  BaseLayout,
  RecommendedModelHint,
  cardStyle,
  btnStyle,
} from './layout';

/** Per-IP Campus Pass usage, surfaced from /v1/auth/key's bayleaf.campus block. */
export interface CampusUsage {
  count: number;
  limit: number;
  remaining: number;
  resetsAt: string; // ISO 8601
}

/** Format the reset time for human display. ISO timestamps are ugly on a card. */
function formatResetTime(iso: string): string {
  try {
    const d = new Date(iso);
    // "Nov 16, 04:00 PM PST" style. Use the user's locale.
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

export const LandingPage: FC<{
  showCampusPass: boolean;
  recommendedModel: string;
  loginButtonText: string;
  campusUsage?: CampusUsage;
}> = ({ showCampusPass, recommendedModel, loginButtonText, campusUsage }) => (
  <BaseLayout title="Welcome">
    <div class={cardStyle}>
      <h2>API Access for UCSC</h2>
      <p>Free LLM inference for UC Santa Cruz students, faculty, and staff.</p>
      <p><a href="/login" class={btnStyle}>{loginButtonText}</a></p>
    </div>

    {showCampusPass ? (
      <div class={cardStyle} style="background: #e8f4e8; border-color: #28a745;">
        <h3>Campus Pass Available</h3>
        <p>You're on the UCSC network! You can use the API right now without signing in.</p>
        <p>Just point any OpenAI-compatible client at:</p>
        <pre><code>https://api.bayleaf.dev/v1</code></pre>
        <p>No API key needed, or use <code>campus</code> as your key.</p>
        {campusUsage ? (
          <p style="margin-top: 1em; padding-top: 0.75em; border-top: 1px solid #b8d8b8; font-size: 0.95em; color: #2d5a2d;">
            {campusUsage.remaining > 0 ? (
              <>
                <strong>{campusUsage.count}</strong> of {campusUsage.limit} requests
                used today by your network address.
                Resets {formatResetTime(campusUsage.resetsAt)}.
              </>
            ) : (
              <>
                <strong>Daily limit reached</strong> ({campusUsage.count}/{campusUsage.limit}) for your network address.
                Resets {formatResetTime(campusUsage.resetsAt)}.{' '}
                <a href="/login">Sign in</a> for a personal key with higher limits.
              </>
            )}
            <br />
            <span style="color: #5a7a5a; font-size: 0.9em;">
              Counted per network address; users sharing a NAT share a budget.
            </span>
          </p>
        ) : null}
        <RecommendedModelHint model={recommendedModel} />
      </div>
    ) : (
      <div class={cardStyle} style="background: #f0f4ff; border-color: #4a7abf;">
        <h3>On Campus?</h3>
        <p>
          When you're on the UCSC network, you can use the API instantly: no sign-in or
          API key required. Just connect to campus Wi-Fi and visit this page again.
        </p>
      </div>
    )}
  </BaseLayout>
);
