// 隔离测试：提示词记录（接口层）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 8800, KEY = 'test-key-prompt';
const DATA = path.join(__dirname, 'testdata-prompt');
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
const poll = (body, ms = 1200) => api('/api/agent/poll', { method: 'POST', body: JSON.stringify(body) });
const create = (b) => api('/api/tasks', { method: 'POST', body: JSON.stringify(b) }).then((r) => r.j);

(async () => {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  await poll({ name: 'P-A', os: 'win32', host: 'P-A', agentVersion: '1.9.1', cli: 'x', workdir: 'C:\\w', cpu: 5 });

  console.log('\n[1] 发一条任务 → 自动记一条');
  let r = await api('/api/prompts');
  ok(r.status === 200 && r.j.prompts.length === 0, '一开始是空的');
  await create({ mode: 'pool', prompt: '把桌面上的发票按月份整理好', targets: ['P-A'], expert: 'senior-developer', model: 'deepseek-v4.1-flash', workdir: 'C:\\work\\demo', git: true });
  await sleep(200);
  r = await api('/api/prompts');
  ok(r.j.prompts.length === 1, '记下了 1 条');
  const p1 = r.j.prompts[0];
  ok(p1.text === '把桌面上的发票按月份整理好', '文字一致');
  ok(p1.expert === 'senior-developer' && p1.model === 'deepseek-v4.1-flash', '专家、模型一起记了');
  ok(p1.workdir === 'C:\\work\\demo' && p1.git === true && p1.mode === 'pool', '目录、Git、派法都记了');
  ok(!!p1.taskId && !!p1.id && !!p1.at, '有任务号、自身编号、时间');
  ok(p1.targets === 1, '目标台数记了');

  console.log('\n[2] 每行算一件活 → 每行记一条');
  await create({ mode: 'pool', prompt: '第一件事\n第二件事\n第三件事', targets: ['P-A'], split: true });
  await sleep(200);
  r = await api('/api/prompts');
  ok(r.j.prompts.length === 4, '总共 4 条（1 + 3）');
  ok(r.j.prompts.slice(0, 3).every((x) => /第[一二三]件事/.test(x.text)), '最近 3 条就是那三行');

  console.log('\n[3] 升级类系统任务不记');
  const before = (await api('/api/prompts')).j.prompts.length;
  await poll({ name: 'P-OLD', os: 'win32', host: 'P-OLD', agentVersion: '1.5.0', cli: 'x', workdir: 'C:\\w', cpu: 3 }, 1500);
  await sleep(300);
  const after = (await api('/api/prompts')).j.prompts.length;
  ok(after === before, '旧版机器触发的升级任务没混进提示词');

  console.log('\n[4] 超长提示词：列表截断、单条取全文');
  const long = '很长的提示词'.repeat(800); // 4800 字
  await create({ mode: 'all', prompt: long, targets: ['P-A'] });
  await sleep(200);
  r = await api('/api/prompts');
  const pl = r.j.prompts[0];
  ok(pl.cut === true && pl.text.length === 4000 && pl.len === 4800, '列表里截到 4000 字并标了 cut');
  const full = await api('/api/prompts/' + pl.id);
  ok(full.status === 200 && full.j.text.length === 4800, '单条能取到全文');

  console.log('\n[5] 搜索不需要后端（前端过滤），但删除要');
  const ids = (await api('/api/prompts')).j.prompts.slice(0, 2).map((x) => x.id);
  const d1 = await api('/api/prompts/delete', { method: 'POST', body: JSON.stringify({ ids }) });
  ok(d1.status === 200 && d1.j.removed === 2, '批量删掉 2 条');
  const d2 = await api('/api/prompts/delete', { method: 'POST', body: JSON.stringify({ ids: ['ffffffffffff'] }) });
  ok(d2.status === 404, '删不存在的返回 404');
  const d3 = await api('/api/prompts/delete', { method: 'POST', body: JSON.stringify({ ids: [] }), headers: {} });
  ok(d3.status === 401, '没口令删不了');

  console.log('\n[6] 重启后还在（存进了 state.json）');
  const total = (await api('/api/prompts')).j.total;
  ok(total === 3, `重启前 ${total} 条`);
  hub.kill();
  await sleep(1200);
  hub = startHub();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  const r2 = await api('/api/prompts');
  ok(r2.j.total === 3, '重启后条数没变');
  ok(r2.j.prompts.some((x) => x.text.includes('发票')) && r2.j.prompts[0].text === '第二件事', '内容和顺序也都还在');

  console.log('\n[7] 老数据补录（只补一次，删光后不复活）');
  hub.kill();
  await sleep(1200);
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  st.prompts = [];
  delete st.promptsMigrated;
  st.tasks = [{ id: 'aaaabbbbcccc', mode: 'all', pool: [], after: null, git: false, prio: 1, prompt: '历史任务里的提示词', cont: false, workdir: '', expert: '', model: '', createdAt: Date.now() - 3600e3, runs: {} }];
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(st));
  hub = startHub();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  let rm = await api('/api/prompts');
  ok(rm.j.total === 1 && rm.j.prompts[0].text === '历史任务里的提示词', '老任务里的提示词补录进来了');

  await api('/api/prompts/delete', { method: 'POST', body: JSON.stringify({ ids: rm.j.prompts.map((x) => x.id) }) });
  await sleep(900);
  hub.kill();
  await sleep(1200);
  hub = startHub();
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/healthz')).ok) break; } catch {} await sleep(200); }
  rm = await api('/api/prompts');
  ok(rm.j.total === 0, '删光后重启不会把老任务再补一遍');

  console.log('\n[8] 页面上有这个入口');
  const html = await (await fetch(B + '/')).text();
  ok(html.includes('data-view="prompts"'), '顶部有「提示词」页签');
  ok(html.includes('id="viewPrompts"') && html.includes('id="plist"'), '有提示词视图容器');
  ok(html.includes('data-puse') && html.includes('data-pcopy'), '渲染脚本里有「拿去用」「复制」');

  console.log(`\n接口测试全部通过：${pass} 项\n`);
  hub.kill();
  process.exit(0);
})().catch((e) => { console.error('\n' + e.message + '\n'); hub.kill(); process.exit(1); });
