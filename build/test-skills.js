// 隔离测试：技能共享（一台开发 → 其它电脑自动装上；改动自动同步；删除不自动复活；防路径穿越）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8809, KEY = 'test-key-skills';
const DATA = path.join(__dirname, 'testdata-skills');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');

function startHub() {
  const p = spawn(process.execPath, [HUB], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, FLEET_KEY: KEY, AUTO_UPGRADE: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('[hub] ' + d));
  return p;
}
let hub = startHub();

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };
async function api(p, opt = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opt.headers === undefined ? { 'x-fleet-key': KEY } : opt.headers) };
  const r = await fetch(B + p, { ...opt, headers });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
// 一台电脑来问（像 agent 那样）
const poll = (name, skills, extra = {}) => api('/api/agent/skills', {
  method: 'POST',
  body: JSON.stringify({ name, skills, agentVersion: '1.11.0', ...extra }),
});
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// 和连接程序一样的算法：按路径排序，路径+\0+字节 → sha256 前 20 位
const crypto = require('crypto');
function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.p < b.p ? -1 : 1))) { h.update(f.p); h.update('\0'); h.update(Buffer.from(f.d, 'base64')); }
  return h.digest('hex').slice(0, 20);
}
const upload = (name, from, files) => api('/api/agent/skill', { method: 'POST', body: JSON.stringify({ name, from, files }) });
const skillList = () => api('/api/skills').then((r) => r.j.skills || []);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 校验：不合法的一律拒掉');
  // 先登记 M-A，后面测路径校验才有意义（from 必须是已登记的机器）
  await poll('M-A', []);
  let r = await upload('坏名字', '没登记的机器', [{ p: 'a.md', d: b64('x') }]);
  ok(r.status === 400 && /不知道是哪台电脑/.test(r.j.error), '没登记过的机器名拒掉');
  r = await upload('ok', 'M-A', [{ p: '../逃逸.md', d: b64('x') }]);
  ok(r.status === 400 && /路径不合法/.test(r.j.error), '路径穿越（../）拒掉');
  r = await upload('ok', 'M-A', [{ p: '/etc/passwd', d: b64('x') }]);
  ok(r.status === 400, '绝对路径拒掉');
  r = await upload('ok', 'M-A', [{ p: 'C:/win', d: b64('x') }]);
  ok(r.status === 400, '盘符路径拒掉');
  r = await upload('ok', 'M-A', [{ p: 'a.md', d: '不是base64!!!' }]);
  ok(r.status === 400 && /base64/.test(r.j.error), '内容不是 base64 拒掉');
  r = await upload('ok', 'M-A', []);
  ok(r.status === 400 && /没有文件/.test(r.j.error), '空文件列表拒掉');

  console.log('\n[2] 一台开发技能 → 另一台自动装上');
  // M-A 上有个技能
  const f1 = [{ p: 'SKILL.md', d: b64('# 我的技能\n干活用的') }];
  const h1 = hashOf(f1);
  // M-A 先来问一次（登记自己 + 上报清单）
  let pr = await poll('M-A', [{ name: 'my-skill', hash: h1, mtime: Date.now() }]);
  ok(pr.status === 200, 'M-A 来问，正常应答');
  // 总控让它传上来
  pr = await poll('M-A', [{ name: 'my-skill', hash: h1, mtime: Date.now() }]);
  ok(pr.j.skills && pr.j.skills.get && pr.j.skills.get.includes('my-skill'), '总控让 M-A 把新技能传上来');
  r = await upload('my-skill', 'M-A', f1);
  ok(r.status === 200 && r.j.ok, '上传成功');
  let list = await skillList();
  ok(list.length === 1 && list[0].name === 'my-skill', '注册表里有这个技能');
  ok(list[0].from === 'M-A', '记着来自哪台');
  ok(list[0].hash === h1, 'hash 记对了');
  ok(list[0].files === 1, '文件数记对了');
  ok(list[0].size > 0, '大小记下了');

  console.log('\n[3] 别的电脑来问 → 自动下发安装指令');
  pr = await poll('M-B', []);
  ok(pr.j.skills && pr.j.skills.want && pr.j.skills.want.includes('my-skill'), 'M-B 收到「装 my-skill」的指令');
  // M-B 下不到正文会报错，但指令本身已经对了；再验正文能下到
  const dl = await api('/api/agent/skill?name=my-skill');
  ok(dl.status === 200 && dl.j.files.length === 1, '正文能下载');
  ok(Buffer.from(dl.j.files[0].d, 'base64').toString('utf8').includes('我的技能'), '内容对得上');
  const dl2 = await api('/api/agent/skill?name=没有这个');
  ok(dl2.status === 404, '没有的技能下不到');

  console.log('\n[4] 装上以后不再重复催');
  pr = await poll('M-B', [{ name: 'my-skill', hash: h1, mtime: Date.now() }]);
  ok(!pr.j.skills || !pr.j.skills.want, '已经是最新了，不再下发');

  console.log('\n[5] 改了技能 → 自动把新版传上去');
  const f2 = [{ p: 'SKILL.md', d: b64('# 我的技能\n改过了') }];
  const h2 = hashOf(f2);
  pr = await poll('M-A', [{ name: 'my-skill', hash: h2, mtime: Date.now() }]);
  ok(pr.j.skills && pr.j.skills.get && pr.j.skills.get.includes('my-skill'), 'M-A 改过，总控要新版本');
  r = await upload('my-skill', 'M-A', f2);
  ok(r.status === 200, '新版上传成功');
  list = await skillList();
  ok(list[0].hash === h2, '注册表换成新 hash');
  // M-B 现在是旧版，应该收到安装指令
  pr = await poll('M-B', [{ name: 'my-skill', hash: h1, mtime: Date.now() }]);
  ok(pr.j.skills && pr.j.skills.want && pr.j.skills.want.includes('my-skill'), 'M-B 版本旧，收到更新指令');

  console.log('\n[6] 在一台电脑上删了 → 不自动装回');
  await api('/api/skills/machine-del', { method: 'POST', body: JSON.stringify({ id: 'my-skill', machine: 'M-B' }) });
  list = await skillList();
  ok(list[0].installs['M-B'] && list[0].installs['M-B'].removed === true, '记下 M-B 上删过了');
  pr = await poll('M-B', []);
  ok(pr.j.skills && pr.j.skills.del && pr.j.skills.del.includes('my-skill'), '给 M-B 下了删除指令');
  // 删完之后它不上报这个技能，总控不该再催它装
  pr = await poll('M-B', []);
  ok(!pr.j.skills || !pr.j.skills.want, '删过的不自动装回');
  // 但别的没删的机器照旧自动装
  pr = await poll('M-C', []);
  ok(pr.j.skills && pr.j.skills.want && pr.j.skills.want.includes('my-skill'), 'M-C 照旧自动装');

  console.log('\n[7] 点「推送到全部」→ 装回来');
  r = await api('/api/skills/push', { method: 'POST', body: JSON.stringify({ id: 'my-skill' }) });
  ok(r.status === 200 && r.j.targets.includes('M-B'), '推送目标含 M-B');
  list = await skillList();
  ok(list[0].installs['M-B'].removed === false, 'M-B 的「删过」标记清了');
  pr = await poll('M-B', []);
  ok(pr.j.skills && pr.j.skills.want && pr.j.skills.want.includes('my-skill'), 'M-B 又收到安装指令了');

  console.log('\n[8] 老连接程序（不支持技能共享）不受影响');
  pr = await poll('M-OLD', [{ name: 'my-skill', hash: h2, mtime: Date.now() }], { agentVersion: '1.10.1' });
  ok(pr.status === 200, '老版来问也正常');
  ok(!pr.j.skills, '老版不下发技能指令（它不认）');
  ok(/^\d+\.\d+\.\d+$/.test(pr.j.agentV), '老版能拿到新版本号去自升级（' + pr.j.agentV + '）');

  console.log('\n[9] 技能页看到各台装到什么程度');
  await poll('M-A', [{ name: 'my-skill', hash: h2, mtime: Date.now() }]);
  await poll('M-B', [{ name: 'my-skill', hash: h2, mtime: Date.now() }]);
  list = await skillList();
  const st = list[0].states;
  ok(st['M-A'] === 'ok', 'M-A 是最新的（ok）');
  ok(st['M-B'] === 'ok', 'M-B 也是最新的（ok）');
  ok(!!st['M-C'], 'M-C 也有状态');
  ok(st['M-C'] !== 'ok', 'M-C 还没装上（不是 ok）');

  console.log('\n[10] 停止共享 / 彻底删除');
  r = await api('/api/skills/delete', { method: 'POST', body: JSON.stringify({ ids: ['my-skill'] }) });
  ok(r.status === 200 && r.j.removed === 1, '停止共享删掉注册表条目');
  ok((await skillList()).length === 0, '列表空了');
  const dl3 = await api('/api/agent/skill?name=my-skill');
  ok(dl3.status === 404, '正文也删了');
  pr = await poll('M-C', []);
  ok(!pr.j.skills || !pr.j.skills.want, '不再分发');

  console.log('\n[11] 重启后注册表还在');
  r = await upload('keep-me', 'M-A', [{ p: 'a.md', d: b64('x') }]);
  ok(r.status === 200, '又传了一个');
  hub.kill();
  await sleep(800);
  hub = startHub();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  list = await skillList();
  ok(list.length === 1 && list[0].name === 'keep-me', '重启后还在');
  const dl4 = await api('/api/agent/skill?name=keep-me');
  ok(dl4.status === 200, '正文还在');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
