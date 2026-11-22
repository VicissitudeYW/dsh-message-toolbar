const contextError = () => Object.assign(new Error('所选历史中有一段无法装入摘要模型的上下文窗口。请换用更大窗口的模型。'),
  { code: 'CONTEXT_WINDOW_EXCEEDED' });

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

async function readPartialSummary(stream, signal) {
  const blocks = new Map();
  let finish;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    if (chunk.type === 'block-start' && chunk.blockType === 'text' && !blocks.has(chunk.index)) blocks.set(chunk.index, '');
    if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
    if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  signal?.throwIfAborted();
  if (finish?.failure) throw Object.assign(new Error(finish.failure.message), { code: finish.failure.code });
  if (finish?.kind !== 'stop') throw new Error('模型未完成分批摘要。');
  const text = [...blocks.values()].filter(value => value.trim()).join('\n');
  if (!text) throw new Error('模型未返回分批摘要。');
  // Use DSH's checkpoint framing so the native directive merges the prior batch.
  return { role: 'user', content: [{ type: 'text', text: `<compacted-summary>\n${text}\n</compacted-summary>` }] };
}

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
  if (!Number.isSafeInteger(window) || window <= 0) {
    beforeFinal();
    yield* stream(messages);
    return;
  }
  const estimate = message => meter.estimateMessage(message);
  const reserved = request.maxTokens ?? info.defaultMaxTokens ?? 0;
  const tools = request.tools?.length ? Math.ceil(JSON.stringify(request.tools).length / 4) + 4 : 0;
  const capacity = window - reserved - tools;
  if (messages.reduce((total, message) => total + estimate(message), 0) <= capacity) {
    beforeFinal();
    yield* stream(messages);
    return;
  }

  const head = messages[0]?.role === 'system' ? messages.slice(0, 1) : [];
  const instruction = messages.at(-1);
  const history = messages.slice(head.length, -1);
  // The meter is a character-density estimate. Leave room for adapter framing.
  const framing = head.reduce((total, message) => total + estimate(message), 0) + estimate(instruction);
  const limit = capacity - framing;
  const budget = Math.floor(capacity * 0.9) - framing;
  const groups = messageGroups(history, estimate);
  if (!groups.length || groups.some(group => group.tokens > limit)) throw contextError();

  let prior;
  for (let first = 0; first < groups.length;) {
    const carry = prior ? estimate(prior) : 0;
    const minimum = carry + groups[first].tokens;
    if (minimum > limit) throw contextError();
    let remaining = Math.max(budget, minimum) - carry;
    let end = first;
    while (end < groups.length && remaining >= groups[end].tokens) {
      remaining -= groups[end].tokens;
      end++;
    }
    const batch = [...head, ...(prior ? [prior] : []), ...history.slice(groups[first].start, groups[end - 1].end), instruction];
    signal?.throwIfAborted();
    if (end === groups.length) {
      beforeFinal();
      yield* stream(batch);
      return;
    }
    prior = await readPartialSummary(stream(batch), signal);
    first = end;
  }
}
