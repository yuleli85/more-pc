// 隔离测试：网页登录授权（会话、改口令、限速、机器通道不受影响）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8802, KEY = 'machine-key-abc';
const DATA = path.join(__dirname, 'testdata-auth');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, [path.join(__dirname, '..', 'app', 'hub.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };

// 手工管 cookie：node 的 fetch 不会自己保存
function req(p, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
  if (opt.cookie) headers.cookie = opt.cookie;
  return fetch(B + p, { ...opt, headers }).then(async (r) => ({
    status: r.status,
    cookie: (r.headers.get('set-cookie') || '').split(';')[0],
    j: await r.json().catch(() => ({})),
    text: undefined,
  }));
}
const login = (p, cookie) => req('/api/login', { method: 'POST', cookie, body: JSON.stringify({ pass: p }) });

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 没登录什么都拿不到');
  ok((await req('/api/state')).status === 401, '没登录看不了状态');
  ok((await req('/api/prompts')).status === 401, '没登录看不了提示词');
  ok((await req('/api/tasks', { method: 'POST', body: '{}' })).status === 401, '没登录派不了活');
  ok((await req('/healthz')).status === 200, '健康检查仍然公开');

  console.log('\n[2] 登录');
  const bad = await login('wrong-pass');
  ok(bad.status === 401 && /还能再试 4 次/.test(bad.j.error), '错口令被拒，并告知剩余次数');
  const good = await login(KEY);
  ok(good.status === 200 && /^wb_fleet=[\w-]{10,}$/.test(good.cookie), '首次（网页口令＝机器口令）能登进来，发了 Cookie');
  const c1 = good.cookie;
  ok((await req('/api/state', { cookie: c1 })).status === 200, '带上 Cookie 就能看状态了');

  console.log('\n[3] 连接程序那条通道没被影响');
  ok((await req('/api/state', { headers: { 'x-fleet-key': KEY } })).status === 200, '机器口令走 header 照样能用');
  const poll = await req('/api/agent/poll', { method: 'POST', headers: { 'x-fleet-key': KEY }, body: JSON.stringify({ name: 'AUTH-A', os: 'win32', agentVersion: '1.9.1', cpu: 3 }) });
  ok(poll.status === 200 && poll.j && 'job' in poll.j, '连接程序轮询正常');
  const jfn = await fetch(B + '/join.ps1?t=' + KEY);
  ok(jfn.status === 200, '加入脚本能下载');
  ok((await fetch(B + '/join.ps1?t=wrong')).status === 403, '错口令下不了加入脚本');

  console.log('\n[4] 会话隔离：没 Cookie 的人拿不到');
  ok((await req('/api/state', { cookie: 'wb_fleet=fake-token-123456' })).status === 401, '伪造的 Cookie 无效');

  console.log('\n[5] 改网页口令');
  const c2 = (await login(KEY)).cookie;
  ok(!!c2 && c2 !== c1, '再登录一次拿到另一个会话');
  const changed = await req('/api/pass', { method: 'POST', cookie: c1, body: JSON.stringify({ old: KEY, pass: 'my-new-pass-1' }) });
  ok(changed.status === 200, '用当前口令改成新口令');
  ok((await req('/api/state', { cookie: c1 })).status === 200, '改口令的这台还登着');
  ok((await req('/api/state', { cookie: c2 })).status === 401, '别处已登录的会话被踢下线');

  console.log('\n[6] 换过之后，旧的机器口令不能再当网页口令');
  ok((await login(KEY, undefined)).status === 401, '旧口令登不进网页了');
  const np = await login('my-new-pass-1');
  ok(np.status === 200, '新口令能登进来');
  // 但机器那边完全不受影响
  ok((await req('/api/state', { headers: { 'x-fleet-key': KEY } })).status === 200, '连接程序还是用原来的机器口令，没断');
  ok((await req('/api/agent/poll', { method: 'POST', headers: { 'x-fleet-key': KEY }, body: JSON.stringify({ name: 'AUTH-A', os: 'win32', agentVersion: '1.9.1', cpu: 3 }) })).status === 200, '轮询依旧正常');

  console.log('\n[7] 改口令的校验');
  ok((await req('/api/pass', { method: 'POST', cookie: np.cookie, body: JSON.stringify({ old: 'nope', pass: 'another-pass' }) })).status === 403, '旧口令不对就不让改');
  ok((await req('/api/pass', { method: 'POST', cookie: np.cookie, body: JSON.stringify({ old: 'my-new-pass-1', pass: '123' }) })).status === 400, '新口令太短被拒');
  ok((await req('/api/pass', { method: 'POST', cookie: np.cookie, body: JSON.stringify({ old: 'my-new-pass-1', pass: 'x'.repeat(80) }) })).status === 400, '新口令太长被拒');

  console.log('\n[8] 退出登录');
  const lo = await req('/api/logout', { method: 'POST', cookie: np.cookie });
  ok(lo.status === 200 && /^wb_fleet=$/.test(lo.cookie), '退出后 Cookie 被清掉');
  ok((await req('/api/state', { cookie: np.cookie })).status === 401, '拿旧 Cookie 也进不来了');

  console.log('\n[9] 连着猜错会被锁（放最后测）');
  let locked = false;
  for (let i = 0; i < 6; i++) {
    const r = await login('guess-' + i);
    if (r.status === 429) { locked = true; break; }
  }
  ok(locked, '连错 5 次后开始锁 5 分钟');

  console.log(`\n授权测试全部通过：${pass} 项\n`);
  hub.kill();
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
