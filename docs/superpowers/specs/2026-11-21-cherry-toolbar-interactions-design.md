# Cherry Studio 工具栏交互对照与改进 spec

## 意图

用户希望把 DSH 里的消息工具栏尽量做得像 Cherry Studio 的消息工具栏：动作易发现、状态清晰，正在进行的翻译可以停止，用户能从回答模型与内容中判断应该切换哪一份。保留 DSH 自己的会话、agent、工具调用、流式回答与原生消息渲染。

## 依据

- Cherry Studio 官方仓库 `CherryHQ/cherry-studio`，本次调研固定于 `e00f061f66297fc8adcaf8ef378be67942565fac`（2026-11-21 浅克隆头）。
- Cherry 的 `src/renderer/components/chat/messages/frame/messageMenuBarActions.tsx` 用动作描述与 availability 统一显示、启用状态和命令；`MessageMenuBarToolbarRenderers.tsx` 绘制控制；`list/SiblingNavigator.tsx` 在分支计数菜单展示当前分支摘要；`blocks/MessageTranslate.tsx` 为翻译提供关闭控件；`hooks/translate/useTranslate.ts` 将 AbortSignal 一路交给翻译请求，并在取消后丢弃过期输出。
- DSH 本机/已安装版本为 0.2.2-rc.5，对照官方 tag `dsh-v0.2.2-rc.5`，commit `9c2670d3bce5275e0d1610272958121af87787bb`。官方 DSH 的 `GenerateOptions.signal` 支持 AbortSignal，`ctx.llm.stream` 可接收信号；agent 请求上下文则按公开的 session surface 派生。
- Context7 本次超出调用配额；Cherry 与 DSH 的这些结论已由各自固定 SHA/tag 下的官方 GitHub 源码交叉核验。

## 方案

1. 重写 renderer 和会话模型，把 Cherry 的消息结构搬到 DSH：能够最大限度贴近对照产品，但必须取代 DSH 原生消息、进程卡片和 agent 历史，并会破坏用户要求保留的原生工具及过程。
2. 只润色现有图标和菜单文案：风险低，但无法解决翻译不能中止、备选难以分辨等已确认差距。
3. 渐进扩展：保留 DSH agent 与真实 transcript；沿用已有回答组和原生菜单，补上可证明安全的 Cherry 交互（翻译取消、菜单摘要），并重写对照文档说明剩余语义差异。

**采用方案 3**。方案 1 会把“复刻 toolbar”扩展成重做 DSH 的会话/运行时；方案 2 不满足用户点出的差距。用户已授权自主设计、实施、验证并推送，本 spec 依这项现有授权直接作为实施依据。

## 范围与行为

- 翻译按钮在空闲时打开语言菜单；翻译运行时显示停止状态，并可直接点击取消当前翻译，不再被 disabled 属性锁住。
- 取消贯通浏览器请求、中断 HTTP 响应以及 `ctx.llm.stream({ signal })`。取消的部分内容只作为临时流，不写持久翻译缓存、不标记显示语言、不显示普通失败提示；立即释放该轮忙状态，允许重试。每条会话与轮次最多一个当前翻译；旧流不得终止或覆盖后发的新流。
- 回答选择菜单在模型标签旁提供可读的短回答预览，保留当前所选回答和一击切换；不在 transcript 中挪动/复制 agent 消息。
- 更新 Cherry Studio 对照材料，基于已核对的固定 SHA 描述动作表、分支、回答组、翻译与删除语义，并注明插件选择一条原生回答显示。
- 保持现有图标、菜单 primitive、轻暗主题和原生 transcript 布局。

## DSH 边界与非目标

- 用户明示的历史需求要求重答和切模型继续使用真实 agent、工具、思维过程和 DSH 流式消息，不准悄悄改用纯文本生成。
- DSH turn 已结束时，会话记录的工具与助手内容仍是追加式的；插件不能安全地把另一备选重新写成原始历史，也不能把环形选择伪装成模型上下文选择。`run-select` 只切换显示答案。要重现 Cherry 完整分支语义，需要 DSH 树/父节点/活动路径支持；需要请求级上下文隔离才能实现真正的可删编辑及“仅上下文使用”；本轮不伪造这些能力。
- 本轮不重排 native assistant/tool rows 成并排答案卡，不加入朗读/云 TTS、笔记/知识库/导出、多选删除，也不改变“编辑提问保存不自动发送”、回答编辑保存覆盖、删除和保留备选等已有明确要求。
- 不改 DSH 安装副本、用户状态或真实会话，不重启 DSH，不发布 npm。

## 验收

- 先写 host 与 client 行为测试，并观察它们因为传输未中止/不能取消而失败，然后逐层修复直到通过。
- 验证取消在响应中止时传到 LLM signal；不保留 partial/cached translation、不错误写回；host清理活动 controller，client立即恢复可交互；不同轮次同时翻译互不取消，旧任务不能清掉同一轮新任务。
- 验证回答选择菜单标签含正确模型和匹配回答预览，未知/空回答时使用稳定模型标签。
- `npm test`、`npm run build`、语法、diff、打包检查通过；更新库级用户说明。不能真实验证的 GUI/模型行为须如实标记为未验证。

## 审查后补充的验收场景

- 会话读取乱序不能让旧翻译取消后发重试；读取期间关闭翻译，旧任务不能写回。请求顺序只在仍有未完成会话读取时保留，完成后释放。
- DSH 隧道先设置 `writableEnded` 再发 `close` 时，provider 仍收到取消。只依赖响应的 `on/off` 接口；本轮不声称整个插件兼容 Web Worker。
- 收到完整 `done` 后立即显示确认结果，不等待 EOF 或底层 reader 取消完成；provider 的失败/中止终态禁止提交，正常长度上限终态保留已有截断提示语义。
- 分组内旧文本备选优先于 native override，预览模型与正文对应。短摘要和 title 最长 120 字符，菜单关闭时不生成预览列表。
- 复制反馈属于最近一次操作及当时所显示文本，旧请求成功不能覆盖新请求失败。
