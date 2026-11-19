// 测试：客户端结果的提取（会话 jsonl → 最终答复 + 产出文件）
// 这是「没有反馈、最终交付在哪」的核心修复：
// 客户端不把答复写进 automation_runs，只在会话 jsonl 里，以前读到的永远是空的。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let pass = 0;
const ok = (c, n) => { assert.ok(c, 'FAIL: ' + n); pass++; console.log('  ✓ ' + n); };

// ---- 复制 agent.js 里的实现（保持一致）----
let WB_PROJECTS = path.join(os.homedir(), '.workbuddy', 'projects');
function projSlug(cwd) {
  let s = String(cwd || '').replace(/\\/g, '/').replace(/:/g, '/');
  s = s.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\//g, '-').replace(/-+/g, '-');
  if (/^[a-zA-Z]-/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s || 'default';
}
function sessionTexts(jsonlPath) {
  const out = [];
  let txt = '';
  try { txt = fs.readFileSync(jsonlPath, 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'message' && o.role === 'assistant' && Array.isArray(o.content)) {
      for (const c of o.content) {
        if ((c.type === 'output_text' || c.type === 'text') && c.text && c.text.trim()) out.push(c.text.trim());
      }
    }
  }
  return out;
}
function findSessionFile(cid, cwd) {
  if (!cid) return null;
  const dirs = [];
  const guess = path.join(WB_PROJECTS, projSlug(cwd));
  if (fs.existsSync(guess)) dirs.push(guess);
  try { for (const d of fs.readdirSync(WB_PROJECTS)) { const p = path.join(WB_PROJECTS, d); if (!dirs.includes(p)) dirs.push(p); } } catch {}
  for (const d of dirs) {
    const f = path.join(d, cid + '.jsonl');
    try { if (fs.existsSync(f)) return f; } catch {}
  }
  return null;
}
function sessionFiles(jsonlPath) {
  const set = new Set();
  let txt = '';
  try { txt = fs.readFileSync(jsonlPath, 'utf8'); } catch { return []; }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    if (line.indexOf('"function_call"') < 0) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'function_call') continue;
    const nm = String(o.name || '');
    if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(nm)) continue;
    let args = o.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
    if (!args || typeof args !== 'object') continue;
    const fp = args.file_path || args.filePath || args.path || '';
    if (fp) set.add(String(fp).slice(0, 300));
  }
  return [...set].slice(0, 40);
}
function clientResult(cid, cwd) {
  const f = findSessionFile(cid, cwd);
  if (!f) return { text: '', files: [] };
  const texts = sessionTexts(f);
  const last = texts.length ? texts[texts.length - 1] : '';
  const text = last.length >= 40 ? last : texts.join('\n\n');
  return { text: String(text || '').slice(0, 60000), files: sessionFiles(f) };
}

// ---- 造一份假的会话文件来测 ----
const TMP = path.join(os.tmpdir(), 'wb-fake-proj-' + process.pid);
const SLUG = projSlug('E:/workspaces/dev/Octop');
const DIR = path.join(TMP, SLUG);
fs.mkdirSync(DIR, { recursive: true });
WB_PROJECTS = TMP; // 让查找函数在临时目录里找
const CID = 'test-cid-1234';
const lines = [
  JSON.stringify({ type: 'session-meta', id: CID }),
  JSON.stringify({ type: 'reasoning', text: '想了一下' }),
  JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我写个脚本' }] }),
  JSON.stringify({ type: 'function_call', name: 'Write', arguments: JSON.stringify({ file_path: 'E:/workspaces/dev/Octop/build.py' }) }),
  JSON.stringify({ type: 'function_call_result', name: 'Write', output: { type: 'text', text: 'ok' } }),
  JSON.stringify({ type: 'function_call', name: 'Edit', arguments: JSON.stringify({ file_path: 'E:/workspaces/dev/Octop/build.py' }) }),
  JSON.stringify({ type: 'function_call', name: 'Read', arguments: JSON.stringify({ file_path: 'E:/workspaces/dev/Octop/别的.md' }) }),
  JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经写好 build.py 了，直接跑就行。' }] }),
  JSON.stringify({ type: 'function_call', name: 'Write', arguments: JSON.stringify({ file_path: 'E:/workspaces/dev/Octop/README.md' }) }),
];
fs.writeFileSync(path.join(DIR, CID + '.jsonl'), lines.join('\n'));

console.log('\n[1] 目录名映射');
ok(SLUG === 'e-workspaces-dev-Octop', 'Windows 盘符路径 → ' + SLUG);
ok(projSlug('/Users/shan/works/proj') === 'Users-shan-works-proj', 'Mac 路径 → ' + projSlug('/Users/shan/works/proj'));
ok(projSlug('C:\\Users\\Administrator\\WorkBuddy\\写书') === 'c-Users-Administrator-WorkBuddy-写书', '跟客户端实际目录名一致');
ok(projSlug('') === 'default', '空路径 → default');

console.log('\n[2] 从会话里取答复');
const r = clientResult(CID, 'E:/workspaces/dev/Octop');
ok(r.text.includes('已经写好 build.py'), '取到了 assistant 的最终答复');
ok(r.text.length < 100, '拿到的是最后一轮，不是全部历史');

console.log('\n[3] 取产出文件（这就是「交付在哪」）');
ok(r.files.length === 2, '2 个产出文件（' + r.files.length + '）');
ok(r.files.some((f) => f.endsWith('build.py')), '包含 build.py');
ok(r.files.some((f) => f.endsWith('README.md')), '包含 README.md');
ok(!r.files.some((f) => f.endsWith('别的.md')), 'Read 读的文件不算产出');

console.log('\n[4] 找不到会话时不报错');
const r2 = clientResult('不存在的会话', 'E:/workspaces/dev/Octop');
ok(r2.text === '' && r2.files.length === 0, '返回空，不抛异常');

console.log('\n[5] 答复太短时把前几轮也带上');
const CID2 = 'short-cid';
fs.writeFileSync(path.join(DIR, CID2 + '.jsonl'), [
  JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }),
].join('\n'));
const r3 = clientResult(CID2, 'E:/workspaces/dev/Octop');
ok(r3.text === '好的', '短答复也带上了');

console.log('\n[6] 真实客户端会话也能读出来（回归）');
WB_PROJECTS = path.join(os.homedir(), '.workbuddy', 'projects');
let realOk = false, realSample = '';
try {
  const dirs = fs.readdirSync(WB_PROJECTS).slice(0, 40);
  for (const d of dirs) {
    const p = path.join(WB_PROJECTS, d);
    let fs2 = []; try { fs2 = fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).slice(0, 6); } catch { continue; }
    for (const f of fs2) {
      const t = sessionTexts(path.join(p, f));
      if (t.length) { realOk = true; realSample = t[t.length - 1].slice(0, 60); break; }
    }
    if (realOk) break;
  }
} catch {}
ok(realOk, '真实会话里能提取到文字' + (realSample ? '：' + realSample : ''));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n全部通过：${pass} 项`);
