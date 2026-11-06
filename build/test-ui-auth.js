// jsdom 真跑页面：登录页 / 输口令 / 老书签自动登录 / 退出
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8803, KEY = 'machine-key-ui';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-auth');
fs.rmSync(DATA, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'hub.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

// 每个 JSDOM 自己带一份 cookie 罐子（node 的 fetch 不会存 cookie）
function makeDom(url) {
  const jar = { cookie: '' }, errs = [], alerts = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errs.push(String((e && e.message) || e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = async (u, opt = {}) => {
        const headers = { ...(opt.headers || {}) };
        if (jar.cookie) headers.cookie = jar.cookie;
        const r = await fetch(new URL(u, BASE), { ...opt, headers });
        const sc = r.headers.get('set-cookie');
        if (sc) jar.cookie = sc.split(';')[0];
        return r;
      };
      win.confirm = () => true;
      win.alert = (m) => alerts.push(String(m));
      win.scrollTo = () => {};
      win.document.execCommand = () => true;
    },
  });
  return { dom, w: dom.window, doc: dom.window.document, errs, jar, alerts };
}

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 没登录：只给登录框');
  const A = makeDom(`${BASE}/`);
  await sleep(700);
  ok(!!A.doc.querySelector('#k'), '显示口令输入框');
  ok(!A.doc.querySelector('#tlist') && !A.doc.querySelector('#mlist'), '看不到任务和电脑列表');
  ok(!A.doc.querySelector('.tabs'), '顶部页签都没出来');
  ok(/内部管理页面/.test(A.doc.querySelector('.login').textContent), '写明了这是内部页面');

  console.log('\n[2] 输错口令');
  A.doc.querySelector('#k').value = 'wrong-one';
  A.doc.querySelector('#go').dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
  await sleep(600);
  ok(/口令不对/.test(A.doc.querySelector('.login').textContent), '提示口令不对');
  ok(!A.doc.querySelector('#tlist'), '还是进不去');

  console.log('\n[3] 输对口令');
  A.doc.querySelector('#k').value = KEY;
  A.doc.querySelector('#go').dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
  await sleep(1500);
  ok(!!A.doc.querySelector('#tlist'), '进到主界面，能看到任务列表');
  ok(!!A.doc.querySelector('#logoutBtn'), '右上角有「退出」');
  ok(A.w.localStorage.getItem('fleetKey') === null, '浏览器里不再留着口令');
  ok(/^wb_fleet=/.test(A.jar.cookie), '登录凭证放在 Cookie 里');

  console.log('\n[4] 加电脑 / 改口令入口');
  A.doc.querySelector('#addBtn').dispatchEvent(new A.w.MouseEvent('click', { bubbles: true }));
  await sleep(700);
  const card = A.doc.querySelector('#joinCard');
  ok(/join\.ps1\?t=/.test(card.textContent), '给出了带口令的加入命令');
  ok(!!A.doc.querySelector('#chPass') && !!A.doc.querySelector('#newPass'), '有改网页口令的输入框');

  console.log('\n[5] 老书签（?key=）自动登录');
  const B = makeDom(`${BASE}/?key=${KEY}`);
  await sleep(1500);
  ok(!!B.doc.querySelector('#tlist'), '带机器口令的旧链接直接进来了');
  ok(B.w.location.search === '', '地址栏里的口令被清掉，不再留在历史记录里');

  console.log('\n[6] 退出登录');
  B.doc.querySelector('#logoutBtn').dispatchEvent(new B.w.MouseEvent('click', { bubbles: true }));
  await sleep(800);
  ok(!!B.doc.querySelector('#k') && !B.doc.querySelector('#tlist'), '退出后回到登录框');
  ok(/已退出/.test(B.doc.querySelector('.login').textContent), '提示已退出');

  ok(A.errs.length === 0 && B.errs.length === 0, '页面没有运行时错误' + ([].concat(A.errs, B.errs).join(' | ') || ''));
  console.log(`\n登录页测试全部通过：${pass} 项\n`);
  A.dom.window.close(); B.dom.window.close(); hub.kill(); process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
