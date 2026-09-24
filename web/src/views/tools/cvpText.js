/**
 * cvpText.js — 특수기능 › Arista CloudVision(CVP) 화면의 판정·문구(v2.608, 순수 — vitest 대상).
 *
 * 규칙(루트 CLAUDE.md 프론트엔드 규약):
 *  · '못 읽은 값' 은 null → '—' 이고 **단위를 붙이지 않는다**(unitText). `Number(null)===0` 함정은 numOrNull 로 막는다.
 *  · 파트 상태는 다섯 가지다 — ok·warn·fault·unknown(못 읽음)·absent(빈 슬롯). 뒤 둘을 정상에도 장애에도 넣지 않는다
 *    (v2.548 파트 장애 규약). 장비의 parts 가 null 이면 '읽지 못함' 이고 빈 배열(부품 0개)과 다르다.
 *  · KPI 값 0 을 경고색으로 칠하지 않는다(v2.556 — 숫자는 '문제 없음' 이라 하고 색은 '문제 있음' 이라 말하는 모순).
 *  · 후보 경로(usedPaths·missing)는 실장비로 확인하지 못한 추정이다 — 표 아래 **각주 1회**로 밝힌다(행마다 반복 금지, v2.509).
 *  · 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다) — 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { blankOr } from '../blankOr.js';

export const SECRET_MASK = '********';

/** 경과 시각 문구('—' 는 시각 없음). */
export function agoText(ts, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null || t <= 0) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/** 기간(ms) → '5분' 류. 주기 숫자를 문구에 박지 않고 서버 값을 쓴다. */
export function spanText(ms) {
  const v = numOrNull(ms);
  if (v == null || v <= 0) return '—';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.round(s / 60)}분`;
  if (s < 86400) return `${Math.round(s / 3600)}시간`;
  return `${Math.round(s / 86400)}일`;
}

/** 정수 표기(천 단위). null → '—'. */
export function countText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : n.toLocaleString('ko-KR');
}

/** bps → 사람이 읽는 처리량(값이 없으면 단위 없는 '—'). */
export function bpsText(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return '—';
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let x = n; let i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i += 1; }
  return `${i === 0 ? Math.round(x) : x.toFixed(x >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 사용률(%) — 0~100 밖이면 사용률로 보지 않는다(분모가 틀렸거나 카운터가 흔들린 것). */
export function pctOrNull(v) {
  const n = numOrNull(v);
  if (n == null || n < 0 || n > 100) return null;
  return n;
}

export function pctText(v) {
  const n = pctOrNull(v);
  return unitText(n == null ? null : (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10), '%');
}

// ── KPI ──────────────────────────────────────────────────────────────────────

/**
 * totals → KPI 목록. 값이 0 이면 강조색(accent)을 주지 않는다. 못 읽은 항목 수는 따로 적는다.
 * @returns [{ key, label, value, accent|null, meta }]
 */
export function kpiItems(totals) {
  const t = totals && typeof totals === 'object' ? totals : {};
  const n = (k) => numOrNull(t[k]);
  const red = 'var(--red)'; const amber = 'var(--amber)';
  const fault = n('partsFault'); const warn = n('partsWarn'); const unknown = n('partsUnknown');
  const faultMeta = [
    warn != null ? `주의 ${warn.toLocaleString('ko-KR')}` : null,
    unknown != null && unknown > 0 ? `상태 미확인 ${unknown.toLocaleString('ko-KR')}(정상·장애에 넣지 않음)` : null,
  ].filter(Boolean).join(' · ');
  return [
    { key: 'devices', label: '장비', value: countText(n('devices')), accent: null, meta: 'CVP 인벤토리 기준' },
    { key: 'streaming', label: '스트리밍 중', value: countText(n('streaming')), accent: null,
      meta: n('devices') != null && n('streaming') != null ? `스트리밍 아님 ${countText(Math.max(0, n('devices') - n('streaming')))}` : '' },
    { key: 'parts', label: '장애 파트', value: countText(fault), accent: fault > 0 ? red : (warn > 0 ? amber : null), meta: faultMeta },
    { key: 'bgp', label: 'BGP 피어 down', value: countText(n('bgpDown')), accent: n('bgpDown') > 0 ? red : null, meta: '' },
    { key: 'ports', label: '포트 down', value: countText(n('portsDown')), accent: n('portsDown') > 0 ? amber : null,
      meta: '관리상 켜 둔(admin up) 포트 중 링크 down' },
  ];
}

// ── 서버(CVP) 상태 ───────────────────────────────────────────────────────────

/** authStopped 값(불리언 또는 {since,at,attempts,reason}) → 있으면 true. */
export function isAuthStopped(v) {
  if (!v) return false;
  if (typeof v === 'object') return !Array.isArray(v);
  return v === true;
}

/**
 * 서버 행 상태 → { tone:'ok'|'warn'|'bad'|'muted', label, detail }.
 * 수집 기록이 없는 것은 '실패' 가 아니라 '수집 기록 없음'(회색)이다.
 */
export function serverState(server, { enabled = true } = {}) {
  const st = server && server.status && typeof server.status === 'object' ? server.status : null;
  if (server && server.enabled === false) return { tone: 'muted', label: '비활성', detail: '등록은 되어 있지만 수집하지 않습니다.' };
  if (isAuthStopped(st && st.authStopped)) return { tone: 'bad', label: '인증 실패 정지', detail: '' };
  if (!st || (st.ok == null && !st.collectedAt && !st.error)) {
    return { tone: 'muted', label: '수집 기록 없음', detail: enabled ? '첫 수집을 기다리는 중이거나 엣지가 아직 보고하지 않았습니다.' : '수집이 꺼져 있습니다(설정).' };
  }
  if (st.ok === false) return { tone: 'bad', label: '실패', detail: String(st.error || '사유를 받지 못했습니다') };
  const miss = st.missing && typeof st.missing === 'object' ? Object.keys(st.missing).length : 0;
  if (miss > 0 || st.truncated) {
    return { tone: 'warn', label: '성공(일부 미확인)', detail: [miss ? `확인하지 못한 항목 ${miss}개` : '', st.truncated ? '상한으로 잘림' : ''].filter(Boolean).join(' · ') };
  }
  return { tone: 'ok', label: '성공', detail: '' };
}

/** authStopped 안내 문장(BoldText). */
export function authStopText(v, name = '이 CVP') {
  if (!isAuthStopped(v)) return '';
  const o = typeof v === 'object' ? v : {};
  const facts = [];
  const since = numOrNull(o.since);
  const attempts = numOrNull(o.attempts);
  if (since != null) facts.push(`${agoText(since)}부터 정지`);
  if (attempts != null) facts.push(`실패 ${attempts}회`);
  const reason = typeof o.reason === 'string' && o.reason.trim() ? ` 사유: ${o.reason.trim()}` : '';
  return `**인증 실패로 ${name}의 주기 수집을 멈췄습니다**${facts.length ? `(${facts.join(' · ')})` : ''}.`
    + ' 같은 계정으로 반복 로그인하면 계정이 잠기기 때문입니다. 토큰·비밀번호를 고치면 자동으로 다시 시작하고,'
    + ' ‘지금 수집’ 은 막지 않습니다(1회 시도).' + reason;
}

/**
 * 서버 목록 → '확인하지 못한 경로' 각주(항목별 1회). 행마다 반복하지 않는다.
 * @returns [{ item, servers:[name], reasons:[string] }]
 */
export function missingFootnotes(servers) {
  const map = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    const miss = s && s.status && s.status.missing;
    if (!miss || typeof miss !== 'object') continue;
    for (const [item, reason] of Object.entries(miss)) {
      const e = map.get(item) || { item, servers: [], reasons: [] };
      const nm = String(s.name || s.id || '');
      if (nm && !e.servers.includes(nm)) e.servers.push(nm);
      const r = typeof reason === 'string' ? reason : (reason && typeof reason === 'object' ? String(reason.reason || reason.error || '') : '');
      if (r && !e.reasons.includes(r) && e.reasons.length < 3) e.reasons.push(r);
      map.set(item, e);
    }
  }
  return [...map.values()].sort((a, b) => a.item.localeCompare(b.item));
}

export const ITEM_LABEL = {
  inventory: '인벤토리', version: '버전', parts: '장애 파트', interfaces: '포트 구성', counters: '포트 카운터', bgp: 'BGP',
};
export const itemLabel = (k) => ITEM_LABEL[k] || String(k);

export const CANDIDATE_NOTE = 'CVP 의 조회 경로는 **실장비로 확인하지 못한 후보**입니다. 항목마다 후보 경로를 차례로 시도하고, 읽은 경로와 읽지 못한 이유를 그대로 보여 줍니다 — 비어 있는 칸은 ‘0’ 이 아니라 ‘읽지 못함’ 입니다.';

// ── 장비 요약 셀 ─────────────────────────────────────────────────────────────

/** parts 요약({ok,warn,fault,unknown,absent}|null) → 셀 문구·톤. */
export function partsCell(parts) {
  if (parts == null || typeof parts !== 'object') return { text: '—', tone: 'muted', title: '파트 상태를 읽지 못했습니다(정상이라는 뜻이 아닙니다).' };
  const g = (k) => numOrNull(parts[k]);
  const fault = g('fault'); const warn = g('warn'); const unknown = g('unknown'); const absent = g('absent'); const ok = g('ok');
  const bits = [];
  if (fault) bits.push(`장애 ${fault}`);
  if (warn) bits.push(`주의 ${warn}`);
  if (!bits.length) bits.push(ok != null ? `정상 ${ok}` : '—');
  if (unknown) bits.push(`미확인 ${unknown}`);
  const tone = fault ? 'bad' : warn ? 'warn' : (ok ? 'ok' : 'muted');
  const title = [`정상 ${countText(ok)}`, `주의 ${countText(warn)}`, `장애 ${countText(fault)}`,
    `상태 미확인 ${countText(unknown)}`, `빈 슬롯 ${countText(absent)}`].join(' · ')
    + ' — 미확인·빈 슬롯은 정상에도 장애에도 넣지 않습니다.';
  return { text: bits.join(' · '), tone, title };
}

/** bgp 요약({peers,established,down,prefixes}|null). */
export function bgpCell(bgp) {
  if (bgp == null || typeof bgp !== 'object') return { text: '—', tone: 'muted', title: 'BGP 상태를 읽지 못했거나 BGP 를 쓰지 않는 장비입니다.' };
  const peers = numOrNull(bgp.peers); const est = numOrNull(bgp.established); const down = numOrNull(bgp.down);
  if (peers === 0) return { text: '피어 없음', tone: 'muted', title: '설정된 BGP 피어가 없습니다.' };
  const text = `${countText(est)}/${countText(peers)}${down ? ` · down ${down}` : ''}`;
  return { text, tone: down ? 'bad' : (est != null ? 'ok' : 'muted'), title: `Established ${countText(est)} · 그 외 ${countText(down)} · 받은 prefix ${countText(bgp.prefixes)}` };
}

/** ports 요약({total,up,down}|null). */
export function portsCell(ports) {
  if (ports == null || typeof ports !== 'object') return { text: '—', tone: 'muted', title: '포트 구성을 읽지 못했습니다.' };
  const total = numOrNull(ports.total); const up = numOrNull(ports.up); const down = numOrNull(ports.down);
  return { text: `${countText(up)}/${countText(total)}${down ? ` · down ${down}` : ''}`, tone: down ? 'warn' : 'ok', title: `up ${countText(up)} · down ${countText(down)} · 전체 ${countText(total)}` };
}

export function streamingText(v) {
  if (v === true) return { text: '스트리밍', tone: 'ok' };
  if (v === false) return { text: '끊김', tone: 'warn' };
  return { text: '—', tone: 'muted' };
}

/** 장비 검색(호스트명·모델·시리얼·주소·EOS). 공백으로 나눈 단어 AND. */
export function filterDevices(devices, q) {
  const list = Array.isArray(devices) ? devices.filter((d) => d && typeof d === 'object') : [];
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((d) => {
    const hay = [d.hostname, d.model, d.serial, d.mgmtIp, d.eosVersion, d.agent, d.key].map((x) => String(x ?? '').toLowerCase()).join(' ');
    return words.every((w) => hay.includes(w));
  });
}

// ── 파트 상세 ────────────────────────────────────────────────────────────────

export const PART_STATES = Object.freeze({
  ok: { label: '정상', tone: 'ok' },
  warn: { label: '주의', tone: 'warn' },
  fault: { label: '장애', tone: 'bad' },
  unknown: { label: '상태 미확인', tone: 'muted' },
  absent: { label: '빈 슬롯', tone: 'muted' },
});
/** 모르는 상태 문자열을 정상으로 칠하지 않는다 — '상태 미확인'. */
export function partState(s) {
  return PART_STATES[s] || PART_STATES.unknown;
}

/** 파트 목록 → 다섯 상태 개수(모르는 값은 unknown 에). */
export function partCounts(parts) {
  const c = { ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0 };
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== 'object') continue;
    c[PART_STATES[p.state] ? p.state : 'unknown'] += 1;
  }
  return c;
}

// ── 포트 추이 차트(순수 기하) ────────────────────────────────────────────────

/**
 * 점 → SVG path. y축은 **0~100 고정**(사용률 — 잔물결을 '거의 100%' 처럼 보이게 하지 않는다).
 * 수집이 없던 구간(간격 > intervalMs×gapFactor)은 선을 끊는다. 점이 1개뿐인 조각은 선이 아니라 점으로만 낸다.
 * 값이 null·범위 밖인 점은 버린다(0 으로 그리지 않는다).
 * @returns { paths:[string], dots:[{x,y}], count, t0, t1 }
 */
export function seriesGeometry(points, key, { width = 600, height = 160, pad = 28, intervalMs = 300_000, gapFactor = 3 } = {}) {
  const pts = (Array.isArray(points) ? points : [])
    .map((p) => ({ t: numOrNull(p && p.ts), v: pctOrNull(p && p[key]) }))
    .filter((p) => p.t != null && p.v != null)
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return { paths: [], dots: [], count: 0, t0: null, t1: null };
  const t0 = pts[0].t; const t1 = pts[pts.length - 1].t;
  const span = t1 - t0 || 1;
  const w = width - pad * 2; const h = height - pad * 2;
  const X = (t) => pad + (pts.length === 1 ? w / 2 : ((t - t0) / span) * w);
  const Y = (v) => pad + h - (v / 100) * h;
  const gap = Math.max(1, numOrNull(intervalMs) || 300_000) * gapFactor;
  const segs = []; let cur = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0 && pts[i].t - pts[i - 1].t > gap) { segs.push(cur); cur = []; }
    cur.push(pts[i]);
  }
  segs.push(cur);
  const paths = []; const dots = [];
  for (const s of segs) {
    if (s.length === 1) { dots.push({ x: X(s[0].t), y: Y(s[0].v) }); continue; }
    paths.push(s.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' '));
  }
  return { paths, dots, count: pts.length, t0, t1 };
}

/** 추이 출처 문구 — 원시와 일 롤업은 뜻이 다르다. */
export function seriesSourceNote(resp) {
  if (!resp || typeof resp !== 'object') return '';
  if (resp.source === 'daily') return '일 단위 롤업입니다(하루 평균) — 순간값이 아니므로 짧은 피크는 보이지 않습니다.';
  if (resp.source === 'raw') return `원시 표본입니다(수집 주기 ${spanText(resp.intervalMs)}).`;
  return '';
}

// ── 지금 수집 ────────────────────────────────────────────────────────────────

/** POST /collect 응답 → 문장(중앙 즉시분과 엣지 요청분을 나눠 말한다). */
export function collectSummary(r) {
  if (!r || typeof r !== 'object') return '응답을 읽지 못했습니다.';
  const d = numOrNull(r.direct); const q = numOrNull(r.requested);
  const parts = [];
  if (d != null) parts.push(d > 0 ? `중앙 직접 ${d}대는 지금 수집했습니다` : '중앙 직접 수집 대상은 없습니다');
  if (q != null) parts.push(q > 0 ? `엣지 위임 ${q}대는 재수집을 **요청만** 등록했습니다(엣지가 설정을 받아 수집한 뒤 반영됩니다)` : '엣지 위임 대상은 없습니다');
  if (!parts.length) return '수집 요청을 보냈습니다.';
  return `${parts.join(' · ')}.`;
}

// ── 등록·설정 폼 ─────────────────────────────────────────────────────────────

export const EMPTY_SERVER = Object.freeze({
  id: '', name: '', host: '', authMode: 'token', token: '', username: '', password: '',
  agent: '', verifyTls: false, enabled: true, datacenterId: '', note: '',
});

/** 서버 응답(마스킹된 비밀 포함) → 폼 값. 비밀이 저장돼 있으면 '********'(유지 의미)로 둔다. */
export function serverToForm(s) {
  const f = { ...EMPTY_SERVER, ...(s && typeof s === 'object' ? s : {}) };
  for (const k of ['token', 'password']) f[k] = typeof f[k] === 'string' ? f[k] : '';
  f.authMode = f.authMode === 'password' ? 'password' : 'token';
  delete f.status;
  return f;
}

/**
 * 폼 → 저장 본문. '********' 는 '저장값 유지' 로 그대로 보낸다(서버가 승계). 쓰지 않는 인증 방식의 비밀은 보내지 않는다.
 * @returns { body, issue }  issue 가 있으면 저장하지 않는다.
 */
export function serverPayload(f, { isNew = false } = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const body = {
    name: s(f.name), host: s(f.host), authMode: f.authMode === 'password' ? 'password' : 'token',
    agent: s(f.agent), verifyTls: !!f.verifyTls, enabled: f.enabled !== false,
    datacenterId: s(f.datacenterId), note: s(f.note),
  };
  if (!isNew && f.id) body.id = f.id;
  if (!body.host) return { body, issue: '주소(host)를 입력하세요 — 예: ‘https://cvp.example.local’ 또는 ‘10.0.0.10’' };
  if (body.authMode === 'token') {
    const tok = typeof f.token === 'string' ? f.token : '';
    if (!tok) return { body, issue: '서비스 계정 토큰을 입력하세요(저장된 토큰을 쓰려면 ‘********’ 을 그대로 두세요).' };
    body.token = tok;
  } else {
    body.username = s(f.username);
    const pw = typeof f.password === 'string' ? f.password : '';
    if (!body.username) return { body, issue: '계정(username)을 입력하세요.' };
    if (!pw) return { body, issue: '비밀번호를 입력하세요(저장된 비밀번호를 쓰려면 ‘********’ 을 그대로 두세요).' };
    body.password = pw;
  }
  return { body, issue: '' };
}

/** 설정 폼 → PUT 본문. 빈 칸은 보내지 않는다(blankOr) — 서버가 이전 값을 유지한다. */
export function settingsPayload(f) {
  const out = { enabled: !!(f && f.enabled) };
  const min = (v) => { const n = blankOr(v); return n == null ? undefined : n; };
  const intervalMin = min(f && f.intervalMin);
  if (intervalMin != null) out.intervalMs = Math.round(intervalMin * 60_000);
  for (const k of ['rawRetentionDays', 'dailyRetentionDays', 'concurrency']) {
    const n = min(f && f[k]);
    if (n != null) out[k] = n;
  }
  const to = min(f && f.deviceTimeoutSec);
  if (to != null) out.deviceTimeoutMs = Math.round(to * 1000);
  return out;
}

/** 설정 응답 → 폼(분·초 단위로). 값이 없으면 빈 칸(0 을 지어내지 않는다). */
export function settingsToForm(s) {
  const o = s && typeof s === 'object' ? s : {};
  const n = (v, div = 1) => { const x = numOrNull(v); return x == null ? '' : String(Math.round((x / div) * 100) / 100); };
  return {
    enabled: !!o.enabled,
    intervalMin: n(o.intervalMs, 60_000),
    rawRetentionDays: n(o.rawRetentionDays),
    dailyRetentionDays: n(o.dailyRetentionDays),
    concurrency: n(o.concurrency),
    deviceTimeoutSec: n(o.deviceTimeoutMs, 1000),
  };
}
