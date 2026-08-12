import { URL } from 'node:url';

import config from './config.js';
import { stats } from './state.js';
import { json, readBody } from './http.js';
import { providerForModel, modelsResponse } from './models.js';
import { enqueue } from './queue.js';
import { fetchWithRetry, providerHeaders } from './upstream.js';

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } }); }

  const model = body.model;
  if (!model) return json(res, 400, { error: { message: 'Missing model', type: 'invalid_request_error' } });

  const [providerName, modelConfig] = providerForModel(model);
  if (!providerName) return json(res, 404, { error: { message: `No proxy route configured for model: ${model}`, type: 'invalid_request_error' } });

  const provider = config.providers[providerName];
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) return json(res, 500, { error: { message: `Missing environment variable ${provider.apiKeyEnv}`, type: 'proxy_error' } });

  const outbound = { ...body, ...(modelConfig?.body ?? {}) };
  const url = provider.baseUrl.replace(/\/$/, '') + '/chat/completions';

  try {
    const response = await enqueue(providerName, async () => fetchWithRetry(url, {
      method: 'POST',
      headers: providerHeaders(provider, req),
      body: JSON.stringify(outbound)
    }, providerName));

    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k.toLowerCase())) res.setHeader(k, v);
    }
    res.setHeader('x-mixtape-provider', providerName);
    res.setHeader('x-mixtape-proxy-model', model);
    if (response.body) {
      for await (const chunk of response.body) res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (err) {
    json(res, 502, { error: { message: `Upstream request failed: ${err.message}`, type: 'proxy_error' } });
  }
}

export async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, providers: Object.keys(config.providers ?? {}), stats: Object.fromEntries(stats) });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return json(res, 200, modelsResponse());
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }

  return json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
}
