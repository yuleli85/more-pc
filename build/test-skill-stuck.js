// 专项测试：两边 hash 规则不一致时，不能陷入「上传→对不上→再上传」的死循环
// （实测这个 bug 让 hub 空转 12 小时、日志涨到 22.8MB）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8819, KEY = 'test-key-stuck';
const DATA = path.join(__dirname, 'testdata-stuck');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');
const crypto = require('crypto');

const hub = spawn(process.execPath, [HUB], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
hub.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
async function api(p, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers === undefined ? { 'x-fleet-key': KEY } : opt.headers) };
  const r = await fetch(B + p, { ...opt, headers });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function hashOf(files) { // 总控的算法：按完整路径排序
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.p < b.p ? -1 : 1))) { h.update(f.p); h.update('\0'); h.update(Buffer.from(f.d, 'base64')); }
  return h.digest('hex').slice(0, 20);
}
function hashOfOther(files) { // 另一种算法：按目录递归排序（故意跟总控不一样）
  const paths = files.map((f) => f.p);
  const fileDirs = new Map();
  for (const p of paths) { const parts = p.split('/'); const d = parts.slice(0, -1).join('/'); if (!fileDirs.has(d)) fileDirs.set(d, []); fileDirs.get(d).push(parts[parts.length - 1]); }
  const res = [];
  (function walk(d) { for (const k of (fileDirs.get(d) || []).slice().sort()) { const full = d ? d + '/' + k : k; res.push(full); if (fileDirs.has(full)) walk(full); } })('');
  const map = new Map(files.map((f) => [f.p, f]));
  const h = crypto.createHash('sha256');
  for (const p of res) { const f = map.get(p); if (!f) continue; h.update(f.p); h.update('\0'); h.update(Buffer.from(f.d, 'base64')); }
  return h.digest('hex').slice(0, 20);
}
const ask = (name, skills) => api('/api/agent/skills', { method: 'POST', body: JSON.stringify({ name, skills, agentVersion: '1.11.0' }) });
const upload = (name, from, files) => api('/api/agent/skill', { method: 'POST', body: JSON.stringify({ name, from, files }) });

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 造一个两边 hash 规则不同的技能');
  await ask('STUCK-A', []);
  // 文件名故意让两种排序结果不同：「演示项目」和「演示项目-审计结果」
  const files = [
    { p: 'SKILL.md', d: b64('# 技能') },
    { p: 'examples/演示项目/a.py', d: b64('a') },
    { p: 'examples/演示项目-审计结果/b.json', d: b64('b') },
  ];
  const hubHash = hashOf(files), otherHash = hashOfOther(files);
  ok(hubHash !== otherHash, '两种算法确实算出不同 hash（' + hubHash + ' vs ' + otherHash + '）');

  console.log('\n[2] 先用总控的算法传上去，注册表里是这个 hash');
  let r = await upload('stuck-skill', 'STUCK-A', files);
  ok(r.status === 200, '上传成功');
  ok(r.j.hash === hubHash, '接口回传了总控算的 hash');
  const list0 = (await api('/api/skills')).j.skills;
  ok(list0[0].hash === hubHash, '注册表里是总控的 hash');

  console.log('\n[3] 这台一直用「另一种算法」上报 → 不能死循环');
  // 模拟死循环：不停问、每次都上报那个对不上的 hash。
  // mtime 固定成「上传前的时间」= 它其实没改过文件（真改了的话 mtime 会更新）
  const staleMtime = Date.now() - 600000;
  let asked = 0, wanted = 0;
  for (let i = 0; i < 30; i++) {
    const res = await ask('STUCK-A', [{ name: 'stuck-skill', hash: otherHash, mtime: staleMtime }]);
    asked++;
    const sk = res.j.skills;
    if (sk && sk.get && sk.get.includes('stuck-skill')) wanted++;
    await sleep(60);
  }
  ok(asked === 30, '问了 30 次');
  // 最多允许 2 次（第一次是正常的「确认这台上报的是新版本吗」），之后就该停了
  ok(wanted <= 2, '基本不再让它重传（' + wanted + ' 次 / 30 次）');
  const list1 = (await api('/api/skills')).j.skills;
  ok(list1[0].hash === hubHash, '注册表的 hash 没被改来改去');
  ok(list1.length === 1, '技能还是 1 个，没被搞乱');

  console.log('\n[4] 注册表仍然是正常版本，其它机器照常能装');
  await ask('STUCK-B', []);
  const res2 = await ask('STUCK-B', []);
  ok(res2.j.skills && res2.j.skills.want && res2.j.skills.want.includes('stuck-skill'), 'B 照样收到安装指令');

  console.log('\n[5] 熔断：极端情况（1 分钟 25 次）也不会一直要它传');
  // 换个新技能，反复用不一致的 hash 上报
  const f2 = [{ p: 'x.md', d: b64('x') }, { p: 'a/y.md', d: b64('y') }];
  await upload('stuck2', 'STUCK-A', f2);
  const h2a = hashOf(f2), h2b = hashOfOther(f2);
  const stale2 = Date.now() - 600000;
  let w2 = 0;
  for (let i = 0; i < 25; i++) {
    const res = await ask('STUCK-A', [{ name: 'stuck2', hash: h2b, mtime: stale2 }]);
    if (res.j.skills && res.j.skills.get && res.j.skills.get.includes('stuck2')) w2++;
    await sleep(20);
  }
  ok(w2 <= 3, '25 次里最多要求 3 次重传（实际 ' + w2 + ' 次）—— 熔断起作用了');

  console.log('\n[6] 日志没有暴涨');
  const logSize = fs.existsSync(path.join(DATA, 'hub.log')) ? fs.statSync(path.join(DATA, 'hub.log')).size : 0;
  ok(logSize < 200 * 1024, '日志小于 200KB（实际 ' + Math.round(logSize / 1024) + 'KB）');

  console.log('\n[7] 上传动作不能把「连续冲突计数」清掉（真实 bug：清了就永远触发不了保护）');
  // 模拟真实死循环：这台每隔几秒就上传一次，每次上传都会走到 hub 的上传接口。
  // 那个接口以前会把冲突计数覆盖掉 → 计数永远到不了阈值 → 保护形同虚设。
  const f3 = [{ p: 'p.md', d: b64('p') }, { p: 'b/q.md', d: b64('q') }];
  await upload('stuck3', 'STUCK-A', f3);
  const h3a = hashOf(f3), h3b = hashOfOther(f3);
  const stale3 = Date.now() - 600000;
  let w3 = 0;
  for (let i = 0; i < 12; i++) {
    // 每轮都先问一次（拿到 get 指令），再上传一次（模拟 agent 老老实实照做）
    const res = await ask('STUCK-A', [{ name: 'stuck3', hash: h3b, mtime: stale3 }]);
    if (res.j.skills && res.j.skills.get && res.j.skills.get.includes('stuck3')) {
      w3++;
      await upload('stuck3', 'STUCK-A', f3); // agent 照着指令传上来
    }
    await sleep(30);
  }
  ok(w3 <= 3, '12 轮里最多要求 3 次重传（实际 ' + w3 + ' 次）—— 上传动作没把计数清掉');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
