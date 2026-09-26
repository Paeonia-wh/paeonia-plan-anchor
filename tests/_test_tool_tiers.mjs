/**
 * verify-tool-tiers.mjs · 工具集分层档（#5）专项
 *
 * 为什么单独一个文件：插件把工具注册在 apply() 里，且 db 缓存在模块级 ——
 * 一个进程里验多个档位要靠**带查询串的模块实例**（`?tier=core`）来隔离。
 *
 * 用法：node verify-tool-tiers.mjs   退出码 0 = 全过
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

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}${detail ? ' —— ' + detail : ''}`); }
};

const loadTier = async (tier, tag) => {
	const p = join(tmpdir(), `pa-tier-${tag}.db`);
	for (const f of [p, p + '-wal', p + '-shm']) { try { rmSync(f); } catch { /* 首次 */ } }
	const mod = await import(`${LIB}?tier=${tag}&t=${Date.now()}`);
	const tools = new Map();
	(mod.apply || mod.default.apply)(
		{ tools: { register: (t) => tools.set(t.name, t) }, on: () => {} },
		{ path: p, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', turnAnchor: true, toolTier: tier },
	);
	return [...tools.keys()];
};

console.log('══════ 工具集分层档（#5）══════');

const all = await loadTier('all', 'all');
const standard = await loadTier('standard', 'std');
const core = await loadTier('core', 'core');

check(`all 档挂满（${all.length} 个）`, all.length === 25, `实际 ${all.length}`);
check(`standard 档更少（${standard.length} 个）`, standard.length === 17, `实际 ${standard.length}`);
check(`core 档最少（${core.length} 个）`, core.length === 11, `实际 ${core.length}`);
check('三档是包含关系（core ⊂ standard ⊂ all）', core.every((n) => standard.includes(n)) && standard.every((n) => all.includes(n)));
check('core 里必须有 plan_claim（新会话首问会让 agent 用它）', core.includes('plan_claim'));
check('core 里必须有 plan_detour（用户要的活最容易走这条）', core.includes('plan_detour'));
check('维护类只在 all（plan_export / plan_backup）', !standard.includes('plan_export') && all.includes('plan_export'));
check('plan_gc / plan_health 默认要显式上 all 档才在', !core.includes('plan_gc') && all.includes('plan_health'));

// 非法档位必须快速失败（照本项目"非法配置不许静默回退"的契约）
{
	const p = join(tmpdir(), 'pa-tier-bad.db');
	for (const f of [p, p + '-wal', p + '-shm']) { try { rmSync(f); } catch { /* 首次 */ } }
	const mod = await import(`${LIB}?tier=bad&t=${Date.now()}`);
	let threw = null;
	try {
		(mod.apply || mod.default.apply)(
			{ tools: { register: () => {} }, on: () => {} },
			{ path: p, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', turnAnchor: true, toolTier: 'nope' },
		);
	} catch (e) { threw = e; }
	check('非法 toolTier → 开插件就抛错（不静默回退）', !!threw && /invalid toolTier/.test(String(threw.message)), threw ? threw.message.slice(0, 80) : '居然放行了');
}

console.log(`\n合计：${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
