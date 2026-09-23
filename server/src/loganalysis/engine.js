/**
 * loganalysis/engine.js — 로그 → 개선점(v2.583, 순수 + 청크 양보).
 *
 * 상태(state)는 **평범한 객체**다 — 시간 버킷으로 쌓고(live.js), 합치고(mergeState), 파일에 남길 수 있다.
 * 한 항목(`{ts, tsRaw, level, msg}`)을 넣을 때 하는 일은 태그 추출 + 정규식 몇 개뿐이라(규칙은 태그별로
 * 색인한다) 로그 1줄당 비용이 작다. 대량 입력(붙여넣기·저널)은 `analyzeItems` 가 2,000줄마다
 * setImmediate 로 양보한다 — 이 포탈의 규약(폴링 주기마다 이벤트 루프를 막는 동기 작업 금지).
 *
 * 개선점(finding)의 종류:
 *  · rule        — 카탈로그 규칙에 맞은 문장(뜻·조치·링크가 있다).
 *  · http        — 요청 로그의 5xx·413·429·401/403·느린 응답(경로 단위).
 *  · unclassified — 규칙에 없는 경고·오류(원천에 수준이 없으면 **키워드로 추정** — 그 사실을 밝힌다).
 *  · noise       — 한 문장이 로그의 큰 몫을 차지(필요한 줄을 가린다).
 * 모든 개수는 **분석한 구간 안에서**다 — 구간 밖은 말하지 않는다(coverage 가 그 구간을 밝힌다).
 */
import { tagOf, templateOf, parseHttp } from './template.js';
import { looksProblem } from './parse.js';
import { SEVERITY_RANK, normalizeRules } from './rules.js';
import { redactLogLine } from '../edgelog/redact.js';

export const CAPS = { tmpl: 3000, prob: 500, ent: 200, http: 600, samples: 3, sampleLen: 300 };


/*
 * v2.586 — 로그 문자열이 곧 맵 키다. `[__proto__] …` 한 줄이 `st.tags['__proto__']` 로 **Object.prototype 을
 * 오염**시켰다(실측 `({}).n === NaN`) — 실시간 분석은 콘솔 전 줄을 받으므로 한 줄로 프로세스 전체가 오염된다.
 * `toString`·`constructor` 같은 이름은 `||` 조회가 상속 함수를 돌려줘 엉뚱한 곳에 더한다.
 * 키는 `safeKey` 로 바꾸고 조회는 `own()`(자기 속성만)으로 한다.
 */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
export const safeKey = (k) => { const s = String(k); return RESERVED.has(s) ? `(${s})` : s; };
const own = (obj, k) => (Object.hasOwn(obj, k) ? obj[k] : undefined);

export function newState() {
  return {
    lines: 0, levels: { info: 0, warn: 0, error: 0, unknown: 0 },
    first: null, last: null, firstRaw: '', lastRaw: '',
    tags: {}, tmpl: {}, rules: {}, http: {}, prob: {},
    overflow: { tmpl: 0, prob: 0, ent: 0, http: 0 },
  };
}

/** 규칙 색인(태그 → 규칙 배열, 태그 없는 규칙은 '' 에). */
export function indexRules(rules) {
  const byTag = new Map();
  for (const r of normalizeRules(rules)) {
    const k = r.tag || '';
    if (!byTag.has(k)) byTag.set(k, []);
    byTag.get(k).push(r);
  }
  return { byTag, list: [...byTag.values()].flat() };
}

const sample = (msg) => redactLogLine(String(msg || '')).slice(0, CAPS.sampleLen);

/** 한 항목을 상태에 더한다. 절대 던지지 않는다(로그 경로에서 불린다). */
export function addItem(state, item, idx) {
  try {
    if (!item || !item.msg) return;
    const st = state;
    const msg = String(item.msg);
    st.lines += 1;
    const lv = st.levels[item.level] != null ? item.level : 'unknown';
    st.levels[lv] += 1;
    const ts = Number.isFinite(item.ts) ? item.ts : null;
    if (ts != null) {
      if (st.first == null || ts < st.first) { st.first = ts; st.firstRaw = item.tsRaw || ''; }
      if (st.last == null || ts >= st.last) { st.last = ts; st.lastRaw = item.tsRaw || ''; }
    }
    const tag = tagOf(msg);
    const tk = safeKey(tag || '(태그 없음)');
    const t = own(st.tags, tk) || (st.tags[tk] = { n: 0, warn: 0, error: 0 });
    t.n += 1; if (lv === 'warn') t.warn += 1; if (lv === 'error') t.error += 1;

    // HTTP 요청 줄 — 라우트·상태 단위로만 센다(템플릿·규칙 대상 아님).
    if (tag === 'http') {
      const h = parseHttp(msg);
      if (h) {
        const key = `${h.method} ${h.route} ${h.status}`;
        let e = own(st.http, key);
        if (!e) {
          if (Object.keys(st.http).length >= CAPS.http) { st.overflow.http += 1; return; }
          e = st.http[key] = { method: h.method, route: h.route, status: h.status, n: 0, sumMs: 0, maxMs: 0, slow: 0, rid: '' };
        }
        e.n += 1; e.sumMs += h.ms; if (h.ms > e.maxMs) { e.maxMs = h.ms; if (h.rid) e.rid = h.rid; }
        if (h.ms >= 5000) e.slow += 1;
      }
      return;
    }

    // 규칙(첫 번째로 맞는 것 하나)
    let hit = null; let m = null;
    for (const r of (idx.byTag.get(tag) || []).concat(idx.byTag.get('') || [])) {
      m = r.re.exec(msg);
      if (m) { hit = r; break; }
    }
    if (hit) {
      const e = own(st.rules, hit.id) || (st.rules[hit.id] = { n: 0, first: null, last: null, firstRaw: '', lastRaw: '', ent: {}, samples: [] });
      e.n += 1;
      if (ts != null) {
        if (e.first == null || ts < e.first) { e.first = ts; e.firstRaw = item.tsRaw || ''; }
        if (e.last == null || ts >= e.last) { e.last = ts; e.lastRaw = item.tsRaw || ''; }
      }
      if (hit.entity && m[hit.entity]) {
        const name = safeKey(String(m[hit.entity]).trim().slice(0, 120));
        if (own(e.ent, name) != null) e.ent[name] += 1;
        else if (Object.keys(e.ent).length < CAPS.ent) e.ent[name] = 1;
        else st.overflow.ent += 1;
      }
      if (e.samples.length < CAPS.samples) e.samples.push(sample(msg));
    }

    // 템플릿(반복 문장)
    const key = `${tag}|${templateOf(msg)}`;
    let te = own(st.tmpl, key);
    if (!te) {
      if (Object.keys(st.tmpl).length >= CAPS.tmpl) st.overflow.tmpl += 1;
      else te = st.tmpl[key] = { n: 0, tag, level: lv, sample: sample(msg), rule: hit ? hit.id : '' };
    }
    if (te) { te.n += 1; if (lv === 'error' || (lv === 'warn' && te.level !== 'error')) te.level = lv; }

    // 규칙에 없는 문제(수준이 있으면 warn/error, 없으면 키워드 추정)
    if (!hit) {
      const problem = lv === 'warn' || lv === 'error' || (lv === 'unknown' && looksProblem(msg));
      if (problem) {
        let pe = own(st.prob, key);
        if (!pe) {
          if (Object.keys(st.prob).length >= CAPS.prob) st.overflow.prob += 1;
          else pe = st.prob[key] = { n: 0, tag, level: lv, guessed: lv === 'unknown', sample: sample(msg) };
        }
        if (pe) pe.n += 1;
      }
    }
  } catch { /* 분석 실패가 로그 경로를 막지 않는다 */ }
}

const addNum = (a, b) => (Number(a) || 0) + (Number(b) || 0);
const minTs = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
const maxTs = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

/** 상태 b 를 a 에 합친다(a 를 바꾼다). 상한을 지킨다. */
export function mergeState(a, b) {
  if (!b) return a;
  a.lines += b.lines || 0;
  for (const k of Object.keys(a.levels)) a.levels[k] += (b.levels?.[k] || 0);
  if (b.first != null && (a.first == null || b.first < a.first)) { a.first = b.first; a.firstRaw = b.firstRaw || ''; }
  if (b.last != null && (a.last == null || b.last >= a.last)) { a.last = b.last; a.lastRaw = b.lastRaw || ''; }
  for (const [k0, v] of Object.entries(b.tags || {})) {
    const k = safeKey(k0);
    const t = own(a.tags, k) || (a.tags[k] = { n: 0, warn: 0, error: 0 });
    t.n += v.n || 0; t.warn += v.warn || 0; t.error += v.error || 0;
  }
  // v2.589 (감사 ARCH-A3): 키마다 Object.keys(...).length 를 다시 세면 버킷 수 × 키 수 × 키 수 라 7일 합산이
  //   이벤트 루프를 ~1.5초 막았다(실측) — 개수는 지역 변수로 센다.
  let nTmpl = Object.keys(a.tmpl).length;
  for (const [k0, v] of Object.entries(b.tmpl || {})) {
    const k = safeKey(k0);
    const t = own(a.tmpl, k);
    if (t) { t.n += v.n || 0; if (v.level === 'error' || (v.level === 'warn' && t.level !== 'error')) t.level = v.level; }
    else if (nTmpl < CAPS.tmpl) { a.tmpl[k] = { ...v }; nTmpl += 1; }
    else a.overflow.tmpl += v.n || 0;
  }
  let nProb = Object.keys(a.prob).length;
  for (const [k0, v] of Object.entries(b.prob || {})) {
    const k = safeKey(k0);
    const t = own(a.prob, k);
    if (t) t.n += v.n || 0;
    else if (nProb < CAPS.prob) { a.prob[k] = { ...v }; nProb += 1; }
    else a.overflow.prob += v.n || 0;
  }
  for (const [k0, v] of Object.entries(b.rules || {})) {
    const k = safeKey(k0);
    const t = own(a.rules, k) || (a.rules[k] = { n: 0, first: null, last: null, firstRaw: '', lastRaw: '', ent: {}, samples: [] });
    t.n += v.n || 0;
    if (v.first != null && (t.first == null || v.first < t.first)) { t.first = v.first; t.firstRaw = v.firstRaw || ''; }
    if (v.last != null && (t.last == null || v.last >= t.last)) { t.last = v.last; t.lastRaw = v.lastRaw || ''; }
    let nEnt = Object.keys(t.ent).length;
    for (const [n0, n] of Object.entries(v.ent || {})) {
      const name = safeKey(n0);
      if (own(t.ent, name) != null) t.ent[name] += n;
      else if (nEnt < CAPS.ent) { t.ent[name] = n; nEnt += 1; }
      else a.overflow.ent += n;
    }
    for (const s of v.samples || []) if (t.samples.length < CAPS.samples) t.samples.push(s);
  }
  let nHttp = Object.keys(a.http).length;
  for (const [k0, v] of Object.entries(b.http || {})) {
    const k = safeKey(k0);
    const t = own(a.http, k);
    if (t) { t.n += v.n; t.sumMs += v.sumMs; t.slow += v.slow; if (v.maxMs > t.maxMs) { t.maxMs = v.maxMs; t.rid = v.rid || t.rid; } }
    else if (nHttp < CAPS.http) { a.http[k] = { ...v }; nHttp += 1; }
    else a.overflow.http += v.n || 0;
  }
  for (const k of Object.keys(a.overflow)) a.overflow[k] = addNum(a.overflow[k], b.overflow?.[k]);
  void minTs; void maxTs;
  return a;
}

/** 오래된 버킷을 줄인다(상위 N 만 남긴다) — 영속 크기 유계. */
export function compactState(st, { tmpl = 60, prob = 30, ent = 30, http = 100 } = {}) {
  const top = (obj, n) => Object.fromEntries(Object.entries(obj || {}).sort((x, y) => (y[1].n || 0) - (x[1].n || 0)).slice(0, n));
  const cut = (obj, n) => {
    const kept = top(obj, n);
    let lost = 0; for (const [k, v] of Object.entries(obj || {})) if (!(k in kept)) lost += v.n || 0;
    return [kept, lost];
  };
  let lost;
  [st.tmpl, lost] = cut(st.tmpl, tmpl); st.overflow.tmpl += lost;
  [st.prob, lost] = cut(st.prob, prob); st.overflow.prob += lost;
  // v2.589: http 키는 무인증 404 경로까지 들어온다(외부 스캐너가 버킷마다 수백 개를 채울 수 있다) — 오래된 버킷은 상위 N 만.
  if (st.http) { [st.http, lost] = cut(st.http, http); st.overflow.http = (st.overflow.http || 0) + lost; }
  for (const r of Object.values(st.rules || {})) {
    const ents = Object.entries(r.ent || {}).sort((x, y) => y[1] - x[1]);
    r.ent = Object.fromEntries(ents.slice(0, ent));
    for (const [, n] of ents.slice(ent)) st.overflow.ent += n;
  }
  return st;
}

/**
 * 항목 배열을 청크로 분석한다. v2.591 S2: 줄 수(2,000)만으로 양보하면 줄 하나가 무거울 때(긴 줄·많은 규칙) 한 청크가
 * 수 초를 잡는다(실측: 붙여넣기 6MB 에 `/api/health` 24.6초 지연). **시간(sliceMs)** 으로도 양보해 이벤트 루프 정지를
 * 짧게 묶는다 — 결과는 같고 순서도 같다.
 */
export async function analyzeItems(items, rules, { chunk = 2000, sliceMs = 25, state = newState() } = {}) {
  const idx = indexRules(rules);
  let t = Date.now();
  for (let i = 0; i < items.length; i += 1) {
    addItem(state, items[i], idx);
    if ((i && i % chunk === 0) || Date.now() - t >= sliceMs) {
      await new Promise((r) => setImmediate(r));
      t = Date.now();
    }
  }
  return state;
}

const topEntities = (ent, n = 10) => Object.entries(ent || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));

/**
 * 상태 → 보고서. `rules` 는 규칙 목록(뜻·조치를 붙인다). `coverage` 는 원천이 준 구간 설명.
 * 개선점은 심각도 → 개수 순이다.
 */
export function buildReport(state, rules, { coverage = {}, noiseSharePct = 20, noiseMin = 100, probLimit = 12 } = {}) {
  const st = state || newState();
  const byId = new Map(normalizeRules(rules).map((r) => [r.id, r]));
  const findings = [];
  const lines = st.lines || 0;

  for (const [id, e] of Object.entries(st.rules || {})) {
    const r = byId.get(id);
    if (!r || !e.n) continue;
    const ents = topEntities(e.ent);
    findings.push({
      kind: 'rule', id, severity: r.severity, category: r.category, title: r.title, meaning: r.meaning, action: r.action,
      link: r.link || '', linkLabel: r.linkLabel || '', count: e.n,
      entities: ents, entityTotal: Object.keys(e.ent || {}).length, entityLabel: r.entityLabel || '', edge: !!r.edge,
      first: e.first, last: e.last, firstRaw: e.firstRaw || '', lastRaw: e.lastRaw || '', samples: e.samples || [],
    });
  }

  // HTTP — 경로 단위
  const http = Object.values(st.http || {});
  const httpBy = (pred) => http.filter(pred).sort((a, b) => b.n - a.n);
  const httpFinding = (id, severity, category, title, meaning, action, link, linkLabel, rows) => {
    if (!rows.length) return;
    const count = rows.reduce((a, r) => a + r.n, 0);
    findings.push({
      kind: 'http', id, severity, category, title, meaning, action, link, linkLabel, count,
      entities: rows.slice(0, 10).map((r) => ({ name: `${r.method} ${r.route} → ${r.status}`, count: r.n, rid: r.rid || '', maxMs: r.maxMs })),
      entityTotal: rows.length, samples: [],
    });
  };
  httpFinding('http-5xx', 'high', 'stability', '서버 오류 응답(5xx)',
    '요청 처리 중 서버가 실패했습니다. 같은 경로가 반복되면 결함입니다.',
    '경로별 최대 지연 요청의 요청 ID(#…)로 서버 성능 측정·진단·로그에서 그 줄을 찾아 원인 문구를 보세요.',
    '#/settings/perf-monitor', '서버 성능 측정', httpBy((r) => r.status >= 500));
  httpFinding('http-413', 'high', 'data', '요청 본문 한도 초과로 거부(413)',
    '보낸 데이터가 한도를 넘어 통째로 거부됐습니다. 엣지 push 라면 그 주기 데이터가 조용히 사라집니다(재시도 대상이 아닙니다).',
    '거부된 경로가 대용량 수신 경로로 등록돼 있는지 개발자에게 확인하세요. 엣지 쪽 로그의 같은 시각 push 실패도 함께 보세요.',
    '#/settings/collectors', '수집 서버', httpBy((r) => r.status === 413));
  httpFinding('http-429', 'medium', 'perf', '요청 속도 제한(429)',
    '같은 출처에서 요청이 몰려 제한에 걸렸습니다. 화면이 일부 데이터를 못 받았을 수 있습니다.',
    '같은 계정으로 여러 탭·자동화 스크립트가 도는지 확인하세요.', '', '', httpBy((r) => r.status === 429));
  httpFinding('http-auth', 'low', 'auth', '인증·권한 거부(401/403)',
    '세션 만료·권한 없음·토큰 불일치로 거부된 요청입니다. 적으면 정상(세션 만료)이고, 한 경로가 반복되면 설정 문제입니다.',
    '/api/central/ 경로가 반복되면 엣지 토큰을 점검하세요(특수기능 › 포탈 점검 › 토큰 점검). 화면 경로면 그 계정의 권한을 보세요.',
    '#/tools/portal-check', '포탈 점검', httpBy((r) => r.status === 401 || r.status === 403));
  httpFinding('http-slow', 'low', 'perf', '느린 응답(5초 이상)',
    '응답에 5초 이상 걸린 요청입니다. 고RTT vCenter 조회처럼 원래 느린 것도 섞여 있습니다.',
    '서버 성능 측정의 라우트별 지연에서 막힘(동기 CPU)인지 기다림(외부 응답)인지 보세요.',
    '#/settings/perf-monitor', '서버 성능 측정', httpBy((r) => r.slow > 0).map((r) => ({ ...r, n: r.slow })));

  // 규칙에 없는 문제
  const probs = Object.values(st.prob || {}).sort((a, b) => b.n - a.n);
  if (probs.length) {
    const guessed = probs.some((p) => p.guessed);
    findings.push({
      kind: 'unclassified', id: 'unclassified', severity: 'medium', category: 'other',
      title: '규칙에 없는 경고·오류 문장',
      meaning: guessed
        ? '카탈로그에 없는 문제성 문장입니다. 이 원천에는 로그 수준이 없어 문구의 키워드(실패·오류·거부 등)로 **추정**했습니다.'
        : '카탈로그에 없는 경고·오류 문장입니다.',
      action: '많이 반복되는 것부터 원문을 보세요. 조치가 정해진 문장이면 개발자에게 규칙 추가를 요청하세요.',
      link: '#/settings/diagnostics', linkLabel: '진단·로그',
      count: probs.reduce((a, p) => a + p.n, 0),
      entities: probs.slice(0, probLimit).map((p) => ({ name: p.sample, count: p.n, tag: p.tag, guessed: !!p.guessed })),
      entityTotal: probs.length, samples: [],
    });
  }

  // 로그 잡음 — 한 문장이 큰 몫
  const tmpls = Object.entries(st.tmpl || {}).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.n - a.n);
  if (lines >= noiseMin) {
    const noisy = tmpls.filter((t) => (t.n / lines) * 100 >= noiseSharePct && t.level !== 'error');
    if (noisy.length) {
      findings.push({
        kind: 'noise', id: 'noise', severity: 'low', category: 'noise',
        title: '한 문장이 로그의 큰 몫을 차지',
        meaning: '같은 문장이 반복돼 다른 줄을 가립니다. 화면 덤프·tail 로 볼 때 필요한 줄이 밀려납니다.',
        action: '덤프할 때 이 문장을 빼고 보세요(grep -v). 정상 기록이 대부분이면 개발자에게 로그 축소를 요청하세요.',
        link: '', linkLabel: '',
        count: noisy.reduce((a, t) => a + t.n, 0),
        entities: noisy.slice(0, 5).map((t) => ({ name: t.sample, count: t.n, sharePct: Math.round((t.n / lines) * 1000) / 10 })),
        entityTotal: noisy.length, samples: [],
      });
    }
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.count - a.count));

  const tags = Object.entries(st.tags || {}).map(([tag, v]) => ({ tag, ...v, sharePct: lines ? Math.round((v.n / lines) * 1000) / 10 : null }))
    .sort((a, b) => b.n - a.n);
  const bySev = {};
  for (const f of findings) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  return {
    coverage: { ...coverage, lines, first: st.first, last: st.last, firstRaw: st.firstRaw || '', lastRaw: st.lastRaw || '' },
    levels: { ...st.levels },
    findings,
    findingCounts: bySev,
    tags: tags.slice(0, 60),
    tagsTotal: tags.length,
    templates: tmpls.slice(0, 40).map((t) => ({ tag: t.tag, level: t.level, count: t.n, sharePct: lines ? Math.round((t.n / lines) * 1000) / 10 : null, sample: t.sample, rule: t.rule || '' })),
    templatesTotal: tmpls.length,
    http: {
      total: http.reduce((a, r) => a + r.n, 0),
      err5xx: http.filter((r) => r.status >= 500).reduce((a, r) => a + r.n, 0),
      err4xx: http.filter((r) => r.status >= 400 && r.status < 500).reduce((a, r) => a + r.n, 0),
    },
    overflow: { ...st.overflow },
  };
}
