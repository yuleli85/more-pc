// jsdom 真跑页面：提示词页（切换、搜索、复制、展开、拿去用、删除）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8801, KEY = 'test-key-ui-prompt';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-prompt');
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
const create = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.j);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: 'UI-P', os: 'win32', host: 'UI-P', agentVersion: '1.9.1', cli: 'x', workdir: 'C:\\w', cpu: 4 }) });
  await create({ mode: 'pool', prompt: '把桌面上的发票按月份整理好，列个清单', targets: ['UI-P'], expert: 'senior-developer', workdir: 'C:\\work\\demo' });
  await create({ mode: 'all', prompt: '检查一下 dev 分支的构建有没有挂', targets: ['UI-P'], model: 'deepseek-v4.1-flash' });
  await create({ mode: 'pool', prompt: '很长的提示词\r\n'.concat('这是一段比较长的说明，用来验证折叠。'.repeat(20)), targets: ['UI-P'] });
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const copied = [], alerts = [];
  const jar = { cookie: '' }; // 页面靠 Cookie 认登录状态，得手工存
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
      win.scrollTo = () => {}; // jsdom 没实现，页面里「拿去用」会滚到顶
      win.document.execCommand = () => { const ta = win.document.querySelector('textarea[readonly]'); if (ta) copied.push(ta.value); return true; };
    },
  });
  const w = dom.window, doc = w.document;
  await sleep(2200);

  console.log('\n[1] 切到提示词页');
  ok(doc.querySelector('#viewPrompts').style.display === 'none', '一开始提示词页是藏着的');
  const tab = doc.querySelector('.tabs button[data-view="prompts"]');
  ok(!!tab, '顶部有「提示词」页签');
  tab.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  ok(doc.querySelector('#viewPrompts').style.display === '' && doc.querySelector('#viewTasks').style.display === 'none', '切过去后只看提示词页');
  ok(tab.classList.contains('on'), '页签高亮');
  const items = doc.querySelectorAll('#plist .pm');
  ok(items.length === 3, '列出 3 条提示词');
  ok(/共 3 条/.test(doc.querySelector('#pcount').textContent), '标题显示条数');
  const meta = items[0].querySelector('.meta').textContent;
  ok(/派给空闲的/.test(meta), '标了派法');
  ok(/专家 高级开发工程师/.test(items[2].querySelector('.meta').textContent), '老的标了专家名');
  ok(/目录 C:\\work\\demo/.test(items[2].querySelector('.meta').textContent), '标了目录');

  console.log('\n[2] 搜索');
  const search = doc.querySelector('#pSearch');
  search.value = '发票';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(100);
  ok(doc.querySelectorAll('#plist .pm').length === 1, '搜「发票」只剩 1 条');
  ok(/匹配 1 条/.test(doc.querySelector('#pcount').textContent), '标题显示匹配数');
  search.value = '不存在的关键词xyz';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(100);
  ok(/没有匹配/.test(doc.querySelector('#plist').textContent), '搜不到时给提示');
  search.value = '';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(100);
  ok(doc.querySelectorAll('#plist .pm').length === 3, '清空搜索后恢复 3 条');

  console.log('\n[3] 复制 / 展开');
  const first = doc.querySelector('#plist .pm');
  copied.length = 0;
  first.querySelector('[data-pcopy]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  ok(copied.length === 1 && /这是一段比较长的说明/.test(copied[0]), '复制到的是这条提示词全文');
  ok(first.querySelector('[data-pcopy]').textContent === '已复制', '按钮变「已复制」');

  const more = first.querySelector('[data-pmore]');
  ok(!!more, '长提示词有「展开」');
  ok(first.querySelector('.ptext').classList.contains('clamp'), '默认是折叠的');
  more.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  ok(!first.querySelector('.ptext').classList.contains('clamp') && more.textContent === '收起', '点展开后不再截断');

  console.log('\n[4] 拿去用');
  const item2 = doc.querySelectorAll('#plist .pm')[2]; // 最早那条（带专家/目录）
  item2.querySelector('[data-puse]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(150);
  ok(doc.querySelector('#viewTasks').style.display === '' && doc.querySelector('#viewPrompts').style.display === 'none', '回到任务页');
  ok(doc.querySelector('#prompt').value === '把桌面上的发票按月份整理好，列个清单', '提示词填进了发任务框');
  ok(doc.querySelector('#workdir').value === 'C:\\work\\demo', '目录也一起填了');
  ok(doc.querySelector('#expert').value === 'senior-developer', '专家也一起选了');

  console.log('\n[5] 勾选 + 删除选中');
  doc.querySelector('.tabs button[data-view="prompts"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  const cb = doc.querySelector('#plist .ppick');
  cb.click();
  await sleep(80);
  const del = doc.querySelector('#pDel');
  ok(del.disabled === false && /删除选中 1/.test(del.textContent), '勾一条后按钮可点');
  del.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(900);
  ok(doc.querySelectorAll('#plist .pm').length === 2, '删掉后剩 2 条');
  ok(/共 2 条/.test(doc.querySelector('#pcount').textContent), '条数也跟着变了');

  ok(errs.length === 0, '页面没有运行时错误' + (errs.length ? '：' + errs.join(' | ') : ''));
  console.log(`\n提示词页测试全部通过：${pass} 项\n`);
  w.close(); hub.kill(); process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
