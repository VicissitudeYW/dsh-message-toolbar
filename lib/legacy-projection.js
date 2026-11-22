import { isDeepStrictEqual } from 'node:util';

const compactionEvents = new Set(['compaction/start', 'compaction/summary', 'compaction/end']);

function restoreRequestHeaders(source, records) {
  const retryHeaders = new Map();
  let header;
  for (const event of source) {
    if (event.type === 'request/header') header = event;
    if (event.type === 'llm/retry' && header) retryHeaders.set(event.seq, header);
  }
  const result = [], available = new Map();
  let provider;
  const providerOf = event => event.data.header.config.provider;
  const appendHeader = (previous, time) => {
    const event = { type: previous.type, time, data: structuredClone(previous.data) };
    event.data.reason = provider === undefined ? 'initial' : 'change';
    const record = { event };
    result.push(record);
    available.set(previous.seq, record);
    provider = providerOf(event);
    return record;
  };
  for (const record of records) {
    const { event, sourceSeq } = record;
    if (event.type === 'session-log-deepseek/delivery-accepted') continue;
    if (event.type === 'request/header') {
      available.set(sourceSeq, record);
      provider = providerOf(event);
    } else if (event.type === 'developer/message' && event.data.headerSeq !== undefined) {
      const previous = source[event.data.headerSeq];
      if (previous?.type !== 'request/header') throw new Error('旧历史存在无效的工具配置引用。');
      record.requestHeader = available.get(previous.seq) ?? appendHeader(previous, event.time);
    } else if (event.type === 'llm/retry' && provider !== event.data.provider) {
      const previous = retryHeaders.get(sourceSeq);
      if (!previous || providerOf(previous) !== event.data.provider) throw new Error('旧历史缺少重试时使用的模型配置。');
      appendHeader(previous, event.time);
    }
    result.push(record);
  }
  return result;
}

function rangeOnSurface(surface, start, end) {
  const first = surface.indexOf(start), last = surface.indexOf(end);
  return first >= 0 && last >= first ? { first, seqs: surface.slice(first, last + 1) } : undefined;
}

function replacementSpan(surface, event) {
  const op = event.surfaceOp;
  if (op?.op !== 'replace') return undefined;
  return rangeOnSurface(surface, op.startSeq, op.endSeq);
}

function compactionId({ type, data }) {
  if (compactionEvents.has(type)) return data.compactionId;
  if (type === 'user/message' && data.source?.kind === 'compact-checkpoint') return data.source.compactionId;
}

function sourceProjections(events) {
  const surface = [], spans = new Map(), owners = new Map(), transactions = new Map();
  for (const event of events) {
    const { seq, type, data, surfaceOp } = event;
    const id = compactionId(event);
    if (id !== undefined) {
      if (!transactions.has(id)) transactions.set(id, []);
      transactions.get(id).push(seq);
      owners.set(seq, transactions.get(id));
    }
    if (type === 'compaction/prune' && events[seq + 1]?.type === 'tool/result'
      && data.shadowedRange?.start === events[seq + 1].surfaceOp?.startSeq) {
      const pair = [seq, seq + 1];
      owners.set(seq, pair);
      owners.set(seq + 1, pair);
    }
    if (type === 'compaction/summary' || type === 'compaction/prune') {
      const range = rangeOnSurface(surface, data.shadowedRange?.start, data.shadowedRange?.end);
      if (!range || !isDeepStrictEqual(range.seqs, data.shadowedSeqs)) {
        throw new Error('旧历史的压缩范围不完整，无法安全迁移。');
      }
      spans.set(seq, range.seqs);
    }
    if (surfaceOp === 'append') surface.push(seq);
    else if (surfaceOp !== undefined) {
      const span = replacementSpan(surface, event);
      const refs = new Set(event.sourceEventSeqs);
      if (!span || span.seqs.some(ref => !refs.has(ref)) || [...refs].some(ref => !Number.isSafeInteger(ref) || ref < 0 || ref >= seq)) {
        throw new Error('旧历史的压缩替换引用无效，无法安全迁移。');
      }
      spans.set(seq, span.seqs);
      surface.splice(span.first, span.seqs.length, seq);
    }
  }
  return { spans, owners };
}

/** Rebuild native V4 projection and reference coordinates after folding legacy turns. */
export function rebuildLegacyProjection(source, records) {
  const { spans, owners } = sourceProjections(source);
  records = restoreRequestHeaders(source, records);
  const copied = new Map();
  const changed = new Set();
  for (const [index, { event, sourceSeq }] of records.entries()) {
    if (!Number.isSafeInteger(sourceSeq)) continue;
    if (copied.has(sourceSeq)) throw new Error('旧历史存在重复事件序号，无法安全迁移。');
    copied.set(sourceSeq, index);
    // Mechanical changes to a turn or a step do not change a projected message.
    if (event.surfaceOp === 'append' && !isDeepStrictEqual(event.data.message ?? event.data,
      source[sourceSeq]?.data?.message ?? source[sourceSeq]?.data)) changed.add(sourceSeq);
  }
  const omitted = new Set();
  const omit = seq => { for (const related of owners.get(seq) ?? [seq]) omitted.add(related); };
  for (const [seq, owner] of owners) {
    if (owner.some(ref => !copied.has(ref))) omit(seq);
  }
  // Compare the exact current span before and after the legacy edits. Endpoints
  // alone are not enough: a replacement can reorder the numbers on the surface.
  let previousSize, offloadTargets;
  do {
    previousSize = omitted.size;
    offloadTargets = new Map();
    const surface = [];
    for (const [index, { event, sourceSeq }] of records.entries()) {
      if (omitted.has(sourceSeq)) continue;
      const { type, data, surfaceOp } = event;
      const originalSpan = spans.get(sourceSeq);
      if (originalSpan) {
        const span = rangeOnSurface(surface, originalSpan[0], originalSpan.at(-1));
        if (!span || !isDeepStrictEqual(span.seqs, originalSpan) || span.seqs.some(ref => changed.has(ref))
          || event.sourceEventSeqs?.some(ref => omitted.has(ref) || !(copied.get(ref) < index))) {
          // Omit the full compaction transaction with its stale checkpoint;
          // the underlying selected messages are still in the seed.
          omit(sourceSeq);
          continue;
        }
        if (surfaceOp?.op === 'replace') surface.splice(span.first, span.seqs.length, sourceSeq);
      } else if (surfaceOp === 'append') surface.push(sourceSeq);
      if (type === 'image/offload') {
        // Offload indexes refer to the old content array; an edit may change it.
        offloadTargets.set(sourceSeq, data.targets.filter(target => surface.includes(target.seq) && !changed.has(target.seq)));
      }
      if (type === 'session/title' || type === 'session/title-llm-request') {
        if (data.messageSeqs?.some(ref => !(copied.get(ref) < index) || omitted.has(ref))) omit(sourceSeq);
      }
    }
  } while (omitted.size !== previousSize);

  for (const [seq, targets] of offloadTargets) if (targets.length === 0) omit(seq);
  const retained = records.filter(record => !omitted.has(record.sourceSeq));
  const seqMap = new Map(retained.map(({ sourceSeq }, seq) => [sourceSeq, seq]).filter(([old]) => Number.isSafeInteger(old)));
  const outputPositions = new Map(retained.map((record, seq) => [record, seq]));
  return retained.map(({ event, sourceSeq, requestHeader }, seq) => {
    const remap = old => {
      const next = seqMap.get(old);
      if (next === undefined || next >= seq) throw new Error('旧历史存在跨回答的事件引用，无法安全迁移。');
      return next;
    };
    const { type, data, surfaceOp } = event;
    event.seq = seq;
    if (surfaceOp?.op === 'replace') event.surfaceOp = { ...surfaceOp,
      startSeq: remap(surfaceOp.startSeq), endSeq: remap(surfaceOp.endSeq) };
    if (event.sourceEventSeqs !== undefined) event.sourceEventSeqs = event.sourceEventSeqs.map(remap);
    if (type === 'compaction/summary' || type === 'compaction/prune') {
      data.shadowedRange = { start: remap(data.shadowedRange.start), end: remap(data.shadowedRange.end) };
      data.shadowedSeqs = data.shadowedSeqs.map(remap);
    }
    if (requestHeader !== undefined) data.headerSeq = outputPositions.get(requestHeader);
    if (type === 'command/done' && data.sourceEventSeq !== undefined) {
      if (seqMap.get(data.sourceEventSeq) < seq) data.sourceEventSeq = remap(data.sourceEventSeq);
      else delete data.sourceEventSeq;
    }
    if (type === 'session/title' || type === 'session/title-llm-request') {
      if (Array.isArray(data.messageSeqs)) data.messageSeqs = data.messageSeqs.map(remap);
    }
    if (type === 'image/offload') data.targets = offloadTargets.get(sourceSeq).map(target => ({ ...target, seq: remap(target.seq) }));
    if (type === 'tool/result' && data.error?.code === 'TOOL_NOT_STARTED') {
      const prefix = `forked-tool-result-${data.message.toolCallId}-`;
      if (data.message.id.startsWith(prefix)) data.message.id = `${prefix}${event.surfaceOp?.startSeq ?? seq}`;
    }
    if (type === 'message-toolbar/version' || type === 'message-tree/version') {
      if (data.effect && Number.isSafeInteger(data.effect.targetEventSeq)) {
        data.effect.targetEventSeq = seqMap.get(data.effect.targetEventSeq) ?? -1;
      }
    }
    return event;
  });
}
