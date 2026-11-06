// 隔离测试：会话续接（run 记会话 id、会话列表、接会话派发、机器/目录锁定、版本门槛）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8797, KEY = 'test-key-sess';
const DATA = path.join(__dirname, 'testdata-sess');
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
  try {
    const r = await fetch(B + p, { ...opt, signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  } finally { clearTimeout(timer); }
}
const poll = (name, ver = '1.10.0') => api('/api/agent/poll', {
  method: 'POST', timeout: 32000,
  body: JSON.stringify({ name, os: 'win32', host: name, agentVersion: ver, cli: 'x', workdir: 'C:\\w', cpu: 5, running: null }),
});
const state = async () => (await api('/api/state')).j;
const create = async (body) => await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
const events = (name, jobId, extra) => api('/api/agent/events', {
  method: 'POST',
  body: JSON.stringify({ name, jobId, items: [], ...extra }),
});

(async () => {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/healthz'); if (r.ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 两台电脑上线（一新一旧）');
  await Promise.all([poll('TEST-A'), poll('TEST-B', '1.9.1')]);
  let st = await state();
  ok(st.machines.length === 2, '两台已注册');
  ok(st.meta.agentSessionMin === '1.10.1', 'meta 带上会话最低版本');

  console.log('\n[2] 普通任务：不下发会话');
  const t1 = await create({ mode: 'all', prompt: '第一件活', targets: ['TEST-A'] });
  ok(t1.status === 200 && t1.j.ids.length === 1, '任务已建');
  ok(t1.j.session === '' || t1.j.session === undefined, '任务本身没有会话');
  const j1 = await poll('TEST-A').catch(() => ({ j: {} }));
  ok(j1.j && j1.j.job && j1.j.job.session === '', '老任务下发的 job.session 为空');

  console.log('\n[3] 跑完把会话 id 记下来（客户端通道 / 命令行通道都记）');
  await events('TEST-A', t1.j.ids[0], { session: 'sess-client-001', via: 'client', done: true, ok: true, result: '做完了' });
  st = await state();
  let run = st.tasks.find((t) => t.id === t1.j.ids[0]).runs['TEST-A'];
  ok(run.session === 'sess-client-001', '客户端的会话 id 落到 run 上');
  ok(run.via === 'client', '标出了走的哪条通道');

  const t2 = await create({ mode: 'all', prompt: '第二件活', targets: ['TEST-B'] });
  const j2 = await poll('TEST-B', '1.9.1').catch(() => ({ j: {} }));
  ok(j2.j && j2.j.job && j2.j.job.id === t2.j.ids[0], 'TEST-B 领到活');
  await events('TEST-B', t2.j.ids[0], { session: 'sess-cli-002', via: 'cli', done: true, ok: true, result: '命令行跑完' });

  console.log('\n[4] 会话列表');
  let list = (await api('/api/sessions')).j;
  ok(list.total === 2, '两条会话都在');
  ok(list.sessions[0].session === 'sess-cli-002', '按时间倒序，最新的在前');
  const one = list.sessions.find((x) => x.session === 'sess-client-001');
  ok(one.machine === 'TEST-A' && one.prompt === '第一件活', '会话带着机器和任务摘要');
  ok((await api('/api/sessions?q=第二件')).j.total === 1, '按关键字过滤');
  ok((await api('/api/sessions?machine=TEST-A')).j.total === 1, '按机器过滤');

  console.log('\n[5] 接会话：只派那台、目录跟着会话锁死');
  await events('TEST-A', t1.j.ids[0], { session: 'sess-client-001', done: false });
  const t3 = await create({ mode: 'pool', prompt: '接着刚才那条继续', session: 'sess-client-001', targets: ['TEST-A', 'TEST-B'], workdir: 'C:\\别的地方' });
  ok(t3.status === 200, '接会话的任务能建');
  st = await state();
  const task3 = st.tasks.find((t) => t.id === t3.j.ids[0]);
  ok(Object.keys(task3.runs).length === 1 && task3.runs['TEST-A'], '只派给会话所在的那台');
  ok(task3.mode === 'all', '强制成单台模式，不会被别的机器抢走');
  ok(task3.session === 'sess-client-001', '任务记着接哪条会话');
  ok(task3.sessionMachine === 'TEST-A', '记着是哪台的会话');
  ok(task3.workdir === run.dir || task3.workdir === '', '目录被会话锁住，没采用乱填的路径');

  const j3 = await poll('TEST-A').catch(() => ({ j: {} }));
  ok(j3.j && j3.j.job && j3.j.job.session === 'sess-client-001', '下发的 job 带上了会话 id');

  console.log('\n[6] 边界');
  ok((await create({ mode: 'all', prompt: 'x', session: 'bad session!', targets: ['TEST-A'] })).status === 400, '会话 id 格式不对 → 400');
  ok((await create({ mode: 'pool', prompt: 'a\nb', split: true, session: 'sess-client-001', targets: ['TEST-A'] })).status === 400, '接会话 + 每行一件活 → 400');
  ok((await create({ mode: 'all', prompt: 'x', session: 'sess-client-001', sessionMachine: 'NOBODY' })).status === 400, '指定不存在的机器 → 400');
  const t4 = await create({ mode: 'all', prompt: '不写机器也认', session: 'sess-cli-002' });
  ok(t4.status === 200, '不写机器时按会话记录自动认出机器');
  st = await state();
  ok(st.tasks.find((t) => t.id === t4.j.ids[0]).sessionMachine === 'TEST-B', '自动认出是 TEST-B');

  console.log('\n[7] 老连接程序：不拒单，只提醒');
  const t5 = await create({ mode: 'all', prompt: '老机器接会话', session: 'sess-cli-002', sessionMachine: 'TEST-B' });
  ok(t5.status === 200, '老版本也照常建');
  ok(/还不支持接会话/.test(t5.j.warn || ''), '给出升级提醒');

  console.log('\n[8] 同一条会话跑多次：列表里只留最新那条');
  const t6 = await create({ mode: 'all', prompt: '同会话第三轮', targets: ['TEST-A'] });
  await poll('TEST-A').catch(() => {});
  await events('TEST-A', t6.j.ids[0], { session: 'sess-client-001', via: 'cli', done: true, ok: true, result: 'ok' });
  list = (await api('/api/sessions')).j;
  ok(list.sessions.filter((x) => x.session === 'sess-client-001').length === 1, '同一条会话只出现一次');
  ok(list.sessions.find((x) => x.session === 'sess-client-001').taskId === t6.j.ids[0], '留下的是最新那次的记录');

  console.log('\n[9] 页面上有入口');
  const page = await (await fetch(`${B}/?key=${KEY}`)).text();
  for (const [k, v] of [['sessChip', '会话状态'], ['sessPick', '选会话按钮'], ['sessModal', '会话选择弹层'], ['sessList', '会话列表']]) {
    ok(page.includes(`id="${k}"`), '页面有 ' + v);
  }
  ok(/接着这条会话/.test(page), '详情里有「接着这条会话」');

  hub.kill();
  console.log(`\n全部通过：${pass} 项`);
  process.exit(0);
})().catch((e) => { console.error('\n' + (e && e.message || e)); hub.kill(); process.exit(1); });
