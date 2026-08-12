import config from './config.js';

export function providerForModel(model) {
  const entry = config.models?.[model];
  if (entry?.provider && config.providers?.[entry.provider]) return [entry.provider, entry];
  return [null, null];
}

export function modelsResponse() {
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
