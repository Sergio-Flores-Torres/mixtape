import config from './config.js';
import { statFor } from './state.js';

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchWithRetry(url, options, providerName) {
  const provider = config.providers[providerName];
  const maxRetries = Number(provider.maxRetries ?? 3);
  let attempt = 0;

  while (true) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      attempt++;
      continue;
    }

    if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= maxRetries) {
      return response;
    }

    if (response.status === 429) statFor(providerName).rateLimited++;

    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 1500 * 2 ** attempt);

    await response.arrayBuffer();
    await sleep(wait);
    attempt++;
  }
}

export function providerHeaders(provider, req) {
  const headers = {
    'authorization': `Bearer ${process.env[provider.apiKeyEnv] ?? ''}`,
    'content-type': req.headers['content-type'] || 'application/json'
  };
  for (const name of ['accept', 'user-agent', 'x-stainless-os', 'x-stainless-lang', 'x-stainless-package-version']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}
