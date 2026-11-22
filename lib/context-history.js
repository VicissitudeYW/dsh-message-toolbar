/** Whether old toolbar state changes the messages selected for the model. */
export function hasLegacyContext(legacy) {
  return ['runs', 'replays', 'prompts', 'answers'].some(key => Object.keys(legacy[key] ?? {}).length > 0)
    || ['turns', 'answers'].some(key => Array.isArray(legacy.hidden?.[key]) && legacy.hidden[key].length > 0);
}

/** Read native turns without rewriting the DSH event log. */
export function contextTurns(events, { includeUnprompted = false } = {}) {
  const turns = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, events: [], answers: [] };
      turns.push(current);
      continue;
    }
    if (current === undefined) continue;
    current.events.push(event);
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
    }
    if (event.type === 'assistant/message' && event.data?.turn === current.turn
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      current.answers.push(event);
    }
    if (event.type === 'turn/end' && event.data?.turn === current.turn) current.end = event;
  }
  return includeUnprompted ? turns : turns.filter(turn => turn.user !== undefined);
}
