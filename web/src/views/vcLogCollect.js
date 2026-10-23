/**
 * vcLogCollect.js — 설정 › vCenter 로그 보관의 'vCenter 별 수집 상태' 표 문구·판정 한 벌(v2.764 — 실서버 OC2 이벤트 수집 13일 정체, 순수 · vitest).
 *
 * 서버(logs/poller.js logCollectDiag)가 `collect:[{ vcenterId, count, lastStoredTs, cursorTs, okAt, capped, ended, lagMs, lastPoll, consecutiveCapped,
 * ratePerMin, state }]` 로 싣고, 범위 계정에는 scopeVcLogStatus 가 범위 밖 vCenter 와 오류 원문을 지운다. 이 모듈은 그 값을 표 칸 문구로 바꾼다.
 * 규칙: 값이 없으면 '—'(0 이 아니다) · 숫자(주기·상한)는 화면에 박지 않고 서버 값을 쓴다 · 문구에 백틱·별표 없음.
 */

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 서버 목록을 믿을 수 있는 모양으로 좁힌다(객체·vcenterId 문자열만). */
export function vcLogCollectItems(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && x.vcenterId != null && String(x.vcenterId) !== '');
}

/**
 * 표 행 — 서버 collect 목록이 없으면(구버전 서버) 보관 건수 목록(store.vcenters)만으로 만든다(수집 칸은 '—').
 * 둘 다 있으면 vcenterId 로 합친다(collect 가 건수·마지막 저장을 이미 싣지만 없을 때는 store 값으로 채운다).
 */
export function vcLogCollectRows(st) {
  const byId = new Map();
  for (const v of vcLogCollectItems(st?.store?.vcenters)) byId.set(String(v.vcenterId), { vcenterId: String(v.vcenterId), count: num(v.count), lastStoredTs: pos(v.lastTs) });
  for (const c of vcLogCollectItems(st?.collect)) {
    const id = String(c.vcenterId);
    const base = byId.get(id) || { vcenterId: id, count: null, lastStoredTs: null };
    byId.set(id, { ...base, count: num(c.count) ?? base.count, lastStoredTs: pos(c.lastStoredTs) ?? base.lastStoredTs, ...pickCollect(c) });
  }
  return [...byId.values()].sort((a, b) => (a.vcenterId < b.vcenterId ? -1 : a.vcenterId > b.vcenterId ? 1 : 0));
}
function pickCollect(c) {
  const p = c.lastPoll && typeof c.lastPoll === 'object' ? c.lastPoll : null;
  return {
    okAt: pos(c.okAt), cursorTs: pos(c.cursorTs), lagMs: nonneg(c.lagMs), capped: c.capped === true ? true : c.capped === false ? false : null,
    ended: typeof c.ended === 'string' ? c.ended : null, consecutiveCapped: nonneg(c.consecutiveCapped), ratePerMin: nonneg(c.ratePerMin),
    state: typeof c.state === 'string' ? c.state : null, restored: c.restored === true,
    read: p ? nonneg(p.read) : null, stored: p ? nonneg(p.stored) : null, ms: p ? nonneg(p.ms) : null, deadlineMs: p ? pos(p.deadlineMs) : null,
    rounds: p ? nonneg(p.rounds) : null, error: p && typeof p.error === 'string' && p.error ? p.error : null, errorHidden: p?.errorHidden === true,
    budgetMs: p ? pos(p.budgetMs) : null, hint: p && typeof p.hint === 'string' && p.hint ? p.hint : null,   // v2.764(재검토 2-c)
  };
}

/** v2.764(2-c): 서버 진단 힌트 → 안내 문구. 'timeout' = 첫 묶음도 못 받고 시한에 걸렸다(13일치 beginTime 의 첫 쪽이 느린 vCenter). 모르면 ''. */
export const VCLOG_HINT_TEXT = Object.freeze({ timeout: '시한 안에 첫 묶음도 못 읽었습니다 — 요청 시한(vCenter 관리 › timeoutMs)을 올리세요' });
export function vcLogHintText(row) { return (row && typeof row === 'object' && VCLOG_HINT_TEXT[row.hint]) || ''; }
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const nonneg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };

/** 상태 코드 → 표기. 서버 state 가 없으면(이번 주기 기록 없음) '—'. */
export const VCLOG_STATE_TEXT = Object.freeze({ 'catching-up': '따라잡기 중', stalled: '정체', ok: '정상', failed: '실패' });
export const VCLOG_STATE_CLASS = Object.freeze({ 'catching-up': 'amber', stalled: 'red', ok: 'green', failed: 'red' });
export function vcLogStateText(state) { return VCLOG_STATE_TEXT[state] || '—'; }
export function vcLogStateClass(state) { return VCLOG_STATE_CLASS[state] || 'gray'; }

/** 지연 문구 — '3일 4시간' · '5시간' · '12분' · '1분 미만'. 모르면 '—'. */
export function vcLogLagText(lagMs) {
  const n = nonneg(lagMs);
  if (n == null) return '—';
  if (n < 60_000) return '1분 미만';
  if (n < HOUR_MS) return `${Math.floor(n / 60_000)}분`;
  if (n < DAY_MS) return `${Math.floor(n / HOUR_MS)}시간`;
  const d = Math.floor(n / DAY_MS); const h = Math.floor((n % DAY_MS) / HOUR_MS);
  return h ? `${d}일 ${h}시간` : `${d}일`;
}
/** 1일을 넘는 지연은 호박색으로 강조한다(루트 규칙 — 지연 1일 초과 콘솔 경고와 같은 문턱). */
export function vcLogLagWarn(lagMs) { const n = nonneg(lagMs); return n != null && n > DAY_MS; }

/** 상한 칸 — 왜 끝까지 읽지 못했는지. ended 가 없으면 capped 불리언으로. */
// v2.764(재검토): budget = 시간 예산(주기의 80%)에서 멈춤 · batch = 묶음 사이에서 멈춤(적재 실패 등 — 뒤가 남았다)
export const VCLOG_ENDED_TEXT = Object.freeze({ max: '상한', pages: '쪽 수 한도', aborted: '시한', budget: '예산', batch: '중단', empty: '아니오' });
export function vcLogCappedText(row) {
  if (!row || typeof row !== 'object') return '—';
  if (row.ended && VCLOG_ENDED_TEXT[row.ended]) return row.capped === false && row.ended !== 'empty' ? '아니오' : VCLOG_ENDED_TEXT[row.ended];
  if (row.capped === true) return '상한';
  if (row.capped === false) return '아니오';
  return '—';
}

/** 읽음/저장 — '4,000 / 3,990'. 둘 다 모르면 '—'. 회차가 2 이상이면 '(3회)' 를 붙인다. */
export function vcLogReadStoredText(row, fmt = (n) => Number(n).toLocaleString()) {
  if (!row || (row.read == null && row.stored == null)) return '—';
  const r = row.read == null ? '—' : fmt(row.read);
  const s = row.stored == null ? '—' : fmt(row.stored);
  const rounds = row.rounds != null && row.rounds > 1 ? ` (${row.rounds}회)` : '';
  return `${r} / ${s}${rounds}`;
}

/** 소요/시한 — '12초 / 60초'. 소요를 모르면 '—'. 시한을 모르면(데모) 소요만. */
export function vcLogDurText(row) {
  if (!row || row.ms == null) return '—';
  const sec = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms / 1000)}초`);
  return row.deadlineMs != null ? `${sec(row.ms)} / ${sec(row.deadlineMs)}` : sec(row.ms);
}

/**
 * 한 주기 상한 안내 — 설정값과 실효 상한(수집기 한도로 잘린 값)을 함께. 서버 값이 없으면(구버전) 설정값만.
 * v2.764(재검토 1-c): 서버가 묶음 수집(catchup.streaming·batchRows)이면 상한은 수집 상한이 아니다 — '시간 예산(주기의 N%) 안에서 묶음으로 한 세션에 이어
 *   읽는다' 를 말한다(건수 상한 문구를 그대로 두면 설정값이 수집을 자른다고 오해한다). 옛 서버(maxRounds)는 예전 문구.
 */
export function vcLogMaxPerPollText(st, fmt = (n) => Number(n).toLocaleString()) {
  const set = pos(st?.settings?.maxPerPoll);
  const eff = pos(st?.maxPerPollEffective);
  const colMax = pos(st?.collectorMaxEvents);
  if (set == null && eff == null) return '';
  const ratio = pos(st?.catchup?.ratio); const r = pos(st?.catchup?.maxRounds); const batch = pos(st?.catchup?.batchRows);
  if (st?.catchup?.streaming === true || batch != null) {
    const parts = [];
    if (ratio != null) parts.push(`주기의 ${Math.round(ratio * 100)}% 시간 예산 안에서`);
    if (batch != null) parts.push(`${fmt(batch)}건씩`);
    return `vCenter 마다 ${parts.length ? `${parts.join(' ')} ` : ''}한 세션으로 이어 읽어 적재합니다(로그인은 주기에 1회). 한 번에 읽는 건수 상한은 없고 시간 예산이 끝을 정합니다.`;
  }
  let s = `한 주기 상한(maxPerPoll): 설정 ${set == null ? '—' : `${fmt(set)}건`}`;
  if (eff != null && set != null && eff < set) s += ` · 실효 ${fmt(eff)}건${colMax != null ? `(수집기 한도 ${fmt(colMax)}건)` : ''}`;
  else if (eff != null && set == null) s += ` · 실효 ${fmt(eff)}건`;
  if (ratio != null || r != null) {
    const parts = [];
    if (ratio != null) parts.push(`주기의 ${Math.round(ratio * 100)}% 안`);
    if (r != null) parts.push(`최대 ${fmt(r)}회`);
    s += `. 상한에 걸린 vCenter 는 같은 주기 안에서 이어 읽습니다(${parts.join(' · ')})`;
  }
  return `${s}.`;
}
