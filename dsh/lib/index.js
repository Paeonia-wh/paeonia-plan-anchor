// dsh-plan-anchor · 计划锚（防漂移护栏）
//
// 解决的真实痛点（用户原话）：
//   "已经按一定的规划规划好了，执行其中一个规划的时候又发现了很多其他的问题，
//    然后就一路沿着其他的问题进行下去了，导致其他的规划全忘记了，并且混乱了。"
//
// 根因（不是"没记下来"，而是"再也没被读"）：
//   1. 计划活在易失的对话上下文里；新发现的问题具体、当下、有明确解法，
//      计划里的后续步骤抽象、遥远 —— 注意力天然被后者劫持。
//   2. 已有任务库（dsh-task-tracker）是**被动**的：只有主动查才输出。
//      而漂移的定义恰恰就是"没人去查"。它也没有 WIP 上限、不区分
//      "计划内步骤"与"计划外发现"、没有"我现在在第几步"的位置指针、
//      更不介入"即将偏离的那一刻"。
//
// 本插件补的正是这四样：持久锚 + 泊位队列 + 回合自动重放 + 代码强制的不变量。
//
// 设计依据（调研笔记见 DESIGN.md 的「设计证据」一节）：
//   liza ADR-0039 逐字："security constraints belong in code, not in prompt instructions"
//   → 凡能用代码强制的不变量，绝不退化成提示词要求。见文件末尾不变量表。
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const name = "plan-anchor";
const inject = ["tools"];

/** 计划内步骤的状态域（闭合枚举，非法值一律拒绝）。 */
const STEP_STATUSES = ["pending", "active", "done", "skipped", "blocked"];
/** 泊位条目的状态域。parked = 仍在泊位；其余为已关闭（两个正当终态：done 做了 / declined 判定不做）。 */
const PARK_STATUSES = ["parked", "escalated", "done", "declined"];
/** 会被漂移预算计数的"计划进展"类工具——只有它们能把预算清零。 */
const PROGRESS_TOOLS = new Set(["plan_step_done", "plan_set", "plan_goto"]);
/** 完全不参与预算计数的工具（查询类不推进也不消耗）。 */
const NEUTRAL_PREFIX = "plan_";
/** 偏离步骤在排序上的偏移量：detour 永远排在计划步骤之后，不扰动计划顺序。 */
const DETOUR_ORD_BASE = 10000;

const Config = z.object({
	path: z.string(),
	driftThreshold: z.number().default(12),
	escalateAt: z.number().default(24),
	detourBudget: z.number().default(3),
	refuseCap: z.number().default(5),
	scopeMode: z.string().default("observe"),
	completionGate: z.boolean().default(true),
	watchTools: z.array(z.string()).default(["task_create", "todo_write", "subagent", "workflow"]),
	turnAnchor: z.boolean().default(true)
});

// ---------- 存储 ----------

let db = null;
function open(config) {
	if (!db) {
		mkdirSync(dirname(config.path), { recursive: true });
		db = new DatabaseSync(config.path);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec(`
			CREATE TABLE IF NOT EXISTS plans (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				title TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 1,
				status TEXT NOT NULL DEFAULT 'active',
				reason TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				superseded_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS steps (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL,
				ord INTEGER NOT NULL,
				detour_no INTEGER NOT NULL DEFAULT 0,
				text TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'plan',
				from_park INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'pending',
				evidence TEXT NOT NULL DEFAULT '',
				started_at INTEGER,
				done_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS parking (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL,
				text TEXT NOT NULL,
				from_step INTEGER NOT NULL DEFAULT 0,
				blocking INTEGER NOT NULL DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'parked',
				note TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				closed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS ledger (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				kind TEXT NOT NULL,
				plan_id INTEGER NOT NULL DEFAULT 0,
				step_id INTEGER NOT NULL DEFAULT 0,
				ref TEXT NOT NULL DEFAULT '',
				detail TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS runtime (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			-- 按 plan_id 归属的运行态。隔离由 plan_id 天然保证：
			-- 计划已经按 scope（工作目录）分开，所以挂在计划上的指针/计数自动跟着隔离，
			-- 不需要再给每个键加作用域前缀（那样容易漏、也容易在并发会话间串味）。
			CREATE TABLE IF NOT EXISTS plan_state (
				plan_id INTEGER NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				PRIMARY KEY (plan_id, key)
			);
			-- scope 判决的观察记录（append-only）。先只观察不拦，靠它统计误报率；
			-- 误报率降下来之前，任何"硬拦"都是拍脑袋。
			CREATE TABLE IF NOT EXISTS verdicts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				plan_id INTEGER NOT NULL,
				step_id INTEGER NOT NULL DEFAULT 0,
				ts INTEGER NOT NULL,
				tool TEXT NOT NULL,
				verdict TEXT NOT NULL,
				target TEXT NOT NULL DEFAULT ''
			);
		`);
		// 迁移：老库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
		const addCol = (table, col, ddl) => {
			const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
			if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
		};
		addCol("steps", "detour_no", "detour_no INTEGER NOT NULL DEFAULT 0");
		// 操作级 cue：这一步"怎么做才算做完"（Rubinstein 2001：切换代价随 task cuing 下降）
		addCol("steps", "acceptance", "acceptance TEXT NOT NULL DEFAULT ''");
		// 这一步"允许动什么"（JSON 数组）：由代码自动判决是否越界，先只观察
		addCol("steps", "scope_files", "scope_files TEXT NOT NULL DEFAULT ''");
		addCol("steps", "scope_commands", "scope_commands TEXT NOT NULL DEFAULT ''");
		// 计划谱系：一条谱系 = 同一个目标的一串计划版本。**额外步骤编号与完成继承都按谱系算**，
		// 而不是按"这一版计划"——否则每次改计划，已完成的进度和额外步骤编号都会断掉。
		addCol("plans", "lineage_id", "lineage_id INTEGER NOT NULL DEFAULT 0");
		db.prepare("UPDATE plans SET lineage_id = id WHERE lineage_id = 0").run();
		// 被丢弃的步骤（drop）：标记 + 理由，**不删行**，历史可查
		addCol("steps", "drop_reason", "drop_reason TEXT NOT NULL DEFAULT ''");
		// 最近一次修订的提示（供锚行回答"编号是不是变了"），回合边界清一次
		addCol("steps", "revision_note", "revision_note TEXT NOT NULL DEFAULT ''");
		// 熔断放行的标记：被"磨"过去的完成必须在主视图上看得见，而不是只躺在台账里
		addCol("steps", "forced", "forced INTEGER NOT NULL DEFAULT 0");
		// 返工指向：这一步是在重做**哪一步**的产出（"做到第 3 个规划时发现第 1 个规划做错了"）
		addCol("steps", "rework_of", "rework_of INTEGER NOT NULL DEFAULT 0");
		// 台账记下"谁干的"（同目录多会话时能分清）
		addCol("ledger", "session", "session TEXT NOT NULL DEFAULT ''" );
		// 多项目隔离：每个计划记下它是在哪个工作目录里立的
		addCol("plans", "scope", "scope TEXT NOT NULL DEFAULT ''");
		// 重启条件（ready-to-resume 干预：光是"记下问题"不够，必须连"怎么回来"一起记）
		addCol("parking", "resume_when", "resume_when TEXT NOT NULL DEFAULT ''");
		addCol("parking", "resume_after_ord", "resume_after_ord INTEGER NOT NULL DEFAULT 0");
		// 回程票改按**步骤身份**存：序号会因插入/丢弃而顺延，指向序号 = 会在错误的时机响
		addCol("parking", "resume_after_step_id", "resume_after_step_id INTEGER NOT NULL DEFAULT 0");
		// 一次性迁移：老的全局 runtime 指针 → 按 plan_id 归属的 plan_state，搬完清空 runtime
		const legacy = db.prepare("SELECT key, value FROM runtime").all();
		if (legacy.length) {
			const ap = legacy.find((r) => r.key === "active_plan");
			const pid = ap ? Number(ap.value) : 0;
			if (pid && db.prepare("SELECT 1 AS x FROM plans WHERE id = ?").get(pid)) {
				const ins = db.prepare("INSERT OR IGNORE INTO plan_state (plan_id, key, value) VALUES (?,?,?)");
				for (const r of legacy) if (r.key !== "active_plan") ins.run(pid, r.key, r.value);
			}
			db.exec("DELETE FROM runtime");
		}
	}
	return db;
}

const now = () => Date.now();

// ---------- 隔离作用域 ----------

/**
 * 会话工作目录 = 隔离作用域。取法与 DSH 自己的文件工具一致：
 * `exec.agent?.session.header.cwd`（源码注释逐字："the agent's per-session workspace … so each
 * session's read/write/edit act on its workspace, not the server's launch directory"）。
 * 语义：**同一个项目的不同会话共享同一份计划**（计划属于项目，不属于窗口）；
 * 不同项目各自一套，互不串。拿不到 cwd（非 agent 调用、测试桩）时退化为默认作用域 ""。
 */
function scopeOf(exec) {
	const a = exec && exec.agent;
	const cwd = a && a.session && a.session.header && a.session.header.cwd;
	if (typeof cwd !== "string" || !cwd) return "";
	if (scopeCache.has(cwd)) return scopeCache.get(cwd);
	let p = cwd.trim();
	if (process.platform === "win32") {
		// 同一个目录会被写成很多种样子：D:\x、D:/x、D:\x\、D:\x\.、\\?\D:\x、junction 路径……
		// 任何两种被当成不同作用域 = 护栏**静默失明**，所以这里逐个归一化。
		p = p.replace(/^\\\\\?\\/, "").replace(/^\\\\\.\\/, "");
		p = p.replaceAll("/", "\\").replace(/\\{2,}/g, "\\");
		p = p.replace(/(\\\.)+\\?$/, "").replace(/\\+$/, "");
		p = p.toLowerCase();
		// 符号链接 / junction 解析到真实路径（不存在就退回原值——不能因为路径还没建就失明）
		try { p = realpathSync.native(p).replace(/\\+$/, "").toLowerCase(); } catch { /* 保持原样 */ }
	} else {
		p = p.replace(/\/+$/, "");
	}
	scopeCache.set(cwd, p);
	return p;
}
/** 作用域解析缓存：避免每次工具调用都做一次 realpath 系统调用。 */
const scopeCache = new Map();

// ---------- 按 plan 归属的运行态 ----------

function stGet(d, planId, key, fallback = null) {
	const row = d.prepare("SELECT value FROM plan_state WHERE plan_id = ? AND key = ?").get(planId, key);
	return row ? row.value : fallback;
}
function stSet(d, planId, key, value) {
	d.prepare("INSERT INTO plan_state (plan_id, key, value) VALUES (?,?,?) ON CONFLICT(plan_id, key) DO UPDATE SET value = excluded.value")
		.run(planId, key, String(value));
}
function stDel(d, planId, key) {
	d.prepare("DELETE FROM plan_state WHERE plan_id = ? AND key = ?").run(planId, key);
}

/** 自动写台账：状态迁移的留痕由代码产生，不接受 agent 手工填写。 */
function log(d, kind, { planId = 0, stepId = 0, ref = "", detail = "", session = "" } = {}) {
	d.prepare("INSERT INTO ledger (ts, kind, plan_id, step_id, ref, detail, session) VALUES (?,?,?,?,?,?,?)")
		.run(now(), kind, planId, stepId, ref, detail, String(session));
}
/** 会话标识：同一个 agent 对象复用同一个短号（进程内稳定，不依赖宿主给字段）。 */
const agentKeys = new WeakMap();
let agentSeq = 0;
function sessionKeyOf(agent) {
	if (!agent || typeof agent !== "object") return "";
	if (!agentKeys.has(agent)) agentKeys.set(agent, `s${++agentSeq}`);
	return agentKeys.get(agent);
}

/**
 * 当前作用域（工作目录）里生效的计划。
 * 不再依赖一行全局指针，而是直接按 (status, scope) 查——指针是派生的，
 * 查出来的一定自洽：项目 A 与项目 B 各有各的 active 计划，互不覆盖。
 */
function activePlan(d, scope = "") {
	return d.prepare("SELECT * FROM plans WHERE status = 'active' AND scope = ? ORDER BY id DESC LIMIT 1").get(scope) || null;
}
function stepById(d, id) {
	return d.prepare("SELECT * FROM steps WHERE id = ?").get(Number(id)) || null;
}
function currentStep(d, planId) {
	const id = stGet(d, planId, "current_step");
	return id ? stepById(d, Number(id)) : null;
}
function planSteps(d, planId) {
	// 只返回"活着"的主线步骤（不含被 drop 的）：总数 n、找下一个待办都该用它
	return d.prepare("SELECT * FROM steps WHERE plan_id = ? AND kind = 'plan' AND status != 'dropped' ORDER BY ord ASC").all(planId);
}
/** 含已丢弃的主线步骤（只给显示用，好让"这里原本有一步"看得见）。 */
function planStepsAll(d, planId) {
	return d.prepare("SELECT * FROM steps WHERE plan_id = ? AND kind = 'plan' ORDER BY ord ASC").all(planId);
}
function detourSteps(d, planId) {
	return d.prepare("SELECT * FROM steps WHERE plan_id = ? AND kind = 'detour' ORDER BY detour_no ASC, id ASC").all(planId);
}


// ---------- 编号体系：把"引用一个步骤/泊位"收口到一处 ----------
//
// 为什么要有这一层（它不是洁癖，是被现场教出来的）：
//   以前 7 个工具各自 `stepById(d, args.step_id)`，于是**「第 1 步」（序号）和「id=28」（身份）
//   被当成了同一个东西**——而界面上这两套数字是并排显示的（`主线第 1 步(id=28)`）。
//   结果：**作者本人在两轮之内填错了两次**（`after_step_id: 9`、`after_step_id: 1` 全被拒）。
//   所以：输入收人话（序号）也收身份（id）；**查 id 优先**，查不到才退到序号，且**明确说明**按什么理解；
//   解析不了就给"教会人"的报错，附上序号↔id 对照表。

/** 泊位序号：给用户看的连续编号（1、2、3…）。泊位的数据库 id 是不连续的，两者混在一起最容易填错。 */
function parkingOrd(d, planId, parkId) {
	const all = d.prepare("SELECT id FROM parking WHERE plan_id=? ORDER BY id").all(planId);
	const i = all.findIndex((r) => Number(r.id) === Number(parkId));
	return i >= 0 ? i + 1 : 0;
}
function parkingByOrd(d, planId, ord) {
	const all = d.prepare("SELECT id FROM parking WHERE plan_id=? ORDER BY id").all(planId);
	const r = all[Number(ord) - 1];
	return r ? d.prepare("SELECT * FROM parking WHERE id=?").get(r.id) : null;
}
/** 泊位的显示名：用**序号**，不用数据库 id。 */
function parkLabel(d, p) {
	const o = parkingOrd(d, p.plan_id, p.id);
	return o ? `泊位 ${o}` : `泊位(${p.id})`;
}

/** 步骤引用解析：id 优先、序号兜底、都失败就给出教会人的报错。 */
function resolveStep(d, plan, args, idKey = "step_id", ordKey = "step_ord") {
	const id = Number(args[idKey] || 0);
	const ord = Number(args[ordKey] || 0);
	if (id) {
		const s = stepById(d, id);
		if (s && s.plan_id === plan.id) return { step: s, how: "id" };
		// 【兜底·现场教出来的】id 查不到 → 试试它是不是"第几步"的序号。
		// 为什么敢这样：查 id 优先，只有**没有任何步骤**的 id 等于它时才退到序号，所以不会误伤；
		// 而且会**明确说明**按什么理解 —— 不静默改写。
		const byOrd = planStepsAll(d, plan.id).find((x) => x.kind === "plan" && Number(x.ord) === id);
		if (byOrd) {
			return {
				step: byOrd,
				how: "ord-fallback",
				note: `ℹ \`${idKey}=${id}\` 不是任何步骤的 id；我按**主线第 ${id} 步**理解（它的 id 是 ${byOrd.id}）。要精确引用请填 id，或改用 \`${ordKey}\`。`
			};
		}
	}
	if (ord) {
		const s = planStepsAll(d, plan.id).find((x) => x.kind === "plan" && Number(x.ord) === ord);
		if (s) {
			return {
				step: s,
				how: "ord",
				note: id ? `ℹ 你填的 ${idKey}=${id} 不是任何步骤的 id；我按**主线第 ${ord} 步**理解（它的 id 是 ${s.id}）。` : ""
			};
		}
	}
	const map = planSteps(d, plan.id).map((s) => `第${s.ord}步→${s.id}`).join("、");
	return {
		error: [
			`找不到要引用的步骤（${idKey}=${id || "—"}${ord ? `、${ordKey}=${ord}` : ""}）。`,
			"⚠ **注意：`*_step_id` 要的是 id（形如 28），不是「第几步」的序号（形如 1）—— 两者不一样。**",
			`   两个办法：填 id，或者直接填序号参数 \`${ordKey}\`。`,
			map ? `   当前主线对照：${map}` : ""
		].filter(Boolean).join("\n")
	};
}

/** 泊位引用解析：同上（id 优先、序号兜底）。 */
function resolvePark(d, plan, args, idKey = "park_id", ordKey = "park_ord") {
	const id = Number(args[idKey] || 0);
	const ord = Number(args[ordKey] || 0);
	if (id) {
		const p = d.prepare("SELECT * FROM parking WHERE id=?").get(id);
		if (p && p.plan_id === plan.id) return { park: p, how: "id" };
		// 兜底：id 查不到 → 试试它是不是"泊位 N"里的序号
		const byOrdP = parkingByOrd(d, plan.id, id);
		if (byOrdP) {
			return {
				park: byOrdP,
				how: "ord-fallback",
				note: `ℹ \`${idKey}=${id}\` 不是任何泊位的 id；我按**${parkLabel(d, byOrdP)}**理解。`
			};
		}
	}
	if (ord) {
		const p = parkingByOrd(d, plan.id, ord);
		if (p) return { park: p, how: "ord", note: id ? `ℹ 你填的 ${idKey}=${id} 不是任何泊位的 id；我按**${parkLabel(d, p)}**理解。` : "" };
	}
	const list = d.prepare("SELECT id FROM parking WHERE plan_id=? ORDER BY id").all(plan.id)
		.map((r, i) => `泊位${i + 1}→${r.id}`).join("、");
	return {
		error: [
			`找不到要引用的泊位（${idKey}=${id || "—"}${ord ? `、${ordKey}=${ord}` : ""}）。`,
			"⚠ **注意：泊位在界面上显示的是序号（泊位 1、2、3…），而 `*_park_id` 要的是数据库 id —— 两者不一样。**",
			`   两个办法：填 id，或者直接填序号参数 \`${ordKey}\`。`,
			list ? `   当前对照：${list}` : "   （当前计划没有泊位条目。）"
		].filter(Boolean).join("\n")
	};
}

/** 每个工具有哪些"id / 序号"参数对。（回程票那对不在此列：plan_discover 内部已经两套都收。） */
const REF_PAIRS = [
	["step_id", "step_ord"],
	["after_step_id", "after_ord"],
	["park_id", "park_ord"]
];

/** 所有工具的 exec 都过这里：把序号归一成 id，并把"我按什么理解"的说明附在回执上。 */
function withRefs(d, args, scope, fn) {
	let a = args || {};
	const notes = [];
	try {
		const plan = activePlan(d, scope);
		if (plan) {
			for (const [idKey, ordKey] of REF_PAIRS) {
				const hasId = Number(a[idKey] || 0) !== 0;
				const hasOrd = Number(a[ordKey] || 0) !== 0;
				if (!hasId && !hasOrd) continue;
				const r = idKey.startsWith("park")
					? resolvePark(d, plan, a, idKey, ordKey)
					: resolveStep(d, plan, a, idKey, ordKey);
				if (r.error) return { ok: false, reason: r.error };
				const target = r.step || r.park;
				if (target) a = { ...a, [idKey]: target.id };
				if (r.note) notes.push(r.note);
			}
		}
	} catch (e) {
		// P4：护栏自身出错必须可见，但不阻断主流程
		console.error("[plan-anchor] 引用解析出错（已跳过归一）:", e);
	}
	const out = fn(d, a, scope);
	if (notes.length && out && typeof out === "object" && typeof out.briefing === "string") {
		return { ...out, briefing: out.briefing + "\n" + notes.join("\n") };
	}
	return out;
}

function openParking(d, planId) {
	return d.prepare("SELECT * FROM parking WHERE plan_id = ? AND status = 'parked' ORDER BY id ASC").all(planId);
}
/**
 * 「回程票到期」的泊位：它指的是**某一步**（按 step id，不按序号——序号会顺延），那一步做完了就该回来处理。
 * 这是 ready-to-resume 干预的落地——**回程不靠记忆，靠代码在他走到那一步时主动举手**。
 */
function dueParking(d, planId) {
	const list = openParking(d, planId);
	if (!list.length) return [];
	const statusByOrd = new Map(planSteps(d, planId).map((s) => [s.ord, s.status]));
	return list.filter((p) => {
		const sid = Number(p.resume_after_step_id) || 0;
		if (sid) {
			const s = stepById(d, sid);
			return s && s.status === "done"; // 按身份判：中间插入/丢弃都不会让它指错
		}
		const ord = Number(p.resume_after_ord) || 0;
		if (!ord) return false;
		return statusByOrd.get(ord) === "done"; // 老的按序号记的，保底仍可用
	});
}
/** 回程票的人类可读描述：用该步骤**当前**的序号，所以编号顺延后它自己会更正。 */
function resumeLabel(d, p) {
	const sid = Number(p.resume_after_step_id) || 0;
	if (sid) {
		const s = stepById(d, sid);
		if (s) {
			const stale = Number(p.resume_after_ord) && Number(p.resume_after_ord) !== s.ord
				? `（原来写的是第 ${p.resume_after_ord} 步）` : "";
			return `主线第 ${s.ord} 步之后${stale}`;
		}
	}
	return p.resume_after_ord ? `主线第 ${p.resume_after_ord} 步之后` : "";
}
function setCurrent(d, planId, stepId) {
	if (stepId) {
		stSet(d, planId, "current_step", stepId);
		// 焦点一变就重置"本步工作痕迹"计数器 —— 语义是"自本步开始以来"
		stSet(d, planId, "step_calls", 0);
		stSet(d, planId, "step_user_turns", 0);
	} else {
		stDel(d, planId, "current_step");
	}
}
/** 本步开始以来留下的工作痕迹（工具调用 + 用户回合）。用于挡住"零动作声称完成"。 */
function workTrace(d, planId) {
	return {
		calls: Number(stGet(d, planId, "step_calls", "0")),
		turns: Number(stGet(d, planId, "step_user_turns", "0"))
	};
}
/** 偏离额度：每完成一个计划步骤回血 1 点（封顶 detourBudget）。额度不是禁令，是可见的代价。 */
function detourUsed(d, planId) {
	return Number(stGet(d, planId, "detour_used", "0"));
}

/**
 * 熔断（有限纠偏预算）：同一 (工具, 步骤) 连续被拒 `cap` 次后，改为**放行 + 上报**。
 *
 * 依据一（工程共识）：四家厂商的实测实现**全都**设了硬上限——
 *   Claude Code Stop hook「8 consecutive blocks」；auto mode 分类器「3 times in a row or 20 times total」；
 *   Cursor `loop_limit` 5；Copilot `agentStop` 8；planning-with-files `PWF_GATE_CAP` 20；oh-my-agent 5。
 *   → 强制力是"有限纠偏预算"，不是"绝对约束"。而 DSH 的 hooks 桥**不提供任何上限**，必须自己实现。
 * 依据二（诚实筛选）：anthropics/claude-plugins-official#5312 逐字
 *   "An agent willing to falsely claim completion would have escaped in one turn.
 *    The failure mode selects against honesty."
 *   → 无上限的硬拦会卡死**诚实**报告"我卡住了"的 agent，而谎报者一轮就溜了。
 *
 * 所以上限到了就放行，但把"这是熔断放行"写进台账：状态迁移**可见**，而不是卡死或悄悄溜过。
 * 返回 null = 放行；返回对象 = 继续拒绝（并告知这是第几次、还有几次到上限）。
 */
function refuseOrRelease(d, planId, tool, stepId, cap, refusal, session = 0) {
	// 【批2-D】计数按 (会话, 工具, 步骤) 分：否则同目录两个会话各拒 2 次就会一起磨到上限
	const key = `refuse:s${session}:${tool}:${stepId}`;
	const n = Number(stGet(d, planId, key, "0")) + 1;
	if (n >= cap) {
		stDel(d, planId, key);
		return null; // 放行（由调用方写 cap_reached 台账）
	}
	stSet(d, planId, key, n);
	// 每次拒绝都进台账：若有人靠"磨到熔断"来过关，痕迹会明明白白留在那里
	log(d, "refused", {
		planId, stepId, ref: tool, session,
		detail: `第 ${n}/${cap} 次被拒：${String(refusal.reason || "").split("\n")[0].slice(0, 70)}`
	});
	return {
		...refusal,
		refusal_count: n,
		refuse_cap: cap,
		refuse_hint: `这是第 ${n}/${cap} 次被拒。连续被拒满 ${cap} 次后本关会**自动放行并记为熔断**（不会把你卡死）——届时台账会留下"强制放行"的记录。`
	};
}
/** 关卡通过 → 清掉该 (工具, 步骤) 的连续拒绝计数。 */
function clearRefusal(d, planId, tool, stepId, session = 0) {
	stDel(d, planId, `refuse:s${session}:${tool}:${stepId}`);
}
function budget(d, planId) {
	return Number(stGet(d, planId, "budget", "0"));
}
function setBudget(d, planId, n) {
	stSet(d, planId, "budget", Math.max(0, n));
}
function muteLeft(d, planId) {
	return Number(stGet(d, planId, "mute", "0"));
}

// ---------- scope 判决（先只观察，不拦） ----------
//
// 目的：补上护栏目前最大的盲区 —— 它能看状态/计数/字段，但**看不见内容**。
// "嘴上说在做第 2 步、手上在干第 5 步的事"这条路它现在挡不住。
// 做法：给步骤声明"允许动什么"（files/commands），由代码自动判决。**先只观察**，
// 靠 verdicts 表统计误报率；误报率降下来之前谈"硬拦"都是拍脑袋。
// 若将来要升级成真硬拦，唯一"连用户也绕不过"的层级是 PreToolUse 的 deny
// （官方逐字：blocks the tool even in bypassPermissions mode），而不是 post 层。

/** `*` 通配 → 锚定正则（其余正则元字符按字面处理）。 */
function globToRe(pattern) {
	const escaped = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
	return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "i");
}
function parseList(json) {
	if (!json) return [];
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : [];
	} catch { return []; }
}
/**
 * 从一次工具调用的参数里抽出"候选目标"：像路径的字符串 + 命令字符串。
 * 判据故意偏宽（宁多抽不漏抽）——observe 档里多抽只是统计噪声，漏抽会让统计系统性偏乐观。
 */
function extractTargets(args) {
	const paths = [];
	const commands = [];
	const seen = new Set();
	const walk = (v, key) => {
		if (typeof v === "string") {
			if (/^(command|cmd|script|shell)$/i.test(key)) { commands.push(v); return; }
			if (v.length > 400 || v.includes("\n")) return;
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return; // URL 不算文件
			const looksPath = /[\\/]/.test(v)
				|| /\.(js|mjs|cjs|ts|tsx|json|ya?ml|md|txt|py|ps1|sh|db|sql|html|css|toml|ini|env|log|xml|csv|lock)$/i.test(v);
			if (looksPath && !seen.has(v)) { seen.add(v); paths.push(v); }
			return;
		}
		if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
		if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
	};
	walk(args, "");
	return { paths, commands };
}

/** 只读类工具：越界**读**只算低危，不算 out-of-scope —— 否则误报率会高得没法看。 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "read_document", "read_image", "list_dir", "find"]);
/** 该工具是否"会动东西"（写文件 / 跑命令）。判 scope 只对它们算越界。 */
function isMutating(toolName) {
	if (READ_ONLY_TOOLS.has(toolName)) return false;
	if (/^(plan_|memory_|canvas_|skill_|task_(list|ready|snapshot|rollback|compact))/.test(toolName)) return false;
	return /^(write|edit|str_replace|apply_patch|fs_|pwsh|bash|shell|terminal|run|node|python|multi_edit)/i.test(toolName);
}

/** 一条路径是否落在 scope 内：不含分隔符的模式按**文件名**匹配，含分隔符的按**后缀**匹配（偏宽，少误报）。 */
function pathInScope(target, patterns) {
	const p = String(target).replaceAll("\\", "/");
	const base = p.split("/").pop();
	const segs = p.split("/");
	for (const raw of patterns) {
		const pat = String(raw).replaceAll("\\", "/").replace(/^\.\//, "");
		const re = globToRe(pat);
		if (!pat.includes("/")) {
			// 不含分隔符 → 只比文件名（`Dockerfile` 要能命中 `D:/p/Dockerfile`）
			if (re.test(base)) return true;
			continue;
		}
		// 【批2-B】含分隔符 → 按**路径后缀**逐段试：`src/*.ts` 必须能命中 `D:/p/src/a.ts`
		// （以前只做全匹配/字面后缀，导致目录通配失效、全判越界）
		for (let i = 0; i < segs.length; i++) {
			if (re.test(segs.slice(i).join("/"))) return true;
		}
	}
	return false;
}

/**
 * 给一次工具调用判 scope。**只判"声明了 scope 的当前主线步骤"**，没声明就一律不判（不打扰）。
 * 返回 null = 无判决（没声明 / 没抽到目标 / 该工具不参与）。
 */
function judgeScope(step, toolName, args) {
	if (!step || step.kind !== "plan") return null;
	// 【批2-A】计划自己的工具不参与判决。红队抓到的自我误伤：
	// plan_set/plan_status 的参数（文本、id 之类）会被当成文件目标，判出 read-outside。
	if (String(toolName).startsWith("plan_")) return null;
	const files = parseList(step.scope_files);
	const cmds = parseList(step.scope_commands);
	if (!files.length && !cmds.length) return null;
	const { paths, commands } = extractTargets(args);
	const mutating = isMutating(toolName);
	const outKind = mutating ? "out-of-scope" : "read-outside";

	if (commands.length && cmds.length) {
		for (const c of commands) {
			if (!cmds.some((pat) => globToRe(pat).test(c.trim()))) {
				return { verdict: outKind, target: c.trim().slice(0, 80) };
			}
		}
	}
	if (paths.length && files.length) {
		let outside = 0;
		let sample = "";
		for (const p of paths) {
			if (!pathInScope(p, files)) { outside++; if (!sample) sample = p; }
		}
		if (outside === 0) return { verdict: "match", target: paths[0] };
		if (outside === paths.length) return { verdict: outKind, target: sample };
		return { verdict: "partial", target: sample };
	}
	return null;
}

function recordVerdict(d, planId, stepId, toolName, v) {
	d.prepare("INSERT INTO verdicts (plan_id, step_id, ts, tool, verdict, target) VALUES (?,?,?,?,?,?)")
		.run(planId, stepId, now(), toolName, v.verdict, (v.target || "").slice(0, 200));
}
/** 判决统计 —— 这就是"先只观察"的仪表盘：误报率靠它说话。 */
function verdictStats(d, planId, stepId = 0) {
	const rows = stepId
		? d.prepare("SELECT verdict, COUNT(*) c FROM verdicts WHERE plan_id=? AND step_id=? GROUP BY verdict").all(planId, stepId)
		: d.prepare("SELECT verdict, COUNT(*) c FROM verdicts WHERE plan_id=? GROUP BY verdict").all(planId);
	const out = {};
	for (const r of rows) out[r.verdict] = Number(r.c);
	return out;
}

/** 步骤的展示文本：标题 + 验收动作（操作级 cue）。 */
function stepCue(s) {
	if (!s) return "";
	return s.acceptance ? `${s.text}（验收：${s.acceptance}）` : s.text;
}

/**
 * 步骤文字里自带的编号已经过时了吗？
 * 修订会顺延/收拢**位置编号**，但**不改你写的文字**（改文字风险太大："3 个服务都要健康"不是序号）。
 * 所以只做标注：让"文字里的 5 和现在的第 6 步对不上"这件事**看得见**，而不是悄悄错下去。
 * 区分"序号前缀"与"数量词"靠一张量词表 —— "5 上线"是序号，"3 个服务"是数量。
 */
const MEASURE_WORD = /^(个|条|种|次|天|分钟|小时|人|台|份|项|张|页|行|秒|倍|遍|轮|批|段|层|级|度|元|万|千|百|套|组|步)/;
function staleOrdinalNote(s) {
	const m = String(s.text || "").match(/^\s*(\d+)\s*([.、)．,，]?\s*)(\S)/);
	if (!m) return "";
	if (!m[2].trim() && MEASURE_WORD.test(m[3])) return ""; // 数量词，不是序号前缀
	const n = Number(m[1]);
	return n === Number(s.ord) ? "" : `（文字里的「${n}」是旧编号）`;
}

/** scope 判决的一行摘要 —— "先只观察"的仪表盘：误报率靠它说话。 */function scopeLineText(d, planId, stepId) {
	const s = verdictStats(d, planId, stepId);
	const total = Object.values(s).reduce((a, b) => a + b, 0);
	if (!total) return "本步暂无记录（该步没声明 scope，或还没动过手）";
	const parts = Object.entries(s).map(([k, v]) => `${k} ${v}`).join(" / ");
	const oo = s["out-of-scope"] || 0;
	return parts + (oo ? ` —— 其中 out-of-scope ${oo} 条，需人工看一眼是不是误报` : "");
}

/**
 * 台账 ↔ 泊位表一致性自检。
 * 目的：把"绕开工具直接改数据库"这种**无痕篡改**变成**可检测**——
 * 台账里"入泊过 #N"的记录必须能在泊位表里找到对应行（显式关闭只是改状态，不删行）。
 * 照 zannabi 的思路：不是禁止，而是让"通过这件事还有没有可追溯的根据"可见。
 */
function integrityLine(d) {
	// 全库检查（不限本计划）：任何合法路径都不会**删除**泊位行——
	// 关闭只是改 status，重规划只是改 plan_id，偏离结束只是改 status。
	// 所以"台账有、表里没有"只可能是被绕开工具直接动过。
	const refs = d.prepare("SELECT ref FROM ledger WHERE kind IN ('discover_park','discover_block')").all()
		.map((r) => Number(String(r.ref).replace("#", "")))
		.filter((n) => Number.isInteger(n) && n > 0);
	if (!refs.length) return null;
	const missing = [...new Set(refs)].filter((id) => !d.prepare("SELECT 1 AS x FROM parking WHERE id=?").get(id));
	if (!missing.length) return null;
	return `⚠ 一致性异常：台账里入泊过的 #${missing.join(" #")} 在泊位表里**找不到对应行** —— 可能是绕开工具直接改动数据库（无痕篡改）。台账是 append-only，这条记录不会被自动抹掉。`;
}

// ---------- 锚点简报（模型可见文本 —— 这就是本插件的"产品"） ----------

/**
 * 生成锚点简报。这是所有 plan_* 工具返回给模型的东西，
 * 也是漂移提醒注入的内容。要求：短、具体、带编号、带明确下一步。
 */
function anchorText(d, plan, opts = {}) {
	if (!plan) {
		return [
			"【计划锚】当前没有生效的计划。",
			opts.scopeHint ? `（本项目作用域：${opts.scopeHint} —— 如果你确定立过计划，可能是路径写法不同导致作用域没对上。）` : "",
			"如果这次任务是多步的（≥3 步），先用 plan_set 把步骤写下来再开工——",
			"没有落盘的计划等于没有计划：执行到一半冒出新问题时，它挡不住你的注意力。"
		].filter(Boolean).join("\n");
	}
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const done = steps.filter((s) => s.status === "done").length;
	const park = openParking(d, plan.id);
	const dts = lineageDetours(d, plan); // 额外步骤按**谱系**统计：改计划不该让编号重启
	const dtDone = dts.filter((s) => s.status === "done").length;
	const lines = [];
	// 两套编号分开报：主线 k/n 一条线，额外步骤 j 另一条线。混在一起就永远说不清"我们到哪了"
	const dtPart = dts.length ? `｜额外步骤 ${dtDone}/${dts.length} 完成` : "";
	lines.push(`【计划锚】${plan.title}（v${plan.version}）｜主线 ${done}/${steps.length} 步${dtPart}`);
	// 编号刚变过就必须主动说 —— 否则"我们做到哪了"跨修订又会含混
	const rev = revisionNote(d, plan.id);
	if (rev) lines.push(`⚠ 计划刚修订过：${rev}`);

	if (cur && cur.kind === "detour") {
		const resume = stGet(d, plan.id, "resume_step");
		const r = resume ? stepById(d, Number(resume)) : null;
		lines.push(`⚙ 当前在做**额外步骤 ${cur.detour_no}**：${cur.text}`);
		lines.push(r
			? `主线第 ${r.ord} 步「${r.text}」已挂起 —— 做完 plan_step_done 会**自动回到主线第 ${r.ord} 步**。`
			: "主线当前没有挂起的步骤；做完 plan_step_done 会回到主线的下一个待办步。");
	} else if (cur) {
		lines.push(`▶ 当前：**主线第 ${cur.ord}/${steps.length} 步**：${stepCue(cur)}`);
	} else {
		lines.push("▶ 主线当前没有进行中的步骤。");
	}

	const nextPending = steps.find((s) => s.status === "pending" || s.status === "blocked");
	if (!cur || cur.kind === "detour") {
		if (nextPending) lines.push(`⏭ 回归后下一步：**主线第 ${nextPending.ord} 步**「${stepCue(nextPending)}」${nextPending.status === "blocked" ? "（此前被标阻塞）" : ""}`);
	}

	if (park.length) {
		const head = park.slice(0, 3).map((p) => `${parkLabel(d, p)} ${p.text}`).join("；");
		lines.push(`🅿 泊位 ${park.length} 条未处理（一律先入泊，不要现在追）：${head}${park.length > 3 ? ` …另 ${park.length - 3} 条` : ""}`);
	} else {
		lines.push("🅿 泊位空。");
	}
	// 偏离额度：不做禁令，只做可见的代价（Scrum Guide 2020 的立场是"尽早调整"，不是"禁止调整"）
	if (detourUsed(d, plan.id) > detourBudget) {
		lines.push(`⚠ 偏离额度已用尽（已提取 ${detourUsed(d, plan.id)} 条 / 额度 ${detourBudget}）—— 不禁止，但请把这笔代价算进判断。`);
	}
	// 回程票到期：填了 resume_after_ord 的泊位，等它那条主线步骤做完就主动举手
	for (const p of dueParking(d, plan.id)) {
		lines.push(`⏰ 回程票到期：${parkLabel(d, p)}「${p.text}」—— 当初写的是「${p.resume_when}」，现在到了（${resumeLabel(d, p)}已完成）。`);
	}

	if (opts.verdict) lines.push(`状态判定：${opts.verdict}`);
	return lines.join("\n");
}

/** 漂移判定：哪些信号说明"你现在大概不在计划上"。判据公开且可查，不靠感觉。 */
function driftSignals(d, plan, threshold) {
	const sig = [];
	if (!plan) return sig;
	const cur = currentStep(d, plan.id);
	const b = budget(d, plan.id);
	if (b >= threshold) sig.push(`已连续 ${b} 次工具调用没有推进计划（阈值 ${threshold}）`);
	if (cur && cur.kind === "detour") sig.push("当前处于偏离态（在做计划外的事）");
	// 计划步骤被标为阻塞：偏离中处理 = 正常；不在处理 = 计划实际停摆（真正该报警的状态）
	const blocked = planSteps(d, plan.id).filter((s) => s.status === "blocked");
	if (blocked.length) {
		const ords = blocked.map((s) => s.ord).join("/");
		sig.push(cur && cur.kind === "detour"
			? `第 ${ords} 步处于阻塞中断中（正在偏离处理）`
			: `第 ${ords} 步被标为阻塞，但当前没有在处理它 —— 计划实际停摆`);
	}
	return sig;
}

// ---------- 工具实现 ----------

/** 1. plan_set：立计划 / 显式重规划（重规划必须带 reason，不许可静默改） */
function planSet(d, args, scope = "") {
	const title = (args.title || "").trim();
	if (!title) return { ok: false, reason: "title 不能为空" };
	const raw = Array.isArray(args.steps) ? args.steps : [];
	// 步骤可以是纯字符串，也可以是对象：{ text, acceptance, files, commands }
	const parsed = parseStepList(raw);
	if (parsed.length === 0) return { ok: false, reason: "steps 不能为空：至少要写下第 1 步是什么" };

	const prev = activePlan(d, scope);
	let version = 1;
	const reason = (args.reason || "").trim();
	if (prev) {
		// 不变量 I3：已存在生效计划时，改计划必须给出理由 —— 否则拒绝并把现状回显。
		if (!reason) {
			return {
				ok: false,
				reason: "已存在生效计划，覆盖它必须传 reason（为什么原计划不再成立）。静默改计划正是漂移的起点。",
				current: anchorText(d, prev)
			};
		}
		d.prepare("UPDATE plans SET status='superseded', superseded_at=? WHERE id=?").run(now(), prev.id);
		version = prev.version + 1;
		// 重规划 = 计划变了，未决的"完成确认"随之作废（否则闸门会挂在一个已经不存在的计划上）
		stDel(d, prev.id, "review_since");
		stDel(d, prev.id, "review_step");
		log(d, "replan", { planId: prev.id, ref: `v${prev.version}→v${version}`, detail: reason });
	}
	// 谱系：重规划继承旧计划的谱系；首次立计划时谱系 = 自己
	const lineageId = prev ? Number(prev.lineage_id) : 0;
	const res = d.prepare("INSERT INTO plans (title, version, status, reason, scope, lineage_id, created_at) VALUES (?,?,'active',?,?,?,?)")
		.run(title, version, reason, scope, lineageId, now());
	const planId = Number(res.lastInsertRowid);
	if (!lineageId) d.prepare("UPDATE plans SET lineage_id = ? WHERE id = ?").run(planId, planId);
	// I5 延伸：**重规划不许把旧计划的欠账弄丢**。泊位是按 plan_id 归属的，
	// 若不做搬迁，重规划之后旧欠账会从 plan_park 里"消失"（数据还在，但看不见了）。
	// 搬 parked（未处理）与 escalated（偏离进行中——那条偏离随重规划一起作废，所以退回待处理）；
	// resume_after_ord 重置为 0：新计划的步骤编号很可能与旧计划对不上，宁可让提醒失效，也不给一个错的到期点。
	let carried = 0;
	let orphaned = [];
	if (prev) {
		const rows = d.prepare("SELECT id FROM parking WHERE plan_id=? AND status IN ('parked','escalated')").all(prev.id);
		carried = rows.length;
		if (carried) {
			d.prepare("UPDATE parking SET plan_id=?, status='parked', closed_at=NULL, resume_after_ord=0 WHERE plan_id=? AND status IN ('parked','escalated')").run(planId, prev.id);
			log(d, "park_carryover", { planId, ref: `${carried} 条`, detail: "重规划带过来的未闭合欠账（含偏离进行中的）；到期提醒已重置" });
		}
		// 旧计划里"活着"的步骤没有被继承 —— 必须**明说**，不能静默丢掉（这正是 plan_set 的代价）
		orphaned = planSteps(d, prev.id).map((s) => ({ ord: s.ord, text: s.text, done: s.status === "done" }));
	}
	const ins = d.prepare("INSERT INTO steps (plan_id, ord, text, kind, acceptance, scope_files, scope_commands, status) VALUES (?,?,?,'plan',?,?,?,'pending')");
	const ids = parsed.map((s, i) => Number(
		ins.run(planId, i + 1, s.text, s.acceptance, JSON.stringify(s.files), JSON.stringify(s.commands)).lastInsertRowid
	));

	// ---- 显式映射（carry）：把旧计划的步骤关系声明清楚，而不是让它们无声消失 ----
	// 四种关系：kept（保留，连完成状态一起继承）/ replaced（取代：旧的做错了，新的重做它）
	//          / split（拆分：旧的工拆分到多个新步骤）/ merged（合并：多个旧步骤合成一个新步骤）
	const RELATIONS = ["kept", "replaced", "split", "merged"];
	const carriedIn = [];
	const reworks = [];
	const carryWarnings = [];
	if (Array.isArray(args.carry) && args.carry.length) {
		if (!prev) return { ok: false, reason: "carry 只能在**换计划**时用（当前没有旧计划可映射）—— 局部调整请用 plan_amend / plan_insert / plan_drop。" };
		for (const raw of args.carry) {
			const rel = String((raw && raw.relation) || "").trim();
			const fromId = Number(raw && raw.from_step_id || 0);
			const toIdx = Number(raw && raw.to_index || 0);
			const from = fromId ? stepById(d, fromId) : null;
			if (!RELATIONS.includes(rel)) { carryWarnings.push(`映射被跳过：relation 必须是 ${RELATIONS.join(" / ")}（收到「${rel}」）`); continue; }
			if (!from || from.plan_id !== prev.id) { carryWarnings.push(`映射被跳过：步骤 #${fromId} 不属于被替换的旧计划`); continue; }
			if (!(toIdx >= 1 && toIdx <= ids.length)) { carryWarnings.push(`映射被跳过：to_index=${toIdx} 超出新计划范围（1..${ids.length}）`); continue; }
			const target = ids[toIdx - 1];
			if (rel === "kept") {
				// 只有"真做完"才继承完成状态：做得对不对是语义判断，插件只搬确定的事
				if (from.status === "done") {
					d.prepare("UPDATE steps SET status='done', evidence=?, done_at=?, rework_of=0 WHERE id=?")
						.run(`${from.evidence}\n[继承自旧计划第 ${from.ord} 步]`, from.done_at, target);
					carriedIn.push(`旧第 ${from.ord} 步「${from.text}」的**完成状态**已继承到新第 ${toIdx} 步`);
				} else {
					carriedIn.push(`旧第 ${from.ord} 步「${from.text}」→ 新第 ${toIdx} 步（保留关系；旧步当时未完成，所以没有可继承的完成状态）`);
				}
			} else if (rel === "replaced") {
				// 取代 = 返工：旧的那步产出有问题，新步骤重做它。不继承完成状态，只留显式链接。
				d.prepare("UPDATE steps SET rework_of=?, status='pending' WHERE id=?").run(from.id, target);
				reworks.push(`新第 ${toIdx} 步「${stepById(d, target).text}」是**返工**：取代旧第 ${from.ord} 步「${from.text}」${raw.note ? `（${raw.note}）` : ""}`);
			} else {
				carriedIn.push(`旧第 ${from.ord} 步「${from.text}」→ 新第 ${toIdx} 步（关系：${rel === "split" ? "拆分" : "合并"}；**不继承完成状态**，完成与否要重新判定）`);
			}
			log(d, "carry", { planId, stepId: target, ref: `${rel} from #${from.id}`, detail: `${from.text} → ${stepById(d, target).text}${raw.note ? `｜${raw.note}` : ""}` });
		}
	}
	// 没有被映射、但**已经完成**的旧步骤：必须吼出来，不能静默丢掉它的成果
	const mappedFrom = new Set((Array.isArray(args.carry) ? args.carry : []).map((r) => Number(r && r.from_step_id || 0)));
	const unMappedDone = (prev ? planSteps(d, prev.id) : []).filter((s) => s.status === "done" && !mappedFrom.has(s.id));

	// 起点：第一条还没完成的步骤（被 carry 继承成 done 的不能当起点）
	const start = planSteps(d, planId).find((s) => s.status !== "done") || null;
	if (start) d.prepare("UPDATE steps SET status='active', started_at=? WHERE id=?").run(now(), start.id);
	setCurrent(d, planId, start ? start.id : null);
	// 【计划膨胀】记下"出生时几步"—— 论文实测：早期插入额外阶段可能反而降低表现，
	// 所以"这个计划长了多少"应该是个看得见的数字，而不是感觉。
	stSet(d, planId, "birth_steps", String(parsed.length));
	stDel(d, planId, "resume_step");
	setBudget(d, planId, 0);
	stSet(d, planId, "detour_used", 0);
	log(d, "plan_set", { planId, stepId: start ? start.id : 0, ref: `v${version}`, detail: `${parsed.length} 步：${title}` });

	const plan = d.prepare("SELECT * FROM plans WHERE id=?").get(planId);
	const withScope = parsed.filter((s) => s.files.length || s.commands.length).length;
	const doneNow = planSteps(d, planId).filter((s) => s.status === "done").length;
	return {
		ok: true,
		plan_id: planId,
		version,
		steps: parsed.length,
		steps_with_cue: parsed.filter((s) => s.acceptance).length,
		steps_with_scope: withScope,
		briefing: anchorText(d, plan, { verdict: doneNow ? `已换计划；继承了 ${doneNow} 步已完成的进度` : `已立计划，开工第 1 步` }),
		rules: [
			...(carried ? [`⚠ 重规划：旧计划有 ${carried} 条未闭合欠账**已搬到本计划**（到期提醒已重置）；plan_park 可查。`] : []),
			...(carriedIn.length ? ["📎 显式映射（你说的关系我照办了）：", ...carriedIn.map((x) => `   ${x}`)] : []),
			...(reworks.length ? ["🔁 返工（旧的那步产出有问题，新步骤取代它）：", ...reworks.map((x) => `   ${x}`), "   → 返工本身也要有验收标准；做完后**下游步骤若建立在旧产出上，应复查**（拿不准就问用户）。"] : []),
			...(unMappedDone.length ? [
				`⚠ **有 ${unMappedDone.length} 步已完成、但没有被任何映射认领**（它们的成果在新计划里没有归属）：`,
				...unMappedDone.map((s) => `   ✔ 原第${s.ord}步 ${s.text}`),
				"   → 如果你认这些成果，用 `carry: [{from_step_id, to_index, relation: \"kept\"}]` 显式认领；",
				"     如果它们**做错了**，用 `relation: \"replaced\"` 声明返工 —— 别让它无声消失。"
			] : []),
			...(carryWarnings.length ? ["⚠ 部分映射没生效：", ...carryWarnings.map((x) => `   ${x}`)] : []),
			...(orphaned.filter((s) => !mappedFrom.has(s.id)).length ? [
				`⚠ 旧计划还有 ${orphaned.filter((s) => !mappedFrom.has(s.id)).length} 步**没有被任何映射认领**（已认领的不在此列）：`,
				...orphaned.filter((s) => !mappedFrom.has(s.id)).map((s) => `   ${s.done ? "✔" : "·"} 原第${s.ord}步 ${s.text}`),
				"   → 如果你其实只是想**局部调整**（改一步、插一步、删一步），那 plan_set 是错的工具：",
				"     应该用 `plan_amend`（原地改，编号与历史不变）/ `plan_insert`（插一步，编号顺延）/ `plan_drop`（丢一步）。这三个都不会丢进度。"
			] : []),
			...(parsed.filter((s) => !s.acceptance).length ? [
				`⚠ 有 ${parsed.filter((s) => !s.acceptance).length} 步**没写验收标准**（"怎么算做完"）。`,
				"   论文实测（arXiv 2604.12147）：**烂计划比没计划更糟**。写了验收，你自己和用户都能判它过没过。"
			] : []),
			"执行中冒出任何新问题 → 先 plan_discover 显式判定：permit / defer / decline。",
			"选 defer 必须一起给 resume_when（回程票）；能给出步骤号就带 resume_after_ord，到期我会主动提醒。",
			"每完成一步 → plan_step_done（evidence 要对着该步的「验收」说话）。",
			withScope ? `已声明 scope 的步骤：${withScope} 个 —— 当前是 **observe 档**：只记录判决、不拦你；等误报率数据出来再谈要不要收紧。` : "（步骤没声明 files/commands，所以 scope 判决不参与 —— 想用它就在步骤里加上。）"
		].join("\n")
	};
}

/** 2. plan_status：回归锚 —— 随时回答"我在第几步、下一步、泊位几条、是否在漂" */
function planStatus(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) {
		return {
			ok: true, has_plan: false,
			// 失明时必须能诊断：把解析出来的作用域报出来，而不是笼统说"没有计划"
			briefing: anchorText(d, null, { scopeHint: scope || "（本次调用拿不到会话工作目录，退化到默认作用域）" })
		};
	}
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const sig = driftSignals(d, plan, Math.max(1, Number(args.threshold ?? threshold)));
	const reviewSince = Number(stGet(d, plan.id, "review_since", "0"));
	let verdict = "在计划上";
	if (reviewSince) verdict = "**待用户确认完成**（最后一步已做完，但还没问过用户 —— 完成闸门开着）";
	else if (!cur) verdict = "没有进行中的步骤（计划可能已停摆）";
	else if (cur.kind === "detour") verdict = "偏离中";
	if (sig.some((s) => s.includes("没有在处理它"))) verdict += "，且有阻塞未处理";
	if (sig.some((s) => s.includes("没有推进"))) verdict += "，疑似漂移";
	const detail = {
		plan_id: plan.id,
		version: plan.version,
		title: plan.title,
		total: steps.length,
		done: steps.filter((s) => s.status === "done").length,
		// 步骤行同时给出 id 与序号：不给 id，模型就没法用 plan_goto(step_id) 精确切步
		// 这里用 planStepsAll：被 drop 的步骤也列出来，好让"这里原本有一步"看得见
		step_map: planStepsAll(d, plan.id).map((s) => {
			const mark = s.status === "done" ? "✔" : s.status === "dropped" ? "⊘丢弃" : s.status === "blocked" ? "⛔" : cur && s.id === cur.id ? "▶" : "·";
			// 已完成步骤把依据也带出来：否则 evidence 就是"只写不能读"，写完没人能核
			const ev = s.status === "done" && s.evidence
				? ` · 依据：${String(s.evidence).replace(/\s+/g, " ").slice(0, 70)}`
				: "";
			return `${mark} 主线第${s.ord}步(id=${s.id}) ${stepCue(s)}${s.rework_of ? `〔🔁 返工：取代 #${s.rework_of}〕` : ""}${s.forced ? "〔⚠ 熔断放行〕" : ""}${ev}${staleOrdinalNote(s)}`;
		}),
		// 额外步骤独立编号、独立成节：两套编号混在一起就永远说不清"我们到哪了"
		detours: lineageDetours(d, plan).map((s) => {
			const mark = s.status === "done" ? "✔" : s.status === "skipped" ? "⊘中止" : cur && s.id === cur.id ? "⚙在做" : "·";
			const rw = s.rework_of ? `〔🔁 返工：取代 #${s.rework_of}〕` : "";
			return `${mark} 额外步骤${s.detour_no}(id=${s.id}) ${s.text}${rw}`;
		}),
		revisions: d.prepare("SELECT ts, kind, ref, detail FROM ledger WHERE plan_id=? AND kind IN ('amend','insert','drop','replan') ORDER BY id DESC LIMIT 5").all(plan.id),
		parking_open: openParking(d, plan.id).length,
		budget: budget(d, plan.id),
		mute_left: muteLeft(d, plan.id)
	};
	return {
		ok: true,
		has_plan: true,
		...detail,
		drift_signals: sig,
		verdict,
		briefing: [
			anchorText(d, plan, { verdict }),
			"",
			"主线步骤：",
			...detail.step_map.map((l) => "  " + l),
			...(detail.detours.length ? ["", "额外步骤（从主线岔出去的工作，独立编号，跨修订连续）：", ...detail.detours.map((l) => "  " + l)] : []),
			...(detail.revisions.length ? ["", "计划修订史（最近 5 次）：", ...detail.revisions.map((r) => {
				const t = new Date(r.ts).toISOString().slice(11, 19);
				const K = { amend: "原地改", insert: "插入", drop: "丢弃", replan: "换计划" }[r.kind] || r.kind;
				return `  ${t} ${K} ${r.ref} · ${String(r.detail).slice(0, 70)}`;
			})] : [])
			,
			...(openParking(d, plan.id).length ? ["", "泊位（未处理，含回程票）：", ...openParking(d, plan.id).map((p) => {
				const rl = resumeLabel(d, p);
				const due = dueParking(d, plan.id).some((x) => x.id === p.id);
				return `  ${parkLabel(d, p)}${p.blocking ? " ⛔" : ""} ${p.text}${p.resume_when ? `｜🔄 ${p.resume_when}${rl ? `（${rl}）` : ""}` : ""}${due ? " ← ⏰ 已到期" : ""}`;
			})] : []),
			"",
			`漂移预算：已用 ${Math.round(budget(d, plan.id) * 10) / 10}/${threshold} 次无进展调用${budget(d, plan.id) >= threshold ? "（已超阈值，应立刻定位或重规划）" : ""}`,
			...(scopeMode === "off" ? [] : [`🔎 scope 判决（${scopeMode} 档${scopeMode === "observe" ? "，仅记录不拦" : ""}）：${scopeLineText(d, plan.id, cur ? cur.id : 0)}`]),
			// 【批2-C】提醒额度用尽必须说出来：否则"没提醒"看起来像"没问题"
			...(() => {
				const k = cur ? cur.id : 0;
				const fired = stGet(d, plan.id, "drift_fired", "").split(",");
				return fired.includes(`${k}:gentle`) && fired.includes(`${k}:firm`)
					? ["⚠ 本步的两档漂移提醒**都已用掉**（每档每步只响一次）—— 之后再漂不会有自动提醒，只能靠你自己或问用户。"]
					: [];
			})(),
			...(integrityLine(d) ? [integrityLine(d)] : []),
			...(reviewSince ? ["", "▶ 完成闸门开着：先用 `ask_user_question` 问用户「这个计划真的交付了吗？」，再用 `plan_review` 记录答复。"] : []),
			...(muteLeft(d, plan.id) > 0 ? [`⏸ 主动提醒已静音，还剩 ${muteLeft(d, plan.id)} 次调用（静音不是免责，台账照记）`] : []),
			...(sig.length ? ["", "漂移信号：" + sig.join("；")] : [])
		].join("\n")
	};
}

/** 3. plan_step_done：完成当前步（evidence 必填，防"假装推进"） */
function planStepDone(d, args, scope = "", session = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "没有生效计划" };
	const cur = currentStep(d, plan.id);
	if (!cur) return { ok: false, reason: "当前没有进行中的步骤", briefing: anchorText(d, plan) };
	// 完成类关卡统一走熔断。**熔断在本次调用内是终局的**：一个关卡放行后，
	// 后续关卡不再拦——否则两关会乒乓（放行→立刻被另一关拒→计数器重置→无限循环），
	// 那正是行业 cap 要防的死循环，必须避免。
	let released = false;
	const gate = (reason) => {
		if (released) return null;
		const out = refuseOrRelease(d, plan.id, "plan_step_done", cur.id, refuseCap, { ok: false, reason, briefing: anchorText(d, plan) }, session);
		if (out) return out;
		released = true;
		return null;
	};

	const evidence = (args.evidence || "").trim();
	if (!evidence) {
		const g = gate("evidence 必填：凭什么算这一步做完了（跑了什么/看到了什么）。没有依据的完成不算完成。");
		if (g) return g;
	}
	// 硬不变量 I9（纯代码，不依赖任何模型判断）：自本步开始以来零工作痕迹，不许声称完成。
	// 判据 = 工具调用数 + 用户回合数，两者都为 0 说明这一步根本没发生过任何事。
	// 唯一出路是显式说明"为什么这一步不需要任何工具调用"——禁止的不是推进，是**静默**。
	const trace = workTrace(d, plan.id);
	if (trace.calls === 0 && trace.turns === 0) {
		const why = (args.no_work_reason || "").trim();
		if (!why) {
			const g = gate(
				`自本步开始以来既没有任何工具调用、也没有新的用户回合（工作痕迹 = 0）。没有任何动作发生，凭什么算完成？\n` +
				`- 真做过了 → 先干活，再回来 plan_step_done\n` +
				`- 这一步确实不需要工具（例如纯讨论就定了）→ 传 no_work_reason 显式说明，会记进台账\n` +
				`- 其实卡住了 → plan_discover(disposition="permit") 走正式中断`
			);
			if (g) return g;
		} else {
			log(d, "zero_work_done", { planId: plan.id, stepId: cur.id, detail: `无工具调用完成，理由：${why}` });
		}
	}
	if (released) log(d, "cap_reached", { planId: plan.id, stepId: cur.id, ref: "plan_step_done", session, detail: "关卡在连续被拒达上限后熔断放行（evidence 或工作痕迹仍不合规，状态迁移已强制通过）" });
	clearRefusal(d, plan.id, "plan_step_done", cur.id, session);
	d.prepare("UPDATE steps SET status='done', evidence=?, done_at=? WHERE id=?").run(evidence, now(), cur.id);
	// 熔断放行必须留在**主视图**上，不能只躺在台账里（红队抓到：以前只看得到"完成了"）
	if (released) d.prepare("UPDATE steps SET forced=1 WHERE id=?").run(cur.id);
	markAnswered(d, plan.id);   // 【计划遵守率】这是一次实质响应
	log(d, cur.kind === "detour" ? "detour_done" : "step_done", { planId: plan.id, stepId: cur.id, detail: evidence });
	setBudget(d, plan.id, 0);

	let tail;
	if (cur.kind === "detour") {
		// I5：偏离做完 → 关闭对应泊位条目（闭环，不许停在 escalated 变成幽灵条目）
		if (cur.from_park) {
			d.prepare("UPDATE parking SET status='done', closed_at=? WHERE id=? AND status='escalated'").run(now(), cur.from_park);
		}
		// 偏离结束 —— 自动回到挂起的计划步骤（不变量 I6：回归由代码完成，不靠模型记得）
		const rid = stGet(d, plan.id, "resume_step");
		const resume = rid ? stepById(d, Number(rid)) : null;
		let back = null;
		if (resume && resume.status !== "done" && resume.status !== "dropped") {
			d.prepare("UPDATE steps SET status='active', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), resume.id);
			setCurrent(d, plan.id, resume.id);
			back = resume;
			log(d, "return_to_plan", { planId: plan.id, stepId: resume.id, ref: `detour#${cur.id}`, detail: "偏离结束，自动回归" });
			stDel(d, plan.id, "resume_step");
		} else {
			const next = planSteps(d, plan.id).find((s) => s.status === "pending" || s.status === "blocked");
			if (next) {
				d.prepare("UPDATE steps SET status='active', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), next.id);
				setCurrent(d, plan.id, next.id);
				back = next;
			} else setCurrent(d, plan.id, null);
		}
		tail = back
			? `额外步骤 ${cur.detour_no} 已完成 ✔（${cur.text}）；**已自动回到主线第 ${back.ord} 步**：「${back.text}」${back.status === "blocked" ? "（此前标为阻塞；若阻塞其实未解除，再 plan_discover(disposition=\"permit\")）" : ""}`
			: `额外步骤 ${cur.detour_no} 已完成 ✔；主线已无待办步骤。`;
	} else {
		// 完成一个计划步骤 → 偏离额度回血 1 点（额度是预算，不是禁令）
		stSet(d, plan.id, "detour_used", Math.max(0, detourUsed(d, plan.id) - 1));
		const next = planSteps(d, plan.id).find((s) => s.status === "pending" || s.status === "blocked");
		if (next) {
			d.prepare("UPDATE steps SET status='active', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), next.id);
			setCurrent(d, plan.id, next.id);
			tail = `主线第 ${cur.ord} 步完成 ✔${cur.acceptance ? `（对照验收：${cur.acceptance}）` : ""}，下一步 ▶ **主线第 ${next.ord} 步**：「${stepCue(next)}」`
				+ (cur.acceptance ? `\n（该步有验收标准 —— 若拿不准是否**真**过了，用 \`ask_user_question\` 让用户确认；判验收是语义判断，别自己拍板。）` : "");
		} else {
			setCurrent(d, plan.id, null);
			const park = openParking(d, plan.id).length;
			if (completionGate) {
				// 完成闸门：**语义判断交给用户，但"用户有没有回过话"是可观测事实 → 这一条可以硬判**。
				// 依据：Anthropic 官方公布 auto mode 分类器对真实越界动作的漏检率是 17%，且承认提示词工程解决不了
				// → "算不算交付"不该由做事的那一方拍板，也不该交给另一个模型，该交给会为结果负责的人。
				stSet(d, plan.id, "review_since", now());
				stSet(d, plan.id, "review_step", cur.id);
				tail = [
					`最后一步（主线第 ${cur.ord} 步）做完了 —— 但**计划还不能算完成**。`,
					"「算不算交付」是语义判断，不该由我自己拍板。",
					"▶ 现在就用 `ask_user_question` 问用户：**这个计划真的交付了吗？**",
					`   把依据一并摆出来${cur.acceptance ? `（该步验收：「${cur.acceptance}」）` : "（该步没写验收标准 —— 这正是值得补的地方）"}。`,
					"用户回答后：通过 → `plan_review(confirmed=true)`；说没完成 → `plan_review(confirmed=false, note=\"用户原话\")`，那一步会被退回。",
					park ? `另外泊位还有 ${park} 条未闭合，值得连这个一起问。` : ""
				].filter(Boolean).join("\n");
			} else {
				tail = park
					? `计划全部走完 ✔ 但泊位还有 ${park} 条未闭合 —— 现在正是回头处理它们的时机（plan_park 看清单）。`
					: "计划全部走完 ✔ 泊位也是空的。";
			}
		}
	}
	// 【第 8 件】证据 vs 验收：只提醒、不拒绝（判真伪是语义判断，超出硬拦边界）
	let cueWarn = "";
	if (cur.acceptance && !evidenceResponds(evidence, cur.acceptance)) {
		cueWarn = `\n\n⚠ 你写的依据里几乎没有回应验收标准「${cur.acceptance}」的措辞。自查一下：这条验收真的过了吗？拿不准就用 ask_user_question 问用户 —— 别自己拍板。`;
	}
	return { ok: true, step_done: cur.id, briefing: anchorText(d, plan, { verdict: tail }) + "\n" + tail + cueWarn };
}

/**
 * 4. plan_discover：发现新问题 → **必须显式判定处置**（本插件的核心动作）
 *   disposition=permit ：它阻塞当前步 → 走正式中断，转为偏离态焦点
 *   disposition=defer  ：现在不做 → 入泊位，焦点立刻回到当前步（没想清楚就选这个）
 *   disposition=decline：判定不做 → 带理由关闭，不留幽灵条目
 * 为什么是三值而不是布尔：二值会把"延后"表现成"什么都没发生"，而**延后应该是一个
 * 一等公民的决策值**（借 scope-lock 的 Permit/Decline/Defer）。三者都必须显式选择——
 * 禁止的不是"不做"，是**静默**。
 */
const DISPOSITIONS = ["permit", "defer", "decline"];

function planDiscover(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) {
		return { ok: false, reason: "没有生效计划。先 plan_set 立计划（哪怕只写 3 步），否则新问题会直接把主线冲掉。" };
	}
	const text = (args.text || "").trim();
	if (!text) return { ok: false, reason: "text 不能为空：一句话写清这个新发现的问题" };
	const disposition = (args.disposition || "").trim();
	if (!DISPOSITIONS.includes(disposition)) {
		return {
			ok: false,
			reason: [
				"disposition 必填，且必须是 permit / defer / decline 之一 —— 新问题不许含糊地留在半空。",
				"- permit：它**阻塞当前步**，不做就没法继续 → 走正式中断，现在做",
				"- defer：现在不做，入泊位（**没想清楚就选这个**，入泊不会丢，plan_park 随时可查）",
				"- decline：明确判定**不做**，必须附 note 说明理由"
			].join("\n"),
			briefing: anchorText(d, plan)
		};
	}
	const cur = currentStep(d, plan.id);
	const fromStep = cur && cur.kind === "plan" ? cur.id : Number(stGet(d, plan.id, "resume_step", "0") || 0);

	// decline：也要给"不做"一条正规出口，否则泊位只进不出，欠账清单会烂掉
	if (disposition === "decline") {
		const why = (args.note || "").trim();
		if (!why) {
			return {
				ok: false,
				reason: "decline 必须传 note 说明为什么不做 —— 禁止的不是「不做」，是**静默地不做**。",
				briefing: anchorText(d, plan)
			};
		}
		const res = d.prepare(
			"INSERT INTO parking (plan_id, text, from_step, blocking, status, note, created_at, closed_at) VALUES (?,?,?,0,'declined',?,?,?)"
		).run(plan.id, text, fromStep, why, now(), now());
		const parkId = Number(res.lastInsertRowid);
		log(d, "discover_decline", { planId: plan.id, stepId: fromStep, ref: `#${parkId}`, detail: `${text} —— 不做，理由：${why}` });
		return {
			ok: true,
			parking_id: parkId,
			disposition: "decline",
			briefing: [
				`【已判定不做 #${parkId}】${text}`,
				`理由已记录：${why}`,
				"这条不进欠账清单（plan_park 默认只列待处理），但记录保留可追溯。",
				cur ? `▶ 继续第 ${cur.ord} 步：「${cur.text}」` : ""
			].filter(Boolean).join("\n")
		};
	}

	// defer 必须交代"怎么回来"—— 这不是记账负担，是本次改动的**机制本身**：
	// Leroy & Glomb (2018), Organization Science 29(3):380-397 摘要逐字
	//   "A **ready-to-resume intervention**, in which one briefly reflects on and
	//    **plans one's return to the interrupted task**, **mitigates this effect**"。
	// 只记"问题是什么"不算入泊；连"什么时候回来、怎么重新进入"一起记下来，才是那个被实验验证有效的干预。
	let resumeWhen = "";
	let resumeAfterOrd = 0;
	let resumeAfterStepId = 0;
	if (disposition === "defer") {
		resumeWhen = (args.resume_when || "").trim();
		if (!resumeWhen) {
			return {
				ok: false,
				reason: [
					"defer 必须传 resume_when：**到时候凭什么判断该回来看它了？**",
					"例如：`第 4 步做完之后` / `compose 能起来之后` / `计划全部走完之后`。",
					"这不是给你加记账负担 —— 实验证据（Leroy & Glomb 2018, Organization Science）表明：",
					"「**先想清楚怎么回到被打断的任务**」这个动作本身就能显著减轻注意力残留。",
					"只记下问题、不记回程，泊位就会变成没人再看的垃圾抽屉。",
					"（若能给出主线步骤号，再传 resume_after_ord=4，到那一步做完我会**主动提醒**你回来处理。）"
				].join("\n"),
				briefing: anchorText(d, plan)
			};
		}
		resumeAfterOrd = Math.max(0, Math.floor(Number(args.resume_after_ord || 0)));
		// 调用方说的是"第 N 步之后"，但**存的是 step id**：
		// 序号会因为插入/丢弃而顺延，身份不会 —— 否则回程票会在错误的时机响。
		if (args.resume_after_step_id) {
			const s = stepById(d, Number(args.resume_after_step_id));
			if (!s || s.plan_id !== plan.id) return { ok: false, reason: `resume_after_step_id=${args.resume_after_step_id} 不属于当前计划`, briefing: anchorText(d, plan) };
			resumeAfterStepId = s.id;
			resumeAfterOrd = s.ord;
		} else if (resumeAfterOrd) {
			const s = planSteps(d, plan.id).find((x) => x.ord === resumeAfterOrd);
			if (!s) {
				return {
					ok: false,
					reason: `主线没有第 ${resumeAfterOrd} 步（当前共 ${planSteps(d, plan.id).length} 步）—— 序号指错了。改用 resume_after_step_id 更稳（序号会顺延，身份不会）。`,
					briefing: anchorText(d, plan)
				};
			}
			resumeAfterStepId = s.id;
		}
	}

	const res = d.prepare(
		"INSERT INTO parking (plan_id, text, from_step, blocking, status, note, resume_when, resume_after_ord, resume_after_step_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
	).run(plan.id, text, fromStep, disposition === "permit" ? 1 : 0, "parked", args.note || "", resumeWhen, resumeAfterOrd, resumeAfterStepId, now());
	const parkId = Number(res.lastInsertRowid);

	if (disposition === "defer") {
		log(d, "discover_park", { planId: plan.id, stepId: fromStep, ref: `#${parkId}`, detail: `${text}｜重启条件：${resumeWhen}${resumeAfterOrd ? `（主线第 ${resumeAfterOrd} 步之后）` : ""}` });
		const open = openParking(d, plan.id).length;
		return {
			ok: true,
			parking_id: parkId,
			disposition: "defer",
			parking_open: open,
			resume_when: resumeWhen,
			resume_after_ord: resumeAfterOrd,
			next_action: cur ? `回到主线第 ${cur.ord} 步：${cur.text}` : "回到当前步骤",
			briefing: [
				`【已入泊 #${parkId}】${text}`,
				`🔄 重启条件已记：${resumeWhen}${resumeAfterOrd ? `（主线第 ${resumeAfterOrd} 步做完时我会主动提醒你）` : ""}`,
				`泊位现有 ${open} 条未处理。**现在不要处理它** —— 它不阻塞主线第 ${cur ? cur.ord : "?"} 步。`,
				cur ? `▶ 立刻回到**主线第 ${cur.ord} 步**：「${cur.text}」` : "",
				"（泊位不会丢：plan_park 随时可查；到期我会把「回程票」举到你眼前。）"
			].filter(Boolean).join("\n")
		};
	}

	// 阻塞性中断：这是唯一合法的"立刻偏离"
	if (!cur || cur.kind === "detour") {
		// permit 认定失败 → 落回 defer（安全侧），但台账要留痕，不许静默变化
		log(d, "discover_park", { planId: plan.id, stepId: fromStep, ref: `#${parkId}`, detail: `${text}（permit 认定失败：当前无进行中的计划步骤，已落回 defer）` });
		return { ok: false, reason: "当前没有进行中的计划步骤（或已在偏离态），无法把这条认定为「阻塞」——它已按 **defer** 入泊。要处理它请直接 plan_goto(park_id)。", briefing: anchorText(d, plan) };
	}
	d.prepare("UPDATE steps SET status='blocked' WHERE id=?").run(cur.id);
	// I10 覆盖：permit 也是一次偏离（它确实产生了一个额外步骤），必须计入偏离额度。
	// 红队抓到的漏洞：以前只有 plan_goto(park_id) 计入，于是可以靠反复 permit 刷偏移而不报警。
	stSet(d, plan.id, "detour_used", detourUsed(d, plan.id) + 1);
	const dNo = lineageDetourNo(d, plan);
	const dres = d.prepare("INSERT INTO steps (plan_id, ord, detour_no, text, kind, from_park, status, started_at) VALUES (?,?,?,?,'detour',?,'active',?)")
		.run(plan.id, DETOUR_ORD_BASE + parkId, dNo, text, parkId, now());
	const detourId = Number(dres.lastInsertRowid);
	d.prepare("UPDATE parking SET status='escalated', closed_at=? WHERE id=?").run(now(), parkId);
	stSet(d, plan.id, "resume_step", cur.id);
	setCurrent(d, plan.id, detourId);
	setBudget(d, plan.id, 0);
	log(d, "discover_block", { planId: plan.id, stepId: cur.id, ref: `#${parkId}`, detail: text });
	return {
		ok: true,
		parking_id: parkId,
		detour_step_id: detourId,
		disposition: "permit",
		briefing: [
			`【正式中断】主线第 ${cur.ord} 步「${cur.text}」已标记为 ⛔ 阻塞。`,
			`你现在在做**额外步骤 ${dNo}**：${text}`,
			`做完之后 plan_step_done（写 evidence）会自动把你送回**主线第 ${cur.ord} 步** —— 不需要你记得回来。`
		].join("\n")
	};
}

/** 5. plan_goto：显式改焦点（回到某步 / 把泊位条目提上来做）。必须写 reason。 */
function planGoto(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "没有生效计划" };
	const reason = (args.reason || "").trim();
	if (!reason) return { ok: false, reason: "reason 必填：为什么现在要改焦点。无理由的跳步会被记进漂移台账。", briefing: anchorText(d, plan) };
	const cur = currentStep(d, plan.id);

	if (args.park_id) {
		const p = d.prepare("SELECT * FROM parking WHERE id=?").get(Number(args.park_id));
		if (!p) return { ok: false, reason: `泊位 #${args.park_id} 不存在` };
		if (p.plan_id !== plan.id) return { ok: false, reason: `泊位 #${p.id} 不属于当前计划（挂在计划 #${p.plan_id} 上）` };
		if (p.status !== "parked") return { ok: false, reason: `泊位 #${p.id} 已是 ${p.status}，不能重复提取` };
		if (cur && cur.kind === "plan") {
			d.prepare("UPDATE steps SET status='pending' WHERE id=?").run(cur.id);
			stSet(d, plan.id, "resume_step", cur.id);
		}
		const dNo = lineageDetourNo(d, plan);
		const dres = d.prepare("INSERT INTO steps (plan_id, ord, detour_no, text, kind, from_park, status, started_at) VALUES (?,?,?,?,'detour',?,'active',?)")
			.run(plan.id, DETOUR_ORD_BASE + p.id, dNo, p.text, p.id, now());
		const detourId = Number(dres.lastInsertRowid);
		d.prepare("UPDATE parking SET status='escalated', closed_at=? WHERE id=?").run(now(), p.id);
		setCurrent(d, plan.id, detourId);
		setBudget(d, plan.id, 0);
		stSet(d, plan.id, "detour_used", detourUsed(d, plan.id) + 1);
		log(d, "goto_park", { planId: plan.id, stepId: cur ? cur.id : 0, ref: `#${p.id}`, detail: reason });
		const over = detourUsed(d, plan.id) > detourBudget;
		return {
			ok: true,
			detour_step_id: detourId,
			detour_used: detourUsed(d, plan.id),
			detour_budget: detourBudget,
			briefing: [
				`【已提取${parkLabel(d, p)} → 记为额外步骤 ${dNo}】${p.text}`,
				`理由已记录：${reason}`,
				cur && cur.kind === "plan" ? `主线第 ${cur.ord} 步「${cur.text}」已挂起，做完 plan_step_done 会**自动回到主线第 ${cur.ord} 步**。` : "",
				"...but 提醒：这是**计划外的工作**，台账已留痕。",
				over ? `⚠ 偏离额度已超支（第 ${detourUsed(d, plan.id)} 次 / 额度 ${detourBudget}）。不禁止你继续，但这笔代价会一直显示在锚上，直到你完成一个计划步骤。` : `偏离额度：${detourUsed(d, plan.id)}/${detourBudget}。`
			].filter(Boolean).join("\n")
		};
	}

	if (args.step_id) {
		const s = stepById(d, Number(args.step_id));
		if (!s || s.plan_id !== plan.id || s.kind !== "plan") return { ok: false, reason: `计划步骤 #${args.step_id} 不存在` };
		if (s.status === "done") return { ok: false, reason: `第 ${s.ord} 步已完成，不需要重做（要重做请 plan_amend 或 plan_insert 加一步）` };
		if (s.status === "dropped") return { ok: false, reason: `第 ${s.ord} 步已被丢弃，不能切到它（要恢复请 plan_insert 重新加一步）` };
		if (cur && cur.id !== s.id) {
			if (cur.kind === "plan") {
				d.prepare("UPDATE steps SET status='pending' WHERE id=?").run(cur.id);
			} else {
				// 从偏离态直接跳回计划：偏离被**中止**（不是完成），台账要看得见这个区别
				d.prepare("UPDATE steps SET status='skipped', done_at=? WHERE id=? AND status='active'").run(now(), cur.id);
				// I5：中止 ≠ 完成。欠账必须回到泊位继续挂着，绝不许静默消失
				if (cur.from_park) d.prepare("UPDATE parking SET status='parked', closed_at=NULL WHERE id=?").run(cur.from_park);
				log(d, "detour_abandoned", { planId: plan.id, stepId: cur.id, ref: `#${cur.from_park}`, detail: `${reason}（泊位 #${cur.from_park} 已退回待处理）` });
			}
		}
		d.prepare("UPDATE steps SET status='active', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), s.id);
		if (s.status === "blocked") log(d, "unblock", { planId: plan.id, stepId: s.id, detail: reason });
		setCurrent(d, plan.id, s.id);
		setBudget(d, plan.id, 0);
		log(d, "goto_step", { planId: plan.id, stepId: s.id, detail: reason });
		return { ok: true, step_id: s.id, briefing: anchorText(d, plan, { verdict: `焦点已切到第 ${s.ord} 步（理由：${reason}）` }) };
	}

	return { ok: false, reason: "必须给 step_id 或 park_id 之一" };
}

/** 6. plan_park：泊位清单（泊位条目永不自动消失，只能显式关闭） */
function planPark(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "没有生效计划" };
	const all = args.all === true;
	const rows = all
		? d.prepare("SELECT * FROM parking WHERE plan_id=? ORDER BY id ASC").all(plan.id)
		: openParking(d, plan.id);
	if (rows.length === 0) return { ok: true, count: 0, briefing: "🅿 泊位空 —— 没有欠账。" };
	const PARK_CN = { parked: "待处理", escalated: "偏离处理中", done: "已完成", declined: "已判定不做" };
	const lines = rows.map((p) => {
		const step = p.from_step ? stepById(d, p.from_step) : null;
		const where = step ? `第 ${step.ord} 步时发现` : "计划外发现";
		const st = PARK_CN[p.status] || p.status;
		const why = p.status === "declined" && p.note ? `｜不做理由：${p.note.slice(0, 60)}` : "";
		const back = p.status === "parked" && p.resume_when
			? `｜🔄 重启条件：${p.resume_when}${resumeLabel(d, p) ? `（${resumeLabel(d, p)}）` : ""}`
			: "";
		return `- ${parkLabel(d, p)} [${st}]${p.blocking ? " ⛔阻塞性" : ""} ${p.text}（${where}）${back}${why}`;
	});
	const parked = rows.filter((p) => p.status === "parked").length;
	return {
		ok: true,
		count: rows.length,
		parked,
		briefing: [
			`🅿 泊位清单（${parked} 条待处理 / 共 ${rows.length} 条）`,
			...lines,
			"",
			"处理原则：**只有当前计划步骤走完、或该条阻塞当前步时**才动它们。"
		].join("\n")
	};
}

/** 6b. plan_close：把泊位条目显式关闭（判定不做）。reason 必填 —— 禁止静默丢弃欠账。 */
function planClose(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "没有生效计划" };
	const p = d.prepare("SELECT * FROM parking WHERE id=?").get(Number(args.park_id));
	if (!p) return { ok: false, reason: `泊位 #${args.park_id} 不存在` };
	if (p.plan_id !== plan.id) return { ok: false, reason: `泊位 #${p.id} 不属于当前计划（它挂在计划 #${p.plan_id} 上，那条计划可能已被重规划取代）—— 重规划时未闭合的欠账会自动搬过来；若它仍挂在旧计划上，说明它当时已闭合。`, briefing: anchorText(d, plan) };
	if (p.status !== "parked") return { ok: false, reason: `泊位 #${p.id} 当前状态是「${p.status}」，只有待处理条目才能关闭` };
	const why = (args.reason || "").trim();
	if (!why) return { ok: false, reason: "reason 必填：为什么判定这条不做（禁止静默丢弃欠账）", briefing: anchorText(d, plan) };
	d.prepare("UPDATE parking SET status='declined', note=?, closed_at=? WHERE id=?").run(why, now(), p.id);
	// 两种关闭语义必须分开：真的做完了 ≠ 判定不做。以前只有后者，回执会说反话。
	const outcome = args.outcome === "resolved" ? "resolved" : "declined";
	if (outcome === "resolved") d.prepare("UPDATE parking SET status='done' WHERE id=?").run(p.id);
	log(d, outcome === "resolved" ? "park_resolved" : "park_declined", { planId: plan.id, stepId: p.from_step, ref: `#${p.id}`, detail: `${p.text} —— ${outcome === "resolved" ? "已解决" : "判定不做"}，理由：${why}` });
	const open = openParking(d, plan.id).length;
	return {
		ok: true,
		parking_id: p.id,
		outcome,
		parking_open: open,
		briefing: `【${outcome === "resolved" ? "已完成" : "已判定不做"}】${p.text}\n理由：${why}\n剩余待处理 ${open} 条。`
	};
}

/** 7. plan_log：漂移台账（append-only，由代码自动写） */
function planLog(d, args, scope = "") {
	const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
	const plan = activePlan(d, scope);
	const all = args.all === true;
	// 默认只看**本计划**的台账：以前是全局的，B 项目能看到 A 项目的记录
	// （红队抓到的；而我的测试当时只是靠 limit 窗口侥幸没撞上——测试通过不等于隔离成立）。
	const rows = all
		? d.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit)
		: plan
			? d.prepare("SELECT * FROM ledger WHERE plan_id = ? ORDER BY id DESC LIMIT ?").all(plan.id, limit)
			: [];
	if (rows.length === 0) {
		return {
			ok: true, count: 0,
			briefing: all ? "台账为空。" : "本计划还没有台账记录。（想看全部项目的历史，传 all=true。）"
		};
	}
	const KIND_CN = {
		plan_set: "立计划", replan: "重规划", step_done: "完成步骤", detour_done: "完成偏离",
		detour_abandoned: "中止偏离", discover_park: "新问题入泊", discover_block: "正式中断",
		discover_decline: "判定不做", park_declined: "判定不做（泊位关闭）", park_resolved: "欠账已解决", ask: "问询判定", zero_work_done: "无工具调用完成",
		drift_warning: "漂移提醒", guard_error: "护栏自身错误",
		cap_reached: "熔断放行", refused: "关卡拒绝", on_track: "在轨声明",
		goto_park: "提取泊位", goto_step: "切步", return_to_plan: "自动回归", unblock: "解除阻塞",
		mute: "静音提醒"
	};
	const lines = rows.map((r) => {
		const t = new Date(r.ts).toISOString().slice(11, 19);
		const s = r.step_id ? stepById(d, r.step_id) : null;
		const loc = s ? (s.kind === "detour" ? `额外步骤${s.detour_no}` : `主线第${s.ord}步`) : "";
		return `- ${t} ${KIND_CN[r.kind] || r.kind} ${loc} ${r.ref} ${r.detail ? "· " + r.detail.slice(0, 80) : ""}`.trim();
	});
	return { ok: true, count: rows.length, briefing: ["漂移台账（最近 " + rows.length + " 条，倒序" + (all ? "，全部项目" : `，仅本计划`) + "）", ...lines].join("\n") };
}

/**
 * 8b. plan_review：把"计划算不算完成"这个**语义判断**交给用户，
 * 并由代码守住一个**可观测前提**：自宣布最后一步完成以来，**用户必须真的回过话**。
 * （"用户有没有说话"是事实，不是猜测——所以这一条能硬判，而不是靠自觉。）
 */
function planReview(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划" };
	const since = Number(stGet(d, plan.id, "review_since", "0"));
	if (!since) return { ok: false, reason: "现在没有待确认的完成 —— 完成闸门只在「最后一步做完」时开启。" };
	const lastUser = Number(stGet(d, plan.id, "last_user_turn", "0"));
	if (lastUser <= since) {
		return {
			ok: false,
			reason: [
				"**你还没问过用户。**",
				"自你宣布最后一步完成以来，这个会话里**没有任何用户发言** —— 这是可观测事实，不是我的猜测。",
				"▶ 先用 `ask_user_question` 问：这个计划真的交付了吗？等用户真的回答了，再回来调 plan_review。",
				"（自始至终禁止的是**静默**：你可以判断完成，但不能不打招呼就替用户拍板。）"
			].join("\n")
		};
	}
	const note = (args.note || "").trim();
	const stepId = Number(stGet(d, plan.id, "review_step", "0") || 0);
	stDel(d, plan.id, "review_since");
	stDel(d, plan.id, "review_step");
	if (args.confirmed === true) {
		log(d, "plan_confirmed", { planId: plan.id, stepId, ref: "用户确认", detail: note || "用户确认计划完成" });
		const park = openParking(d, plan.id).length;
		return {
			ok: true,
			briefing: [
				`【计划已完成 · 用户确认】${plan.title}`,
				note ? `用户的话：${note}` : "",
				park ? `泊位还有 ${park} 条未闭合，别忘了（plan_park）。` : "泊位是空的。"
			].filter(Boolean).join("\n")
		};
	}
	// 用户说没完成 → 如实退回状态，而不是嘴上继续报"完成"
	if (stepId) {
		d.prepare("UPDATE steps SET status='active', done_at=NULL, evidence = evidence || ? WHERE id=?").run(`\n[用户判定未完成] ${note}`, stepId);
		setCurrent(d, plan.id, stepId);
	}
	log(d, "plan_rejected", { planId: plan.id, stepId, ref: "用户判定未完成", detail: note });
	const s = stepId ? stepById(d, stepId) : null;
	return {
		ok: true,
		briefing: [
			`【用户判定：没完成】${note}`,
			s ? `主线第 ${s.ord} 步「${s.text}」已**退回未完成**，焦点回到它。` : "",
			"▶ 把用户的意见变成行动：要改计划 → plan_set（带 reason）；它是个新问题 → plan_discover 判定处置。别只是嘴上改口。"
		].filter(Boolean).join("\n")
	};
}

// ---------- 计划修订：amend / insert / drop ----------
//
// 为什么要有这一套：**好计划不是一次定出来的，是执行中改出来的。**
// 原来只有 plan_set（整份重建）→ 在第 3 步想调计划，已完成的 1、2 步进度归零、焦点跳回第 1 步、
// 步骤身份全断（新行、新 id）。那是"换计划"的语义，不是"改计划"。
//
// 本节的模型：**改的是内容，不是身份**。
//   · 步骤以 id 为身份：amend 原地改文本/验收/scope，**不新建行、不丢历史、编号不变**
//   · insert 插入后**重排编号为连续 1..N**，但焦点与完成状态跟着 id 走，不会被带跑
//   · drop 只标记（status='dropped'，不删行），重排后编号收拢，理由留档
// 编号变化不是禁忌，**藏着不说才是**——所以每次修订都写台账，并在锚行上明说"编号怎么变了"。

function setRevisionNote(d, planId, text) { stSet(d, planId, "revision_note", text); }
function revisionNote(d, planId) { return stGet(d, planId, "revision_note", ""); }
function clearRevisionNote(d, planId) { stDel(d, planId, "revision_note"); }

/** 把步骤列表（字符串或对象混排）解析成统一结构。plan_set 与 plan_insert 共用。 */
function parseStepList(raw) {
	return (Array.isArray(raw) ? raw : []).map((s) => {
		if (s && typeof s === "object" && !Array.isArray(s)) {
			return {
				text: String(s.text ?? "").trim(),
				acceptance: String(s.acceptance ?? "").trim(),
				files: Array.isArray(s.files) ? s.files.map((x) => String(x)).filter(Boolean) : [],
				commands: Array.isArray(s.commands) ? s.commands.map((x) => String(x)).filter(Boolean) : []
			};
		}
		return { text: String(s ?? "").trim(), acceptance: "", files: [], commands: [] };
	}).filter((s) => s.text);
}

/**
 * 重排主线编号为连续 1..N（只动"活着"的步骤），返回"哪些步骤换了号"的映射文本。
 * 因为 current_step 存的是 **id**，重排不会让焦点跳到别的步骤上——这正是"用身份而非编号"的价值。
 */
function renumber(d, planId) {
	const rows = planSteps(d, planId);
	const upd = d.prepare("UPDATE steps SET ord = ? WHERE id = ?");
	const moved = [];
	for (let i = 0; i < rows.length; i++) {
		const want = i + 1;
		if (rows[i].ord !== want) moved.push(`「${rows[i].text.slice(0, 12)}」第${rows[i].ord}→第${want}步`);
		upd.run(want, rows[i].id);
	}
	return moved;
}

/** 额外步骤编号按**谱系**取 max：改计划不该让"额外步骤 1"指向两件不同的事。 */
function lineageDetourNo(d, plan) {
	const row = d.prepare(
		"SELECT COALESCE(MAX(s.detour_no),0) AS m FROM steps s JOIN plans p ON s.plan_id = p.id WHERE p.lineage_id = ? AND s.kind = 'detour'"
	).get(plan.lineage_id);
	return Number(row.m) + 1;
}
/** 谱系内的全部额外步骤（跨计划版本），用于让编号与计数保持连续。 */
function lineageDetours(d, plan) {
	return d.prepare(
		"SELECT s.* FROM steps s JOIN plans p ON s.plan_id = p.id WHERE p.lineage_id = ? AND s.kind = 'detour' ORDER BY s.detour_no ASC"
	).all(plan.lineage_id);
}

/** 9a. plan_amend：原地改一步的内容（保留 id、状态、历史；编号不变） */
function planAmend(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划" };
	const s = stepById(d, Number(args.step_id));
	if (!s || s.plan_id !== plan.id) return { ok: false, reason: `步骤 #${args.step_id} 不属于当前计划` };
	if (s.status === "dropped") return { ok: false, reason: `主线第 ${s.ord} 步已被丢弃，改它没有意义` };
	const reason = (args.reason || "").trim();
	if (!reason) {
		return {
			ok: false,
			reason: "reason 必填：为什么改这一步。（改计划本身是正当的——禁止的始终是**静默**改。）",
			briefing: anchorText(d, plan)
		};
	}
	const next = { text: s.text, acceptance: s.acceptance, scope_files: s.scope_files, scope_commands: s.scope_commands };
	const changes = [];
	if (args.text !== undefined) {
		const t = String(args.text).trim();
		if (!t) return { ok: false, reason: "text 不能为空" };
		if (t !== s.text) { changes.push(`文字：「${s.text}」→「${t}」`); next.text = t; }
	}
	if (args.acceptance !== undefined) {
		const a = String(args.acceptance).trim();
		if (a !== s.acceptance) { changes.push(`验收：「${s.acceptance || "（无）"}」→「${a || "（清空）"}」`); next.acceptance = a; }
	}
	if (args.files !== undefined) {
		const f = JSON.stringify((Array.isArray(args.files) ? args.files : []).map((x) => String(x)));
		if (f !== s.scope_files) { changes.push(`允许动的文件：→ ${f}`); next.scope_files = f; }
	}
	if (args.commands !== undefined) {
		const c = JSON.stringify((Array.isArray(args.commands) ? args.commands : []).map((x) => String(x)));
		if (c !== s.scope_commands) { changes.push(`允许跑的命令：→ ${c}`); next.scope_commands = c; }
	}
	if (!changes.length) return { ok: true, briefing: `主线第 ${s.ord} 步没有任何变化（你没给要改的字段）。` };
	d.prepare("UPDATE steps SET text=?, acceptance=?, scope_files=?, scope_commands=? WHERE id=?")
		.run(next.text, next.acceptance, next.scope_files, next.scope_commands, s.id);
	log(d, "amend", { planId: plan.id, stepId: s.id, ref: `主线第${s.ord}步`, detail: `${changes.join("；")}｜理由：${reason}` });
	return {
		ok: true,
		step_id: s.id,
		briefing: [
			`【已修订】主线第 ${s.ord} 步（**编号未变、身份未变、历史保留**${s.status === "done" ? "；注意这步已完成，改的是记录" : ""}）`,
			...changes.map((c) => `- ${c}`),
			`理由已记录：${reason}`
		].join("\n")
	};
}

/** 9b. plan_insert：在某一步之后插入步骤（当前焦点不会被带跑；编号顺延并明确告知） */
function planInsert(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划" };
	const reason = (args.reason || "").trim();
	if (!reason) return { ok: false, reason: "reason 必填：为什么要在这一步插入（禁止静默改计划）", briefing: anchorText(d, plan) };
	const afterId = Number(args.after_step_id || 0);
	let afterOrd = 0;
	if (afterId) {
		const a = stepById(d, afterId);
		if (!a || a.plan_id !== plan.id) return { ok: false, reason: `步骤 #${afterId} 不属于当前计划` };
		if (a.status === "dropped") return { ok: false, reason: `主线第 ${a.ord} 步已被丢弃，不能在它后面插入` };
		afterOrd = a.ord;
	}
	const parsed = parseStepList(args.steps);
	if (!parsed.length) return { ok: false, reason: "steps 不能为空：要插入的步骤得写出来" };

	// 先腾位置：让出 ord > afterOrd 的号段。
	// ⚠ 必须**先记下要被后移的是哪些步骤**，否则回执里就报不出"上线从第 5 步变成了第 7 步"——
	// 而"编号变了要说清"正是这一整块设计的意义所在。
	// 腾位置之前先记下"当前步"—— 决定焦点该不该跟
	const curBefore = currentStep(d, plan.id);
	const wantFocus = args.focus === true || (args.focus !== false && !!(curBefore && curBefore.kind === "plan" && afterOrd < curBefore.ord));
	const willShift = d.prepare("SELECT id, ord, text FROM steps WHERE plan_id=? AND kind='plan' AND ord > ? ORDER BY ord")
		.all(plan.id, afterOrd);
	d.prepare("UPDATE steps SET ord = ord + ? WHERE plan_id = ? AND kind = 'plan' AND ord > ?").run(parsed.length, plan.id, afterOrd);
	const ins = d.prepare("INSERT INTO steps (plan_id, ord, text, kind, acceptance, scope_files, scope_commands, status) VALUES (?,?,?,'plan',?,?,?,'pending')");
	const newIds = parsed.map((s, i) => Number(
		ins.run(plan.id, afterOrd + 1 + i, s.text, s.acceptance, JSON.stringify(s.files), JSON.stringify(s.commands)).lastInsertRowid
	));
	const shifts = willShift.map((s) => `「${s.text.slice(0, 12)}」第${s.ord}→第${s.ord + parsed.length}步`);
	const moved = [...shifts, ...renumber(d, plan.id)];

	// 焦点语义：
	//   插在**当前步之前** → 焦点跟到新插入的第一步（它现在排在你前面；不跟就会出现
	//     "当前在第 7 步、但第 1–6 步未完成"这种自相矛盾的状态）
	//   插在**当前步之后** → 焦点不动（手上正在做的活不该被打断）
	// 可用 focus: true / false 显式覆盖。
	let focusMsg = "";
	if (wantFocus) {
		if (curBefore && curBefore.kind === "plan") d.prepare("UPDATE steps SET status='pending' WHERE id=?").run(curBefore.id);
		setCurrent(d, plan.id, newIds[0]);
		focusMsg = `👉 焦点已跟到**新插入的第 ${afterOrd + 1} 步**`
			+ (curBefore && curBefore.kind === "plan" ? `（原当前步「${curBefore.text.slice(0, 14)}」已挂起，做完新插入的会自动回到它）` : "");
	}
	const where = afterOrd ? `主线第 ${afterOrd} 步之后` : "最前面";
	const note = `在${where}插入了 ${parsed.length} 步${moved.length ? `；编号顺延：${moved.join("，")}` : ""}`;
	log(d, "insert", { planId: plan.id, stepId: newIds[0], ref: `after 第${afterOrd}步`, detail: `${note}｜理由：${reason}` });
	setRevisionNote(d, plan.id, note);
	return {
		ok: true,
		inserted: newIds,
		briefing: [
			`【已插入】在${where}插入 ${parsed.length} 步`,
			...parsed.map((s, i) => `- 第 ${afterOrd + 1 + i} 步：${s.acceptance ? `${s.text}（验收：${s.acceptance}）` : s.text}`),
			moved.length ? `⚠ 编号已顺延：${moved.join("，")}（**步骤身份与完成状态跟着 id 走，没有被带跑**）` : "",
			focusMsg,
			`理由已记录：${reason}`,
			"",
			anchorText(d, plan, { verdict: "计划已修订，继续按新编号走" })
		].filter(Boolean).join("\n")
	};
}

/** 9c. plan_drop：丢弃一步（只标记不删行；若丢的是当前步，焦点顺延到下一个待办） */
function planDrop(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划" };
	const s = stepById(d, Number(args.step_id));
	if (!s || s.plan_id !== plan.id) return { ok: false, reason: `步骤 #${args.step_id} 不属于当前计划` };
	if (s.status === "dropped") return { ok: false, reason: `主线第 ${s.ord} 步已经被丢弃过了` };
	// 已完成区冻结（对齐 Camunda：迁移只改"未执行的部分"，已完成的活动原封不动）：
	// 允许 drop 一个已完成的步骤 = 把真实做过的工作从计数里抹掉，那不是"改计划"，是抹账。
	if (s.status === "done") {
		return {
			ok: false,
			reason: [
				`主线第 ${s.ord} 步**已完成**，不能丢弃 —— 已完成的部分是历史，不是可以随手改的草稿。`,
				"（对齐 Camunda 的做法：迁移只改「未执行的部分」，已完成的活动原封不动。）",
				"要修正它的记录（比如文字写错了）→ `plan_amend`；要整体重来 → `plan_set`（换计划）。"
			].join("\n"),
			briefing: anchorText(d, plan)
		};
	}
	const reason = (args.reason || "").trim();
	if (!reason) return { ok: false, reason: "reason 必填：为什么不做了（禁止静默丢弃计划里的一步）", briefing: anchorText(d, plan) };

	d.prepare("UPDATE steps SET status='dropped', drop_reason=? WHERE id=?").run(reason, s.id);
	// 连带隐患①：如果正在进行的偏离"回程票"指向这一步，丢弃后必须清掉，
	// 否则偏离结束时会把一个已丢弃的步骤**复活**成 active。
	if (Number(stGet(d, plan.id, "resume_step", "0")) === s.id) stDel(d, plan.id, "resume_step");
	let focusMsg = "";
	if (Number(stGet(d, plan.id, "current_step", "0")) === s.id) {
		const after = planSteps(d, plan.id).find((x) => x.status !== "done");
		setCurrent(d, plan.id, after ? after.id : null);
		focusMsg = after
			? `它原本是当前步 → 焦点已**顺延到主线第 ${after.ord} 步**：「${after.text}」`
			: "它原本是当前步 → 计划里已没有待办，焦点清空。";
	}
	const moved = renumber(d, plan.id);
	const note = `丢弃了原主线第 ${s.ord} 步「${s.text}」${moved.length ? `；编号收拢：${moved.join("，")}` : ""}`;
	log(d, "drop", { planId: plan.id, stepId: s.id, ref: `原第${s.ord}步`, detail: `${note}｜理由：${reason}` });
	setRevisionNote(d, plan.id, note);
	return {
		ok: true,
		briefing: [
			`【已丢弃】原主线第 ${s.ord} 步「${s.text}」`,
			focusMsg,
			moved.length ? `⚠ 编号已收拢：${moved.join("，")}（步骤身份与完成状态跟着 id 走）` : "",
			`理由已记录：${reason}`,
			"（行没有被删除，历史可查；台账里也留了这一笔。）"
		].filter(Boolean).join("\n")
	};
}

/**
 * 9d. plan_rework：执行中声明"某一步（可能早就完成了）的产出有问题，我要返工它"。
 *
 * 为什么需要它：carry 的 `replaced` 只能在**换计划**时声明；但真实场景是
 * "我做到第 5 步，发现第 1 步做错了" —— 这时候不该被迫重写整份计划。
 *
 * 建模：返工是**挂在旧步骤上的支线**（复用额外步骤机制），不是主线新的一步——
 * 因为它的执行顺序不属于主线，硬塞进主线会让编号暗示一个不存在的顺序。
 * 但**不计入偏离额度**：返工是纠错，不是跑偏，不该被当成漂移来收费。
 */
function planRework(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划" };
	const target = stepById(d, Number(args.step_id));
	if (!target || target.plan_id !== plan.id) return { ok: false, reason: `步骤 #${args.step_id} 不属于当前计划` };
	if (target.kind !== "plan") return { ok: false, reason: "只能对**主线步骤**开返工" };
	if (target.status === "dropped") return { ok: false, reason: `主线第 ${target.ord} 步已被丢弃，返工它没有意义` };
	const reason = (args.reason || "").trim();
	if (!reason) {
		return {
			ok: false,
			reason: "reason 必填：为什么判定这一步的产出有问题。返工是个重决定（会花掉真实的工作量），必须留痕。",
			briefing: anchorText(d, plan)
		};
	}
	const text = (args.text || "").trim() || `重做第 ${target.ord} 步：${target.text}`;
	const acceptance = (args.acceptance || "").trim();
	const cur = currentStep(d, plan.id);

	const dNo = lineageDetourNo(d, plan);
	const res = d.prepare(
		"INSERT INTO steps (plan_id, ord, detour_no, text, kind, from_park, rework_of, acceptance, status, started_at) VALUES (?,?,?,?,'detour',0,?,?,'active',?)"
	).run(plan.id, DETOUR_ORD_BASE + dNo, dNo, text, target.id, acceptance, now());
	const rid = Number(res.lastInsertRowid);
	// 手上那一步挂起，返工做完自动回来（复用偏离的回归机制）
	if (cur && cur.kind === "plan" && cur.id !== target.id) {
		d.prepare("UPDATE steps SET status='pending' WHERE id=?").run(cur.id);
		stSet(d, plan.id, "resume_step", cur.id);
	} else if (cur && cur.kind === "detour") {
		stSet(d, plan.id, "resume_step", Number(stGet(d, plan.id, "resume_step", "0")) || 0);
	}
	setCurrent(d, plan.id, rid);
	setBudget(d, plan.id, 0);
	log(d, "rework", { planId: plan.id, stepId: rid, ref: `取代 #${target.id}`, detail: `返工主线第 ${target.ord} 步「${target.text}」｜理由：${reason}` });
	const down = planSteps(d, plan.id).filter((s) => s.ord > target.ord);
	return {
		ok: true,
		rework_step_id: rid,
		briefing: [
			`【已开返工】记为**额外步骤 ${dNo}**：${text}`,
			`它取代的是主线第 ${target.ord} 步「${target.text}」${target.status === "done" ? "（该步之前标为已完成 —— 已完成区不删除、不篡改，只是**被取代**）" : ""}`,
			`理由已记录：${reason}`,
			cur && cur.kind === "plan" && cur.id !== target.id ? `主线第 ${cur.ord} 步「${cur.text}」已挂起 —— 返工做完 plan_step_done 会**自动回到它**。` : "",
			down.length ? `⚠ 下游有 ${down.length} 步建立在它之上（第 ${down.map((s) => s.ord).join("、")} 步）—— 返工完成后**该复查下游**；拿不准要不要重做，用 ask_user_question 问用户。` : "",
			"（返工不计入偏离额度：这是纠错，不是跑偏。）"
		].filter(Boolean).join("\n")
	};
}

/**
 * 9e. plan_note：声明「我仍在这一步上，进展是 X」。
 *
 * 为什么需要它（实测误报过 3 次之后才补上的）：漂移预算只认**计划状态变化**
 * （切步/完成/重规划），于是"同一步内的合法长活"会被判成"没推进"——
 * 实测误报过 3 次（连着 12 次调用做语料挖掘、连着十几次改代码，全都在当前步上）。
 * 它是"我在轨"的**唯一表达通道**：清零预算 + 进台账。
 * 台账记的是「自称在轨」，与「真的完成」严格区分 —— 可见化，而不是禁止。
 */
/**
 * 【计划遵守率】质问发出后，是否得到了"实质性响应"。
 * 依据：arXiv 2604.12147《From Plan to Action》—— 它把 plan compliance 量化测量了
 *（21,120 条轨迹）。我们没有这个数字时，"锚有没有被无视"只能靠感觉；
 * 有了它，那就是一个可查的指标，而不是印象。
 *
 * 判据：质问发出 → ask_open=1；之后**任何实质性动作**（在轨声明 / 步进 / 改计划 /
 * 开额外步骤 / 进入等待）→ 认领这一次质问，ask_answered++。
 */
function markAnswered(d, planId) {
	if (!planId) return;
	if (stGet(d, planId, "ask_open", "") !== "1") return;
	stDel(d, planId, "ask_open");
	stSet(d, planId, "ask_answered", String(Number(stGet(d, planId, "ask_answered", "0")) + 1));
}
/** 遵守率的显示行（没问过就不显示）。 */
function complianceLine(d, planId) {
	const total = Number(stGet(d, planId, "ask_total", "0"));
	if (!total) return "";
	const ans = Number(stGet(d, planId, "ask_answered", "0"));
	const open = stGet(d, planId, "ask_open", "") === "1";
	const rate = total ? Math.round((ans / total) * 100) : 0;
	return `📊 这条质问问过 ${total} 次，其中 ${ans} 次有响应（遵守率 ${rate}%）${open ? " —— **当前这一次还没回应**" : ""}`;
}

function planNote(d, args, scope = "", session = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划 —— 没有计划就没有预算可清。" };
	const cur = currentStep(d, plan.id);
	const text = (args.text || "").trim();
	if (!text) return { ok: false, reason: "text 必填：一句话说清你这一步目前的进展 —— 空话不算在轨依据。" };
	const before = budget(d, plan.id);
	setBudget(d, plan.id, 0);
	stSet(d, plan.id, "on_track_note", text);
	markAnswered(d, plan.id);   // 【计划遵守率】这是一次实质响应
	// 声明"我在推进"就等于宣告**等待结束**（唤醒条件已满足）—— 所以顺手清掉等待状态
	for (const k of ["waiting_what", "waiting_until", "waiting_timeout", "waiting_turns", "waiting_limit", "waiting_step"]) stDel(d, plan.id, k);
	// 【修·问过就不再问】把当前指纹记为「已答复」—— 锚下次看到同一个指纹时不再重复质问。
	// 不这样做的后果实测过：我用 plan_note 答了它，下一回合它还是一模一样的质问句，
	// 于是"质问"自己也变成了墙纸。
	stSet(d, plan.id, "anchor_ack_sig", anchorSignature(d, plan));
	stSet(d, plan.id, "anchor_ack_age", "0");
	log(d, "on_track", { planId: plan.id, stepId: cur ? cur.id : 0, ref: `清零 ${Math.round(before * 10) / 10}`, detail: text, session });
	return {
		ok: true,
		briefing: [
			`【在轨声明已记录】${text}`,
			`漂移预算已清零（原 ${Math.round(before * 10) / 10}）${cur ? `；当前仍在主线第 ${cur.ord} 步「${cur.text}」` : ""}。`,
			"（台账记的是「自称在轨」—— 它与「真的完成」是两回事；真做完请 plan_step_done。）"
		].join("\n")
	};
}

/** 去掉内部批次代号 —— 给人看的文本里不许出现。 */
function cleanForHuman(s) {
	return String(s || "")
		// 注意带上结尾字母：只剥到序号会留下一个光秃秃的字母（真用一次才发现的）
		.replace(/批\s*\d+\s*[-－]?\s*[①②③④⑤⑥⑦⑧⑨⑩a-zA-Z]*\s*/g, "")
		.replace(/【[^】]*】/g, "")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s、，。:：-]+/, "")
		.trim();
}

/**
 * 9f. plan_report：**给人看的整理稿**。
 *
 * 分工是刻意的（也是被现场教出来的）：
 *   · **数据部分由本工具从计划本体直接生成** —— 不漏、不编（手写顶替曾当场漏项：8 件写成 7 件）
 *   · **叙述部分（一句话 / 这一段发现了什么 / 建议）留给 agent** —— 工具看不到那些，硬编就是编
 * 硬约束：零 id、零内部代号、零机器术语；**必须能直接贴给用户看**。
 */
function planReport(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划 —— 没有计划就没有可整理的东西。" };
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const done = steps.filter((s) => s.status === "done");
	const todo = steps.filter((s) => s.status !== "done");
	const park = openParking(d, plan.id);
	const dts = lineageDetours(d, plan);
	const L = [];
	L.push(`**${cleanForHuman(plan.title)}**`);
	L.push(`进度：${done.length}/${steps.length} 件做完${dts.length ? `；另有 ${dts.filter((s) => s.status === "done").length}/${dts.length} 个临时加的任务完成` : ""}`);
	// 起点：最近一次"计划扩充/更换"
	const rev = d.prepare("SELECT ts, kind, detail FROM ledger WHERE plan_id=? AND kind IN ('insert','replan') ORDER BY id DESC LIMIT 1").get(plan.id);
	if (rev) {
		const day = new Date(rev.ts).toISOString().slice(0, 10);
		// 只取「理由」那半句：台账原文前半段全是内部代号与编号位移，倒给用户看没有意义
		const why = String(rev.detail).split("｜理由：")[1] || "";
		L.push(`这一段的起点：${day} 的一次「${rev.kind === "insert" ? "计划扩充" : "计划更换"}」${why ? `——${cleanForHuman(why).slice(0, 60)}` : ""}`);
	}
	L.push("");
	L.push(`## 已经做完的（${done.length} 件）`);
	L.push(done.length ? done.map((s) => `- ✅ ${cleanForHuman(s.text)}`).join("\n") : "- （还没有）");
	L.push("");
	L.push(`## 要做还没做的（${todo.length} 件）`);
	if (todo.length) {
		let n = 0;
		for (const s of todo) {
			n++;
			const here = cur && s.id === cur.id;
			L.push(`${n}. ${here ? "**👉 正在做：**" : ""}${cleanForHuman(s.text)}`);
			if (s.acceptance) L.push(`   - 怎么算做完：${cleanForHuman(s.acceptance).slice(0, 140)}`);
		}
	} else L.push("- （没有）");
	if (dts.length) {
		L.push("");
		L.push(`## 临时加进来的任务（${dts.length} 个）`);
		L.push(dts.map((s) => `- ${s.status === "done" ? "✅" : "·"} ${cleanForHuman(s.text)}`).join("\n"));
	}
	L.push("");
	L.push(`## 先记下、回头再处理（${park.length} 笔）`);
	if (park.length) {
		for (const p of park) {
			// 回程条件优先用"步骤身份"的说法；没有绑步骤时**退回用户写的重启条件原文**（那也是"什么时候"的答案）
			const when = resumeLabel(d, p) || cleanForHuman(p.resume_when);
			L.push(`- ${cleanForHuman(p.text)}${when ? `（什么时候回头处理：${cleanForHuman(when)}）` : ""}`);
		}
	} else L.push("- （没有欠账）");
	L.push("");
	L.push("---");
	L.push("**以下两段工具生成不了，必须 agent 自己写、并标明是判断：**");
	L.push("① **一句话**：我们在干什么");
	L.push("② **这一段发现的问题**（已解决 / 没解决）");
	L.push("③ **建议**（哪些其实是一件事、有没有重复、建议先做哪个）—— 必须单独标注「这是建议」");
	return { ok: true, briefing: L.join("\n") };
}

/**
 * 9g. plan_ask：**该不该问用户** —— 规则全部来自一手材料（不是我们拍的）：
 *   · AAEF《审批质量与审批疲劳》：批准不构成授权，除非批准者有足够的**上下文、能力、时间、独立性**；
 *     泛泛的问只是 "approval-shaped friction"（有审批的形，没有审批的实质）
 *   · Horvitz 期望值：E[打扰] = P(相关)×收益 − (1−P)×误扰成本 → 被问多次后，**连相关的问题都该闭嘴**
 *   · Carey & Everitt《Human Control》：因"对方不理智"而忽略指令是**被命名的失败模式**；
 *     且 agent 不得 "inappropriately influence" 用户下决定的能力（只摆一边事实 = 不当影响）
 * 三档：must（必问，不许静默继续）| once（问一次，照办）| note（不问，只记账，收尾时一起摆）
 */
const ASK_KINDS = {
	irreversible: "must", // 不可逆动作：删除 / 覆盖 / 发布 / 对外提交
	acceptance: "must",   // 验收判据的最终确认
	"scope-out": "must",  // 超出已批准范围的新工作
	conflict: "once",     // 发现与原计划冲突的事实
	structure: "once",    // 要改计划结构（插入 / 丢弃 / 重规划）
	uncertain: "once",    // 拿不准算不算偏离
	detail: "note",       // 纯执行细节
	authorized: "note"    // 用户明确授权过的类别
};

function planAsk(d, args, scope = "", session = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划 —— 没有计划就谈不上「偏离计划」。" };
	const kind = String(args.kind || "").trim();
	if (!ASK_KINDS[kind]) {
		return {
			ok: false,
			reason: `kind 必须是以下之一：${Object.keys(ASK_KINDS).join(" / ")}\n`
				+ "分档依据：不可逆 / 验收 / 超范围 = 必问；冲突 / 改结构 / 拿不准 = 问一次；细节 / 已授权 = 只记账。"
		};
	}
	const what = String(args.what || "").trim();
	// 铁律一：不许泛泛地问 —— 必须说清具体动作（否则就是 approval-shaped friction）
	if (what.length < 6) {
		return {
			ok: false,
			reason: "what 必填且要具体：说清**要做什么动作、影响什么**。\n"
				+ "泛泛地问（如「要改计划吗？」）只是 approval-shaped friction —— 有审批的形，没有审批的实质。"
		};
	}
	let tier = ASK_KINDS[kind];
	const day = new Date().toISOString().slice(0, 10);
	const askedToday = Number(stGet(d, plan.id, `asked:${day}`, "0"));
	// 期望值那条的可操作形式：今天已经问够了 → 非必问的降级为"记账"（防审批疲劳）
	const downgraded = tier === "once" && askedToday >= askBudget;
	if (downgraded) tier = "note";
	if (tier !== "note") {
		stSet(d, plan.id, `asked:${day}`, String(askedToday + 1));
		log(d, "ask", { planId: plan.id, ref: kind, detail: `${tier}｜${what}`, session });
	}
	const head = tier === "must"
		? "【必问 —— 不许静默继续】"
		: tier === "once"
			? "【问一次，他怎么说就怎么办】"
			: "【不问，只记账】";
	return {
		ok: true,
		tier,
		asked_today: askedToday + (tier === "note" ? 0 : 1),
		briefing: [
			`${head}${downgraded ? `（今天已经问过 ${askedToday} 次，按期望值降级为「只记账」—— 收尾时一起摆给他看）` : ""}`,
			`要问的具体动作：${what}`,
			"",
			"问的时候**必须两边都给**（只摆一边 = 不当影响）：",
			"  · 照做的理由：…",
			"  · 不照做的理由（含代价与不可逆性）：…",
			"  · 我的建议：…（标明这是建议）",
			"",
			tier === "note"
				? "→ **不要问**：写进台账，等计划收尾（完成闸门那一步）再一起摆出来。"
				: "→ 用 ask_user_question 问，然后把他的答复**如实**记账。",
			"⚠ 铁律：**绝不因为「用户可能不理智」而不听他的决定** —— 只允许「提出一次 + 摊开代价 + 照办 + 记账」。"
		].join("\n")
	};
}

/**
 * 9h. plan_detour：**「我现在要去做一件主线之外的事」** —— 直接开一条额外步骤。
 *
 * 为什么需要它（用户一眼看出来的缺口）：
 *   质问只给了三个选项（在推进 / 卡住了 / 不想做了），但真实使用里最常见的第四种是
 *   —— **「我在做用户另外要求的一件事」**。而现有能力里，开额外步骤必须先入泊再提取（两步），
 *   于是发生这种事时只能靠 plan_note 嘴上说一句「我在推进」，**它从来没进过计划**。
 *
 * 与 plan_discover(permit) 的区别：permit 是**我自己跑去追**新问题（记偏离）；
 *   这个是**用户要我做**的事（不记偏离 —— 用户改方向不是跑偏）。
 * 与 plan_rework 的区别：那个是重做某个旧步骤的产出，带 rework_of 链接。
 */
function planDetour(d, args, scope = "", session = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划 —— 没有主线，就谈不上「主线之外」。" };
	const text = (args.text || "").trim();
	if (!text) return { ok: false, reason: "text 必填：这件「主线之外的事」是什么？" };
	const reason = (args.reason || "").trim();
	const acceptance = (args.acceptance || "").trim();
	const cur = currentStep(d, plan.id);
	const dNo = lineageDetourNo(d, plan);
	const res = d.prepare(
		"INSERT INTO steps (plan_id, ord, detour_no, text, kind, from_park, acceptance, status, started_at) VALUES (?,?,?,?,'detour',0,?,'active',?)"
	).run(plan.id, DETOUR_ORD_BASE + dNo, dNo, text, acceptance, now());
	const rid = Number(res.lastInsertRowid);
	if (cur && cur.kind === "plan") {
		d.prepare("UPDATE steps SET status='pending' WHERE id=?").run(cur.id);
		stSet(d, plan.id, "resume_step", cur.id);
	}
	setCurrent(d, plan.id, rid);
	setBudget(d, plan.id, 0);
	log(d, "detour", { planId: plan.id, stepId: rid, ref: `额外 ${dNo}`, detail: `${text}${reason ? `｜因为：${reason}` : ""}`, session });
	return {
		ok: true,
		detour_no: dNo,
		briefing: [
			`【已开一条额外步骤 ${dNo}】${text}`,
			reason ? `理由已记录：${reason}` : "",
			cur && cur.kind === "plan" ? `主线第 ${cur.ord} 步「${cur.text}」已挂起 —— 做完这条 plan_step_done 会**自动回到它**。` : "",
			"（额外步骤**不计偏离额度**：它是「要做的活」，不是「跑偏」。主线仍然是主线，它只是岔出去的一条。）"
		].filter(Boolean).join("\n")
	};
}

/**
 * 9i. plan_wait：**「我在等 X」** —— 把"等待"变成一个显式状态，而不是含糊的"在推进"。
 *
 * 依据（都是别人踩过的）：
 *   · `blocked.md`（给 AI agent 写的规范）：*blocked means implementation cannot proceed and
 *     **only a human can unblock it**. Stop, set status: blocked, and escalate.*
 *     —— 判据是「**重试也没用**」。这条能把"等待"和"卡住了"分开。
 *   · agent 状态机实践（bunq）：**Pauses are just "stop and wait for the next API call"**，
 *     且状态里有显式的 AWAITING_ANSWERS / AWAITING_APPROVAL。
 *   · Temporal 的人机回路教程：等待用 **Signal**（唤醒条件）+ **Durable Timer**（超时截止）。
 *
 * 所以「等待」不是一张标签，而是**三要素 + 两条出边**：
 *   等谁/等什么 · 什么算等到了 · **超时怎么办**；出边 = ①唤醒 ②超时。
 *
 * 两条硬规矩：
 *   · **等待不涨漂移预算** —— 等外部不是我的错（等自己才是漂移）。
 *   · **必须写明超时之后干什么** —— 否则"等待"就成了一张免死金牌。
 */
function planWait(d, args, scope = "", session = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划。" };
	const what = (args.what || "").trim();
	const until = (args.until || "").trim();
	const onTimeout = (args.on_timeout || "").trim();
	if (!what || !until) {
		return {
			ok: false,
			reason: "what（在等什么）和 until（什么条件算等到了）**都必须写** ——\n"
				+ "「在多等一个外部依赖」这种没头没尾的声明，就是给漂移开后门。\n"
				+ "参照 blocked 的判据：**只有「重试也没用、只能等外部」的事才算等待。**"
		};
	}
	if (!onTimeout) {
		return {
			ok: false,
			reason: "on_timeout（**超时之后怎么办**）必填 —— 等待必须有两条出边：①唤醒 ②超时。\n"
				+ "BPMN 叫「边界定时器事件」，Temporal 叫「durable timer」，都是同一个东西。\n"
				+ "少了这条边，等待就变成无限期免死金牌。例如：「超时就先跳过这步、去做别的」。"
		};
	}
	const turns = Math.max(1, Math.min(50, Number(args.timeout_turns ?? 8)));
	const cur = currentStep(d, plan.id);
	stSet(d, plan.id, "waiting_what", what);
	stSet(d, plan.id, "waiting_until", until);
	stSet(d, plan.id, "waiting_timeout", onTimeout);
	stSet(d, plan.id, "waiting_turns", "0");
	stSet(d, plan.id, "waiting_limit", String(turns));
	stSet(d, plan.id, "waiting_step", String(cur ? cur.id : 0));
	// 等待期间不该被"停滞质问"打扰 —— 记下当前指纹，锚会认出"这是明知的等待"
	stSet(d, plan.id, "anchor_ack_sig", anchorSignature(d, plan));
	stSet(d, plan.id, "anchor_ack_age", "0");
	setBudget(d, plan.id, 0);
	log(d, "wait", { planId: plan.id, stepId: cur ? cur.id : 0, ref: "等待", detail: `等：${what}｜等到：${until}｜超时(${turns}回合)：${onTimeout}`, session });
	return {
		ok: true,
		briefing: [
			`⏸【已进入等待】${what}`,
			`   唤醒条件：${until}`,
			`   超时：${turns} 回合 · 超时之后 → ${onTimeout}`,
			"（等待期间**不涨漂移预算**，也不会被停滞质问打扰 —— 等外部不是你的错。",
			"  但**超时那条边是实的**：到点它会把你叫回来。用户发言也算一次唤醒。）"
		].join("\n")
	};
}

/** 9. plan_mute：静音提醒 N 次工具调用（防"哭狼来了"，但计划仍在，只是不主动打扰） */
/** 【第 6 件 · flow mode 式有限豁免】静音不是"关掉护栏"：必须有理由、有硬上限、到期自动恢复并温和 check-in。 */
function planMute(d, args, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return { ok: false, reason: "当前项目没有生效计划 —— 没有计划就没有提醒可静音。" };
	const reason = (args.reason || "").trim();
	if (!reason) {
		return {
			ok: false,
			reason: "reason 必填：为什么现在需要安静一段时间。\n（静音不是免责——计划和台账照旧，只是暂停打扰；到期我还会温和问你一句。）"
		};
	}
	const n = Math.max(1, Math.min(muteCap, Number(args.calls ?? 20)));
	stSet(d, plan.id, "mute", n);
	stSet(d, plan.id, "mute_pending_checkin", "1");
	log(d, "mute", { planId: plan.id, ref: `${n} 次调用`, detail: reason });
	return {
		ok: true,
		mute_calls: n,
		mute_cap: muteCap,
		briefing: [
			`已静音：接下来 ${n} 次工具调用内不主动提醒（硬上限 ${muteCap}）。`,
			`理由已记录：${reason}`,
			"到期后会**温和问你一句**（刚才完成了什么、还在不在计划上）—— 静音是暂停打扰，不是免责。"
		].join("\n")
	};
}

// ---------- 通知（注入模型上下文的提醒） ----------

/** 构造一条带来源归属的合成 user 消息 —— 抄官方 guard 的写法（不加标注会被当成用户发言）。 */
function notice(text, summary) {
	const message = {
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: "plan-anchor", form: "notice", summary },
		id: randomUUID()
	};
	return Object.freeze(message);
}

/**
 * 锚的"状态指纹"：只含**真正该让人看见的变化**（版本、进度、当前步、泊位）。
 * 预算故意不算 —— 预算在涨而别的没动，恰恰是"卡住了"，那才更该说话。
 */
function anchorSignature(d, plan) {
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const dts = detourSteps(d, plan.id);
	return [
		plan.version,
		`${steps.filter((s) => s.status === "done").length}/${steps.length}`,
		cur ? `${cur.kind}:${cur.ord}:${cur.id}` : "none",
		openParking(d, plan.id).length,
		`${dts.filter((s) => s.status === "done").length}/${dts.length}`
	].join("|");
}

/**
 * 连续多少回合"指纹"不变，就不再复读同一句，改成**质问**。
 * 为什么要有这个：实测本插件的锚连续十几回合一模一样，结果作者本人都开始无视它 ——
 * **一个只重复的提醒，无论多重要，第 10 次之后都会失效。** 它变成了墙纸。
 * 提醒的价值不在"说了什么"，在**"它变了没有"**。
 */
const ANCHOR_STALE_AT = 3;

/**
 * 「已声明在轨」的**时效**（回合数）。
 * 为什么必须有：用户一眼看出的漏洞 —— 我声明在轨 → 锚安静 → 然后连续几十轮都在做别的事，
 * 而计划状态一个字没动、指纹也没变 → **锚会一直安静下去，我就这么漂走了**。
 * 那正是这工具存在的理由。所以豁免必须是**有时效的**，到期重新问，而且要问得更重。
 * （同一套思路 plan_mute 早就有了：静音有上限、到期温和 check-in。这里当时没复用，是失误。）
 */
const ANCHOR_ACK_TTL = 5;

/** 回合锚：每个用户回合的第一次工具调用后，把计划放回眼前。**内容会自适应：变了给全的，没变缩短，一直没变就质问。** */
function turnAnchorNotice(d, scope = "") {
	const plan = activePlan(d, scope);
	if (!plan) return null;
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const park = openParking(d, plan.id).length;
	const dts = detourSteps(d, plan.id);
	const dtInfo = dts.length ? `｜额外步骤 ${dts.filter((s) => s.status === "done").length}/${dts.length}` : "";
	const doneN = steps.filter((s) => s.status === "done").length;

	// —— 【等待状态】显式等待优先于一切"停滞"判断 ——
	//   依据：blocked.md 判据（"重试也没用、只能等外部"）+ Temporal 的 Signal/Timer 两条出边。
	const wWhat = stGet(d, plan.id, "waiting_what", "");
	if (wWhat) {
		const wn = Number(stGet(d, plan.id, "waiting_turns", "0")) + 1;
		const wlim = Number(stGet(d, plan.id, "waiting_limit", "8"));
		const wUntil = stGet(d, plan.id, "waiting_until", "");
		const wTo = stGet(d, plan.id, "waiting_timeout", "");
		if (wn > wlim) {
			// ⏰ 第二条边：超时 —— 把它叫回来，并且提醒"当初说好怎么办"
			for (const k of ["waiting_what", "waiting_until", "waiting_timeout", "waiting_turns", "waiting_limit", "waiting_step"]) stDel(d, plan.id, k);
			stDel(d, plan.id, "anchor_ack_sig");
			return notice([
				`⏰【计划锚】**你等的「${wWhat}」已经 ${wn} 回合没动静了。**`,
				`   唤醒条件：${wUntil}`,
				`   当初说好超时之后：**${wTo}**`,
				"",
				"现在按当初说好的办，别继续干等。",
				"（等待有两条出边：**唤醒** 或 **超时**。你现在走到超时这边了。想继续等 → 再 plan_wait 一次并重新说明。）"
			].join("\n"), "plan anchor (wait timed out)");
		}
		stSet(d, plan.id, "waiting_turns", String(wn));
		return notice(
			`⏸【计划锚】在等：${wWhat}｜等到：${wUntil}｜第 ${wn}/${wlim} 回合${cur ? `｜（第 ${cur.ord} 步挂着）` : ""}`,
			"plan anchor (waiting)"
		);
	}

	// —— 自适应（①）：指纹没变就别说同样的话 ——
	const sig = anchorSignature(d, plan);
	const prevSig = stGet(d, plan.id, "anchor_sig", "");
	const n = prevSig === sig ? Number(stGet(d, plan.id, "anchor_sig_n", "0")) + 1 : 1;
	stSet(d, plan.id, "anchor_sig", sig);
	stSet(d, plan.id, "anchor_sig_n", String(n));

	if (n >= ANCHOR_STALE_AT) {
		// 【问过就不再问】如果这个指纹已经被答复过（plan_note 声明在轨），就别再问第二遍 ——
		// 否则"质问"会和"复读"一样退化成墙纸。等状态真的变了（指纹变）自然会重新开口。
		// 【关键修正】不再**质问**，但**锚必须还在** —— "闭嘴"和"消失"是两回事：
		// 该闭嘴的是催问（噪声），绝不能消失的是锚本身（那是这工具存在的理由）。
		// 我第一版写成 return null（连锚都不注入），那是把"别唠叨"做成了"别出现"，是错的。
		if (stGet(d, plan.id, "anchor_ack_sig", "") === sig) {
			const age = Number(stGet(d, plan.id, "anchor_ack_age", "0")) + 1;
			stSet(d, plan.id, "anchor_ack_age", String(age));
			if (age <= ANCHOR_ACK_TTL) {
				// 豁免期内：**锚仍在**（闭嘴≠消失），只是不追问，并如实标出还剩几回合
				const tail = cur ? `｜第 ${cur.ord} 步` : "";
				return notice(
					`【计划锚】${plan.title}｜${doneN}/${steps.length} 步${tail}${park ? `｜泊位 ${park}` : ""}（已声明在轨 · 豁免第 ${age}/${ANCHOR_ACK_TTL} 回合）`,
					"plan anchor (acked)"
				);
			}
			// 【豁免到期】重新问，而且问得更重 —— 因为"声明在轨这么久、计划却一步没动"本身就可疑
			stDel(d, plan.id, "anchor_ack_sig");
			stDel(d, plan.id, "anchor_ack_age");
			// 【计划遵守率】记一笔"质问发出"（可测量的事实，不是印象）
			stSet(d, plan.id, "ask_total", String(Number(stGet(d, plan.id, "ask_total", "0")) + 1));
			stSet(d, plan.id, "ask_open", "1");
			return notice([
				`⚠【计划锚】**你声明「在轨」已经 ${age} 回合了，但计划一步没动。**`,
				complianceLine(d, plan.id),
				cur ? `   还停在第 ${cur.ord} 步「${cur.text}」（主线 ${doneN}/${steps.length}）` : `   主线无进行中步骤（${doneN}/${steps.length}）`,
				"",
				"三种可能，选一个说清楚：",
				"  · **这一步其实不该这么做** → `plan_amend` 改它 / `plan_drop` 丢掉 / `plan_set` 换计划",
				"  · **确实还在做它** → 再 `plan_note` 一次（但顺带想想：为什么这么久没进展？）",
				"  · **你在做用户另外要的事**（不是主线这一步）→ `plan_detour` 把它开成一条额外步骤：主线挂起、做完自动回来、**不计偏离**。别让它只活在对话里。",
				"",
				"（豁免是有的，但**不会永久** —— 否则你漂走了也没人提醒你。）"
			].join("\n"), "plan anchor (ack expired)");
		}
		// 【计划遵守率】同上
		stSet(d, plan.id, "ask_total", String(Number(stGet(d, plan.id, "ask_total", "0")) + 1));
		stSet(d, plan.id, "ask_open", "1");
		return notice([
			`⚠【计划锚】**计划已经 ${n} 回合没有任何变化** —— 还停在这里：`,
			complianceLine(d, plan.id),
			cur ? `   第 ${cur.ord} 步「${cur.text}」（主线 ${doneN}/${steps.length}）` : `   主线无进行中步骤（${doneN}/${steps.length}）`,
			park ? `   另有 ${park} 条欠账挂着。` : "",
			"这是**真的在推进**，还是**卡住了**？四选一：",
			"  · 在推进**这一步** → `plan_note` 说一句进展（预算清零）",
			"  · **在做用户另外要的事**（不是这一步）→ `plan_detour` 把它开成一条额外步骤：主线挂起、做完自动回来、**不计偏离**。别让它只活在对话里。",
			"  · 卡住了 → `plan_discover` 处置，或 `plan_amend` 改这一步",
			"  · 不想做了 → `plan_drop` 丢掉它 / `plan_set` 换计划"
		].filter(Boolean).join("\n"), "plan anchor (stalled)");
	}
	if (n > 1) {
		// 上回合变过、这回合没变 → 缩成一行
		return notice(
			`【计划锚】${plan.title}｜${doneN}/${steps.length} 步${cur ? `｜第 ${cur.ord} 步` : ""}${park ? `｜泊位 ${park}` : "｜泊位空"}（与上回合相同，已缩短）`,
			"plan anchor (compact)"
		);
	}

	const bits = [`【计划锚】${plan.title}｜主线 ${doneN}/${steps.length} 步${dtInfo}`];
	if (cur && cur.kind === "detour") {
		const r = stGet(d, plan.id, "resume_step");
		const rs = r ? stepById(d, Number(r)) : null;
		bits.push(`在做额外步骤 ${cur.detour_no}：${cur.text}${rs ? `（主线第 ${rs.ord} 步已挂起）` : ""}`);
	} else if (cur) {
		bits.push(`主线第 ${cur.ord} 步：${cur.text}`);
	} else {
		bits.push("主线无进行中步骤");
	}
	// 【计划膨胀】长了多少，明说 —— 论文（arXiv 2604.12147）实测：早期插入额外阶段
	// 可能反而降低表现，尤其当它不符合模型内在的解题策略时。所以这该是个看得见的数字。
	const birth = Number(stGet(d, plan.id, "birth_steps", "0"));
	if (birth && steps.length > birth) bits.push(`📈 计划已从 ${birth} 步长到 ${steps.length} 步（后加 ${steps.length - birth}）`);
	bits.push(park ? `泊位 ${park} 条未处理` : "泊位空");
	return notice(bits.join("｜") + "\n新发现的问题请先 plan_discover 显式判定处置（permit/defer/decline），不要直接开工。", "plan anchor");
}

/** 漂移提醒：两档升级（轻 → 重），每档每步只响一次。 */
function driftNotice(d, plan) {
	const b = budget(d, plan.id);
	const cur = currentStep(d, plan.id);
	const gentle = threshold;
	const firm = escalateAt;
	const stage = b >= firm ? "firm" : b >= gentle ? "gentle" : null;
	if (!stage) return null;
	// 同一档在同一步只响一次（fired 集合以 "stepId:stage" 为键）
	const key = `${cur ? cur.id : 0}:${stage}`;
	const fired = stGet(d, plan.id, "drift_fired", "");
	if (fired.split(",").includes(key)) return null;
	stSet(d, plan.id, "drift_fired", fired ? fired + "," + key : key);

	const steps = planSteps(d, plan.id);
	const park = openParking(d, plan.id);
	const target = cur && cur.kind === "detour"
		? `**额外步骤 ${cur.detour_no}**「${cur.text}」`
		: cur ? `**主线第 ${cur.ord}/${steps.length} 步**「${cur.text}」` : "当前计划";
	// **必须真的记账**：正文里写着"漂移台账已记录"，那就得真记。
	// （红队抓到的：以前只写了 fired 计数、台账里什么都没有 —— 那是对模型撒谎。）
	log(d, "drift_warning", {
		planId: plan.id, stepId: cur ? cur.id : 0, ref: `第 ${b} 次无进展调用`,
		detail: `${stage === "firm" ? "二次" : "轻"}提醒已发出（${target.replace(/\*/g, "")}）`
	});
	const head = stage === "gentle"
		? `${toneHead("gentle")}你已连续 ${b} 次工具调用没有推进${target}。`
		: `${toneHead("firm")}又过去了 ${b} 次调用，${target}仍未推进。漂移台账已记录此次偏离。`;
	return notice([
		head,
		"先停一下，明确回答：你手上正在做的事，属于上面这条吗？",
		"- 是新发现的问题 → plan_discover 显式判定：permit（阻塞当前步，现在做）/ defer（入泊，稍后）/ decline（判定不做）",
		"- 它卡住了当前步 → disposition=\"permit\" 走正式中断",
		"- 原计划已不成立 → plan_set 带 reason 显式重规划",
		"- **拿不准自己偏没偏 → 直接用 `ask_user_question` 问用户：「你觉得我现在偏离计划了吗？」**（这比我自己猜可靠得多）",
		"- **如果你确实在做当前这一步的长活 → `plan_note(text)` 声明进展**（一句话），预算立刻清零并记台账 —— 免得合法长活被误判成漂移",
		park.length ? `泊位现有 ${park.length} 条未处理。` : ""
	].filter(Boolean).join("\n"), `drift ×${b}`);
}

/** 开新活提醒：在计划步骤未完成时调用"开新活"类工具 → 轻提醒一次（每步一次）。 */
function newWorkNotice(d, plan, toolName) {
	const cur = currentStep(d, plan.id);
	if (!cur) return null;
	if (stGet(d, plan.id, "newwork_fired") === String(cur.id)) return null;
	stSet(d, plan.id, "newwork_fired", String(cur.id));
	const label = cur.kind === "detour" ? `**额外步骤 ${cur.detour_no}**「${cur.text}」` : `**主线第 ${cur.ord} 步**「${cur.text}」`;
	return notice([
		`【计划锚】你正在做${label}，却调用了 \`${toolName}\` 开了一项新活。`,
		"如果这来自执行中冒出的新问题：先 plan_discover 显式判定（permit/defer/decline），再决定要不要现在做。",
		"如果它确实属于当前步骤：忽略本条，继续。"
	].join("\n"), `new work during ${cur.kind === "detour" ? `detour ${cur.detour_no}` : "step " + cur.ord}`);
}

// ---------- 接线 ----------

let threshold = 12;
let escalateAt = 24;
let detourBudget = 3;
let refuseCap = 5;
let scopeMode = "observe";
let completionGate = true;
let noPlanNudge = true;
let muteCap = 120;
let askBudget = 5;
let noPlanTurns = 6;
let tone = "normal";
let watchTools = new Set();
let useTurnAnchor = true;
/** 每个 agent 是否处于"本回合尚未注入过锚"的状态（回合边界由 agent/pre-step 标记）。 */
const turnPending = new WeakMap();
/**
 * 刚被压缩过、需要补一次锚的会话。
 * 压缩（compaction）会把计划从上下文里冲掉 —— 而我的回合锚只在"每回合第一次工具调用后"注入，
 * 覆盖不到"回合进行到一半被压缩"这个空窗。事件名来自 DSH 自己的压缩包：
 * `compaction/start` / `compaction/summary` / `compaction/end`，都走 `session/event` 这条线。
 */
const anchorAfterCompact = new WeakSet();
/**
 * "没立计划就动手"的计数（每会话一份）。学自 Task-Anchor 的 "No code without a lock"。
 * 分寸：**只数改文件类调用**（write/edit/patch），不数跑命令 —— 查个磁盘、跑一条命令不该被念；
 * 且**第 2 次**才提醒、**每会话只提醒一次**，这样一次性小改不会触发，真在干活才会被看见。
 */
const noPlanWrites = new WeakMap();
/** 【缺口修补】本会话的用户回合数：纯讨论/规划阶段一个工具都不调，只能在「终于动手」那一刻补课。 */
const discussTurns = new WeakMap();
/** 【第一轮就问】会话第一轮 + 没有计划 → 提示"要不要启用计划锚"（最早的介入点，与轮数兜底成双保险）。 */
const pendingFirstTurn = new WeakMap();
/** 只认"改文件"类工具（比 isMutating 更窄：不含 shell/run，避免把一次性命令也算进来）。 */
function isFileMutating(toolName) {
	return /^(write|edit|str_replace|apply_patch|multi_edit|fs_write)/i.test(String(toolName));
}

// ---------- 用户消息信号检测（打断 / 问进度 / 要整理 / 追加需求） ----------
//
// 词表来自**真实语料**（260 个会话 / 4895 条用户原话 / 282 万字，见 research/drift-signals-zh.md），
// 不是编的。三条铁律都是数据教出来的：
//   ① **不用子串匹配短词** —— 「等等」70 次是"诸如此类"、只有 8 次是"等一下"（87% 假阳性）
//   ② **高频 ≠ 信号** —— 「还有(296)/重新(186)/不对(106)/帮我(82)/一起(60)/反正(54)」全是语境噪声
//   ③ 判"这句是给我的指令、还是派任务的描述"，**消息长度**比关键词可靠（≤80 字才是直接请求）
// 另有**一处相对原计划的改动**：命中"追加需求"时**不去问用户**（"顺便把 X 改了"本来就是要做，再问是多余摩擦），
// 而是提示 agent **按纪律显式处置**。

// 【误报修复·其一】`先不` / `先别` 会吃掉「先不管 / 先别看 / 先别说」这类 ——
// 那是"暂时不管某件事 / 跳过某话题"，**不是"叫你停"**。实测被误报过三次。
//
// 【误报修复·其二 · 更本质的一条】当这些词**后面紧跟「的」**时，用户是在**引用**这个词
// （例如"就是那个**先别**的**那个事情**"），而不是在下指令。
// **"提到某个词" ≠ "用那个词下命令"** —— 这是从一次真实误报里学到的。
const RX_INTERRUPT = /(等一下|等下|停一下|先停|先别(?!的|管|看|说|提)|先不(?!的|管|说|提|用)|打住|暂停|慢着|别急)/;
const RX_PROGRESS = /(做到哪|干到哪|进行到哪|走到哪)/;
const RX_SUMMARY = /(整理|梳理|汇总|总结|归纳|列一下|列出来|理一下)/;
const RX_CONFUSED = /(混乱|有点乱|很乱|太乱|绕晕|晕了|懵|搞乱|搞混|弄混|乱套|忘记|忘了|记不清|不记得)/;
const RX_APPEND = /(对了|另外|顺手|再加|加一个|还要|补充|顺便)/;
const RX_SHORT_OK = /(我们|咱们|当前|现在|这版|刚才)/;

/** 判断用户这句话属于哪类信号；返回 null = 不是信号（默认不打扰）。 */
function detectUserSignal(rawText) {
	const t = String(rawText || "").trim();
	if (!t) return null;
	const short = t.length <= 80; // ③ 长度判据
	const hit = (rx) => { const m = t.match(rx); return m ? m[0] : ""; };
	if (RX_INTERRUPT.test(t)) return { kind: "interrupt", hit: hit(RX_INTERRUPT) };
	if (RX_PROGRESS.test(t)) return { kind: "progress", hit: hit(RX_PROGRESS) };
	// 整理请求：动作词 +（自述混乱 或 短消息里指"我们的计划"）——两道约束，避免把任务描述当请求
	if (RX_SUMMARY.test(t) && (RX_CONFUSED.test(t) || (short && RX_SHORT_OK.test(t)))) {
		return { kind: "summary", hit: hit(RX_SUMMARY) };
	}
	// 追加需求：**短消息**（≤40 字）**或标记出现在句首**（≤3 字处）。
	// 为什么加位置约束：实测 "请你调研…，另外要注意…"（79 字）里的"另外"是任务描述的一部分，
	// 而 "对了，顺便把 README 也改了" / "另外我发现启动脚本有个 bug" 才是真的临时想起。
	// 宁可漏报，也不要变成多余的打扰。
	if (RX_APPEND.test(t)) {
		const at = t.search(RX_APPEND);
		if (t.length <= 40 || at <= 3) return { kind: "append", hit: hit(RX_APPEND) };
	}
	return null;
}

/**
 * 【第 8 件】"证据 vs 验收"轻量匹配：**只判"有没有回应"，不判"真不真"**。
 * 判真伪是语义判断，超出硬拦的合法边界；这里只做中文 2-gram 重合度检查，命中率低就给**提醒**（不拒绝）。
 */
function evidenceResponds(evidence, acceptance) {
	const strip = (s) => String(s || "").replace(/[\s，。、；：（）()【】《》"'`·\-—]/g, "");
	const a = strip(acceptance);
	if (a.length < 4) return true; // 验收太短，不判
	const e = strip(evidence);
	const grams = new Set();
	for (let i = 0; i + 2 <= a.length; i++) grams.add(a.slice(i, i + 2));
	if (!grams.size) return true;
	let hit = 0;
	for (const g of grams) if (e.includes(g)) hit++;
	return hit / grams.size >= 0.2;
}

/** 【第 7 件】提醒语气三档：同一条提醒，语气可换（免得被提醒烦到把插件关掉）。 */
function toneHead(kind) {
	if (tone === "strict") return kind === "firm" ? "【计划锚 · 严重偏离】" : "【计划锚 · 请停下核对】";
	if (tone === "soft") return kind === "firm" ? "【计划锚 · 再提醒一次】" : "【计划锚 · 小提示】";
	return kind === "firm" ? "【计划锚 · 二次提醒】" : "【计划锚 · 提醒】";
}
/** 用户问进度 / 要整理时，要摆到 agent 眼前的东西（比一行锚更全：含已完成项、泊位、修订提示）。 */
function progressBriefing(d, plan) {
	const steps = planSteps(d, plan.id);
	const cur = currentStep(d, plan.id);
	const done = steps.filter((s) => s.status === "done");
	const park = openParking(d, plan.id);
	const lines = ["【真实进度 —— 照这个答，不要凭记忆】"];
	const rev = revisionNote(d, plan.id);
	if (rev) lines.push(`⚠ 计划刚修订过：${rev}`);
	lines.push(`计划：《${plan.title}》 主线 ${done.length}/${steps.length} 步`);
	lines.push(cur ? `当前在：第 ${cur.ord} 步「${cur.text}」` : "当前没有进行中的步骤");
	lines.push(done.length ? `已完成：${done.map((s) => `第${s.ord}步「${s.text}」`).join("；")}` : "已完成：无");
	// 额外步骤（跨修订连续）也要报 —— 这是"两套编号"的另一半，不能被漏掉
	const dts = lineageDetours(d, plan);
	if (dts.length) {
		const dn = dts.filter((s) => s.status === "done").length;
		lines.push(`额外步骤 ${dn}/${dts.length} 完成：${dts.map((s) => `额外${s.detour_no}「${s.text}」${s.status === "done" ? "✔" : "·"}`).join("；")}`);
	}
	lines.push(park.length ? `泊位 ${park.length} 条未处理：${park.map((p) => `${parkLabel(d, p)} ${p.text}`).join("；")}` : "泊位空");
	return lines.join("\n");
}

/** 每个 agent 待处理的用户信号（pre-step 检测、下一次工具调用后注入 —— 用已验证过的注入通道）。 */
const pendingUserSignal = new WeakMap();

function apply(ctx, config) {
	if (!config || typeof config.path !== "string" || !config.path) throw new Error("plan-anchor: `path` is required");
	threshold = Number(config.driftThreshold);
	escalateAt = Number(config.escalateAt);
	detourBudget = Number(config.detourBudget ?? 3);
	watchTools = new Set(config.watchTools || []);
	useTurnAnchor = config.turnAnchor !== false;
	if (!Number.isInteger(threshold) || threshold < 1) throw new Error(`plan-anchor: invalid driftThreshold ${threshold} — must be an integer >= 1`);
	if (!Number.isInteger(escalateAt) || escalateAt <= threshold) throw new Error(`plan-anchor: escalateAt (${escalateAt}) must be an integer greater than driftThreshold (${threshold})`);
	if (!Number.isInteger(detourBudget) || detourBudget < 0) throw new Error(`plan-anchor: invalid detourBudget ${detourBudget} — must be an integer >= 0`);
	refuseCap = Number(config.refuseCap ?? 5);
	if (!Number.isInteger(refuseCap) || refuseCap < 2) throw new Error(`plan-anchor: invalid refuseCap ${refuseCap} — must be an integer >= 2`);
	scopeMode = String(config.scopeMode ?? "observe");
	completionGate = config.completionGate !== false;
	noPlanNudge = config.noPlanNudge !== false;
	muteCap = Number(config.muteCap ?? 120);
	if (!Number.isInteger(muteCap) || muteCap < 1) throw new Error(`plan-anchor: invalid muteCap ${muteCap} — must be an integer >= 1`);
	noPlanTurns = Number(config.noPlanTurns ?? 6);
	if (!Number.isInteger(noPlanTurns) || noPlanTurns < 1) throw new Error(`plan-anchor: invalid noPlanTurns ${noPlanTurns}`);
	askBudget = Number(config.askBudget ?? 5);
	if (!Number.isInteger(askBudget) || askBudget < 1) throw new Error(`plan-anchor: invalid askBudget ${askBudget} — must be an integer >= 1`);
	tone = String(config.tone ?? "normal");
	if (!["normal", "strict", "soft"].includes(tone)) throw new Error(`plan-anchor: invalid tone "${tone}" — must be normal | strict | soft`);
	if (!["off", "observe", "advise"].includes(scopeMode)) {
		throw new Error(`plan-anchor: invalid scopeMode "${scopeMode}" — must be one of off | observe | advise（block 档故意未实现：先拿到误报率数据再谈硬拦）`);
	}

	const d = open(config);

	const tools = [
		{
			name: "plan_set",
			description: "立计划：把多步计划的步骤写进持久锚。已存在生效计划时必须传 reason 才允许覆盖（防静默改计划）。",
			params: {
				title: { type: "string", required: true, description: "计划标题（这次要做成什么）" },
				steps: { type: "array", required: true, items: { type: "json" }, description: "有序步骤数组。每项可以是字符串，也可以是对象 {text, acceptance, files, commands}；acceptance=怎么做才算做完，files/commands=这一步允许动什么（供 scope 判决）" },
				reason: { type: "string", description: "覆盖已有计划时的理由（首次立计划可省略）" },
				carry: { type: "array", items: { type: "json" }, description: "换计划时的显式映射：[{from_step_id, to_index, relation, note}]，relation ∈ kept（保留并继承完成状态）| replaced（取代=返工，旧的做错了）| split（拆分）| merged（合并）。不写映射而旧步已完成 → 回执会把它吼出来" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planSet)
		},
		{
			name: "plan_status",
			description: "回归锚：我现在在第几步、下一步做什么、泊位几条、是否正在漂移。任何「我是不是跑偏了」的时刻都调它。",
			params: { threshold: { type: "number", description: "漂移判定的调用次数阈值（默认 12，仅本次查询生效）" } },
			exec: (a, x) => withRefs(d, a, scopeOf(x), planStatus)
		},
		{
			name: "plan_step_done",
			description: "完成当前步（evidence 必填）。若当前处于偏离态，完成后会自动回到挂起的计划步骤。",
			params: {
				evidence: { type: "string", description: "必填。凭什么算做完了：跑了什么、看到了什么" },
				no_work_reason: { type: "string", description: "仅当本步期间没有任何工具调用时必填：说明为什么这一步不需要工具（会记进台账）" }
			},
			exec: (a, x) => planStepDone(d, a, scopeOf(x), sessionKeyOf(x && x.agent))
		},
		{
			name: "plan_discover",
			description: "执行中发现新问题 → **必须显式判定处置**：permit（阻塞当前步，现在做）/ defer（现在不做，入泊位）/ decline（判定不做）。三值不可省略，新问题不许含糊地留在半空。",
			params: {
				text: { type: "string", required: true, description: "一句话写清这个新发现的问题" },
				disposition: { type: "string", description: "必填。permit | defer | decline；没想清楚就选 defer（入泊不会丢）" },
				resume_when: { type: "string", description: "选 defer 时必填：到时候凭什么判断该回来看它了（如「第 4 步做完之后」）" },
				resume_after_ord: { type: "number", description: "选 defer 时可选：主线第几步做完后回来（内部会换算成步骤身份；序号顺延也不会指错）" },
				resume_after_step_id: { type: "number", description: "更稳的写法：直接给某个步骤的 id（从 plan_status 读），做完它我就提醒你" },
				note: { type: "string", description: "补充信息；选 decline 时必填，说明为什么不做什么" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planDiscover)
		},
		{
			name: "plan_goto",
			description: "显式改焦点：回到某个计划步骤（step_id）或把泊位条目提上来做（park_id）。必须写 reason，会记入漂移台账。",
			params: {
				step_id: { type: "number", description: "目标步骤 id" },
				step_ord: { type: "number", description: "也可以直接填「主线第几步」（序号），我会换算成 id" },
				park_id: { type: "number", description: "要提取的泊位条目 id" },
				park_ord: { type: "number", description: "也可以直接填「泊位 N」里的 N（序号）" },
				// reason 同样故意不标 required：让代码层拒绝并解释"无理由的跳步会被记进台账"
				reason: { type: "string", description: "必填。为什么现在改焦点" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planGoto)
		},
		{
			name: "plan_park",
			description: "泊位清单：所有被泊下的新问题（永不自动消失，只能显式关闭）。",
			params: { all: { type: "boolean", description: "true 则连已关闭的也列出" } },
			exec: (a, x) => withRefs(d, a, scopeOf(x), planPark)
		},
		{
			name: "plan_close",
			description: "把泊位条目显式关闭（判定不做）。reason 必填 —— 禁止静默丢弃欠账；泊位只进不出会让清单烂掉。",
			params: {
				park_id: { type: "number", description: "泊位 id" },
				park_ord: { type: "number", description: "或直接填「泊位 N」里的 N（序号）" },
				reason: { type: "string", description: "必填。为什么关闭它" },
				outcome: { type: "string", description: "resolved（真的做完了）| declined（判定不做，默认）" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planClose)
		},
		{
			name: "plan_amend",
			description: "原地修订某一步的内容（文字/验收/files/commands）。**编号不变、身份不变、历史保留**——改计划用这个，别用 plan_set 整份重建。reason 必填。",
			params: {
				step_id: { type: "number", description: "要改的步骤 id" },
				step_ord: { type: "number", description: "或直接填序号「第几步」" },
				text: { type: "string", description: "新的步骤文字（不给则不改）" },
				acceptance: { type: "string", description: "新的验收标准" },
				files: { type: "array", items: { type: "string" }, description: "新的允许文件范围" },
				commands: { type: "array", items: { type: "string" }, description: "新的允许命令范围" },
				reason: { type: "string", description: "必填。为什么改这一步" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planAmend)
		},
		{
			name: "plan_insert",
			description: "在某一步之后插入步骤（after_step_id=0 表示插到最前）。当前焦点不会被带跑；编号顺延并在回执里明说。reason 必填。",
			params: {
				after_step_id: { type: "number", description: "在哪个步骤之后插入（0 = 插到最前面）" },
				after_ord: { type: "number", description: "或直接填序号：插在「第几步」之后" },
				steps: { type: "array", required: true, items: { type: "json" }, description: "要插入的步骤（字符串或 {text, acceptance, files, commands}）" },
				focus: { type: "boolean", description: "焦点是否跟到新插入的步骤（默认：插在当前步之前就跟随，之后就不动）" },
				reason: { type: "string", description: "必填。为什么插入" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planInsert)
		},
		{
			name: "plan_drop",
			description: "丢弃一步（只标记不删行，历史可查）。若丢的是当前步，焦点自动顺延到下一个待办。reason 必填。",
			params: {
				step_id: { type: "number", description: "要丢弃的步骤 id" },
				step_ord: { type: "number", description: "或直接填序号「第几步」" },
				reason: { type: "string", description: "必填。为什么不做了" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planDrop)
		},
		{
			name: "plan_rework",
			description: "执行中声明「某一步（可能早就完成了）的产出有问题，我要返工它」。记为一条挂在旧步骤上的支线（显示为额外步骤），做完自动回到主线；不计入偏离额度。reason 必填。",
			params: {
				step_id: { type: "number", description: "要返工的主线步骤 id" },
				step_ord: { type: "number", description: "或直接填序号「第几步」" },
				reason: { type: "string", description: "必填。为什么判定它的产出有问题" },
				text: { type: "string", description: "返工任务写什么（默认「重做第 N 步：原文」）" },
				acceptance: { type: "string", description: "返工的验收标准（强烈建议写）" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planRework)
		},
		{
			name: "plan_review",
			description: "把「计划算不算完成」交给用户裁：必须先用 ask_user_question 问过用户（自宣布完成以来用户真的回过话），再调本工具。confirmed=false 会把最后一步如实退回未完成。",
			params: {
				confirmed: { type: "boolean", required: true, description: "用户是否确认完成" },
				note: { type: "string", description: "用户的原话/意见（confirmed=false 时务必填，会记进台账与步骤证据）" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planReview)
		},
		{
			name: "plan_log",
			description: "漂移台账：立计划/完成步骤/入泊/正式中断/提取泊位/自动回归 的 append-only 记录。",
			params: {
				limit: { type: "number", description: "条数（默认 20）" },
				all: { type: "boolean", description: "true 则显示全部项目的台账（默认只看本计划）" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planLog)
		},
		{
			name: "plan_ask",
			description: "该不该问用户 —— 按三档判定：must（必问，不许静默继续）/ once（问一次，照办）/ note（不问，只记账，收尾时一起摆）。规则来自 AAEF 审批质量与疲劳、Horvitz 期望值、Carey & Everitt 的 corrigibility。",
			params: {
				kind: { type: "string", required: true, description: "irreversible | acceptance | scope-out | conflict | structure | uncertain | detail | authorized" },
				what: { type: "string", required: true, description: "要做的**具体动作**与影响（泛泛地问会被拒）" }
			},
			exec: (a, x) => planAsk(d, a, scopeOf(x), sessionKeyOf(x && x.agent))
		},
		{
			name: "plan_wait",
			description: "「我在等 X」—— 把等待变成显式状态。三要素必填：what（等什么）/ until（什么算等到了）/ on_timeout（超时怎么办）。等待期间不涨漂移预算，也不会被停滞质问打扰。只用于「重试也没用、只能等外部」的事。",
			params: {
				what: { type: "string", description: "必填。在等什么" },
				until: { type: "string", description: "必填。什么条件算等到了（唤醒条件）" },
				on_timeout: { type: "string", description: "必填。超时之后怎么办（不能没有这条边）" },
				timeout_turns: { type: "number", description: "多少回合算超时（默认 8，上限 50）" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), (dd, aa, sc) => planWait(dd, aa, sc, sessionKeyOf(x && x.agent)))
		},
		{
			name: "plan_detour",
			description: "「我现在要去做一件主线之外的事」—— 直接开一条额外步骤：主线当前步挂起，做完自动回来，**不计偏离额度**（用户要做的活 ≠ 跑偏）。",
			params: {
				text: { type: "string", description: "必填。这件主线之外的事是什么" },
				reason: { type: "string", description: "为什么现在要做它（例如：用户刚要求的）" },
				acceptance: { type: "string", description: "怎么算做完" }
			},
			exec: (a, x) => withRefs(d, a, scopeOf(x), (dd, aa, sc) => planDetour(dd, aa, sc, sessionKeyOf(x && x.agent)))
		},
		{
			name: "plan_note",
			description: "声明「我仍在这一步上，进展是 X」—— 漂移预算只认计划状态变化，合法长活会被误判成没推进；用这个清零预算并记台账（台账记的是「自称在轨」，与「真的完成」区分开）。",
			params: {
				// text 故意不在 schema 层标 required：留给代码层拒绝并解释「空话不算在轨依据」
				text: { type: "string", description: "必填。一句话说清你这一步目前的进展" }
			},
			exec: (a, x) => planNote(d, a, scopeOf(x), sessionKeyOf(x && x.agent))
		},
		{
			name: "plan_report",
			description: "生成**给人看的整理稿**（可直接贴给用户）：进度、这一段从哪开始、已经做完的、要做还没做的、临时加的任务、先记下回头再处理的。**零 id、零内部代号、零机器术语**。数据由计划本体生成（不漏不编）；「一句话 / 这一段发现的问题 / 建议」三段工具生成不了，必须你自己补。",
			params: {},
			exec: (a, x) => withRefs(d, a, scopeOf(x), planReport)
		},
		{
			name: "plan_mute",
			description: "静音主动提醒 N 次工具调用（计划仍在锚位上，只是不打扰）。",
			params: { calls: { type: "number", description: "静音的调用次数（默认 20）" } },
			exec: (a, x) => withRefs(d, a, scopeOf(x), planMute)
		}
	];

	for (const t of tools) {
		ctx.tools.register(defineTool({
			name: t.name,
			description: t.description,
			parameters: t.params,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { result: { type: "string", required: true } }
				},
				render: (_a, v) => [{ type: "text", text: v.result }]
			},
			async execute(args, exec) {
				let out;
				try {
					out = t.exec(args || {}, exec);
				} catch (error) {
					out = { ok: false, reason: `plan-anchor 内部错误：${error && error.message ? error.message : String(error)}` };
				}
				// 拒绝时必须让**理由**抵达模型 —— 只回简报会把"为什么被拒"吞掉，等于白拒。
				if (out && out.ok === false) {
					const parts = [`⛔ ${out.reason}`];
					if (out.refuse_hint) parts.push("", `（关卡提示：${out.refuse_hint}）`);
					if (out.briefing) parts.push("", out.briefing);
					return { result: parts.join("\n") };
				}
				if (out && out.briefing) {
					// rules 必须一起送出去 —— 否则"立计划时把规则讲清楚"这件事等于没做
					return { result: out.rules ? [out.briefing, "", out.rules].join("\n") : out.briefing };
				}
				const { briefing, ...rest } = out || {};
				return { result: JSON.stringify(rest) };
			}
		}));
	}

	// ——— 压缩结束：标一个"要补锚"的记号（真正的注入在下次工具调用后做，用已验证过的通道）———
	ctx.on("session/event", (session, event) => {
		try {
			if (session && event && event.type === "compaction/end") anchorAfterCompact.add(session);
		} catch { /* 护栏自身绝不打断主流程 */ }
	});

	// ——— 回合边界：标记"本回合还没注入过锚"———
	ctx.on("agent/pre-step", ({ agent, messages }, next) => {
		try {
			const ums = Array.isArray(messages) ? messages.filter((m) => m && m.source && m.source.kind === "user") : [];
			if (ums.length) {
				turnPending.set(agent, true);
				// I9 判据之二：用户回合也算工作痕迹（"这一步靠讨论就定了"是合法的）
				const p2 = activePlan(d, scopeOf({ agent }));
				if (p2) {
					stSet(d, p2.id, "step_user_turns", workTrace(d, p2.id).turns + 1);
					// 完成闸门的可观测前提：记下"用户最近一次说话的时刻"
					stSet(d, p2.id, "last_user_turn", now());
					// 修订提示只在本回合有效：用户一开口就清掉，免得旧提示长期占位
					clearRevisionNote(d, p2.id);
				}
				// 读用户最后那句话，识别"打断 / 问进度 / 要整理 / 追加需求"。
				// 检测放在 pre-step（这里能看见用户原话），**注入放在下一次工具调用后**（用已验证的通道）。
				const last = ums[ums.length - 1];
				const text = (Array.isArray(last.content) ? last.content : [])
					.filter((c) => c && c.type === "text" && c.text)
					.map((c) => c.text)
					.join("\n");
				const turns0 = (discussTurns.get(agent) || 0) + 1;
				discussTurns.set(agent, turns0);
				if (turns0 === 1 && !p2) pendingFirstTurn.set(agent, true);
				const sig = detectUserSignal(text);
				// 【真 bug 修复】没信号时必须**清掉**上一回合残留的 ——
				// 否则一个过期的信号会挂在那里，直到你下一次调工具才突然触发。
				// 实测：用户先说"等一下你先别推送"，随后又说"直接推送吧"，
				// 结果"他在叫你停"在几轮之后才炸出来，而那时它已经过期了。
				if (sig) pendingUserSignal.set(agent, sig);
				else pendingUserSignal.delete(agent);
			}
		} catch (error) {
			try { log(d, "guard_error", { ref: "agent/pre-step", detail: String(error && error.message || error).slice(0, 200) }); } catch { /* ignore */ }
			console.error("[plan-anchor] pre-step 抛错（护栏已跳过本次检测）:", error);
		}
		return next();
	});

	// ——— 工具后置：计数漂移预算 + 注入提醒 ———
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		let reminder = null;
		try {
			reminder = observe(d, exec);
		} catch (error) {
			// 护栏自己的异常绝不能打断主流程，但**也绝不能静默**：
			// 写一条 error 台账并打到宿主日志 —— 我自己的一个 TDZ bug 就是这样被瞒了很久。
			try { log(d, "guard_error", { ref: "observe", detail: String(error && error.message || error).slice(0, 200) }); } catch { /* 连写台账都失败就只剩控制台 */ }
			console.error("[plan-anchor] observe 抛错（护栏已跳过本次提醒）:", error);
		}
		const downstream = await next();
		if (!reminder) return downstream;
		if (downstream && downstream.kind === "block") {
			return { kind: "block", feedback: downstream.feedback, additionalContexts: [reminder, ...(downstream.additionalContexts || [])] };
		}
		return { ...downstream, additionalContexts: [reminder, ...((downstream && downstream.additionalContexts) || [])] };
	});
}

/** 每次工具调用后：推进预算、判断该不该注入哪一类提醒。 */
function observe(d, exec) {
	if (!exec || !exec.agent) return null;
	const scope = scopeOf(exec); // 每会话各自的工作目录 → 各自的项目
	const plan = activePlan(d, scope);
	const toolName = exec.name;
	// 没立计划时：默认完全不打扰（单步任务不该被啰嗦）。
	// 但**改文件两次以上就该被看见**（学自 Task-Anchor 的 "No code without a lock"）——
	// 这是我文档里承认过的边界一（"不调工具直接干活，护栏完全看不见"）目前唯一能补的部分。
	if (!plan) {
		// 【第一轮就问】最早的介入点：会话开场就该决定要不要用计划锚
		// 只在**真的还在第一轮**时才响；否则清掉，交给轮数兜底（否则会拖到第 N 轮才说自己是第一轮）
		if (pendingFirstTurn.get(exec.agent) && (discussTurns.get(exec.agent) || 0) !== 1) pendingFirstTurn.delete(exec.agent);
		if (noPlanNudge && pendingFirstTurn.get(exec.agent)) {
			pendingFirstTurn.delete(exec.agent);
			return notice([
				"【本会话第一轮】还没有计划锚。",
				"如果这看起来是**多步任务**（≥3 步 / 要跨多轮 / 会改多个文件）→ 先问用户要不要启用，照抄这句：",
				"「这次是个多步活，要不要用计划锚管着？好处：计划不会忘、冒出来的问题有处放；代价：会多几次记录动作。」",
				"→ 用 ask_user_question 问（这属「超出已批准范围」，是必问档）。",
				"如果只是一句话问答或单次操作 → **忽略本条**，别无谓打扰用户。"
			].join("\n"), "first-turn: ask whether to enable");
		}
		if (noPlanNudge) {
			const n = (noPlanWrites.get(exec.agent) || 0) + (isFileMutating(toolName) ? 1 : 0);
			noPlanWrites.set(exec.agent, n);
			// 【缺口修补】纯讨论/规划阶段没有工具调用 → 注入通道用不上（additionalContexts 只在工具层）。
			// 唯一能补的时机是「讨论结束、终于动手」的第一次工具调用 —— 那也正是该提醒的时候。
			const turns = discussTurns.get(exec.agent) || 0;
			const byWrites = n === 2 && isFileMutating(toolName);
			const byTalk = turns >= noPlanTurns && n === 0;
			if (byWrites || byTalk) {
				return notice([
					byTalk
						? `【计划锚】这个会话你已经聊了 ${turns} 轮，现在开始动手了 —— 但**还没有计划**。`
						: "【计划锚】这个项目**还没有计划**，但你已经改了 2 次文件。",
					"没有计划 = 外挂完全看不见你在干什么：没有「第几步」、没有泊位、没有台账；",
					"执行到一半冒出新问题时，它挡不住你的注意力（这正是它存在的理由）。",
					byTalk ? "讨论阶段就该立 —— 计划没落盘，后面延伸出来的东西就没有归属。" : "",
					"▶ 如果这是多步活（≥3 步）→ 先 plan_set 把步骤写下来（哪怕 3 步）；",
					"▶ 如果只是顺手改个小东西 → 忽略本条。",
					"（每会话只提醒一次；跑命令不算数。）"
				].join("\n"), "no plan after 2 file writes");
			}
		}
		return null;
	}
	const planId = plan.id;

	// 预算推进：计划类查询工具既不推进也不消耗；进展类工具清零；其余 +1
	if (PROGRESS_TOOLS.has(toolName)) setBudget(d, planId, 0);
	else if (!toolName.startsWith(NEUTRAL_PREFIX)) {
		// 【批2-C】只读工具算**半次**：一次合法的长调研（连读十几个文件做参考）不该等价于"写了十几次"；
		// 但也不能算 0 —— 真跑偏时同样经常是"读个不停"，所以是折中的半次。
		setBudget(d, planId, budget(d, planId) + (READ_ONLY_TOOLS.has(toolName) ? 0.5 : 1));
		stSet(d, planId, "step_calls", workTrace(d, planId).calls + 1); // 本步工作痕迹（I9 判据之一）
	}

	// ①b scope 判决：只判"声明了 scope 的当前主线步骤"
	//     observe 档 = 只记录（供统计误报率）；advise 档 = 本步首次越界时提醒一次（仍不拦）
	//     ⚠ 这一段必须在"静音检查"**之前**：静音的意思是不打扰，**不是停止观察**
	//     （红队抓到的：以前静音会连判决一起停掉，等于静音期间瞎了）
	let scopeNotice = null;
	if (scopeMode !== "off") {
		const cs = currentStep(d, planId);
		const v = judgeScope(cs, toolName, exec.arguments);
		if (v) {
			recordVerdict(d, planId, cs.id, toolName, v);
			if (scopeMode === "advise" && v.verdict === "out-of-scope" && stGet(d, planId, "scope_nudged") !== String(cs.id)) {
				stSet(d, planId, "scope_nudged", String(cs.id));
				scopeNotice = notice([
					`【计划锚 · scope 观察】当前是主线第 ${cs.ord} 步「${cs.text}」，你动了 scope 之外的东西：`,
					`- 工具 ${toolName}　- 目标 ${v.target}`,
					`该步声明允许动：${[...parseList(cs.scope_files), ...parseList(cs.scope_commands)].join("、") || "（无）"}`,
					"先确认一句：这是本步必需的吗？如果不是 → plan_discover 判定处置；如果确实必需 → plan_goto/plan_set 把 scope 改对，别硬做。",
					"（当前是 advise 档，只提醒不拦；本条每步只响一次。）"
				].join("\n"), `scope ×${cs.ord}`);
			}
		}
	}

	// ⓪ 用户信号：用户叫你停 / 问进度 / 要整理 / 追加需求。
	//    优先于一切自动提醒，**且不受静音影响** —— 静音是"别主动烦我"，而回应用户是服务，不是打扰。
	const usig = pendingUserSignal.get(exec.agent);
	if (usig) {
		pendingUserSignal.delete(exec.agent);
		const brief = progressBriefing(d, plan);
		if (usig.kind === "interrupt") {
			return notice([
				`【用户信号：${usig.hit}】他在叫你停。`,
				brief,
				"▶ 先回应他，别再往下做；要改计划就 plan_set / plan_insert，要记下的事就 plan_discover。"
			].join("\n\n"), `user signal: interrupt (${usig.hit})`);
		}
		if (usig.kind === "progress") {
			return notice([
				`【用户信号：${usig.hit}】他在问进度。`,
				brief,
				"▶ 直接用上面的数字回答，**不要凭记忆**。"
			].join("\n\n"), "user signal: progress");
		}
		if (usig.kind === "summary") {
			return notice([
				`【用户信号：${usig.hit}】他要的是**「这一段的全景整理」**，不是问进度。`,
				brief,
				"▶ 按四类逐条列：**要做还没做的 / 已经做完的 / 发现的问题（再分已解决·未解决）/ 欠账**；",
				"   **零编号、零内部代号、零机器术语**，要能直接贴给他看。"
			].join("\n\n"), "user signal: summary");
		}
		// append：**不去问用户**，而是提示 agent 按纪律显式处置（问用户是多余的摩擦）
		return notice([
			`【用户信号：${usig.hit}】用户在**追加新需求**（这不是跑偏，是他改方向；他的指令优先）。`,
			"▶ 按纪律显式处置，**不许默默切换**：",
			"   · 不阻塞当前步 → plan_discover(disposition=\"defer\", resume_when=\"回程条件\")，然后继续当前步；",
			"   · 它就是现在的重点 → plan_insert 记进计划（或者 plan_set 换计划，带 reason）。"
		].join("\n"), `user signal: append (${usig.hit})`);
	}

	// 静音：递减计数，并跳过一切**打扰**（判决已经记完了）。
	// 【第 6 件】到期时不做"静默恢复"，而是**温和 check-in 一次**——静音是暂停打扰，不是免责。
	const ml = muteLeft(d, planId);
	if (ml > 0) {
		const left = ml - 1;
		stSet(d, planId, "mute", left);
		if (left === 0 && stGet(d, planId, "mute_pending_checkin", "") === "1") {
			stDel(d, planId, "mute_pending_checkin");
			setBudget(d, planId, 0);
			const cs2 = currentStep(d, planId);
			return notice([
				"【静音结束】刚才那段安静时间用完了 —— 这不是提醒你跑偏，是确认一下方向。",
				"一句话回答两件事：① 那段时间你完成了什么？② 你还在计划上吗？",
				cs2 ? `（记录里你停在主线第 ${cs2.ord} 步「${cs2.text}」—— 如果实际不在这上面，那现在就是归位的时候。）` : ""
			].filter(Boolean).join("\n"), "mute expired check-in");
		}
		return null;
	}

	// ① 回合锚（每回合第一次工具调用后一次）
	if (useTurnAnchor && turnPending.get(exec.agent)) {
		turnPending.delete(exec.agent);
		const anchor = turnAnchorNotice(d, scope);
		if (anchor) return anchor;
	}
	// ①a 压缩后补锚：刚被压缩过 → 计划很可能已经不在上下文里了，立刻补一次
	if (exec.agent.session && anchorAfterCompact.has(exec.agent.session)) {
		anchorAfterCompact.delete(exec.agent.session);
		const a = turnAnchorNotice(d, scope);
		if (a) return notice(a.content[0].text + "\n（刚才发生过上下文压缩 —— 这条是把计划重新放回你眼前。**读完请回一句：当前在第几步**，好确认你真的读到了。）", "post-compaction anchor");
	}
	if (scopeNotice) return scopeNotice;

	// ② 开新活提醒（每步一次）
	if (watchTools.has(toolName)) {
		const n = newWorkNotice(d, plan, toolName);
		if (n) return n;
	}

	// ③ 漂移预算提醒
	return driftNotice(d, plan);
}

// ---------- 不变量表（照抄调研里 liza 的写法：逐条标注"在哪一层强制"） ----------
//
// | ID | 不变量                                                        | 防的是什么                | 强制层      |
// |----|---------------------------------------------------------------|---------------------------|-------------|
// | I1 | 计划内同时最多一个 active 步骤                                | 多头并进、主线丢失        | code        |
// | I2 | 新发现必须显式判定 permit/defer/decline，无判定即拒；permit 认定失败也落回 defer（安全侧） | 一路追新问题 + 泊位只进不出 | code |
// | I3 | 已生效计划不可静默覆盖，必须带 reason 且旧版留痕              | 计划被悄悄改写掉          | code        |
// | I4 | 状态迁移的台账由代码自动追加，不接受 agent 手工写            | 事后编故事                | code        |
// | I5 | 泊位条目永不自动消失，只有显式关闭才关闭                      | 欠账被遗忘                | code        |
// | I6 | 偏离结束后由代码自动回到挂起的计划步骤                        | "忘了回来"                | code        |
// | I7 | 完成步骤必须附 evidence                                       | 假装推进                  | code        |
// | I8 | 回合开始与漂移超阈值时，把锚放回上下文                        | 计划不再被读取            | prompt_only |
//
// 逐字理由（liza ADR-0039）："security constraints belong in code, not in prompt instructions"
// I8 是唯一只能靠注入提醒实现的，明确标注为 prompt_only —— 不假装它是硬约束。
//
// 【为什么本插件**不做** Stop hook / 不阻断回合结束】（一手源码核实，2026-09-18）
// DSH 自带 Claude Code hooks 兼容桥 @deepseek-ai/dsh-hooks-claude-code，但有两个致命缺口：
//   ① `stopPayload()` 把 `stop_hook_active` **硬编码为 false**
//      （lib/index.js L385-390，注释逐字："the loop-guard flag, always false"）
//      → 官方文档教的"读到它为真就放行"这个自限写法在 DSH 上永远失效，照抄范例 = 无条件继续。
//   ② 全文件 grep `consecutive` / `blockCap` / `BLOCK_CAP` **零命中**
//      → Claude Code 那条"连续 8 次阻断后强制结束回合"的兜底在 DSH 上不存在，判据写错 = 真死循环。
// 结论：**Stop 式闸门在这台机器上没有安全网**。本插件因此只做「注入提醒 + 状态迁移关卡」：
// 提醒从不阻断收工，关卡拒绝的是一次状态迁移且必留合法出路。
//
// 【硬拦的边界】只拦**可观测事实**（状态计数、字段空否、本插件自己记录的工具调用数），
// 一切语义判断（"这算不算计划外""你是不是在漂"）只提醒、不阻断。
// 反例 anthropics/claude-plugins-official#5312 逐字：
//   "An agent willing to falsely claim completion would have escaped in one turn.
//    The failure mode selects against honesty."
// 自检方法（#5312 的原始测试）：问"谎报是否比诚实更划算" —— 若两者受同等待遇，就没有选择效应。
// 本插件逐项过过：诚实说"这步不需要工具"（no_work_reason）与谎报，**两者都放行**。

export { Config, apply, inject, name };
