import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { revertWorkspacePlan } from '../lib/workspace-revert.js';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'toolbar-revert-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const hunk = (oldStart, oldLines, newStart, newLines, lines) => ({ oldStart, oldLines, newStart, newLines, lines });
const file = (name, hunks, extra = {}) => ({ path: name, display: name, kind: 'text', before: true, after: true, hunks, ...extra });
const plan = (cwd, files) => ({ turn: 2, supported: true, cwd, files });
const missing = async (name) => assert.rejects(fs.stat(name), { code: 'ENOENT' });

test('created file edited after the turn is never deleted', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'user revision\n');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('new.txt', [hunk(0, 0, 1, 1, ['+created'])], { before: false, afterText: 'created\n' })])));
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'user revision\n');
});

test('exact after snapshot authorizes deletion of a created file', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'created\r\n');
  const result = await revertWorkspacePlan(plan(cwd, [file('new.txt', [], { before: false, afterText: 'created\r\n' })]));
  await missing(path.join(cwd, 'new.txt'));
  assert.deepEqual(result, { turn: 2, cwd, reverted: [{ path: 'new.txt', display: 'new.txt', action: 'deleted' }], skipped: [] });
});

test('created-file EOF-only edits conflict with the exact after snapshot', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'created');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('new.txt', [], { before: false, afterText: 'created\n' })])));
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'created');
});

test('normalized creation diff without exact EOF evidence is skipped', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'created\n');
  const result = await revertWorkspacePlan(plan(cwd, [file('new.txt', [hunk(0, 0, 1, 1, ['+created'])], { before: false })]));
  assert.equal(result.skipped[0]?.reason, 'missing-exact-snapshot');
  assert.deepEqual(result.reverted, []);
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'created\n');
});

test('deleted file is recreated byte-for-byte from exact before snapshot', async (t) => {
  const cwd = await workspace(t);
  const result = await revertWorkspacePlan(plan(cwd, [file('deep/deleted.txt', [], { after: false, beforeText: 'first\r\nlast' })]));
  assert.equal(await fs.readFile(path.join(cwd, 'deep/deleted.txt'), 'utf8'), 'first\r\nlast');
  assert.equal(result.reverted[0].action, 'recreate');
});

test('deleted file rebuilt later by the user is never overwritten', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'deleted.txt'), 'later recreation\n');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('deleted.txt', [hunk(1, 1, 0, 0, ['-old'])], { after: false, beforeText: 'old\n' })])));
  assert.equal(await fs.readFile(path.join(cwd, 'deleted.txt'), 'utf8'), 'later recreation\n');
});

test('normalized deletion diff with unknowable EOF is skipped', async (t) => {
  const cwd = await workspace(t);
  const result = await revertWorkspacePlan(plan(cwd, [file('deleted.txt', [hunk(1, 1, 0, 0, ['-old'])], { after: false })]));
  assert.equal(result.skipped[0]?.reason, 'missing-exact-snapshot');
  await missing(path.join(cwd, 'deleted.txt'));
});

test('empty created and deleted files can be reverted without guessing EOF', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'created.txt'), '');
  const result = await revertWorkspacePlan(plan(cwd, [file('created.txt', [], { before: false }), file('deleted.txt', [], { after: false })]));
  await missing(path.join(cwd, 'created.txt'));
  assert.equal(await fs.readFile(path.join(cwd, 'deleted.txt'), 'utf8'), '');
  assert.equal(result.reverted.length, 2);
});

test('zero-line newStart=0 restores a deleted first line without a negative index', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'empty.txt'), '');
  await revertWorkspacePlan(plan(cwd, [file('empty.txt', [hunk(1, 1, 0, 0, ['-original', '\\ No newline at end of file'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'empty.txt'), 'utf8'), 'original');
});

test('pure additions and changes to the first line reverse at their exact positions', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'inserted\nold\n');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'new\nsecond\n');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(0, 0, 1, 1, ['+inserted'])]), file('b.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'old\nsecond\n');
});

test('edits and append outside recorded hunks remain byte-for-byte intact', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'user prefix\nnew\nuser append\n');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(2, 1, 2, 1, ['-old', '+new'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'user prefix\nold\nuser append\n');
});

test('CRLF and mixed line endings outside a hunk are preserved', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new\r\nuntouched\nlast');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old\r', '+new\r'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old\r\nuntouched\nlast');
});

test('no-newline markers are metadata rather than literal file content', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old');
});

test('an explicit no-newline whole deletion can be recreated from its hunk', async (t) => {
  const cwd = await workspace(t);
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 2, 0, 0, ['-first\r', '-last', '\\ No newline at end of file'])], { after: false })]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'first\r\nlast');
});

test('one conflicting file prevents writes to every other file', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new\n');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'user\n');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])]), file('b.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])])])));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new\n');
});

test('relative and absolute paths outside the workspace are rejected', async (t) => {
  const root = await workspace(t);
  const cwd = path.join(root, 'workspace');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(root, 'outside.txt'), 'new\n');
  for (const name of ['../outside.txt', path.join(root, 'outside.txt')]) {
    await assert.rejects(revertWorkspacePlan(plan(cwd, [file(name, [hunk(1, 1, 1, 1, ['-old', '+new'])])])));
    assert.equal(await fs.readFile(path.join(root, 'outside.txt'), 'utf8'), 'new\n');
  }
});

test('symlinked parent directories cannot redirect writes outside the workspace', async (t) => {
  const root = await workspace(t);
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'a.txt'), 'new\n');
  await fs.symlink(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('link/a.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])])])));
  assert.equal(await fs.readFile(path.join(outside, 'a.txt'), 'utf8'), 'new\n');
});

test('overlapping or malformed hunks are rejected before mutation', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new\n');
  for (const hunks of [[hunk(1, 2, 1, 1, ['-old', '+new'])], [hunk(1, 1, 1, 1, ['-old', '+new']), hunk(1, 1, 1, 1, ['-old', '+new'])]]) {
    await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', hunks)])));
    assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new\n');
  }
});

test('mid-commit I/O failure rolls back earlier changes and reports the outcome', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new a\n');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'new b\n');
  const realLink = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (source, target) => {
    if (target === path.join(cwd, 'b.txt') && source.includes('.revert-stage-')) {
      const error = new Error('injected storage failure');
      error.code = 'EIO';
      throw error;
    }
    return realLink(source, target);
  });
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old a', '+new a'])]), file('b.txt', [hunk(1, 1, 1, 1, ['-old b', '+new b'])])])), (error) => error.code === 'WORKSPACE_REVERT_IO' && error.rollbackComplete === true);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new a\n');
  assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'new b\n');
  assert.deepEqual((await fs.readdir(cwd)).sort(), ['a.txt', 'b.txt']);
});

test('inconsistent creation and deletion hunks cannot authorize whole-file writes', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'new');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('new.txt', [hunk(1, 1, 1, 1, ['-old', '+new', '\\ No newline at end of file'])], { before: false })])));
  assert.equal(await fs.readFile(path.join(cwd, 'new.txt'), 'utf8'), 'new');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('deleted.txt', [hunk(1, 1, 1, 1, ['-old', '\\ No newline at end of file', '+new'])], { after: false })])));
  await missing(path.join(cwd, 'deleted.txt'));
});

test('large whole-file replacement is not limited by JavaScript argument count', async (t) => {
  const cwd = await workspace(t);
  const count = 180000;
  await fs.writeFile(path.join(cwd, 'large.txt'), 'new\n');
  await revertWorkspacePlan(plan(cwd, [file('large.txt', [hunk(1, count, 1, 1, [...Array(count).fill('-old'), '+new'])])]));
  const actual = await fs.readFile(path.join(cwd, 'large.txt'), 'utf8');
  assert.equal(actual, 'old\n'.repeat(count));
});

test('a later hunk cannot follow a claimed old-side EOF marker', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new\nsecond\n');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [
    hunk(1, 1, 1, 1, ['-old', '\\ No newline at end of file', '+new']),
    hunk(2, 1, 2, 1, ['-other', '+second']),
  ])])));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new\nsecond\n');
});

test('rollback preserves a concurrent edit and reports its retained recovery backup', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new a\n');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'new b\n');
  const realLink = fs.link.bind(fs);
  t.mock.method(fs, 'link', async (source, target) => {
    if (target === path.join(cwd, 'b.txt') && source.includes('.revert-stage-')) {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'concurrent user edit\n');
      throw Object.assign(new Error('injected storage failure'), { code: 'EIO' });
    }
    return realLink(source, target);
  });
  let thrown;
  try {
    await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old a', '+new a'])]), file('b.txt', [hunk(1, 1, 1, 1, ['-old b', '+new b'])])]));
  } catch (error) { thrown = error; }
  assert.equal(thrown?.code, 'WORKSPACE_REVERT_IO');
  assert.equal(thrown.rollbackComplete, false);
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'concurrent user edit\n');
  assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'new b\n');
  assert.equal(thrown.recoveryFiles.length, 1);
  assert.equal(await fs.readFile(thrown.recoveryFiles[0], 'utf8'), 'new a\n');
});

test('all files are rechecked after staging and before any original is modified', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new a\n');
  await fs.writeFile(path.join(cwd, 'b.txt'), 'new b\n');
  const realWrite = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (name, ...args) => {
    await realWrite(name, ...args);
    if (name.includes('.a.txt.revert-stage-')) await realWrite(path.join(cwd, 'b.txt'), 'concurrent edit\n');
  });
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old a', '+new a'])]), file('b.txt', [hunk(1, 1, 1, 1, ['-old b', '+new b'])])])));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new a\n');
  assert.equal(await fs.readFile(path.join(cwd, 'b.txt'), 'utf8'), 'concurrent edit\n');
  assert.deepEqual((await fs.readdir(cwd)).sort(), ['a.txt', 'b.txt']);
});

test('unanchored zero-line hunks on nonempty files are explicitly skipped', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'user changed line\n');
  const result = await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 0, 0, ['-old'])])]));
  assert.equal(result.skipped[0]?.reason, 'unanchored-hunk');
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'user changed line\n');
});

test('different hunks use original new-side offsets when reversed in order', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new1\ninserted\nmiddle\nnew2\n');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 2, ['-old1', '+new1', '+inserted']), hunk(3, 1, 4, 1, ['-old2', '+new2'])])]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old1\nmiddle\nold2\n');
});

test('duplicate file aliases are rejected before either operation is applied', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'new\n');
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])]), file('./a.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])])])));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new\n');
});

test('invalid UTF-8 is never replaced by a lossy text decode', async (t) => {
  const cwd = await workspace(t);
  const bytes = Buffer.from([0xff, 0x0a]);
  await fs.writeFile(path.join(cwd, 'a.txt'), bytes);
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(1, 1, 1, 1, ['-old', '+�'])])])));
  assert.deepEqual(await fs.readFile(path.join(cwd, 'a.txt')), bytes);
});

test('already missing created files and nontext entries keep their original skip reasons', async (t) => {
  const cwd = await workspace(t);
  const result = await revertWorkspacePlan(plan(cwd, [file('gone.txt', [], { before: false }), file('binary.dat', [], { kind: 'binary' }), file('large.dat', [], { kind: 'oversized' })]));
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ['already-gone', 'binary', 'oversized']);
  assert.deepEqual(result.reverted, []);
});

test('unsupported plans are rejected without accessing the filesystem', async () => {
  await assert.rejects(revertWorkspacePlan({ supported: false, reason: 'no-service' }), /workspace-changes/);
  await assert.rejects(revertWorkspacePlan({ supported: false, reason: 'not-recorded' }), /没有留下记录/);
});

test('a workspace swapped for a symlink after preflight cannot receive staged directories', async (t) => {
  const root = await workspace(t);
  const cwd = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  const realLstat = fs.lstat.bind(fs);
  const realMkdir = fs.mkdir.bind(fs);
  let swapped = false;
  let outsideWasTouched = false;
  t.mock.method(fs, 'lstat', async (name, ...args) => {
    try { return await realLstat(name, ...args); } catch (error) {
      if (!swapped && name === path.join(cwd, 'nested') && error.code === 'ENOENT') {
        swapped = true;
        await fs.rename(cwd, path.join(root, 'old-workspace'));
        await fs.symlink(outside, cwd, process.platform === 'win32' ? 'junction' : 'dir');
      }
      throw error;
    }
  });
  t.mock.method(fs, 'mkdir', async (name, ...args) => {
    const result = await realMkdir(name, ...args);
    if (name === path.join(cwd, 'nested')) outsideWasTouched = (await realLstat(path.join(outside, 'nested'))).isDirectory();
    return result;
  });
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('nested/deleted.txt', [], { after: false, beforeText: 'old\n' })])));
  assert.equal(outsideWasTouched, false);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a symlink at the file itself is rejected without touching its target', async (t) => {
  const cwd = await workspace(t);
  const target = path.join(cwd, 'real.txt');
  await fs.writeFile(target, 'new\n');
  try { await fs.symlink(target, path.join(cwd, 'link.txt'), 'file'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('Host does not grant file-symlink privileges'); return; }
    throw error;
  }
  await assert.rejects(revertWorkspacePlan(plan(cwd, [file('link.txt', [hunk(1, 1, 1, 1, ['-old', '+new'])])])));
  assert.equal(await fs.readFile(target, 'utf8'), 'new\n');
  assert.equal((await fs.lstat(path.join(cwd, 'link.txt'))).isSymbolicLink(), true);
});

test('exact snapshots restore an existing file including its EOF byte', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'after\n');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [], { beforeText: 'before', afterText: 'after\n' })]));
  assert.equal(await fs.readFile(path.join(cwd, 'a.txt'), 'utf8'), 'before');
});

test('a created file with an explicit EOF marker is completely verified before deletion', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'a.txt'), 'last');
  await revertWorkspacePlan(plan(cwd, [file('a.txt', [hunk(0, 0, 1, 1, ['+last', '\\ No newline at end of file'])], { before: false })]));
  await missing(path.join(cwd, 'a.txt'));
});
