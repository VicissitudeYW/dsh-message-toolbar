# 版本模型展示修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复显式换模型重答完成后，回答卡片和版本树错误显示恢复后默认模型的问题。

**Architecture:** 保留现有 `sessionParsedData()` 对 composer 当前模型的解析，用版本 marker 的显式 `effect.model` 覆盖版本投影中的会话模型。回答选择项继续由实际 assistant source 优先提供模型信息。

**Tech Stack:** JavaScript ESM、Node.js `node:test`、现有 host harness。

**Spec:** `docs/superpowers/specs/2026-11-21-version-model-display-design.md`

## Global Constraints

- 只修改插件，不修改 DSH 本体、已安装副本或用户会话。
- 保持实际模型生成和模型恢复行为不变。
- 先看到回归测试失败，再写生产代码。
- 完成前运行完整 `npm test`、`npm run build`、`git diff --check` 和 `npm pack --dry-run --json --ignore-scripts`。

## Review Focus

- 显式换模型且生成完成后恢复默认模型：版本标签仍必须显示备选模型。
- 没有显式模型的普通编辑/删除版本：继续使用解析出的会话模型。
- 回答选择项：实际 assistant source 优先，不能被版本级 fallback 覆盖。

### Task 1: 建立失败回归测试

**Files:**
- Modify: `test/host-regressions.test.mjs`

- [x] 写一个通过 host harness 创建显式备选模型重答、追加 assistant/turn end、等待恢复后读取 `GET /message-toolbar` 的测试。
- [x] 断言 composer 当前模型恢复为 `original`，但对应 `versions[].model.model` 仍为 `other`，并且选择项模型来自实际 assistant source。
- [x] 运行该单测，确认在当前实现上因 `versions[].model` 为 `original` 而失败。

### Task 2: 修复版本模型优先级

**Files:**
- Modify: `lib/index.js`

- [x] 让 `tree()` 在版本对象中优先使用显式 `effect.model`，只有不存在时才 fallback 到 `parsed.model`。
- [x] 运行回归测试，确认通过且普通版本仍保持当前模型解析行为。

### Task 3: 完成验证与交付

**Files:**
- Modify: `docs/RELIABILITY-2026-11-21.md`（如需记录本次缺陷修复）
- Remove: `修复版本模型标签 TO DO list.csv`

- [x] 运行完整测试、构建、差异检查和打包预览，读取退出码与失败数。
- [x] 检查最终 diff 与包清单并提交修复。
- [x] 独立审查已提交的改动。
- [x] 推送当前分支和 `main`，核对两个远端 SHA。
