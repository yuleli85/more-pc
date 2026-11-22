// 测试：图片附件（存图、派活时带下去、连接程序下载、删任务时清理）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8823, KEY = 'test-key-img';
const DATA = path.join(__dirname, 'testdata-img');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');

const hub = spawn(process.execPath, [HUB], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
async function api(p, opt = {}) {
  const r = await fetch(B + p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json().catch(() => ({})) : await r.arrayBuffer(), hdr: r.headers };
}
// 造一张真 PNG（1x1 像素）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const b64 = PNG.toString('base64');

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  await api('/api/agent/poll', { method: 'POST', body: JSON.stringify({ name: 'IMG-A', os: 'win32', host: 'IMG-A', agentVersion: '1.11.2', cli: 'x', workdir: 'C:\\w', cpu: 3 }) });

  console.log('\n[1] 带图片建任务');
  const r = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: '看看这张图', images: [{ name: '测试图.png', mime: 'image/png', data: b64 }] }) });
  ok(r.status === 200, '任务建成了（HTTP ' + r.status + '）' + (r.j.error ? '：' + r.j.error : ''));
  ok(r.j.images && r.j.images.length === 1, '任务记着 1 张图');
  const im = (r.j.images || [])[0];
  ok(im && im.name === '测试图.png', '图名对：' + (im && im.name));
  ok(im && im.size === PNG.length, '大小对：' + (im && im.size));
  ok(im && /^[a-f0-9]{24}$/.test(im.id), '图片 id 是十六进制：' + (im && im.id));
  const tid = r.j.ids[0];

  console.log('\n[2] 图片真存到总控了');
  const imgFile = path.join(DATA, 'imgs', im.id);
  ok(fs.existsSync(imgFile), '文件在 data/imgs/');
  ok(fs.existsSync(imgFile + '.json'), '元信息也在');

  console.log('\n[3] 连接程序能下载到图');
  const d = await api('/api/agent/img?id=' + im.id);
  ok(d.status === 200, '下载成功（HTTP ' + d.status + '）');
  ok(Buffer.compare(Buffer.from(d.j), PNG) === 0, '下载到的内容跟原来一模一样');
  ok((d.hdr.get('content-type') || '').includes('image/png'), '类型对：' + d.hdr.get('content-type'));

  console.log('\n[4] 网页也能看图（同一个接口走 cookie）');
  const d2 = await api('/api/img?id=' + im.id);
  ok(d2.status === 200, '网页接口可用');

  console.log('\n[5] 派活时图片跟着下去');
  const st = await api('/api/state');
  ok(st.j.machines.length >= 1, '电脑连着');
  const t = st.j.tasks.find((x) => x.id === tid);
  ok(t && t.images && t.images.length === 1, '状态里也有这张图');

  console.log('\n[6] 坏输入要挡住');
  let bad = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: 'x', images: [{ name: 'a.exe', mime: 'application/x-msdownload', data: b64 }] }) });
  ok(bad.status === 400, '不支持的格式被拒（HTTP ' + bad.status + '）');
  bad = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: 'x', images: [{ name: 'a.png', mime: 'image/png', data: '!!!not base64!!!' }] }) });
  ok(bad.status === 400, '乱数据被拒');
  bad = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: 'x', images: Array.from({ length: 12 }, () => ({ name: 'a.png', mime: 'image/png', data: b64 })) }) });
  ok(bad.status === 400, '超过 10 张被拒');
  const d3 = await api('/api/agent/img?id=../key');
  ok(d3.status === 400 || d3.status === 404, '路径穿越被挡住（HTTP ' + d3.status + '）');

  console.log('\n[7] 多张图');
  const r2 = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ mode: 'pool', prompt: '看这几张', images: [
    { name: 'a.png', mime: 'image/png', data: b64 }, { name: 'b.jpg', mime: 'image/jpeg', data: b64 }, { name: 'c.gif', mime: 'image/gif', data: b64 },
  ] }) });
  ok(r2.status === 200 && r2.j.images.length === 3, '3 张图都收下了');
  ok(r2.j.images.map((x) => x.mime).sort().join(',') === 'image/gif,image/jpeg,image/png', '各自的类型记对了');

  console.log('\n[8] 删任务时图片一起清掉');
  const before = fs.readdirSync(path.join(DATA, 'imgs')).filter((f) => !f.endsWith('.json')).length;
  await api('/api/tasks/delete', { method: 'POST', body: JSON.stringify({ ids: [tid, r2.j.ids[0]] }) });
  await sleep(300);
  const after = fs.readdirSync(path.join(DATA, 'imgs')).filter((f) => !f.endsWith('.json')).length;
  ok(after < before, '图片文件少了（' + before + ' → ' + after + '）');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
