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
import { rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
// 可移植解析：开发布局（../dsh-plan-anchor）优先，否则用发布布局（../dsh）。
// 照 tests/_test_plan_anchor.mjs 的同一写法 —— 公开仓库里别人也能直接跑。
const LIB = (() => {
	const dev = new URL('../dsh-plan-anchor/lib/index.js', import.meta.url);
	return (existsSync(dev) ? dev : new URL('../dsh/lib/index.js', import.meta.url)).href;
})();
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
		for (const c of (d && d.additionalContexts) || []) out += (c.content || []).map((x) => x.text || '').join('');
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
section('④ 新会话首问（E）：先分「正在别处做」与「遗留」');

const raw = () => new DatabaseSync(P);
const planId = raw().prepare("SELECT id FROM plans WHERE status='active' ORDER BY id DESC LIMIT 1").get().id;
const C = { session: { header: { cwd: CWD, id: 'session-CCC' } } };   // 第三个会话，专门用来看"正在别处做"

// 先把台账时间推老 2 小时 → 模拟"做到一半、早就没人动了的遗留计划"
raw().prepare('UPDATE ledger SET ts = ts - 7200000 WHERE plan_id = ?').run(planId);

const legacy = await turn(B, '你好，看看这个目录');
check('遗留：问"要不要接着做"', legacy.includes('不是本会话开的'), `注入：${legacy.slice(0, 120) || '(空)'}`);
check('遗留：明确要求用 ask_user_question 去问用户', legacy.includes('ask_user_question'), legacy.slice(0, 200));
check('遗留：禁止自己替用户决定', legacy.includes('不许自己替用户决定'), '没写这条');

const legacy2 = await turn(B, '继续看看');
check('遗留：第二次不再重复首问', !legacy2.includes('需要你回话'), legacy2.slice(0, 160));

await call(B, 'plan_status', {});
const legacy3 = await turn(B, '再看看');
check('遗留：本会话查过计划后不再问', !legacy3.includes('需要你回话'), legacy3.slice(0, 160));

// 再插一条"别的会话刚刚动过"的台账 → 模拟"正在别处做"
raw().prepare('INSERT INTO ledger (ts, kind, plan_id, session, ref, detail) VALUES (?,?,?,?,?,?)')
	.run(Date.now(), 'on_track', planId, 'sOTHER', '', '自测：模拟另一个会话刚动过这条计划');

const live = await turn(C, '你好，帮我看个东西');
check('活跃：提示"正由别的会话在做"', live.includes('正由别的会话在做'), `注入：${live.slice(0, 120) || '(空)'}`);
check('活跃：**不再**问"要不要接着做"（防两头做同一件事）', !live.includes('要不要接着做'), live.slice(0, 200));
check('活跃：明确说"别两头做"', live.includes('别两头做'), '没写这条');
check('活跃：给出最后活动时间', /\d+\s*分钟前/.test(live), live.slice(0, 220));

const live2 = await turn(C, '继续');
check('活跃：只提醒一次，之后安静', !live2.includes('正由别的会话在做'), live2.slice(0, 160));

// ─────────────────────────────────────────────────────────────────────────────
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
check('新库/老库都被盖上结构版本戳（v1）', Number(uv) === 1, `实际 user_version=${uv}`);

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

const afterOldKey = await turn(D, '你好');
check('老格式号的新鲜台账 → 仍判为"别人在动"（撞车不再骗过判断）', afterOldKey.includes('正由别的会话在做'), afterOldKey.slice(0, 160) || '(空)');

await call(D, 'plan_note', { text: '自测：验证台账写入的是稳定身份' });
const newestSession = raw().prepare('SELECT session FROM ledger WHERE plan_id=? ORDER BY id DESC LIMIT 1').get(activeId).session;
check('台账写的是稳定身份（session-…），不再是进程内号', /^session-/.test(String(newestSession)), `实际写入：${newestSession}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('════════ plan-anchor 自测套 ════════');
console.log(results.join('\n'));
console.log(`\n合计：${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
