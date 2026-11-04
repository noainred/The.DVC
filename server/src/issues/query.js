/**
 * issues/query.js — 이슈 검색식(순수, v2.882 · 시안 docs/design/wiki-issues ⑧).
 *
 *   assignee = me() AND status in (progress, review) AND vcenter = "vc-ap-northeast" AND updated >= -7d ORDER BY priority ASC, due ASC
 *
 * 문법: 조건(필드 연산자 값) · AND · OR · 괄호 · ORDER BY 필드 [ASC|DESC], …
 *   연산자 = != > >= < <= ~(포함) · in (…) · not in (…) · is empty · is not empty
 *   값: 낱말 · "따옴표" · 숫자 · 날짜 YYYY-MM-DD · 상대 날짜 -7d / +3d / -2w · 함수 me() now() active()
 * **서버가 해석해 거른다** — 화면은 같은 식을 보내기만 한다(두 벌 금지). 범위(scope)는 식보다 먼저(호출부 listIssues).
 * 상한: 식 500자 · 조건 20개 · 괄호 깊이 8 · in 목록 30개. 손으로 짠 토크나이저 · 재귀 하강(정규식은 한 글자 판정만 — 역추적 없음).
 * 오류는 { msg, start, end, hint } — 화면이 그 구간에 밑줄을 긋고 hint('progress 를 뜻했나요?')를 보인다.
 */

export const QUERY_LIMITS = Object.freeze({ length: 500, clauses: 20, depth: 8, inList: 30, value: 200 });
const STATUS_ORDER = ['backlog', 'todo', 'progress', 'review', 'done'];
const PRIO = ['p0', 'p1', 'p2', 'p3'];
const TYPES = ['incident', 'task', 'request', 'improve', 'epic'];

/** 필드 → 종류. text: 글(포함 · 같음) · enum · name(사람) · names(목록 — 관찰자 · 라벨) · key · date · num · sprint · vcenter · doc */
export const FIELDS = Object.freeze({
  key: 'key', title: 'text', text: 'fulltext', type: 'enum', status: 'enum', priority: 'enum', assignee: 'name', reporter: 'name',
  watcher: 'names', vcenter: 'vcenter', label: 'names', component: 'text', epic: 'key', parent: 'key', sprint: 'sprint',
  progress: 'num', due: 'date', created: 'date', updated: 'date', closed: 'date', doc: 'doc',
  // v2.885 C-3 — 수정/영향 버전(글) · SLA 상태(breached · warning · paused · late · ok · none)
  fixversion: 'text', affectsversion: 'text', sla: 'state',
});
const ENUMS = { type: TYPES, status: STATUS_ORDER, priority: PRIO, sla: ['breached', 'warning', 'paused', 'late', 'ok', 'none'] };
/** 한글 값도 받는다(화면의 표시 이름) — 저장 · 비교는 코드 값. */
const ALIASES = {
  status: {
    백로그: 'backlog', '할 일': 'todo', 할일: 'todo', '진행 중': 'progress', 진행중: 'progress', 진행: 'progress', 검토: 'review', 완료: 'done',
    open: 'todo', running: 'progress', inprogress: 'progress', 'in-progress': 'progress', wip: 'progress', closed: 'done', resolved: 'done',
  },
  type: { 장애: 'incident', 작업: 'task', 요청: 'request', 개선: 'improve', 에픽: 'epic', bug: 'incident' },
  priority: { 긴급: 'p0', 높음: 'p1', 보통: 'p2', 낮음: 'p3' },
  sla: { 초과: 'breached', 임박: 'warning', 멈춤: 'paused', 늦음: 'late', 정상: 'ok', 없음: 'none', overdue: 'breached', violated: 'breached' },
};
const OPS_BY_KIND = {
  key: ['=', '!=', 'in', 'not in', 'is'], text: ['=', '!=', '~', 'is'], fulltext: ['~'], enum: ['=', '!=', 'in', 'not in', '>', '>=', '<', '<='],
  name: ['=', '!=', 'in', 'not in', 'is'], names: ['=', '!=', 'in', 'not in', 'is'], vcenter: ['=', '!=', 'in', 'not in', 'is'],
  sprint: ['=', '!=', 'in', 'not in', 'is'], num: ['=', '!=', '>', '>=', '<', '<=', 'is'], date: ['=', '!=', '>', '>=', '<', '<=', 'is'], doc: ['~', 'is'],
  state: ['=', '!=', 'in', 'not in'],
};
export const ORDERABLE = Object.freeze(['key', 'title', 'type', 'status', 'priority', 'assignee', 'reporter', 'vcenter', 'progress', 'due', 'created', 'updated', 'closed', 'sprint', 'epic', 'component', 'fixversion']);
const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'empty', 'order', 'by', 'asc', 'desc', 'null']);

/* ───── 비슷한 말(제안) — 짧은 낱말만, 표 크기 상한 ───── */
function distance(a, b) {
  if (a.length > 40 || b.length > 40) return 99;
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export function suggest(word, choices) {
  const w = String(word || '').toLowerCase();
  let best = null; let bd = 99;
  for (const c of choices) { const d = distance(w, c.toLowerCase()); if (d < bd) { bd = d; best = c; } }
  return best && bd <= Math.max(1, Math.min(3, Math.floor(w.length / 2))) ? best : null;
}

/* ───── 토큰 ───── */
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isWord = (ch) => !!ch && /[\p{L}\p{N}_.:@/+-]/u.test(ch);
function tokenize(src, errors) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (isSpace(ch)) { i += 1; continue; }
    const start = i;
    if (ch === '(' || ch === ')' || ch === ',') { toks.push({ t: ch, start, end: i + 1 }); i += 1; continue; }
    if (ch === '!' && src[i + 1] === '=') { toks.push({ t: 'op', v: '!=', start, end: i + 2 }); i += 2; continue; }
    if ((ch === '>' || ch === '<') && src[i + 1] === '=') { toks.push({ t: 'op', v: `${ch}=`, start, end: i + 2 }); i += 2; continue; }
    if (ch === '=' || ch === '>' || ch === '<' || ch === '~') { toks.push({ t: 'op', v: ch, start, end: i + 1 }); i += 1; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1; let v = '';
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; } v += src[j]; j += 1; }
      if (j >= src.length) { errors.push({ msg: '따옴표가 닫히지 않았습니다', start, end: src.length, hint: '' }); i = src.length; break; }
      if (v.length > QUERY_LIMITS.value) errors.push({ msg: `값은 ${QUERY_LIMITS.value}자까지입니다`, start, end: j + 1, hint: '' });
      toks.push({ t: 'str', v: v.slice(0, QUERY_LIMITS.value), start, end: j + 1 }); i = j + 1; continue;
    }
    if (isWord(ch)) {
      let j = i;
      while (j < src.length && isWord(src[j])) j += 1;
      const v = src.slice(i, j);
      // 함수: 낱말 바로 뒤 '()'
      if (src[j] === '(' && src[j + 1] === ')' && /^[a-z]+$/i.test(v)) { toks.push({ t: 'fn', v: v.toLowerCase(), start, end: j + 2 }); i = j + 2; continue; }
      toks.push({ t: 'word', v, start, end: j }); i = j; continue;
    }
    errors.push({ msg: `읽을 수 없는 글자 ‘${ch}’`, start, end: i + 1, hint: '' });
    i += 1;
  }
  return toks;
}

/* ───── 구문 ───── */
const kw = (tok, word) => tok && tok.t === 'word' && tok.v.toLowerCase() === word;

/**
 * 검색식 → { ast, order, clauses, errors }. ast: { t:'and'|'or', items } | { t:'clause', field, op, values:[{k,v}], start, end } | null(조건 없음).
 * clauses: 맨 위가 AND 로만 이어질 때 조건마다 { field, op, values, start, end }(화면 칩 — 지우면 그 구간을 잘라낸다). OR 가 섞이면 식 전체 하나.
 */
export function parseQuery(input) {
  const src = String(input ?? '');
  const errors = [];
  if (src.length > QUERY_LIMITS.length) {
    return { ast: null, order: [], clauses: [], errors: [{ msg: `검색식은 ${QUERY_LIMITS.length}자까지입니다`, start: QUERY_LIMITS.length, end: src.length, hint: '' }] };
  }
  const toks = tokenize(src, errors);
  let p = 0;
  let clauseCount = 0;
  const peek = () => toks[p];
  const fail = (msg, tok, hint = '') => { errors.push({ msg, start: tok ? tok.start : src.length, end: tok ? tok.end : src.length, hint }); };

  function value() {
    const tok = peek();
    if (!tok) { fail('값이 없습니다', null); return null; }
    if (tok.t === 'str') { p += 1; return { k: 'str', v: tok.v, start: tok.start, end: tok.end }; }
    if (tok.t === 'fn') { p += 1; return { k: 'fn', v: tok.v, start: tok.start, end: tok.end }; }
    if (tok.t === 'word' && !KEYWORDS.has(tok.v.toLowerCase())) { p += 1; return { k: 'word', v: tok.v, start: tok.start, end: tok.end }; }
    fail('값이 있어야 합니다', tok); p += 1; return null;
  }
  function clause() {
    const ftok = peek();
    if (!ftok || ftok.t !== 'word') { fail('필드 이름이 있어야 합니다', ftok, ''); if (ftok) p += 1; return null; }
    const field = ftok.v.toLowerCase();
    p += 1;
    clauseCount += 1;
    if (clauseCount === QUERY_LIMITS.clauses + 1) fail(`조건은 ${QUERY_LIMITS.clauses}개까지입니다`, ftok);
    if (!Object.hasOwn(FIELDS, field)) { const s = suggest(field, Object.keys(FIELDS)); fail(`모르는 필드 ‘${ftok.v}’`, ftok, s ? `${s} 를 뜻했나요?` : ''); }
    const kind = FIELDS[field];
    let op = null; const optok = peek();
    if (optok?.t === 'op') { op = optok.v; p += 1; }
    else if (kw(optok, 'in')) { op = 'in'; p += 1; }
    else if (kw(optok, 'not') && kw(toks[p + 1], 'in')) { op = 'not in'; p += 2; }
    else if (kw(optok, 'is')) {
      p += 1;
      let neg = false;
      if (kw(peek(), 'not')) { neg = true; p += 1; }
      if (kw(peek(), 'empty') || kw(peek(), 'null')) { const e = peek(); p += 1; return finishIs(field, kind, neg, ftok, e); }
      fail("‘is’ 다음에는 empty 또는 not empty 가 와야 합니다", peek()); return null;
    } else { fail('연산자가 있어야 합니다(= != > >= < <= ~ in · not in · is empty)', optok || null); return null; }
    if (kind && !OPS_BY_KIND[kind].includes(op)) fail(`‘${field}’ 에는 ${op} 를 쓸 수 없습니다(${OPS_BY_KIND[kind].filter((o) => o !== 'is').join(' ')}${OPS_BY_KIND[kind].includes('is') ? ' · is empty' : ''})`, optok || ftok);
    let values = [];
    let closeEnd = 0; // in (…) 의 닫는 괄호 — 칩 구간이 ')' 까지 덮어야 지울 때 괄호가 남지 않는다
    if (op === 'in' || op === 'not in') {
      const lp = peek();
      if (!lp || lp.t !== '(') { fail("in 다음에는 ‘(값, 값)’ 이 와야 합니다", lp || null); return null; }
      p += 1;
      for (;;) {
        const v = value();
        if (v) values.push(v);
        if (values.length > QUERY_LIMITS.inList) { fail(`in 목록은 ${QUERY_LIMITS.inList}개까지입니다`, v); break; }
        const nx = peek();
        if (nx?.t === ',') { p += 1; continue; }
        if (nx?.t === ')') { closeEnd = nx.end; p += 1; break; }
        fail("‘)’ 가 있어야 합니다", nx || null); break;
      }
    } else {
      const v = value();
      if (v) values = [v];
    }
    const end = values.length ? Math.max(...values.map((v) => v.end), ftok.end, closeEnd) : (toks[p - 1]?.end ?? ftok.end);
    for (const v of values) checkValue(field, kind, v);
    return { t: 'clause', field, op, values, start: ftok.start, end };
  }
  function finishIs(field, kind, neg, ftok, etok) {
    if (kind && !OPS_BY_KIND[kind].includes('is')) fail(`‘${field}’ 에는 is empty 를 쓸 수 없습니다`, etok);
    return { t: 'clause', field, op: neg ? 'is not empty' : 'is empty', values: [], start: ftok.start, end: etok.end };
  }
  function checkValue(field, kind, v) {
    if (!kind) return;
    const raw = String(v.v);
    if (v.k === 'fn') {
      const okFn = (kind === 'name' || kind === 'names') ? ['me'] : kind === 'date' ? ['now'] : kind === 'sprint' ? ['active'] : [];
      if (!okFn.includes(v.v)) fail(`‘${field}’ 에는 ${v.v}() 를 쓸 수 없습니다${okFn.length ? `(${okFn.map((f) => `${f}()`).join(' · ')})` : ''}`, v);
      return;
    }
    if (kind === 'enum' || kind === 'state') {
      const low = raw.toLowerCase();
      const al = ALIASES[field] || {};
      if (!ENUMS[field].includes(low) && !Object.hasOwn(al, raw) && !Object.hasOwn(al, low)) {
        const s = suggest(low, [...ENUMS[field], ...Object.keys(al)]); // 'runnig' → running(별칭) → progress
        const code = s ? (al[s] || s) : null;
        fail(`알 수 없는 값 ‘${raw}’`, v, code ? `${code} 를 뜻했나요?` : `쓸 수 있는 값: ${ENUMS[field].join(' · ')}`);
      }
    } else if (kind === 'key') {
      if (!/^ISS-\d{1,9}$/i.test(raw)) fail(`이슈 키(ISS-번호)여야 합니다 — ‘${raw}’`, v);
    } else if (kind === 'num') {
      if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) fail(`0~100 숫자여야 합니다 — ‘${raw}’`, v);
    } else if (kind === 'date') {
      if (dateValue(raw, 0) == null) fail(`날짜(YYYY-MM-DD) · 상대 날짜(-7d · +3d · -2w) · now() 여야 합니다 — ‘${raw}’`, v);
    }
  }
  function term(depth) {
    const tok = peek();
    if (tok?.t === '(') {
      if (depth >= QUERY_LIMITS.depth) { fail(`괄호는 ${QUERY_LIMITS.depth}단까지입니다`, tok); }
      p += 1;
      const e = orExpr(depth + 1);
      let end = toks[p - 1]?.end ?? tok.end;
      if (peek()?.t === ')') { end = peek().end; p += 1; } else fail("‘)’ 가 있어야 합니다", peek() || null);
      return e ? { ...e, start: tok.start, end } : null; // 괄호 묶음의 구간(칩 하나 — 지우면 괄호째 잘라낸다)
    }
    return clause();
  }
  function andExpr(depth) {
    const items = [];
    const first = term(depth); if (first) items.push(first);
    while (kw(peek(), 'and')) { p += 1; const t2 = term(depth); if (t2) items.push(t2); }
    return items.length === 1 ? items[0] : items.length ? { t: 'and', items, start: items[0].start, end: items[items.length - 1].end } : null;
  }
  function orExpr(depth) {
    const items = [];
    const first = andExpr(depth); if (first) items.push(first);
    while (kw(peek(), 'or')) { p += 1; const t2 = andExpr(depth); if (t2) items.push(t2); }
    return items.length === 1 ? items[0] : items.length ? { t: 'or', items, start: items[0].start, end: items[items.length - 1].end } : null;
  }

  let ast = null;
  const order = [];
  let orderStart = -1;
  if (toks.length && !kw(peek(), 'order')) ast = orExpr(0);
  if (kw(peek(), 'order')) {
    const otok = peek();
    orderStart = otok.start;
    p += 1;
    if (!kw(peek(), 'by')) fail("‘ORDER’ 다음에는 ‘BY’ 가 와야 합니다", peek() || otok);
    else p += 1;
    for (let guard = 0; guard < 10; guard += 1) {
      const f = peek();
      if (!f || f.t !== 'word') { fail('정렬할 필드가 있어야 합니다', f || null); break; }
      p += 1;
      const field = f.v.toLowerCase();
      if (!ORDERABLE.includes(field)) { const s = suggest(field, ORDERABLE); fail(`정렬할 수 없는 필드 ‘${f.v}’`, f, s ? `${s} 를 뜻했나요?` : ''); }
      let dir = 'asc';
      if (kw(peek(), 'asc') || kw(peek(), 'desc')) { dir = peek().v.toLowerCase(); p += 1; }
      order.push({ field, dir, start: f.start });
      if (peek()?.t === ',') { p += 1; continue; }
      break;
    }
  }
  if (p < toks.length && !errors.length) fail('여기서 식이 끝나야 합니다 — AND · OR 가 빠졌나요?', toks[p]);
  // 칩 — 맨 위 AND 의 항목마다 하나(조건이면 그 조건, 괄호 · OR 묶음이면 묶음 하나). 맨 위가 OR 이면 식 전체가 한 칩.
  const chipOf = (x) => (x.t === 'clause' ? x : { t: 'expr', field: '', op: 'expr', values: [], start: x.start ?? 0, end: x.end ?? 0 });
  let clauses = [];
  if (ast?.t === 'and') clauses = ast.items.map(chipOf);
  else if (ast) clauses = [chipOf(ast)];
  return {
    ast: errors.length ? null : ast,
    order: errors.length ? [] : order.map(({ field, dir }) => ({ field, dir })),
    clauses: clauses.map((c) => ({ field: c.field, op: c.op, values: (c.values || []).map((v) => (v.k === 'fn' ? `${v.v}()` : v.v)), start: c.start, end: c.end })),
    orderStart, // ORDER 낱말의 위치(-1 = 없음) — 화면이 칩을 지울 때 정렬 부분을 그대로 붙인다
    errors: errors.slice(0, 10),
  };
}

/* ───── 값 해석 ───── */
/** 날짜 값 → 포탈 날짜 번호(today 기준 상대). 못 읽으면 null. */
export function dateValue(raw, today) {
  const s = String(raw || '').trim();
  const rel = /^([+-])(\d{1,4})([dw])$/i.exec(s);
  if (rel) { const n = Number(rel[2]) * (rel[3].toLowerCase() === 'w' ? 7 : 1); return today + (rel[1] === '-' ? -n : n); }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) { const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null; }
  return null;
}
const enumOf = (field, raw) => { const r = String(raw); return ALIASES[field]?.[r] || ALIASES[field]?.[r.toLowerCase()] || r.toLowerCase(); };

/**
 * ast → 판정 함수(row → bool). ctx = { me, today(포탈 날짜 번호), dayOf(ms→번호), activeSprints:Set, sprintId(이름|id → id|null), vcenterId(이름|id → id) }.
 * row = store 가 만든 평평한 보기(key · num · title · text · type · status · priority · assignee · reporter · watchers · vcenterId · labels · component ·
 *   epicKey · parentKey · sprintId · progress · dueAt · createdAt · updatedAt · closedAt · docs[]).
 */
export function compileQuery(ast, ctx) {
  if (!ast) return () => true;
  if (ast.t === 'and') { const fs = ast.items.map((x) => compileQuery(x, ctx)); return (r) => fs.every((f) => f(r)); }
  if (ast.t === 'or') { const fs = ast.items.map((x) => compileQuery(x, ctx)); return (r) => fs.some((f) => f(r)); }
  const { field, op } = ast;
  const kind = FIELDS[field];
  const vals = ast.values.map((v) => ({ ...v }));
  const getter = {
    key: (r) => r.key, title: (r) => r.title || '', text: (r) => r.text || '', type: (r) => r.type, status: (r) => r.status, priority: (r) => r.priority,
    assignee: (r) => r.assignee || '', reporter: (r) => r.reporter || '', watcher: (r) => r.watchers || [], vcenter: (r) => r.vcenterId || '',
    label: (r) => r.labels || [], component: (r) => r.component || '', epic: (r) => r.epicKey || '', parent: (r) => r.parentKey || '', sprint: (r) => r.sprintId || '',
    progress: (r) => (Number.isInteger(r.progress) ? r.progress : null), due: (r) => r.dueAt, created: (r) => r.createdAt, updated: (r) => r.updatedAt, closed: (r) => r.closedAt,
    doc: (r) => r.docs || [],
    fixversion: (r) => r.fixVersion || '', affectsversion: (r) => r.affectsVersion || '', sla: (r) => r.sla || 'none',
  }[field];
  if (op === 'is empty' || op === 'is not empty') {
    const want = op === 'is empty';
    return (r) => { const v = getter(r); const empty = v == null || v === '' || (Array.isArray(v) && !v.length); return empty === want; };
  }
  // 값 → 비교용 값 목록
  const norm = (v) => {
    if (v.k === 'fn') {
      if (v.v === 'me') return ctx.me || '\u0000';
      if (v.v === 'now') return ctx.today;
      if (v.v === 'active') return ctx.activeSprints || new Set();
    }
    const raw = String(v.v);
    switch (kind) {
      case 'enum': case 'state': return enumOf(field, raw);
      case 'key': return raw.toUpperCase();
      case 'num': return Number(raw);
      case 'date': return dateValue(raw, ctx.today);
      case 'sprint': return ctx.sprintId ? (ctx.sprintId(raw) || `\u0000${raw}`) : raw;
      case 'vcenter': return ctx.vcenterId ? ctx.vcenterId(raw) : raw;
      default: return raw.toLowerCase();
    }
  };
  const want = vals.map(norm);
  const eqOne = (have, w) => {
    if (w instanceof Set) return w.has(have);
    if (kind === 'name' || kind === 'text' || kind === 'vcenter') return String(have).toLowerCase() === String(w).toLowerCase();
    if (kind === 'date') return have != null && ctx.dayOf(have) === w;
    return have === w;
  };
  const eq = (r) => {
    const have = getter(r);
    if (Array.isArray(have)) return have.some((h) => want.some((w) => (w instanceof Set ? w.has(h) : String(h).toLowerCase() === String(w).toLowerCase())));
    return want.some((w) => eqOne(have, w));
  };
  if (op === '=' || op === 'in') return eq;
  if (op === '!=' || op === 'not in') return (r) => !eq(r);
  if (op === '~') {
    const needle = String(want[0] ?? '').toLowerCase();
    return (r) => { const v = getter(r); return Array.isArray(v) ? v.some((x) => String(x).toLowerCase().includes(needle)) : String(v || '').toLowerCase().includes(needle); };
  }
  // 크기 비교 — enum 은 순서(우선순위 p0 가 가장 높다 → 'priority <= p1' 은 p0 · p1), 날짜는 날짜 번호, 숫자
  const rank = (field === 'status' ? STATUS_ORDER : field === 'priority' ? PRIO : field === 'type' ? TYPES : null);
  const toN = (v) => {
    if (v == null) return null;
    if (rank) { const i = rank.indexOf(v); return i < 0 ? null : i; }
    if (kind === 'date') return v;
    return Number(v);
  };
  const w = toN(want[0]);
  const cmp = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b }[op];
  return (r) => {
    const raw = getter(r);
    const a = kind === 'date' ? (raw == null ? null : ctx.dayOf(raw)) : toN(raw);
    return a != null && w != null && cmp(a, w);
  };
}

/** 정렬 비교 함수 — 값이 없는 것은 방향과 무관하게 뒤. */
export function orderComparator(order, ctx = {}) {
  if (!order?.length) return null;
  const val = {
    key: (r) => r.num, title: (r) => r.title || '', type: (r) => TYPES.indexOf(r.type), status: (r) => STATUS_ORDER.indexOf(r.status), priority: (r) => PRIO.indexOf(r.priority),
    assignee: (r) => r.assignee || null, reporter: (r) => r.reporter || null, vcenter: (r) => r.vcenterId || null, progress: (r) => (Number.isInteger(r.progress) ? r.progress : null),
    due: (r) => r.dueAt ?? null, created: (r) => r.createdAt ?? null, updated: (r) => r.updatedAt ?? null, closed: (r) => r.closedAt ?? null,
    sprint: (r) => (r.sprintId ? (ctx.sprintName ? ctx.sprintName(r.sprintId) : r.sprintId) : null), epic: (r) => (r.epicKey ? Number(r.epicKey.slice(4)) : null), component: (r) => r.component || null,
    fixversion: (r) => r.fixVersion || null,
  };
  return (a, b) => {
    for (const { field, dir } of order) {
      const f = val[field]; if (!f) continue;
      const x = f(a); const y = f(b);
      const xn = x == null || x === -1; const yn = y == null || y === -1;
      if (xn && yn) continue;
      if (xn) return 1; if (yn) return -1;
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      if (c) return dir === 'desc' ? -c : c;
    }
    return 0;
  };
}
