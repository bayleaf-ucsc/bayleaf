/**
 * Landing Page Component (hono/jsx)
 */

import type { FC } from 'hono/jsx';
import {
  BaseLayout,
  RecommendedModelHint,
  CodingAgentCard,
  cardStyle,
  btnStyle,
} from './layout';

export const LandingPage: FC<{ showCampusPass: boolean; recommendedModel: string; loginButtonText: string }> = ({
  showCampusPass,
  recommendedModel,
  loginButtonText,
}) => (
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

    <CodingAgentCard recommendedModel={recommendedModel} />
  </BaseLayout>
);
