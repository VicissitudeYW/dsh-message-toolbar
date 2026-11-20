import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../lib/state-store.js', import.meta.url).href;

function isolated(code, initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-state-regression-'));
  const dir = path.join(home, '.dsh', 'message-toolbar');
  fs.mkdirSync(dir, { recursive: true });
  if (initial !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), initial);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import fs from 'node:fs';
      import path from 'node:path';
      import * as store from ${JSON.stringify(moduleUrl)};
      const file = ${JSON.stringify(path.join(dir, 'state.json'))};
      ${code}
    `], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('corrupt state is reported and never replaced by an empty state', () => {
  const result = isolated(`
    let error;
    try { store.markDeleted('s', {}); store.flushState(); } catch (e) { error=e.message; }
    console.log(JSON.stringify({ error: !!error, contents: fs.readFileSync(file,'utf8') }));
  `, '{broken');
  assert.deepEqual(result, { error: true, contents: '{broken' });
});

test('a newer state schema is preserved until a compatible plugin reads it', () => {
  const initial = '{"schema":999,"deleted":{"precious":{"at":1}}}';
  const result = isolated(`
    let error;
    try { store.markDeleted('s', {}); store.flushState(); } catch (e) { error=e.message; }
    console.log(JSON.stringify({ error: !!error, contents: fs.readFileSync(file,'utf8') }));
  `, initial);
  assert.deepEqual(result, { error: true, contents: initial });
});

test('a throwing state mutation leaves memory and disk unchanged', () => {
  const result = isolated(`
    store.markDeleted('keep', {}); store.flushState();
    const before=fs.readFileSync(file,'utf8');
    try { store.mutateState(s=>{s.deleted.leaked={at:1};throw new Error('reject')}); } catch {}
    store.markDeleted('other', {}); store.flushState();
    console.log(JSON.stringify({ leaked: Object.hasOwn(store.readState().deleted,'leaked'),
      diskLeaked: Object.hasOwn(JSON.parse(fs.readFileSync(file,'utf8')).deleted,'leaked') }));
  `);
  assert.deepEqual(result, { leaked: false, diskLeaked: false });
});

test('a failed flush is observable and a later flush retries the same dirty state', () => {
  const result = isolated(`
    store.readState(); fs.mkdirSync(file);
    store.markDeleted('saved', {});
    let failed=false;try{store.flushState()}catch{failed=true}
    fs.rmdirSync(file);store.flushState();
    console.log(JSON.stringify({failed,saved:fs.existsSync(file)&&!!JSON.parse(fs.readFileSync(file,'utf8')).deleted.saved}));
  `);
  assert.deepEqual(result, { failed: true, saved: true });
});

test('state maps cannot silently serialize as arrays and lose session properties', () => {
  const initial = '{"schema":1,"answers":[]}';
  const result = isolated(`
    let error=false;try{store.setAnswerOverride('s',1,'answer');store.flushState()}catch{error=true}
    console.log(JSON.stringify({error,contents:fs.readFileSync(file,'utf8')}));
  `, initial);
  assert.deepEqual(result, { error: true, contents: initial });
});

for (const maps of [
  { hidden: { s: [] } }, { translations: { s: [] } },
  { translations: { s: { 'turn:1': [] } } }, { answers: { s: { 1: [] } } },
  { prompts: { s: [] } }, { runs: { s: [] } }, { replays: { s: [] } },
]) {
  test('nested state dictionaries are validated before any mutation: ' + JSON.stringify(maps), () => {
    const initial = JSON.stringify({ schema: 1, ...maps });
    const result = isolated(`
      let error=false;try{
        store.setHidden('s','answer',1,true);
        store.storeTranslation('s','turn:1','zh',{text:'kept'});
        store.flushState();
      }catch{error=true}
      console.log(JSON.stringify({error,contents:fs.readFileSync(file,'utf8')}));
    `, initial);
    assert.deepEqual(result, { error: true, contents: initial });
  });
}

test('a singleton answer retains its question identity for the next regeneration', () => {
  const result = isolated(`
    store.recordRun('s',1,2);
    store.setHidden('s','answer',1,true);store.removeRunMember('s',1);
    const root=store.runKeyFor('s',2);
    store.recordRun('s',store.runKeyFor('s',1),3);
    console.log(JSON.stringify({root,turns:store.runsForSession('s')['1']?.turns}));
    store.flushState();
  `);
  assert.deepEqual(result, { root: 1, turns: [2, 3] });
});

test('run selection cannot invent a group for a nonexistent question', () => {
  const result = isolated(`
    let rejected=false;try{store.selectRun('s',1,1)}catch{rejected=true}
    console.log(JSON.stringify({rejected,groups:store.runsForSession('s')}));
    store.flushState();
  `);
  assert.deepEqual(result, { rejected: true, groups: {} });
});

test('UTF-8 BOM state files retain their existing answers', () => {
  const result = isolated(`
    console.log(JSON.stringify({answer:store.answerEntry('s',1)?.override?.text}));
  `, '\uFEFF{"schema":1,"answers":{"s":{"1":{"active":"native","items":[],"override":{"text":"kept"}}}}}');
  assert.deepEqual(result, { answer: 'kept' });
});
