/** Match DSH's modelSelection projection: pending is retired by a matching header. */
export function sessionModel(events) {
  let pending;
  let lastUsed;
  const equal = (left, right) => left && right && left.provider === right.provider
    && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
  for (const event of events) {
    if (event.type === 'model/selection' && event.data?.provider && event.data?.model) {
      pending = event.data;
    } else if (event.type === 'request/header') {
      const header = event.data?.header;
      const config = header?.config;
      if (!config?.provider || !config?.model) continue;
      lastUsed = {
        provider: config.provider,
        model: config.model,
        ...(header.adapterDefaults?.reasoningEffort === true || config.reasoningEffort === undefined
          ? {} : { reasoningEffort: config.reasoningEffort }),
      };
      if (equal(pending, lastUsed)) pending = undefined;
    }
  }
  return pending ?? lastUsed;
}
