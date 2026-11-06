#!/usr/bin/env node
// 飞书表 → 自动开发：在一张飞书多维表格里填缺陷或功能，总控自动读、判级别（紧急／重要／加大力度发展）、
// 按级别排队派给空闲电脑的 WorkBuddy 走「分析→开发→测试→交付」，进度和结果写回表里。只用 Node 自带模块（Node 18+）。
//
// 第一次：node feishu-board.js setup --app-id 飞书应用ID --app-secret 飞书应用密钥 --owner 你的邮箱或open_id
//         [--ai-url 兼容 OpenAI 的接口地址 --ai-key 钥匙 --ai-model 模型名]   （不填 AI 就按关键字判级别）
//   会新建一张表、给你加上管理权限，把设置写进 data/feishu-board.json；之后照常 node hub.js，总控自己接上这张表。
// 飞书应用要开的权限：多维表格（bitable:app）、云文档权限管理（drive:permission:member 或 drive:drive）。
//
// 表里怎么用：
//   - 新加一行，填「标题」「描述」（「类型」「验收标准」「项目文件夹」可不填），十几秒后自动判级别、排队。
//   - 「级别」自己先填了就按你填的；排队时改级别，马上按新级别重排。
//   - 「状态」选「停下」就把这件停掉；做完或没做成的，把「状态」清空就重做一遍。
//   - 「项目文件夹」填每台电脑上代码所在的文件夹（如 ~/code/linmo）；勾「自动提交推送」就开工前拉最新代码、做完自动提交推送。
'use strict';
const fs = require('fs');
const path = require('path');

const F = { title: '标题', type: '类型', desc: '描述', accept: '验收标准', prio: '级别', status: '状态', machine: '执行电脑', result: '结果', reason: '判定理由', dir: '项目文件夹', git: '自动提交推送', start: '开始时间', end: '完成时间', id: '任务编号' };
const ST = { queued: '排队中', running: '开发中', done: '已完成', failed: '没做成', stopped: '已停', stop: '停下' };
const PRIOS = ['紧急', '重要', '加大力度发展'];

// ---------- 飞书接口 ----------
function feishu(cfg) {
  const base = (cfg.domain || 'https://open.feishu.cn').replace(/\/$/, '');
  let tok = null, tokExp = 0;
  async function call(method, p, body, auth = true) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (auth) headers.Authorization = 'Bearer ' + (await token());
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({ code: r.status, msg: 'HTTP ' + r.status }));
    if (j.code !== 0) { const e = new Error(`飞书 ${p.split('?')[0]}：${j.code} ${j.msg || ''}`); e.code = j.code; throw e; }
    return j.data || {};
  }
  async function token() {
    if (tok && Date.now() < tokExp) return tok;
    const r = await fetch(base + '/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (j.code !== 0) throw new Error('飞书应用钥匙不对：' + j.msg);
    tok = j.tenant_access_token; tokExp = Date.now() + (j.expire - 300) * 1000;
    return tok;
  }
  const tb = () => `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}`;
  return {
    call,
    async records() {
      const out = []; let pt = '';
      do {
        const d = await call('POST', `${tb()}/records/search?page_size=500${pt ? '&page_token=' + encodeURIComponent(pt) : ''}`, {});
        out.push(...(d.items || [])); pt = d.has_more ? d.page_token : '';
      } while (pt);
      return out;
    },
    async update(list) {
      for (let i = 0; i < list.length; i += 400) await call('POST', `${tb()}/records/batch_update`, { records: list.slice(i, i + 400) });
    },
  };
}

// 表格里的值转成文字（文本是一段段的，单选是字符串，网址是对象）
function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? x.text || x.name || '' : String(x))).join('').trim();
  if (typeof v === 'object') return String(v.text || v.link || v.name || '').trim();
  return '';
}

// ---------- 判级别 ----------
const RULES = `紧急：正式环境/线上出错、打不开、用不了，数据错或丢，安全问题，挡住客户、演示或验收，今天明天就要。
重要：影响主要功能或很多人，但暂时有绕过的办法；客户或负责人明确要的功能；不做会耽误本月目标。
加大力度发展：新能力、体验优化、提效、技术储备，长期有价值但不急。`;
function byKeywords(it) {
  const s = `${it.title} ${it.desc}`;
  const bug = it.type === '缺陷' || /报错|错误|打不开|用不了|失败|异常|崩|bug|404|500|不显示|没反应/i.test(s);
  if (bug && /线上|正式|生产|客户|演示|验收|今天|明天|马上|阻塞|卡住|丢失|数据错|安全|泄露|全部|所有人/.test(s)) return { prio: 0, reason: '缺陷且影响正式环境、客户或有近期截止（按关键字判）' };
  if (bug) return { prio: 1, reason: '缺陷，影响使用但没提到线上或截止（按关键字判）' };
  if (/客户|必须|核心|本月|负责人要/.test(s)) return { prio: 1, reason: '客户或负责人明确要的功能（按关键字判）' };
  return { prio: 2, reason: '新功能或优化，长期有价值但不急（按关键字判）' };
}
async function classify(cfg, it) {
  if (!cfg.ai || !cfg.ai.url || !cfg.ai.key) return byKeywords(it);
  try {
    const r = await fetch(cfg.ai.url.replace(/\/$/, '') + (/\/chat\/completions$/.test(cfg.ai.url) ? '' : '/chat/completions'), {
      method: 'POST', signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.ai.key },
      body: JSON.stringify({ model: cfg.ai.model, temperature: 0, messages: [
        { role: 'system', content: `你是研发负责人，给一件缺陷或功能定级别。三个级别：\n${RULES}\n只按描述里写明的事实判，不推测没写的影响和截止：没写出错、没写客户或负责人要、没写截止的新功能和优化，就是加大力度发展。\n只回一行 JSON：{"级别":"紧急|重要|加大力度发展","理由":"一句话，引用描述里的依据"}` },
        { role: 'user', content: `类型：${it.type || '没填'}\n标题：${it.title}\n描述：${it.desc || '没填'}\n验收标准：${it.accept || '没填'}` },
      ] }),
    });
    const j = await r.json();
    const s = (j.choices && j.choices[0] && j.choices[0].message.content) || '';
    const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    const p = PRIOS.indexOf(String(o['级别']).trim());
    if (p < 0) throw new Error('级别不认识：' + o['级别']);
    return { prio: p, reason: String(o['理由'] || '').slice(0, 300) };
  } catch (e) {
    const k = byKeywords(it); k.reason += `；AI 没判成：${String(e.message || e).slice(0, 80)}`; return k;
  }
}

// ---------- 交给电脑的话：开发全流程 ----------
function devPrompt(it) {
  const bug = it.type === '缺陷';
  return `这是一件${it.type || '开发任务'}，按开发全流程做完。
标题：${it.title}
描述：${it.desc || '（没写，按标题理解）'}
验收标准：${it.accept || '（没写，你按描述定一个能检验的标准，并在最后写出来）'}

按顺序做，每步做完再做下一步：
1. 分析：${bug ? '先复现这个问题，找到出错的根本原因（不是只挡住现象）' : '理清要做成什么样、要改哪些地方，先看项目里有没有现成的写法可以照着做'}。
2. 开发：改代码。只改和这件有关的地方，照项目现有的写法和风格。
3. 测试：跑项目已有的测试；再为这件补一个测试或验证步骤并实际跑通。没通过就回到第 2 步改，直到通过。
4. 交付：最后只用下面的格式回答（中文大白话）：
结论：做成了／没做成（一句话）
${bug ? '原因' : '做法'}：……
改了哪些：……
怎么测的、结果：……
还要人做的：……（没有就写「无」）`;
}

// ---------- 主循环：读表 → 判级别、派活 → 写回 ----------
function start(hub) {
  const cfg = JSON.parse(fs.readFileSync(hub.cfgFile, 'utf8'));
  const api = feishu(cfg);
  const log = (...a) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), '[飞书表]', ...a);
  const POLL = Math.max(5, +cfg.pollSec || 15) * 1000;
  let busy = false, lastErr = '';
  log(`已接上 ${cfg.url || cfg.appToken}，每 ${POLL / 1000} 秒看一次`);

  async function tick() {
    if (busy) return; busy = true;
    try {
      const rows = [];
      for (const row of await api.records()) {
        const f = row.fields || {};
        const it = { title: text(f[F.title]), type: text(f[F.type]), desc: text(f[F.desc]), accept: text(f[F.accept]), dir: text(f[F.dir]), git: f[F.git] === true };
        if (!it.title && !it.desc) continue;
        const cur = { prio: text(f[F.prio]), status: text(f[F.status]), id: text(f[F.id]), start: f[F.start] || null, end: f[F.end] || null };
        rows.push({ row, f, it, cur, want: {}, t: cur.id ? hub.get(cur.id) : null });
      }
      // 新的一件，或清空状态要重做：没填级别就自动判；一次来好几件时先判完、按级别交，免得空着的电脑先领走低级别的
      const fresh = rows.filter((x) => !x.cur.status);
      for (const x of fresh) {
        x.prio = PRIOS.indexOf(x.cur.prio);
        if (x.prio < 0) { const c = await classify(cfg, x.it); x.prio = c.prio; x.want[F.prio] = PRIOS[c.prio]; x.want[F.reason] = '自动：' + c.reason; }
      }
      for (const x of fresh.sort((a, b) => a.prio - b.prio)) {
        // 上次写表没成功、活其实已经交过的，别重复交
        const id = x.t && x.t.src === x.row.record_id && !finished(x.t) ? x.t.id : hub.add({ prompt: devPrompt(x.it), workdir: x.it.dir, git: x.it.git, prio: x.prio, src: x.row.record_id, meta: x.it });
        x.t = hub.get(id);
        Object.assign(x.want, { [F.id]: id, [F.machine]: '', [F.result]: '', [F.start]: null, [F.end]: null });
        log(`新的一件「${x.it.title.slice(0, 30)}」→ ${PRIOS[x.prio]}，任务 ${id}`);
      }
      const ups = [];
      for (const x of rows) {
        const { row, f, cur, want } = x; let t = x.t;
        // 接着做过几轮的，看最新那一轮
        for (let n = t && hub.child(t.id); n; n = hub.child(n.id)) { t = n; want[F.id] = n.id; }
        if (cur.status === ST.stop) {
          if (t) hub.stop(t.id); else want[F.status] = ST.stopped;
        } else if (!t && (cur.status === ST.queued || cur.status === ST.running)) {
          Object.assign(want, { [F.status]: ST.failed, [F.result]: '总控里找不到这件了（总控换过数据），把「状态」清空就重做' });
        }
        if (t && t.src === row.record_id && cur.status !== ST.done && cur.status !== ST.failed && cur.status !== ST.stopped) {
          // 排着队时改了级别，按新级别重排
          const p = PRIOS.indexOf(want[F.prio] || cur.prio);
          if (p >= 0 && Object.keys(t.runs).length === 0) hub.setPrio(t.id, p);
          Object.assign(want, progress(t, hub));
        }
        const diff = {};
        for (const [k, v] of Object.entries(want)) {
          const old = k === F.start || k === F.end ? cur[k === F.start ? 'start' : 'end'] : text(f[k]);
          if ((old || '') !== (v || '')) diff[k] = v;
        }
        if (Object.keys(diff).length) ups.push({ record_id: row.record_id, fields: diff });
      }
      if (ups.length) await api.update(ups);
      if (lastErr) { log('恢复正常'); lastErr = ''; }
    } catch (e) {
      const m = String(e.message || e);
      if (m !== lastErr) log('出错：' + m);
      lastErr = m;
    } finally { busy = false; }
  }
  setInterval(tick, POLL).unref();
  setTimeout(tick, 1000);
  return {
    // 电脑说做完了却没按四步走完（没给「结论」）：当场接着交给它做，最多 MAX_ROUNDS 轮
    onDone(t) {
      const it = t.meta;
      if (!it || !unfinished(t) || (t.round || 1) >= MAX_ROUNDS || hub.child(t.id)) return;
      const id = hub.add({ prompt: `上一轮还没按要求做完（最后没有给出「结论」）。在同一个项目里接着把这件做完：已经做好的不用重做，直接动手做剩下的步骤，别只说打算做什么。\n\n${devPrompt(it)}`, workdir: it.dir, git: it.git, prio: prioOf(t), src: t.src, after: t.id, round: (t.round || 1) + 1, meta: it });
      log(`「${it.title.slice(0, 30)}」第 ${t.round || 1} 轮没做完，接着做，任务 ${id}`);
    },
  };
}

const MAX_ROUNDS = 3;
const prioOf = (t) => (t.prio === 0 || t.prio === 1 || t.prio === 2 ? t.prio : 1);
const CONCLUDED = /结论[:：]\s*\**\s*(做成|没做成)/;
const doneRun = (t) => Object.values(t.runs).find((r) => r.status === 'done');
const unfinished = (t) => { const r = doneRun(t); return !!r && !CONCLUDED.test(r.result || ''); };
const finished = (t) => {
  const rs = Object.values(t.runs);
  if (!rs.length) return !!t.stopped;
  return rs.every((r) => ['done', 'failed', 'stopped'].includes(r.status));
};
// 总控里这件的进度 → 表里的几列
function progress(t, hub) {
  const e = Object.entries(t.runs)[0];
  if (!e) {
    if (t.stopped) return { [F.status]: ST.stopped, [F.result]: t.note || '已停' };
    const n = hub.rank(t.id);
    return { [F.status]: ST.queued, [F.machine]: '', [F.start]: null, [F.result]: hub.onlineCount() ? `排第 ${n} 位，等空闲电脑` : `排第 ${n} 位；现在没有电脑在线，开机连上就开始` };
  }
  const [name, r] = e;
  const out = { [F.machine]: name, [F.start]: r.startedAt || null };
  if (['queued', 'sent', 'running'].includes(r.status)) {
    out[F.status] = ST.running;
    const last = [...(r.items || [])].reverse().find((i) => i.t === 'text' || i.t === 'tool');
    out[F.result] = last ? '正在做：' + last.s.replace(/\s+/g, ' ').slice(0, 200) : '开工了';
    return out;
  }
  const res = String(r.result || '').trim();
  out[F.end] = r.endedAt || null;
  let note = r.status === 'done' ? '' : r.error;
  if (r.status === 'done' && !CONCLUDED.test(res)) { out[F.status] = ST.failed; note = `接着做了 ${t.round || 1} 轮还是没做完，最后一轮停在下面这里；把「状态」清空就再来一遍`; }
  else if (r.status === 'done') out[F.status] = /结论[:：]\s*\**\s*没做成/.test(res) ? ST.failed : ST.done;
  else out[F.status] = r.status === 'stopped' ? ST.stopped : ST.failed;
  out[F.result] = [note, res].filter(Boolean).join('\n').slice(0, 5000) || (r.status === 'stopped' ? '已停' : '');
  return out;
}

// ---------- 第一次：建表 ----------
async function setup() {
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  const dataDir = arg('data') || process.env.DATA_DIR || path.join(__dirname, 'data');
  const cfgFile = path.join(dataDir, 'feishu-board.json');
  const old = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const cfg = { ...old, appId: arg('app-id') || old.appId, appSecret: arg('app-secret') || old.appSecret, domain: arg('domain') || old.domain || 'https://open.feishu.cn', pollSec: old.pollSec || 15 };
  if (arg('ai-url')) cfg.ai = { url: arg('ai-url'), key: arg('ai-key'), model: arg('ai-model') };
  const owner = arg('owner');
  if (!cfg.appId || !cfg.appSecret) { console.error('用法：node feishu-board.js setup --app-id … --app-secret … --owner 你的邮箱或open_id [--ai-url … --ai-key … --ai-model …]'); process.exit(2); }
  const { call } = feishu(cfg);
  const app = (await call('POST', '/open-apis/bitable/v1/apps', { name: arg('name') || '缺陷和功能-自动开发' })).app;
  Object.assign(cfg, { appToken: app.app_token, tableId: app.default_table_id, url: app.url });
  const tb = `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}`;
  await call('PATCH', tb, { name: '缺陷和功能' }).catch(() => {});
  // 默认表自带的列和空行清掉，换成我们的
  const fields = (await call('GET', `${tb}/fields?page_size=100`)).items || [];
  for (const fd of fields) {
    if (fd.is_primary) await call('PUT', `${tb}/fields/${fd.field_id}`, { field_name: F.title, type: 1 });
    else await call('DELETE', `${tb}/fields/${fd.field_id}`);
  }
  const opt = (names) => ({ options: names.map((name, i) => ({ name, color: i })) });
  const want = [
    [F.type, 3, opt(['缺陷', '功能'])], [F.desc, 1], [F.accept, 1],
    [F.prio, 3, opt(PRIOS)], [F.status, 3, opt([ST.queued, ST.running, ST.done, ST.failed, ST.stopped, ST.stop])],
    [F.machine, 1], [F.result, 1], [F.reason, 1], [F.dir, 1], [F.git, 7],
    [F.start, 5, { date_formatter: 'yyyy/MM/dd HH:mm' }], [F.end, 5, { date_formatter: 'yyyy/MM/dd HH:mm' }], [F.id, 1],
  ];
  for (const [field_name, type, property] of want) await call('POST', `${tb}/fields`, { field_name, type, ...(property ? { property } : {}) });
  const recs = (await call('POST', `${tb}/records/search?page_size=500`, {})).items || [];
  if (recs.length) await call('POST', `${tb}/records/batch_delete`, { records: recs.map((r) => r.record_id) });
  // 给本人加管理权限，再把表转给本人（转不成也不要紧，已有管理权限）
  if (owner) {
    const mt = owner.includes('@') ? 'email' : 'openid';
    await call('POST', `/open-apis/drive/v1/permissions/${cfg.appToken}/members?type=bitable&need_notification=false`, { member_type: mt, member_id: owner, perm: 'full_access' });
    await call('POST', `/open-apis/drive/v1/permissions/${cfg.appToken}/members/transfer_owner?type=bitable&need_notification=true&remove_old_owner=false`, { member_type: mt, member_id: owner }).catch((e) => console.log('（表没转到你名下，你已有管理权限，不影响用）', e.message));
  } else console.log('没填 --owner：这张表只有飞书应用自己能打开');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log(`表建好了：${cfg.url}\n设置已写进 ${cfgFile}；重启总控（node hub.js）就接上这张表。`);
}

module.exports = { start, devPrompt, classify, progress };
if (require.main === module && process.argv[2] === 'setup') setup().catch((e) => { console.error('没建成：' + e.message); process.exit(1); });
