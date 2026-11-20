# 1.9.0 可靠性重构报告

日期：2026-11-21。基线：`8cf98f7` / 1.8.8。

本轮依据历史开发会话中的最终要求，采用渐进式重构，保留原生工具栏、真实 agent 和无生产依赖的实现。完整解析了 17,206 个压缩帧、29,770 个事件、138 条直接用户消息；原文仅用于本地分析，不随仓库或包分发。先建立 [spec](superpowers/specs/2026-11-21-reliability-design.md) 和 [实施计划](superpowers/plans/2026-11-21-reliability.md)，再逐项复现和修复。

## 已修复的主要问题

| 范围 | 缺陷与修复 |
| --- | --- |
| 原生重生成 | 路由原先丢弃 `group: false`；现在透传并验证字段，先检查目标轮次再产生取消等副作用。同一会话的准备操作串行，未开始的重放保留预约，避免两个请求预测同一轮。 |
| 多回答与删除 | 删除的回答不再回到备选列表。独立 `replays` 保存问题身份，组只剩一个时也能正确再次生成。删除问题会级联隐藏全部回答；旧编辑、译文或流不能让已删回答复活。 |
| 用户编辑与附件 | 从任意备选再次生成都会读取原问题的最新编辑及附件。附件上传完成前禁止发送，失败会保留提示；上传另一个文件不会吞掉先前失败。保存显示修改与发送保持独立。 |
| 回答编辑与复制 | 修复有真实多回答分组时提前返回导致编辑器和译文不显示；当前可见备选或编辑覆盖参与复制与大纲。编辑仍覆盖原内容，不新增备选。 |
| 模型选择 | 优先调用现代公开 `agent.model.select`；模型状态按原生 `pending ?? lastUsed` 投影折叠，只有匹配的请求 header 才退役 pending，保留 adapter 默认 effort 语义。 |
| 翻译 | 首次完成帧携带原文，立即双语渲染；缓存按源文本 hash 区分。host token 与 client revision 阻止编辑、删除、关闭或新任务之后的旧 delta/done/error 写回。部分流后报错不再记成成功。 |
| 客户端刷新 | GET 与 mutation 使用逻辑版本；旧快照不覆盖本地更新，期间的多次 invalidate 合并为一次补抓，loading 能结束。 |
| 流协议 | NDJSON 检查帧与终止状态，正确处理逐字节 UTF-8、错误和未完成响应，释放 reader；中断不等于成功。 |
| 大纲与隐藏 | 合并同一轮的 prompt/answer/translation 隐藏规则。大纲跟随问题编辑、当前回答和删除；通过 replay 身份识别 singleton，同时继续接收宿主后续新回合。 |
| 状态保存 | 提取 `durable-state.js`；损坏 JSON、未来 schema、顶层及嵌套非法字典报错并保留原文件；兼容 UTF-8 BOM。mutation 在独立 draft 上执行；成功响应前 flush，写入失败可重试。 |
| 文件回退 | 提取 `workspace-revert.js`；全计划预检、staging、全量及逐文件写前复检，反向应用已匹配 hunks，保留区间外后来改动和混合换行。保护被改过的新文件、不覆盖后来重建的已删文件；拒绝路径逃逸、别名和链接。 |
| 回退失败 | I/O 异常尽力补偿，保留并发编辑和所需备份；HTTP 错误提供恢复路径。无法验证的文件明确跳过，UI 报告实际数量并停止重生成。 |
| 构建与安装 | `npm test` 自动构建当前 bundle 并执行全部回归；`prepack` 重建。修复同步脚本强制复制未跟踪 changelog 导致干净安装失败的问题。 |

## 测试与审查

验证环境：Windows、Node `v24.19.0`；已安装 DSH 的版本信息为 `0.2.2-rc.5`。测试使用独立临时 home、临时文件系统、真实 HTTP handler 和执行真实客户端源码的 VM，未读写用户真实状态。

- 既有 `test/host.test.mjs` 与 `test/client.test.mjs` 通过。
- 新增 node:test 回归共 **108 项：107 通过、1 跳过、0 失败**。跳过的是文件本身的 symlink 测试，本机未授予创建权限；目录 junction 与路径替换用例已执行。
- 新缺陷均先建立失败用例，再修复；覆盖状态损坏/写入失败、并发刷新、翻译任务逆序、上传失败、多回答删除和真实磁盘回退。
- 独立只读审查发现四组 P2：问题删除未级联、编辑回答删不掉、删除与 singleton 导致大纲错误、嵌套数组状态丢失。均已补失败用例、修复并独立复验；审查结论无未关闭 P1/P2，可以合并。
- 构建、源码与 bundle 一致性、语法、diff 和打包清单检查见执行记录。打包包含全部运行模块，不包含个人历史、状态、临时 CSV 或测试产物。

**未做真实 GUI、真实模型调用或宿主重启验收。** 不能将 VM 和夹具结果视为这些环境已验证，也不能承诺所有 bug 已清零。没有改动已安装插件副本、发布 npm 包或自动重启正在使用的 DSH。

## 仍未解决：同会话重生成的历史隔离

历史曾明确要求：重生成时不把旧回答及重复问题再作为上下文。此版仍是同会话原生重放，**没有完成这项要求**。显示层隐藏不改变模型历史。

对照官方 tag `dsh-v0.2.2-rc.5`、提交 `9c2670d3bce5275e0d1610272958121af87787bb` 后，拒绝上线以下看似可行的 workaround：

1. `Session.surface` 的确决定模型所见历史，但 `replace` 是持久事件，不是仅作用于单次请求的遮罩。从较早问题到尾部的 replacement 会永久遮住之后的正常人工上下文，重启仍有效。
2. 在 `agent/pre-step` 追加空 `developer/message` 还有格式问题：该时机尚未打开 step，V4 恢复校验要求 developer 事件匹配 open step。内存接受不代表持久日志可恢复。
3. 换到已开 step 的时机仍不解决永久遮蔽、失败恢复、compaction 和多步工具历史的问题；不能靠重新追加旧 assistant/tool 消息伪造完整恢复。

要安全满足它，需要宿主提供请求范围、跨工具续步有效、不会改写 durable surface 的历史选择机制。当前显式新建回答卡片仍可用子会话得到前缀历史，但它不等同于用户要求的同会话方案，因此未自动替换正常重生成。

## 其他边界

- 模型选择退役为 `lastUsed`，不会自动切回旧模型；中英文说明已纠正旧说法。
- 宿主公开 workspace diff 会规范化 EOF。没有精确快照或明确 no-newline 证据时，不能证明非空创建/删除文件的完整字节，返回 `missing-exact-snapshot`。无锚点零行 hunk 也可跳过。其他安全文件可能已回退，UI 会停止后续生成并提示检查。
- 回退不是事务。进程强杀、断电、存储失败及并发改路径不能得到完整原子性保证；实现不承担抵御恶意本地进程的安全边界。
- 状态存储是单进程设计；多个 DSH 进程不能并发写同一 `state.json`。后续可设计跨进程锁与合并策略，但本轮未虚称支持。
- schema 仍为 1，新字段向后兼容；旧分组可迁移 replay 身份。旧版本若已丢掉 singleton 身份，不能安全地通过相同问题文字猜回。
- 短预约处理普通并发；第三方同步 inbox hook 或宿主写 `turn/start` 失败等极端生命周期未经过实机验证。已核对版本的正常 maintenance 收尾会同步唤醒 driver，并在首个 await 前写入 `turn/start`。
- GitHub 推送更新仓库，不自动覆盖正在运行的 profile。需在方便时执行 `npm run sync -- desktop` 并自行重启 DSH；状态文件不在同步覆盖范围内。

## 官方资料依据

Context7 检索官方文档，并用本机版本对应的官方源码固定 tag 交叉核对。公开搜索未提供可直接使用的固定 tag 结果，因此没有拿搜索摘要代替源码证据。

- [Session surface 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/session/src/surface.ts)
- [原生 agent 循环与事件时机](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/agent-loop/src/agent.ts)
- [模型选择投影](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/core/agent/src/model-selection.ts)
- [V4 developer 关系约束](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-format-v3-to-v4/src/relationships.ts)
- [developer 恢复拒绝用例](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-format-v3-to-v4/tests/developer-relationships.spec.ts)
