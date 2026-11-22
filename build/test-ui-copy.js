// jsdom 真跑页面：执行结果复选 + 复制
// 覆盖：结果弹窗里勾几台 → 复制选中；任务列表勾几件 → 批量复制结果
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8827, KEY = 'test-key-copy';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-copy');
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

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 造三台电脑、几件任务');
  for (const n of ['PC-A', 'PC-B', 'PC-C']) {
    await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: n, os: 'win32', host: n, agentVersion: '1.11.3', cli: 'x', workdir: 'C:\\w', cpu: 3 }) });
  }
  // 第一件：3 台都有结果
  const t1 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'all', prompt: '第一件活', targets: ['PC-A', 'PC-B', 'PC-C'] }) });
  // 第二件：2 台有结果
  const t2 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'all', prompt: '第二件活', targets: ['PC-A', 'PC-B'] }) });
  ok(t1.status === 200 && t2.status === 200, '两件都派出去了');
  const done = (id, body) => api('/api/agent/events', { method: 'POST', body: JSON.stringify({ name: body.name, jobId: id, items: [], done: true, ok: true, ...body }) });
  await done(t1.j.ids[0], { name: 'PC-A', result: 'A的结果内容', via: 'cli' });
  await done(t1.j.ids[0], { name: 'PC-B', result: 'B的结果内容', via: 'cli' });
  await done(t1.j.ids[0], { name: 'PC-C', result: 'C的结果内容', via: 'cli' });
  await done(t2.j.ids[0], { name: 'PC-A', result: '第二件的A结果', via: 'cli' });
  await done(t2.j.ids[0], { name: 'PC-B', result: '第二件的B结果', via: 'cli' });
  await sleep(400);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const alerts = [];
  const copied = []; // 记录复制出去的内容
  const jar = { cookie: '' };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/?key=${KEY}`, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (u, opt = {}) => {
        const h = { ...((opt && opt.headers) || {}) };
        if (jar.cookie) h.cookie = jar.cookie;
        const r = await fetch(new URL(u, BASE), { ...opt, headers: h });
        const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
        return r;
      };
      win.confirm = () => true;
      win.alert = (m) => alerts.push(String(m));
      win.scrollTo = () => {};
      // 拦截复制：把内容记下来
      win.document.execCommand = () => true;
      win.navigator.clipboard = { writeText: (t) => { copied.push(String(t)); return Promise.resolve(); } };
      Object.defineProperty(win, 'isSecureContext', { value: true });
    },
  });
  const w = dom.window, doc = w.document;
  // 记录 textarea 方式的复制（http 下走这条路）
  const origExec = w.document.execCommand;
  w.document.execCommand = function (cmd) { if (cmd === 'copy') { const ta = doc.querySelector('textarea[readonly]'); if (ta) copied.push(ta.value); } return true; };
  await sleep(2500);

  console.log('\n[2] 结果弹窗里能勾选各台');
  await w.eval(`openResult('${t1.j.ids[0]}')`);
  await sleep(1200);
  const picks = doc.querySelectorAll('#resBox .rpick');
  ok(picks.length === 3, '三台都有复选框（实际 ' + picks.length + '）');
  ok(!!doc.querySelector('#resCopyPicked'), '有「复制选中」按钮');
  ok(!!doc.querySelector('#resPickAll'), '有「全选」按钮');
  const cpBtn = doc.querySelector('#resCopyPicked');
  ok(cpBtn.disabled, '没勾时「复制选中」是禁用的');

  console.log('\n[3] 勾两台 → 复制选中');
  const cbB = doc.querySelector('[data-rp="PC-B"]');
  cbB.checked = true; cbB.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(400);
  const cbC = doc.querySelector('[data-rp="PC-C"]');
  cbC.checked = true; cbC.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(400);
  const cp2 = doc.querySelector('#resCopyPicked');
  ok(cp2 && !cp2.disabled, '勾了之后按钮可点了');
  ok(cp2 && cp2.textContent.includes('2'), '按钮上写了数量：' + (cp2 && cp2.textContent.trim()));
  ok(!!doc.querySelector('.rblk.rpicked'), '勾中的那块有高亮');
  copied.length = 0;
  cp2.click();
  await sleep(600);
  ok(copied.length === 1, '复制了一次');
  const txt = copied[0] || '';
  ok(txt.includes('B的结果内容'), '含 B 的结果');
  ok(txt.includes('C的结果内容'), '含 C 的结果');
  ok(!txt.includes('A的结果内容'), '不含 A 的结果（没勾的不能混进去）');
  ok(txt.includes('第一件活'), '含任务说明');
  ok(txt.includes('PC-B') && txt.includes('PC-C'), '含机器名');

  console.log('\n[4] 全选 / 取消全选');
  await w.eval(`document.querySelector('#resPickAll').click()`);
  await sleep(400);
  ok(doc.querySelectorAll('.rblk.rpicked').length === 3, '全选了 3 台');
  await w.eval(`document.querySelector('#resPickAll').click()`);
  await sleep(400);
  ok(doc.querySelectorAll('.rblk.rpicked').length === 0, '又取消了');

  console.log('\n[5] 复制全部结果（老的按钮还在）');
  copied.length = 0;
  doc.querySelector('#resCopyAll').click();
  await sleep(500);
  ok(copied.length === 1, '复制了一次');
  ok((copied[0] || '').includes('A的结果内容'), '全部结果里有 A');

  console.log('\n[6] 任务列表勾选 → 批量复制结果');
  await w.eval(`closeResult && closeResult()`);
  await sleep(300);
  const cbs = doc.querySelectorAll('#tlist .tpick');
  ok(cbs.length >= 2, '列表有复选框（' + cbs.length + '）');
  const copySel = doc.querySelector('#tCopySel');
  ok(!!copySel, '有「复制选中结果」按钮');
  ok(copySel.disabled, '没勾时禁用');
  cbs[0].click();
  await sleep(300);
  cbs[1].click();
  await sleep(300);
  const cs2 = doc.querySelector('#tCopySel');
  ok(cs2 && !cs2.disabled, '勾了之后可点');
  ok(cs2 && cs2.textContent.includes('2'), '按钮上有数量：' + (cs2 && cs2.textContent.trim()));
  copied.length = 0;
  cs2.click();
  await sleep(1500);
  ok(copied.length === 1, '复制了一次');
  const txt2 = copied[0] || '';
  ok(txt2.includes('第一件活') && txt2.includes('第二件活'), '两件任务的说明都有');
  ok(txt2.includes('A的结果内容'), '含第一件的结果');
  ok(txt2.includes('第二件的B结果'), '含第二件的结果');
  ok(txt2.includes('══ 任务'), '有分隔线');
  ok(alerts.length === 0, '没弹出报错' + (alerts.length ? '：' + alerts[0] : ''));

  console.log('\n[7] 取消勾选后按钮回到禁用');
  await w.eval(`document.querySelector('#tPickNone').click()`);
  await sleep(300);
  ok(doc.querySelector('#tCopySel').disabled, '又禁用了');

  console.log('\n[8] 交付文件也带上（路径）');
  await api('/api/agent/events', { method: 'POST', body: JSON.stringify({ name: 'PC-A', jobId: t2.j.ids[0], items: [], done: true, ok: true, result: '带文件的结果', files: [{ p: 'E:/x/报告.md', size: 10, text: '内容' }] }) });
  await sleep(400);
  await w.eval(`openResult('${t2.j.ids[0]}')`);
  await sleep(1000);
  copied.length = 0;
  doc.querySelector('#resCopyAll').click();
  await sleep(500);
  ok((copied[0] || '').includes('报告.md'), '结果里带上了交付文件路径');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
