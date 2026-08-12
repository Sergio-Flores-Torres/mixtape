import http from 'node:http';
import fs from 'node:fs';
import { URL } from 'node:url';

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const PORT = config.listen?.port ?? 8787;
const HOST = config.listen?.host ?? '127.0.0.1';

const queues = new Map();
const stats = new Map();

function providerForModel(model) {
  const entry = config.models?.[model];
  if (entry?.provider && config.providers?.[entry.provider]) return [entry.provider, entry];
  for (const [name, p] of Object.entries(config.providers ?? {})) {
    if ((p.models ?? []).includes(model)) return [name, { provider: name }];
  }
  return [null, null];
}

function stateFor(name) {
  if (!queues.has(name)) {
    queues.set(name, {
      pending: [],
      active: 0,
      timestamps: [],
      nextAvailable: 0
    });
  }
  return queues.get(name);
}

function statFor(name) {
  if (!stats.has(name)) stats.set(name, { requests: 0, successes: 0, errors: 0, rateLimited: 0, queued: 0 });
  return stats.get(name);
}

function rpmDelay(state, provider) {
  const rpm = Number(provider.requestsPerMinute ?? 0);
  if (!rpm) return 0;
  const now = Date.now();
  state.timestamps = state.timestamps.filter(t => t > now - 60_000);
  if (state.timestamps.length < rpm) return 0;
  return Math.max(0, state.timestamps[0] + 60_000 - now);
}

function enqueue(providerName, job) {
  const provider = config.providers[providerName];
  const state = stateFor(providerName);
  const stat = statFor(providerName);
  stat.requests++;
  if (state.pending.length || state.active >= Number(provider.maxConcurrent ?? 1)) stat.queued++;
  return new Promise((resolve, reject) => {
    state.pending.push({ job, resolve, reject });
    pump(providerName);
  });
}

async function pump(providerName) {
  const provider = config.providers[providerName];
  const state = stateFor(providerName);
  const maxConcurrent = Number(provider.maxConcurrent ?? 1);
  if (state.active >= maxConcurrent || !state.pending.length) return;

  const delay = rpmDelay(state, provider);
  if (delay > 0) {
    if (state.nextAvailable === 0) {
      state.nextAvailable = Date.now() + delay;
      setTimeout(() => {
        state.nextAvailable = 0;
        pump(providerName);
      }, delay + 5);
    }
    return;
  }

  const item = state.pending.shift();
  state.active++;
  state.timestamps.push(Date.now());

  try {
    const result = await item.job();
    statFor(providerName).successes++;
    item.resolve(result);
  } catch (err) {
    statFor(providerName).errors++;
    item.reject(err);
  } finally {
    state.active--;
    pump(providerName);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, options, providerName) {
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

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function modelsResponse() {
  const data = [];
  for (const [id, model] of Object.entries(config.models ?? {})) {
    data.push({
      id,
      object: 'model',
      created: 0,
      owned_by: model.provider
    });
  }
  return { object: 'list', data };
}

function providerHeaders(provider, req) {
  const headers = {
    'authorization': `Bearer ${process.env[provider.apiKeyEnv] ?? ''}`,
    'content-type': req.headers['content-type'] || 'application/json'
  };
  // Forward selected headers useful to OpenAI-compatible APIs without leaking hop-by-hop headers.
  for (const name of ['accept', 'user-agent', 'x-stainless-os', 'x-stainless-lang', 'x-stainless-package-version']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  return headers;
}

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
    res.setHeader('x-crush-proxy-provider', providerName);
    res.setHeader('x-crush-proxy-model', model);
    if (response.body) {
      for await (const chunk of response.body) res.write(Buffer.from(chunk));
    }
    res.end();
  } catch (err) {
    json(res, 502, { error: { message: `Upstream request failed: ${err.message}`, type: 'proxy_error' } });
  }
}

const server = http.createServer(async (req, res) => {
  try {
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
  } catch (err) {
    return json(res, 500, { error: { message: err.message, type: 'proxy_error' } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Crush rate proxy listening on http://${HOST}:${PORT}`);
  for (const [name, p] of Object.entries(config.providers ?? {})) {
    console.log(`  ${name}: ${p.requestsPerMinute ?? 'unlimited'} RPM, concurrency ${p.maxConcurrent ?? 1}`);
  }
});
