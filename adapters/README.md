# adapters/ —— 怎么移植到别的宿主

参考实现是 **DSH 插件**，但**规范是可移植的**（见 [`SPEC.md`](../SPEC.md)）。
这里说明在别的宿主上落地需要什么。

## 只需要三类接缝

| # | 接缝 | 用途 | **缺了会怎样** |
|---|---|---|---|
| 1 | **注册工具** | 让 AI 能调用 `plan_*` | 完全不可用 |
| 2 | **工具执行后追加上下文** | 注入回合锚、回锚、漂移提醒 | ⚠️ **退化成"只是个记事本"** —— 能记，但没人看 |
| 3 | **能看见用户发言 / 回合边界** | 回合锚、回锚、完成闸门的"用户是否发过言" | I8 与 I12 失效 |

**第 2 条最关键，也最容易被忽略。** 如果目标宿主没有它，请**如实告诉使用者**这个退化 ——
一个"能记但没人看"的计划锚，等于没有。

## 各家的接缝点（调研所得，未逐家实测）

> ⚠️ 下表来自公开文档与第三方整理，**我们没有在每个宿主上实测过**。落地前请自行核对该宿主的当前版本。

| 宿主 | 接缝 1（工具） | 接缝 2（追加上下文） | 接缝 3（用户/回合） |
|---|---|---|---|
| **DSH**（参考实现） | cordis 插件 + `defineTool` | `tools/post-execute` 返回 `additionalContexts` | `agent/pre-step`（能拿到 messages） |
| **MCP 通用** | MCP server | ❌ **MCP 本身不提供** —— 需要宿主自己的钩子补 | 视宿主 |
| **Claude Code** | MCP | `PostToolUse` 钩子（可附加上下文） | `SessionStart`（`matcher: compact` 可只响应压缩）、`UserPromptSubmit` |
| **Codex** | MCP | `PostToolUse`（支持 `additionalContext`） | `UserPromptSubmit`；另有 `PreCompact` / `PostCompact` 可做压缩后补锚 |

**Codex 的官方提醒值得原样引用**：它的 `PreToolUse` 只能拦 Bash、`apply_patch` 与 MCP 工具调用，
且 *"Codex may still accomplish equivalent work via another tool path, so do not treat hooks as a
complete enforcement boundary."* —— **别把钩子当成完整的强制边界。**

## 一个通用建议

不管落到哪个宿主，**先把"回合锚"那一层做出来**（接缝 2），再做工具。
因为工具是"能记"，锚是"会被看见" —— **而漂移的定义就是"不再有人去看它"**。
