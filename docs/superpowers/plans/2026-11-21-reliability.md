# 消息工具栏可靠性 Implementation Plan

> **For agentic workers:** 使用 executing-plans 按任务执行，修复遵守 test-driven-development，交付前进行独立代码审查。用户已授权自主执行，不等待设计确认。

**Goal:** 保留历史最终交互，修复可证实缺陷并减少高风险边界的耦合。

**Architecture:** 保留 host route、Cordis 与原生客户端插槽；提取文件回退、状态保存和必要的纯逻辑。现有 client 入口继续生成单文件 bundle。

**Tech Stack:** JavaScript ESM、Node 24、node:test、DSH 0.2.x。

**Spec:** `docs/superpowers/specs/2026-11-21-reliability-design.md`

## Global Constraints

- 不引入生产依赖，不提交个人日志、状态、凭据或测试截图。
- 不强推，不发布 npm，不修改真实会话或自动重启 DSH。
- 保留 schema 1 与原有外观；以最新用户要求为准。

## Review Focus

- 已删除原回答后重放：只有一个有效答案，无幽灵备选。
- mutation 与正在进行的 GET 交叉：补取新快照，loading 能结束。
- 新建文件被用户后续修改、已删除文件及空文件：拒绝覆盖且正确恢复。
- 状态 JSON 损坏、非法结构或 mutation 抛错：不污染或覆盖原始数据。
- 不同模型/译文请求完成顺序相反：不得把旧内容展示到新回答旁。

## Task 1: 协议与重放边界

Files: `lib/index.js`, `lib/session-record.js`, `test/host.test.mjs` 及必要独立行为测试。

- [ ] 对 group=false、非法模型/轮号和重叠重放补充失败用例。
- [ ] 修复字段转发与副作用前验证，确保删除后重新回答无旧备选。
- [ ] 调查官方 surface 能力；只实施与已安装版本契约一致且有回归证据的上下文隔离。
- [ ] 运行 host 及全量测试，记录结果并提交。

## Task 2: 文件回退

Files: `lib/workspace-revert.js`（新增）、`lib/index.js`、`test/workspace-revert.test.mjs`（新增）。

Interfaces: 从 `revertTurn` 提取 `revertWorkspacePlan(plan)`；消费原 `collectTurnChanges` 结果，返回原 `{turn,reverted,skipped,cwd}`。

- [ ] 真实临时目录复现新增文件被误删、删除文件无法重建、零行 hunk 等错误。
- [ ] 实现预检与安全回退，保护用户后续修改；处理异常并说明非事务性磁盘限制。
- [ ] 运行回归及全量测试并提交。

## Task 3: 持久化与客户端竞态

Files: `lib/state-store.js`、`plugin.client.js`、必要独立模块及 `test/*`。

- [ ] 先复现状态损坏/部分 mutation、刷新竞态、流中断等明确问题。
- [ ] 以小模块和确定性的请求版本处理修复根因，保持旧状态兼容。
- [ ] 更新构建与测试脚本，让测试检验当前源生成的 bundle。
- [ ] 全量回归，提交。

## Task 4: 审查与交付

Files: 中英文 README、`docs/ARCHITECTURE.md`、修复报告和 package 元数据。

- [ ] 独立审查最终差异，针对发现补回归与修复。
- [ ] 更新中英文说明及真实兼容限制，修正过时的协议文档。
- [ ] `npm test`、`npm run build`、`npm pack --dry-run`、语法与 diff 检查。
- [ ] 核对脱敏、清理临时 CSV，fast-forward main、推送并验证远端 SHA。
