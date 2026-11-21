// Native branch attachment and save/send contract coverage.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-attachment-host-'));
process.env.USERPROFILE = home; process.env.HOME = home;
const { harness, history } = await import('./helpers/host-harness.mjs');
const store = await import('../lib/state-store.js');
after(() => { store.flushState(); fs.rmSync(home, { recursive: true, force: true }); });
const oldFile = { type: 'file', attachment: { attachmentId: 'old', name: 'old.pdf' } };
const newFile = { type: 'image', attachment: { attachmentId: 'new', name: 'new.png' } };
function setup() {
  store.flushState(); fs.rmSync(path.join(home, '.dsh/message-toolbar/state.json'), { force: true }); store.reloadState();
  const events = history(); events[5].data.content.push(structuredClone(oldFile)); return harness(events);
}

test('retry preserves native attachments when no replacement is supplied', async () => {
  const h = setup();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 2 });
  assert.equal(response.status, 200, response.payload.error);
  const queued = h.children[0].sent;
  assert.equal(queued.length, 1); assert.deepEqual(queued[0].content, [{ type: 'text', text: 'question 2' }, oldFile]);
  assert.equal(queued[0].source.kind, 'user'); assert.notEqual(queued[0].id, 'u2'); assert.equal(h.sent.length, 0);
});

test('atomic Send uses the final editor attachment list and revised text exactly once', async () => {
  const h = setup();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 2, text: 'revised', files: [newFile] });
  assert.equal(response.status, 200, response.payload.error);
  assert.equal(h.children[0].sent.length, 1);
  assert.deepEqual(h.children[0].sent[0].content, [{ type: 'text', text: 'revised' }, newFile]);
  assert.deepEqual(h.events[5].data.content, [{ type: 'text', text: 'question 2' }, oldFile]);
});

test('saving a question persists attachments without generation and a later retry reads that branch', async () => {
  const h = setup();
  const saved = await h.post({ action: 'context-branch', operation: 'edit-prompt', turn: 2, text: 'saved', files: [oldFile, newFile] });
  assert.equal(saved.status, 200, saved.payload.error); assert.equal(h.children[0].sent.length, 0);
  const state = await h.get(saved.payload.sessionId);
  assert.deepEqual(state.payload.promptAttachments['2'], [oldFile, newFile]);
  const retried = await h.post({ action: 'context-branch', operation: 'retry', sessionId: saved.payload.sessionId, turn: 2 });
  assert.equal(retried.status, 200, retried.payload.error);
  assert.deepEqual(h.children[1].sent[0].content, [{ type: 'text', text: 'saved' }, oldFile, newFile]);
});

test('saving an empty attachment list removes files from subsequent model input', async () => {
  const h = setup();
  const saved = await h.post({ action: 'context-branch', operation: 'edit-prompt', turn: 2, text: 'text only', files: [] });
  await h.post({ action: 'context-branch', operation: 'retry', sessionId: saved.payload.sessionId, turn: 2 });
  assert.deepEqual(h.children[1].sent[0].content, [{ type: 'text', text: 'text only' }]);
});

test('attachment-only questions can be saved and sent without an empty text block', async () => {
  const h = setup();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 2, text: '', files: [newFile] });
  assert.equal(response.status, 200, response.payload.error);
  assert.deepEqual(h.children[0].sent[0].content, [newFile]);
});

test('malformed attachments fail before a child or native followup is created', async () => {
  for (const files of ['bad', [{ type: 'text', text: 'bad' }], [{ type: 'file', attachment: { name: 'no-id' } }]]) {
    const h = setup();
    const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 2, files });
    assert.equal(response.status, 400); assert.equal(h.children.length, 0); assert.equal(h.sent.length, 0);
  }
});

test('legacy prompt attachments migrate into the new durable question', async () => {
  const h = setup();
  store.setPromptOverride('session-test', 2, 'legacy saved', [newFile]);
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 2 });
  assert.equal(response.status, 200, response.payload.error);
  assert.deepEqual(h.children[0].sent[0].content, [{ type: 'text', text: 'legacy saved' }, newFile]);
});
