/**
 * verify-ask-style.mjs · 首问措辞 A/B（#6）专项
 *
 * 验的是"两档真的不一样、且都保住了关键事实"：
 *   directive：含 ⛔ 硬规矩 + 明确要求 ask_user_question
 *   neutral  ：不含 ⛔（中性+事实），但**仍然**必须出现 ask_user_question（否则就丢了"唯一渠道"这个事实）
 *
 * 做法：两个档位各用一个**带查询串的模块实例**（互相隔离 db 缓存），
 * 场景都造一样的：A 会话建计划 → 台账时间推老 2 小时（= 遗留）→ 新会话 B 触发首问。
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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}${detail ? ' —— ' + detail : ''}`); }
};

const scenario = async (style) => {
	const P = join(tmpdir(), `pa-style-${style}.db`);
	for (const f of [P, P + '-wal', P + '-shm']) { try { rmSync(f); } catch { /* 首次 */ } }
	const mod = await import(`${LIB}?style=${style}&t=${Date.now()}`);
	const tools = new Map(); const hooks = new Map();
	(mod.apply || mod.default.apply)(
		{ tools: { register: (t) => tools.set(t.name, t) }, on: (e, f) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(f); } },
		{ path: P, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', turnAnchor: true, freshAskStyle: style },
	);
	const CWD = `D:\\styletest-${style}`;
	const A = { session: { header: { cwd: CWD } } };
	const B = { session: { header: { cwd: CWD } } };
	const tools2 = (n, a, ag) => tools.get(n).execute(a || {}, { agent: ag });

	await tools2('plan_set', { title: '措辞对照样本', steps: ['第一步', '第二步'] }, A);
	const P2 = new DatabaseSync(P);
	P2.prepare('UPDATE ledger SET ts = ts - 7200000 WHERE plan_id = (SELECT id FROM plans ORDER BY id DESC LIMIT 1)').run();

	const say = async (ag, text) => {
		for (const h of hooks.get('agent/pre-step') || []) {
			await h({ agent: ag, messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] }, async () => ({}));
		}
	};
	const fire = async (ag) => {
		let out = '';
		for (const h of hooks.get('tools/post-execute') || []) {
			const d = await h({ agent: ag, name: 'read', arguments: { file_path: 'a.js' } }, {}, async () => ({ kind: 'continue' }));
			for (const c of (d && d.additionalContexts) || []) out += (c.content || []).map((x) => x.text || '').join('');
		}
		return out;
	};
	await say(B, '你好');
	return fire(B);
};

console.log('══════ 首问措辞 A/B（#6）══════');

const directive = await scenario('directive');
check('directive 档：出现 ⛔ 硬规矩', directive.includes('⛔'), directive.slice(0, 120));
check('directive 档：明确要求 ask_user_question', directive.includes('ask_user_question'));
check('directive 档：说明这是唯一渠道', /唯一.*渠道/.test(directive), directive.slice(0, 200));

const neutral = await scenario('neutral');
check('neutral 档：不含 ⛔（中性+事实）', !neutral.includes('⛔'), neutral.slice(0, 200));
check('neutral 档：仍然出现 ask_user_question（关键事实没丢）', neutral.includes('ask_user_question'), neutral.slice(0, 200));
check('neutral 档：仍然说明"用户看不见这条注入"', /看不到|看不见/.test(neutral), neutral.slice(0, 200));
check('两档内容确实不同（A/B 有意义）', directive !== neutral);

console.log(`\n合计：${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
