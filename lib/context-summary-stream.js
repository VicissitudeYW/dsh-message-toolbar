const capacityCode = 'CONTEXT_WINDOW_EXCEEDED';
const contextError = () => Object.assign(new Error('所选历史中有一段无法装入摘要模型的上下文窗口。请换用更大窗口的模型。'),
  { code: capacityCode });
const modelError = failure => Object.assign(new Error(failure.message), { code: failure.code });
const imageError = () => modelError({ message: 'compaction summary cannot contain image output', code: 'UNSUPPORTED_CONTENT' });

function messageGroups(messages, estimate) {
  const groups = [], pending = new Set();
  let start = 0, tokens = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool' && !pending.delete(message.toolCallId)) {
      throw new Error('所选历史中的工具调用与结果无法配对。');
    }
    for (const block of message.content) if (block.type === 'tool-call') pending.add(block.id);
    tokens += estimate(message);
    if (!pending.size) {
      groups.push({ start, end: index + 1, tokens });
      start = index + 1;
      tokens = 0;
    }
  }
  if (pending.size) throw new Error('所选历史中还有未完成的工具调用。');
  return groups;
}

async function readSummary(stream, signal, final) {
  const blocks = new Map();
  const chunks = final ? [] : null;
  let finish, hasImage = false;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    chunks?.push(chunk);
    if (chunk.type === 'block-start' && chunk.blockType === 'text' && !blocks.has(chunk.index)) blocks.set(chunk.index, '');
    if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
    if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
    if (chunk.type === 'block-end' && chunk.block.type === 'image') hasImage = true;
    if (chunk.type === 'finish') finish = chunk;
  }
  signal?.throwIfAborted();
  const failure = finish?.reason.failure;
  if (failure?.code === capacityCode) throw modelError(failure);
  const text = [...blocks.values()].filter(value => value.trim()).join('\n');
  return { chunks, finish, text, hasImage };
}

function* publishSummary({ chunks, finish, text, hasImage }, beforeFinal) {
  const reason = finish?.reason;
  if (reason?.failure || ['error', 'aborted', 'max-tokens'].includes(reason?.kind)) {
    yield finish;
    return;
  }
  if (hasImage) throw imageError();
  if (!text) {
    if (finish) yield finish;
    return;
  }
  beforeFinal();
  yield* chunks;
}

const smallerEnd = (first, end) => first + Math.floor((end - first) / 2);

/** Rebuild an oversized projected region without publishing intermediate summaries. */
export async function* streamProjectedSummary(ctx, request, messages, stream, beforeFinal) {
  const { signal } = request;
  signal?.throwIfAborted();
  const meter = ctx.get?.('tokenMeter');
  let info;
  if (typeof meter?.estimateMessage === 'function' && typeof ctx.llm.resolveModelInfo === 'function') {
    try { info = await ctx.llm.resolveModelInfo(request.provider, request.model, signal); }
    catch { /* Let the native adapter report any routing error. */ }
  }
  signal?.throwIfAborted();
  const window = info?.context?.contextWindow;
  const knownWindow = Number.isSafeInteger(window) && window > 0;
  const estimate = knownWindow ? message => meter.estimateMessage(message) : () => 0;
  const reserved = request.maxTokens ?? info?.defaultMaxTokens ?? 0;
  const tools = request.tools?.length ? Math.ceil(JSON.stringify(request.tools).length / 4) + 4 : 0;
  const capacity = knownWindow ? window - reserved - tools : Infinity;
  let initialError;
  if (messages.reduce((total, message) => total + estimate(message), 0) <= capacity) {
    let summary;
    try { summary = await readSummary(stream(messages), signal, true); }
    catch (error) {
      signal?.throwIfAborted();
      if (error?.code !== capacityCode) throw error;
      initialError = error;
    }
    if (summary) {
      signal?.throwIfAborted();
      yield* publishSummary(summary, beforeFinal);
      return;
    }
  }

  const head = messages[0]?.role === 'system' ? messages.slice(0, 1) : [];
  const instruction = messages.at(-1);
  const history = messages.slice(head.length, -1);
  // The meter is a character-density estimate. Leave room for adapter framing.
  const framing = head.reduce((total, message) => total + estimate(message), 0) + estimate(instruction);
  const limit = capacity - framing;
  const budget = Math.floor(capacity * 0.9) - framing;
  const groups = messageGroups(history, estimate);
  if (initialError && groups.length < 2) throw initialError;
  if (!groups.length || groups.some(group => group.tokens > limit)) throw contextError();

  let prior;
  for (let first = 0; first < groups.length;) {
    const carry = prior ? estimate(prior) : 0;
    const minimum = carry + groups[first].tokens;
    if (minimum > limit) throw contextError();
    let end = first;
    if (first === 0 && initialError) end = smallerEnd(first, groups.length);
    else {
      let remaining = Math.max(budget, minimum) - carry;
      while (end < groups.length && remaining >= groups[end].tokens) {
        remaining -= groups[end].tokens;
        end++;
      }
    }
    let summary;
    for (;;) {
      signal?.throwIfAborted();
      const batch = [...head, ...(prior ? [prior] : []), ...history.slice(groups[first].start, groups[end - 1].end), instruction];
      try {
        summary = await readSummary(stream(batch), signal, end === groups.length);
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.code !== capacityCode || end - first <= 1) throw error;
        end = smallerEnd(first, end);
      }
    }
    signal?.throwIfAborted();
    if (end === groups.length) {
      yield* publishSummary(summary, beforeFinal);
      return;
    }
    const reason = summary.finish?.reason;
    if (reason?.failure) throw modelError(reason.failure);
    if (reason?.kind !== 'stop') throw new Error('模型未完成分批摘要。');
    if (summary.hasImage) throw imageError();
    if (!summary.text) throw new Error('模型未返回分批摘要。');
    prior = { role: 'user', content: [{ type: 'text', text: `<compacted-summary>\n${summary.text}\n</compacted-summary>` }] };
    first = end;
  }
}
