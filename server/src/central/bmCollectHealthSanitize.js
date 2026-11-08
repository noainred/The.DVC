/**
 * central/bmCollectHealthSanitize.js — 엣지 봉투의 **수집 건강**(`collectHealth` — 6단계) 정제(순수 · 화이트리스트).
 *
 * 규약(edge.md — 엣지가 보낸 것은 정제한다): 아는 필드만 · 객체만 · 수는 numOrNull(문자열 수치는 수로 · 못 읽으면 null — 0 으로 두지 않는다) ·
 *   사유 code · 칸 · 상태는 열거 밖이면 버린다 · 법인 id 는 형식 검사 · 상한(사유 32 · 법인 64 · 추이 200점) · 엣지 시각은 수신 시각으로 자른다(clampEdgeTs).
 *   ⚠ 중앙은 다시 판정하지 않는다 — cells(기준 대조)는 엣지가 만든 것을 열거로만 거른다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { strOf } from '../util/coercionTrap.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { HEALTH_REASON_CODES, NODE_FLAGS, NODE_ERRORS } from '../bmusage/collectHealth.js';
import { PEAK_PLAN_REASONS } from '../bmusage/peakPlan.js';
import { FAMILIES } from '../bmusage/monthStore.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const CODES = new Set(HEALTH_REASON_CODES);
const PATHS = new Set(['os', 'idrac']);
const STATES = new Set(['auth', 'osOnly', 'osOnlyUnread', 'idracOnlyUnread']);
const CELL = new Set(['true', 'false', 'unread']);
const VC_RE = /^[A-Za-z0-9._:@-]{0,128}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const N = numOrNull;

function cleanNode(x, now) {
  if (!isObj(x)) return null;
  const reasons = (Array.isArray(x.reasons) ? x.reasons : []).slice(0, 32).filter(isObj)
    .filter((r) => PATHS.has(r.path) && CODES.has(r.code))
    .map((r) => ({ path: r.path, code: r.code, n: N(r.n), since: clampEdgeTs(N(r.since), now), state: STATES.has(r.state) ? r.state : null }));
  const info = isObj(x.info) ? { 'no-telemetry': N(x.info['no-telemetry']), first: N(x.info.first), 'psi-absent': N(x.info['psi-absent']) } : null;
  // 폴더를 못 읽은 노드는 가족 값이 null(모름 — 0개 0KB 가 아니다 · 반증 F5)
  const fams = isObj(x.db?.families) ? {} : null;
  if (isObj(x.db?.families)) for (const f of Object.keys(FAMILIES)) { const v = x.db.families[f]; if (isObj(v)) fams[f] = { files: N(v.files), bytes: N(v.bytes), first: v.first == null ? null : strOf(v.first, 10), last: v.last == null ? null : strOf(v.last, 10) }; }
  const cells = {};
  if (isObj(x.cells)) for (const k of NODE_FLAGS) if (CELL.has(x.cells[k])) cells[k] = x.cells[k];
  return {
    at: clampEdgeTs(N(x.at), now), cycleMs: N(x.cycleMs), budgetMs: N(x.budgetMs), cyclePct: N(x.cyclePct),
    servers: N(x.servers), ok: N(x.ok), fail: N(x.fail), successPct: N(x.successPct), reasons, info,
    conc: isObj(x.conc) ? { max: N(x.conc.max), cap: N(x.conc.cap) } : null,
    ssh: isObj(x.ssh) ? { n: N(x.ssh.n), p50Ms: N(x.ssh.p50Ms), p95Ms: N(x.ssh.p95Ms) } : null,
    focus: isObj(x.focus) ? { running: N(x.focus.running), queued: N(x.focus.queued) } : null,
    peakPlan: isObj(x.peakPlan) ? { windowS: N(x.peakPlan.windowS), capS: N(x.peakPlan.capS), reason: PEAK_PLAN_REASONS.includes(x.peakPlan.reason) ? x.peakPlan.reason : null, expectedMs: N(x.peakPlan.expectedMs), budgetMs: N(x.peakPlan.budgetMs) } : null,
    db: isObj(x.db) ? { mainBytes: N(x.db.mainBytes), walBytes: N(x.db.walBytes), files: N(x.db.files), bytes: N(x.db.bytes), ...(N(x.db.unread) ? { unread: N(x.db.unread) } : {}), ...(x.db.error ? { error: 'readdir' } : {}), ...(x.db.partial === true ? { partial: true } : {}), families: fams } : null,
    dbPct: N(x.dbPct), capBytes: N(x.capBytes), cells,
    // 8a단계 정비 창: 건너뜀(④) · 창 안 실패 · 창 끝 뒤 억제(leak — 0 이어야 정상) · 판정 입력 상태(수만 · 표지만).
    ...(isObj(x.maint) ? { maint: { skipped: N(x.maint.skipped), failInWindow: N(x.maint.failInWindow), leak: N(x.maint.leak), checked: N(x.maint.checked), windows: N(x.maint.windows),
      ...(x.maint.localUnreadable === true ? { localUnreadable: true } : {}), ...(x.maint.judge === 'unavailable' ? { judge: 'unavailable' } : {}),
      ...(isObj(x.maint.deployed) ? { deployed: { n: N(x.maint.deployed.n), stale: x.maint.deployed.stale === true, at: clampEdgeTs(N(x.maint.deployed.at), now), ...(x.maint.deployed.unreadable === true ? { unreadable: true } : {}) } } : {}) } } : {}),
    th: isObj(x.th) ? { cyclePct: N(x.th.cyclePct), successPct: N(x.th.successPct), dbPct: N(x.th.dbPct), dbCapGb: N(x.th.dbCapGb) } : null,
    // 주기 오류는 열거 code 만(엣지 원문을 싣지 않는다 — 모르는 값은 ‘수집 건강 계산 실패’ 로 본다 · 반증 F1).
    ...(x.error ? { error: NODE_ERRORS.includes(x.error) ? x.error : 'health-failed' } : {}), ...(x.recordError ? { recordError: strOf(x.recordError, 160) } : {}),
  };
}
/** 봉투 collectHealth → 중앙 보관 모양(모르는 형식이면 null). */
export function sanitizeCollectHealth(h, now = Date.now()) {
  if (!isObj(h)) return null;
  const node = cleanNode(h.node, now);
  if (!node) return null;
  const byCorp = {};
  let corps = 0;
  if (isObj(h.byCorp)) {
    for (const vc of Object.keys(h.byCorp)) {
      if (corps >= 64) break;
      const c = h.byCorp[vc];
      if (BAD_KEYS.has(vc) || !VC_RE.test(vc) || !isObj(c)) continue;
      const reasons = {};
      if (isObj(c.reasons)) for (const k of Object.keys(c.reasons).slice(0, 32)) { const [p, code] = k.split(':'); if (PATHS.has(p) && CODES.has(code)) reasons[`${p}:${code}`] = N(c.reasons[k]); }
      byCorp[vc] = { servers: N(c.servers), ok: N(c.ok), fail: N(c.fail), reasons, ...(N(c.maintSkipped) != null ? { maintSkipped: N(c.maintSkipped) } : {}), ...(N(c.maintFail) != null ? { maintFail: N(c.maintFail) } : {}) };
      corps += 1;
    }
  }
  const trend = (Array.isArray(h.trend) ? h.trend : []).slice(-200).filter(isObj).map((p) => ({ t: clampEdgeTs(N(p.t), now), maxMs: N(p.maxMs), budgetMs: N(p.budgetMs), minOkPct: N(p.minOkPct), concMax: N(p.concMax), cycles: N(p.cycles) }))
    .filter((p) => p.t != null);
  return { v: 1, at: clampEdgeTs(N(h.at), now), node, byCorp, trend, sinceFrom: clampEdgeTs(N(h.sinceFrom), now) };
}
