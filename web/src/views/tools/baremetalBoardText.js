/**
 * baremetalBoardText.js — 서버 › 물리 서버 '상태 보드' 탭의 집계·문구(순수, v2.916).
 * 설계 레퍼런스: docs/design/baremetal/ (Claude Design 시안 A — 사용자 컨펌 2026-11-06).
 *
 * ⚠ 부품 판정은 서버가 한다(CLAUDE.md '판정 코어는 하나'): 행의 `parts` 는 서버 idrac/serverParts.js serverPartsCell 이고,
 *   이 파일은 그 요약을 **서버 1대의 상태 한 칸**으로 접고 세기만 한다. 부품 하나하나를 다시 판정하지 않는다.
 *
 * 서버 1대 상태(boardState):
 *   fault   장애 부품이 1개 이상
 *   warn    장애 없음 · 경고 부품 1개 이상
 *   partial 장애·경고 없음 · 상태를 읽지 못한 부품이 있거나 일부 종류 수집이 실패 — **정상으로 세지 않는다**('못 읽은 값은 0 이 아니다')
 *   ok      판정했고 확인한 부품이 모두 정상
 *   nojudge 판정 못함(인벤토리 없음·장비 불통·엣지 구판·시스템 조회 실패·부품 목록 0개·요약 없음)
 * 오래됨(stale)은 상태와 **직교**하는 표지다 — 판정은 유지하고 따로 센다(서버가 INV_STALE_MS 로 붙인다. 화면에 기준 분을 박지 않는다).
 *
 * 문구에 백틱을 쓰지 않는다(BoldText 는 **강조** 만 해석한다).
 */
import { partsReasonText } from '../idrac/hwStatusText.js';

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v) => (v == null ? '' : String(v).trim());

export const BOARD_STATES = Object.freeze(['fault', 'warn', 'partial', 'ok', 'nojudge']);
export const BOARD_STATE_TEXT = Object.freeze({
  fault: '장애', warn: '경고', partial: '일부 확인 불가', ok: '정상', nojudge: '판정 못함',
});
/** 배지 클래스(styles.css .badge.*) — 확인 불가·판정 못함은 회색(정상도 장애도 아님). */
export const BOARD_STATE_TONE = Object.freeze({
  fault: 'red', warn: 'amber', partial: 'gray', ok: 'green', nojudge: 'gray',
});
/** 정렬 순위 — 나쁜 것이 먼저. */
const RANK = Object.freeze({ fault: 0, warn: 1, partial: 2, nojudge: 3, ok: 4 });

/** 판정 못함 사유 키 — 서버 PARTS_REASON 4종 + 화면 쪽 2종(요약 자체가 없음·부품 목록 0개). */
export const NOJUDGE_NO_SUMMARY = 'no-summary';
export const NOJUDGE_NO_PARTS = 'no-parts';
export function nojudgeReasonText(key) {
  if (key === NOJUDGE_NO_SUMMARY) return '부품 상태 요약을 받지 못했습니다';
  if (key === NOJUDGE_NO_PARTS) return '판정할 부품이 없습니다(부품 목록 0개)';
  return partsReasonText(key);
}

/** KPI 보조 줄용 짧은 사유(긴 문장은 사유 패널·툴팁에). 모르는 키는 '기타'. */
const NOJUDGE_SHORT = Object.freeze({
  'no-inventory': '미수집', unreachable: '응답 없음', 'system-failed': '시스템 조회 실패', 'edge-old': '엣지 구판',
  [NOJUDGE_NO_SUMMARY]: '요약 없음', [NOJUDGE_NO_PARTS]: '부품 0개',
});
export const nojudgeShortText = (key) => NOJUDGE_SHORT[key] || '기타';

/**
 * 행의 parts(serverPartsCell) → { state, stale, reason, fault, warn, unknown, ok, total }
 * @param {object|null|undefined} p
 */
export function boardState(p) {
  if (!p || typeof p !== 'object') return { state: 'nojudge', stale: false, reason: NOJUDGE_NO_SUMMARY, fault: 0, warn: 0, unknown: 0, ok: 0, total: 0 };
  const stale = p.stale === true;
  const fault = fin(p.fault); const warn = fin(p.warn); const unknown = fin(p.unknown); const ok = fin(p.ok); const total = fin(p.total);
  const base = { stale, fault, warn, unknown, ok, total };
  if (!p.judged) return { ...base, state: 'nojudge', reason: str(p.reason) || NOJUDGE_NO_SUMMARY };
  const failed = Array.isArray(p.failedKinds) && p.failedKinds.length > 0;
  if (fault) return { ...base, state: 'fault', reason: null };
  if (warn) return { ...base, state: 'warn', reason: null };
  if (unknown || failed) return { ...base, state: 'partial', reason: null };
  if (ok) return { ...base, state: 'ok', reason: null };
  return { ...base, state: 'nojudge', reason: NOJUDGE_NO_PARTS };
}

/* ── 소속(서버 분석 화면과 같은 규칙 — ServerInfoByVcenter 도 이 함수를 쓴다) ─────────────────── */

/** 가상화 소속 vCenter: 명시 vcenterId, 없으면 서비스태그 매칭 mappedVcenterId. */
export const effVcOf = (s) => (s && (s.vcenterId || s.mappedVcenterId)) || '';
/** 소속 법인: 스캔 등록분은 datacenterId 직접, 그 외는 (매핑 포함) vCenter → DataCenter 할당. */
export const dcOfServer = (s, assign = {}) => (s && (s.datacenterId || (assign || {})[effVcOf(s)])) || '';
/**
 * 상단 2단 필터 스코프 { datacenterId?, vcenterId?, baremetal? } 적용 — 백엔드 serverInScope 와 같은 규칙:
 * 법인 = 그 법인 전체, vCenter = 그 vCenter 가상화, Baremetal = vCenter 미소속.
 */
export function scopeMatchServer(s, sc, assign = {}) {
  const o = (sc && typeof sc === 'object') ? sc : {};
  const ev = effVcOf(s);
  if (o.vcenterId) { if (o.vcenterId === '__unmapped__' ? ev : ev !== o.vcenterId) return false; }
  if (o.datacenterId) { if (dcOfServer(s, assign) !== (o.datacenterId === '__unmapped__' ? '' : o.datacenterId)) return false; }
  if (o.baremetal && ev) return false;
  return true;
}

/** 검색어 일치 — 이름·서비스태그·주소·모델(대소문자 무시). */
export function matchServerQuery(s, q) {
  const ql = str(q).toLowerCase();
  if (!ql) return true;
  return [s?.name, s?.serviceTag, s?.host, s?.model].some((x) => str(x).toLowerCase().includes(ql));
}

/* ── 보드 집계 ─────────────────────────────────────────────────────────────────────────── */

/**
 * 보드 한 장의 집계. OME(관리 콘솔 등록)는 서버가 아니므로 세지 않고 수만 밝힌다.
 * @param {Array} servers  /admin/idrac?parts=1 의 servers(이미 스코프·검색을 적용한 것)
 * @param {{dcName?:Map<string,string>, assign?:object, dcErr?:boolean}} o
 * @returns {{rows:Array, omeSkipped:number, counts:object, reasons:Array, groups:Array, models:Array, attention:Array, newestAt:number|null, authStopped:number}}
 */
export function buildBoard(servers, { dcName = new Map(), assign = {}, dcErr = false } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const counts = { all: 0, fault: 0, warn: 0, partial: 0, ok: 0, nojudge: 0, stale: 0 };
  const reasonMap = new Map();
  const groupMap = new Map();
  const modelMap = new Map();
  let omeSkipped = 0; let newestAt = null; let authStopped = 0;
  const rows = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'ome') { omeSkipped++; continue; }
    const b = boardState(s.parts);
    const dc = dcOfServer(s, assign) || '__unmapped__';
    const row = { s, ...b, dc, corp: dc === '__unmapped__' ? (dcErr ? '법인 정보를 읽지 못함' : '미지정(법인 없음)') : (dcName.get(dc) || dc), model: str(s.model) || '미상', collectedAt: Number.isFinite(Number(s.parts?.collectedAt)) && s.parts?.collectedAt != null ? Number(s.parts.collectedAt) : null };
    rows.push(row);
    counts.all++; counts[b.state]++; if (b.stale) counts.stale++;
    if (b.state === 'nojudge') reasonMap.set(b.reason, (reasonMap.get(b.reason) || 0) + 1);
    if (s.authStopped) authStopped++;
    if (row.collectedAt != null && (newestAt == null || row.collectedAt > newestAt)) newestAt = row.collectedAt;
    if (!groupMap.has(dc)) groupMap.set(dc, { id: dc, name: row.corp, rows: [], fault: 0, warn: 0, partial: 0, ok: 0, nojudge: 0, stale: 0, models: new Map() });
    const g = groupMap.get(dc);
    g.rows.push(row); g[b.state]++; if (b.stale) g.stale++;
    g.models.set(row.model, (g.models.get(row.model) || 0) + 1);
    modelMap.set(row.model, (modelMap.get(row.model) || 0) + 1);
  }
  const byRank = (a, b) => RANK[a.state] - RANK[b.state] || b.fault - a.fault || b.warn - a.warn || str(a.s.name).localeCompare(str(b.s.name));
  const groups = [...groupMap.values()].map((g) => {
    const top = [...g.models.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
    // 타일은 나쁜 것이 앞에 — 장애·경고가 법인 묶음 첫 줄에 보인다.
    return { id: g.id, name: g.name, count: g.rows.length, fault: g.fault, warn: g.warn, partial: g.partial, ok: g.ok, nojudge: g.nojudge, stale: g.stale, rows: g.rows.slice().sort(byRank), topModel: top ? { name: top[0], n: top[1] } : null };
  }).sort((a, b) => (a.id === '__unmapped__' ? 1 : 0) - (b.id === '__unmapped__' ? 1 : 0)
    || (b.fault - a.fault) || (b.warn - a.warn) || (b.count - a.count) || str(a.name).localeCompare(str(b.name)));
  const models = [...modelMap.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const attention = rows.filter((r) => r.state === 'fault' || r.state === 'warn').sort(byRank);
  const reasons = [...reasonMap.entries()].map(([key, n]) => ({ key, n, text: nojudgeReasonText(key) })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return { rows, omeSkipped, counts, reasons, groups, models, attention, newestAt, authStopped };
}

/** KPI 필터 — 'all' | 상태 5종 | 'stale'. */
export const BOARD_FILTERS = Object.freeze(['all', ...BOARD_STATES, 'stale']);
export function matchBoardFilter(row, f) {
  if (!f || f === 'all') return true;
  if (f === 'stale') return row.stale === true;
  return row.state === f;
}

/** 주의 목록 한 줄 — 목록 API 는 부품 이름을 주지 않는다(개수만). 이름은 상세에서 본다. */
export function attentionDetail(row) {
  const bits = [];
  if (row.fault) bits.push(`장애 부품 ${row.fault}`);
  if (row.warn) bits.push(`경고 부품 ${row.warn}`);
  if (row.unknown) bits.push(`확인 불가 ${row.unknown}`);
  return `${bits.join(' · ')} · ${row.model}`;
}

/** 타일·행 툴팁. */
export function tileTitle(row, now = Date.now()) {
  const s = row.s || {};
  const parts = [str(s.name) || str(s.host) || str(s.id), row.model, BOARD_STATE_TEXT[row.state]];
  if (row.state === 'fault' || row.state === 'warn' || row.state === 'partial') {
    const b = [];
    if (row.fault) b.push(`장애 ${row.fault}`);
    if (row.warn) b.push(`경고 ${row.warn}`);
    if (row.unknown) b.push(`확인 불가 ${row.unknown}`);
    if (b.length) parts.push(b.join(' · '));
  }
  if (row.state === 'nojudge') parts.push(nojudgeReasonText(row.reason));
  if (row.stale) parts.push(`오래됨(${ageText(row.collectedAt, now)} 값)`);
  return parts.filter(Boolean).join(' · ');
}

/** 경과 글자 — 값이 없으면 '—'(0분 전으로 지어내지 않는다). */
export function ageText(at, now = Date.now()) {
  if (at == null || !Number.isFinite(Number(at))) return '—';
  const m = Math.max(0, Math.round((now - Number(at)) / 60_000));
  if (m < 1) return '방금 전';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 ${m % 60 ? `${m % 60}분 ` : ''}전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 머리 한 줄의 범위 글자. */
export function boardScopeText({ bm, dcLabel }) {
  const corp = dcLabel ? dcLabel : '전체 법인';
  return bm ? `Baremetal(미가상화 물리) · ${corp}` : corp;
}
