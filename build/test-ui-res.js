// 用 jsdom 真跑页面：双击任务看执行结果（弹窗、各台结果、复制、关闭）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8797, KEY = 'test-key-ui-res';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-res');
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
const poll = (name) => api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name, os: 'win32', host: name, agentVersion: '1.10.1', cli: 'x', workdir: 'C:\\w', cpu: 5 }) });
const create = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.j);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }

  // 造两条：一条跑成了、一条没成
  await poll('UI-R').catch(() => {});
  await create({ mode: 'all', prompt: '把桌面发票按月整理', targets: ['UI-R'], workdir: 'C:\\work\\demo' });
  const g1 = await poll('UI-R').catch(() => ({ j: {} }));
  const job1 = g1.j && g1.j.job;
  assert.ok(job1, '假连接程序要领到第一件活');
  await api('/api/agent/events', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-R', jobId: job1.id, done: true, ok: true, session: 'sess-res-001', via: 'client', result: '一共 37 张，已按月放进 发票/2026-01 … 发票/2026-09', items: [{ t: 'text', s: '开始整理…' }] }),
  });
  await sleep(200);
  await create({ mode: 'all', prompt: '跑测试的那个活', targets: ['UI-R'], workdir: 'C:\\work\\demo' });
  const g2 = await poll('UI-R').catch(() => ({ j: {} }));
  const job2 = g2.j && g2.j.job;
  assert.ok(job2, '假连接程序要领到第二件活');
  await api('/api/agent/events', {
    method: 'POST',
    body: JSON.stringify({ name: 'UI-R', jobId: job2.id, done: true, ok: false, error: '目录不存在：C:\\nope', via: 'cli' }),
  });
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const jar = { cookie: '' };
  const copied = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/?key=${KEY}`, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (u, opt = {}) => {
        const h = { ...((opt && opt.headers) || {}) };
        if (jar.cookie) h.cookie = jar.cookie;
        const r = await fetch(new URL(u, BASE), { ...opt, headers: h });
        const sc = r.headers.get('set-cookie');
        if (sc) jar.cookie = sc.split(';')[0];
        return r;
      };
      win.confirm = () => true;
      win.alert = () => {};
      win.scrollTo = () => {};
      win.document.execCommand = () => { const ta = win.document.querySelector('textarea[readonly]'); if (ta) copied.push(ta.value); return true; };
    },
  });
  const w = dom.window, doc = w.document;
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const dbl = (el) => el.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  await sleep(2500);

  const rows = () => [...doc.querySelectorAll('#tlist .task')];
  const rowOf = (kw) => rows().find((el) => el.textContent.includes(kw));
  ok(rows().length === 2, '任务列表里有两件活');

  console.log('\n[1] 双击跑成了的那件');
  const r1 = rowOf('把桌面发票按月整理');
  ok(!!r1, '找得到那条任务');
  dbl(r1);
  await sleep(1200);
  ok(doc.querySelector('#resModal').style.display === 'flex', '结果弹窗打开了');
  const box = doc.querySelector('#resBox');
  ok(/执行结果/.test(box.textContent), '标题写着执行结果');
  ok(/UI-R/.test(box.textContent), '写着是哪台电脑干的');
  ok(/一共 37 张/.test(box.textContent), '显示这台电脑的最终回答');
  ok(/完成/.test(box.textContent), '显示状态是完成');
  ok(/客户端跑的/.test(box.textContent), '标出这条是客户端跑的');
  ok(/C:\\work\\demo/.test(box.textContent), '显示干活目录');
  ok(/把桌面发票按月整理/.test(box.textContent), '弹窗里带着任务说明，知道这结果对应什么活');

  console.log('\n[2] 复制');
  const cBtn = box.querySelector('[data-rcopy]');
  ok(!!cBtn, '每台有「复制这台」');
  copied.length = 0;
  click(cBtn);
  await sleep(300);
  ok(copied.length === 1 && /一共 37 张/.test(copied[0]), '「复制这台」复制的是这台的结果');
  const allBtn = doc.querySelector('#resCopyAll');
  ok(!!allBtn, '底部有「复制全部结果」');
  copied.length = 0;
  click(allBtn);
  await sleep(300);
  ok(copied.length === 1, '点了一下复制一次');
  ok(/任务：把桌面发票按月整理/.test(copied[0]), '复制内容带任务抬头');
  ok(/──── UI-R · 完成/.test(copied[0]), '按电脑分段，带状态');

  console.log('\n[3] 关掉');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  ok(doc.querySelector('#resModal').style.display === 'none', 'Esc 能关掉');

  console.log('\n[4] 双击没成的那件');
  dbl(rowOf('跑测试的那个活'));
  await sleep(1200);
  ok(doc.querySelector('#resModal').style.display === 'flex', '弹窗又打开了');
  const b2 = doc.querySelector('#resBox');
  ok(/目录不存在/.test(b2.textContent), '显示报错原因，不是空白');
  ok(/没成/.test(b2.textContent), '状态是没成');
  ok(/命令行跑的/.test(b2.textContent), '标出这条是命令行跑的');
  click(doc.querySelector('#resModal')); // 点外面
  await sleep(200);
  ok(doc.querySelector('#resModal').style.display === 'none', '点外面能关掉');

  console.log('\n[5] 点按钮不该弹窗');
  dbl(rowOf('把桌面发票按月整理').querySelector('[data-copy]'));
  await sleep(400);
  ok(doc.querySelector('#resModal').style.display === 'none', '双击「复制」按钮不打开结果弹窗');

  ok(errs.length === 0, '页面没有运行时错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log(`\n双击看结果测试全部通过：${pass} 项\n`);
  w.close(); hub.kill(); process.exit(0);
})().catch((e) => { console.error('\n' + (e && e.message || e) + '\n'); hub.kill(); process.exit(1); });
