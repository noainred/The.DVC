/**
 * central/bmMaintCapSanitize.js — 8a단계 **엣지 봉투의 정비 창 상태 · 용량 예측 행 정제**(중앙 수신 — edge.md ‘엣지가 보낸 것은 정제한다’).
 *
 *   · 아는 필드만 · 객체만 · 상한(창 500 · 자원 행 20,000) · 문자열 수치는 수로(numOrNull — 못 읽으면 null, 0 으로 두지 않는다) ·
 *     열거(종류 · 상태 · 신뢰 · 사유)는 밖이면 버린다(행) 또는 null(칸) · 날짜는 'YYYY-MM-DD' 꼴만 · 창 id 는 mw- 꼴만 · 서명은 16진 32자만 ·
 *     엣지 시각은 수신 시각으로 자른다(clampEdgeTs) · **서버 키는 그 엣지가 같은 봉투로 보고한 대상 목록에 있는 것만**(남의 서버 행을 끼워 넣지 못한다).
 *   · 이 값은 표시 · 합산(억제 계수)용이다 — 중앙은 엣지 계수로 억제를 판정하지 않는다(판정은 각 노드의 maint/judge.js).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';
import { CAP_KINDS, CAP_STATUS, CAP_REASONS } from '../bmusage/capacity.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const N = numOrNull;
const ID_RE = /^mw-[a-z0-9]{6,32}$/;
const SIG_RE = /^[0-9a-f]{32}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(CAP_KINDS);
const STATUS = new Set(CAP_STATUS);
const CONF = new Set(['high', 'mid']);
const REASONS = new Set(CAP_REASONS);
const COUNT_KEYS = ['alerts', 'after', 'hold', 'focus', 'collect', 'collectFail'];
const txt = (v, n) => capStr(typeof v === 'string' ? v : '', n).replace(/[\u0000-\u001f\u007f]/g, ' ');
const day = (v) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);
const bool = (v) => v === true;

/** 정비 창 상태(봉투 maint) → 중앙 보관 모양(순수). */
export function sanitizeMaintEnvelope(m, rcv = Date.now()) {
  if (!isObj(m)) return null;
  const d = isObj(m.deployed) ? m.deployed : null;
  const byWindow = {};
  if (isObj(m.byWindow)) {
    for (const [id, c] of Object.entries(m.byWindow).slice(0, 500)) {
      if (!ID_RE.test(id) || !isObj(c)) continue;
      byWindow[id] = Object.fromEntries(COUNT_KEYS.map((k) => { const x = N(c[k]); return [k, x != null && x >= 0 ? Math.floor(x) : 0]; }));
    }
  }
  const lk = isObj(m.leak) ? m.leak : null;
  return {
    deployed: d ? { at: clampEdgeTs(N(d.at), rcv), sig: typeof d.sig === 'string' && SIG_RE.test(d.sig) ? d.sig : '', n: N(d.n), stale: bool(d.stale), ...(d.unreadable === true ? { unreadable: true } : {}) } : null,
    local: N(m.local), ...(m.localUnreadable === true ? { localUnreadable: true } : {}),
    byWindow,
    leak: lk ? { n: N(lk.n), last: N(lk.last), at: clampEdgeTs(N(lk.at), rcv) } : null,
  };
}

/** 용량 예측(봉투 capacity) → 중앙 보관 모양(순수). targetKeys = 같은 봉투의 대상 키. */
export function sanitizeCapacityEnvelope(c, { targetKeys = new Set(), now = Date.now() } = {}) {
  if (!isObj(c)) return null;
  if (c.unreadable === true) return { unreadable: true, rows: [], dropped: 0 };
  const arr = Array.isArray(c.rows) ? c.rows : [];
  const rows = []; let dropped = 0;
  for (const r of arr.slice(0, 20_000)) {
    if (!isObj(r) || typeof r.key !== 'string' || !targetKeys.has(r.key) || !KINDS.has(r.kind) || !STATUS.has(r.status)) { dropped += 1; continue; }
    rows.push({
      key: capStr(r.key, 256), kind: r.kind, res: txt(r.res, 256), status: r.status, reason: REASONS.has(r.reason) ? r.reason : null, grade: r.grade === 'ref' ? 'ref' : null,
      current: N(r.current), max30: N(r.max30), slope: N(r.slope), slope30: N(r.slope30), r2: N(r.r2), conf: CONF.has(r.conf) ? r.conf : null, n: N(r.n), targetPct: N(r.targetPct),
      daysToTarget: N(r.daysToTarget), dateToTarget: day(r.dateToTarget), daysTo100: N(r.daysTo100), dateTo100: day(r.dateTo100),
      beyondTarget: bool(r.beyondTarget), beyond100: bool(r.beyond100), reset: bool(r.reset), resetDay: day(r.resetDay), resets30: N(r.resets30), excluded: N(r.excluded), missing: N(r.missing), sizeBytes: N(r.sizeBytes), ...(N(r.dailyWin) ? { dailyWin: N(r.dailyWin) } : {}),
    });
  }
  dropped += Math.max(0, arr.length - 20_000);
  const cfg = isObj(c.cfg) ? { targetPct: N(c.cfg.targetPct), minDays: N(c.cfg.minDays) } : null;
  return { at: clampEdgeTs(N(c.at), now), day: day(c.day), cfg, rows, dropped, ...(typeof c.truncated === 'string' ? { truncated: ['rows-cap', 'forecast-only'].includes(c.truncated) ? c.truncated : 'rows-cap' } : {}) };
}
