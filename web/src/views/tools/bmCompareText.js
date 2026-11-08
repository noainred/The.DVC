/**
 * views/tools/bmCompareText.js — 리눅스 성능 6단계 **서버 비교(2~5대)** 화면의 문구 · 좌표 · CSV(순수 · vitest `bmStage6Text.test.jsx`).
 *
 * ⚠⚠ 판정은 서버(`server/src/bmusage/multiCompare.js` — 편차 · 최고 · 스큐 후보 · 눈금 · 잘림 · 열 상태)가 한다. 이 모듈은 그 응답을 **문장 · 좌표로 바꾸기만** 한다
 *   (max ÷ min · 그룹 비교 · 기준 대조가 여기 없다 — 테스트가 소스 스윕으로 고정).
 * ⚠ 결측은 0 이 아니다 — 값이 없으면 단위 없이 ‘—’ · 스파크는 끊는다 · CSV 는 빈 칸.
 * ⚠ 문구에 백틱 금지(BoldText 는 **강조** 만). 상한 · 비율 숫자는 응답 값만 쓴다(maxServers · devHighRatio · skewRatio).
 */
import { numOrNull } from '../../numOrNull.js';
import { toCsv } from '../../util/csv.js';
import { dayStamp } from '../../dayStamp.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { SERVER_METRIC_INFO, DEVICE_PALETTE, valText } from './bmTrendText.js';

const n = numOrNull;
const t = (v) => String(v ?? '').trim();

export const COMPARE_GROUP_TEXT = Object.freeze({ util6: '사용률 6종', use: 'USE 전부', queue: '큐 · 버퍼', hw: '하드웨어' });
export const COMPARE_VIEW_TEXT = Object.freeze({ side: '나란히(서버마다 열)', overlay: '겹쳐서(한 차트)', table: '표(편차 · 순위)' });
export const COMPARE_VIEWS = Object.freeze(Object.keys(COMPARE_VIEW_TEXT));
export const COMPARE_VALUE_TEXT = Object.freeze({ avgpeak: '평균 + 피크', avg: '평균', peak: '피크' });
export const COMPARE_RANGES = Object.freeze([{ k: '1h', label: '1시간' }, { k: '24h', label: '24시간' }, { k: '7d', label: '7일' }]);
/** 열 상태(서버 bmCompareView columns[].state) → 칩 문구. */
export const COLUMN_STATE_TEXT = Object.freeze({
  ok: { label: '', tone: 'ok', note: '' },
  stale: { label: '오래됨', tone: 'warn', note: '엣지에서 계열을 읽지 못했습니다 — 봉투 보관분의 판정만 보입니다' },
  none: { label: '없음', tone: 'idle', note: '찾지 못했거나 볼 수 없는 서버입니다(사라졌거나 범위 밖 — 둘을 구분하지 않습니다)' },
  'other-corp': { label: '다른 법인', tone: 'idle', note: '같은 법인만 비교합니다 — ‘법인 간 허용’ 으로 바꾸면 담을 수 있습니다' },
  'old-version': { label: '엣지 버전 낮음', tone: 'warn', note: '이 엣지는 비교 계열 경로가 없습니다 — 보관분 판정만 보입니다' },
  'no-sample': { label: '표본 없음', tone: 'idle', note: '아직 수집한 표본이 없습니다' },
  // 다음 점검 ①: 같은 키의 서버가 범위 안 여러 법인에 있고 법인 없이 담았다(예전 판이 저장한 목록 · 세트 · 링크) — 아래 후보 법인 중 하나를 고른다.
  ambiguous: { label: '법인 고르기', tone: 'warn', note: '같은 식별 키의 서버가 여러 법인에 있습니다 — 아래에서 법인을 고르세요' },
});
export function columnStateView(state, { minEdgeVersion = null } = {}) {
  const v = COLUMN_STATE_TEXT[state] || { label: String(state || '—'), tone: 'idle', note: '' };
  return state === 'old-version' && minEdgeVersion ? { ...v, note: `${v.note}(엣지 v${minEdgeVersion} 이상 필요)` } : v;
}
/** 하드웨어(iDRAC) 지표 — 지금 값만(계열 없음). */
const HW_INFO = Object.freeze({
  power_w: { label: '전력', unit: 'W' }, power_cap_pct: { label: '전력(cap 대비)', unit: '%' }, inlet_c: { label: '흡기 온도', unit: '℃' },
  // 추이 탭 표(SERVER_METRIC_INFO)에 없는 비교 지표 — PSI 는 커널이 준 10초 평균 · OOM 은 주기 증가분.
  psi_cpu_some10: { label: 'PSI cpu some 10초', unit: '%' }, psi_mem_full10: { label: 'PSI memory full 10초', unit: '%' }, psi_io_full10: { label: 'PSI io full 10초', unit: '%' },
  oom_kill_delta: { label: 'OOM kill 증가', unit: '건' },
});
export function metricLabel(col) { return SERVER_METRIC_INFO[col]?.label || HW_INFO[col]?.label || String(col || '—'); }
export function metricUnit(col, meta = {}) { return meta?.[col]?.unit ?? SERVER_METRIC_INFO[col]?.unit ?? HW_INFO[col]?.unit ?? ''; }
/** 값 글자 — ℃ · W 는 valText 가 모르는 단위라 여기서(값이 없으면 단위 없이 ‘—’). */
export function cmpValText(v, unit = '') {
  const x = n(v);
  if (x == null) return '—';
  if (unit === '℃') return `${Math.round(x * 10) / 10}℃`;
  if (unit === 'W') return `${Math.round(x).toLocaleString('ko-KR')}W`;
  return valText(x, unit);
}
/**
 * 칸 글자 — 값 모드대로(평균 + 피크 · 평균 · 피크). 피크 칸은 피크 표본만 — 없으면 ‘—’(평균으로 메우지 않는다 · 반증 F7).
 *   peakCapable=false(피크 표본 열이 원래 없는 지표 · 하드웨어 지금 값)면 평균만 쓰고 ‘/ —’ 꼬리를 붙이지 않는다(피크 모드는 ‘—’).
 */
export function cellPairText(pair, unit = '', value = 'avgpeak', peakCapable = true) {
  if (!pair) return '—';
  const a = n(pair.avg); const p = n(pair.peak);
  if (value === 'avg') return cmpValText(a, unit);
  if (value === 'peak') return p == null ? '—' : cmpValText(p, unit);
  if (!peakCapable) return cmpValText(a, unit);
  if (p == null) return a == null ? '—' : `${cmpValText(a, unit)} / —`;
  return `${cmpValText(a, unit)} / ${cmpValText(p, unit)}`;
}
/** 행의 편차 · 최고 판정 기준(서버 row.basis) → 꼬리 글자. 평균+피크 모드에서 값 있는 서버 2대 이상 중 피크 표본이 없는 서버가 있어 서버가 평균으로 대 봤을 때만. */
export function rowBasisNote(row, value = 'avgpeak') {
  if (!row || row.src === 'hw' || row.peakCapable === false) return '';
  const valued = (row.cells || []).filter((c) => c?.win && (n(c.win.avg) != null || n(c.win.peak) != null)).length;
  if (value === 'avgpeak' && row.basis === 'avg' && valued >= 2) return '평균으로 비교(피크 표본이 없는 서버가 있음)';
  return '';
}

/**
 * 서버 키 → 색(선택 순서가 아니라 키에 매긴다 — 세트를 다시 열어도 같은 색). 간단한 문자열 해시(FNV-1a) → 팔레트.
 */
export function keyColor(key) {
  let h = 0x811c9dc5;
  for (const ch of t(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return DEVICE_PALETTE[h % DEVICE_PALETTE.length];
}
/** 같은 화면에서 두 서버가 같은 색이면 두 번째부터 점선(구분 — 색은 키 고정 그대로). */
export function colorPlan(keys = []) {
  const seen = new Map();
  return Object.fromEntries(keys.map((k) => { const c = keyColor(k); const i = seen.get(c) || 0; seen.set(c, i + 1); return [k, { stroke: c, dash: i ? '5 3' : '' }]; }));
}

/** 스파크(서버 [t, avg, peak]) → SVG 경로. 값 없는 점에서 끊는다 · 눈금 밖은 위로 잘라 그린다(잘림 표지는 서버 clipped). */
export function sparkPath(spark = [], { pick = 1, scale = 100, w = 100, h = 24, from = null, to = null } = {}) {
  const pts = (Array.isArray(spark) ? spark : []).filter((p) => Array.isArray(p) && n(p[0]) != null);
  if (!pts.length) return '';
  const f = n(from) ?? n(pts[0][0]); const e = n(to) ?? n(pts.at(-1)[0]);
  const span = e > f ? e - f : 1;
  const ym = n(scale) && n(scale) > 0 ? n(scale) : 1;
  let d = ''; let pen = false; let solo = false;
  for (const p of pts) {
    const v = n(p[pick]);
    if (v == null) { if (solo) d += 'l0.01,0 '; pen = false; solo = false; continue; }
    const x = Math.round(((n(p[0]) - f) / span) * w * 10) / 10;
    const y = Math.round((h - (Math.max(0, Math.min(v, ym)) / ym) * h) * 10) / 10;
    d += `${pen ? 'L' : 'M'}${x},${y} `;
    solo = !pen; pen = true;
  }
  if (solo) d += 'l0.01,0 ';   // 홀로 남은 점은 점으로(둥근 끝 — 값이 있는데 안 보이면 거짓이다)
  return d.trim();
}

/** 법인별 읽은 시각 한 줄(‘법인 간’ 머리) — 시각이 없으면 그 사실을 적는다. */
export function corpsReadText(corps = []) {
  return (Array.isArray(corps) ? corps : []).map((c) => {
    const at = n(c.seriesAt) ?? n(c.readAt);
    const st = (c.states || []).filter((s) => s !== 'ok').map((s) => columnStateView(s).label).filter(Boolean);
    return `${t(c.vcenterId) || '귀속 없음'} ${at == null ? '읽은 시각 없음' : fmtHm(at)}${c.agent ? `(엣지 ${t(c.agent)})` : ''}${st.length ? ` · ${st.join(' · ')}` : ''}`;
  }).join(' · ');
}

/** 편차 글자 — 서버 dev(없으면 ‘—’ · 이유는 각주). */
export function devText(dev) { const x = n(dev); return x == null ? '—' : `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}×`; }
export const COMPARE_TABLE_NOTE = '편차는 결측을 뺀 서버들만으로 내고(max ÷ min) 2대 미만이거나 최소가 0 이면 ‘—’ 입니다. 판정 행(USE · 베이스라인)은 단위가 없어 편차를 내지 않습니다. 같은 용도 그룹에서 한 대만 높으면 ‘스큐 후보’ 로 적고 용도 탭의 점검으로 잇습니다 — 후보이지 원인이 아닙니다.';
export const COMPARE_HONEST = '시간축 · 구간은 모든 서버가 같습니다. 서버마다 경로(OS · iDRAC)가 달라 한 지표가 어떤 서버에는 ‘—’ 일 수 있습니다(못 읽음 · 경로 없음). 전력 · 흡기는 iDRAC 의 지금 값만 있고 추이가 없습니다. 엣지 위임 서버는 그 엣지에서 따로 읽어 합칩니다 — 법인마다 읽은 시각이 다릅니다.';
export function skewText(skew, nameOf = (k) => k) {
  if (!skew) return '';
  return `스큐 후보 — 같은 용도(${t(skew.group)})에서 ‘${nameOf(skew.key)}’ 한 대만 높습니다`;
}
export function baselineCellText(worst) {
  if (!worst) return '—';
  if (worst.reason) return { 'no-history': '띠 없음(이력 없음)', 'few-weeks': '띠 없음(주 수 부족)', missing: '띠 없음(결측 많음)' }[worst.reason] || '띠 없음';
  const r = n(worst.ratio);
  return r == null ? '—' : `${Math.round(r * 10) / 10}×${worst.out === 'in' ? '' : worst.out === 'above' ? ' ↑' : ' ↓'}`;
}

/** 선택 목록에 더하기(순수) — 중복 · 상한(서버가 준 maxServers). 판정 아님(목록 관리). */
export function addKey(list = [], key, max = 5) {
  const k = t(key);
  if (!k) return { list, error: '' };
  if (list.includes(k)) return { list, error: '' };
  if (list.length >= max) return { list, error: `${max}대까지 비교합니다 — 하나를 빼고 더하세요.` };
  return { list: [...list, k], error: '' };
}

/** 5대 동시 집중 결과 한 줄(서버 code 를 문장으로 — 집중 탭 문구 재사용은 화면이 한다). */
export function focusStartSummary(resp) {
  if (!resp) return '';
  if (resp.ok === false && !Array.isArray(resp.results)) return resp.reason || '시작하지 못했습니다.';
  const rs = Array.isArray(resp.results) ? resp.results : [];
  const run = rs.filter((r) => r.status === 'running').length;
  const q = rs.filter((r) => r.status === 'queued').length;
  const bad = rs.filter((r) => !r.ok).length;
  return `${rs.length}대 중 시작 ${run} · 대기열 ${q}${bad ? ` · 시작 못함 ${bad}` : ''} — 끝나면 각 서버의 집중 모니터링 탭에 결과가 남습니다.`;
}

/**
 * CSV — 보기 모드대로. side/overlay: 지표 × 서버(창 평균 · 피크 · 지금). table: 표 그대로(+ 편차 · 최고). 결측은 빈 칸.
 */
export function compareCsv(resp = {}, { view = 'table', nameOf = (k) => k } = {}) {
  const cols = (resp.columns || []).filter((c) => c.state === 'ok' || c.state === 'stale');
  const rows = resp.table?.rows || [];
  const meta = resp.metricMeta || {};
  const head = ['지표', '단위'];
  for (const c of cols) head.push(`${nameOf(c.key)} 평균`, `${nameOf(c.key)} 피크`);
  if (view === 'table') head.push('편차(max/min)', '최고 서버', '스큐 후보');
  else for (const c of cols) head.push(`${nameOf(c.key)} 지금 평균`);
  const out = [head];
  for (const r of rows) {
    const line = [metricLabel(r.col), metricUnit(r.col, meta) || '-'];
    for (const c of cols) { const cell = (r.cells || []).find((x) => x.key === c.key); line.push(n(cell?.win?.avg) ?? '', n(cell?.win?.peak) ?? ''); }
    if (view === 'table') line.push(n(r.dev) ?? '', r.top ? nameOf(r.top) : '', r.skew ? nameOf(r.skew.key) : '');
    else for (const c of cols) { const cell = (r.cells || []).find((x) => x.key === c.key); line.push(n(cell?.now?.avg) ?? ''); }
    out.push(line);
  }
  return `${toCsv(out)}\r\n`;
}
export function compareCsvName(view, endMs) {
  const d = n(endMs) == null ? 'latest' : (dayStamp(n(endMs)) || 'latest');
  return `bm-compare_${view}_${d}.csv`;
}
