
// dsh-message-toolbar — host half.
//
// Owns the /message-toolbar HTTP route. POST builds a version branch (a new
// session seeded with every event BEFORE the edited turn — a true rewind),
// writes a durable `message-toolbar/version` marker recording what changed
// and with which model, then queues the message for a fresh answer. GET
// projects the whole version family plus the per-message index and cached
// translations the client needs for its toolbar and bilingual cards.
//
// The branching transaction shape is derived from dsh-plugin-message-edit
// (MIT © SpookySandwich) and dsh-message-edit (MIT © Moeblack).

import crypto from 'node:crypto';
import { attachParentId, ancestorChainFromLog, collectFamily } from './toolbar-logic.js';
import { sessionEventCount, sessionRecord, branchSeedOptions, readSessionRecord } from './session-record.js';
import {
  deletedVersionIds, markDeleted, unmarkDeleted,
  translationFor, storeTranslation, translationsForSession, shownForSession, originTextsForSession, setShown,
  answerEntry, answersForSession, storeAnswer, updateAnswer, selectAnswer, removeAnswer,
  setAnswerOverride, clearAnswerOverride, hiddenForSession, setHidden,
} from './state-store.js';

/** Same-origin endpoint owned by this plugin's host half. */
const MESSAGE_TOOLBAR_PATH = '/message-toolbar';
/** Durable version-marker schema. */
const MESSAGE_TOOLBAR_SCHEMA = 1;
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

/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events) {
  const result = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
      continue;
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({ ...current, endSeq: event.seq });
      current = undefined;
    }
  }
  return result;
}

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

function cloneUser(message, content = structuredClone(message.content)) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user' }),
  });
}

function replaceTextBlock(content, blockIndex, text) {
  const block = content[blockIndex];
  if (block?.type !== 'text') throw new Error('所选内容块不是可编辑文本。');
  return content.map((candidate, index) => index === blockIndex ? { ...candidate, text } : structuredClone(candidate));
}

/* ---------------------------------------------------------------- planning -- */

function pairVersionEffect(sourceSessionId, effect) {
  return {
    schemaVersion: MESSAGE_TOOLBAR_SCHEMA,
    effect: { ...effect, id: crypto.randomUUID() },
    inverse: { kind: 'restore-version', sessionId: sourceSessionId },
  };
}

/** Edit a user message: rewind to before its turn, queue the edited prompt. */
function editPlan(operation, turns) {
  const turn = turns.find((candidate) => operation.eventSeq > candidate.startSeq && operation.eventSeq < candidate.endSeq);
  if (turn === undefined) throw new Error('所选消息不属于已落定回合。');
  if (turn.user === undefined || turn.user.seq !== operation.eventSeq) throw new Error('所选消息不是用户消息。');
  const before = turn.user.data.content[operation.blockIndex];
  if (before?.type !== 'text') throw new Error('所选用户消息块不是文本。');
  const edited = cloneUser(turn.user.data, replaceTextBlock(turn.user.data.content, operation.blockIndex, operation.text));
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(operation.sessionId, {
      operation: 'edit',
      targetTurn: turn.turn,
      targetEventSeq: turn.user.seq,
      before: before.text,
      after: operation.text,
    }),
    queuedUsers: [edited],
    turn: turn.turn,
  };
}

/** Regenerate a turn — optionally with another model: rewind to before it, queue the prompt again. */
function retryPlan(sessionId, turnNumber, turns, model) {
  const turn = turns.find((candidate) => candidate.turn === turnNumber);
  if (turn?.user === undefined) throw new Error('所选回合没有可重放的用户输入。');
  const effect = {
    operation: 'retry',
    targetTurn: turn.turn,
    targetEventSeq: turn.user.seq,
    before: userText(turn.user.data),
  };
  if (model !== undefined) effect.model = model;
  return {
    boundary: turn.startSeq - 1,
    version: pairVersionEffect(sessionId, effect),
    queuedUsers: [cloneUser(turn.user.data)],
    turn: turn.turn,
  };
}

function planOperation(operation, events) {
  const turns = closedTurns(events);
  switch (operation.action) {
    case 'edit': return editPlan(operation, turns);
    case 'retry': return retryPlan(operation.sessionId, operation.turn, turns, operation.model);
    default: throw new TypeError(`未知操作：${operation.action}`);
  }
}

/* -------------------------------------------------------- branch creation -- */

function agentOptions(events, fallback) {
  const config = events.findLast((event) => event.type === 'request/header')?.data.header.config;
  const provider = config?.provider ?? fallback?.provider;
  const model = config?.model ?? fallback?.model;
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('无法从会话历史解析模型路由。');
  }
  const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
  const reasoningEffort = config?.reasoningEffort ?? fallback?.reasoningEffort;
  return {
    provider, model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  };
}

async function withSourceAgent(ctx, sessionId, operation) {
  let handle;
  let agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    const snapshot = await readSessionRecord(ctx, sessionId);
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: agentOptions(snapshot.events),
    });
    agent = handle.agent;
  }
  try {
    return await agent.runMaintenance(async () => operation(agent));
  } finally {
    await handle?.dispose();
  }
}

function inheritedSeed(source, boundary) {
  if (boundary === -1) return [];
  const boundaryEvent = source.events[boundary];
  if (boundary < 0 || boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
    throw new Error('分支边界不是连续会话事件。');
  }
  return source.events.slice(0, boundary + 1);
}

function versionSeed(source, plan, childId) {
  const events = inheritedSeed(source, plan.boundary);
  const inheritedLength = events.length;
  events.push({
    type: MARKER_TYPE,
    seq: events.length,
    time: Date.now(),
    // Ownership is explicit: the entire constructor seed is inherited, so
    // log position alone cannot identify our own marker.
    data: { ...plan.version, sessionId: childId },
    // Plugin event types live outside the harness vocabulary; without this
    // marker the read path refuses to interpret the whole session log.
    ignorable: true,
  });
  return { events, inheritedLength: typeof source.header.isSeeded === 'boolean' ? events.length : inheritedLength };
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

function sessionRecordId(session) {
  return session.header?.id ?? session.id;
}

function sessionTargetTurn(session) {
  return ownVersionEvent(session)?.effect.targetTurn;
}

/**
 * Repeated edits of the same message must hang off the original, not off the
 * previous edit. Walk the parent chain and stop at the first session that is
 * not itself a version of `targetTurn`.
 */
async function resolveAttachSession(ctx, sourceSession, targetTurn) {
  const nodes = new Map();
  let session = sourceSession;
  const seen = new Set();
  while (session) {
    const id = sessionRecordId(session);
    if (id === undefined || seen.has(id)) break;
    seen.add(id);
    nodes.set(id, {
      targetTurn: sessionTargetTurn(session),
      parentSessionId: session.header.parentSession,
      session,
    });
    const parentId = session.header.parentSession;
    if (parentId === undefined || nodes.has(parentId)) break;
    session = await loadSessionRecord(ctx, parentId);
  }
  const byId = new Map([...nodes].map(([id, node]) => [id, {
    targetTurn: node.targetTurn,
    parentSessionId: node.parentSessionId,
  }]));
  const attachId = attachParentId(byId, sessionRecordId(sourceSession), targetTurn);
  return nodes.get(attachId)?.session ?? sourceSession;
}

async function createVersionAgent(ctx, source, childId, plan, options) {
  const seed = versionSeed(source, plan, childId);
  const presets = ctx.get('agentPresets');
  const presetId = sessionPreset(source);
  let agentPreset;
  if (presets !== undefined && presetId !== undefined) {
    const resolved = (await presets.resolve(presetId)).id;
    agentPreset = resolved;
  }
  const setup = async (agentCtx, agent) => {
    // Rewinding before turn/start also rewinds before the durable inbox claim.
    // Clear BOTH inherited queues before publication can start the agent.
    agent?.inbox?.clear();
    if (agentPreset !== undefined) await presets.mount(agentCtx, agentPreset);
  };
  const seedOptions = branchSeedOptions(source, seed.inheritedLength);
  const child = await ctx.agents.create({
    sessionId: childId,
    seed: seed.events,
    ...seedOptions,
    meta: {
      ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
      parentSession: source.id ?? source.header.id,
      ...seedOptions.meta,
      // Versions appear in the sidebar as ordinary sessions: `origin:
      // 'subagent'` would fence cancel and model selection, and an archived
      // session cannot be navigated to.
      ...agentPreset === undefined ? {} : { agentPreset },
    },
    agentOptions: options,
    setup,
  });
  try {
    await ctx.sessions.flush(child.agent.session);
    return child;
  } catch (error) {
    await child.dispose();
    throw error;
  }
}

async function recoverOperation(inverses) {
  const failures = [];
  for (const inverse of inverses.reverse()) {
    try {
      await inverse();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, '版本操作恢复失败。');
}

/**
 * Stop a still-running turn on `sessionId` so an edit can fork away from it.
 * Cancel only signals the abort; wait until the phase settles, otherwise the
 * `runMaintenance` that follows still throws.
 */
async function stopRunningTurn(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) return false;
  try {
    agent.cancel({ kind: 'user' });
    await agent.whenIdle();
    return true;
  } catch {
    return false;
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

/** Every surviving session in this conversation's version family, ghosts excluded. */
async function familySessionIds(ctx, sessionId) {
  const { flat } = await assembleFamily(ctx, sessionId);
  const ids = new Set([sessionId]);
  for (const { entry } of flat) {
    if (!entry.ghost) ids.add(entry.id);
  }
  return [...ids];
}

/**
 * Stop every still-running turn in this conversation's family before
 * branching: the superseded reply must not keep spending tokens, and a
 * sibling branch started earlier can still be streaming.
 */
async function stopFamilyTurns(ctx, sessionId) {
  let ids;
  try {
    ids = await familySessionIds(ctx, sessionId);
  } catch {
    ids = [sessionId];
  }
  let stopped = 0;
  for (const id of ids) {
    if (await stopRunningTurn(ctx, id)) stopped += 1;
  }
  return stopped;
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
 * Unarchive one session so the app can navigate to it. The app cannot open
 * an archived session — it bounces to the workspace picker.
 */
async function activateVersion(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) throw new Error('workspaceRegistry 不可用，无法取消归档。');
  if (!registry.archivedSessionIds.includes(sessionId)) return { unarchived: false };
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId);
    return { unarchived: true };
  }
  if (typeof registry.enqueueOperation !== 'function'
    || typeof registry.requireState !== 'function'
    || typeof registry.setState !== 'function') {
    throw new Error('此 dsh 版本未提供取消归档的途径。');
  }
  await registry.enqueueOperation(async () => {
    const state = registry.requireState();
    if (!state.archivedSessionIds.includes(sessionId)) return;
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
    });
  });
  return { unarchived: true };
}

/**
 * Make one family member the only visible conversation: unarchive it, then
 * archive every other member. The alternatives stay navigable through the
 * switcher (which calls this again with the other side), but the sidebar shows
 * one conversation instead of a row of near-identical branches.
 *
 * `sessionId` must already be the session the app navigated to: archiving the
 * session that is still current closes the main view (the workspace UI clears
 * an archived current selection).
 */
async function focusVersion(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) throw new Error('workspaceRegistry 不可用，无法整理版本。');
  const activated = await activateVersion(ctx, sessionId);
  const family = await tree(ctx, sessionId);
  const archived = [];
  const skipped = [];
  for (const version of family.versions) {
    const id = version.sessionId;
    if (id === sessionId || version.deleted === true) continue;
    if (registry.archivedSessionIds.includes(id)) continue;
    try {
      await registry.archiveSession(id);
      archived.push(id);
    } catch (error) {
      // Running work refuses the archive without `stopActivity`; leave it visible
      // rather than killing a turn the user did not ask to stop.
      if (error instanceof Error && error.name === 'WorkspaceActiveSessionError') {
        skipped.push(id);
        continue;
      }
      throw error;
    }
  }
  return { active: sessionId, unarchived: activated.unarchived === true, archived, skipped };
}

/** Archive one version card (hide it from the sidebar without deleting the log). */
async function archiveVersion(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || typeof registry.archiveSession !== 'function') return false;
  if (registry.archivedSessionIds.includes(sessionId)) return true;
  await registry.archiveSession(sessionId);
  return true;
}

/** Keep a version in the same sidebar workspace group as its tree parent. */
async function attachToParentWorkspace(ctx, parentId, childId) {
  try {
    const registry = ctx.get('workspaceRegistry');
    const workspace = registry?.list().find((w) => w.sessionIds.includes(parentId));
    if (workspace !== undefined) await workspace.attachSession(childId);
  } catch {
    // Cosmetic only.
  }
}

/* -------------------------------------------------------------- operations -- */

async function runOperation(ctx, operation) {
  const sourceId = sessionIdOf(operation.sessionId);
  if (operation.stopPrevious === true) await stopFamilyTurns(ctx, sourceId);
  return withSourceAgent(ctx, sourceId, async (source) => {
    const childId = sessionIdOf(`session-${crypto.randomUUID()}`);
    const inverses = [];
    try {
      const record = sessionRecord(source.session);
      const events = record.events;
      const plan = planOperation(operation, events);
      const options = agentOptions(events, source.options);
      if (operation.model !== undefined) {
        options.provider = operation.model.provider;
        options.model = operation.model.model;
      }
      const attach = await resolveAttachSession(ctx, record, plan.version.effect.targetTurn);
      if (sessionRecordId(attach) !== record.id) {
        const turn = closedTurns(attach.events).find((candidate) => candidate.turn === plan.version.effect.targetTurn);
        if (turn === undefined) throw new Error('无法在父会话上定位同一回合。');
        plan.boundary = turn.startSeq - 1;
        plan.version.inverse.sessionId = sessionRecordId(attach);
      }
      const child = await createVersionAgent(ctx, attach, childId, plan, options);
      inverses.push(() => child.dispose());
      for (const message of plan.queuedUsers) child.agent.followup(message);
      inverses.length = 0;
      await attachToParentWorkspace(ctx, sessionRecordId(attach), childId);
      return {
        sessionId: childId,
        queuedTurns: plan.queuedUsers.length,
        turn: plan.turn,
        provider: options.provider,
        model: options.model,
        operation: operation.action,
      };
    } catch (error) {
      try {
        await recoverOperation(inverses);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], '版本操作及其恢复均失败。');
      }
      throw error;
    }
  });
}

/* -------------------------------------------------------------- translate -- */

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
  'Preserve Markdown formatting, code blocks, inline code, links, lists and numbers exactly.',
  'Do not translate code identifiers, file paths, URLs or model names.',
  'Do not add commentary, explanations or notes.',
  'Reply with ONLY the translated text.',
].join(' ');

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

async function translateMessage(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const lang = typeof operation.lang === 'string' && operation.lang.length > 0 ? operation.lang : 'zh';
  if (LANGUAGE_NAMES[lang] === undefined) throw new TypeError(`不支持的语言：${lang}`);
  const record = await loadSessionRecord(ctx, sessionId);

  // Two ways in: by log event (the ordinary answer) or by text (what is on
  // screen right now — a variant, or an answer the reader edited). Translating
  // the text on screen is what "translate in place" means: the reader is looking
  // at that text, so that is the text to translate.
  const supplied = typeof operation.text === 'string' ? operation.text : '';
  const byText = supplied.trim().length > 0;

  let turn;
  let role = 'assistant';
  let key;
  if (byText) {
    turn = typeof operation.turn === 'number' ? operation.turn : undefined;
    if (turn === undefined) throw new TypeError('缺少要翻译的轮次。');
    key = `turn:${turn}`;
  } else {
    const event = record.events.find((candidate) => candidate.seq === operation.eventSeq);
    if (event === undefined) throw new TypeError('找不到要翻译的消息。');
    let message;
    if (event.type === 'assistant/message') {
      message = event.data.message;
      turn = event.data.turn;
      role = 'assistant';
    } else if (event.type === 'user/message') {
      message = event.data;
      role = 'user';
      const index = record.events.findIndex((candidate) => candidate.seq === event.seq);
      for (let i = index; i >= 0; i -= 1) {
        if (record.events[i].type === 'turn/start') { turn = record.events[i].data.turn; break; }
      }
    } else {
      throw new TypeError('只能翻译用户或助手消息。');
    }
    key = event.seq;
    operation.text = messageText(message);
  }

  if (!operation.force) {
    const cached = translationFor(sessionId, key, lang);
    if (cached !== undefined && cached.text) {
      setShown(sessionId, turn, lang, typeof operation.text === 'string' ? operation.text : undefined);
      return { turn, role, seq: key, lang, ...cached, cached: true, shown: lang };
    }
  }
  const text = typeof operation.text === 'string' ? operation.text : '';
  if (text.trim().length === 0) throw new TypeError('这条消息没有可翻译的文本。');

  const route = await resolveTranslationModel(ctx, record.events, operation.model);
  const chunks = [];
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
          text: `Translate the following text into ${LANGUAGE_NAMES[lang]}.\n\n<<<TEXT\n${text}\nTEXT>>>`,
        }],
      }],
      // A translation is as long as the text it translates — a long answer needs
      // room to say the same thing in another language. 4096 truncated a 700-word
      // article mid-sentence.
      maxTokens: 8192,
      signal: undefined,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') chunks.push(chunk.text);
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    failed = error;
  }
  const translation = chunks.join('').trim();
  if (translation.length === 0) {
    const reason = failed instanceof Error ? failed.message : '模型没有返回内容';
    throw new Error(`翻译失败：${reason}`);
  }
  // Say so instead of passing a half translation off as the whole thing: the
  // reader can see the original right above it and would notice anyway.
  const truncated = finish === 'length' || finish === 'max_tokens';
  storeTranslation(sessionId, key, lang, {
    text: translation,
    provider: route.provider,
    model: route.model,
    turn,
    role,
    ...truncated ? { truncated: true } : {},
  });
  // Translation replaces the answer in place, so choosing a language is also
  // choosing what the turn shows from now on.
  setShown(sessionId, turn, lang, typeof operation.text === 'string' ? operation.text : undefined);
  return {
    turn, role, seq: key, lang, text: translation,
    provider: route.provider, model: route.model, cached: false, shown: lang,
    ...truncated ? { truncated: true } : {},
  };
}

/**
 * Put the original back. Translation is a view decision, so this only drops the
 * "which language is shown" record — the cached translation stays for next time.
 */
async function translateOff(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  if (typeof operation.turn !== 'number') throw new TypeError('缺少要还原的轮次。');
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
function transcriptMessages(events, turn) {
  const slices = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, user: undefined, answer: undefined };
      slices.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = userText(event.data);
      continue;
    }
    if (event.type === 'assistant/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      const body = messageText(event.data.message);
      if (body.trim().length > 0) current.answer = { message: event.data.message, text: body };
    }
  }
  const messages = [];
  for (const slice of slices) {
    if (slice.turn > turn) break;
    if (slice.user !== undefined && slice.user.trim().length > 0) {
      // A one-shot user input: the request type allows exactly this shape.
      messages.push({ role: 'user', content: [{ type: 'text', text: slice.user }] });
    }
    // A replayed answer has to be a *message*, not just a role and some text:
    // adapters drop entries without `id` and `source`, and a request whose
    // messages were all dropped finishes empty (which used to look like "the
    // model returned nothing"). The original logged message carries both, so
    // keep them and swap in the text-only content.
    if (slice.turn < turn && slice.answer !== undefined) {
      const original = slice.answer.message;
      messages.push({
        id: original.id,
        role: 'assistant',
        content: [{ type: 'text', text: slice.answer.text }],
        source: original.source !== undefined && original.source !== null
          ? original.source
          : { kind: 'model', provider: 'unknown', model: 'unknown' },
      });
    }
  }
  return messages;
}

/** The logged final answer of one turn — the baseline the editor starts from. */
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

async function resolveAnswerModel(ctx, events, requested) {
  if (requested !== undefined && requested.provider && requested.model) return requested;
  const config = events.findLast((event) => event.type === 'request/header')?.data.header.config;
  if (config !== undefined && config.provider && config.model) {
    return { provider: config.provider, model: config.model };
  }
  const providers = await ctx.llm.listProviders();
  for (const provider of providers) {
    const models = await ctx.llm.listModels(provider.id);
    if (models.length > 0) return { provider: provider.id, model: models[0].id };
  }
  throw new Error('没有可用的模型来重答。请在设置里配置模型。');
}

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

/**
 * Ask another model — or the same one again — and keep the reply as a variant.
 * `sink` turns the call into a stream: it receives one frame per step so the
 * composer can show the answer being written instead of waiting for the end.
 */
async function generateAnswer(ctx, operation, sink) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const record = await loadSessionRecord(ctx, sessionId);
  if (!turnExists(record.events, turn)) throw new TypeError(`第 ${turn} 轮不存在。`);
  const messages = transcriptMessages(record.events, turn);
  if (messages.length === 0) throw new TypeError(`第 ${turn} 轮没有可重答的用户消息。`);
  const route = await resolveAnswerModel(ctx, record.events, operation.model);
  if (typeof sink === 'function') {
    sink({
      type: 'start',
      turn,
      provider: route.provider,
      model: route.model,
      ...route.name === undefined ? {} : { name: route.name },
    });
  }
  const chunks = [];
  const thoughts = [];
  // Some providers answer with whole blocks instead of token deltas, and some
  // narrate for a while before they say anything at all. Keep both shapes and
  // record what came back, so "no content" can name its own cause instead of
  // leaving the reader guessing which model behaved oddly.
  const blocks = [];
  const seen = new Map();
  let failed;
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: 8192,
      signal: undefined,
    });
    for await (const chunk of stream) {
      seen.set(chunk.type, (seen.get(chunk.type) ?? 0) + 1);
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.text);
        if (typeof sink === 'function') sink({ type: 'delta', text: chunk.text });
      } else if (chunk.type === 'reasoning-delta') {
        // A thinking model narrates before it answers: keep that as this run's
        // own process log, so the client can show it above the answer the way
        // the app shows a logged turn's thinking.
        thoughts.push(chunk.text);
        if (typeof sink === 'function') sink({ type: 'reasoning', text: chunk.text });
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text'
        && typeof chunk.block.text === 'string' && chunk.block.text.length > 0) {
        blocks.push(chunk.block.text);
      }
    }
  } catch (error) {
    failed = error;
  }
  const text = (chunks.length > 0 ? chunks.join('') : blocks.join('')).trim();
  if (text.length === 0) {
    const reason = failed instanceof Error ? failed.message : '模型没有返回正文';
    const shape = [...seen.entries()].map(([type, count]) => `${type}×${count}`).join('、');
    const detail = shape.length > 0 ? `（收到 ${shape}）` : '（流里没有任何块）';
    throw new Error(`重答失败：${reason}${detail}`);
  }
  const reasoning = thoughts.join('').trim();
  const item = {
    id: crypto.randomUUID(),
    kind: 'model',
    provider: route.provider,
    model: route.model,
    ...route.name === undefined ? {} : { name: route.name },
    text,
    ...reasoning.length === 0 ? {} : { reasoning },
    at: Date.now(),
  };
  storeAnswer(sessionId, turn, item);
  const payload = answerPayload(sessionId, turn);
  if (typeof sink === 'function') sink({ type: 'done', payload });
  return payload;
}

/**
 * Save the user's rewrite. Editing changes what is on screen, so nothing new is
 * added: an alternative is rewritten in place, and the logged answer — which no
 * API can rewrite — takes an override that leaves the ring at `1/1`.
 */
function saveAnswer(operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const text = answerTextOperation(operation);
  const payload = answerPayload(sessionId, turn);
  const target = typeof operation.id === 'string' && operation.id.length > 0
    ? operation.id
    : payload.active;
  if (target !== 'native' && payload.items.some((item) => item.id === target)) {
    updateAnswer(sessionId, turn, target, text);
  } else {
    setAnswerOverride(sessionId, turn, text);
  }
  return answerPayload(sessionId, turn);
}

/** The text the editor should open with: the visible variant, or the log. */
async function answerSource(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const record = await loadSessionRecord(ctx, sessionId);
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

/** Give the model's own answer back, dropping an edit of the logged text. */
function restoreAnswerOperation(operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  clearAnswerOverride(sessionId, turn);
  return answerPayload(sessionId, turn);
}

function selectAnswerOperation(operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const id = operation.id;
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('id 必须是非空字符串。');
  selectAnswer(sessionId, turn, id);
  return answerPayload(sessionId, turn);
}

function removeAnswerOperation(operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const id = operation.id;
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('id 必须是非空字符串。');
  removeAnswer(sessionId, turn, id);
  return answerPayload(sessionId, turn);
}

/* ---------------------------------------------------- hiding transcript -- */

/**
 * "Delete" one message or one answer. The session log is append-only, so
 * nothing is removed from it: this records a view flag, the client hides the
 * matching rows and offers an inline restore, and the model keeps reading the
 * full transcript. Real removal needs a rewritten session, which DSH does not
 * support for a live conversation.
 */
async function hideOperation(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  const turn = integerOf(operation.turn, 'turn');
  const scope = operation.scope;
  if (scope !== 'turn' && scope !== 'answer' && scope !== 'prompt') {
    throw new TypeError("scope 必须是 'turn'、'answer' 或 'prompt'。");
  }
  const hidden = operation.hidden !== false;
  const record = await loadSessionRecord(ctx, sessionId);
  if (!turnExists(record.events, turn)) throw new TypeError(`第 ${turn} 轮不存在。`);
  return { turn, scope, hidden: setHidden(sessionId, scope, turn, hidden) };
}

/* --------------------------------------------------- answering, in place -- */

/**
 * Answer one turn again **in the same session**.
 *
 * A closed turn can never grow a second assistant message — the log's invariant
 * (`requireOpenStep` in dsh-session/lib/invariant.js) allows an assistant message
 * only inside an open step, and a rewind is a different session by construction.
 * So when a turn's answer is gone and the reader wants it answered for real
 * (thinking chain, tool cards, streaming, all of DSH's own rendering), the only
 * honest way is a fresh turn: replay the same prompt as a new user message here,
 * let the agent run, and tell the client which turn to hide the replayed prompt
 * in. The question stays where it was; the answer arrives under it.
 *
 * The replay appends one user message to the log, which the model will see — the
 * price of a real answer rather than a text-only stand-in, and the reason the
 * mark lives in plugin state (the log itself is append-only).
 */
async function runAnswerInPlace(ctx, operation) {
  const sessionId = sessionIdOf(operation.sessionId);
  if (operation.stopPrevious === true) await stopFamilyTurns(ctx, sessionId);
  return withSourceAgent(ctx, sessionId, async (agent) => {
    const record = sessionRecord(agent.session);
    const plan = retryPlan(
      sessionId,
      operation.turn,
      closedTurns(record.events),
      operation.model,
    );
    const opened = record.events
      .filter((event) => event.type === 'turn/start')
      .map((event) => event.data.turn);
    // Turn numbers are handed out one after another, so the next one is the turn
    // the replayed prompt will open. The client hides exactly that prompt.
    const turn = (opened.length === 0 ? plan.turn : opened[opened.length - 1]) + 1;
    for (const message of plan.queuedUsers) agent.followup(message);
    return {
      sessionId,
      turn,
      replayedFrom: plan.turn,
      queuedTurns: plan.queuedUsers.length,
      inPlace: true,
    };
  });
}

/* --------------------------------------------------------- version state -- */
async function deleteVersion(ctx, sessionId) {
  const record = await loadSessionRecord(ctx, sessionId);
  const own = ownVersionEvent(record);
  if (own === undefined) throw new TypeError('只有版本卡片可以删除；当前会话是原始对话。');
  const parent = record.header.parentSession;
  markDeleted(sessionId, { parent, turn: own.effect.targetTurn });
  let archived = false;
  try {
    archived = await archiveVersion(ctx, sessionId);
  } catch {
    // The card is hidden by the state flag even when archiving fails.
  }
  return { deleted: true, archived, parent, turn: own.effect.targetTurn };
}

async function restoreVersion(ctx, sessionId) {
  unmarkDeleted(sessionId);
  let unarchived = false;
  try {
    const result = await activateVersion(ctx, sessionId);
    unarchived = result.unarchived;
  } catch {
    // Navigating may still work if the session was never archived.
  }
  return { deleted: false, unarchived };
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
  if (version.schemaVersion !== MESSAGE_TOOLBAR_SCHEMA) throw new Error(`会话 ${header.id} 使用不支持的版本效果结构。`);
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
      current = { turn: event.data.turn, startSeq: event.seq, time: event.time, answered: false };
      continue;
    }
    if (current === undefined) continue;
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') {
      current.user = event;
      current.text = userText(event.data);
      current.time = event.time ?? current.time;
      continue;
    }
    // A durable answer: the only surface op a human transcript reads.
    if (event.type === 'assistant/message' && event.data?.turn === current.turn
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      current.answered = true;
      continue;
    }
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      result.push({
        turn: current.turn,
        text: current.text ?? '',
        time: current.time ?? event.time,
        answered: current.answered === true,
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
  const key = live === undefined ? snapshot.events.length : sessionEventCount(live);
  const cached = sessionParsedCache.get(id);
  if (cached !== undefined && cached.key === key && cached.live?.deref() === live) {
    return cached;
  }

  const source = snapshot ?? sessionRecord(live);
  const events = source.events;
  const turns = extractTurns(events);
  const messages = indexMessages(events);
  // The model this session is configured with, so the picker can mark the row
  // the session already answers with.
  const configured = events.findLast((event) => event.type === 'request/header')?.data.header.config;
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

  // Cache identity without keeping a disposed session's entire log alive.
  const entry = { key, live: live === undefined ? undefined : new WeakRef(live), turns, messages, effect, time, model };
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
  const versions = flat.map(({ entry, depth }, index) => {
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
    return {
      sessionId: entry.id,
      ...entry.parentId === undefined ? {} : { parentSessionId: entry.parentId },
      createdAt: time ?? record?.header.createdAt ?? entry.createdAt,
      depth,
      current: entry.id === sessionId,
      onCurrentPath: currentPath.has(entry.id),
      ...entry.ghost ? { deleted: true } : {},
      ...deletedSet.has(entry.id) ? { deleted: true } : {},
      ...archived.has(entry.id) ? { archived: true } : {},
      ...effect === undefined ? {} : {
        operation: effect.operation,
        targetTurn: effect.targetTurn,
        targetEventSeq: effect.targetEventSeq,
        ...effect.before === undefined ? {} : { before: effect.before },
        ...effect.after === undefined ? {} : { after: effect.after },
        ...effect.model === undefined ? {} : { model: effect.model },
      },
      turns,
      messages,
      ...model === undefined ? {} : { model },
    };
  });

  const current = versions.find((version) => version.sessionId === sessionId);
  const currentIndex = flat.findIndex(({ entry }) => entry.id === sessionId);
  const currentEvents = currentIndex >= 0 ? (recordsById.get(sessionId)?.events ?? []) : [];
  return {
    sessionId,
    versions,
    messages: current?.messages ?? [],
    model: current?.model,
    translations: translationsForSession(sessionId),
    shown: shownForSession(sessionId),
    // The original text of every turn that is showing a translation: the answer
    // is drawn beside it, paragraph by paragraph, so the client needs both sides.
    origins: originTexts(sessionId, currentEvents),
    answers: answersForSession(sessionId),
    turns: current?.turns ?? [],
    hidden: hiddenForSession(sessionId),
    deleted: [...deletedSet],
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
  return value;
}

function integerOf(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} 必须是非负安全整数。`);
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
    default:
      // Name the action and the full vocabulary: a mismatch here almost always
      // means the running host half is older than the loaded client bundle
      // (the client keeps talking while the host was never restarted).
      throw new TypeError(
        `action 无法识别：${JSON.stringify(record['action'])}。`
        + '可用：edit、retry、translate、delete-version、restore-version、activate、focus、models、'
        + 'answer-generate、answer-save、answer-source、answer-select、answer-delete、answer-restore、'
        + 'answer-run、hide。'
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
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function respondJson(response, status, value) {
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
async function respondAnswerStream(ctx, response, operation) {
  response.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  if (typeof response.flushHeaders === 'function') response.flushHeaders();
  const send = (frame) => {
    if (response.writableEnded) return;
    response.write(`${JSON.stringify(frame)}\n`);
  };
  try {
    await generateAnswer(ctx, operation, send);
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  if (!response.writableEnded) response.end();
}

async function handleRoute(ctx, request, response) {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url ?? MESSAGE_TOOLBAR_PATH, 'http://message-toolbar.local');
      if (url.searchParams.get('models') === '1') {
        respondJson(response, 200, await modelsCatalog(ctx));
        return;
      }
      respondJson(response, 200, await tree(ctx, sessionIdOf(url.searchParams.get('sessionId'))));
      return;
    }
    if (request.method === 'POST') {
      const body = await requestJson(request);
      if (body !== null && typeof body === 'object' && body.action === 'activate') {
        respondJson(response, 200, await activateVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'focus') {
        respondJson(response, 200, await focusVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'delete-version') {
        respondJson(response, 200, await deleteVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'restore-version') {
        respondJson(response, 200, await restoreVersion(ctx, sessionIdOf(body.sessionId)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'translate') {
        const operation = objectValue(body);
        respondJson(response, 200, await translateMessage(ctx, {
          sessionId: sessionIdOf(operation['sessionId']),
          eventSeq: operation['eventSeq'] === undefined ? undefined : integerOf(operation['eventSeq'], 'eventSeq'),
          turn: operation['turn'] === undefined ? undefined : integerOf(operation['turn'], 'turn'),
          text: typeof operation['text'] === 'string' ? operation['text'] : undefined,
          lang: typeof operation['lang'] === 'string' ? operation['lang'] : 'zh',
          force: operation['force'] === true,
          model: operation['model'] === undefined ? undefined : modelRequest(operation['model']),
        }));
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
      if (body !== null && typeof body === 'object' && body.action === 'answer-generate') {
        const operation = {
          sessionId: sessionIdOf(body['sessionId']),
          turn: integerOf(body['turn'], 'turn'),
          model: body['model'] === undefined ? undefined : modelRequest(body['model']),
        };
        if (body['stream'] === true) {
          await respondAnswerStream(ctx, response, operation);
          return;
        }
        respondJson(response, 200, await generateAnswer(ctx, operation));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-save') {
        const operation = objectValue(body);
        respondJson(response, 200, saveAnswer({
          sessionId: operation['sessionId'],
          turn: operation['turn'],
          text: operation['text'],
          baseId: typeof operation['baseId'] === 'string' ? operation['baseId'] : undefined,
        }));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-source') {
        respondJson(response, 200, await answerSource(ctx, objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-select') {
        respondJson(response, 200, selectAnswerOperation(objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-delete') {
        respondJson(response, 200, removeAnswerOperation(objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-restore') {
        respondJson(response, 200, restoreAnswerOperation(objectValue(body)));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'answer-run') {
        const operation = objectValue(body);
        respondJson(response, 200, await runAnswerInPlace(ctx, {
          sessionId: operation['sessionId'],
          turn: operation['turn'],
          stopPrevious: operation['stopPrevious'] === true,
        }));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'hide') {
        const operation = objectValue(body);
        respondJson(response, 200, await hideOperation(ctx, {
          sessionId: operation['sessionId'],
          turn: operation['turn'],
          scope: operation['scope'],
          hidden: operation['hidden'],
        }));
        return;
      }
      if (body !== null && typeof body === 'object' && body.action === 'models') {
        respondJson(response, 200, await modelsCatalog(ctx));
        return;
      }
      respondJson(response, 200, await runOperation(ctx, decodeOperation(body)));
      return;
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
    respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MESSAGE_TOOLBAR_PATH,
    handler: (request, response) => handleRoute(ctx, request, response),
  }), 'message-toolbar: HTTP route');
}

export { MESSAGE_TOOLBAR_PATH, MESSAGE_TOOLBAR_SCHEMA, MARKER_TYPE, inject, name, apply };
