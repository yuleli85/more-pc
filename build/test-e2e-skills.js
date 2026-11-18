// 端到端：跑真的 agent.js，在两台「电脑」各自的技能目录里放技能，看是不是真能自动互通
// 用 HOME 变量把两台的 ~/.workbuddy 隔开（agent 认 HOME）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8811, KEY = 'e2e-skill-key';
const DATA = path.join(__dirname, 'testdata-e2e-skills');
const ROOT = path.join(__dirname, 'e2e-homes');
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

// 两台假电脑：各自的 HOME，各自的技能目录
function makeHome(name) {
  const h = path.join(ROOT, name);
  fs.mkdirSync(path.join(h, '.workbuddy', 'skills'), { recursive: true });
  return h;
}
function startAgent(name, home) {
  const p = spawn(process.execPath, [AGENT, '--hub', B, '--key', KEY, '--name', name], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FLEET_NO_UPDATE: '1', FLEET_CHANNEL: 'cli' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ` + d));
  return p;
}
async function api(p, opt = {}) {
  const r = await fetch(B + p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY } });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const skillDir = (home, n) => path.join(home, '.workbuddy', 'skills', n);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }

  const homeA = makeHome('pcA'), homeB = makeHome('pcB');
  const a1 = startAgent('E2E-A', homeA);
  const b1 = startAgent('E2E-B', homeB);

  console.log('\n[1] 两台连上来');
  let state = null;
  for (let i = 0; i < 40; i++) { await sleep(1000); state = (await api('/api/state')).j; if (state.machines.filter((m) => m.online).length >= 2) break; }
  ok(state.machines.filter((m) => m.online).length >= 2, '两台都上线了');

  console.log('\n[2] A 上开发一个技能 → B 自动装上');
  fs.mkdirSync(skillDir(homeA, 'e2e-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillDir(homeA, 'e2e-skill'), 'SKILL.md'), '# E2E 技能\n这是 A 开发的。\n', 'utf8');
  fs.mkdirSync(path.join(skillDir(homeA, 'e2e-skill'), 'ref'), { recursive: true });
  fs.writeFileSync(path.join(skillDir(homeA, 'e2e-skill'), 'ref', 'note.txt'), '参考资料', 'utf8');

  let got = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (fs.existsSync(path.join(skillDir(homeB, 'e2e-skill'), 'SKILL.md'))) { got = true; break; }
  }
  ok(got, 'B 上自动出现了这个技能');
  if (got) {
    const content = fs.readFileSync(path.join(skillDir(homeB, 'e2e-skill'), 'SKILL.md'), 'utf8');
    ok(content.includes('这是 A 开发的'), '内容一字不差');
    ok(fs.existsSync(path.join(skillDir(homeB, 'e2e-skill'), 'ref', 'note.txt')), '子目录里的文件也带过去了');
  }

  console.log('\n[3] A 上改了技能 → B 自动更新');
  fs.writeFileSync(path.join(skillDir(homeA, 'e2e-skill'), 'SKILL.md'), '# E2E 技能\n改过了，加了一行。\n', 'utf8');
  let upd = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const c = fs.readFileSync(path.join(skillDir(homeB, 'e2e-skill'), 'SKILL.md'), 'utf8');
      if (c.includes('改过了')) { upd = true; break; }
    } catch {}
  }
  ok(upd, 'B 上的技能自动更新到新版');

  console.log('\n[4] 总控网页上能看到这个技能');
  // B 刚装完新版还在上报途中，等它报上来（这是真实的瞬态，不是 bug）
  let st2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    st2 = (await api('/api/skills')).j.skills;
    if (st2[0] && st2[0].states['E2E-B'] === 'ok') break;
  }
  ok(st2.length === 1 && st2[0].name === 'e2e-skill', '注册表里有');
  ok(st2[0].from === 'E2E-A', '记着来自 A');
  ok(st2[0].states['E2E-A'] === 'ok', 'A 上是最新版');
  ok(st2[0].states['E2E-B'] === 'ok', 'B 上也是最新版');

  console.log('\n[5] 在 B 上删掉 → 不自动装回（用户定的规矩）');
  fs.rmSync(skillDir(homeB, 'e2e-skill'), { recursive: true, force: true });
  await sleep(12000); // 等 agent 发现删了并上报
  ok(!fs.existsSync(skillDir(homeB, 'e2e-skill')), 'B 上删了没被装回来');
  const sk2 = (await api('/api/skills')).j.skills;
  ok(sk2[0].states['E2E-B'] === 'removed', '页面上标成「已删」（实际：' + sk2[0].states['E2E-B'] + '）');

  console.log('\n[6] 点「推送到全部」→ B 装回来');
  await api('/api/skills/push', { method: 'POST', body: JSON.stringify({ id: 'e2e-skill' }) });
  let back = false;
  for (let i = 0; i < 30; i++) { await sleep(1000); if (fs.existsSync(path.join(skillDir(homeB, 'e2e-skill'), 'SKILL.md'))) { back = true; break; } }
  ok(back, 'B 上装回来了');
  // 装完要等它上报一次，状态才变回「已装」
  let sk3 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    sk3 = (await api('/api/skills')).j.skills;
    if (sk3[0] && sk3[0].states['E2E-B'] === 'ok') break;
  }
  ok(sk3[0].states['E2E-B'] === 'ok', '状态变回「已装」');

  a1.kill(); b1.kill();
  console.log(`\n全部通过：${pass} 项`);
  hub.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); hub.kill(); process.exit(1); });
