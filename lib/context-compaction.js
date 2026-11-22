import { createHash } from 'node:crypto';

const isSeq = value => Number.isSafeInteger(value) && value >= 0;

export function validCompactionId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]{1,120}$/i.test(id) && !Object.hasOwn(Object.prototype, id);
}

export function validCompactionSource(record) {
  return Array.isArray(record?.native) && record.native.length > 0 && record.native.every(isSeq)
    && isSeq(record.first) && Number.isSafeInteger(record.count) && record.count > 0
    && typeof record.digest === 'string' && /^[a-f0-9]{64}$/.test(record.digest);
}

function sameSequences(left, right) {
  return left.length === right.length && left.every((seq, index) => seq === right[index]);
}

function historyFingerprint(history) {
  // Consecutive checkpoints commonly cover progressively longer prefixes.
  // Hash their shared content once per projection.
  const prefixes = new Map();
  return (start, end) => {
    const previous = prefixes.get(start);
    const prefix = previous && previous.end <= end ? previous : { end: start, hash: createHash('sha256') };
    for (; prefix.end < end; prefix.end++) {
      const { seq, message } = history[prefix.end];
      prefix.hash.update(JSON.stringify([seq, message])).update('\n');
    }
    if (!previous || previous.end <= end) prefixes.set(start, prefix);
    return prefix.hash.copy().digest('hex');
  };
}

function sourceTree(roots, checkpoints) {
  const seen = new Set(), queue = [...roots];
  while (queue.length) {
    const seq = queue.pop();
    if (seen.has(seq)) continue;
    seen.add(seq);
    for (const member of checkpoints.get(seq) ?? []) queue.push(member);
  }
  return seen;
}

function nativeSpan(seqs, positions, history, valid) {
  let start, end;
  for (const seq of seqs) {
    const position = positions.get(seq);
    const span = valid.get(seq) ?? (history[position]?.unchanged ? { start: position, end: position + 1 } : undefined);
    if (!span || (end !== undefined && end !== span.start)) return undefined;
    start ??= span.start;
    end = span.end;
  }
  if (start !== undefined) return { start, end };
}

/** Keep the longest covered span whose tool requests and results stay together. */
function selectedSpan(history, covered) {
  let best;
  const pending = new Set();
  let start = 0;
  for (const [index, { seq, sourceSeq, message }] of history.entries()) {
    if (!covered.has(seq) && !covered.has(sourceSeq)) {
      start = index + 1;
      pending.clear();
      continue;
    }
    if (message.role === 'tool' && !pending.delete(message.toolCallId)) {
      start = index + 1;
      pending.clear();
      continue;
    }
    for (const block of message.content) if (block.type === 'tool-call') pending.add(block.id);
    if (pending.size === 0 && index + 1 - start > (best ? best.end - best.start : 0)) best = { start, end: index + 1 };
  }
  return best;
}

/** Native checkpoints describe the physical log; recorded sources describe what the model actually read. */
export function contextCompaction(session, events, history, records) {
  const project = seq => session.deriveEventMessage(events[seq]);
  const produced = seq => events[seq] && project(seq) != null;
  const surface = session.surface.nodes;
  const positions = new Map(history.map(({ seq }, index) => [seq, index]));
  const fingerprint = historyFingerprint(history);
  const summaries = new Map(), completed = new Map();
  let open;
  for (const event of events) {
    if (event.type === 'compaction/start') open = event;
    if (event.type === 'compaction/summary') summaries.set(event.data.compactionId, event);
    if (event.type === 'compaction/end') {
      if (open?.data.compactionId === event.data.compactionId) open = undefined;
      if (event.data.error === undefined) completed.set(event.data.compactionId, event.seq);
    }
  }
  const checkpoints = new Map(), valid = new Map();
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'compact-checkpoint') continue;
    const id = event.data.source.compactionId;
    const summary = summaries.get(id);
    const shadowed = summary?.data.shadowedSeqs;
    if (!Array.isArray(shadowed) || !shadowed.length || !shadowed.every(seq => isSeq(seq) && seq < event.seq && events[seq])
      || summary.seq >= event.seq || event.surfaceOp?.op !== 'replace'
      || event.surfaceOp.startSeq !== shadowed[0] || event.surfaceOp.endSeq !== shadowed.at(-1)) continue;
    checkpoints.set(event.seq, shadowed);
    if (!records || !(completed.get(id) > event.seq)) continue;

    const native = shadowed.filter(produced);
    const record = Object.hasOwn(records, id) ? records[id] : undefined;
    let span;
    if (record === undefined) {
      span = nativeSpan(native, positions, history, valid);
    } else if (sameSequences(native, record.native)) {
      const start = positions.get(record.first);
      const end = start + record.count;
      if (start !== undefined && end <= history.length && fingerprint(start, end) === record.digest) span = { start, end };
    }
    const message = project(event.seq);
    if (span && message != null) valid.set(event.seq, { ...span, message });
  }

  function collapsed(start, end, reachable) {
    const byStart = new Map();
    for (const [seq, span] of valid) {
      if (!reachable.has(seq) || span.start < start || span.end > end) continue;
      const previous = byStart.get(span.start);
      if (!previous || span.end >= previous.end) byStart.set(span.start, span);
    }
    const messages = [];
    for (let index = start; index < end;) {
      const checkpoint = byStart.get(index);
      messages.push(checkpoint?.message ?? history[index].message);
      index = checkpoint?.end ?? index + 1;
    }
    return messages;
  }

  return {
    conversation() {
      return valid.size ? collapsed(0, history.length, sourceTree(surface, checkpoints)) : history.map(({ message }) => message);
    },
    summary(request) {
      // The native request has no range ID. Match its system head, verbatim
      // surface slice and final synthetic user directive to the open operation.
      const id = open?.data.compactionId;
      const instruction = request.at(-1);
      if (!validCompactionId(id) || instruction?.role !== 'user' || instruction.id !== undefined
        || instruction.source !== undefined || instruction.content?.length !== 1 || instruction.content[0]?.type !== 'text') return;
      const hasSystem = events[surface[0]]?.type === 'system/message' && produced(surface[0]);
      const system = hasSystem ? project(surface[0]) : undefined;
      if (hasSystem && request[0] !== system) return;
      const region = request.slice(hasSystem ? 1 : 0, -1);
      if (region.length === 0) return;
      const native = surface.slice(hasSystem ? 1 : 0).filter(produced);
      const first = native.findIndex(seq => project(seq) === region[0]);
      if (first === -1 || first + region.length > native.length
        || !region.every((message, index) => message === project(native[first + index]))) return;
      const seqs = native.slice(first, first + region.length);
      const covered = sourceTree(seqs, checkpoints);
      const span = selectedSpan(history, covered);
      if (!span) return;
      const { start, end } = span;
      const messages = [...(hasSystem ? [system] : []), ...collapsed(start, end, covered), instruction];
      return { id, messages, source: { native: seqs, first: history[start].seq, count: end - start, digest: fingerprint(start, end) } };
    },
  };
}
