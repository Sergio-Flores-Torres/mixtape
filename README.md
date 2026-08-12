# Crush Rate Proxy

A tiny local Node.js OpenAI-compatible proxy designed for Crush. It queues requests per provider, enforces requests-per-minute limits, limits concurrency, retries 429/5xx responses with backoff, and can inject provider/model-specific request-body fields.

## Requirements

- Node.js 20+
- No npm dependencies

## Install / run

```bash
cd crush-rate-proxy
export GEMINI_API_KEY="..."
export NVIDIA_API_KEY="..."
node server.js
```

The proxy listens only on `127.0.0.1:8787` by default.

## How Crush uses it

Crush can point an OpenAI-compatible provider at:

```text
http://127.0.0.1:8787/v1
```

Crush still sends the real model ID. The proxy uses `config.json` to map that model to its upstream provider and API key.

For example:

```json
{
  "providers": {
    "nvidia-proxy": {
      "type": "openai-compat",
      "base_url": "http://127.0.0.1:8787/v1",
      "api_key": "local-proxy",
      "models": [
        { "id": "z-ai/glm-5.2", "name": "GLM-5.2", "context_window": 1000000 }
      ]
    }
  },
  "models": {
    "large": {
      "model": "z-ai/glm-5.2",
      "provider": "nvidia-proxy",
      "max_tokens": 32000
    }
  }
}
```

The proxy ignores the local API key; the real upstream keys stay in environment variables on the proxy process.

## Configuration

`config.json` has two layers:

- `providers`: upstream endpoint, API-key environment variable, RPM limit, concurrency and retry policy.
- `models`: maps a model ID to a provider and optionally injects additional request-body fields.

Example:

```json
"gemini": {
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "apiKeyEnv": "GEMINI_API_KEY",
  "requestsPerMinute": 5,
  "maxConcurrent": 1,
  "maxRetries": 4,
  "models": ["gemini-2.5-flash"]
}
```

Set the RPM conservatively. A limit of 5 RPM is safer configured as 4 RPM if the upstream uses a strict rolling one-minute window and you want headroom.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

Streaming responses are passed through, so Crush can continue using streaming.

## Important behavior

The limiter is per upstream provider, not global. Queued requests wait locally rather than being rejected. 429, 500, 502, 503 and 504 responses are retried with `Retry-After` support and exponential backoff.

The proxy binds to localhost by default and should not be exposed to the LAN without adding authentication.
