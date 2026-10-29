/**
 * vcLogCollect.js — 설정 › vCenter 로그 보관의 'vCenter 별 수집 상태' 표 문구·판정 한 벌(v2.765 — 실서버 OC2 이벤트 수집 13일 정체, 순수 · vitest).
 *
 * 서버(logs/poller.js logCollectDiag)가 `collect:[{ vcenterId, count, lastStoredTs, cursorTs, okAt, capped, ended, lagMs, lastPoll, consecutiveCapped,
 * ratePerMin, state }]` 로 싣고, 범위 계정에는 scopeVcLogStatus 가 범위 밖 vCenter 와 오류 원문을 지운다. 이 모듈은 그 값을 표 칸 문구로 바꾼다.
 * 규칙: 값이 없으면 '—'(0 이 아니다) · 숫자(주기·상한)는 화면에 박지 않고 서버 값을 쓴다 · 문구에 백틱·별표 없음.
 * v2.772(Z1-1·Z1-2·Z1-4·Z2-I1·Z1 I-1·I-2): 서버가 running(진행 중 — 그 행의 읽음/저장·상태는 직전에 끝난 주기) · skip(주기 수집에서 빼는 이유) ·
 *   firstTs(그 vCenter 의 가장 오래된 보관 로그) · lastPoll.okAtStart·okAtEnd·everyMs(따라잡기 진척) 를 더 싣는다.
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
    budgetMs: p ? pos(p.budgetMs) : null, hint: p && typeof p.hint === 'string' && p.hint ? p.hint : null,   // v2.765(재검토 2-c)
    // v2.772: 진행 중(Z1-1) · 수집 제외 사유(Z1-4) · 가장 오래된 로그(Z2-I1) · 따라잡기 진척 근거(I-1)
    running: c.running && typeof c.running === 'object' ? { since: pos(c.running.since), read: nonneg(c.running.read), stored: nonneg(c.running.stored), rounds: nonneg(c.running.rounds) } : null,
    skip: typeof c.skip === 'string' && c.skip ? c.skip : null, firstTs: pos(c.firstTs),
    okAtStart: p ? pos(p.okAtStart) : null, okAtEnd: p ? pos(p.okAtEnd) : null, everyMs: p ? pos(p.everyMs) : null,
  };
}

/** v2.765(2-c): 서버 진단 힌트 → 안내 문구. 'timeout' = 첫 묶음도 못 받고 시한에 걸렸다(13일치 beginTime 의 첫 쪽이 느린 vCenter). 모르면 ''. */
export const VCLOG_HINT_TEXT = Object.freeze({ timeout: '시한 안에 첫 묶음도 못 읽었습니다 — 요청 시한(vCenter 관리 › timeoutMs)을 올리세요' });
export function vcLogHintText(row) { return (row && typeof row === 'object' && VCLOG_HINT_TEXT[row.hint]) || ''; }
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const nonneg = (v) => { const n = num(v); return n != null && n >= 0 ? n : null; };

/**
 * 상태 코드 → 표기. 서버 state 가 없으면(이번 주기 기록 없음) '—'.
 * v2.772(Z1-4·I-3): 'auth-stopped'(인증 정지 — 주기 수집에서 건너뜀) · 'not-collected'(직접 수집 대상 아님). 서버 콘솔(logs/poller.js COLLECT_STATE_TEXT)과 같은 말.
 */
export const VCLOG_STATE_TEXT = Object.freeze({ 'catching-up': '따라잡기 중', stalled: '정체', ok: '정상', failed: '실패', 'auth-stopped': '인증 정지', 'not-collected': '수집 안 함' });
export const VCLOG_STATE_CLASS = Object.freeze({ 'catching-up': 'amber', stalled: 'red', ok: 'green', failed: 'red', 'auth-stopped': 'red', 'not-collected': 'gray' });
export function vcLogStateText(state) { return VCLOG_STATE_TEXT[state] || '—'; }
export function vcLogStateClass(state) { return VCLOG_STATE_CLASS[state] || 'gray'; }
/** v2.772(Z1-4): 수집 제외 사유 → 안내(상태 칸 툴팁). 모르면 ''. */
export const VCLOG_SKIP_TEXT = Object.freeze({
  'auth-stopped': '인증 실패로 멈춘 vCenter 입니다 — 주기 수집에서 건너뜁니다(vCenter 관리에서 계정·비밀번호를 확인하세요).',
  disabled: '관리자가 끈 vCenter 입니다 — 이 포탈은 수집하지 않습니다.',
  maintenance: '점검중인 vCenter 입니다 — 수집을 멈췄습니다.',
  site: '엣지에 위임한 vCenter 입니다 — 이 포탈은 수집하지 않습니다(로그는 엣지가 보관합니다).',
});
export function vcLogSkipText(row) { return (row && typeof row === 'object' && VCLOG_SKIP_TEXT[row.skip]) || ''; }
/**
 * v2.772(Z1 I-2): 상태 칸 정렬 값 — 심각도 순(오름차순이면 실패·인증 정지·정체가 위). 예전 data-sort 는 코드 문자열이라 '정체'(빨강)가 '정상' 뒤였다.
 *   상태를 모르면 ''(STable 이 항상 뒤로).
 */
export const VCLOG_STATE_RANK = Object.freeze({ failed: 0, 'auth-stopped': 1, stalled: 2, 'catching-up': 3, 'not-collected': 4, ok: 5 });
export function vcLogStateSort(row) { const r = VCLOG_STATE_RANK[row?.state]; return Number.isInteger(r) ? r : ''; }
/**
 * v2.772(Z1-1): 진행 중 문구 — '수집 중 · 읽음 1,200 / 저장 1,200(묶음 12)'. 진행 중이 아니면 ''.
 *   그 행의 읽음/저장·소요·상태는 **직전에 끝난 주기** 값이다(서버 lastPoll) — 진행분은 여기서만 말한다.
 */
export function vcLogRunningText(row, fmt = (n) => Number(n).toLocaleString()) {
  const r = row && typeof row === 'object' ? row.running : null;
  if (!r) return '';
  const rounds = r.rounds != null && r.rounds > 1 ? `(묶음 ${fmt(r.rounds)})` : '';
  return `수집 중 · 읽음 ${r.read == null ? '—' : fmt(r.read)} / 저장 ${r.stored == null ? '—' : fmt(r.stored)}${rounds}`;
}

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
// v2.765(재검토): budget = 시간 예산(주기의 80%)에서 멈춤 · batch = 묶음 사이에서 멈춤(적재 실패 등 — 뒤가 남았다)
export const VCLOG_ENDED_TEXT = Object.freeze({ max: '상한', pages: '쪽 수 한도', aborted: '시한', budget: '예산', batch: '중단', empty: '아니오' });
export function vcLogCappedText(row) {
  if (!row || typeof row !== 'object') return '—';
  // v2.772(Z1-1): 진행 중이면 서버 ended 는 진행분의 중간 묶음('batch')이다 — '중단' 이 아니라 '진행 중'.
  if (row.running) return '진행 중';
  if (row.ended && VCLOG_ENDED_TEXT[row.ended]) return row.capped === false && row.ended !== 'empty' ? '아니오' : VCLOG_ENDED_TEXT[row.ended];
  if (row.capped === true) return '상한';
  if (row.capped === false) return '아니오';
  return '—';
}

/**
 * 읽음/저장 — '4,000 / 3,990'. 둘 다 모르면 '—'. 묶음이 2 이상이면 '(묶음 3)' 을 붙인다.
 * v2.772(Z1 I-2): 예전 '(3회)' 는 실제로는 한 세션 안의 묶음(batchRows 건) 수였다 — '묶음' 으로. (Z1-1) 진행 중이면 이 값은 직전 주기 — '직전 ' 을 앞에.
 */
export function vcLogReadStoredText(row, fmt = (n) => Number(n).toLocaleString()) {
  if (!row || (row.read == null && row.stored == null)) return '—';
  const r = row.read == null ? '—' : fmt(row.read);
  const s = row.stored == null ? '—' : fmt(row.stored);
  const rounds = row.rounds != null && row.rounds > 1 ? ` (묶음 ${fmt(row.rounds)})` : '';
  return `${row.running ? '직전 ' : ''}${r} / ${s}${rounds}`;
}

/** 소요/시한 — '12초 / 60초'. 소요를 모르면 '—'. 시한을 모르면(데모) 소요만. */
export function vcLogDurText(row) {
  if (!row || row.ms == null) return '—';
  const sec = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms / 1000)}초`);
  const t = row.deadlineMs != null ? `${sec(row.ms)} / ${sec(row.deadlineMs)}` : sec(row.ms);
  return row.running ? `직전 ${t}` : t;
}

/** v2.772(Z1-2): 보관 건수 집계 시각(서버 store.countsAt — 건수는 최대 5분 캐시) → '3분 전 집계' · '방금 집계'. 모르면 ''. */
export function vcLogCountsAtText(countsAt, now = Date.now()) {
  const t = pos(countsAt);
  if (t == null) return '';
  const d = Math.max(0, now - t);
  return d < 60_000 ? '방금 집계' : `${vcLogLagText(d)} 전 집계`;
}

/**
 * v2.772(Z1 I-1): 따라잡기 진척 — 지난 주기에 온전한 시각이 얼마나 나아갔는가(okAtEnd − okAtStart)에서 주기 간격(everyMs — 그동안 새로 쌓이는 시간)을 뺀 것이
 *   주기당 순진척이다. 양수면 '주기마다 N 따라잡음 · 약 M 뒤 완료(추정)', 0 이하면 '생성 속도를 못 따라감'. 따라잡기·정체 상태에서만 말하고, 근거가 없으면 '—'.
 *   추정의 한계: 주기가 밀려(busy) 실제 간격이 길면 낙관적이다 · 지난 한 주기 속도만 본다.
 */
export function vcLogCatchupText(row) {
  if (!row || typeof row !== 'object' || (row.state !== 'catching-up' && row.state !== 'stalled')) return '';
  const a = row.okAtStart; const b = row.okAtEnd; const every = row.everyMs;
  if (a == null || b == null || every == null) return '따라잡기 진척 —';
  const net = (b - a) - every;
  if (net <= 0) return `따라잡기 진척: 생성 속도를 못 따라갑니다(지난 주기 기준 주기마다 지연 ${vcLogLagText(-net)} 증가 — 추정)`;
  const lag = nonneg(row.lagMs);
  const eta = lag == null ? '—' : `약 ${vcLogLagText((lag / net) * every)} 뒤`;
  return `따라잡기 진척: 주기마다 ${vcLogLagText(net)} 따라잡음 · 완료 예상 ${eta}(지난 주기 속도 기준 추정)`;
}

/**
 * v2.772(Z2-I1): 용량 상한이 실제 보관 기간을 정하고 있다는 안내. 화면에는 '보관 기간 365일' 만 보여 용량 상한(사용 중 크기)이 며칠 만에
 *   오래된 로그를 지우는 사실이 드러나지 않았다. 마지막 용량 정리(lastCap)가 지운 것이 있고 그 상한이 지금 설정과 같을 때만 말한다.
 *   가장 오래된 로그는 store.firstTs(전체 범위) 또는 표 행 firstTs 의 최솟값(범위 계정 — 전 법인 값은 오지 않는다). 모르면 '—'.
 */
export function vcLogCapNoteText(st, rows = [], { now = Date.now(), fmtTime = (ts) => new Date(ts).toLocaleString('ko-KR') } = {}) {
  const cap = st?.lastCap;
  const mb = pos(st?.settings?.maxSizeMB);
  if (!cap || typeof cap !== 'object' || !(nonneg(cap.dropped) > 0) || mb == null || pos(cap.limitBytes) !== mb * 1024 * 1024) return '';
  let oldest = pos(st?.store?.firstTs);
  if (oldest == null) for (const r of Array.isArray(rows) ? rows : []) { const t = pos(r?.firstTs); if (t != null && (oldest == null || t < oldest)) oldest = t; }
  const days = pos(st?.settings?.retentionDays);
  const span = oldest == null ? null : Math.max(0, now - oldest);
  const shorter = span != null && days != null && span < days * DAY_MS ? `, 설정 보관 ${days.toLocaleString()}일보다 짧음` : '';
  const oldestTxt = oldest == null ? '가장 오래된 로그 —' : `가장 오래된 로그 ${fmtTime(oldest)}(약 ${vcLogLagText(span)} 전${shorter})`;
  const tail = cap.stuck === true ? ' — 지웠지만 사용 중 크기가 줄지 않아 멈췄습니다' : cap.done === false ? ' — 아직 상한을 넘어 다음 주기에 이어 지웁니다' : '';
  const at = pos(cap.at);
  return `용량 상한(${mb.toLocaleString()}MB)이 실제 보관 기간을 정하고 있습니다 — ${oldestTxt} · 마지막 용량 정리 ${at == null ? '—' : fmtTime(at)}에 ${Number(cap.dropped).toLocaleString()}건 삭제${tail}.`;
}

/**
 * 한 주기 상한 안내 — 설정값과 실효 상한(수집기 한도로 잘린 값)을 함께. 서버 값이 없으면(구버전) 설정값만.
 * v2.765(재검토 1-c): 서버가 묶음 수집(catchup.streaming·batchRows)이면 상한은 수집 상한이 아니다 — '시간 예산(주기의 N%) 안에서 묶음으로 한 세션에 이어
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
