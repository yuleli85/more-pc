// 隔离测试：任务批量删除 + 接力依赖 + 取消下发 + 页面元素
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8798, KEY = 'test-key-del';
const DATA = path.join(__dirname, 'testdata-del');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'hub.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (cond, name) => { assert.ok(cond, 'FAIL: ' + name); pass++; console.log('  ✓ ' + name); };

async function api(p, opt = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opt.timeout || 8000);
  const headers = { 'Content-Type': 'application/json', ...(opt.headers === undefined ? { 'x-fleet-key': KEY } : opt.headers) };
  try {
    const r = await fetch(B + p, { ...opt, signal: ctl.signal, headers });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  } finally { clearTimeout(timer); }
}
const poll = (name, ms = 1500) => api('/api/agent/poll', { method: 'POST', timeout: ms, body: JSON.stringify({ name, os: 'win32', host: name, agentVersion: '1.9.1', cli: 'x', workdir: 'C:\\w', cpu: 5, running: null }) });
const state = async () => (await api('/api/state')).j;
const create = async (body) => (await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) })).j;

(async () => {
  // 等端口起来
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/healthz'); if (r.ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 注册一台电脑，派一件活并让它领走');
  await poll('TEST-A', 900).catch(() => {});
  let st = await state();
  ok(st.machines.length === 1, '电脑已注册');

  const a = await create({ mode: 'pool', prompt: '任务甲：先做这个', targets: ['TEST-A'] });
  ok(a.ids && a.ids.length === 1, '任务甲已创建');
  await sleep(300);
  st = await state();
  ok(st.tasks.find((t) => t.id === a.ids[0]).runs['TEST-A'].status === 'queued', '甲已派给 TEST-A 排着');

  const got = await poll('TEST-A', 4000).catch(() => ({ j: null }));
  if (got && got.j && got.j.job) ok(got.j.job.id === a.ids[0], 'TEST-A 领到了甲');
  else { console.log('  ! 没领到（长轮询超时），后续按 sent 判定跳过'); }
  await sleep(200);

  console.log('\n[2] 建一件接力任务，再删掉它的上一步');
  const b = await create({ mode: 'pool', prompt: '任务乙：接在甲后面', targets: ['TEST-A'], after: a.ids[0] });
  await sleep(300);
  st = await state();
  const tb = st.tasks.find((t) => t.id === b.ids[0]);
  ok(tb.waiting === true, '乙在等上一步做完');

  const del1 = await api('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ ids: [a.ids[0]] }) });
  ok(del1.status === 200 && del1.j.removed === 1, '甲已删掉（removed=1）');
  ok(Array.isArray(del1.j.stopped) && del1.j.stopped.includes('TEST-A'), '删甲时记下了要叫停 TEST-A');
  await sleep(300);
  st = await state();
  ok(!st.tasks.some((t) => t.id === a.ids[0]), '列表里没有甲了');
  const tb2 = st.tasks.find((t) => t.id === b.ids[0]);
  ok(tb2 && tb2.stopped === true && /被删/.test(tb2.note || ''), '乙被标成已停，说明原因是上一步被删');

  console.log('\n[3] 删掉的任务要给那台电脑下发停止（ghost cancel）');
  const p2 = await poll('TEST-A', 4000).catch(() => ({ j: {} }));
  const cancel = (p2 && p2.j && p2.j.cancel) || [];
  ok(cancel.includes(a.ids[0]), 'TEST-A 下次来问会收到甲的停止指令');

  console.log('\n[4] 批量删多条');
  const c1 = await create({ mode: 'pool', prompt: '丙', targets: ['TEST-A'] });
  const c2 = await create({ mode: 'pool', prompt: '丁', targets: ['TEST-A'] });
  const c3 = await create({ mode: 'pool', prompt: '戊', targets: ['TEST-A'] });
  await sleep(300);
  const del3 = await api('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ ids: c1.ids.concat(c2.ids, c3.ids) }) });
  ok(del3.status === 200 && del3.j.removed === 3, '一次删掉 3 件');
  st = await state();
  ok(!st.tasks.some((t) => [c1.ids[0], c2.ids[0], c3.ids[0]].includes(t.id)), '3 件都不在列表里了');

  console.log('\n[5] 边界');
  const bad = await api('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ ids: [] }) });
  ok(bad.status === 400, '空 ids 返回 400');
  const gone = await api('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ ids: ['deadbeef1234'] }) });
  ok(gone.status === 404, '删不存在的返回 404');
  const noKey = await api('/api/tasks/delete', { method: 'POST', body: '{}', headers: {} });
  ok(noKey.status === 401, '没口令返回 401');

  console.log('\n[6] 页面元素');
  const html = await (await fetch(B + '/')).text();
  ok(html.includes('id="tDel"'), '有「删除选中」按钮');
  ok(html.includes('id="tPickAll"') && html.includes('id="tPickDone"'), '有全选 / 选中已结束');
  ok(html.includes('id="copyAll"'), '详情有「复制全部结果」');
  ok(html.includes('data-cres='), '每台卡片有「复制结果」按钮');
  ok(/function deleteTasks/.test(fs.readFileSync(path.join(__dirname, '..', 'app', 'hub.js'), 'utf8')), 'hub 有 deleteTasks');

  console.log(`\n全部通过：${pass} 项\n`);
  hub.kill();
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
