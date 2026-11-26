/**
 * vmpower/history.js — VM 한 대의 전원 이력 응답(GET /api/vms/:id/power-history · v3.39.0).
 *   구간(power_spans) + 끊김(power_gaps) + vCenter 전원 이벤트(로그 DB — VM 이름으로 찾음)를 spans.js buildTimeline 하나로 판정한다.
 *   같은 vCenter 에 같은 이름 VM 이 둘 이상이면 이벤트로 좁히지 않는다(이벤트 엔티티 키가 이름이라 구분할 수 없다).
 *   데모(mock) 스냅샷은 저장된 기록이 없으므로 mock/demo/vmPower.js 의 결정적 구간을 같은 판정에 넣는다.
 */
import { getLogsDb } from '../logs/db.js';
import { numOrNull } from '../util/numOrNull.js';
import { WATCH_EVERY_MS, GAP_MS, TRACK_GRAN_MS, EVENT_SLACK_MS, buildTimeline } from './spans.js';
import { powerDb, spansOfVm, gapsOf, watchOf } from './db.js';
import { demoPowerHistory } from '../mock/demo/vmPower.js';

const DAY = 86_400_000;
/** 한 번에 볼 수 있는 범위 상한(달력 12개월 + 여유). */
export const MAX_RANGE_MS = 400 * DAY;

/** 요청 범위 정규화 — 숫자가 아니면 기본(최근 366일), 상한을 넘으면 끝에서 자른다. */
export function normRange(fromQ, toQ, now) {
  let to = numOrNull(toQ);
  if (to == null || to > now) to = now;
  let from = numOrNull(fromQ);
  if (from == null || from >= to) from = to - 366 * DAY;
  if (to - from > MAX_RANGE_MS) from = to - MAX_RANGE_MS;
  return { from, to };
}

async function eventsOf(vcenterId, name, fromTs, toTs) {
  try {
    const db = await getLogsDb();
    if (!db || typeof db.powerEventsOf !== 'function') return { ok: false, rows: [] };
    return { ok: true, rows: db.powerEventsOf(String(vcenterId), String(name), fromTs, toTs) || [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

/**
 * @param {object} vm  스냅샷 VM 행 · @param {object} snap 스냅샷 · @param {{from?,to?,now?,admin?}} q
 *   admin = 관리자 판본(auth/demoGuest.js isAdminDetailUser) — 아니면 수행 계정 이름을 싣지 않고 userMasked(재검토 #6 · vcInfo · 만든 계정과 같은 규칙).
 */
export async function vmPowerHistory(vm, snap, { from: fromQ, to: toQ, now = Date.now(), admin = false } = {}) {
  const { from, to } = normRange(fromQ, toQ, now);
  const base = {
    ok: true, vmId: vm.id, name: vm.name || '', vcenterId: vm.vcenterId, now, from, to,
    powerState: vm.powerState || null,
    precision: { watchMs: WATCH_EVERY_MS, gapMs: GAP_MS, backfillMs: TRACK_GRAN_MS },
  };
  let spans; let gaps; let watch; let events = []; let eventsNote = null;
  // 템플릿은 켜지지 않는다 — 관측기도 템플릿을 기록하지 않는다(빈 달력 대신 이유를 말한다).
  if (vm.template) return { ...base, available: false, reason: '템플릿은 전원 상태를 기록하지 않습니다(켜지지 않는 VM 입니다).' };
  if (snap?.source === 'mock') {
    const d = demoPowerHistory(vm, now);
    ({ spans, gaps, watch, events } = d);
    return { ...base, available: true, demo: true, watch, eventsUsed: events.length > 0, ...finish({ spans, gaps, events, watch, now, from, to, admin }) };
  }
  if (!(await powerDb())) return { ...base, available: false, reason: '전원 기록 DB 를 쓸 수 없습니다(node:sqlite 없음 또는 추적 DB 초기화 실패).' };
  spans = await spansOfVm(vm.vcenterId, vm.id) || [];
  watch = await watchOf(vm.vcenterId);
  const first = spans.length ? spans[0].start : now;
  gaps = await gapsOf(vm.vcenterId, Math.min(first, from));
  const sameName = (snap?.vms || []).filter((v) => v && v.vcenterId === vm.vcenterId && v.name === vm.name).length;
  if (vm.name && sameName === 1 && spans.length) {
    const ev = await eventsOf(vm.vcenterId, vm.name, first - EVENT_SLACK_MS - DAY, now);
    events = ev.rows;
    if (!ev.ok) eventsNote = 'unavailable';
  } else if (sameName > 1) eventsNote = 'duplicate-name';
  // 엣지 위임(site) vCenter 의 이벤트 로그는 법인 엣지가 보관한다 — 중앙에서는 이벤트로 좁힐 수 없다(재검토 #8 · logs/poller.js 와 같은 판정).
  const vc = (snap?.vcenters || []).find((x) => x && String(x.id) === String(vm.vcenterId));
  if (!events.length && (vc?.collectMode === 'site' || vc?.collectSource === 'site')) eventsNote = 'site';
  return { ...base, available: true, watch, eventsUsed: events.length > 0, eventsNote, ...finish({ spans, gaps, events, watch, now, from, to, admin }) };
}

/** 화면 범위 안 전환을 몇 건까지 싣는가 — 넘으면 최신부터 싣고 transitionsInRange(전체 수)와 transitionsTruncated 를 밝힌다(재검토 #1). */
export const TRANSITIONS_CAP = 2000;

function maskUsers(obj) {
  if (obj && typeof obj === 'object' && 'user' in obj) obj.user = '';
}

function finish({ spans, gaps, events, watch, now, from, to, admin }) {
  const t = buildTimeline({ spans, gaps, events, now, watchLast: watch?.lastTs ?? null, from, to, floor: watch?.prunedTo ?? null });
  // 소급 구간의 끝은 실시간 관측을 시작한 시각(power_watch.first_ts)이다.
  if (t.facts.backfill && watch?.firstTs) t.facts.backfill.to = watch.firstTs;
  // 전환은 **화면 범위 안**만 싣는다(이전 12개월 창에서 최신 500건만 와 '전원이 바뀐 적이 없다' 로 보였다 — 재검토 #1).
  const inRange = t.transitions.filter((x) => x.ts >= from && x.ts <= to);
  const transitions = inRange.slice(0, TRANSITIONS_CAP);
  let userMasked = false;
  if (!admin) {
    const had = transitions.some((x) => x.user) || ['current', 'firstOn', 'lastOn', 'lastOff'].some((k) => t.facts[k]?.user);
    for (const x of transitions) maskUsers(x);
    for (const k of ['current', 'firstOn', 'lastOn', 'lastOff']) maskUsers(t.facts[k]);
    userMasked = had;
  }
  return {
    segments: t.segments, transitions, transitionsInRange: inRange.length, transitionsTruncated: inRange.length > transitions.length,
    // 범위 안 방향별 건수 — 실은 2000건이 아니라 전체 기준(2회차 남은 것: 타일의 '꺼짐 N · 켜짐 M' 이 실린 건수였다)
    transitionsInRangeBy: { on: inRange.filter((x) => x.to === 'on').length, off: inRange.filter((x) => x.to === 'off').length },
    transitionsTotal: t.transitions.length, sums: t.sums, facts: t.facts, ...(userMasked ? { userMasked: true } : {}),
  };
}
