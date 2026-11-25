/** Whether old toolbar state changes the messages selected for the model. */
export function hasLegacyContext(legacy) {
  return ['runs', 'replays', 'prompts', 'answers'].some(key => Object.keys(legacy[key] ?? {}).length > 0)
    || ['turns', 'answers'].some(key => Array.isArray(legacy.hidden?.[key]) && legacy.hidden[key].length > 0);
}

/** Read native turns without rewriting the DSH event log. */
export function contextTurns(events, { includeUnprompted = false } = {}) {
  const turns = [];
  const inbox = { 'next-turn': [], 'next-step': [] };
  const replayable = message => message?.role === 'user' && typeof message.id === 'string'
    && Array.isArray(message.content) && typeof message.source?.kind === 'string'
    && message.source.form !== 'notice'
    && !['compact-checkpoint', 'runtime-context', 'model-selection'].includes(message.source.kind);
  let current;
  let claimedPriority = 0;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, events: [], answers: [] };
      claimedPriority = 0;
      turns.push(current);
      continue;
    }
    // Admission can fail after an inbox claim but before user/message exists.
    // Replay the durable splices to recover only input actually claimed here.
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data;
      const pending = inbox[splice?.target];
      if (Array.isArray(pending)) {
        const count = splice.removedCount ?? 0;
        if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > pending.length
          || !Number.isSafeInteger(count) || count < 0 || splice.start + count > pending.length
          || !Array.isArray(splice.inserted)) {
          inbox[splice.target] = undefined;
        } else {
          const removed = pending.splice(splice.start, count, ...splice.inserted);
          const priority = splice.target === 'next-turn' ? 2 : 1;
          const input = removed.find(replayable);
          if (current && !current.end && splice.outcome === undefined && input && priority > claimedPriority) {
            current.input = input;
            claimedPriority = priority;
          }
        }
      }
    }
    if (current === undefined) continue;
    current.events.push(event);
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
    }
    if (event.type === 'user/message' && replayable(event.data)
      && (current.input === undefined || event.data.id === current.input.id)) {
      current.input = event.data;
      claimedPriority = 3;
    }
    if (event.type === 'assistant/message' && event.data?.turn === current.turn
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      current.answers.push(event);
    }
    if (event.type === 'turn/end' && event.data?.turn === current.turn) current.end = event;
  }
  return includeUnprompted ? turns : turns.filter(turn => turn.user !== undefined);
}
