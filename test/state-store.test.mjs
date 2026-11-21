import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const moduleUrl = new URL('../lib/state-store.js', import.meta.url).href;
const durableModuleUrl = new URL('../lib/durable-state.js', import.meta.url).href;

function runNode(home, code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function isolated(code, initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-state-regression-'));
  const dir = path.join(home, '.dsh', 'message-toolbar');
  fs.mkdirSync(dir, { recursive: true });
  if (initial !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), initial);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import fs from 'node:fs';
      import path from 'node:path';
      import { spawnSync } from 'node:child_process';
      import * as store from ${JSON.stringify(moduleUrl)};
      import { createDurableState } from ${JSON.stringify(durableModuleUrl)};
      const file = ${JSON.stringify(path.join(dir, 'state.json'))};
      ${code}
    `], { encoding: 'utf8', timeout: 15000, env: { ...process.env, USERPROFILE: home, HOME: home } });
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

for (const firstWriter of ['delete', 'append']) {
  test(`concurrent answer deletion and replay preserve the original answer (${firstWriter} flushes first)`, () => {
    const result = isolated(`
      store.recordRun('s',1,2);store.flushState();
      const deleting=await import(${JSON.stringify(moduleUrl + '?deleting')});
      const appending=await import(${JSON.stringify(moduleUrl + '?appending')});
      deleting.readState();appending.readState();
      deleting.setHidden('s','answer',2,true);deleting.removeRunMember('s',2);
      appending.recordRun('s',1,3,{provider:'p',model:'new'});
      if (${JSON.stringify(firstWriter)} === 'delete') { deleting.flushState();appending.flushState(); }
      else { appending.flushState();deleting.flushState(); }
      const group=store.runsForSession('s')['1'];
      console.log(JSON.stringify({turns:group?.turns,active:group?.active,models:group?.models,hidden:store.readState().hidden.s.answers}));
    `);
    assert.deepEqual(result, { turns: [1, 3], active: 3, models: { 3: { provider: 'p', model: 'new' } }, hidden: [2] });
  });
}

test('a dirty reader reconciles answer groups after another instance appends an answer', () => {
  const result = isolated(`
    store.recordRun('s',1,2);store.flushState();
    const deleting=await import(${JSON.stringify(moduleUrl + '?deleting')});
    deleting.setHidden('s','answer',1,true);deleting.removeRunMember('s',1);
    store.recordRun('s',1,3);store.flushState();
    const turns=deleting.runsForSession('s')['1']?.turns;
    deleting.flushState();
    console.log(JSON.stringify({turns,persisted:store.runsForSession('s')['1']?.turns}));
  `);
  assert.deepEqual(result, { turns: [2, 3], persisted: [2, 3] });
});

test('a merged reconciliation never recreates a deliberately dropped answer group', () => {
  const result = isolated(`
    store.recordRun('s',1,2);store.flushState();
    store.dropRun('s',1);store.flushState();
    store.markDeleted('other',{});store.flushState();store.reloadState();
    console.log(JSON.stringify({groups:store.runsForSession('s'),root:store.runKeyFor('s',2)}));
  `);
  assert.deepEqual(result, { groups: {}, root: 1 });
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

test('parallel DSH processes preserve different sessions and concurrent hidden additions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-state-concurrent-'));
  const stateFile = path.join(home, '.dsh', 'message-toolbar', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 1,
    hidden: { 'shared-session': { turns: [], answers: [99], prompts: [] } },
    answers: { 'shared-session': { 1: { active: 'native', items: [] } } },
  }));
  const code = (id, first, last) => `
    import fs from 'node:fs';
    import path from 'node:path';
    import * as store from ${JSON.stringify(moduleUrl)};
    const home=${JSON.stringify(home)};
    store.readState();
    fs.writeFileSync(path.join(home, 'ready-${id}'), 'ready');
    while (!fs.existsSync(path.join(home, 'ready-${id === 'a' ? 'b' : 'a'}'))) await new Promise(resolve=>setTimeout(resolve, 1));
    store.markDeleted('process-${id}', {});
    ${id === 'a' ? "store.setHidden('shared-session','answer',99,false);" : ''}
    for (let turn=${first}; turn<=${last}; turn++) store.setHidden('shared-session','answer',turn,true);
    store.mutateState(state=>state.answers['shared-session']['1'].items.push({id:'answer-${id}',kind:'model',text:'${id}'}));
    fs.writeFileSync(path.join(home, 'mutated-${id}'), 'ready');
    while (!fs.existsSync(path.join(home, 'mutated-${id === 'a' ? 'b' : 'a'}'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
    store.flushState();
  `;
  try {
    const results = await Promise.all([
      runNode(home, code('a', 1, 20)),
      runNode(home, code('b', 21, 40)),
    ]);
    assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'));
    const state = JSON.parse(fs.readFileSync(path.join(home, '.dsh', 'message-toolbar', 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(state.deleted).sort(), ['process-a', 'process-b']);
    assert.deepEqual(state.hidden['shared-session'].answers, Array.from({ length: 40 }, (_, index) => index + 1));
    assert.deepEqual(state.answers['shared-session']['1'].items.map((item) => item.id).sort(), ['answer-a', 'answer-b']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('parallel first answer alternatives for the same turn are both preserved', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-state-answer-race-'));
  const stateFile = path.join(home, '.dsh', 'message-toolbar', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ schema: 1 }));
  const code = (id) => `
    import * as store from ${JSON.stringify(moduleUrl)};
    store.readState();
    const fs=await import('node:fs');
    const path=await import('node:path');
    const home=${JSON.stringify(home)};
    store.storeAnswer('shared-session',1,{id:'answer-${id}',kind:'model',text:'${id}'});
    fs.writeFileSync(path.join(home,'ready-${id}'),'ready');
    while(!fs.existsSync(path.join(home,'ready-${id === 'a' ? 'b' : 'a'}'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
    store.flushState();
  `;
  try {
    const results = await Promise.all([runNode(home, code('a')), runNode(home, code('b'))]);
    assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'));
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(state.answers['shared-session']['1'].items.map((item) => item.id).sort(), ['answer-a', 'answer-b']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an already loaded store refreshes after another process commits state', () => {
  const result = isolated(`
    store.deletedVersionIds();
    store.markDeleted('local',{});
    const childCode=${JSON.stringify(`import * as store from ${JSON.stringify(moduleUrl)}; store.markDeleted("external",{}); store.flushState();`)};
    const child=spawnSync(process.execPath,['--input-type=module','--eval',
      childCode],
      {encoding:'utf8',env:{...process.env,USERPROFILE:path.dirname(path.dirname(path.dirname(file))),HOME:path.dirname(path.dirname(path.dirname(file)))}});
    if(child.status!==0)throw Error(child.stderr);
    const ids=[...store.deletedVersionIds()].sort();
    store.flushState();
    console.log(JSON.stringify({ids}));
  `);
  assert.deepEqual(result, { ids: ['external', 'local'] });
});

test('a state replacement during a read cannot pin stale data in the warm cache', () => {
  const result = isolated(`
    fs.writeFileSync(file,JSON.stringify({value:1}));
    const durable=createDurableState(file,{empty:()=>({}),normalize:value=>value});
    const original=fs.readFileSync;
    let armed=true;
    fs.readFileSync=function(source,...args){
      const value=original.call(this,source,...args);
      if(armed){
        armed=false;
        fs.writeFileSync(file+'.replacement',JSON.stringify({value:2}));
        fs.renameSync(file+'.replacement',file);
      }
      return value;
    };
    durable.read();
    fs.readFileSync=original;
    console.log(JSON.stringify({value:durable.read().value}));
  `);
  assert.deepEqual(result, { value: 2 });
});

test('an answer text edit does not overwrite a concurrent model metadata edit', () => {
  const result = isolated(`
    fs.writeFileSync(file,JSON.stringify({items:[{id:'answer',text:'before',model:'old'}]}));
    const options={empty:()=>({items:[]}),normalize:value=>value,delay:10000};
    const first=createDurableState(file,options), second=createDurableState(file,options);
    first.mutate(state=>{state.items[0].text='edited'});
    second.mutate(state=>{state.items[0].model='new'});
    second.flush();first.flush();
    console.log(fs.readFileSync(file,'utf8'));
    first.reload();second.reload();
  `);
  assert.deepEqual(result, { items: [{ id: 'answer', text: 'edited', model: 'new' }] });
});

test('removing the final local translation preserves a concurrent translation in that session', () => {
  const result = isolated(`
    fs.writeFileSync(file,JSON.stringify({shown:{s:{'1':'zh'}}}));
    const options={empty:()=>({shown:{}}),normalize:value=>value,delay:10000};
    const first=createDurableState(file,options), second=createDurableState(file,options);
    first.mutate(state=>{delete state.shown.s});
    second.mutate(state=>{state.shown.s['2']='ja'});
    second.flush();first.flush();
    console.log(fs.readFileSync(file,'utf8'));
    first.reload();second.reload();
  `);
  assert.deepEqual(result, { shown: { s: { '2': 'ja' } } });
});

test('a live state lock times out without replacing data, then the mutation can retry', () => {
  const result = isolated(`
    const durable=createDurableState(file,{empty:()=>({value:0}),normalize:value=>value,delay:10000,staleLockMs:1,lockTimeoutMs:30,lockPollMs:2});
    durable.mutate(state=>{state.value=1});
    fs.writeFileSync(file+'.lock',JSON.stringify({pid:process.pid,token:'holder',createdAt:Date.now()-10000}));
    let code;try{durable.flush()}catch(error){code=error.code}
    const missing= !fs.existsSync(file);
    fs.unlinkSync(file+'.lock');
    durable.flush();
    const value=JSON.parse(fs.readFileSync(file,'utf8')).value;
    durable.reload();
    console.log(JSON.stringify({code,missing,value}));
  `);
  assert.deepEqual(result, { code: 'MTT_STATE_LOCK_TIMEOUT', missing: true, value: 1 });
});

test('an ownerless state lock is preserved rather than reaped as a dead process', () => {
  const result = isolated(`
    const durable=createDurableState(file,{empty:()=>({value:0}),normalize:value=>value,delay:10000,staleLockMs:1,lockTimeoutMs:20,lockPollMs:2});
    fs.writeFileSync(file+'.lock','');
    const old=new Date(Date.now()-10000);
    fs.utimesSync(file+'.lock',old,old);
    durable.mutate(state=>{state.value=3});
    let code;try{durable.flush()}catch(error){code=error.code}
    const preserved=fs.existsSync(file+'.lock')&&fs.readFileSync(file+'.lock','utf8')==='';
    const missing=!fs.existsSync(file);
    durable.reload();
    console.log(JSON.stringify({code,preserved,missing}));
  `);
  assert.deepEqual(result, { code: 'MTT_STATE_LOCK_TIMEOUT', preserved: true, missing: true });
});

test('a dead process lock is reclaimed before state is committed', () => {
  const result = isolated(`
    const durable=createDurableState(file,{empty:()=>({value:0}),normalize:value=>value,delay:10000,staleLockMs:1,lockTimeoutMs:100,lockPollMs:2});
    const dead=spawnSync(process.execPath,['--eval','process.exit(0)']);
    fs.writeFileSync(file+'.lock',JSON.stringify({pid:dead.pid,token:'dead-owner',createdAt:Date.now()-1000}));
    durable.mutate(state=>{state.value=2});
    durable.flush();
    const exists=fs.existsSync(file+'.lock');
    const value=JSON.parse(fs.readFileSync(file,'utf8')).value;
    durable.reload();
    console.log(JSON.stringify({exists,value}));
  `);
  assert.deepEqual(result, { exists: false, value: 2 });
});

test('a dead lock cleanup owner is reclaimed without losing the pending state', () => {
  const result = isolated(`
    const durable=createDurableState(file,{empty:()=>({value:0}),normalize:value=>value,delay:10000,staleLockMs:1,lockTimeoutMs:100,lockPollMs:2});
    const dead=spawnSync(process.execPath,['--eval','process.exit(0)']);
    fs.writeFileSync(file+'.lock',JSON.stringify({pid:dead.pid,token:'dead-owner',createdAt:Date.now()-10000}));
    fs.mkdirSync(file+'.lock.reaper');
    fs.writeFileSync(path.join(file+'.lock.reaper','owner-'+dead.pid+'-11111111-1111-1111-1111-111111111111'),'');
    durable.mutate(state=>{state.value=4});durable.flush();
    const value=JSON.parse(fs.readFileSync(file,'utf8')).value;
    durable.reload();
    console.log(JSON.stringify({value,lock:fs.existsSync(file+'.lock'),reaper:fs.existsSync(file+'.lock.reaper')}));
  `);
  assert.deepEqual(result, { value: 4, lock: false, reaper: false });
});

test('a suspended live cleanup owner is not replaced by another reaper', () => {
  const result = isolated(`
    const durable=createDurableState(file,{empty:()=>({value:0}),normalize:value=>value,delay:10000,staleLockMs:1,lockTimeoutMs:20,lockPollMs:2});
    const dead=spawnSync(process.execPath,['--eval','process.exit(0)']);
    const lock=JSON.stringify({pid:dead.pid,token:'dead-owner',createdAt:Date.now()-10000});
    fs.writeFileSync(file+'.lock',lock);
    fs.mkdirSync(file+'.lock.reaper');
    const marker=path.join(file+'.lock.reaper','owner-'+process.pid+'-11111111-1111-1111-1111-111111111111');
    fs.writeFileSync(marker,'');
    durable.mutate(state=>{state.value=5});
    let code;try{durable.flush()}catch(error){code=error.code}
    durable.reload();
    console.log(JSON.stringify({code,preserved:fs.readFileSync(file+'.lock','utf8')===lock&&fs.existsSync(marker),missing:!fs.existsSync(file)}));
  `);
  assert.deepEqual(result, { code: 'MTT_STATE_LOCK_TIMEOUT', preserved: true, missing: true });
});
