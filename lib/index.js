
// dsh-message-toolbar — host half.
//
// Owns /message-toolbar. Mutations select a conversation path inside the
// current session. Earlier native versions remain available for navigation.
//
// The branching transaction shape is derived from dsh-plugin-message-edit
// (MIT © SpookySandwich) and dsh-message-edit (MIT © Moeblack).

import crypto from 'node:crypto';
import { ancestorChainFromLog, collectFamily } from './toolbar-logic.js';
import { sessionEventCount, sessionRecord, readSessionRecord } from './session-record.js';
import { revertWorkspacePlan } from './workspace-revert.js';
import { sessionModel } from './model-selection.js';
import { contextTurns, hasLegacyContext } from './context-history.js';
import { inSessionView, inSessionDisplay, projectModelMessages, selectPath, rememberContinuation, editTurn, deleteQuestion, promptWith } from './in-session-context.js';
import {
  flushState,
  deletedVersionIds, markDeleted, unmarkDeleted,
  translationFor, storeTranslation, translationsForSession, shownForSession, originTextsForSession, setShown,
  clearTranslationForTurn, reserveTranslation, beginTranslation, currentTranslation, cancelTranslation, finishTranslation,
  answerEntry, answersForSession, hiddenForSession, promptOverridesForSession,
  runsForSession, replaysForSession,
  navigationFor, pendingNavigationFor, recordNavigation,
  contextFor, writeContext,
} from './state-store.js';

/** Same-origin endpoint owned by this plugin's host half. */
const MESSAGE_TOOLBAR_PATH = '/message-toolbar';
/**
 * The last row dump a client sent, and whether it should keep sending them.
 *
 * The flow rows are drawn by the app, and nothing in this process can see them:
 * when a row the reader deletes leaves something behind, the only way to learn
 * which kinds and attributes that row has is to ask the client. `?rows=1` turns
 * the dump on and answers with what arrived; `POST {action:'rows'}` feeds it.
 */
let wantRows = false;
let rowDigest = null;
/** Durable version-marker schema. */
const MESSAGE_TOOLBAR_SCHEMA = 2;
/** Durable marker event type. Deliberately distinct from message-edit/message-tree. */
const MARKER_TYPE = 'message-toolbar/version';
/**
 * Marker types this plugin understands. Branches created by the older
 * dsh-plugin-message-edit use `message-tree/version` with the exact same
 * `{schemaVersion, effect, inverse}` payload, so accepting both keeps every
 * existing version card and ‹ › ring working after switching plugins.
 */
const MARKER_TYPES = new Set([MARKER_TYPE, 'message-tree/version']);

function isVersionMarker(event) {
  return event !== null && typeof event === 'object' && MARKER_TYPES.has(event.type);
}

const name = 'message-toolbar';
const inject = [
  'sessions',
  'agents',
  'sessionPersistence',
  'sessionQuery',
  'webServer',
  'workspaceRegistry',
  'llm',
];

/* ------------------------------------------------------------ log reading -- */

function userText(message) {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n');
}

function textPreview(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const limit = max ?? 90;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/**
 * Attachment blocks handed in by the editor: `{type:'file'|'image', attachment:
 * {attachmentId, …}}` — exactly what the app's own upload endpoint answers with.
 * Only the identity is checked; the reference belongs to the attachment service
 * and is passed through untouched.
 */
function promptAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('files 必须是一个数组。');
  const blocks = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') throw new TypeError('files 里有无法识别的内容。');
    const type = item.type === 'image' ? 'image' : item.type === 'file' ? 'file' : null;
    if (type === null) throw new TypeError('files 只接受 file 或 image。');
    const ref = item.attachment;
    if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') {
      throw new TypeError('附件缺少 attachmentId。');
    }
    blocks.push({ type, attachment: ref });
  }
  return blocks;
}

/* ---------------------------------------------------------------- planning -- */

function agentOptions(events, fallback) {
  const config = events.findLast((event) => event.type === 'request/header')?.data.header.config;
  const selection = sessionModel(events);
  const provider = selection?.provider ?? fallback?.provider;
  const model = selection?.model ?? fallback?.model;
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。');
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
  const reasoningEffort = selection?.reasoningEffort ?? fallback?.reasoningEffort;
  return {
    provider, model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  };
}

function sessionPreset(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset;
  }
  return session.header.agentPreset;
}

async function loadSessionRecord(ctx, sessionId) {
  return readSessionRecord(ctx, sessionId);
}

const contextLocks = new WeakMap();
const contextHooks = new WeakSet();

async function flushSession(ctx, session) {
  if (await ctx.sessions.flush(session) !== true) throw new Error('DSH 未确认消息已保存，请检查会话存储服务。');
}

/**
 * `agent.followup()` only enqueues a message. Match the admitted prompt even
 * when the driver stops before it opens a model step.
 */
function waitForQueuedPrompt(ctx, agent, messageId, timeout = 15000) {
  const session = agent?.session;
  const eventContext = agent?.ctx && typeof agent.ctx.on === 'function' ? agent.ctx : ctx;
  const hasMessage = () => (session?.snapshotEvents?.() ?? session?.events ?? []).some(event =>
    event.type === 'user/message' && event.data?.id === messageId && event.data?.source?.kind === 'user');
  if (hasMessage()) return { promise: Promise.resolve(), cancel() {} };
  if (typeof eventContext?.on !== 'function') throw new Error('当前 DSH 无法确认重答问题已经写入会话。');

  let disposeSession = () => {}, disposeClaimed = () => {}, disposeDiscarded = () => {};
  let timer;
  let claimedTurn;
  let settled = false;
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    disposeSession(); disposeClaimed(); disposeDiscarded();
    if (error) rejectPromise(error); else resolvePromise();
  };
  const failed = () => new Error('重答问题未能写入当前会话。');
  disposeSession = eventContext.on('session/event', (subject, event) => {
    if (subject?.header?.id !== session?.header?.id) return;
    if (event.type === 'user/message' && event.data?.id === messageId
      && event.data?.source?.kind === 'user') { finish(); return; }
    if (event.type === 'turn/end' && claimedTurn !== undefined && event.data?.turn === claimedTurn) finish(failed());
  }) ?? disposeSession;
  disposeClaimed = eventContext.on('agent/inbox/claimed', payload => {
    if (payload?.agent === agent && payload.message?.id === messageId && Number.isSafeInteger(payload.turn)) {
      claimedTurn = payload.turn;
    }
  }) ?? disposeClaimed;
  disposeDiscarded = eventContext.on('agent/inbox/discarded', payload => {
    if (payload?.agent === agent && payload.message?.id === messageId) finish(failed());
  }) ?? disposeDiscarded;
  timer = setTimeout(() => finish(new Error('等待重答问题写入会话历史超时。')), timeout);
  return { promise, cancel() { finish(); } };
}

function legacyState(sessionId) {
  return { runs: runsForSession(sessionId), replays: replaysForSession(sessionId),
    prompts: promptOverridesForSession(sessionId), answers: answersForSession(sessionId), hidden: hiddenForSession(sessionId) };
}

function selectedView(record) {
  const id = record.header.id;
  const saved = contextFor(id);
  return inSessionView(record.events, saved, saved === undefined ? legacyState(id) : undefined);
}

async function withContextLock(ctx, id, task) {
  let locks = contextLocks.get(ctx);
  if (!locks) contextLocks.set(ctx, locks = new Set());
  if (locks.has(id)) throw new Error('这条会话正在更新回答，请稍后再试。');
  locks.add(id);
  try { return await task(); }
  finally { locks.delete(id); }
}

function targetIn(view, number) {
  const node = view.path.find(candidate => candidate.turn === number);
  const turn = view.turns.find(candidate => candidate.turn === number);
  if (!node || !turn?.user) throw new TypeError(`第 ${number} 轮没有可操作的提问。`);
  return { node, turn, content: node.prompt ?? turn.user.data.content };
}

function queuedWork(agent) {
  return (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0;
}

async function resumeForRetry(ctx, id, source, requestedModel) {
  const presetId = sessionPreset(source);
  const presets = ctx.get('agentPresets');
  const preset = presetId !== undefined && presets ? (await presets.resolve(presetId)).id : undefined;
  return ctx.agents.resume({ resumeSessionId: id, agentOptions: agentOptions(source.events, requestedModel),
    ...(preset === undefined ? {} : { setup: async agentCtx => { await presets.mount(agentCtx, preset); } }) });
}

async function runContextOperation(ctx, input) {
  const operation = { ...input, sessionId: sessionIdOf(input.sessionId), turn: integerOf(input.turn, 'turn'),
    model: input.model === undefined ? undefined : modelRequest(input.model),
    files: input.files === undefined ? undefined : promptAttachments(input.files) };
  const kind = operation.operation;
  if (!['retry', 'edit-prompt', 'edit-answer', 'delete-question', 'delete-answer', 'select'].includes(kind)) {
    throw new TypeError('无法识别的回答操作。');
  }
  if (operation.operation === 'edit-answer') answerTextOperation(operation);
  if (kind === 'edit-prompt' || operation.text !== undefined) {
    if (typeof operation.text !== 'string' || (operation.text.trim() === '' && !operation.files?.length)) {
      throw new TypeError('请输入文字或保留至少一个附件。');
    }
  }
  const { sessionId: id } = operation;
  return withContextLock(ctx, id, async () => {
    if (!contextHooks.has(ctx)) throw new Error('当前 DSH 未能加载工具栏的回答上下文支持。');
    if (sessionArchived(ctx, id)) throw new Error('请先在 DSH 中打开这条已归档的会话。');
    const source = await loadSessionRecord(ctx, id);
    targetIn(selectedView(source), operation.turn);
    let agent = ctx.agents.get(id), owned;
    if (!agent && kind === 'retry') {
      owned = await resumeForRetry(ctx, id, source, operation.model);
      agent = owned.agent;
    }
    let queued, restoration;
    try {
      if (agent && queuedWork(agent)) throw new Error('会话还有待发送消息，请等它完成后再试。');
      if (agent?.status === 'running' && operation.stopPrevious === true) {
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        await agent.whenIdle();
      }
      const update = async () => {
        if (agent && queuedWork(agent)) throw new Error('会话还有待发送消息，请等它完成后再试。');
        const view = selectedView(agent ? sessionRecord(agent.session) : source);
        const { node, content } = targetIn(view, operation.turn);
        if (kind !== 'retry') {
          updateSelection(view, node, content, operation, id);
          writeContext(id, view.state);
          clearTranslationForTurn(id, operation.turn);
          return;
        }
        const prompt = { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' },
          content: promptWith(content, operation.text, operation.files) };
        const previous = contextFor(id);
        // Existing DSH events must be durable before state can reference them.
        await flushSession(ctx, agent.session);
        if (queuedWork(agent)) throw new Error('会话还有待发送消息，请等它完成后再试。');
        rememberContinuation(view);
        view.state.pending = { messageId: prompt.id, group: node.group, parent: node.parent,
          ...(operation.model ? { model: operation.model } : {}) };
        queued = waitForQueuedPrompt(ctx, agent, prompt.id);
        try {
          writeContext(id, view.state);
          if (operation.model !== undefined) {
            const beforeModel = modelSelection(agent.model?.current?.() ?? agent.options);
            const temporary = selectModelForNextTurn(ctx, agent, operation.model);
            restoration = watchReplayModelRestoration(ctx, agent, id, prompt.id, beforeModel, temporary);
          }
          agent.followup(prompt);
        } catch (error) {
          queued.cancel();
          restoration?.dispose(); restoration?.restore();
          writeContext(id, previous);
          throw error;
        }
      };
      if (agent) await agent.runMaintenance(update);
      else await update();
      if (queued) {
        await queued.promise;
        await flushSession(ctx, agent.session);
      }
      return { sessionId: id, turn: operation.turn, queuedTurns: queued ? 1 : 0, inPlace: true };
    } finally {
      if (owned) {
        void agent.whenIdle().then(() => owned.dispose()).catch(error => ctx.logger?.warn?.(String(error)));
      }
    }
  });
}

function updateSelection(view, node, content, operation, id) {
  const { state } = view;
  switch (operation.operation) {
    case 'select': selectPath(view, node.turn, operation.id); break;
    case 'edit-prompt': editTurn(view, node, { prompt: promptWith(content, operation.text, operation.files) }); break;
    case 'edit-answer': editTurn(view, node, { answer: operation.text }); break;
    case 'delete-question': deleteQuestion(view, node); break;
    case 'delete-answer': {
      const choices = inSessionDisplay(view, id).contextChoices[node.turn]?.items ?? [];
      const index = choices.findIndex(choice => choice.id === node.id);
      const fallback = index < 0 ? choices.at(-1) : choices[index - 1] ?? choices[index + 1];
      if (fallback) { selectPath(view, node.turn, fallback.id); state.removed.push(node.id); }
      else editTurn(view, node, { answer: null });
      break;
    }
  }
}

/* -------------------------------------------------------------- family -- */

/** All message-toolbar/version events of one session's full log, in seq order. */
async function versionMarkers(ctx, sessionId) {
  const { events } = await loadSessionRecord(ctx, sessionId);
  return events.filter(isVersionMarker);
}

/**
 * Assemble one conversation family, bridging sessions the user has deleted.
 * Every version's seed inherits its ancestors' markers, so a deleted
 * ancestor's identity, parent and target turn survive in its descendants'
 * logs. Families never span working directories.
 */
async function assembleFamily(ctx, sessionId) {
  const records = await ctx.sessionQuery.listSessions();
  const recordsById = new Map(records.map((record) => [record.header.id, record]));
  const target = recordsById.get(sessionId);
  if (target === undefined) throw new Error(`session "${sessionId}" not found`);

  const ghostInfo = new Map();
  const absorbChain = (chain) => {
    for (let i = 0; i < chain.length; i++) {
      const link = chain[i];
      if (recordsById.has(link.sessionId)) continue;
      const info = ghostInfo.get(link.sessionId) ?? {};
      if (link.marker !== undefined) info.marker = link.marker;
      if (i + 1 < chain.length) info.parentId = chain[i + 1].sessionId;
      ghostInfo.set(link.sessionId, info);
    }
  };

  // The target's root: surviving headers first, the log bridge at a hole.
  let rootId;
  {
    const seen = new Set();
    let cursor = target.header;
    while (cursor.parentSession !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = recordsById.get(cursor.parentSession);
      if (parent === undefined) break;
      cursor = parent.header;
    }
    rootId = cursor.id;
    if (cursor.parentSession !== undefined) {
      const chain = ancestorChainFromLog(cursor.parentSession, await versionMarkers(ctx, cursor.id));
      absorbChain(chain);
      if (chain.length > 0) rootId = chain[chain.length - 1].sessionId;
    }
  }

  // Other orphans in the same cwd may belong to this family through their own
  // holes; each orphan's log names its full ancestry.
  for (const record of records) {
    const parentId = record.header.parentSession;
    if (parentId === undefined || recordsById.has(parentId)) continue;
    if (record.header.cwd !== target.header.cwd) continue;
    if (record.header.id === sessionId) continue;
    try {
      absorbChain(ancestorChainFromLog(parentId, await versionMarkers(ctx, record.header.id)));
    } catch {
      // An unreadable orphan stays an island; the family is still assembled.
    }
  }

  const entries = [];
  for (const record of records) {
    if (record.header.cwd !== target.header.cwd && record.header.id !== sessionId) continue;
    entries.push({
      id: record.header.id,
      ...record.header.parentSession === undefined ? {} : { parentId: record.header.parentSession },
      createdAt: record.header.createdAt,
      ghost: false,
    });
  }
  for (const [id, info] of ghostInfo) {
    entries.push({
      id,
      ...info.parentId === undefined ? {} : { parentId: info.parentId },
      createdAt: info.marker?.time ?? 0,
      ghost: true,
      ...info.marker === undefined ? {} : { marker: info.marker },
    });
  }
  return { rootId, flat: collectFamily(rootId, entries), recordsById };
}

/* ------------------------------------------------------- workspace glue -- */

/** Archived session ids, as a Set; empty when the registry cannot say. */
function archivedSessionIdSet(ctx) {
  try {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function sessionArchived(ctx, sessionId) {
  return archivedSessionIdSet(ctx).has(sessionId);
}

/**
 * Reopen the archived session selected by the reader. DSH cannot navigate
 * to an archived session until it is restored.
 */
async function activateVersion(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) throw new Error('workspaceRegistry 不可用，无法取消归档。');
  if (!registry.archivedSessionIds.includes(sessionId)) return { unarchived: false };
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId);
    return { unarchived: true };
  }
  throw new Error('此 DSH 版本未提供公开的取消归档 API，请升级后再切换版本。');
}

/** Serialize changes to the pending navigation record for each family. */
const focusLocks = new WeakMap();
async function withFocusLock(ctx, root, task) {
  let locks = focusLocks.get(ctx);
  if (!locks) focusLocks.set(ctx, locks = new Map());
  const previous = locks.get(root) ?? Promise.resolve();
  const running = previous.catch(() => {}).then(task);
  locks.set(root, running);
  try { return await running; }
  finally { if (locks.get(root) === running) locks.delete(root); }
}

async function prepareFocus(ctx, sessionId, source, { requireCurrentSource, beforeRecord } = {}) {
  const family = await tree(ctx, sessionId);
  if (!family.versions.some(version => version.sessionId === source)) {
    throw new Error('只能在同一工具栏会话的版本之间切换。');
  }
  const root = family.rootSessionId;
  return withFocusLock(ctx, root, async () => {
    if (requireCurrentSource) await requireCurrentSource();
    const job = { token: crypto.randomUUID(), target: sessionId, source, root, completed: false,
      archived: sessionArchived(ctx, sessionId) };
    beforeRecord?.(job);
    recordNavigation(root, job);
    return job;
  });
}

function focusJob(root, sessionId, token) {
  const job = navigationFor(root);
  if (!job || job.target !== sessionId || job.token !== token) {
    throw new Error('版本切换已被更新的导航替代，请重新选择。');
  }
  return job;
}

async function focusVersion(ctx, sessionId, token) {
  const { rootSessionId } = await tree(ctx, sessionId);
  return withFocusLock(ctx, rootSessionId, () => {
    const job = focusJob(rootSessionId, sessionId, token);
    if (job.completed === true || job.cancelled === true) throw new Error('版本切换已经结束，请重新选择。');
    recordNavigation(rootSessionId, { ...job, completed: true });
    return { active: sessionId };
  });
}

async function cancelFocus(ctx, sessionId, token) {
  const { rootSessionId } = await tree(ctx, sessionId);
  return withFocusLock(ctx, rootSessionId, () => {
    const job = focusJob(rootSessionId, sessionId, token);
    if (job.completed === true) return { cancelled: job.cancelled === true, sessionId, token };
    recordNavigation(rootSessionId, { ...job, completed: true, cancelled: true });
    return { cancelled: true, sessionId, token };
  });
}

/* -------------------------------------------------------------- operations -- */

const LANGUAGE_NAMES = {
  zh: 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  es: 'Spanish (Español)',
  ru: 'Russian (Русский)',
};

const TRANSLATE_SYSTEM = [
  'You are a precise professional translator.',
  'Translate the user-supplied text into the requested target language.',
  'Preserve Markdown formatting, links, lists and numbers exactly.',
  'The text contains placeholders such as ⟦1⟧ standing for code, formulas and sentences already written in',
  'the target language: copy every placeholder into your translation unchanged, in the same order, without',
  'translating them and without repeating them.',
  'Do not translate code identifiers, file paths, URLs or model names.',
  'Do not add commentary, explanations or notes.',
  'Reply with ONLY the translated text.',
].join(' ');

/**
 * Everything the model must never rewrite: fenced and inline code, display and
 * inline math. They are lifted out before the request and put back afterwards, so
 * a translation cannot reformat `console.log(x)` or break a LaTeX macro — the only
 * way to keep code and formulas byte-identical is to never hand them over.
 */
const BLOCK_PATTERNS = [
  /```[\s\S]*?```/g,
  /~~~[\s\S]*?~~~/g,
  /\$\$[\s\S]*?\$\$/g,
  /\\\[[\s\S]*?\\\]/g,
];

const INLINE_PATTERNS = [
  /`[^`\n]+`/g,
  // No whitespace just inside the dollars: `$5 and $10` is money, `$x_1$` is math.
  /\$(?=\S)[^$\n]*?\S\$/g,
  /\\\([\s\S]*?\\\)/g,
];

/**
 * Which script a target language is written in. Only used for languages whose text
 * can be recognised by script: for those, a sentence already in the target language
 * is not worth sending to a translator (or reading twice). Latin-script targets are
 * absent on purpose — "English" and "German" look alike letter for letter.
 */
const TARGET_SCRIPTS = {
  zh: ['han'],
  'zh-TW': ['han'],
  ja: ['kana', 'han'],
  ko: ['hangul'],
  ru: ['cyrillic'],
};

const SCRIPT_TESTS = {
  han: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
  kana: /[\u3040-\u30ff\u31f0-\u31ff]/g,
  hangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g,
  cyrillic: /[\u0400-\u04ff]/g,
};

const WORD_CHARS = /[A-Za-z\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

function countMatches(text, pattern) {
  const found = text.match(pattern);
  return found === null ? 0 : found.length;
}

/**
 * Is this piece already written in the target language? Judged by script share, which
 * is decisive for Chinese/Japanese/Korean/Russian and deliberately unused for Latin
 * scripts.
 */
function alreadyInTarget(piece, scripts) {
  const words = countMatches(piece, WORD_CHARS);
  if (words === 0) return false;
  let mine = 0;
  for (const script of scripts) mine += countMatches(piece, SCRIPT_TESTS[script]);
  // Two characters is the shortest piece worth calling a sentence; below that the
  // share is just noise from a stray word.
  return mine >= 2 && mine / words >= 0.5;
}

/**
 * Lift every sentence that is already in the target language, so it is neither sent
 * to the model nor translated a second time. This runs before the code patterns,
 * because a sentence like `先运行 \`npm run build\` 再继续。` should be kept whole —
 * code included — rather than half-protected twice.
 */
function liftTargetLanguage(text, lang, kept) {
  const scripts = TARGET_SCRIPTS[lang];
  if (scripts === undefined) return text;
  return text.replace(/[^\n。！？；!?;]+[。！？；!?;]?/g, (piece) => {
    if (!alreadyInTarget(piece, scripts)) return piece;
    kept.push(piece);
    return `⟦${kept.length}⟧`;
  });
}

/** Lift code, formulas and already-translated sentences out of the text. */
function protectText(text, lang) {
  const kept = [];
  let out = liftTargetLanguage(text, lang, kept);
  const lift = (block) => (match, offset, whole) => {
    kept.push(match);
    const token = `⟦${kept.length}⟧`;
    if (!block) return token;
    const standing = /(^|\n)[ \t]*$/.test(whole.slice(0, offset));
    return standing ? `\n\n${token}\n\n` : token;
  };
  for (const pattern of BLOCK_PATTERNS) out = out.replace(pattern, lift(true));
  for (const pattern of INLINE_PATTERNS) out = out.replace(pattern, lift(false));
  return { text: out, kept };
}

/** Put them back, by placeholder number. */
function restoreText(text, kept) {
  if (kept.length === 0) return text;
  return text.replace(/⟦(\d+)⟧/g, (match, digits) => {
    const value = kept[Number(digits) - 1];
    return value === undefined ? match : value;
  });
}

/**
 * How much of the half-restored stream is safe to send: a placeholder that has only
 * partly arrived would otherwise paint `⟦1` on screen for a moment before the code
 * lands.
 */
function settledLength(raw) {
  const at = raw.lastIndexOf('⟦');
  if (at === -1) return raw.length;
  return raw.indexOf('⟧', at) === -1 ? at : raw.length;
}

async function resolveTranslationModel(ctx, events, requested) {
  if (requested !== undefined && requested.provider && requested.model) {
    return { provider: requested.provider, model: requested.model };
  }
  const config = events.findLast((event) => event.type === 'request/header')?.data.header.config;
  if (config !== undefined && config.provider && config.model) {
    return { provider: config.provider, model: config.model };
  }
  const providers = await ctx.llm.listProviders();
  for (const provider of providers) {
    const models = await ctx.llm.listModels(provider.id);
    if (models.length > 0) return { provider: provider.id, model: models[0].id };
  }
  throw new Error('没有可用的模型来翻译。请在设置里配置模型或先发送一条消息。');
}

/** DSH's stream reports adapter failures as a finish outcome, not necessarily a throw. */
function checkedFinish(reason) {
  const kind = typeof reason === 'string' ? reason : reason?.kind;
  if (kind === 'error' || kind === 'aborted') {
    throw new Error(reason?.failure?.message || (kind === 'aborted' ? '模型请求已中止' : '模型请求失败'));
  }
  return kind;
}

function translationInput(events, operation) {
  // Two ways in: by log event (the ordinary answer) or by text (what is on
  // screen right now — a variant, or an answer the reader edited). Translating
  // the text on screen is what "translate in place" means: the reader is looking
  // at that text, so that is the text to translate.
  let text = typeof operation.text === 'string' ? operation.text : '';
  const byText = text.trim().length > 0;
  let turn;
  let role = 'assistant';
  let key;
  if (byText) {
    turn = typeof operation.turn === 'number' ? operation.turn : undefined;
    if (turn === undefined) throw new TypeError('缺少要翻译的轮次。');
    key = `turn:${turn}`;
  } else {
    const event = events.find((candidate) => candidate.seq === operation.eventSeq);
    if (event === undefined) throw new TypeError('找不到要翻译的消息。');
    let message;
    if (event.type === 'assistant/message') {
      message = event.data.message;
      turn = event.data.turn;
      role = 'assistant';
    } else if (event.type === 'user/message') {
      message = event.data;
      role = 'user';
      const index = events.indexOf(event);
      for (let i = index; i >= 0; i -= 1) {
        if (events[i].type === 'turn/start') { turn = events[i].data.turn; break; }
      }
    } else {
      throw new TypeError('只能翻译用户或助手消息。');
    }
    key = event.seq;
    text = messageText(message);
  }
  if (text.trim().length === 0) throw new TypeError('这条消息没有可翻译的文本。');
  return { turn, role, key, text, byText };
}

async function translateMessage(ctx, operation, sink) {
  const sessionId = sessionIdOf(operation.sessionId);
  const lang = typeof operation.lang === 'string' && operation.lang.length > 0 ? operation.lang : 'zh';
  if (!Object.hasOwn(LANGUAGE_NAMES, lang)) throw new TypeError(`不支持的语言：${lang}`);
  const reservation = reserveTranslation(sessionId);
  let record, input, task;
  try {
    operation.signal?.throwIfAborted();
    record = await loadSessionRecord(ctx, sessionId);
    operation.signal?.throwIfAborted();
    input = translationInput(record.events, operation);
    task = beginTranslation(sessionId, input.turn, reservation.order);
  } finally {
    reservation.release();
  }

  const { turn, role, key, text, byText } = input;
  const onAbort = () => task.abort();
  operation.signal?.addEventListener('abort', onAbort, { once: true });
  if (operation.signal?.aborted) onAbort();
  try {
  task.signal.throwIfAborted();
  const sourceHash = crypto.createHash('sha256').update(text).digest('hex');
  if (!operation.force) {
    const cached = translationFor(sessionId, key, lang);
    if (cached !== undefined && cached.text && (cached.sourceHash === sourceHash || (!byText && cached.sourceHash === undefined))) {
      setShown(sessionId, turn, lang, text);
      const ready = { turn, role, seq: key, lang, ...cached, cached: true, shown: lang, origin: text };
      if (typeof sink === 'function') sink({ type: 'done', payload: ready });
      return ready;
    }
  }
  const route = await resolveTranslationModel(ctx, record.events, operation.model);
  task.signal.throwIfAborted();
  if (typeof sink === 'function') {
    sink({
      type: 'start',
      seq: key,
      turn,
      lang,
      provider: route.provider,
      model: route.model,
      ...route.name === undefined ? {} : { name: route.name },
    });
  }
  // Code and formulas stay out of the request entirely — see PROTECTED_PATTERNS.
  const guarded = protectText(text, lang);
  let raw = '';
  let sent = 0;
  let failed;
  let finish;
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: TRANSLATE_SYSTEM,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `Translate the following text into ${LANGUAGE_NAMES[lang]}.\n\n<<<TEXT\n${guarded.text}\nTEXT>>>`,
        }],
      }],
      // No maxTokens on purpose: a translation is exactly as long as the text it
      // translates, so any cap is a guess — and a guess that cuts a long article
      // mid-sentence. The provider's own window is the only honest limit.
      signal: task.signal,
    });
    for await (const chunk of stream) {
      task.signal.throwIfAborted();
      if (chunk.type === 'text-delta') {
        raw += chunk.text;
        if (typeof sink === 'function') {
          // Placeholders are restored as the stream goes, but only up to the last
          // settled one: half a `⟦1⟧` on screen would read as noise.
          const restored = restoreText(raw.slice(0, settledLength(raw)), guarded.kept);
          if (restored.length > sent) {
            sink({ type: 'delta', text: restored.slice(sent) });
            sent = restored.length;
          }
        }
      } else if (chunk.type === 'finish') finish = checkedFinish(chunk.reason);
    }
  } catch (error) {
    failed = error;
  }
  task.signal.throwIfAborted();
  // Blocks come back with their own paragraph around them (see protectText), so
  // the padding can leave more blank lines than the original had; Markdown only
  // needs one, and the extra ones would read as gaps.
  const translation = restoreText(raw, guarded.kept).trim().replace(/\n{3,}/g, '\n\n');
  if (failed || translation.length === 0) {
    const reason = failed instanceof Error ? failed.message : '模型没有返回内容';
    throw new Error(`翻译失败：${reason}`);
  }
  // Say so instead of passing a half translation off as the whole thing: the
  // reader can see the original right above it and would notice anyway.
  const truncated = finish === 'max-tokens' || finish === 'length' || finish === 'max_tokens';
  if (!currentTranslation(sessionId, turn, task)) throw new Error('回答或翻译选择已改变，旧译文已丢弃。');
  storeTranslation(sessionId, key, lang, {
    text: translation,
    provider: route.provider,
    model: route.model,
    turn,
    role,
    sourceHash,
    ...truncated ? { truncated: true } : {},
  });
  // Translation replaces the answer in place, so choosing a language is also
  // choosing what the turn shows from now on.
  setShown(sessionId, turn, lang, text);
  const payload = {
    turn, role, seq: key, lang, text: translation, origin: text,
    provider: route.provider, model: route.model, cached: false, shown: lang,
    ...truncated ? { truncated: true } : {},
  };
  if (typeof sink === 'function') sink({ type: 'done', payload });
  return payload;
  } finally {
    operation.signal?.removeEventListener('abort', onAbort);
    finishTranslation(sessionId, turn, task);
  }
}

/**
 * Put the original back. Translation is a view decision, so this only drops the
 * "which language is shown" record — the cached translation stays for next time.
 */
async function translateOff(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  if (typeof operation.turn !== 'number') throw new TypeError('缺少要还原的轮次。');
  cancelTranslation(sessionId, operation.turn);
  return { turn: operation.turn, shown: setShown(sessionId, operation.turn, null)[String(operation.turn)] ?? null };
}

/* ------------------------------------------ in-session answer variants -- */
//
// A closed turn can never gain a second assistant/message — the session
// invariants require an open step and a monotonically growing step number — so
// "have another model answer this turn" cannot be a log event. It is instead a
// plugin-state record the client substitutes for the logged answer *in place*,
// inside the same conversation: the branch machinery below stays available for
// users who want a real agent run with tools, but switching answers no longer
// branches anything.

/**
 * The conversation as plain chat messages: every completed turn before
 * `turn`, then that turn's own question. Tool traffic is dropped — an
 * alternative answer is a pure model comparison, exactly what the same
 * question asked in a fresh chat window would produce.
 */
function loggedAnswer(events, turn) {
  let text = '';
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    if (event.data.turn !== turn) continue;
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
    const body = messageText(event.data.message);
    if (body.trim().length > 0) text = body;
  }
  return text;
}

/**
 * The model this session answers with, read the way `dsh-agent`'s own selection
 * projection does: `pending ?? lastUsed`.
 *
 * `model/selection` is what a user picks in the composer — it is appended the
 * moment they choose, and it stays pending until the request it was meant for
 * carries it away. `request/header` is what a finished request actually used.
 * Reading only the last header therefore answers "which model answered last",
 * which is wrong exactly when it matters: a turn that failed before its request
 * (quota exhausted, and so on) leaves no header, so the last header is an older
 * turn's model — and regenerating a failed turn would use the model the user
 * had already moved away from. Pending wins, exactly as the agent reads it.
 */
function answerPayload(sessionId, turn) {
  const entry = answerEntry(sessionId, turn);
  return {
    turn,
    active: entry?.active ?? 'native',
    items: entry?.items ?? [],
    override: entry?.override ?? null,
  };
}

function answerTextOperation(operation) {
  const text = operation.text;
  if (typeof text !== 'string' || text.trim().length === 0) throw new TypeError('text 必须是非空字符串。');
  return text;
}

/** Whether the log contains a turn with this number. */
function turnExists(events, turn) {
  return events.some((event) => event.type === 'turn/start' && event.data.turn === turn);
}

/** The text the editor should open with: the visible variant, or the log. */
async function answerSource(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const record = await loadSessionRecord(ctx, sessionId);
  const selected = selectedView(record);
  if (selected.modified) {
    const node = selected.path.find(item => item.turn === turn);
    const native = loggedAnswer(record.events, turn);
    return { turn, native, text: node?.answer === null || !node ? '' : node.answer ?? native };
  }
  const payload = answerPayload(sessionId, turn);
  const active = payload.items.find((item) => item.id === payload.active);
  const native = loggedAnswer(record.events, turn);
  const override = payload.override?.text;
  return {
    ...payload,
    native,
    text: active?.text ?? override ?? native,
    ...active === undefined ? {} : { source: active.kind },
    ...override === undefined || active !== undefined ? {} : { source: 'edit' },
  };
}

/**
 * Select a model through the host's public session model API.
 *
 * The session controller keeps this as a *pending* selection: `model/selection`
 * lands in the log, the next assembled request carries it, and the header it
 * produced retires it into lastUsed. Going through the controller makes the in-memory
 * copy and the log agree — appending the event alone would leave a live agent
 * answering with its old model.
 */
function selectModelForNextTurn(ctx, agent, model) {
  const selection = {
    provider: String(model.provider),
    model: String(model.model),
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
  };
  if (typeof agent.model?.select === 'function') {
    agent.model.select(selection);
    return selection;
  }
  const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined;
  const agents = controller === undefined || controller === null ? undefined : controller.agents;
  if (agents !== undefined && agents !== null && typeof agents.selectForNextRequest === 'function') {
    agents.selectForNextRequest(agent, selection);
    return selection;
  }
  // Host without that service: the durable half still applies from the next turn on.
  agent.session.append('model/selection', selection);
  return selection;
}

/** Return only fields that define DSH's effective model selection. */
function modelSelection(value) {
  if (value === null || typeof value !== 'object'
    || typeof value.provider !== 'string' || value.provider.length === 0
    || typeof value.model !== 'string' || value.model.length === 0) return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
  };
}

function sameModelSelection(left, right) {
  return left !== undefined && right !== undefined
    && left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

/**
 * A model selected for one replay is still the Session's last-used choice when
 * its request header is recorded. Watch for the exact queued user message and
 * restore only after that turn's synchronous event dispatch has unwound.
 */
function watchReplayModelRestoration(ctx, agent, sessionId, messageId, previous, temporary) {
  if (previous === undefined) return undefined;
  const eventContext = agent.ctx && typeof agent.ctx.on === 'function' ? agent.ctx : ctx;
  if (typeof eventContext?.on !== 'function') return undefined;

  let activeTurn;
  let replayTurn;
  let disposed = false;
  let disposeSession = () => {};
  let disposeClaimed = () => {};
  let disposeDiscarded = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeSession?.();
    disposeClaimed?.();
    disposeDiscarded?.();
  };
  const restore = () => {
    try {
      const current = typeof agent.model?.current === 'function'
        ? modelSelection(agent.model.current()) : modelSelection(sessionModel(sessionRecord(agent.session).events));
      if (sameModelSelection(current, temporary)) selectModelForNextTurn(ctx, agent, previous);
    } catch (error) {
      // The host may release the SessionStore during synchronous turn/end
      // dispatch. A late restore must neither crash its process nor mask the
      // original followup error when restoring after a queue failure.
      console.error(`[dsh-message-toolbar] model restoration failed (${sessionId}, ${messageId}):`, error);
    }
  };
  disposeClaimed = eventContext.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
    if (subject !== agent || message?.id !== messageId || !Number.isSafeInteger(turn) || turn < 1) return;
    // Claim precedes tools/prompt/request assembly, all of which can fail
    // before user/message is appended. Keep the message-event fallback below.
    replayTurn = turn;
  });
  disposeSession = eventContext.on('session/event', (session, event) => {
    if (session?.header?.id !== sessionId) return;
    if (event.type === 'turn/start') {
      activeTurn = event.data?.turn;
      return;
    }
    if (event.type === 'user/message' && event.data?.id === messageId
      && event.data?.source?.kind === 'user') {
      replayTurn = activeTurn;
      return;
    }
    if (event.type === 'turn/end' && replayTurn !== undefined && event.data?.turn === replayTurn) {
      dispose();
      queueMicrotask(restore);
    }
  });
  disposeDiscarded = eventContext.on('agent/inbox/discarded', ({ agent: subject, message }) => {
    if (subject !== agent || message?.id !== messageId || replayTurn !== undefined) return;
    dispose();
    queueMicrotask(restore);
  });
  return { dispose, restore };
}

/* ------------------------------------------------------ workspace files -- */
//
// Answering again only makes sense from the workspace the answer would have
// started from. DSH's own `@deepseek-ai/dsh-workspace-changes` records every
// top-level turn's changed files (git tree snapshots of the whole work tree,
// plus whole-file captures around the file tools) and serves each listed file's
// turn-start versus turn-end comparison as hunks. Those hunks are the only
// handle on the past this process has — the snapshot trees live in a private
// object directory owned by that plugin — so reverting means applying them
// backwards, and refusing to touch any file whose current content no longer
// matches what the turn left behind.

function workspaceChangesService(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : undefined;
}

/** The last `workspace/changes` event naming one turn: the latest replaces earlier ones. */
function changesEventFor(events, turn) {
  let found;
  for (const event of events) {
    if (event.type !== 'workspace/changes') continue;
    if (event.data === null || typeof event.data !== 'object') continue;
    if (event.data.turn !== turn) continue;
    found = event;
  }
  return found;
}

/**
 * The changed files of one turn, with the hunks needed to undo them.
 * `supported: false` carries the reason: no `workspaceChanges` service in this
 * host, no `workspace/changes` event for that turn, or a summary that is gone
 * because the host process that recorded it restarted (or the session ended).
 */
async function collectTurnChanges(ctx, operation) {
  const base = { turn: operation.turn, supported: false, files: [], total: 0, added: 0, deleted: 0 };
  const service = workspaceChangesService(ctx);
  if (service === undefined) return { ...base, reason: 'no-service' };
  const record = await loadSessionRecord(ctx, operation.sessionId);
  const event = changesEventFor(record.events, operation.turn);
  if (event === undefined) return { ...base, reason: 'not-recorded' };
  const summary = service.summary(operation.sessionId, event.seq);
  if (summary === undefined) return { ...base, reason: 'not-recorded' };
  const files = [];
  for (let index = 0; index < summary.files.length; index += 1) {
    const listed = summary.files[index];
    let comparison;
    try {
      comparison = await service.diff(operation.sessionId, event.seq, index, new AbortController().signal);
    } catch {
      comparison = undefined;
    }
    const kind = comparison === undefined ? 'unknown' : comparison.kind;
    files.push({
      path: listed.path,
      display: listed.display,
      added: listed.added,
      deleted: listed.deleted,
      kind,
      revertable: kind === 'text',
      before: kind === 'text' ? comparison.before : true,
      after: kind === 'text' ? comparison.after : true,
      hunks: kind === 'text' ? comparison.hunks : [],
    });
  }
  return {
    turn: operation.turn,
    supported: true,
    cwd: summary.cwd,
    seq: event.seq,
    total: summary.total,
    added: summary.added,
    deleted: summary.deleted,
    files,
  };
}

function changesPayload(plan) {
  return {
    ...plan,
    files: plan.files.map(({ hunks, ...rest }) => rest),
  };
}

/**
 * Undo one turn's file changes. Every file is checked against what the turn left
 * before anything is written, so a single conflict means nothing moves at all.
 */
async function revertTurn(ctx, operation) {
  const plan = await collectTurnChanges(ctx, operation);
  if (!plan.supported) {
    throw new Error(
      plan.reason === 'no-service'
        ? '这个 DSH 没有启用 workspace-changes，无法读取这一轮改过哪些文件。'
        : '这一轮的改动没有留下记录（宿主重启过，或者这一轮没有改动文件），无法回退。',
    );
  }
  return revertWorkspacePlan(plan);
}

/* --------------------------------------------------------- version state -- */
async function deleteVersion(ctx, sessionId, sourceSessionId = sessionId) {
  const record = await loadSessionRecord(ctx, sessionId);
  const own = ownVersionEvent(record);
  if (own === undefined) throw new TypeError('只有版本卡片可以删除；当前会话是原始对话。');
  const parent = record.header.parentSession;
  let target = sourceSessionId;
  if (sourceSessionId === sessionId) {
    const { versions } = await tree(ctx, sessionId);
    const available = versions.filter(version => version.sessionId !== sessionId && !version.deleted && !version.archived);
    const fallback = available.find(version => version.sessionId === parent) ?? available[0];
    if (!fallback) throw new Error('请先从版本树打开其他版本，再删除当前版本。');
    target = fallback.sessionId;
  }
  const job = await prepareFocus(ctx, target, sessionId, {
    beforeRecord(navigation) {
      // Keep the replacement check and card removal under the same family lock.
      if (sourceSessionId === sessionId && (navigation.archived || deletedVersionIds().has(target))) {
        throw new Error('目标版本已不可打开，请先从版本树选择其他版本。');
      }
      markDeleted(sessionId, { parent, turn: own.effect.targetTurn });
    },
  });
  return { deleted: true, parent, turn: own.effect.targetTurn, sessionId: target,
    archived: job.archived, navigationToken: job.token };
}

/* ------------------------------------------------------- tree projection -- */

function ownVersionEvent({ header, events, inheritedEventCount: inherited }) {
  const ownEvents = events.filter((event) => isVersionMarker(event)
    && (event.data.sessionId === header.id
      || (event.data.sessionId === undefined && event.seq >= inherited)));
  if (ownEvents.length === 0) return undefined;
  const event = ownEvents[0];
  const version = event.data;
  const parent = header.parentSession;
  if (![1, MESSAGE_TOOLBAR_SCHEMA].includes(version.schemaVersion)) throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`);
  if (version.inverse.kind !== 'restore-version' || parent === undefined || version.inverse.sessionId !== parent) {
    throw new Error(`会话 ${header.id} 的版本效果与逆不匹配。`);
  }
  return { effect: version.effect, time: event.time };
}

const TREE_READ_CONCURRENCY = 4;
async function mapConcurrent(items, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };
  const workers = Math.min(TREE_READ_CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

/** Extract all user turns from a session's event stream. */
function extractTurns(events) {
  if (!Array.isArray(events)) return [];
  const result = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq, time: event.time, answered: false, tools: 0 };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
      current.text = userText(event.data);
      current.time = event.time ?? current.time;
      continue;
    }
    // Whether the answer reached for a tool. A plain completion cannot, which is
    // what decides how "regenerate" has to answer (see the client).
    if (event.type === 'tool/call' && event.data.turn === current.turn) {
      current.tools += 1;
      continue;
    }
    // A durable answer: the only surface op a human transcript reads.
    if (event.type === 'assistant/message' && event.data?.turn === current.turn
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      current.answered = true;
      const answerText = messageText(event.data.message);
      if (answerText.trim().length > 0) current.answerText = answerText;
      // Whether the answer thought out loud. The process group of a turn is worth
      // keeping when it holds real work (tools, reasoning) and worth hiding when it
      // holds nothing but the context the agent injected to answer again.
      if (Array.isArray(event.data.message?.content)
        && event.data.message.content.some((block) => block && block.type === 'reasoning')) {
        current.reasoning = true;
      }
      continue;
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({
        turn: current.turn,
        text: current.text ?? '',
        time: current.time ?? event.time,
        answered: current.answered === true,
        answerText: current.answerText ?? '',
        tools: current.tools,
        reasoning: current.reasoning === true,
        reason: event.data.reason?.kind,
      });
      current = undefined;
    }
  }
  if (current && current.user) {
    result.push({
      turn: current.turn,
      text: current.text ?? '',
      time: current.time ?? Date.now(),
      answered: current.answered === true,
      answerText: current.answerText ?? '',
      tools: current.tools,
      reasoning: current.reasoning === true,
      open: true,
    });
  }
  return result;
}

/**
 * The per-message index the client needs: assistant-actions only know a
 * messageId, so the host maps every durable message id to its turn and event
 * seq. Built from a full log scan; cheap enough at these sizes.
 */
function indexMessages(events) {
  const out = [];
  let turn = 0;
  for (const event of events) {
    if (event.type === 'turn/start') { turn = event.data.turn; continue; }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      out.push({
        id: event.data.id,
        role: 'user',
        turn,
        seq: event.seq,
        preview: textPreview(userText(event.data)),
      });
      continue;
    }
    if (event.type === 'assistant/message') {
      out.push({
        id: event.data.message.id,
        role: 'assistant',
        turn: event.data.turn,
        step: event.data.step,
        seq: event.seq,
        preview: textPreview(messageText(event.data.message)),
      });
    }
  }
  return out;
}

const SESSION_CACHE_MAX = 500;
const sessionParsedCaches = new WeakMap();

async function sessionParsedData(ctx, record) {
  if (!record || !record.header) return { turns: [], effect: undefined, time: undefined, messages: [] };
  const id = record.header.id;
  let sessionParsedCache = sessionParsedCaches.get(ctx);
  if (!sessionParsedCache) sessionParsedCaches.set(ctx, sessionParsedCache = new Map());
  const live = ctx.sessions.get(id);
  // Header creation timestamps never change when a cold log grows. Read a
  // cold snapshot before caching by length; live logs expose a cheap count.
  const snapshot = live === undefined ? await loadSessionRecord(ctx, id) : undefined;
  const saved = contextFor(id);
  const legacy = saved === undefined ? legacyState(id) : undefined;
  const key = `${live === undefined ? snapshot.events.length : sessionEventCount(live)}:${JSON.stringify(legacy)}`;
  const cached = sessionParsedCache.get(id);
  if (cached !== undefined && cached.key === key && cached.revision === saved && cached.live?.deref() === live) {
    return cached;
  }

  const source = snapshot ?? sessionRecord(live);
  const events = source.events;
  const turns = extractTurns(events);
  const messages = indexMessages(events);
  // The model this session is configured with, so the picker can mark the row
  // the session already answers with. `sessionModel` reads the composer's own
  // selection first (pending before last-used): a failed turn has no header, so
  // the last header would name an older model the user already moved away from.
  const configured = sessionModel(events);
  const model = configured?.provider !== undefined && configured?.model !== undefined
    ? { provider: configured.provider, model: configured.model }
    : undefined;
  let effect;
  let time;
  try {
    const version = ownVersionEvent(source);
    effect = version?.effect;
    time = version?.time;
  } catch {
    effect = undefined;
  }

  let display, contextError;
  try {
    if (saved !== undefined || (legacy && hasLegacyContext(legacy))) {
      display = inSessionDisplay(inSessionView(events, saved, legacy), id);
    }
  } catch (error) {
    contextError = String(error.message ?? error);
  }
  const entry = { key, revision: saved, live: live === undefined ? undefined : new WeakRef(live), turns, messages, effect, time, model,
    display, contextError, promptAttachments: display?.promptAttachments ?? Object.fromEntries(contextTurns(events).map(turn => [turn.turn,
      turn.user.data.content.filter(block => block.type === 'file' || block.type === 'image')])) };
  if (sessionParsedCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionParsedCache.keys().next().value;
    sessionParsedCache.delete(firstKey);
  }
  sessionParsedCache.set(id, entry);
  return entry;
}

async function tree(ctx, sessionId) {
  const { flat, recordsById } = await assembleFamily(ctx, sessionId);
  const archived = archivedSessionIdSet(ctx);
  const deletedSet = deletedVersionIds();
  const parsedLogs = await mapConcurrent(flat, async ({ entry }) => {
    if (entry.ghost) return null;
    const record = recordsById.get(entry.id);
    return record === undefined ? null : sessionParsedData(ctx, record);
  });
  const parentOf = new Map(flat.map(({ entry }) => [entry.id, entry.parentId]));
  const currentPath = new Set();
  let pathId = sessionId;
  while (pathId !== undefined && !currentPath.has(pathId)) {
    currentPath.add(pathId);
    pathId = parentOf.get(pathId);
  }
  const allVersions = flat.map(({ entry, depth }, index) => {
    let effect;
    let time;
    let turns = [];
    let messages = [];
    let model;
    if (entry.ghost) {
      effect = entry.marker?.data?.effect;
      time = entry.marker?.time;
    } else {
      const parsed = parsedLogs[index];
      turns = parsed?.turns ?? [];
      messages = parsed?.messages ?? [];
      effect = parsed?.effect;
      time = parsed?.time;
      model = parsed?.model;
    }
    const record = entry.ghost ? undefined : recordsById.get(entry.id);
    const versionModel = effect?.model ?? model;
    return {
      sessionId: entry.id,
      ...entry.parentId === undefined ? {} : { parentSessionId: entry.parentId },
      createdAt: time ?? record?.header.createdAt ?? entry.createdAt,
      depth,
      current: entry.id === sessionId,
      onCurrentPath: currentPath.has(entry.id),
      ...entry.ghost ? { deleted: true, ghost: true } : {},
      ...deletedSet.has(entry.id) ? { deleted: true } : {},
      ...archived.has(entry.id) ? { archived: true } : {},
      ...effect === undefined ? {} : {
        operation: effect.operation,
        targetTurn: effect.targetTurn,
        targetEventSeq: effect.targetEventSeq,
        ...effect.before === undefined ? {} : { before: effect.before },
        ...effect.after === undefined ? {} : { after: effect.after },
      },
      turns,
      messages,
      owned: effect !== undefined,
      ...versionModel === undefined ? {} : { model: versionModel },
    };
  });

  // A raw DSH fork or subagent sharing parentSession is a separate conversation.
  // Only our own durable markers admit an edge into a toolbar family.
  const byId = new Map(allVersions.map(version => [version.sessionId, version]));
  const familyRoot = id => {
    const seen = new Set(); let version = byId.get(id);
    while (version?.owned && version.parentSessionId && !seen.has(version.sessionId)) {
      seen.add(version.sessionId);
      const parent = byId.get(version.parentSessionId);
      if (!parent) return version.parentSessionId;
      version = parent;
    }
    return version?.sessionId ?? id;
  };
  const rootSessionId = familyRoot(sessionId);
  const versions = allVersions.filter(version => familyRoot(version.sessionId) === rootSessionId);
  const current = versions.find((version) => version.sessionId === sessionId);
  const currentIndex = flat.findIndex(({ entry }) => entry.id === sessionId);
  const parsed = parsedLogs[currentIndex];
  const display = parsed?.display;
  const currentEvents = currentIndex >= 0 ? (recordsById.get(sessionId)?.events ?? []) : [];
  return {
    sessionId,
    rootSessionId,
    contextChoices: display?.contextChoices ?? {},
    contextOrder: display?.contextOrder,
    promptAttachments: parsed?.promptAttachments ?? {},
    pendingFocus: pendingNavigationFor(sessionId) ?? null,
    contextError: parsed?.contextError ?? null,
    versions,
    messages: current?.messages ?? [],
    model: current?.model,
    translations: translationsForSession(sessionId),
    shown: shownForSession(sessionId),
    // The original text of every turn that is showing a translation: the answer
    // is drawn beside it, paragraph by paragraph, so the client needs both sides.
    origins: originTexts(sessionId, currentEvents),
    answers: display?.answers ?? answersForSession(sessionId),
    replays: display ? {} : replaysForSession(sessionId),
    prompts: display?.prompts ?? promptOverridesForSession(sessionId),
    turns: current?.turns ?? [],
    runs: display ? {} : runsForSession(sessionId),
    hidden: display?.hidden ?? hiddenForSession(sessionId),
    deleted: [...deletedSet],
    // Diagnostics only, and only once asked for: the client keeps sending a map of
    // the flow rows it can see while this is true.
    debugRows: wantRows,
  };
}

/**
 * The original half of every translation on screen. A translation never replaces
 * the answer, so the client draws both sides and needs this side: the text that
 * was showing when the translation was asked for, falling back to whatever the
 * answer currently resolves to.
 */
function originTexts(sessionId, events) {
  const shown = shownForSession(sessionId);
  const remembered = originTextsForSession(sessionId);
  const out = {};
  for (const key in shown) {
    const turn = Number(key);
    const entry = answerEntry(sessionId, turn);
    const active = entry && entry.active !== 'native' && Array.isArray(entry.items)
      ? entry.items.find((item) => item.id === entry.active)
      : null;
    const stored = remembered[key];
    const text = typeof stored === 'string' && stored.length > 0
      ? stored
      : active ? active.text : entry?.override?.text ?? loggedAnswer(events, turn);
    if (typeof text === 'string' && text.length > 0) out[key] = text;
  }
  return out;
}

/* ------------------------------------------------------------ model list -- */

const modelsCache = { at: 0, value: undefined };
const MODELS_TTL = 60_000;

async function modelsCatalog(ctx) {
  if (modelsCache.value !== undefined && Date.now() - modelsCache.at < MODELS_TTL) {
    return modelsCache.value;
  }
  const providers = await ctx.llm.listProviders();
  const out = [];
  for (const provider of providers) {
    try {
      const models = await ctx.llm.listModels(provider.id);
      out.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
      });
    } catch {
      out.push({ id: provider.id, name: provider.name ?? provider.id, models: [] });
    }
  }
  modelsCache.value = { providers: out };
  modelsCache.at = Date.now();
  return modelsCache.value;
}

/* --------------------------------------------------------- HTTP plumbing -- */

function objectValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('请求体必须是 JSON 对象。');
  return value;
}

function sessionIdOf(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('sessionId 必须是非空字符串。');
  if (value === 'prototype' || Object.hasOwn(Object.prototype, value)) throw new TypeError('sessionId 不是有效的会话标识。');
  return value;
}

function integerOf(value, label) {
  if (!Number.isSafeInteger(value) || value < (label === 'turn' ? 1 : 0)) throw new TypeError(`${label} 必须是${label === 'turn' ? '正' : '非负'}安全整数。`);
  return value;
}

function modelRequest(value) {
  if (value === undefined || value === null) return undefined;
  const record = objectValue(value);
  const provider = record['provider'];
  const model = record['model'];
  if (typeof provider !== 'string' || provider.length === 0) throw new TypeError('model.provider 必须是非空字符串。');
  if (typeof model !== 'string' || model.length === 0) throw new TypeError('model.model 必须是非空字符串。');
  return { provider, model, ...record['name'] === undefined ? {} : { name: String(record['name']) } };
}

function decodeOperation(value) {
  const record = objectValue(value);
  const sessionId = sessionIdOf(record['sessionId']);
  switch (record['action']) {
    case 'edit':
      if (typeof record['text'] !== 'string' || record['text'].trim().length === 0) throw new TypeError('text 必须是非空字符串。');
      return {
        action: 'edit',
        sessionId,
        eventSeq: integerOf(record['eventSeq'], 'eventSeq'),
        blockIndex: integerOf(record['blockIndex'], 'blockIndex'),
        text: record['text'],
        stopPrevious: record['stopPrevious'] === true,
      };
    case 'retry':
      return {
        action: 'retry',
        sessionId,
        turn: integerOf(record['turn'], 'turn'),
        stopPrevious: record['stopPrevious'] === true,
        ...record['model'] === undefined ? {} : { model: modelRequest(record['model']) },
      };
    case 'changes':
      return { action: 'changes', sessionId, turn: integerOf(record['turn'], 'turn') };
    case 'revert':
      return { action: 'revert', sessionId, turn: integerOf(record['turn'], 'turn') };
    default:
      // Name the action and the full vocabulary: a mismatch here almost always
      // means the running host half is older than the loaded client bundle
      // (the client keeps talking while the host was never restarted).
      throw new TypeError(
        `action 无法识别：${JSON.stringify(record['action'])}。`
        + '可用：edit、retry、translate、delete-version、restore-version、activate、focus、models、'
        + 'answer-generate、answer-save、answer-source、answer-select、answer-delete、answer-restore、'
        + 'answer-run、run-select、hide、changes、revert。'
        + '如果你点的是“切换模型”或“重新生成”，说明正在运行的宿主插件还是旧版本，重启 dsh web 后再试。',
      );
  }
}

function requestJson(request) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    request.on('data', (chunk) => {
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      try {
        text += decoder.decode();
        resolve(JSON.parse(text));
      } catch (cause) {
        reject(new TypeError('请求体不是有效的 JSON。', { cause }));
      }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new TypeError('请求在 JSON 接收完成之前中断。')));
  });
}

function respondJson(response, status, value) {
  if (status < 400) flushState();
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

/**
 * Write one answer as newline-delimited JSON frames (`start`, then `delta` per
 * token batch, then `done` or `error`). The client renders the text as it
 * arrives, which is what makes "switch model" feel like a fresh answer instead
 * of a delayed swap of the old one.
 */
async function respondStream(response, run) {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  if (typeof response.flushHeaders === 'function') response.flushHeaders();
  const send = (frame) => {
    if (response.writableEnded || response.destroyed) return;
    if (frame.type === 'done') flushState();
    response.write(`${JSON.stringify(frame)}\n`);
  };
  try {
    await run(send);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  if (!response.writableEnded && !response.destroyed) response.end();
}

/** A translation being written: the same frame shape, so one client reader serves both. */
async function respondTranslateStream(ctx, response, operation) {
  const controller = new AbortController();
  // DSH's worker tunnel sets writableEnded before emitting even a premature
  // close. A normal completion has already released the task's abort listener.
  const onClose = () => controller.abort();
  response.on('close', onClose);
  if (response.destroyed || response.writableEnded) controller.abort();
  try {
    await respondStream(response, (send) => translateMessage(ctx, { ...operation, signal: controller.signal }, send));
  } finally {
    response.off('close', onClose);
  }
}

async function handleRoute(ctx, request, response) {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? MESSAGE_TOOLBAR_PATH, 'http://message-toolbar.local');
      if (url.searchParams.get('models') === '1') {
        respondJson(response, 200, await modelsCatalog(ctx));
        return;
      }
      // `?rows=1` turns on a client-side dump of the flow rows: which kinds the
      // frame drew, which of them carry a turn, and under which key. There is no
      // way to read the DOM from here, so the client reports it back and this
      // answers with the last report it sent.
      if (url.searchParams.get('rows') !== null) {
        wantRows = true;
        respondJson(response, 200, { rows: rowDigest });
        return;
      }
      respondJson(response, 200, await tree(ctx, sessionIdOf(url.searchParams.get('sessionId'))));
      return;
    }
    if (request.method === 'POST') {
      const body = await requestJson(request);
      if (body && ['answer-run', 'answer-generate', 'prompt-save', 'prompt-restore', 'answer-save',
        'answer-select', 'answer-delete', 'answer-restore', 'run-select', 'run-delete', 'hide', 'edit', 'retry'].includes(body.action)) {
        throw new Error('此旧版接口只改变显示，已经停用；请更新插件客户端并重启 DSH。');
      }
      if (body !== null && typeof body === 'object' && (body.action === 'context-update' || body.action === 'context-branch')) {
        respondJson(response, 200, await runContextOperation(ctx, objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'context-normalize') {
        const sessionId = sessionIdOf(body.sessionId);
        await loadSessionRecord(ctx, sessionId);
        respondJson(response, 200, { sessionId, inPlace: true });
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'context-select') {
        respondJson(response, 200, await runContextOperation(ctx, { ...body, operation: 'select' }));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'activate') {
        respondJson(response, 200, await activateVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'focus') {
        respondJson(response, 200, await focusVersion(ctx, sessionIdOf(body.sessionId), body.token));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'cancel-focus') {
        respondJson(response, 200, await cancelFocus(ctx, sessionIdOf(body.sessionId), body.token));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'prepare-focus') {
        respondJson(response, 200, await prepareFocus(ctx, sessionIdOf(body.sessionId), sessionIdOf(body.sourceSessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'delete-version') {
        respondJson(response, 200, await deleteVersion(ctx, sessionIdOf(body.sessionId),
          body.sourceSessionId === undefined ? undefined : sessionIdOf(body.sourceSessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'restore-version') {
        unmarkDeleted(sessionIdOf(body.sessionId));
        respondJson(response, 200, { deleted: false });
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'translate') {
        const operation = objectValue(body);
        const request = {
          sessionId: sessionIdOf(operation['sessionId']),
          eventSeq: operation['eventSeq'] === undefined ? undefined : integerOf(operation['eventSeq'], 'eventSeq'),
          turn: operation['turn'] === undefined ? undefined : integerOf(operation['turn'], 'turn'),
          text: typeof operation['text'] === 'string' ? operation['text'] : undefined,
          lang: typeof operation['lang'] === 'string' ? operation['lang'] : 'zh',
          force: operation['force'] === true,
          model: operation['model'] === undefined ? undefined : modelRequest(operation['model']),
        };
        if (body['stream'] === true) {
          await respondTranslateStream(ctx, response, request);
          return;
        }
        respondJson(response, 200, await translateMessage(ctx, request));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'translate-off') {
        const operation = objectValue(body);
        respondJson(response, 200, await translateOff(ctx, {
          sessionId: sessionIdOf(operation['sessionId']),
          turn: integerOf(operation['turn'], 'turn'),
        }));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-source') {
        respondJson(response, 200, await answerSource(ctx, objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'models') {
        respondJson(response, 200, await modelsCatalog(ctx));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'rows') {
        rowDigest = Array.isArray(body.rows) ? body.rows.slice(0, 400) : null;
        respondJson(response, 200, { ok: true });
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'changes') {
        respondJson(response, 200, changesPayload(await collectTurnChanges(ctx, decodeOperation(body))));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'revert') {
        respondJson(response, 200, await revertTurn(ctx, decodeOperation(body)));
        return;
      }
      throw new TypeError('无法识别的工具栏操作，请更新插件并重启 DSH。');
    }
    response.writeHead(405);
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A stream that already wrote its header cannot be answered with JSON.
    if (response.headersSent) {
      if (!response.writableEnded) {
        response.write(`${JSON.stringify({ type: 'error', message })}\n`);
        response.end();
      }
      return;
    }
    const recovery = error?.code === 'WORKSPACE_REVERT_IO' || error?.code === 'WORKSPACE_REVERT_CLEANUP'
      ? { code: error.code, rollbackComplete: error.rollbackComplete,
        recoveryFiles: Array.isArray(error.recoveryFiles) ? error.recoveryFiles.filter((file) => typeof file === 'string') : [] }
      : null;
    respondJson(response, error instanceof TypeError ? 400 : 409, {
      error: recovery?.recoveryFiles.length ? `${message}\n保留的恢复文件：${recovery.recoveryFiles.join(', ')}` : message,
      ...(recovery ?? {}),
    });
  }
}

function installContextHook(ctx) {
  if (typeof ctx.on !== 'function') return;
  const forwarded = new WeakSet();
  ctx.on('llm/stream', (request, next) => {
    const id = request.sessionId;
    if (!id || forwarded.has(request) || (request.purpose !== undefined && request.purpose !== 'compaction')) return next();
    const session = ctx.sessions.get(id);
    if (!session) return next();
    const saved = contextFor(id);
    const legacy = saved === undefined ? legacyState(id) : undefined;
    if (saved === undefined && !hasLegacyContext(legacy)) return next();
    if (request.purpose === undefined && !Object.isFrozen(request)) return next();
    const record = sessionRecord(session);
    const view = inSessionView(record.events, saved, legacy);
    const messages = projectModelMessages(session, record.events, view);
    if (request.purpose === 'compaction') {
      const selected = request.messages.slice(0, -1);
      const positions = new Map(messages.map((message, index) => [message, index]));
      let previous = -1;
      if (selected.every(message => {
        const position = positions.get(message);
        if (position === undefined || position <= previous) return false;
        previous = position;
        return true;
      })) return next();
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TOOLBAR_CONTEXT_MISMATCH',
          message: 'DSH 无法压缩包含未选回答的历史。' } } };
      })();
    }
    if (messages.length === request.messages.length && messages.every((message, index) => message === request.messages[index])) return next();

    // The original loop request is immutable. Supply an independent request
    // and return its stream to the same native turn.
    const projected = Object.freeze({ ...request, messages: Object.freeze(messages) });
    forwarded.add(projected);
    return ctx.llm.stream(projected);
  }, { prepend: true });
  contextHooks.add(ctx);
}

function apply(ctx) {
  installContextHook(ctx);
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MESSAGE_TOOLBAR_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'message-toolbar: HTTP route');
}

export { MESSAGE_TOOLBAR_PATH, MESSAGE_TOOLBAR_SCHEMA, MARKER_TYPE, inject, name, apply };
