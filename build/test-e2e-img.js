// 端到端：派一件带图的活 → 连接程序把图下到本地 → 指令里带上本地路径 → AI 真的读到了图
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8824, KEY = 'e2e-img-key';
const DATA = path.join(__dirname, 'testdata-e2e-img');
const ROOT = path.join(__dirname, 'e2e-img-home');
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');
const AGENT = path.join(__dirname, '..', 'app', 'agent.js');

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const hub = spawn(process.execPath, [HUB], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));
async function api(p, opt = {}) {
  const r = await fetch(B + p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 起一台假电脑（会检查指令里有没有图片路径）');
  const home = path.join(ROOT, 'pc');
  const work = path.join(home, 'proj');
  fs.mkdirSync(work, { recursive: true });
  const fakeJs = path.join(home, 'fake.js');
  fs.writeFileSync(fakeJs, `
const fs = require('fs'), path = require('path');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  // 指令里应该有图片的本地路径，而且那个文件真的存在、内容跟原图一样
  const paths = input.split('\\n').map((l) => l.replace(/^\\s*\\d+\\.\\s*/, '').trim()).filter((l) => l.toLowerCase().endsWith('.png'));
  const out = { type: 'result', is_error: false, result: '收到指令；里面提到 ' + paths.length + ' 个 png 路径', session_id: 's1' };
  const chk = paths.map((p) => {
    try { const b = fs.readFileSync(p); return { p: p, ok: b.length > 0 && b[0] === 0x89 }; }
    catch (e) { return { p: p, ok: false, err: e.message }; }
  });
  fs.writeFileSync(path.join(cwd, 'imgcheck.json'), JSON.stringify({ paths: paths, chk: chk, input: input.slice(0, 2000) }, null, 2));
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
});
`, 'utf8');
  const isWin = process.platform === 'win32';
  const fake = isWin ? path.join(home, 'fake.cmd') : path.join(home, 'fake.sh');
  if (isWin) fs.writeFileSync(fake, '@echo off\r\n"' + process.execPath + '" "' + fakeJs + '" %*\r\n');
  else { fs.writeFileSync(fake, '#!/bin/sh\nexec "' + process.execPath + '" "' + fakeJs + '" "$@"\n'); fs.chmodSync(fake, 0o755); }
  const agent = spawn(process.execPath, [AGENT, '--hub', B, '--key', KEY, '--name', 'E2E-IMG', '--workdir', work], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_NO_UPDATE: '1', FLEET_CHANNEL: 'cli', CODEBUDDY_BIN: fake },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => process.stderr.write('[agent] ' + d));
  agent.stderr.on('data', (d) => process.stderr.write('[agent!] ' + d));
  await sleep(4000);

  console.log('\n[2] 派一件带两张图的活');
  const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify({
    mode: 'pool', prompt: '看看这两张图', targets: ['E2E-IMG'],
    images: [
      { name: '第一张.png', mime: 'image/png', data: PNG.toString('base64') },
      { name: '第二张.png', mime: 'image/png', data: PNG.toString('base64') },
    ],
  }) });
  ok(t.status === 200, '派出去了：' + (t.j.error || t.j.ids.join(',')));
  ok(t.j.images && t.j.images.length === 2, '带了两张图');
  const tid = t.j.ids[0];

  console.log('\n[3] 等它跑完');
  let task = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const d = await api('/api/tasks/' + tid);
    task = d.j;
    const r = Object.values(task.runs || {})[0];
    if (r && ['done', 'failed', 'stopped'].includes(r.status)) break;
  }
  const run = Object.values(task.runs || {})[0] || {};
  ok(run.status === 'done', '状态是完成（' + run.status + '）');
  ok(!run.error, '没有报错：' + (run.error || ''));

  console.log('\n[4] 图片下到了那台电脑的本地');
  const chkPath = path.join(work, 'imgcheck.json');
  ok(fs.existsSync(chkPath), '假程序写出了检查结果');
  const chk = JSON.parse(fs.readFileSync(chkPath, 'utf8'));
  ok(chk.chk.length === 2, '指令里提到了 2 个图片路径（实际 ' + chk.chk.length + '）');
  ok(chk.chk.every((c) => c.ok), '两个路径下的文件都真实存在且是 PNG');
  ok(chk.paths.every((p) => /第一张|第二张/.test(p)), '文件名带上了原图名：' + JSON.stringify(chk.paths));

  console.log('\n[5] 本地图片存在 ~/.wb-fleet/imgs 下');
  const imgDir = path.join(home, '.wb-fleet', 'imgs');
  ok(fs.existsSync(imgDir), '图片目录建了');
  const local = fs.readdirSync(imgDir).filter((f) => f.endsWith('.png'));
  ok(local.length === 2, '本地存了 2 张（实际 ' + local.length + '）');
  ok(fs.readFileSync(path.join(imgDir, local[0])).length === PNG.length, '内容跟原图一样');

  console.log('\n[6] 过程里说清楚了「图片已下载」');
  const items = (run.items || []).map((i) => i.s || '').join(' | ');
  ok(items.includes('图片'), '过程消息提到图片');

  agent.kill();
  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
