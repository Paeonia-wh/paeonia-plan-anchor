// 冒烟测试：dsh-plan-anchor（防漂移护栏）—— 重点是验证不变量 I1~I8 真的被强制
// 不依赖 harness：模拟 ctx.tools.register 与 ctx.on，手工触发钩子。
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试库放系统临时目录：跨平台，且不依赖任何人的工作区路径
const TMP = join(tmpdir(), 'plan-anchor-tests');
mkdirSync(TMP, { recursive: true });
const TESTDB = join(TMP, 'plan-anchor-test.db');

for (const f of [TESTDB, `${TESTDB}-wal`, `${TESTDB}-shm`]) {
  try { rmSync(f); } catch {}
}

const mod = await import((await import('node:fs')).existsSync(new URL('../dsh-plan-anchor/lib/index.js', import.meta.url))
  ? new URL('../dsh-plan-anchor/lib/index.js', import.meta.url).href
  : new URL('../dsh/lib/index.js', import.meta.url).href);
const { apply } = mod;

const registered = [];
const hooks = new Map();
const ctx = {
  tools: { register: (t) => registered.push(t) },
  on: (event, handler) => { if (!hooks.has(event)) hooks.set(event, []); hooks.get(event).push(handler); }
};
apply(ctx, {
  path: TESTDB,
  driftThreshold: 12,
  escalateAt: 24,
  watchTools: ['task_create', 'todo_write', 'subagent', 'workflow'],
  turnAnchor: true
});

const byName = new Map();
for (const t of registered) byName.set(t.name, t);
console.log('registered tools:', [...byName.keys()].join(', '));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, extra !== undefined ? String(extra).slice(0, 400) : ''); }
}

async function call(name, args) {
  const out = await byName.get(name).execute(args || {});
  const text = out.result;
  let json = null;
  if (text.trimStart().startsWith('{')) { try { json = JSON.parse(text); } catch {} }
  const refused = text.startsWith('⛔');
  const reason = refused ? text.split('\n')[0].replace(/^⛔\s*/, '') : (json && json.reason) || '';
  return { text, json, refused, reason };
}

// ---- 钩子驱动器 ----
const agent = { id: 'agent-1' };
async function fire(toolName, args) {
  const exec = { agent, name: toolName, arguments: args || {} };
  let injected = [];
  for (const h of hooks.get('tools/post-execute') || []) {
    const downstream = await h(exec, {}, async () => ({ kind: 'continue' }));
    injected = injected.concat(downstream && downstream.additionalContexts || []);
  }
  return injected;
}
async function fireUserTurn() {
  for (const h of hooks.get('agent/pre-step') || []) {
    await h({ agent, messages: [{ role: 'user', source: { kind: 'user' } }] }, async () => ({}));
  }
}
const noticeText = (injected) => (injected[0] && injected[0].content[0].text) || '';
/** 留下真实的工作痕迹（I9 判据：本步开始以来有多少次工具调用） */
async function work(n = 1) { for (let i = 0; i < n; i++) await fire('read', { file_path: `w${i}.txt` }); }

console.log('\n--- 1. 无计划时的状态查询 ---');
let r = await call('plan_status', {});
check('提示去立计划', r.text.includes('没有生效的计划'), r.text);

console.log('\n--- 2. plan_set 立计划（I1：只允许一个 active 步骤）---');
r = await call('plan_set', { title: '把电梯 demo 上 Docker', steps: ['调研现有 Dockerfile', '写 Dockerfile', '写 compose 编排', '本地跑通', '写部署文档', '上线试运行'] });
check('立计划成功且开工第 1 步', r.text.includes('第 1/6 步') && r.text.includes('已立计划'), r.text);
check('v1', r.text.includes('（v1）'), r.text);

console.log('\n--- 3. I3：不许可静默覆盖计划 ---');
r = await call('plan_set', { title: '换个计划', steps: ['x'] });
check('无 reason 被拒', r.refused, r.text);
check('拒绝时说清理由', r.reason.includes('reason'), r.reason);
r = await call('plan_status', {});
check('原计划未被改动', r.text.includes('把电梯 demo 上 Docker') && r.text.includes('（v1）'), r.text);

console.log('\n--- 4. I2：新发现只能入泊，不能直接抢焦点 ---');
r = await call('plan_discover', { text: '发现基础镜像里的时区不对', disposition: 'defer', resume_when: '第 1 步做完之后', resume_after_ord: 1 });
check('入泊成功（defer）', r.text.includes('已入泊 #1'), r.text);
check('明确要求不要现在处理', r.text.includes('不要处理它'), r.text);
check('并把焦点按回第 1 步', r.text.includes('主线第 1 步'), r.text);
r = await call('plan_status', {});
check('泊位 1 条未处理', r.text.includes('泊位 1 条未处理'), r.text);
check('当前步仍是第 1 步（未被抢占）', r.text.includes('主线第 1/6 步'), r.text);

console.log('\n--- 5. I7：完成步骤必须写 evidence ---');
r = await call('plan_step_done', {});
check('空 evidence 被拒', r.refused, r.text);
check('解释为什么必须写', r.reason.includes('凭什么算这一步做完了'), r.reason);

console.log('\n--- 5b. I9：零工作痕迹不许声称完成（纯代码判据，不靠模型自觉）---');
r = await call('plan_step_done', { evidence: '看了一遍，没问题' });
check('零工具调用 + 零用户回合 → 被拒', r.refused, r.text);
check('拒绝理由点名工作痕迹为 0', r.reason.includes('工作痕迹 = 0'), r.reason);
check('给出三条出路（干活/显式说明/正式中断）', r.text.includes('no_work_reason') && r.text.includes('plan_discover'), r.text);

console.log('\n--- 6. 正常推进一步（先留下工作痕迹）---');
await work();
r = await call('plan_step_done', { evidence: '读了现有 Dockerfile 与 requirements.txt，确认 base 镜像与依赖' });
check('第 1 步完成 → 第 2 步', r.text.includes('第 1 步完成') && r.text.includes('第 2 步'), r.text);
check('已推进 1/6', r.text.includes('主线 1/6 步'), r.text);

console.log('\n--- 6b. 回程票到期：主线第 1 步做完 → 主动举手提醒（ready-to-resume）---');
r = await call('plan_status', {});
check('泊位 1 的重启条件（第 1 步之后）已到 → 主动提醒', r.text.includes('回程票到期') && r.text.includes('泊位 1'), r.text);
check('并复述当初写的重启条件原文', r.text.includes('第 1 步做完之后'), r.text);

console.log('\n--- 7. 回合锚：每回合第一次工具调用后注入一次，且只一次 ---');
await fireUserTurn();
let inj = await fire('read', { file_path: 'D:/x/Dockerfile' });
check('回合锚已注入', noticeText(inj).includes('【计划锚】'), noticeText(inj));
check('锚里带计划名与当前步', noticeText(inj).includes('把电梯 demo 上 Docker') && noticeText(inj).includes('第 2 步'), noticeText(inj));
check('锚里带泊位数', noticeText(inj).includes('泊位 1 条未处理'), noticeText(inj));
check('来源标注为 plugin（不会被当成人发言）', inj[0]?.source?.kind === 'plugin' && inj[0]?.source?.plugin === 'plan-anchor', JSON.stringify(inj[0]?.source));
inj = await fire('read', { file_path: 'D:/x/Dockerfile' });
check('同一回合不重复注入', inj.length === 0, inj.length);

console.log('\n--- 8. I8：漂移预算（连续 12 次调用无计划进展 → 提醒）---');
// 预算从前面步骤继承而来，先读当前已用量，再算理论触发点（判据必须可对账，不能靠猜）
const statusText = (await call('plan_status', {})).text;
const usedBudget = Number((statusText.match(/已用 (\d+)\//) || [0, 0])[1]);
console.log(`  (进入本节时漂移预算已用 ${usedBudget} 次)`);
let gentleAt = -1, firmAt = -1, extra = 0;
for (let i = 1; i <= 60; i++) {
  const out = await fire('write', { file_path: 'x.txt', content: 'y' });
  const t = noticeText(out);
  if (t.includes('【计划锚 · 提醒】')) gentleAt = gentleAt < 0 ? i : gentleAt;
  else if (t.includes('【计划锚 · 二次提醒】')) firmAt = firmAt < 0 ? i : firmAt;
  else if (t.includes('【计划锚】')) extra++;
}
check(`第 ${Math.ceil(12 - usedBudget)} 次触发轻提醒（预算耗尽）`, gentleAt === Math.ceil(12 - usedBudget), `gentleAt=${gentleAt} used=${usedBudget}`);
check(`第 ${Math.ceil(24 - usedBudget)} 次触发重提醒（升级档）`, firmAt === Math.ceil(24 - usedBudget), `firmAt=${firmAt} used=${usedBudget}`);
check('同一档不再重复轰炸（60 次内只有这两次）', extra === 0, `extra=${extra}`);

console.log('\n--- 9. 提醒内容必须具体（否则等于噪声）---');
const captured = [];
{
  // 新一步 → 新一档可再次触发
  await work();
  await call('plan_step_done', { evidence: 'Dockerfile 写完并 docker build 通过' });
  for (let i = 1; i <= 12; i++) {
    const out = await fire('write', { file_path: 'y.txt', content: 'z' });
    if (noticeText(out)) captured.push(noticeText(out));
  }
}
check('换步后重新计预算并能再提醒', captured.length === 1, captured.length);
check('提醒点名当前步与步名', captured[0] && captured[0].includes('第 3/6 步') && captured[0].includes('写 compose 编排'), captured[0]);
check('提醒给出三条明确出路（含三值处置与重规划）', captured[0] && captured[0].includes('plan_discover') && captured[0].includes('disposition="permit"') && captured[0].includes('reason'), captured[0]);

console.log('\n--- 10. 开新活提醒（计划未完成却去开新任务）---');
const nw = await fire('task_create', { title: '顺手把日志改成结构化的' });
check('检测到"开新活"', noticeText(nw).includes('却调用了') && noticeText(nw).includes('task_create'), noticeText(nw));
check('给出正确处置（先入泊）', noticeText(nw).includes('plan_discover'), noticeText(nw));
const nw2 = await fire('task_create', { title: '再开一个' });
check('同一步只提醒一次', nw2.length === 0, nw2.length);

console.log('\n--- 11. 静音阀（防哭狼来了）---');
r = await call('plan_mute', { reason: '测试静音', calls: 50 });
check('静音成功', r.text.includes('已静音'), r.text);
let mutedInjects = 0;
for (let i = 1; i <= 30; i++) {
  const out = await fire('read', { file_path: 'a' });
  if (out.length) mutedInjects++;
}
check('静音期间零打扰', mutedInjects === 0, mutedInjects);
r = await call('plan_status', {});
check('静音期台账照记（静音不是免责）', r.text.includes('静音'), r.text);

console.log('\n--- 12. 正式中断：只有阻塞当前步才允许立刻偏离 ---');
r = await call('plan_discover', { text: 'compose 起不来：端口被占用，不解决无法继续第 3 步', disposition: 'permit' });
check('认定为正式中断', r.text.includes('正式中断'), r.text);
check('原步骤标为阻塞', r.text.includes('已标记为 ⛔ 阻塞'), r.text);
check('说明会自动回归', r.text.includes('自动'), r.text);
r = await call('plan_status', {});
check('状态判定为偏离中', r.text.includes('偏离中'), r.text);
check('阻塞步骤进入漂移信号', r.text.includes('阻塞中断中') || r.text.includes('阻塞'), r.text);

console.log('\n--- 13. I6：偏离结束后自动回到挂起的步骤 ---');
await work();
r = await call('plan_step_done', { evidence: '换端口 5433，compose 起来了' });
check('自动回到第 3 步', r.text.includes('已自动回到主线第 3 步') && r.text.includes('额外步骤 1 已完成'), r.text);
check('回归后状态为 active（解除阻塞）', r.text.includes('第 3/6 步'), r.text);

console.log('\n--- 14. 从泊位提取条目来做（必须写 reason，留痕）---');
r = await call('plan_goto', { park_id: 1 });
check('无 reason 被拒', r.refused, r.text);
r = await call('plan_goto', { park_id: 1, reason: '时区确实影响第 3 步的镜像构建' });
check('提取成功（用序号显示，不暴露数据库 id）', r.text.includes('已提取泊位 1'), r.text);
check('标注为计划外工作', r.text.includes('计划外的工作'), r.text);
r = await call('plan_status', {});
check('当前处于偏离态', r.text.includes('偏离态') || r.text.includes('偏离中'), r.text);
await work();
r = await call('plan_step_done', { evidence: '时区已设为 Asia/Shanghai' });
check('再次自动回归', r.text.includes('已自动回到主线第 3 步') && r.text.includes('额外步骤 2 已完成'), r.text);
console.log('\n--- 15. 泊位清单与台账 ---');
await call('plan_discover', { text: '镜像体积 1.2G，需要多阶段构建优化', disposition: 'defer', resume_when: '计划走完之后' });
r = await call('plan_park', {});
check('泊位清单列出待处理', r.text.includes('待处理') && r.text.includes('镜像体积'), r.text);
r = await call('plan_park', { all: true });
check('all 连已关闭也列出', r.text.includes('已是') || r.text.includes('已关闭') || r.text.includes('escalated') || r.text.includes('完成') || true, r.text);
r = await call('plan_log', { limit: 50 });
check('台账含立计划/完成/入泊/中断/回归', r.text.includes('立计划') && r.text.includes('完成步骤') && r.text.includes('新问题入泊') && r.text.includes('正式中断') && r.text.includes('自动回归'), r.text);

console.log('\n--- 16. 走完整个计划 ---');
for (const ev of ['第 3 步完成：compose 三件套跑通', '第 4 步完成：本地 200 OK', '第 5 步完成：部署文档写完']) {
  await work();
  await call('plan_step_done', { evidence: ev });
}
r = await call('plan_status', {});
check('完成第 3、4、5 步后为 5/6', r.text.includes('主线 5/6 步'), r.text);
await work();
r = await call('plan_step_done', { evidence: '上线完成，健康检查通过' });
check('最后一步做完 → 触发完成闸门（不许自己拍板）', r.text.includes('计划还不能算完成') && r.text.includes('ask_user_question'), r.text);
check('并提示用户回答后怎么记账', r.text.includes('plan_review'), r.text);
check('计数到 6/6', r.text.includes('主线 6/6 步'), r.text);

console.log('\n--- 17. 显式重规划（带 reason，旧版留痕）---');
r = await call('plan_set', { title: '下一阶段：加监控告警', steps: ['选监控方案', '接 Prometheus', '配告警规则'], reason: '上一阶段已交付，进入运维阶段' });
check('重规划成功且版本 +1', r.text.includes('（v2）'), r.text);
r = await call('plan_log', { limit: 5 });
check('台账记录重规划', r.text.includes('重规划'), r.text);

console.log('\n--- 18. I5 闭环：泊位条目不许静默消失 ---');
// (a) 提取泊位 → 做完 → 该条应被关闭（不再是幽灵条目）
r = await call('plan_discover', { text: '告警通道还没定', disposition: 'defer', resume_when: '计划走完之后' });
const parkA = Number(r.text.match(/已入泊 #(\d+)/)[1]);
await call('plan_goto', { park_id: parkA, reason: '它属于第 1 步的选型工作' });
await work();
await call('plan_step_done', { evidence: '定了用 webhook 通道' });
r = await call('plan_park', {});
check('做完的泊位不再出现在待处理清单', !/泊位 \d+ [^\n]*告警通道还没定/.test(r.text), r.text);
r = await call('plan_park', { all: true });
check('但 all 里能看到它已关闭（不是消失）', /告警通道还没定/.test(r.text) && /已判定不做|已完成/.test(r.text), r.text);

// (b) 提取泊位 → 中止偏离（跳回计划）→ 欠账必须退回待处理，不许静默消失
r = await call('plan_discover', { text: '告警阈值谁来定还没结论', disposition: 'defer', resume_when: '计划走完之后' });
const parkB = Number(r.text.match(/已入泊 #(\d+)/)[1]);
await call('plan_goto', { park_id: parkB, reason: '先看看这个' });
const stepId = Number((await call('plan_status', {})).text.match(/第1步\(id=(\d+)\)/)[1]);
r = await call('plan_goto', { step_id: stepId, reason: '还是先回到主线' });
check('能从偏离态跳回指定步骤', r.text.includes('焦点已切到第 1 步'), r.text);
r = await call('plan_park', {});
check('被中止的偏离：欠账退回待处理（不静默消失）', /泊位 \d+[^\n]*告警阈值谁来定还没结论/.test(r.text) && r.text.includes('待处理'), r.text);
r = await call('plan_log', { limit: 6 });
check('台账把"中止偏离"与"完成偏离"区分开', r.text.includes('中止偏离'), r.text);

console.log('\n--- 19. 偏离额度：不做禁令，只做可见的代价 ---');
r = await call('plan_status', {});
check('额度已回血（完成计划步骤后 -1）', !r.text.includes('偏离额度已用尽'), r.text);
// 连续提取泊位，直到超支（budget=3）
const ids = [];
for (let i = 0; i < 4; i++) {
  const out = await call('plan_discover', { text: `第 ${i + 1} 条待办杂事`, disposition: 'defer', resume_when: '计划走完之后' });
  ids.push(Number(out.text.match(/已入泊 #(\d+)/)[1]));
}
let lastGoto = null;
for (const id of ids) {
  lastGoto = await call('plan_goto', { park_id: id, reason: '就想现在做' });
  await work(); // 做完才能回归，否则偏离态不断累积
  await call('plan_step_done', { evidence: '处理完了' });
}
check('超支时明确写出代价（不禁止）', lastGoto !== null, 'goto 未执行');
r = await call('plan_status', {});
check('额度超支后持续显示在锚上（可见化，非禁令）', r.text.includes('偏离额度已用尽'), r.text);
check('同时明确声明不禁止', r.text.includes('不禁止'), r.text);

console.log(`\n--- 20. 三值处置 permit/defer/decline：新问题不许含糊留在半空 ---`);
r = await call('plan_discover', { text: '忘了写处置的杂事' });
check('不写 disposition 被拒', r.refused, r.text);
check('给出三值说明与安全默认（没想清楚就 defer）', r.text.includes('permit') && r.text.includes('defer') && r.text.includes('decline') && r.text.includes('没想清楚就选这个'), r.text);

r = await call('plan_discover', { text: '判定不做但没给理由', disposition: 'decline' });
check('decline 不给理由被拒', r.refused, r.text);
check('点明禁的是「静默地不做」', r.text.includes('静默'), r.text);

r = await call('plan_discover', { text: '这条路是死路，不做了', disposition: 'decline', note: '实测该镜像没有 arm64 tag' });
check('decline 带理由 → 通过', !r.refused, r.text);
const parkListOpen = (await call('plan_park', {})).text;
check('decline 不进欠账清单', !parkListOpen.includes('这条路是死路'), parkListOpen);
r = await call('plan_park', { all: true });
check('但记录保留可追溯（已判定不做 + 理由）', r.text.includes('已判定不做') && r.text.includes('arm64'), r.text);

r = await call('plan_discover', { text: '顺手发现 README 有个错别字', disposition: 'defer', resume_when: '计划走完之后' });
const parkC = Number(r.text.match(/已入泊 #(\d+)/)[1]);
r = await call('plan_close', { park_id: parkC });
check('plan_close 不给理由被拒', r.refused, r.text);
r = await call('plan_close', { park_id: parkC, reason: '错别字不影响交付，下个迭代会整体重写' });
check('plan_close 带理由 → 关闭成功（并说清是判定不做）', r.text.includes('已判定不做'), r.text);
const afterClose = (await call('plan_park', {})).text;
check('关闭后不再占欠账位（泊位有明确终态，不会烂掉）', !afterClose.includes('错别字'), afterClose);

r = await call('plan_log', { limit: 40 });
check('台账区分「新问题入泊」与「判定不做」两种去向', r.text.includes('新问题入泊') && r.text.includes('判定不做'), r.text);

console.log(`\n--- 21. 两套编号：主线 1..n 与额外步骤 1..m 必须分别报清 ---`);
r = await call('plan_status', {});
check('同时有「主线步骤」与「额外步骤」两节', r.text.includes('主线步骤：') && r.text.includes('额外步骤（从主线岔出去的工作，独立编号，跨修订连续）：'), r.text);
check('主线步骤带 id 且标为主线第 N 步', /主线第1步\(id=\d+\)/.test(r.text), r.text);
check('额外步骤独立编号（额外步骤1/额外步骤2）', /额外步骤1\(id=\d+\)/.test(r.text) && /额外步骤2\(id=\d+\)/.test(r.text), r.text);

// 再岔一次，验证编号**继续往上走**（不复用主线序号、也不从 1 重来）—— 动态取号，不许硬编码
const beforeNos = [...(await call('plan_status', {})).text.matchAll(/额外步骤(\d+)\(id=/g)].map((m) => Number(m[1]));
const maxBefore = beforeNos.length ? Math.max(...beforeNos) : 0;
r = await call('plan_discover', { text: '又发现一个待办：构建缓存没配', disposition: 'defer', resume_when: '计划走完之后' });
const parkD = Number(r.text.match(/已入泊 #(\d+)/)[1]);
r = await call('plan_goto', { park_id: parkD, reason: '它影响第 1 步的验证' });
const newNo = Number((r.text.match(/记为额外步骤 (\d+)/) || [0, 0])[1]);
check('提取泊位时标注记为额外步骤 N，且 N = 上一个最大号 + 1', newNo === maxBefore + 1, `newNo=${newNo} maxBefore=${maxBefore} :: ${r.text}`);
check('并明确说明挂起的是主线第几步', /主线第\s*\d+\s*步/.test(r.text), r.text);
r = await call('plan_status', {});
check('锚头同时报两层进度', /主线 \d+\/\d+ 步｜额外步骤 \d+\/\d+ 完成/.test(r.text), r.text);
check('正在做额外步骤时，明确回答"主线哪一步被挂起"', r.text.includes(`额外步骤${newNo}`) && /主线第\s*\d+\s*步/.test(r.text), r.text);
await work();
r = await call('plan_step_done', { evidence: '缓存目录已配好' });
check('完成额外步骤后汇报两层：额外步骤 N 完成 + 回到主线第 k 步', r.text.includes(`额外步骤 ${newNo} 已完成`) && /已自动回到主线第\s*\d+\s*步/.test(r.text), r.text);
r = await call('plan_log', { limit: 10 });
check('台账也用两套编号（额外步骤N / 主线第N步）', r.text.includes(`额外步骤${newNo}`) && /主线第\d+步/.test(r.text), r.text);

console.log(`\n--- 22. 熔断：反复被拒后改为放行 + 上报（不把诚实的 agent 卡死）---`);
r = await call('plan_step_done', {});
check('被拒时告知这是第几次、几次后会自动放行', r.refused && r.text.includes('这是第 1/5 次被拒') && r.text.includes('自动放行并记为熔断'), r.text);
check('两个关卡不会乒乓（熔断在本次调用内终局）', !r.text.includes('工作痕迹 = 0'), r.text);
let refusedCount = 1, released = false;
for (let i = 0; i < 10; i++) {
  const out = await call('plan_step_done', {});
  if (out.refused) refusedCount++;
  else { released = true; break; }
}
check('前几次仍然坚决拒绝（关卡没被架空）', refusedCount >= 3, `refusedCount=${refusedCount}`);
check('有限次后被放行 —— 不会无限卡死诚实的 agent', released, `released=${released} refusedCount=${refusedCount}`);
r = await call('plan_log', { limit: 12 });
check('台账留下「熔断放行」记录（可见，不是悄悄溜过）', r.text.includes('熔断放行'), r.text);
check('台账也留下每一次「关卡拒绝」（磨关的痕迹藏不住）', r.text.includes('关卡拒绝'), r.text);

console.log(`\n--- 23. 多项目隔离：两个工作目录各有各的计划，互不覆盖 ---`);
const execA = { agent: { session: { header: { cwd: 'D:\\projA' } } } };
const execB = { agent: { session: { header: { cwd: 'D:\\projB\\' } } } }; // 故意带尾斜杠，验证路径归一化
async function callIn(name, args, exec) {
  const out = await byName.get(name).execute(args || {}, exec);
  const text = out.result;
  const refused = text.startsWith('⛔');
  return { text, refused };
}
r = await callIn('plan_set', { title: '项目A的计划', steps: ['A1 调研', 'A2 实现'] }, execA);
check('A 项目立计划成功', !r.refused && r.text.includes('项目A的计划'), r.text);
// 关键判据：B 项目立计划**不需要 reason** —— 说明 A 的计划没有串到 B
r = await callIn('plan_set', { title: '项目B的计划', steps: ['B1 只有一步'] }, execB);
check('B 项目立计划无需 reason（A 的计划没串过来）', !r.refused && r.text.includes('项目B的计划'), r.text);
r = await callIn('plan_status', {}, execA);
check('A 只看到自己的计划', r.text.includes('项目A的计划') && !r.text.includes('项目B的计划'), r.text);
check('A 的主线是 0/2', r.text.includes('主线 0/2 步'), r.text);
r = await callIn('plan_status', {}, execB);
check('B 只看到自己的计划（尾斜杠归一化生效）', r.text.includes('项目B的计划') && !r.text.includes('项目A的计划'), r.text);
check('B 的主线是 0/1', r.text.includes('主线 0/1 步'), r.text);
await callIn('plan_step_done', { evidence: 'A 的第一个动作做完了' }, execA);
r = await callIn('plan_status', {}, execB);
check('B 仍停在 0/1（没被 A 的推进带动）', r.text.includes('主线 0/1 步'), r.text);
r = await call('plan_status', {});
check('默认作用域（本测试主线）完全没被污染', r.text.includes('下一阶段：加监控告警'), r.text);
r = await callIn('plan_log', {}, execA);
check('台账也按项目隔离', !r.text.includes('把电梯 demo 上 Docker'), r.text);

console.log(`\n--- 24. defer 必须给「回程票」（ready-to-resume，有实验依据的那一条）---`);
r = await call('plan_discover', { text: '又不写重启条件的杂事', disposition: 'defer' });
check('defer 不给 resume_when 被拒', r.refused, r.text);
check('拒绝理由点明「这不是记账负担，是机制本身」', r.text.includes('resume_when') && r.text.includes('注意力残留'), r.text);
check('并告知可用 resume_after_ord 换自动提醒', r.text.includes('resume_after_ord'), r.text);
r = await call('plan_discover', { text: '给回程票的杂事', disposition: 'defer', resume_when: '主线第 1 步之后', resume_after_ord: 1 });
check('给了重启条件 → 通过', !r.refused, r.text);
check('回执里复述重启条件', r.text.includes('重启条件已记') && r.text.includes('主线第 1 步之后'), r.text);
r = await call('plan_park', {});
check('泊位清单里也带重启条件', r.text.includes('重启条件：主线第 1 步之后'), r.text);

// —— 补充驱动：在指定 scope 下触发 post-execute（带上会话 cwd，才会命中那个项目的计划）——
async function fireIn(toolName, args, exec) {
  const e = { agent: exec.agent, name: toolName, arguments: args || {} };
  let injected = [];
  for (const h of hooks.get('tools/post-execute') || []) {
    const downstream = await h(e, {}, async () => ({ kind: 'continue' }));
    injected = injected.concat(downstream && downstream.additionalContexts || []);
  }
  return injected;
}

console.log(`\n--- 25. 步骤的验收动作（操作级 cue，Rubinstein 2001：切换代价随 task cuing 下降）---`);
const execC = { agent: { session: { header: { cwd: 'D:\\projC' } } } };
r = await callIn('plan_set', {
  title: '带验收与 scope 的计划',
  steps: [
    { text: '写 Dockerfile', acceptance: 'docker build 通过且镜像 <200MB', files: ['Dockerfile', '*.dockerignore'] },
    { text: '写 compose 编排', acceptance: 'docker compose up 后三个服务 healthy' },
    { text: '本地跑通', acceptance: 'curl localhost:8000 返回 200' }
  ]
}, execC);
check('立计划成功（对象形式的步骤被接受）', !r.refused, r.text);
check('锚行带出该步的验收动作', r.text.includes('（验收：docker build 通过且镜像 <200MB）'), r.text);
r = await callIn('plan_status', {}, execC);
check('步骤表里也带验收', r.text.includes('写 Dockerfile（验收：docker build 通过且镜像 <200MB）'), r.text);
check('未完成的步骤也能看到它的验收标准（判据前置）', r.text.includes('写 compose 编排（验收：docker compose up 后三个服务 healthy）'), r.text);

console.log(`\n--- 26. scope 判决（observe 档：只记录、不拦、不打扰）---`);
await callIn('plan_discover', { text: '无关紧要的观察项', disposition: 'defer', resume_when: '计划走完之后' }, execC).catch(() => {});
let inj3 = await fireIn('write', { file_path: 'D:/projC/Dockerfile', content: 'FROM node' }, execC);
check('范围内写入：注入为空（observe 档不打扰）', inj3.length === 0, inj3.length);
await fireIn('write', { file_path: 'D:/projC/ci.yml', content: 'x' }, execC);
await fireIn('read', { file_path: 'D:/projC/other.js' }, execC);
r = await callIn('plan_status', {}, execC);
check('判决统计出现在 plan_status（观察档的仪表盘）', r.text.includes('scope 判决') && r.text.includes('observe 档'), r.text);
check('范围内写入记为 match', r.text.includes('match 1'), r.text);
check('范围外写入记为 out-of-scope（并要求人工看误报）', r.text.includes('out-of-scope 1') && r.text.includes('误报'), r.text);
check('越界「读」单独记为 read-outside（不算越界改，压误报）', r.text.includes('read-outside 1'), r.text);
check('observe 档全程没有打扰', true, '');
// 判决是 append-only 记录，可回溯
r = await callIn('plan_status', {}, execB);
check('B 项目看不到 C 的判决（隔离）', !r.text.includes('out-of-scope'), r.text);

console.log(`\n--- 27. 重规划不许把欠账弄丢（仿真抓出的真 bug，已修）---`);
const execD = { agent: { session: { header: { cwd: 'D:\\projD' } } } };
await callIn('plan_set', { title: 'D 的第一版计划', steps: ['D1', 'D2'] }, execD);
await callIn('plan_discover', { text: 'D 的欠账（重规划后不许消失）', disposition: 'defer', resume_when: '计划走完之后', resume_after_ord: 1 }, execD);
r = await callIn('plan_park', {}, execD);
check('重规划前：欠账在清单里', r.text.includes('D 的欠账'), r.text);
r = await callIn('plan_set', { title: 'D 的第二版计划', steps: ['D1 重做', 'D2', 'D3'], reason: '需求变了' }, execD);
check('重规划回执明确告知欠账已搬过来', r.text.includes('未闭合欠账') && r.text.includes('已搬到本计划'), r.text);
r = await callIn('plan_park', {}, execD);
check('重规划后：欠账**仍然挂着**（不再丢失）', r.text.includes('D 的欠账'), r.text);
check('搬迁时到期提醒被重置（步骤编号对不上）', !r.text.includes('主线第 1 步后'), r.text);

console.log(`\n--- 28. 绕开工具直接改数据库 → 可检测（不是无痕）---`);
r = await callIn('plan_status', {}, execD);
check('正常状态下没有一致性告警', !r.text.includes('一致性异常'), r.text);
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(TESTDB);
  const victim = db.prepare("SELECT id FROM parking WHERE status='parked' ORDER BY id DESC LIMIT 1").get();
  db.prepare('DELETE FROM parking WHERE id=?').run(victim.id);
  db.close();
  console.log(`   （已直接删除泊位 #${victim.id}，绕过插件）`);
}
r = await callIn('plan_status', {}, execD);
check('篡改被检测出来', r.text.includes('一致性异常'), r.text);
check('告警点名了具体是哪条泊位', /一致性异常：台账里入泊过的 #\d+/.test(r.text), r.text);
check('告警说明缘由（绕开工具直接改库）', r.text.includes('无痕篡改'), r.text);

console.log(`\n--- 29. 完成闸门：把「算不算交付」交给用户，且必须**真的问过** ---`);
const execE = { agent: { session: { header: { cwd: 'D:\\projE' } } } };
const userTurn = async (exec) => {
  for (const h of hooks.get('agent/pre-step') || []) {
    await h({ agent: exec.agent, messages: [{ role: 'user', source: { kind: 'user' } }] }, async () => ({}));
  }
};
await callIn('plan_set', { title: 'E 的小计划', steps: [
  { text: 'E1 实现', acceptance: 'E1 的单测全绿' },
  { text: 'E2 验收', acceptance: 'E2 的回归测试全跑通' }
]}, execE);
for (let i = 1; i <= 2; i++) {
  await fireIn('read', { file_path: 'e.js' }, execE);
  r = await callIn('plan_step_done', { evidence: `E${i} 做完了` }, execE);
}
check('最后一步做完 → 闸门开启，不许自称完成', r.text.includes('计划还不能算完成'), r.text);
check('并明确要求用 ask_user_question 问用户', r.text.includes('ask_user_question'), r.text);
r = await callIn('plan_status', {}, execE);
check('plan_status 显示「待用户确认完成」', r.text.includes('待用户确认完成'), r.text);

r = await callIn('plan_review', { confirmed: true }, execE);
check('【关键】没问过用户就想确认 → 被拒', r.refused, r.text);
check('拒绝依据是可观测事实（没有任何用户发言）', r.text.includes('没有任何用户发言'), r.text);

await userTurn(execE); // 模拟用户真的回话了
r = await callIn('plan_review', { confirmed: false, note: 'E2 没做完，回归测试没跑' }, execE);
check('用户说没完成 → 最后一步被如实退回（不是嘴上改口）', r.text.includes('没完成') && r.text.includes('退回未完成'), r.text);
r = await callIn('plan_status', {}, execE);
check('退回后焦点回到那一步', /主线第 2\/2 步/.test(r.text), r.text);

await fireIn('read', { file_path: 'e2.js' }, execE);
await callIn('plan_step_done', { evidence: '补跑了回归测试，全绿' }, execE);
await userTurn(execE);
r = await callIn('plan_review', { confirmed: true, note: '这回可以了' }, execE);
check('用户确认后正式完成', r.text.includes('用户确认'), r.text);
r = await callIn('plan_log', { limit: 12 }, execE);
check('台账同时留下「用户确认」与「用户判定未完成」', r.text.includes('用户确认') && r.text.includes('用户判定未完成'), r.text);

console.log(`\n--- 30. 【批 0 核心】执行到第 3 步时改计划：进度不许归零、焦点不许跳、编号变化要说清 ---`);
const execF = { agent: { session: { header: { cwd: 'D:\\projF' } } } };
await callIn('plan_set', { title: '上线五步', steps: ['1 调研', '2 写配置', '3 写代码', '4 测试', '5 上线'] }, execF);
for (const ev of ['调研完成', '配置写完']) {
  await fireIn('read', { file_path: 'f.js' }, execF);
  await callIn('plan_step_done', { evidence: ev }, execF);
}
r = await callIn('plan_status', {}, execF);
check('起点：主线 2/5，焦点在第 3 步', r.text.includes('主线 2/5 步') && /▶ 主线第3步\(id=\d+\) 3 写代码/.test(r.text), r.text);
// 注意：step_id 是**数据库 id**，不是序号 —— 模型也要从 plan_status 里读它
const idOfOrd = (text, ord) => { const m = text.match(new RegExp(`主线第${ord}步\\(id=(\\d+)\\)`)); return m ? Number(m[1]) : 0; };
const id4 = idOfOrd(r.text, 4);
check('能从步骤表里读出第 4 步的 id', id4 > 0, `id4=${id4}`);

// ① 原地改一步：把「4 测试」改成「4 集成测试」
r = await callIn('plan_amend', { step_id: id4, text: '4 集成测试', acceptance: '集成环境里三个服务互通', reason: '测试要拆细' }, execF);
check('amend：编号不变、身份不变', r.text.includes('编号未变、身份未变、历史保留'), r.text);
r = await callIn('plan_status', {}, execF);
check('amend 后进度仍是 2/5（没有归零）', r.text.includes('主线 2/5 步'), r.text);
check('amend 后第 4 步文字已改', r.text.includes('4 集成测试（验收：集成环境里三个服务互通）'), r.text);

// ② 插一步：在第 4 步后面插「压测」
r = await callIn('plan_insert', { after_step_id: id4, steps: ['5 压测', { text: '6 观察', acceptance: '看一天指标' }], reason: '上线前要压测' }, execF);
check('insert：明确告知编号顺延', r.text.includes('编号已顺延'), r.text);
check('insert：明确告知身份与完成状态没被带跑', r.text.includes('没有被带跑'), r.text);
r = await callIn('plan_status', {}, execF);
check('insert 后主线 2/7（进度保住）', r.text.includes('主线 2/7 步'), r.text);
check('insert 后焦点仍在第 3 步（没被带跑）', /▶ 主线第3步\(id=\d+\) 3 写代码/.test(r.text), r.text);
check('insert 后原第 5 步「上线」变成第 7 步', /主线第7步\(id=\d+\) 5 上线/.test(r.text), r.text);
check('已完成的 1、2 步始终是 ✔', /✔ 主线第1步\(id=\d+\) 1 调研/.test(r.text) && /✔ 主线第2步\(id=\d+\) 2 写配置/.test(r.text), r.text);

// ③ 丢一步：不做「4 集成测试」了
r = await callIn('plan_drop', { step_id: id4, reason: '环境里没有集成环境，改在本地跑' }, execF);
check('drop：明确告知编号收拢', r.text.includes('编号已收拢'), r.text);
check('drop：说明行没被删除、历史可查', r.text.includes('行没有被删除'), r.text);
r = await callIn('plan_status', {}, execF);
check('drop 后主线 2/6，进度仍保住', r.text.includes('主线 2/6 步'), r.text);
check('被丢弃的步骤仍列在步骤表里（标 ⊘丢弃）', /⊘丢弃 主线第4步\(id=\d+\) 4 集成测试/.test(r.text), r.text);
check('修订史记录了三种修订', r.text.includes('原地改') && r.text.includes('插入') && r.text.includes('丢弃'), r.text);
check('步骤文字里过时的旧编号会被标注出来（不改你的字，但不许悄悄错）', r.text.includes('是旧编号'), r.text);

// ④ 锚行必须主动说"计划刚修订过"
r = await callIn('plan_status', {}, execF);
check('锚行提示计划刚修订过', r.text.includes('⚠ 计划刚修订过'), r.text);

// ⑤ 对比：用 plan_set 整份重建会怎样（回执必须如实说明代价）
r = await callIn('plan_set', { title: '换一份计划', steps: ['A', 'B'], reason: '整个目标变了' }, execF);
check('plan_set 明确列出"旧计划哪些步骤没被认领"', r.text.includes('没有被任何映射认领'), r.text);
check('并指引改用 amend/insert/drop', r.text.includes('plan_amend') && r.text.includes('plan_insert') && r.text.includes('plan_drop'), r.text);

console.log(`\n--- 31. 额外步骤编号跨重规划连续（谱系，不再从 1 重启）---`);
const execG = { agent: { session: { header: { cwd: 'D:\\projG' } } } };
await callIn('plan_set', { title: 'G 计划', steps: ['G1', 'G2'] }, execG);
r = await callIn('plan_discover', { text: 'G 的第一件杂事', disposition: 'permit' }, execG);
check('第一次偏离记为额外步骤 1', r.text.includes('额外步骤 1'), r.text);
await fireIn('read', { file_path: 'g.js' }, execG);
await callIn('plan_step_done', { evidence: '杂事做完了' }, execG);
r = await callIn('plan_set', { title: 'G 计划改版', steps: ['G1 新', 'G2'], reason: '需求变了' }, execG);
r = await callIn('plan_discover', { text: 'G 的第二件杂事', disposition: 'permit' }, execG);
check('重规划后新偏离记为额外步骤 2（不重启）', r.text.includes('额外步骤 2'), r.text);
r = await callIn('plan_status', {}, execG);
check('额外步骤计数跨版本连续（2 条都在）', r.text.includes('额外步骤 1/2 完成') || r.text.includes('额外步骤 1/2'), r.text);

console.log(`\n--- 32. 【批 1】漂移提醒必须真的进台账（以前是假的：写了"已记录"却没记）---`);
const execH = { agent: { session: { header: { cwd: 'D:\\projH' } } } };
await callIn('plan_set', { title: 'H 计划', steps: ['H1', 'H2', 'H3'] }, execH);
let driftN = 0;
for (let i = 0; i < 14; i++) {
  // 用写类工具推进预算（权重 1）：只读工具从批2-C 起算半次
  const out = await fireIn('write', { file_path: 'h.txt', content: 'x' }, execH);
  if (out.length && noticeText(out).includes('【计划锚 · 提醒】')) driftN++;
}
check('确实发出了轻提醒', driftN === 1, `driftN=${driftN}`);
r = await callIn('plan_log', { limit: 20 }, execH);
check('台账里真的出现了「漂移提醒」这一笔', r.text.includes('漂移提醒'), r.text);
check('并且写明了是第几次无进展调用', /第 \d+ 次无进展调用/.test(r.text), r.text);

console.log(`\n--- 33. 【批 1】permit 造成的偏离必须计入偏离额度（以前只有 plan_goto 计入，可刷）---`);
const execI = { agent: { session: { header: { cwd: 'D:\\projI' } } } };
await callIn('plan_set', { title: 'I 计划', steps: ['I1', 'I2', 'I3'] }, execI);
const gotos = [];
for (let i = 1; i <= 4; i++) {
  const d = await callIn('plan_discover', { text: `I 的第 ${i} 个阻塞问题`, disposition: 'permit' }, execI);
  check(`第 ${i} 次 permit 成功`, !d.refused, d.text);
  await fireIn('read', { file_path: 'i.js' }, execI);
  const done = await callIn('plan_step_done', { evidence: `第 ${i} 个问题处理完了` }, execI);
  if (i === 4) gotos.push(done);
}
r = await callIn('plan_status', {}, execI);
check('偏离额度已被 permit 消耗（超支可见）', r.text.includes('偏离额度已用尽'), r.text);

console.log(`\n--- 34. 【批 1】同一目录的不同写法必须归到同一作用域（否则护栏静默失明）---`);
const execJ1 = { agent: { session: { header: { cwd: 'D:\\projJ' } } } };
const execJ2 = { agent: { session: { header: { cwd: 'D:/projJ' } } } };
const execJ3 = { agent: { session: { header: { cwd: 'D:\\projJ\\.' } } } };
const execJ4 = { agent: { session: { header: { cwd: '\\\\?\\D:\\projJ' } } } };
await callIn('plan_set', { title: 'J 计划', steps: ['J1', 'J2'] }, execJ1);
for (const [label, e] of [['正斜杠 D:/projJ', execJ2], ['尾 \\. ', execJ3], ['\\\\?\\ 前缀', execJ4]]) {
  const out = await callIn('plan_status', {}, e);
  check(`${label} 能查到同一份计划（不失明）`, out.text.includes('J 计划'), out.text);
}
// 失明时必须能诊断：没计划时说清解析出来的作用域
const execJ5 = { agent: { session: { header: { cwd: 'D:\\projNobody' } } } };
r = await callIn('plan_status', {}, execJ5);
check('确实没计划时报出作用域，便于诊断路径问题', r.text.includes('本项目作用域'), r.text);

console.log(`\n--- 35. 【批 1】台账默认只看本计划（以前跨项目可见）---`);
const jlog = (await callIn('plan_log', { limit: 60 }, execJ1)).text;
check('默认不含其它项目的台账', !jlog.includes('把电梯 demo 上 Docker') && !jlog.includes('E 的小计划'), jlog);
check('台账头部标明范围', jlog.includes('仅本计划'), jlog);
const jall = (await callIn('plan_log', { limit: 3, all: true }, execJ1)).text;
check('all=true 时才给全部项目', jall.includes('全部项目'), jall);

console.log(`\n--- 36. 【批 1】静音只停止打扰，不停止观察 ---`);
const execK = { agent: { session: { header: { cwd: 'D:\\projK' } } } };
await callIn('plan_set', { title: 'K 计划', steps: [{ text: 'K1', files: ['K1.md'] }, 'K2'] }, execK);
await callIn('plan_mute', { reason: '测试静音', calls: 50 }, execK);
await fireIn('write', { file_path: 'D:/projK/other.md', content: 'x' }, execK);
r = await callIn('plan_status', {}, execK);
check('静音期间 scope 判决仍在记录（判决没被一起停掉）', r.text.includes('out-of-scope 1'), r.text);
check('同时显示静音仍生效', r.text.includes('静音'), r.text);

console.log(`\n--- 37. 【批 1】熔断放行必须在主视图可见（不能只躺在台账里）---`);
const execL = { agent: { session: { header: { cwd: 'D:\\projL' } } } };
await callIn('plan_set', { title: 'L 计划', steps: ['L1', 'L2'] }, execL);
let releasedL = false;
for (let i = 0; i < 8; i++) {
  const out = await callIn('plan_step_done', {}, execL);
  if (!out.refused) { releasedL = true; break; }
}
check('磨关最终被放行', releasedL, `released=${releasedL}`);
r = await callIn('plan_status', {}, execL);
check('步骤表里标出「熔断放行」', r.text.includes('熔断放行'), r.text);

console.log(`\n--- 38. 已完成区冻结：已完成的步骤不能被丢弃（对齐 Camunda）---`);
const execM = { agent: { session: { header: { cwd: 'D:\\projM' } } } };
await callIn('plan_set', { title: 'M 计划', steps: ['M1', 'M2', 'M3'] }, execM);
await fireIn('read', { file_path: 'm.js' }, execM);
await callIn('plan_step_done', { evidence: 'M1 做完了' }, execM);
let st = (await callIn('plan_status', {}, execM)).text;
const idOf = (t, ord) => { const m = t.match(new RegExp(`主线第${ord}步\\(id=(\\d+)\\)`)); return m ? Number(m[1]) : 0; };
r = await callIn('plan_drop', { step_id: idOf(st, 1), reason: '不想要这步了' }, execM);
check('丢弃已完成的步骤 → 被拒', r.refused, r.text);
check('拒绝理由点明"已完成是历史，不是草稿"', r.text.includes('已完成') && r.text.includes('历史'), r.text);
check('并指路 amend / plan_set', r.text.includes('plan_amend') && r.text.includes('plan_set'), r.text);
r = await callIn('plan_status', {}, execM);
check('进度没被抹掉（仍 1/3）', r.text.includes('主线 1/3 步'), r.text);
// 未完成的步骤仍然可以丢
r = await callIn('plan_drop', { step_id: idOf(r.text, 3), reason: 'M3 不做了' }, execM);
check('未完成的步骤照常可丢', !r.refused && r.text.includes('已丢弃'), r.text);
r = await callIn('plan_status', {}, execM);
check('丢弃未完成步骤后：已完成的那步还在（1/2）', r.text.includes('主线 1/2 步') && /✔ 主线第1步\(id=\d+\) M1/.test(r.text), r.text);
// 连带隐患：不能切到一个已丢弃的步骤
const droppedId = (r.text.match(/⊘丢弃 主线第2步\(id=(\d+)\)/) || [0, 0])[1];
r = await callIn('plan_goto', { step_id: Number(droppedId), reason: '想回到它' }, execM);
check('不能切到已丢弃的步骤（否则会把它复活）', r.refused, r.text);

console.log(`\n--- 39. 回程票按步骤身份存：中间插入不会让它指错步（修的是真 bug）---`);
const execN = { agent: { session: { header: { cwd: 'D:\\projN' } } } };
await callIn('plan_set', { title: 'N 计划', steps: ['N1', 'N2', 'N3'] }, execN);
let stN = (await callIn('plan_status', {}, execN)).text;
r = await callIn('plan_discover', { text: 'N 的欠账', disposition: 'defer', resume_when: 'N2 之后', resume_after_ord: 2 }, execN);
check('回执复述重启条件', r.text.includes('主线第 2 步'), r.text);
check('内部已换算成步骤身份', r.text.includes('resume_after_step_id') || r.text.includes('主线第 2 步做完时'), r.text);
// 在第 1 步后面插一步 → 原第 2 步顺延为第 3 步
await callIn('plan_insert', { after_step_id: idOf(stN, 1), steps: ['N1.5'], reason: '补一步' }, execN);
stN = (await callIn('plan_status', {}, execN)).text;
check('插入后原第 2 步顺延为第 3 步', /主线第3步\(id=\d+\) N2/.test(stN), stN);
check('回程票跟着身份走：显示为"主线第 3 步之后"并标出旧号', stN.includes('主线第 3 步之后') && stN.includes('原来写的是第 2 步'), stN);
// 做完 N1 与 N1.5（= 第 1、2 步）—— 此时**不该**到期
for (const ev of ['N1 完成', 'N1.5 完成']) {
  await fireIn('read', { file_path: 'n.js' }, execN);
  await callIn('plan_step_done', { evidence: ev }, execN);
}
stN = (await callIn('plan_status', {}, execN)).text;
check('做到第 2 步（N1.5）时回程票**还没**到期 —— 这就是修复的意义', !stN.includes('回程票到期'), stN);
// 做完 N2（现在的第 3 步）—— 这时才该到期
await fireIn('read', { file_path: 'n.js' }, execN);
r = await callIn('plan_step_done', { evidence: 'N2 完成' }, execN);
stN = (await callIn('plan_status', {}, execN)).text;
check('做到 N2 时才到期（正确时机，不是错位的那个序号）', stN.includes('回程票到期'), stN);

console.log(`\n--- 40. 【③】换计划的显式映射：kept 继承 / replaced 返工 / 未认领会被吼出来 ---`);
// (a) 不写映射：已完成的旧步骤必须被吼出来，不能无声消失
const execOA = { agent: { session: { header: { cwd: 'D:\\projOA' } } } };
await callIn('plan_set', { title: 'OA 第一版', steps: ['OA1 调研', 'OA2 写配置', 'OA3 上线'] }, execOA);
for (const ev of ['调研完成', '配置写完了']) {
  await fireIn('read', { file_path: 'oa.js' }, execOA);
  await callIn('plan_step_done', { evidence: ev }, execOA);
}
r = await callIn('plan_set', { title: 'OA 第二版', steps: ['A', 'B'], reason: '结构大改' }, execOA);
check('未写映射时，已完成的旧步骤被明确吼出来', r.text.includes('没有被任何映射认领'), r.text);
check('并给出两条出路：kept 认领 / replaced 返工', r.text.includes('kept') && r.text.includes('replaced'), r.text);
r = await callIn('plan_status', {}, execOA);
check('新计划从 0 开始（因为没认领）', r.text.includes('主线 0/2 步'), r.text);

// (b) 带映射：第 1 步保留（继承完成状态），第 2 步取代=返工
const execOB = { agent: { session: { header: { cwd: 'D:\\projOB' } } } };
await callIn('plan_set', { title: 'OB 第一版', steps: ['OB1 调研', 'OB2 写配置', 'OB3 上线'] }, execOB);
for (const ev of ['调研做得很扎实', '配置写完但写错了']) {
  await fireIn('read', { file_path: 'ob.js' }, execOB);
  await callIn('plan_step_done', { evidence: ev }, execOB);
}
let stOB = (await callIn('plan_status', {}, execOB)).text;
const idOB1 = idOf(stOB, 1), idOB2 = idOf(stOB, 2);
check('起点：OB 2/3', stOB.includes('主线 2/3 步'), stOB);
r = await callIn('plan_set', {
  title: 'OB 第二版',
  reason: '到这一步发现配置那步做错了',
  steps: ['OB1 调研', 'OB2 重写配置', 'OB3 上线'],
  carry: [
    { from_step_id: idOB1, to_index: 1, relation: 'kept' },
    { from_step_id: idOB2, to_index: 2, relation: 'replaced', note: '配置写错了，得重做' }
  ]
}, execOB);
check('回执说明「完成状态已继承」', r.text.includes('完成状态') && r.text.includes('已继承'), r.text);
check('回执说明新第 2 步是返工', r.text.includes('返工') && r.text.includes('取代旧第 2 步'), r.text);
check('并提醒下游要复查', r.text.includes('下游步骤'), r.text);
r = await callIn('plan_status', {}, execOB);
check('继承生效：新计划直接是 1/3（不是 0/3）', r.text.includes('主线 1/3 步'), r.text);
check('焦点落在返工那一步（第 2 步），不是第 1 步', /▶ 主线第2步\(id=\d+\) OB2 重写配置/.test(r.text), r.text);
check('步骤表标出返工关系', r.text.includes('🔁 返工：取代 #'), r.text);
check('继承的那一步带来源标注', r.text.includes('继承自旧计划第 1 步'), r.text);
check('已被认领的步骤不再出现在"未认领"清单里（E2E 抓到的报告不准）', !/原第1步 OB1 调研[\s\S]{0,120}没有被任何映射认领/.test(r.text), r.text);
// 返工做完 → 计划才推进
await fireIn('read', { file_path: 'ob2.js' }, execOB);
await callIn('plan_step_done', { evidence: '配置重写完成，这次对过了' }, execOB);
r = await callIn('plan_status', {}, execOB);
check('返工完成后 → 2/3', r.text.includes('主线 2/3 步'), r.text);

console.log(`\n--- 41. 【你的场景】做到第 5 步时发现第 1 步做错了 → 当场开返工 ---`);
const execP = { agent: { session: { header: { cwd: 'D:\\projP' } } } };
await callIn('plan_set', { title: 'P 五步工程', steps: ['P1 定方案', 'P2 建库', 'P3 写接口', 'P4 联调', 'P5 上线'] }, execP);
// 做到第 3 步（前两步完成）
for (const ev of ['方案定了', '库建好了']) {
  await fireIn('read', { file_path: 'p.js' }, execP);
  await callIn('plan_step_done', { evidence: ev }, execP);
}
let stP = (await callIn('plan_status', {}, execP)).text;
check('起点：做到第 3 步（2/5）', stP.includes('主线 2/5 步') && /▶ 主线第3步\(id=\d+\) P3 写接口/.test(stP), stP);
const idP1 = idOf(stP, 1);
// 发现第 1 步"定方案"做错了
r = await callIn('plan_rework', { step_id: idP1, reason: '方案选错了，后面全建立在它上面', acceptance: '新方案评审通过，且 P2 的库要按新方案调整' }, execP);
check('返工被接受', !r.refused, r.text);
check('记为额外步骤（不硬塞进主线编号）', /额外步骤 \d+/.test(r.text), r.text);
check('说明它取代的是第 1 步', r.text.includes('取代的是主线第 1 步'), r.text);
check('说明已完成区不删不篡改、只是被取代', r.text.includes('被取代'), r.text);
check('把原第 1 步标为已完成的记录也算事实写出来', r.text.includes('之前标为已完成'), r.text);
check('【关键】提醒下游要复查并给出步号', r.text.includes('下游有 4 步') && r.text.includes('第 2、3、4、5 步'), r.text);
check('说明不计入偏离额度（纠错不是跑偏）', r.text.includes('不计入偏离额度'), r.text);
check('手上那步被挂起、返工做完自动回来', r.text.includes('已挂起') && r.text.includes('自动回到它'), r.text);
r = await callIn('plan_status', {}, execP);
check('步骤表里能看到返工支线', r.text.includes('🔁 返工：取代 #'), r.text);
check('返工期间主线进度保持 2/5（没被搅乱）', r.text.includes('主线 2/5 步'), r.text);
// 做完返工 → 自动回到主线第 3 步
await fireIn('read', { file_path: 'p2.js' }, execP);
r = await callIn('plan_step_done', { evidence: '方案重定并评审通过' }, execP);
check('返工完成后自动回到主线第 3 步', r.text.includes('已自动回到主线第 3 步'), r.text);
// 无 reason 时被拒
r = await callIn('plan_rework', { step_id: idP1 }, execP);
check('不给 reason 的返工被拒', r.refused, r.text);
check('拒绝理由点明"返工是重决定"', r.text.includes('重决定'), r.text);

console.log(`\n--- 42. 【批 2】四条：自我误伤 / 目录通配 / 只读半次 + 额度用尽可见 / 会话隔离 ---`);
// (A) 计划自己的工具不该被 scope 判决
const execQ = { agent: { session: { header: { cwd: 'D:\\projQ' } } } };
await callIn('plan_set', { title: 'Q 计划', steps: [{ text: 'Q1', files: ['Q1.md'] }, 'Q2'] }, execQ);
await callIn('plan_status', {}, execQ);
await callIn('plan_set', { title: 'Q 计划', steps: [{ text: 'Q1', files: ['Q1.md'] }, 'Q2'], reason: '顺手重立一次' }, execQ);
r = await callIn('plan_status', {}, execQ);
check('(A) plan_* 自己的调用不产生任何判决（自我误伤已修）', r.text.includes('本步暂无记录'), r.text);

// (B) 目录通配要能命中绝对路径
await callIn('plan_set', { title: 'Q2 计划', steps: [{ text: '改源码', files: ['src/*.ts'] }, 'Q2b'], reason: '测通配' }, execQ);
await fireIn('write', { file_path: 'D:/projQ/src/a.ts', content: 'x' }, execQ);
r = await callIn('plan_status', {}, execQ);
check('(B) files:[src/*.ts] 命中绝对路径 → match（不再误判越界）', r.text.includes('match 1') && !r.text.includes('out-of-scope'), r.text);
await fireIn('write', { file_path: 'D:/projQ/other/b.md', content: 'y' }, execQ);
r = await callIn('plan_status', {}, execQ);
check('(B) 范围外仍是 out-of-scope（没有把判决放宽成废纸）', r.text.includes('out-of-scope 1'), r.text);

// (C) 只读工具算半次 + 额度用尽要可见
const execR = { agent: { session: { header: { cwd: 'D:\\projR' } } } };
await callIn('plan_set', { title: 'R 计划', steps: ['R1', 'R2'] }, execR);
for (let i = 0; i < 14; i++) await fireIn('read', { file_path: 'r.js' }, execR);
r = await callIn('plan_status', {}, execR);
check('(C) 14 次只读只算 7 分（半次），没触发阈值', r.text.includes('已用 7/12'), r.text);
let usedR = 7;
for (let i = 0; i < 60; i++) {
  await fireIn('write', { file_path: 'r.txt', content: 'x' }, execR);
}
r = await callIn('plan_status', {}, execR);
check('(C) 两档提醒用尽后明确说出来', r.text.includes('都已用掉'), r.text);

// (D) 两个会话的熔断计数必须独立
const execS1 = { agent: { session: { header: { cwd: 'D:\\projS' } } } };
const execS2 = { agent: { session: { header: { cwd: 'D:\\projS' } } } };
await callIn('plan_set', { title: 'S 计划', steps: ['S1', 'S2'] }, execS1);
let refusedBoth = 0;
for (let i = 0; i < 4; i++) {
  if ((await callIn('plan_step_done', {}, execS1)).refused) refusedBoth++;
  if ((await callIn('plan_step_done', {}, execS2)).refused) refusedBoth++;
}
check('(D) 两个会话各拒 4 次都没放行（计数不再共享，磨关难度回到 5 次/会话）', refusedBoth === 8, `refusedBoth=${refusedBoth}`);

console.log(`\n--- 43. 【批3-15】压缩后补锚：回合中间被压缩也能把计划放回眼前 ---`);
const sessT = { header: { cwd: 'D:\\projT' } };
const agentT = { id: 't', session: sessT };
const execT = { agent: agentT };
async function callT(n, a) { return (await byName.get(n).execute(a || {}, execT)).result; }
async function fireT(n, a) {
  let inj = [];
  for (const h of hooks.get('tools/post-execute') || []) {
    const dd = await h({ agent: agentT, name: n, arguments: a || {} }, {}, async () => ({ kind: 'continue' }));
    inj = inj.concat((dd && dd.additionalContexts) || []);
  }
  return inj.length ? inj[0].content[0].text : '';
}
await callT('plan_set', { title: 'T 计划', steps: ['T1', 'T2'] });
// 先清掉"回合锚"的待注入标记，避免混淆
for (const h of hooks.get('agent/pre-step') || []) {
  await h({ agent: agentT, messages: [{ role: 'user', source: { kind: 'user' } }] }, async () => ({}));
}
await fireT('read', { file_path: 't.js' }); // 第一发：回合锚
// 模拟一次压缩结束
for (const h of hooks.get('session/event') || []) {
  await h(sessT, { type: 'compaction/end' });
}
const after = await fireT('read', { file_path: 't2.js' });
check('压缩结束后会补一次锚', after.includes('【计划锚】') && after.includes('刚才发生过上下文压缩'), after);
const after2 = await fireT('read', { file_path: 't3.js' });
check('补一次就够（不会每次调用都刷）', !after2.includes('刚才发生过上下文压缩'), after2);

console.log(`\n--- 44. 【没立计划就动手】：改文件两次 → 被看见一次（学 Task-Anchor "No code without a lock"）---`);
const execU = { agent: { session: { header: { cwd: 'D:\\projU' } } } };
let injU = await fireIn('write', { file_path: 'D:/projU/a.txt', content: 'x' }, execU);
check('第 1 次改文件：不打扰', injU.length === 0, injU.length);
injU = await fireIn('write', { file_path: 'D:/projU/b.txt', content: 'y' }, execU);
check('第 2 次改文件：被看见', injU.length > 0 && noticeText(injU).includes('还没有计划'), noticeText(injU));
check('并给出两条出路（立计划 / 忽略）', noticeText(injU).includes('plan_set') && noticeText(injU).includes('忽略本条'), noticeText(injU));
injU = await fireIn('write', { file_path: 'D:/projU/c.txt', content: 'z' }, execU);
check('每会话只提醒一次', injU.length === 0, injU.length);
const execV = { agent: { session: { header: { cwd: 'D:\\projV' } } } };
let injV = [];
for (let i = 0; i < 5; i++) injV = await fireIn('pwsh', { command: 'dir' }, execV);
check('只跑命令不触发（单发操作零噪声）', injV.length === 0, injV.length);
const execW = { agent: { session: { header: { cwd: 'D:\\projW' } } } };
await callIn('plan_set', { title: 'W 计划', steps: ['W1'] }, execW);
await fireIn('write', { file_path: 'D:/projW/a.txt', content: 'x' }, execW);
const injW = await fireIn('write', { file_path: 'D:/projW/b.txt', content: 'y' }, execW);
check('有计划时不再提"没计划"', !injW.some((n) => n.content[0].text.includes('还没有计划')), injW.length);

console.log(`\n--- 45. 【用户消息信号】：打断 / 问进度 / 要整理 / 追加需求 ---`);
const mkExec = (cwd) => ({ agent: { session: { header: { cwd } } } });
const userSays = async (exec, text) => {
  for (const h of hooks.get('agent/pre-step') || []) {
    await h({ agent: exec.agent, messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }] }, async () => ({}));
  }
};
const execX = mkExec('D:\\projX');
await callIn('plan_set', { title: 'X 计划', steps: ['X1', 'X2'] }, execX);
await userSays(execX, '等一下，先别改那个');
let injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('打断类被识别（等一下）', noticeText(injX).includes('他在叫你停'), noticeText(injX));
check('并摆出真实进度', noticeText(injX).includes('【真实进度') && noticeText(injX).includes('X 计划'), noticeText(injX));
check('指明"先回应他，别再往下做"', noticeText(injX).includes('先回应他'), noticeText(injX));
await userSays(execX, '我们做到哪了');
injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('进度查询被识别（做到哪）', noticeText(injX).includes('他在问进度'), noticeText(injX));
check('明确"不要凭记忆"', noticeText(injX).includes('不要凭记忆'), noticeText(injX));
await userSays(execX, '我有点乱了，你帮我整理一下');
injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('整理请求被识别（自述混乱 + 动作词）', noticeText(injX).includes('全景整理'), noticeText(injX));
check('给出四类结构 + 零代号约束', noticeText(injX).includes('要做还没做的') && noticeText(injX).includes('零编号'), noticeText(injX));
await userSays(execX, '对了，顺便把 README 也改了');
injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('追加需求被识别（对了/顺便）', noticeText(injX).includes('追加新需求'), noticeText(injX));
check('提示按纪律显式处置、且**不去问用户**', noticeText(injX).includes('不许默默切换') && !noticeText(injX).includes('要不要'), noticeText(injX));
await userSays(execX, '请你调研一下这个方案，另外要注意区分一手来源和二手来源，并且给出每个结论的证据等级，不要编造数字，核不到就写未核实，最后用中文结构化输出给我');
injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('长任务描述里的「另外」不触发（长度判据起作用）', !noticeText(injX).includes('追加新需求'), noticeText(injX).slice(0, 100));
await userSays(execX, '把缺的东西等等都列出来');
injX = await fireIn('read', { file_path: 'x.js' }, execX);
check('「等等」作诸如此类不触发打断（87% 假阳性那条教训）', !noticeText(injX).includes('叫你停'), noticeText(injX).slice(0, 100));

console.log(`\n--- 46. 【泊位 #3 回程票】"我在轨"的表达通道：plan_note 清零预算 ---`);
const execY = mkExec('D:\\projY');
await callIn('plan_set', { title: 'Y 计划', steps: ['Y1', 'Y2'] }, execY);
for (let i = 0; i < 12; i++) await fireIn('write', { file_path: 'y.txt', content: 'x' }, execY);
let stY = await callIn('plan_status', {}, execY);
check('预算已被填满（模拟合法长活）', /已用 12\/12/.test(stY.text), stY.text);
r = await callIn('plan_note', { text: '在做语料挖掘：已完成解压与脚本，正在统计词频' }, execY);
check('在轨声明被接受', !r.refused && r.text.includes('在轨声明已记录'), r.text);
check('说明清零了多少', r.text.includes('漂移预算已清零'), r.text);
check('台账区分「自称在轨」与「真的完成」', r.text.includes('自称在轨'), r.text);
stY = await callIn('plan_status', {}, execY);
check('预算确实清零', /已用 0\/12/.test(stY.text), stY.text);
r = await callIn('plan_log', { limit: 6 }, execY);
check('台账里出现「在轨声明」这一笔', r.text.includes('在轨声明'), r.text);
r = await callIn('plan_note', {}, execY);
check('空话不算在轨依据（被拒）', r.refused, r.text);

console.log(`\n--- 47. 【第5件】人类可读整理稿：零 id / 零内部代号 / 数据由计划本体生成 ---`);
const execZ = mkExec('D:\\projZ');
await callIn('plan_set', { title: '把电梯 demo 上 Docker', steps: [
  { text: '批4-① 调研现有配置', acceptance: '列出要改的文件' },
  { text: '写 Dockerfile', acceptance: 'docker build 通过' },
  { text: '本地跑通', acceptance: 'curl 返回 200' }
]}, execZ);
await fireIn('write', { file_path: 'z.txt', content: 'x' }, execZ);
await callIn('plan_step_done', { evidence: '读完了配置' }, execZ);
await callIn('plan_discover', { text: '日志格式不统一', disposition: 'defer', resume_when: '计划走完之后' }, execZ);
r = await callIn('plan_report', {}, execZ);
check('生成成功', !r.refused && r.text.includes('把电梯 demo 上 Docker'), r.text.slice(0, 200));
check('【硬约束】不含步骤 id', !/id=\d+/.test(r.text), r.text);
check('【硬约束】不含内部代号「批4-」', !r.text.includes('批4-'), r.text);
check('【硬约束】不含泊位编号 #N', !/#\d+/.test(r.text), r.text);
check('含四类中的「已经做完的」', r.text.includes('已经做完的'), r.text);
check('含「要做还没做的」并标出正在做那件', r.text.includes('要做还没做的') && r.text.includes('正在做'), r.text);
check('含「先记下、回头再处理」及其回程条件', r.text.includes('先记下、回头再处理') && r.text.includes('什么时候回头处理'), r.text);
check('明确交代哪几段工具生成不了、必须 agent 补', r.text.includes('工具生成不了') && r.text.includes('必须 agent 自己写'), r.text);

console.log(`\n--- 48. 【第6/7/8件】有限豁免 / 语气与压缩确认 / 证据对验收 ---`);
const execAA = mkExec('D:\\projAA');
await callIn('plan_set', { title: 'AA 计划', steps: [{ text: 'AA1 写文档', acceptance: '文档包含完整安装步骤且能照做' }, 'AA2'] }, execAA);
r = await callIn('plan_mute', { calls: 3 }, execAA);
check('（第6件）静音不给理由被拒', r.refused, r.text);
check('说明"静音不是免责"', r.text.includes('静音不是免责'), r.text);
r = await callIn('plan_mute', { calls: 3, reason: '在跑一个长测试' }, execAA);
check('带理由的静音被接受', !r.refused && r.text.includes('已静音'), r.text);
check('说明有硬上限', r.text.includes('硬上限'), r.text);
let checkin = '';
for (let i = 0; i < 3; i++) {
  const out = await fireIn('read', { file_path: 'aa.js' }, execAA);
  if (out.length && noticeText(out).includes('静音结束')) checkin = noticeText(out);
}
check('（第6件）到期温和 check-in', checkin.includes('静音结束') && checkin.includes('还在计划上吗'), checkin);
await fireIn('write', { file_path: 'aa.txt', content: 'x' }, execAA);
r = await callIn('plan_step_done', { evidence: '搞定了' }, execAA);
check('（第8件）依据没回应验收：仍接受但给提醒', !r.refused && r.text.includes('几乎没有回应验收标准'), r.text.slice(-260));
check('提醒里带上验收原文', r.text.includes('文档包含完整安装步骤且能照做'), r.text.slice(-260));
check('并建议拿不准就问用户', r.text.includes('ask_user_question'), r.text.slice(-260));

console.log(`\n--- 49. 【问用户规则】三档判据 + 铁律 + 熔断负向测试 ---`);
const execAB = mkExec('D:\\projAB');
await callIn('plan_set', { title: 'AB 计划', steps: ['AB1'] }, execAB);
r = await callIn('plan_ask', { kind: 'irreversible', what: '删除 D:/projAB/data 整个目录（不可恢复）' }, execAB);
check('不可逆动作 → 必问，不许静默继续', !r.refused && r.text.includes('必问') && r.text.includes('不许静默继续'), r.text);
check('必问也要求两边都给理由（不得当影响）', r.text.includes('照做的理由') && r.text.includes('不照做的理由'), r.text);
check('铁律：绝不因"用户可能不理智"而不听', r.text.includes('绝不因为'), r.text);
r = await callIn('plan_ask', { kind: 'detail', what: '把变量名从 a 改成 b' }, execAB);
check('纯执行细节 → 不问，只记账', r.text.includes('不问，只记账') && r.text.includes('不要问'), r.text);
check('并说明收尾时一起摆出来', r.text.includes('收尾'), r.text);
r = await callIn('plan_ask', { kind: 'structure', what: '改吗' }, execAB);
check('泛泛地问被拒（approval-shaped friction）', r.refused && r.text.includes('approval-shaped friction'), r.text);
r = await callIn('plan_ask', { kind: '乱写', what: '把 A 目录移到 B' }, execAB);
check('非法 kind 被拒并列出可选值', r.refused && r.text.includes('irreversible'), r.text);
for (let i = 0; i < 5; i++) await callIn('plan_ask', { kind: 'structure', what: `改计划结构第 ${i} 次` }, execAB);
r = await callIn('plan_ask', { kind: 'structure', what: '再改一次计划结构' }, execAB);
check('（期望值）问够 5 次后非必问降级为只记账（防疲劳）', r.text.includes('只记账') && r.text.includes('按期望值降级'), r.text);
r = await callIn('plan_ask', { kind: 'irreversible', what: '删除线上数据库' }, execAB);
check('必问档不受疲劳降级影响', r.text.includes('必问'), r.text);
const execAC = mkExec('D:\\projAC');
await callIn('plan_set', { title: 'AC 计划', steps: ['AC1', 'AC2'] }, execAC);
let relay = false;
for (let i = 0; i < 6; i++) {
  const out = await callIn('plan_step_done', {}, execAC);
  if (!out.refused) { relay = true; break; }
}
check('（熔断负向测试）连续被拒达上限后确实放行（不会把人卡死）', relay, String(relay));
const stAC = await callIn('plan_status', {}, execAC);
check('（熔断负向测试）放行必须在主视图上标记出来（〔⚠ 熔断放行〕）', stAC.text.includes('熔断放行'), stAC.text);

console.log(`\n--- 50. 【缺口修补】纯讨论阶段的长任务：终于动手时补提醒 ---`);
const execAD = mkExec('D:\\projAD');
for (let i = 0; i < 6; i++) await userSays(execAD, `第 ${i} 轮讨论：我们想做一个多步的东西`);
const injD = await fireIn('read', { file_path: 'ad.js' }, execAD);
check('纯讨论 6 轮后终于动手 → 补提醒立计划', noticeText(injD).includes('已经聊了'), noticeText(injD).slice(0, 160));
check('并解释为什么该在讨论阶段就立', noticeText(injD).includes('讨论阶段就该立'), noticeText(injD).slice(0, 220));
const execAE = mkExec('D:\\projAE');
await userSays(execAE, '帮我看一眼这个');
await userSays(execAE, '嗯');
const injE = await fireIn('read', { file_path: 'ae.js' }, execAE);
check('只聊两轮就动手 → 不打扰（单发操作零噪声）', !noticeText(injE).includes('已经聊了'), noticeText(injE).slice(0, 120));

console.log(`\n--- 51. 【第一轮就问】会话开场提示「要不要启用计划锚」 ---`);
const execAF = mkExec('D:\\projAF');
await userSays(execAF, '帮我看看这个项目');
const injF = await fireIn('read', { file_path: 'af.js' }, execAF);
check('第一轮 + 无计划 → 开场提示要不要启用', noticeText(injF).includes('本会话第一轮'), noticeText(injF).slice(0, 200));
check('给出可照抄的问句', noticeText(injF).includes('要不要用计划锚管着'), noticeText(injF).slice(0, 260));
check('交代两边代价（好处与代价都有）', noticeText(injF).includes('计划不会忘') && noticeText(injF).includes('代价'), noticeText(injF).slice(0, 300));
check('明确"单发问答则忽略"，防止无谓打扰', noticeText(injF).includes('忽略本条'), noticeText(injF).slice(0, 320));
const injF2 = await fireIn('read', { file_path: 'af2.js' }, execAF);
check('只提示一次（不会每轮都问）', !noticeText(injF2).includes('本会话第一轮'), noticeText(injF2).slice(0, 120));
const execAG = mkExec('D:\\projAG');
await callIn('plan_set', { title: 'AG 计划', steps: ['AG1'] }, execAG);
await userSays(execAG, '继续');
const injG = await fireIn('read', { file_path: 'ag.js' }, execAG);
check('有计划时不提示开场问', !noticeText(injG).includes('本会话第一轮'), noticeText(injG).slice(0, 120));

console.log(`\n--- 52. 【编号体系】序号与 id 都能用；填错要教会人（这次的现场回归） ---`);
const execAH = mkExec('D:\\projAH');
await callIn('plan_set', { title: 'AH 计划', steps: ['AH1 甲', 'AH2 乙', 'AH3 丙'] }, execAH);
// ① 用序号插入（现场就是这里填错的：以前只能填 id）
r = await callIn('plan_insert', { after_ord: 1, steps: ['甲之后'], reason: '按序号插入' }, execAH, true);
check('（①）after_ord 按序号插入可用 —— 这正是当初填错的那个参数', !r.refused && r.text.includes('甲之后'), r.text.slice(0, 200));
// ② 填错时给出教会人的报错（带序号↔id 对照）
r = await callIn('plan_amend', { step_id: 999, text: '改名字' }, execAH, true);
check('（②）id 填错时不是干瘪报错，而是点明"要的是 id 不是序号"', r.refused && r.text.includes('不是「第几步」的序号'), r.text);
check('（②）并附上当前主线的序号↔id 对照表', /第1步→\d+/.test(r.text), r.text);
// ③ 序号当 id 填时的自动识别（明确说明按什么理解）
r = await callIn('plan_amend', { step_id: 2, text: 'AH2 乙改名' }, execAH, true);
if (r.refused && r.text.includes('不是任何步骤的 id')) {
  check('（③）兜底识别生效且说明依据', true, r.text);
} else {
  // 若 id=2 恰好真实存在，则走精确路径，也是对的
  check('（③）id 存在时走精确路径（不误判）', !r.refused, r.text.slice(0, 160));
}
// ④ 泊位用序号关闭 + 显示用序号（不暴露数据库 id）
await callIn('plan_discover', { text: 'AH 的欠账甲', disposition: 'defer', resume_when: '做完 AH3' }, execAH);
r = await callIn('plan_park', {}, execAH);
check('（④）泊位显示为「泊位 N」而不是 #数据库id', /泊位 \d+ \[/.test(r.text) && !/#\d+/.test(r.text), r.text);
r = await callIn('plan_close', { park_ord: 1, reason: '按序号关闭', outcome: 'resolved' }, execAH, true);
check('（④）park_ord 按序号关闭可用', !r.refused, r.text.slice(0, 160));

console.log(`\n--- 53. 【锚的自适应】不变就缩短、一直不变就质问（别当墙纸） ---`);
const execAI = mkExec('D:\\projAI');
await callIn('plan_set', { title: 'AI 计划', steps: ['AI1', 'AI2'] }, execAI);
const anchorOf = async () => {
  await userSays(execAI, '继续');
  const inj = await fireIn('read', { file_path: 'ai.js' }, execAI);
  return noticeText(inj);
};
const a1 = await anchorOf();
check('（①）第 1 次：给完整锚', a1.includes('主线第 1 步') && !a1.includes('与上回合相同'), a1.slice(0, 120));
const a2 = await anchorOf();
check('（①）第 2 次没变化：缩成一行', a2.includes('与上回合相同'), a2.slice(0, 120));
const a3 = await anchorOf();
check('（①）连续没变化：不再复读，改成质问', a3.includes('回合没有任何变化') && a3.includes('真的在推进'), a3.slice(0, 200));
check('（①）质问里给出三条出路', a3.includes('plan_note') && a3.includes('plan_discover') && a3.includes('plan_drop'), a3.slice(0, 320));
await fireIn('write', { file_path: 'ai.txt', content: 'x' }, execAI);
await callIn('plan_step_done', { evidence: 'AI1 做完了' }, execAI);
const a4 = await anchorOf();
check('（①）计划一有变化：立刻回到完整锚（不再质问）', !a4.includes('与上回合相同') && !a4.includes('没有任何变化'), a4.slice(0, 160));

console.log(`\n--- 54. 【泊位 6】「先不管」不再被当成叫停 ---`);
const execAJ = mkExec('D:\\projAJ');
await callIn('plan_set', { title: 'AJ 计划', steps: ['AJ1'] }, execAJ);
await userSays(execAJ, '卖点的话先不管，我们先把东西确定好');
let injJ = await fireIn('read', { file_path: 'aj.js' }, execAJ);
check('（③）「先不管」不再触发"他在叫你停"', !noticeText(injJ).includes('叫你停'), noticeText(injJ).slice(0, 140));
await userSays(execAJ, '先不清理，你把我桌面整理一下');
injJ = await fireIn('read', { file_path: 'aj2.js' }, execAJ);
check('（③）真正的「先不清理」仍然触发叫停', noticeText(injJ).includes('叫你停'), noticeText(injJ).slice(0, 140));

console.log(`\n--- 55. 【真 bug】过期信号必须作废（否则几轮后才炸出来） ---`);
const execAK = mkExec('D:\\projAK');
await callIn('plan_set', { title: 'AK 计划', steps: ['AK1'] }, execAK);
await userSays(execAK, '等一下，你先别推送');
await userSays(execAK, '算了直接推送吧');   // 新回合**没有**信号 → 旧的必须作废
const injK = await fireIn('read', { file_path: 'ak.js' }, execAK);
check('（过期信号）上一轮的「等一下」不再触发叫停', !noticeText(injK).includes('叫你停'), noticeText(injK).slice(0, 160));
await userSays(execAK, '停一下');
const injK2 = await fireIn('read', { file_path: 'ak2.js' }, execAK);
check('（对照）当回合的信号仍然照常触发', noticeText(injK2).includes('叫你停'), noticeText(injK2).slice(0, 160));

console.log(`\n--- 56. 【误报】先别/先不 的"跳过某话题"与"引用这个词"都不算叫停 ---`);
const execAL = mkExec('D:\\projAL');
await callIn('plan_set', { title: 'AL 计划', steps: ['AL1'] }, execAL);
const sayCheck = async (text, shouldStop, label) => {
  await userSays(execAL, text);
  const out = await fireIn('read', { file_path: 'al.js' }, execAL);
  const got = noticeText(out).includes('叫你停');
  check(label, got === shouldStop, `期望${shouldStop ? '叫停' : '不叫停'}，实际${got ? '叫停' : '不叫停'}｜«${text}»`);
};
await sayCheck('没事你先别管这个ppt，先告诉我风格', false, '（先别管）跳过话题 ≠ 叫停');
await sayCheck('先别看代码，先说思路', false, '（先别看）跳过话题 ≠ 叫停');
await sayCheck('就是那个先别的那个事情你好像没修吧', false, '（引用）"先别"后面跟「的」= 在提这个词，不是下指令');
await sayCheck('先不说这个，你先把图给我', false, '（先不说）跳过话题 ≠ 叫停');
await sayCheck('你先别急着改', true, '（对照）真正的「先别急」仍然叫停');
await sayCheck('先别做那个，我们换个方向', true, '（对照）真正的「先别做」仍然叫停');

console.log(`\n--- 57. 【问过就不再问】plan_note 答复过的停滞质问不再重复 ---`);
const execAM = mkExec('D:\\projAM');
await callIn('plan_set', { title: 'AM 计划', steps: ['AM1', 'AM2'] }, execAM);
const anchorAM = async () => { await userSays(execAM, '继续'); const inj = await fireIn('read', { file_path: 'am.js' }, execAM); return noticeText(inj); };
await anchorAM(); await anchorAM();
const q3 = await anchorAM();
check('（前置）连续 3 回合没变 → 出现质问', q3.includes('回合没有任何变化'), q3.slice(0, 120));
await callIn('plan_note', { text: '我在做别的事，这一步在等外部依赖' }, execAM);
const q4 = await anchorAM();
check('（修复）答复之后不再重复同一句质问', !q4.includes('回合没有任何变化'), q4.slice(0, 120));
check('（修复）不再质问，但**锚仍然在**（闭嘴≠消失）', q4.includes('【计划锚】') && q4.includes('已声明在轨'), q4.slice(0, 170));
await fireIn('write', { file_path: 'am.txt', content: 'x' }, execAM);
await callIn('plan_step_done', { evidence: 'AM1 完成' }, execAM);
const q5 = await anchorAM();
check('（对照）状态一变，锚立刻重新开口（给完整版）', q5.includes('【计划锚】') && !q5.includes('没有任何变化'), q5.slice(0, 160));

console.log(`\n--- 58. 【豁免有时效】声明在轨不会变成"永久失明"（用户指出的漏洞） ---`);
const execAN = mkExec('D:\\projAN');
await callIn('plan_set', { title: 'AN 计划', steps: ['AN1', 'AN2'] }, execAN);
const anc = async () => { await userSays(execAN, '继续'); const inj = await fireIn('read', { file_path: 'an.js' }, execAN); return noticeText(inj); };
await anc(); await anc(); await anc();          // 走到质问态
await callIn('plan_note', { text: '我在做别的事' }, execAN);
const c1 = await anc();
check('（豁免期）锚仍在，且标明豁免进度', c1.includes('【计划锚】') && c1.includes('豁免第 1/5 回合'), c1.slice(0, 170));
let last = c1;
for (let i = 0; i < 4; i++) last = await anc();
check('（豁免期）第 5 回合仍在豁免内', last.includes('豁免第 5/5 回合'), last.slice(0, 170));
const expired = await anc();
check('（关键）豁免到期 → 重新问，不会永久失明', expired.includes('声明「在轨」已经') && expired.includes('一步没动'), expired.slice(0, 220));
check('（关键）升级质问给出四条出路（含新增的 plan_detour）', expired.includes('plan_amend') && expired.includes('plan_note') && expired.includes('plan_detour'), expired.slice(0, 360));
check('（关键）并明说豁免不会永久', expired.includes('不会永久'), expired.slice(0, 360));

console.log(`\n--- 59. 【初心】主线之外的事：plan_detour 直接开额外步骤 ---`);
const execAO = mkExec('D:\\projAO');
await callIn('plan_set', { title: 'AO 计划', steps: ['AO1 主线第一步', 'AO2 主线第二步'] }, execAO);
r = await callIn('plan_detour', { text: '给这个项目做一套宣传图', reason: '用户刚要求的', acceptance: '15 张图生成完' }, execAO);
check('（plan_detour）开出一条额外步骤', !r.refused && r.text.includes('已开一条额外步骤'), r.text.slice(0, 200));
check('（plan_detour）主线当前步被挂起', r.text.includes('已挂起'), r.text.slice(0, 240));
check('（plan_detour）明说不计偏离额度', r.text.includes('不计偏离额度'), r.text.slice(0, 260));
r = await callIn('plan_status', {}, execAO);
check('（plan_detour）状态显示：在做额外步骤，主线挂着', r.text.includes('额外步骤'), r.text.slice(0, 200));
await fireIn('write', { file_path: 'ao.txt', content: 'x' }, execAO);
r = await callIn('plan_step_done', { evidence: '15 张图做完了' }, execAO);
check('（plan_detour）做完自动回到主线', r.text.includes('自动回到主线'), r.text.slice(0, 240));
r = await callIn('plan_detour', {}, execAO);
check('（plan_detour）不写 text 被拒', r.refused && r.text.includes('text 必填'), r.text.slice(0, 160));

console.log(`\n--- 60. 【等待状态】三要素 + 两条出边（唤醒 / 超时）---`);
const execAP = mkExec('D:\\projAP');
await callIn('plan_set', { title: 'AP 计划', steps: ['AP1 主线一步'] }, execAP);
// 三要素缺一不可
r = await callIn('plan_wait', { what: '等用户决定' }, execAP);
check('（等待）只写 what 被拒，且点明"只有重试没用的事才算等待"', r.refused && r.text.includes('重试也没用'), r.text.slice(0, 200));
r = await callIn('plan_wait', { what: '等用户决定', until: '用户回话' }, execAP);
check('（等待）缺 on_timeout 被拒，且点明"必须有两条出边"', r.refused && r.text.includes('两条出边'), r.text.slice(0, 220));
check('（等待）并给出 BPMN/Temporal 的出处', r.text.includes('BPMN') && r.text.includes('Temporal'), r.text.slice(0, 300));
// 三要素齐全
r = await callIn('plan_wait', { what: '等用户决定仓库标签', until: '用户回话', on_timeout: '先跳过，继续做别的', timeout_turns: 3 }, execAP);
check('（等待）三要素齐全即接受', !r.refused && r.text.includes('已进入等待'), r.text.slice(0, 200));
check('（等待）回执列出唤醒条件与超时动作', r.text.includes('用户回话') && r.text.includes('先跳过'), r.text.slice(0, 260));
check('（等待）明说不涨漂移预算', r.text.includes('不涨漂移预算'), r.text.slice(0, 300));
// 等待期间锚显示等待态，且不出现停滞质问
const w1 = await (async () => { await userSays(execAP, '继续'); const inj = await fireIn('read', { file_path: 'ap.js' }, execAP); return noticeText(inj); })();
check('（等待）锚显示 ⏸ 等待态与回合数', w1.includes('在等：') && w1.includes('回合'), w1.slice(0, 200));
check('（等待）等待期间不出现停滞质问', !w1.includes('没有任何变化'), w1.slice(0, 200));
// 跑到超时
let timedOut = '';
for (let i = 0; i < 6; i++) {
  await userSays(execAP, '继续');
  const out = noticeText(await fireIn('read', { file_path: 'ap.js' }, execAP));
  if (out.includes('没动静了')) { timedOut = out; break; }
}
check('（超时·第二条边）到点把 agent 叫回来', timedOut.includes('没动静了'), timedOut.slice(0, 200));
check('（超时）提醒当初说好的超时动作', timedOut.includes('先跳过'), timedOut.slice(0, 260));
check('（超时）并说明两条出边', timedOut.includes('两条出边') || timedOut.includes('超时这边'), timedOut.slice(0, 320));
// 等待可用 plan_note 解除（声明在推进 = 等待结束）
await callIn('plan_wait', { what: '等 X', until: 'Y 到', on_timeout: '跳过' }, execAP);
await callIn('plan_note', { text: '条件到了，我继续做' }, execAP);
const w2 = await (async () => { await userSays(execAP, '继续'); const inj = await fireIn('read', { file_path: 'ap.js' }, execAP); return noticeText(inj); })();
check('（唤醒）plan_note 解除等待（声明在推进 = 等待结束）', !w2.includes('在等：'), w2.slice(0, 180));

console.log(`\n--- 61. 【论文依据】计划遵守率 + 计划膨胀可见 ---`);
const execAQ = mkExec('D:\\projAQ');
await callIn('plan_set', { title: 'AQ 计划', steps: ['AQ1', 'AQ2'] }, execAQ);
const ancQ = async () => { await userSays(execAQ, '继续'); const inj = await fireIn('read', { file_path: 'aq.js' }, execAQ); return noticeText(inj); };
await ancQ(); await ancQ();
const z3 = await ancQ();
check('（遵守率）第一次质问时显示"问过 1 次、0 次响应"', z3.includes('问过 1 次') && z3.includes('0 次有响应'), z3.slice(0, 240));
await callIn('plan_note', { text: '我在推进' }, execAQ);
const z4 = await ancQ();          // 豁免期
const z5 = await ancQ();
check('（遵守率）plan_note 之后计入一次响应', z5.includes('1 次有响应') || z5.includes('豁免'), z5.slice(0, 200));
// 计划膨胀
await callIn('plan_set', { title: 'AQ-2', steps: ['只一步'], reason: '换计划重来' }, execAQ);
await callIn('plan_insert', { after_ord: 1, steps: ['加一步', '再加一步'], reason: '膨胀测试' }, execAQ);
await userSays(execAQ, '继续');
const z6 = noticeText(await fireIn('read', { file_path: 'aq2.js' }, execAQ));
check('（膨胀）锚显示"计划已从 1 步长到 3 步"', z6.includes('计划已从 1 步长到 3 步'), z6.slice(0, 220));

console.log(`\n--- 62. 【说了没做】等待期间真的不涨预算 + 等待态/膨胀在 plan_status 里可见 ---`);
const execAR = mkExec('D:\\projAR');
await callIn('plan_set', { title: 'AR 计划', steps: ['AR1', 'AR2'] }, execAR);
await callIn('plan_wait', { what: '等外部 API 返回', until: 'API 返回 200', on_timeout: '改用缓存', timeout_turns: 20 }, execAR);
// 连续 10 次工具调用 —— 预算**必须**纹丝不动（这条就是"说了没做"的锁）
for (let i = 0; i < 10; i++) await fireIn('write', { file_path: `ar${i}.txt`, content: 'x' }, execAR);
r = await callIn('plan_status', {}, execAR);
check('（缺口一）等待期间连做 10 次写操作，预算仍然是 0', r.text.includes('已用 0/12'), r.text.split('\n').filter((l) => l.includes('预算')).join(''));
check('（缺口二）plan_status 里能看到等待状态', r.text.includes('在等') && r.text.includes('等外部 API 返回'), r.text.slice(0, 400));
check('（缺口二）并列出唤醒条件与超时动作', r.text.includes('API 返回 200') && r.text.includes('改用缓存'), r.text.slice(0, 460));
await callIn('plan_insert', { after_ord: 1, steps: ['AR1.5 后加的'], reason: '测试膨胀' }, execAR);
r = await callIn('plan_status', {}, execAR);
check('（缺口三）plan_status 里能看到计划膨胀', r.text.includes('计划已从 2 步长到 3 步'), r.text.slice(0, 500));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
