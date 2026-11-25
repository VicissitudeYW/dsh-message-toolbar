# Project Rules

## 技术栈
- Node.js 原生 ESM（`type: module`），宿主代码无第三方运行时依赖。
- DSH/Cordis 插件；声明兼容 `@deepseek-ai/dsh >=0.2.2-rc.5 <0.3.0-0`。
- 浏览器客户端使用宿主提供的 React，由构建脚本包装为 `window.__ModuleLoader__` 模块。

## 目录职责
- `lib/index.js`：宿主入口、HTTP 路由、当前 agent 重答、模型历史投影与翻译。
- `lib/in-session-context.js`、`lib/context-*.js`：回答路径、历史兼容与压缩；`lib/model-selection.js`：模型选择。
- `lib/state-store.js`、`lib/durable-state.js`：插件状态与原子持久化；`lib/session-record.js`：会话读取；`lib/workspace-revert.js`：文件撤销。
- `plugin.client.js`：客户端源文件；`lib/client.js`：生成文件；`scripts/`：构建和 profile 同步。
- `test/`：本地测试及 harness；`docs/`：本地设计和验证记录；`assets/`：公开截图等资源。
- `.agent/MEMORY.md`：当前任务切片与项目经验；`package.json`、`cordis.patch.yml`：插件入口及发布配置。

## 常用命令
- 以下命令均在项目根目录执行。
- 构建：`npm run build`。
- 测试：`node --test test/*.test.mjs`（先构建；包含读取生成客户端的测试）。
- 语法检查：`node --check lib/index.js`、`node --check lib/client.js`。
- 差异检查：`git diff --check`。
- 当前没有 `npm test` 或 lint 脚本；`test/`、`docs/` 受 `.gitignore` 排除，干净克隆可能缺失，缺失时应明确报告验证限制。
- 已知本地基线：宿主 harness 缺鉴权服务、同步测试 fixture 缺构建脚本，全量测试存在失败或挂起；详情见 `.agent/MEMORY.md`。
- 可选真宿主验证：`test/in-session-context.integration.mjs`，需已安装 DSH 的 Electron Node 模式及 `resources/app.asar`，不属于上述单测。

## 红线
- 多步改代码时先只读 `.agent/MEMORY.md`；新需求或 Bug 先追加为 `Active Tasks` 的 `- [ ]` 并锁定，否则锁定首个未完成切片；给出 10～15 行方案，获用户批准后才改业务代码。
- 一次只做一个切片；改完主动运行上述构建、测试和检查。同一卡点连续三轮未解，停止并记录现象与无效路径，交由新会话接管。
- 完成后标 `[x]`、追加 1～2 句经验并 `git commit`；经验超过 80 行时提议拆分 `patterns.md`。完整协议见 `~/.agents/agent-template/PROTOCOL.md`，本项目规则与用户当前指令优先。
- 编辑客户端只改 `plugin.client.js`，再构建 `lib/client.js`；源文件作为 IIFE 函数体使用，不能直接对其执行 `node --check`。
- 重答、编辑及回答切换保持当前 session，保留 DSH 追加式原始事件；回答路径与模型实际读取的投影必须一致。
- `/message-toolbar` 保持 `auth: 'required'` 并保留 peer 校验；状态写入成功后才能确认操作完成，不绕过跨进程锁、合并及原子替换。
- 测试使用临时 home 和工作区；未经明确要求不改真实 `~/.dsh` 状态、不运行 `npm run sync`、不重启 DSH、不发布。
- 保留 `test/`、`docs/` 等本地忽略约定，不强行纳入版本控制；不把模拟单测通过表述为真实 DSH、云模型或 GUI 验收通过。
