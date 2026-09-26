/**
 * verify-schema-guard.mjs · 专测「库比代码新」那一支（#4 的闸门）
 *
 * 为什么单独一个文件：plan-anchor 把 db 缓存在**模块级变量**上，同一个进程里没法二次 open
 * —— 所以"开库时发现库领先 → 拦下"这条路径必须在**独立进程**里验。
 *
 * 用法：node verify-schema-guard.mjs   退出码 0 = 全过
 *
 * 验三件事：
 *   ① 库领先（user_version=999）→ open 时必须抛错，且错里带三种处理方式（可操作）
 *   ② 显式豁免（config.ignoreSchemaSkew: true）→ 不抛错，但要打警告（绝不静默）
 *   ③ 环境变量逃生阀 DSH_PLAN_ANCHOR_IGNORE_SCHEMA_SKEW=1 → 同样放行
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

const freshDb = (name, ver) => {
	const p = join(tmpdir(), `pa-guard-${name}.db`);
	for (const f of [p, p + '-wal', p + '-shm']) { try { rmSync(f); } catch { /* 首次 */ } }
	const d = new DatabaseSync(p);
	d.exec('CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY)');
	d.exec(`PRAGMA user_version = ${ver}`);
	d.close();
	return p;
};
const applyWith = async (mod, path, extra = {}) => {
	const tools = new Map();
	(mod.apply || mod.default.apply)(
		{ tools: { register: (t) => tools.set(t.name, t) }, on: () => {} },
		{ path, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', turnAnchor: true, ...extra },
	);
	return tools;
};

console.log('══════ 库结构闸门（#4）══════');

// ① 库领先 → 必须拦
{
	const p = freshDb('ahead', 999);
	const mod = await import('file:///D:/dsh/dsh-plan-anchor/lib/index.js?' + Date.now());
	let threw = null;
	try { await applyWith(mod, p); } catch (e) { threw = e; }
	check('库领先（v999）→ 开库被拦下', !!threw, '居然放行了');
	if (threw) {
		const m = String(threw.message || '');
		check('错误信息可操作：说明了版本差', m.includes('v999') && m.includes('只认到'), m.slice(0, 120));
		check('错误信息给出三种处理', m.includes('更新插件') && m.includes('ignoreSchemaSkew') && m.includes('plan_backup'), m.slice(0, 200));
	}
}

// ② 显式豁免（配置）→ 放行但打警告
{
	const p = freshDb('skew-cfg', 999);
	const mod = await import('file:///D:/dsh/dsh-plan-anchor/lib/index.js?' + Date.now());
	const warns = [];
	const orig = console.error;
	console.error = (...a) => warns.push(a.join(' '));
	let threw = null;
	try { await applyWith(mod, p, { ignoreSchemaSkew: true }); } catch (e) { threw = e; }
	console.error = orig;
	check('显式豁免（配置）→ 放行', !threw, threw && threw.message.slice(0, 80));
	check('豁免也打警告（绝不静默）', warns.some((w) => w.includes('豁免')), JSON.stringify(warns).slice(0, 120));
}

// ③ 环境变量逃生阀 → 放行
{
	const p = freshDb('skew-env', 999);
	process.env.DSH_PLAN_ANCHOR_IGNORE_SCHEMA_SKEW = '1';
	const mod = await import('file:///D:/dsh/dsh-plan-anchor/lib/index.js?' + Date.now());
	let threw = null;
	const orig = console.error; console.error = () => {};
	try { await applyWith(mod, p); } catch (e) { threw = e; }
	console.error = orig;
	delete process.env.DSH_PLAN_ANCHOR_IGNORE_SCHEMA_SKEW;
	check('环境变量逃生阀 → 放行', !threw, threw && threw.message.slice(0, 80));
}

console.log(`\n合计：${pass} 过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
