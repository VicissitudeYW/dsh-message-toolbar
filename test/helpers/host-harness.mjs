import os from 'node:os';
import { EventEmitter } from 'node:events';
import { apply } from '../../lib/index.js';

export function history(count = 2) {
  return Array.from({ length: count }, (_, i) => i + 1).flatMap((turn) => {
    const seq = (turn - 1) * 4;
    return [
      { seq, type: 'turn/start', data: { turn } },
      { seq: seq + 1, type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${turn}` }] } },
      { seq: seq + 2, type: 'assistant/message', data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }] } } },
      { seq: seq + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ];
  });
}

export function harness(events = history(), { followupError, flushError, deferFollowupMessage = false, cold = false } = {}) {
  let handler;
  const sent = [], selected = [], requests = [];
  const listeners = new Map();
  let cancelled = 0;
  let currentSelection = { provider: 'p', model: 'original', reasoningEffort: 'medium' };
  const dispatch = (subject, event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(subject, event);
  };
  const session = { header: { id: 'session-test', cwd: os.homedir(), isSeeded: false }, events, append(type, data) {
    const event = { seq: events.length, type, data };
    events.push(event);
    dispatch(session, event);
  } };
  const agentContext = { on(type, listener) {
    const bucket = listeners.get(type) ?? new Set();
    bucket.add(listener);
    listeners.set(type, bucket);
    return () => bucket.delete(listener);
  } };
  const agent = {
    options: { provider: 'p', model: 'original', reasoningEffort: 'medium' },
    ctx: agentContext,
    session,
    model: {
      current() { return currentSelection && { ...currentSelection }; },
      select(selection) { selected.push(selection); currentSelection = { ...selection }; session.append('model/selection', selection); },
    },
    followup(message) {
      if (followupError) throw followupError;
      sent.push(message);
      this.queuedMessage = message;
      if (!deferFollowupMessage) this.appendQueuedMessage();
    },
    appendQueuedMessage() {
      if (this.queuedMessage === undefined) throw new Error('no queued message');
      const turn = (events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0) + 1;
      session.append('turn/start', { turn });
      session.append('user/message', structuredClone(this.queuedMessage));
      this.queuedMessage = undefined;
      return turn;
    },
    runMaintenance(fn) { return fn(); },
    cancel() { cancelled++; },
    async whenIdle() {},
  };
  const children = [], flushed = [], disposed = [], archived = [], resumed = [];
  const sessions = new Map([['session-test', session]]), agents = new Map(cold ? [] : [['session-test', agent]]);
  const registry = { archivedSessionIds: archived,
    async archiveSession(id) { if (!archived.includes(id)) archived.push(id); },
    async unarchiveSession(id) { const at = archived.indexOf(id); if (at >= 0) archived.splice(at, 1); },
    list() { return []; },
  };
  const ctx = {
    effect(fn) { fn(); },
    on() {},
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    sessions: { get(id) { return sessions.get(id); }, async flush(subject) { if (flushError) throw flushError; flushed.push(subject.header.id); return true; } },
    agents: {
      get(id) { return agents.get(id); },
      async create() { throw new Error('The toolbar must not create a session.'); },
      async resume(options) {
        if (options.resumeSessionId !== session.header.id) throw new Error('Wrong session resumed.');
        resumed.push(options);
        currentSelection = options.agentOptions;
        agents.set(options.resumeSessionId, agent);
        return { agent, async dispose() { disposed.push(options.resumeSessionId); } };
      },
    },
    sessionQuery: { async observeSession(id) { if (!sessions.has(id)) throw new Error('missing'); return sessions.get(id); },
      async listSessions() { return [...sessions.values()].map(value => ({ header: value.header, events: value.events })); } },
    get(name) { return name === 'workspaceRegistry' ? registry : undefined; },
    llm: {
      listProviders() { return [{ id: 'p' }]; },
      async listModels() { return [{ id: 'm' }]; },
      async *stream(request) { requests.push(request); yield { type: 'text-delta', text: 'translated' }; },
    },
  };
  function seedSession(options) {
      const childEvents = structuredClone(options.seed);
      const childSession = { header: { id: options.sessionId, ...options.meta }, events: childEvents,
        inheritedEventCount: options.inheritedEventCount,
        append(type, data) { const event = { type, seq: childEvents.length, time: Date.now(), data }; childEvents.push(event); dispatch(childSession, event); },
      };
      childSession.append('session/end-seed', { inherited: true });
      let selection = options.agentOptions;
      const child = { session: childSession, ctx: agentContext, options: options.agentOptions,
        inbox: { clear() {} },
        model: { current() { return selection; }, select(value) { selection = value; childSession.append('model/selection', value); } },
        sent: [], followup(message) { if (followupError) throw followupError; this.sent.push(message);
          this.queuedMessage = message;
          if (!deferFollowupMessage) this.appendQueuedMessage(); },
        appendQueuedMessage() {
          if (this.queuedMessage === undefined) throw new Error('no queued message');
          const turn = 1;
          childSession.append('turn/start', { turn });
          childSession.append('user/message', structuredClone(this.queuedMessage));
          this.queuedMessage = undefined;
        },
        async whenIdle() {}, cancel() {}, runMaintenance(fn) { return fn(); },
      };
      sessions.set(options.sessionId, childSession); agents.set(options.sessionId, child);
      children.push(child);
      return { agent: child, async dispose() { disposed.push(options.sessionId); agents.delete(options.sessionId); } };
  }
  apply(ctx);
  async function post(body, raw) {
    const text = raw ?? JSON.stringify({ sessionId: 'session-test', ...body });
    const request = { method: 'POST', url: '/message-toolbar', on(name, listener) {
      if (name === 'data') listener(Buffer.from(text));
      if (name === 'end') listener();
      return this;
    } };
    const response = { status: 0, body: '', headersSent: false, writableEnded: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      write(value) { this.body += value; },
      end(value) { this.body += value ?? ''; this.writableEnded = true; },
    };
    await handler(request, response);
    return { status: response.status, payload: JSON.parse(response.body) };
  }
  function postStream(body) {
    const request = new EventEmitter();
    request.method = 'POST'; request.url = '/message-toolbar';
    const response = new EventEmitter();
    Object.assign(response, { status: 0, body: '', headersSent: false, writableEnded: false, destroyed: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      flushHeaders() {},
      write(value) { if (!this.destroyed) this.body += value; },
      end(value) { this.body += value ?? ''; this.writableEnded = true; },
      close() { this.destroyed = true; this.emit('close'); },
    });
    const completion = handler(request, response);
    request.emit('data', Buffer.from(JSON.stringify({ sessionId: 'session-test', ...body })));
    request.emit('end');
    return { response, completion, close: () => response.close() };
  }
  const emit = (type, payload) => {
    for (const listener of listeners.get(type) ?? []) listener(payload);
  };
  const listenerCount = () => [...listeners.values()].reduce((total, bucket) => total + bucket.size, 0);
  async function get(id = 'session-test') {
    let body = '', status;
    await handler({ method: 'GET', url: `/message-toolbar?sessionId=${encodeURIComponent(id)}` },
      { writeHead(value) { status = value; }, end(value) { body += value; } });
    return { status, payload: JSON.parse(body) };
  }
  return { post, get, postStream, seedSession, handle: handler, events, ctx, agent, session, dispatch, emit, listenerCount, sent, selected, requests,
    children, flushed, disposed, archived, resumed, cancelled: () => cancelled };
}

