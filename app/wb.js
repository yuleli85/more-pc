#!/usr/bin/env node
// WorkBuddy 总控的终端：在任何一台电脑上向云主机派活、看各台状态、实时看结果。只用 Node 自带模块（Node 18+）。
// 地址和口令放在同目录的 wb.json：{"hub":"http://云主机:8790","key":"口令"}，装终端的脚本会写好。
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = path.join(__dirname, 'wb.json');
const cfg = fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')) : {};
const HUB = (process.env.WB_HUB || cfg.hub || '').replace(/\/$/, '');
const KEY = process.env.WB_KEY || cfg.key || '';
const ST = { queued: '排队', sent: '已发出', running: '在干', done: '完成', failed: '没成', stopped: '已停' };
const PRIO = ['紧急', '重要', '加大力度发展'];
const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const time = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/^\d+\//, '') : '');

const HELP = `用法：
  wb                       看各台电脑状态和最近的任务
  wb 派 "要干什么"          派给空闲的电脑，实时显示进度，做完显示结果
     选项：--每台（每台都做一遍）  --给 电脑A,电脑B（只在这几台里派）
           --紧急 / --发展（默认「重要」）  --文件夹 路径  --接在 任务号  --git（拉推代码）
           --每行一件（指令里每行算一件活）  --不等（发出去就返回）
  wb 看 任务号              看一件任务的进度和结果（没做完会等到做完）
  wb 停 任务号              停掉一件任务
  wb 任务                   列最近 20 件任务
（英文也行：status / send / show / stop / tasks）`;

async function api(p, opt = {}) {
  if (!HUB || !KEY) { console.error('还没设总控地址和口令，请重跑装终端那一行命令'); process.exit(2); }
  let res;
  try {
    res = await fetch(HUB + p, { ...opt, headers: { 'X-Fleet-Key': KEY, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  } catch (e) { console.error(`连不上总控 ${HUB}：${e.cause?.code || e.message}`); process.exit(3); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`总控说：${j.error || res.status}`); process.exit(4); }
  return j;
}

function runsLine(runs) {
  const e = Object.entries(runs || {});
  if (!e.length) return c(33, '等空闲电脑');
  return e.map(([n, r]) => `${n} ${r.status === 'done' ? c(32, ST[r.status]) : r.status === 'failed' ? c(31, ST[r.status]) : ST[r.status] || r.status}`).join('  ');
}

async function status() {
  const s = await api('/api/state');
  const on = s.machines.filter((m) => m.online).length;
  console.log(c(1, `电脑：${on} 台在线 / 共 ${s.machines.length} 台`) + `   总控 ${HUB}`);
  for (const m of s.machines) {
    const st = !m.online ? c(90, '离线') : m.busy ? c(33, '在干活') : m.idle ? c(32, '空闲') : c(33, 'CPU 忙');
    console.log(`  ${m.online ? c(32, '●') : c(90, '○')} ${m.name.padEnd(12)} ${st}  CPU ${m.cpu ?? '-'}%  ${m.os || ''}  ${m.online ? '' : '最后在线 ' + time(m.lastSeen)}`);
  }
  if (!s.machines.length) console.log('  还没有电脑连上来');
  console.log(c(1, '\n最近的任务：'));
  listTasks(s.tasks.slice(0, 10));
}

function listTasks(ts) {
  if (!ts.length) return console.log('  还没发过任务');
  for (const t of ts) {
    console.log(`  ${c(36, t.id)} ${time(t.createdAt)} [${PRIO[t.prio] || ''}] ${t.prompt.replace(/\s+/g, ' ').slice(0, 50)}`);
    console.log(`      ${t.stopped ? '已停 ' : ''}${runsLine(t.runs)}${t.note ? '  ' + t.note : ''}`);
  }
}

async function follow(id, wait = true) {
  let since = 0; const seen = {};
  for (;;) {
    const t = await api(`/api/tasks/${id}?since=${since}`);
    for (const [n, r] of Object.entries(t.runs)) {
      if (seen[n] !== r.status) { console.log(c(1, `【${n}】${ST[r.status] || r.status}`)); seen[n] = r.status; }
      for (const it of r.items || []) {
        since = Math.max(since, it.at);
        if (it.t === 'tool') console.log(c(90, `  · ${it.s.split('\n')[0].slice(0, 160)}`));
        else if (it.t === 'text') console.log('  ' + it.s.replace(/\n/g, '\n  '));
      }
    }
    const runs = Object.values(t.runs);
    const fin = t.stopped || (runs.length && runs.every((r) => ['done', 'failed', 'stopped'].includes(r.status)));
    if (fin) {
      for (const [n, r] of Object.entries(t.runs)) {
        console.log(c(1, `\n===== ${n}：${ST[r.status] || r.status}${r.endedAt && r.startedAt ? `，用时 ${Math.round((r.endedAt - r.startedAt) / 1000)} 秒` : ''} =====`));
        if (r.result) console.log(r.result);
        if (r.error) console.log(c(31, r.error));
      }
      if (t.stopped && !runs.length) console.log('这件已停，没开始做');
      return runs.every((r) => r.status === 'done') ? 0 : 1;
    }
    if (!wait) { console.log(`还没做完：${runsLine(t.runs)}`); return 0; }
    if (!runs.length && !follow.told) { console.log(c(33, '电脑都在忙，排着队，谁先空下来谁接…')); follow.told = true; }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function send(args) {
  const o = { mode: 'pool', prio: 1 }; const words = []; let wait = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--每台' || a === '--all') o.mode = 'all';
    else if (a === '--给' || a === '--to') o.targets = String(args[++i] || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    else if (a === '--紧急' || a === '--urgent') o.prio = 0;
    else if (a === '--重要') o.prio = 1;
    else if (a === '--发展' || a === '--later') o.prio = 2;
    else if (a === '--文件夹' || a === '--dir') o.workdir = args[++i];
    else if (a === '--接在' || a === '--after') o.after = args[++i];
    else if (a === '--git') o.git = true;
    else if (a === '--每行一件' || a === '--split') o.split = true;
    else if (a === '--不等' || a === '--nowait') wait = false;
    else words.push(a);
  }
  o.prompt = words.join(' ').trim();
  if (!o.prompt && !process.stdin.isTTY) o.prompt = fs.readFileSync(0, 'utf8').trim(); // 也可以从管道读：cat 需求.txt | wb 派
  if (!o.prompt) { console.error('要干什么没写。例：wb 派 "把 Downloads 里的发票按月份整理好"'); process.exit(1); }
  const t = await api('/api/tasks', { method: 'POST', body: JSON.stringify(o) });
  const ids = t.ids || [t.id];
  console.log(`已派出 ${ids.length} 件，任务号 ${ids.map((x) => c(36, x)).join(' ')}（${o.mode === 'all' ? '每台都做一遍' : '派给空闲的电脑'}）`);
  if (!wait || ids.length > 1) { console.log('看进度：wb 看 任务号'); return 0; }
  console.log(c(90, '（按 Ctrl+C 只是不看了，任务照样在跑；之后用 wb 看 ' + ids[0] + '）'));
  return follow(ids[0]);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  let code = 0;
  if (!cmd || cmd === '状态' || cmd === 'status') await status();
  else if (cmd === '派' || cmd === 'send') code = await send(rest);
  else if (cmd === '看' || cmd === 'show') { if (!rest[0]) { console.error('要写任务号'); process.exit(1); } code = await follow(rest[0], !rest.includes('--不等')); }
  else if (cmd === '停' || cmd === 'stop') { await api(`/api/tasks/${rest[0]}/stop`, { method: 'POST', body: '{}' }); console.log('已叫停'); }
  else if (cmd === '任务' || cmd === 'tasks') listTasks((await api('/api/state')).tasks.slice(0, 20));
  else if (cmd === '-h' || cmd === '--help' || cmd === '帮助' || cmd === 'help') console.log(HELP);
  else { console.log(`不认识「${cmd}」\n\n${HELP}`); code = 1; }
  process.exit(code);
})();
