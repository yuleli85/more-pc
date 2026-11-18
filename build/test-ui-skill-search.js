// jsdom 真跑页面：技能页的查询功能（搜索框、来源/状态/电脑筛选、展开文件清单、统计）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8815, KEY = 'test-key-ui-skq';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-skq');
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
  await ask('UQ-A', []);
  await ask('UQ-B', []);
  const fA = [{ p: 'SKILL.md', d: b64('# alpha\n说明\n') }, { p: 'ref/note.txt', d: b64('参考资料') }];
  const fB = [{ p: 'SKILL.md', d: b64('# beta\n') }];
  const fG = [{ p: 'SKILL.md', d: b64('# gamma\n') }];
  await upload('alpha-skill', 'UQ-A', fA);
  await upload('beta-skill', 'UQ-A', fB);
  await upload('gamma-skill', 'UQ-B', fG);
  await ask('UQ-A', [{ name: 'alpha-skill', hash: hashOf(fA), mtime: Date.now() }]);
  await sleep(400);

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

  console.log('\n[1] 查询控件都在');
  ok(errs.length === 0, '没有 jsdom 报错' + (errs.length ? '：' + errs[0] : ''));
  ok(doc.querySelector('#skSearch'), '有搜索框');
  ok(doc.querySelector('#skFrom'), '有来源下拉');
  ok(doc.querySelector('#skState'), '有状态下拉');
  ok(doc.querySelector('#skMachine'), '有电脑下拉');
  ok(doc.querySelector('#skMissing'), '有「只看没装齐」勾选');
  const stOpts = [...doc.querySelectorAll('#skState option')].map((o) => o.value);
  ok(stOpts.includes('ok') && stOpts.includes('none') && stOpts.includes('diff'), '状态下拉有多种选项');

  console.log('\n[2] 列表渲染 + 统计');
  await sleep(800);
  const rows = () => [...doc.querySelectorAll('#sklist .pm')];
  ok(rows().length === 3, '3 个技能都显示（' + rows().length + '）');
  ok(doc.querySelector('#skcount').textContent.includes('共'), '统计显示总数');
  ok(doc.querySelector('#skcount').textContent.includes('3'), '总数是 3');
  ok(doc.querySelector('#skcount').textContent.includes('没装齐'), '统计里带「没装齐」');

  console.log('\n[3] 搜技能名');
  const inp = doc.querySelector('#skSearch');
  inp.value = 'alpha';
  inp.dispatchEvent(new w.Event('input'));
  await sleep(900);
  ok(rows().length === 1, '搜 alpha 只剩 1 个（' + rows().length + '）');
  ok(rows()[0].textContent.includes('alpha-skill'), '剩下的是 alpha-skill');
  ok(doc.querySelector('#skcount').textContent.includes('匹配'), '统计显示「匹配 N 个」');
  inp.value = '搜不到的名字';
  inp.dispatchEvent(new w.Event('input'));
  await sleep(900);
  ok(rows().length === 0, '搜不到时列表空');
  ok(doc.querySelector('#sklist').textContent.includes('没有符合条件'), '给个提示不是白屏');
  inp.value = '';
  inp.dispatchEvent(new w.Event('input'));
  await sleep(900);
  ok(rows().length === 3, '清空搜索又都回来了');

  console.log('\n[4] 按来源筛');
  const fr = doc.querySelector('#skFrom');
  ok([...fr.options].some((o) => o.value === 'UQ-A'), '来源下拉里有 UQ-A');
  ok([...fr.options].some((o) => o.value === 'UQ-B'), '来源下拉里有 UQ-B');
  fr.value = 'UQ-B';
  fr.dispatchEvent(new w.Event('change'));
  await sleep(900);
  ok(rows().length === 1 && rows()[0].textContent.includes('gamma-skill'), '只看 UQ-B 的剩 1 个');
  fr.value = '';
  fr.dispatchEvent(new w.Event('change'));
  await sleep(900);
  ok(rows().length === 3, '清空来源又都回来了');

  console.log('\n[5] 按电脑筛');
  const mc = doc.querySelector('#skMachine');
  ok([...mc.options].some((o) => o.value === 'UQ-A'), '电脑下拉里有 UQ-A');
  mc.value = 'UQ-A';
  mc.dispatchEvent(new w.Event('change'));
  await sleep(900);
  ok(rows().length === 3, '筛某台电脑时相关技能都在');
  ok(doc.querySelector('#sklist').textContent.includes('UQ-A'), '列表里能看到这台电脑');
  mc.value = '';
  mc.dispatchEvent(new w.Event('change'));
  await sleep(900);

  console.log('\n[6] 展开看文件清单');
  // 注意：列表每 5 秒自动重绘，旧的元素引用会失效 —— 每次点击都要重新取
  doc.querySelector('[data-skopen]').click();
  await sleep(900);
  const fl = doc.querySelector('.skfiles');
  ok(!!fl, '展开了文件清单区');
  ok(fl && fl.textContent.includes('SKILL.md'), '列出 SKILL.md');
  ok(fl && fl.textContent.includes('ref/note.txt'), '子目录文件也列出来了');
  ok(fl && /\d+ B/.test(fl.textContent), '标了文件大小');
  doc.querySelector('[data-skopen]').click();
  await sleep(400);
  ok(!doc.querySelector('.skfiles'), '再点一下收起来');

  console.log('\n[7] 筛选 + 展开能一起用');
  inp.value = 'alpha';
  inp.dispatchEvent(new w.Event('input'));
  await sleep(900);
  doc.querySelector('[data-skopen]').click();
  await sleep(900);
  ok(rows().length === 1 && doc.querySelector('.skfiles'), '搜着的时候也能展开看文件');
  ok(doc.querySelector('.skfiles').textContent.includes('SKILL.md'), '展开的是搜到的那个技能的文件');
  inp.value = '';
  inp.dispatchEvent(new w.Event('input'));
  await sleep(900);

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
