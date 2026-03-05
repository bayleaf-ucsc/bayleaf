# BayLeaf API

API key provisioning and LLM inference proxy for UC Santa Cruz, part of the [BayLeaf Chat](https://bayleaf.chat/about) platform.

## Features

- **OIDC Authentication**: Sign in with UCSC Google accounts
- **API Key Provisioning**: Automatic OpenRouter key management (one key per user)
- **Inference Proxy**: OpenAI-compatible Chat Completions and Responses API endpoints with campus-specific system prompt injection
- **Self-Service Dashboard**: Create, view (statistics), and revoke API keys
- **Campus Pass**: On-campus users can access the API without authentication

## Architecture

This is a stateless Cloudflare Worker that:
1. Authenticates users via Google OIDC (restricted to `@ucsc.edu`)
2. Uses the OpenRouter Provisioning API to manage per-user API keys
3. Proxies `/v1/*` requests to OpenRouter, injecting a configurable system prompt prefix

No database required - all state is managed via OpenRouter's API (keys are identified by a name template including the user's authenticated email address).

## Deployment

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Google Cloud project with OAuth 2.0 credentials
- OpenRouter account with Provisioning API key

### Setup

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/rndmcnlly/bayleaf.git
   cd bayleaf/api
   npm install
   ```

2. Configure secrets:
   ```bash
   wrangler secret put OPENROUTER_PROVISIONING_KEY
   wrangler secret put OIDC_CLIENT_ID
   wrangler secret put OIDC_CLIENT_SECRET
   ```

3. Update `wrangler.jsonc` with your configuration (non-secret values)

4. Deploy:
   ```bash
   npm run deploy
   ```

5. **Important**: After deployment is working, disable observability in `wrangler.jsonc` to avoid data accumulation:
   ```jsonc
   "observability": {
     "enabled": false
   }
   ```

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create OAuth 2.0 credentials (Web application)
3. Add authorized redirect URI: `https://api.bayleaf.chat/callback`
4. Set the OIDC client ID and secret as Cloudflare secrets

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SPENDING_LIMIT_DOLLARS` | Daily spending limit per user | `1.0` |
| `SPENDING_LIMIT_RESET` | Limit reset period | `daily` |
| `KEY_NAME_TEMPLATE` | Template for key names (`$email` replaced) | `BayLeaf API for $email` |
| `KEY_EXPIRY_DAYS` | Days until keys expire | `30` |
| `ALLOWED_EMAIL_DOMAIN` | Restrict to this email domain | `ucsc.edu` |
| `SYSTEM_PROMPT_PREFIX` | Prefix injected into all chat requests | `You are an AI assistant...` |
| `CAMPUS_IP_RANGES` | CIDR ranges for Campus Pass (comma-separated, empty = disabled) | `128.114.0.0/16,169.233.0.0/16` |
| `CAMPUS_SYSTEM_PREFIX` | Additional system prompt prefix for Campus Pass users | `Note: This user is using shared access...` |

### Secrets

| Secret | Description |
|--------|-------------|
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter provisioning API key |
| `OIDC_CLIENT_ID` | Google OAuth client ID |
| `OIDC_CLIENT_SECRET` | Google OAuth client secret |
| `CAMPUS_POOL_KEY` | Shared OpenRouter key for Campus Pass (optional) |

## Campus Pass

Campus Pass allows users on the UC Santa Cruz campus network to access the inference proxy without signing in or creating a personal API key.

### How it works

1. When a request arrives at `/v1/*` with no API key (or `Bearer campus`), the system checks the client IP
2. If the IP matches a configured campus CIDR range, the request is proxied using a shared pool key
3. An additional system prompt prefix is injected to inform the model about the shared access context

### Configuration

1. Pre-provision a shared OpenRouter key (e.g., with higher daily limits) and add it as a secret:
   ```bash
   wrangler secret put CAMPUS_POOL_KEY
   ```

2. Set the campus IP ranges in `wrangler.jsonc`:
   ```jsonc
   "CAMPUS_IP_RANGES": "128.114.0.0/16,169.233.0.0/16,192.35.220.0/24,192.35.223.0/24,2607:F5F0::/32"
   ```

3. Optionally customize the campus system prompt prefix:
   ```jsonc
   "CAMPUS_SYSTEM_PREFIX": "Note: This user is accessing via shared on-campus access..."
   ```

### Usage

On-campus users can access the API without any authentication:

```bash
# Chat Completions — no Authorization header needed on campus
curl https://api.bayleaf.chat/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek/deepseek-v3.2", "messages": [{"role": "user", "content": "Hello!"}]}'

# Responses API
curl https://api.bayleaf.chat/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek/deepseek-v3.2", "input": "Hello!"}'

# Or explicitly use "campus" as the key
curl https://api.bayleaf.chat/v1/chat/completions \
  -H "Authorization: Bearer campus" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek/deepseek-v3.2", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Off-campus users will receive a 401 error directing them to get a personal key at https://api.bayleaf.chat/

## API Endpoints

### User-Facing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page |
| `/login` | GET | Start OIDC flow |
| `/callback` | GET | OIDC callback |
| `/logout` | GET | Clear session |
| `/dashboard` | GET | Main user interface |
| `/key` | GET | Get current key info (JSON) |
| `/key` | POST | Create new key (returns key in JSON) |
| `/key` | DELETE | Revoke current key |

### Inference Proxy

| Endpoint | Description |
|----------|-------------|
| `/v1/responses` | Responses API (system prompt injected via `instructions` field) |
| `/v1/chat/completions` | Chat completions (system prompt injected via system message) |
| `/v1/completions` | Text completions |
| `/v1/models` | List available models |
| `/v1/*` | All other OpenRouter endpoints |

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [BayLeaf Chat](https://bayleaf.chat/about)
- [OpenRouter](https://openrouter.ai/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
