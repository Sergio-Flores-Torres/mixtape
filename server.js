import http from 'node:http';

import config from './src/config.js';
import { route } from './src/routes.js';

const PORT = config.listen?.port ?? 8787;
const HOST = config.listen?.host ?? '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    return await route(req, res);
  } catch (err) {
    const data = JSON.stringify({ error: { message: err.message, type: 'proxy_error' } });
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mixtape: A Crush Model proxy listening on http://${HOST}:${PORT}`);
  for (const [name, p] of Object.entries(config.providers ?? {})) {
    console.log(`  ${name}: ${p.requestsPerMinute ?? 'unlimited'} RPM, concurrency ${p.maxConcurrent ?? 1}`);
  }
});
