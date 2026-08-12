export const queues = new Map();
export const stats = new Map();

export function stateFor(name) {
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

export function statFor(name) {
  if (!stats.has(name)) stats.set(name, { requests: 0, successes: 0, errors: 0, rateLimited: 0, queued: 0 });
  return stats.get(name);
}
