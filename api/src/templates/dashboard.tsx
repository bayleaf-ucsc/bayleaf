/**
 * Dashboard Page Component (hono/jsx)
 */

import type { FC } from 'hono/jsx';
import type { Session, UserKeyRow, OpenRouterKey } from '../types';
import type { SandboxInfo } from '../daytona';
import {
  BaseLayout,
  RecommendedModelHint,
  CodingAgentCard,
  OpenCodeQuickstartCard,
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

/** Per-backend daily-request view model for the LLM card. */
export interface AltBackendUsage {
  /** Human-readable backend label, e.g. "Google Vertex AI". */
  label: string;
  /** Today's request count (0 when the stored counter date is stale). */
  count: number;
  /** Per-key daily request limit. */
  limit: number;
}

const KeyCard: FC<{ hasKey: boolean }> = ({ hasKey }) => {
  if (hasKey) {
    return (
      <div class={cardStyle} id="keyCard">
        <h2>Your API Key</h2>
        <div id="keyDisplaySlot" />
        <p style="margin-top: 0.5rem; font-size: 0.9em; color: #555;">
          This key authenticates both the LLM inference and sandbox services below.
        </p>
        <button type="button" class={btnDangerStyle} style="margin-top: 0.75rem;" onclick="revokeKey()">Revoke Key</button>
      </div>
    );
  }
  return (
    <div class={cardStyle} id="keySection">
      <h2>Get Your API Key</h2>
      <p>You don't have an API key yet. Create one to start using the BayLeaf API.</p>
      <button type="button" class={btnStyle} onclick="createKey()">Create API Key</button>
    </div>
  );
};

const LlmCard: FC<{ orKey: OpenRouterKey; recommendedModel: string; altBackendUsage: AltBackendUsage[] }> = ({ orKey, recommendedModel, altBackendUsage }) => {
  const remaining = orKey.limit_remaining?.toFixed(4) ?? 'N/A';
  const limitDisplay = orKey.limit != null ? `$${orKey.limit.toFixed(2)}` : 'unlimited';

  return (
    <div class={cardStyle}>
      <h2>LLM Inference</h2>
      <p>OpenAI-compatible chat completions and responses API, proxied through BayLeaf. We retain no copy of your prompts or completions and have no standing access to your request content in flight: only request metadata (model, token counts, timestamps) is observable. Upstream inference is restricted to zero-data-retention (ZDR) providers.</p>
      
      <h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.1em; color: #444;">OpenRouter (Any Provider)</h3>
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
      <p style="margin-top: 0.5rem; font-size: 0.85em; color: #555;">
        Daily limit: {limitDisplay}. Resets <span class="resetHint">at midnight UTC</span>.
      </p>

      {altBackendUsage.map((b) => (
        <>
          <h3 style="margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.1em; color: #444;">{b.label}</h3>
          <div class={statsStyle}>
            <div class={statStyle}>
              <div class={statValueStyle}>{b.count}</div>
              <div class={statLabelStyle}>Today's Requests</div>
            </div>
            <div class={statStyle}>
              <div class={statValueStyle}>{Math.max(0, b.limit - b.count)}</div>
              <div class={statLabelStyle}>Remaining Today</div>
            </div>
            <div class={statStyle}>
              <div class={statValueStyle}>{b.limit}</div>
              <div class={statLabelStyle}>Daily Limit</div>
            </div>
          </div>
          <p style="margin-top: 0.5rem; font-size: 0.85em; color: #555;">
            Resets <span class="resetHint">at midnight UTC</span>.
          </p>
        </>
      ))}

      <p style="margin-top: 1.5rem; font-size: 0.85em; color: #555;">
        Increased limits are <a href="https://bayleaf.dev/support" style="color: #2a5298;">available upon request</a>.
      </p>
      <details style="margin-top: 1rem;">
        <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Quick start</summary>
        <div style="margin-top: 0.75rem;">
          <p><strong>Endpoint:</strong></p>
          <button type="button" class={copyBoxStyle} onclick="copyToClipboard(this)">
            <code>https://api.bayleaf.dev/v1</code>
            <span class="copy-hint">Click to copy</span>
          </button>
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
      <details style="margin-top: 1rem;" id="modelsDetails" ontoggle="loadModels(this)">
        <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Available models</summary>
        <div style="margin-top: 0.75rem; max-height: 400px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; padding: 0.5rem; background: #fafafa;">
          <div id="modelsLoading">Loading models...</div>
          <ul id="modelsList" style="list-style: none; margin: 0; padding: 0; display: none; font-family: monospace; font-size: 0.9em;">
          </ul>
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
    : state === 'stopped' ? '#7a5a00'
    : state === 'archived' ? '#3a6fb5'
    : state === 'error' ? '#c41e3a'
    : '#555';

  return (
    <div class={cardStyle} id="sandboxCard">
      <h2>Code Sandbox</h2>
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
        <button type="button" class={btnDangerStyle} style="margin-top: 1rem;" onclick="deleteSandbox()">Delete Sandbox</button>
      ) : (
        <p style="margin-top: 0.75rem; color: #555; font-size: 0.9em;">
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
          <p style="margin-top: 0.75rem; font-size: 0.9em; color: #555;">
            Sandboxes auto-stop after {sandboxInfo?.autoStopInterval ?? 15} min idle and auto-archive
            after {sandboxInfo?.autoArchiveInterval ?? 60} min stopped.
            The first request after idle may take a few seconds while the sandbox restarts.
          </p>
        </div>
      </details>
    </div>
  );
};

const GwsCard: FC = () => (
  <div class={cardStyle} style="background: #f0f7f0; border-color: #2d7d46;">
    <h2>Google Workspace CLI</h2>
    <p>
      Access Drive, Gmail, Calendar, Sheets, and other Google Workspace services from your
      terminal or coding agent, authenticated as your UCSC account.
    </p>
    <details style="margin-top: 1rem;">
      <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Setup instructions</summary>
      <div style="margin-top: 0.75rem;">
        <p><strong>1. Install:</strong></p>
        <pre><code>npm install -g @googleworkspace/cli</code></pre>
        <p style="margin-top: 0.75rem;"><strong>2. Download credentials:</strong></p>
        <pre><code>{`curl -s https://api.bayleaf.dev/docs/gws-client-secret.json \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -o ~/.config/gws/client_secret.json`}</code></pre>
        <p style="margin-top: 0.75rem;"><strong>3. Authenticate (one-time, opens browser):</strong></p>
        <pre><code>gws auth login --account your@ucsc.edu --full</code></pre>
        <p style="margin-top: 0.75rem; font-size: 0.9em; color: #555;">
          Or hand the full setup guide to your coding agent (GWS setup is included):
        </p>
        <p style="margin: 0.25rem 0 0 0;">
          <a href="/llms.txt" target="_blank" style="font-weight: 500;">
            https://api.bayleaf.dev/llms.txt
          </a>
        </p>
      </div>
    </details>
  </div>
);

const WebCard: FC = () => (
  <div class={cardStyle} style="background: #f0f0ff; border-color: #4a4aad;">
    <h2>Web Search & Fetch</h2>
    <p>
      Search the web and extract page content via the API, powered by Tavily.
    </p>
    <details style="margin-top: 1rem;">
      <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Quick start</summary>
      <div style="margin-top: 0.75rem;">
        <p><strong>Search:</strong></p>
        <pre><code>{`curl https://api.bayleaf.dev/web/search \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "UC Santa Cruz", "max_results": 5}'`}</code></pre>
        <p style="margin-top: 0.75rem;"><strong>Fetch page content:</strong></p>
        <pre><code>{`curl https://api.bayleaf.dev/web/fetch \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"urls": "https://example.com", "format": "markdown"}'`}</code></pre>
      </div>
    </details>
  </div>
);

const CanvasCard: FC = () => (
  <div class={cardStyle} style="background: #fff7f0; border-color: #c45a20;">
    <h2>Canvas LMS</h2>
    <p>
      Give your coding agent access to your Canvas courses, assignments, grades, and announcements
      via the <code>canvaslms</code> CLI.
    </p>
    <details style="margin-top: 1rem;">
      <summary style="cursor: pointer; color: #006aad; font-weight: 500;">Setup instructions</summary>
      <div style="margin-top: 0.75rem;">
        <p><strong>1. Generate a Canvas access token:</strong></p>
        <p style="font-size: 0.9em; color: #555;">
          Go to <a href="https://canvas.ucsc.edu/profile/settings" target="_blank">Canvas &rarr; Profile &rarr; Settings</a>,
          scroll to "Approved Integrations", and click <strong>New Access Token</strong>.
          Copy the token (it is only shown once). This is separate from your BayLeaf API key.
        </p>
        <p style="margin-top: 0.75rem;"><strong>2. Install the CLI:</strong></p>
        <pre><code>{`pipx install canvaslms
pipx inject canvaslms cryptography`}</code></pre>
        <p style="margin-top: 0.75rem;"><strong>3. Log in (interactive, stores credentials):</strong></p>
        <pre><code>canvaslms login</code></pre>
        <p style="font-size: 0.9em; color: #555; margin-top: 0.5rem;">
          Enter <code>canvas.ucsc.edu</code> as the hostname and paste your token.
          Credentials are stored in your system keyring (or a config file as fallback).
        </p>
        <p style="margin-top: 0.75rem;"><strong>4. Verify:</strong></p>
        <pre><code>canvaslms courses -i</code></pre>
        <p style="margin-top: 0.75rem; font-size: 0.9em; color: #555;">
          Or hand the full details to your coding agent (Canvas setup is included):
        </p>
        <p style="margin: 0.25rem 0 0 0;">
          <a href="/llms.txt" target="_blank" style="font-weight: 500;">
            https://api.bayleaf.dev/llms.txt
          </a>
        </p>
      </div>
    </details>
  </div>
);

// ── Dashboard Scripts ────────────────────────────────────────────

const DashboardScripts: FC<{ bayleafToken: string }> = ({ bayleafToken }) => (
  <script dangerouslySetInnerHTML={{
    __html: `
      // JSON.stringify is defensive: bayleafToken is server-generated by
      // utils/token.ts (sk-bayleaf- + base64url) and cannot today contain a
      // quote, slash, angle bracket, or newline. The .stringify guarantees
      // safety even if the token format ever changes (e.g. a future
      // randomness layer that happens to produce a script-closing tag by
      // accident) and turns this into syntactically inert JS regardless.
      const BAYLEAF_TOKEN = ${JSON.stringify(bayleafToken)};

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

      let modelsLoaded = false;
      async function loadModels(detailsEl) {
        if (!detailsEl.open || modelsLoaded) return;
        if (!BAYLEAF_TOKEN) {
          document.getElementById('modelsLoading').textContent = 'Please create an API key first.';
          return;
        }

        try {
          const res = await fetch('/v1/models', {
            headers: { 'Authorization': 'Bearer ' + BAYLEAF_TOKEN }
          });
          if (!res.ok) throw new Error('Failed to fetch models');
          const data = await res.json();

          const list = document.getElementById('modelsList');
          list.innerHTML = '';

          data.data.sort((a, b) => a.id.localeCompare(b.id)).forEach(model => {
            const provider = model.id.split(':')[0];
            const originalId = model.id.substring(provider.length + 1);
            let docsLink = '#';

            if (provider === 'openrouter') {
              docsLink = 'https://openrouter.ai/' + originalId;
            } else if (provider === 'vertex') {
              const publisher = originalId.startsWith('gemini-') ? 'google' : 'google';
              docsLink = 'https://console.cloud.google.com/vertex-ai/publishers/' + publisher + '/model-garden/' + originalId;
            }

            const li = document.createElement('li');
            li.style.padding = '0.2rem 0';

            const a = document.createElement('a');
            a.href = docsLink;
            a.target = '_blank';
            a.style.color = '#006aad';
            a.style.textDecoration = 'none';
            a.textContent = model.id;

            li.appendChild(a);
            list.appendChild(li);
          });

          document.getElementById('modelsLoading').style.display = 'none';
          list.style.display = 'block';
          modelsLoaded = true;
        } catch (e) {
          document.getElementById('modelsLoading').textContent = 'Error loading models: ' + e.message;
        }
      }

      // On page load: localize the reset hint
      (function() {
        const els = document.querySelectorAll('.resetHint');
        if (!els.length) return;
        try {
          const now = new Date();
          const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
          const h = Math.ceil((midnightUtc.getTime() - now.getTime()) / 3600000);
          const localTime = midnightUtc.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
          const countdown = h === 1 ? 'in ~1 hour' : 'in ~' + h + ' hours';
          els.forEach(el => {
            el.textContent = 'at ' + localTime + ' your time (' + countdown + ')';
          });
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
            <div class="success" style="margin-bottom: 1rem;" role="status" aria-live="polite">
              <strong>Your new API key is ready.</strong>
              <p style="font-size: 0.9em; color: #155724; margin: 0.25rem 0 0 0;">Use the Copy button; the key is hidden to keep it safe during screen sharing.</p>
            </div>
            <form onsubmit="return false" class="key-display" style="margin-bottom: 1rem;">
              <input type="password" value="\${newKey}" id="apiKey" readonly autocomplete="off" aria-label="Your BayLeaf API key (hidden)">
              <button type="button" class="btn copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
            </form>
          \`;
        } else if (BAYLEAF_TOKEN) {
          displaySlot.innerHTML = \`
            <form onsubmit="return false" class="key-display" style="margin-bottom: 1rem;">
              <input type="password" value="\${BAYLEAF_TOKEN}" id="apiKey" readonly autocomplete="off" aria-label="Your BayLeaf API key (hidden)">
              <button type="button" class="btn copy-btn" id="copyBtn" onclick="copyToken()">Copy</button>
              <button type="button" class="btn copy-btn" id="toggleBtn" onclick="toggleKeyVisibility()" style="right: 4rem;">Show</button>
            </form>
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
  gwsEnabled?: boolean;
  altBackendUsage?: AltBackendUsage[];
}> = ({ session, row, orKey, recommendedModel, sandboxInfo, gwsEnabled, altBackendUsage }) => {
  const greeting = session.name
    ? `Welcome, ${session.name} (${session.email})`
    : `Welcome, ${session.email}`;
  const hasKey = !!(row && orKey);

  return (
    <BaseLayout title="Dashboard">
      <p>{greeting} | <a href="/logout">Sign out</a></p>

      <KeyCard hasKey={hasKey} />

      {hasKey && orKey && row && <LlmCard orKey={orKey} recommendedModel={recommendedModel} altBackendUsage={altBackendUsage ?? []} />}

      {hasKey && <SandboxCard sandboxInfo={sandboxInfo ?? null} />}

      {hasKey && <WebCard />}

      {hasKey && <OpenCodeQuickstartCard />}

      <CodingAgentCard recommendedModel={recommendedModel} />

      {gwsEnabled && <GwsCard />}

      <CanvasCard />

      <DashboardScripts bayleafToken={row?.bayleaf_token || ''} />
    </BaseLayout>
  );
};
