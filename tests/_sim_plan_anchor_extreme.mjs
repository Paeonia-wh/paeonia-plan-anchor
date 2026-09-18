// 极端场景仿真：用脚本驱动**真实插件代码**（不是 mock 逻辑），
// 5 个场景各自演示"一个想偷懒/想糊弄/被问题淹没的 agent 会看到什么"。
// 说明：这里的"agent"是脚本，不是 LLM —— 所以它证明的是**护栏的状态机与判据行为**，
// 不证明"真实模型会不会乖乖配合"（那要靠真实会话跑）。
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const TMP = join(tmpdir(), 'plan-anchor-tests');
mkdirSync(TMP, { recursive: true });
const DB = join(TMP, 'sim-extreme.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch {} }

const mod = await import((await import('node:fs')).existsSync(new URL('../dsh-plan-anchor/lib/index.js', import.meta.url))
  ? new URL('../dsh-plan-anchor/lib/index.js', import.meta.url).href
  : new URL('../dsh/lib/index.js', import.meta.url).href);
const registered = [];
const hooks = new Map();
const ctx = {
  tools: { register: (t) => registered.push(t) },
  on: (e, h) => { if (!hooks.has(e)) hooks.set(e, []); hooks.get(e).push(h); }
};
mod.apply(ctx, { path: DB, driftThreshold: 12, escalateAt: 24, detourBudget: 3, refuseCap: 5, scopeMode: 'observe', watchTools: ['task_create'], turnAnchor: true });
const byName = new Map(registered.map((t) => [t.name, t]));

const agent = { id: 'sim' };
async function call(name, args) { return (await byName.get(name).execute(args || {}, { agent })).result; }
async function fire(toolName, args) {
  let inj = [];
  for (const h of hooks.get('tools/post-execute') || []) {
    const d2 = await h({ agent, name: toolName, arguments: args || {} }, {}, async () => ({ kind: 'continue' }));
    inj = inj.concat((d2 && d2.additionalContexts) || []);
  }
  return inj.length ? inj[0].content[0].text : '';
}
const refused = (s) => s.startsWith('⛔');
const head = (s, n = 1) => s.split('\n').slice(0, n).join(' ');
function H(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function step(label, s) { console.log(`\n▸ ${label}\n   ${refused(s) ? '拒绝！' : '接受'} ${head(s, 2).slice(0, 190)}`); }

// ─────────────────────────────────────────────────────────────────────────────
H('场景 1 · 新问题洪水：执行第 1 步时连撞 8 个问题，agent 全都想「现在做」');
let r = await call('plan_set', { title: '洪水测试', steps: [
  { text: '调研配置', acceptance: '列出要改的文件' }, '写 Dockerfile', '写 compose', '本地跑通', '写文档', '上线' ] });
console.log('立计划 →', head(r, 2).replace(/\n/g, ' '));
let permitOk = 0, permitBlocked = 0;
for (let i = 1; i <= 8; i++) {
  const out = await call('plan_discover', { text: `第 ${i} 个新问题`, disposition: 'permit' });
  if (refused(out)) permitBlocked++; else permitOk++;
  if (i <= 3 || i === 8) step(`第 ${i} 次「现在做」`, out);
}
console.log(`\n结果：permit 成功 ${permitOk} 次，被拒 ${permitBlocked} 次`);
console.log('→ 结论：**结构上无法把偏离嵌套起来** —— 一旦处于偏离态，第二次 permit 会被拒。');
console.log('  但代价是：它逼 agent 做选择（做完再发现 / 入泊），这**正是设计意图**。');
step('agent 改口入泊（第 3 个问题）', await call('plan_discover', { text: '第 3 个问题（改判）', disposition: 'defer', resume_when: '第 2 步之后', resume_after_ord: 2 }));
let s = await call('plan_status', {});
console.log('\nplan_status 摘要：\n' + s.split('\n').slice(0, 6).map((l) => '   ' + l).join('\n'));

// ─────────────────────────────────────────────────────────────────────────────
H('场景 2 · 对抗性磨关：反复调 plan_step_done 硬推，不写证据');
// 先回到主线并进入干净的一步
await fire('read', { file_path: 'x.txt' }); // 留下工作痕迹
await call('plan_step_done', { evidence: '调研完成，列出 3 个待改文件' });
let n = 0, released = false, firstMsg = '', releaseAt = 0;
for (let i = 1; i <= 10; i++) {
  const out = await call('plan_step_done', {});
  if (refused(out)) { n++; if (i === 1) firstMsg = out; } else { released = true; releaseAt = i; break; }
}
console.log(`连续被拒 ${n} 次后在**第 ${releaseAt} 次**放行：released=${released}`);
console.log('第一次被拒的提示（节选）：\n   ' + firstMsg.split('\n').slice(0, 2).join('\n   ').slice(0, 200));
const lg = await call('plan_log', { limit: 12 });
const refusedRows = (lg.match(/关卡拒绝/g) || []).length;
console.log(`\n台账里「关卡拒绝」出现 ${refusedRows} 次，"熔断放行"出现 ${(lg.match(/熔断放行/g) || []).length} 次`);
console.log('→ 结论：磨关**能磨过去**（行业共识：强制力是有限纠偏预算），但**每一步都留痕**。');
console.log(`  代价：过一步要烧 ${releaseAt} 次调用，且痕迹永久可见。`);

// ─────────────────────────────────────────────────────────────────────────────
H('场景 3 · 装死：零动作声称完成，以及「假装干过活」');
r = await call('plan_discover', { text: '临时挂起用的问题', disposition: 'defer', resume_when: '之后' });
step('零动作 + 写证据「已完成」', await call('plan_step_done', { evidence: '已完成' }));
console.log('\n   ↑ 被 I9 挡住（工作痕迹 = 0）');
await fire('read', { file_path: 'nothing-relevant.txt' });  // 一次毫无意义的读
step('喂一次无意义的工具调用，再写「已完成」', await call('plan_step_done', { evidence: '已完成' }));
console.log('\n→ 结论：I9 只挡得住「零动作」。**「敷衍的一读 + 废话证据」能过** —— 这是真实漏洞，');
console.log('  I7 只校验 evidence 非空、不判质量（判质量需要语义判断，超出硬拦的合法边界）。');

// ─────────────────────────────────────────────────────────────────────────────
H('场景 4 · 绕过尝试：无理由覆盖 / 泊位消失 / 不申报就干活 / 直接改数据库');
step('(a) 无 reason 覆盖计划', await call('plan_set', { title: '偷偷换掉', steps: ['x'] }));
step('(b) 敷衍的 reason（"因为我想换"）', await call('plan_set', { title: '换个计划', steps: ['x', 'y'], reason: '因为我想换' }));
console.log('   ↑ **过了**：reason 只校验非空、不校验质量。同上，判质量需要语义判断。');
await call('plan_discover', { text: '要被关掉的泊位', disposition: 'defer', resume_when: '之后' });
step('(c) 无理由关泊位', await call('plan_close', { park_id: 1 }));
// (d) 直接改数据库
const db = new DatabaseSync(DB);
const before = db.prepare('SELECT COUNT(*) c FROM parking').get().c;
db.prepare('DELETE FROM parking WHERE id = 2').run();
const after = db.prepare('SELECT COUNT(*) c FROM parking').get().c;
db.close();
console.log(`\n(d) 直接改数据库删泊位：parking ${before} → ${after} 条`);
const stAfter = await call('plan_status', {});
const detected = stAfter.includes('一致性异常');
console.log('   plan_status 有没有检测到？', detected ? '**检测到了 ✓**' : '**没有 ✗**');
if (detected) console.log('   ' + (stAfter.split('\n').find((l) => l.includes('一致性异常')) || '').trim().slice(0, 170));
console.log('→ 结论：绕开工具直接改库**逃不过一致性自检**（台账 append-only，删不掉这条指控）。');

// ─────────────────────────────────────────────────────────────────────────────
H('场景 5 · 极端并发与收尾：两个项目交错 + 重规划 + 计划走完堆 10 条泊位');
const execP1 = { agent: { session: { header: { cwd: 'D:\\proj1' } } } };
const execP2 = { agent: { session: { header: { cwd: 'D:\\proj2' } } } };
const callIn = async (n2, a, e) => (await byName.get(n2).execute(a || {}, e)).result;
await callIn('plan_set', { title: '项目1的计划', steps: ['1a', '1b'] }, execP1);
await callIn('plan_set', { title: '项目2的计划', steps: ['2a'] }, execP2);
// 交错推进
await callIn('plan_discover', { text: 'P1 的杂事', disposition: 'defer', resume_when: '计划走完之后' }, execP1);
await callIn('plan_discover', { text: 'P2 的杂事', disposition: 'defer', resume_when: '计划走完之后' }, execP2);
const p1 = await callIn('plan_status', {}, execP1);
const p2 = await callIn('plan_status', {}, execP2);
console.log(`P1 看到：${p1.split('\n')[0]}`);
console.log(`P2 看到：${p2.split('\n')[0]}`);
console.log('交错污染？', p1.includes('项目2') || p2.includes('项目1') ? '**有**' : '没有 ✓');
// 重规划后旧泊位是否存活
await callIn('plan_set', { title: '项目1的计划 v2', steps: ['1a 重做', '1b'], reason: '需求变了' }, execP1);
const p1b = await callIn('plan_park', {}, execP1);
console.log('重规划后旧泊位：', p1b.includes('P1 的杂事') ? '仍然挂着 ✓（不会被重规划顺手清掉）' : '**丢了** ✗');
// 堆 10 条泊位 + 走完计划
for (let i = 1; i <= 10; i++) await callIn('plan_discover', { text: `堆积项 ${i}`, disposition: 'defer', resume_when: '计划走完之后' }, execP1);
let last = '';
for (let i = 0; i < 6; i++) {
  for (const nm of ['read']) { await hooks.get('tools/post-execute')[0]({ agent: execP1.agent, name: nm, arguments: { file_path: 'a.js' } }, {}, async () => ({})); }
  last = await callIn('plan_step_done', { evidence: '做完了' }, execP1);
  if (last.includes('计划全部走完')) break;
}
console.log('走完计划时的收尾提示：\n   ' + (last.split('\n').find((l) => l.includes('计划全部走完')) || '(未触发)'));
console.log('→ 结论：泊位堆到 10 条不会丢失、也不会自动消失；**收尾时会明确把欠账举到你眼前**。');

console.log('\n' + '='.repeat(78));
console.log('仿真结束。再次强调：这里驱动的是**真实插件代码**，但"agent"是脚本。');
console.log('='.repeat(78));
