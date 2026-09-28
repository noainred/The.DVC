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
import { collectDropNote } from './collectDropText.js';
import { agoText } from './relTime.js'; // v2.640 ①: 상대시각 사본(9벌 중 하나 — v2.613 WEB2613-15)을 공용 코어로

export const SECRET_MASK = '********';
export { agoText };

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
  // v2.611(WEB2611-12): 0 초과 0.05 미만은 반올림하면 '0%'(= 트래픽 없음)로 읽힌다 — '<0.1%' 로 말한다.
  if (n != null && n > 0 && n < 0.05) return '<0.1%';
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
  // v2.611(WEB2611-02): 읽지 못한 **장비** 수를 함께 말한다 — 'down 0'·'장애 0' 이 전부 확인했다는 뜻이 아니다.
  const unread = (k, what) => { const v = n(k); return v != null && v > 0 ? `${what} 못 읽은 장비 ${v.toLocaleString('ko-KR')}대(0 에 넣지 않음)` : null; };
  const faultMeta = [
    warn != null ? `주의 ${warn.toLocaleString('ko-KR')}` : null,
    unknown != null && unknown > 0 ? `상태 미확인 ${unknown.toLocaleString('ko-KR')}(정상·장애에 넣지 않음)` : null,
    unread('partsUnread', '파트를'),
  ].filter(Boolean).join(' · ');
  return [
    { key: 'devices', label: '장비', value: countText(n('devices')), accent: null, meta: 'CVP 인벤토리 기준' },
    { key: 'streaming', label: '스트리밍 중', value: countText(n('streaming')), accent: null,
      meta: n('devices') != null && n('streaming') != null ? `스트리밍 아님 ${countText(Math.max(0, n('devices') - n('streaming')))}` : '' },
    { key: 'parts', label: '장애 파트', value: countText(fault), accent: fault > 0 ? red : (warn > 0 ? amber : null), meta: faultMeta },
    { key: 'bgp', label: 'BGP 피어 down', value: countText(n('bgpDown')), accent: n('bgpDown') > 0 ? red : null, meta: [n('bgpStateUnknown') > 0 ? `상태 미확인 ${countText(n('bgpStateUnknown'))}(down 에 넣지 않음)` : null, unread('bgpUnread', 'BGP 를')].filter(Boolean).join(' · ') },
    { key: 'ports', label: '포트 down', value: countText(n('portsDown')), accent: n('portsDown') > 0 ? amber : null,
      meta: ['관리상 켜 둔(admin up) 포트 중 링크 down', n('portsNoLink') > 0 ? `미연결 ${countText(n('portsNoLink'))}은 제외` : null, unread('portsUnread', '포트를')].filter(Boolean).join(' · ') },
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
 * 보고가 없는 위임 CVP 의 kind(서버 `central/cvpEdge.js CVP_EDGE_KINDS`) → 상태. 키 집합은 서버와 1:1 이어야 한다(테스트가 대조).
 * 문구는 여기(웹)가 만든다 — 서버는 kind·edgeVersion·minEdgeVersion 만 준다(v2.553 규약). 백틱 금지(BoldText 는 ‘**’ 만 해석).
 */
const EDGE_NO_REPORT_TEXT = Object.freeze({
  'old-version': (st) => ({
    tone: 'bad', label: `구버전 엣지${st.edgeVersion ? ` ${st.edgeVersion}` : ''}`,
    detail: `이 엣지는 CVP 위임 수집이 없는 버전입니다(현재 ${st.edgeVersion || '?'} · 필요 ${st.minEdgeVersion || '?'} 이상). 기다려도 보고가 오지 않습니다 — 그 엣지를 업그레이드하세요.`,
  }),
  'unknown-version': () => ({
    tone: 'warn', label: '보고 없음 · 버전 미상',
    detail: '이 엣지가 중앙에 보고한 적이 없고 엣지 버전도 확인되지 않았습니다(export 를 한 번도 받지 못함). 설정 › 수집 서버에서 그 엣지 연결부터 확인하세요.',
  }),
  silent: () => ({
    tone: 'warn', label: '보고 없음',
    detail: '엣지 버전은 충분한데 중앙이 수집 주기의 3배를 넘게 돌았는데도 보고가 없습니다. 기다려서 될 일이 아닙니다 — 그 엣지의 CVP 설정 pull·push 상태를 엣지 로그(특수기능 › 엣지 로그)에서 보세요.',
  }),
  waiting: () => ({ tone: 'muted', label: '수집 기록 없음', detail: '첫 보고를 기다리는 중입니다(엣지 버전은 충분합니다).' }),
});

/** 서버가 낼 수 있는 '보고 없음' kind 목록 — 서버 `CVP_EDGE_KINDS` 와 1:1(테스트가 두 목록을 대조). */
export const CVP_EDGE_KINDS = Object.freeze(Object.keys(EDGE_NO_REPORT_TEXT));

/**
 * 서버 행 상태 → { tone:'ok'|'warn'|'bad'|'muted', label, detail }.
 * 수집 기록이 없는 것은 '실패' 가 아니라 '수집 기록 없음'(회색)이다.
 */
export function serverState(server, { enabled = true } = {}) {
  const st = server && server.status && typeof server.status === 'object' ? server.status : null;
  if (server && server.enabled === false) return { tone: 'muted', label: '비활성', detail: '등록은 되어 있지만 수집하지 않습니다.' };
  if (isAuthStopped(st && st.authStopped)) return { tone: 'bad', label: '인증 실패 정지', detail: '' };
  if (!st || (st.ok == null && !st.collectedAt && !st.error)) {
    if (!enabled) return { tone: 'muted', label: '수집 기록 없음', detail: '수집이 꺼져 있습니다(설정).' };
    // v2.613 CONTRACT2613-04: 엣지 위임인데 보고가 없으면 서버가 이유(kind)를 나눠 준다 — 구버전은 기다려도 안 된다.
    const k = st && EDGE_NO_REPORT_TEXT[st.kind] ? EDGE_NO_REPORT_TEXT[st.kind](st) : null;
    if (k) return k;
    return { tone: 'muted', label: '수집 기록 없음', detail: '첫 수집을 기다리는 중이거나 엣지가 아직 보고하지 않았습니다.' };
  }
  if (st.ok === false) return { tone: 'bad', label: '실패', detail: String(st.error || '사유를 받지 못했습니다') };
  const miss = st.missing && typeof st.missing === 'object' ? Object.keys(st.missing).length : 0;
  if (miss > 0 || isTruncated(st.truncated)) {
    return { tone: 'warn', label: '성공(일부 미확인)', detail: [miss ? `확인하지 못한 항목 ${miss}개` : '', isTruncated(st.truncated) ? '상한으로 잘림' : ''].filter(Boolean).join(' · ') };
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

/**
 * 서버 수집 항목 키(cvp/client.js CANDIDATES + missing 의 budget·deadline) → 한글 라벨.
 * v2.611(WEB2611-04): 예전 표는 서버에 없는 키(version·parts)를 들고 있고 실제 키 6개(cvpVersion·power·cooling·temperature·xcvr·budget)가
 *   영문 그대로 샜다. 두 목록은 테스트(cvpText.test.js)가 서버 소스와 대조한다 — 서버에 키를 더하면 여기도 더할 것.
 */
export const ITEM_LABEL = {
  inventory: '인벤토리', cvpVersion: 'CVP 버전', interfaces: '포트 구성', counters: '포트 카운터', bgp: 'BGP',
  power: '전원(PSU)', cooling: '팬', temperature: '온도 센서', xcvr: '트랜시버',
  budget: '시간 예산', deadline: '수집 시한',
};
export const itemLabel = (k) => ITEM_LABEL[k] || String(k);

export const CANDIDATE_NOTE = 'CVP 의 조회 경로는 **실장비로 확인하지 못한 후보**입니다. 항목마다 후보 경로를 차례로 시도하고, 읽은 경로와 읽지 못한 이유를 그대로 보여 줍니다 — 비어 있는 칸은 ‘0’ 이 아니라 ‘읽지 못함’ 입니다.';

/** 누가 '지금 수집' 을 누를 수 있나(서버 `/tools/cvp/collect` 가 admin·operator 만 받는다 — v2.590 D1). 로그인 정보가 없으면(인증 꺼짐) 참. */
export function canCollect(user) {
  if (!user) return true;
  return user.role === 'admin' || user.role === 'operator';
}

/**
 * 목록 응답의 부가 상태 → 배너 문장들(BoldText). v2.611(WEB2611-03): 서버는 싣는데 화면이 읽지 않던 넷 —
 *   dbUnavailable(장비 0대로 보이는 거짓) · collectDrops(요청이 결과 없이 폐기) · pendingRequest(재수집 대기) · orphanRows(담당이 바뀌어 숨긴 행).
 * @returns {string[]}
 */
export function listNotes(data, now = Date.now()) {
  const d = data && typeof data === 'object' ? data : {};
  const servers = Array.isArray(d.servers) ? d.servers.filter((s) => s && typeof s === 'object') : [];
  const nameOf = (id) => (servers.find((s) => String(s.id) === String(id)) || {}).name || id;
  const out = [];
  if (d.dbUnavailable) out.push('**중앙 CVP DB 를 열지 못했습니다** — 아래 장비 목록이 비어 있는 것은 ‘장비 0대’ 가 아니라 ‘읽지 못함’ 입니다(중앙 로그의 cvp-db 줄 참조).');
  const drop = collectDropNote(d.collectDrops, nameOf, now);
  if (drop) out.push(drop);
  const pend = servers.filter((s) => s.pendingRequest);
  if (pend.length) out.push(`재수집 요청 대기 ${pend.length}대(${pend.slice(0, 5).map((s) => s.name || s.id).join(', ')}${pend.length > 5 ? ' 외' : ''}) — 엣지가 설정을 받아 수집한 뒤 반영됩니다.`);
  const orphan = numOrNull(d.orphanRows);
  if (orphan != null && orphan > 0) out.push(`담당 엣지가 바뀌었거나 등록에서 빠진 CVP 의 옛 장비 행 ${orphan.toLocaleString('ko-KR')}개는 표에 넣지 않았습니다(현재 담당의 보고만 보여 줍니다).`);
  for (const s of servers) {
    const st = s.status && typeof s.status === 'object' ? s.status : {};
    if (st.dbUnavailable) out.push(`${s.name || s.id}: 수집한 노드의 CVP DB 를 쓸 수 없어 결과를 저장하지 못했습니다.`);
    if (st.pruneHeld && typeof st.pruneHeld === 'object') out.push(`${s.name || s.id}: ${String(st.pruneHeld.reason || '장비 0대 보고 — 장비 목록 정리를 잠시 보류합니다')}`);
    if (st.partsDueUnread) out.push(partsDueNote(s.name || s.id, st));
  }
  return out;
}

/**
 * v2.612 WEB2612-07: 장비 표 제목. 목록 응답이 없으면(불러오는 중·실패) '장비 —' — '0대' 는 '읽었고 없다' 는 뜻이다.
 */
export function deviceCountLabel(devices, shown, total) {
  if (!devices || typeof devices !== 'object' || !Array.isArray(devices.devices)) return '장비 —';
  return `장비 ${countText(shown)}대${shown !== total ? ` (전체 ${countText(total)})` : ''}`;
}

const PART_ITEM_KEYS = ['power', 'cooling', 'temperature', 'xcvr'];
/**
 * v2.612 RECENT2612-01: '파트를 읽을 차례였지만 조회하지 못함' 문장. 서버는 이 표시를 **예산·시한 때문에 시도조차 못 한 장비**가
 *   있을 때만 싣는다 — 그 원인만 말하고, 파트 경로 실패 사유가 함께 있으면 그 사유를 그대로 붙인다(원인을 지어내지 않는다).
 *   '이전 값' 은 시도하지 못한 장비에만 해당한다(시도한 장비는 이번 결과가 저장된다).
 */
export function partsDueNote(name, st) {
  const o = st && typeof st === 'object' ? st : {};
  const n = numOrNull(o.partsNotTried);
  const who = n != null && n > 0 ? `${n}대` : '일부 장비';
  const miss = o.missing && typeof o.missing === 'object' ? o.missing : {};
  const reasons = PART_ITEM_KEYS.filter((k) => typeof miss[k] === 'string' && miss[k]).map((k) => `${itemLabel(k)}: ${miss[k]}`);
  return `${name}: 이번 주기에 파트를 읽을 차례였지만 ${who}는 시간 예산·수집 시한 때문에 파트를 조회하지 못했습니다 — 그 장비의 파트 표시는 이전 조회 값입니다.`
    + (reasons.length ? ` 파트 조회 실패 사유: ${reasons.join(' · ')}` : '');
}

/** 장비 상세의 '읽지 못한 파트 종류' 문장(없으면 ''). 서버 키(power·cooling·…)를 한글로. */
export function partsMissingText(kinds) {
  const list = (Array.isArray(kinds) ? kinds : []).filter((k) => typeof k === 'string' && k);
  if (!list.length) return '';
  return `이번 파트 조회에서 **${list.map(itemLabel).join(' · ')}** 은(는) 읽지 못했습니다 — 목록에 없는 것은 ‘정상’ 이 아니라 ‘읽지 못함’ 입니다.`;
}

export const TELEMETRY_TEXT = {
  ok: '텔레메트리 조회 성공',
  failed: '텔레메트리 조회 실패(모든 후보 경로 실패)',
  'not-streaming': 'CVP 로 스트리밍하지 않는 장비 — 텔레메트리를 조회하지 않았습니다',
  budget: '시간 예산이 모자라 조회하지 않았습니다',
  'budget-partial': '시간 예산이 모자라 일부만 조회했습니다',
  aborted: '수집 시한에 걸려 조회를 끝내지 못했습니다',
  pending: '조회 결과가 없습니다',
};
/** 장비 telemetry 값 → 문장('' = 없음). 모르는 값은 원문을 붙인다(지어내지 않는다). */
export function telemetryText(v) {
  if (v == null || v === '') return '';
  return TELEMETRY_TEXT[v] || `텔레메트리 상태: ${String(v)}`;
}

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
  return { text, tone: down ? 'bad' : (est != null ? 'ok' : 'muted'), title: `Established ${countText(est)} · 그 외 ${countText(down)} · 받은 prefix ${prefixText(bgp.prefixes, bgp.prefixesUnknown)}` };
}

/**
 * v2.612 COL2612-04: 받은 prefix 합계 — prefix 수를 모르는 피어가 있으면 합계는 '최소' 값이다(부분 합을 전체라 말하지 않는다).
 *   전부 모르면 '—'. prefixesUnknown 이 없는 옛 응답은 예전처럼 숫자만.
 */
export function prefixText(prefixes, unknown) {
  const p = numOrNull(prefixes);
  const u = numOrNull(unknown);
  if (p == null) return '—';
  if (u != null && u > 0) return `최소 ${countText(p)}(피어 ${countText(u)}개는 prefix 수 모름)`;
  return countText(p);
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
  if (!body.name) return { body, issue: '표시명을 입력하세요(1~64자).' };
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
  // v2.640 ③: 알림 스위치 둘(불리언 — 빈 칸 규칙 대상이 아니다). faultAlertsClosed 는 체크 해제가 곧 false.
  const out = { enabled: !!(f && f.enabled), faultAlerts: !!(f && f.faultAlerts), faultAlertsClosed: !(f && f.faultAlertsClosed === false) };
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
    faultAlerts: o.faultAlerts === true,
    faultAlertsClosed: o.faultAlertsClosed !== false,
    intervalMin: n(o.intervalMs, 60_000),
    rawRetentionDays: n(o.rawRetentionDays),
    dailyRetentionDays: n(o.dailyRetentionDays),
    concurrency: n(o.concurrency),
    deviceTimeoutSec: n(o.deviceTimeoutMs, 1000),
  };
}

/** 서버 `truncated` 는 `{devices, ports, peers, notTried}` 개수 객체다(불리언을 보내던 판본도 받는다) — 0 만 있으면 잘린 것이 아니다. */
export function isTruncated(t) {
  if (t === true) return true;
  if (!t || typeof t !== 'object') return false;
  return Object.values(t).some((v) => typeof v === 'number' && v > 0);
}

/**
 * 등록 폼 드롭다운 항목(v2.609 — 사용자 요청 "엣지 이름과 데이터 센터를 콤보박스로 … 오타/대소문자 방지").
 * 목록에 없는 현재 값(엣지가 아직 통신한 적이 없거나 DataCenter 가 삭제된 경우)은 **지우지 않고** 따로 표시한다 —
 * 지우면 다른 칸만 고쳐 저장해도 그 값이 조용히 바뀐다.
 * @param {Array<string|{id:string,name?:string}>} list
 * @param {string} current
 * @returns {{value:string,label:string,missing?:boolean}[]}
 */
export function choiceOptions(list, current) {
  const items = (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string'
    ? { value: x, label: x }
    : { value: String(x && x.id != null ? x.id : ''), label: String((x && (x.name || x.id)) ?? '') })).filter((o) => o.value);
  const cur = String(current ?? '').trim();
  if (cur && !items.some((o) => o.value.trim().toLowerCase() === cur.toLowerCase())) {
    items.unshift({ value: cur, label: `${cur} (목록에 없음)`, missing: true });
  }
  return items;
}

// ── v2.640 ① 남은 결함·정리 ───────────────────────────────────────────────────

/** 엣지 보고 1건 → 배지. v2.640: `devicesUnavailable`(엣지 DB 불가 — 상태만 보냄)을 함께 말한다(예전엔 서버가 싣는데 화면이 안 읽었다). */
export function edgeReportView(e) {
  const o = e && typeof e === 'object' ? e : {};
  const tone = o.ok === false ? 'bad' : o.ok ? 'ok' : 'muted';
  const label = o.ok === false ? '실패' : o.ok ? '정상' : '—';
  const extras = [];
  if (o.devicesUnavailable === true) extras.push('엣지 DB 불가 — 상태만 보고(장비 목록은 직전 값)');
  const servers = numOrNull(o.servers);
  if (servers != null) extras.push(`CVP ${servers}대`);
  return { tone, label, title: String(o.error || ''), extras };
}

/** 서버 행 툴팁 — CVP 자체 버전·수집 소요(서버는 싣는데 화면이 안 보이던 값). */
export function serverMetaText(st) {
  const o = st && typeof st === 'object' ? st : {};
  const bits = [];
  if (o.cvpVersion) bits.push(`CVP ${String(o.cvpVersion)}`);
  const d = numOrNull(o.durationMs);
  if (d != null && d >= 0) bits.push(`수집 소요 ${d < 1000 ? `${d}ms` : `${Math.round(d / 100) / 10}초`}`);
  if (o.partsRead === true) bits.push('이번 주기에 파트 읽음');
  return bits.join(' · ');
}

/** 관리자용 DB 요약 한 줄(행 수는 캐시값 — countsAt 이 말한다). */
export function dbStatsText(db, now = Date.now()) {
  if (!db || typeof db !== 'object') return '';
  if (db.available === false) return `중앙 CVP DB 사용 불가${db.note ? ` — ${db.note}` : ''}`;
  const r = db.rows && typeof db.rows === 'object' ? db.rows : {};
  const mb = numOrNull(db.bytes);
  return `DB 장비 ${countText(r.device)} · 포트 ${countText(r.port)} · 원시 표본 ${countText(r.sample)} · 일 롤업 ${countText(r.daily)}`
    + (mb != null ? ` · ${(mb / 1_048_576).toFixed(1)} MB` : '') + (db.countsAt ? ` (행 수는 ${agoText(db.countsAt, now)} 기준)` : '');
}

// ── v2.640 ④ 화면 UX — 필터 칩 · CSV ─────────────────────────────────────────

/** 장비 필터 칩. 판정은 목록 응답의 요약 셀과 같은 값을 본다(표와 칩 개수가 어긋나지 않게). */
export const DEVICE_CHIPS = Object.freeze([
  { key: 'all', label: '전체' },
  { key: 'fault', label: '장애 파트' },
  { key: 'warn', label: '주의 파트' },
  { key: 'portDown', label: '포트 down' },
  { key: 'bgpDown', label: 'BGP down' },
  { key: 'notStreaming', label: '스트리밍 아님' },
  { key: 'unread', label: '못 읽음' },
]);
const gt0 = (v) => { const n = numOrNull(v); return n != null && n > 0; };
/** 장비 1대가 칩에 해당하는가. 'unread' = 파트·포트·BGP 중 하나라도 읽지 못했거나 텔레메트리 실패(정상이 아니라 '모름'). */
export function chipMatch(d, key) {
  if (!d || typeof d !== 'object') return false;
  switch (key) {
    case 'all': return true;
    case 'fault': return gt0(d.parts && d.parts.fault);
    case 'warn': return gt0(d.parts && d.parts.warn);
    case 'portDown': return gt0(d.ports && d.ports.down);
    case 'bgpDown': return gt0(d.bgp && d.bgp.down);
    case 'notStreaming': return d.streaming === false;
    case 'unread': return d.parts == null || d.ports == null || d.bgp == null || ['failed', 'aborted', 'budget'].includes(String(d.telemetry || ''));
    default: return false;
  }
}
export function chipCounts(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const out = {};
  for (const c of DEVICE_CHIPS) out[c.key] = list.filter((d) => chipMatch(d, c.key)).length;
  return out;
}
export function filterByChip(devices, key) {
  const list = (Array.isArray(devices) ? devices : []).filter((d) => d && typeof d === 'object');
  if (!key || key === 'all') return list;
  return list.filter((d) => chipMatch(d, key));
}
/** CSV 다운로드 경로(목록과 같은 필터를 쓴다 — 칩 필터는 화면 전용이라 CSV 는 검색·CVP 범위만 반영한다는 것을 문구가 말한다). */
export function devicesCsvPath(cvpSel, q) {
  const p = new URLSearchParams();
  if (cvpSel) p.set('cvpId', String(cvpSel));
  if (q && String(q).trim()) p.set('q', String(q).trim());
  const qs = p.toString();
  return `/tools/cvp/devices.csv${qs ? `?${qs}` : ''}`;
}
export const CSV_NOTE = 'CSV 는 검색어·CVP 선택만 반영합니다(필터 칩은 화면 전용). 값이 없는 칸은 비어 있습니다 — 0 이 아닙니다.';

// ── v2.640 ④ 포트 차트 — 처리량 모드 ─────────────────────────────────────────

export const CHART_MODES = Object.freeze([['util', '사용률'], ['bps', '처리량']]);
/** 처리량 축 상한 — 데이터 최대를 1·2·5 계열로 올림(사용률과 달리 상한이 없으므로 데이터에 맞춘다 — v2.551 규약). */
export function bpsAxisMax(max) {
  const m = numOrNull(max);
  if (m == null || m <= 0) return 1000;
  const e = Math.pow(10, Math.floor(Math.log10(m)));
  for (const k of [1, 2, 5, 10]) if (m <= k * e) return k * e;
  return 10 * e;
}
/**
 * 처리량(bps) 기하 — 사용률 기하와 같은 규칙(끊김·점 1개·null 버림)이지만 y 축은 두 방향의 최대에 맞춘다.
 * @returns { paths:{[key]:string[]}, dots:{[key]:{x,y}[]}, count, max, axisMax, ticks:[{v,y,label}] }
 */
export function seriesGeometryBps(points, keys = ['inBps', 'outBps'], { width = 600, height = 160, pad = 28, intervalMs = 300_000, gapFactor = 3 } = {}) {
  const list = Array.isArray(points) ? points : [];
  let max = 0; let count = 0;
  const per = {};
  for (const k of keys) {
    per[k] = list.map((p) => ({ t: numOrNull(p && p.ts), v: numOrNull(p && p[k]) })).filter((p) => p.t != null && p.v != null && p.v >= 0).sort((a, b) => a.t - b.t);
    for (const p of per[k]) if (p.v > max) max = p.v;
    count += per[k].length;
  }
  const axisMax = bpsAxisMax(max);
  const all = keys.flatMap((k) => per[k]);
  const t0 = all.length ? Math.min(...all.map((p) => p.t)) : null;
  const t1 = all.length ? Math.max(...all.map((p) => p.t)) : null;
  const span = (t1 ?? 0) - (t0 ?? 0) || 1;
  const w = width - pad * 2; const h = height - pad * 2;
  const X = (t) => pad + (all.length === 1 ? w / 2 : ((t - t0) / span) * w);
  const Y = (v) => pad + h - (v / axisMax) * h;
  const gap = Math.max(1, numOrNull(intervalMs) || 300_000) * gapFactor;
  const paths = {}; const dots = {};
  for (const k of keys) {
    const segs = []; let cur = [];
    for (let i = 0; i < per[k].length; i += 1) {
      if (i > 0 && per[k][i].t - per[k][i - 1].t > gap) { segs.push(cur); cur = []; }
      cur.push(per[k][i]);
    }
    segs.push(cur);
    paths[k] = []; dots[k] = [];
    for (const sg of segs) {
      if (!sg.length) continue;
      if (sg.length === 1) { dots[k].push({ x: X(sg[0].t), y: Y(sg[0].v) }); continue; }
      paths[k].push(sg.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' '));
    }
  }
  const ticks = [0, 0.5, 1].map((f) => ({ v: axisMax * f, y: Y(axisMax * f), label: bpsText(axisMax * f) }));
  return { paths, dots, count, max, axisMax, ticks, t0, t1 };
}
/** 응답 상한으로 잘린 추이 — 조용한 상한 금지(v2.509). '' 면 잘리지 않았다. */
export function chartCutNote(resp) {
  if (!resp || typeof resp !== 'object' || resp.truncated !== true) return '';
  const lim = numOrNull(resp.limit);
  return `응답 상한${lim != null ? `(${countText(lim)}점)` : ''}으로 잘렸습니다 — 최근 표본만 그렸습니다. 기간을 줄이거나 30일 이상은 일 롤업으로 보세요.`;
}

// ── v2.640 ③ 장애 전이·알림 ──────────────────────────────────────────────────

export const FAULT_KIND_LABEL = Object.freeze({ psu: '전원(PSU)', fan: '팬', temp: '온도 센서', xcvr: '트랜시버', port: '포트', bgp: 'BGP 피어' });
export const faultKindLabel = (k) => FAULT_KIND_LABEL[k] || String(k || '—');
/** 보류 사유(서버 cvp/faults.js HOLD_REASON) → 문장. 보류는 '고쳐지지 않았다' 도 '고쳐졌다' 도 아니다. 키 집합은 테스트가 서버와 대조한다. */
export const HOLD_TEXT = Object.freeze({
  'device-failed': '장비 수집 실패 — 닫지 않고 보류(한 주기 실패로 전 장애를 복구로 적지 않습니다)',
  'device-stale': '수집이 낡음(주기 3배 초과) — 보류',
  'collection-failed': '그 종류(파트·포트·BGP)를 이번에 읽지 못함 — 보류',
  unknown: '상태 미확인으로 관측 — 보류(정상도 이상도 아닙니다)',
  missing: '관측 목록에 없음 — 보류. 고쳐졌다는 뜻이 아닙니다(장비·부품이 사라졌으면 관리자가 수동으로 닫습니다)',
  'not-streaming': 'CVP 로 스트리밍하지 않는 장비 — 보류',
});
export const HOLD_KEYS = Object.freeze(Object.keys(HOLD_TEXT));
export function holdText(r) { return r ? (HOLD_TEXT[r] || `보류(${String(r)})`) : ''; }
/** 닫힘 사유 → 문장. */
export function closeReasonText(r) {
  const s = String(r ?? '');
  if (!s) return '—';
  if (s === 'ok') return '정상으로 관측';
  if (s === 'removed') return '빈 슬롯(부품 제거 — 교체 여부를 확인하세요)';
  if (s.startsWith('manual')) { const who = s.split(':')[1]; return `수동 닫기${who ? `(${who})` : ''}`; }
  return s;
}
/** 열린 장애 행 → 표시. */
export function faultRowView(f) {
  const o = f && typeof f === 'object' ? f : {};
  const ps = partState(o.state);
  return {
    kindLabel: faultKindLabel(o.kind),
    state: ps,
    device: o.deviceName || o.deviceKey || '—',
    where: [o.cvpName || o.cvpId || '', o.agent ? `엣지 ${o.agent}` : '중앙'].filter(Boolean).join(' · '),
    hold: holdText(o.holdReason),
    since: o.firstSeen,
    lastSeen: o.lastSeen,
    notified: o.notifiedAt != null,
  };
}
/** 이벤트 행 → 문장. */
export function faultEventText(ev) {
  const o = ev && typeof ev === 'object' ? ev : {};
  if (o.event === 'open') return `열림 — ${partState(o.state).label}`;
  if (o.event === 'change') return `변경 — ${partState(o.prevState).label} → ${partState(o.state).label}`;
  if (o.event === 'close') return `닫힘 — ${closeReasonText(o.closeReason)}`;
  return String(o.event || '—');
}
/** KPI 칸 — 열린 장애 수. DB 불가면 '—'(0 이 아니다). 보류 중인 것은 따로 말한다. */
export function faultKpi(counts) {
  const c = counts && typeof counts === 'object' ? counts : null;
  if (!c || c.unavailable) return { key: 'faults', label: '열린 장애(전이)', value: '—', accent: null, meta: c && c.unavailable ? '장애 DB 를 읽지 못함' : '' };
  const open = numOrNull(c.open); const held = numOrNull(c.held);
  const by = c.byState && typeof c.byState === 'object' ? c.byState : {};
  const fault = numOrNull(by.fault); const warn = numOrNull(by.warn);
  return {
    key: 'faults', label: '열린 장애(전이)', value: countText(open), accent: fault > 0 ? 'var(--red)' : warn > 0 ? 'var(--amber)' : null,
    meta: [fault != null ? `장애 ${countText(fault)}` : null, warn != null ? `주의 ${countText(warn)}` : null, held != null && held > 0 ? `보류 ${countText(held)}(판정 못 함)` : null].filter(Boolean).join(' · '),
  };
}
/** 마지막 판정 문장. */
export function faultScanNote(scan, settings, now = Date.now()) {
  const s = scan && typeof scan === 'object' ? scan : {};
  const st = settings && typeof settings === 'object' ? settings : {};
  const bits = [];
  if (s.at) bits.push(`마지막 판정 ${agoText(s.at, now)}${s.reason ? `(${s.reason})` : ''}`);
  else bits.push('이번 기동 뒤 아직 판정하지 않았습니다(수집이 들어오면 자동으로 돕니다)');
  if (s.error) bits.push(`마지막 판정 실패: ${String(s.error)}`);
  if (s.unavailable) bits.push('장애 DB 불가');
  if (s.at && s.devices != null) bits.push(`장비 ${countText(s.devices)}대 · 열림 ${countText(s.opened)} · 변경 ${countText(s.updated)} · 닫힘 ${countText(s.closed)} · 보류 ${countText(s.held)}`);
  if (s.notified && typeof s.notified === 'object') {
    const sent = numOrNull(s.notified.sent); const capped = numOrNull(s.notified.capped);
    if (sent != null) bits.push(`알림 ${countText(sent)}건${capped ? ` (상한으로 ${countText(capped)}건 미발송)` : ''}`);
  }
  bits.push(st.faultAlerts === true ? `알림 켬${st.faultAlertsClosed === false ? '(해소는 알리지 않음)' : ''}` : '알림 꺼짐(기록만 남깁니다 — 등록·설정에서 켤 수 있습니다)');
  return bits.join(' · ');
}
export const FAULT_INTRO = '전이만 기록합니다 — 부품 **장애·주의**, 관리상 켜 둔 포트의 **링크 down**, **BGP 피어 down** 이 생기거나 사라질 때만 남깁니다. '
  + '상태 미확인·빈 슬롯·읽지 못한 종류·수집 실패 장비는 **열지도 닫지도 않고 보류**합니다(못 읽은 것을 복구로 적지 않습니다). 판정은 중앙이 가진 최신값으로만 하며 장비·엣지 왕복이 없습니다.';

// ── v2.640 ② 진단 — 원문 표본 · 파서 시험 ───────────────────────────────────

/** 상태의 samples → 표 행(종류 라벨 순). */
export function sampleRows(samples) {
  const o = samples && typeof samples === 'object' ? samples : {};
  return Object.entries(o).filter(([, v]) => v && typeof v === 'object').map(([kind, v]) => ({
    kind, label: itemLabel(kind), path: String(v.path || ''), ok: v.ok === true, status: numOrNull(v.status), bytes: numOrNull(v.bytes), at: numOrNull(v.at),
    head: typeof v.head === 'string' ? v.head : '', reason: typeof v.reason === 'string' ? v.reason : '',
  })).sort((a, b) => a.label.localeCompare(b.label));
}
export const SAMPLE_NOTE = '원문 표본은 **그 CVP 에서 처음 성공한 응답(종류별 1건, 앞 4KB)** 이고 성공이 없으면 마지막 실패 응답입니다. 첫 실수집에서 후보 경로·필드명을 좁히는 근거입니다 — 관리자에게만 보이며 아래 ‘파서 시험’ 에 그대로 붙여넣어 볼 수 있습니다.';
export const PREVIEW_NOTE = 'CVP 응답 원문(JSON·NDJSON)을 붙여넣으면 **이 포탈의 파서가 무엇을 읽는지** 보여줍니다 — 네트워크 왕복·저장 없음. 인식한 필드가 없으면 실패이고, 그때 ‘응답에 있던 필드’ 가 곧 다음 후보의 근거입니다(1MB 이하 — 더 크면 앞부분만).';
/** 파서 시험 응답 → 요약 문장 + 표 열. */
export function previewSummary(p) {
  const o = p && typeof p === 'object' ? p : null;
  if (!o) return { ok: false, text: '응답을 읽지 못했습니다.' };
  if (o.ok === false) return { ok: false, text: `읽지 못함 — ${o.note || o.reason || '인식한 필드가 없습니다'}${Array.isArray(o.keys) && o.keys.length ? ` · 응답에 있던 필드: ${o.keys.slice(0, 20).join(', ')}` : ''}${numOrNull(o.badChunks) ? ` · JSON 조각 오류 ${o.badChunks}건` : ''}` };
  const bits = [`형식 ${o.format || '—'}`, `읽은 항목 ${countText(o.count)}`];
  if (numOrNull(o.entities) != null) bits.push(`개체 ${countText(o.entities)}`);
  if (numOrNull(o.truncated)) bits.push(`상한으로 ${countText(o.truncated)}개 잘림`);
  if (numOrNull(o.unrecognized)) bits.push(`인식 못 한 개체 ${countText(o.unrecognized)}`);
  if (numOrNull(o.dropped)) bits.push(`키 없이 버림 ${countText(o.dropped)}`);
  if (numOrNull(o.badChunks)) bits.push(`JSON 조각 오류 ${countText(o.badChunks)}건`);
  if (o.truncatedInput) bits.push('입력이 상한을 넘어 앞부분만 읽었습니다');
  return { ok: true, text: bits.join(' · ') };
}
/** 항목 배열의 열 이름(첫 50개 항목의 키 합집합 — 파서가 무엇을 채웠는지 그대로). */
export function previewColumns(items) {
  const cols = [];
  for (const it of Array.isArray(items) ? items.slice(0, 50) : []) if (it && typeof it === 'object') for (const k of Object.keys(it)) if (!cols.includes(k)) cols.push(k);
  return cols;
}
