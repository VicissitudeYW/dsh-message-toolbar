# Active Tasks

- [x] 修复自动化任务运行失败、会话没有用户消息时，点击重新生成报“没有可操作的提问。”的问题。（2026-11-25；用户已批准；实现、验证与只读代码复核已完成）
  - 只读定位：`contextTurns()` 仅将 `source.kind === 'user'` 识别为提问；`inSessionView()` 保留无人工提问轮次，但 `targetIn()` 对所有操作强制要求 `turn.user`，导致重答提前返回 400。后续排队确认与 pending 匹配同样依赖人工 user 消息，不能只删除入口判断。
  - 完成验证：新增 19 项自动化回归均通过；全量 210 项中 209 通过、1 项 Windows 文件符号链接权限跳过。已安装 DSH 的临时 home + 脚本模型集成通过，包含无人工消息、pre-step 失败未产生 user/message、同轮人工 steer、版本选择与失败路径保留；构建、四个宿主模块语法检查和 diff 检查通过。详细记录见本地忽略的 `docs/AUTOMATIC-RETRY-2026-11-25.md`；未同步 profile、未重启日常 DSH、未发布，未验收云模型或 GUI。

# 经验与交接

- **自动化重答输入身份**：人工提问 `turn.user` 与轮次发起输入 `turn.input` 必须区分，自动化使用 `schedule` 来源，早期失败可从持久 inbox claim 恢复；同轮后续人工 steer 及其编辑不能覆盖原输入 ID、来源或内容，pending 和模型历史须以原输入关联。
- **本轮测试设施更新**：补齐本地 host harness 的鉴权服务与同步 fixture 的构建脚本副本，修正旧失败/中止重答断言为既有“保留原路径”语义后，全量测试已可通过（仅权限跳过），取代下方接入时的失败基线；`test/`、`docs/` 仍本地忽略，隔离宿主集成使用脚本模型不等于真实 GUI/云模型验收。

- **宿主/客户端边界**：`package.json` 的宿主入口是 `lib/index.js`；`plugin.client.js` 是由宿主提供 React 的客户端源，`scripts/build-client.mjs` 将其作为 IIFE 函数体包装到 `lib/client.js`。修改源后必须构建，不能手改生成文件或直接以 ESM 语法检查源文件。
- **同会话回答路径**：`lib/index.js` 使用原 agent 的 `followup` 重答；`lib/in-session-context.js` 管理选中的回答及后续消息，并为 UI 和模型请求提供投影。保留 DSH 原始追加式日志；旧版版本树导航仅处理既有会话，不应让普通重答新建或归档会话。
- **持久化与兼容**：`lib/state-store.js` 将回答路径、翻译和旧版显示状态等保存在 `~/.dsh/message-toolbar/state.json`，当前 schema 为 1；`lib/durable-state.js` 负责校验、跨进程锁、最新状态合并和原子替换。成功确认前需 flush；损坏或未知状态应报错保留，不能清空重建。
- **鉴权与撤销边界**：`lib/index.js` 通过 `webServer.register` 注册 `/message-toolbar` 并声明 `auth: 'required'`，路由保留 peer 校验。`lib/workspace-revert.js` 的磁盘撤销独立于回答选择，需显式用户操作及路径、内容校验；不能把切换回答等同于自动回滚文件。
- **验证与部署边界**：实际 `package.json` 仅有 `build`、`sync`、`prepack` 脚本，旧 `docs/` 中的 `npm test` 已不适用。现有 `test/*.test.mjs` 使用 Node 测试运行器及隔离 home/工作区，部分客户端测试读取构建产物；可选 `test/in-session-context.integration.mjs` 另需安装的 Electron/DSH。`test/`、`docs/` 为本地忽略目录，不强制提交；`scripts/sync-profile.mjs` 会写入真实 profile，常规验证不运行它。

2026-11-25 接入记录：新增 `AGENTS.md` 与本文件；`npm run build`、两入口语法检查通过，生成客户端 SHA-256 与构建前一致；排除下述已知失败文件后，6 个测试文件共 133 项通过、1 项因 Windows 文件符号链接权限跳过。全量单测未通过：`test/helpers/host-harness.mjs` 的模拟 ctx 缺少 `connection.requestRejection` 且未传入已准入 peer，当前 `lib/index.js` 因而返回 503 空响应，JSON 解析断言失败，部分流式用例持续等待，已终止该次挂起进程；`test/sync-profile.test.mjs` 的临时 checkout 只复制同步脚本，缺少被 `scripts/sync-profile.mjs` 复制的 `scripts/build-client.mjs`，报 `ENOENT`；本次按逆向建档边界保留业务代码与测试原样，留待后续获批切片处理。
