/**
 * sanStorageText.js — 'SAN 스토리지 성능'(도구 san-storage · v2.948 · 설계 docs/design/san-storage-perf) 화면의 **순수 계산 · 문구**.
 * 웹 테스트가 node 환경이라 여기서 고정한다. 판정 코어는 서버(storageList · storagePerfCheck)에 있고, 여기는 받은 값을 **그리고 읽기 좋게** 만들 뿐이다.
 *
 * 정직 규칙: 값이 없으면 '—'(0 · 단위 금지) · 결측 칸은 선을 끊는다(연결하지 않는다) · 주기 · 상한 숫자는 API 값에서 만든다 · 추정은 추정이라 적는다.
 */
import { numOrNull } from '../../numOrNull.js';

export const TABS = Object.freeze([['list', '현황'], ['check', '성능 점검'], ['mapping', '분류 · 매핑']]);
export const RANGES = Object.freeze([
  { k: '1h', label: '실시간 1시간', hours: 1, live: true },
  { k: '24h', label: '24시간', hours: 24 },
  { k: '7d', label: '7일', hours: 168 },
  { k: '30d', label: '30일', hours: 720 },
  { k: '90d', label: '90일', hours: 2160 },
  { k: '1y', label: '1년', hours: 8760 },
]);
export const rangeOf = (k) => RANGES.find((r) => r.k === k) || RANGES[1];
export const GROUPINGS = Object.freeze([['total', '합계'], ['director', '디렉터별'], ['fabric', '팹 A · B'], ['port', '포트별']]);
export const MODES = Object.freeze([['avg', '평균'], ['peak', '피크']]);
/** 서버 `hours` 상한(rangeParams — 90일). 그 위(1년)는 from/to(최대 366일)로 묻는다. */
export const HOURS_MAX = 24 * 90;
export const VIZ = Object.freeze(['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)']);
export const OTHER_COLOR = 'var(--text-dim)';
export const vizColor = (i) => (i < VIZ.length ? VIZ[i] : OTHER_COLOR);
export const DAYS_KO = Object.freeze(['월', '화', '수', '목', '금', '토', '일']);

/** 조회 파라미터 — back 은 '창 몇 개 전'(◀ 이전). 1년 · 과거 창은 from/to 로. */
export function rangeQuery(rangeK, { now = Date.now(), back = 0 } = {}) {
  const r = rangeOf(rangeK);
  const span = r.hours * 3_600_000;
  if (back <= 0 && r.hours <= HOURS_MAX) return { hours: r.hours };
  const to = now - back * span;
  return { from: to - span, to };
}
export function windowLabel(rangeK, back) {
  const r = rangeOf(rangeK);
  return back <= 0 ? `최신 · ${r.label}` : `${r.label} 창 ${back}개 전`;
}

export function gbps(bytesPerSec) {
  const n = numOrNull(bytesPerSec);
  return n == null ? null : (n * 8) / 1e9;
}
/** 바이트/초 → 'Gb/s' 문구(값 없음 '—'). 화면 전체가 같은 단위 표기(Gb/s · Mb/s)를 쓴다. */
export function rateText(bytesPerSec) {
  const n = numOrNull(bytesPerSec);
  if (n == null) return '—';
  const g = (n * 8) / 1e9;
  if (g >= 1) return `${g.toFixed(g >= 100 ? 0 : 1)} Gb/s`;
  const m = (n * 8) / 1e6;
  if (m >= 1) return `${m.toFixed(m >= 100 ? 0 : 1)} Mb/s`;
  return `${Math.round(n * 8)} b/s`;
}
export function pctText(p, digits = 1) {
  const n = numOrNull(p);
  return n == null ? '—' : `${Number(n).toFixed(digits)}%`;
}
/** 7일 대비 — null 은 '—'(비교 불가 — 사유는 deltaNote). */
export function deltaOf(d) {
  const n = numOrNull(d);
  if (n == null) return { text: '—', tone: 'none' };
  if (Math.abs(n) < 1) return { text: '— 0%', tone: 'flat' };
  return n > 0 ? { text: `▲ ${n}%`, tone: 'up' } : { text: `▼ ${-n}%`, tone: 'dn' };
}
export function deltaNote(row, minPrevHours) {
  if (row?.delta7d != null) return `지난 7일 하루 평균 ${rateText(row.prevAvg)} 대비`;
  if (row?.avg24 == null) return '24시간 평균이 없어 비교하지 않음';
  if ((row?.prevHours || 0) < (minPrevHours || 6)) return `비교 구간에 값이 ${row?.prevHours || 0}시간뿐(최소 ${minPrevHours || 6}시간)`;
  return '비교 불가';
}
/** 하루 환산 전송량(TB) — 평균 바이트/초 × 86,400. 모르면 null. */
export function dayTB(avgBytesPerSec) {
  const n = numOrNull(avgBytesPerSec);
  return n == null ? null : (n * 86_400) / 1e12;
}

export const STATE_TONE = Object.freeze({ ok: 'ok', stale: 'warn', 'edge-missing': 'crit', 'no-sample': 'gray', 'partial-only': 'gray' });
/** 상태 배지 — 서버 코드(state) · 문구(stateText)를 그대로 쓰고 톤만 고른다. 편중은 따로 배지. */
export function stateTag(row) {
  const code = row?.state || 'ok';
  return { tone: STATE_TONE[code] || 'gray', text: code === 'ok' ? '정상' : (row?.stateText || code), code };
}
export function imbalanceTag(row) {
  if (!row?.imbalance) return null;
  return { tone: 'warn', text: `편중 · ${row.imbalance.group} ${row.imbalance.ratio}×` };
}

/** '실시간' 알약 — 마지막 표본 · 주기(API 값) · 화면 갱신 주기. 숫자를 박지 않는다. */
export function liveText({ lastSampleAt, intervalMs, pollMs, now = Date.now() } = {}) {
  const parts = [];
  const last = numOrNull(lastSampleAt);
  parts.push(last == null ? '마지막 표본 없음' : `마지막 표본 ${agoShort(now - last)}`);
  const iv = intervalText(intervalMs);
  if (iv) parts.push(`수집 주기 ${iv}(설정값)`);
  const pm = intervalText(pollMs);
  if (pm) parts.push(`${pm}마다 다시 읽음`);
  return parts.join(' · ');
}
export function intervalText(ms) {
  const n = numOrNull(ms);
  if (n == null || n <= 0) return '';
  if (n % 3_600_000 === 0) return `${n / 3_600_000}시간`;
  if (n >= 60_000) return `${Math.round(n / 60_000)}분`;
  return `${Math.round(n / 1000)}초`;
}
export function agoShort(ms) {
  const n = numOrNull(ms);
  if (n == null) return '—';
  if (n < 60_000) return '방금';
  if (n < 3_600_000) return `${Math.round(n / 60_000)}분 전`;
  if (n < 86_400_000) return `${Math.round(n / 3_600_000)}시간 전`;
  return `${Math.round(n / 86_400_000)}일 전`;
}
export function clockText(ts) {
  const n = numOrNull(ts);
  if (n == null) return '—';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function dateClockText(ts) {
  const n = numOrNull(ts);
  if (n == null) return '—';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()} ${clockText(n)}`;
}

/** 현황 KPI 5 — 지금 합계(트래픽 카드와 같은 함수의 값) · 회선 사용률 · 어레이 수 · 편중 · 측정 없음/미보고. */
export function kpisOf(data) {
  const t = data?.totals || {};
  const nowB = numOrNull(t.nowBps);
  const avgB = numOrNull(t.avgBps);
  const diff = nowB != null && avgB ? Math.round(((nowB - avgB) / avgB) * 100) : null;
  const util = nowB != null && t.speedSumBps ? (nowB / t.speedSumBps) * 100 : null;
  const tb = dayTB(avgB);
  const counts = data?.counts || {};
  return [
    { k: 'now', label: '지금 합계 처리량', sub: '어레이 포트만', value: nowB == null ? '—' : gbps(nowB).toFixed(1), unit: nowB == null ? '' : 'Gb/s', tone: 'mint',
      meta: nowB == null ? '팹 A/B 표본이 다 모인 칸이 아직 없습니다 — 0 이 아닙니다' : `1시간 평균 ${rateText(avgB)}${diff != null ? ` 보다 ${diff >= 0 ? `${diff}% 높음` : `${-diff}% 낮음`}` : ''}${tb != null ? ` · 하루 환산 약 ${tb >= 10 ? tb.toFixed(0) : tb.toFixed(1)} TB` : ''}` },
    { k: 'util', label: '회선 사용률(합)', value: util == null ? '—' : util.toFixed(1), unit: util == null ? '' : '%', tone: '',
      meta: t.speedSumBps ? `분모 = 어레이 포트 속도 합 ${rateText(t.speedSumBps)}${t.unknownSpeedPorts ? ` · 속도 모르는 포트 ${t.unknownSpeedPorts}개 제외` : ''}` : '포트 속도를 아직 모릅니다' },
    { k: 'arrays', label: '스토리지 어레이', value: String(t.arrays ?? 0), unit: '대', tone: '',
      meta: `호스트(HBA) ${counts.host ?? 0} · 미확인 ${counts.unknown ?? 0} · 법인 ${(data?.allDatacenters || []).length}` },
    { k: 'imbalance', label: '디렉터 · 컨트롤러 편중', value: String(t.imbalance ?? 0), unit: '건', tone: (t.imbalance || 0) > 0 ? 'warn' : '',
      meta: data?.imbalanceRule ? `한 디렉터가 어레이 평균의 ${data.imbalanceRule.ratio}배 이상(24시간 평균 · 포트 사용량 탭과 같은 기준)` : '' },
    { k: 'unmeasured', label: '측정 없음 · 미보고', value: String((t.unmeasured ?? 0) + (data?.edgeMissing ?? 0)), unit: '대', tone: ((t.unmeasured || 0) + (data?.edgeMissing || 0)) > 0 ? 'bad' : '',
      meta: `엣지 미보고 ${data?.edgeMissing ?? 0} · 측정 없음 ${t.unmeasured ?? 0} — 합계 · 사용률에 넣지 않았습니다` },
  ];
}

/** 목록 거르기 · 정렬(순수). 모르는 값은 방향과 무관하게 뒤로. */
export function filterRows(rows = [], { dc = '', vendor = '', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return rows.filter((r) => (!dc || String(r.datacenterId ?? '') === dc)
    && (!vendor || (r.vendor || 'other') === vendor)
    && (!needle || [r.name, r.key, r.serial, r.datacenterName, ...(r.switches || []).map((s) => s.name)].some((v) => String(v || '').toLowerCase().includes(needle))));
}
export const SORTS = Object.freeze([['now', '지금 처리량'], ['util', '회선 사용률'], ['delta', '24시간 대비'], ['imbalance', '편중'], ['name', '이름']]);
export function sortRowsBy(rows = [], key = 'now') {
  const get = {
    now: (r) => numOrNull(r.now?.bps), util: (r) => numOrNull(r.utilPct), delta: (r) => numOrNull(r.delta7d),
    imbalance: (r) => (r.imbalance ? r.imbalance.ratio : null), name: (r) => null,
  }[key] || (() => null);
  const desc = key !== 'name';
  return [...rows].sort((a, b) => {
    const va = get(a); const vb = get(b);
    if (va == null && vb == null) return String(a.name || a.key).localeCompare(String(b.name || b.key));
    if (va == null) return 1;
    if (vb == null) return -1;
    return desc ? vb - va : va - vb;
  });
}

/* ── 차트(순수 기하) ─────────────────────────────────────────────────────────────── */
export function niceMax(v) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  const m = n / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
/** 스파크라인 — 결측은 선을 끊는다(조각 배열). 값은 바이트/초 · 세로는 0~최대. */
export function sparkSegments(values = [], w = 120, h = 26) {
  const n = values.length;
  const vals = values.filter((v) => v != null);
  if (!vals.length) return [];
  const max = Math.max(...vals) || 1;
  const x = (i) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v) => h - 2 - (v / max) * (h - 4);
  const segs = []; let cur = [];
  for (let i = 0; i < n; i++) {
    if (values[i] == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push(`${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`);
  }
  if (cur.length) segs.push(cur);
  return segs.map((s) => s.join(' '));
}
/**
 * 쌓기 면적 차트 모델. seriesList: [{ key, label, color, values[] }](바이트/초 — Gb/s 로 그린다). 어느 시리즈든 null 인 칸은 전체를 끊고 gaps 에 번호를 둔다.
 */
export function stackModel(buckets = [], seriesList = [], { w = 1140, h = 220, padL = 60, padR = 20, padT = 10, padB = 30, yMax = null } = {}) {
  const n = buckets.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL - padR));
  const tops = seriesList.map(() => new Array(n).fill(null));
  let top = 0; const gaps = [];
  for (let i = 0; i < n; i++) {
    let acc = 0; let broken = false;
    for (let s = 0; s < seriesList.length; s++) {
      const v = seriesList[s].values?.[i];
      if (v == null) { broken = true; break; }
      acc += gbps(v); tops[s][i] = acc;
    }
    if (broken) { for (const t of tops) t[i] = null; gaps.push(i); } else if (acc > top) top = acc;
  }
  const ymax = yMax ?? niceMax(top);
  const y = (v) => padT + (h - padT - padB) * (1 - (ymax ? v / ymax : 0));
  const areas = seriesList.map((s, si) => {
    const lo = si === 0 ? null : tops[si - 1]; const hi = tops[si];
    const segs = []; let cur = [];
    for (let i = 0; i < n; i++) { if (hi[i] == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(i); }
    if (cur.length) segs.push(cur);
    const d = segs.map((seg) => {
      const topLine = seg.map((i) => `${x(i).toFixed(1)},${y(hi[i]).toFixed(1)}`).join(' L');
      const botLine = [...seg].reverse().map((i) => `${x(i).toFixed(1)},${y(lo ? lo[i] : 0).toFixed(1)}`).join(' L');
      return `M${topLine} L${botLine} Z`;
    }).join(' ');
    return { key: s.key, label: s.label, color: s.color, d };
  });
  return { areas, x, y, yMax: ymax, gaps, w, h, padL, padR, padT, padB, n };
}
/** 가로축 눈금 — count 개, 창 길이에 따라 HH:mm 또는 M/D. */
export function tickLabels(buckets = [], count = 6) {
  const n = buckets.length;
  if (!n) return [];
  const span = buckets[n - 1] - buckets[0];
  const long = span > 36 * 3_600_000;
  const out = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k / (count - 1)) * (n - 1));
    const d = new Date(buckets[i]);
    out.push({ i, label: long ? `${d.getMonth() + 1}/${d.getDate()}` : clockText(buckets[i]) });
  }
  return out;
}
/** 시계열 요약 — 결측은 분모에서 뺀다. now 는 마지막 값이 한계(carryMs + 칸 폭) 안일 때만. */
export function seriesStats(values = [], peaks = [], buckets = [], { until = null, carryMs = 0, bucketMs = 0 } = {}) {
  let last = -1; let max = null; let maxTs = null; let sum = 0; let cnt = 0; let peakMax = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    last = i; sum += v; cnt++;
    if (max == null || v > max) { max = v; maxTs = buckets[i] ?? null; }
    const p = peaks?.[i]; if (p != null && (peakMax == null || p > peakMax)) peakMax = p;
  }
  const u = numOrNull(until) ?? (buckets.length ? buckets[buckets.length - 1] : null);
  const stale = last >= 0 && u != null && u - buckets[last] > (carryMs || 0) + (bucketMs || 0);
  return { now: last >= 0 && !stale ? values[last] : null, nowTs: last >= 0 ? buckets[last] : null, stale, avg: cnt ? sum / cnt : null, max, maxTs, peakMax, measured: cnt, total: values.length };
}
/** 요일 × 시간 접기(포탈 하루 — offsetMin · 서버 값). 빈 칸은 평균에서 뺀다. */
export function foldHeatmap(buckets = [], values = [], offsetMin = 540) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, n: 0, avg: null })));
  let max = null;
  for (let i = 0; i < buckets.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const local = new Date(buckets[i] + offsetMin * 60_000);
    const day = (local.getUTCDay() + 6) % 7;   // 월=0
    const hour = local.getUTCHours();
    const c = cells[day][hour]; c.sum += v; c.n++;
  }
  for (const row of cells) for (const c of row) { c.avg = c.n ? c.sum / c.n : null; if (c.avg != null && (max == null || c.avg > max)) max = c.avg; }
  const busiest = (() => { let best = null; for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) { const c = cells[d][h]; if (c.avg != null && (!best || c.avg > best.avg)) best = { day: d, hour: h, avg: c.avg }; } return best; })();
  return { cells, max, busiest, days: DAYS_KO };
}
/** 시리즈를 색 4개로 접는다 — 평균 큰 순 4개 + 나머지는 '그 밖'(합). 색을 늘리지 않는다(dataviz 규칙). */
export function foldSeries(seriesList = [], n = VIZ.length) {
  const avg = (vals) => { const v = (vals || []).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : -1; };
  const sorted = [...seriesList].sort((a, b) => avg(b.values) - avg(a.values));
  if (sorted.length <= n) return sorted.map((s, i) => ({ ...s, color: vizColor(i) }));
  const head = sorted.slice(0, n).map((s, i) => ({ ...s, color: vizColor(i) }));
  const rest = sorted.slice(n);
  const len = rest[0]?.values?.length || 0;
  const values = new Array(len).fill(null);
  for (let i = 0; i < len; i++) { let acc = null; for (const s of rest) { const v = s.values?.[i]; if (v != null) acc = (acc ?? 0) + v; } values[i] = acc; }
  return [...head, { key: '__other', label: `그 밖 ${rest.length}개`, color: OTHER_COLOR, values, folded: rest.length }];
}
/** CSV — 시각 · 합계 · 묶음별(Gb/s). 결측은 빈 칸. */
export function csvText(buckets = [], total = [], groups = []) {
  const head = ['시각', '합계(Gb/s)', ...groups.map((g) => `${g.label}(Gb/s)`)];
  const g = (v) => (v == null ? '' : gbps(v).toFixed(3));
  const lines = [head.join(',')];
  for (let i = 0; i < buckets.length; i++) lines.push([new Date(buckets[i]).toISOString(), g(total[i]), ...groups.map((s) => g(s.values?.[i]))].map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','));
  return lines.join('\r\n') + '\r\n';
}
export function csvFileName(key, rangeK, endMs = Date.now()) {
  const safe = String(key || 'array').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const d = new Date(endMs);
  return `san-storage_${safe}_${rangeK}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
}

/* ── 점검 ─────────────────────────────────────────────────────────────────────── */
export const CHECK_MARK = Object.freeze({
  ok: { sym: '●', cls: 'ok', label: '정상' }, warn: { sym: '▲', cls: 'warn', label: '주의' }, bad: { sym: '✕', cls: 'bad', label: '이상' },
  unknown: { sym: '?', cls: 'unk', label: '확인 불가' }, na: { sym: '—', cls: 'na', label: '해당 없음' },
});
export function overallText(r) {
  if (!r) return '—';
  if (r.overall === 'ok') return r.uncheckedCount > 0 ? '정상(일부 미확인)' : '정상';
  return CHECK_MARK[r.overall]?.label || r.overall;
}
export function thresholdText(item, value) {
  if (!item) return '';
  if (value == null) return '비움(판정 안 함)';
  return `${value}${item.unit}`;
}

/** 표 보조줄의 짧은 벤더 표기 — 긴 표기(PowerMax · VMAX)는 title · 상세 머리에. 모르는 벤더는 서버 표기(vendorLabel)를 그대로. */
export const VENDOR_SHORT = Object.freeze({ powermax: 'PowerMax', powerstore: 'PowerStore', unity: 'Unity' });

/* ── v2.951 어레이 측(디렉터 · 노드 · SP) 성능 ─────────────────────────────── */
/** 지표 키 → 표시 단위(화면 · CSV). hbps 는 B/s 를 Gb/s 로 바꿔 그린다(스위치 처리량과 같은 눈). */
export const FE_UNIT_TEXT = Object.freeze({ busy: '%', cpu: '%', queue: '%', iops: 'IO/s', lat: 'ms', hbps: 'Gb/s' });
/** 값 → 문구. 없으면 '—'(단위 없음). */
export function feValueText(k, v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  if (k === 'busy' || k === 'cpu' || k === 'queue') return pctText(n);
  if (k === 'iops') return `${Math.round(n).toLocaleString('en-US')} IO/s`;
  if (k === 'lat') return `${(Math.round(n * 10) / 10).toFixed(1)} ms`;
  if (k === 'hbps') return rateText(n);
  return String(n);
}
/**
 * 선 차트 모델(쌓지 않는다 — 단위가 같은 여러 선). values 는 이미 표시 단위로 바꾼 값(hbps 는 gbps()). null 은 선을 끊는다(gaps 와 같은 뜻).
 * @returns {{lines:Array<{key,label,color,d}>, x:Function, y:Function, yMax:number, n:number, w,h,padL,padR,padT,padB}}
 */
export function lineModel(cols = [], seriesList = [], { w = 1140, h = 200, padL = 60, padR = 20, padT = 10, padB = 30, yMax = null } = {}) {
  const n = cols.length;
  const x = (i) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL - padR));
  let top = 0;
  for (const s of seriesList) for (const v of s.values || []) if (v != null && v > top) top = v;
  const ymax = yMax ?? niceMax(top);
  const y = (v) => padT + (h - padT - padB) * (1 - (ymax ? Math.min(v, ymax) / ymax : 0));
  const lines = seriesList.map((s) => {
    const segs = []; let cur = [];
    for (let i = 0; i < n; i++) { const v = s.values?.[i]; if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(i); }
    if (cur.length) segs.push(cur);
    const d = segs.map((seg) => (seg.length === 1
      ? `M${x(seg[0]).toFixed(1)},${y(s.values[seg[0]]).toFixed(1)} h0.01`
      : `M${seg.map((i) => `${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`).join(' L')}`)).join(' ');
    return { key: s.key, label: s.label, color: s.color, d, points: segs.filter((g) => g.length === 1).map((g) => ({ cx: x(g[0]), cy: y(s.values[g[0]]) })) };
  });
  return { lines, x, y, yMax: ymax, n, w, h, padL, padR, padT, padB };
}
/** 어레이 측 단위 중 값이 하나라도 있는 지표만 세그먼트에 올린다(없는 지표를 눌러도 빈 차트뿐). 첫 지표가 기본. */
export function feMetricsPresent(side) {
  const units = side?.units || [];
  return (side?.metrics || []).filter((m) => units.some((u) => u?.latest?.[m.k] != null || (side?.series?.byUnit?.[u.id]?.[m.k] || []).some((v) => v != null)));
}
