/**
 * central/bmIdleSanitize.js — 리눅스 성능 8b단계 **저활용 결과(봉투 idle)** 중앙 정제(순수).
 *
 * 규약(edge.md ‘엣지가 보낸 것은 정제한다’): 아는 필드만 · 객체만 · 상한(행 20,000 · 이력 62일) · 문자열 수치는 수로(numOrNull — 못 읽으면 null, 0 으로 두지 않는다) ·
 *   상태 · 제외 사유 · 뺀 지표는 열거 밖이면 버린다(상태가 이상한 행은 통째로) · 점수는 0~100 정수 · 등급은 0 · 0.5 · 1 · null ·
 *   서버 키는 **같은 봉투의 대상 목록 안**만(남의 서버 행을 끼워 넣지 못한다) · 이름 · 법인은 행이 아니라 대상 목록에서 붙인다(라우트) · 엣지 시각은 수신 시각으로 자른다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { IDLE_STATUS, IDLE_EXCLUDE, IDLE_METRICS } from '../bmusage/idleConst.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const N = numOrNull;
const STATUS = new Set(IDLE_STATUS);
const EXCL = new Set(IDLE_EXCLUDE);
const MET = new Set(IDLE_METRICS);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);
const grade = (v) => (v === 0 || v === 0.5 || v === 1 ? v : null);
const score = (v) => { const x = N(v); return x != null && Number.isInteger(x) && x >= 0 && x <= 100 ? x : null; };
const CFG_KEYS = ['windowDays', 'minDays', 'candidate', 'watch', 'wCpu', 'wMem', 'wDisk', 'wNet', 'wPower', 'wAct', 'cpuAvgPct', 'cpuMaxPct', 'memAvgPct', 'diskBusyMaxPct', 'netMaxPct', 'powerIdlePct', 'periodicHighPct'];
const MET_KEYS = ['cpuAvg', 'cpuMax', 'memAvg', 'diskMax', 'netMax', 'powerAvgW', 'powerMinW', 'powerHours', 'ssh', 'focus', 'snap'];

/** 한 행(순수) — 형식 밖이면 null. */
export function sanitizeIdleRow(r, targetKeys) {
  if (!isObj(r) || typeof r.key !== 'string' || !targetKeys.has(r.key) || !STATUS.has(r.status)) return null;
  const g = isObj(r.grades) ? r.grades : {};
  const m = isObj(r.metrics) ? r.metrics : {};
  return {
    key: capStr(r.key, 256), status: r.status, ...(r.status === 'excluded' ? { reason: EXCL.has(r.reason) ? r.reason : 'no-score' } : {}),
    score: score(r.score), days: N(r.days), excludedDays: N(r.excludedDays),
    grades: Object.fromEntries(IDLE_METRICS.map((k) => [k, grade(g[k])])),
    dropped: (Array.isArray(r.dropped) ? r.dropped : []).filter((x) => MET.has(x)).slice(0, 6),
    metrics: Object.fromEntries(MET_KEYS.map((k) => [k, N(m[k])])),
    ...(isObj(r.periodic) ? { periodic: { highDays: N(r.periodic.highDays), sameWeekday: r.periodic.sameWeekday === true } } : {}),
    ...(day(r.candSince) ? { candSince: day(r.candSince) } : {}), ...(day(r.candLeft) ? { candLeft: day(r.candLeft) } : {}),
  };
}

/** 봉투 idle → 중앙 보관 모양(순수). */
export function sanitizeIdleEnvelope(c, { targetKeys = new Set(), now = Date.now() } = {}) {
  if (!isObj(c)) return null;
  if (c.unreadable === true) return { unreadable: true, rows: [], dropped: 0 };
  const arr = Array.isArray(c.rows) ? c.rows : [];
  const rows = []; let dropped = 0;
  for (const r of arr.slice(0, 20_000)) { const x = sanitizeIdleRow(r, targetKeys); if (x) rows.push(x); else dropped += 1; }
  dropped += Math.max(0, arr.length - 20_000);
  const cfg = isObj(c.cfg) ? Object.fromEntries(CFG_KEYS.map((k) => [k, N(c.cfg[k])])) : null;
  const history = (Array.isArray(c.history) ? c.history : []).slice(-62).filter((h) => isObj(h) && day(h.day))
    .map((h) => ({ day: h.day, candidate: N(h.candidate), watch: N(h.watch), active: N(h.active), periodic: N(h.periodic), excluded: N(h.excluded) }));
  return { at: clampEdgeTs(N(c.at), now), day: day(c.day), firstDay: day(c.firstDay), cfg, rows, dropped, history, ...(typeof c.truncated === 'string' ? { truncated: c.truncated === 'non-active-only' ? 'non-active-only' : 'rows-cap' } : {}) };
}
