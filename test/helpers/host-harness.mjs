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

export function harness(events = history(), { followupError } = {}) {
  let handler;
  const sent = [], selected = [], requests = [];
  const listeners = new Map();
  let cancelled = 0;
  let currentSelection = { provider: 'p', model: 'original', reasoningEffort: 'medium' };
  const dispatch = (subject, event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(subject, event);
  };
  const session = { header: { id: 'session-test', cwd: os.homedir() }, events, append(type, data) {
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
    ctx: agentContext,
    session,
    model: {
      current() { return currentSelection && { ...currentSelection }; },
      select(selection) { selected.push(selection); currentSelection = { ...selection }; session.append('model/selection', selection); },
    },
    followup(message) { if (followupError) throw followupError; sent.push(message); },
    runMaintenance(fn) { return fn(); },
    cancel() { cancelled++; },
    async whenIdle() {},
  };
  const ctx = {
    effect(fn) { fn(); },
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    sessions: { get() { return undefined; } },
    agents: { get(id) { return id === 'session-test' ? agent : undefined; } },
    sessionQuery: { async observeSession(id) { if (id !== 'session-test') throw new Error('missing'); return session; } },
    get() { return undefined; },
    llm: {
      listProviders() { return [{ id: 'p' }]; },
      async listModels() { return [{ id: 'm' }]; },
      async *stream(request) { requests.push(request); yield { type: 'text-delta', text: 'translated' }; },
    },
  };
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
  return { post, postStream, handle: handler, events, ctx, agent, session, dispatch, emit, listenerCount, sent, selected, requests, cancelled: () => cancelled };
}

