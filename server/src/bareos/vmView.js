/**
 * bareos/vmView.js — Bareos 조회 판정 하나(v2.828 · 사용자 요청 'Bareos 백업 전용 화면 · 28개 법인 통합').
 *   쓰는 곳: Backup › Detail 의 'Bareos' 칸(routes/api/veeam.js detailData) · 법인별 현황(bareos-detail) · 통합 현황(bareos-summary).
 *   웹 views/tools/bareosViewText.js 가 같은 판정(bareosClass)을 한 벌 더 갖고 있다 — test/bareosViews2828.test.js 가 같은 입력으로 대조한다.
 *
 * 자료: 원장(registry.jobDigests — 폴러가 마지막으로 반영한 카탈로그 값)과 백업 표시(veeam/backupMarks — **사람이 정한** 백업 방식)뿐.
 *   요청 경로에서 Director 에 접속하지 않는다(고지연 법인이 화면을 늦추지 않게 — 루트 CLAUDE.md '운영 환경').
 *
 * 두 자료는 섞지 않는다(백업 방식은 사람이 정한 값만 — v2.803 규칙. 잡이 있다고 방식을 'bareos' 로 추정하지 않는다):
 *   · 미등록   = 방식 bareos ∧ 이 VM 의 잡 없음  → b = { job:false }
 *   · 방식 불일치 = 잡 있음 ∧ 방식 ≠ bareos       → b.job = true 이고 행의 method 가 bareos 가 아님(세는 쪽이 판정)
 *   · 표시 파일을 못 읽었으면(marksUnreadable) 미등록·불일치는 **모름(null)** 이다 — 0 이 아니다.
 */
import { isFinalStatus, statusOf } from './names.js';

const DAY = 86_400_000;
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
/** 기준 일수(오래된 백업) — Backup Detail 의 '오래된 백업 기준'(veeam/backupStatus RPO_DAYS)과 같은 값. */
export const BAREOS_RPO_DAYS = Object.freeze([1, 3, 7]);

/** 잡 실행 기록(lastRun · finishedRuns 한 줄)의 상태 — state 가 없으면 Bareos 글자에서 다시 푼다. */
const stateOf = (r) => (r ? (r.state || statusOf(r.status)) : null);

/**
 * 원장 잡 요약(jobDigests 한 줄) + 그 VM 의 백업 방식 → 화면 칸 b.
 *   잡 없음 + 방식 bareos → { job:false }(미등록) · 잡 없음 + 그 밖 → undefined(Bareos 와 무관 — 키를 싣지 않는다).
 *   잡 있음 → { job:true, on, gone?, missing?, st, at, lv, by, ok, run, runAt, err? }
 *     st  = 마지막으로 **끝난** 실행의 상태(ok·warning·error·canceled) · 끝난 실행이 없으면 null
 *     at  = 그 실행이 끝난 시각 · lv = 레벨 · by = 바이트(그 실행이 lastRun 일 때만 — finishedRuns 에는 바이트가 없다)
 *     ok  = 마지막으로 백업이 만들어진(T·W) 시각(registry.lastOkAt) · run = 지금 도는 실행의 상태(running·queued·waiting) 또는 null
 * @param {object|null|undefined} j  registry.jobDigests() 한 줄
 * @param {string} method  사람이 정한 백업 방식('' = 정하지 않음)
 */
export function bareosVmView(j, method = '') {
  if (!j) return method === 'bareos' ? { job: false } : undefined;
  const L = j.lastRun || null;
  const finished = [];
  if (L && isFinalStatus(L.status)) finished.push(L);
  for (const r of Array.isArray(j.recentRuns) ? j.recentRuns : []) if (r && isFinalStatus(r.status)) finished.push(r);
  let last = null;
  for (const r of finished) if (!last || (Number(r.jobid) || 0) > (Number(last.jobid) || 0)) last = r;
  const pend = j.pending ? (j.pending.state || statusOf(j.pending.status) || 'queued') : null;
  const liveRun = L && !isFinalStatus(L.status) && ['running', 'queued', 'waiting'].includes(stateOf(L)) ? stateOf(L) : null;
  const run = pend && pend !== 'unknown' ? pend : liveRun;
  return {
    job: true, on: j.enabled !== false,
    ...(j.missingInDirector ? { missing: true } : {}),
    st: last ? stateOf(last) : null,
    at: last && isFin(last.endedAt) ? last.endedAt : null,
    lv: last?.level || null,
    by: last && L && last.jobid === L.jobid && isFin(L.bytes) && L.bytes >= 0 ? L.bytes : null,
    ok: isFin(j.lastOkAt) ? j.lastOkAt : null,
    run: run || null,
    runAt: run && L && isFin(L.startedAt) && !isFinalStatus(L.status) ? L.startedAt : null,
    ...(j.lastError ? { err: true } : {}),
  };
}

/**
 * 칸 b 하나의 분류(화면 필터·수 세기 공용 — 웹 bareosViewText.bareosClass 와 한 쌍).
 *   b undefined(무관) · null(원장을 못 읽음 — 모름)이면 전부 false 이고 unknown 만 b===null.
 *   old = 마지막 백업이 기준 일수보다 오래됨(잡이 켜져 있고 백업이 한 번이라도 있을 때만 — 한 번도 없으면 never).
 */
export function bareosClass(b, { rpoDays = 1, now = Date.now() } = {}) {
  const days = BAREOS_RPO_DAYS.includes(Number(rpoDays)) ? Number(rpoDays) : 1;
  const job = !!b && b.job === true;
  const st = job ? b.st || null : null;
  return {
    unknown: b === null,
    job,
    missing: !!b && b.job === false,
    on: job && b.on !== false,
    off: job && b.on === false,
    ok: st === 'ok',
    warn: st === 'warning',
    fail: st === 'error' || st === 'canceled',
    run: job && !!b.run,
    never: job && !isFin(b.ok),
    old: job && b.on !== false && isFin(b.ok) && now - b.ok > days * DAY,
    gone: job && b.gone === true,
  };
}

/**
 * Director 상태(법인 한 줄) — 화면 점 색과 '결과를 믿을 수 있나' 를 정한다. 판정만(문구는 웹).
 *   unset   = 이 vCenter 를 묶은 Director 가 없거나 접속값이 비어 있음
 *   auth    = 인증 실패로 주기 조회 정지(bareosAuthGuard)
 *   error   = 마지막 조회 실패
 *   relay   = 엣지 대행 회신 대기(앞 결과는 그대로 유효)
 *   pending = 아직 조회 전(재시작 직후)
 *   ok      = 마지막 조회 성공
 * resultsKnown = 원장의 결과(성공·실패·오래됨)를 합계에 넣어도 되나 — unset·auth·error 는 '모름' 으로 따로 센다(0 이 아니다).
 */
export function directorState({ mapped, configured, authStopped, poll } = {}) {
  let state;
  if (!mapped || !configured) state = 'unset';
  else if (authStopped) state = 'auth';
  else if (!poll) state = 'pending';
  else if (poll.ok === false) state = 'error';
  else if (poll.ok == null && poll.relay === 'pending') state = 'relay';
  else if (poll.ok === true) state = 'ok';
  else state = 'pending';
  return { state, resultsKnown: !['unset', 'auth', 'error'].includes(state) };
}

/**
 * 법인(vCenter) 하나의 수 — rows 는 그 법인의 Bareos 관련 VM 행({ method, b }).
 *   marksKnown=false(표시 파일 손상) → 방식 기준 수(bareosMethod·missing·mismatch)는 null.
 *   resultsKnown=false(Director 조회 정지·실패·미설정) → 결과 기준 수(ok·warn·fail·never·old·run)는 null 이고 unknown = 잡 수.
 *   잡 수(jobs·on·off·gone)는 원장만 보면 알므로 늘 센다. 원장을 못 읽었으면(registryKnown=false) 잡 기준 수도 null.
 */
export function corpCounts(rows, { marksKnown = true, resultsKnown = true, registryKnown = true, rpoDays = 1, now = Date.now() } = {}) {
  const c = { rows: 0, bareosMethod: 0, jobs: 0, on: 0, off: 0, gone: 0, missing: 0, mismatch: 0, ok: 0, warn: 0, fail: 0, never: 0, old: 0, run: 0, unknown: 0, gb: 0, gbUnknown: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    c.rows++;
    const k = bareosClass(r.b, { rpoDays, now });
    if (r.method === 'bareos') c.bareosMethod++;
    if (k.job) { c.jobs++; if (k.on) c.on++; else c.off++; if (k.gone) c.gone++; else if (r.method !== 'bareos') c.mismatch++; }   // 인벤토리에 없는 VM 은 방식을 정할 수 없어 불일치로 세지 않는다
    if (k.missing) c.missing++;
    if (k.ok) c.ok++; if (k.warn) c.warn++; if (k.fail) c.fail++; if (k.never && k.on) c.never++;   /* 버그 점검 S16: 웹 칩·우선 목록과 같은 판정(꺼진 잡은 '백업 없음' 으로 세지 않는다) */ if (k.old) c.old++; if (k.run) c.run++;
    if (isFin(r.gb) && r.gb >= 0) c.gb += r.gb; else if (!r.gone) c.gbUnknown++;
  }
  c.gb = Math.round(c.gb * 10) / 10;
  if (!marksKnown) { c.bareosMethod = null; c.missing = null; c.mismatch = null; }
  if (!registryKnown) { for (const k of ['jobs', 'on', 'off', 'gone', 'missing', 'mismatch']) c[k] = null; }
  if (!resultsKnown || !registryKnown) { c.unknown = registryKnown ? c.jobs : null; for (const k of ['ok', 'warn', 'fail', 'never', 'old', 'run']) c[k] = null; }
  return c;
}

/** 합계(여러 법인) — null 은 더하지 않고 그 칸을 '일부 모름' 으로 알린다(partial). 부분 합은 그렇다고 밝힌다(루트 CLAUDE.md). */
export function sumCounts(list) {
  const keys = ['rows', 'bareosMethod', 'jobs', 'on', 'off', 'gone', 'missing', 'mismatch', 'ok', 'warn', 'fail', 'never', 'old', 'run', 'unknown', 'gb', 'gbUnknown'];
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  const partial = {};
  for (const c of Array.isArray(list) ? list : []) for (const k of keys) { if (c?.[k] == null) partial[k] = true; else out[k] += c[k]; }
  out.gb = Math.round(out.gb * 10) / 10;
  return { ...out, partial };
}

/** 우선 확인 목록의 종류 순서(앞일수록 먼저) — 실패 → 미등록 → 오래됨 → 한 번도 없음. */
export const PRIORITY_KINDS = Object.freeze(['fail', 'missing', 'old', 'never']);
export const PRIORITY_MAX = 200;
const CRIT_RANK = { high: 0, mid: 1, low: 2 };
/** 행 하나가 들 우선 확인 종류(없으면 ''). 결과를 모르는 법인은 결과 기준 종류(fail·old·never)를 넣지 않는다. */
export function priorityKind(r, { resultsKnown = true, marksKnown = true, rpoDays = 1, now = Date.now() } = {}) {
  const k = bareosClass(r?.b, { rpoDays, now });
  if (resultsKnown && k.fail) return 'fail';
  if (marksKnown && k.missing) return 'missing';
  if (resultsKnown && k.old) return 'old';
  if (resultsKnown && k.never && k.on) return 'never';
  return '';
}
/** 우선 확인 정렬 — 중요도 상 → 중 → 하 → 없음, 같으면 종류 순서, 같으면 이름. */
export function priorityCmp(a, b) {
  const ca = CRIT_RANK[a.crit] ?? 3; const cb = CRIT_RANK[b.crit] ?? 3;
  if (ca !== cb) return ca - cb;
  const ka = PRIORITY_KINDS.indexOf(a.kind); const kb = PRIORITY_KINDS.indexOf(b.kind);
  if (ka !== kb) return ka - kb;
  return String(a.name || '').localeCompare(String(b.name || ''), 'en', { numeric: true });
}
