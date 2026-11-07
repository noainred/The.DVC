/**
 * storageNodeLoad/nodeLoadText.js — 스토리지 장비 상세 › 노드 부하 추이(v2.926)의 판정·문구·좌표(순수 — React 없음, vitest 로 고정).
 *
 * 서버 `GET /tools/storage/devices/:id/node-load` 가 열(cols) 정렬 배열을 준다. 이 모듈은 그것을 **고르고 · 더하고 · 말하기만** 한다:
 *  · 못 읽은 값은 null 이고 '—' 로 쓴다(단위를 붙이지 않는다). 두 계열을 더할 때(In + Out) 하나라도 null 이면 null — 부분 합 금지.
 *  · 평균·순위는 읽은 표본만으로(분모에서 결측을 뺀다) — 0 으로 채워 평균을 끌어내리지 않는다.
 *  · 숫자(수집 주기·보존 기간·노드 상한)는 응답에서 읽는다. 문장에 박지 않는다.
 *  · 창 이동(이전 구간)은 전송 속도 화면의 순수 함수를 **그대로** 쓴다(xferSpeedText — 사본 금지).
 *  · 화면 문구에 백틱을 쓰지 않는다(BoldText 는 '**강조**' 만 해석한다).
 * 설계: docs/design/isilon-node-load/README.md
 */
import { numOrNull } from '../../../numOrNull.js';
import { bpsText } from '../storageNodeText.js';
import { clockText, maxBackOf, windowEndOf, windowLabel, windowRangeText, historyOldestOf } from '../xferSpeedText.js';

export { maxBackOf, windowEndOf, windowLabel, windowRangeText, historyOldestOf };

/** 기간 — 서버 nodeLoad.NODE_LOAD_RANGES 와 같은 키. 글자는 전송 속도 PERIODS 와 같다(windowLabel 이 그것으로 쓴다). */
export const RANGES = Object.freeze([
  { key: '24h', label: '24시간', days: 1 },
  { key: '7d', label: '7일', days: 7 },
  { key: '30d', label: '30일', days: 30 },
  { key: '90d', label: '90일', days: 90 },
]);
export const rangeOf = (key) => RANGES.find((r) => r.key === key) || RANGES[0];

/**
 * 보는 값(선택) — 묶음(group)은 서버 조회 단위, 선택은 그 안의 계열 또는 합.
 * 디스크 In/Out 을 쓰기/읽기로 부르는 것은 **실장비 미확인** 가정이다(수집기 isilonNodeLoad.js 머리말) — 괄호에 원래 이름을 남긴다.
 */
export const SELECTS = Object.freeze([
  { key: 'in', group: 'net', label: 'In', parts: ['in'], unit: 'bps' },
  { key: 'out', group: 'net', label: 'Out', parts: ['out'], unit: 'bps' },
  { key: 'net', group: 'net', label: 'In + Out', parts: ['in', 'out'], unit: 'bps' },
  { key: 'din', group: 'disk', label: '쓰기(In)', parts: ['din'], unit: 'B/s' },
  { key: 'dout', group: 'disk', label: '읽기(Out)', parts: ['dout'], unit: 'B/s' },
  { key: 'disk', group: 'disk', label: '쓰기 + 읽기', parts: ['din', 'dout'], unit: 'B/s' },
  // v2.932(2차 ②): 드라이브 busy %(노드 평균 — 표본 폴러의 summary/drive · isi statistics drive) · IOPS(드라이브 전송 in+out).
  { key: 'busy', group: 'disk', label: 'busy %', parts: ['busy'], unit: '%' },
  { key: 'iops', group: 'disk', label: 'IOPS', parts: ['iops'], unit: 'ops/s' },
  { key: 'cpu', group: 'cpu', label: 'CPU', parts: ['cpu'], unit: '%' },
  // v2.932(2차 ③): 프로토콜 묶음 — 노드 ops/s(전 프로토콜 합) · 지연(ops 가중 평균 ms — µs→ms 가정).
  { key: 'ops', group: 'proto', label: 'ops/s', parts: ['ops'], unit: 'ops/s' },
  { key: 'lat', group: 'proto', label: '지연(ms)', parts: ['lat'], unit: 'ms' },
]);
export const selectOf = (key) => SELECTS.find((s) => s.key === key) || SELECTS[0];
export const GROUP_TEXT = Object.freeze({ net: '네트워크', disk: '디스크', cpu: 'CPU', proto: '프로토콜' });
export const GROUP_ORDER = Object.freeze(['net', 'disk', 'cpu', 'proto']);
/** 묶음의 첫 선택(없는 묶음으로 옮길 때). */
export const GROUP_FIRST = Object.freeze({ net: 'in', disk: 'din', cpu: 'cpu', proto: 'ops' });
/** 묶음의 두 계열(차트 선) — 이름표. */
export const SERIES_TEXT = Object.freeze({ in: 'In', out: 'Out', din: '쓰기(In)', dout: '읽기(Out)', cpu: 'CPU', busy: 'busy %', iops: 'IOPS', ops: 'ops/s', lat: '지연' });
/** 계열색 — 기존 용량 추이(CapacityTrend)와 같은 두 색(검증기 통과: 어두운 패널 기준 CVD ΔE 26.8). 디스크도 같은 두 색(한 번에 한 묶음만 보인다). */
export const SERIES_COLOR = Object.freeze({ in: '#3987e5', out: '#d95926', din: '#3987e5', dout: '#d95926', cpu: '#3987e5', busy: '#3987e5', iops: '#d95926', ops: '#3987e5', lat: '#d95926' });
/** 차트에 함께 그리는 계열 — 처리량 선택은 In·Out 두 선을 함께(한 선만 고르면 반쪽), 그 밖은 고른 계열 하나. */
export function chartParts(sel) {
  const s = selectOf(sel);
  if (s.group === 'net') return ['in', 'out'];
  if (['din', 'dout', 'disk'].includes(s.key)) return ['din', 'dout'];
  return s.parts;
}
/** 겹쳐 보기 4색(검증기 통과 — 최악 인접 CVD ΔE 8.4). 색은 고른 순서의 칸(slot)에 붙는다 — 선택을 바꿔도 남은 노드 색은 그대로. */
export const OVERLAY_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500']);
export const OVERLAY_MAX = OVERLAY_COLORS.length;
/** 비교 구간 선 — 회색(계열색이 아니다 · 실선 · 얇게). */
export const BASELINE_COLOR = '#8b9bb4';
/** 히트맵 단일 색조 5단계(어두운 면에서 밝을수록 큼 — 검증기 단계 간격 확인). */
export const HEAT_RAMP = Object.freeze(['#184f95', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6']);

/**
 * 노드 스냅샷에서 묶음별로 값이 있는가 — 값이 없는 묶음은 버튼을 그리지 않는다('—' 만 늘어놓지 않는다).
 * v2.932: 표본 폴러가 켜진 장비(응답 sample.sampleEnabled)는 디스크·프로토콜 묶음을 연다 — busy·IOPS·ops·지연은 1시간 스냅샷에 없고 5분 표본에만 있다.
 */
export function groupsAvailable(list, { sampleEnabled = false } = {}) {
  const nodes = Array.isArray(list) ? list.filter((n) => n && typeof n === 'object') : [];
  const has = (f) => nodes.some((n) => numOrNull(n[f]) != null);
  const se = sampleEnabled === true;
  return { net: has('inBps') || has('outBps'), disk: has('diskInBytesPs') || has('diskOutBytesPs') || has('busyPct') || has('iops') || se,
    cpu: has('cpuPct'), proto: has('opsPs') || has('latencyMs') || se };
}

/** B/s → 사람 단위(10진 — KB/s·MB/s·GB/s). 값이 없으면 '—'. */
export function rateText(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} B/s`;
  const u = ['KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let x = n / 1000; let i = 0;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}
export function pctText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : `${n.toFixed(1)}%`;
}
/** ops/s — 정수 · 천 단위 쉼표. 값이 없으면 '—'. */
export function opsText(v) {
  const n = numOrNull(v);
  return n == null || n < 0 ? '—' : `${Math.round(n).toLocaleString()} ops/s`;
}
/** 지연(ms) — 소수 1자리. */
export function latText(v) {
  const n = numOrNull(v);
  return n == null || n < 0 ? '—' : `${n.toFixed(1)} ms`;
}
/** 단위별 표기. */
export function valueText(unit, v) {
  if (numOrNull(v) == null) return '—';
  if (unit === 'bps') return bpsText(Math.round(numOrNull(v)));
  if (unit === 'B/s') return rateText(v);
  if (unit === 'ops/s') return opsText(v);
  if (unit === 'ms') return latText(v);
  return pctText(v);
}

/** 두 배열을 칸마다 더한다 — 하나라도 null 이면 null(부분 합 금지). */
export function addSeries(a, b) {
  const n = Math.max(a?.length || 0, b?.length || 0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = numOrNull(a?.[i]); const y = numOrNull(b?.[i]);
    out[i] = x == null || y == null ? null : x + y;
  }
  return out;
}
/** 선택(합 포함)의 값 배열 — src 는 {in:[…], out:[…]} 꼴(노드의 v · mx, 또는 cluster). */
export function pickSeries(src, sel) {
  const s = selectOf(sel);
  if (!src) return [];
  if (s.parts.length === 1) return (src[s.parts[0]] || []).map((x) => numOrNull(x));
  return addSeries(src[s.parts[0]], src[s.parts[1]]);
}

/** 읽은 값만의 평균·최대·개수. 하나도 없으면 avg·peak null. */
export function statOf(arr) {
  let sum = 0; let n = 0; let peak = null; let missing = 0;
  for (const x of arr || []) {
    const v = numOrNull(x);
    if (v == null) { missing += 1; continue; }
    sum += v; n += 1; if (peak == null || v > peak) peak = v;
  }
  return { avg: n ? sum / n : null, peak, n, missing };
}

/**
 * 노드 순위(기간 평균 내림차순 · 같으면 번호순). 읽은 값이 없는 노드는 맨 뒤(평균 null — 0 으로 세지 않는다).
 * @returns {Array<{id:number, avg:number|null, peak:number|null, n:number, missing:number, w:number}>} w = 1위 대비 막대 % (0~100)
 */
export function rankNodes(resp, sel) {
  const rows = (resp?.nodes || []).map((nd) => ({ id: nd.id, ...statOf(pickSeries(nd.v, sel)) }));
  rows.sort((a, b) => (a.avg == null) - (b.avg == null) || (b.avg ?? 0) - (a.avg ?? 0) || a.id - b.id);
  const top = rows[0]?.avg || 0;
  return rows.map((r) => ({ ...r, w: r.avg != null && top > 0 ? Math.max(1, Math.round((r.avg / top) * 100)) : 0 }));
}

/** 히트맵 단계(0~4) — CPU 는 0~100% 절대 눈금, 처리량은 이 보기의 최대값 기준. 값 없음은 null. */
export function heatScaleMax(resp, sel) {
  if (selectOf(sel).unit === '%') return 100;
  let mx = 0;
  for (const nd of resp?.nodes || []) for (const v of pickSeries(nd.v, sel)) if (v != null && v > mx) mx = v;
  return mx;
}
export function heatBin(v, max) {
  const n = numOrNull(v); const m = numOrNull(max);
  if (n == null) return null;
  if (!(m > 0)) return 0;
  return Math.max(0, Math.min(HEAT_RAMP.length - 1, Math.floor((n / m) * HEAT_RAMP.length)));
}

/** 칸 이름(포탈 시각) — 원시·15분 버킷은 'MM-DD HH:mm', 4시간 버킷은 'MM-DD HH시', 일은 'MM-DD'. */
export function colText(ts, kind, bucketMs, offsetMin = 540) {
  const t = numOrNull(ts);
  if (t == null) return '—';
  if (kind === 'daily') return clockText(t, offsetMin).slice(0, 5);
  if (kind === 'bucket' && numOrNull(bucketMs) >= 3_600_000) return `${clockText(t, offsetMin).slice(0, 8)}시`;
  return clockText(t, offsetMin);
}
/** 칸 설명(무엇의 값인가) — '수집 1회(순간값)' · '4시간 평균' · '하루 평균'. */
export function colKindText(kind, bucketMs) {
  if (kind === 'daily') return '하루 평균';
  if (kind === 'bucket') {
    const m = Math.round((numOrNull(bucketMs) || 0) / 60_000);
    return m >= 60 ? `${Math.round(m / 60)}시간 평균` : `${m}분 평균`;
  }
  return '수집 1회(순간값)';
}
/** 머리줄 눈금 — 칸이 많으면 k 칸마다 하나(6개 남짓 — 400px 에서도 글자가 겹치지 않게). */
export function tickEvery(n) {
  return n <= 6 ? 1 : Math.ceil(n / 6);
}

/**
 * 긴 보기(7일·30일·90일)의 칸 → 그 날의 24시간 창 끝(다음 날 0시, 포탈 시각). 지금보다 뒤면 null(= 최신 창).
 */
export function drillEndOf(ts, offsetMin = 540, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null) return null;
  const off = offsetMin * 60_000;
  const end = Math.floor((t + off) / 86_400_000) * 86_400_000 + 86_400_000 - off;
  return end >= now ? null : end;
}
/**
 * 창 끝 시각(ms)을 스크롤 상태({back, anchor})로 — 전송 속도 jumpToDate 와 같은 모델(창 끝 = anchor − back × 기간).
 * 지금 이후(또는 형식 오류)는 최신({back:0, anchor:null}). maxBack 을 넘으면 가장 오래된 칸으로 자르고 clamped.
 */
export function scrollToEnd(end, { days, now = Date.now(), maxBack = Infinity } = {}) {
  const e = numOrNull(end); const span = (numOrNull(days) ?? 0) * 86_400_000;
  if (e == null || !(span > 0) || e >= now) return { back: 0, anchor: null };
  let back = Math.max(1, Math.ceil((now - e) / span));
  const anchor = e + back * span;
  const lim = Number.isFinite(maxBack) ? Math.max(0, Math.floor(maxBack)) : Infinity;
  if (back > lim) { back = lim; return lim ? { back, anchor, clamped: true } : { back: 0, anchor: null, clamped: true }; }
  return { back, anchor };
}
/** 'YYYY-MM-DDTHH:mm'(포탈 시각 — datetime-local 값) → ms. 형식 오류는 null. */
export function portalLocalToMs(s, offsetMin = 540) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - offsetMin * 60_000;
  return Number.isFinite(t) ? t : null;
}
/** ms → datetime-local 값(포탈 시각, 분 단위). */
export function msToPortalLocal(ts, offsetMin = 540) {
  const t = numOrNull(ts);
  if (t == null) return '';
  const d = new Date(t + offsetMin * 60_000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
/** 갈 수 있는 범위 문구 — 어느 표의 보존 기간인지 응답 값으로 말한다(숫자를 박지 않는다). */
export function rangeLimitText(resp, maxB) {
  const days = numOrNull(resp?.days) ?? 1;
  const raw = days <= (numOrNull(resp?.rawMaxDays) ?? 7);
  const keep = raw ? numOrNull(resp?.retention?.rawDays) : numOrNull(resp?.retention?.dailyDays);
  const src = raw ? '노드 부하 원시 보존' : '일 단위 요약 보존';
  return `갈 수 있는 범위 ${(Number(maxB) || 0) + 1}칸 — ${src}${keep != null ? ` ${keep}일` : ''}(스토리지 증가량 › ⚙ 저장 기간에서 바꿉니다)`;
}

/**
 * 비교 구간 값을 지금 칸에 맞춘다(차트 한 데이터 배열 — 툴팁이 같은 칸의 두 값을 함께 읽게).
 * 비교 칸 시각(이미 창 위치로 옮겨진 값)이 지금 칸에서 tol 안이면 그 칸의 값, 아니면 null(가장 가까운 하나 — 지어내지 않는다).
 */
export function alignBaseline(cols, baseCols, baseVals, tolMs) {
  const tol = Math.max(0, numOrNull(tolMs) ?? 0);
  const out = (cols || []).map(() => null);
  const bc = baseCols || []; const bv = baseVals || [];
  let j = 0;
  (cols || []).forEach((t, i) => {
    while (j + 1 < bc.length && Math.abs(bc[j + 1] - t) <= Math.abs(bc[j] - t)) j += 1;
    if (j < bc.length && Math.abs(bc[j] - t) <= tol) out[i] = numOrNull(bv[j]);
  });
  return out;
}

/** 칸마다 돌던 잡(잡 엔진) — 칸에 들어가는 잡 표본의 이름 합집합. 모르면(REST 장비) null. */
export function jobsByCol(resp) {
  const cols = resp?.cols || [];
  if (!resp?.jobsKnown) return null;
  const out = cols.map(() => null);
  for (const j of resp.jobs || []) {
    const t = numOrNull(j?.ts);
    if (t == null) continue;
    let i = -1;
    for (let k = cols.length - 1; k >= 0; k--) if (cols[k] <= t) { i = k; break; }
    if (i < 0) continue;
    const names = (j.running || []).map((x) => String(x?.job || '').replace(/\[\d+\]$/, '')).filter(Boolean);
    if (j.paused) names.push(`일시정지 ${j.paused}`);
    out[i] = [...new Set([...(out[i] || []), ...names])];
  }
  return out;
}

/**
 * 머리 타일 4개 — 클러스터 합계(창 끝) · 가장 바쁜/한가한 노드 · 비교 구간 대비.
 * 비교는 두 구간 모두 합계를 읽은 칸이 절반 이상일 때만(조금 읽은 쪽과 비교하면 거짓 증감이 된다).
 */
export function tilesOf(resp, sel) {
  const s = selectOf(sel);
  const cl = pickSeries(resp?.cluster, sel);
  let lastIdx = -1;
  for (let i = cl.length - 1; i >= 0; i--) if (cl[i] != null) { lastIdx = i; break; }
  const rank = rankNodes(resp, sel).filter((r) => r.avg != null);
  const mean = rank.length ? rank.reduce((a, r) => a + r.avg, 0) / rank.length : null;
  const busy = rank[0] || null; const idle = rank.length > 1 ? rank[rank.length - 1] : null;
  const a = statOf(cl); const b = statOf(pickSeries(resp?.baseline?.cluster, sel));
  const enough = (st, len) => len > 0 && st.n >= Math.ceil(len / 2);
  const cmp = enough(a, cl.length) && enough(b, (resp?.baseline?.cols || []).length) && b.avg > 0
    ? Math.round(((a.avg - b.avg) / b.avg) * 100) : null;
  return {
    clusterLast: lastIdx >= 0 ? cl[lastIdx] : null,
    clusterLastAt: lastIdx >= 0 ? resp.cols[lastIdx] : null,
    clusterKind: s.unit === '%' ? '노드 평균' : '노드 합',
    busy, idle, mean,
    busyRatio: busy && mean > 0 ? Math.round((busy.avg / mean) * 10) / 10 : null,
    spread: busy && idle && idle.avg > 0 ? Math.round((busy.avg / idle.avg) * 10) / 10 : null,
    compare: cmp, compareLabel: resp?.baseline?.label || '',
  };
}

/** 클러스터 합계를 비운 칸 수(부분 합 생략) — '비웠다' 는 사실을 숨기지 않는다. */
export function partialColsOf(resp, sel) {
  const cl = pickSeries(resp?.cluster, sel);
  const nodes = resp?.clusterNodes || [];
  let n = 0;
  cl.forEach((v, i) => { if (v == null && (nodes[i] || 0) > 0) n += 1; });
  return n;
}

/** 안내 문장들(상태) — 아는 것과 모르는 것을 나눠 말한다. */
export function notesOf(resp, { snapCount = null, listed = null, isEdge = false, sel = 'in' } = {}) {
  const out = [];
  if (!resp) return out;
  if (resp.db === false) {
    out.push({ tone: 'amber', text: '이 포탈 노드에서 저장소 DB(SQLite)를 열 수 없어 노드 부하를 저장하지 못합니다 — 최신값만 노드 표에 있습니다.' });
    return out;
  }
  const empty = !(resp.cols || []).length;
  if (empty) {
    out.push({ tone: 'muted', text: resp.past
      ? '이 구간에는 노드 부하 기록이 없습니다(보존 기간 밖이거나 그때 수집하지 않았습니다).'
      : `아직 이 장비의 노드 부하 기록이 없습니다 — 다음 수집부터 쌓입니다${isEdge ? '(엣지 장비는 중앙이 push 를 받은 시점부터)' : ''}. 최신값은 아래 노드 표에 있습니다.` });
  }
  const partial = partialColsOf(resp, sel);
  // CPU 는 노드 평균, 처리량은 노드 합 — 무엇을 비웠는지 그 이름으로 말한다(CPU 화면이 '합계' 라고 하지 않게).
  const avg = selectOf(sel).unit === '%';
  if (!empty && partial) out.push({ tone: 'muted', text: avg
    ? `클러스터 평균을 비운 칸 ${partial}개 — 그 칸에 값을 읽지 못한 노드가 있어 일부 노드의 평균을 전체 평균처럼 그리지 않았습니다.`
    : `클러스터 합계를 비운 칸 ${partial}개 — 그 칸에 값을 읽지 못한 노드가 있어 일부 노드의 합을 전체처럼 그리지 않았습니다.` });
  const c = numOrNull(snapCount); const l = numOrNull(listed);
  if (c != null && l != null && c > l) out.push({ tone: 'muted', text: `노드 ${c}대 중 ${l}대만 목록에 올라옵니다(목록 상한) — 나머지 ${c - l}대는 이력이 없고 합계는 ${l} 노드 합입니다.` });
  if (resp.truncated) out.push({ tone: 'muted', text: '조회 상한에 걸려 이 구간의 앞부분 일부를 읽지 못했습니다 — 기간을 줄여 보세요.' });
  if (resp.clamped) out.push({ tone: 'muted', text: '고른 시각이 지금보다 뒤라 최신 구간을 보여 줍니다.' });
  return out;
}

/** 소형 다중 · 스파크 — 값 배열을 SVG path 로(결측에서 선을 끊는다). */
export function sparkPath(arr, { w = 100, h = 24, max = null, pad = 2 } = {}) {
  const vals = (arr || []).map((x) => numOrNull(x));
  const n = vals.length;
  if (!n) return '';
  const m = numOrNull(max) ?? Math.max(0, ...vals.filter((v) => v != null));
  let d = ''; let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = m > 0 ? h - pad - (v / m) * (h - pad * 2) : h - pad;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/** 수집 주기 문구(응답 sampleMs) — '1시간' · '5분'. */
export function sampleText(ms) {
  const m = Math.round((numOrNull(ms) || 0) / 60_000);
  if (!m) return '—';
  return m % 60 === 0 ? `${m / 60}시간` : `${m}분`;
}
/** 출처 문구 — 노드 스냅샷의 nodeLoadProbe(객체가 아니거나 글자가 아니면 쓰지 않는다 — 엣지 입력). 표본 폴러가 켜졌으면 그 호출도 함께 말한다. */
export function sourceText(snap, group, { sampleEnabled = false } = {}) {
  const ex = snap?.extra || {};
  const ssh = ex.collectMethod === 'ssh';
  if (group === 'proto') return ssh ? '‘isi statistics protocol/client’(표본)' : 'REST statistics/summary/protocol·client(표본)';
  if (group === 'net') return (ssh ? '‘isi status’ 처리량 열' : 'REST node.net.ext.bytes.*.rate(B/s × 8)') + (sampleEnabled ? ' + 표본' : '');
  const p = ex.nodeLoadProbe;
  const src = p && typeof p === 'object' && typeof p.source === 'string' ? p.source.slice(0, 120) : '';
  if (group === 'disk' && sampleEnabled) return `${src || '—'} · busy·IOPS 는 ${ssh ? '‘isi statistics drive’' : 'summary/drive'}(표본)`;
  return src || '—';
}

/* ── v2.932(2차 ③) 노드 드로어 · 클라이언트 분포 ───────────────────────────────────────────── */
/** 비중 %(0~100) 표기. */
export function shareText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : `${Math.round(n)}%`;
}
/** 이름 칸 — 장비가 준 이름 · 포탈 인벤토리(VM·호스트) · 못 찾음(IP 만). 출처는 괄호로 짧게. */
export function clientNameText(row) {
  const name = typeof row?.name === 'string' ? row.name.trim() : '';
  if (!name) return { text: '—', hint: '포탈 인벤토리(VM IP · 호스트 관리 IP)에 없는 주소 — 역방향 DNS 는 하지 않습니다' };
  const src = row.nameSource === 'vm' ? 'VM' : row.nameSource === 'host' ? '호스트' : row.nameSource === 'device' ? '장비 보고' : '';
  return { text: name, hint: `${src ? `${src} 이름` : '이름'}${row.ambiguous ? ' · 같은 IP 를 가진 객체가 둘 이상 — 첫 것만 보입니다' : ''}` };
}
/** '지금' 열의 표본이 늦었는가 — 마지막 표본이 표본 주기 ×3(응답 lateMs)을 넘으면 노란 머리 문구. 표본이 없으면 null. */
export function lateNote(resp, now = Date.now()) {
  const ts = numOrNull(resp?.latest?.ts);
  if (ts == null) return null;
  const late = numOrNull(resp?.lateMs) ?? 0;
  const age = Math.max(0, now - ts);
  if (!(late > 0) || age <= late) return null;
  const m = Math.round(age / 60_000);
  return { tone: 'amber', text: `마지막 표본 ${m >= 120 ? `${Math.round(m / 60)}시간` : `${m}분`} 전 — 그 뒤 표본이 오지 않았습니다(표본 주기 ${sampleText(resp?.sample?.sampleMs)} 기준). 엣지 장비는 push 지연까지 더해 봅니다.` };
}
/** 드로어 안내문 — 아는 것과 모르는 것을 나눠 말한다. */
export function drawerNotes(resp) {
  const out = [];
  if (!resp) return out;
  if (resp.db === false) { out.push({ tone: 'amber', text: '이 포탈 노드에서 저장소 DB(SQLite)를 열 수 없어 클라이언트 표본을 저장하지 못합니다.' }); return out; }
  if (resp.sample && resp.sample.sampleEnabled === false) out.push({ tone: 'amber', text: '이 장비는 표본 수집이 꺼져 있습니다(장비 편집 › 노드 부하 표본 수집) — 클라이언트·프로토콜은 표본에서만 읽으므로 켜기 전 구간은 비어 있습니다.' });
  const n = (resp.clients || []).length;
  if (!n) out.push({ tone: 'muted', text: resp.past
    ? '이 구간에는 이 노드의 클라이언트 기록이 없습니다(보존 기간 밖이거나 그때 표본이 없었습니다).'
    : '최근 작업한 클라이언트가 없습니다 — 통계에는 그 순간 요청을 보낸 클라이언트만 잡히고, 마운트만 하고 쉬는 클라이언트는 나오지 않습니다(‘연결 없음’ 이 아닙니다).' });
  const u = numOrNull(resp.names?.unknown);
  if (u > 0) out.push({ tone: 'muted', text: `이름을 찾지 못한 주소 ${u}개 — 포탈 인벤토리(VM IP · 호스트 이름/관리 IP · IP 대장)에 없습니다. 역방향 DNS 는 하지 않습니다.` });
  if (resp.clamped) out.push({ tone: 'muted', text: '고른 시각이 지금보다 뒤라 최신 구간을 보여 줍니다.' });
  return out;
}
/** 노드별 '지금' 값을 클라이언트+프로토콜 키로 — 창 표에 '지금' 열을 붙일 때 쓴다. */
export function latestMapOf(resp) {
  const m = new Map();
  for (const r of resp?.latest?.rows || []) m.set(`${r.client}|${r.proto || ''}`, r);
  return m;
}
/** 프로토콜 요약(노드 하나) — ops 내림차순 · 창 평균·최대. */
export function protoSummaryOf(rows) {
  return (rows || []).map((r) => ({ proto: r.proto || '—', ops: numOrNull(r.ops), opsMax: numOrNull(r.opsMax), lat: numOrNull(r.lat), latMax: numOrNull(r.latMax), samples: numOrNull(r.samples) ?? 0 }))
    .sort((a, b) => (b.ops ?? -1) - (a.ops ?? -1));
}

/** 분포 보기 — 노드 막대(합계 ops 대비 %) · 쏠림 표지. 노드 집합은 서버 skew.nodes(ops 0 노드 포함). */
export function skewBarsOf(resp) {
  const nodes = Array.isArray(resp?.nodes) ? resp.nodes : [];
  const max = Math.max(0, ...nodes.map((n) => numOrNull(n.total) ?? 0));
  return nodes.map((n) => { const t = numOrNull(n.total) ?? 0; return { id: n.id, total: t, ratio: numOrNull(n.ratio), skew: n.skew === true, w: max > 0 && t > 0 ? Math.max(1, Math.round((t / max) * 100)) : 0 }; });
}
/** 재배치 후보 한 줄. */
export function candidateText(c) {
  const who = (typeof c?.name === 'string' && c.name.trim()) ? `${c.name.trim()} (${c.client})` : String(c?.client || '—');
  return `${who}${c?.proto ? ` · ${c.proto}` : ''} — 노드 ${c?.from} → 노드 ${c?.to} · ${opsText(c?.ops)} · 옮긴 뒤 노드 ${c?.from} ${opsText(c?.fromAfter)} / 노드 ${c?.to} ${opsText(c?.toAfter)}`;
}
/** 분포 안내문. */
export function distNotes(resp) {
  const out = [];
  if (!resp) return out;
  if (resp.db === false) { out.push({ tone: 'amber', text: '이 포탈 노드에서 저장소 DB(SQLite)를 열 수 없어 클라이언트 표본이 없습니다.' }); return out; }
  if (resp.sample && resp.sample.sampleEnabled === false) out.push({ tone: 'amber', text: '이 장비는 표본 수집이 꺼져 있습니다(장비 편집 › 노드 부하 표본 수집) — 분포는 표본에서만 계산합니다.' });
  const nodes = Array.isArray(resp.nodes) ? resp.nodes : [];
  const skewed = nodes.filter((n) => n.skew === true);
  const f = numOrNull(resp.thresholds?.skewFactor); const fs = numOrNull(resp.thresholds?.fixedShare);
  if (!(resp.clients || []).length) out.push({ tone: 'muted', text: resp.past ? '이 구간에는 클라이언트 기록이 없습니다.' : '아직 이 장비의 클라이언트 표본이 없습니다 — 표본 폴러가 돌기 시작하면 쌓입니다.' });
  else if (!skewed.length) out.push({ tone: 'muted', text: `쏠린 노드가 없습니다 — 모든 노드의 ops 합이 노드 평균의 ${f ?? '—'}배 미만입니다.` });
  else if (!(resp.candidates || []).length) out.push({ tone: 'muted', text: `쏠린 노드 ${skewed.map((n) => n.id).join(', ')} 에 ‘고정’ 클라이언트(창 ops 의 ${fs != null ? Math.round(fs * 100) : '—'}% 이상을 한 노드에 보낸 클라이언트)가 없어 후보를 내지 못했습니다 — 여러 노드에 고르게 흩어진 클라이언트는 옮겨도 쏠림이 줄지 않습니다.` });
  const u = numOrNull(resp.names?.unknown);
  if (u > 0) out.push({ tone: 'muted', text: `이름을 찾지 못한 주소 ${u}개 — 포탈 인벤토리에 없는 주소입니다(역방향 DNS 없음).` });
  if (typeof resp.note === 'string' && resp.note) out.push({ tone: 'muted', text: resp.note });
  return out;
}
/** 분포 CSV(클라이언트 × 노드 비중 %) — 쉼표·따옴표·줄바꿈은 따옴표로 감싼다. */
export function distCsv(resp) {
  const nodes = (Array.isArray(resp?.nodes) ? resp.nodes : []).map((n) => n.id);
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['client', 'name', 'proto', 'total_ops', 'top_node', 'top_share_pct', 'fixed', ...nodes.map((n) => `node_${n}_pct`)];
  const lines = [head.join(',')];
  for (const c of resp?.clients || []) {
    lines.push([c.client, c.name || '', c.proto || '', Math.round(numOrNull(c.total) ?? 0), c.top ?? '', c.topShare ?? '', c.fixed ? 'Y' : 'N', ...nodes.map((n) => (c.share?.[n] != null ? c.share[n] : ''))].map(q).join(','));
  }
  return `${lines.join('\n')}\n`;
}
