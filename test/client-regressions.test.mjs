import test from 'node:test';
import assert from 'node:assert/strict';
import { clientHarness, state, deferred, element, jsonResponse, streamResponse, flush, byClass, findAll, textOf } from './helpers/client-harness.mjs';

const props = { sessionId: 's', turn: 1 };

test('deleted answers stay hidden even when an old edit or variant is still cached', () => {
  const h = clientHarness();
  h.store.set('s', state({ answers: { 1: { active: 'native', items: [], override: { text: 'deleted edit' } } } }));
  assert.equal(byClass(h.render(h.AnswerCard, props), 'native-md').map(textOf).join(''), 'deleted edit');
  h.store.patchHidden('s', { turns: [], answers: [1], prompts: [] });
  assert.equal(h.render(h.AnswerCard, props).length, 0);
  // A fresh page still has the saved edit in durable state.
  const restored = clientHarness();
  restored.store.set('s', JSON.parse(JSON.stringify(h.store.get('s').state)));
  assert.equal(restored.render(restored.AnswerCard, props).length, 0);
});

test('deleting an answer retires its live translation before it can complete', async () => {
  const h = clientHarness(), pending = deferred(); h.store.set('s', state());
  h.window.fetch = () => pending.promise;
  const translating = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  h.store.patchHidden('s', { turns: [], answers: [1], prompts: [] });
  assert.equal(h.store.getLiveTranslation('s', 1), null);
  pending.resolve(streamResponse([{ type: 'done', payload: { seq: 5, turn: 1, lang: 'zh', text: 'deleted translation' } }]));
  await assert.rejects(translating, /修改|改变|翻译/);
  assert.equal(h.render(h.AnswerCard, props).length, 0);
});

test('canceling a translation aborts its request and releases the live translation without writeback', async () => {
  const h = clientHarness(); h.store.set('s', state());
  const requestStarted = deferred(); let requestSignal;
  h.window.fetch = (_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal;
    requestStarted.resolve();
    requestSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const translating = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  await requestStarted.promise;
  assert.equal(requestSignal.aborted, false);
  assert.ok(h.store.getLiveTranslation('s', 1));

  assert.equal(h.cancelTranslation('s', 1), true);
  assert.equal(requestSignal.aborted, true);
  assert.equal(await translating, null);
  assert.equal(h.store.getLiveTranslation('s', 1), null);
  assert.deepEqual(h.store.get('s').state.translations, {});
  assert.deepEqual(h.store.get('s').state.shown, {});
});

test('answer choice rows identify their reply alongside the model label', () => {
  const h = clientHarness();
  const choices = h.ringChoices({ active: 2, turns: [1, 2], models: {
    1: { provider: 'p', model: 'alpha' }, 2: { provider: 'p', model: 'beta' },
  } }, null, [
    { turn: 1, answerText: 'first answer preview' },
    { turn: 2, answerText: 'selected answer preview' },
  ]);
  assert.match(h.render(() => choices.items[0].label, {}).map(textOf).join(''), /alpha.*first answer preview/);
  assert.match(h.render(() => choices.items[1].label, {}).map(textOf).join(''), /beta.*selected answer preview/);
  assert.equal(choices.selectedId, '2');
});

test('the answer menu previews each edited reply and does not label an empty answer with its question', () => {
  const h = clientHarness();
  h.store.set('s', state({ turns: [
    { turn: 1, answerText: 'original source' }, { turn: 2, answerText: 'old source' }, { turn: 3, text: 'question without reply' },
  ], runs: { 1: { turns: [1, 2, 3], active: 2 } },
  answers: { 2: { active: 'native', items: [], override: { text: 'edited second answer' } } } }));
  const ringMenu = openAnswerMenu(h, 2);
  const rowText = ringMenu.props.items.map((item) => h.render(() => item.label, {}).map(textOf).join(''));
  assert.match(rowText[1], /edited second answer/);
  assert.doesNotMatch(rowText[0], /edited second answer/);
  assert.doesNotMatch(rowText[2], /question without reply/);
});

function openAnswerMenu(h, turn) {
  const draw = () => h.render(h.AssistantToolbar, { sessionId: 's', turn });
  const menu = () => findAll(draw(), (node) => node.type === 'menu'
    && (node.props.anchor?.props.className || '').includes('mtt-ring-num'))[0];
  menu().props.anchor.props.onClick();
  return menu();
}

test('an answer group shows the selected legacy variant and bounds its menu preview', () => {
  const h = clientHarness();
  const longReply = 'visible legacy answer ' + '段落 '.repeat(5000);
  h.store.set('s', state({ runs: { 1: { turns: [1, 2], active: 2, models: { 1: { model: 'native-model' } } } },
    answers: { 1: { active: 'v1', items: [{ id: 'v1', model: 'legacy-model', text: longReply }],
      override: { text: 'hidden native edit' } } } }));

  const menu = openAnswerMenu(h, 2);
  const first = h.render(() => menu.props.items[0].label, {});
  const preview = byClass(first, 'mtt-answer-choice-preview')[0];
  assert.match(first.map(textOf).join(''), /legacy-model.*visible legacy answer/);
  assert.ok(textOf(preview).length <= 120);
  assert.ok((preview.props.title || '').length <= 120);
});

test('the toolbar can stop a translation even after mounting during its live stream', async () => {
  const h = clientHarness(); h.store.set('s', state());
  const pending = deferred();
  h.window.fetch = () => pending.promise;
  const translating = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  const stop = findAll(h.render(h.AssistantToolbar, props), (node) => node.type === 'button' && node.props.title === 'Stop translating')[0];
  assert.ok(stop, 'the live request exposes a stop button, not a disabled language picker');
  assert.notEqual(stop.props.disabled, true);
  stop.props.onClick();
  assert.equal(h.store.getLiveTranslation('s', 1), null);
  pending.resolve(streamResponse([{ type: 'done', payload: { turn: 1, seq: 5, lang: 'zh', text: 'late' } }]));
  assert.equal(await translating, null);
  assert.equal(Object.keys(h.store.get('s').state.translations).length, 0);
  const tree = h.render(h.AssistantToolbar, props);
  assert.ok(findAll(tree, (node) => node.type === 'button' && node.props.title === 'Translate')[0]);
});

test('a confirmed translation becomes visible without waiting for the connection to close', async () => {
  const h = clientHarness(); h.store.set('s', state());
  const eof = deferred(); let reads = 0;
  const bytes = new TextEncoder().encode(JSON.stringify({ type: 'done', payload: {
    turn: 1, seq: 5, lang: 'zh', text: '完整译文', origin: 'original answer',
  } }) + '\n');
  h.window.fetch = async () => ({ ok: true, body: { getReader: () => ({
    read: async () => ++reads === 1 ? { done: false, value: bytes } : eof.promise,
    cancel() { return eof.promise; }, releaseLock() {},
  }) } });
  const translating = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  try {
    await flush();
    assert.equal(h.store.get('s').state.translations[5]?.zh?.text, '完整译文');
    assert.equal(h.cancelTranslation('s', 1), false);
    assert.equal((await translating).text, '完整译文');
  } finally {
    eof.resolve({ done: true });
    await translating;
  }
});

test('a canceled old translation cannot clear or overwrite a same-turn retry', async () => {
  const h = clientHarness(); h.store.set('s', state());
  const first = deferred(), second = deferred(); let request = 0;
  h.window.fetch = () => [first, second][request++].promise;
  const old = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  h.cancelTranslation('s', 1);
  const retry = h.translateInto('s', 1, { eventSeq: 5, lang: 'fr' });
  first.resolve(streamResponse([{ type: 'done', payload: { turn: 1, seq: 5, lang: 'zh', text: 'stale' } }]));
  assert.equal(await old, null);
  assert.equal(h.store.getLiveTranslation('s', 1)?.lang, 'fr');
  second.resolve(streamResponse([{ type: 'done', payload: { turn: 1, seq: 5, lang: 'fr', text: 'nouveau' } }]));
  assert.equal((await retry).text, 'nouveau');
  assert.equal(h.store.get('s').state.translations[5].zh, undefined);
  assert.equal(h.store.get('s').state.shown[1], 'fr');
});

test('an incomplete file revert stops regeneration and reports files already reverted', async () => {
  const h = clientHarness(), actions = [];
  h.store.set('s', state());
  h.window.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); actions.push(body.action);
    return jsonResponse({ reverted: [{ path: 'safe.txt' }], skipped: [{ path: 'new.txt', reason: 'missing-exact-snapshot' }] });
  };
  await assert.rejects(h.rerunAfterRevert({ sessionId: 's', turn: 1 }), /1.*1.*new\.txt/);
  assert.deepEqual(actions, ['revert']);
});

test('unchanged and already removed files do not block regeneration after a safe revert', async () => {
  const h = clientHarness(), actions = [];
  h.store.set('s', state());
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state());
    const body = JSON.parse(init.body); actions.push(body.action);
    return jsonResponse(body.action === 'revert'
      ? { reverted: [{ path: 'safe.txt' }], skipped: [{ reason: 'unchanged' }, { reason: 'already-gone' }] }
      : { turn: 2 });
  };
  const result = await h.rerunAfterRevert({ sessionId: 's', turn: 1 });
  assert.equal(result.revertedCount, 1);
  assert.deepEqual(actions, ['revert', 'answer-run']);
});

test('a grouped visible answer renders its editor and saved override', () => {
  const h = clientHarness();
  h.store.set('s', state({ runs: { 1: { turns: [1, 2], active: 1 } } }));
  h.store.setEdit('s', 1, { initial: 'edit this answer' });
  let tree = h.render(h.AnswerCard, props);
  assert.equal(byClass(tree, 'mtt-answer-edit-input')[0]?.props.value, 'edit this answer');
  h.store.setEdit('s', 1, null);
  h.store.patchAnswer('s', 1, { active: 'native', items: [], override: { text: 'saved answer' } });
  tree = h.render(h.AnswerCard, props);
  assert.equal(byClass(tree, 'native-md').map(textOf).join(''), 'saved answer');
});

test('first translation draws the original supplied in the completed payload', async () => {
  const h = clientHarness();
  h.store.set('s', state({ turns: [{ turn: 1, text: 'question', answered: true }] }));
  h.window.fetch = async () => streamResponse([{ type: 'done', payload: {
    seq: 5, turn: 1, lang: 'zh', text: '译文', origin: 'the original', role: 'assistant',
  } }]);
  await h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  const tree = h.render(h.AnswerCard, props);
  assert.equal(byClass(tree, 'mtt-pair-src').map(textOf).join(''), 'the original');
  assert.equal(byClass(tree, 'mtt-pair-tr').map(textOf).join(''), '译文');
});

test('a translation finishing after an answer edit cannot restore a stale pair', async () => {
  const h = clientHarness(), finished = deferred(); h.store.set('s', state());
  h.window.fetch = async () => finished.promise;
  const translating = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
  h.store.patchAnswer('s', 1, { active: 'native', items: [], override: { text: 'new answer' } });
  finished.resolve(streamResponse([{ type: 'done', payload: { seq: 5, turn: 1, lang: 'zh', text: 'old translation', origin: 'original answer' } }]));
  await assert.rejects(translating, /修改|改变|翻译/);
  assert.equal(byClass(h.render(h.AnswerCard, props), 'mtt-pair-tr').length, 0);
  assert.equal(h.store.getLiveTranslation('s', 1), null);
});

for (const outcome of ['done', 'error']) {
  test('an old translation ' + outcome + ' cannot clear the translation started after an answer edit', async () => {
    const h = clientHarness(), first = deferred(), second = deferred();
    h.store.set('s', state()); let requests = 0;
    h.window.fetch = () => [first, second][requests++].promise;
    const old = h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' });
    const rejected = assert.rejects(old, /修改|改变|翻译|offline/);
    h.store.patchAnswer('s', 1, { active: 'native', items: [], override: { text: 'new answer' } });
    const current = h.translateInto('s', 1, { text: 'new answer', turn: 1, lang: 'fr' });
    if (outcome === 'done') first.resolve(streamResponse([{ type: 'done', payload: {
      seq: 5, turn: 1, lang: 'zh', text: 'old translation', origin: 'original answer',
    } }]));
    else first.reject(new Error('offline'));
    await rejected;
    assert.equal(h.store.getLiveTranslation('s', 1)?.lang, 'fr');
    second.resolve(streamResponse([{ type: 'delta', text: 'nouvelle traduction' }, { type: 'done', payload: {
      seq: 'turn:1', turn: 1, lang: 'fr', text: 'nouvelle traduction', origin: 'new answer',
    } }]));
    await current;
    const tree = h.render(h.AnswerCard, props);
    assert.equal(byClass(tree, 'mtt-pair-src').map(textOf).join(''), 'new answer');
    assert.equal(byClass(tree, 'mtt-pair-tr').map(textOf).join(''), 'nouvelle traduction');
    assert.equal(h.store.getLiveTranslation('s', 1), null);
  });
}

test('copy on a grouped edited answer copies the visible override', () => {
  const h = clientHarness(), clipped = [];
  h.store.set('s', state({ runs: { 1: { turns: [1, 2], active: 1 } },
    answers: { 1: { active: 'native', items: [], override: { text: 'visible override' } } } }));
  h.window.navigator.clipboard.writeText = (text) => clipped.push(text);
  const copy = findAll(h.render(h.AssistantToolbar, props), (node) => node.props['data-mtt'] === 'copy-answer')[0];
  assert.ok(copy); copy.props.onClick(); assert.equal(clipped[0], 'visible override');
});

test('copying an edited answer reports success only after the clipboard write succeeds', async () => {
  const h = clientHarness();
  h.store.set('s', state({ answers: { 1: { active: 'native', items: [], override: { text: 'visible override' } } } }));
  const written = deferred(); h.window.navigator.clipboard.writeText = () => written.promise;
  const copy = findAll(h.render(h.AssistantToolbar, props), (node) => node.props['data-mtt'] === 'copy-answer')[0];
  const copying = copy.props.onClick();
  let tree = h.render(h.AssistantToolbar, props);
  assert.equal(findAll(tree, (node) => node.props['data-mtt'] === 'copy-answer')[0].props.title, 'Copy this answer');
  written.resolve(); await copying;
  tree = h.render(h.AssistantToolbar, props);
  assert.equal(findAll(tree, (node) => node.props['data-mtt'] === 'copy-answer')[0].props.title, 'Copied');
});

test('failed clipboard writes surface an error instead of marking the answer copied', async () => {
  const h = clientHarness();
  h.store.set('s', state({ answers: { 1: { active: 'native', items: [], override: { text: 'visible override' } } } }));
  h.window.navigator.clipboard.writeText = () => Promise.reject(new Error('clipboard denied'));
  const copy = findAll(h.render(h.AssistantToolbar, props), (node) => node.props['data-mtt'] === 'copy-answer')[0];
  await copy.props.onClick();
  const tree = h.render(h.AssistantToolbar, props);
  assert.equal(findAll(tree, (node) => node.props['data-mtt'] === 'copy-answer')[0].props.title, 'Copy this answer');
  assert.match(tree.map(textOf).join(''), /clipboard denied/);
});

test('a late earlier clipboard success cannot override a newer copy failure', async () => {
  const h = clientHarness();
  h.store.set('s', state({ answers: { 1: { active: 'native', items: [], override: { text: 'edited answer' } } } }));
  const first = deferred(); let attempts = 0;
  h.window.navigator.clipboard.writeText = () => ++attempts === 1
    ? first.promise : Promise.reject(new Error('latest copy denied'));
  const copy = () => findAll(h.render(h.AssistantToolbar, props), (node) => node.type === 'button'
    && node.props['data-mtt'] === 'copy-answer')[0];
  const earlier = copy().props.onClick();
  await copy().props.onClick();
  first.resolve();
  await earlier;
  assert.notEqual(copy().props.title, 'Copied');
  assert.match(h.render(h.AssistantToolbar, props).map(textOf).join(''), /latest copy denied/);
});

test('copying a translation reports a failed clipboard write without claiming success', async () => {
  const h = clientHarness();
  h.store.set('s', state({ shown: { 1: 'zh' }, translations: { 5: { zh: { turn: 1, text: '译文' } } } }));
  h.window.navigator.clipboard.writeText = () => { throw new Error('clipboard unavailable'); };
  const menu = findAll(h.render(h.AssistantToolbar, props), (node) => node.type === 'menu'
    && node.props.items?.some((item) => item.id === 'message-toolbar/copy-translation'))[0];
  assert.ok(menu);
  await menu.props.onSelect('message-toolbar/copy-translation'); await flush();
  const text = h.render(h.AssistantToolbar, props).map(textOf).join('');
  assert.match(text, /clipboard unavailable/);
  assert.doesNotMatch(text, /Translation copied/);
});

test('copying a question without clipboard access reports a usable error', async () => {
  const h = clientHarness(); h.store.set('s', state());
  h.window.navigator.clipboard = undefined;
  const rowProps = { ...props, text: 'question' };
  const copy = findAll(h.render(h.UserRow, rowProps), (node) => node.props['data-mtt'] === 'copy')[0];
  await copy.props.onClick();
  const tree = h.render(h.UserRow, rowProps);
  assert.equal(findAll(tree, (node) => node.props['data-mtt'] === 'copy')[0].props.title, 'Copy');
  assert.match(tree.map(textOf).join(''), /clipboard|Clipboard/);
});

test('a grouped answer shows the completed translation beside its source', () => {
  const h = clientHarness();
  h.store.set('s', state({ runs: { 1: { turns: [1, 2], active: 1 } }, shown: { 1: 'zh' },
    translations: { 5: { zh: { turn: 1, text: '译文' } } } }));
  const tree = h.render(h.AnswerCard, props);
  assert.equal(byClass(tree, 'mtt-pair-src').map(textOf).join(''), 'original answer');
  assert.equal(byClass(tree, 'mtt-pair-tr').map(textOf).join(''), '译文');
});

test('old hosts keep the native original visible until its source is known', () => {
  const h = clientHarness();
  h.store.set('s', state({ turns: [{ turn: 1, answered: true }], shown: { 1: 'zh' },
    translations: { 5: { zh: { turn: 1, text: '译文' } } } }));
  h.render(h.AnswerCard, props);
  assert.equal(h.nativeHideStyle.node.textContent.includes('assistant-step'), false);
});

for (const action of ['answer-save', 'answer-select', 'answer-delete', 'answer-restore']) {
  test(action + ' immediately removes the previous translation from the client', async () => {
    const h = clientHarness();
    h.store.set('s', state({ shown: { 1: 'zh' }, origins: { 1: 'old answer' },
      translations: { 5: { zh: { turn: 1, text: 'old translation' } } } }));
    h.window.fetch = async () => jsonResponse({ turn: 1, active: 'native', items: [], override: { text: 'new answer' } });
    await h.answerMutate({ action, sessionId: 's', turn: 1 });
    const tree = h.render(h.AnswerCard, props);
    assert.equal(byClass(tree, 'mtt-pair-tr').length, 0);
    assert.equal(byClass(tree, 'native-md').map(textOf).join(''), 'new answer');
  });
}

test('a local mutation during GET discards the old snapshot and settles after one refresh', async () => {
  const h = clientHarness();
  h.store.set('s', state());
  const first = deferred(), second = deferred(); let gets = 0;
  h.window.fetch = () => [first, second][gets++].promise;
  const loaded = h.store.load('s'); await flush();
  h.store.patchHidden('s', { turns: [], answers: [1], prompts: [] });
  first.resolve(jsonResponse(state())); await flush();
  assert.equal(gets, 2);
  assert.equal(h.store.get('s').state.hidden.answers[0], 1);
  second.resolve(jsonResponse(state({ hidden: { turns: [], answers: [1], prompts: [] } })));
  await loaded;
  assert.equal(h.store.get('s').loading, false);
  assert.equal(h.store.inflight.has('s'), false);
});

test('invalidations during GET coalesce into one fresh snapshot request', async () => {
  const h = clientHarness(); h.store.set('s', state());
  const first = deferred(), second = deferred(); let gets = 0;
  h.window.fetch = () => [first, second][gets++].promise;
  const loaded = h.store.load('s'); await flush();
  h.store.invalidate('s'); h.store.invalidate('s');
  first.resolve(jsonResponse(state())); await flush();
  assert.equal(gets, 2);
  second.resolve(jsonResponse(state({ prompts: { 1: { text: 'fresh question' } } })));
  await loaded;
  assert.equal(h.store.get('s').state.prompts[1].text, 'fresh question');
  assert.equal(h.store.get('s').loading, false);
});

test('a failed GET clears loading without retrying an unchanged request', async () => {
  const h = clientHarness(); h.store.set('s', state()); let gets = 0;
  h.window.fetch = async () => { gets++; throw new Error('offline'); };
  await h.store.load('s');
  assert.equal(gets, 1);
  assert.equal(h.store.get('s').loading, false);
  assert.equal(h.store.inflight.has('s'), false);
  assert.match(h.store.get('s').error, /offline/);
});

test('a successful unchanged GET is not fetched a second time', async () => {
  const h = clientHarness(); h.store.set('s', state()); let gets = 0;
  h.window.fetch = async () => { gets++; return jsonResponse(state({ prompts: { 1: { text: 'fresh' } } })); };
  await h.store.load('s');
  assert.equal(gets, 1); assert.equal(h.store.get('s').loading, false);
  assert.equal(h.store.get('s').state.prompts[1].text, 'fresh');
});

test('replayed prompt hiding combines with answer and translation hiding', () => {
  const h = clientHarness();
  h.nativeHideStyle.set('prompt:1', 1, 'prompt');
  h.nativeHideStyle.set('tail:1', 1, 'answer');
  assert.match(h.nativeHideStyle.node.textContent, /assistant-step/);
  h.nativeHideStyle.set('tail:1', 1, 'translate');
  assert.match(h.nativeHideStyle.node.textContent, /assistant-step/);
});

test('the rail follows an edited question and active run while accepting later native turns', () => {
  const h = clientHarness();
  h.store.set('s', state({ prompts: { 1: { text: 'edited question' } },
    turns: [{ turn: 1, answerText: 'old answer' }, { turn: 2, answerText: 'selected answer' }],
    runs: { 1: { turns: [1, 2], active: 2 } }, hidden: { turns: [], answers: [], prompts: [2] } }));
  let items = [{ turn: 1, prompt: 'old question', response: 'old answer' }, { turn: 2, response: 'selected answer' }];
  const snapshot = { navigation: { items: () => items } };
  const target = h.railTarget({ getSnapshot: () => snapshot }, 's');
  let actual = target.getSnapshot().navigation.items();
  assert.equal(actual.length, 1);
  assert.equal(actual[0].prompt, 'edited question');
  assert.equal(actual[0].response, 'selected answer');
  items = [...items, { turn: 3, prompt: 'new question', response: 'new answer' }];
  actual = target.getSnapshot().navigation.items();
  assert.equal(actual[1].turn, 3);
  assert.equal(actual[1].response, 'new answer');
});

test('the outline clears a deleted answer even when its native text and edit remain cached', () => {
  const h = clientHarness();
  const snapshot = state({ hidden: { answers: [1], turns: [], prompts: [] },
    answers: { 1: { active: 'native', items: [], override: { text: 'deleted edit' } } } });
  h.store.set('s', snapshot);
  const actual = h.patchRailItems([{ turn: 1, response: 'deleted native' }], snapshot, 's');
  assert.equal(actual[0].response, '');
});

test('the outline follows the surviving replay after its group shrinks to one answer', () => {
  const h = clientHarness();
  const snapshot = state({ runs: {}, replays: { 2: 1 },
    hidden: { answers: [1], turns: [], prompts: [2] },
    turns: [{ turn: 1, answerText: 'deleted original' }, { turn: 2, answerText: 'surviving replay' }] });
  h.store.set('s', snapshot);
  const actual = h.patchRailItems([{ turn: 1, response: 'deleted original' }, { turn: 2, response: 'surviving replay' }], snapshot, 's');
  assert.equal(actual.length, 1);
  assert.equal(actual[0].response, 'surviving replay');
});

test('projection outlines also reflect prompt edits and the selected answer', () => {
  const h = clientHarness(); h.store.set('s', state());
  const raw = [{ turn: 1, prompt: 'old question', response: 'old answer' }];
  const face = h.outlineFace('s', { getSnapshot: () => raw, subscribe: () => () => {} });
  face.getSnapshot();
  h.store.patchPrompt('s', { 1: { text: 'edited question' } });
  h.store.patchAnswer('s', 1, { active: 'native', items: [], override: { text: 'edited answer' } });
  const actual = face.getSnapshot();
  assert.equal(actual[0].prompt, 'edited question');
  assert.equal(actual[0].response, 'edited answer');
});

function editor(h) {
  h.store.set('s', state());
  const draw = h.mount(h.UserRow, { ...props, slot: element(), bubble: element() });
  findAll(draw(), (n) => n.props['data-mtt'] === 'edit')[0].props.onClick();
  return draw;
}
const button = (tree, text) => findAll(tree, (node) => node.type === 'button' && textOf(node) === text)[0];
const drop = (tree, files) => byClass(tree, 'mtt-answer-edit-prompt')[0].props.onDrop({
  preventDefault() {}, stopPropagation() {}, dataTransfer: { files },
});

test('pending attachments block both Send and the keyboard shortcut until upload completes', async () => {
  const h = clientHarness(), pending = deferred(), sent = [];
  h.window.fetch = async (url, init) => {
    if (String(url).includes('uploadFileBinary')) return pending.promise;
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); sent.push(body);
      if (body.action === 'prompt-save') return jsonResponse({ prompts: { 1: { text: body.text, files: body.files } } });
      if (body.action === 'changes') return jsonResponse({ supported: false });
      return jsonResponse({ turn: 2 });
    }
    return jsonResponse(state());
  };
  const draw = editor(h), beforeDrop = draw(); drop(beforeDrop, [{ name: 'report.pdf', type: 'application/pdf' }]);
  let tree = draw();
  assert.equal(button(tree, 'Send').props.disabled, true);
  // Invoke the handler captured before React could render the pending upload.
  byClass(beforeDrop, 'mtt-answer-edit-input')[0].props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  await flush(); assert.equal(sent.some((body) => body.action === 'answer-run'), false);
  pending.resolve(jsonResponse({ ok: true, value: { file: { attachmentId: 'file-1', name: 'report.pdf' } } }));
  await flush(); tree = draw();
  assert.equal(button(tree, 'Send').props.disabled, false);
  await button(tree, 'Send').props.onClick();
  assert.equal(sent.find((body) => body.action === 'answer-run').files[0].attachment.attachmentId, 'file-1');
});

test('a failed upload stays explicit and prevents sending an incomplete question', async () => {
  const h = clientHarness(); const sent = [];
  h.window.fetch = async (url, init) => {
    if (String(url).includes('uploadFileBinary')) throw new Error('upload offline');
    sent.push(JSON.parse(init.body)); return jsonResponse({ supported: false });
  };
  const draw = editor(h); drop(draw(), [{ name: 'report.pdf', type: 'application/pdf' }]);
  await flush(); let tree = draw();
  assert.match(tree.map(textOf).join(''), /upload offline/);
  await button(tree, 'Send').props.onClick(); await flush(); tree = draw();
  assert.equal(sent.some((body) => body.action === 'answer-run'), false);
  assert.match(tree.map(textOf).join(''), /upload offline/);
});

for (const retry of [false, true]) {
  test(retry ? 'successfully retrying a failed attachment allows sending it'
    : 'uploading another attachment cannot silently discard a failed attachment', async () => {
    const h = clientHarness(), sent = []; let uploads = 0;
    h.window.fetch = async (url, init) => {
      if (String(url).includes('uploadFileBinary')) {
        if (++uploads === 1) throw new Error('upload offline');
        return jsonResponse({ ok: true, value: { file: { attachmentId: 'file-2', name: retry ? 'report.pdf' : 'other.pdf' } } });
      }
      const body = JSON.parse(init.body); sent.push(body);
      if (body.action === 'prompt-save') return jsonResponse({ prompts: { 1: { text: body.text, files: body.files } } });
      return jsonResponse({ supported: false, turn: 2 });
    };
    const draw = editor(h);
    drop(draw(), [{ name: 'report.pdf', type: 'application/pdf' }]); await flush();
    drop(draw(), [{ name: retry ? 'report.pdf' : 'other.pdf', type: 'application/pdf' }]); await flush();
    await button(draw(), 'Send').props.onClick(); await flush();
    const replay = sent.find((body) => body.action === 'answer-run');
    assert.equal(Boolean(replay), retry);
    if (retry) assert.equal(replay.files[0].attachment.attachmentId, 'file-2');
    else assert.match(draw().map(textOf).join(''), /upload offline/);
  });
}

test('NDJSON decodes UTF-8 split at every byte and releases the completed reader', async () => {
  const h = clientHarness();
  const bytes = new TextEncoder().encode('{"type":"delta","text":"中文"}\n{"type":"done","payload":{"ok":true}}');
  let offset = 0, released = false;
  h.window.fetch = async () => ({ ok: true, body: { getReader: () => ({
    async read() { return offset < bytes.length ? { value: bytes.slice(offset, ++offset), done: false } : { done: true }; },
    releaseLock() { released = true; },
  }) } });
  let text = '';
  const result = await h.streamOperation({}, { onDelta: (delta) => { text += delta; } });
  assert.equal(text, '中文'); assert.equal(result.ok, true); assert.equal(released, true);
});

for (const frames of ['not json\n{"type":"done","payload":{"ok":true}}\n', 'null\n', '{"type":"delta","text":42}\n']) {
  test('malformed NDJSON fails explicitly: ' + frames.slice(0, 20), async () => {
    const h = clientHarness(); h.window.fetch = async () => ({ ok: true, text: async () => frames });
    await assert.rejects(h.streamOperation({}), /无效|格式|流|响应/);
  });
}

test('a disconnected reader rejects the operation and releases its lock', async () => {
  const h = clientHarness(); let released = false, cancelled = false;
  h.window.fetch = async () => ({ ok: true, body: { getReader: () => ({
    async read() { throw new Error('connection lost'); },
    async cancel() { cancelled = true; }, releaseLock() { released = true; },
  }) } });
  await assert.rejects(h.streamOperation({}), /connection lost/);
  assert.equal(released, true); assert.equal(cancelled, true);
});

test('an unterminated stream never publishes a partial translation', async () => {
  const h = clientHarness(); h.store.set('s', state());
  h.window.fetch = async () => streamResponse([{ type: 'delta', text: 'partial translation' }]);
  await assert.rejects(h.translateInto('s', 1, { eventSeq: 5, lang: 'zh' }), /提前结束/);
  assert.equal(h.store.getLiveTranslation('s', 1), null);
  assert.equal(Object.keys(h.store.get('s').state.shown).length, 0);
  assert.equal(Object.keys(h.store.get('s').state.translations).length, 0);
});
