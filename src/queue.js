import config from './config.js';
import { stateFor, statFor } from './state.js';
import { updateStats } from './display.js';

function rpmDelay(state, provider) {
  const rpm = Number(provider.requestsPerMinute ?? 0);
  if (!rpm) return 0;
  const now = Date.now();
  state.timestamps = state.timestamps.filter(t => t > now - 60_000);
  if (state.timestamps.length < rpm) return 0;
  return Math.max(0, state.timestamps[0] + 60_000 - now);
}

export function enqueue(providerName, job) {
  const provider = config.providers[providerName];
  const state = stateFor(providerName);
  const stat = statFor(providerName);
  stat.requests++;
  if (state.pending.length || state.active >= Number(provider.maxConcurrent ?? 1)) stat.queued++;
  return new Promise((resolve, reject) => {
    state.pending.push({ job, resolve, reject });
    updateStats();
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
  updateStats();

  try {
    const result = await item.job();
    statFor(providerName).successes++;
    item.resolve(result);
  } catch (err) {
    statFor(providerName).errors++;
    item.reject(err);
  } finally {
    state.active--;
    updateStats();
    pump(providerName);
  }
}
