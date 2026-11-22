import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleepSync = (milliseconds) => {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  if (!plainRecord(left) || !plainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

function arrayItemKey(item) {
  if (item === null || typeof item !== 'object') return `value:${JSON.stringify(item)}`;
  if (typeof item.id === 'string') return `id:${item.id}`;
  const attachmentId = item.attachment?.attachmentId;
  if ((item.type === 'file' || item.type === 'image') && typeof attachmentId === 'string') {
    return `attachment:${item.type}:${attachmentId}`;
  }
  return undefined;
}

function mergeArray(current, before, after) {
  const items = [...current, ...before, ...after];
  const keys = items.map(arrayItemKey);
  const keyed = keys.every((key) => key !== undefined)
    && [current, before, after].every((array) => new Set(array.map(arrayItemKey)).size === array.length);
  if (!keyed) {
    const removed = before.filter((item) => !after.some((candidate) => equal(candidate, item)));
    const added = after.filter((item) => !before.some((candidate) => equal(candidate, item)));
    const next = current.filter((item) => !removed.some((candidate) => equal(candidate, item)));
    for (const item of added) if (!next.some((candidate) => equal(candidate, item))) next.push(structuredClone(item));
    if (next.every((item) => typeof item === 'number')) next.sort((a, b) => a - b);
    return next;
  }
  const beforeByKey = new Map(before.map((item) => [arrayItemKey(item), item]));
  const afterByKey = new Map(after.map((item) => [arrayItemKey(item), item]));
  const removed = new Set([...beforeByKey.keys()].filter((key) => !afterByKey.has(key)));
  const next = current.filter((item) => !removed.has(arrayItemKey(item))).map((item) => {
    const key = arrayItemKey(item);
    if (!beforeByKey.has(key) || !afterByKey.has(key) || equal(beforeByKey.get(key), afterByKey.get(key))) return item;
    return mergeDelta(structuredClone(item), beforeByKey.get(key), afterByKey.get(key));
  });
  const nextByKey = new Set(next.map(arrayItemKey));
  for (const [key, item] of afterByKey) {
    if (!beforeByKey.has(key) && !nextByKey.has(key)) next.push(structuredClone(item));
  }
  if (next.every((item) => typeof item === 'number')) next.sort((a, b) => a - b);
  return next;
}

/** Merge one mutation's before/after delta into the latest disk state. */
function mergeDelta(target, before, after) {
  if (equal(before, after)) return target;
  if (plainRecord(before) && plainRecord(after) && plainRecord(target)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, key);
      const has = Object.hasOwn(after, key);
      if (had && has && equal(before[key], after[key])) continue;
      if (!has) {
        if (plainRecord(before[key]) && plainRecord(target[key])) {
          mergeDelta(target[key], before[key], {});
          if (Object.keys(target[key]).length === 0) delete target[key];
        } else if (Array.isArray(before[key]) && Array.isArray(target[key])) {
          target[key] = mergeArray(target[key], before[key], []);
          if (target[key].length === 0) delete target[key];
        } else if (had) delete target[key];
        continue;
      }
      if (!had && plainRecord(after[key]) && plainRecord(target[key])) {
        mergeDelta(target[key], {}, after[key]);
      } else if (!had && Array.isArray(after[key]) && Array.isArray(target[key])) {
        target[key] = mergeArray(target[key], [], after[key]);
      } else if (!had) target[key] = structuredClone(after[key]);
      else if (plainRecord(before[key]) && plainRecord(after[key])) {
        if (!plainRecord(target[key])) target[key] = {};
        mergeDelta(target[key], before[key], after[key]);
      } else if (Array.isArray(before[key]) && Array.isArray(after[key])) {
        target[key] = mergeArray(Array.isArray(target[key]) ? target[key] : [], before[key], after[key]);
      } else {
        target[key] = structuredClone(after[key]);
      }
    }
    return target;
  }
  return structuredClone(after);
}

function fileSignature(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function expiredLockOwner(file, staleLockMs) {
  try { fs.statSync(file); } catch (error) { return error.code === 'ENOENT'; }
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  // An incomplete or foreign lock cannot prove its owner has exited. Never
  // replace it based on age alone: a live process may have been suspended.
  if (!Number.isSafeInteger(metadata?.pid) || metadata.pid <= 0
    || typeof metadata.token !== 'string' || !metadata.token
    || !Number.isFinite(metadata.createdAt)) return false;
  const age = Date.now() - metadata.createdAt;
  if (age < staleLockMs) return false;
  if (Number.isSafeInteger(metadata?.pid) && processAlive(metadata.pid)) return false;
  return true;
}

function reclaimDeadReaper(directory) {
  let names;
  try { names = fs.readdirSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'ENOTDIR') return false;
    throw error;
  }
  if (names.length !== 1) return false;
  const owner = /^owner-(\d+)-[a-f0-9-]{36}$/.exec(names[0]);
  const pid = Number(owner?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || processAlive(pid)) return false;
  try { fs.unlinkSync(path.join(directory, names[0])); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // Only the process that removed this exact owner marker may remove the empty
  // directory. A competing reaper cannot unlink a newly acquired guard.
  fs.rmdirSync(directory);
  return true;
}

/** A validated, crash-safe JSON store shared by all plugin host processes. */
export function createDurableState(file, {
  empty,
  normalize,
  reconcile = (state) => state,
  delay = 200,
  lockTimeoutMs = 10000,
  lockPollMs = 10,
  staleLockMs = 1000,
}) {
  const lockFile = `${file}.lock`;
  let cache;
  let signature;
  let timer;
  let dirty = false;
  let pending = [];

  function readDisk() {
    // Capture the signature before reading. A replacement during or after the
    // read must trigger a refresh next time, never label old bytes as new.
    const loadedSignature = fileSignature(file);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { state: empty(), signature: null };
    }
    try {
      return { state: normalize(JSON.parse(raw.replace(/^\uFEFF/, ''))), signature: loadedSignature };
    } catch (cause) {
      throw new Error(`无法读取工具栏状态，原文件已保留：${file}（${cause.message}）`, { cause });
    }
  }

  function read() {
    if (cache === undefined) {
      const loaded = readDisk();
      cache = loaded.state;
      signature = loaded.signature;
    } else if (fileSignature(file) !== signature) {
      try {
        const loaded = readDisk();
        cache = dirty
          ? reconcile(pending.reduce((state, operation) => mergeDelta(state, operation.before, operation.after), loaded.state))
          : loaded.state;
        signature = loaded.signature;
      } catch (error) {
        // Retain the in-memory copy when the target was replaced by a directory;
        // writes will still fail loudly until the caller repairs the path.
        if (error.code !== 'EISDIR' && error.cause?.code !== 'EISDIR') throw error;
      }
    }
    return cache;
  }

  function staleLock() {
    if (!expiredLockOwner(lockFile, staleLockMs)) return false;
    const reaperFile = `${lockFile}.reaper`;
    try { fs.mkdirSync(reaperFile, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return reclaimDeadReaper(reaperFile);
    }
    const marker = path.join(reaperFile, `owner-${process.pid}-${randomUUID()}`);
    try {
      fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
      if (!expiredLockOwner(lockFile, staleLockMs)) return false;
      try { fs.unlinkSync(lockFile); return true; } catch (error) { return error.code === 'ENOENT'; }
    } finally {
      try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmdirSync(reaperFile);
    }
  }

  function acquireLock() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const started = performance.now();
    const token = randomUUID();
    const claim = `${lockFile}.${process.pid}.${token}.claim`;
    let descriptor;
    try {
      descriptor = fs.openSync(claim, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      while (true) {
        try {
          // Publish fully initialized owner metadata in one exclusive operation.
          fs.linkSync(claim, lockFile);
          return token;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (staleLock()) continue;
          if (performance.now() - started >= lockTimeoutMs) {
            const timeout = new Error(`无法取得工具栏状态锁：${lockFile}`);
            timeout.code = 'MTT_STATE_LOCK_TIMEOUT';
            throw timeout;
          }
          sleepSync(lockPollMs);
        }
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(claim);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  function releaseLock(token) {
    try {
      const metadata = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (metadata?.token !== token) return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    fs.unlinkSync(lockFile);
  }

  function writeState(state) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    let renamed = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      renamed = true;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (!renamed) {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  function flush() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (dirty) persist();
  }

  /** Apply an acknowledged mutation without ever queuing its uncommitted draft. */
  function persist(mutator) {
    const token = acquireLock();
    try {
      let next = readDisk().state;
      for (const operation of pending) next = mergeDelta(next, operation.before, operation.after);
      if (mutator) mutator(next);
      next = reconcile(next);
      writeState(next);
      cache = next;
      // Read the signature with the bytes on the next read; avoid reporting a
      // failed operation once the rename has already made the write visible.
      signature = undefined;
      pending = [];
      dirty = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    } finally {
      try { releaseLock(token); } catch (error) { console.error('[dsh-message-toolbar] failed to release state lock:', error); }
    }
  }

  function mutate(mutator) {
    const before = structuredClone(read());
    const draft = structuredClone(before);
    mutator(draft);
    pending.push({ before, after: structuredClone(draft) });
    cache = draft;
    dirty = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try { flush(); } catch (error) { console.error('[dsh-message-toolbar] failed to persist state:', error); }
    }, delay);
    return cache;
  }

  function reload() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    cache = undefined;
    signature = undefined;
    dirty = false;
    pending = [];
  }

  return { read, mutate, flush, commit: persist, reload };
}
