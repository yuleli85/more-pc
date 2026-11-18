#!/usr/bin/env node
// 每台电脑上跑的连接程序：主动连总控领任务，交给本机 WorkBuddy 的内核（CodeBuddy 命令行）干，
// 边干边把进展传回总控。只往外连，不开端口，所以在哪个网络里都行。只用 Node 自带模块（Node 18+）。
//
// 用法：node agent.js --hub https://总控地址 --key 口令 [--name 这台的名字] [--workdir 默认干活的文件夹]
//   也可用环境变量：FLEET_HUB、FLEET_KEY、FLEET_NAME、FLEET_WORKDIR、CODEBUDDY_BIN（命令行程序路径，默认 codebuddy），
//   或 --config 配置文件（UTF-8 的 JSON：hub、key、name、workdir、bin；Windows 加入脚本用它，免得中文名字过 cmd 乱码）
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFile, execFileSync } = require('child_process');

const VERSION = '1.11.1';
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const CFG = arg('config') ? JSON.parse(fs.readFileSync(arg('config'), 'utf8').replace(/^\uFEFF/, '')) : {};
const HUB = (arg('hub') || CFG.hub || process.env.FLEET_HUB || '').replace(/\/$/, '');
const KEY = arg('key') || CFG.key || process.env.FLEET_KEY || '';
const NAME = arg('name') || CFG.name || process.env.FLEET_NAME || os.hostname().replace(/\.local$/, '');
const WORKDIR = expandHome(arg('workdir') || CFG.workdir || process.env.FLEET_WORKDIR || path.join(os.homedir(), 'WorkBuddy-tasks'));
const BIN = CFG.bin || process.env.CODEBUDDY_BIN || 'codebuddy';
const IS_WIN = process.platform === 'win32';
// Windows 上 .cmd 要经 cmd 跑，路径带空格得加引号
const CMD = IS_WIN ? `"${BIN}"` : BIN;
if (!HUB || !KEY) { console.error('缺 --hub 或 --key，请从总控网页复制加入命令'); process.exit(2); }

function expandHome(p) { return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cliVersion() {
  try { return execFileSync(CMD, ['--version'], { encoding: 'utf8', timeout: 20000, shell: IS_WIN, windowsHide: true }).trim().split('\n')[0]; }
  catch { return ''; }
}
let CLI = cliVersion();

// ---------- 本机装了哪些专家 ----------
// WorkBuddy 的专家是「专家包」：plugins/marketplaces/experts/plugins/<包>/agents/<专家>.md
// 总控要按这里的清单告诉用户哪台能用哪个专家，命令行也用 --agent <专家> 指定。
const EXPERT_ROOTS = [
  path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins'),
  path.join(os.homedir(), '.workbuddy', 'experts'),
  path.join(os.homedir(), '.codebuddy', 'agents'),
];
function expertTitle(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').slice(0, 8000);
    const m = /^#\s+(.+)$/m.exec(s);
    if (!m) return '';
    return m[1].replace(/[（(].*$/, '').trim().slice(0, 30);
  } catch { return ''; }
}
function scanExperts() {
  const found = [];
  for (const root of EXPERT_ROOTS) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const agentsDir = path.join(root, n, 'agents');
      let files = [];
      try { files = fs.readdirSync(agentsDir); } catch { files = []; }
      if (!files.length) continue;
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const id = f.slice(0, -3);
        const full = path.join(agentsDir, f);
        found.push({ id, name: expertTitle(full) || id });
      }
    }
  }
  const map = new Map();
  for (const e of found) if (!map.has(e.id)) map.set(e.id, e);
  return [...map.values()];
}
let EXPERTS = scanExperts();
let expertAt = Date.now();

// ---------- 本机有哪些能真正干活的文件夹（网页上「选目录」用）----------
// 两个来源：① WorkBuddy 自己记下的工作区（workbuddy.db 的 workspaces 表，最贴近「我在 WorkBuddy 里指定的目录」）
//          ② 常见放置位置里、看着像项目的文件夹（有 .git / pom.xml / package.json 之类）
// 目的：用户在总控上填的目录在这台机器上不存在时，能直接把真实存在的目录报上去让他点选，
// 而不是像以前那样悄悄建一个空文件夹，在空壳里干完活、用户以为没按指定目录跑。
const DIR_ROOTS = ['WorkBuddy', 'WorkBuddy-tasks', 'workspaces', 'workspace', 'work', 'works', 'project', 'projects', 'dev', 'code', 'src', 'Documents', 'Desktop'];
// 除用户目录外，其他盘/卷上这些名字的文件夹也算（项目常放在 E:\workspaces、D:\code 这类地方）
const DIR_NAMES = ['workspaces', 'workspace', 'works', 'work', 'project', 'projects', 'code', 'dev', 'src', 'git', 'repo', 'repos'];
function dirRoots() {
  const out = DIR_ROOTS.map((r) => path.join(os.homedir(), r));
  const vols = [];
  if (IS_WIN) {
    for (let c = 68; c <= 90; c++) { // D: 到 Z:
      const d = String.fromCharCode(c) + ':/';
      try { if (fs.statSync(d).isDirectory()) vols.push(d); } catch {}
    }
  } else {
    try { for (const n of fs.readdirSync('/Volumes')) vols.push(path.join('/Volumes', n)); } catch {}
  }
  for (const v of vols) {
    for (const n of DIR_NAMES) {
      const p = path.join(v, n);
      try { if (fs.statSync(p).isDirectory()) out.push(p); } catch {}
    }
  }
  return out;
}
const PROJECT_MARKS = ['.git', 'pom.xml', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'build.gradle', 'settings.gradle'];
function looksLikeProject(p) {
  try { if (!fs.statSync(p).isDirectory()) return false; } catch { return false; }
  return PROJECT_MARKS.some((f) => fs.existsSync(path.join(p, f)));
}
// 读 WorkBuddy 的工作区表：另起一个进程开 sqlite，免得主进程没带 --experimental-sqlite 就打不开
function wbWorkspaces() {
  if (!fs.existsSync(WB_DB)) return [];
  const code = `db.prepare('select path from workspaces order by last_opened_at desc limit 40').all().forEach(x=>console.log(x.path));`;
  try {
    return wbRun(code, 20000).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
function scanDirs() {
  const seen = new Map(); // 路径 -> 像不像项目
  const wbOrder = new Map(); // 路径 -> 在 WorkBuddy 工作区表里的位次（0 = 最近打开）
  const add = (p) => {
    const q = String(p || '').replace(/[\\/]+$/, '');
    if (!q || seen.has(q)) return;
    try { if (!fs.statSync(q).isDirectory()) return; } catch { return; }
    seen.set(q, looksLikeProject(q));
  };
  wbWorkspaces().forEach((p, i) => {
    const q = String(p || '').replace(/[\\/]+$/, '');
    add(q);
    if (q && seen.has(q) && !wbOrder.has(q)) wbOrder.set(q, i);
  });
  add(WORKDIR);
  for (const base of dirRoots()) {
    let kids = [];
    try { kids = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name)); }
    catch { continue; }
    for (const k of kids) {
      add(k);
      if (seen.get(k)) continue; // 自己就是项目，不用再往下看
      let sub = [];
      try { sub = fs.readdirSync(k, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(k, d.name)); }
      catch { continue; }
      for (const s of sub) { add(s); if (seen.size > 150) break; }
    }
  }
  const rank = (p) => (wbOrder.has(p) ? wbOrder.get(p) : 999);
  return [...seen.entries()]
    .map(([p, proj]) => ({ p, proj, wb: wbOrder.has(p), recent: rank(p) }))
    .sort((a, b) => (Number(b.proj) - Number(a.proj)) || (a.recent - b.recent) || (a.p.length - b.p.length))
    .slice(0, 40);
}
let DIRS = [];
let dirsAt = 0;
function refreshDirs(force) {
  if (!force && Date.now() - dirsAt < 600000) return; // 10 分钟扫一次就够，别每轮都翻硬盘
  dirsAt = Date.now();
  try { DIRS = scanDirs(); } catch { DIRS = []; }
}

// ---------- 技能共享 ----------
// 本机的用户级技能（~/.workbuddy/skills/<名字>/）和总控互通：自己开发/改了自动传上去，
// 别的电脑开发的自动装下来 —— 全自动，谁最后改就以谁的为准。只在 ~/.workbuddy/skills 下动手，
// 不碰插件缓存里那些由 WorkBuddy 商店管的技能。
const SKILLS_ROOT = path.join(os.homedir(), '.workbuddy', 'skills');
const SKILL_BYTES_MAX = 2 << 20; // 单个技能最大 2MB，超大的多半不是技能，不同步
const SKILL_FILES_MAX = 200;     // 单个技能最多 200 个文件
// 本机删过哪些技能：记在 ~/.workbuddy/.wb-skills-removed（不在技能目录里，不会被当成技能）
// 为什么要记：用户手动删掉的技能，总控不该再自动装回来（用户定的规矩：删除不自动同步）。
// 只记「删过」这一事实，等这个技能在总控那边被改了内容，才会重新装。
const SKILL_REMOVED_FILE = path.join(os.homedir(), '.workbuddy', '.wb-skills-removed.json');
// 技能 hash 的对齐记录：名字 -> { hash: 总控认可的, own: 本机内容自己算的 }
// 两边 hash 规则必须一致，否则会互相认为「对方是旧版」而无限重传（实测烧掉 22MB 日志）。
// 用法：内容没变 → 上报总控那个 hash（对齐）；内容变了（own 变了）→ 上报自己算的新值，让总控收新版。
const SKILL_HASH_FIX = new Map();
function readRemoved() {
  try { const j = JSON.parse(fs.readFileSync(SKILL_REMOVED_FILE, 'utf8')); return Array.isArray(j) ? j : []; }
  catch { return []; }
}
function writeRemoved(list) {
  try { fs.mkdirSync(path.dirname(SKILL_REMOVED_FILE), { recursive: true }); fs.writeFileSync(SKILL_REMOVED_FILE, JSON.stringify(list.slice(-200))); }
  catch {}
}
function markRemoved(name) {
  const l = readRemoved();
  if (!l.includes(name)) { l.push(name); writeRemoved(l); }
}
function clearRemoved(name) {
  const l = readRemoved();
  const i = l.indexOf(name);
  if (i >= 0) { l.splice(i, 1); writeRemoved(l); }
}
// 技能里有哪些文件（相对路径，用 / 分隔）
// 注意：这里只负责「列出」，不做排序 —— 排序统一由 skillHash 里的「按完整路径排序」决定。
// 千万别按目录逐层排序：那样「演示项目」和「演示项目-审计结果」这类目录的顺序，
// 会跟总控那边（按完整路径字符串排序）不一样 → 两边算出的 hash 永远不同 → 无限重传。
function skillFiles(root, base = '') {
  const out = [];
  let es = [];
  try { es = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  es.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of es) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...skillFiles(path.join(root, e.name), rel));
    else if (e.isFile()) out.push(rel);
    if (out.length > SKILL_FILES_MAX) break;
  }
  return out;
}
// 版本 hash：必须和总控那边算法一模一样 —— 按相对路径字符串排序后，
// 依次喂入「路径 + \0 + 文件内容」。两边差一个字节都会导致互相认为对方是旧版、无限重传。
function skillHashOf(pairs) {
  const h = crypto.createHash('sha256');
  for (const p of [...pairs].sort((a, b) => (a.p < b.p ? -1 : 1))) { h.update(p.p); h.update('\0'); h.update(p.buf); }
  return h.digest('hex').slice(0, 20);
}
function scanSkills() {
  const out = [];
  let ds = [];
  try { ds = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const d of ds) {
    if (!d.isDirectory()) continue;
    const dir = path.join(SKILLS_ROOT, d.name);
    const files = skillFiles(dir);
    if (!files.length || files.length > SKILL_FILES_MAX) continue;
    const pairs = [];
    let size = 0, newest = 0, tooBig = false;
    try {
      for (const rel of files) {
        const st = fs.statSync(path.join(dir, rel));
        size += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (size > SKILL_BYTES_MAX) { tooBig = true; break; }
        pairs.push({ p: rel, buf: fs.readFileSync(path.join(dir, rel)) });
      }
    } catch { continue; } // 正在被人改写，这轮先跳过
    if (tooBig || !size) continue;
    const own = skillHashOf(pairs);
    // 上次记的（总控认可的）hash：只用来判断「内容有没有变」。
    // 内容变了 → 用自己算的新值上报，让总控收新版；
    // 内容没变 → 用总控那个值上报，两边对齐，不会互相认为「对方是旧版」。
    const last = SKILL_HASH_FIX.get(d.name);
    const hash = (last && last.own && last.own !== own) ? own : (last && last.hash) || own;
    SKILL_HASH_FIX.set(d.name, { hash, own });
    out.push({ name: d.name, hash, mtime: Math.round(newest), size });
  }
  return out;
}
let SKILLS = [], skillsAt = 0, SKILL_GONE = new Set();
// 扫技能目录。顺带发现「用户自己删掉的」：上轮有、这轮没了 → 记进删除名单，
// 总控据此知道这台不要这个技能，不会自动装回来。
function refreshSkills(force) {
  if (!force && Date.now() - skillsAt < 3000) return; // 技能目录很小，3 秒一扫，改动几秒内就能共享出去
  const prev = new Map(SKILLS.map((s) => [s.name, s.hash]));
  skillsAt = Date.now();
  let next = [];
  try { next = scanSkills(); } catch { next = []; }
  for (const [n] of prev) {
    if (!next.some((s) => s.name === n)) { SKILL_GONE.add(n); markRemoved(n); }
  }
  SKILLS = next;
}
function skillNameOk(s) {
  const v = String(s || '').trim().replace(/[\\/\u0000-\u001f<>:"|?*]/g, '').replace(/^\.+/, '').slice(0, 80);
  return v;
}
// 解压前把每个相对路径过一遍：绝对路径、盘符、..、空段一律拒收，防止把文件写到技能目录外面
function skillPathOk(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.length > 200) return false;
  if (/^[/\\]/.test(p) || /^[a-zA-Z]:/.test(p)) return false;
  return p.split(/[/\\]/).every((x) => x && x !== '.' && x !== '..');
}
// 总控要这份技能的正文：打成 base64 传上去
async function skillUpload(rawName) {
  const name = skillNameOk(rawName);
  if (!name) return;
  const dir = path.join(SKILLS_ROOT, name);
  if (!fs.existsSync(dir)) return; // 已经没了就当无事发生，下一轮对账自然清楚
  const files = [];
  let size = 0;
  for (const rel of skillFiles(dir)) {
    if (files.length >= SKILL_FILES_MAX) return;
    const buf = fs.readFileSync(path.join(dir, rel));
    size += buf.length;
    if (size > SKILL_BYTES_MAX) return; // 超大：不传，等总控那边的版本覆盖回来
    files.push({ p: rel, d: buf.toString('base64') });
  }
  if (!files.length) return;
  // 上传后以总控回传的 hash 为准：两边算 hash 的规则要是一致，
  // 否则会互相认为「对方是旧版」而无限重传（实测烧掉几十 GB 日志）。
  // 用总控的值，本机上报时也用它，两边就对齐了。
  try {
    const r = await api('/api/agent/skill', { name, from: NAME, files }, 60000);
    if (r && r.hash) { const old = SKILL_HASH_FIX.get(name) || {}; SKILL_HASH_FIX.set(name, { hash: r.hash, own: old.own }); }
  } catch {}
}
// 从总控下载一份技能装到本机（先删掉旧的再写，保证和共享版完全一致）
async function skillInstall(rawName) {
  const name = skillNameOk(rawName);
  if (!name) return;
  try {
    const r = await fetch(HUB + '/api/agent/skill?name=' + encodeURIComponent(name), { headers: { 'x-fleet-key': KEY } });
    const j = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(j.files) && j.files.length && j.files.every((f) => skillPathOk(f.p))) {
      skillWrite(name, j.files);
      // 装的就是总控那份 → 用总控的 hash（两边规则必须一致，否则会互相认为「对方是旧版」）
      if (j.hash) { const old = SKILL_HASH_FIX.get(name) || {}; SKILL_HASH_FIX.set(name, { hash: j.hash, own: old.own }); }
    }
  } catch { /* 网络不通下次再试，不挡着领活 */ }
}
function skillWrite(name, files) {
  const dir = path.join(SKILLS_ROOT, name);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  for (const f of files) {
    const full = path.join(dir, ...f.p.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(f.d || '', 'base64'));
  }
  clearRemoved(name); // 装回来了就不用再记「删过」
  SKILL_GONE.delete(name);
  // 记下这份内容自己算的 hash：以后用户改了文件，跟它一比就知道变了
  try {
    const pairs = [];
    for (const rel of skillFiles(dir)) pairs.push({ p: rel, buf: fs.readFileSync(path.join(dir, rel)) });
    if (pairs.length) { const old = SKILL_HASH_FIX.get(name) || {}; SKILL_HASH_FIX.set(name, { hash: old.hash, own: skillHashOf(pairs) }); }
  } catch {}
  skillsAt = 0; // 装完立刻重扫，下次上报的就是新版本，总控不会重复催
}
// 删掉：记下「这台删过」，总控就不会自动装回来（用户定的规矩）
function skillRemove(rawName, byUser) {
  const name = skillNameOk(rawName);
  if (!name) return;
  try { fs.rmSync(path.join(SKILLS_ROOT, name), { recursive: true, force: true }); } catch {}
  markRemoved(name);
  skillsAt = 0;
}
async function handleSkillCmds(sc) {
  for (const n of (sc && sc.del) || []) skillRemove(n);
  for (const n of (sc && sc.want) || []) await skillInstall(n);
  for (const n of (sc && sc.get) || []) await skillUpload(n);
}
// 技能轮询：独立于派活通道，每 3 秒问一次总控「有没有新技能」。
// 走独立接口是为了不占派活那条长连接（那条要等最多 25 秒），技能才能几秒内就到别的电脑。
let skillBusy = false;
async function skillLoop() {
  if (skillBusy) return;
  skillBusy = true;
  try {
    refreshSkills(false);
    const removed = [...new Set([...readRemoved(), ...SKILL_GONE])].map(skillNameOk).filter(Boolean).slice(0, 100);
    const r = await api('/api/agent/skills', { name: NAME, skills: SKILLS, removed }, 15000);
    if (r.skills && (r.skills.want || r.skills.get || r.skills.del)) {
      const before = SKILLS.map((s) => s.name + ':' + s.hash).join(',');
      await handleSkillCmds(r.skills);
      refreshSkills(true);
      const after = SKILLS.map((s) => s.name + ':' + s.hash).join(',');
      if (before !== after) log('技能已同步：' + SKILLS.map((s) => s.name).join('、'));
    }
  } catch { /* 网络不通下次再问，不影响干活 */ }
  finally { skillBusy = false; }
}

// 命令行有没有 --agent / --model 这两个参数（老版本没有）
let CLI_FLAGS = { agent: true, model: true, resume: true };
function probeFlags() {
  try {
    const h = execFileSync(CMD, ['--help'], { encoding: 'utf8', timeout: 30000, shell: IS_WIN, windowsHide: true });
    return { agent: /--agent\b/.test(h), model: /--model\b/.test(h), resume: /--resume\b/.test(h) };
  } catch { return { agent: true, model: true, resume: true }; } // 探不出来就按支持处理，真不支持会报 unknown option
}
if (CLI) CLI_FLAGS = probeFlags();

// 这台电脑整机的 CPU 占用（两次领活之间的平均），总控按它挑最闲的电脑派活；Windows、Mac、Linux 都能用
let cpuPrev = cpuTimes();
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}
function cpuLoad() {
  const now = cpuTimes();
  const dt = now.total - cpuPrev.total, di = now.idle - cpuPrev.idle;
  if (dt < 500) return undefined; // 间隔太短不准，这次不报
  cpuPrev = now;
  return Math.round(100 * (1 - di / dt));
}
let lastCpu = 0;

async function api(p, body, timeoutMs = 40000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(HUB + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fleet-key': KEY }, body: JSON.stringify(body), signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  } finally { clearTimeout(timer); }
}

// ---------- 正在干的活 ----------
let current = null; // { id, child, buf: [], session, stopped }

// 把 CodeBuddy 的 stream-json 一行翻成网页上好看的一条
function toItems(ev) {
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') out.push({ t: 'info', s: `开工（模型 ${ev.model || '默认'}，目录 ${ev.cwd || ''}）` });
  else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ t: 'text', s: c.text });
      else if (c.type === 'tool_use') out.push({ t: 'tool', s: `${c.name}  ${brief(c.input)}` });
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) if (c.type === 'tool_result' && c.is_error) out.push({ t: 'err', s: '工具出错：' + brief(c.content, 300) });
  }
  return out;
}
function brief(v, n = 160) {
  let s;
  if (v == null) s = '';
  else if (typeof v === 'string') s = v;
  else if (Array.isArray(v)) s = v.map((x) => (x && x.text) || '').join(' ');
  else s = v.command || v.file_path || v.path || v.pattern || v.url || v.query || v.description || JSON.stringify(v);
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function friendlyError(msg) {
  if (/Authentication required|\/login/i.test(msg)) return '这台还没登录 WorkBuddy 命令行：在这台电脑的终端里运行 codebuddy，输入 /login 用 WorkBuddy 的账号登录，再重发。';
  if (/ENOENT|not found|不是内部或外部命令/i.test(msg)) return `这台没找到 WorkBuddy 命令行（${BIN}）：重新跑一次加入命令会自动装。`;
  if (/unknown option[^\n]*--(agent|model)/i.test(msg)) return `这台的 WorkBuddy 命令行（${CLI || '未知版本'}）不认 --agent/--model：在那台运行 codebuddy upgrade 升级命令行，再重发。`;
  return msg;
}

// ---------- 代码用 Git 同步：由连接程序自己做，不靠 AI 记得跑 ----------
function git(cwd, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => {
      if (e) { e.detail = String((err || '') + (out || '') || e.message).trim().split('\n').slice(-3).join(' '); reject(e); } else resolve(String(out).trim());
    });
  });
}
const gitErr = (e) => e.detail || e.message;
async function upstream(cwd) {
  try { const u = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); const i = u.indexOf('/'); return i > 0 ? { remote: u.slice(0, i), branch: u.slice(i + 1) } : null; }
  catch { return null; }
}
// 拉代码撞上别的电脑的改动（rebase 停在冲突上）：让本机 AI 只改文件解掉冲突，git 的步骤还是连接程序自己做；解不掉就退回原样
// 这台没配 Git 用户名就用电脑名代填，免得提交失败
const whoArgs = (cwd) => git(cwd, ['config', 'user.email']).then(() => [], () => ['-c', `user.name=WorkBuddy-${NAME}`, '-c', 'user.email=workbuddy-fleet@localhost']);
const inRebase = (cwd) => ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(cwd, '.git', d)));
async function pullResolving(cwd, cur, resolve) {
  try { await git(cwd, ['pull', '--rebase', '--autostash']); return; }
  catch (e) {
    for (let round = 0; resolve && inRebase(cwd) && round < 5; round++) {
      const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
      if (files.length) {
        cur.buf.push({ t: 'info', s: `Git：和别的电脑的改动冲突（${files.join('、')}），交给 AI 合并` });
        const r = await resolve(`拉最新代码时，和别的电脑推上去的改动冲突了，冲突的文件：${files.join('、')}。\n打开这些文件，把冲突标记（<<<<<<<、=======、>>>>>>>）处理掉：两边的改动都要保留、合到一起能用；改完跑项目的测试确认通过。只改文件，不要运行任何 git 命令。`);
        if (!r.ok) break;
        const left = files.filter((f) => { try { return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(cwd, f), 'utf8')); } catch { return false; } });
        if (left.length) break;
      }
      await git(cwd, ['add', '-A']);
      try { await git(cwd, [...(await whoArgs(cwd)), '-c', 'core.editor=true', 'rebase', '--continue']); } catch { /* 下一个提交还有冲突，接着解 */ }
      if (!inRebase(cwd)) { cur.buf.push({ t: 'info', s: 'Git：冲突已合并' }); return; }
    }
    try { await git(cwd, ['rebase', '--abort']); } catch {}
    throw e;
  }
}
async function gitBefore(cwd, cur, resolve) {
  try { await git(cwd, ['rev-parse', '--is-inside-work-tree']); }
  catch (e) { throw new Error(/ENOENT/.test(e.message) ? '这台没装 Git，装好再重发' : `勾了「代码用 Git 同步」，但 ${cwd} 不是 Git 仓库：在「干活的文件夹」里填仓库所在的文件夹`); }
  if (!(await upstream(cwd))) { cur.buf.push({ t: 'info', s: 'Git：这个仓库没有对应的远端分支，跳过拉取' }); return; }
  const before = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  try { await pullResolving(cwd, cur, resolve); }
  catch (e) { throw new Error('Git 拉最新代码没成（冲突 AI 也没合上），先在这台处理好再重发：' + gitErr(e)); }
  const after = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  cur.buf.push({ t: 'info', s: before === after ? `Git：已是最新代码（${after}）` : `Git：已拉最新代码 ${before} → ${after}` });
}
async function gitAfter(cwd, prompt, cur, resolve) {
  await git(cwd, ['add', '-A']);
  let made = '';
  const dirty = await git(cwd, ['diff', '--cached', '--quiet']).then(() => false, () => true);
  if (dirty) {
    await git(cwd, [...(await whoArgs(cwd)), 'commit', '-q', '-m', `WorkBuddy（${NAME}）：${prompt.replace(/\s+/g, ' ').slice(0, 72)}`]);
    made = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  }
  const up = await upstream(cwd);
  if (!up) return made ? `Git：改动已提交 ${made}（仓库没有远端分支，没推送）` : 'Git：没有改动';
  const ahead = +(await git(cwd, ['rev-list', '--count', '@{u}..HEAD']));
  if (!ahead) return 'Git：没有改动要推送';
  for (let i = 0; ; i++) {
    try { await git(cwd, ['push', up.remote, 'HEAD:' + up.branch]); break; }
    catch (e) {
      if (i >= 2) throw new Error(`Git 推送没成，改动已提交在这台（${made || '本地'}）：` + gitErr(e));
      // 别的电脑先推了：合上它的改动再推
      try { await pullResolving(cwd, cur, resolve); }
      catch (e2) { throw new Error(`Git 和别的电脑的改动冲突，改动已提交在这台（${made || '本地'}）、没推上去：` + gitErr(e2)); }
    }
  }
  return `Git：已提交并推送 ${await git(cwd, ['rev-parse', '--short', 'HEAD'])}（${up.remote}/${up.branch}）`;
}

async function flush(cur, done, extra = {}) {
  if (!cur) return;
  const items = cur.buf.splice(0, cur.buf.length);
  if (!items.length && !done) return;
  try {
    const j = await api('/api/agent/events', { name: NAME, jobId: cur.id, items, session: cur.session, via: cur.via || '', done, ...extra });
    if (j.cancel && !done) stop();
  } catch (e) {
    cur.buf.unshift(...items); // 网络不通先攒着，下次一起补
    if (done) throw e;
  }
}

function stop() {
  if (!current || !current.child || current.stopped) return;
  current.stopped = true;
  log('收到停止指令，停掉当前任务');
  if (IS_WIN) { try { execFileSync('taskkill', ['/pid', String(current.child.pid), '/T', '/F'], { windowsHide: true }); } catch {} }
  else { try { process.kill(-current.child.pid, 'SIGTERM'); } catch { try { current.child.kill('SIGTERM'); } catch {} } }
}

// 在 cwd 里跑一轮 CodeBuddy 命令行，边跑边把进展放进 cur.buf
async function runCli(cwd, prompt, cont, cur) {
  let result = '', ok = false, error = '', cost;
  const args = ['-p', '--output-format', 'stream-json', '-y'];
  // 接着上一轮做：优先用「精确会话 id」，别再靠 -c 猜最近一个。
  // -c 在总控同时派了多件活时会续到别人的会话上（多台、多任务交错时很常见），
  // 这是「上下文莫名串了」的根源。cur.resume 是前端明确指定的会话。
  const sid = cur.resume || cur.session || '';
  if (sid) { if (CLI_FLAGS.resume) args.push('--resume', sid); else if (cont) args.push('-c'); }
  else if (cont) args.push('-c');
  cur.via = 'cli';
  // 指定专家 / 模型：命令行原生参数（--agent <专家> / --model <模型>）
  if (cur.expert && CLI_FLAGS.agent) args.push('--agent', cur.expert);
  if (cur.model && CLI_FLAGS.model) args.push('--model', cur.model);
  // 指令从标准输入送进去，不拼进命令行，免得引号、换行出问题
  // 会话分两套库：WorkBuddy 客户端建的会话在 ~/.workbuddy 下，命令行自己建的在 ~/.codebuddy 下。
  // 要接客户端跑过的会话，必须让命令行去翻客户端那套（CODEBUDDY_CONFIG_DIR 就是干这个的）。
  const env = { ...process.env, NO_COLOR: '1' };
  if (cur.resumeHome === 'client') env.CODEBUDDY_CONFIG_DIR = path.join(os.homedir(), '.workbuddy');
  else delete env.CODEBUDDY_CONFIG_DIR;
  const child = spawn(CMD, args, { cwd, shell: IS_WIN, detached: !IS_WIN, windowsHide: true, env });
  cur.child = child;
  child.stdin.end(prompt);
  let pending = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    pending += d;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { cur.buf.push({ t: 'text', s: line }); continue; }
      if (ev.session_id) cur.session = ev.session_id;
      if (ev.type === 'result') {
        ok = !ev.is_error; result = ev.result || ''; cost = ev.total_cost_usd;
        if (ev.is_error) error = (ev.errors && ev.errors.join('；')) || ev.result || ev.subtype || '出错了';
      } else cur.buf.push(...toItems(ev));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const ticker = setInterval(() => flush(cur, false), 1000);
  const code = await new Promise((resolve) => { child.on('error', (e) => { error = e.message; resolve(-1); }); child.on('close', resolve); });
  clearInterval(ticker);
  if (cur.stopped) { ok = false; error = '已按要求停下'; }
  return { ok, result, error, cost, code, stderr };
}

// 会话可能落在另一套库里（客户端一套、命令行一套）：没找到就换一套再试一次，过程里说清楚
function resumeMiss(r) {
  const txt = String((r && r.error) || '') + ' ' + String((r && r.stderr) || '') + ' ' + String((r && r.result) || '');
  return /not found|no such|no conversation|unknown session|does not exist|cannot find|找不到|没有找到/i.test(txt);
}
async function runCliResumable(cwd, prompt, cont, cur) {
  const r = await runCli(cwd, prompt, cont, cur);
  if (r.ok || !cur.resume || !resumeMiss(r)) return r;
  cur.resumeHome = cur.resumeHome === 'client' ? 'cli' : 'client';
  cur.session = '';
  cur.buf.push({ t: 'err', s: `这套会话库里找不到「${cur.resume}」，换成${cur.resumeHome === 'client' ? ' WorkBuddy 客户端' : '命令行自己'}的会话库再试一次` });
  await flush(cur, false);
  return await runCli(cwd, prompt, cont, cur);
}

// ---------- 交给 WorkBuddy 客户端执行 ----------
// 以前所有活都是 spawn 命令行跑的：活是干了，但 WorkBuddy 客户端里什么都没有，
// 用户不能在那边的会话里回看过程、也接不上话。现在改成把活写进 WorkBuddy 自己的
// 「自动化任务」表（一条一次性任务），由客户端去执行，连接程序再把结果取回来。
// 这样任务在 WorkBuddy 里有会话、有产出，客户端关着才退回命令行。
const WB_DB = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
const WB_ON = process.env.FLEET_CHANNEL !== 'cli'; // FLEET_CHANNEL=cli 可强制走命令行

function wbRun(code, timeout = 25000) {
  // 脚本写成临时文件再跑：用 -e 传长参数在 macOS 上会翻车（实测 Mac 上必失败），
  // 而且任务描述里的中文、引号一路过命令行也容易出错。
  const tmp = path.join(os.tmpdir(), `wb-db-${process.pid}.js`);
  const src = `const{DatabaseSync}=require('node:sqlite');`
    + `const db=new DatabaseSync(${JSON.stringify(WB_DB)});`
    + `try{db.exec('PRAGMA busy_timeout=12000')}catch(e){}`
    + code;
  fs.writeFileSync(tmp, src, 'utf8');
  let r;
  try { r = spawnSync(process.execPath, ['--experimental-sqlite', tmp], { encoding: 'utf8', timeout, windowsHide: true }); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const d = String(r.stderr || '').split('\n')
      .filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/i.test(l)).slice(-3).join(' ');
    throw new Error(d || `脚本退出码 ${r.status}`);
  }
  return String(r.stdout || '').trim();
}

// 总控给的专家是包名（senior-developer），客户端认的是 ex_xxx：用 WorkBuddy 自己的映射表反查
function wbExpert(id) {
  if (!id) return { expertId: '', marketplace: '' };
  try {
    const f = path.join(os.homedir(), '.workbuddy', 'app', 'cache', 'experts', 'expert-bundle-map.json');
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    const hit = Object.entries(m).find(([k, v]) => v === id && /^ex_/.test(k));
    if (hit) return { expertId: hit[0], marketplace: 'experts' };
  } catch {}
  return { expertId: '', marketplace: '' };
}

// 写一条一次性自动化任务，让 WorkBuddy 客户端去跑
function wbSubmit(cwd, prompt, cur) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const name = `wb-fleet｜${prompt.replace(/\s+/g, ' ').slice(0, 40)}`;
  const ex = wbExpert(cur.expert);
  // 各台装的 WorkBuddy 版本不一样，automations 的列也不同（老版本没有 workspace_scope，
  // 硬写会整条插入失败）。所以先读本机表结构，只写它真有的列。
  const want = {
    id, name, prompt, status: 'ACTIVE', schedule_type: 'once',
    next_run_at: now,                                  // 客户端的调度依据，不填就没人跑（实测）
    scheduled_at: new Date(now).toISOString(),
    cwds: JSON.stringify([cwd]),
    model_id: cur.model || '', model_is_thinking: 0,
    created_at: now, updated_at: now,
    skills_json: '[]', push_to_wechat: 0, push_to_wecom_bot: 0,
    owner_status: 'confirmed', connector_ids_json: '[]', permission_mode: 'fullAccess',
    workspace_scope: 'workspace',
    expert_id: ex.expertId, expert_marketplace: ex.marketplace,
  };
  const code = `
    const owner = db.prepare("select owner_user_id from automations where owner_user_id is not null and owner_user_id<>'' order by created_at desc limit 1").get();
    const want = ${JSON.stringify(want)};
    if (owner && owner.owner_user_id) want.owner_user_id = owner.owner_user_id;
    const cols = db.prepare('pragma table_info(automations)').all().map(x => x.name);
    const use = Object.keys(want).filter(k => cols.includes(k) && want[k] !== null && want[k] !== '');
    const sql = 'insert into automations (' + use.join(',') + ') values (' + use.map(() => '?').join(',') + ')';
    db.prepare(sql).run(...use.map(k => want[k]));
    console.log(JSON.stringify({ id: want.id, owner: want.owner_user_id || '', cols: use.length }));
  `;
  const out = JSON.parse(wbRun(code).split('\n').pop());
  cur.wbId = id;
  cur.wbName = name;
  return out;
}

// 问客户端：这条任务跑到哪一步了（只取小字段，别把整段对话读出来）
function wbStat(id) {
  const code = `
    const cols = db.prepare('pragma table_info(automation_runs)').all().map(x => x.name);
    const sel = ['thread_id','status','result_success'].filter(k => cols.includes(k));
    const r = db.prepare('select ' + sel.join(',') + ' from automation_runs where automation_id=? order by created_at desc limit 1').get(${JSON.stringify(id)});
    console.log(r ? JSON.stringify({thread:r.thread_id,status:r.status,success:(r.result_success === undefined ? null : r.result_success)}) : 'null');
  `;
  return JSON.parse(wbRun(code, 15000) || 'null');
}

// 跑完了，把产出取回来
function wbOutput(id) {
  const code = `
    const r=db.prepare("select runs_json from automation_runs where automation_id=? order by created_at desc limit 1").get(${JSON.stringify(id)});
    let out='',ok=null,cid='';try{const a=JSON.parse(r.runs_json||'[]');const x=a[0]||{};out=x.output||'';ok=x.success===undefined?null:!!x.success;cid=x.conversationId||x.conversation_id||x.sessionId||x.session_id||''}catch(e){}
    console.log(JSON.stringify({ok:ok,output:String(out).slice(0,60000),cid:String(cid)}));
  `;
  try { return JSON.parse(wbRun(code, 25000)); } catch { return { ok: null, output: '', cid: '' }; }
}

function wbCancel(id) {
  try {
    wbRun(`db.prepare("update automations set status='PAUSED', updated_at=? where id=?").run(Date.now(), ${JSON.stringify(id)}); console.log('ok')`, 12000);
  } catch {}
}

// 返回 {ok,result,error} 或 {fallback:'原因'}（说明客户端没接手，让调用方退回命令行）
async function runInWorkBuddy(cwd, prompt, cur) {
  if (!fs.existsSync(WB_DB)) return { fallback: '这台没装 WorkBuddy（找不到 workbuddy.db）' };
  try { wbSubmit(cwd, prompt, cur); }
  catch (e) { return { fallback: '没写进 WorkBuddy 的任务表：' + String(e.message || e).slice(0, 200) }; }
  cur.buf.push({ t: 'info', s: `已交给本机 WorkBuddy 客户端执行，任务名「${cur.wbName}」——在 WorkBuddy 里能看到这一轮的完整过程` });
  await flush(cur, false);
  const t0 = Date.now(), LIMIT = 45 * 60e3, GRACE = 90e3;
  let seen = false, lastBeat = Date.now(), lockFails = 0;
  for (;;) {
    await sleep(4000);
    if (cur.stopped) { wbCancel(cur.wbId); return { ok: false, result: '', error: '已按要求停下' }; }
    let s = null;
    try { s = wbStat(cur.wbId); } catch { lockFails++; } // 库被客户端锁着是常事，下次再问
    if (s) {
      lockFails = 0;
      if (!seen) { seen = true; cur.buf.push({ t: 'info', s: 'WorkBuddy 已接手，正在跑（客户端「自动化」里能看进度）' }); await flush(cur, false); }
      if (s.success !== null && s.success !== undefined) {
        const o = wbOutput(cur.wbId);
        // 把客户端这次建的会话 id 记下来：下一轮「接着这个会话」就靠它，
        // 否则前端选会话时列表里永远看不到客户端跑过的那些。
        if (o.cid) cur.session = String(o.cid).slice(0, 80);
        cur.via = 'client';
        const okay = s.success !== 0 && s.success !== false;
        return { ok: okay, result: o.output || '', error: okay ? '' : (o.output || 'WorkBuddy 这次报的是没成功，但没有给原因') };
      }
    }
    if (!seen && Date.now() - t0 > GRACE) return { fallback: 'WorkBuddy 客户端 90 秒没接手（桌面端可能没开），这次先用命令行跑' };
    if (Date.now() - t0 > LIMIT) { wbCancel(cur.wbId); return { ok: false, result: '', error: 'WorkBuddy 那边跑了 45 分钟还没结束，先停下了' }; }
    if (Date.now() - lastBeat > 30000) {
      lastBeat = Date.now();
      cur.buf.push({ t: 'info', s: `WorkBuddy 还在跑（${Math.round((Date.now() - t0) / 60000)} 分钟）${lockFails > 3 ? '，任务库一时读不到，稍后再看' : ''}` });
      await flush(cur, false);
    }
  }
}

async function runJob(job) {
  const cwd = expandHome(job.workdir) || WORKDIR;
  log(`领到任务 ${job.id}：${job.prompt.slice(0, 60)}${job.expert ? '｜专家 ' + job.expert : ''}${job.model ? '｜模型 ' + job.model : ''}`);
  const cur = current = { id: job.id, buf: [], session: '', resume: String(job.session || ''), resumeHome: job.sessionHome === 'client' ? 'client' : 'cli', via: '', stopped: false, expert: job.expert || '', model: job.model || '' };
  let result = '', ok = false, error = '', cost;
  try {
    // 以前这里无脑 fs.mkdirSync：填错的路径会被悄悄建成空文件夹，任务在空壳里干完活，
    // 表面看不出问题，只觉得「没在 WorkBuddy 指定的目录里跑」。现在先检查，缺了就明确报错。
    let has = false;
    try { has = fs.statSync(cwd).isDirectory(); } catch {}
    if (!has && job.mkdir) { fs.mkdirSync(cwd, { recursive: true }); has = true; }
    if (!has) {
      refreshDirs(true);
      const near = DIRS.filter((d) => d.proj).slice(0, 12).map((d) => d.p);
      throw new Error(`这台电脑上没有「${cwd}」这个文件夹，任务没有开跑（免得又在空目录里白干一场）。`
        + (near.length
          ? `\n本机真实存在的项目目录：\n${near.map((x) => '· ' + x).join('\n')}\n把总控上这台的「目录」改成其中某一个，或把这次任务的目录填成它，再重发即可。`
          : '\n本机没扫到现成的项目目录，请在总控上把这台的目录改成这台电脑上实际存在的路径。'));
    }
    // 把「指定了什么」摆到明面上，网页上一眼能看见
    if (cur.expert || cur.model) {
      const bits = [];
      if (cur.expert) {
        const hit = EXPERTS.find((e) => e.id === cur.expert);
        bits.push(`专家 ${hit ? hit.name + '（' + cur.expert + '）' : cur.expert}`);
      }
      if (cur.model) bits.push(`模型 ${cur.model}`);
      cur.buf.push({ t: 'info', s: '这件活指定了：' + bits.join('，') });
      if (cur.expert && !CLI_FLAGS.agent) cur.buf.push({ t: 'err', s: `这台的命令行不支持 --agent，专家没生效（会按默认跑）：升级命令行 codebuddy upgrade` });
      else if (cur.expert && !EXPERTS.some((e) => e.id === cur.expert)) cur.buf.push({ t: 'err', s: `这台没装专家「${cur.expert}」，命令行会退回默认专家：先在 WorkBuddy「专家」里装上它` });
      if (cur.model && !CLI_FLAGS.model) cur.buf.push({ t: 'err', s: '这台的命令行不支持 --model，模型没生效：升级命令行 codebuddy upgrade' });
      await flush(cur, false);
    }
    // 解冲突时接着这件的对话做（开工前还没有对话，就新开一轮）
    const resolve = (p) => runCliResumable(cwd, p, !!cur.session, cur);
    if (job.git) await gitBefore(cwd, cur, resolve);
    // 前端明确要求「接着某个会话」：这轮只能走命令行（客户端任务表没有会话字段，
    // 写进去必然是全新会话，接不上）。这里直接拦在客户端通道前面，并说明原因。
    if (cur.resume) {
      cur.buf.push({ t: 'info', s: `接着会话 ${cur.resume} 继续：这轮走命令行，能带上上一轮的上下文（WorkBuddy 客户端的「自动化」列表里不会有这一条）` });
      if (!CLI_FLAGS.resume) cur.buf.push({ t: 'err', s: '这台的命令行不支持 --resume，续接会退化成新会话：跑一次 codebuddy upgrade 升级命令行' });
      await flush(cur, false);
    }
    // 先交给 WorkBuddy 客户端跑（那边会留会话、能回看）；客户端没开着才退回命令行
    // 升级任务除外：它要重启连接程序自己，绕客户端没意义还容易丢结果
    // 指定了会话也除外：客户端通道接不上旧会话
    let r = null;
    if (WB_ON && !job.cont && !job.session && job.kind !== 'upgrade') {
      const w = await runInWorkBuddy(cwd, job.prompt, cur);
      if (w && w.fallback) { cur.buf.push({ t: 'info', s: `${w.fallback}，这次改用命令行执行` }); await flush(cur, false); }
      else r = w;
    }
    if (!r) r = await runCliResumable(cwd, job.prompt, job.cont, cur);
    // 客户端建的会话，命令行读不到（会话库和登录态都不共用，实测报 No conversation found / Authentication required）：
    // 改成在客户端开一条新会话，把上一轮的结论当上文带过去，并在过程里说清楚，别让人以为上下文还在
    if (job.session && !r.ok && job.sessionCtx && WB_ON && job.kind !== 'upgrade') {
      const txt = String(r.error || '') + ' ' + String(r.stderr || '');
      if (resumeMiss(r) || /Authentication required|请先登录/i.test(txt)) {
        cur.buf.push({ t: 'err', s: '这条会话是 WorkBuddy 客户端跑的，命令行读不到它的会话库和登录态；改成在客户端开一条新会话，把上一轮的结论带过去' });
        await flush(cur, false);
        cur.resume = ''; cur.session = ''; cur.resumeHome = 'client';
        const withCtx = `【接着上一轮继续】下面是上一轮在这条会话里做出来的结论（原始上下文没法原样搬过来，只能带结论）：\n${String(job.sessionCtx).slice(0, 6000)}\n\n—— 这一轮要做的事 ——\n${job.prompt}`;
        const w = await runInWorkBuddy(cwd, withCtx, cur);
        if (w && w.fallback) { cur.buf.push({ t: 'err', s: w.fallback + '：这轮没接上上一轮' }); await flush(cur, false); }
        else r = w;
      }
    }
    ({ ok, result, error, cost } = r); const code = r.code === undefined ? 0 : r.code, stderr = r.stderr || '';
    if (cur.stopped) { ok = false; error = '已按要求停下'; }
    else if (!result && !error && code !== 0) error = stderr.trim() || `退出码 ${code}`;
    else if (code !== 0 && !error && !ok) error = stderr.trim();
    if (job.git && ok) {
      try { const g = await gitAfter(cwd, job.title || job.prompt, cur, resolve); cur.buf.push({ t: 'info', s: g }); result = (result ? result + '\n\n' : '') + g; }
      catch (e) { ok = false; error = e.message; }
    }
  } catch (e) { error = e.message; }
  error = friendlyError(error);
  log(`任务 ${job.id} ${ok ? '完成' : '没成：' + error}`);
  // 先腾出手（总控收到结果就会派下一件），结果一定要交回去，网络不通就一直重试
  current = null;
  for (let n = 0; ; n++) {
    try { await flush(cur, true, { ok, result, error, cost }); break; }
    catch (e) { await sleep(Math.min(30000, 2000 * (n + 1))); }
  }
}

// ---------- 自动更新 ----------
// 总控说它那边有更新的连接程序（agentV）时，自己下载、校验语法、备份后换掉，然后退出让外层的
// loop-agent.cmd 重新拉起 —— 这样老机器不用一台台去重跑加入命令。
const vm = require('vm');
let updateTried = '';
function verParts(v) { const p = String(v || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
function isNewer(a, b) { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }
async function selfUpdate(latest) {
  if (process.env.FLEET_NO_UPDATE === '1') return false;
  if (updateTried === latest) return false;
  updateTried = latest;
  const self = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!self || !fs.existsSync(self)) return false;
  log(`发现新版本连接程序 ${latest}（当前 ${VERSION}），自动更新`);
  try {
    const r = await fetch(HUB + '/agent.js');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const src = await r.text();
    if (!src.includes(`const VERSION = '${latest}'`)) throw new Error('总控上的版本和它说的不一致');
    new vm.Script(src, { filename: 'agent.js' }); // 语法先过一遍，坏的绝不上盘
    fs.writeFileSync(self + '.new', src);
    if (!fs.existsSync(self + '.bak')) fs.copyFileSync(self, self + '.bak');
    fs.renameSync(self + '.new', self);
    log('连接程序已更新，重启接管');
    setTimeout(() => process.exit(0), 800);
    return true;
  } catch (e) {
    log('自动更新没成，继续用当前版本：' + e.message);
    return false;
  }
}

async function main() {
  await sleep(1000); lastCpu = cpuLoad() ?? 0; // 先量一秒，第一次报上去的 CPU 就准
  try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch {}
  refreshDirs(true);
  refreshSkills(true);
  log(`WorkBuddy 连接程序 ${VERSION} 启动：名字「${NAME}」，总控 ${HUB}，默认文件夹 ${WORKDIR}，命令行 ${CLI || '没找到'}，本机专家 ${EXPERTS.length} 个，可干活目录 ${DIRS.length} 个，本机技能 ${SKILLS.length} 个`);
  // 技能共享：独立轮询，不占派活那条长连接
  setInterval(() => { skillLoop().catch(() => {}); }, 3000);
  let fails = 0, lastCliCheck = Date.now();
  for (;;) {
    try {
      if (!CLI && Date.now() - lastCliCheck > 60000) { CLI = cliVersion(); lastCliCheck = Date.now(); }
      if (Date.now() - expertAt > 600000) { EXPERTS = scanExperts(); expertAt = Date.now(); }
      refreshDirs(false);
      const c = cpuLoad(); if (c !== undefined) lastCpu = c;
      const j = await api('/api/agent/poll', { name: NAME, os: `${os.type()} ${os.release()} ${os.arch()}`, host: os.hostname(), agentVersion: VERSION, cli: CLI, workdir: WORKDIR, cpu: lastCpu, running: current && current.id, experts: EXPERTS, dirs: DIRS }, 40000);
      if (fails) log('连上总控了');
      fails = 0;
      if (j.cancel && current && j.cancel.includes(current.id)) stop();
      if (j.agentV && !current && isNewer(j.agentV, VERSION)) { if (await selfUpdate(j.agentV)) return; }
      if (j.job && !current) runJob(j.job); // 不等它干完，继续去领停止指令
    } catch (e) {
      fails++;
      if (fails === 1 || fails % 20 === 0) log('连不上总控，稍后重试：', e.message);
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(fails, 5)));
    }
  }
}
process.on('SIGINT', () => { stop(); process.exit(0); });
main();
