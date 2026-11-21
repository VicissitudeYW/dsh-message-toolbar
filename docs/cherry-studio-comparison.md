# Cherry Studio 消息工具栏对照

目标是在 DSH 的原生消息和真实 agent 之上，尽量复现 Cherry Studio 的消息操作体验。相同按钮名称不代表相同的会话语义。本次研究固定源码版本，再分别验证交互、消息状态和模型上下文。

## 研究依据

2026-11-21 核对了官方仓库 [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)，固定提交为 [`e00f061f66297fc8adcaf8ef378be67942565fac`](https://github.com/CherryHQ/cherry-studio/tree/e00f061f66297fc8adcaf8ef378be67942565fac)。该源码已是 v2；本笔记描述这个提交，不能用来断言任意 v1 安装的界面细节。

| 官方源码（均位于上述提交） | 实际职责与本次借鉴 |
| --- | --- |
| [`frame/messageMenuBarActions.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/components/chat/messages/frame/messageMenuBarActions.tsx) | 命令与动作描述集中管理；`availability` 决定可见/可用/原因。翻译运行时用暂停图标执行中止，删除前先中止附属翻译。复制等待真实 clipboard 写入。 |
| [`frame/MessageMenuBarToolbarRenderers.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/components/chat/messages/frame/MessageMenuBarToolbarRenderers.tsx) | 动作按钮、确认、模型选择、翻译菜单与更多菜单；禁用原因作为 tooltip，禁用期间仍允许关闭已打开的确认框。 |
| [`list/SiblingNavigator.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/components/chat/messages/list/SiblingNavigator.tsx) | 用户消息的兄弟分支导航；数字打开带预览及当前勾选的列表，通过 `setActiveBranch` 切换活动路径。插件借鉴“计数 + 模型 + 内容预览”，不是搬运其分支模型。 |
| [`list/MessageGroupMenuBar.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/components/chat/messages/list/MessageGroupMenuBar.tsx) | 同问多模型回答的折叠/纵向/横向/网格布局；整组删除、批量重试失败回答，并按模型合并重试候选。 |
| [`blocks/MessageTranslate.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/components/chat/messages/blocks/MessageTranslate.tsx) | 译文块、首 token 等待态及单独关闭；原文与翻译的实际展示可由不同宿主适配器决定。 |
| [`hooks/translate/useTranslate.ts`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/hooks/translate/useTranslate.ts) | AbortController 与当前请求身份配对；取消即时结束忙状态，后到的旧结果/错误不覆盖新请求。 |
| [`pages/home/messages/homeMessageListAdapter.tsx`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/pages/home/messages/homeMessageListAdapter.tsx) | 消息翻译的独立 controller、错误与空翻译清理，转发重生成和换模型动作。 |
| [`pages/home/hooks/useChatWriteActions.ts`](https://github.com/CherryHQ/cherry-studio/blob/e00f061f66297fc8adcaf8ef378be67942565fac/src/renderer/pages/home/hooks/useChatWriteActions.ts) | 重生成使用提问的 `parentAnchorId`；部分失败回答可原位重试。切分支修改 topic 的 `activeNodeId`，编辑持久消息，删除由服务端重挂子节点。 |

DSH 对照本机版本 `0.2.2-rc.5` 的官方提交 [`9c2670d3bce5275e0d1610272958121af87787bb`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb)。主要依据：

- [`packages/llm/llm/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/llm/llm/src/types.ts)：`GenerateOptions.signal?: AbortSignal`；`StreamChunk.finish.reason` 是含 `kind` 的对象，正常、长度上限、失败与中止都可以通过这个终态表达。
- [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/core/agent-loop/src/agent.ts)：`buildRequest` 从 `session.deriveMessages()` 取得不可变模型消息；公开的 `agent/request` 配置中间件不提供任意的每次请求历史替换。
- [`packages/core/session/src/surface.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/core/session/src/surface.ts)：model-visible surface 与追加日志不同，但 replace 是持久日志语义，不能当作本次重答的临时遮罩。
- [`packages/client/ui-primitives/src/Menu.tsx`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/client/ui-primitives/src/Menu.tsx)：菜单行 label 接受 ReactNode，可在现有原生菜单加入内容预览，保留菜单自身的键盘与焦点处理。
- [`packages/host/webserver/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/host/webserver/src/index.ts) 与 [`synthetic-http.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/9c2670d3bce5275e0d1610272958121af87787bb/packages/experimental/webworker-runtime/src/transport/synthetic-http.ts)：隧道断连可能先设置 `writableEnded` 再发送 `close`。翻译取消监听不把这个标记当作正常完成；清理使用 `.off()`。这项响应生命周期兼容不代表整个插件已经适配 Web Worker 宿主。

Context7 本次返回配额耗尽，无法取得其文档索引；已通过网页检索核对官方仓库，并直接读取上述固定版本源码。行为借鉴在本项目内独立实现，没有引入 Cherry 的运行时或消息数据库。

## 哪些已经接近，哪些仍不同

| 动作/场景 | Cherry 的实现 | 插件 1.10.0 的行为 | 判断 |
| --- | --- | --- | --- |
| 重新生成 / 换模型 | 重生成由提问锚点确定新回答/重试位置，持久层负责分组与活动路径 | 同会话追加真实 agent turn，隐藏重放提问与其它备选；保留真实工具/思维/流式过程；临时模型在完成后恢复 | 显示接近，模型上下文不同。DSH 会保留旧回答与重复问题，不能称为完全一致 |
| 回答选择 | 兄弟分支导航会改变活动路径；同问多模型有分组布局与上下文选择 | 原生回答轮次环；计数菜单列模型和短内容预览、勾选当前项，直接跳到所选回答 | 可复刻预览和切换操作；`run-select` 仍只控制显示，不控制后续模型上下文 |
| 编辑用户提问 | 编辑持久消息；另有兄弟分支编辑后重发 | 保存只改显示/下一次重放输入；发送按钮单独触发真实 agent，附件引用保留 | 遵从用户明确的“保存不自动发送”；已发送日志及后续模型历史不会被重写 |
| 编辑回答 | 修改持久消息正文 | markdown 源码原位编辑，保存覆盖所选回答的插件显示值，不新增备选 | 阅读体验可复刻；对日志与模型上下文的作用不同 |
| 翻译 | 独立取消信号和请求身份，运行中可中断，清理过期/空翻译 | 目标语言菜单、原译按段对照、流式输出；运行时按钮变“停止翻译”，取消传到 fetch、HTTP 响应与 DSH provider signal；取消的半截内容不保存 | 中断不受 DSH 限制，本轮补齐；沿用插件既有代码/公式保护及不人为截 token 要求 |
| 复制 | 等待 clipboard 成功，失败由通知反馈 | 复制所见备选/编辑文本，译文可单独复制；三个插件复制入口都等待成功才提示，权限/API 失败可见 | 本轮修复假成功；原生复制按钮继续由 DSH 控制 |
| 删除 | 服务端持久删除、按树重挂子节点，生成期间限制删除 | 插件状态隐藏指定回答/整轮及附属行；整轮级联重放回答，不归档会话 | 显示效果接近；模型历史不会因此删除 |
| 失败 / 中止 | 保留可用重试动作；状态来自消息和流协议 | 无回答时仍有重答/换模型/删除；翻译及旧纯文本备选接口识别 DSH `finish` 的 error/aborted，拒绝把 partial 当成功；max-tokens 明示截断 | 后两项是本轮修正的协议 bug，不是 DSH 无法做到 |
| 朗读 / 笔记 / 知识库 / 导出 | 有对应服务与数据体系 | 未加入 | 属于独立产品范围，并非概括成“DSH 不支持” |
| 同问并排 / 多选批量操作 | 完整分组布局及批处理 | 本轮保持一次显示一条原生真实回答 | 设计范围取舍。可以另做，但需要处理原生工具行、过程和大纲，不应把纯文本并排卡说成等价实现 |

## 1.10.0 的实际改动

1. 翻译停止按钮和取消链路；忙状态由每会话/每轮共享的 live 状态决定，组件重挂时仍可停止。宿主在异步读取会话前记录请求顺序，旧请求无法抢占后发重试；读取期间关闭翻译也能阻止旧结果。
2. 关闭译文、编辑、删除或替换该回答会中止匹配的 host 翻译；客户端断连也会取消 provider。仅改变当前轮，不影响旁边另一轮的翻译。
3. 当前 DSH 把部分失败转成结构化 finish，而不抛异常。现在拒绝失败/中止后的半截译文与旧文本备选；识别 `max-tokens` 以显示截断提示。
4. 回答菜单显示模型与对应回答摘要，优先取当前所选的旧文本备选，再取编辑值或原文；空回答不会错误地把问题当作答案预览。摘要与悬浮文本限制为 120 字符，只在菜单打开时生成，保留原生菜单选择和勾选。
5. 复制失败不再假报成功；重答入队不再提示“已就绪”，编辑保存不再声称“新增备选”。
6. 客户端收到完整 `done` 帧立即结算，不继续等待连接关闭，避免已保存的完整译文被误点停止丢弃。复制反馈按操作身份匹配，旧成功不会覆盖后发失败。

## 验证边界

回归测试执行真实 host/client 源码，用户状态隔离；另有本地真实 HTTP 流连接把客户端 AbortController 接到宿主 provider signal。它验证的是传输和状态链路，不是一次实际云模型调用。隔离浏览器预览加载当前插件源码、React 18.2 与固定版本 DSH 原生菜单，检查了键盘切换、停止翻译和 390 像素深色窗口溢出；它不构成整个 DSH 客户端的验收。本机正在使用的 DSH 安装副本与个人会话未作本轮变更。最终命令结果见本轮计划中的交付记录。
