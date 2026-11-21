# 模型恢复与跨进程状态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让临时模型重答在对应轮次结束后恢复原选择，并防止并行 DSH 进程互相覆盖插件状态。

**Architecture:** 在 host 层关联已排队的重放消息与结束事件，在不覆盖后续选择的前提下恢复公开模型选择。持久层通过跨进程文件锁在最新状态上顺序应用排队 mutation 的 before/after 差异，再原子落盘并刷新其他进程的缓存。

**Tech Stack:** JavaScript ESM、Node 24、`node:test`、DSH 0.2.x。

**Spec:** `docs/superpowers/specs/2026-11-21-model-restore-and-state-lock-design.md`

## Global Constraints

- 保持 schema 1、无生产依赖、隔离测试不使用用户真实 DSH home 或会话。
- 只使用 DSH 公共模型与会话事件 API；不修改 DSH、不伪造上下文历史。
- 文件写失败或锁超时时，不得静默覆盖或丢弃已提交状态。
- 推送前运行完整 `npm test` 与 `npm pack --dry-run`；不发布 npm、不改已安装插件、不重启 DSH。

## Review Focus

- 外部用户消息先于已排队重放开轮：必须以重放消息 ID 找到实际轮次，不得提前恢复。
- 重放中途报错或取消：结束事件仍应触发模型恢复。
- 用户在重答期间主动切到第三个模型：恢复逻辑不得覆盖它。
- 两进程修改同一 hidden 数组不同轮号：最终集合必须包含两者。
- 锁持有者仍存活或锁超时：不得删除其锁或改写状态文件。

---

### Task 1: 精确恢复重答前的模型

**Files:**
- Modify: `lib/index.js`
- Test: `test/host-regressions.test.mjs`

**Interfaces:**
- 消费现有 `agent.model.current()` / `selectModelForNextTurn()` 与 `plan.queuedUsers[0].id`。
- 在目标会话中以 `turn/start`、`user/message.id`、`turn/end` 精确关联重放轮，并在事件分发之后有条件恢复旧模型。

- [x] **Step 1: 写失败回归测试**：显式模型重答的实际消息对应 `turn/end` 后选择恢复；第三方后续模型选择不会被覆盖；错误/取消结束也恢复；无关 session/turn 不触发。
- [x] **Step 2: 运行 `node --test test/host-regressions.test.mjs` 确认模型恢复断言失败**。
- [x] **Step 3: 实现目标重放事件跟踪与有条件恢复**，并覆盖消息排队失败时的监听器清理。
- [x] **Step 4: 重跑该测试文件，确认全部通过**。
- [x] **Step 5: `npm test` 并提交 `fix: restore the prior model after a replay`**。提交 `6f3f28e`。

### Task 2: 串行化跨进程状态写入

**Files:**
- Modify: `lib/durable-state.js`
- Modify: `test/state-store.test.mjs`

**Interfaces:**
- 保持 `createDurableState(file, { empty, normalize, delay })` 的 `read/mutate/flush/reload` 外部形状。
- 文件锁必须在有界期限内返回明确的失败；磁盘变化时先刷新基线并依序重放本进程尚未 flush 的 mutation。

- [x] **Step 1: 写失败回归测试**：并行子进程写不同 session、并发追加同一隐藏列表、预热缓存后观察外部提交、活锁超时不覆盖文件、死进程遗留锁可恢复。
- [x] **Step 2: 运行 `node --test test/state-store.test.mjs` 确认并发/锁断言失败**。
- [x] **Step 3: 加入独占锁、超时与失效锁处理，刷新磁盘基线并顺序合并待提交 mutation 的差异**。追加 5 个失败用例，加固锁发布、数组首次创建、标量编辑、容器删除和读取签名竞态。
- [x] **Step 4: 重跑该测试文件，确认全部通过**。
- [x] **Step 5: `npm test` 并提交 `fix: serialize shared state writes across processes`**。提交 `4c623a3`。

### Task 3: 文档、审查与交付

**Files:**
- Modify: `README.md`, `README.en.md`, `docs/ARCHITECTURE.md`, `docs/RELIABILITY-2026-11-21.md`
- Remove: repository-root `模型恢复与并发状态 TO DO list.csv`

- [x] **Step 1: 更新运行限制与实现说明**，记录状态文件锁行为、模型自动恢复及无法保证的真实运行环境边界。
- [x] **Step 2: 审查整个差异与状态生命周期**，重点检查失败清理、锁竞态、删除/追加语义及包文件范围。
- [x] **Step 3: 运行完整 `npm test`、`npm run build`、`npm pack --dry-run`、`git diff --check`**。`npm test` 136 项（135 通过、1 跳过）；build 通过；dry-run 包清单 29 项，无测试/用户状态/临时文件。
- [x] **Step 4: 提交文档并核验提交差异**。实现与说明分别提交；临时清单在交付完成后按状态规则清理。
- [x] **Step 5: 将分支 fast-forward 到 `main` 并推送已配置 GitHub remote，核对远端 SHA**。快进后推送 `origin/main`；远端和本地都为 `8957c877a5399ccffb371b76d1cfc96c736ff9f9`。
