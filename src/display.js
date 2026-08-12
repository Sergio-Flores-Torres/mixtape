import { queues } from './state.js';

let lastProvider = 'none';
let lastModel = 'none';
let lastStatus = 'idle';

export function updateStats({ provider, model, status } = {}) {
  if (provider !== undefined) lastProvider = provider;
  if (model !== undefined) lastModel = model;
  if (status !== undefined) lastStatus = status;

  let totalActive = 0;
  let totalPending = 0;
  const queueDetails = [];

  for (const [pName, state] of queues.entries()) {
    const active = state.active || 0;
    const pending = state.pending ? state.pending.length : 0;
    totalActive += active;
    totalPending += pending;
    if (active > 0 || pending > 0) {
      queueDetails.push(`${pName}:${active} active, ${pending} pending`);
    }
  }

  const queueStr = queueDetails.length > 0
    ? `${totalActive} active, ${totalPending} pending (${queueDetails.join(', ')})`
    : `${totalActive} active, ${totalPending} pending`;

  const line = `Last: ${lastProvider}/${lastModel} | Status: ${lastStatus} | Queue: ${queueStr}`;
  process.stdout.write(`\r\x1b[K${line}`);
}
