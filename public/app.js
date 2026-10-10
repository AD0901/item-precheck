/* 试题质量预检工作台 —— 前端。数据都存在服务器上，所有访问者看到同一份。 */
let ATTR = [], DIMS = [], BASEROWS = [], PRIOR = [0.241, 0.7741], K = 0, NP = 1;
let aiReady = false, aiModel = '';
let SETS = [], SET = null, PASSAGE = null, ITEMS = [], AI = [], EX = [], CLASS = [], ACT = [], N = 0, NSTU = 0;
let cur = 0, src = 'set', customAI = null, busy = false;
const L = 'ABCD', G = 0.2, S = 0.1;
const LEVELS = ['易', '中', '难'], SUGS = ['通过', '修改', '退回'];
const levelOf = p => p >= 0.7 ? '易' : p >= 0.4 ? '中' : '难';
const mask = a => a.reduce((m, v, k) => v ? m | (1 << (K - 1 - k)) : m, 0);
const disOf = a => a.dis.some(d => d.q !== '有效') ? '需修改' : '合格';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attrStr = a => ATTR.filter((_, k) => a[k]).map(t => t.k).join('+') || '–';
const pillCls = v => ({ '通过': 'p-ok', '合格': 'p-ok', '无': 'p-ok', '有效': 'p-ok', '入库': 'p-ok', '修改': 'p-warn', '需修改': 'p-warn', '偏弱': 'p-warn', '存疑': 'p-warn', '修订后入库': 'p-warn', '有争议': 'p-bad', '退回': 'p-bad', '超纲': 'p-bad', '偏题': 'p-bad' }[v] || 'p-n');
const pill = v => `<span class="pill ${pillCls(v)}">${esc(v)}</span>`;

/* ---------- 与服务器通信 ---------- */
async function api(method, url, body) {
  let res;
  try { res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('连不上服务器，请检查网络后再试'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
let saveTimer = null;
function saveExpert() {
  clearTimeout(saveTimer);
  const set = SET;
  saveTimer = setTimeout(() => {
    api('PUT', '/api/sets/' + set.id, { ex: set.ex }).then(() => flash('复核已保存')).catch(e => flash(e.message, true));
  }, 500);
}
let flashTimer = null;
function flash(msg, bad) {
  const el = $('#flash'); el.textContent = msg; el.className = 'chip' + (bad ? ' bad' : ' ai-on'); el.hidden = false;
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 1800);
}

/* ---------- 统计 ---------- */
function kappa(pairs, cats, weighted) {
  const c = cats.length, n = pairs.length, o = Array.from({ length: c }, () => Array(c).fill(0)), r = Array(c).fill(0), cl = Array(c).fill(0);
  pairs.forEach(([a, b]) => { const i = cats.indexOf(a), j = cats.indexOf(b); if (i < 0 || j < 0) return; o[i][j]++; r[i]++; cl[j]++; });
  let po = 0, pe = 0;
  for (let i = 0; i < c; i++) for (let j = 0; j < c; j++) { const w = weighted ? 1 - Math.abs(i - j) / (c - 1) : (i === j ? 1 : 0); po += w * o[i][j] / n; pe += w * r[i] * cl[j] / (n * n); }
  return { k: pe >= 1 ? 1 : (po - pe) / (1 - pe), po };
}
const kLabel = k => k >= .8 ? ['几乎完全一致', 'p-ok'] : k >= .6 ? ['一致性较高', 'p-ok'] : k >= .4 ? ['一致性中等', 'p-warn'] : ['一致性较低', 'p-bad'];
/* DINA 后验：Q 用位掩码表示，每个 Q 矩阵只算一次 */
const postCache = new Map();
function posts(Q) {
  const key = Q.join(',');
  if (postCache.has(key)) return postCache.get(key);
  const out = CLASS.map(c => {
    const po = new Float64Array(NP); let tot = 0;
    for (let p = 0; p < NP; p++) { let Lk = 1; for (let j = 0; j < N; j++) { const pc = (p & Q[j]) === Q[j] ? 1 - S : G; Lk *= c.resp[j] ? pc : 1 - pc; } po[p] = Lk; tot += Lk; }
    for (let p = 0; p < NP; p++) po[p] /= tot; return po;
  });
  if (postCache.size > 40) postCache.clear();
  postCache.set(key, out); return out;
}
/* 题目区分度：按后验加权，掌握组正确率 − 未掌握组正确率 */
function idi(Q, j) {
  const P = posts(Q); let n1 = 0, c1 = 0, n0 = 0, c0 = 0;
  CLASS.forEach((c, i) => { let pe = 0; const po = P[i]; for (let p = 0; p < NP; p++) if ((p & Q[j]) === Q[j]) pe += po[p]; n1 += pe; c1 += pe * c.resp[j]; n0 += 1 - pe; c0 += (1 - pe) * c.resp[j]; });
  return { d: (n1 > 1e-9 ? c1 / n1 : 0) - (n0 > 1e-9 ? c0 / n0 : 0) };
}

/* ---------- 题组 ---------- */
function useSet(i, keepCur) {
  SET = SETS[i]; PASSAGE = SET.passage; ITEMS = SET.items; AI = SET.ai; EX = SET.ex; N = ITEMS.length;
  CLASS = (SET.resp || []).map(r => ({ resp: r })); NSTU = CLASS.length;
  ACT = ITEMS.map((_, j) => NSTU ? CLASS.reduce((s, c) => s + (c.resp[j] ? 1 : 0), 0) / NSTU : null);
  if (!keepCur) cur = 0;
  postCache.clear();
  try { localStorage.setItem('precheck-set', SET.id); } catch (e) { }
}
function renderSetSelect() {
  $('#srcSel').innerHTML = SETS.map((s, i) => `<option value="set:${i}" ${src === 'set' && s === SET ? 'selected' : ''}>${esc(s.title)}</option>`).join('') +
    `<option value="create" ${src === 'create' ? 'selected' : ''}>＋ 新建题组…</option><option value="new" ${src === 'new' ? 'selected' : ''}>贴入单题（临时预检，不保存）</option>`;
  $('#setChip').textContent = SET.demo ? '示例题组 · 模拟作答数据' : '自建题组 · 共 ' + N + ' 题';
}
function parseItems(text) {
  const items = []; let it = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    let m;
    if ((m = line.match(/^(?:答案|answer|key)\s*[:：]?\s*([A-Da-d])\b/i))) { if (it) it.a = L.indexOf(m[1].toUpperCase()); continue; }
    if ((m = line.match(/^([A-Da-d])\s*[.、．)）]\s*(.+)$/)) && it && it.o.length < 4) { it.o.push(m[2].trim()); continue; }
    if ((m = line.match(/^(\d+)\s*[.、．)）]\s*(.+)$/))) { it = { q: m[2].trim(), o: [], a: -1 }; items.push(it); continue; }
    if (it && !it.o.length) it.q += ' ' + line;
  }
  items.forEach((x, i) => { if (x.o.length !== 4) throw new Error(`第 ${i + 1} 题没有识别出四个选项`); if (x.a < 0) throw new Error(`第 ${i + 1} 题缺少“答案：X”一行`); });
  if (!items.length) throw new Error('没有识别出试题，请按示例格式填写');
  return items;
}
async function createSet() {
  const note = $('#createNote'); note.hidden = true;
  try {
    const items = parseItems($('#cItems').value);
    const paras = $('#cPassage').value.split(/\r?\n\s*\r?\n|\r?\n/).map(s => s.trim()).filter(Boolean);
    const { set } = await api('POST', '/api/sets', { title: $('#cTitle').value, passage: { title: $('#cPTitle').value, paras }, items });
    SETS.push(set); src = 'set'; useSet(SETS.length - 1); showBoxes(); renderAll();
    flash('题组已创建');
  } catch (e) { note.textContent = e.message; note.hidden = false; }
}

/* ---------- 1 预检工作台 ---------- */
function renderPassage() {
  $('#passage').innerHTML = (PASSAGE.title ? `<h4>${esc(PASSAGE.title)}</h4>` : '') + PASSAGE.paras.map((p, i) => `<p><span class="pn">¶${i + 1}</span>${esc(p)}</p>`).join('');
}
function renderItemList() {
  $('#itemList').innerHTML = ITEMS.map((it, j) => `<button class="item" data-j="${j}" aria-current="${j === cur}">
    <span class="n">${j + 1}</span><span class="t">${esc(it.q)}${j === cur ? `<span class="opts">${it.o.map((o, i) => `<span class="${i === it.a ? 'key' : ''}">${L[i]}. ${esc(o)}${i === it.a ? ' <span class="small muted">（答案）</span>' : ''}</span>`).join('')}</span>` : ''}</span>
    ${pill(AI[j] ? AI[j].sug : '未预检')}</button>`).join('');
}
function renderCover() {
  const done = AI.filter(Boolean).length;
  if (!done) { $('#cover').innerHTML = '<p class="muted small" style="margin:0;grid-column:1/-1">完成 AI 预检后，这里显示九项属性各被几道题考查。</p>'; return; }
  const cnt = ATTR.map((_, k) => AI.reduce((s, a) => s + (a ? a.attrs[k] : 0), 0));
  $('#cover').innerHTML = ATTR.map((t, k) => `<div class="cv ${cnt[k] === 0 ? 'zero' : cnt[k] === 1 ? 'one' : ''}" title="${esc(t.def)}"><span class="tag">${t.k}</span><span class="nm">${t.name}</span><span class="kv">${cnt[k]} 题</span></div>`).join('') +
    (cnt.some(c => c === 0) ? `<div class="note" style="grid-column:1/-1">${ATTR.filter((_, k) => cnt[k] === 0).map(t => t.k + ' ' + t.name).join('、')} 没有被${done < N ? '已预检的' : '任何一'}题考查。若题组要用于诊断，需补题。</div>` : '');
}
function reportHTML(a, head, key) {
  const tags = ATTR.filter((_, k) => a.attrs[k]);
  return `<div class="row between" style="align-items:flex-end">
     <div><div class="eyebrow">AI 预检报告</div><h2>${head}</h2></div>
     <div class="row"><span class="chip">${a.demo ? '示例预检结果' : 'AI 预检 · ' + esc(a.model || '')}</span><span class="small muted">AI 建议</span>${pill(a.sug)}</div>
    </div>
    <p style="margin:0">${esc(a.sum)}</p>
    <div class="sec"><h3>考查属性<span class="small muted" style="font-weight:400">九属性框架</span></h3>
      <div class="row" style="gap:6px;margin-bottom:6px">${tags.map(t => `<span class="tag big">${t.k} ${t.name}</span>`).join('') || '<span class="small muted">未识别</span>'}</div>
      ${tags.map(t => `<p><span class="tag">${t.k}</span> ${esc(a.reasons[t.k] || '')}</p>`).join('')}</div>
    <div class="sec"><h3>预估难度<span><span class="kv">P = ${a.p.toFixed(2)}</span>　${pill(levelOf(a.p))}</span></h3>
      <div class="track"><span class="band" style="left:${PRIOR[0] * 100}%;width:${(PRIOR[1] - PRIOR[0]) * 100}%"></span><div class="fill" style="width:${(a.p * 100).toFixed(0)}%"></div><span class="th" style="left:40%"></span><span class="th" style="left:70%"></span></div>
      <div class="scale"><span>0 难</span><span>0.40</span><span>0.70</span><span>易 1</span></div>
      <p class="muted">${esc(a.why || '')}${a.p < PRIOR[0] || a.p > PRIOR[1] ? ' 超出前期测验的实测难度区间 0.24–0.77。' : ''}</p></div>
    <div class="sec"><h3>答案唯一性${pill(a.uniq.s)}</h3><p>${key ? `参考答案 <span class="kv">${esc(key)}</span>。` : ''}${esc(a.uniq.n)}</p></div>
    <div class="sec"><h3>干扰项质量${pill(disOf(a))}</h3>${a.dis.map(d => `<p><span class="kv">${esc(d.o)}</span> ${pill(d.q)} ${esc(d.n)}</p>`).join('')}</div>
    <div class="sec"><h3>超纲与偏题风险${pill(a.risk.s)}</h3><p>${esc(a.risk.n)}</p></div>`;
}
function renderReport() {
  const box = $('#report');
  const empty = (h, t) => `<div><div class="eyebrow">AI 预检报告</div><h2>${h}</h2></div><p class="muted" style="margin:0">${t}</p>`;
  if (src === 'create') box.innerHTML = empty('新建题组', '在左侧填好题组后点“创建题组”。创建后可以逐题或一次性预检，结果保存在服务器上，所有访问者都能看到。');
  else if (src === 'new') box.innerHTML = customAI ? reportHTML(customAI, '贴入的单题', customAI.key) : empty('贴入的单题', '点“运行 AI 预检”，这里会显示属性标定、预估难度、答案唯一性、干扰项质量和超纲偏题风险五项结果。');
  else if (!AI[cur]) box.innerHTML = empty(`第 ${cur + 1} 题`, aiReady ? '这道题还没有预检。点左侧的“预检这道题”或“预检全部未检题”。' : '这道题还没有预检。服务器尚未配置 AI 接口密钥，暂时无法预检。');
  else {
    box.innerHTML = reportHTML(AI[cur], `第 ${cur + 1} 题`, L[ITEMS[cur].a]) + `<div class="row"><button class="btn" id="toRev">去复核这道题</button></div>`;
    $('#toRev').addEventListener('click', () => showTab('rev'));
  }
  box.insertAdjacentHTML('beforeend', '<div class="note" id="runNote" hidden></div>');
}
function updateRunHint() {
  const pending = AI.filter(a => !a).length;
  $('#runRow').hidden = src === 'create';
  $('#runBtn').textContent = src === 'new' ? '运行 AI 预检' : (AI[cur] ? '重新预检这道题' : '预检这道题');
  $('#runAllBtn').hidden = src !== 'set' || !pending;
  $('#runAllBtn').textContent = `预检全部未检题（${pending}）`;
  $('#runHint').textContent = aiReady ? '' : '服务器尚未配置 AI 接口密钥，暂时只能查看已有结果';
  $('#runBtn').disabled = $('#runAllBtn').disabled = busy || !aiReady;
}
function runNote(html) { const n = $('#runNote'); if (n) { n.hidden = !html; n.innerHTML = html || ''; } }
async function precheckOne(set, j) {
  const { ai } = await api('POST', '/api/precheck', { setId: set.id, j });
  set.ai[j] = ai;
}
async function runPrecheck() {
  if (!aiReady || busy) return;
  busy = true; updateRunHint(); runNote('<span class="spin"></span>AI 正在预检，大约需要十几秒…');
  try {
    if (src === 'new') {
      const text = $('#newItem').value.trim();
      customAI = (await api('POST', '/api/precheck', { text })).ai;
    } else await precheckOne(SET, cur);
    busy = false; renderAll();
  } catch (e) { busy = false; updateRunHint(); runNote(esc(e.message)); }
}
async function runAll() {
  if (!aiReady || busy) return;
  const set = SET, todo = set.ai.map((a, j) => a ? -1 : j).filter(j => j >= 0);
  busy = true; updateRunHint();
  let err = null;
  for (let i = 0; i < todo.length; i++) {
    runNote(`<span class="spin"></span>正在预检第 ${todo[i] + 1} 题（${i + 1}/${todo.length}）…`);
    try { await precheckOne(set, todo[i]); } catch (e) { err = e; break; }
    if (set === SET) { renderItemList(); renderCover(); }
  }
  busy = false; if (set === SET) renderAll();
  if (err) runNote(esc(err.message));
}

/* ---------- 2 专家复核 ---------- */
const reviewed = j => AI[j] && EX[j].verdict;
function renderKappa() {
  const J = ITEMS.map((_, j) => j).filter(reviewed);
  if (J.length < 2) { $('#kappaKpis').innerHTML = `<div class="kpi"><div class="k">人机一致性</div><div class="d" style="font-size:14px;margin-top:6px">至少两道题同时有 AI 预检和专家复核结论后，这里显示 Kappa 系数。目前 ${J.length} 题。</div></div>`; return; }
  const aPairs = [], dPairs = [], vPairs = [];
  J.forEach(j => { for (let k = 0; k < K; k++) aPairs.push([AI[j].attrs[k], EX[j].attrs[k]]); dPairs.push([levelOf(AI[j].p), EX[j].level]); vPairs.push([AI[j].sug, EX[j].verdict]); });
  const ka = kappa(aPairs, [0, 1], false), kd = kappa(dPairs, LEVELS, true), kv = kappa(vPairs, SUGS, true);
  const card = (t, r, d) => { const [lab, cls] = kLabel(r.k); return `<div class="kpi"><div class="k">${t}</div><div class="v">κ = ${r.k.toFixed(2)}</div><div class="d"><span class="pill ${cls}">${lab}</span>　${d}，原始一致率 ${(r.po * 100).toFixed(0)}%</div></div>`; };
  $('#kappaKpis').innerHTML = card('属性标定', ka, `${J.length * K} 项二值判断`) + card('难度等级（加权）', kd, `${J.length} 题三级`) + card('处理结论（加权）', kv, `${J.length} 题三级`);
}
function renderOverview() {
  $('#ovTable').innerHTML = `<thead><tr><th>题</th><th>AI 属性</th><th>专家属性</th><th>AI 难度</th><th>专家难度</th><th>AI 建议</th><th>专家结论</th></tr></thead><tbody>` +
    ITEMS.map((_, j) => {
      const a = AI[j], e = EX[j], rv = !!e.verdict, da = a && rv && attrStr(a.attrs) !== attrStr(e.attrs), dl = a && rv && levelOf(a.p) !== e.level;
      return `<tr class="click ${j === cur ? 'sel' : ''}" data-j="${j}"><td class="num">${j + 1}</td><td><span class="kv">${a ? attrStr(a.attrs) : '–'}</span></td><td><span class="kv" style="${da ? 'color:var(--warn);font-weight:600' : ''}">${rv ? attrStr(e.attrs) : '–'}</span></td>
     <td>${a ? levelOf(a.p) : '–'}</td><td style="${dl ? 'color:var(--warn);font-weight:600' : ''}">${rv ? e.level : '–'}</td><td>${pill(a ? a.sug : '未预检')}</td><td>${pill(rv ? e.verdict : '待复核')}</td></tr>`;
    }).join('') + '</tbody>';
}
function renderReview() {
  const a = AI[cur], e = EX[cur], it = ITEMS[cur], P = $('#revPanel');
  const stem = `<div><p style="margin:0;font-family:var(--f-en)">${esc(it.q)}</p><span class="opts">${it.o.map((o, i) => `<span class="${i === it.a ? 'key' : ''}">${L[i]}. ${esc(o)}</span>`).join('')}</span></div>`;
  if (!a) { P.innerHTML = `<div><div class="eyebrow">逐项复核</div><h2>第 ${cur + 1} 题</h2></div>${stem}<p class="muted" style="margin:0">这道题还没有 AI 预检意见。先到“AI 预检工作台”预检，再回来复核。</p>`; return; }
  const rv = !!e.verdict;
  const st = same => !rv ? '<span class="pill p-n">待定</span>' : same ? '<span class="pill p-ok">采纳</span>' : '<span class="pill p-warn">已修改</span>';
  const sel = (id, opts, v) => `<select id="${id}" data-f="${id.split('-')[1]}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  const rows = ATTR.map((t, k) => `<tr><td><span class="tag">${t.k}</span> ${t.name}</td><td>${a.attrs[k] ? `考查。<span class="muted">${esc(a.reasons[t.k] || '')}</span>` : '<span class="muted">不考查</span>'}</td>
     <td><label class="row" style="gap:6px;flex-wrap:nowrap"><input type="checkbox" id="rv-attr-${k}" data-k="${k}" ${e.attrs[k] ? 'checked' : ''} style="accent-color:var(--accent)">考查</label></td><td>${st(a.attrs[k] === e.attrs[k])}</td></tr>`).join('') +
    `<tr><td>难度</td><td>${levelOf(a.p)}　<span class="kv muted">P = ${a.p.toFixed(2)}</span></td><td>${sel('rv-level', LEVELS, e.level)}</td><td>${st(levelOf(a.p) === e.level)}</td></tr>
    <tr><td>答案唯一性</td><td>${a.uniq.s}。<span class="muted">${esc(a.uniq.n)}</span></td><td>${sel('rv-uniq', ['通过', '存疑'], e.uniq)}</td><td>${st(a.uniq.s === e.uniq)}</td></tr>
    <tr><td>干扰项质量</td><td>${disOf(a)}。<span class="muted">${esc(a.dis.filter(d => d.q !== '有效').map(d => d.o + ' 项' + d.q).join('，') || '干扰项均有效')}</span></td><td>${sel('rv-dis', ['合格', '需修改'], e.dis)}</td><td>${st(disOf(a) === e.dis)}</td></tr>
    <tr><td>超纲偏题</td><td>${a.risk.s}。<span class="muted">${esc(a.risk.n)}</span></td><td>${sel('rv-risk', ['无', '超纲', '偏题'], e.risk)}</td><td>${st(a.risk.s === e.risk)}</td></tr>`;
  P.innerHTML = `<div class="row between"><div><div class="eyebrow">逐项复核</div><h2>第 ${cur + 1} 题</h2></div><button class="btn" id="adoptAll">全部采纳 AI 意见</button></div>
   ${stem}
   <div class="scroll-x"><table class="t rv"><thead><tr><th>检查项</th><th>AI 意见</th><th>专家判断</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
   <div class="sec stack" style="gap:10px">
     <div class="row between"><h3 style="margin:0">复核结论</h3><span class="small muted">AI 建议：${a.sug}${rv ? '' : '。选定结论后，这道题才计入一致性'}</span></div>
     <div class="seg" role="radiogroup" aria-label="复核结论">${SUGS.map((s, i) => `<label><input type="radio" name="verdict" id="rv-v${i}" value="${s}" ${e.verdict === s ? 'checked' : ''}>${s === '修改' ? '修改后通过' : s}</label>`).join('')}</div>
     <textarea id="rv-note" rows="2" placeholder="复核意见（可选），例如需要修改的具体位置">${esc(e.note)}</textarea>
   </div>`;
  P.querySelectorAll('input[type=checkbox]').forEach(c => c.addEventListener('change', () => { EX[cur].attrs[+c.dataset.k] = c.checked ? 1 : 0; afterEdit('rv-attr-' + c.dataset.k); }));
  P.querySelectorAll('select').forEach(s => s.addEventListener('change', () => { EX[cur][s.dataset.f] = s.value; afterEdit(s.id); }));
  P.querySelectorAll('input[name=verdict]').forEach(r => r.addEventListener('change', () => { EX[cur].verdict = r.value; afterEdit(r.id); }));
  $('#rv-note').addEventListener('input', ev => { EX[cur].note = ev.target.value; saveExpert(); });
  $('#adoptAll').addEventListener('click', () => { const x = EX[cur]; x.attrs = a.attrs.slice(); x.level = levelOf(a.p); x.uniq = a.uniq.s; x.dis = disOf(a); x.risk = a.risk.s; x.verdict = a.sug; afterEdit('adoptAll'); });
}
function afterEdit(focusId) { saveExpert(); renderKappa(); renderOverview(); renderReview(); renderValidation(); const f = document.getElementById(focusId); if (f) f.focus(); }

/* ---------- 3 试测验证 ---------- */
function parseResp(text) {
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(/[,\t;，\s]+/).filter(c => c !== ''));
  const out = [];
  rows.forEach(cells => {
    if (cells.length === N + 1) cells = cells.slice(1); // 第一列是学号或姓名
    if (cells.length !== N) return;
    const r = cells.map((c, j) => { const u = c.toUpperCase(); if (u === '1' || u === '0') return +u; if (/^[A-D]$/.test(u)) return u === L[ITEMS[j].a] ? 1 : 0; return null; });
    if (r.every(v => v !== null)) out.push(r);
  });
  if (out.length < 5) throw new Error(`只识别出 ${out.length} 行有效作答。每行一名学生、${N} 列，填 1/0 或 A–D。`);
  return out;
}
async function importResp(text) {
  const note = $('#respNote'); note.hidden = true;
  try {
    const resp = parseResp(text), respNote = `导入的作答数据：${resp.length} 人`;
    await api('PUT', '/api/sets/' + SET.id, { resp, respNote });
    SET.resp = resp; SET.respNote = respNote; useSet(SETS.indexOf(SET), true); renderAll(); flash('作答数据已导入');
  } catch (e) { note.textContent = e.message; note.hidden = false; }
}
function renderValidation() {
  $('#respInfo').textContent = NSTU ? (SET.respNote || `${NSTU} 人`) + '。' : '这个题组还没有作答数据。';
  $('#respFmt').textContent = `每行一名学生，共 ${N} 列，对应第 1–${N} 题；填 1/0（对/错）或学生所选的 A–D。可以多一列学号放在最前面，表头行会自动跳过。`;
  const JA = ITEMS.map((_, j) => j).filter(j => AI[j]);
  const ready = NSTU > 0 && JA.length > 0;
  $('#valBody').hidden = !ready; $('#valEmpty').hidden = ready;
  if (!ready) { $('#valEmpty').textContent = !JA.length ? '先完成 AI 预检，再导入作答数据，这里才能比对。' : '导入试测作答数据后，这里显示预估难度与实测正确率的比对，以及 Q 矩阵标定检验。'; return; }
  const zero = Array(K).fill(0);
  const EA = ITEMS.map((_, j) => EX[j].verdict ? EX[j].attrs : AI[j] ? AI[j].attrs : zero), AA = ITEMS.map((_, j) => AI[j] ? AI[j].attrs : EA[j]);
  const EQ = EA.map(mask), AQ = AA.map(mask);
  const dev = ITEMS.map((_, j) => AI[j] ? AI[j].p - ACT[j] : null);
  const n = JA.length, mae = JA.reduce((s, j) => s + Math.abs(dev[j]), 0) / n;
  const mx = JA.reduce((s, j) => s + AI[j].p, 0) / n, my = JA.reduce((s, j) => s + ACT[j], 0) / n;
  let sxy = 0, sxx = 0, syy = 0; JA.forEach(j => { sxy += (AI[j].p - mx) * (ACT[j] - my); sxx += (AI[j].p - mx) ** 2; syy += (ACT[j] - my) ** 2; });
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  const off = JA.filter(j => Math.abs(dev[j]) >= .15);
  const dE = ITEMS.map((_, j) => idi(EQ, j)), differ = ITEMS.map((_, j) => !!(AI[j] && EX[j].verdict && EQ[j] !== AQ[j]));
  const dA = ITEMS.map((_, j) => differ[j] ? idi(AQ, j) : null);
  const qv = ITEMS.map((_, j) => {
    if (!differ[j]) return dE[j].d >= .3 ? ['标定合理', 'p-ok'] : ['区分度偏低', 'p-warn'];
    const g = dA[j].d - dE[j].d; return g >= .1 ? ['数据支持 AI 标定', 'p-warn'] : g <= -.1 ? ['数据支持专家标定', 'p-ok'] : ['数据无法区分', 'p-n'];
  });
  const inPrior = JA.filter(j => ACT[j] >= PRIOR[0] && ACT[j] <= PRIOR[1]).length;
  const list = a => '第 ' + a.map(j => j + 1).join('、') + ' 题';
  $('#valKpis').innerHTML = [
    ['预估与实测的相关', r === null ? '–' : `r = ${r.toFixed(2)}`, `${n} 道题的皮尔逊相关`],
    ['平均绝对偏差', mae.toFixed(2), '|AI 预估 P − 实测正确率|'],
    ['难度偏差超过 0.15', `${off.length} 题`, off.length ? list(off) : '全部在容差内'],
    ['人机 Q 矩阵标定不同', `${differ.filter(Boolean).length} 题`, differ.some(Boolean) ? list(ITEMS.map((_, j) => j).filter(j => differ[j])) : '已复核的题标定一致'],
    ['落在前期测验难度区间', `${inPrior} / ${n} 题`, '实测正确率在 0.24–0.77 之间']
  ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');

  /* 散点图：同一比例尺 0–1 */
  const W = 360, H = 330, m = { l: 44, r: 14, t: 14, b: 40 }, pw = W - m.l - m.r, ph = H - m.t - m.b, X = v => m.l + v * pw, Y = v => m.t + (1 - v) * ph;
  const ticks = [0, .2, .4, .6, .8, 1];
  $('#scatter').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:440px;display:block;margin:0 auto" role="img" aria-label="AI 预估难度与实测正确率散点图">
    <rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="var(--sunk)" rx="4"></rect>
    ${ticks.map(t => `<line x1="${X(t)}" y1="${m.t}" x2="${X(t)}" y2="${m.t + ph}" stroke="var(--line)" stroke-width="1"></line><line x1="${m.l}" y1="${Y(t)}" x2="${m.l + pw}" y2="${Y(t)}" stroke="var(--line)" stroke-width="1"></line>
      <text x="${X(t)}" y="${m.t + ph + 15}" text-anchor="middle">${t.toFixed(1)}</text><text x="${m.l - 7}" y="${Y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join('')}
    <polygon points="${X(0)},${Y(.15)} ${X(.85)},${Y(1)} ${X(1)},${Y(1)} ${X(1)},${Y(.85)} ${X(.15)},${Y(0)} ${X(0)},${Y(0)}" fill="var(--accent-soft)" opacity=".7"></polygon>
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--accent)" stroke-width="1.5"></line>
    <line x1="${X(0)}" y1="${Y(.15)}" x2="${X(.85)}" y2="${Y(1)}" stroke="var(--accent)" stroke-dasharray="3 3" stroke-width="1" fill="none"></line>
    <line x1="${X(.15)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(.85)}" stroke="var(--accent)" stroke-dasharray="3 3" stroke-width="1" fill="none"></line>
    ${JA.map(j => { const bad = Math.abs(dev[j]) >= .15; return `<g><title>第 ${j + 1} 题：AI 预估 ${AI[j].p.toFixed(2)}，实测 ${ACT[j].toFixed(2)}</title><circle cx="${X(AI[j].p)}" cy="${Y(ACT[j])}" r="9" fill="${bad ? 'var(--bad)' : 'var(--accent)'}" stroke="var(--surface)" stroke-width="1.5"></circle>
      <text x="${X(AI[j].p)}" y="${Y(ACT[j]) + 3.5}" text-anchor="middle" style="fill:var(--on-accent);font-size:10px">${j + 1}</text></g>`; }).join('')}
    <text x="${m.l + pw / 2}" y="${H - 6}" text-anchor="middle">AI 预估正确率</text>
    <text x="12" y="${m.t + ph / 2}" text-anchor="middle" transform="rotate(-90 12 ${m.t + ph / 2})">实测正确率</text></svg>`;

  const dj = ITEMS.map((_, j) => j).filter(j => differ[j]);
  const dbar = (lab, v) => `<div class="bar"><span class="lbl">${lab}</span><div class="track"><div class="fill" style="width:${Math.max(0, v * 100).toFixed(0)}%"></div></div><span class="val">${v.toFixed(2)}</span></div>`;
  $('#qCheck').innerHTML = dj.length ? dj.map(j => `<div class="stack" style="gap:6px"><div class="row between"><strong>第 ${j + 1} 题</strong><span class="pill ${qv[j][1]}">${qv[j][0]}</span></div>
     ${dbar(`专家 <span class="kv">${attrStr(EA[j])}</span>`, dE[j].d)}${dbar(`AI <span class="kv">${attrStr(AA[j])}</span>`, dA[j].d)}</div>`).join('') +
    `<div class="note">两种标定的区分度相差不到 0.10 时，现有样本无法判断哪一种更合理，保留专家标定。</div>`
    : '<p class="muted" style="margin:0">已复核的题里，人机标定没有分歧，没有需要用数据裁决的题。</p>';

  $('#valTable').innerHTML = `<thead><tr><th>题</th><th>属性标定</th><th class="num">AI 预估 P</th><th class="num">实测正确率</th><th class="num">偏差</th><th class="num">区分度</th><th>Q 矩阵检验</th><th>专家结论</th><th>入库建议</th></tr></thead><tbody>` +
    JA.map(j => {
      const bad = Math.abs(dev[j]) >= .15, v = EX[j].verdict;
      const fin = !v ? '待复核' : v === '退回' ? '退回' : (v === '修改' || bad || qv[j][0] === '数据支持 AI 标定' || qv[j][0] === '区分度偏低') ? '修订后入库' : '入库';
      return `<tr><td class="num">${j + 1}</td><td><span class="kv">${attrStr(EA[j])}</span>${v ? '' : ' <span class="small muted">AI</span>'}</td><td class="num">${AI[j].p.toFixed(2)}</td><td class="num">${ACT[j].toFixed(2)}</td>
     <td class="num" style="${bad ? 'color:var(--bad);font-weight:600' : ''}">${dev[j] >= 0 ? '+' : '−'}${Math.abs(dev[j]).toFixed(2)}</td><td class="num">${dE[j].d.toFixed(2)}</td>
     <td><span class="pill ${qv[j][1]}">${qv[j][0]}</span></td><td>${pill(v || '待复核')}</td><td>${pill(fin)}</td></tr>`;
    }).join('') + '</tbody>';

  const P = posts(EQ), covered = ATTR.map((_, k) => EA.some(a => a[k]));
  const avg = ATTR.map((_, k) => { const bit = 1 << (K - 1 - k); let s = 0; P.forEach(po => { for (let p = 0; p < NP; p++) if (p & bit) s += po[p]; }); return s / NSTU; });
  $('#classBars').innerHTML = ATTR.map((t, k) => `<div class="bar wide"><span class="lbl"><b>${t.k}</b>${t.name}</span><div class="track"><div class="fill" style="width:${covered[k] ? (avg[k] * 100).toFixed(0) : 0}%"></div></div><span class="val">${covered[k] ? (avg[k] * 100).toFixed(0) + '%' : '未覆盖'}</span></div>`).join('');
}

/* ---------- 其它 ---------- */
function showTab(t) {
  document.querySelectorAll('nav.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t));
  document.querySelectorAll('[data-view]').forEach(v => v.hidden = v.dataset.view !== t);
}
function showBoxes() { $('#setBox').hidden = src !== 'set'; $('#newBox').hidden = src !== 'new'; $('#createBox').hidden = src !== 'create'; }
function renderAll() { renderSetSelect(); renderPassage(); renderItemList(); renderCover(); renderReport(); updateRunHint(); renderKappa(); renderOverview(); renderReview(); renderValidation(); }
function pickItem(j) { cur = j; renderItemList(); renderReport(); updateRunHint(); renderOverview(); renderReview(); }

async function boot() {
  try {
    const [cfg, data] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/sets')]);
    ATTR = cfg.framework.attrs; DIMS = cfg.framework.dims; BASEROWS = cfg.framework.baseRows; PRIOR = cfg.framework.prior;
    K = ATTR.length; NP = 1 << K; aiReady = cfg.aiReady; aiModel = cfg.model; SETS = data.sets;
  } catch (e) { $('#boot').textContent = e.message; return; }
  $('#aiChip').classList.toggle('ai-on', aiReady);
  $('#aiChipText').textContent = aiReady ? 'AI 已连接 · ' + aiModel : 'AI 接口未配置';
  let i = 0; try { i = Math.max(0, SETS.findIndex(s => s.id === localStorage.getItem('precheck-set'))); } catch (e) { }
  useSet(i);

  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#itemList').addEventListener('click', e => { const b = e.target.closest('.item'); if (b) pickItem(+b.dataset.j); });
  $('#ovTable').addEventListener('click', e => { const r = e.target.closest('tr[data-j]'); if (r) pickItem(+r.dataset.j); });
  $('#srcSel').addEventListener('change', e => {
    const v = e.target.value;
    if (v.startsWith('set:')) { src = 'set'; useSet(+v.slice(4)); showBoxes(); renderAll(); }
    else { src = v; showBoxes(); renderReport(); updateRunHint(); }
  });
  $('#runBtn').addEventListener('click', runPrecheck);
  $('#runAllBtn').addEventListener('click', runAll);
  $('#createBtn').addEventListener('click', createSet);
  $('#respBtn').addEventListener('click', () => importResp($('#respText').value));
  $('#respFile').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { $('#respText').value = rd.result; }; rd.readAsText(f); });
  $('#newItem').value = `Passage: Although the museum's new wing drew record crowds in its first year, its director admitted that ticket income alone could not cover the cost of maintaining it, and that the board was "exploring other options".

Question: What does the director suggest about the new wing?
A. It was unpopular with visitors.
B. It needs other sources of funding.
C. It will soon be closed.
D. It was built too quickly.`;
  $('#cItems').placeholder = `1. What does the passage mainly discuss?
A. ...
B. ...
C. ...
D. ...
答案：B

2. The word "..." in Paragraph 2 means ____.
A. ...
B. ...
C. ...
D. ...
答案：A`;
  $('#dimDefs').innerHTML = DIMS.map(d => `<li><strong>${d[0]}</strong>：${d[1]}</li>`).join('');
  $('#attrDefs').innerHTML = ATTR.map(a => `<div><span class="tag">${a.k}</span> <strong>${a.name}</strong> <span class="small muted">${a.def}</span></div>`).join('');
  $('#baseTable').innerHTML = '<thead><tr><th>前期已完成的工作</th><th>对应环节</th><th>在本课题中的作用</th></tr></thead><tbody>' + BASEROWS.map(r => `<tr><td>${r[0]}</td><td style="white-space:nowrap">${r[1]}</td><td>${r[2]}</td></tr>`).join('') + '</tbody>';
  showBoxes(); renderAll();
  $('#boot').hidden = true; $('#app').hidden = false;
}
boot();
