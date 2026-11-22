// jsdom 真跑页面：图片附件（选图、缩略图、拖拽、粘贴、发送带图、详情看图）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORT = 8825, KEY = 'test-key-ui-img';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(__dirname, 'testdata-ui-img');
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
  await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: 'UIMG', os: 'win32', host: 'UIMG', agentVersion: '1.11.2', cli: 'x', workdir: 'C:\\w', cpu: 3 }) });

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
      win.DataTransfer = class { constructor() { this.files = []; this.items = []; } };
    },
  });
  const w = dom.window, doc = w.document;
  await sleep(2500);

  console.log('\n[1] 图片区存在');
  ok(errs.length === 0, '没有 jsdom 报错' + (errs.length ? '：' + errs[0] : ''));
  ok(doc.querySelector('#imgBox'), '有图片区');
  ok(doc.querySelector('#imgPick'), '有「加图片」按钮');
  ok(doc.querySelector('#imgFile'), '有文件选择框');
  ok(doc.querySelector('#imgFile').accept.includes('image/png'), 'accept 限了图片类型');
  ok(doc.querySelector('#imgBox').style.display === 'none', '没选图时是收着的');

  console.log('\n[2] 选图后出缩略图');
  // 用 jsdom 真实的 File + FileReader
  const mkFile = (name) => new w.File([new w.Blob([PNG], { type: 'image/png' })], name, { type: 'image/png' });
  w.__f1 = mkFile('截图.png');
  await w.eval(`(async()=>{ await addImageFiles([window.__f1]); })()`);
  await sleep(500);
  const items = doc.querySelectorAll('#imgList .it');
  ok(items.length >= 1, '有缩略图（' + items.length + '）');
  ok(doc.querySelector('#imgBox').style.display !== 'none', '图片区展开了');
  ok(doc.querySelector('#imgList').textContent.includes('截图.png'), '显示了文件名');
  ok(doc.querySelector('#imgList').textContent.includes('KB'), '显示了大小');
  ok(doc.querySelector('#imgList img'), '有预览图');

  console.log('\n[3] 能去掉一张');
  const xBtn = doc.querySelector('[data-imgx]');
  ok(!!xBtn, '有删除按钮');
  const n0 = doc.querySelectorAll('#imgList .it').length;
  xBtn.click();
  await sleep(200);
  ok(doc.querySelectorAll('#imgList .it').length === n0 - 1, '少了一张');

  console.log('\n[4] 全部清掉');
  w.__f2 = mkFile('a.png');
  await w.eval(`(async()=>{ await addImageFiles([window.__f2]); })()`);
  await sleep(400);
  ok(doc.querySelectorAll('#imgList .it').length >= 1, '又加上了');
  doc.querySelector('#imgClear').click();
  await sleep(200);
  ok(doc.querySelectorAll('#imgList .it').length === 0, '清空了');
  ok(doc.querySelector('#imgBox').style.display === 'none', '图片区又收起来了');

  console.log('\n[5] 派活时真的把图带上了');
  w.__f3 = mkFile('派活图.png');
  await w.eval(`(async()=>{ await addImageFiles([window.__f3]); })()`);
  await sleep(500);
  doc.querySelector('#prompt').value = '看看这张图';
  await w.eval(`(async()=>{ await sendTask(); })()`);
  await sleep(1500);
  const st = await api('/api/state');
  const t = st.j.tasks.find((x) => x.prompt === '看看这张图');
  ok(t, '任务建了');
  ok(t && t.images && t.images.length === 1, '任务带着 1 张图');
  ok(t && t.images[0].name === '派活图.png', '图名对：' + (t && t.images[0].name));
  const imgs = doc.querySelectorAll('#imgList .it');
  ok(imgs.length === 0, '发出去后缩略图清空了');

  console.log('\n[6] 任务列表上有「N 张图」标记');
  const row = [...doc.querySelectorAll('#tlist .task')].find((x) => x.textContent.includes('看看这张图'));
  ok(row && row.textContent.includes('张图'), '标了图片数量（' + (row && row.textContent.match(/\d+ 张图/)) + '）');

  console.log('\n[7] 详情页能看图');
  await w.eval(`selTask='${t.id}'; detail=null; renderTasks(); loadDetail();`);
  await sleep(1200);
  const im = doc.querySelector('#detail .imglist .it img');
  ok(!!im, '详情页有图片缩略图');
  ok(im && im.src.includes('/api/img?id='), '图片走的是总控接口：' + (im && im.src.slice(0, 60)));

  console.log('\n[8] 图片接口真的能取到图');
  const imgId = t.images[0].id;
  const rr = await fetch(BASE + '/api/img?id=' + imgId, { headers: { 'x-fleet-key': KEY } });
  const buf = Buffer.from(await rr.arrayBuffer());
  ok(rr.status === 200, '取图成功');
  ok(buf.length === PNG.length && buf[0] === 0x89, '内容是原图');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
