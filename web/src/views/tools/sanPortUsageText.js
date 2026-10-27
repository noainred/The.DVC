/**
 * sanPortUsageText.js — SAN 포트 사용량(📊)·포트 배치(🔲) 탭의 순수 판정(v2.748, 시안 A안 개정 2 + 스위치 한 대 화면).
 *
 * 렌더는 테스트할 수 없으니(웹 테스트는 node 환경) **틀리면 운영자가 잘못 판단하는 규칙**을 여기 둔다:
 *  - 못 읽은 칸은 0 이 아니라 '없음'(빗금). 지금 이후의 칸은 '아직'(점선). 속도를 모르면 포화도를 말하지 않는다.
 *  - 색 단계 경계(20·40·60·80%)와 KPI(평균·피크·피크 포화도·피크 시각).
 *  - 앞 기간 겹쳐 보기는 '기간 시작부터의 경과 시간' 으로 맞춘다(달 길이가 달라도 같은 날·시각끼리).
 * 시각 표기는 서버가 준 offsetMin(기본 한국 +540) 기준이다 — 브라우저 시간대로 날짜 경계를 다시 자르지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { bps } from './sanSwitchPorts.js';

export const UNITS = [['d', '1일'], ['w', '7일'], ['m', '1달']];
export const TODAY_TEXT = { d: '오늘로', w: '이번 7일로', m: '이번 달로' };

/** 색 단계(시안과 같은 값). 경계는 '이상' 쪽에 붙는다(20% 는 20~40 칸). */
export const LEVELS = [
  { min: 0, color: '#1e3a5f', label: '20% 미만' },
  { min: 20, color: '#155e75', label: '20~40%' },
  { min: 40, color: '#0e7490', label: '40~60%' },
  { min: 60, color: '#22d3ee', label: '60~80%' },
  { min: 80, color: '#ea580c', label: '80% 이상' },
];
export const GAP_BG = 'repeating-linear-gradient(45deg, rgba(148,163,184,.18) 0 3px, transparent 3px 6px)';

export function levelColor(pct) {
  const p = numOrNull(pct);
  if (p == null) return null;
  let c = LEVELS[0].color;
  for (const l of LEVELS) if (p >= l.min) c = l.color;
  return c;
}

/** 바이트/초 ÷ 회선 용량(바이트/초) → %. 어느 쪽이든 모르면 null(0% 가 아니다). */
export function pctOf(bytes, capBps) {
  const b = numOrNull(bytes), c = numOrNull(capBps);
  if (b == null || c == null || !(c > 0)) return null;
  return Math.round((b / c) * 1000) / 10;
}

/** 바이트/초 → 'x.xx Gbps'(값이 없으면 '—', 단위를 붙이지 않는다). */
export const rateText = (bytes) => (numOrNull(bytes) == null ? '—' : bps(Number(bytes) * 8));
export const pctText = (p) => (numOrNull(p) == null ? '—' : `${p}%`);

const pad = (n) => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
function parts(t, offsetMin = 540) {
  const d = new Date(Number(t) + offsetMin * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: WD[d.getUTCDay()] };
}
export const timeText = (t, o) => { if (numOrNull(t) == null) return '—'; const p = parts(t, o); return `${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`; };
export const dayText = (t, o) => { const p = parts(t, o); return `${pad(p.m)}-${pad(p.d)}(${p.wd})`; };

/**
 * 히트맵 칸 하나의 판정.
 * cell = [avg, peak, n] | null (바이트/초). start = 칸 시작 시각.
 * kind: 'future'(지금 이후 — 점선) · 'gap'(값 없음 — 빗금) · 'val'.
 */
export function cellInfo(cell, { capBps, metric = 'peak', start, now }) {
  if (numOrNull(start) != null && numOrNull(now) != null && Number(start) > Number(now)) return { kind: 'future', pct: null, value: null };
  if (!Array.isArray(cell)) return { kind: 'gap', pct: null, value: null };
  const value = numOrNull(metric === 'peak' ? cell[1] : cell[0]);
  if (value == null) return { kind: 'gap', pct: null, value: null };
  const pct = pctOf(value, capBps);
  return { kind: 'val', value, pct, color: pct == null ? '#475569' : levelColor(pct), n: numOrNull(cell[2]) };
}

export function cellTitle(info, { label, metric, colMs }) {
  if (info.kind === 'future') return `${label} — 아직 오지 않은 시간`;
  if (info.kind === 'gap') return `${label} — 값 없음(수집되지 않았거나 보관 기간이 지났습니다 · 0 이 아닙니다)`;
  const hours = colMs >= 86_400_000 && info.n != null ? ` · 24시간 중 ${info.n}시간 값` : '';
  return `${label} — ${metric === 'peak' ? '피크' : '평균'} ${rateText(info.value)}${info.pct == null ? ' · 속도를 몰라 포화도 없음' : ` · ${info.pct}%`}${hours}`;
}

/** 차트 KPI — 평균(칸 평균들의 평균)·피크(칸 피크의 최댓값)·피크 포화도·피크 시각. */
export function usageKpis(chart, capBps) {
  if (!chart) return { avg: null, peak: null, peakPct: null, peakAt: null };
  return { avg: numOrNull(chart.avgMean), peak: numOrNull(chart.peakMax), peakPct: pctOf(chart.peakMax, capBps), peakAt: numOrNull(chart.peakAt) };
}

/** 앞 기간 대비 변화(%) — 어느 쪽이든 없으면 null. */
export function deltaPct(cur, prev) {
  const a = numOrNull(cur), b = numOrNull(prev);
  if (a == null || b == null || !(b > 0)) return null;
  return Math.round(((a - b) / b) * 1000) / 10;
}

/**
 * v2.782(점검 K3 I-B2): 앞 기간 KPI 한 줄. 진행 중 기간이면 서버가 앞 기간을 **같은 경과 구간**으로 잘라 준다(sameElapsed) —
 * 그 사실을 '같은 구간' 으로 밝힌다(전에는 '지금까지' 를 '앞 기간 전체' 와 견줘 매일 같은 트래픽도 −77%·−90% 로 보였다).
 */
export function prevKpiMeta(cur, prev, { sameElapsed = false } = {}) {
  const d = deltaPct(cur, prev);
  return `${sameElapsed ? '앞 기간 같은 구간' : '앞 기간'} ${rateText(prev)}${d != null ? ` (${d > 0 ? '+' : ''}${d}%)` : ''}`;
}

/** 경과 시간 표기 — 하루 미만은 'N시간 M분', 이상은 'N일 M시간'(0 인 뒤 단위는 뺀다). 값이 없으면 '—'. */
export function elapsedText(ms) {
  const v = numOrNull(ms);
  if (v == null || v < 0) return '—';
  const min = Math.floor(v / 60_000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (d > 0) return h % 24 ? `${d}일 ${h % 24}시간` : `${d}일`;
  if (h > 0) return min % 60 ? `${h}시간 ${min % 60}분` : `${h}시간`;
  return `${min}분`;
}

/** 진행 중 기간의 비교 기준 안내(서버가 sameElapsed 를 달았을 때만). 겹쳐 그린 선은 앞 기간 전체다. */
export function prevCompareNote(prev) {
  if (!prev?.sameElapsed) return '';
  return `진행 중인 기간이라 앞 기간 값(평균·피크)은 전체가 아니라 **같은 경과 시간**(기간 시작부터 ${elapsedText(prev.elapsedMs)})까지만 잘라 비교합니다. 겹쳐 그린 선은 앞 기간 전체입니다.`;
}

/**
 * recharts 행. 값은 바이트/초 그대로(축·툴팁이 bps 로 바꾼다). cap 은 회선 용량 선(모르면 없음).
 * prev 는 '기간 시작부터의 경과' 로 맞춘다 — 앞 칸 폭이 달라도(15분 ↔ 1시간) 같은 시각의 값을 놓는다.
 */
export function usageChartRows(chart, { capBps = null, withPrev = false } = {}) {
  if (!chart?.avg) return [];
  const prev = withPrev ? chart.prev : null;
  return chart.avg.map((a, i) => {
    const ts = chart.since + i * chart.bucketMs;
    const row = { ts, avg: a, peak: chart.peak?.[i] ?? null };
    if (numOrNull(capBps) != null) row.cap = Number(capBps);
    if (prev) {
      const j = Math.floor((i * chart.bucketMs) / prev.bucketMs);
      row.prevAvg = prev.avg?.[j] ?? null;
      row.prevPeak = prev.peak?.[j] ?? null;
    }
    return row;
  });
}

/** 이전·다음 버튼 상태 — 하한(보관 기간)·현재(미래 없음). */
export function navInfo(r) {
  const off = Number(r?.off) || 0, minOff = Number(r?.minOff) || 0;
  return { prevDisabled: off <= minOff, nextDisabled: off >= 0, todayText: TODAY_TEXT[r?.unit] || '오늘로' };
}

/** 히트맵 A 열 머리. d: 00~23시 · w: 'MM-DD(요일)' · m: 일(1~31). */
export function colLabels(r) {
  if (!r) return [];
  if (r.unit === 'd') return Array.from({ length: 24 }, (_, h) => pad(h));
  return (r.days || []).map((t) => (r.unit === 'w' ? dayText(t, r.offsetMin) : String(parts(t, r.offsetMin).d)));
}

/** 행 하나라도 값이 있는가(빈 포트 접기용). */
export const rowHasData = (row) => (row?.cells || []).some((c) => Array.isArray(c));

export function imbalanceText(it, slotOf = (p) => p) {
  return `${it.storage} · 포트 ${slotOf(it.port)}: 묶음 평균의 ${it.ratio}배를 받습니다(같은 스토리지로 가는 다른 경로가 덜 쓰이고 있을 수 있습니다).`;
}

/**
 * 유휴 요약 한 줄. v2.785(GI I-B1): 스냅샷에 상태가 없는 포트(서버 idle.unknown — 엣지가 문제 포트만 보낸 축약·스냅샷 없음)는
 * '사용 중이 아닌 포트' 로 단정하지 않고 '상태 모름' 으로 따로 밝힌다. 0개이거나 옛 서버 응답(필드 없음)이면 전과 같은 문구.
 */
export function idleSummary(idle) {
  if (!idle) return '';
  const unknown = Array.isArray(idle.unknown) ? idle.unknown.length : 0;
  const tail = unknown > 0
    ? `사용 중이 아닌 포트 ${idle.off.length}개(비어 있음·비활성 등)와 상태 모름 ${unknown}개(스위치 스냅샷에 상태가 없는 포트)는 유휴로 세지 않습니다.`
    : `사용 중이 아닌 포트 ${idle.off.length}개(비어 있음·비활성 등)는 유휴로 세지 않습니다.`;
  return `지난 ${idle.days}일 피크가 속도의 ${idle.pct}% 미만인 사용 중 포트 ${idle.idle.length}개 · 판단 보류 ${idle.pending.length}개(데이터 ${idle.minDays}일 미만·속도 모름) · ${tail}`;
}

/** 화면 하단 정직 표기(시안과 같은 다섯 줄). */
export const USAGE_NOTES = [
  '값은 스위치 **portperfshow** 가 보고한 포트 처리량(송신+수신 합, 바이트/초 × 8)입니다. 송수신 합이라 단방향 회선 속도 대비 100% 를 넘을 수 있습니다.',
  '피크는 **수집 시점들 중 최댓값**입니다(기본 5분 주기) — 그 사이의 순간 최대는 보이지 않습니다.',
  '스토리지 피크 합은 멤버 피크가 같은 순간이 아닐 수 있어 **상한**입니다. 멤버 중 하나라도 값이 없는 칸은 합을 내지 않고 비웁니다.',
  '값이 없는 칸(빗금)은 0 이 아닙니다 — 수집이 없었거나 보관 기간이 지난 것입니다.',
  '연결 장비 이름은 **최신 하나**만 보관합니다(변경 이력 없음) — 지난 기간도 지금 이름으로 묶여 보입니다.',
];

export function usageParams({ unit, off, view, target, prev }) {
  const p = { unit, off: String(off || 0), view };
  if (target != null && target !== '') p.target = String(target);
  if (prev) p.prev = '1';
  return p;
}

/* ───────── 🔲 포트 배치(스위치 한 대 전체 포트) ───────── */

export const MAP_HOURS = [[1, '1시간'], [24, '24시간'], [168, '7일']];

/**
 * 포트 타일. list = 스냅샷 포트 목록, perf = /perf 응답(portSeries — series[{port, avg[], peak[], max}]).
 * 값: 평균 기준은 칸 평균들의 평균, 피크 기준은 원시 표본 최댓값(max — 칸 폭과 무관).
 */
export function mapTiles(list = [], perf = null, metric = 'peak') {
  const byPort = new Map((perf?.series || []).map((s) => [Number(s.port), s]));
  return (list || []).map((p) => {
    const s = byPort.get(Number(p.index));
    const vals = (s?.avg || []).map(numOrNull).filter((v) => v != null);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const peakVals = (s?.peak || []).map(numOrNull).filter((v) => v != null);
    const peak = numOrNull(s?.max) != null && Number(s.max) > 0 ? Number(s.max) : (peakVals.length ? Math.max(...peakVals) : null);
    const value = metric === 'peak' ? peak : avg;
    const capBps = (() => { const m = String(p.speed || '').match(/^(\d+)G$/); return m && Number(m[1]) > 0 ? (Number(m[1]) * 1e9) / 8 : null; })();
    return { port: Number(p.index), slotPort: p.slotPort ?? String(p.index), state: p.state || 'unknown', name: p.attachedName || '', speed: p.speed || '',
      avg, peak, value, capBps, pct: pctOf(value, capBps), spark: (metric === 'peak' ? s?.peak : s?.avg) || [] };
  });
}

/** 타일 KPI — 사용 중·80% 이상·유휴(1% 미만)·값 없음(사용 중인데 값 없음)·전체. 속도를 모르면 80%·유휴에 넣지 않는다. */
export function mapKpis(tiles = []) {
  const k = { online: 0, hot: 0, idle: 0, noData: 0, total: tiles.length };
  for (const t of tiles) {
    if (t.state !== 'online') continue;
    k.online++;
    if (t.value == null) { k.noData++; continue; }
    if (t.pct != null && t.pct >= 80) k.hot++;
    if (t.pct != null && t.pct < 1) k.idle++;
  }
  return k;
}

/** 타일 색 — 꺼짐은 회색, 사용 중인데 값 없음은 빗금, 속도 모름은 중립. */
export function tileStyle(t) {
  if (t.state !== 'online') return { background: 'rgba(148,163,184,.08)', color: 'var(--muted, #94a3b8)' };
  if (t.value == null) return { background: GAP_BG, color: 'var(--muted, #94a3b8)' };
  if (t.pct == null) return { background: '#475569', color: '#e2e8f0' };
  const c = levelColor(t.pct);
  return { background: c, color: t.pct >= 60 && t.pct < 80 ? '#0f172a' : '#f8fafc' };
}

/** 스파크라인 점(0~1 정규화). 값 없는 칸은 끊는다(null). */
export function sparkPoints(values = [], w = 80, h = 18) {
  const v = values.map(numOrNull);
  const known = v.filter((x) => x != null);
  if (!known.length) return [];
  const max = Math.max(...known) || 1;
  const n = Math.max(1, v.length - 1);
  const segs = []; let cur = [];
  v.forEach((x, i) => {
    if (x == null) { if (cur.length) segs.push(cur); cur = []; return; }
    cur.push([Math.round((i / n) * w * 10) / 10, Math.round((h - (x / max) * h) * 10) / 10]);
  });
  if (cur.length) segs.push(cur);
  return segs;
}
