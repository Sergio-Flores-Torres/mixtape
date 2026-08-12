# AGENTS.md - Developer & Agent Guide for Crush Rate Proxy

## Overview & Architecture

`crush-rate-proxy` is a lightweight, zero-dependency Node.js HTTP proxy designed to sit between coding agents (such as Crush) and OpenAI-compatible LLM provider APIs (e.g., Gemini, NVIDIA).

Key capabilities:
- Queues incoming requests per upstream provider.
- Enforces rolling requests-per-minute (RPM) limits and max concurrency limits (`maxConcurrent`).
- Automatically retries failed or rate-limited requests (`429`, `500`, `502`, `503`, `504`, or network fetch errors) with exponential backoff and `Retry-After` header support.
- Merges provider or model-specific request body modifications (e.g., reasoning budgets or chat template parameters) prior to upstream forwarding.
- Injects upstream API keys from process environment variables, hiding sensitive credentials from local clients.

---

## Essential Commands

### Environment Setup
Requires **Node.js 20+**. There are zero external npm dependencies.

Set the API key environment variables declared in `config.json` before starting:
```bash
export GEMINI_API_KEY="your-gemini-key"
export NVIDIA_API_KEY="your-nvidia-key"
```

### Start Server
```bash
./mixtape.sh
# or via npm:
npm start
# or directly:
node server.js
```

### Verification & Testing
There is no automated test suite in the repository. Verify proxy endpoints using HTTP clients:

```bash
# Healthcheck & metrics
curl http://127.0.0.1:8787/health

# Model list
curl http://127.0.0.1:8787/v1/models

# Chat completion request
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

---

## Code Base & Control Flow

The codebase consists of four root-level files:

```
.
├── package.json    # Configured as ESM ("type": "module"), specifies Node >=20 engine requirement
├── config.json     # Declarative provider and model rate limits, endpoints, and body injections
├── server.js       # Complete HTTP server implementation (routing, queuing, retries, header filtering)
└── README.md       # User documentation
```

### Request Lifecycle
1. **HTTP Routing** (`server.js`):
   - `GET /health`: Returns system status and provider metrics (`requests`, `successes`, `errors`, `rateLimited`, `queued`).
   - `GET /v1/models`: Transforms `config.models` into an OpenAI-compatible model list response.
   - `POST /v1/chat/completions`: Handled by `handleChat`.
2. **Model & Provider Resolution** (`providerForModel`):
   - Reads `config.models[model]` and returns its `provider` (plus the model config entry). If the model is not listed in the top-level `models` map, resolution fails (returns `[null, null]`), and `handleChat` rejects the request with an HTTP 404 `{ error: { message: 'No proxy route configured for model: <model>', type: 'invalid_request_error' } }`. Provider objects no longer carry their own `models` arrays — the top-level `models` map is the single source of truth for model-to-provider routing.
3. **Queueing & Rate Limiting** (`enqueue`, `pump`, `rpmDelay`):
   - Queues request jobs in per-provider state objects (`stateFor`).
   - Restricts concurrent requests to `provider.maxConcurrent` (defaults to 1).
   - Enforces `provider.requestsPerMinute` by maintaining request timestamps over a 60,000 ms sliding window and calculating required delays before job execution.
4. **Upstream Forwarding & Retries** (`fetchWithRetry`):
   - Merges extra request body properties from `modelConfig.body` into client payload.
   - Injects `Authorization: Bearer <process.env[provider.apiKeyEnv]>`.
   - Forwards client headers: `accept`, `user-agent`, and `x-stainless-*` headers. Filters out hop-by-hop headers.
   - Retries statuses `429`, `500`, `502`, `503`, `504` or fetch exceptions up to `provider.maxRetries` (defaults to 3) using backoff or `Retry-After` header values. Consumes response buffer (`arrayBuffer()`) on retried attempts to avoid socket leaks.
5. **Streaming Output**:
   - Streams response chunks to client using `res.write(Buffer.from(chunk))`.
   - Appends proxy headers `x-crush-proxy-provider` and `x-crush-proxy-model`.

---

## Configuration Structure (`config.json`)

`config.json` contains two main sections:

- **`providers`**: Maps provider keys (e.g., `gemini`, `nvidia`) to configuration:
  - `baseUrl`: Upstream base endpoint (proxy appends `/chat/completions`).
  - `apiKeyEnv`: Environment variable name holding the API key.
  - `requestsPerMinute`: Sliding 60-second limit window.
  - `maxConcurrent`: Maximum concurrent outgoing requests.
  - `maxRetries`: Maximum retry attempts for failed/throttled calls.
- **`models`**: The single source of truth for model routing. Maps explicit model names to provider settings and optional payload fields:
  - `provider`: Reference to a provider key in `providers`.
  - `body`: Optional object merged into outgoing payload (e.g., `chat_template_kwargs`, `reasoning_budget`).

---

## Gotchas & Important Conventions

- **Zero External Dependencies**: Do not add third-party dependencies (`express`, `axios`, `dotenv`, etc.). The project strictly relies on Node 20+ standard library modules (`node:http`, `node:fs`, `node:url`) and global `fetch`.
- **In-Memory State**: Provider queues and request statistics (`queues`, `stats`) are held purely in memory. Server restarts reset queues, rate-limiting history, and metrics.
- **Client Auth Ignored**: Client `Authorization` headers are ignored and overridden by `process.env[provider.apiKeyEnv]`. Missing environment variables result in an HTTP 500 `proxy_error`.
- **Static Config Reading**: `config.json` is read synchronously on startup via `fs.readFileSync`. Modifications to `config.json` require restarting `server.js`.
- **Response Buffering on Retry**: On retriable error status codes, `fetchWithRetry` awaits `response.arrayBuffer()` before sleeping to prevent unconsumed stream leaks.
