// jsdom 真跑页面：交付文件的展示（文件清单、看内容、复制、下载、无结果时的提示）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8822, KEY = 'test-key-ui-result';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-result');
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

  console.log('\n[1] 造两条任务：一条有交付文件，一条没结果');
  await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: 'UI-R', os: 'win32', host: 'UI-R', agentVersion: '1.11.1', cli: 'x', workdir: 'C:\\w', cpu: 3 }) });
  const t1 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: '有交付的任务', targets: ['UI-R'] }) });
  const t2 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: '没结果的任务', targets: ['UI-R'] }) });
  ok(t1.status === 200 && t2.status === 200, '两条都派出去了');
  // 模拟连接程序把结果交回来（走真实的 events 接口，不改文件）
  const done = (id, body) => api('/api/agent/events', { method: 'POST', body: JSON.stringify({ name: 'UI-R', jobId: id, items: [], done: true, ...body }) });
  await done(t1.j.ids[0], {
    ok: true, result: '干完了，报告在下面', via: 'client',
    files: [
      { p: 'E:/proj/报告.md', size: 120, text: '# 交付报告\n\n内容在这里。' },
      { p: 'E:/proj/data/结果.json', size: 30, text: '{"ok":true}' },
      { p: 'E:/proj/大文件.bin', size: 999999, text: '' },
    ],
  });
  await done(t2.j.ids[0], { ok: true, result: '', via: 'client' });
  await sleep(600);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const alerts = [];
  const jar = { cookie: '' };
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
      win.scrollTo = () => {};
      win.URL.createObjectURL = () => 'blob:fake';
      win.URL.revokeObjectURL = () => {};
      win.Blob = class { constructor(parts) { this.parts = parts; } };
      win.HTMLAnchorElement.prototype.click = function () { this.__clicked = true; };
    },
  });
  const w = dom.window, doc = w.document;
  await sleep(2500);

  console.log('\n[2] 任务列表能看出有没有结果');
  const rows = [...doc.querySelectorAll('#tlist .task')];
  ok(rows.length >= 2, '任务都显示（' + rows.length + '）');
  const withFiles = rows.find((x) => x.textContent.includes('有交付的任务'));
  const noResult = rows.find((x) => x.textContent.includes('没结果的任务'));
  ok(withFiles && withFiles.textContent.includes('完成'), '有结果的任务标「完成」');
  ok(noResult && noResult.textContent.includes('无结果'), '没结果的标「完成·无结果」（实际：' + (noResult && noResult.textContent.match(/完成\S*/)) + '）');

  console.log('\n[3] 双击看结果：交付文件清单');
  w.eval(`openResult('${t1.j.ids[0]}')`);
  await sleep(900);
  const fb = doc.querySelector('.rfiles');
  ok(!!fb, '有交付文件区');
  ok(fb && fb.textContent.includes('交付文件 3 个'), '写了 3 个文件');
  ok(fb && fb.textContent.includes('报告.md'), '列出了 报告.md');
  ok(fb && fb.textContent.includes('结果.json'), '列出了 结果.json');
  ok(fb && fb.textContent.includes('大文件.bin'), '列出了 大文件.bin');

  console.log('\n[4] 小文件能看内容 / 复制 / 下载');
  ok(doc.querySelectorAll('[data-fview]').length === 2, '两个小文件有「看内容」按钮（实际 ' + doc.querySelectorAll('[data-fview]').length + '）');
  ok(doc.querySelectorAll('[data-fcopy]').length === 2, '两个小文件有「复制」按钮');
  ok(doc.querySelectorAll('[data-fdl]').length === 2, '两个小文件有「下载」按钮');
  const viewBtn = doc.querySelector('[data-fview]');
  viewBtn.click();
  await sleep(200);
  const prev = doc.querySelector('[data-fprev]');
  ok(prev && prev.style.display !== 'none', '点「看内容」展开预览');
  ok(prev && prev.textContent.includes('交付报告'), '预览里有文件内容');

  console.log('\n[5] 大文件没有内容按钮，只说去哪看');
  const big = [...doc.querySelectorAll('.rfiles li')].find((x) => x.textContent.includes('大文件.bin'));
  ok(big && !big.querySelector('[data-fview]'), '大文件没有「看内容」');
  ok(big && big.textContent.includes('去那台电脑上看'), '提示了去哪看');

  console.log('\n[6] 结果正文也在');
  ok(doc.querySelector('#resBox').textContent.includes('干完了，报告在下面'), '显示了这台的答复');

  console.log('\n[7] 没结果的任务：给的是能落地的提示，不是「没有输出」');
  w.eval(`openResult('${t2.j.ids[0]}')`);
  await sleep(900);
  const txt = doc.querySelector('#resBox').textContent;
  ok(txt.includes('WorkBuddy'), '提示了去哪看（' + txt.slice(txt.indexOf('（这台'), txt.indexOf('（这台') + 60) + '）');
  ok(!txt.includes('（没有输出）'), '不再只写「没有输出」');

  console.log('\n[8] 详情页也有文件清单');
  w.eval(`selTask='${t1.j.ids[0]}'; detail=null; renderTasks(); loadDetail();`);
  await sleep(1200);
  ok(doc.querySelector('#detail .rfiles'), '详情页有交付文件区');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
