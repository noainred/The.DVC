/**
 * views/tools/bmUsageChart.js — 베어메탈 사용률 **추이 차트**의 판정과 좌표(순수, v2.551).
 *
 * 사용자 요청(2026-09-18): 방금 만든 기능 개선 → 선택 ②「추이 차트(상세)」.
 * v2.550 은 원시 24시간 데이터를 **받아오면서 표만** 그렸다 — 사용률 기능의 핵심은 추이인데 없었다.
 *
 * ── 이 모듈이 막는 거짓 ─────────────────────────────────────────────────────
 *  ① ⚠⚠ **수집이 없던 구간은 선을 잇지 않는다**(끊어진 subpath). 이으면 그 시간에도 값이 있던
 *     것처럼 보인다(`roomTempView.sparkPath` 와 같은 규약).
 *  ② ⚠ **`v == null` 을 먼저 본다** — `Number(null) === 0` 이라 `Number.isFinite(Number(v))` 만
 *     보면 결측이 **0% 로 둔갑**한다(v2.525 규약. 이 저장소가 여러 번 밟은 함정이다).
 *  ③ **y축을 데이터 범위에 맞추지 않는다** — 퍼센트는 **0~100 고정**이다. 자동 스케일이면 3~5%
 *     구간의 잔물결이 '거의 100%' 처럼 보인다(사용률 차트에서 가장 위험한 착시).
 *     단 처리량(B/s)은 상한이 없으니 데이터 최대에 맞추고 **축에 단위를 적는다**.
 *  ④ **원시와 일 롤업을 같은 선으로 그리지 않는다** — 뜻이 다르다(순간값 vs 하루 평균/최대).
 *     기간을 바꾸면 `source` 가 바뀌고 화면이 그 사실을 말한다.
 *  ⑤ **점이 1개면 선을 그리지 않는다** — 한 점을 선으로 만들면 추세가 있는 것처럼 보인다.
 */
import { numOrNull } from '../../numOrNull.js';

const t = (v) => String(v ?? '').trim();
/** ⚠ null·빈 문자열을 **먼저** 본다(위 규칙 ②). */
const n = numOrNull;   // v2.576: 사본 금지 — 코어는 하나다(사본은 Number([])===0 을 막지 못했다)

/** 차트에 그릴 지표 — 표(`COLS`)와 **같은 순서**를 쓴다(두 곳이 어긋나면 사용자가 헷갈린다). */
export const CHART_SERIES = Object.freeze([
  { key: 'cpu', label: 'CPU', raw: 'cpu_pct', avg: 'cpu_avg', max: 'cpu_max', kind: 'pct', color: '#60a5fa' },
  { key: 'mem', label: '메모리', raw: 'mem_pct', avg: 'mem_avg', max: 'mem_max', kind: 'pct', color: '#a78bfa' },
  { key: 'diskIo', label: '디스크 I/O', raw: 'disk_busy_pct', avg: null, max: 'disk_busy_max', kind: 'pct', color: '#fbbf24' },
  { key: 'diskSpace', label: '디스크 공간', raw: 'disk_used_pct', avg: null, max: 'disk_used_max', kind: 'pct', color: '#f87171' },
  { key: 'net', label: '네트워크', raw: 'net_pct', avg: null, max: 'net_max', kind: 'pct', color: '#4ade80' },
  { key: 'hba', label: 'HBA', raw: 'hba_pct', avg: null, max: 'hba_max', kind: 'pct', color: '#22d3ee' },
  { key: 'netBps', label: '네트워크 처리량', raw: 'net_bps', avg: null, max: 'net_bps_max', kind: 'bps', color: '#34d399' },
  { key: 'hbaBps', label: 'HBA 처리량', raw: 'hba_bps', avg: null, max: 'hba_bps_max', kind: 'bps', color: '#38bdf8' },
]);

/** 기간 선택지. ⚠ 원시와 롤업의 **경계를 숨기지 않는다**(규칙 ④). */
export const RANGES = Object.freeze([
  { key: '6h', label: '6시간', hours: 6, source: 'raw' },
  { key: '24h', label: '24시간', hours: 24, source: 'raw' },
  { key: '7d', label: '7일', hours: 24 * 7, source: 'raw' },
  { key: '90d', label: '90일', days: 90, source: 'daily' },
]);
export function rangeOf(key) { return RANGES.find((r) => r.key === key) || RANGES[1]; }

/**
 * 기간에 맞는 '선을 끊는 간격'. 원시는 수집 주기의 2.5배, 롤업은 하루의 2.5배.
 * ⚠ **주기를 숫자로 박지 말 것** — 서버가 주는 `intervalMs` 를 쓴다(CLAUDE.md 규약).
 */
export function gapMsFor(range, intervalMs) {
  if (range?.source === 'daily') return 2.5 * 86_400_000;
  const iv = n(intervalMs) || 5 * 60_000;
  return Math.max(2.5 * iv, 3 * 60_000);
}

/**
 * 서버 응답 → 한 지표의 점 배열.
 * @param {object} p
 * @param {Array} p.raw     `usageHistory().rows`(시간 오름차순)
 * @param {Array} p.daily   `usageDaily()` 결과
 * @param {object} p.series `CHART_SERIES` 항목
 * @param {string} p.source 'raw' | 'daily'
 * @param {string} p.dailyStat 'avg' | 'max' — 롤업에서 무엇을 그릴지(평균만 두면 피크가 사라진다)
 */
export function seriesPoints({ raw = [], daily = [], series, source = 'raw', dailyStat = 'max' } = {}) {
  if (!series) return [];
  /*
   * ⚠⚠ **값이 `null` 인 점은 여기서 버린다**(v2.551 자체 검증에서 잡은 결함): 남겨 두면
   *   `chartEmptyNote` 가 `points.length` 만 보므로 **값이 전부 결측인데도 '비어 있다' 고 말하지
   *   못한다** — 차트는 비고 안내도 없는 최악의 조합이 된다. 이 함수의 뜻은 '그릴 수 있는 점' 이다.
   */
  if (source === 'daily') {
    const col = dailyStat === 'avg' ? series.avg : series.max;
    // ⚠ 평균이 없는 지표(디스크·네트워크·HBA)는 롤업에 최대만 있다 — 없는 것을 지어내지 않는다.
    if (!col) return [];
    return daily.map((r) => ({ ts: Date.parse(`${t(r.day)}T00:00:00Z`), v: n(r[col]), day: t(r.day) }))
      .filter((p) => Number.isFinite(p.ts) && p.v != null);
  }
  return raw.map((r) => ({ ts: n(r.ts), v: n(r[series.raw]) })).filter((p) => p.ts != null && p.v != null);
}

/**
 * 점 배열 → SVG path. **결측·간격은 subpath 를 끊는다**(규칙 ①).
 * @returns {{d:string, n:number, lo:number|null, hi:number|null, breaks:number}|null}
 *   점이 2개 미만이면 `null`(규칙 ⑤ — 선을 그리지 않는다).
 */
export function linePath(points = [], { w = 640, h = 160, gapMs = 15 * 60_000, yMax = null, yMin = 0 } = {}) {
  const pts = (points || []).filter((p) => p && p.v != null && Number.isFinite(Number(p.v)) && Number.isFinite(Number(p.ts)));
  if (pts.length < 2) return null;
  let lo = Infinity; let hi = -Infinity; let t0 = Infinity; let t1 = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
    t0 = Math.min(t0, p.ts); t1 = Math.max(t1, p.ts);
  }
  const top = n(yMax) != null ? Number(yMax) : (hi > 0 ? hi : 1);
  const bot = n(yMin) != null ? Number(yMin) : 0;
  const span = (top - bot) || 1;
  const tspan = (t1 - t0) || 1;
  const x = (ts) => ((ts - t0) / tspan) * w;
  const y = (v) => h - ((Math.min(top, Math.max(bot, v)) - bot) / span) * h;
  let d = ''; let prevTs = null; let breaks = 0;
  for (const p of pts) {
    const join = prevTs != null && (p.ts - prevTs) <= gapMs;
    if (prevTs != null && !join) breaks += 1;
    d += `${join ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)} `;
    prevTs = p.ts;
  }
  return { d: d.trim(), n: pts.length, lo, hi, breaks, t0, t1 };
}

/** 퍼센트 차트의 y축은 **0~100 고정**(규칙 ③). 처리량은 데이터 최대(여유 10%). */
export function yMaxFor(kind, points = []) {
  if (kind !== 'bps') return 100;
  let hi = 0;
  for (const p of points) { const v = n(p?.v); if (v != null && v > hi) hi = v; }
  return hi > 0 ? hi * 1.1 : 1;
}

/** y축 눈금 — 퍼센트는 0/25/50/75/100, 처리량은 0/절반/최대. */
export function yTicks(kind, yMax) {
  if (kind !== 'bps') return [0, 25, 50, 75, 100];
  const m = n(yMax) || 1;
  return [0, m / 2, m];
}

/**
 * x축 눈금 — 기간에 따라 개수·형식이 다르다.
 * ⚠ **한국 시각으로 표시한다**(사용자는 한국에 있다. DB 의 하루 경계도 UTC+9 다).
 */
export function xTicks(t0, t1, { count = 5, source = 'raw' } = {}) {
  const a = n(t0); const b = n(t1);
  if (a == null || b == null || b <= a) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ts = a + ((b - a) * i) / (count - 1);
    out.push({ ts, at: (i / (count - 1)), label: tickLabel(ts, source) });
  }
  return out;
}
function tickLabel(ts, source) {
  const d = new Date(Number(ts) + 9 * 3_600_000);   // KST
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (source === 'daily') return `${mm}/${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

/**
 * 차트가 **왜 비었는지**를 말한다. ⚠ '데이터 없음' 한 문구로 덮지 않는다 —
 * 조치가 다르다(기다리면 되는가 / 기간을 넓혀야 하는가 / 이 경로로는 영원히 안 나오는가).
 */
export function chartEmptyNote({ series, points = [], range, absent = [], hasRows = false } = {}) {
  if (points.length >= 2) return '';
  const label = series?.label || '';
  // 이 지표가 '이 경로에 원래 없는' 것인가 — iDRAC 전용 서버의 디스크 I/O 가 그렇다.
  const absentKey = series?.key === 'diskIo' ? 'diskbusy' : series?.key === 'net' || series?.key === 'netBps' ? 'net'
    : series?.key === 'hba' || series?.key === 'hbaBps' ? 'hba' : series?.key === 'diskSpace' ? 'disk' : '';
  if (absentKey && (absent || []).includes(absentKey)) {
    return `**${label}** 은 이 서버의 수집 경로로는 알 수 없습니다 — 기다려도 나오지 않습니다.`;
  }
  if (range?.source === 'daily' && !series?.max && !series?.avg) {
    return `**${label}** 은 하루 단위 롤업에 보관하지 않습니다 — 더 짧은 기간을 고르세요.`;
  }
  if (!hasRows) return `이 기간에 저장된 표본이 없습니다 — 기간을 넓히거나 수집을 기다리세요.`;
  if (points.length === 1) return `**${label}** 표본이 1개뿐이라 선을 그리지 않았습니다(추세를 지어내지 않습니다).`;
  return `**${label}** 값이 이 기간에 없습니다(그 지표만 못 읽었을 수 있습니다).`;
}

/** 기간·출처 안내 — 원시와 롤업을 섞지 않았다는 사실을 말한다(규칙 ④). */
export function sourceNote(range, { rawTruncated = false, dailyStat = 'max' } = {}) {
  if (!range) return '';
  if (range.source === 'daily') {
    return `하루 단위 롤업의 **${dailyStat === 'avg' ? '평균' : '최대'}** 값입니다 — 원시 표본(주기마다 1점)과 뜻이 다릅니다.`;
  }
  return `원시 표본(수집 주기마다 1점)입니다.${rawTruncated ? ' ⚠ 조회 상한으로 **앞부분이 잘렸습니다** — 더 긴 기간은 90일(롤업)로 보세요.' : ''}`;
}
