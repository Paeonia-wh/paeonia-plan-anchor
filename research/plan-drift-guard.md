# 计划漂移（Plan Drift）现成机制调研报告

> **调研问题**：AI 编码 agent（或人 + agent 协作）执行已定好的计划时，注意力被中途发现的新问题劫持 → 原计划丢失 → 上下文混乱。GitHub 与公开资料上有哪些现成办法、机制、工具、skill、hook、论文？
>
> **核查日期**：2026-09-18（所有 star 数 / pushed_at / 字段名均于该日实际调 API 或读原文核对；核不到的明确写「未核实」，未编造任何数字）
>
> **网络通道说明**：本机 CDP 浏览器自动化不可用（`check-deps.mjs` 退出码 1，需人工点浏览器授权弹窗）。有效通道为 `api.github.com`（未认证 60/h，实测调查中期耗尽）、`raw.githubusercontent.com`（不限流）、`ungh.cc` 镜像、`export.arxiv.org/api`、以及官方文档站 `code.claude.com`。`github.com` HTML 与 `r.jina.ai` 均超时不可用。

---

## 0. 一句话结论

**「有个清单」不够，是因为清单是 agent 自述状态、是被动的、没有位置指针、且要么禁止一切偏离要么放任一切偏离。业界真正有效的机制只有四类：①把权威锚定在「用户批准时冻结的产物」而非 agent 自述；②用一个独立的、不可伪造的信号（工具调用日志 / 另一个模型）来判完成；③给偏离一个**有名字的落点**（泊位/inbox），让它不是二元的「追 or 丢」；④用**预算与闸门**而不是**禁令**来限制偏离。**

---

## 1. 为什么「已经有 Beads 式任务清单」还会漂移

这一节不引外部资料，而是**用一手项目原文回答**。最直接的一手证据来自 `Kac291/planlock` 的 `ARCHITECTURE.md`（它专门论证「Claude Code 已经有 todo 工具，为什么还需要我」）与 `lennney/stop-that-shit` 的架构文档。逐字引用：

### 1.1 清单的三处结构性缺陷（planlock ARCHITECTURE.md 逐字论点）

planlock 对「为什么内置 `TaskCreate` 清单治不了漂移」给了三条，逐字：

1. **作者权（authorship）**：「`TaskCreate` lists are **authored by Claude at execution time**, not by the user at plan-approval time. Nothing ties a task entry back to the approved plan.」——Claude 可以「Skip tasks it decides are unnecessary」「Invent tasks that were never in the plan」「Rephrase plan steps into tasks that look different enough to lose their identity」。
   结论逐字：「The approved plan file is the only artifact that is **frozen at the moment of user consent**.」
2. **数据形状（data shape）**：「A `TaskCreate` entry carries a subject + status. It has **no scope field**: no file globs, no command list, no operation whitelist.」——因此「即使一个完美的 `TaskCreate` 订阅者也回答不了『`Edit(src/billing/invoice.ts)` 这次调用在计划内还是计划外？』」
3. **真值来源（ground truth）**：「`TaskCreate` status transitions are **self-reported by Claude**. A task marked `completed` does not mean the promised work actually shipped.」

planlock 的点题一句逐字：「`TaskCreate` is Claude's journal. **planlock is the surveillance camera.** A journal can be edited. A camera cannot.」

> 一手来源：<https://raw.githubusercontent.com/Kac291/planlock/main/ARCHITECTURE.md>（2026-09-18 读取）

### 1.2 移植到本机现状的推论

本机的 Beads 式任务库（`dsh-task-tracker`：`task_create`/`task_list`/`task_ready`/`task_dep_add`…）在**结构上**完全对应上面第 2、3 条：任务的字段是 `title/detail/status/priority/parent_id`，**没有 scope 字段**（没有 file glob / command / operation 白名单），也没有「这次工具调用属于哪一步」的绑定；状态由 agent 自己 `task_update` 写入。所以它不是「不够努力」，而是**数据模型上就无法承担漂移检测**——漂移恰恰发生在「没人去查它」的时候，而清单只在被查时输出。

`dsh-plan-anchor`（本机新插件）README 里的五条归纳与 planlock 的三条是同构的，且第 1 条「**它是被动的**——只有主动查才输出。而漂移的定义恰恰就是『没人去查它』」是这里面最锋利的一句。

---

## 2. GitHub 上专门做这件事的现成项目（star 数与推送时间均已核实）

核查方式：`GET https://api.github.com/repos/{owner}/{repo}`，核查日期 **2026-09-18**。

| 项目 | star | 最后推送（pushed_at, UTC） | 核心机制（逐字） |
|---|---|---|---|
| [`lennney/stop-that-shit`](https://github.com/lennney/stop-that-shit) | **2078** | **2026-09-16T09:38:50Z** | 控制态 `OFF / OBSERVING / ARMED`；任务模式 `review / answer / monitor / change`；`Stop Ladder` 五梯；`files=` 文件锁；`agents=N` 并发预算；`hash=allow` |
| [`Kac291/planlock`](https://github.com/Kac291/planlock) | 0 | 2026-04-18T09:54:04Z | 漂移判决枚举 `match / skip-ahead / out-of-scope / extra / partial`；模式 `observe / warn / strict`；步对象 `Step.scope = { files, commands, operations }` |
| [`atoolz/scope-guard`](https://github.com/atoolz/scope-guard) | 3 | 2026-02-05T09:27:54Z | `UserPromptSubmit` 捕获原始 prompt + `PostToolUse` 记录改动 + `Stop` 用 `type:"agent"` 模型裁决 |
| [`dormstern/forge`](https://github.com/dormstern/forge) | 6 | 2026-05-12T09:00:13Z | `drift-detector` agent 每 5 个 feature 审计；判决梯 `CLEAR / DRIFT / CONTRACT_VIOLATION / ARCHITECTURE_DEGRADATION / REWORK_PATTERN`；建议 `CONTINUE / DISCUSS / PIVOT / CONTRACT_HALT / STABILIZE` |
| [`silouone/clens`](https://github.com/silouone/clens) | 6 | 2026-07-26T17:15:39Z | 会话回溯分析、`backtrack-detection`、**measure plan drift**（本地优先可观测性） |
| [`Flagrare/agent-skills`](https://github.com/Flagrare/agent-skills) | 11 | 2026-09-14 | ticket intake、ATDD planning、doc-drift audits |
| [`mariano-aguero/spec-driven-development-skill`](https://github.com/mariano-aguero/spec-driven-development-skill) | 8 | 2026-08-06 | constitution → specify → plan → tasks → implement → validate，含 drift detection、MoSCoW |
| [`shauryagangrade/intent-drift-skill`](https://github.com/shauryagangrade/intent-drift-skill) | 7 | 2026-09-11 | Intent Alignment Engine，9 个 evidence provider，导出 text/markdown/json 报告 |
| [`shutx-net/agent-plan-adherence-bench`](https://github.com/shutx-net/agent-plan-adherence-bench) | 0 | 2026-09-02 | 度量 coding agent 跨 Markdown 计划跟随可靠性的 **benchmark** |
| [`sruja-ai/sruja`](https://github.com/sruja-ai/sruja) | 24 | 2026-09-14 | 独立确定性 grader（`drift / lint / verify-task / intent`）在 ship 前验证，闭环 comprehend → plan → execute → critique → replan |
| [`Jed-Tech/spar-kit`](https://github.com/Jed-Tech/spar-kit) | 17 | 2026-05-07 | Specify → Plan → Act → Retain |
| [`srnichols/plan-forge`](https://github.com/srnichols/plan-forge) | 5 | 2026-09-08 | drift-proof execution contracts，lifecycle hooks |
| [`ijust/intent-planner`](https://github.com/ijust/intent-planner) | 5 | 2026-09-10 | 捕获 intent/invariants，观察 intent drift（**warn-only**） |
| [`muellah24/document-hygiene`](https://github.com/muellah24/document-hygiene) | 0 | 2026-09-16 | 防长寿命文档（plans/specs/READMEs）漂移的 skill + hooks |

> 说明：`Kac291/planlock` 自我标注为 **v0.1 alpha**（README 逐字：`**Status:** v0.1 alpha — passive capture working. v0.2 (matching + drift report) in progress.`），因此它的**设计文档比实现更可信**。README 中引用的 `anthropics/claude-code#32253` 我**未能核实**（该编号在 GitHub 搜索中未命中；按规则不采信，见 §8）。

### 2.1 最值得看的两份一手设计文档

- **planlock 的 ARCHITECTURE.md** 给了完整的**可照抄规格**：解析 → `Step` 结构 → 打分 → 判决 → 行动 → 报告。见 §4.2。
- **stop-that-shit 的 ARCHITECTURE.md / SKILL.md** 给了**控制态机与语义判据**。见 §3。

---

## 3. 【重点】「新发现的问题先进独立队列」的现成设计

这一节直接回答任务优先级 ①。**结论：确实存在这类设计，但它们不叫 inbox，而分别叫 泊位（parking/deferred）、`files=` 边界、`blocking` 判据、以及 Stop Ladder。** 也有一个真正的 inbox 式设计出现在 `plan-anchor` 本机版本里（见 §7 表末）。

### 3.1 `stop-that-shit`（2078★）——最完整、最可直接借鉴

它的核心是**把「能不能拦」与「该不该做」彻底分层**，这是整份调研里最有价值的一条工程判断。逐字（ARCHITECTURE.md）：

> 「These semantic decisions belong in `skills/stop-that-shit/SKILL.md`. The Guard checks explicit authority on supported action paths; **it does not infer business necessity from mechanism names.**」

> 「Hard decisions are limited to **observable facts**:
> - writes in a confirmed non-mutating mode;
> - writes outside an optional explicit `files=` list;
> - covered dependency additions without authority;
> - subagent launches beyond the active `agents=N` limit;
> - high-confidence hashing without `hash=allow`.」

**逐字控制态（三态）**：

```
OFF        no checks and no normal-action events
OBSERVING  check and record; never return permission deny
ARMED      explicit task contract; may return permission deny
```

响应域逐字：`response: none | context_returned | permission_deny_returned | execution_denial_returned`，而 `host effect: unobserved`（诚实标注：deny 不等于宿主真的没执行）。

**逐字任务模式**（`SKILL.md`「Respect the task mode」）：
- `review` / `answer` / `monitor` — 「are read-only unless the user authorizes a change」
- `change` — 「permits only requested work and necessary consequences」

**逐字文件锁**：`$stop-that-shit lock change files=src/config.cjs|test/config.test.cjs -- Fix this behavior.`
并附一条防自欺规则逐字：「**Do not invent a file list to appear precise.**」

**「新问题怎么办」的判据——Stop Ladder（逐字五梯）**：
1. Understand the current responsibility.
2. Start with a direct solution.
3. **Expand to close a concrete gap.**（「A larger diff is justified when it completes the affected flow.」）
4. Judge defenses by their effect.
5. Verify the result and finish.（「Finish when the requested result exists, the required evidence supports it, and **no known in-scope blocker remains**.」）

**关于「什么时候可以停下来」的逐字规则**——这是最接近「什么时候才允许去处理新问题」的现成判据：

> 「Wait for an operation before retrying it or starting work that depends on it. **If a necessary check is blocked, repair the specific cause when feasible within the task and continue independent necessary work.**」

**一条明确的反过拟合警告（诚实边界）**逐字：

> 「This Skill is **advisory** and works without the Guard hooks. **It cannot guarantee model behavior.**」

> 一手来源：<https://raw.githubusercontent.com/lennney/stop-that-shit/main/ARCHITECTURE.md>、<https://raw.githubusercontent.com/lennney/stop-that-shit/main/skills/stop-that-shit/SKILL.md>（2026-09-18 读取）

### 3.2 「独立队列」在这批项目里的实际形态

| 概念 | 项目 | 逐字名称 / 字段 |
|---|---|---|
| 独立捕获队列 | `plan-anchor`（本机 `<工作区>\dsh-plan-anchor`） | 泊位（parking lot）、`plan_discover`、`plan_park`、条目状态 `parked`、`blocking=false` 默认 |
| 范围白名单（不是队列，但等效：先划边界再决定） | `stop-that-shit` | `files=` 列表、`agents=N`、`hash=allow` |
| 队列的**替代方案**：显式中断态 | `planlock` | 判决 `skip-ahead`（跳步）/ `out-of-scope`（越界）/ `extra`（发明） |
| 定期审计而非实时队列 | `dormstern/forge` | `drift-detector` agent，每 5 个 feature，判决 `DRIFT` / `CONTRACT_VIOLATION` |
| 「捕获意图，晚点判断」 | `ijust/intent-planner` | 「observe intent drift (**warn-only**)」 |

**关于「什么时候才允许处理」的判据**：在这批项目里，**只有两处给出了可执行的二元判据**：

1. `stop-that-shit`：**「不在授权范围内的一切写入，一律 deny」**——即判据是「有没有明确授权」，而不是「重不重要」。这是**权限判据**。
2. `plan-anchor`（本机）：**「新问题阻塞当前步 → `blocking=true` 走正式中断；否则一律入泊」**——即判据是「**不解决它，当前这一步还能不能往下走**」。这是**依赖判据**。

> ⚠️ **诚实标注**：我**没有**在 GitHub 上找到一个专门叫 "backburner" / "parking lot" / "GTD inbox for agents" 且有一定 star 数的独立项目（§6 的搜索词 `claude code skill parking lot backburner` 返回 total=0）。这个机制目前主要以**单个项目内部的一个功能**存在，而不是一个独立品类。**未核实**存在更大的同类项目。

---

## 4. 主流 agent 编码工具的官方机制

> 本节事实由子调研经 `code.claude.com` 官方文档与 `raw.githubusercontent.com` 源码核实；**每条附一手链接**；核不到的明确标注。

### 4.1 Claude Code

**（a）待办清单工具：`TodoWrite` 已默认关闭**（重要，且容易被过时资料误导）

官方 tools reference 逐字：
- `TaskCreate`："Creates a new task in the task list."
- `TaskGet` / `TaskList` / `TaskUpdate`：对应检索与更新。
- `TodoWrite`："Manages the session task checklist. **Disabled by default** in favor of `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`. Set `CLAUDE_CODE_ENABLE_TASKS=0` to re-enable it…"

官方给的理由逐字："On newer models, Claude keeps track of multi-step work **without a written checklist**, and the tools' definitions and reminders take up context."
默认可用模型白名单逐字："Claude 3.x models, Opus 4 through 4.7, Sonnet 4 through 4.6, and Haiku 4.5"。其他模型需 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 或 `--allowedTools`。清单落盘 `~/.claude/tasks/`，跨会话共享需 `CLAUDE_CODE_TASK_LIST_ID`。
**是否有强制力：没有。** 文档把它描述为 "Claude's to-do checklist: items **Claude created** to plan multi-step work"，纯自述状态。
一手：<https://code.claude.com/docs/en/tools-reference>

**（b）Hooks：逐字事件名与字段名**（官方 hooks 文档，2026-09-18 直接抓取页面并逐个字符串校验存在）

- 与「计划一致性」直接相关的事件：`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`PreCompact`、`Notification`。逐字事件名清单共 31 个（官方 `plugin-dev/skills/hook-development/SKILL.md` 正文点名的集合为：`PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification`）。
- **`Stop` hook 的输入字段（逐字，官方文档）**：`stop_hook_active`、`last_assistant_message`、`background_tasks`、`session_crons`。
- **`SubagentStop` 输入字段（逐字）**：`stop_hook_active`、`agent_id`、`agent_type`、`agent_transcript_path`、`last_assistant_message`。
- **公共输入字段（逐字，官方插件开发 skill 原文）**：`session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name`。事件专属：`PreToolUse`/`PostToolUse` → `tool_name`、`tool_input`、`tool_result`；`UserPromptSubmit` → `user_prompt`；`Stop`/`SubagentStop` → `reason`。
- **输出字段（逐字）**：`PreToolUse` → `hookSpecificOutput.permissionDecision`（`allow|deny|ask`）+ `hookSpecificOutput.updatedInput` + `systemMessage`；`Stop`/`SubagentStop` 决策 → `decision`（`approve|block`）+ `reason` + `systemMessage`；通用 → `continue`、`suppressOutput`、`systemMessage`。
- **退出码语义**：`0` 成功；`2` 阻断性错误（stderr 回喂给 Claude）；其他非阻断错误。

**（c）防死循环字段 `stop_hook_active`（本调研最关键的一条工程事实）**

官方文档逐字：「Stop hooks receive `stop_hook_active`, `last_assistant_message`, `background_tasks`, and `session_crons`. The `stop_hook_active` field is `true` when Claude Code is already continuing as a result of a stop hook. **Check this value or process the transcript to avoid blocking on a condition that will never resolve.** **Claude Code overrides the hook and ends the turn after 8 consecutive blocks.**」

`additionalContext` 逐字：「It keeps the conversation going through the same loop protections as `decision: "block"`, namely the `stop_hook_active` input and the **8-consecutive-continuation cap**, but the transcript labels it `Stop hook feedback` and no hook error notification is shown.」

→ **厂商为一个失效模式专门设计了防护 API，等于承认这个失效模式真的会发生。** 这是「强制机制必须自带终止条件」的一手依据。
一手：<https://code.claude.com/docs/en/hooks>

**（d）`/goal` —— 目前最强的内建「计划一致性」强制点（强烈建议细看）**

逐字定义："`/goal` is a wrapper around a session-scoped **prompt-based Stop hook**."
- 用法 `/goal <完成条件>`；每轮结束后由**另一个小快模型**（默认 Haiku）判断条件。
- 三个逐字判决：**"Not yet met"** / **"Met"** / **"Impossible"**。`Not yet met` → "Claude keeps working and takes the reason as guidance for the next turn."；`Impossible` → 清除 goal 并记一条失败记录。
- **防漂移的核心设计，逐字**："`/goal` adds a **separate evaluator** that checks your condition after every turn, so **completion is decided by a fresh model rather than the one doing the work**."
- 官方建议条件里要写「路上不能变的东西」，逐字例子："**no other test file is modified**"。条件最长 4,000 字符。
- 停滞保护逐字："If Claude keeps answering the evaluator **without making progress (no tool use for several turns in a row)**, Claude Code **stops the loop**, prints a warning, and returns control to you with the goal still set."
- 卡后台任务时有 check-in（默认 30 分钟，指数退避到 4 倍；`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`；交互式会话最多 3 次）。

一手：<https://code.claude.com/docs/en/goal>

**（e）Plan mode 的强制力不是绝对的（重要反例）**

逐字："In interactive terminal sessions with bypass permissions available, Claude Code **also doesn't enforce plan mode's blocks**. Claude is still **instructed** to plan without editing, but a file edit or shell command it attempts during planning **runs without prompting**."
而「Plan mode keeps its blocks wherever Claude Code runs **without an interactive terminal**, including non-interactive runs with `-p`, Agent SDK sessions, and conversations in the VS Code extension's chat panel.」
另一条同类边界逐字：「…boundary can be lost if **context compaction** removes the message that stated it. **For a hard guarantee, add a deny rule instead.**」
一手：<https://code.claude.com/docs/en/permission-modes>

**（f）官方插件仓库里现成的三件套**（`anthropics/claude-code` 的 `plugins/`，2026-09-18 核实文件树）
- `plugins/hookify` —— 从对话里自动生成 hook 规则，规则是 `.claude/hookify.<name>.local.md`，YAML frontmatter 字段逐字：`name`、`enabled`、`event`、`pattern`、`action`（值含 `block`），支持单模式与多模式。命令 `/hookify`、`/hookify:list`、`/hookify:configure`、`/hookify:help`。
- `plugins/feature-dev` —— 官方 **7 阶段** 工作流（Discovery → Codebase Exploration → Clarifying Questions → Architecture Design → …），Phase 3 逐字要求 "**Waits for your answers before proceeding**"。
- `plugins/plugin-dev/skills/hook-development/SKILL.md` —— hook 开发的完整字段参考（上面 (b) 的逐字字段多来自此文件）。

**（g）一个尚未满足的官方能力**：`anthropics/claude-code` issue **#14259**「`[FEATURE] PrePlanMode and PostPlanMode Hook Events`」**当前仍为 open**（created 2026-01-20，16 条评论）。→ 官方**没有**「进入/离开计划模式」的 hook 事件，所以想「在离开计划模式时冻结计划」必须绕过（planlock 用的办法是 `PreToolUse` matcher `ExitPlanMode`，见 §4.2）。
一手：<https://github.com/anthropics/claude-code/issues/14259>

### 4.2 planlock 的可照抄规格（把它当规格书，而不是当可用软件）

它把「离开计划模式」当作捕获时机，逐字（ARCHITECTURE.md）：
- 捕获点优先级：**`PreToolUse` on `ExitPlanMode`** → 从 settings 解析 `plansDirectory` → 读最新 `.md`；备选是文件系统 watcher；最后是用户手动 `/planlock lock <plan-path>`。
- 步对象逐字：
  ```
  Step {
    id: "s3",
    summary: "Extract auth middleware to src/auth/",
    scope: { files: ["src/auth/**", "src/middleware/auth*"], commands: [], operations: ["Edit", "Write"] },
    dependencies: ["s1", "s2"],
  }
  ```
- **打分公式逐字**：
  ```
  path_match_score    = 0..1   (glob overlap with step.scope.files)
  op_match_score      = 0..1   (tool name in step.scope.operations)
  semantic_score      = 0..1   (Haiku: "does this call advance this step?", cached)
  sequence_penalty    = 0..1   (how many earlier steps are still open)
  total = 0.4*path + 0.2*op + 0.3*semantic + 0.1*(1 - sequence_penalty)
  ```
- **判决规则逐字**：`total ≥ 0.7` → `match`；`0.4 ≤ total < 0.7` **且** path 匹配 → `partial`（记录但接受）；`total < 0.4` → 再分：path 在任何步的 scope 之外 → `out-of-scope`；检测到跳步 → `skip-ahead`；完全没有对应步 → `extra`。
- **三档模式逐字**，且源码里能读到精确的判决集合（`src/match/policy.ts`）：
  - `observe`（默认）：surface 集合 = `{out-of-scope, skip-ahead, extra}`，**从不 block**
  - `warn`：surface 集合 = `{out-of-scope, skip-ahead, extra, partial}`，注入 `<planlock-notice>` 到下一轮
  - `strict`：**唯一允许 block 的判决是 `out-of-scope`**（`STRICT_BLOCK = new Set(["out-of-scope"])`），返回 exit 2
- 报告：`Stop` hook → `.planlock/report.md`，含完成步/跳过步/越界事件/计划外工作/**Drift score (0-100)**；状态落盘 `.planlock/sessions/<id>/events.jsonl`、`state.json`、`report.md`，带 Haiku 语义打分缓存 `cache/haiku-semantic.json`。

> 一手来源：<https://raw.githubusercontent.com/Kac291/planlock/main/ARCHITECTURE.md>、<https://raw.githubusercontent.com/Kac291/planlock/main/src/match/policy.ts>（2026-09-18 读取）

**可直接照抄的三个设计决策**：
1. **只有一类偏离允许被硬拦**（`out-of-scope`），其余最多是提醒。→ 避免「什么都被拦」导致的死锁。
2. **`sequence_penalty` 只占权重 0.1**，且 `partial` 被显式接受。→ 承认执行顺序天然会乱。
3. **三档模式 + 默认 observe**。→ 先观察记录、拿到真实误报率，再考虑开 warn/strict。

### 4.3 OpenAI Codex CLI（源码核实）

- **待办清单工具逐字名 `update_plan`**。配置键路径逐字 `[tools.update_plan] enabled`，其 schema 逐字 `{ "default": false }` → **默认关闭**。handler 只做三件事：校验不在 Plan 模式、解析参数、`send_event(EventMsg::PlanUpdate(args))`。**除「不在 Plan 模式」这一条外，没有任何计划一致性校验**（不检查漏项、不检查与新发现冲突）。
- **Plan 模式与清单硬隔离（逐字错误信息）**，`codex-rs/core/src/tools/handlers/plan.rs`：
  ```rust
  if turn.mode() == ModeKind::Plan {
      return Err(FunctionCallError::RespondToModel(
          "update_plan is a TODO/checklist tool and is not allowed in Plan mode".to_string(),
      ));
  }
  ```
- **Plan 模式的逐字约束**（`collaboration-mode-templates/templates/plan.md`）：
  - "You are in **Plan Mode** until a developer message explicitly ends it. **Plan Mode is not changed by user intent, tone, or imperative language.**"
  - "You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions."
  - 判据逐字："When in doubt: if the action would reasonably be described as **"doing the work"** rather than **"planning the work,"** do not do it."
  - 新发现必回提问逐字："Bias toward questions over guessing: if any high-impact ambiguity remains, **do NOT plan yet—ask**."
  - 计划必须包在 `<proposed_plan>` 标签内，"Only produce **at most one** block per turn"，修改时 "any new `<proposed_plan>` must be a **complete replacement**"。
- **追问/打断工具逐字名 `request_user_input`**，参数 `questions`（每项 `id`/`header`/`question`/`options`），逐字约束 "Prefer 1 and **do not exceed 3**"、"Provide **2-3 mutually exclusive choices**"。
- **approval 配置逐字（重要更正）**：任务书里假设的 `suggest` / `auto-edit` / `full-auto` **在当前 main 分支源码中找不到**。现行是 `approval_policy`（`"on-request"` / `"never"` / `{"granular": …}`）× `sandbox_mode`（`"read-only"` / `"workspace-write"` / `"danger-full-access"`）两个正交配置。（旧称是否存在于历史版本：**未核实**。）
- **Hooks 逐字事件名（12 个，PascalCase TOML 键）**：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`Interrupt`。其中 **`Interrupt` 是 Codex 独有、Claude Code 没有的**（用户打断时触发）。handler 类型标签逐字：`"command"`、`"mcp_tool"`、`"prompt"`、`"agent"`。
- `AGENTS.md` 常量逐字：`DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md"`、`LOCAL_AGENTS_MD_FILENAME = "AGENTS.override.md"`。
> **未核实**：Codex 各 hook 事件**具体能返回什么决策**（能否 block、字段名）——`codex-rs/core/src/hook_runtime.rs` 未逐行核实，不做断言。
> 一手：<https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/plan.rs>、<https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/hook_config.rs>

### 4.4 Cursor / Cline / Roo Code / Aider / OpenHands / Gemini CLI / Kiro / Devin / Windsurf / Copilot / Amp

> 以下由子调研 A 覆盖（其分报告 `A-tool-docs.md`，2351 行 / 260 条一手链接）。**核心结论：清单类工具几乎全是 advisory；整个生态里唯一「不可绕过」的强制原语是 `PreToolUse` 的 `permissionDecision: "deny"`。**

**（a）一个真正不可绕过的边界（值得单独记住）**
`PreToolUse` 返回 `permissionDecision: "deny"` 时，官方逐字：它「blocks the tool **even in `bypassPermissions` mode or with `--dangerously-skip-permissions`**」。
→ 这是**用户也绕不过**的绝对线，与「interactive terminal 里 plan mode 不强制」形成鲜明对比（见 §4.1e）。**如果要做硬拦，这是唯一有官方硬保证的原语。**

**（b）Claude Code 的两个「计划闸门」事件（最硬的清单级强制）**
- `TaskCreated` hook 返回 exit 2 → 官方逐字：「Claude Code **deletes the task** and returns your message to Claude as the tool's error」
- `TaskCompleted` hook 返回 exit 2 → 官方逐字：「the task is **not** marked as completed and the stderr message is **fed back to the model**」
→ 这两条把「清单」从自述升级成了**机械闸门**：可以拒收任务、可以拒绝标记完成。**这是「有清单」之外最直接可用的增量。**

**（c）三处前提被一手证据推翻（引用时务必注意）**
| 常被引用的说法 | 一手核实结果 |
|---|---|
| Roo Code 的 **Focus Chain** | **当前 `main` 零命中**（文档目录、CHANGELOG、完整文件树全零）。官方已改称 **Task Todo List** / `update_todo_list`；真闸门在 `AttemptCompletionTool.ts` 的 `preventCompletionWithOpenTodos`，报错逐字 `"Cannot complete task while there are incomplete todos."`，但**默认 `false`** |
| OpenHands 的 **microagents** | **已不存在**。`openhands/microagent/` 返回 **HTTP 404**；`OpenHands/software-agent-sdk` 文件树中 `microagent` 匹配数为 **0**。替代品是 **Skills（`SKILL.md`）** |
| Codex 的 `suggest`/`auto-edit`/`full-auto` | **在 `main` 里找不到**（与 §4.3 一致），现为 `approval_policy` × `sandbox_mode` |

**（d）「连自建强制都缺原语」的工具（负面发现）**
- **Cursor 官方文档完全没有 todo 机制**。
- **Aider 连「计划」这个数据结构都不存在**。
- **Windsurf 的 12 个 hook 事件无任何 plan/todo 事件，且 post-hook 一律不能 block** → 想自建强制也缺原语。
- 清单类工具（`TodoWrite` / `update_plan` / `write_todos` / `task_tracker` / `update_todo`）**几乎全是 advisory**。

**（e）唯一有官方验证数字的「强制力代价」（重要一手证据）**
Anthropic 工程博客公开 **auto mode 分类器**实测：真实流量 FPR 从 8.5% 降到 0.4%，但真实 overeager 动作的 **FNR 是 17%**。官方原话逐字：
> 「**The 17% false-negative rate on real overeager actions is the honest number.**」

它承认的失败模式逐字：分类器「finds **approval-shaped evidence** and stops short of checking whether it's consent for the blast radius of the action」，并且「**We've tried prompt-engineering around this and haven't found a fix**」。
→ 这是「用模型判断来兜强制力」的**厂商自证上限**：约 **1/6 的真实越界动作会被漏掉**，且官方明确说提示词工程解决不了。**对任何想用 LLM 裁判做漂移闸门的方案，这是必须知道的定量边界。**
一手：<https://www.anthropic.com/engineering/claude-code-auto-mode>

**（f）「压缩后自动重载」—— 一个被低估的机制（7 类强制力之一）**
Claude Code 项目根的 `CLAUDE.md` 在 `/compact` 之后「re-reads it from disk and **re-injects** it」；并有 `SessionStart` + `matcher: "compact"` 这个钩子点。
→ 直接对应「上下文压缩把计划冲掉了」这个失效路径。**本机 `dsh-plan-anchor` 的计划落盘 SQLite 也是同一思路的对策（更彻底，因为不依赖 harness 的 re-inject）。**


---

## 5. 认知/心理学与方法学的机制名与出处

> 本节由子调研 C 核实（其报告 `C-mechanisms-sources.md`，801 行 / 71611 字节，含每项的逐字英文原句+中文翻译+证据等级+实际访问 URL，原始 PDF 在 `plan-drift-raw\dl\`）。**逐字引用 + 一手链接**；未核实项明确标注。
>
> ⚠️ **本节含 6 条对常见说法的硬纠正** —— 这些说法在中文技术圈广泛流传但**查无实据**，若照抄会毁掉报告可信度。见 §5.2。

### 5.1 逐字核实结果（含 6 条硬纠正）

**（a）Yak shaving —— 起源（已被硬纠正）**

发明者不是流传甚广的「Carl Kress」，而是 **`Carlin Vieri`**；首次成文是 **Jeremy H. Brown 于 2000-02-11 致 `all-ai@ai.mit.edu` 的邮件**。
**我本人复核**：MIT CSAIL 官方归档页中 `Carlin Vieri` **存在**，`Kress` **零命中**，`Steele` **零命中**。专项检索 `"Carl Kress" "yak shaving"` 与 `"yak shaving" "Guy Steele"` **均无任何结果** → 「Kress 发明」与「Guy Steele 传播」两说**查无此据**。
三个独立副本（逐字一致）：
- <https://projects.csail.mit.edu/gsb/old-archive/gsb-archive/gsb2000-02-11.html>
- <https://projects.csail.mit.edu/gsb/archives/gsb-msg00275.html>
- <https://www.mit.edu/~xela/yakshaving.html>

**「有时必须立刻 shave」的一手论证**（给出 C4/C5 两条判据）：Adam Wiggins, *In Defense of Yak Shaving*（2007-12-12）<https://adam.herokuapp.com/past/2007/12/12/in_defense_of_yak_shaving/>，逐字：「**You can't see what needs to be done to fix the problem unless you're in the thick of something that needs the fix.**」；双值判据逐字：「**Am I shaving this yak because it will be very valuable to my current goal and the project as a whole? Or am I doing it because I followed a rabbit trail of dependencies, and no one will care one way or the other whether the yak is shaved tomorrow?**」

**（b）⭐ 最有工程价值的一篇：`Ready-to-Resume` 计划（本报告最重要的心理学发现）**

**Leroy & Glomb (2018), *Organization Science* 29(3):380-397**，DOI `10.1287/orsc.2017.1184` <https://doi.org/10.1287/orsc.2017.1184>
摘要逐字：「A **ready-to-resume intervention**, in which one briefly reflects on and **plans one's return to the interrupted task**, **mitigates this effect**」。
→ **这是「入泊时必须写重启条件」的直接实验依据**，不是类推。它回答了一个本机设计目前**没回答**的问题：泊位条目**只存「问题是什么」是不够的，必须存「回来时从哪一步、用什么方式重新进入」**。见 §5.1 规则 2。

**（c）⭐ 「写计划本身能卸载认知负荷」（泊位机制的第二条实验依据）**

**Masicampo & Baumeister (2011)**, *JPSP* 101(4):667-683, DOI `10.1037/a0024192`
官方摘要（NLM）逐字：plan making「**may also free cognitive resources for other pursuits**」<https://pubmed.ncbi.nlm.nih.gov/21688924/>
→ 即：**「把新问题写下来入泊」这个动作本身就有认知收益**，不只是「记账」。这为「入泊必须是默认动作、且要真的写下来」提供了机制解释。

**（d）⭐ `task cuing`：为什么「每回合重锚」有效，以及它必须带**操作规范**

**Rubinstein, Meyer & Evans (2001)**, *JEP: General* 130(2)（NLM 官方）<https://pubmed.ncbi.nlm.nih.gov/11518143/>
官方摘要逐字：切换代价「随规则复杂度上升、**随任务提示（task cuing）下降**」。
→ **这是「每回合把计划放回眼前」的直接实验依据**，且带一个关键限定：**有效的 cue 是「该步要做什么」的操作级提示，不是一个抽象的计划标题**。C 的报告据此把规则 8 写成「每回合主动注入计划锚（**含该步操作规范**）」。→ 对本机 `plan-anchor` 的 `turnAnchor` 有直接改进含义：锚行里除了「第 3 步：写 compose 编排」，应尽量带上该步的验收动作。

**（e）打断的真实代价（把流传的「23 分钟」改正为有出处的 25 分钟）**

**Gloria Mark 等, CHI 2005** 全文（作者主页自存档）<https://www.ics.uci.edu/~gmark/CHI2005.pdf>
逐字（PDF 第 6 页）：「When people did resume work on the same day, it took an average length of time of **25 min**.」
⚠️ **「被打断后需 23 分钟恢复」在 CHI 2005 与 CHI 2008 中都不存在** —— 逐字全文比对：CHI 2008 中 `"23"` 出现 **0 次**；CHI 2005 中 `"23"` 出现 10 次但**全是参考文献编号或 `F(1,23)` 之类统计量**。**引用请用 25 分钟。**

**（f）Zeigarnik 已被否证 —— 不要用它解释「未完成任务占用工作记忆」**

**Ghibellini & Meier (2025)**, *Humanities and Social Sciences Communications*, DOI `10.1057/s41599-025-05000-w`
逐字：「**We found no memory advantage for unfinished tasks**」；被打断任务仅占回忆的 **49.16%**；「the Zeigarnik effect lacks universal validity」。
→ **真正有支持的是 `Ovsiankina 效应`（恢复倾向）**，不是 Zeigarnik 的记忆优势。**不要写「Zeigarnik 说明未完成任务占用工作记忆」。** 该论点应改引 §5(c) 的 Masicampo & Baumeister 2011。

**（g）方法学（含一条被纠正的出处）**

| 机制 | 一手出处 | 逐字要点 | 映射 |
|---|---|---|---|
| **Scrum 2020：偏离超限即刻纠正** | [Scrum Guide 2020](https://scrumguides.org/scrum-guide.html)（🟢 全文） | 「**The adjustment must be made as soon as possible to minimize further deviation.**」；Scrum Master 职责「**Causing the removal of impediments** to the Scrum Team's progress」 | C1（阻塞优先）、C2（偏离超限即刻纠正） |
| **SRE 的「先止血、后定根因」** | [SRE Workbook Ch.9](https://sre.google/workbook/incident-response/)；[SRE Book Ch.14](https://sre.google/sre-book/managing-incidents/)（🟢 全文） | 四步次序 + 角色分离；Ch.14 的 **Planning 角色承接暂存项** | **这是「何时才允许处理新问题」唯一有一手原句的工程等价物**：先缓解、后根因 → 对应「先入泊、计划走完再 triage」 |
| **WIP limit ↔ 上下文切换代价** | **The Official Kanban Guide**（Mauvius Group / Kanban University, 2022）全文 | 「In knowledge work we also have the issue of **context switching** that can drastically reduce the effectiveness of workers. In Kanban, we **limit the WIP** to balance utilization and still ensure the flow of work.」 | 直接支撑 **WIP=1**（计划内同时最多一个 active 步骤） |
| **敏捷宣言** | <https://agilemanifesto.org/> | 「Responding to change **over** following a plan」 | 反对计划神圣化 |
| **escalation of commitment** | Flyvbjerg, arXiv:2202.00125（*Project Management Journal* 52(6), 2021） | 项目管理**十大行为偏差**之一（第 10 项），样本 2,062 个项目 | 解释「已经定了所以必须做完」 |
| **「计划赶不上变化」的原话** | [Quote Investigator](https://quoteinvestigator.com/2021/05/04/no-plan/) | Moltke 1871 德文原文比流行误引**更强**，把「相信计划能被一丝不苟执行到底」称为**外行**；「No plan survives contact with the enemy」是 **1961 年的压缩改写** | 计划文本本就不该被神圣化 |
| **Cargo Cult / 仪式化清单的代价** | James Shore, *Cargo Cult Agile*（2008-05-13）；Ron Jeffries, *Dark Scrum*（2016-09-08）；Martin Fowler, *Flaccid Scrum*（2009-01-29） | Shore 逐字：「a set of methods created to *reduce* meetings and waste is being **abused to *increase* them**」 | 清单化本身的成本（C10） |
| **Attention residue** | Sophie Leroy | ✅ **书目已核（Crossref）+ 作者 CV + 摘要**。**纠正**：她的博士是 **NYU Stern（2001–2007）**，**不是** University of Washington；论文标题 *"Being present but not fully there…"*（2007）。**不存在 2019 年 HBR 文章**——HBR 台湾作者页只列 1 篇，为 **Leroy & Glomb, 2020-06-30** | 与 §5(b) 同一作者，**以 2018 *Organization Science* 的 ready-to-resume 为准** |

### 5.2 ❌ 不要搬进设计里的东西（C 报告第 13 节的反面清单，逐条有据）

| 常见做法 | 为什么不要搬 |
|---|---|
| **GTD 的 2 分钟规则**（小于 2 分钟的事立刻做） | **对 agent 有害**：agent 的「2 分钟」是成千上万 token 与数十次工具调用，判据不可比。应改为**硬预算**（次数/token 上限） |
| **Parkinson's Law**（工作会膨胀到填满可用时间） | 反过来会提供**反向激励**（暗示可以拖延）；且其 1955 年 *Economist* 原文**未核实**（仅第三方转录） |
| **「23 分钟恢复」** | 出处不存在（见 §5(e)），改用 **CHI 2005 的 25 分钟** |
| **Zeigarnik 效应** | **已被 2025 年元分析否证**（见 §5(f)），改用 **Ovsiankina 效应** 或 Masicampo & Baumeister 2011 |
| **GTD 原文逐字引用** | **完全未核实**：`gettingthingsdone.com` 与 `dev.gettingthingsdone.com` 均 **403 Cloudflare**，`archive.org` 不可达 → 报告**不给出任何 GTD 逐字引用**，只作设计类推 |
| **Pomodoro 的原文逐字** | **仅二手引用级**（Cirillo 原文未读到） |
| **「separate discovery from decision」** | **无一手出处**（只命中法律语境）。其工程等价物是 **SRE Workbook Ch.9 的「先缓解后定根因」+ Ch.14 的 Planning 角色**（见 §5(g)） |
| **SRE 书里的「recursive incidents」** | **不存在**，原文是「**Recursive Separation of Responsibilities**」；且 **SRE 书 Ch13/14 与 Spolsky 文中都不含 `triage` 一词** |

### 5.3 【可操作产出】允许立刻追新问题的准入判据（带来源）

> 用法：当成**准入规则**，不是「允许/禁止」二元开关。完整 13 条（C1–C13）见子报告 `D-downsides-and-metrics.md` §1.11；下面给最关键的 12 条：

| # | 判据 | 可操作规则 | 来源（一手） |
|---|---|---|---|
| C1 | **阻塞优先** | 新问题**阻塞当前步骤**（没有它就无法产出可交付物）→ 必须立刻处理。这不是「追新问题」，是「移除阻塞」。 | Scrum Guide 2020 |
| C2 | **偏离超限即刻纠正** | 实际进展偏离计划**超出可接受范围** → 必须尽快调整，不是「记下来等里程碑」。 | Scrum Guide 2020 |
| C3 | **目标 vs 计划分离** | 可随时改**计划**；改**目标**必须走一次显式重新协商。**静默漂移禁止。** | Scrum Guide 2020 |
| C4 | **时机不可替代** | 新问题**只在执行现场才看得清** → 立刻追（否则下次已看不见）。 | Wiggins 2007 |
| C5 | **双值判据** | 对**当前目标**有价值 **且** 对**整体项目**有价值 → 追；只是「顺着依赖链滑下去、明天没人在乎」→ 不追。 | Wiggins 2007 |
| C6 | **约束是逐步揭示的（默认假设）** | 默认「一开始列不全」是**常态**；计划必须设计成可在执行中吸收新约束。 | AdaPlanBench, arXiv:2606.05622 |
| C9 | **成本上限（「不追」的唯一正当理由）** | 「不追」的正当理由是**成本**，所以正解是**设预算/闸门**，不是**设禁令**。 | Anthropic, *Effective context engineering for AI agents* |
| **C14** | **⭐ 入泊必须写「重启条件」** | 泊位条目不只要写「问题是什么」，**必须写「回来时从哪一步、用什么方式重新进入」**。这是唯一有**干预实验**支持的规则（`ready-to-resume` intervention「mitigates this effect」）。 | Leroy & Glomb (2018), *Organization Science* 29(3):380-397, DOI 10.1287/orsc.2017.1184 |
| **C15** | **⭐ 写下来本身就有认知收益（所以入泊必须是默认动作）** | plan making「**may also free cognitive resources for other pursuits**」→ 入泊不是「记账负担」，它是**卸载认知负荷的动作本身**。 | Masicampo & Baumeister (2011), *JPSP* 101(4):667-683, PMID 21688924 |
| **C16** | **⭐ 重锚必须是「操作级 cue」，不是抽象标题** | 切换代价随规则复杂度上升、**随 task cuing 下降** → 每回合注入的锚要带**该步要做什么**，不只是「第 3 步」这个标签。 | Rubinstein, Meyer & Evans (2001), PMID 11518143 |

**C 报告第 13 节另给了 8 条可强制规则**：①入泊不做「顺手」判断 ②入泊必须写重启条件 ③WIP=1 ④阻塞判定口径写死 ⑤**先止血再查根因**（SRE）⑥泊位固定结算时机 ⑦完成必须附证据 ⑧每回合主动注入计划锚（**含该步操作规范**）。

**一句话概括**：**计划要保护的是「目标」，不是「计划文本」。** 允许立刻追的**充分条件**是：阻塞当前步骤（C1）、或使偏离超限（C2）、或只在现场可见（C4）且对当前+整体都有价值（C5）。**不允许的理由只有一个：预算**（C9）。**不允许的表达方式只有一种：静默**（C3）。**入泊时唯一不能省的字段是「重启条件」**（C14）。

---

## 6. 反面证据：强制「不追新问题」会不会有害？

**结论：会，而且有一条最容易踩的坑——强制机制的失效模式被厂商自己文档化了。** 关键一手证据：

1. **厂商为 Stop hook 死循环专门设计了防护 API**（Claude Code 官方文档逐字）：「`stop_hook_active` is true when Claude Code is already continuing as a result of a stop hook. **Check this value or process the transcript to avoid blocking on a condition that will never resolve.** **Claude Code overrides the hook and ends the turn after 8 consecutive blocks.**」
   → 厂商承认「Stop hook 可能导致无限运行」，所以：**任何「计划未回写就不许结束」的强制机制，必须自带 (i) 最大迭代上限、(ii) 循环守卫、(iii) 每轮可判定的收敛标准。缺任一项，这个机制就是 bug。**
   一手：<https://code.claude.com/docs/en/hooks>
2. **Scrum 官方规范要求「偏离一旦超限就尽快调整」**（逐字见 §5），并把「移除阻塞」列为一等职责 → 「一律不许偏离」在方法学上是错的。
3. **Yak shaving 有一手作者论证「有时必须立刻做」并给了判据**（C4/C5）→ 「一律入队」会系统性地丢掉只在现场可见的修复。
4. **Anthropic 自己承认无引导探索有代价**：无引导时 agent 会「waste context by misusing tools, **chasing dead-ends**, or failing to identify key information」（<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>）→ 正解是**预算**而非**禁令**。
5. **动态重规划是独立能力，不会随模型规模自愈**：`Perturbation Recovery Rate (PRR)` 在隐式语义失败下**骤降约 37%**；容错能力随模型规模的改善速度只有基础任务执行的 **1/3.66**（Zhu 等, *When Tools Fail*, arXiv:2606.05806）。
6. **「计划已批准」不构成它可以继续执行的证据**：`stale-plan execution` —— "state freshness does not establish that the plan authorizing an action remains valid"；freshness-only executor 在 30/30 任务上执行了过期计划（Chen, Wang, Brinton, arXiv:2609.03340）。

### 6.1 ⚠️ 最强的规范性指控：这个失效模式**筛选掉诚实**

官方文档不仅有 `stop_hook_active` 防护，还专门有一节排障「**Stop hook hits the block cap**」；CHANGELOG 两次使用 "**looping forever**" / "**infinite loop**" 措辞。跨 `anthropics/claude-code`、`anthropics/claude-plugins-official`、`openai/codex` 三个官方仓库有 **20+ 条正文可读的一手投诉**。

其中规范性最强的一条是 **`anthropics/claude-plugins-official#5312`** 逐字：

> 「An agent willing to falsely claim completion would have escaped in one turn. **The failure mode selects against honesty.**」

→ 这句话直接命中本项目的设计风险：**如果一个 Stop hook 的规则是「不满足条件就不许停」，那么诚实的 agent 会被反复挡住，而愿意谎报完成的 agent 一次就逃脱了。这个机制**在筛选不诚实**。**这是「强制不许停」类机制必须正视的伦理/工程代价，而不是实现细节。**
一手：<https://github.com/anthropics/claude-plugins-official/issues/5312>

### 6.2 ⚠️ 必须一起看的反向张力（不是一边倒）

同一批用户里也有人抱怨**完全相反**的事——`#84002` 逐字：「I cannot get Claude to finish a task, I cannot get it to stay on one… **it routes around the control**」（agent 绕过控制、不肯完成）。
Ralph 循环的推广者 Huntley 承认大量失败模式，但立场是「可调优」。

**所以正确的结论不是「强制 vs 不强制」，而是并存的两难**：
- 强制太软 → agent 静默漂移、绕过控制（#84002）
- 强制太硬 → 无限循环、以及 §6.1 的「筛选不诚实」（#5312）
→ 这正是为什么 §4.2 里 planlock 把「**只有 `out-of-scope` 一类偏离允许硬拦**」写进代码、stop-that-shit 把「**只对可观测事实做硬决定**」写进架构——它们都是对这两难的**折中设计**。

**未核实的最大缺口**：**没有找到任何知名从业者公开撰文论证「该机制本身有害」**（Ralph 推广者 Huntley 是支持者立场）。这属于「未核实/未找到」，不等于「不存在」。

### 6.3 ✅ 本次调研最一致的工程共识：**硬强制力都必须带熔断上限**

这不是我推导的建议，而是**四个独立厂商各自实现的一致做法**（全部一手核实）：

| 厂商 / 机制 | 逐字熔断规则 |
|---|---|
| Claude Code — Stop hook | 「Claude Code overrides the hook and ends the turn after **8 consecutive blocks**」；环境变量 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`（default 8，设 0 可禁用上限） |
| Claude Code — auto mode 分类器 | 「**3 times in a row or 20 times total**」就暂停并交还人类 |
| Cursor — `stop` hook | `loop_limit` 默认 **5** |
| GitHub Copilot — `agentStop` | **8** 次跑飞保护 |
| `planning-with-files`（26973★，社区） | `PWF_GATE_CAP` 默认 **20**，且 stall-aware |
| `oh-my-agent`（1310★，社区） | cap = **5** |

→ **结论：强制力是「有限纠偏预算」，不是「绝对约束」。** 官方与社区的最高 star 项目**无一例外**都给自己的强制机制设了硬上限。
→ **对 `dsh-plan-anchor` 的直接含义**：DSH 的桥**不提供**任何上限（见 §11.2 缺口 2），所以这个 cap 必须**由插件自己实现**，且行业取值的合理区间是 **5–20 次**。cap 达到时应**放行 + 上报**，而不是继续拦。

### 6.4 一条厂商自证的「模型裁判上限」

用 LLM 判断来代替硬规则的方案，有一个官方量化的天花板：Anthropic 工程博客公开 auto mode 分类器实测，真实 overeager 动作的 **FNR 是 17%**，原话逐字：
> 「**The 17% false-negative rate on real overeager actions is the honest number.**」

并承认失败模式是分类器「finds **approval-shaped evidence** and stops short of checking whether it's consent for the blast radius of the action」，且「**We've tried prompt-engineering around this and haven't found a fix**」。
→ 即：**用模型做闸门，约 1/6 的真实越界会被漏过，且官方明确说提示词工程解决不了。** 任何「独立评估者」方案都要按这个数量级设定预期，并靠**结构性手段**（scope 白名单、工具裁剪）而非判断力来兜底。

**未核实**：GitHub 上关于 Stop hook 死循环的具体用户抱怨 issue 正文——**已于收尾阶段由子调研补齐**，见 §6.1 / §6.2。

---

## 7. 学术上有没有量化研究 / benchmark / 指标？

**有，而且 `goal drift` 已经形成研究线。** 以下为逐字核实的指标名与出处：

| 逐字指标名 | 出处 | 数值 |
|---|---|---|
| `goal drift` / `goal adherence` / **`GD_actions` / `GD_inaction`** | Arike, Donoway, Bartsch, Hobbhahn (2025), **arXiv:2505.02709** <https://arxiv.org/abs/2505.02709> | scaffolded Claude 3.5 Sonnet "nearly perfect goal adherence for more than **100,000 tokens**"；**所有被测模型都有某种程度漂移**；漂移归因于 **pattern-matching，而非 token 距离**。⚠️ **该论文用的指标是 `GD_actions`/`GD_inaction`，不是 `GDI`** |
| `asymmetric drift` | Saebo, Gibson, Crosse, Menon, Jang, Cruz (2026), **arXiv:2603.03456** <https://arxiv.org/abs/2603.03456> | 基于 **OpenCode** 跑真实多步编码任务；漂移与三因素相关：`value alignment`、`adversarial pressure`、**`accumulated context`** |
| 继承性漂移 | Menon 等 (2026), **arXiv:2603.03258** <https://arxiv.org/abs/2603.03258> | 现代模型本身稳健，但**条件化于较弱 agent 的轨迹时会「继承」漂移**；只有 GPT-5.1 保持一致韧性 |
| `Goal Drift Detection` + `Intent Lineage Tracking` + `Intent Verification Layer` | Rong Xiang (2026), **arXiv:2604.23646** <https://arxiv.org/abs/2604.23646> | **PEA（Policy-Execution-Authorization）** 架构：把「意图生成 / 授权 / 执行」解耦成隔离层，用密码学能力令牌连接；`Intent Lineage Tracking` 把所有可执行意图**密码学锚定到原始用户请求**；`Goal Drift Detection` 拒绝低于可配置阈值的语义发散意图 |
| `instruction stability` / `instruction drift` | Li 等 (2024), **arXiv:2402.10962**（COLM 2024） | 「**significant instruction drift within eight rounds**」 |
| `Programmatic Instruction Following (PIF)` | Epstein 等 (2024), **arXiv:2409.18216** | PIF 从第 1 轮 **0.81** 掉到第 20 轮 **0.64**；把指令追加到上下文**末尾** → PIF 平均回升 **22.3** 分 |
| `PIF-N-K`（如 `PIF-4-4`） | 同上 | GPT-4o 与 Gemini「**successfully follow all instructions only 11% of the time**」 |
| `Perturbation Recovery Rate (PRR)` | Zhu 等 (2026), **arXiv:2606.05806** | 隐式语义失败下 PRR **骤降约 37%** |
| `50%-task-completion time horizon` | Kwa 等 (2025/2026), **arXiv:2503.14499**（NeurIPS 2025） | Claude 3.7 Sonnet ≈ **50 分钟**；约每 **7 个月**翻倍 |
| `stale-plan execution` | Chen, Wang, Brinton (2026), **arXiv:2609.03340** | 被度量的失败状态：state 是新的，但驱动动作的计划已失效 |

### 7.1 ⚠️ 术语警告：这些指标名**不存在**，不要引用

子调研对 arXiv 全库逐项证伪，以下名词**在 LLM agent 文献里找不到**（属常见臆造）：`plan adherence rate`、`plan adherence score`、`subgoal completion rate`、`goal drift rate`、`task derailment`、`trajectory deviation`、`persona drift`。
另：`GDI (Goal Drift Index)` 属 SAHOO（**arXiv:2603.06333**），**不是** Arike 的指标，勿张冠李戴。
**域内逐字可用名**：`goal drift` / `goal adherence` / `GD_actions` / `GD_inaction`、`instruction stability` / `instruction drift`、`PIF` / `PIF-N-K`、`50%-task-completion time horizon`、`Perturbation Recovery Rate (PRR)`、`Trajectory Efficiency`、`Narrative Commitment Preservation (NCP)`、`Fatigue Index (FI)`、`horizon residual`、`instruction-adherence drift`。

**一条低成本可立即验证的干预**：把全部指令**追加到上下文末尾**，`PIF` 平均回升 **22.3** 分（arXiv:2409.18216）。

**上下文腐烂（context rot）方向的补充一手证据**：- *When and How Context Rot Appears in Coding Agents: A White-Box Study of Agent Skills in Code Auditing*（Yue Xue, 2026-07-20, **arXiv:2607.17937**）：Codex + gpt-5.4-mini 在 **10,991 字符**干净上下文下 **8/10** 通过，在 **299,140 字符**相关上下文与等长无关上下文下都只有 **3/10**；失败分类逐字含 **`lost requirements`、`editing drift`、`failed checking`**；**一份详细的外部检查清单 10/10，而通用自查只有 5/10（p=0.0325）**。
  → 这条对本项目**特别重要**：**「外部清单」显著优于「自查」**，且「agent skills 加载了不等于要求在整个轨迹中一直生效」。
- *How Fast Do Agents Rot?*（Shubhra Mittal, 2026-08-31, **arXiv:2609.01660**）：10,664 条轨迹；**退化由步数而非上下文长度驱动**（限制上下文窗口反而**加剧**衰减，斜率 -0.69 vs -0.44，p=3e-6），**与 lost-in-the-middle 解释矛盾**；建议用 **`reliability budgeting`** 与 horizon-aware evaluation 替代聚合通过率。

**重要的负面发现**：经典 agent benchmark（SWE-bench / WebArena / OSWorld / AgentBench / GAIA 等）**并不把「漂移」当作可测对象**——它们度量的是终态是否达成，不是「是否沿着批准的计划走」（子调研结论，🟡）。唯一专门度量后者的是 `shutx-net/agent-plan-adherence-bench`（GitHub，0 star，2026-09-02，**未核实其内容质量**）。

---

## 8. 哪些是「有清单」之外的额外机制（真正的增量）

| 增量机制 | 谁在用 | 逐字证据 | 为什么清单给不了 |
|---|---|---|---|
| **① 冻结的权威 + 冻结时机** | planlock（`PreToolUse` on `ExitPlanMode`）；Codex（`<proposed_plan>` 完整替换） | 「The approved plan file is the only artifact that is **frozen at the moment of user consent**.」 | 清单是 agent 执行期写的，可被改写、可被跳过、可被重新措辞 |
| **② 独立信号 / 独立评估者（不是自述）** | Claude Code `/goal`；planlock；scope-guard；sruja | `/goal`：「completion is decided by **a fresh model rather than the one doing the work**」；planlock：「verdicts are derived from **observed tool calls** (via `PreToolUse` payload, which Claude cannot forge)」 | 清单的状态是 agent 自报的，等于「自己批自己的作业」 |
| **③ 有名字的偏离判决（不是二元）** | planlock `match/skip-ahead/out-of-scope/extra/partial`；forge `CLEAR/DRIFT/CONTRACT_VIOLATION/ARCHITECTURE_DEGRADATION/REWORK_PATTERN` | 见 §4.2 | 清单只有 open/in_progress/done，无法表达「跳步」「越界」「发明」 |
| **④ 带 scope 的步对象** | planlock `Step.scope = {files, commands, operations}` | 「A `TaskCreate` entry has **no scope field**… the data to answer that question is not on the task.」 | Beads 式任务只有 title/detail/status/priority，无法判断「这次 Edit 属于哪一步」 |
| **⑤ 独立捕获队列 + 明确准入判据** | `plan-anchor` 泊位（`blocking=false` 默认）；stop-that-shit `files=`；§5.1 的 C1–C13 | 泊位：「一律先入泊，不要现在追」；stop-that-shit：「Hard decisions are limited to **observable facts**」 | 清单里新任务和计划任务**地位平等**，可以直接 `in_progress`，零摩擦 |
| **⑥ 预算 / 闸门（而不是禁令）** | stop-that-shit `agents=N`；Claude Code `/goal` 的停滞保护与 8 次上限 | `stop_hook_active` 逐字防护 + 「ends the turn after **8 consecutive blocks**」 | 清单没有「偏离预算」概念，也没有终止条件 |
| **⑦ 只在某一类偏离上硬拦** | planlock `strict` 只拦 `out-of-scope`；stop-that-shit 三态 `OFF/OBSERVING/ARMED` + 默认 `OBSERVING/unconfirmed` | `STRICT_BLOCK = new Set(["out-of-scope"])` | 清单要么全拦要么全不拦 |
| **⑧ 把「可机器核验的事实」与「语义判断」分层** | stop-that-shit | 「The Guard checks explicit authority on supported action paths; **it does not infer business necessity from mechanism names.**」 | 清单不区分这两种判断，导致要么误拦要么漏拦 |

---

## 9. 现成方案里有没有能直接拿来用的？

**能直接用**（Claude Code 生态，非 DSH 原生）：
- `Stop That Shit`（2078★，2026-09-16 仍在推）——**有 5 个 host adapter**（Codex / Claude Code / OpenCode / Hermes / Pi）的 `ControlEvent v2` 归一化协议，设计成熟度最高；但它是 guardrails 不是 sandbox，且作者明确标注「advisory … cannot guarantee model behavior」。
- Claude Code 官方 `plugins/hookify` / `plugins/plugin-dev/skills/hook-development`——**可直接照抄 hook 配置规格**。
- Claude Code 内建 **`/goal`**——如果同类产品里有等价物，这就是现成的「独立评估者 + 不达条件不结束」。

**只能借鉴机制、不能直接装**（DSH 与 Claude Code 的 hook/生命周期 API 不同源）：
- `planlock`（架构规格可照抄，代码是 Claude Code hook 实现）
- `scope-guard`、`forge`、`clens`、`sruja`、`agent-plan-adherence-bench`

**本机已有同类落地**：`<工作区>\dsh-plan-anchor`（v0.1.0）+ 技能 `plan-anchor`。它的 8 条不变量中 **I1–I7 标注 `code` 强制、I8 标注 `prompt_only`**，并明确写「I8 是唯一只能靠注入提醒实现的，明确标注为 `prompt_only` —— 不假装它是硬约束」。这个诚实标注与 stop-that-shit 的 `host effect: unobserved` 是同一个良好实践。

> ⚠️ **本机运维事实（2026-09-18 核实）**：`dsh-plan-anchor` 在 `<工作区>\dsh-plan-anchor` 已构建（`lib/index.js`，770 行；`package.json` v0.1.0；`cordis.patch.yml`），但 **`$DSH_HOME/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都没有它**，`profiles/<profile>/node_modules/` 下也不存在。→ **`plan_*` 工具在当前 GUI 会话中不可用。** 需要 `dsh plugin --profile desktop add file:<本插件源码目录>`（或等价方式）并重启 Web 才会生效。（另：`package.json` 的 `description` 字段是正常 UTF-8，PowerShell 默认按 GBK 读取才会显示为乱码——文件本身没坏。）

---

## 10. 对我们最有用的 3 个机制

### 机制 1：**独立评估者 / 不可自述的证据（separate evaluator）**

- **谁在用**：Claude Code 内建 `/goal`（逐字：「adds a **separate evaluator** … completion is decided by a fresh model rather than the one doing the work」）；planlock（判决来自 `PreToolUse` 的工具调用日志，「which Claude cannot forge」）；sruja（「the actor never grades itself」，独立确定性 grader）。
- **为什么它对「有清单还漂移」是致命的一击**：清单的病根是**自述**。漂移的定义是「agent 以为自己在干第 3 步，实际在干别的」——一个由 agent 自己填的清单在原理上无法发现这件事。
- **怎么落地成工具/规则**（针对本机 `dsh-plan-anchor`）：
  1. **把「步完成」的证据从「模型填的 `evidence` 字符串」升级为「工具调用事实」**：记录每个 active 步开始后发生的工具调用序列（tool name + 关键参数摘要），`plan_step_done` 时把它们作为**不可改写的附件**存进台账，而不是只存模型的自我陈述。（`evidence` 仍然保留，但它要能被外部调用记录交叉验证。）
  2. **引入一个廉价的独立判定步骤**：类似 `/goal` 的三值判决，用一个便宜模型（或纯规则）在回合末回答「本回合的工具调用是否在推进第 k 步？」——三值而非二值：`推进中` / `已达成` / `不可能达成`（第三值避免死循环）。
  3. **单条硬不变量的成本极低且价值极高**：`plan_step_done` 若**本步开始以来没有任何工具调用**，直接拒（代码层，不是 schema 层）。这能挡住「假装推进」这一类，且不依赖任何模型判断。

### 机制 2：**带 scope 的五值漂移判决（typed drift verdict）**

- **谁在用**：planlock 逐字枚举 `match | skip-ahead | out-of-scope | extra | partial`；`Step.scope = { files, commands, operations }`；打分公式 `0.4*path + 0.2*op + 0.3*semantic + 0.1*(1-sequence_penalty)`；`strict` 模式**只拦 `out-of-scope`**。forge 的判决梯 `CLEAR / DRIFT / CONTRACT_VIOLATION / ARCHITECTURE_DEGRADATION / REWORK_PATTERN`。
- **为什么是增量**：Beads 清单只有 `open/in_progress/done`，**无法表达偏离的种类**。而「漏做一步」「越界改了别的文件」「跳步」「发明了新工作」在处理上是**完全不同的四件事**，对应四种不同处置。
- **怎么落地成工具/规则**：
  1. 给 `plan_set` 的每一步加一个**可选但被鼓励的 scope 字段**：`files`（glob 列表）、`commands`、`operations`。哪怕只让用户/agent 填「这一步预期会碰哪些文件」，就能让「越界」从不可检测变成可检测。
  2. 在 `plan_discover` 之外新增一个**由代码自动写的**判决字段（不是模型填的）：每次工具调用后，用纯字符串/glob 规则算一次 `verdict`，写进 `plan_log`。**先只做 `observe`（只记录、不提醒）**——这是 planlock 的默认档，先把真实误报率测出来。
  3. **只有 `out-of-scope` 允许升级为硬拦**，且必须在 observe 档跑够样本、确认误报率可接受之后。planlock 把这条写进了代码（`STRICT_BLOCK = new Set(["out-of-scope"])`），值得照抄。

### 机制 3：**准入判据清单 + 泊位的「再入」规则（admission criteria + bounded re-entry）**

- **谁在用**：Scrum Guide 2020（`remove impediments` / `adjust as soon as possible to minimize further deviation` / 计划可改但目标不可静默改）；Adam Wiggins（现场可见性 + 双值判据）；stop-that-shit（**只对可观测事实做硬决定**，语义判断留给 SKILL 层）；本机 `plan-anchor`（泊位 + `blocking` 判据）。
- **为什么是增量**：现有设计都是二元的（追 or 丢）。泊位解决了「丢弃」那一半，但**留下了另一半漏洞**：泊位条目在主计划走完之后，靠一句注入提醒「现在正是回头处理它们的时机」——**这是软提醒，没有预算、没有上限、没有逐条处置的强制动作**。也就是说，泊位有可能变成**新的、再也没被读过的东西**（正是 `plan-anchor` SKILL.md 自己警告的那件事：「别让泊位变成新的『再也没被读过的东西』」）。
- **怎么落地成工具/规则**（这是本报告最具体的一条建议）：
  1. **把准入判据写成 `plan_discover` 的显式字段**，而不是让它靠 agent 自觉。例如 `blocking` 之外再加：
     - `scope_visible_only: boolean`（对应 C4：是否只在现场可见）
     - `value_current: boolean` + `value_project: boolean`（对应 C5 的双值判据）
     → 规则：`blocking=true` **或**（`scope_visible_only` 且 `value_current` 且 `value_project`）→ 允许立刻处理（走 `plan_goto`）；否则**只能入泊**。这条规则把「什么时候才允许处理」从直觉变成可审计的字段。
  2. **给泊位一个「偏离预算」**（对应 C9：唯一正当理由是成本）。例如每走完 1 步，允许消耗 1 次「立即处理泊位」的额度；额度用完则只能继续入泊。预算 vs 禁令——这是 Anthropic 自己承认的正确方向。
  3. **计划走完时，把「清点泊位」从软提醒升级为一次有上限的强制分诊**：每个条目必须落到三个终态之一 —— `已处理` / `转成 task_create 任务` / `显式关闭（写 reason）`。**并且给这一次分诊设定步数/时间上限**（对应 C13：强制机制必须自带终止条件）。没有上限的分诊会变成新的 yak shaving；没有强制终态的分诊会让泊位变成垃圾场。
  **⭐ 并且必须补上 C14（唯一有干预实验支持的规则）：泊位条目只存「问题是什么」是不够的，必须存「回来时从哪一步、用什么方式重新进入」**（`ready-to-resume` intervention 逐字「**mitigates this effect**」，Leroy & Glomb 2018）。本机 `plan_discover` 目前只收 `text` + `blocking`，**缺这个字段**——这是投入产出比最高的一处改动。
  4. **两条要写进技能的诚实边界**（两条都有先例背书）：① 泊位永不清空是**设计意图**，但「永不清空的泊位」= 未处理的欠账，必须能一眼看到条数（本机已做到）；② 判据是**启发式**，允许 `plan_mute`，且要照 `plan-anchor` 现有做法明确标注哪条不变量是 `prompt_only`。
  5. **`turnAnchor` 的改进（C16）**：锚行要带**该步的操作级 cue**，不只是「第 3 步：写 compose 编排」这个标签——因为切换代价「随 task cuing 下降」，而有效的 cue 是操作级的（Rubinstein et al. 2001）。
  6. **⛔ 不要引入 GTD 的「2 分钟规则」**：agent 的「2 分钟」是成千上万 token，判据不可比，会变成漂移的合法外衣。改用**硬预算**（次数 / token 上限）。

---

## 11. 【收尾追加】DSH 自带 Claude Code hooks 兼容桥 —— 以及它的三个硬限制

> 这一节是本报告**对下一步行动影响最大**的发现，全部由我本人读本机源码核实（非二手转述）。

### 11.1 桥存在，且不只是 Claude Code

路径：`<用户目录>\<DSH 安装目录> Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\`
同目录下与「钩子/计划/提醒」相关的包：

| 包名 | 说明 |
|---|---|
| `dsh-hooks-claude-code` | **Claude Code hooks 兼容桥**（`lib/index.js`，406 行） |
| `dsh-hooks-codex` | Codex hooks 兼容桥 |
| `dsh-hook-protocol` | 钩子协议 |
| `dsh-plan-mode` | **计划模式**（说明 DSH 自带 plan mode 扩展点） |
| `dsh-repeat-tool-reminder` | 重复工具调用提醒（`dsh-plan-anchor` README 提到照抄了它的注入写法） |

`dsh-hooks-claude-code` 支持 7 个事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`。
`Stop` 映射到 harness 事件 `agent/turn-stopping`（`lib/index.js` L293），阻断时用 `agent.steer()` 注入消息强制再走一步（L301）。
**但 desktop profile 的 `dsh.profile.bundles` 里没有它**（我核对了 `$DSH_HOME/profiles/<profile>/package.json`）。

### 11.2 ⛔ 三个硬限制（逐字源码核证，非推测）

**限制 1：`stop_hook_active` 被硬编码为 `false`，永远为假。**
`lib/index.js` L385–390：
```js
function stopPayload(ctx, agent) {
	return {
		...base(ctx, agent, "Stop"),
		stop_hook_active: false
	};
}
```
L391–396 的注释逐字：「`stop_hook_active` is present on SubagentStop only (**the loop-guard flag, always false**)」（SubagentStop 同样在 L402 写死 `false`）。

→ **后果**：官方文档教的标准自限写法「读到 `stop_hook_active` 为真就放行」在 DSH 上**完全失效**——它永远读到假，于是会**无条件继续**。任何照抄官方范例的 Stop hook 在这里都会变成死循环。

**限制 2：没有任何连续阻断上限。**
整个 406 行文件里，`agent/turn-stopping` 处理函数（L293–309）**只做一件事**：`if (merged.decision === "deny") agent.steer(...)`。grep `consecutive` / `blockCap` / `block_cap` / `STOP_HOOK_BLOCK_CAP` **零命中**。
→ **后果**：Claude Code 那个「after **8 consecutive blocks**」的官方兜底 + `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 环境变量在 DSH 上**都不存在**。判据写错 = **真的无限循环，没有兜底**。必须自己在状态文件里计数 + 自己写 cap。

**限制 3：只运行 shell 形态的 command handler。**
据子调研（E）核对 README 与代码：`http` / `mcp_tool` / **`prompt`** / `agent` 类型的 handler 全被跳过，`if` / `once` / `async` / `args` 配置项也不生效。
→ **后果**：Claude Code 的 `/goal` 依赖 `type:"prompt"` 的 Stop hook，**这个范式在 DSH 上不可用**；`PreCompact` 事件也不支持（拿不到「压缩前刷新计划」的时机）。
> 证据级：限制 1、2 由我逐行读源码确认（🟢）。限制 3 我未在本次窗口内独立复核到具体代码行，标注为 **🟡 子调研核实，我未复核**。

### 11.3 对方案的含义（结论）

- **「借机制骨架 + 本机自建」是唯一可行路线**，而不是「找一个现成包装上」。这与 §9 的结论一致，但现在有了硬原因：外部方案的强制机制**依赖宿主提供的兜底**，而 DSH 的桥恰好在最关键的两处（`stop_hook_active`、block cap）不提供兜底。
- **若要用 Stop 闸门做「计划未回写就不许结束」**，必须**自己实现**：①在状态文件里维护连续阻断计数；②写死一个 cap（并且**当 cap 达到时改为放行 + 上报**，绝不能继续拦）；③**不要**依赖 `stop_hook_active`。
- **`additionalContext` 语义（= `agent.steer` 注入提醒）比 `decision:"block"` 语义更安全**，且这是官方自己推荐给「提醒回写计划」这一用途的（官方逐字：走同一套循环保护，但 transcript 标为 `Stop hook feedback` 而非 hook error）。本机 `plan-anchor` 的「回合锚 → 轻提醒 → 二次提醒」两级设计方向正确。

---

## 12. 【收尾追加】三条「准入判据」的现成实现（含一条概念最贴合的）

> 以下是本次调查后半段（子调研 B）新命中的项目。**我亲自核实了 star 数与 pushed_at**（经 `ungh.cc` 镜像，通道：`raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 在收尾阶段均超时，故**未能读到这些仓库的原文逐字字段**）。B 被提前停止，未产出文件，故其转述内容**按 🟡 标注为「未逐字复核」**。

| 项目 | star | pushed_at | 机制（据 B 转述，🟡 未逐字复核） | 证据级 |
|---|---|---|---|---|
| [`buildomator/buildomator`](https://github.com/buildomator/buildomator) | **88** | 2026-09-17T21:53:49Z | 验证阶段产出 `gaps_found`，**按严重度自动路由**：破坏阶段目标的 gap 升级为修复阶段；**minor gap 自动 park 到 backlog 且不打断** ← **这正是「什么时候才允许处理」的判据，且是自动的** | star/pushed 🟢；机制 🟡 |
| [`Ktulue/scope-lock`](https://github.com/Ktulue/scope-lock) | 3 | 2026-03-29T14:42:42Z | `SCOPE.md` 里的 **Scope Change Log**，每条新请求由 agent 判 **`Permit` / `Decline` / `Defer`**；选 `Defer` 会生成 "Follow-up task created" | star/pushed 🟢；机制 🟡 |
| [`danielrosehill/Claude-Breakout`](https://github.com/danielrosehill/Claude-Breakout) | 0 | 2026-08-12T17:21:52Z | 把中途冒出的想法标成 **`out-of-scope`**，"file it, explicitly not this sprint"；配套 **interrupt** 技能；仓库描述逐字含「**without derailing the work in flight**」 | star/pushed 🟢；机制 🟡 |

仓库描述我逐字核到（🟢，来自 `ungh.cc`）：
- buildomator：「Structured plan/execute/verify coding workflow for Claude Code: atomic commits, MCP-backed state, ~92% lower per-turn token overhead, native convention + **drift-detection safeguards**… A Claude Code-native evolution of **GSD and VibeDrift**.」
- Claude-Breakout：「The breakout pattern: **routing an idea that surfaces mid-task into its own repo and its own agent, without derailing the work in flight**.」
- todo-harness：「…**Stop** blocks a session that changed files but left the backlog untouched.」（star 3，2026-08-30）

### 12.1 值得注意的两条线索

1. **存在一条「漂移检测」的谱系**：`buildomator` 自称是 **GSD 与 VibeDrift** 的演进 → 想追更早的先例可以顺着 `VibeDrift` / `GSD` 往回找。**未核实**（本轮未展开）。
2. **`buildomator` 有真实可读的漂移配置**：仓库里有 `.gsd/drift-allowlist.json` 与 `.github/workflows/check-drift.yml` → 「**漂移允许清单**」这个概念值得借鉴：不是「零漂移」，而是**显式声明哪些漂移是被允许的**。**未核实其文件内容**（抓取超时）。

### 12.2 三条判据的横评（把 §5.3 与 §3 串起来）

| 实现的判据 | 形态 | 与 §5.1 的关系 |
|---|---|---|
| `buildomator`：**严重度自动路由**（破坏阶段目标 → 立即；minor → 自动 park） | 自动、二元、按严重度 | ≈ **C1（阻塞优先）** 的机器化实现，且附带自动分流 |
| `plan-anchor`：`blocking=true` 才允许立刻处理 | 模型显式标注、二元 | ≈ **C1**，但靠模型自觉填 |
| `stop-that-shit`：只对**可观测事实**硬拦（`files=` / `agents=` / `hash=`） | 权限判据、二元 | 与 **C9（预算是唯一正当理由）** 同构 |
| `scope-lock`：**`Permit` / `Decline` / `Defer`** 三值 | 三值（比二元多了「延后」） | ≈ **C4 + C5** 的三值化：`Defer` 就是「合规的入泊」 |
| `planlock`：`match` / `skip-ahead` / `out-of-scope` / `extra` / `partial` | 五值 | 把「偏离」细分成四类，见 §4.2 |

→ **`scope-lock` 的三值命名（`Permit`/`Decline`/`Defer`）比本机现有的二元 `blocking` 更好**：它给「延后」一个**一等公民的决策值**，而不是让「不阻塞」表现为「什么都不发生」。这与 §7 里 `PIF` 的实验结果（指令放在末尾效果更好）配合起来，是一条低成本可试的改进。

---

## 13. 一手来源索引（按主题）

**官方文档 / 源码**
- Claude Code hooks（逐字字段与事件）：<https://code.claude.com/docs/en/hooks>
- Claude Code `/goal`（独立评估者）：<https://code.claude.com/docs/en/goal>
- Claude Code tools reference（Task 工具与 `TodoWrite` 默认状态）：<https://code.claude.com/docs/en/tools-reference>
- Claude Code permission modes（plan mode 阻断力的边界）：<https://code.claude.com/docs/en/permission-modes>
- Claude Code 官方插件 `hookify` / `feature-dev` / `hook-development` skill：<https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/plugin-dev/skills/hook-development/SKILL.md>
- Codex plan 工具禁用：<https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/plan.rs>
- Codex Plan 模式模板：<https://raw.githubusercontent.com/openai/codex/main/codex-rs/collaboration-mode-templates/templates/plan.md>
- Codex hook 配置：<https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/hook_config.rs>
- Claude Code issue #14259（PrePlanMode/PostPlanMode hook 请求，open）：<https://github.com/anthropics/claude-code/issues/14259>

**项目设计文档（可照抄的规格）**
- planlock ARCHITECTURE：<https://raw.githubusercontent.com/Kac291/planlock/main/ARCHITECTURE.md>
- planlock policy 源码（逐字判决集合）：<https://raw.githubusercontent.com/Kac291/planlock/main/src/match/policy.ts>
- Stop That Shit ARCHITECTURE：<https://raw.githubusercontent.com/lennney/stop-that-shit/main/ARCHITECTURE.md>
- Stop That Shit SKILL（Stop Ladder）：<https://raw.githubusercontent.com/lennney/stop-that-shit/main/skills/stop-that-shit/SKILL.md>
- scope-guard hooks 配置：<https://raw.githubusercontent.com/atoolz/scope-guard/master/hooks/hooks.json>
- forge drift-detector agent：<https://raw.githubusercontent.com/dormstern/forge/main/agents/drift-detector.md>

**本机源码（DSH 兼容桥）**
- `@deepseek-ai/dsh-hooks-claude-code`：`…\app.asar.unpacked\node_modules\@deepseek-ai\dsh-hooks-claude-code\lib\index.js`（`stop_hook_active` 硬编码于 L388；`agent/turn-stopping` 于 L293）

**方法学 / 心理学**
- Scrum Guide 2020：<https://scrumguides.org/scrum-guide.html>
- 敏捷宣言：<https://agilemanifesto.org/>
- Adam Wiggins, In Defense of Yak Shaving (2007)：<https://adam.herokuapp.com/past/2007/12/12/in_defense_of_yak_shaving/>
- Quote Investigator（Moltke 原话与误引）：<https://quoteinvestigator.com/2021/05/04/no-plan/>
- Anthropic, Effective context engineering for AI agents：<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

**论文（arXiv）**
- 2505.02709 goal drift 奠基评测 · 2603.03456 coding agent 的非对称漂移 · 2603.03258 继承性漂移 · 2604.23646 PEA separation-of-powers 强制 · 2402.10962 instruction stability · 2409.18216 PIF/MMMT-IF · 2606.05806 PRR/动态重规划 · 2503.14499 50% time horizon（NeurIPS 2025）· 2609.03340 stale-plan execution · 2607.17937 coding agent 的 context rot 白盒研究 · 2609.01660 长时程退化由步数驱动 · 2606.05622 AdaPlanBench · 2502.19559 多智能体辩论中的问题漂移

---

## 14. 附：未核实清单（明确标注，便于后续接手）


1. `anthropics/claude-code#32253`（planlock README 引用的「Claude 抛弃我们的计划」用户报告）——**未命中，不采信**。我在该仓库搜索 `plan mode` 相关 issue 时未找到该编号。
2. Cursor / Cline / Roo Code（Focus Chain）/ Aider / OpenHands / Gemini CLI / Kiro / Devin / Windsurf / GitHub Copilot coding agent / Sourcegraph Amp 的官方机制——**已由子调研 A 补齐**（见 §4.4，2351 行分报告 / 260 条一手链接），其中三处常见说法被推翻（Roo 的 Focus Chain、OpenHands 的 microagents、Codex 的旧 approval 名）。仍**未核实**：Kiro 的 `hook_event_name` 大小写（官方两页自相矛盾）、Kiro `todo_list` vs `todo`（官方文档自相矛盾）、Gemini CLI hooks 的引入版本、Cursor 内部 todo 工具名、Cursor Cloud Agents 是否有 Plan Mode、Cascade todo 工具名、Copilot `update_todo` 是否在云端 Linux 沙箱注册、Devin Cloud 的排队语义、Amp 的 `Amp Free` 正文（登录墙）。
3. Codex 各 hook 事件能否返回 block 及决策字段名——**未核实**。
4. Codex 旧 approval 模式名（`suggest`/`auto-edit`/`full-auto`）是否为历史版本——**未核实**。
5. **GTD 完全未核实** —— `gettingthingsdone.com` 与 `dev.gettingthingsdone.com` 均 **403 Cloudflare**，`archive.org` 不可达。报告 §5 **不给出任何 GTD 逐字引用**，只作设计类推；**若要引用 GTD 原句必须另行取证**。
6. **仅二手引用级的项**：Pomodoro（Cirillo 原文未读到）、Parkinson's Law（仅第三方转录，1955 年 *Economist* 原文未核实）、Defer commitment / last responsible moment（二手+摘要）、**David J. Anderson 的 Kanban 原书未读到**（改用 The Official Kanban Guide 2022 全文替代）。
7. **Sophie Leroy 已核实到「书目 (Crossref) + 作者 CV + 摘要」级**，但**未读到她论文全文**；§5.1(g) 的 ready-to-resume 逐字来自 *Organization Science* 摘要。
8. GitHub 上关于 Stop hook 死循环的用户抱怨 issue **正文** —— **已于收尾阶段由子调研补齐**（跨三个官方仓库 20+ 条正文可读；最尖锐一条为 `anthropics/claude-plugins-official#5312`），见 §6.1 / §6.2。
9. `shutx-net/agent-plan-adherence-bench` 的内容与质量——**未核实**（0 star，仅核实了存在性与推送时间）。
10. GitHub API core 配额在调查中期耗尽（`core: 0/60`，重置时间 2026-09-18 13:40 UTC），此后 star/pushed_at 的核实改用 `search` 配额与 `ungh.cc` 镜像完成；表内数据均在耗尽前或经镜像核实。
11. **收尾阶段 `raw.githubusercontent.com` 与 `cdn.jsdelivr.net` 同时超时**，导致以下内容**未拿到原文逐字**：`Ktulue/scope-lock` 的 `Permit`/`Decline`/`Defer` 精确字段名、`buildomator` 的 `gaps_found` 路由逻辑与其 `.gsd/drift-allowlist.json` / `check-drift.yml` 内容、`danielrosehill/Claude-Breakout` 的 `SKILL.md`、`MdYasinMollah/todo-harness` 的 `hooks/todo.mjs`。以上在 §12 中均标注为 🟡「转述，未逐字复核」。（注：同一通道在本调查早期**可用**，故属**不稳定**而非不可用。）
12. **DSH 桥的限制 3**（只跑 shell 形态 command handler；`prompt`/`agent`/`http`/`mcp_tool` 被跳过；`PreCompact` 不支持）—— 由子调研 E 核对 README 与代码得出，**我未在本次窗口内独立复核到具体代码行**，标注为 🟡。限制 1、2 我逐行读源码确认（🟢）。
13. `buildomator` 自称演进自 **GSD 与 VibeDrift** —— 这条「漂移检测谱系」的上游项目**未展开核实**。
14. 子调研 B（GitHub 项目专项）在收尾前被停止，**未产出 `B-github-projects.md`**；其命中项目由我逐个经 `ungh.cc` 复核 star/pushed_at 后并入 §2 与 §12。
15. **本环境 `web_fetch` 不支持 PDF**；子调研 C 改用「下载 + 本地 PyMuPDF 抽取」才拿到多篇全文（该路径已记录，后续会话可复用）。不可达域名：`economist.com`、`archive.org`、`sciencedirect`(403)、`INFORMS`(403 Cloudflare)、`sloanreview`(403)、`gettingthingsdone.com`(403)、Google Books API(超时)。

---
