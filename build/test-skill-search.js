// 隔离测试：技能共享的查询功能（搜名字、按来源/状态/电脑筛选、看文件清单、统计）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8814, KEY = 'test-key-skq';
const DATA = path.join(__dirname, 'testdata-skq');
fs.rmSync(DATA, { recursive: true, force: true });
const B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUB = path.join(__dirname, '..', 'app', 'hub.js');
const crypto = require('crypto');

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
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.p < b.p ? -1 : 1))) { h.update(f.p); h.update('\0'); h.update(Buffer.from(f.d, 'base64')); }
  return h.digest('hex').slice(0, 20);
}
const ask = (name, skills) => api('/api/agent/skills', { method: 'POST', body: JSON.stringify({ name, skills, agentVersion: '1.11.0' }) });
const upload = (name, from, files) => api('/api/agent/skill', { method: 'POST', body: JSON.stringify({ name, from, files }) });

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  console.log('\n[1] 准备：3 台电脑，4 个技能');
  await ask('Q-A', []);
  await ask('Q-B', []);
  await ask('Q-C', []);
  // alpha-skill（来自 A，2 个文件）、beta-skill（来自 A，1 个）、gamma-skill（来自 B）、alphabet-x（来自 B）
  const mk = (name, from, files) => upload(name, from, files);
  const fAlpha = [{ p: 'SKILL.md', d: b64('# alpha\n说明\n') }, { p: 'ref/note.txt', d: b64('参考资料') }];
  const fBeta = [{ p: 'SKILL.md', d: b64('# beta\n') }];
  const fGamma = [{ p: 'SKILL.md', d: b64('# gamma\n') }];
  const fAlpha2 = [{ p: 'SKILL.md', d: b64('# alphabet\n') }];
  await mk('alpha-skill', 'Q-A', fAlpha);
  await mk('beta-skill', 'Q-A', fBeta);
  await mk('gamma-skill', 'Q-B', fGamma);
  await mk('alphabet-x', 'Q-B', fAlpha2);
  // A、B 上报了 alpha（A 还多一个 beta）；C 什么都没有
  await ask('Q-A', [{ name: 'alpha-skill', hash: hashOf(fAlpha), mtime: Date.now() }, { name: 'beta-skill', hash: hashOf(fBeta), mtime: Date.now() }]);
  await ask('Q-B', [{ name: 'alpha-skill', hash: hashOf(fAlpha), mtime: Date.now() }]);
  await ask('Q-C', []);
  await sleep(400);
  // 注意：自动共享会让 A/B 把别的技能也装上（真实行为）。测试里的状态以实际为准，
  // 下面用「Q-C 什么都没装」这个稳定事实来断言，其余用相对关系断言。

  console.log('\n[2] 不带参数：全部列出 + 统计');
  let r = await api('/api/skills');
  ok(r.status === 200, '接口正常');
  ok(r.j.skills.length === 4, '4 个技能都在');
  ok(r.j.total === 4 && r.j.matched === 4, '总数和匹配数都是 4');
  ok(r.j.froms.includes('Q-A') && r.j.froms.includes('Q-B'), '来源清单有 Q-A / Q-B');
  ok(r.j.machines.includes('Q-A') && r.j.machines.includes('Q-C'), '电脑清单有 Q-A / Q-C');
  ok(r.j.notAll === r.j.skills.filter((s) => Object.values(s.states || {}).some((v) => v !== 'ok')).length, '「没装齐」的数量算对了');

  console.log('\n[3] 按名字搜');
  r = await api('/api/skills?q=alpha');
  ok(r.j.skills.length === 2, '搜 alpha 命中 2 个（alpha-skill 和 alphabet-x）');
  ok(r.j.skills.every((s) => s.name.includes('alpha')), '命中的名字都含 alpha');
  ok(r.j.matched === 2 && r.j.total === 4, 'matched 和 total 分别报');
  r = await api('/api/skills?q=ALPHA');
  ok(r.j.skills.length === 2, '大写也能搜到（不区分大小写）');
  r = await api('/api/skills?q=beta');
  ok(r.j.skills.length === 1 && r.j.skills[0].name === 'beta-skill', '搜 beta 命中 1 个');
  r = await api('/api/skills?q=不存在的名字');
  ok(r.j.skills.length === 0 && r.j.matched === 0, '搜不到返回空列表（不是报错）');
  ok(r.j.total === 4, '搜不到时 total 仍是全部数量');

  console.log('\n[4] 按来源电脑筛');
  r = await api('/api/skills?from=Q-A');
  ok(r.j.skills.length === 2 && r.j.skills.every((s) => s.from === 'Q-A'), '来自 Q-A 的 2 个');
  r = await api('/api/skills?from=Q-B');
  ok(r.j.skills.length === 2 && r.j.skills.every((s) => s.from === 'Q-B'), '来自 Q-B 的 2 个');
  r = await api('/api/skills?from=没有这台');
  ok(r.j.skills.length === 0, '来源不存在返回空');

  console.log('\n[5] 按安装状态筛');
  r = await api('/api/skills?state=ok');
  ok(r.j.skills.every((s) => Object.values(s.states || {}).includes('ok')), 'state=ok 全是「某台已装最新」的');
  ok(r.j.skills.length >= 1, '至少有 alpha 是两台都装了的');
  r = await api('/api/skills?state=none');
  ok(r.j.skills.every((s) => Object.values(s.states || {}).includes('none')), 'state=none 全是「某台完全没装」的');
  ok(r.j.skills.some((s) => s.states['Q-C'] === 'none'), 'Q-C 上没装的都算 none');
  r = await api('/api/skills?state=diff');
  ok(r.j.skills.every((s) => Object.values(s.states || {}).includes('diff')), 'state=diff 全是版本不同的');

  console.log('\n[6] 按电脑筛 + 只看没装齐的');
  r = await api('/api/skills?machine=Q-A');
  ok(r.j.skills.length === 4, 'Q-A 相关的都列出来');
  ok(r.j.skills.every((s) => s.states['Q-A'] !== undefined), '每条都有 Q-A 的状态');
  r = await api('/api/skills?machine=Q-C&missing=1');
  ok(r.j.skills.length === 4, 'Q-C 上一个都没装 → 4 个都没装齐');
  ok(r.j.skills.every((s) => s.states['Q-C'] !== 'ok'), '都是 Q-C 上不是 ok 的');
  r = await api('/api/skills?machine=Q-A&missing=1');
  ok(r.j.skills.every((s) => s.states['Q-A'] !== 'ok'), '只留 Q-A 上不是 ok 的');
  ok(r.j.skills.length < 4, 'Q-A 装了一部分，所以比 4 少');

  console.log('\n[7] 条件组合');
  r = await api('/api/skills?q=alpha&from=Q-B');
  ok(r.j.skills.length === 1 && r.j.skills[0].name === 'alphabet-x', '名字 + 来源一起筛');
  r = await api('/api/skills?machine=Q-C&missing=1&from=Q-A');
  ok(r.j.skills.length === 2 && r.j.skills.every((s) => s.from === 'Q-A'), '三个条件一起筛也对');

  console.log('\n[8] 看技能里的文件清单');
  r = await api('/api/skills/alpha-skill');
  ok(r.status === 200, '详情接口正常');
  ok(r.j.fileList && r.j.fileList.length === 2, '2 个文件');
  ok(r.j.fileList.some((f) => f.p === 'SKILL.md'), 'SKILL.md 在');
  ok(r.j.fileList.some((f) => f.p === 'ref/note.txt'), '子目录里的文件也在');
  ok(r.j.fileList.every((f) => typeof f.size === 'number' && f.size > 0), '每个文件有大小');
  r = await api('/api/skills/没有这个技能');
  ok(r.status === 404, '不存在的技能返回 404');

  console.log('\n[9] 删除后查询也不该把它翻出来');
  await api('/api/skills/delete', { method: 'POST', body: JSON.stringify({ ids: ['beta-skill'] }) });
  r = await api('/api/skills');
  ok(r.j.skills.length === 3 && !r.j.skills.some((s) => s.name === 'beta-skill'), '删了就没了');
  r = await api('/api/skills?q=beta');
  ok(r.j.skills.length === 0, '搜也搜不到了');

  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
