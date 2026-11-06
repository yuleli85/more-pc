// 用 jsdom 真跑页面：会话选择器（选会话、锁定目录、发出去带会话、从详情续接）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8795, KEY = 'test-key-ui-sess';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-sess');
fs.rmSync(DATA, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'hub.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
async function api(p, opt = {}) {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const poll = (name) => api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name, os: 'win32', host: name, agentVersion: '1.10.0', cli: 'x', workdir: 'C:\\w', cpu: 5 }) });
const create = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.j);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }

  // 造一条「跑完的会话」：先派活、让假连接程序领走、回报结果时带上会话 id
  await poll('UI-S').catch(() => {});
  const j1 = await create({ mode: 'all', prompt: '已完成的活：整理桌面文件', targets: ['UI-S'], workdir: 'C:\\work\\demo' });
  const got = await poll('UI-S').catch(() => ({ j: {} }));
  const job = got.j && got.j.job;
  assert.ok(job, '假连接程序要领到活');
  await api('/api/agent/events', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-S', jobId: job.id, done: true, ok: true, session: 'sess-ui-001', via: 'client', result: '整理好了', items: [{ t: 'text', s: '开始整理…' }] }),
  });
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const jar = { cookie: '' };
  let lastTaskBody = null;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/?key=${KEY}`, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (u, opt = {}) => {
        const h = { ...((opt && opt.headers) || {}) };
        if (jar.cookie) h.cookie = jar.cookie;
        const url = new URL(u, BASE);
        if (url.pathname === '/api/tasks' && opt.method === 'POST') { try { lastTaskBody = JSON.parse(opt.body); } catch {} }
        const r = await fetch(url, { ...opt, headers: h });
        const sc = r.headers.get('set-cookie');
        if (sc) jar.cookie = sc.split(';')[0];
        return r;
      };
      win.confirm = () => true;
      win.alert = () => {};
      win.scrollTo = () => {};
      win.document.execCommand = () => true;
    },
  });
  const w = dom.window, doc = w.document;
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(2500);

  console.log('\n[1] 默认是新会话');
  ok(doc.querySelector('#sessChip').textContent.trim() === '新会话', '状态显示「新会话」');
  ok(doc.querySelector('#workdir').disabled === false, '目录框可以填');
  ok(doc.querySelector('#sessClear').style.display === 'none', '没有「改回新会话」按钮');

  console.log('\n[2] 打开会话列表');
  click(doc.querySelector('#sessPick'));
  await sleep(900);
  ok(doc.querySelector('#sessModal').style.display === 'flex', '弹层打开了');
  const rows = doc.querySelectorAll('#sessList [data-i]');
  ok(rows.length === 1, '列出 1 条会话');
  ok(/UI-S/.test(rows[0].textContent) && /整理桌面文件/.test(rows[0].textContent), '列表里带着机器和任务摘要');

  console.log('\n[3] 选中一条：锁机器、锁目录');
  click(rows[0]);
  await sleep(200);
  ok(doc.querySelector('#sessModal').style.display === 'none', '选完自动关掉弹层');
  ok(/UI-S/.test(doc.querySelector('#sessChip').textContent), '状态栏显示选中的会话');
  ok(doc.querySelector('#workdir').disabled === true, '目录框被锁住');
  ok(doc.querySelector('#workdir').value === 'C:\\work\\demo', '目录自动填成会话的目录');
  ok(doc.querySelector('#sessClear').style.display !== 'none', '出现「改回新会话」');

  console.log('\n[4] 发出去：带上会话与机器');
  doc.querySelector('#prompt').value = '接着刚才的活继续说';
  click(doc.querySelector('#sendBtn'));
  await sleep(1500);
  ok(!!lastTaskBody, '确实发出了请求');
  ok(lastTaskBody.session === 'sess-ui-001', '请求里带着会话 id');
  ok(lastTaskBody.sessionMachine === 'UI-S', '请求里带着机器名');
  ok(lastTaskBody.split === false, '接会话时不会勾「每行算一件活」');

  console.log('\n[5] 改回新会话');
  click(doc.querySelector('#sessClear'));
  await sleep(150);
  ok(doc.querySelector('#sessChip').textContent.trim() === '新会话', '恢复成新会话');
  ok(doc.querySelector('#workdir').disabled === false, '目录框解锁');

  console.log('\n[6] 从任务详情续接');
  const row = [...doc.querySelectorAll('#tlist .task')].find((el) => /整理桌面文件/.test(el.textContent));
  ok(!!row, '任务列表里能找到那条跑完的活');
  click(row);
  await sleep(1400);
  const btn = doc.querySelector('[data-csess]');
  ok(!!btn, '详情里每台卡片有「接着这条会话」');
  ok(/sess-ui-001/.test(doc.querySelector('#detail').textContent), '详情里能看到会话 id');
  click(btn);
  await sleep(200);
  ok(/UI-S/.test(doc.querySelector('#sessChip').textContent), '点了之后状态栏切到那条会话');
  ok(doc.querySelector('#workdir').disabled === true, '目录跟着会话锁住');

  ok(errs.length === 0, '页面没有运行时错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log(`\n会话页测试全部通过：${pass} 项\n`);
  w.close(); hub.kill(); process.exit(0);
})().catch((e) => { console.error('\n' + (e && e.message || e) + '\n'); hub.kill(); process.exit(1); });
