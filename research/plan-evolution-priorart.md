# 「计划在执行中修订」的业界现成做法 —— 调研报告

> 调研问题：一个 agent 定了 5 步计划，执行到第 3 步发现要改（第 4 步拆成两步或删掉）。此时
> ① 已完成的 1、2 步进度/历史怎么保住？② 步骤**编号**（"第 3 步"）跨修订怎么保持指代不混乱？
> ③ 执行中衍生的额外/临时任务归属于谁、编号怎么连续？④ 计划版本之间怎么对比、回溯？
>
> 调研日期：2026-09-18。取证规则：一手来源（官方文档/源码/论文原文）优先；核不到写"未核实"；
> 不编造 API 名、字段名、版本号。所有结论附链接。

---

## 0. 结论速览（TL;DR）

1. **"步骤身份跨修订稳定"这件事，主流 AI agent 框架（LangGraph/smolagents/AutoGPT 系）基本没做**：
   它们的 `plan` 就是一个 `List[str]`，每次 replan **整表重建**，已完成的工作被降级成"上下文"
   （`past_steps`）而不是"有身份的实体"。已核实 LangGraph 官方 notebook 源码。
2. **真正系统性地解决这 4 个问题的，是工作流引擎，不是 agent 框架**。工业界的标准答案已经成型：
   **流程定义版本化（不可变）+ 运行实例持有版本指针 + 用「元素 ID 映射」把运行实例迁移到新版本
   （已完成元素原封不动、活动元素保留其运行时状态）**。Camunda 8 的 Process Instance Migration
   就是这个答案的教科书实现，且它举的例子几乎就是你描述的场景（在活动步骤**之后**插入一个新步骤）。
3. **身份模型的正确答案是"分离两个 ID"**：Temporal 的 `WorkflowId`（业务身份，跨 run 不变）
   vs `RunId`（每次执行一个新的系统 ID，官方明确警告"不要拿 RunId 做逻辑判断"）；
   Gerrit 的 `Change-Id`（"**independent of the commit id**"，跨 amend/rebase/cherry-pick 不变）。
   这两者是你"步骤身份"问题最直接的可抄样本。
4. **DSH 宿主自身没有任何步骤身份**：`exit_plan_mode(plan)` 收的是**一个 markdown 字符串**，
   `todo_write` 的每个 item 只有 `content` + `status`（`additionalProperties: false`，没有 id）。
   所以"编号稳定"这件事**必须在插件层自建**，宿主给不了。
5. **反面结论**（很重要）：业界**普遍就是重建计划不保编号**。但"重建"并不等于"丢历史"——
   它们用**追加式日志**兜住历史（DSH 的 `todo/write` 快照流、LangGraph 的 `past_steps`、
   trailmap 的 `events[]`、dsh-plan-plus 扫描 `exit_plan_mode` 的 `tool/call` 事件）。
   **你没有做错，只是没做完整**：历史这一半业界的做法你已经天然具备，身份这一半才是空白。

---

## 1. 对照表：各方案 × 4 个子问题

图例：✅ 明确解决 / ◐ 部分解决 / ❌ 没有 / — 不适用。**加粗**=最值得看的。

| 方案 | ① 已完成步骤的进度/历史 | ② 编号/身份跨修订稳定 | ③ 额外任务的归属与编号 | ④ 版本对比/回溯 |
|---|---|---|---|---|
| **DSH 原生**（plan mode + todo_write） | ◐ 每次 `todo/write` 是**整表快照**追加进会话日志，replay 是 last-write-wins ⇒ 历史天然存在 | ❌ 计划是**一个 markdown 字符串**；todo item 只有 `content`+`status`，**无 id**，身份=位置；唯一约束是 content 不重复 | ❌ 无机制（模型自己重写整表） | ❌ 无 UI；但 `exit_plan_mode` 的 `tool/call` 事件全在日志里 |
| dsh-plan-plus（市场插件） | ✅ 依赖宿主日志，不动进度 | ❌ 无步骤概念，**只有整篇文档的 v1…vN** | ❌ — | ✅ **版本下拉 + 行级 LCS diff（+绿/-红）+ 直接编辑留档为新版本 + localStorage 持久化** |
| **file-planning / trailmap** | ✅ 步骤永久 id `<里程碑>-<序号>`（如 `m1-1`），**增删不重编号**；`drop` 带原因而非删除；`reopen` 复活 | ✅ **引用一律用 id**（`depends: ["m1-1"]`），展示序号可派生 | ◐ 发现先落 `fieldnotes.md`（**不编号**），要变成任务须显式 `amend add-step` ⇒ 新 id = 当前最大序号+1 | ◐ 追加式 `events[]`（`created/started/finished/dropped/reopened/amended/noted/journaled/closed`）＝完整时间线，但**无 diff/并排对比**；归档后只读（`PLAN_CLOSED`） |
| dsh-plan-board | ✅ `node.evidence[]`（done 必须有证据，L3 证据门）+ `events.jsonl` | ✅ 节点 `id` 由调用方给、查重（`DUP_ID`）；**执行序号是从 DAG 派生的拓扑序，不落库**（改图后自动重算，不会出现"编号指代漂移"） | ◐ `add_node` 新增节点（挂在某 module 下 ⇒ 归属明确）；改图走**人审门**（`pendingApprovals` + `EditOp[]`：`add_node/update_node/remove_node/set_deps`） | ◐ 乐观锁 `version: number` + SHA-256 digest + `events.jsonl` 时间线；**无 diff 视图** |
| dsh-plan-lattice | ✅ 持久执行合同 + **revision 号** + digest | ◐ 合同（contract）有 `id` + `revision`；步骤层未核实 | ◐ 递归工作图（未核实细节） | ◐ `revision` 递增、旧 receipt 判 stale；aggregate digest |
| dsh-routing-suite（graded 模式） | ◐ `status: pending/in_progress/completed` 落盘 | ❌ 任务用 **`(level, title)` 定位**（不是 id）⇒ 改名即断引用；`lock_stage(L2)` 后 `spec/accept/verify` **只读**，只有 `do` 可改且走"修订登记" | ◐ `edit_plan(level, …)` 结构上支持增改；审核后解锁要显式"『修改』回到审核前" | ◐ `state.audit` + `redteam.log` 轮次；**无版本 diff** |
| dsh-plan-and-execute | ◐ 控制流状态落 `planDir/orchestrator.json`（不写会话日志） | ❌ 步骤身份 = **数组下标**（`stepIndex` 1-based），插入/删除即全体位移 | ❌ — | ❌ — |
| **LangGraph Plan-and-Execute**（官方 notebook 源码） | ✅ `past_steps: Annotated[List[Tuple], operator.add]` —— **追加式累积 (步骤文本, 结果) 对**，永不删 | ❌ `plan: List[str]` **纯字符串列表，无 id**；`plan[0]` 即下一步；replan 返回**全新 steps 列表**；显示序号每轮从 1 重排（"You are tasked with executing step 1"） | ❌ 由 replanner 直接写进新列表 | ◐ checkpointer/`get_state_history()`/time travel（未逐条核实） |
| claude-task-master | ◐ `status` 枚举含 `cancelled/deferred`；子任务带 status | ✅ **点分分层层级 ID：`1` / `1.2` / `1.2.3`**（父任务在 ID 里编码）；`dependencies: [1,2]` 用 ID 引用；跨 tag 移动时 ID 保留 | ✅ **子任务 ID 只在父任务内唯一 ⇒ 归属天然表达为 `父ID.子序号`** | ❌ 无版本/diff；有 `validate-dependencies`/`fix-dependencies` 修悬空依赖 |
| **Temporal** | ✅ **执行历史不可改写**（append-only Event History），replay 确定性约束 | ✅ **`WorkflowId`（业务身份，跨 run/ContinueAsNew 不变）vs `RunId`（每次执行新 ID）**；官方明确"不要用 RunId 做逻辑判断" | ◐ 子工作流/`Continue-As-New` 续接 | ✅ 完整 Event History + Replay；改代码靠 `patched()` 在**历史某一点加门**，`deprecate_patch()` 退休 |
| **Camunda 8（C7 同源）** | ✅ **迁移不改已完成元素**；活动元素"尽可能少干预"，变量/用户任务/作业原值保留 | ✅ 流程定义**版本化且不可变**；元素 ID 是身份；迁移需**显式映射指令** `sourceElementId → targetElementId` | ◐ 迁移可在活动元素**之后插入新元素**（官方示例正是"在 A 之后加 B"）；不能跨元素类型映射 | ✅ 定义版本历史 + Operate UI 迁移；另设"流程实例修改"（不改定义地修实例） |
| Apache Airflow | ◐ TaskInstance 主键 `(dag_id, task_id, run_id)`；**task_id 就是身份，改名=丢历史**（未逐条核实） | ◐ 同上 | ❌ | ◐ Airflow 3 的 DAG versioning（未核实） |
| **git / Gerrit** | ✅ 内容寻址 + 追加式历史，永不重写 | ✅ **Gerrit `Change-Id`：一个"变更"跨多次 patchset 保持同一身份**（"independent of the commit id"，跨 amend/rebase/cherry-pick）；匹配需要 Change-Id + repo + branch | ◐ 分支/子模块；rename 检测是启发式 | ✅ diff/blame/notes/reflog |
| CRDT（Yjs/Automerge） | — | ✅ item 身份 = 稳定 ID，(clientID, clock)，**永不重编号**；`RelativePosition`/cursor 是可跨并发编辑的稳定引用 | ◐ 在相邻 ID 间**分配新 ID**（RGA/Logoot/LSEQ） | ◐ 版本向量/历史（未逐条核实） |
| 经典 AI 规划 | — | ◐ plan repair 保持旧计划结构 ⇒ 天然保序 | ◐ goal reasoning/GDA 处理意外新目标 | ◐ plan distance / plan stability 度量 |

> 表中标"未核实"的格子见 §5 证据清单；加粗行是我认为最值得深读的。

---

## 2. 明确回答：有没有现成方案**直接**解决"步骤身份跨修订稳定 + 额外任务归属"？

**有，但不在 AI agent 生态里，在 BPM/工作流引擎里。**

**Camunda 8 的 Process Instance Migration（已核实，一手文档）**几乎逐条命中你的场景：

- 官方定义：「Process instance migration fits a running process instance to a **different process definition**.」
- 官方给出的示例场景是：运行中的实例停在服务任务 `A`，新需求要**在 A 之后、结束事件之前插入一个用户任务 `B`**。
  官方原话：「Process instance migration allows you to change the **inactive parts** of the process instance.
  In our example, we placed a user task `B` between the active service task `A` and the inactive end event.
  **We did not change the active service task `A`, just the steps that follow.**」
  ⇒ 这就是"第 4 步拆成两步"的工业界标准解法：**改未来，不动过去**。
- 机制：「You must provide a **migration plan with mapping instructions** to the target process definition
  to clarify your intentions.」映射 = `source element ID → target element ID`；活动元素 `A` 映射到 `A`
  即"实例继续停在 A"，且**变量、用户任务、作业原值保留**（「Any existing variables, user tasks, and jobs
  continue to exist with the same values as previously assigned.」）。
- 边界守卫：「**You cannot map an element to an element of a different type.**」（服务任务不能映射成用户任务）
  ⇒ 跨类型要改用"流程实例修改"（cancel + add 新实例），代价是丢掉该元素的运行时状态。
- 还区分了两个机制：**migration**（改定义版本）vs **modification**（不改定义、只修实例）。
- 可前进、可回退、也可迁到完全不同的流程定义。

**"额外任务归属"也有直接答案，但在任务管理生态里**：claude-task-master 用**点分分层层级 ID**
（`1` → `1.2` → `1.2.3`，`packages/tm-core/src/modules/tasks/validation/task-id.ts` 已核实源码），
子任务 ID **只在父任务内唯一**，于是"这个临时冒出来的任务归谁"由 ID 结构本身回答；
依赖也用 ID 引用（`dependencies: [1, 2]`）；跨列表（tag）搬动时 ID 保留，跨列表依赖要显式
`--with-dependencies` 或 `--ignore-dependencies`（附带 `validate-dependencies`/`fix-dependencies` 修悬空）。

**AI agent 框架里没有任何一个项目做到了这两条**：LangGraph 的 plan 是无 id 的字符串列表，
smolagents / AutoGPT / BabyAGI 系同样把计划当"可变文本"（详见 §6）。**所以你的做法不算错，
但那两条恰恰是业界唯一的成熟答案正好覆盖的地方 —— 可以直接借。**

---

## 3. 最值得抄的 3 个做法

### 抄法 1：**身份双 ID 分离** —— `WorkflowId` / `RunId`（Temporal）+ `Change-Id`（Gerrit）

- **谁在用**：Temporal（每个 workflow 执行）；Gerrit（每次代码评审）。
- **具体机制**：
  - Temporal 官方文档：WorkflowId 是「a user-defined … value which typically carries some **business meaning**
    (such as an order number or customer number)」，且「all runs will have the same Workflow ID. However,
    **each run will have a unique system-generated Run ID**」；并明确警告
    「you **shouldn't rely on the current Run Id** in your code to make logical choices」。
  - Gerrit 官方文档：`Change-Id`「is the identity assigned to this change. **It is independent of the commit id.**
    … Gerrit can automatically associate a new version of a change back to its original review,
    **even across cherry-picks and rebases**.」
- **能不能直接借**：能，而且这是最省事的改法。**步骤 = 一个有稳定业务 ID 的逻辑实体；每次修订产生一个新的"执行序号/修订号"**。
  对外/对用户讲"第 3 步"时引用稳定 ID（如 `step-0042` 或 `s4`），展示序号（1、2、3…）**纯派生、不落库**。
  这样"第 4 步拆成两步"就不再是"编号漂移"问题，而是"逻辑实体 `s4` 现在展开成 `s4a`/`s4b` 两个子实体"——
  历史引用 `s4` 永远有效（指向 s4a，或标记为"已拆分，见 s4a/s4b"）。
  name 用 `drop`/`superseded` 而不是删除，编号永不回收。

### 抄法 2：**改未来不动过去 + 显式 ID 映射迁移**（Camunda Process Instance Migration）

- **谁在用**：Camunda 7/8（BPMN 引擎）、广大 BPM 系统；Temporal 的 patching 是同一思想的代码版。
- **具体机制**：
  - 定义侧：流程定义**版本化且不可变**；运行实例持有"我在哪个版本上"的指针，**不会自动升级**。
  - 迁移侧：改运行中实例必须提交**迁移计划**（`mappingInstructions`: `sourceActivityId → targetActivityId`），
    引擎只动"还没走过"的部分；活动元素映射到自己 ⇒ 该步骤的运行时状态（变量、作业、定时器订阅）**原样保留**；
    已有实例继续按原版本跑。
  - Temporal 的对应物：`patched("name")` 往 Event History 里**插一个 marker**——
    「During Replay, if a Worker encounters a history with that marker, it will fail the Workflow task when the
    Workflow code doesn't produce the same patch marker」。即**历史不可改写，改动只能在历史某一点上加门**，
    然后 `deprecate_patch()` 逐步退休。
- **能不能直接借**：**能，而且这是"计划修订"最该抄的骨架**。
  落成三条纪律：① 已 `done` 的步骤是**冻结区**，任何修订不得改写它的内容/结果（只能追加"补充说明"）；
  ② 修订 = 产生**新的计划版本**（`plan v3`），旧版本只读留档；③ 从 v2→v3 时对**未完成步骤**做显式映射
  （保留 id = 原地继续；换 id = 新实体 + 记录"取代了谁"；拆分的 = 保留原 id 作为父 + 派生两个子 id）。
  再加一条引擎级守卫：**跨类型/跨依赖方向的映射要么拒绝，要么强制走"显式修订登记"**（对着 Camunda 的
  "cannot map an element to an element of a different type"）。

### 抄法 3：**追加式事件流 + 稳定 ID + drop-not-delete**（file-planning/trailmap 的工程化实现）

- **谁在用**：DSH 市场插件 `file-planning`（`trailmap`）；本质上 git/Temporal 也是这套；DSH 的
  `todo_write` 快照流和 dsh-plan-plus 的版本数组是它的"宿主原生"版本。
- **具体机制**（全部已核实源码）：
  - 步骤 id = `<里程碑id>-<序号>`，**新增时取"当前最大序号 + 1"，删除/取消后不重编号**
    （`amendAddStep`：`const id = \`${m.id}-${maxN + 1}\``）；引用一律用 id（`depends: ["m1-1"]`）。
  - **取消用 `drop`（必须写原因，`dropReason`），不用删除** ⇒ 历史与叙事保留；还有 `reopen`
    （`done`/`cancelled` → `active`）支持返工。删除步骤只留"悬空依赖"由 `check` 报出。
  - 所有结构变更写**追加式 `events[]`**：`created/started/finished/dropped/reopened/amended/noted/journaled/closed`。
  - **发现 vs 任务的分离**：调研发现先进 `fieldnotes.md`（**不进计划、不占编号**），
    只有显式 `amend add-step` 才成为有编号的步骤 ⇒ 直接回答你的问题③。
  - **归档即冻结**：`close` 后任何结构变更被拒（`PLAN_CLOSED`）。
- **能不能直接借**：**能，几乎是完整答案的一半，且实现成本低**。要点就是"编号只增不改 + 取消不删 + 事件流兜历史"。
  它的**短板**（你要补的）：没有 diff/并排版本对比（只有时间线），以及 `amendRemoveStep` 会真的删掉节点、
  不留墓碑（对已 `done` 的步骤千万别用 remove，应该用 `drop`/`superseded`）。

> 备选第 4 个（如果只能抄三个之外还想加）：**执行序号派生而非存储** —— dsh-plan-board 用
> **Kahn 稳定拓扑序**从 DAG 现算 `topoOrder`（源码：模块依赖向下冒泡后重算），面板上显示的"执行序号"
> 从不落库。这样"改图后编号自动一致，永远不会出现两个第 3 步"。配合"节点 id 由调用方提供 + 查重"，
> 编号与身份彻底解耦。

---

## 4. 反面结论（业界**没**做的事，直说）

1. **AI agent 框架就是"重建计划、不保编号"**，这是常态不是缺陷：
   - LangGraph 官方 Plan-and-Execute：state 是 `plan: List[str]` + `past_steps: Annotated[List[Tuple], operator.add]`；
     `replan_step` 直接 `return {"plan": output.action.steps}`（**整表替换**）；replanner prompt 明确要求
     「**Do not return previously done steps as part of the plan**」——完成的工作被主动**踢出新计划**，
     只以 `past_steps` 文本形式留在上下文里。
   - 副作用：编号每轮从 1 重排（执行时构造 `f"{i+1}. {step}"` 并告诉模型"You are tasked with executing step 1"），
     **也就是说业界用"相对编号 + 只描述剩余工作"来回避编号漂移问题**，而不是解决它。
     （这是个真实可选策略：如果计划每一步都做完就没用了，"第几步"只在剩余计划内有意义。
     代价是无法引用历史步骤。）
2. **DSH 宿主不提供步骤身份**：`exit_plan_mode(plan: string)` 只收 markdown，且拒绝时抛的错是
   「The user chose to keep planning; **revise the plan and present it again**」——原生语义就是"再交一份完整计划"。
   `todo_write` 的 item schema 是 `additionalProperties: false` 的 `{content, status}`，**没有 id**，
   唯一性约束落在 `content` 字符串上（重复 content 直接报错）。⇒ 想保编号，插件层必须自己发 ID。
3. **"计划版本对比"这件事，整个 DSH 插件市场只有 1 个插件真做了**：3852 条目录按
   修订/版本/历史/对比/留档/diff/replan/revise 等关键词交叉筛选后，只有 `dsh-plan-plus` 明确宣称
   "回看、对比、编辑和留档每一版计划"。它的实现很轻：**扫描会话日志里全部 `exit_plan_mode` 的
   `tool/call` 事件 → 版本数组 v1…vN → 手写 LCS 行级 diff**，且**完全不做步骤级身份**（计划是整篇 markdown）。
   ⇒ 结论：**"版本对比"这件事业界的成熟度远低于"版本化"**；你把版本对比做出来就已经领先这个生态。
4. **经典规划理论的立场（据我目前核实到的证据）**：plan repair 与 replanning 的取舍是有经典结论的，
   但那是"从零重算 vs 修补旧计划"的**效率/稳定性**之争，**不是"保不保步骤身份"**——
   经典规划里 plan 本身是动作序列，没有"任务实体 ID"这个概念。详见 §5、§6。

---

## 5. 证据清单（一手来源）

### 5.1 本地只读核对（DSH 宿主，源码）

| 结论 | 出处 | 类型 |
|---|---|---|
| `exit_plan_mode` 参数是 `plan: string`（markdown，必须 `#` 开头）；拒绝时抛"revise the plan and present it again" | `…\app.asar.unpacked\node_modules\@deepseek-ai\dsh-plan-mode\lib\index.js`（常量 `EXIT_PLAN_MODE`、`EXIT_DESCRIPTION`、`execute()`） | 源码 ✅ |
| plan mode 有 `plan` session projection（`stateVersion: 3`），`plan/mode` 事件追加进会话日志 ⇒ resume/fork 可恢复 | 同上（`planProjectionDefinition`） | 源码 ✅ |
| `todo_write` 是整表替换（"Send the ENTIRE list every call — it REPLACES the previous list"），item schema `{content, status}`、`additionalProperties: false`、**无 id**，content 必须唯一；每次 append `todo/write` 快照，replay last-write-wins；`turn/start` 把投影清成 null | `…\node_modules\@deepseek-ai\dsh-tool-todo\lib\index.js` | 源码 ✅ |
| `file-planning`：id 分配 `maxN+1`、`drop` 带原因、`reopen`、`amend{add-step,remove-step,add-milestone,retitle-step,retitle-milestone}`、`events[]` 类型集、`PLAN_CLOSED`、`fieldnotes` 与计划分离 | `github.com/JohnXu22786/file-planning`：`lib/machine.js`（L301-372）、`docs/format.md`、`skill/trailmap/SKILL.md`、`examples/demo-workspace/.trail/map.json` | 源码 ✅ |
| `dsh-plan-plus`：版本 = 会话日志里全部 `exit_plan_mode` 的 `tool/call`，返回 `{plan, plans[]}`；行级 diff（手写 LCS）；编辑留档为新版本存 localStorage(`dsh.planPlus.v1.edits`)；宿主半仅注册一个 HTTP 路由 `/planx-latest-plan` | `github.com/lsdt45/dsh-plan-plus`：`index.mjs`、`README.md` | 源码 ✅ |
| `dsh-plan-board`：节点 `id` 查重（`DUP_ID`）、`deps` 用 id、`version: number` 乐观锁 + SHA-256 digest、`pendingApprovals` + `EditOp[]`、`topoOrder` 从 DAG 现算（Kahn 稳定序，含模块依赖冒泡） | `github.com/hoyyang/dsh-plan-board`：`src/schema.ts`、`docs/DESIGN.md` | 源码 ✅ |
| `dsh-plan-lattice`：执行合同有 `id` + `revision`（`ContractReceipt`/`ContractRecord`），receipt 过期判 stale | `github.com/1052326311/dsh-plan-lattice`：`src/contract.ts` | 源码 ✅ |
| `dsh-routing-suite`（graded 模式）：任务用 `(level, title)` 定位；`Item.status: pending/in_progress/completed`；门控"进 develop 后 spec/accept/verify/star 只读，`do` 可改且走修订登记"；工具 `commit_star/edit_plan/lock_stage/mark_task/redteam_verdict` | `github.com/yjh051108/dsh-routing-suite`：`graded/docs/spec-3.1.md` | 源码/设计文档 ✅ |
| `dsh-plan-and-execute`：步骤身份 = 数组下标（`stepIndex` 1-based，todo 文案 `${index+1}. ${title}`），控制流状态写 `planDir/orchestrator.json` 而非会话日志 | `github.com/jimmyzhang219/dsh-plan-and-execute`：`src/state.ts` | 源码 ✅ |
| 插件市场关键词扫描：3852 条中只有 `dsh-plan-plus` 命中"修订计划/版本/对比/留档"语义 | `<工作区>\market_mirror\plugins.json` + 只读检索脚本 | 一手数据 ✅ |

### 5.2 联网核对

| 结论 | 出处（URL） | 类型 |
|---|---|---|
| LangGraph Plan-and-Execute：`plan: List[str]`、`past_steps: Annotated[List[Tuple], operator.add]`、`replan_step` 整表替换、replanner prompt 要求"不要把已完成的步骤写回计划"、执行时按 `plan[0]` 取下一步 | [langgraph 官方 notebook（归档 commit 23961cf）](https://github.com/langchain-ai/langgraph/blob/23961cff61a42b52525f3b20b4094d8d2fba1744/docs/docs/tutorials/plan-and-execute/plan-and-execute.ipynb) | 官方源码 ✅ |
| 该 notebook 已移出仓库、目录仅存档，指向 [docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/overview) | 仓库内 `examples/plan-and-execute/plan-and-execute.ipynb` 的 move 说明 | 源码 ✅ |
| Temporal：WorkflowId（业务身份，多次 run 相同）vs RunId（每次执行唯一、系统生成）；"不要用 RunId 做逻辑判断"；ContinueAsNew/Retry/Reset 会产生新的 run，`first_execution_run_id` 记链首 | [docs.temporal.io/workflow-execution/workflowid-runid](https://docs.temporal.io/workflow-execution/workflowid-runid) | 官方文档 ✅ |
| Temporal：确定性约束；`patched()` 在 Event History 插 marker，replay 时若代码不产生同一 marker 则 task 失败；三步生命周期 patched → `deprecate_patch()` → 移除；备选方案是"复制成新 Workflow 类型做 cutover"，官方指出它「does not provide a way to version any still-running Workflows」 | [docs.temporal.io/develop/python/workflows/versioning](https://docs.temporal.io/develop/python/workflows/versioning) | 官方文档 ✅ |
| Camunda 8：Process Instance Migration 定义、migration plan + mapping instructions、改 inactive 部分不动 active 元素、"cannot map an element to an element of a different type"、变量/用户任务/作业保留、可与 modification 二选一、可前进可回退可跨定义 | [docs.camunda.io/docs/components/concepts/process-instance-migration](https://docs.camunda.io/docs/components/concepts/process-instance-migration/) | 官方文档 ✅ |
| Gerrit：Change-Id 是"change 的身份，independent of the commit id"，跨 amend/cherry-pick/rebase 关联同一 review；匹配需 Change-Id + 仓库名 + 分支名；由客户端 `commit-msg` hook 生成 | [GerritCodeReview/gerrit: Documentation/user-changeid.txt](https://github.com/GerritCodeReview/gerrit/blob/master/Documentation/user-changeid.txt) | 官方源码文档 ✅ |
| claude-task-master：ID 形态 `1` / `1.2` / `1.2.3`（多级子任务）、API 显示 ID `HAM-1` 内部归一化；`TASK_ID_PATTERN = /^(\d+(\.\d+)*|[A-Za-z]+-?\d+)$/`；子任务 id 在父任务内唯一 | [eyaltoledano/claude-task-master: task-id.ts](https://github.com/eyaltoledano/claude-task-master/blob/main/packages/tm-core/src/modules/tasks/validation/task-id.ts) | 官方源码 ✅ |
| claude-task-master：任务字段 `id/title/status/dependencies/subtasks`，status 含 `pending/in-progress/done/review/deferred/cancelled`；subtask 的 `dependencies` 可引用其他子任务或主任务 | [docs/task-structure.md](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md) | 官方文档 ✅ |
| claude-task-master：跨 tag 移动任务有 `--with-dependencies` / `--ignore-dependencies`，配 `validate-dependencies` / `fix-dependencies` | [docs/cross-tag-task-movement.md](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/cross-tag-task-movement.md) | 官方文档 ✅ |

**本机通道备忘**（写给下一个调研会话）：`developers.openai.com` 403；`gerrit-review.googlesource.com`
连不上（HTTP 000，改用 GitHub 镜像 `GerritCodeReview/gerrit` 取一手文档）；**`cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`
是本机最稳的取文件通道，支持分支、tag、commit SHA**（ungh.cc 只给元数据+文件树，不给单文件内容）。

---

## 6. 【线 2 / 线 3 / 线 4 其余部分：待补】

- 线 2（框架）：smolagents `planning_interval`（`<plan>`/`<facts>`）、AutoGen Magentic-One 的
  Task Ledger / Progress Ledger、BabyAGI 的 task_id 分配、Claude Code plan mode + TodoWrite schema、
  OpenHands、CrewAI planning、AutoGPT classic、ReWOO、AdaPlanner —— *待子调研回填*。
- 线 3（经典规划）：plan repair vs replanning from scratch（Fox/Gerevini/Long/Serina 等）、
  HTN plan repair、PDDL replanning 形式化、bold/cautious commitment、goal reasoning/GDA、
  plan distance 度量 —— *待子调研回填*。
- 线 4（其余）：Airflow DAG versioning 现状、git rename 检测/`--follow`/`notes`、
  Yjs `RelativePosition` / Automerge cursor / RGA-Logoot-LSEQ —— *待子调研回填或标"未核实"*。
