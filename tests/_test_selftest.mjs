/**
 * selftest.mjs · plan-anchor 自测套（零依赖，不需要 DSH 运行时）
 *
 * 用法：node selftest.mjs       退出码 0=全过 / 1=有失败
 *
 * 为什么要有它（2026-09-25 调研结论）：同生态的 dsh-anchored 系列把「零依赖自测」当交付物的一部分，
 * 而我们此前只有零散 verify-*.mjs。就在同一天，我改插件时手滑把坏文件同步出去过 ——
 * 有这套回归，它会在同步前就叫停。
 *
 * ⚠️ 依赖说明：本仓库 node_modules 里的 `@deepseek-ai/dsh-tools` 是**自测 shim**（见其 SHIM.md）。
 *    官方那份只随 DSH 应用分发、且本地残片的传递依赖已缺失。shim 给的是恒等 defineTool，
 *    因此被测的仍是**插件自己的全部逻辑**。
 *
 * 第一版踩到的两个坑（记录下来，免得下次又踩）：
 *   ① 锚只在"用户回合的第一次工具调用后"注入 → 测试里**必须先 say() 造出回合**，否则 fire() 永远返回空
 *      （空 = 断言"没有注入"会假通过，这是最危险的一类测试 bug）
 *   ② 关卡有先后：验收不匹配的闸门在"零工作痕迹"之前 → 测 I9 必须让证据措辞**对得上验收**
 */
import { rmSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
// 可移植解析：开发布局（../dsh-plan-anchor）优先，否则用发布布局（../dsh）。
// 照 tests/_test_plan_anchor.mjs 的同一写法 —— 公开仓库里别人也能直接跑。
const LIB = (() => {
	const dev = new URL('../dsh-plan-anchor/lib/index.js', import.meta.url);
	return (existsSync(dev) ? dev : new URL('../dsh/lib/index.js', import.meta.url)).href;
})();
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const P = join(tmpdir(), 'pa-selftest.db');
for (const f of [P, P + '-wal', P + '-shm']) { try { rmSync(f); } catch { /* 首次运行没有 */ } }

const mod = await import(`${LIB}`);
const tools = new Map();
const hooks = new Map();
(mod.apply || mod.default.apply)(
	{ tools: { register: (t) => tools.set(t.name, t) }, on: (e, f) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(f); } },
	{ path: P, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', turnAnchor: true },
);

const CWD = 'D:\\selftest';
// 三个会话都带**稳定身份**（agent.session.header.id）—— 真机里 E v3 正是被"进程内号跨重启撞车"骗掉的，
// 所以测试必须走稳定身份这条路，否则测不到那条真缺陷。
const A = { session: { header: { cwd: CWD, id: 'session-AAA' } } };   // 建计划的会话
const B = { session: { header: { cwd: CWD, id: 'session-BBB' } } };   // 后来的新会话（同一个工作目录）

const call = async (agent, name, args) => {
	const r = await tools.get(name).execute(args || {}, { agent });
	const v = r && r.result !== undefined ? r.result : r;
	return typeof v === 'string' ? v : JSON.stringify(v);
};
/** 造一个用户回合（锚/提醒都挂在"回合的第一次工具调用后"） */
const say = async (agent, text) => {
	for (const h of hooks.get('agent/pre-step') || []) {
		await h({ agent, messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] }, async () => ({}));
	}
};
/** 本回合第一次工具调用 → 返回注入的上下文（锚/提醒从这里出来） */
const fire = async (agent, nm = 'read', args = { file_path: 'a.js' }) => {
	let out = '';
	for (const h of hooks.get('tools/post-execute') || []) {
		const d = await h({ agent, name: nm, arguments: args }, {}, async () => ({ kind: 'continue' }));
		for (const c of (d && d.additionalContexts) || []) {
			// Native v4 rejects the retired { kind: 'plugin', plugin: ... } wrapper.
			assert.equal(c.source?.kind, 'plugin:plan-anchor');
			assert.equal(Object.hasOwn(c.source, 'plugin'), false);
			assert.equal(c.source.form, 'notice');
			assert.equal(typeof c.source.summary, 'string');
			assert.equal(c.role, 'user');
			assert.ok(c.id && c.content.length);
			out += (c.content || []).map((x) => x.text || '').join('');
		}
	}
	return out;
};
/** 一个完整回合：先说一句，再调一次工具 —— 返回这次注入的文本 */
const turn = async (agent, text = '继续') => { await say(agent, text); return fire(agent); };

let pass = 0, fail = 0;
const results = [];
const check = (name, cond, detail = '') => {
	if (cond) { pass++; results.push(`  ✅ ${name}`); }
	else { fail++; results.push(`  ❌ ${name}${detail ? '\n       ' + String(detail).replace(/\s+/g, ' ').slice(0, 160) : ''}`); }
};
const section = (t) => results.push(`\n【${t}】`);

// ─────────────────────────────────────────────────────────────────────────────
section('① 基础：立计划 / 硬闸门 / 关步 / 完成闸门');

const set = await call(A, 'plan_set', { title: '自测计划', steps: [
	{ text: '第一步', acceptance: '跑通就算过' },
	{ text: '第二步' },
] });
check('plan_set 建计划成功', set.includes('计划锚'), set.slice(0, 80));

const st0 = await call(A, 'plan_status', {});
check('plan_status 能读到计划', st0.includes('自测计划'));
check('计划有 2 个步骤（不然后面的完成闸门测不到）', st0.includes('2'), st0.slice(0, 120));

// 零工作痕迹 + 证据对得上验收 → 该被 I9 拦（放在最前，因为 fire() 会攒工作痕迹）
const noTrace = await call(A, 'plan_step_done', { evidence: '跑通了（对照验收：跑通就算过）' });
check('零工作痕迹不许关步（I9）', noTrace.includes('工作痕迹'), noTrace.slice(0, 120));

// 无证据 → 该被拦
const noEv = await call(A, 'plan_step_done', {});
check('无 evidence 不许关步', noEv.includes('evidence 必填'), noEv.slice(0, 100));

// 正常关第一步（先造工作痕迹）
await turn(A, '开始干活');
const done1 = await call(A, 'plan_step_done', { evidence: '跑通了，输出 42（对照验收：跑通就算过）' });
check('正常关步成功', done1.includes('已关闭'), done1.slice(0, 120));
check('关步回执短（C：< 900 字符）', done1.length < 900, `实际 ${done1.length} 字符`);
check('关步后焦点顺延到第二步', done1.includes('第二步') || done1.includes('下一步'), done1.slice(0, 200));

// 关最后一步 → 完成闸门：必须让用户确认，不许自称完成
await turn(A, '继续做第二步');
const done2 = await call(A, 'plan_step_done', { evidence: '第二步也做完了' });
check('最后一步触发完成闸门（要用户确认）', done2.includes('ask_user_question') || done2.includes('plan_review'), done2.slice(0, 200));

// ─────────────────────────────────────────────────────────────────────────────
section('② 上下文瘦身（A / B / C）');

const p1 = await call(A, 'plan_set', { title: '瘦身测试', steps: ['甲', '乙', '丙'], reason: '自测要一条新计划' });
check('带 reason 的重规划成功', !p1.includes('reason 必填'), p1.slice(0, 80));

const brief = await call(A, 'plan_status', {});
check('A：默认极简（< 1,200 字符）', brief.length < 1200, `实际 ${brief.length} 字符`);
check('A：极简里给出取详情的方式', brief.includes('detail') && brief.includes('step='), brief.slice(-160));
check('A：极简不再列出全部步骤正文', !brief.includes('计划修订史'), '出现了修订史');

await turn(A, '干活');
await call(A, 'plan_step_done', { evidence: '甲做完了' });
const full = await call(A, 'plan_status', { detail: 'full' });
check('A：detail:"full" 能拿到全量', full.includes('主线步骤：'), full.slice(0, 80));
check('B：全量列表里不再回放「依据」', !full.includes('· 依据：'), '还在回放依据');

const firstStepId = Number((full.match(/id=(\d+)/) || [])[1] || 0);
const one = await call(A, 'plan_status', { step: firstStepId });
check('A：step:<id> 能单独取某一步（含依据）', one.includes('步骤详情') && one.includes('依据：'), one.slice(0, 160));
check('A：单步详情比全量小得多', one.length < full.length, `单步 ${one.length} vs 全量 ${full.length}`);

// ─────────────────────────────────────────────────────────────────────────────
section('③ 回合锚与泊位');

const anchor = await turn(A, '继续');
check('回合锚会注入（先有回合才有锚）', anchor.includes('计划锚'), anchor.slice(0, 120));
check('C：锚是短版（< 700 字符）', anchor.length < 700, `实际 ${anchor.length} 字符`);

await call(A, 'plan_discover', { text: '顺手发现的小问题', disposition: 'defer', resume_when: '以后再看' });
const withPark = await call(A, 'plan_status', {});
check('泊位入泊成功（短版给出条数）', /泊位\s*\d+/.test(withPark), withPark.slice(-200));

// ─────────────────────────────────────────────────────────────────────────────
section('④ 伸手就拦（② 判据改造后的新语义）');

// 【保命声明 · 2026-09-27】这三个是**后面所有小节都在用**的 ——
// 我上一版替换 ④ 节时把它们一起删了 ✗ → `raw is not defined`（ReferenceError）✗。
// 教训（今晚第二次同类，上一次是 index.js 里的 `acc`）：**替换一段代码前，先扫它声明的名字、再看后面用不用。**
const raw = () => new DatabaseSync(P);
const planId = raw().prepare("SELECT id FROM plans WHERE status='active' ORDER BY id DESC LIMIT 1").get().id;
const C = { session: { header: { cwd: CWD, id: 'session-CCC' } } };   // 第三个会话（旧 ④ 的定义，后面几节仍在用）

// 【② 判据改造 · 2026-09-27】依据（另一位会话的评审）：
//   开场喊「要不要接手 / 别两头做」是噪音 ✗；而且「每目录只提一次」会把记号消耗在**第一个路过**的
//   会话身上 ✗ —— 真正要动手的那个反而没人拦（那是把「防两头做」降级成「防第一次」）。
// 新判据：**开场不说话** ✓；**会改计划状态的工具**在伸手那一刻检查归属 → 不是我的线就拒绝 + 给唯一出口 ✓。
// 只读工具（plan_status / plan_park / plan_health / plan_log / plan_export / plan_backup / plan_report）照旧放行 ✓。
const EA = { session: { header: { cwd: CWD + '-b2', id: 'session-b2-owner' } } };
await call(EA, 'plan_set', { title: 'B2 样本', reason: '自测：伸手就拦', steps: ['甲', '乙'] });
const EB = { session: { header: { cwd: CWD + '-b2', id: 'session-b2-other' } } };

const readOK = await call(EB, 'plan_status', {});
check('只读入口照旧放行（你问它才答 = 正确形态）', /B2 样本/.test(readOK), readOK.slice(0, 170));

const refused = await call(EB, 'plan_step_done', { evidence: '想关掉别人的一步', no_work_reason: '试试' });
check('伸手改别人的线 → 被拒绝', refused.includes('别的会话的线'), refused.slice(0, 200));
check('拒绝里点名是哪条线 + 给唯一出口 plan_claim', refused.includes('B2 样本') && refused.includes('plan_claim'), refused.slice(0, 280));

const refusedNote = await call(EB, 'plan_note', { text: '在别人的线上声明在轨' });
check('plan_note 同样被拦（它不走 withRefs —— 最容易漏的那类）', refusedNote.includes('别的会话的线'), refusedNote.slice(0, 200));

const ownOK = await call(EA, 'plan_step_done', { evidence: '我自己那步做完了', no_work_reason: '自测' });
check('（正对照）自己的线照旧能关步', ownOK.includes('已关闭'), ownOK.slice(0, 150));

section('⑤ 静音：静掉主动打扰，但账照记');

// 契约（工具定义 + README）：plan_mute = "静音提醒 N 次调用"。
// 每回合注入的锚**就是**主动打扰那条通道 → 静音期间它不该出现；
// 但"静音不是免责"：随时按需查状态仍要拿得到，且全量里要如实标出还剩几次。
// （注：README 里"闭嘴 ≠ 消失"讲的是 plan_note 声明在轨那一路，不是静音——别混。）
await call(A, 'plan_mute', { calls: 5, reason: '自测：验证静音只停主动打扰' });
let sawAnchor = false;
for (let i = 0; i < 3; i++) {
	const o = await turn(A, '继续');
	if (o.includes('【计划锚】')) sawAnchor = true;
}
check('静音期间不再主动注入锚', !sawAnchor);

const afterMute = await call(A, 'plan_status', { detail: 'full' });
check('静音不是免责：按需仍能查到完整状态', afterMute.includes('主线步骤：'), afterMute.slice(0, 80));
check('全量里如实标出静音剩余次数', /主动提醒已静音/.test(afterMute), afterMute.slice(-260));
check('plan_mute 缺 reason 会被拒（静音不是免责）', (await call(A, 'plan_mute', { calls: 3 })).includes('reason 必填'));

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 库结构闸门（#4）');

// 注：「库领先就拦」那一支必须在**独立进程**里验 —— 本模块把 db 缓存在模块级变量上，
// 同一个进程里没法二次 open。那一支见 verify-schema-guard.mjs。
const uv = raw().prepare('PRAGMA user_version').get().user_version;
// 【2026-09-27】这条断言原来写死 v1 ✗ —— 加迁移（v2：老 owner 认领）后它必然失败。
// 改成**跟着代码里的 SCHEMA_VERSION 走**：断言"库被盖上了当前版本的戳"，而不是"等于某个数字"。
// 注意路径要**两种布局都认**（开发仓是 ./lib/index.js；发布仓是 dsh/lib/index.js —— 测试在 tests/ 下）。
const _tryRead = (u) => { try { return readFileSync(u, 'utf8'); } catch { return ''; } };
const _libText = _tryRead(new URL('./lib/index.js', import.meta.url)) || _tryRead(new URL('../dsh/lib/index.js', import.meta.url));
const EXPECTED_SCHEMA = Number((_libText.match(/const SCHEMA_VERSION = (\d+);/) || [0, 0])[1]) || 1;
check(`新库/老库都被盖上结构版本戳（v${EXPECTED_SCHEMA}）`, Number(uv) === EXPECTED_SCHEMA, `实际 user_version=${uv}，期望 ${EXPECTED_SCHEMA}`);

// ─────────────────────────────────────────────────────────────────────────────
section('⑦ 陈旧工件衰减（#3 · plan_gc）');

// 造一条"够老的、依据很长的"已完成步骤
await turn(A, '做第二步');
const longEv = '这条依据很长，用来验证衰减只截断、不抹除：' + 'x'.repeat(200);
const closeLong = await call(A, 'plan_step_done', { evidence: longEv });
check('造出一条长依据的已完成步骤', closeLong.includes('已关闭'), closeLong.slice(0, 100));
raw().prepare("UPDATE steps SET done_at = done_at - 40*86400000 WHERE plan_id=? AND status='done'").run(planId);
const evLen = () => Number(raw().prepare("SELECT MAX(length(evidence)) c FROM steps WHERE plan_id=?").get(planId).c);

const dry = await call(A, 'plan_gc', {});
check('默认只预演（不许静默动手）', dry.includes('只预演') && dry.includes('什么都没动'), dry.slice(0, 160));
check('预演报告了可衰减条数', /可衰减/.test(dry), dry.slice(0, 160));
const lenAfterDry = evLen();
check('预演确实没改数据（依据长度不变）', lenAfterDry > 200, `实际 ${lenAfterDry}`);

const bad = await call(A, 'plan_gc', { older_than_days: 0 });
check('older_than_days < 1 被拒', bad.includes('≥1'), bad.slice(0, 120));
const badKeep = await call(A, 'plan_gc', { keep_evidence_chars: 5 });
check('keep_evidence_chars < 20 被拒（衰减不是抹除）', badKeep.includes('≥20'), badKeep.slice(0, 120));

const real = await call(A, 'plan_gc', { confirm: true });
check('带 confirm 才真衰减', real.includes('已衰减'), real.slice(0, 160));
const lenAfter = evLen();
check('依据被截断（但仍保留前缀，不是抹除）', lenAfter < lenAfterDry && lenAfter >= 80, `衰减后 ${lenAfter} 字符`);
check('台账记了一笔 gc（衰减本身可追溯）', raw().prepare("SELECT COUNT(*) c FROM ledger WHERE plan_id=? AND kind='gc'").get(planId).c > 0);

// ─────────────────────────────────────────────────────────────────────────────
section('⑧ 计划质量体检（#7 · plan_health）');

const h1 = await call(A, 'plan_health', {});
check('体检能出报告', h1.includes('计划体检'), h1.slice(0, 120));
check('体检给出步数与验收覆盖', /验收覆盖\s*\d+\/\d+/.test(h1), h1.slice(0, 140));

// 正例：2 步、都有验收、文字够长 → 该"没发现硬伤"
await call(A, 'plan_set', { title: '体检干净样本', reason: '自测体检正例', steps: [
	{ text: '把接口改成流式返回', acceptance: '压测下首字节 < 200ms' },
	{ text: '补上回归测试用例', acceptance: '新增 3 条用例且全绿' },
] });
const h2 = await call(A, 'plan_health', {});
check('干净计划 → 没发现硬伤', h2.includes('没发现硬伤'), h2.slice(0, 200));

// 反例：1 步 + 文字过短 + 没验收
await call(A, 'plan_set', { title: '体检烂样本', reason: '自测体检反例', steps: ['干'] });
const h3 = await call(A, 'plan_health', {});
check('只有 1 步 → 提示单步用不上锚', h3.includes('只有 1 步'), h3.slice(0, 200));
check('文字过短 → 报出来', h3.includes('文字过短'), h3.slice(0, 240));
check('没写验收 → 报出来', h3.includes('没写验收标准'), h3.slice(0, 240));

// ─────────────────────────────────────────────────────────────────────────────
section('⑨ 稳定会话身份（修"进程内号跨重启撞车"）');

// 真机缺陷（2026-09-26 验收抓到）：重启后新会话拿到的号与**上一进程**写进台账的老号撞车 →
// 被误判成"是我自己在动" → E v3 的"正在别处做"分支从不触发。
// 修后的规则：**老格式号（s1/s2）一律不算我**，只有稳定身份行才严格比对。
const D = { session: { header: { cwd: CWD, id: 'session-DDD' } } };
const activeId = raw().prepare("SELECT id FROM plans WHERE status='active' ORDER BY id DESC LIMIT 1").get().id;
raw().prepare('UPDATE ledger SET ts = ts - 7200000 WHERE plan_id = ?').run(activeId);   // 先把老账推老
raw().prepare('INSERT INTO ledger (ts, kind, plan_id, session, ref, detail) VALUES (?,?,?,?,?,?)')
	.run(Date.now(), 'on_track', activeId, 's1', '', '自测：老格式号（可能与新进程的号撞车）');

// 【② 之后】开场不再喊 ✓ —— 改成：伸手那一刻被拦 ✓（D 在这个目录没有自己的线，那条是别人的）
{
	const afterOldKey = await call(D, 'plan_step_done', { evidence: 'x', no_work_reason: 'y' });
	check('老格式号（跨进程匹配不上）→ 伸手被拦（不再被误当成「我自己」）', afterOldKey.includes('别的会话的线'), afterOldKey.slice(0, 170) || '(空)');
}

	// ⚠️ 这条原先在**别人的线**上写 plan_note ✗ —— 现在会被伸手闸拦下（它本来就该被拦 ✓）。
	// 改成：D 先立**自己的**一条线，再写台账 → 测的还是「台账记的是稳定身份」✓。
	await call(D, 'plan_set', { title: 'D 自己的线', reason: '自测：台账身份', steps: ['甲'] });
	await call(D, 'plan_note', { text: '自测：验证台账写入的是稳定身份' });
	const newestSession = raw().prepare("SELECT session FROM ledger WHERE plan_id=(SELECT id FROM plans WHERE title='D 自己的线') ORDER BY id DESC LIMIT 1").get().session;
	check('台账写的是稳定身份（session-…），不再是进程内号', /^session-/.test(String(newestSession)), `实际写入：${newestSession}`);

// ─────────────────────────────────────────────────────────────────────────────
// Isolated scope: validate v4 attribution and preserve downstream hook results.
const v4Cwd = CWD + "-v4";
const owner = { session: { header: { cwd: v4Cwd, id: "session-v4-owner" } } };
await call(owner, "plan_set", { title: "v4 fixture", steps: ["fixture work"] });
// ⚠️ 【2026-09-27 归属守卫上线后必须补这一步】本节验的是 **v4 来源格式 + 下游结果保留**，
// 不是归属 —— 而下面的探针会话（session-v4-continue / -block）**不是这条计划的属主** ✗。
// 守卫上线后，陌生人**不该**收到任何提醒（真机报告正是这么要求的 ✓）→ 于是这里会少一条 additionalContext ✗。
// 所以把夹具改成"无主"（owner='' → isMine 为真），让本节继续只测它本来要测的东西 ✓。
raw().prepare("UPDATE plans SET owner='' WHERE title='v4 fixture'").run();
for (const kind of ['continue', 'block']) {
	const probe = { session: { header: { cwd: v4Cwd, id: `session-v4-${kind}` } } };
	await say(probe, '继续');
	const context = { role: 'user', source: { kind: 'plugin:other' }, content: [{ type: 'text', text: '下游提醒' }] };
	const downstream = { kind, feedback: '下游反馈', additionalContexts: [context] };
	let nextCalls = 0;
	const hook = hooks.get('tools/post-execute')[0];
	const result = await hook({ agent: probe, name: 'read', arguments: { file_path: 'a.js' } }, {}, async () => { nextCalls++; return downstream; });
	assert.equal(nextCalls, 1);
	assert.equal(result.kind, kind);
	assert.equal(result.feedback, downstream.feedback);
	assert.equal(result.additionalContexts.length, 2);
	assert.equal(result.additionalContexts[1], context);
	const reminder = result.additionalContexts[0];
	assert.equal(reminder.source.kind, 'plugin:plan-anchor');
	assert.equal(Object.hasOwn(reminder.source, 'plugin'), false);
	assert.ok(reminder.source.summary && reminder.content[0].text);
	assert.deepEqual(downstream.additionalContexts, [context]);
	check(`v4 提醒兼容并保留下游 ${kind} 结果`, true);
}

// ─────────────────────────────────────────────────────────────────────────────
section('⑩ 同目录两个会话互不顶掉（问题 7 回归）');

// 现场（另一个会话 2026-09-27 报的）：干到第 6 步时，同一目录的活跃计划被另一个会话换走 →
//   plan_status 看得到、plan_step_done 一直报「没有生效计划」。
// 根因：只有 withRefs 会设置"当前会话"，而 planStepDone/planNote/planAsk **不走 withRefs**
//   → 它们拿**上一次调用留下的会话**去解析活跃计划 → 解析到别人的计划，或 null。
// 本节判据直接抄报告里的验收：两个会话在同一目录各自立计划、各自 plan_step_done，
//   都能写进去、互不影响。
const S1 = { session: { header: { cwd: CWD, id: 'session-two-1' } } };
const S2 = { session: { header: { cwd: CWD, id: 'session-two-2' } } };

const planA1 = await call(S1, 'plan_set', { title: '会话一的线', reason: '自测：同目录双会话', steps: ['一的甲', '一的乙'] });
// ⚠️ 这里**不能**传 replace:true —— 那会去取代"已存在的活跃计划"，
// 在 S2 自己还没有计划时，被取代的就是 **S1 那条线**（探针实测），于是下面会假失败。
// 探针也证实：同目录立第二条计划**不需要** replace，两条线各自 active、各有其主。
const planB1 = await call(S2, 'plan_set', { title: '会话二的线', reason: '自测：同目录双会话', steps: ['二的甲', '二的乙'] });
check('两个会话都能在同一目录立自己的计划', planA1.includes('会话一的线') && planB1.includes('会话二的线'),
	`A=${planA1.slice(0, 60)} | B=${planB1.slice(0, 60)}`);

await turn(S1, '干会话一的活');
// 【关键】复现真正的 bug 窗口：先让 **S2 的钩子跑过**（它会改写"当前会话"），
// 然后 S1 在**自己的钩子之前**就调 plan_step_done（本回合第一次工具调用）。
// 修复前：它用 S2 的身份解析活跃计划 → 关到别人的步骤上（或报"没有生效计划"）。
// 注：第一版测试在关步前又跑了一次 turn(S1)，钩子把"当前会话"纠正回来，于是**把 bug 掩盖了**
//     —— 预修复版本也全过。测试要卡在窗口上，不能顺手把它补掉。
await say(S2, '干会话二的活');
const closeA = await call(S1, 'plan_step_done', { evidence: '一的甲做完了' });
const closeB = await call(S2, 'plan_step_done', { evidence: '二的甲做完了' });
check('会话一关得掉**自己**那步（不再"没有生效计划"/关到别人那步）', closeA.includes('已关闭') && closeA.includes('一的甲'), closeA.slice(0, 130));
check('会话二关得掉**自己**那步', closeB.includes('已关闭') && closeB.includes('二的甲'), closeB.slice(0, 130));

const twoLines = raw().prepare("SELECT p.title t, SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) done FROM plans p JOIN steps s ON s.plan_id=p.id WHERE p.title IN ('会话一的线','会话二的线') GROUP BY p.id").all();
const lineOne = twoLines.find((r) => r.t === '会话一的线'), lineTwo = twoLines.find((r) => r.t === '会话二的线');
check('两条线的进度互不串（各 1 步 done）', lineOne && lineTwo && Number(lineOne.done) === 1 && Number(lineTwo.done) === 1, JSON.stringify(twoLines));

// ─────────────────────────────────────────────────────────────────────────────
section('⑪ 问题 4b / 5：按「额外 N」定位 + 陈旧泊位举手');

// 【问题4b】主线步与额外步的 id 混在一条序列里，光有"额外第 N 条"推不出 id →
// plan_goto 现在接受 detour_no，就地换算成 step_id。
const G = { session: { header: { cwd: CWD, id: 'session-detour' } } };
await call(G, 'plan_set', { title: '额外步定位样本', reason: '自测：问题4b', steps: ['主线甲', '主线乙'] });
const dt = await call(G, 'plan_detour', { text: '顺手做一张宣传图', reason: '自测：问题4b', acceptance: '图出完' });
check('开出一条额外步骤', dt.includes('已开一条额外步骤') || dt.includes('额外步骤'), dt.slice(0, 130));

// 先切回主线（否则焦点本就在额外步上，跳过去看不出效果）
const fullG = await call(G, 'plan_status', { detail: 'full' });
const mainId = Number((fullG.match(/主线第 1 步\(id=(\d+)\)/) || [])[1] || 0);
await call(G, 'plan_goto', { step_id: mainId, reason: '自测：先回主线' });
const backToDetour = await call(G, 'plan_goto', { detour_no: 1, reason: '自测：按额外编号切回去' });
check('按「额外 1」能直接定位（不用先查 id）', backToDetour.includes('焦点已切到') && /额外步骤 ?1/.test(backToDetour), backToDetour.slice(0, 160));
const badDetour = await call(G, 'plan_goto', { detour_no: 99, reason: '自测：不存在的额外步' });
check('不存在的额外编号 → 明确报错并指路', badDetour.includes('没有『额外步骤 99』') && badDetour.includes('plan_status'), badDetour.slice(0, 160));

// 【问题5】泊位只进不出 → 挂太久的要主动举手（仿"回程票"那套）
await call(G, 'plan_discover', { text: '一条挂了很久的欠账', disposition: 'defer', resume_when: '以后再说' });
raw().prepare("UPDATE parking SET created_at = created_at - 5*86400000 WHERE plan_id = (SELECT id FROM plans WHERE title='额外步定位样本')").run();
const staleMsg = await call(G, 'plan_status', {});
check('挂了超 3 天的泊位 → 主动举手并说清怎么关', /挂了超过 3 天/.test(staleMsg) && staleMsg.includes('plan_close'), staleMsg.slice(0, 220));

// 【真机验收修正】额外步骤多的时候"极简"不能被顶回去：
// 实测 #25 有 32 条额外步骤，逐条全列会让输出从 ~900 涨回 **2,900 字符** —— 那就白改了。
const gid = raw().prepare("SELECT id FROM plans WHERE title='额外步定位样本'").get().id;
for (let i = 2; i <= 30; i++) {
	raw().prepare("INSERT INTO steps (plan_id, ord, detour_no, text, kind, status) VALUES (?,?,?,?,'detour','done')").run(gid, 100000 + i, i, `批量额外步 ${i}`);
}
const bigStatus = await call(G, 'plan_status', {});
check('额外步骤 30 条时，极简版仍然很短（< 1200 字符）', bigStatus.length < 1200, `实际 ${bigStatus.length} 字符`);
check('并且如实说明省略了多少条（不是静默截断）', /另有 \d+ 条已完成/.test(bigStatus), bigStatus.slice(0, 200));

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
section('⑫ 重试陷阱（真机发现：重试不能把下一步也关了）');

// 真机现场（plan#38）：第 1 步关掉后，一次"看起来失败"的调用被重试 →
// 而 plan_step_done 关的是**当前步**（已顺延到第 2 步）→ 第 2 步被同一条依据关掉 ✗（不报错，只记错账）。
// 判据（三条同时成立才拦）：上一条主线步已 done + 依据逐字相同 + 两步之间零工作痕迹。
const RT = { session: { header: { cwd: CWD + '-retry', id: 'session-retry' } } };
await call(RT, 'plan_set', { title: '重试陷阱样本', reason: '自测：重试陷阱', steps: ['R1 甲', 'R2 乙', 'R3 丙'] });

const okClose = await call(RT, 'plan_step_done', { evidence: 'R1 纯讨论定了', no_work_reason: '本步不需要工具' });
check('第 1 步合法关掉', okClose.includes('已关闭') && okClose.includes('第 1 步'), okClose.slice(0, 120));

const retryClose = await call(RT, 'plan_step_done', { evidence: 'R1 纯讨论定了', no_work_reason: '本步不需要工具' });
check('同一依据重试 → 被认出来并拦下（不是静默关下一步）', retryClose.includes('重试'), retryClose.slice(0, 200));
const rt2 = raw().prepare("SELECT status FROM steps WHERE plan_id=(SELECT id FROM plans WHERE title='重试陷阱样本') AND kind='plan' AND ord=2").get();
check('第 2 步仍是 active（没被悄悄记成完成）', rt2.status === 'active', JSON.stringify(rt2));

// 反例：换一条**属于第 2 步**的依据 → 应当放行（闸门不能误伤正常关步）
const okClose2 = await call(RT, 'plan_step_done', { evidence: 'R2 也纯讨论定了', no_work_reason: '本步也不需要工具' });
check('换一条属于本步的依据 → 正常放行（不误伤）', okClose2.includes('已关闭') && okClose2.includes('第 2 步'), okClose2.slice(0, 130));

// ─────────────────────────────────────────────────────────────────────────────
section('⑬ 借来的计划：不说"你正在做"、不催、不替别人记预算（真机现场）');

// 现场原话（另一个会话）：「它说"你正在做主线第 9 步"，而那条计划是别的会话的，
//   且它上一条提醒刚说过"不是你的活"。**两句话自相矛盾**。」＋「漂移预算已经 138/12 了」。
const BO = { session: { header: { cwd: CWD + '-borrow', id: 'session-borrow-owner' } } };
await call(BO, 'plan_set', { title: '借来的线', reason: '自测：借来的计划', steps: ['甲', '乙', '丙'] });
const BX = { session: { header: { cwd: CWD + '-borrow', id: 'session-borrow-other' } } };

const firstBorrow = await turn(BX, '你好');
	// 【② 之后】开场不再喊 ✓ —— 但**伸手会被拦**（判据挪到那一刻 ✓）
	const borrowRefused = await call(BX, 'plan_step_done', { evidence: '想动别人的线', no_work_reason: '试' });
	check('借来的线上伸手 → 被拦 + 指路 plan_claim', borrowRefused.includes('别的会话的线') && borrowRefused.includes('plan_claim'), borrowRefused.slice(0, 220));

const secondBorrow = await turn(BX, '继续');
check('**不再**出现「你正在做 / ⚙ 在做」那种自相矛盾的说法', !/你正在做|⚙ 在做/.test(secondBorrow), secondBorrow.slice(0, 180));
check('也不催（借来的计划不该催到不相干的会话头上）', !secondBorrow.includes('回合没有任何变化'), secondBorrow.slice(0, 160));

// 【补 · 2026-09-27 真机】真正那句「你正在做…」的**原产地是"开新活"提醒**（不是漂移质问）：
// 一个会话在**别人的**计划上调用 todo_write / task_create / subagent 时，会被告知
// 「【计划锚】你正在做主线第 N 步，却调用了 todo_write 开了一项新活」✗ —— 这正是另一位会话报的原话。
// 所以直接照那个形状测：在借来的计划上开一项新活。
const deepBorrow = await fire(BX, 'todo_write', { tasks: [{ content: '顺手记个待办' }] });
check('堵住"开新活"路径：借来的计划上不说「你正在做主线第 N 步」', !/你正在做|⚙ 在做/.test(deepBorrow), deepBorrow.slice(0, 220) || '（安静）');

const budgetOf = () => Number((raw().prepare("SELECT value FROM plan_state WHERE plan_id=(SELECT id FROM plans WHERE title='借来的线') AND key='calls_since_update'").get() || {}).value || 0);
const beforeB = budgetOf();
for (let i = 0; i < 15; i++) await turn(BX, '继续');
const afterB = budgetOf();
check('借来的计划不替我记预算（不会涨成 138/12）', afterB === beforeB, `前 ${beforeB} → 后 ${afterB}`);

// ─────────────────────────────────────────────────────────────────────────────
section('⑭ 泊位口径回归（真库验证抓到：显示按作用域、举手按 plan_id ✗）');

// 场景：泊位挂在**已归档的旧计划**上（血脉可见）→ 新计划也必须举手。
// 为什么原来漏测：我把样本的泊位挂在**同一个计划**上（两边口径恰好一致 ✓），
// 于是 bug 只在"泊位挂在旧计划上"时才现形 —— 真库验证当场抓到，而自测当时全绿 ✗。这条专门打它。
const XX = { session: { header: { cwd: CWD + '-park', id: 'session-park' } } };
await call(XX, 'plan_set', { title: '泊位口径样本 v1', reason: '自测：口径回归', steps: ['甲', '乙'] });
const v1Id = raw().prepare("SELECT id FROM plans WHERE title='泊位口径样本 v1'").get().id;
await call(XX, 'plan_set', { title: '泊位口径样本 v2', reason: '口径回归：换一版', steps: ['甲2', '乙2'] });
// ⚠️ 关键：泊位要**留在旧计划上**（plan_id = v1）—— 这才是真库里的形态（#2 显示 1 条、那条挂在已归档的 #1 上）。
// 第一版我让血脉把它带过来（plan_id 被改到 v2）→ 两种口径都找得到 → **断言形同虚设** ✗（双向检验当场发现：旧口径也全过）。
const parkCols = raw().prepare('PRAGMA table_info(parking)').all().map((c) => c.name);
const hasResume = parkCols.includes('resume_when');
raw().prepare(`INSERT INTO parking (plan_id, text, status, created_at${hasResume ? ', resume_when' : ''}) VALUES (?,?, 'parked', ?${hasResume ? ", '以后再说'" : ''})`)
	.run(v1Id, '挂在旧计划上的旧欠账', Date.now() - 5 * 86400000);
const v2Status = await call(XX, 'plan_status', {});
check('泊位留在旧计划上时，新计划也要举手（两个口径必须一致）', /挂了超过 3 天/.test(v2Status), v2Status.slice(0, 240));

// ─────────────────────────────────────────────────────────────────────────────
section('⑮ 三处修复：同域多线提示 / 用户信号归属 / 按 id 看另一条线');

// ① 同域多线：一个会话在同一目录有多条自己的线时，锚里要点出来（否则另一条"看不见"）
const ML = { session: { header: { cwd: CWD + '-multi', id: 'session-multi' } } };
await call(ML, 'plan_set', { title: '多线样本 A', reason: '自测：多线', steps: ['甲', '乙'] });
const mlOwner = raw().prepare("SELECT owner FROM plans WHERE title='多线样本 A'").get().owner;
// 直接插第二条（同一个 owner ✓）：scope 必须**取计划 A 的真实 scope**（别自己拼路径 ——
// 第一次我拼了 `CWD + '-multi'`，与规范化后的 scope 不一致 → 兄弟查询查不到 → 断言假失败 ✗）
const mlScope = raw().prepare("SELECT scope FROM plans WHERE title='多线样本 A'").get().scope;
raw().prepare("INSERT INTO plans (title, version, status, scope, owner, created_at) VALUES (?,1,'active',?,?,?)")
	.run('多线样本 B', mlScope, mlOwner, Date.now());
const mlBId = raw().prepare("SELECT id FROM plans WHERE title='多线样本 B'").get().id;
const mlOut = await call(ML, 'plan_status', {});
check('同域多线时，锚里点出「你还有别的线」', /还有 \d+ 条自己的线/.test(mlOut), mlOut.slice(0, 240));
check('并且给了可操作入口（plan_status 带 plan_id）', mlOut.includes('plan_id'), mlOut.slice(0, 260));

// ③ 按 id 看另一条线（我第一版只加了参数声明、没接线 ✗ —— 断言要能抓到这个"说了没做"）
const byId = await call(ML, 'plan_status', { plan_id: mlBId });
check('plan_status 能按 id 看另一条线', byId.includes('多线样本 B'), byId.slice(0, 160));
check('不存在的 id → 明确报错', (await call(ML, 'plan_status', { plan_id: 999999 })).includes('不存在'), '');

// ② 用户信号也必须认归属：别人的计划上**不许**注入"他在叫你停 + 那条计划的真实进度"
const SG = { session: { header: { cwd: CWD + '-signal', id: 'session-sig-owner' } } };
await call(SG, 'plan_set', { title: '信号归属样本', reason: '自测：信号归属', steps: ['甲', '乙'] });
const SX = { session: { header: { cwd: CWD + '-signal', id: 'session-sig-other' } } };
const strangerSignal = await turn(SX, '先不做了，停一下');          // 陌生人说"停"
// 口径（修正过一次）：**用户信号照给** ✓ —— "他在叫你停"是对**这个会话**说的，跟计划归谁无关（停就要停 ✓）；
// **不该给的**是把别人的计划当成它的 ✗（不摆那条计划的标题/进度 ✓）。第一版我写反了，断言当场把它纠回来 ✓。
check('别人的计划上：信号照给，但不摆那条计划的进度（不把别人的计划当成你的）',
	/他在叫你停/.test(strangerSignal) && !/信号归属样本/.test(strangerSignal), strangerSignal.slice(0, 260));
const ownerSignal = await turn(SG, '先不做了，停一下');             // 正对照：属主说"停" → 应该有
check('（正对照）属主自己的计划上，照常注入「他在叫你停」', /他在叫你停/.test(ownerSignal), ownerSignal.slice(0, 220));

// ─────────────────────────────────────────────────────────────────────────────
section('⑯ 源头兜底：锚是唯一渲染处 —— 不是我的活就绝不摆成"你的活"');

// 【2026-09-27 真机残留】我自己偶尔还会看到**别人的计划**的那套"▶ 要做…" ✗（入口逐个堵会漏 ✗：
// pre-step / observe / 压缩补锚 / 工具回执… 而且入口会继续新增）。
// 修法：在 anchorText（唯一渲染锚的地方）**源头兜住** —— 不是本会话的活 → 只如实说明 + 两个出口。
const FS1 = { session: { header: { cwd: CWD + '-foreign', id: 'session-f-owner' } } };
await call(FS1, 'plan_set', { title: '别人的线', reason: '自测：源头兜底', steps: ['甲', '乙'] });
const FS2 = { session: { header: { cwd: CWD + '-foreign', id: 'session-f-other' } } };
const foreignView = await call(FS2, 'plan_status', {});
check('别人的计划：锚不摆成「你的活」', !/▶ 要做|你正在做|⚙ 在做/.test(foreignView), foreignView.slice(0, 240));
check('别人的计划：如实说明「不是本会话开的」+ 两个出口', /不是本会话开的/.test(foreignView) && /plan_claim/.test(foreignView), foreignView.slice(0, 260));
const ownerView = await call(FS1, 'plan_status', {});
check('（正对照）属主照旧看到完整锚「▶ 要做」', /▶ 要做/.test(ownerView), ownerView.slice(0, 200));

// ─────────────────────────────────────────────────────────────────────────────
section('⑰ 记账提醒也要认归属（真机残留：我一直在收到它，却只能去动别人的线 ✗）');

// 真机现场：本会话在 `d:\知识库` 没有自己的计划（那条 #25 是别人的）→ 却一直被提醒
// 「🗒【记账提醒】…→ plan_detour 记一条」✗ —— 而 plan_detour 只会记到**别人的线**上 ✗，根本不可执行。
const BK1 = { session: { header: { cwd: CWD + '-bk', id: 'session-bk-owner' } } };
await call(BK1, 'plan_set', { title: '记账样本', reason: '自测：记账归属', steps: ['甲', '乙'] });
const BK2 = { session: { header: { cwd: CWD + '-bk', id: 'session-bk-other' } } };   // 同目录，但那条线是别人的
await say(BK2, '改');                                                                 // 一句短话 + 直接改文件
const bkForeign = await fire(BK2, 'write');
check('借来的线上，记账提醒不响（它根本不可执行）', !/记账提醒/.test(bkForeign), bkForeign.slice(0, 220) || '（安静）');
await say(BK1, '改');                                                                 // 正对照：属主
const bkOwner = await fire(BK1, 'write');
check('（正对照）自己的线上，记账提醒照响', /记账提醒/.test(bkOwner), bkOwner.slice(0, 220));

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
section('⑱ 不立计划就拦动手（pre-execute + ask —— 按宿主官方选择规则）');

// 官方依据（宿主 docs/cookbook/adding-a-tool.md「Execution policy and observation」）：
//   「别把部署策略做进工具里。用 tools/pre-execute 做可扩展的 allow/deny/ask 策略」
//   「guard() 只用于后续监听者无法撤销的最终单调拒绝」（那是给不变量的 ✗，不是给策略的 ✓）
//   「用最弱的、够用的机制」「需要等待的决定（比如问用户）就从 pre-execute 返回 ask」
// 分级：第 1 次改文件不说 → 第 2 次轻劝（原有 noPlanNudge ✓）→ 第 3 次**升级问用户** ✓
const preGate = async (ag, toolName) => {
	for (const h of hooks.get('tools/pre-execute') || []) {
		const r = await h({ agent: ag, name: toolName, arguments: {} }, async () => ({ kind: 'allow' }));
		if (r && r.kind && r.kind !== 'allow') return r;
	}
	return { kind: 'allow' };
};
const EF = { session: { header: { cwd: CWD + '-enforce', id: 'session-ef-noplan' } } };
// ⚠️ 计数口径：noPlanWrites 记的是**已完成**的改文件次数；pre-execute 里 +1 = **这一次**。
//    所以「第 3 次改文件」= 已完成 2 次 + 这一次 → 断言要卡在这个位置（第一版我提前一格 ✗）。
await fire(EF, 'write');                 // 已完成 1 次
const g1 = await preGate(EF, 'write');   // 这一次是第 2 次 → 未到阈值 ✓
check('还没到阈值 → 不升级（前几次只轻劝）', g1.kind === 'allow', JSON.stringify(g1).slice(0, 140));
await fire(EF, 'write');                 // 已完成 2 次
const g3 = await preGate(EF, 'write');   // 这一次是第 3 次 → 升级 ✓
check('第 3 次改文件且无计划 → 升级为 ask（问用户，不是拦死）', g3.kind === 'ask', JSON.stringify(g3).slice(0, 200));
check('升级语自带出口（立计划 / 说清这是一次性活）', /plan_set/.test(String(g3.reason)) && /一次性活/.test(String(g3.reason)), String(g3.reason).slice(0, 240));
const g4 = await preGate(EF, 'write');
check('每会话只升一次（第 4 次不再问，免得变墙纸）', g4.kind === 'allow', JSON.stringify(g4).slice(0, 120));
const gRead = await preGate(EF, 'read');
check('只读工具一律放行', gRead.kind === 'allow', JSON.stringify(gRead).slice(0, 120));
const EP = { session: { header: { cwd: CWD + '-enforce2', id: 'session-ef-plan' } } };
await call(EP, 'plan_set', { title: '有计划样本', reason: '自测：不拦有计划的人', steps: ['甲', '乙'] });
for (let i = 0; i < 5; i++) await fire(EP, 'write');
const gp = await preGate(EP, 'write');
check('（正对照）有自己计划 → 永远放行', gp.kind === 'allow', JSON.stringify(gp).slice(0, 140));

// ─────────────────────────────────────────────────────────────────────────────
section('⑲ 两处留白已修：按 id 动手 / 按 id 查询认归属');

const G1 = { session: { header: { cwd: CWD + '-gaps', id: 'session-gap-owner' } } };
await call(G1, 'plan_set', { title: '多线 A', reason: '自测：按 id 动手', steps: ['甲', '乙'] });
const gapScope = raw().prepare("SELECT scope FROM plans WHERE title='多线 A'").get().scope;
const gOwner = raw().prepare("SELECT owner FROM plans WHERE title='多线 A'").get().owner;
raw().prepare("INSERT INTO plans (title,version,status,scope,owner,created_at) VALUES (?,1,'active',?,?,?)").run('多线 B', gapScope, gOwner, Date.now());
const aId = raw().prepare("SELECT id FROM plans WHERE title='多线 A'").get().id;
const bId = raw().prepare("SELECT id FROM plans WHERE title='多线 B'").get().id;

check('同域多线：默认解析到较新的那条', (await call(G1, 'plan_status', {})).includes('多线 B'), '');
check('按 id 能看旧那条（留白①：能看 ✓）', (await call(G1, 'plan_status', { plan_id: aId })).includes('多线 A'), '');
const aDone = await call(G1, 'plan_step_done', { plan_id: aId, evidence: '旧线的第一步做完了', no_work_reason: '自测' });
check('按 id 能**动手**旧那条（留白①已修）', /已关闭/.test(aDone), aDone.slice(0, 180));
const aN = raw().prepare("SELECT COUNT(*) c FROM steps WHERE plan_id=? AND status='done'").get(aId).c;
const bN = raw().prepare("SELECT COUNT(*) c FROM steps WHERE plan_id=? AND status='done'").get(bId).c;
check('关的是**指定**那条，没串到另一条', aN === 1 && bN === 0, `A=${aN} B=${bN}`);

const GS = { session: { header: { cwd: gapScope, id: 'session-gap-stranger' } } };
const sv = await call(GS, 'plan_status', { plan_id: aId });
check('别人的线：按 id 查只给中性摘要（留白②已修，不给步骤明细）', /不是本会话开的/.test(sv) && !/主线步骤（短版/.test(sv), sv.slice(0, 220));
const sDone = await call(GS, 'plan_step_done', { plan_id: bId, evidence: '想动别人的线', no_work_reason: '试' });
check('⛔ 绕过测试：传**别人的 id** 动手 → 照样被拦（归属跟着同一个 id ✓）', sDone.includes('别的会话的线'), sDone.slice(0, 200));

console.log('════════ plan-anchor 自测套 ════════');
console.log(results.join('\n'));
console.log(`\n合计：${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
