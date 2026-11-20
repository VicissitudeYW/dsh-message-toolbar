import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A single-process JSON store. Failed reads and writes never become empty data. */
export function createDurableState(file, { empty, normalize, delay = 200 }) {
  let cache;
  let timer;
  let dirty = false;

  function read() {
    if (cache !== undefined) return cache;
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return cache = empty();
    }
    try {
      cache = normalize(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch (cause) {
      throw new Error(`无法读取工具栏状态，原文件已保留：${file}（${cause.message}）`, { cause });
    }
    return cache;
  }

  function flush() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(cache, null, 2), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      dirty = false;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      // A failed rename leaves the old state intact and dirty=true for retry.
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function mutate(mutator) {
    // A rejected mutation must not leave half an operation in the shared cache.
    const draft = structuredClone(read());
    mutator(draft);
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
    dirty = false;
  }

  return { read, mutate, flush, reload };
}
