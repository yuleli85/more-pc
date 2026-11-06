#!/usr/bin/env node
// 多台电脑 WorkBuddy 总控：网页入口 + 中转站。每台电脑上的连接程序主动连进来领任务，
// 所以电脑在不在同一个网络、有没有公网 IP 都不要紧。只用 Node 自带模块（Node 18+）。
// 两种派法：派给空闲的（默认，一件活只给一台：挑手上没活、CPU 最闲的；都忙就排着，谁先空谁接），
//          每台都做一遍（同一条指令所有选中的电脑各做一次）。
// 接力：一件活可以接在另一件后面（after），等那件做完、带上它的结果再开工，优先交给做那件的电脑（文件就在那台，不用同步）。
// 分级：每件活有级别（0 紧急、1 重要、2 加大力度发展），等电脑的活先派紧急的，紧急的派完才派重要的，再派加大力度发展的；同级按先来后到。
// 飞书表：data/feishu-board.json 在就接上（见 feishu-board.js），表里填缺陷或功能，自动判级别、派活、把进度写回表里。
//
// 用法：node hub.js            （默认端口 8790，数据放 ./data）
//   环境变量：PORT、HOST（默认 0.0.0.0）、DATA_DIR、FLEET_KEY（不填首次启动自动生成并存下）、
//            PUBLIC_URL（对外地址，生成加入命令用；不填按访问的地址推断）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HERE = __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 口令 ----------
// KEY 是「机器口令」：连接程序、加入/升级脚本用它，尽量别动（改了每台电脑都得重跑加入命令）
const keyFile = path.join(DATA_DIR, 'key.txt');
let KEY = (process.env.FLEET_KEY || '').trim();
if (!KEY) {
  if (fs.existsSync(keyFile)) KEY = fs.readFileSync(keyFile, 'utf8').trim();
  else { KEY = crypto.randomBytes(12).toString('base64url'); fs.writeFileSync(keyFile, KEY + '\n', { mode: 0o600 }); }
}
const keyOk = (k) => typeof k === 'string' && k.length === KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(KEY));

// ---------- 网页登录 ----------
// PASS 是「人」用的登录口令：打开网页要输它。跟机器口令分开，改了不影响连接程序。
const passFile = path.join(DATA_DIR, 'pass.txt');
let PASS = (process.env.FLEET_PASS || '').trim();
if (!PASS) {
  if (fs.existsSync(passFile)) PASS = fs.readFileSync(passFile, 'utf8').trim();
  if (!PASS) { PASS = KEY; fs.writeFileSync(passFile, PASS + '\n', { mode: 0o600 }); } // 第一次就用原口令，不折腾
}
function savePass(p) {
  PASS = p;
  try { fs.writeFileSync(passFile, p + '\n', { mode: 0o600 }); } catch (e) { console.error('[保存口令失败]', e.message); }
}
function passOk(p) {
  const a = Buffer.from(String(p == null ? '' : p));
  const b = Buffer.from(PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 会话：登录后发一个 HttpOnly Cookie，30 天有效；只放内存，重启后要重新登录一次
const sessions = new Map(); // token -> { exp, ip }
const SESSION_MS = 30 * 86400e3;
// 客户端地址：默认只认真实连接地址（放在反代后面时设 TRUST_PROXY=1 才信 X-Forwarded-For，
// 否则谁都能伪造这个头绕过登录限速）
const TRUST_PROXY = !!process.env.TRUST_PROXY;
function ipOf(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function cookieOf(req) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'wb_fleet') return part.slice(i + 1).trim();
  }
  return '';
}
function sessionOk(req) {
  const t = cookieOf(req);
  if (!t) return false;
  const s = sessions.get(t);
  if (!s) return false;
  if (Date.now() > s.exp) { sessions.delete(t); return false; }
  return true;
}
function newSession(req) {
  const t = crypto.randomBytes(24).toString('base64url');
  sessions.set(t, { exp: Date.now() + SESSION_MS, ip: ipOf(req) });
  return t;
}
// 登录失败限速：同一个地址连错 5 次，锁 5 分钟，防止有人拿脚本一直猜
const loginFails = new Map(); // ip -> { n, until }
const FAIL_MAX = 5, LOCK_MS = 300e3;
function lockedFor(req) {
  const ip = ipOf(req), f = loginFails.get(ip);
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { loginFails.delete(ip); return 0; }
  return left;
}
function touchFail(req) {
  const ip = ipOf(req);
  const f = loginFails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= FAIL_MAX) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  loginFails.set(ip, f);
  return f;
}
// 网页：有会话、或者带对了口令，都算进来了
const authOk = (req, key) => sessionOk(req) || keyOk(key);
setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (now > s.exp) sessions.delete(t); }, 3600e3).unref();

// ---------- 状态 ----------
// machines: name -> { name, os, host, agentVersion, cli, workdir, cpu, lastSeen, lastJobAt, busy, waiter }
// tasks: [{ id, mode: 'pool'|'all', pool: [能接的电脑，空=全部], after: 接在哪件后面, git, stopped, note, prompt, cont, workdir, createdAt,
//           runs: { name: { status, items[], startedAt, endedAt, result, error } } }]
// 派给空闲的任务还没找到电脑时 runs 是空的（等空闲电脑）
const machines = new Map();
let tasks = [];
let machineDirs = {}; // 每台电脑的默认干活目录（网页上可改，覆盖连接程序上报的默认值）
// prompts: 每次提交的提示词都留一份，网页上「提示词」页看
// [{ id, text, at, mode, src, expert, model, workdir, taskId, targets, git }]
let prompts = [];
const PROMPT_MAX = 1000;   // 最多留最近 1000 条
const PROMPT_TEXT_MAX = 20000; // 单条最长（跟任务的 prompt 上限一致）
let promptsMigrated = false;   // 老版本升上来时补录过一次没有
let needPromptMigrate = false;
const stateFile = path.join(DATA_DIR, 'state.json');
try {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  tasks = s.tasks || [];
  machineDirs = s.machineDirs || {};
  prompts = s.prompts || [];
  promptsMigrated = !!s.promptsMigrated;
  needPromptMigrate = !promptsMigrated && !prompts.length && tasks.length > 0;
  for (const m of s.machines || []) machines.set(m.name, { ...m, waiter: null, busy: null });
  // 重启前还在跑的，标成中断
  for (const t of tasks) for (const r of Object.values(t.runs)) if (r.status === 'running' || r.status === 'sent') { r.status = 'failed'; r.error = '总控重启，这次中断了'; r.endedAt = Date.now(); }
} catch { /* 第一次启动 */ }

let saveTimer = null;
function writeState() {
  const ms = [...machines.values()].map(({ waiter, busy, ...m }) => m);
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ machines: ms, tasks: tasks.slice(-200), machineDirs, prompts: prompts.slice(-PROMPT_MAX), promptsMigrated }));
  fs.renameSync(tmp, stateFile);
}
// 删除这类「删了就不该复活」的操作直接落盘，不等防抖
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { writeState(); } catch (e) { console.error('[保存状态失败]', e.message); }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeState();
  }, 500);
}
// 记一条提示词（升级类系统任务不记）
function recordPrompt(t) {
  if (!t || t.kind === 'upgrade' || !t.prompt) return;
  prompts.push({
    id: crypto.randomBytes(6).toString('hex'),
    text: String(t.prompt).slice(0, PROMPT_TEXT_MAX),
    at: t.createdAt || Date.now(),
    mode: t.mode === 'pool' ? 'pool' : 'all',
    src: t.src || '',
    expert: t.expert || '',
    model: t.model || '',
    workdir: t.workdir || '',
    taskId: t.id || '',
    targets: Object.keys(t.runs || {}).length || (t.pool || []).length || 0,
    git: !!t.git,
    prio: t.prio === 0 || t.prio === 1 || t.prio === 2 ? t.prio : null,
  });
  if (prompts.length > PROMPT_MAX) prompts.splice(0, prompts.length - PROMPT_MAX);
}
// 从老版本第一次升上来：把手上已有任务里的提示词补进提示词库，免得上线后一片空白（只补一次）
if (needPromptMigrate) {
  for (const t of tasks) recordPrompt(t);
  promptsMigrated = true;
  needPromptMigrate = false;
  save();
}

const ONLINE_MS = 45000;
const LOST_MS = +(process.env.LOST_MS || 180000); // 干活中掉线超过这么久才算没了，短暂断网不折腾
const online = (m) => Date.now() - m.lastSeen < ONLINE_MS;
const MAX_ITEMS = 3000;
const BUSY_CPU = 85; // 电脑本身 CPU 到这么高（有人在用或在跑别的），先不派活给它

const byId = (id) => tasks.find((x) => x.id === id);

// ---------- 专家 / 模型 ----------
// 连接程序把这两个值拼到命令行上：--agent <专家> --model <模型>。
// 只有 1.7.0 以后的连接程序才认这两个字段；老连接程序会当没看见，所以按版本卡住，不让它"静默跑错"。
const AGENT_LATEST = '1.10.1';
const AGENT_MIN = '1.7.0'; // 1.7.0 起支持指定专家/模型；1.8.0 起会回报本机可干活目录
const AGENT_SESSION_MIN = '1.10.1'; // 1.10.0 起支持「接着指定会话」＋回报客户端会话 id
// 只允许字母数字开头的安全串：绝不能以 - 开头，否则可能被当成命令行参数
const SPECIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
function cleanSpecial(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (!SPECIAL_RE.test(v)) return '';
  return v;
}
function verNum(v) {
  const p = String(v || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}
function cmpVer(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
const agentSupports = (m) => !!m && cmpVer(m.agentVersion, AGENT_MIN) >= 0;
const agentSessionSupports = (m) => !!m && cmpVer(m.agentVersion, AGENT_SESSION_MIN) >= 0;

// 兜底默认：页面上不选时就用这两个
const DEFAULT_EXPERT = 'senior-developer';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';

// 内置清单：装的专家不止这些也行，各台电脑上报的会并进来
const EXPERTS = [
  { id: 'senior-developer', name: '高级开发工程师' },
  { id: 'data-engineer', name: '数据工程师' },
  { id: 'modern-webapp', name: '现代 Web 应用' },
  { id: 'qa-testing', name: '测试工程师' },
  { id: 'tomato-best-seller-novel', name: '番茄畅销小说' },
];
const MODELS = [
  { id: '', name: '默认（用那台电脑自己的设置）' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash（快）' },
  { id: 'deep-model', name: 'Deep（通用深思考）' },
  { id: 'balanced-model', name: 'Balanced（均衡）' },
  { id: 'fast-model', name: 'Fast（最快）' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { id: 'glm-5.3', name: 'GLM 5.3' },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash' },
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro' },
  { id: 'step-5-preview', name: 'Step 5 Preview' },
  { id: 'hy3', name: 'HY3' },
  { id: 'hy3-x', name: 'HY3-X' },
  { id: 'hy4-preview', name: 'HY4 Preview' },
  { id: 'kimi-k3-1', name: 'Kimi K3.1' },
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview' },
];
// 每台电脑上报的专家（连接程序扫本机装的专家包）
function expertsFor(m) {
  const list = (m && Array.isArray(m.experts) ? m.experts : []).filter((x) => x && x.id);
  return list;
}
function expertChoices() {
  const map = new Map();
  for (const e of EXPERTS) map.set(e.id, e);
  for (const m of machines.values()) for (const e of expertsFor(m)) if (!map.has(e.id)) map.set(e.id, e);
  return [...map.values()];
}
const expertLabel = (id) => ((EXPERTS.find((e) => e.id === id) || {}).name || id);
// 降级兜底：本机真加载不了专家（连接程序太旧 / 没装那个专家包）时，
// 把专家的人物设定直接写进任务说明，让它"以这个专家的身份干活"——不是静默按默认跑。
const EXPERT_PERSONA = {
  'senior-developer': '你现在以「高级开发工程师」专家（senior-developer）的身份工作：按 10 年以上全栈工程师的标准做事，先给方案再动手，代码要能直接跑，处理好边界与异常，交付前自己过一遍。',
};
function personaFor(expert) {
  return EXPERT_PERSONA[expert] || `你现在以「${expertLabel(expert)}」专家（${expert}）的身份工作，严格按这个专家的专业标准完成下面的任务。`;
}



// ---------- 干活目录（任务级 / 每台默认）----------
// 关键：网页上填的相对路径（例如 linmo-pig-full）要按“那台电脑的默认目录”展开成绝对路径再下发。
// 否则连接程序会把它解析成自己进程目录下的子目录，命令行打不开就报 automation-workspace-unavailable。
const isAbsDir = (p) => /^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(String(p || ''));
function joinDir(base, rel) {
  const b = String(base || '').replace(/[\\/]+$/, '');
  const parts = String(rel || '').split(/[\\/]+/).filter((x) => x && x !== '.');
  if (!parts.length) return b;
  const sep = b.includes('\\') ? '\\' : '/';
  return b + sep + parts.join(sep);
}
// 这台电脑的默认目录：网页上设过的优先，否则用连接程序上报的
function baseDirOf(name) {
  const set = machineDirs[name];
  if (set) return set;
  const m = machines.get(name);
  return (m && m.workdir) || '';
}
// 某件任务在某台电脑上的真实绝对目录
function dirFor(t, name) {
  const base = baseDirOf(name);
  const want = String((t && t.workdir) || '').trim();
  if (!want) return base;
  if (isAbsDir(want)) return want;
  return base ? joinDir(base, want) : want;
}

let board = null; // 接了飞书表才有
const PRIO_NAMES = ['紧急', '重要', '加大力度发展'];
const prioOf = (t) => (t.prio === 0 || t.prio === 1 || t.prio === 2 ? t.prio : 1);
const byPrio = (a, b) => prioOf(a) - prioOf(b) || a.createdAt - b.createdAt;
// 前一件的情况：没有前一件或已做成 ok；还在做 wait；没做成 fail
function depState(t) {
  const d = t.after && byId(t.after);
  if (!d) return 'ok';
  const rs = Object.values(d.runs);
  if (unassigned(d) && !d.stopped) return 'wait';
  if (rs.some((r) => ['queued', 'sent', 'running'].includes(r.status))) return 'wait';
  return rs.some((r) => r.status === 'done') ? 'ok' : 'fail';
}
const unassigned = (t) => t.mode === 'pool' && !Object.keys(t.runs).length;
const pending = (t) => unassigned(t) && !t.stopped && depState(t) === 'ok';
const waitingDep = (t) => unassigned(t) && !t.stopped && depState(t) === 'wait';
// 做前一件的那台（接力时优先给它）和前一件的结果
function prevRun(t) {
  const d = t.after && byId(t.after);
  if (!d) return null;
  const e = Object.entries(d.runs).find(([, r]) => r.status === 'done');
  return e ? { task: d, name: e[0], result: e[1].result || '' } : null;
}
const prefer = (t) => { const p = prevRun(t); return p && p.name; };
const GIT_NOTE = '\n\n（这件活的代码由连接程序自动同步：开工前已拉好最新代码，做完会自动提交并推送，你不用自己运行 git pull、commit、push。）';
function jobPrompt(t) {
  let s = t.prompt;
  const p = prevRun(t);
  if (p) s = `上一步「${p.task.prompt.slice(0, 80)}」已经在「${p.name}」上做完，它的结果：\n${p.result}\n\n这一步：\n${t.prompt}`;
  return t.git ? s + GIT_NOTE : s;
}
// 前一件没做成的，这件也不开工
function settleDeps() {
  for (const t of tasks) if (unassigned(t) && !t.stopped && t.after && depState(t) === 'fail') { t.stopped = true; t.note = '上一步没做成，这步没开始'; }
}
const canTake = (t, name) => (!t.pool || !t.pool.length || t.pool.includes(name)) && capable(t, machines.get(name));
// 指定了专家/模型的活，只有认得这两个参数的连接程序（1.7.0+）才接得了
function capable(t, m) {
  if (!t.expert && !t.model) return true;
  return agentSupports(m);
}
const hasQueued = (name) => tasks.some((t) => t.runs[name] && t.runs[name].status === 'queued');
// 空闲：在线、手上没活、也没排着的活、CPU 不高
const idle = (m) => online(m) && !m.busy && !hasQueued(m.name) && (m.cpu || 0) < BUSY_CPU;

// 给某台电脑找下一件活：先做排给它自己的，再从「等空闲电脑」的活里领最早的一件
function nextJobFor(name) {
  for (const t of tasks) {
    const r = t.runs[name];
    if (r && r.status === 'queued') return { t, r };
  }
  const m = machines.get(name);
  if (!m || (m.cpu || 0) >= BUSY_CPU) return null;
  let list = tasks.filter((x) => pending(x) && canTake(x, name)).sort(byPrio);
  // 只在最高的那一级里挑：有紧急的就先做紧急的
  if (list.length) { const top = prioOf(list[0]); list = list.filter((x) => prioOf(x) === top); }
  // 先接自己上一步做的；别的电脑上一步的、那台正空着，留给那台
  const t = list.find((x) => prefer(x) === name) || list.find((x) => { const p = prefer(x), pm = p && machines.get(p); return !(pm && p !== name && idle(pm) && canTake(x, p)); });
  if (!t) return null;
  t.runs[name] = { status: 'queued', items: [] };
  return { t, r: t.runs[name] };
}
// 新来的活、退回来的活：挑最闲的空闲电脑（CPU 低的先，CPU 差不多就挑最久没派过活的），叫醒它来领
function assignPending() {
  settleDeps();
  for (const t of tasks.filter(pending).sort(byPrio)) {
    const cands = [...machines.values()].filter((m) => idle(m) && canTake(t, m.name));
    if (!cands.length) continue;
    const pf = prefer(t);
    cands.sort((a, b) => (b.name === pf) - (a.name === pf) || Math.round((a.cpu || 0) / 10) - Math.round((b.cpu || 0) / 10) || (a.lastJobAt || 0) - (b.lastJobAt || 0));
    const m = cands[0];
    t.runs[m.name] = { status: 'queued', items: [] };
    kick(m.name);
  }
  save();
}
// 派给空闲的活已经排给某台、它却掉线了：退回去重新派
function returnToPool(t, name) {
  if (t.mode !== 'pool') return false;
  delete t.runs[name];
  return true;
}
// 删任务（一件或一批）：正在跑的先在总控这边叫停（打取消标记 + 记 ghost，那台下次回报或来问就会停手），
// 然后任务本体直接移除；接在它后面、还没开工的接力活一并停掉，免得没头没尾地开跑。
function deleteTasks(ids) {
  const set = new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!set.size) return { removed: 0, stopped: [] };
  const stopped = [];
  for (const t of tasks) {
    if (!set.has(t.id)) continue;
    for (const [n, r] of Object.entries(t.runs)) {
      if (r.status === 'running' || r.status === 'sent') { r.cancel = true; ghostCancel(n, t.id); stopped.push(n); }
      else if (r.status === 'queued') { r.status = 'stopped'; r.endedAt = Date.now(); }
    }
    for (const m of machines.values()) if (m.busy === t.id) m.busy = null;
  }
  for (const t of tasks) {
    if (set.has(t.id) || !t.after || !set.has(t.after)) continue;
    if (unassigned(t) && !t.stopped) { t.stopped = true; t.note = '接的那件任务被删了，这步没开始'; }
  }
  const before = tasks.length;
  tasks = tasks.filter((t) => !set.has(t.id));
  saveNow();
  return { removed: before - tasks.length, stopped: [...new Set(stopped)] };
}
setInterval(() => {
  let moved = false;
  for (const t of tasks) for (const [n, r] of Object.entries(t.runs)) {
    const m = machines.get(n);
    if (m && online(m)) continue;
    // 排着的、发出去却一直没回音的（那台多半没收到）：派给空闲的退回去重派；每台都做的等它回来再做
    if (r.status === 'queued' && returnToPool(t, n)) moved = true;
    else if (r.status === 'sent') {
      if (m && m.busy === t.id) m.busy = null;
      if (returnToPool(t, n)) moved = true; else { r.status = 'queued'; r.startedAt = null; }
    }
    // 干到一半那台关机、断网好几分钟：派给空闲的转给别的电脑重做（它回来会被叫停，不会两台重复干）；每台都做的记成没做完
    else if (r.status === 'running' && m && Date.now() - m.lastSeen > LOST_MS) {
      if (m.busy === t.id) m.busy = null;
      if (returnToPool(t, n)) { t.note = `「${n}」干到一半掉线了，已转给别的电脑重做`; moved = true; }
      else { r.status = 'failed'; r.error = '这台干到一半掉线了（关机或断网），这件没做完，回来后请重发'; r.endedAt = Date.now(); moved = true; }
    }
  }
  if (moved || tasks.some((t) => unassigned(t) && !t.stopped)) assignPending();
}, 10000).unref();
// 删掉的任务还得让干它的那台停手，可任务已经从列表里没了、cancelsFor 找不到它，
// 所以先把要停的记在这儿，下次那台来问一起下发（10 分钟后自动过期，不会一直攒着）
const ghostCancels = new Map(); // name -> [{ id, at }]
function ghostCancel(name, id) {
  const a = (ghostCancels.get(name) || []).filter((x) => Date.now() - x.at < 600000);
  a.push({ id, at: Date.now() });
  ghostCancels.set(name, a);
}
function cancelsFor(name) {
  const ids = [];
  for (const t of tasks) {
    const r = t.runs[name];
    // 只要打了取消标记就下发：连接程序只在自己手上那个活号对得上时才真停，多带几个没副作用
    if (r && r.cancel) ids.push(t.id);
  }
  const g = (ghostCancels.get(name) || []).filter((x) => Date.now() - x.at < 600000);
  if (g.length) { ghostCancels.set(name, g); for (const x of g) ids.push(x.id); }
  return [...new Set(ids)].slice(-50);
}
// 有新活或要停的，马上叫醒正在等的那台
function kick(name) {
  const m = machines.get(name);
  if (!m || !m.waiter) return;
  const w = m.waiter; m.waiter = null; clearTimeout(w.timer);
  w.respond();
}
function dispatch(name, res) {
  const m = machines.get(name);
  const cancel = cancelsFor(name);
  let job = null;
  if (!m.busy) {
    const n = nextJobFor(name);
    if (n) {
      // 指定了专家/模型：本机能原生加载就原生；不能就降级兜底（专家写进任务说明），绝不把任务卡死
      const wantExpert = n.t.expert || '', wantModel = n.t.model || '';
      const native = agentSupports(m);
      const hasPkg = !wantExpert || expertsFor(m).some((e) => e.id === wantExpert);
      const nativeExpert = !!wantExpert && native && hasPkg;
      n.r.expertNote = '';
      n.r.modelNote = '';
      if (wantExpert && !nativeExpert) {
        n.r.expertNote = !native
          ? `这台连接程序 ${m.agentVersion || '未知版本'} 太旧，不能直接加载专家：已把「${expertLabel(wantExpert)}」的身份写进任务说明顶上（跑一次更新命令升级后自动改成原生加载）`
          : `这台没装「${expertLabel(wantExpert)}」专家包：已把它的身份写进任务说明顶上（在 WorkBuddy 里装好这个专家后自动改成原生加载）`;
      }
      if (wantModel && !native) {
        n.r.modelNote = `这台连接程序 ${m.agentVersion || '未知版本'} 太旧，模型「${wantModel}」这次没生效（用的是本机默认模型）；升级连接程序后自动生效`;
      }
      n.r.status = 'sent'; n.r.startedAt = Date.now(); m.busy = n.t.id; m.lastJobAt = Date.now();
      const dir = dirFor(n.t, name); // 换算成这台机器上的绝对路径
      n.r.dir = dir;
      save();
      let promptText = jobPrompt(n.t);
      if (n.r.expertNote) promptText = personaFor(wantExpert) + '\n\n—— 任务 ——\n' + promptText;
      job = {
        id: n.t.id, prompt: promptText, cont: !!n.t.cont, workdir: dir, git: !!n.t.git, kind: n.t.kind || '',
        session: n.t.session || '',   // 前端指定了「接着哪个会话」，连接程序会走命令行把它续上
        sessionHome: n.t.sessionHome || '', // 那条会话存在哪套库里：client=~/.workbuddy，cli=~/.codebuddy
        sessionCtx: n.t.sessionCtx || '',   // 客户端会话接不上时，用它把上一轮结论带过去
        title: n.t.prompt.slice(0, 200),
        expert: nativeExpert ? wantExpert : '', model: native ? wantModel : '',
      };
    }
  }
  send(res, 200, { job, cancel, agentV: AGENT_LATEST });
}

// ---------- 小工具 ----------
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'object' && !Buffer.isBuffer(obj) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
const cleanName = (s) => String(s || '').trim().replace(/[\u0000-\u001f<>"'`\\]/g, '').slice(0, 40);
const summary = (t) => ({
  id: t.id, prompt: t.prompt.slice(0, 200), createdAt: t.createdAt, cont: t.cont, workdir: t.workdir, session: t.session || '', sessionMachine: t.sessionMachine || '',
  mode: t.mode || 'all', pool: t.pool || [], prio: prioOf(t), src: t.src || '', stopped: !!t.stopped, pending: pending(t), waiting: waitingDep(t), note: t.note || '',
  after: t.after || '', afterPrompt: t.after && byId(t.after) ? byId(t.after).prompt.slice(0, 60) : '', git: !!t.git,
  expert: t.expert || '', model: t.model || '',
  runs: Object.fromEntries(Object.entries(t.runs).map(([n, r]) => [n, { status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error, dir: r.dir || '', session: r.session || '', via: r.via || '', expertNote: r.expertNote || '', modelNote: r.modelNote || '', last: lastText(r) }])),
});
// 会话索引：每次跑完都会把会话 id 记在 run 上（客户端通道和命令行通道都记）。
// 前端选「接着哪个会话」时就用它，不去翻各台的 workbuddy.db，零额外开销。
function sessionIndex() {
  const all = [];
  for (const t of tasks) {
    for (const [name, r] of Object.entries(t.runs || {})) {
      if (!r || !r.session) continue;
      all.push({
        session: r.session, machine: name, taskId: t.id, dir: r.dir || '',
        at: r.endedAt || r.startedAt || t.createdAt, status: r.status, via: r.via || '',
        result: String(r.result || '').slice(0, 6000), // 客户端会话接不上时，拿上一轮结论当上文带过去
        prompt: String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 160),
      });
    }
  }
  all.sort((a, b) => b.at - a.at);
  const seen = new Set(), out = [];
  for (const x of all) { if (seen.has(x.session)) continue; seen.add(x.session); out.push(x); }
  return out;
}
const sessionInfo = (id) => sessionIndex().find((x) => x.session === id) || null;
// 目录相关的报错翻成人话
function friendlyHubError(msg, dir) {
  if (/automation-workspace-unavailable/i.test(msg)) {
    return `这台电脑打不开干活文件夹「${dir || '默认目录'}」，或者没有写权限。先在那台电脑上确认这个文件夹存在、能新建文件；也可以在发任务时换个目录，或在左边点这台电脑的「改目录」把默认目录改到别的盘。`;
  }
  return msg;
}
function lastText(r) {
  if (r.result) return r.result.slice(0, 160);
  for (let i = r.items.length - 1; i >= 0; i--) if (r.items[i].t === 'text' || r.items[i].t === 'tool') return r.items[i].s.slice(0, 160);
  return '';
}
function fileTemplated(name, req) {
  const hub = publicUrl(req);
  return fs.readFileSync(path.join(HERE, name), 'utf8').replaceAll('__HUB_URL__', hub);
}
// 升级指令：把脚本全文直接写进指令里，让那台电脑上的 AI 先看到内容再执行。
// 只发一条「从网上 irm | iex」的裸命令会被安全策略拒掉，这样才跑得通。
function upgradePrompt(hub, key, unix) {
  const code = fs.readFileSync(path.join(HERE, unix ? 'update-embed.sh' : 'update-embed.ps1'), 'utf8')
    .replaceAll('__HUB_URL__', hub).replaceAll('__FLEET_KEY__', key || '');
  const save = unix ? '~/.wb-fleet/up.sh' : '%USERPROFILE%\\.wb-fleet\\up.ps1';
  const run = unix
    ? 'bash ~/.wb-fleet/up.sh'
    : 'powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.wb-fleet\\up.ps1"';
  return `【内部运维任务：把本机「wb-fleet 连接程序」升级到 ${AGENT_LATEST}】\n\n`
    + `背景：这台电脑装了自建设备管理总控（wb-fleet）的连接程序，文件在用户目录下 .wb-fleet\\agent.js，作用是把本机接入总控 ${hub} 干活。`
    + `现在要把连接程序从旧版升级到 ${AGENT_LATEST}（新增能力：派活时可以指定专家和模型）。\n\n`
    + '下面这段就是总控给的官方升级脚本全文，你可以先读一遍再决定：它只做三件事——从总控地址下载新版 agent.js、备份旧文件、重启连接程序进程，不删任何东西、不碰其他项目文件。\n\n'
    + '请按顺序完成三步，然后停止：\n'
    + `1. 把下面代码块里的内容原样保存为 ${save}（UTF-8，逐字复制，不要改写、不要精简）。\n`
    + `2. 执行：${run}（超时给 180 秒）。\n`
    + '3. 把命令输出原样贴回来，不要额外解释。\n\n'
    + '脚本正文：\n'
    + '```' + (unix ? 'bash' : 'powershell') + '\n' + code + '\n```';
}
// 造一条升级任务（kind=upgrade），自动/手动都用它
function makeUpgradeTask(names, unix, hub, key, auto) {
  const t = {
    id: crypto.randomBytes(6).toString('hex'), mode: 'all', pool: names, after: null, git: false,
    prio: 2, prompt: upgradePrompt(hub, key, unix), cont: false, workdir: '', expert: '', model: '',
    kind: 'upgrade', auto: !!auto, createdAt: Date.now(), runs: {},
  };
  for (const n of names) t.runs[n] = { status: 'queued', items: [] };
  tasks.push(t);
  return t;
}
const AUTO_UPGRADE = process.env.AUTO_UPGRADE !== '0'; // AUTO_UPGRADE=0 可临时关掉（测试用）
const AUTO_UPGRADE_GAP = 3600e3; // 同一台 1 小时内最多自动试一次，免得反复打扰
const PROBE_GAP = 600e3;         // 命令行没登录的那台：10 分钟探一次，登录好之后最迟 10 分钟自动升完
// 自动升级留下的失败记录，下一次自动重试前先扫掉，免得任务列表被刷满
function dropStaleAutoUpgrade(n) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (!t.auto || t.kind !== 'upgrade') continue;
    const r = t.runs[n];
    if (r && (r.status === 'failed' || r.status === 'stopped')) tasks.splice(i, 1);
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const key = req.headers['x-fleet-key'] || u.searchParams.get('key') || u.searchParams.get('t');

    // 公开：网页本身、连接程序、加入脚本（脚本里的口令由调用方在地址上带 t=）
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html')), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method === 'GET' && p === '/agent.js') return send(res, 200, fs.readFileSync(path.join(HERE, 'agent.js')), { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (req.method === 'GET' && p === '/wb.js') return send(res, 200, fs.readFileSync(path.join(HERE, 'wb.js')), { 'Content-Type': 'application/javascript; charset=utf-8' });
    // 加电脑（join）和装终端（term）的脚本
    if (req.method === 'GET' && ['/join.sh', '/join.ps1', '/term.sh', '/term.ps1', '/update.sh', '/update.ps1', '/update-boot.sh', '/update-boot.ps1'].includes(p)) {
      if (!keyOk(key)) return send(res, 403, 'echo "口令不对，请从总控网页复制加入命令"\n');
      return send(res, 200, fileTemplated(p.slice(1), req).replaceAll('__FLEET_KEY__', key));
    }
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    // 登录相关：这时候还没「进来」，不能要求已登录
    if (p === '/api/login' && req.method === 'POST') {
      const wait = lockedFor(req);
      if (wait) return send(res, 429, { error: `试错太多次了，等 ${Math.ceil(wait / 1000)} 秒再试` });
      const b = await readBody(req);
      const pass = String(b.pass == null ? '' : b.pass);
      // 网页口令；还没单独设过网页口令时（PASS 跟机器口令一样），老的机器口令也能登进来。
      // 一旦在网页上改过口令，机器口令就不能再当网页口令用了 —— 否则改了也挡不住知道旧口令的人。
      if (!passOk(pass) && !(PASS === KEY && pass.length > 0 && keyOk(pass))) {
        const f = touchFail(req);
        const left = FAIL_MAX - f.n;
        console.log(`[登录失败] ${ipOf(req)} 口令不对（还差 ${Math.max(left, 0)} 次锁定）`);
        return send(res, 401, { error: left > 0 ? `口令不对，还能再试 ${left} 次` : '试错太多次了，锁 5 分钟' });
      }
      loginFails.delete(ipOf(req));
      const t = newSession(req);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `wb_fleet=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = cookieOf(req);
      if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'wb_fleet=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }
    if (!authOk(req, key)) return send(res, 401, { error: '没登录，或者口令不对' });
    if (p === '/api/me' && req.method === 'GET') {
      return send(res, 200, { ok: true, via: sessionOk(req) ? 'cookie' : 'key' });
    }
    // 网页上拼「加电脑」「装终端」的命令要用机器口令（管理员页面，登录后才给）
    if (p === '/api/key' && req.method === 'GET') return send(res, 200, { key: KEY });
    // 改网页登录口令（不影响机器口令，连接程序照常连）
    if (p === '/api/pass' && req.method === 'POST') {
      const b = await readBody(req);
      const oldp = String(b.old == null ? '' : b.old);
      const np = String(b.pass == null ? '' : b.pass).trim();
      if (!passOk(oldp) && !(PASS === KEY && keyOk(oldp))) return send(res, 403, { error: '原来的口令不对' });
      if (np.length < 6) return send(res, 400, { error: '新口令至少 6 位' });
      if (np.length > 64) return send(res, 400, { error: '新口令最多 64 位' });
      savePass(np);
      // 换了口令，别处还开着的老会话一律失效，只留当前这个
      const keep = cookieOf(req);
      for (const t of [...sessions.keys()]) if (t !== keep) sessions.delete(t);
      return send(res, 200, { ok: true });
    }

    // ----- 连接程序用 -----
    if (p === '/api/agent/poll' && req.method === 'POST') {
      const b = await readBody(req);
      const name = cleanName(b.name);
      if (!name) return send(res, 400, { error: 'name required' });
      let m = machines.get(name);
      if (!m) { m = { name, busy: null, waiter: null }; machines.set(name, m); }
      Object.assign(m, { os: String(b.os || '').slice(0, 60), host: String(b.host || '').slice(0, 60), agentVersion: String(b.agentVersion || ''), cli: String(b.cli || '').slice(0, 80), workdir: String(b.workdir || '').slice(0, 200), cpu: Math.max(0, Math.min(100, Math.round(+b.cpu || 0))), lastSeen: Date.now() });
      // 这台装了哪些专家（连接程序扫本机专家包上报），网页上按这个给提示
      if (Array.isArray(b.experts)) {
        m.experts = b.experts.slice(0, 50)
          .map((e) => ({ id: cleanSpecial(e && e.id), name: String((e && e.name) || '').slice(0, 40) }))
          .filter((e) => e.id)
          .map((e) => ({ id: e.id, name: e.name || e.id }));
      }
      // 这台机器上真实存在、能干活的项目目录（连接程序扫本机上报），网页上给成下拉让人直接点选
      if (Array.isArray(b.dirs)) {
        m.dirs = b.dirs.slice(0, 40)
          .map((d) => ({ p: String((d && d.p) || '').slice(0, 260), proj: !!(d && d.proj), wb: !!(d && d.wb), recent: Number((d && d.recent) || 999) }))
          .filter((d) => d.p);
      }
      // 升级任务：这台重连上来且版本已到最新，就把那条「升级」记成成功
      // （升级最后一步就是重启连接程序，上报必然断开一次，属正常，不能记成失败）
      if (tasks.some((t) => t.kind === 'upgrade')) {
        for (const t of tasks) {
          if (t.kind !== 'upgrade') continue;
          const r = t.runs[name];
          if (!r || r.status === 'done' || r.status === 'stopped') continue;
          if (cmpVer(m.agentVersion, AGENT_LATEST) >= 0) {
            r.status = 'done'; r.endedAt = Date.now(); r.error = '';
            r.result = `连接程序已升级到 ${m.agentVersion}`;
            if (!r.items.some((i) => String(i.s || '').includes('并重新连上总控'))) {
              r.items.push({ t: 'info', s: `这台已升到 ${m.agentVersion} 并重新连上总控（重启时上报断开一次属正常）` });
            }
          }
        }
      }
      // 连接程序重启过：它手上没活了，总控这边记着在跑的标失败
      if (m.busy && b.running !== m.busy) {
        const t = tasks.find((x) => x.id === m.busy);
        const r = t && t.runs[name];
        if (r && t.kind === 'upgrade' && cmpVer(m.agentVersion, AGENT_LATEST) >= 0) {
          r.status = 'done'; r.endedAt = Date.now(); r.error = '';
          r.result = `连接程序已升级到 ${m.agentVersion}`;
          r.items.push({ t: 'info', s: `这台已升到 ${m.agentVersion} 并重新连上总控（重启时上报断开一次属正常）` });
        } else if (r && r.status === 'sent') { if (!returnToPool(t, name)) { r.status = 'queued'; r.startedAt = null; } } // 发出去没收到（网络闪断），重新排队
        else if (r && r.status === 'running') { r.status = 'failed'; r.error = '这台电脑的连接程序重启或断线了，这次中断'; r.endedAt = Date.now(); }
        m.busy = null;
      }
      // 旧版连接程序连上来、手上又没活：自动补一条升级
      // 命令行没登录的那台没法跑指令，改成 10 分钟探一次——用户在那台登录好之后，最迟 10 分钟就自动升完
      const gap = m.needsLogin ? PROBE_GAP : AUTO_UPGRADE_GAP;
      if (AUTO_UPGRADE && !m.busy && cmpVer(m.agentVersion, AGENT_LATEST) < 0 && Date.now() - (m.autoUpAt || 0) > gap) {
        m.autoUpAt = Date.now();
        dropStaleAutoUpgrade(name);
        makeUpgradeTask([name], /darwin|linux|mac/i.test(m.os || ''), publicUrl(req), key || KEY, true);
        save();
      }
      save();
      if (tasks.some((x) => unassigned(x) && !x.stopped)) setImmediate(assignPending); // 别的空闲电脑也可能接得了
      // 同一台又来等了，旧的那条连接多半已断，空着打发掉，别把活发到断了的连接上
      if (m.waiter) { clearTimeout(m.waiter.timer); m.waiter.empty(); m.waiter = null; }
      if (cancelsFor(name).length || (!m.busy && nextJobFor(name))) return dispatch(name, res);
      // 没活就挂着等，最长 25 秒（有新活会提前叫醒）
      const respond = () => { m.lastSeen = Date.now(); dispatch(name, res); };
      m.waiter = { respond, empty: () => send(res, 200, { job: null, cancel: [], agentV: AGENT_LATEST }), timer: setTimeout(() => { if (m.waiter && m.waiter.respond === respond) m.waiter = null; respond(); }, 25000) };
      // 连接断了（对方断网、关机）就别再往这条连接上发活；要听 res 的 close，req 的 close 读完请求体就触发了
      res.on('close', () => { if (!res.writableFinished && m.waiter && m.waiter.respond === respond) { clearTimeout(m.waiter.timer); m.waiter = null; } });
      return;
    }
    if (p === '/api/agent/events' && req.method === 'POST') {
      const b = await readBody(req);
      const name = cleanName(b.name);
      const t = tasks.find((x) => x.id === b.jobId);
      const r = t && t.runs[name];
      // 掉线太久、活已经转给别的电脑了：让它停下，别两台重复干
      if (!r) return send(res, 200, { ok: false, cancel: true });
      const m = machines.get(name); if (m) m.lastSeen = Date.now();
      if (r.status === 'sent') r.status = 'running';
      for (const it of (b.items || []).slice(0, 500)) {
        r.items.push({ t: String(it.t || 'text').slice(0, 10), s: String(it.s || '').slice(0, 20000), at: Date.now() });
      }
      if (r.items.length > MAX_ITEMS) r.items.splice(0, r.items.length - MAX_ITEMS);
      if (b.session) r.session = String(b.session).slice(0, 80);
      if (b.via) r.via = String(b.via).slice(0, 10);
      if (b.done) {
        r.status = b.ok ? 'done' : (r.cancel ? 'stopped' : 'failed');
        r.result = String(b.result || '').slice(0, 50000);
        r.error = b.ok ? '' : friendlyHubError(String(b.error || '').slice(0, 2000), r.dir);
        r.cost = b.cost; r.endedAt = Date.now();
        if (m && m.busy === t.id) m.busy = null;
        // 命令行没登录：这台在登录好之前跑什么都白跑，记下来在网页上说清楚，别让人一直等
        if (m) {
          if (b.ok) { m.needsLogin = false; }
          else if (/没登录 WorkBuddy 命令行|Authentication required|\/login/i.test(String(b.error || '') + ' ' + String(b.result || ''))) {
            m.needsLogin = true; m.needsLoginAt = Date.now();
          }
        }
        // 飞书表来的活：没做完的当场接着交（赶在下一件之前），不等下一次读表
        if (board && t.src) { try { board.onDone(t); } catch (e) { console.error('[飞书表]', e); } }
        kick(name);
        setImmediate(assignPending);
      }
      save();
      return send(res, 200, { ok: true, cancel: !!r.cancel });
    }

    // ----- 网页用 -----
    if (p === '/api/state' && req.method === 'GET') {
      const ms = [...machines.values()].map((m) => ({ name: m.name, os: m.os, host: m.host, cli: m.cli, workdir: m.workdir, dir: baseDirOf(m.name), dirCustom: !!machineDirs[m.name], dirs: m.dirs || [], cpu: m.cpu, online: online(m), busy: m.busy, idle: idle(m), lastSeen: m.lastSeen, agentVersion: m.agentVersion || '', agentsOk: agentSupports(m), needsLogin: !!m.needsLogin, experts: expertsFor(m) }));
      ms.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return send(res, 200, {
        machines: ms, tasks: tasks.slice(-50).reverse().map(summary), hub: publicUrl(req), passSameAsKey: PASS === KEY,
        meta: { experts: expertChoices(), models: MODELS, agentMin: AGENT_MIN, agentLatest: AGENT_LATEST, agentSessionMin: AGENT_SESSION_MIN, defaultExpert: DEFAULT_EXPERT, defaultModel: DEFAULT_MODEL },
      });
    }
    // ----- 提示词页 -----
    // 列表倒序（最近的在前面）。超长的只下发前 4000 字并标 cut，复制全文时再取单条
    // 可接着做的会话：从已有的 run 里攒，带机器、目录、时间、任务摘要
    if (p === '/api/sessions' && req.method === 'GET') {
      const u = new URL('http://x' + req.url);
      const q = String(u.searchParams.get('q') || '').trim().toLowerCase();
      const mc = String(u.searchParams.get('machine') || '').trim();
      let list = sessionIndex();
      if (mc) list = list.filter((x) => x.machine === mc);
      if (q) list = list.filter((x) => (x.session + ' ' + x.prompt + ' ' + x.dir + ' ' + x.machine).toLowerCase().includes(q));
      return send(res, 200, { total: list.length, sessions: list.slice(0, 200) });
    }
    if (p === '/api/prompts' && req.method === 'GET') {
      const list = prompts.slice().reverse().map((x) => {
        const cut = x.text.length > 4000;
        return { ...x, text: cut ? x.text.slice(0, 4000) : x.text, len: x.text.length, cut };
      });
      return send(res, 200, { prompts: list, total: prompts.length });
    }
    if (p === '/api/prompts/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : (b.id ? [String(b.id)] : []);
      if (!ids.length) return send(res, 400, { error: '没说删哪条' });
      const set = new Set(ids);
      const before = prompts.length;
      prompts = prompts.filter((x) => !set.has(x.id));
      saveNow();
      if (before === prompts.length) return send(res, 404, { error: '这些提示词已经没了' });
      return send(res, 200, { ok: true, removed: before - prompts.length });
    }
    let mp = p.match(/^\/api\/prompts\/([a-f0-9]+)$/);
    if (mp && req.method === 'GET') {
      const x = prompts.find((y) => y.id === mp[1]);
      if (!x) return send(res, 404, { error: '没有这条提示词' });
      return send(res, 200, x);
    }
    if (p === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return send(res, 400, { error: '指令是空的' });
      const mode0 = b.mode === 'all' ? 'all' : 'pool';
      // 每行一件活：一次交一批，派给空闲的电脑分着干
      const prompts = b.split ? prompt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 200) : [prompt];
      const picked = Array.isArray(b.targets) ? [...new Set(b.targets.map(cleanName))].filter((n) => machines.has(n)) : [];
      let targets = [];
      if (mode0 === 'all') {
        targets = picked.length ? picked : [...machines.values()].filter(online).map((m) => m.name);
        if (!targets.length) return send(res, 400, { error: '没有在线的电脑' });
      } else if (!machines.size) return send(res, 400, { error: '还没有电脑连上来' });
      // 接力只在派给空闲的里用：after 接在某件后面；chain 每行接在上一行后面
      const after = mode0 === 'pool' && b.after && byId(String(b.after)) ? String(b.after) : null;
      // 指定专家/模型：确认至少有一台在线的电脑认得（连接程序要 1.7.0+）
      const expert = cleanSpecial(b.expert);
      const model = cleanSpecial(b.model);
      if (String(b.expert || '').trim() && !expert) return send(res, 400, { error: '专家名只能用字母、数字、点、下划线、冒号、短横线，且不能以短横线开头' });
      if (String(b.model || '').trim() && !model) return send(res, 400, { error: '模型名只能用字母、数字、点、下划线、冒号、短横线，且不能以短横线开头' });
      // 指定专家/模型：能用原生就原生，用不了就降级（专家写进任务说明），不再拒单
      let warn = '';
      if (expert || model) {
        const names = mode0 === 'all' ? targets : [...machines.values()].filter(online).map((m) => m.name);
        const soft = names.filter((n) => {
          const mm = machines.get(n); if (!mm) return false;
          const noExpert = expert && (!agentSupports(mm) || !expertsFor(mm).some((e) => e.id === expert));
          const noModel = model && !agentSupports(mm);
          return noExpert || noModel;
        });
        if (soft.length) {
          warn = `这些电脑会降级执行（专家写进任务说明顶上、模型用本机默认）：${soft.join('、')}。`
            + '想原生加载就跑一次更新命令升级连接程序，升级后自动改成原生。';
        }
      }
      // 接着某个会话做：会话只活在某一台电脑的某个目录里，所以机器和目录一起被锁死。
      // 客户端任务表没有会话字段（写进去必然是全新会话），所以这类任务一律走命令行，
      // 连接程序那边会拦掉客户端通道，这里只负责把会话信息连同机器、目录一起下发。
      let mode = mode0, sessWanted = '', sessMachine = '', sessHome = '', sessCtx = '';
      let lockedDir = String(b.workdir || '').trim().slice(0, 300);
      const rawSess = String(b.session || '').trim();
      if (rawSess) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(rawSess)) return send(res, 400, { error: '会话 id 格式不对' });
        if (b.split) return send(res, 400, { error: '接会话时不能「每行算一件活」：同一个会话只能一条接一条做，否则两件活会抢同一个会话' });
        const info = sessionInfo(rawSess);
        const want = cleanName(b.sessionMachine || (info && info.machine) || '');
        const mm = machines.get(want);
        if (!want || !mm) return send(res, 400, { error: '接会话必须指定是哪台电脑：会话只存在于那台上，换台电脑就接不上了' });
        sessWanted = rawSess; sessMachine = want;
        // 客户端建的会话存在 ~/.workbuddy 里，命令行建的在 ~/.codebuddy 里，两套不通用：
        // 把来源一起带下去，连接程序才知道该让命令行去翻哪一套。
        sessHome = (info && info.via) === 'client' ? 'client' : 'cli';
        if (sessHome === 'client') sessCtx = (info && info.result) || '';
        // 目录跟着会话走，不让改：在别的目录里续旧会话，等于上下文和文件对不上
        if (info && info.dir) lockedDir = info.dir;
        mode = 'all'; targets = [want];
        if (!agentSessionSupports(mm)) {
          warn += `「${want}」的连接程序是 ${mm.agentVersion || '旧版'}，还不支持接会话（这次会当成新会话跑）：点右上角「升级连接程序」升到 ${AGENT_SESSION_MIN} 后再试。`;
        }
      }
      const made = [];
      prompts.forEach((pr, i) => {
        const dep = mode === 'pool' && b.chain && i > 0 ? made[i - 1].id : after;
        const t = { id: crypto.randomBytes(6).toString('hex'), mode, pool: mode === 'pool' ? picked : [], after: dep, git: !!b.git, prio: [0, 1, 2].includes(+b.prio) ? +b.prio : 1, prompt: pr.slice(0, 20000), cont: !!b.cont, session: sessWanted, sessionMachine: sessMachine, sessionHome: sessHome, sessionCtx: sessCtx, workdir: lockedDir, expert, model, createdAt: Date.now() + i, runs: {} };
        for (const n of targets) t.runs[n] = { status: 'queued', items: [] };
        tasks.push(t);
        made.push(t);
      });
      if (tasks.length > 500) tasks.splice(0, tasks.length - 500);
      for (const t of made) recordPrompt(t); // 提示词页：每次提交都留一份
      save();
      for (const n of targets) kick(n);
      if (mode === 'pool') assignPending();
      return send(res, 200, { ...summary(made[0]), ids: made.map((t) => t.id), warn });
    }
    let mt = p.match(/^\/api\/tasks\/([a-f0-9]+)$/);
    if (mt && req.method === 'GET') {
      const t = tasks.find((x) => x.id === mt[1]);
      if (!t) return send(res, 404, { error: '没有这件任务' });
      const since = +(u.searchParams.get('since') || 0);
      return send(res, 200, { ...summary(t), prompt: t.prompt, runs: Object.fromEntries(Object.entries(t.runs).map(([n, r]) => [n, { ...r, items: r.items.filter((i) => i.at > since) }])) });
    }
    mt = p.match(/^\/api\/tasks\/([a-f0-9]+)\/stop$/);
    if (mt && req.method === 'POST') {
      const t = tasks.find((x) => x.id === mt[1]);
      if (!t) return send(res, 404, { error: '没有这件任务' });
      const b = await readBody(req);
      if (unassigned(t) && !b.name) t.stopped = true;
      // 后面接力等着这件的，也一起停
      if (!b.name) for (const x of tasks) if (x.after === t.id && unassigned(x) && !x.stopped) { x.stopped = true; x.note = '上一步停了，这步没开始'; }
      for (const [n, r] of Object.entries(t.runs)) {
        if (b.name && b.name !== n) continue;
        if (r.status === 'queued') { r.status = 'stopped'; r.endedAt = Date.now(); }
        else if (r.status === 'running' || r.status === 'sent') { r.cancel = true; kick(n); }
      }
      save();
      return send(res, 200, { ok: true });
    }
    // 删任务：一件（DELETE /api/tasks/<id>）或一批（POST /api/tasks/delete {ids:[…]}）
    if (p === '/api/tasks/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : []);
      if (!ids.length) return send(res, 400, { error: '没说删哪件' });
      const r = deleteTasks(ids);
      if (!r.removed) return send(res, 404, { error: '这些任务已经没了' });
      return send(res, 200, { ok: true, ...r });
    }
    // 远程升级连接程序：给各台电脑派一条「更新命令」，不需要登录那台电脑
    if (p === '/api/upgrade' && req.method === 'POST') {
      const b = await readBody(req);
      const onlineNames = [...machines.values()].filter(online).map((m) => m.name);
      const picked = Array.isArray(b.targets) ? [...new Set(b.targets.map(cleanName))].filter((n) => onlineNames.includes(n)) : [];
      let targets = picked.length ? picked : onlineNames;
      if (!targets.length) return send(res, 400, { error: '没有在线的电脑' });
      if (!b.force) {
        const stale = targets.filter((n) => cmpVer(machines.get(n).agentVersion, AGENT_LATEST) < 0);
        if (stale.length) targets = stale; // 默认只升「不是最新」的那些
      }
      const hub = publicUrl(req);
      const isUnix = (n) => /darwin|linux|mac/i.test(machines.get(n).os || '');
      const win = targets.filter((n) => !isUnix(n));
      const mac = targets.filter(isUnix);
      const made = [];
      const mk = (names, unix) => {
        if (!names.length) return;
        made.push(makeUpgradeTask(names, unix, hub, key || KEY, false));
      };
      mk(win, false); mk(mac, true);
      if (tasks.length > 500) tasks.splice(0, tasks.length - 500);
      save();
      for (const n of targets) kick(n);
      return send(res, 200, { ok: true, targets, ids: made.map((t) => t.id), latest: AGENT_LATEST });
    }
    // 解卡：某台连接程序卡在一个旧活上不放手（一直「已发出、没接手」），
    // 给它手上那些活全打上取消，下次它来问就把「停下」送过去
    mt = p.match(/^\/api\/machines\/(.+)\/unstick$/);
    if (mt && req.method === 'POST') {
      const n = decodeURIComponent(mt[1]);
      const m = machines.get(n);
      if (!m) return send(res, 404, { error: '没有这台电脑' });
      m.busy = null;
      const ids = [];
      for (const t of tasks) {
        const r = t.runs[n];
        if (!r) continue;
        if (t.createdAt && Date.now() - t.createdAt > 7200e3) continue; // 只看最近两小时的
        r.cancel = true;
        ids.push(t.id);
      }
      save(); kick(n);
      return send(res, 200, { ok: true, name: n, cancel: ids });
    }
    // 改某台电脑的默认干活目录（传空字符串 = 恢复用连接程序上报的默认值）
    mt = p.match(/^\/api\/machines\/(.+)\/dir$/);
    if (mt && (req.method === 'POST' || req.method === 'PUT')) {
      const name = decodeURIComponent(mt[1]);
      const b = await readBody(req);
      const dir = String(b.dir == null ? '' : b.dir).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 300);
      if (dir) machineDirs[name] = dir; else delete machineDirs[name];
      save();
      return send(res, 200, { ok: true, name, dir, base: baseDirOf(name), custom: !!dir });
    }
    mt = p.match(/^\/api\/machines\/(.+)$/);
    if (mt && req.method === 'DELETE') {
      const name = decodeURIComponent(mt[1]);
      const m = machines.get(name);
      if (m && online(m)) return send(res, 400, { error: '在线的电脑删不了，先在那台电脑上停掉连接程序' });
      machines.delete(name); save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
});
// ---------- 飞书表（可选） ----------
const boardCfg = path.join(DATA_DIR, 'feishu-board.json');
if (fs.existsSync(boardCfg)) {
  board = require('./feishu-board.js').start({
    cfgFile: boardCfg, dataDir: DATA_DIR, PRIO_NAMES,
    // 交一件派给空闲电脑的活，返回它的编号
    add({ prompt, workdir, git, prio, src, after, round, meta }) {
      const t = { id: crypto.randomBytes(6).toString('hex'), mode: 'pool', pool: [], after: after && byId(after) ? after : null, round: round || 1, meta, git: !!git, prio, src: src || '', prompt: String(prompt).slice(0, 20000), cont: false, workdir: String(workdir || '').slice(0, 300), createdAt: Date.now(), runs: {} };
      tasks.push(t); if (tasks.length > 500) tasks.splice(0, tasks.length - 500);
      recordPrompt(t);
      save(); assignPending();
      return t.id;
    },
    get: (id) => byId(id),
    // 接着这件做的下一轮（没有就是 null）
    child: (id) => tasks.find((x) => x.after === id && x.src && x.src === (byId(id) || {}).src) || null,
    // 还在等电脑的里排第几（同一套排法）
    rank(id) { const q = tasks.filter(pending).sort(byPrio); const i = q.findIndex((x) => x.id === id); return i < 0 ? 0 : i + 1; },
    setPrio(id, prio) { const t = byId(id); if (t && t.prio !== prio) { t.prio = prio; save(); assignPending(); } },
    stop(id) {
      const t = byId(id); if (!t) return;
      if (unassigned(t)) t.stopped = true;
      for (const [n, r] of Object.entries(t.runs)) {
        if (r.status === 'queued') { r.status = 'stopped'; r.endedAt = Date.now(); }
        else if (r.status === 'running' || r.status === 'sent') { r.cancel = true; kick(n); }
      }
      save();
    },
    onlineCount: () => [...machines.values()].filter(online).length,
  });
}

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.listen(PORT, HOST, () => {
  const local = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`WorkBuddy 总控已启动，在这台电脑上打开：http://${local}:${PORT}/?key=${KEY}`);
  if (process.env.PUBLIC_URL) console.log(`对外地址：${process.env.PUBLIC_URL.replace(/\/$/, '')}/?key=${KEY}`);
  else if (HOST === '0.0.0.0') console.log('同一局域网的电脑把 127.0.0.1 换成这台的局域网 IP；不同网络的电脑要放到有公网的服务器上（设 PUBLIC_URL）');
});
