/** Safe, dependency-free execution of collectTurnChanges() plans. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const NO_NEWLINE = '\\ No newline at end of file';
const owns = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const isMissing = (error) => error?.code === 'ENOENT';

function conflict(message) {
  const error = new Error(`无法安全回退，什么都没动：${message}`);
  error.code = 'WORKSPACE_REVERT_CONFLICT';
  return error;
}

function splitText(text) {
  if (text === '') return { lines: [], newline: false };
  const lines = text.split('\n');
  const newline = text.endsWith('\n');
  if (newline) lines.pop();
  // Keep CR in the line body: the host compares on LF and preserves CR there.
  return { lines, newline };
}

function sideOffset(start, count, otherStart) {
  // Standard unified diffs use zero-based insertion anchors on an empty side;
  // the host's whole-file fallback instead uses 1 on both empty/nonempty sides.
  return count === 0 ? (start === 1 && otherStart === 1 ? 0 : start) : start - 1;
}

function parseHunks(hunks) {
  if (!Array.isArray(hunks)) throw conflict('缺少文本差异。');
  let oldEnd = 0;
  let newEnd = 0;
  let delta = 0;
  let reachedEof = false;
  return hunks.map((hunk) => {
    if (reachedEof) throw conflict('文件末尾标记后还有差异。');
    if (!hunk || !['oldStart', 'oldLines', 'newStart', 'newLines'].every((key) => Number.isSafeInteger(hunk[key]) && hunk[key] >= 0)
      || (hunk.oldLines > 0 && hunk.oldStart === 0) || (hunk.newLines > 0 && hunk.newStart === 0) || !Array.isArray(hunk.lines)) {
      throw conflict('文本差异的位置无效。');
    }
    const old = [];
    const next = [];
    let previous;
    let oldNoNewline = false;
    let newNoNewline = false;
    let hasMarker = false;
    for (const line of hunk.lines) {
      if (line === NO_NEWLINE) {
        if (!previous) throw conflict('无效的末尾换行标记。');
        if (previous !== '+') oldNoNewline = true;
        if (previous !== '-') newNoNewline = true;
        previous = undefined;
        hasMarker = true;
        continue;
      }
      if (typeof line !== 'string' || !['+', '-', ' '].includes(line[0]) || line.includes('\n')) throw conflict('文本差异含有无效行。');
      const marker = line[0];
      if ((marker !== '+' && oldNoNewline) || (marker !== '-' && newNoNewline)) throw conflict('末尾换行标记后还有内容。');
      if (marker !== '+') old.push(line.slice(1));
      if (marker !== '-') next.push(line.slice(1));
      previous = marker;
    }
    if (old.length !== hunk.oldLines || next.length !== hunk.newLines) throw conflict('文本差异行数不符。');
    const oldAt = sideOffset(hunk.oldStart, old.length, hunk.newStart);
    const newAt = sideOffset(hunk.newStart, next.length, hunk.oldStart);
    if (oldAt < oldEnd || newAt < newEnd || newAt - oldAt !== delta) throw conflict('文本差异重叠或顺序无效。');
    oldEnd = oldAt + old.length;
    newEnd = newAt + next.length;
    delta += next.length - old.length;
    reachedEof = oldNoNewline || newNoNewline;
    return { old, next, oldAt, newAt, oldNoNewline, newNoNewline, hasMarker };
  });
}

function completeSide(hunks, side) {
  const lines = [];
  let noNewline = false;
  for (const hunk of hunks) {
    const at = side === 'old' ? hunk.oldAt : hunk.newAt;
    const body = side === 'old' ? hunk.old : hunk.next;
    if ((side === 'old' ? hunk.next : hunk.old).length > 0) throw conflict('整文件创建或删除差异与存在状态不符。');
    if (at !== lines.length || noNewline) return undefined;
    for (const line of body) lines.push(line);
    noNewline = side === 'old' ? hunk.oldNoNewline : hunk.newNoNewline;
  }
  // compareText() normalizes EOF. Empty text and an explicit standard marker
  // are the only exact whole-file snapshots that its hunks alone can prove.
  if (lines.length === 0) return '';
  return noNewline ? lines.join('\n') : undefined;
}

function reverseText(text, hunks) {
  const current = splitText(text);
  let restored = current.lines.slice();
  let newline = current.newline;
  let missingEvidence = false;
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    const { next, old, newAt } = hunk;
    if (newAt > current.lines.length || newAt + next.length > current.lines.length
      || next.some((line, at) => current.lines[newAt + at] !== line)) throw conflict('文件中的改动行已被修改。');
    if (hunk.newNoNewline && (newAt + next.length !== current.lines.length || current.newline)) throw conflict('文件末尾已被修改。');
    // With no context on the current side there is no anchor proving where a
    // deletion belongs after later edits. Empty current files are unambiguous.
    if (next.length === 0 && current.lines.length > 0) return { skipped: 'unanchored-hunk' };
    if (newAt + next.length === current.lines.length && old.length > 0) {
      if (hunk.hasMarker) {
        if (next.length > 0 && current.newline === hunk.newNoNewline) throw conflict('文件末尾已被修改。');
        newline = !hunk.oldNoNewline;
      } else if (current.lines.length === 0) missingEvidence = true;
    }
    restored = restored.slice(0, newAt).concat(old, restored.slice(newAt + next.length));
  }
  if (missingEvidence && restored.length > 0) return { skipped: 'missing-exact-snapshot' };
  return { text: restored.length === 0 ? '' : restored.join('\n') + (newline ? '\n' : '') };
}

function targetPath(cwd, name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) throw conflict('文件路径无效。');
  const absolute = path.resolve(cwd, name);
  const relative = path.relative(cwd, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw conflict(`文件在工作区外：${name}`);
  // Reject Windows streams/device aliases and trailing-dot/space aliases.
  if (process.platform === 'win32' && relative.split(path.sep).some((part) => /[<>:"|?*]|[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw conflict(`文件路径有不安全的别名：${name}`);
  return absolute;
}

async function lstatOrNull(name) {
  try { return await fs.lstat(name); } catch (error) { if (isMissing(error)) return null; throw error; }
}

async function inspectPath(root, absolute) {
  const rootNow = await fs.lstat(root.cwd);
  if (rootNow.isSymbolicLink() || !rootNow.isDirectory() || !sameNode(rootNow, root.stat)) throw conflict('工作区路径已改变。');
  const parts = path.relative(root.cwd, absolute).split(path.sep);
  let cursor = root.cwd;
  let stat = rootNow;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    stat = await lstatOrNull(cursor);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) throw conflict(`不回退符号链接或链接目录：${cursor}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw conflict(`文件路径不是普通文件：${cursor}`);
  }
  return stat;
}

async function readState(root, absolute) {
  const stat = await inspectPath(root, absolute);
  if (stat === null) return null;
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameNode(stat, opened)) throw conflict('读取期间文件已改变。');
    const bytes = await handle.readFile();
    const checked = await inspectPath(root, absolute);
    if (checked === null || !sameNode(opened, checked)) throw conflict('读取期间文件路径已改变。');
    return { bytes, stat: opened };
  } finally { await handle.close(); }
}

function statesMatch(a, b) {
  return a === null || b === null ? a === b : sameNode(a.stat, b.stat) && a.bytes.equals(b.bytes);
}

async function verifyState(root, action, expected = action.original) {
  if (!statesMatch(await readState(root, action.absolute), expected)) throw conflict(`文件在预检后又改过了：${action.display}`);
}

async function ensureParents(root, absolute, created) {
  const relative = path.relative(root.cwd, path.dirname(absolute));
  let cursor = root.cwd;
  for (const part of relative === '' ? [] : relative.split(path.sep)) {
    // Preflight may have observed missing directories. Recheck the workspace
    // and every existing ancestor before creating even a staging directory.
    await inspectPath(root, absolute);
    cursor = path.join(cursor, part);
    const existing = await lstatOrNull(cursor);
    if (existing === null) {
      await fs.mkdir(cursor);
      created.push(cursor);
    }
    const checked = await fs.lstat(cursor);
    if (!checked.isDirectory() || checked.isSymbolicLink()) throw conflict('重建目录期间路径已改变。');
  }
  await inspectPath(root, absolute);
}

function temporary(absolute, role) {
  return path.join(path.dirname(absolute), `.${path.basename(absolute)}.revert-${role}-${randomBytes(12).toString('hex')}`);
}

async function removeTemporary(root, name) {
  if (!name) return;
  if (await inspectPath(root, name) !== null) await fs.unlink(name);
}

async function execute(root, actions) {
  const createdDirectories = [];
  try {
    // Every original has already passed preflight. Stage complete replacement
    // files before touching any original, then revalidate the entire plan.
    for (const action of actions) {
      if (action.text === undefined) continue;
      await ensureParents(root, action.absolute, createdDirectories);
      action.stage = temporary(action.absolute, 'stage');
      await fs.writeFile(action.stage, action.text, { flag: 'wx', mode: action.original?.stat.mode ?? 0o666 });
      action.staged = await readState(root, action.stage);
    }
    for (const action of actions) await verifyState(root, action);
    for (const action of actions) {
      await verifyState(root, action);
      if (action.original !== null) {
        // A hard-link backup does not alter original bytes, and fails safely on
        // filesystems that cannot provide it. Exclusive installation below
        // never overwrites a concurrently recreated destination.
        action.backup = temporary(action.absolute, 'backup');
        await fs.link(action.absolute, action.backup);
        await verifyState(root, action);
        await fs.unlink(action.absolute);
        action.removed = true;
      }
      if (action.stage) {
        await inspectPath(root, action.absolute);
        await fs.link(action.stage, action.absolute);
        action.installed = true;
      }
    }
  } catch (cause) {
    const rollbackErrors = [];
    for (const action of actions.slice().reverse()) {
      try {
        if (action.installed) {
          await verifyState(root, action, action.staged);
          await fs.unlink(action.absolute);
          action.installed = false;
        }
        if (action.removed) {
          await inspectPath(root, action.absolute);
          await fs.link(action.backup, action.absolute);
          action.removed = false;
        }
      } catch (error) { rollbackErrors.push(error); }
    }
    for (const action of actions) {
      for (const name of [action.stage, ...(action.removed ? [] : [action.backup])]) {
        try { await removeTemporary(root, name); } catch (error) { rollbackErrors.push(error); }
      }
    }
    for (const directory of createdDirectories.slice().reverse()) {
      try {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink()) throw conflict('清理目录期间路径已改变。');
        await fs.rmdir(directory);
      } catch (error) { if (!isMissing(error) && error.code !== 'ENOTEMPTY') rollbackErrors.push(error); }
    }
    const error = new Error(rollbackErrors.length === 0
      ? '文件回退中途失败；已撤销本次写入，文件内容已还原。'
      : '文件回退中途失败，无法保证全部还原；请检查 recoveryFiles 中的备份，勿再次盲目回退。', { cause });
    error.code = 'WORKSPACE_REVERT_IO';
    error.rollbackComplete = rollbackErrors.length === 0;
    error.rollbackErrors = rollbackErrors;
    error.recoveryFiles = actions.filter((action) => action.removed).map((action) => action.backup);
    throw error;
  }
  const cleanupErrors = [];
  for (const action of actions) {
    for (const name of [action.stage, action.backup]) {
      try { await removeTemporary(root, name); } catch (error) { cleanupErrors.push({ path: name, error }); }
    }
  }
  if (cleanupErrors.length > 0) {
    const error = new Error('文件内容已完成回退，但临时备份清理失败。');
    error.code = 'WORKSPACE_REVERT_CLEANUP';
    error.recoveryFiles = cleanupErrors.map((entry) => entry.path);
    throw error;
  }
}

/**
 * Undo one turn. Existing files are reversed only within validated hunks; bytes
 * outside them, including later edits and the current EOF style, are preserved.
 * Optional beforeText/afterText strings are exact UTF-8 snapshots. In their
 * absence creation/deletion requires fully provable content, otherwise it is
 * explicitly skipped. The DSH normalized diff cannot prove a nonempty EOF.
 *
 * This is best-effort rollback, NOT an atomic filesystem transaction: process
 * death, storage failure, or concurrent path replacement can defeat rollback.
 * Node has no portable openat/renameat conditional transaction. Symlinks and
 * escapes are rejected and every path/content is rechecked before mutation;
 * callers must not treat this as a boundary against a hostile concurrent OS
 * process. Incomplete rollback throws with rollbackComplete=false and backups.
 */
export async function revertWorkspacePlan(plan) {
  if (!plan?.supported) throw new Error(plan?.reason === 'no-service'
    ? '这个 DSH 没有启用 workspace-changes，无法读取这一轮改过哪些文件。'
    : '这一轮的改动没有留下记录，无法回退。');
  if (typeof plan.cwd !== 'string' || !path.isAbsolute(plan.cwd) || !Array.isArray(plan.files)) throw conflict('工作区回退计划无效。');
  const cwd = path.resolve(plan.cwd);
  const stat = await fs.lstat(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict('工作区不是普通目录。');
  const root = { cwd, stat };
  const actions = [];
  const skipped = [];
  const seen = new Set();
  for (const file of plan.files) {
    if (!file || typeof file !== 'object') throw conflict('文件记录无效。');
    const label = { path: file.path, display: file.display };
    const skip = (reason) => skipped.push({ ...label, reason });
    if (file.kind !== 'text') { skip(file.kind); continue; }
    if (typeof file.before !== 'boolean' || typeof file.after !== 'boolean' || (!file.before && !file.after)) throw conflict('文件存在状态无效。');
    const absolute = targetPath(cwd, file.path);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) throw conflict(`同一文件重复出现：${file.display}`);
    seen.add(key);
    const original = await readState(root, absolute);
    const current = original?.bytes.toString('utf8') ?? null;
    if (current !== null && !Buffer.from(current, 'utf8').equals(original.bytes)) throw conflict(`文件不是完整 UTF-8 文本：${file.display}`);
    for (const side of ['before', 'after']) {
      if (owns(file, `${side}Text`) && (typeof file[`${side}Text`] !== 'string' && file[`${side}Text`] !== null
        || (file[`${side}Text`] !== null) !== file[side])) throw conflict('完整文件快照与存在状态不符。');
    }
    if (!file.before && original === null) { skip('already-gone'); continue; }
    if (file.after === false && original !== null || file.before && file.after && original === null) throw conflict(`文件存在状态已改变：${file.display}`);
    let text;
    let action;
    if (!file.before) {
      const expected = owns(file, 'afterText') ? file.afterText : completeSide(parseHunks(file.hunks), 'next');
      if (expected === undefined) { skip('missing-exact-snapshot'); continue; }
      if (current !== expected) throw conflict(`新建文件后来又改过了：${file.display}`);
      action = 'deleted';
    } else if (!file.after) {
      text = owns(file, 'beforeText') ? file.beforeText : completeSide(parseHunks(file.hunks), 'old');
      if (text === undefined) { skip('missing-exact-snapshot'); continue; }
      action = 'recreate';
    } else {
      if (owns(file, 'beforeText') && owns(file, 'afterText')) {
        if (current !== file.afterText) throw conflict(`文件后来又改过了：${file.display}`);
        text = file.beforeText;
      } else {
        const reversed = reverseText(current, parseHunks(file.hunks));
        if (reversed.skipped) { skip(reversed.skipped); continue; }
        text = reversed.text;
      }
      if (text === current) { skip('unchanged'); continue; }
      action = 'restore';
    }
    actions.push({ ...label, absolute, original, action, text });
  }
  await execute(root, actions);
  return { turn: plan.turn, reverted: actions.map(({ path: name, display, action }) => ({ path: name, display, action })), skipped, cwd: plan.cwd };
}
