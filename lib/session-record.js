
/**
 * DSH session compatibility helpers.
 * Adapted from message-edit research.
 */

export function sessionEvents(session) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events;
  if (!Array.isArray(events)) {
    throw new Error('Unable to read session events.');
  }
  return events;
}

export function sessionEventCount(session) {
  return typeof session?.snapshotEvents === 'function' &&
    Number.isSafeInteger(session.seq)
    ? session.seq
    : sessionEvents(session).length;
}

export function sessionRecord(session) {
  const events = sessionEvents(session);
  const header = session.header ?? session.session;
  const inheritedEventCount = session.inheritedEventCount
    ?? header?.seedLength
    ?? 0;

  return {
    id: header.id,
    header,
    events,
    inheritedEventCount,
  };
}

export function branchSeedOptions(source, inheritedEventCount) {
  return typeof source.header?.isSeeded === 'boolean'
    ? { inheritedEventCount, meta: { isSeeded: true } }
    : { meta: { seedLength: inheritedEventCount } };
}

export async function readSessionRecord(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId);
  if (live) return sessionRecord(live);

  if (typeof ctx.sessionQuery.observeSession === 'function') {
    const observation = await ctx.sessionQuery.observeSession(sessionId, {
      projectionMode: 'none',
    });

    try {
      return sessionRecord(observation);
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  return sessionRecord(await ctx.sessionQuery.readSession(sessionId));
}
