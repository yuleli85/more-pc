// 用 jsdom 真跑一遍页面：勾选、批量删除、复制按钮
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8799, KEY = 'test-key-ui';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui');
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
const poll = (name, ms = 1500) => api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name, os: 'win32', host: name, agentVersion: '1.9.1', cli: 'x', workdir: 'C:\\w', cpu: 5 }) });
const create = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.j);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }

  // 造数据：一台机器 + 3 件任务（1 件已跑完、1 件排着、1 件没派出去）
  await poll('UI-A', 800).catch(() => {});
  const j1 = await create({ mode: 'pool', prompt: '已完成的活：整理桌面文件', targets: ['UI-A'] });
  await sleep(250);
  const got = await poll('UI-A', 4000).catch(() => ({ j: {} }));
  assert.ok(got.j && got.j.job, '假连接程序要领到活');
  await api('/api/agent/events', { method: 'POST', body: JSON.stringify({ name: 'UI-A', jobId: got.j.job.id, done: true, ok: true, result: '整理好了，共 12 个文件：\n1. 发票.pdf\n2. 合同.docx', items: [{ t: 'text', s: '开始整理桌面文件…' }] }) });
  await sleep(300);
  const j2 = await create({ mode: 'pool', prompt: '排着的活：写周报', targets: ['UI-A'] });
  await sleep(300);
  console.log('\n[1] 页面加载');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const alerts = [], copied = [];
  const jar = { cookie: '' }; // 页面靠 Cookie 认登录状态，得手工存
  // 页面脚本一解析就会跑 boot()，所以 fetch / alert 必须在 beforeParse 里就位
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
      win.alert = (m) => alerts.push(String(m));
      win.document.execCommand = () => { const ta = win.document.querySelector('textarea[readonly]'); if (ta) copied.push(ta.value); return true; };
    },
  });
  const w = dom.window, doc = w.document;

  await sleep(2500);
  ok(doc.querySelectorAll('#tlist .task').length === 2, '任务列表渲染出 2 条');
  ok(doc.querySelectorAll('#tlist .tpick').length === 2, '每条前面有勾选框');
  ok(!!doc.querySelector('#tDel') && doc.querySelector('#tDel').disabled === true, '没勾时「删除选中」不可点');
  ok(/共 2 件/.test(doc.querySelector('#tcount').textContent), '标题显示件数');

  console.log('\n[2] 勾选与「选中已结束」');
  doc.querySelector('#tPickDone').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  const del = doc.querySelector('#tDel');
  ok(del.disabled === false && /删除选中 1/.test(del.textContent), '只勾上已完成的那 1 件');
  ok(doc.querySelectorAll('#tlist .task.pick').length === 1, '勾中的那条有高亮');
  doc.querySelector('#tPickNone').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(doc.querySelector('#tDel').disabled === true, '「清除」后按钮又变灰');

  console.log('\n[3] 单条删除按钮');
  const one = doc.querySelector('#tlist [data-del]');
  const rowId = doc.querySelector('#tlist .task').dataset.id;
  one.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(1200);
  ok(doc.querySelectorAll('#tlist .task').length === 1, '点「删」后少了一条');
  ok(!doc.querySelector(`#tlist .task[data-id="${rowId}"]`), '删掉的正是点的那条');

  console.log('\n[4] 详情页复制');
  doc.querySelector('#tlist .task').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(1200);
  ok(!!doc.querySelector('#copyAll'), '详情有「复制全部结果」');
  const cbtn = doc.querySelector('[data-cres]');
  ok(!!cbtn, '每台卡片有「复制结果」');
  ok(!!doc.querySelector('.result'), '结果区显示了执行结果');
  copied.length = 0;
  cbtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(copied.length === 1 && /发票\.pdf/.test(copied[0]), '复制到的正是那台的执行结果');
  ok(cbtn.textContent === '已复制', '按钮变成「已复制」');

  copied.length = 0;
  doc.querySelector('#copyAll').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(copied.length === 1 && /任务：/.test(copied[0]) && /UI-A/.test(copied[0]), '全部结果带任务抬头和机器名');

  ok(errs.length === 0, '页面没有运行时错误' + (errs.length ? '：' + errs.join(' | ') : ''));

  console.log(`\n页面测试全部通过：${pass} 项\n`);
  w.close(); hub.kill(); process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
