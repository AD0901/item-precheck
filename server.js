// 试题质量预检工作台 —— 服务端
// 无第三方依赖，Node 18 以上即可运行：node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* 没有 .env 也能运行 */ }

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
const AI_API_KEY = (process.env.AI_API_KEY || '').trim();
const RATE_PER_IP_HOUR = Number(process.env.RATE_PER_IP_HOUR) || 60;
const RATE_GLOBAL_DAY = Number(process.env.RATE_GLOBAL_DAY) || 500;

const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sets.json');
const FRAMEWORK = JSON.parse(fs.readFileSync(path.join(__dirname, 'framework.json'), 'utf8'));
const ATTR = FRAMEWORK.attrs;
const K = ATTR.length;
const L = 'ABCD';
const SUGS = ['通过', '修改', '退回'];

/* ---------- 数据存取 ---------- */
let db = { sets: [] };
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    db = { sets: [JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', 'demo.json'), 'utf8'))] };
    save();
  }
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
const blankExpert = () => ({ attrs: Array(K).fill(0), level: '中', uniq: '通过', dis: '合格', risk: '无', verdict: null, note: '' });

/* ---------- 校验 ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function cleanSet(body) {
  const title = str(body.title, 100);
  const p = body.passage || {};
  const paras = (Array.isArray(p.paras) ? p.paras : []).map(x => str(x, 4000)).filter(Boolean).slice(0, 40);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 60).map(it => ({
    q: str(it && it.q, 800),
    o: (Array.isArray(it && it.o) ? it.o : []).slice(0, 4).map(x => str(x, 400)),
    a: Number(it && it.a)
  }));
  if (!title) throw new Error('请填写题组名称');
  if (!paras.length) throw new Error('请填写阅读材料');
  if (!items.length) throw new Error('至少需要一道题');
  items.forEach((it, i) => {
    if (!it.q || it.o.length !== 4 || it.o.some(x => !x) || ![0, 1, 2, 3].includes(it.a)) throw new Error(`第 ${i + 1} 题不完整：需要题干、四个选项和答案`);
  });
  return { title, passage: { title: str(p.title, 200), paras }, items };
}
function cleanExpert(list, n) {
  if (!Array.isArray(list) || list.length !== n) throw new Error('复核数据与题数不符');
  const pick = (v, opts, d) => (opts.includes(v) ? v : d);
  return list.map(e => ({
    attrs: Array.from({ length: K }, (_, k) => (e && Array.isArray(e.attrs) && e.attrs[k] ? 1 : 0)),
    level: pick(e && e.level, ['易', '中', '难'], '中'),
    uniq: pick(e && e.uniq, ['通过', '存疑'], '通过'),
    dis: pick(e && e.dis, ['合格', '需修改'], '合格'),
    risk: pick(e && e.risk, ['无', '超纲', '偏题'], '无'),
    verdict: pick(e && e.verdict, SUGS, null),
    note: str(e && e.note, 500)
  }));
}
function cleanResp(resp, n) {
  if (resp === null) return null;
  if (!Array.isArray(resp) || resp.length > 5000) throw new Error('作答数据格式不对');
  return resp.map(r => {
    if (!Array.isArray(r) || r.length !== n) throw new Error('作答数据的列数与题数不符');
    return r.map(v => (v ? 1 : 0));
  });
}

/* ---------- AI 预检 ---------- */
function buildPrompt(itemText) {
  return `你是大学英语四级考试阅读部分的命题审校专家，负责在试题入库前做质量预检。请对下面这道阅读理解四选一试题逐项检查，用中文写理由，每条理由不超过 50 字，要引用原文或选项中的具体词句。

属性标定必须使用下面这套九项阅读认知属性。它们来自对中国大学生四级阅读的有声思维研究，并经认知诊断模型检验：
${ATTR.map(a => `${a.k} = ${a.name}：${a.def}`).join('\n')}

预估难度时请同时考虑：涉及的属性数量、信息定位的明显程度、干扰项的迷惑性（错误选项越合情合理，题目越难）。

${itemText}

只回复一个 JSON 对象，不要任何其他文字，字段如下：
{"attributes":["A2"],           // 答对必需的属性，通常 1-2 个，只选必需的
 "reasons":{"A2":"理由"},
 "p":0.65,                      // 预估正确率，0-1，面向普通本科一年级学生
 "p_reason":"一句话说明难度依据",
 "key":"B",                     // 你独立判断的正确选项
 "uniqueness":{"status":"通过","note":"理由"},   // status 只能是 通过 或 存疑
 "distractors":[{"option":"A","quality":"有效","note":"理由"}],  // 三个错误选项各一条，quality 只能是 有效、偏弱、有争议
 "risk":{"status":"无","note":"理由"},           // status 只能是 无、超纲、偏题
 "suggestion":"通过",           // 只能是 通过、修改、退回
 "summary":"一两句综合意见，说明最需要改的地方"}`;
}
function normalize(r) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const at = Array.isArray(r.attributes) ? r.attributes.map(x => String(x).toUpperCase()) : [];
  const p = Math.min(1, Math.max(0, Number(r.p)));
  const reasons = {};
  if (r.reasons && typeof r.reasons === 'object') for (const a of ATTR) if (r.reasons[a.k]) reasons[a.k] = str(String(r.reasons[a.k]), 300);
  return {
    attrs: ATTR.map(t => (at.includes(t.k) ? 1 : 0)), reasons,
    p: Number.isFinite(p) ? p : 0.5, why: str(String(r.p_reason || ''), 300),
    key: typeof r.key === 'string' ? r.key.trim().slice(0, 1).toUpperCase() : '',
    uniq: { s: pick(r.uniqueness && r.uniqueness.status, ['通过', '存疑'], '存疑'), n: str(String((r.uniqueness && r.uniqueness.note) || ''), 300) },
    dis: (Array.isArray(r.distractors) ? r.distractors : []).slice(0, 4).map(d => ({ o: String((d && d.option) || '').slice(0, 1).toUpperCase(), q: pick(d && d.quality, ['有效', '偏弱', '有争议'], '偏弱'), n: str(String((d && d.note) || ''), 300) })),
    risk: { s: pick(r.risk && r.risk.status, ['无', '超纲', '偏题'], '无'), n: str(String((r.risk && r.risk.note) || ''), 300) },
    sug: pick(r.suggestion, SUGS, '修改'), sum: str(String(r.summary || ''), 500),
    model: AI_MODEL, at: new Date().toISOString()
  };
}
async function callAI(prompt) {
  const res = await fetch(AI_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_API_KEY },
    body: JSON.stringify({ model: AI_MODEL, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('AI 接口返回', res.status, t.slice(0, 300));
    const msg = res.status === 401 ? 'AI 接口密钥无效，请检查 .env 里的 AI_API_KEY' : res.status === 402 ? 'AI 接口余额不足' : res.status === 429 ? 'AI 接口限流，请稍后再试' : `AI 接口出错（${res.status}）`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const data = await res.json();
  let text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  text = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try { return normalize(JSON.parse(text.slice(a, b + 1))); }
  catch (e) { throw Object.assign(new Error('AI 返回的内容无法解析，请再试一次'), { status: 502 }); }
}

/* 没有访问口令，所以对 AI 调用限流，避免额度被刷 */
const hits = new Map();
let dayCount = 0, dayStamp = new Date().toDateString();
function rateLimit(ip) {
  const now = Date.now();
  if (new Date().toDateString() !== dayStamp) { dayStamp = new Date().toDateString(); dayCount = 0; }
  const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= RATE_PER_IP_HOUR) throw Object.assign(new Error('预检次数太多，请一小时后再试'), { status: 429 });
  if (dayCount >= RATE_GLOBAL_DAY) throw Object.assign(new Error('今天的预检次数已用完'), { status: 429 });
  list.push(now); hits.set(ip, list); dayCount++;
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 3e6) { reject(Object.assign(new Error('数据太大'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('请求格式不对'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const findSet = id => {
  const s = db.sets.find(x => x.id === id);
  if (!s) throw Object.assign(new Error('找不到这个题组'), { status: 404 });
  return s;
};

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (req.method === 'GET' && parts[1] === 'config') return send(res, 200, { framework: FRAMEWORK, aiReady: !!AI_API_KEY, model: AI_MODEL });
  if (req.method === 'GET' && parts[1] === 'sets' && !parts[2]) return send(res, 200, { sets: db.sets });

  if (req.method === 'POST' && parts[1] === 'sets' && !parts[2]) {
    const c = cleanSet(await readBody(req));
    if (db.sets.length >= 200) throw Object.assign(new Error('题组数量已达上限'), { status: 400 });
    const set = { id: crypto.randomBytes(6).toString('hex'), ...c, ai: c.items.map(() => null), ex: c.items.map(blankExpert), resp: null, respNote: '', createdAt: new Date().toISOString() };
    db.sets.push(set); save();
    return send(res, 201, { set });
  }
  if (req.method === 'PUT' && parts[1] === 'sets' && parts[2]) {
    const set = findSet(parts[2]); const body = await readBody(req);
    if ('ex' in body) set.ex = cleanExpert(body.ex, set.items.length);
    if ('resp' in body) { set.resp = cleanResp(body.resp, set.items.length); set.respNote = str(body.respNote, 100); }
    set.updatedAt = new Date().toISOString(); save();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && parts[1] === 'precheck') {
    if (!AI_API_KEY) throw Object.assign(new Error('服务器还没有配置 AI 接口密钥'), { status: 503 });
    const body = await readBody(req);
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
    if (typeof body.text === 'string') {
      const text = str(body.text, 8000);
      if (text.length < 30) throw Object.assign(new Error('请贴入完整的材料和试题'), { status: 400 });
      rateLimit(ip);
      return send(res, 200, { ai: await callAI(buildPrompt('试题：\n' + text)) });
    }
    const set = findSet(String(body.setId)); const j = Number(body.j); const it = set.items[j];
    if (!it) throw Object.assign(new Error('找不到这道题'), { status: 404 });
    rateLimit(ip);
    const text = `阅读材料：\n${set.passage.title}\n${set.passage.paras.join('\n')}\n\n试题：\n${it.q}\n${it.o.map((o, i) => `${L[i]}. ${o}`).join('\n')}\n命题人给的答案：${L[it.a]}`;
    const ai = await callAI(buildPrompt(text));
    if (ai.key && ai.key !== L[it.a]) { ai.uniq.s = '存疑'; ai.uniq.n = `AI 独立作答选 ${ai.key}，与命题人答案 ${L[it.a]} 不同。` + ai.uniq.n; }
    set.ai[j] = ai; set.updatedAt = new Date().toISOString(); save();
    return send(res, 200, { ai });
  }
  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { error: e.status ? e.message : '服务器出错了，请稍后再试' }); }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

load();
server.listen(PORT, HOST, () => {
  console.log(`试题质量预检工作台已启动：http://localhost:${PORT}`);
  console.log(AI_API_KEY ? `AI 接口：${AI_BASE_URL}（${AI_MODEL}）` : 'AI 接口：未配置。把密钥写进 .env 的 AI_API_KEY 后重启，才能实时预检。');
});
