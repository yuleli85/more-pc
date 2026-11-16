// 隔离测试：定时任务（接口层 + 到点自动发 + 重启错过）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8807, KEY = 'test-key-sched';
const DATA = path.join(__dirname, 'testdata-sched');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');

function startHub() {
  const p = spawn(process.execPath, [HUB], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));
  return p;
}
let hub = startHub();

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
async function api(p, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers === undefined ? { 'x-fleet-key': KEY } : opt.headers) };
  const r = await fetch(B + p, { ...opt, headers });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const poll = (body, ms = 1200) => api('/api/agent/poll', { method: 'POST', body: JSON.stringify(body) });
const mkSched = (b) => api('/api/scheds', { method: 'POST', body: JSON.stringify(b) });
const scheds = () => api('/api/scheds').then((r) => r.j.scheds || []);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 校验：不合法的都拒掉');
  let r = await mkSched({ prompt: '  ', kind: 'daily', at: '09:00' });
  ok(r.status === 400, '空指令拒掉');
  r = await mkSched({ prompt: 'x', kind: 'daily', at: '9点' });
  ok(r.status === 400 && /HH:MM/.test(r.j.error), '时间格式不对拒掉');
  r = await mkSched({ prompt: 'x', kind: 'weekly', at: '09:00', days: [] });
  ok(r.status === 400, '每周没勾星期几拒掉');
  r = await mkSched({ prompt: 'x', kind: 'interval', everyMin: 3 });
  ok(r.status === 400, '间隔小于 5 分钟拒掉');
  r = await mkSched({ prompt: 'x', kind: 'once', onceAt: Date.now() - 1000 });
  ok(r.status === 400, '一次性的时间已过拒掉');
  r = await mkSched({ prompt: 'x', kind: 'daily', at: '09:00', expert: '-bad' });
  ok(r.status === 400, '横线开头的专家名拒掉（防命令行注入）');

  console.log('\n[2] 建一条每天 03:00 → nextRun 是下一个 03:00');
  r = await mkSched({ name: '凌晨整理', prompt: '整理下载目录', kind: 'daily', at: '03:00', mode: 'pool' });
  ok(r.status === 200 && r.j.sched.id, '建好了，有 id');
  const s1 = r.j.sched;
  const expect = (() => {
    const d = new Date(); d.setHours(3, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  })();
  ok(Math.abs(s1.nextRun - expect) < 2000, 'nextRun=下一个 03:00');
  ok(s1.enabled === true && s1.createdAt > 0, '默认启用');

  console.log('\n[3] 没电脑在线时「立即跑一次」→ 记下原因，不发');
  r = await api('/api/scheds/run', { method: 'POST', body: JSON.stringify({ id: s1.id }) });
  ok(r.status === 400 && /还没有电脑|在线/.test(r.j.error), '拒了：' + r.j.error);
  const s1b = (await scheds()).find((x) => x.id === s1.id);
  ok(s1b.lastOk === false && /还没有电脑/.test(s1b.lastErr), '失败原因记在任务上');
  ok(s1b.nextRun === expect, '失败不影响周期，nextRun 没动');

  console.log('\n[4] 有电脑了：每隔 5 分钟');
  await poll({ name: 'S-A', os: 'win32', host: 'S-A', agentVersion: '1.10.1', cli: 'x', workdir: 'C:\\w', cpu: 5 });
  r = await mkSched({ name: '盯盘', prompt: '看看构建挂了没', kind: 'interval', everyMin: 5, mode: 'pool', targets: ['S-A'] });
  const s2 = r.j.sched;
  const now = Date.now();
  ok(s2.nextRun > now + 4 * 60000 && s2.nextRun <= now + 5 * 60000 + 3000, '下一次=创建时间+5 分钟');

  console.log('\n[5] 立即跑一次 → 真发任务、带「定时」标记');
  r = await api('/api/scheds/run', { method: 'POST', body: JSON.stringify({ id: s2.id }) });
  ok(r.status === 200 && r.j.ids.length === 1, '发出去一件');
  const st = await api('/api/state');
  const t = st.j.tasks.find((x) => x.id === r.j.ids[0]);
  ok(!!t, '任务在列表里');
  ok(t.schedName === '盯盘' && t.schedId === s2.id, '带定时标记和 id');
  ok(t.prompt === '看看构建挂了没' && t.mode === 'pool', '内容、派法照配置来');
  const s2b = (await scheds()).find((x) => x.id === s2.id);
  ok(s2b.lastOk === true && s2b.lastTaskIds.length === 1, '发成功记在任务上');
  ok(Math.abs(s2b.nextRun - s2.nextRun) < 1500, '手动跑不打乱周期');
  const pr = await api('/api/prompts');
  ok(pr.j.prompts.some((x) => x.text === '看看构建挂了没'), '提示词页也记了');

  console.log('\n[6] 启停 + 编辑');
  r = await api('/api/scheds/update', { method: 'POST', body: JSON.stringify({ id: s2.id, enabled: false }) });
  ok(r.status === 200 && r.j.sched.enabled === false && r.j.sched.nextRun === 0, '停用后 nextRun 清零');
  r = await api('/api/scheds/update', { method: 'POST', body: JSON.stringify({ id: s2.id, enabled: true }) });
  ok(r.j.sched.nextRun > Date.now(), '重新启用算好下一次');
  r = await api('/api/scheds/update', { method: 'POST', body: JSON.stringify({ id: s2.id, kind: 'weekly', at: '23:30', days: [1], prompt: '周一深夜跑', mode: 'all' }) });
  const s2c = r.j.sched;
  const expMon = (() => {
    const d = new Date(); d.setHours(23, 30, 0, 0);
    while (!(d.getTime() > Date.now() && d.getDay() === 1)) d.setDate(d.getDate() + 1);
    return d.getTime();
  })();
  ok(s2c.kind === 'weekly' && s2c.prompt === '周一深夜跑', '改成了每周一 23:30');
  ok(Math.abs(s2c.nextRun - expMon) < 2000, 'nextRun=下一个周一 23:30');

  console.log('\n[7] 删');
  r = await mkSched({ prompt: '要删的', kind: 'daily', at: '04:00' });
  const sid = r.j.sched.id;
  r = await api('/api/scheds/delete', { method: 'POST', body: JSON.stringify({ ids: [sid] }) });
  ok(r.status === 200 && r.j.removed === 1, '删掉一条');
  ok(!(await scheds()).some((x) => x.id === sid), '列表里没了');

  console.log('\n[8] 到点自动发（一次性，等它自己跑）');
  r = await mkSched({ name: '自动档', prompt: '自动档测试活', kind: 'once', onceAt: Date.now() + 32000, mode: 'pool' });
  const s3 = r.j.sched;
  let fired = null, waited = 0;
  while (waited < 75000) {
    await sleep(3000); waited += 3000;
    const x = (await scheds()).find((y) => y.id === s3.id);
    if (!x.enabled) { fired = x; break; }
  }
  ok(!!fired, '跑完后自动停用');
  ok(fired && /跑过/.test(fired.note || ''), '标了「到点跑过了」');
  const st2 = await api('/api/state');
  const t2 = st2.j.tasks.find((x) => x.prompt === '自动档测试活');
  ok(!!t2 && t2.schedName === '自动档', '到点真发了任务');
  ok(fired.lastOk === true, '发成功');

  console.log('\n[9] 重启时错过的档口不补发');
  r = await mkSched({ name: '错过档', prompt: '不该出现的活', kind: 'once', onceAt: Date.now() + 32000, mode: 'pool' });
  const s4 = r.j.sched;
  hub.kill();
  await sleep(34000);
  hub = startHub();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  const list = await scheds();
  const s4b = list.find((x) => x.id === s4.id);
  ok(!!s4b && s4b.enabled === false, '错过的一次性任务自动停用');
  ok(/错过/.test(s4b.note || ''), '标了错过原因');
  const st3 = await api('/api/state');
  ok(!st3.j.tasks.some((x) => x.prompt === '不该出现的活'), '没补发');
  ok(list.some((x) => x.id === s2.id), '其他定时任务重启后还在');
  const s2d = list.find((x) => x.id === s2.id);
  ok(s2d.nextRun > Date.now(), '重启后 nextRun 顺到未来');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
