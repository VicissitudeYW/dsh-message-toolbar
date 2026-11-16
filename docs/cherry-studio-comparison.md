# Cherry Studio 对照笔记

这份笔记是 1.7.0 的来由：把 Cherry Studio 的消息区源码读了一遍，逐项对照，挑出能搬过来、
搬过来值得的几处，其余记下「为什么不搬」。

源码位置以 `CherryHQ/cherry-studio` 的 `src/renderer/components/chat/messages/` 为准
（浅克隆 `--depth 1 --filter=blob:none --sparse` 只取 `src/renderer`，约 30 秒）。

## 它那边是怎么组织的

| 文件 | 作用 |
| --- | --- |
| `frame/messageMenuBarActions.tsx` | 动作注册表。`registerToolbarAction` / `registerAction`，每项带 `id`、`label`、`icon`、`group`/`order`、`surface: 'menu'`、`confirm`，以及 `availability(context)` 返回 `{ visible, enabled, reason }` |
| `frame/MessageMenuBarToolbarRenderers.tsx` | 工具栏渲染器：确认弹窗、翻译子菜单、模型选择器、「更多」菜单 |
| `list/SiblingNavigator.tsx` | 用户消息旁的 `‹ i/N ▾ ›` 分支切换器 |
| `list/MessageGroup*.tsx` | 多模型同问的分组：布局切换、模型 chips、整组重试/删除 |
| `blocks/MessageTranslate.tsx`、`TranslationBlock.tsx` | 译文块：分隔线 + 语言图标 + 垃圾桶，正文以 markdown 流式打字 |
| `utils/messageDeleteAvailability.ts` | 删除可用的两种否定理由：`not-loaded`、`generating` |

要点是**动作是一个注册表**，每项自己声明「什么时候出现、什么时候能按、按了要不要确认」，
渲染层只负责摆位置。我们这边是写死的几个按钮，够用但扩展性差；这一层没有照搬，因为插件的
动作集合是固定的，多一层注册表只是多一层间接。

## 工具栏按钮对照

| Cherry | 我们 | 结论 |
| --- | --- | --- |
| copy（含「复制纯文本 / 复制图片」） | 原生复制 + 1.7.0 起「复制这条回答」 | **采纳**：见下 |
| read-aloud（朗读） | —— | 不搬：DSH 没有 TTS 通道，只能自己接一个云端接口，和插件的定位不符 |
| regenerate | 重新生成（就地） | 一致 |
| mention-model（换个模型重答） | 切换模型 | 一致 |
| translate（翻译中变成暂停键，可中断） | 翻译（翻译中图标转圈，不可中断） | 半采纳：进度有，中断没做——`ctx.llm.stream` 要贯穿一个 `AbortSignal` 到宿主，改动面比这一轮该做的事大 |
| useful（把某条回答标为「用于上下文」） | —— | 不搬：DSH 的上下文由日志决定，标了也不会改变模型看到什么，标了就是骗人 |
| notes / knowledge / export | —— | 不搬：属于笔记与导出体系，和消息工具栏是两件事 |
| delete（`generating` 时禁用并给理由） | 删除（生成中禁用） | **采纳理由文案** |
| more-menu（edit/分支/多选/导出） | 编辑、分支在行内 | 一致，位置不同 |

## 1.7.0 实际改的四处

### 1. `2/3` 不只是数字，点开是答案列表

Cherry 的 `SiblingNavigator` 是 `‹ 2/3 ▾ ›`：箭头走相邻，**中间的数字是下拉**，
列表里每条是「序号 + 预览 + 当前项打勾」，点哪条跳哪条。两个箭头只能一步步挪，
问题问到第四遍时就很难用了；而一个光秃秃的 `2/3` 也从不告诉读者哪条是哪个模型写的。

所以我们把行里那个计数改成按钮（`RingMenuHost` + `ringChoices`）：

- 答案以轮次形式存在时（`runs`），行是 `/1. 模型原始回答/`、`/2. deepseek-flash/`……
  模型来自建组时记下的 `runs[key].models[turn]`，不是猜的；组里第一条按「模型原始回答」命名，
  和备选环的第 1 格同一个说法。
- 答案以插件状态存在时（`answers`），行是 `native` + 每个备选，备选按 provider/model 命名。
- 打勾用原生 `Menu` 的 `selection: 'check'`；`align: 'end'`、`side` 跟着翻转逻辑走，
  选中直接发 `run-select` / `answer-select`，不经过「走一步」。

### 2. 译文可以单独复制

Cherry 的翻译菜单在语言列表下面隔一条线，放「📋 复制译文」「✖ 移除译文」。我们原来只有
「隐藏译文」。逐段对照把原文和译文并排画出来之后，想只要译文的人反而得用鼠标去挑——
所以菜单里加了 `COPY_TRANSLATION_ROW`，写的是 `translationOf(state, turn).text`（译文本身），
不是屏幕上的对照文本。

### 3. 垃圾桶禁用时说清楚为什么

Cherry 的 `getMessageDeleteUnavailableText` 把 `generating` 翻成一句人话。我们原来在生成中
也禁用，但 tooltip 还是「删除这条回答」——对着一个按不动的按钮说「删」，等于没说。
现在生成中标题是「等这轮回答写完再删除」。

### 4. 复制要复制屏幕上那条

这是对照时发现的一个真 bug，不是 Cherry 有而我们没有：DSH 原生的复制按钮读的是**日志里的**
回答。一旦屏幕上是换来的备选、编辑过的版本或译文，行上唯一的复制按钮复制的是读者看不见的
那段文字。现在这种行会多一个自己的复制按钮（`data-mtt="copy-answer"`），写的就是屏幕上的文字；
答案以轮次形式存在时不需要——那时屏幕上的回答本身就是一条日志回答，原生复制本来就对。

## 看过但没有搬的

- **分组布局切换（fold / vertical / horizontal / grid）**。Cherry 能把同一个问题的多个模型
  回答并排或网格铺开。我们这边「一条显示、其余隐藏」是因为 DSH 的日志只认一条回答，
  并排需要把每条回答的 markdown 都塞进同一个插槽里自己排版，视觉收益不如风险大；
  真要对比，现在的答案是「开两个会话」或者版本树。
- **动作注册表**。Cherry 需要它是因为动作由设置、插件、命令面板共同决定；我们的动作集合是
  固定的十一二个，注册表只会让调用链更长。
- **多选批量删除**。Cherry 有 multi-select 模式。我们的删除是「整轮隐藏」的视图标记，
  批量删除要一次写多条标记，收益有限。
- **朗读、笔记、知识库、导出**。都属于消息之外的体系。

## 结论

值得搬的是**交互形状**，不是功能清单：数字点开是列表、破坏性动作说清楚为什么按不动、
复制跟着屏幕上看到的东西走。这三条与 DSH 的日志不变性无关，改起来风险小、收益直接。
