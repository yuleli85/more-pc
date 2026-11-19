// 端到端：真的发一件活，验证「结果能带回来」+「交付文件能带回来」
// 之前的问题：客户端通道跑完，网页上结果一片空白（automation_runs 里没有 output 字段）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8821, KEY = 'e2e-result-key';
const DATA = path.join(__dirname, 'testdata-e2e-result');
const ROOT = path.join(__dirname, 'e2e-result-home');
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(ROOT, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');
const AGENT = path.join(__dirname, '..', 'app', 'agent.js');

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };

const hub = spawn(process.execPath, [HUB], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

async function api(p, opt = {}) {
  const r = await fetch(B + p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const mkTask = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) });

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 起一台假电脑（命令行通道）');
  const home = path.join(ROOT, 'pc');
  const work = path.join(home, 'proj');
  fs.mkdirSync(work, { recursive: true });
  // 假的 codebuddy：把指令写进一个文件、产出两个文件，然后打印结果
  const fakeJs = path.join(home, 'fake-codebuddy.js');
  fs.writeFileSync(fakeJs, `
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const cwd = process.cwd();
  // 模拟干活：产出两个文件
  fs.writeFileSync(path.join(cwd, '报告.md'), '# 交付报告\\n\\n这是干完活写出来的。\\n', 'utf8');
  fs.mkdirSync(path.join(cwd, 'data'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'data', '结果.json'), JSON.stringify({ ok: true, n: 42 }), 'utf8');
  // 模拟 stream-json 输出
  const out = { type: 'result', is_error: false, result: '干完了：产出 报告.md 和 data/结果.json', session_id: 'fake-session-1' };
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake', cwd }) + '\\n');
  process.exit(0);
});
`, 'utf8');
  // Windows 上 agent 用 cmd 跑 BIN，得给 .cmd；Mac/Linux 用 .sh
  const isWin = process.platform === 'win32';
  const fake = isWin ? path.join(home, 'fake.cmd') : path.join(home, 'fake.sh');
  if (isWin) fs.writeFileSync(fake, '@echo off\r\n"' + process.execPath + '" "' + fakeJs + '" %*\r\n');
  else { fs.writeFileSync(fake, '#!/bin/sh\nexec "' + process.execPath + '" "' + fakeJs + '" "$@"\n'); fs.chmodSync(fake, 0o755); }
  const agent = spawn(process.execPath, [AGENT, '--hub', B, '--key', KEY, '--name', 'E2E-R', '--workdir', work], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_NO_UPDATE: '1', FLEET_CHANNEL: 'cli', CODEBUDDY_BIN: fake, FLEET_DEBUG_API: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => process.stderr.write('[agent] ' + d));
  agent.stderr.on('data', (d) => process.stderr.write('[agent!] ' + d));
  // Windows 下 .cmd 要经 shell 跑，这里给的是 .js，agent 会直接 spawn —— 加个包装
  await sleep(4000);

  console.log('\n[2] 派一件活');
  let st = await api('/api/state');
  ok(st.j.machines.length >= 1, '电脑连上来了');
  const t = await mkTask({ mode: 'pool', prompt: '做个报告', workdir: work, targets: ['E2E-R'] });
  ok(t.status === 200 && t.j.ids.length === 1, '派出去了：' + t.j.ids.join(','));
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
  if (process.env.DBG) {
    console.log('--- hub.log ---');
    try { console.log(fs.readFileSync(path.join(DATA, 'hub.log'), 'utf8').slice(-2000)); } catch (e) { console.log('读不到:', e.message); }
  }
  const run = Object.values(task.runs || {})[0] || {};
  ok(run.status === 'done', '状态是完成（' + run.status + '）');
  ok(run.error === '', '没有报错：' + (run.error || ''));

  console.log('\n[4] 结果有内容吗');
  ok(!!(run.result && run.result.trim()), '结果不是空的：' + JSON.stringify((run.result || '').slice(0, 80)));
  ok(run.result.includes('干完了'), '结果内容对');

  console.log('\n[5] 产出文件带回来了吗（交付在哪）');
  ok(Array.isArray(run.files), '有文件清单字段');
  console.log('    文件:', JSON.stringify((run.files || []).map((f) => f.p || f)));

  console.log('\n[6] 网页上能看到');
  const d2 = await api('/api/tasks/' + tid);
  ok(d2.j.runs['E2E-R'].hasResult === true, '标了「有结果」');
  const sl = await api('/api/state');
  const t2 = sl.j.tasks.find((x) => x.id === tid);
  ok(t2, '任务列表里有');

  agent.kill();
  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
