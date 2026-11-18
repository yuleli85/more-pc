// jsdom 真跑页面：技能共享页（页签、列表渲染、推送到全部、停止共享、只删某台、彻底删除）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8810, KEY = 'test-key-ui-skills';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-skills');
fs.rmSync(DATA, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const crypto = require('crypto');

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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.p < b.p ? -1 : 1))) { h.update(f.p); h.update('\0'); h.update(Buffer.from(f.d, 'base64')); }
  return h.digest('hex').slice(0, 20);
}
const ask = (name, skills) => api('/api/agent/skills', { method: 'POST', body: JSON.stringify({ name, skills, agentVersion: '1.11.0' }) });
const upload = (name, from, files) => api('/api/agent/skill', { method: 'POST', body: JSON.stringify({ name, from, files }) });

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  // 两台电脑 + 一个技能
  await ask('UI-A', []);
  await ask('UI-B', []);
  const f1 = [{ p: 'SKILL.md', d: b64('# 共享技能\n') }];
  const h1 = hashOf(f1);
  await ask('UI-A', [{ name: 'shared-skill', hash: h1, mtime: Date.now() }]);
  await upload('shared-skill', 'UI-A', f1);
  await ask('UI-A', [{ name: 'shared-skill', hash: h1, mtime: Date.now() }]);
  await sleep(300);

  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String(e && e.message || e)));
  const alerts = [];
  const jar = { cookie: '' };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/?key=${KEY}#skills`, pretendToBeVisual: true, virtualConsole: vc,
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

  console.log('\n[1] 进页面就在技能页');
  ok(errs.length === 0, '没有 jsdom 报错' + (errs.length ? '：' + errs[0] : ''));
  ok(doc.querySelector('#viewSkills') && doc.querySelector('#viewSkills').style.display !== 'none', '技能页可见');
  ok(doc.querySelector('.tabs button[data-view=skills]').classList.contains('on'), '页签高亮');
  ok(doc.querySelector('#crumbNow').textContent === '技能共享', '面包屑跟着换');
  ok(doc.querySelector('#pageTitle').textContent.includes('技能共享'), '标题跟着换');

  console.log('\n[2] 列表渲染');
  await sleep(600);
  const rows = [...doc.querySelectorAll('#sklist .pm')];
  ok(rows.length === 1, '一个技能一行（' + rows.length + '）');
  const txt = doc.querySelector('#sklist').textContent;
  ok(txt.includes('shared-skill'), '技能名在');
  ok(txt.includes('UI-A'), '来源电脑在');
  ok(txt.includes('个文件'), '文件数在');
  ok(txt.includes('已装'), '安装状态在');
  ok(txt.includes('未装'), '没装的也标出来');

  console.log('\n[3] 点某台电脑的标签 → 只删那一台');
  const chips = [...doc.querySelectorAll('[data-skm]')];
  ok(chips.length >= 2, '每台电脑一个标签（' + chips.length + '）');
  const bChip = chips.find((c) => c.dataset.skm === 'UI-B');
  ok(!!bChip, '找到 UI-B 的标签');
  bChip.click();
  await sleep(700);
  const sk1 = (await api('/api/skills')).j.skills[0];
  ok(sk1.installs['UI-B'] && sk1.installs['UI-B'].removed === true, '后端记下 UI-B 上删过了');
  ok(sk1.installs['UI-A'] && !sk1.installs['UI-A'].removed, 'UI-A 没受影响');
  ok(doc.querySelector('#sklist').textContent.includes('已删'), '列表上标成「已删」');

  console.log('\n[4] 推送到全部 → 装回来');
  [...doc.querySelectorAll('[data-skpush]')][0].click();
  await sleep(700);
  const sk2 = (await api('/api/skills')).j.skills[0];
  ok(sk2.installs['UI-B'] && sk2.installs['UI-B'].removed === false, 'UI-B 的「已删」清了');
  const pr = await ask('UI-B', []);
  ok(pr.j.skills && pr.j.skills.want && pr.j.skills.want.includes('shared-skill'), 'UI-B 收到安装指令');

  console.log('\n[5] 停止共享（各台电脑上的文件不动）');
  [...doc.querySelectorAll('[data-skdel]')][0].click();
  await sleep(700);
  const sk3 = (await api('/api/skills')).j.skills;
  ok(sk3.length === 0, '注册表空了');
  const dl = await api('/api/agent/skill?name=shared-skill');
  ok(dl.status === 404, '正文也删了');
  ok(doc.querySelector('#sklist').textContent.includes('还没有共享的技能'), '页面显示空态');

  console.log('\n[6] 彻底删除');
  await upload('wipe-me', 'UI-A', [{ p: 'a.md', d: b64('x') }]);
  await sleep(400);
  await api('/api/agent/skills', { method: 'POST', body: JSON.stringify({ name: 'UI-A', skills: [{ name: 'wipe-me', hash: hashOf([{ p: 'a.md', d: b64('x') }]), mtime: Date.now() }], agentVersion: '1.11.0' }) });
  w.eval('loadSkills()');
  await sleep(800);
  ok(doc.querySelector('#sklist').textContent.includes('wipe-me'), '新技能出现在列表');
  [...doc.querySelectorAll('[data-skwipe]')][0].click();
  await sleep(700);
  const sk4 = (await api('/api/skills')).j.skills;
  ok(sk4.length === 0, '彻底删干净了');

  console.log('\n[7] 切走再切回来，数据还在');
  w.eval("setView('tasks')");
  await sleep(300);
  ok(doc.querySelector('#viewTasks').style.display !== 'none', '切回任务页');
  w.eval("setView('skills')");
  await sleep(700);
  ok(doc.querySelector('#viewSkills').style.display !== 'none', '又切回技能页');
  ok(doc.querySelector('#sklist').textContent.includes('还没有共享的技能'), '空态还在（没被删的东西复活）');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
