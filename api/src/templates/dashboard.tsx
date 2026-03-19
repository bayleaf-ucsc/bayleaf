/**
 * Dashboard Page Component (hono/jsx)
 */

import type { FC } from 'hono/jsx';
import type { Session, UserKeyRow, OpenRouterKey } from '../types';
import type { SandboxInfo } from '../daytona';
import {
  BaseLayout,
  RecommendedModelHint,
  OpencodeOnboarding,
  cardStyle,
  btnStyle,
  btnDangerStyle,
  copyBoxStyle,
  statsStyle,
  statStyle,
  statValueStyle,
  statLabelStyle,
} from './layout';

// ── Helpers ──────────────────────────────────────────────────────

/** Format a duration from a date to now as a human-readable string. */
function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return '1d';
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// ── Sub-components ───────────────────────────────────────────────

const KeyCard: FC<{ hasKey: boolean }> = ({ hasKey }) => {
  if (hasKey) {
    return (
      <div class={cardStyle} id="keyCard">
        <h3>Your API Key</h3>
        <div id="keyDisplaySlot" />
        <p style="margin-top: 0.5rem; font-size: 0.9em; color: #666;">
          This key authenticates both the LLM inference and sandbox services below.
        </p>
        <button class={btnDangerStyle} style="margin-top: 0.75rem;" onclick="revokeKey()">Revoke Key</button>
      </div>
    );
  }
  return (
    <div class={cardStyle} id="keySection">
      <h3>Get Your API Key</h3>
      <p>You don't have an API key yet. Create one to start using the BayLeaf API.</p>
      <button class={btnStyle} onclick="createKey()">Create API Key</button>
    </div>
  );
};

const LlmCard: FC<{ orKey: OpenRouterKey; recommendedModel: string }> = ({ orKey, recommendedModel }) => {
  const remaining = orKey.limit_remaining?.toFixed(4) ?? 'N/A';
  const limitDisplay = orKey.limit != null ? `$${orKey.limit.toFixed(2)}` : 'unlimited';

  return (
    <div class={cardStyle}>
      <h3>LLM Inference</h3>
      <p>OpenAI-compatible chat completions and responses API, proxied through BayLeaf with zero data retention.</p>
      <div class={statsStyle}>
        <div class={statStyle}>
          <div class={statValueStyle}>${orKey.usage_daily.toFixed(4)}</div>
          <div class={statLabelStyle}>Today's Usage</div>
        </div>
        <div class={statStyle}>
          <div class={statValueStyle}>${remaining}</div>
          <div class={statLabelStyle}>Remaining Today</div>
        </div>
        <div class={statStyle}>
          <div class={statValueStyle}>${orKey.usage_monthly.toFixed(4)}</div>
          <div class={statLabelStyle}>This Month</div>
        </div>
      </div>
      <p style="margin-top: 0.5rem; font-size: 0.85em; color: #666;">
        Daily limit: {limitDisplay} — resets <span id="resetHint">at midnight UTC</span>.
        Increased limits are <a href="https://bayleaf.dev/support" style="color: #2a5298;">available upon request</a>.
      </p>
      <details style="margin-top: 1rem;">
        <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Quick start</summary>
        <div style="margin-top: 0.75rem;">
          <p><strong>Endpoint:</strong></p>
          <div class={copyBoxStyle} onclick="copyToClipboard(this)">
            <code>https://api.bayleaf.dev/v1</code>
            <span class="copy-hint">Click to copy</span>
          </div>
          <p style="margin-top: 1rem;"><strong>Example:</strong></p>
          <pre><code>{`curl https://api.bayleaf.dev/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${recommendedModel}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}</code></pre>
          <RecommendedModelHint model={recommendedModel} />
        </div>
      </details>
    </div>
  );
};

const SandboxCard: FC<{ sandboxInfo: SandboxInfo | null }> = ({ sandboxInfo }) => {
  const state = sandboxInfo?.state ?? null;
  const stateLabel = state
    ? state.charAt(0).toUpperCase() + state.slice(1)
    : 'None';
  const stateColor = state === 'started' ? '#2d7d46'
    : state === 'stopped' ? '#b88a00'
    : state === 'archived' ? '#3a6fb5'
    : state === 'error' ? '#c41e3a'
    : '#666';

  return (
    <div class={cardStyle} id="sandboxCard">
      <h3>Code Sandbox</h3>
      <p>A persistent Linux environment for running code, accessible via the API.</p>
      <div class={statsStyle}>
        <div class={statStyle}>
          <div class={statValueStyle} style={`color: ${stateColor}`}>{stateLabel}</div>
          <div class={statLabelStyle}>Status</div>
        </div>
        {sandboxInfo?.cpu != null && (
          <div class={statStyle}>
            <div class={statValueStyle}>{sandboxInfo.cpu}</div>
            <div class={statLabelStyle}>vCPU</div>
          </div>
        )}
        {sandboxInfo?.memory != null && (
          <div class={statStyle}>
            <div class={statValueStyle}>{sandboxInfo.memory} GB</div>
            <div class={statLabelStyle}>RAM</div>
          </div>
        )}
        {sandboxInfo?.disk != null && (
          <div class={statStyle}>
            <div class={statValueStyle}>{sandboxInfo.disk} GB</div>
            <div class={statLabelStyle}>Disk</div>
          </div>
        )}
        {sandboxInfo?.createdAt && (
          <div class={statStyle}>
            <div class={statValueStyle}>{timeSince(new Date(sandboxInfo.createdAt))}</div>
            <div class={statLabelStyle}>Age</div>
          </div>
        )}
      </div>
      {sandboxInfo ? (
        <button class={btnDangerStyle} style="margin-top: 1rem;" onclick="deleteSandbox()">Delete Sandbox</button>
      ) : (
        <p style="margin-top: 0.75rem; color: #666; font-size: 0.9em;">
          A sandbox will be created automatically on your first <code>POST /sandbox/exec</code> request.
        </p>
      )}
      <details style="margin-top: 1rem;">
        <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Quick start</summary>
        <div style="margin-top: 0.75rem;">
          <p><strong>Run a command:</strong></p>
          <pre><code>{`curl https://api.bayleaf.dev/sandbox/exec \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"command": "echo hello"}'`}</code></pre>
          <p style="margin-top: 0.75rem;"><strong>Upload a file:</strong></p>
          <pre><code>{`curl https://api.bayleaf.dev/sandbox/files/home/daytona/workspace/hello.txt \\
  -X PUT \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  --data-binary "Hello, world!"`}</code></pre>
          <p style="margin-top: 0.75rem;"><strong>Download a file:</strong></p>
          <pre><code>{`curl https://api.bayleaf.dev/sandbox/files/home/daytona/workspace/hello.txt \\
  -H "Authorization: Bearer YOUR_API_KEY"`}</code></pre>
          <p style="margin-top: 0.75rem; font-size: 0.9em; color: #666;">
            Sandboxes auto-stop after {sandboxInfo?.autoStopInterval ?? 15} min idle and auto-archive
            after {sandboxInfo?.autoArchiveInterval ?? 60} min stopped.
            The first request after idle may take a few seconds while the sandbox restarts.
          </p>
        </div>
      </details>
    </div>
  );
};

// ── Dashboard Scripts ────────────────────────────────────────────

const DashboardScripts: FC<{ bayleafToken: string }> = ({ bayleafToken }) => (
  <script dangerouslySetInnerHTML={{
    __html: `
      const BAYLEAF_TOKEN = '${bayleafToken}';

      function copyToClipboard(el) {
        const code = el.querySelector('code');
        if (!code) return;
        const text = code.textContent;
        if (!navigator.clipboard) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('copy');
          sel.removeAllRanges();
        } else {
          navigator.clipboard.writeText(text);
        }
        el.querySelector('.copy-hint').textContent = 'Copied!';
        setTimeout(() => {
          el.querySelector('.copy-hint').textContent = 'Click to copy';
        }, 1200);
      }

      function copyToken() {
        const input = document.getElementById('apiKey');
        navigator.clipboard.writeText(input.value);
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      }

      function toggleKeyVisibility() {
        const input = document.getElementById('apiKey');
        const btn = document.getElementById('toggleBtn');
        if (input.type === 'password') {
          input.type = 'text';
          btn.textContent = 'Hide';
        } else {
          input.type = 'password';
          btn.textContent = 'Show';
        }
      }

      async function createKey() {
        const res = await fetch('/key', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.key) {
          sessionStorage.setItem('newKey', data.key);
          location.reload();
        } else {
          alert(data.error || 'Failed to create key');
        }
      }

      async function revokeKey() {
        if (!confirm('Revoke your API key? You can create a new one afterward.')) return;
        const res = await fetch('/key', { method: 'DELETE' });
        if (res.ok) {
          location.reload();
        } else {
          alert('Failed to revoke key');
        }
      }

      async function deleteSandbox() {
        if (!confirm('Delete your sandbox? All files in it will be permanently lost.')) return;
        const res = await fetch('/sandbox', { method: 'DELETE' });
        if (res.ok) {
          location.reload();
        } else {
          alert('Failed to delete sandbox');
        }
      }

      // On page load: localize the reset hint
      (function() {
        const el = document.getElementById('resetHint');
        if (!el) return;
        try {
          const now = new Date();
          const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
          const h = Math.ceil((midnightUtc.getTime() - now.getTime()) / 3600000);
          const localTime = midnightUtc.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
          const countdown = h === 1 ? 'in ~1 hour' : 'in ~' + h + ' hours';
          el.textContent = 'at ' + localTime + ' your time (' + countdown + ')';
        } catch(e) {}
      })();

      // On page load: show key display
      (function() {
        const newKey = sessionStorage.getItem('newKey');
        const displaySlot = document.getElementById('keyDisplaySlot');
        if (!displaySlot) return;

        if (newKey) {
          sessionStorage.removeItem('newKey');
          displaySlot.innerHTML = \`
            <div class="success" style="margin-bottom: 1rem;">
              <strong>Your new API key is ready.</strong>
              <p style="font-size: 0.9em; color: #155724; margin: 0.25rem 0 0 0;">Use the Copy button — the key is hidden to keep it safe during screen sharing.</p>
            </div>
            <div class="key-display" style="margin-bottom: 1rem;">
              <input type="password" value="\${newKey}" id="apiKey" readonly>
              <button class="btn copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
            </div>
          \`;
        } else if (BAYLEAF_TOKEN) {
          displaySlot.innerHTML = \`
            <div class="key-display" style="margin-bottom: 1rem;">
              <input type="password" value="\${BAYLEAF_TOKEN}" id="apiKey" readonly>
              <button class="btn copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
              <button class="btn copy-btn" id="toggleBtn" onclick="toggleKeyVisibility()" style="right: 4rem;">Show</button>
            </div>
          \`;
        }
      })();
    `,
  }} />
);

// ── DashboardPage ────────────────────────────────────────────────

export const DashboardPage: FC<{
  session: Session;
  row: UserKeyRow | null;
  orKey: OpenRouterKey | null;
  recommendedModel: string;
  sandboxInfo?: SandboxInfo | null;
}> = ({ session, row, orKey, recommendedModel, sandboxInfo }) => {
  const greeting = `Welcome, ${session.name || session.email}`;
  const hasKey = !!(row && orKey);

  return (
    <BaseLayout title="Dashboard">
      <p>{greeting} | <a href="/logout">Sign out</a></p>

      <KeyCard hasKey={hasKey} />

      {hasKey && orKey && <LlmCard orKey={orKey} recommendedModel={recommendedModel} />}

      {hasKey && <SandboxCard sandboxInfo={sandboxInfo ?? null} />}

      <OpencodeOnboarding recommendedModel={recommendedModel} />

      <DashboardScripts bayleafToken={row?.bayleaf_token || ''} />
    </BaseLayout>
  );
};
