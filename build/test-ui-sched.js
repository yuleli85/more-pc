// jsdom 真跑页面：定时任务页（页签切换、新建、列表渲染、启停、立即跑、删除、任务列表打「定时」标）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8808, KEY = 'test-key-ui-sched';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-sched');
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
  await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: 'UI-S', os: 'win32', host: 'UI-S', agentVersion: '1.10.1', cli: 'x', workdir: 'C:\\w', cpu: 4 }) });
  await api('/api/scheds', { method: 'POST', body: JSON.stringify({ name: '盯构建', prompt: '看看构建挂了没', kind: 'daily', at: '08:30', mode: 'pool', targets: ['UI-S'] }) });
  await api('/api/scheds', { method: 'POST', body: JSON.stringify({ name: '停用的', prompt: '不会跑的活', kind: 'interval', everyMin: 30, mode: 'pool', enabled: false }) });
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const alerts = [];
  const jar = { cookie: '' };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/?key=${KEY}#scheds`, pretendToBeVisual: true, virtualConsole: vc,
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
    },
  });
  const w = dom.window, doc = w.document;
  await sleep(2500);

  console.log('\n[1] 进页面就在定时页');
  ok(errs.length === 0, '没有 jsdom 报错' + (errs.length ? '：' + errs[0] : ''));
  ok(doc.querySelector('#viewScheds') && doc.querySelector('#viewScheds').style.display !== 'none', '定时页可见');
  ok(doc.querySelector('.tabs button[data-view=scheds]').classList.contains('on'), '页签高亮');
  ok(doc.querySelector('#crumbNow').textContent === '定时任务', '面包屑跟着换');

  console.log('\n[2] 列表渲染');
  await sleep(400);
  const rows = [...doc.querySelectorAll('#slist .pm')];
  ok(rows.length === 2, '两条都显示（2 条）' + rows.length);
  ok(doc.querySelector('#slist').textContent.includes('盯构建'), '名称在');
  ok(doc.querySelector('#slist').textContent.includes('每天 08:30'), '频率写出来了');
  ok(doc.querySelector('#slist').textContent.includes('下次'), '下次时间在');
  ok(doc.querySelector('#slist').textContent.includes('停用的') && doc.querySelector('#slist').textContent.includes('已停用'), '停用状态在');

  console.log('\n[3] 启停切换');
  const btns = [...doc.querySelectorAll('[data-stoggle]')];
  ok(btns.length === 2, '有启停按钮');
  btns[0].click();
  await sleep(600);
  const r1 = await api('/api/scheds');
  const a = r1.j.scheds.find((x) => x.name === '盯构建');
  ok(a.enabled === false && !a.nextRun, '点一下就停用了，nextRun 清零');
  [...doc.querySelectorAll('[data-stoggle]')][0].click();
  await sleep(600);
  const a2 = (await api('/api/scheds')).j.scheds.find((x) => x.name === '盯构建');
  ok(a2.enabled === true && a2.nextRun > Date.now(), '再点又启用了，nextRun 顺到未来');

  console.log('\n[4] 立即跑一次');
  [...doc.querySelectorAll('[data-srun]')][0].click();
  await sleep(800);
  const st = await api('/api/state');
  const t = st.j.tasks.find((x) => x.schedName === '盯构建');
  ok(!!t, '真发出去了一件');
  ok(t.prompt === '看看构建挂了没', '内容照存好的配置来');
  ok(doc.querySelector('#slist').textContent.includes('已发'), '列表标上「已发」');

  console.log('\n[5] 任务列表里这条带「定时」标');
  w.eval("setView('tasks')");
  await sleep(300);
  ok(doc.querySelector('#viewTasks').style.display !== 'none', '切回任务页');
  const tr = [...doc.querySelectorAll('#tlist .task')].find((x) => x.textContent.includes('看看构建挂了没'));
  ok(!!tr && tr.textContent.includes('定时'), '任务行有「定时」chip');

  console.log('\n[6] 新建弹窗');
  w.eval("setView('scheds')");
  await sleep(400);
  doc.querySelector('#sNew').click();
  const modal = doc.querySelector('#schedModal');
  ok(modal.style.display === 'flex', '弹窗开了');
  ok([...doc.querySelectorAll('.scday')].length === 7, '星期几有 7 个勾');
  ok([...doc.querySelectorAll('.sctg')].some((c) => c.value === 'UI-S'), '目标电脑列出了在线的');
  doc.querySelector('#scName').value = '新档';
  doc.querySelector('#scPrompt').value = '新档测试活';
  doc.querySelector('#scKind').value = 'weekly';
  doc.querySelector('#scKind').dispatchEvent(new w.Event('change'));
  ok(doc.querySelector('#scDaysWrap').style.display === 'none'.replace('none', '') || doc.querySelector('#scDaysWrap').style.display !== 'none', '每周时星期勾显示出来');
  doc.querySelector('.scday[value="3"]').checked = true;
  doc.querySelector('#scAt').value = '21:15';
  doc.querySelector('#scSave').click();
  await sleep(800);
  ok(modal.style.display === 'none', '保存后弹窗关了');
  const r2 = await api('/api/scheds');
  const nb = r2.j.scheds.find((x) => x.name === '新档');
  ok(!!nb && nb.kind === 'weekly' && nb.days.includes(3) && nb.at === '21:15', '新建的每周三 21:15 存对了');
  ok(nb.nextRun > Date.now(), 'nextRun 算出来了');
  ok(doc.querySelector('#slist').textContent.includes('新档'), '列表刷新出现新档');
  ok(doc.querySelector('#slist').textContent.includes('每周三 21:15'), '频率描述：每周三 21:15');

  console.log('\n[7] 校验错误回显在弹窗里');
  doc.querySelector('#sNew').click();
  doc.querySelector('#scPrompt').value = '';
  doc.querySelector('#scSave').click();
  await sleep(500);
  ok(doc.querySelector('#schedModal').style.display === 'flex', '没关弹窗（说明没存上）');
  ok(doc.querySelector('#scHint').textContent.includes('指令是空的'), '错误提示在弹窗里');
  ok(!(await api('/api/scheds')).j.scheds.some((x) => x.name === ''), '没有存进空档');
  doc.querySelector('#schedClose').click();

  console.log('\n[8] 删除');
  const delBtns = [...doc.querySelectorAll('[data-sdel]')];
  const firstId = delBtns[0].dataset.sdel;
  delBtns[0].click();
  await sleep(700);
  const r3 = await api('/api/scheds');
  ok(!r3.j.scheds.some((x) => x.id === firstId), '删掉了');
  ok(r3.j.scheds.length === 2, '剩 2 条');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
