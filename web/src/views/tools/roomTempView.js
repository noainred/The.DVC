import { histCutNote } from './serverTemp/board.js'; // v2.629 A6-07 — 잘린 기간 문구는 한 벌
/**
 * roomTempView.js — 법인 전산실 운영 온도 화면의 판정·서식(순수 · v2.534).
 *
 * 사용자 제공 시안(클로드 디자인 캔버스 '온도 시각화 10안' 의 적용안 `2a`)을 붙이면서,
 * 화면 로직을 여기로 모았다 — 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더를 볼 수 없으므로
 * 판정·문구는 순수 모듈에 두고 vitest 로 고정한다(`accessDeniedText.js`·`loadState.js` 관례).
 *
 * ★ 이 화면이 지키는 정직성 규칙(시안 문구와 같다):
 *  - 상태 판정은 **흡기 최고값**만 쓴다. 배기·CPU 는 장비·부하에 따라 정상 범위가 달라
 *    임계를 정하지 않고 **값과 '열 안에서의 상대 농도'** 로만 표현한다(v2.381 부터의 규약).
 *  - 흡기 데이터가 없는 법인은 `ok` 가 아니라 **판정 불가**다 — 초록으로 칠하면 거짓이다.
 *  - 수집이 없던 시간은 스파크라인에서 **선을 잇지 않는다**(이으면 그 시간도 값이 있던 것처럼 보인다).
 */

/** 정렬 옵션 — v2.534 에 ΔT 를 추가했다(시안 요구). */
export const SORTS = Object.freeze([
  ['inlet-desc', '흡기 높은순'],
  ['inlet-asc', '흡기 낮은순'],
  ['exhaust-desc', '배기 높은순'],
  ['exhaust-asc', '배기 낮은순'],
  ['cpu-desc', 'CPU 높은순'],
  ['cpu-asc', 'CPU 낮은순'],
  ['dt-desc', 'ΔT 높은순'],
  ['dt-asc', 'ΔT 낮은순'],
  ['name-asc', '법인명 A→Z'],
  ['name-desc', '법인명 Z→A'],
]);

/** 보기(시안 2a) — 세 시각화를 한 페이지에서 전환한다. */
export const VIEWS = Object.freeze([
  ['range', '범위 플롯'],
  ['matrix', '매트릭스'],
  ['board', '상황실 월보드'],
]);

/**
 * 정렬 — 온도는 그 종류의 **최고값** 기준, ΔT 는 평균 기준.
 * 값이 없는 법인(null)은 방향과 무관하게 **항상 뒤로** 보낸다(데이터 없는 행이 위로 올라와
 * 실제 현황을 가리지 않게 — v2.384 규약을 그대로 유지).
 */
export function sortGroups(groups, sort) {
  const [key, dir] = String(sort || 'inlet-desc').split('-');
  const sign = dir === 'asc' ? 1 : -1;
  const arr = [...(groups || [])];
  if (key === 'name') return arr.sort((a, b) => String(a.name).localeCompare(String(b.name)) * sign);
  const val = (g) => (key === 'dt' ? g?.deltaAvg : g?.[key]?.max);
  return arr.sort((a, b) => {
    const x = val(a); const y = val(b);
    if (x == null && y == null) return String(a.name).localeCompare(String(b.name));
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * sign || String(a.name).localeCompare(String(b.name));
  });
}

/**
 * 한 열(예: 배기 최고)의 최소·최대 — '열 안에서의 상대 농도' 의 기준.
 * ⚠ 임계가 아니다. 이 값으로 색을 정하는 것은 **비교** 이지 **판정** 이 아니다.
 */
export function columnStats(groups, pick) {
  let min = null; let max = null;
  for (const g of groups || []) {
    const v = pick(g);
    if (v == null || !Number.isFinite(Number(v))) continue;
    const n = Number(v);
    if (min == null || n < min) min = n;
    if (max == null || n > max) max = n;
  }
  return { min, max };
}

/**
 * 열 안 상대 농도 0~1. 값이 없으면 **null**(0 이 아니다 — 0 은 '가장 연함' 이라는 판정이 된다).
 * 열의 모든 값이 같으면 0.5(가운데) — 한 값만 진하게 칠하면 그것이 이상값처럼 보인다.
 */
export function heat(v, { min, max }) {
  if (v == null || !Number.isFinite(Number(v)) || min == null || max == null) return null;
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (Number(v) - min) / (max - min)));
}

/**
 * 월보드 타일 수치 — 큰 숫자는 **흡기 최고**(가장 보수적인 값)다.
 * `status` 가 없으면 `unknown` 이다 — 흡기 센서를 못 읽은 법인을 정상으로도 이상으로도 세지 않는다.
 */
export function tileData(g) {
  return {
    id: g?.id ?? '', name: g?.name ?? '—',
    status: g?.status || 'unknown',
    inletMax: g?.inlet?.max ?? null, inletAvg: g?.inlet?.avg ?? null,
    exMax: g?.exhaust?.max ?? null, cpuMax: g?.cpu?.max ?? null,
    dt: g?.deltaAvg ?? null,
    servers: g?.inlet?.servers ?? 0,
    missing: (g?.noSensorCount || 0) + (g?.staleCount || 0),
  };
}

/**
 * 월보드 상단 카운트. ⚠ **`unknown` 을 `ok` 로 흡수하지 않는다**(v2.523·v2.519 규약과 같다) —
 * '확인하지 못한 것' 을 '이상 없음' 으로 칠하는 것이 이 화면이 만들 수 있는 가장 위험한 거짓이다.
 */
export function boardCounts(groups) {
  const c = { hot: 0, warn: 0, ok: 0, cold: 0, unknown: 0 };
  for (const g of groups || []) {
    const s = g?.status;
    if (s === 'hot') c.hot += 1;
    else if (s === 'warn') c.warn += 1;
    else if (s === 'ok' || s === 'lowok') c.ok += 1;
    else if (s === 'cold') c.cold += 1;
    else c.unknown += 1;
  }
  return c;
}

/**
 * 스파크라인 path — **수집이 없던 구간은 선을 잇지 않는다**(끊어진 subpath 로 낸다).
 *
 * @param {Array<{ts:number, avg:number|null}>} points 시간 오름차순
 * @param {{w:number, h:number, gapMs?:number}} box gapMs 이상 벌어지면 끊는다(기본 2시간)
 * @returns {{d:string, lo:number, hi:number, n:number}|null} 점이 2개 미만이면 null
 */
export function sparkPath(points, { w = 120, h = 24, gapMs = 2 * 3_600_000 } = {}) {
  // ⚠ `v == null` 을 **먼저** 본다 — `Number(null) === 0` 이라 `Number.isFinite(Number(v))` 만
  //   보면 결측이 0℃ 로 둔갑한다(CLAUDE.md v2.525 규약. 이 파일의 첫 판이 실제로 그랬고
  //   `roomTempView.test.js` 의 'avg 가 null 인 점은 버린다' 가 잡아냈다).
  const pts = (points || []).filter((p) => p && p.avg != null && p.ts != null
    && Number.isFinite(Number(p.avg)) && Number.isFinite(Number(p.ts)));
  if (pts.length < 2) return null;
  let lo = Infinity; let hi = -Infinity; let t0 = Infinity; let t1 = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.avg); hi = Math.max(hi, p.avg);
    t0 = Math.min(t0, p.ts); t1 = Math.max(t1, p.ts);
  }
  const span = hi - lo || 1;
  const tspan = t1 - t0 || 1;
  const x = (ts) => ((ts - t0) / tspan) * w;
  const y = (v) => h - ((v - lo) / span) * h;
  let d = ''; let prevTs = null;
  for (const p of pts) {
    const cmd = prevTs != null && p.ts - prevTs <= gapMs ? 'L' : 'M';
    d += `${cmd}${x(p.ts).toFixed(1)},${y(p.avg).toFixed(1)} `;
    prevTs = p.ts;
  }
  return { d: d.trim(), lo, hi, n: pts.length };
}

/** 매트릭스 한 행의 수치 열 정의 — 화면과 PDF/정렬이 같은 순서를 쓰게 한다. */
export const MATRIX_COLS = Object.freeze([
  { key: 'inletMin', label: '흡기 최저', pick: (g) => g?.inlet?.min ?? null, kind: 'inlet' },
  { key: 'inletAvg', label: '흡기 평균', pick: (g) => g?.inlet?.avg ?? null, kind: 'inlet' },
  { key: 'inletMax', label: '흡기 최고', pick: (g) => g?.inlet?.max ?? null, kind: 'inlet' },
  { key: 'exAvg', label: '배기 평균', pick: (g) => g?.exhaust?.avg ?? null, kind: 'rel' },
  { key: 'exMax', label: '배기 최고', pick: (g) => g?.exhaust?.max ?? null, kind: 'rel' },
  { key: 'cpuAvg', label: 'CPU 평균', pick: (g) => g?.cpu?.avg ?? null, kind: 'rel' },
  { key: 'cpuMax', label: 'CPU 최고', pick: (g) => g?.cpu?.max ?? null, kind: 'rel' },
  { key: 'dt', label: 'ΔT 평균', pick: (g) => g?.deltaAvg ?? null, kind: 'rel' },
]);

/**
 * 매트릭스 셀 — 흡기 열은 **ASHRAE 상태색**, 나머지는 **열 내 상대 농도**.
 * 두 색 체계를 섞지 말 것: 상태색은 판정이고 농도는 비교다.
 *
 * @param {Array} groups 화면에 보이는 법인들(정렬·필터 적용 후 — 농도의 모집단이다)
 * @returns {Map<string,{min:number|null,max:number|null}>} 열 key → 통계
 */
export function matrixStats(groups) {
  const m = new Map();
  for (const c of MATRIX_COLS) m.set(c.key, c.kind === 'rel' ? columnStats(groups, c.pick) : { min: null, max: null });
  return m;
}

/**
 * 추이 모달 각주(v2.629 A6-07) — 서버 응답(idrac/roomTempSeries.js roomTempHistory)의 stepFilled·truncated·coveredSince.
 * roomtemp_* 는 dead-band 계열이라 1시간 미만 버킷은 직전 저장값을 이어 채운다(stepFilled 개) — 그 점을 실측처럼 두지 않는다.
 * 점 상한으로 잘렸으면 serverTemp/board.js histCutNote 로 말한다(두 화면이 같은 문구). 해당 없으면 빈 배열.
 */
export function trendNotes(d) {
  const out = [];
  const filled = Number(d?.stepFilled);
  if (Number.isFinite(filled) && filled > 0) out.push(`변화가 없던 ${filled.toLocaleString()}개 구간은 직전 값을 이어 그렸습니다(0.5℃ 미만 변화는 저장하지 않습니다).`);
  const cut = histCutNote(d);
  if (cut) out.push(cut);
  return out;
}

/*
 * v2.634 — '미갱신 서버' 가 **왜** 빠졌는지를 말한다(2026-09-28 사용자 신고 '측정 서버 0/980 · 미갱신 975').
 * 예전 카드는 '15분 이상 갱신 없음' 한 줄뿐이라 '센서가 고장났다' 와 '폴 한 주기가 15분보다 오래 걸린다' 를
 * 가를 수 없었다. 서버가 주는 값(staleMs·staleMsMax·pollCycle·totals.staleNewestAgeMs)만 쓴다 — 숫자를 박지 않는다.
 */
export function spanText(ms) {
  const n = ms == null || ms === '' ? NaN : Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))}초`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}분`;
  return `${Math.round((n / 3_600_000) * 10) / 10}시간`;
}

/** 미갱신 카드의 짧은 설명. */
export function staleCardMeta(data) {
  const base = spanText(data?.staleMs);
  const max = Number(data?.staleMsMax);
  const widened = Number.isFinite(max) && max > Number(data?.staleMs);
  const parts = [widened
    ? `경계 ${base}(폴 주기가 길어 최대 ${spanText(max)}까지 넓힘) 넘게 갱신 없음 — 집계 제외`
    : `${base ?? '—'} 이상 갱신 없음 — 집계 제외(동결값 방지)`];
  const newest = spanText(data?.totals?.staleNewestAgeMs);
  if (newest) parts.push(`빠진 것 중 가장 최근 표본 ${newest} 전`);
  return parts.join(' · ');
}

/**
 * 폴 주기·전량 제외 안내(배너 한 줄) — 없으면 null.
 * 원인을 단정하지 않는다: 측정 0대면 '폴러가 멈췄다' 와 '한 주기가 매우 오래 걸린다' 두 가능성을 함께 말한다.
 */
export function staleBannerText(data) {
  const t = data?.totals || {};
  const pc = data?.pollCycle || null;
  const itv = Number(pc?.intervalMs);
  const dur = Number(pc?.durationMs);
  const out = [];
  if (pc && Number.isFinite(dur) && Number.isFinite(itv) && itv > 0 && dur > 3 * itv) {
    const running = Number(pc.runningForMs);
    const widened = Number(data?.staleMsMax) > Number(data?.staleMs);
    // 넓힌 사실은 서버가 실제로 넓혔을 때만 말한다 — 전부 엣지 위임 서버(구버전 엣지)면 이 포탈의 주기로 넓히지 않는다.
    out.push(`이 포탈의 iDRAC 폴 한 주기가 ${spanText(dur)} 걸리고 있습니다(간격 ${spanText(itv)}${Number.isFinite(running) && running > 0 ? ` · 지금 주기 ${spanText(running)}째` : ''}) — 서버마다 표본이 그만큼 늦게 옵니다${widened ? `. 신선도 경계를 최대 ${spanText(data.staleMsMax)}까지 넓혔습니다.` : '.'}`);
  }
  if ((t.withData ?? 0) === 0 && (t.stale ?? 0) > 0) {
    const newest = spanText(t.staleNewestAgeMs);
    out.push(`측정 서버가 0대입니다 — 온도를 받은 서버 ${t.stale}대가 모두 경계를 넘었습니다${newest ? `(가장 최근 표본 ${newest} 전)` : ''}. iDRAC 폴러가 멈췄거나 한 주기가 경계보다 오래 걸리는 경우입니다 — 특수 기능 › 다빈치 서비스 점검의 ‘iDRAC 폴 주기’ 행과 수집 서버(엣지) 상태를 확인하세요.`);
  }
  return out.length ? out.join(' ') : null;
}
