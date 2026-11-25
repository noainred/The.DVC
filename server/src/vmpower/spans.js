/**
 * vmpower/spans.js — VM 전원 구간(켜짐 · 꺼짐) 판정 코어(v3.39.0 · 시안 docs/design/vm-power-calendar A안 · ⑤).
 * 순수 모듈(테스트 server/test/vmPower3390.test.js). 저장은 vmpower/db.js, 관측은 vmpower/watcher.js, 조회는 vmpower/history.js.
 *
 * 저장 모델 — VM 마다 '같은 상태가 이어진 구간' 한 행(power_spans):
 *   state 'on' | 'off'  · start = 그 상태를 처음 본 시각 · end = 그 상태로 마지막 본 시각(null = 진행 중)
 *   lo = 그 상태가 시작된 구간의 앞 끝(직전 관측). **null = 기록 시작 전부터 그 상태였다**(언제 바뀌었는지 모른다 — 지어내지 않는다).
 *   전환이 없으면 행이 생기지 않는다(10분마다 5,850행을 갱신하지 않는다 — 관측 시각은 vCenter 당 한 행 power_watch).
 *   두 구간 사이 [앞 구간 end, 뒤 구간 start] = 전환이 일어난 창(정밀도 = 관측 간격). 관측이 끊긴 시간은 power_gaps 에 따로 남긴다.
 * 화면 상태 4가지: on · off · est(경계 불확실 — 창 안 어딘가에서 바뀜) · unk(기록 없음 — 관측이 끊김). est · unk 는 켜짐 · 꺼짐에 넣지 않는다.
 */
import { numOrNull } from '../util/numOrNull.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 관측 간격 — 수집 결과(store 스냅샷)를 읽기만 한다(vCenter 왕복 없음). */
export const WATCH_EVERY_MS = 10 * MIN;
/** 이보다 오래 관측이 없으면 '기록 없음'(포탈 중지 · vCenter 못 읽음 · 긴급중단). */
export const GAP_MS = 3 * WATCH_EVERY_MS;
/** VM 추적(vmtrack) 슬롯 간격 — 소급 구간의 정밀도(화면 문구용). */
export const TRACK_GRAN_MS = 12 * HOUR;
/** 이벤트 시각과 관측 창의 시계 오차 허용. */
export const EVENT_SLACK_MS = 2 * MIN;

/** 스냅샷 powerState → 'on' | 'off' | null(모름 — 구간을 건드리지 않는다). 일시 정지는 꺼짐으로 센다. */
export function powerStateOf(ps) {
  const s = String(ps || '').toUpperCase();
  if (s === 'POWERED_ON') return 'on';
  if (s === 'POWERED_OFF' || s === 'SUSPENDED') return 'off';
  return null;
}

/**
 * 관측 1회 → 쓰기 계획. open: Map(vmId → {id, state, start}) · watchLast: 이 vCenter 의 직전 관측 시각(null = 처음).
 * vms: [{vmId, name, state}] (state null = 전원 모름 — 열린 구간을 그대로 둔다).
 * @returns {{gap: {from,to}|null, close: Array<{id,end,gone?}>, insert: Array<{vmId,name,state,start,lo}>}}
 */
export function planObservation({ open = new Map(), watchLast = null, vms = [], ts, gapMs = GAP_MS } = {}) {
  const prev = numOrNull(watchLast);
  const gap = prev != null && ts - prev > gapMs ? { from: prev, to: ts } : null;
  const insert = [];
  const close = [];
  const seen = new Set();
  for (const v of vms || []) {
    if (!v || !v.vmId) continue;
    seen.add(v.vmId);
    const st = v.state === 'on' || v.state === 'off' ? v.state : null;
    if (!st) continue;
    const o = open.get(v.vmId);
    if (!o) { insert.push({ vmId: v.vmId, name: v.name || '', state: st, start: ts, lo: prev }); continue; }
    if (o.state === st) continue;
    close.push({ id: o.id, end: Math.max(o.start, prev ?? o.start) });
    insert.push({ vmId: v.vmId, name: v.name || '', state: st, start: ts, lo: Math.max(o.start, prev ?? o.start) });
  }
  // 목록에서 사라진 VM(삭제 · 다른 vCenter 로 이동) — 마지막으로 본 관측에서 닫는다.
  for (const [vmId, o] of open) if (!seen.has(vmId)) close.push({ id: o.id, end: Math.max(o.start, prev ?? o.start), gone: true });
  return { gap, insert, close };
}

/** 정렬된 배열에서 x 보다 작은 마지막 값(없으면 null). */
function lastBelow(sorted, x) {
  let lo = 0; let hi = sorted.length - 1; let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) { ans = sorted[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * 소급 — vCenter 의 첫 관측 때 한 번, 기존 VM 추적 기록(12시간 슬롯 diff)으로 지난 구간을 만든다.
 *   vms: 지금 목록 [{vmId,name,state}] · firstSeen: Map(vmId → 추적이 처음 본 시각) · changes: [{vmId, kind:'powered_on'|'powered_off', ts}]
 *   snapTs: 이 vCenter 의 추적 슬롯 시각(오름차순) · ts: 지금.
 * 슬롯 사이에서 바뀌었다 돌아온 것은 추적에 없다 — 소급 구간은 '두 슬롯 사이' 로만 안다(src 'backfill').
 * @returns {Array<{vmId,name,state,start,lo,end,src}>} end null = 진행 중
 */
export function planBackfill({ vms = [], firstSeen = new Map(), changes = [], snapTs = [], ts } = {}) {
  const byVm = new Map();
  for (const c of changes || []) {
    if (!c || !c.vmId || (c.kind !== 'powered_on' && c.kind !== 'powered_off')) continue;
    const t = numOrNull(c.ts);
    if (t == null || t > ts) continue;
    if (!byVm.has(c.vmId)) byVm.set(c.vmId, []);
    byVm.get(c.vmId).push({ to: c.kind === 'powered_on' ? 'on' : 'off', ts: t });
  }
  const slots = (snapTs || []).map(Number).filter((x) => Number.isFinite(x) && x <= ts).sort((a, b) => a - b);
  const out = [];
  for (const v of vms || []) {
    if (!v || !v.vmId) continue;
    const now = v.state === 'on' || v.state === 'off' ? v.state : null;
    if (!now) continue;
    const fs = numOrNull(firstSeen.get(v.vmId));
    if (fs == null || fs > ts) { out.push({ vmId: v.vmId, name: v.name || '', state: now, start: ts, lo: null, end: null, src: 'watch' }); continue; }
    const trans = (byVm.get(v.vmId) || []).filter((x) => x.ts >= fs).sort((a, b) => a.ts - b.ts);
    // 추적이 이미 돌고 있을 때 처음 보인 VM 은 '그 사이에 생겼다' — 앞 끝을 직전 슬롯으로(기록 시작 전과 구분).
    const appearedLo = slots.length && fs > slots[0] ? lastBelow(slots, fs) : null;
    let cur = { state: trans.length ? (trans[0].to === 'on' ? 'off' : 'on') : now, start: fs, lo: appearedLo };
    for (const t of trans) {
      if (t.to === cur.state) continue;
      const prevSlot = lastBelow(slots, t.ts) ?? Math.max(cur.start, t.ts - TRACK_GRAN_MS);
      const end = Math.max(cur.start, prevSlot);
      out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end, src: 'backfill' });
      cur = { state: t.to, start: t.ts, lo: end };
    }
    if (cur.state === now) out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end: null, src: 'backfill' });
    else {
      // 마지막 슬롯 뒤에 바뀌었다 — 소급 구간을 마지막 슬롯에서 닫고 지금부터 새 구간.
      const last = slots.length ? slots[slots.length - 1] : cur.start;
      const end = Math.max(cur.start, last);
      out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end, src: 'backfill' });
      out.push({ vmId: v.vmId, name: v.name || '', state: now, start: ts, lo: end, end: null, src: 'watch' });
    }
  }
  return out;
}

/** segs 위에 over 구간(unk)을 덮어 칠한다 — over 는 segs 가 덮는 범위 안에서만. */
function paint(segs, overs) {
  if (!segs.length || !overs.length) return segs;
  const minA = segs[0].a;
  const maxB = segs[segs.length - 1].b;
  let cur = segs;
  for (const o of overs) {
    const a = Math.max(o.a, minA);
    const b = Math.min(o.b, maxB);
    if (!(b > a)) continue;
    const next = [];
    for (const s of cur) {
      if (s.b <= a || s.a >= b) { next.push(s); continue; }
      if (s.a < a) next.push({ ...s, b: a });
      if (s.b > b) next.push({ ...s, a: b });
    }
    next.push({ a, b, st: 'unk' });
    next.sort((x, y) => x.a - y.a);
    cur = next;
  }
  return cur;
}

function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    if (!(s.b > s.a)) continue;
    const p = out[out.length - 1];
    if (p && p.st === s.st && p.b === s.a && (p.src || '') === (s.src || '')) p.b = s.b;
    else out.push({ ...s });
  }
  return out;
}

const EV_OF = { on: 'VmPoweredOnEvent', off: 'VmPoweredOffEvent' };

/**
 * 구간 · 끊김 · 이벤트 → 화면용 타임라인 · 전환 목록 · 사실(처음 Power On 등).
 *   spans: [{state,start,lo,end,src}] (어느 순서든) · gaps: [{from,to}] · events: [{ts,type,user}] — VM 이름으로 찾은 전원 이벤트
 *   (같은 이름 VM 이 둘 이상이면 호출부가 [] 를 준다) · watchLast: 이 vCenter 의 마지막 관측 · from/to: 화면 범위.
 */
export function buildTimeline({ spans = [], gaps = [], events = [], now, watchLast = null, gapMs = GAP_MS, from = -Infinity, to = Infinity } = {}) {
  const sp = (spans || [])
    .map((s) => ({ state: s.state, start: numOrNull(s.start), lo: numOrNull(s.lo), end: numOrNull(s.end), src: s.src || 'watch' }))
    .filter((s) => (s.state === 'on' || s.state === 'off') && s.start != null)
    .sort((a, b) => a.start - b.start);
  const evs = (events || []).map((e) => ({ ts: numOrNull(e.ts), type: e.type, user: e.user || '' })).filter((e) => e.ts != null).sort((a, b) => a.ts - b.ts);
  const wl = numOrNull(watchLast);
  const tail = wl != null && now - wl > gapMs ? wl : now;   // 진행 중 구간을 어디까지 아는가

  // ① 전환 창을 이벤트로 좁힌다(창 안의 같은 방향 이벤트 중 마지막).
  for (let i = 1; i < sp.length; i++) {
    const p = sp[i - 1];
    const s = sp[i];
    if (p.state === s.state || p.end == null) continue;
    const lo = p.end - EVENT_SLACK_MS;
    const hi = s.start + EVENT_SLACK_MS;
    let hit = null;
    for (const e of evs) if (e.type === EV_OF[s.state] && e.ts >= lo && e.ts <= hi && e.ts >= p.start && (s.end == null || e.ts <= s.end)) hit = e;
    if (hit) { p.end = hit.ts; s.start = hit.ts; s.lo = hit.ts; s.exact = true; s.user = hit.user; }
  }

  // ② 구간 → 칠할 조각
  let segs = [];
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i];
    if (i > 0) {
      const p = sp[i - 1];
      const pe = p.end ?? s.start;
      if (s.start > pe) segs.push({ a: pe, b: s.start, st: p.state !== s.state ? 'est' : 'unk' });
    }
    const end = s.end ?? Math.max(s.start, tail);
    segs.push({ a: s.start, b: Math.max(s.start, end), st: s.state, src: s.src });
    if (s.end == null && tail < now) segs.push({ a: Math.max(s.start, tail), b: now, st: 'unk' });
  }
  // ③ 관측이 끊긴 시간은 무엇이었든 '기록 없음'
  const overs = (gaps || []).map((g) => ({ a: numOrNull(g.from), b: numOrNull(g.to) })).filter((g) => g.a != null && g.b != null && g.b > g.a).sort((x, y) => x.a - y.a);
  segs = mergeSegs(paint(segs, overs));

  // ④ 전환 목록(최신 먼저)
  const transitions = [];
  for (let i = 1; i < sp.length; i++) {
    const p = sp[i - 1];
    const s = sp[i];
    if (p.state === s.state) continue;
    const lo = s.exact ? s.start : (p.end ?? s.lo ?? s.start);
    const unk = !s.exact && overs.some((g) => g.a < s.start && g.b > lo);
    transitions.push({
      to: s.state, ts: s.start, lo, exact: !!s.exact, src: s.exact ? 'event' : s.src, user: s.user || '', unknownWindow: unk,
      prevState: p.state, prevMs: Math.max(0, (p.end ?? s.start) - p.start), prevFromStart: p.lo == null && i - 1 === 0,
      // 직전 상태가 이어진 시간의 위 끝 — 앞 창의 시작(lo)부터 이 전환 창의 끝까지. 기록 시작 전부터면 위 끝을 모른다(null).
      prevMaxMs: p.lo == null ? null : Math.max(0, s.start - p.lo),
    });
  }
  transitions.reverse();

  // ⑤ 사실
  const fact = (s, idx) => (s ? (s.lo == null && idx === 0 ? { before: s.start, src: s.src } : { ts: s.start, lo: s.lo, exact: !!s.exact, src: s.exact ? 'event' : s.src, user: s.user || '' }) : null);
  const idxOf = (pred) => { for (let i = sp.length - 1; i >= 0; i--) if (pred(sp[i])) return i; return -1; };
  const firstOnIdx = sp.findIndex((s) => s.state === 'on');
  const lastOnIdx = idxOf((s) => s.state === 'on');
  const lastOffIdx = idxOf((s) => s.state === 'off');
  const last = sp[sp.length - 1] || null;
  // 구간 길이는 범위다 — 아래 끝 = 그 상태로 본 첫 · 마지막 관측 사이, 위 끝 = 앞 창 시작(lo) ~ 다음 구간 시작(진행 중이면 지금).
  const durOf = (i) => {
    const s = sp[i];
    const e = s.end ?? tail;
    const next = sp[i + 1];
    const hi = s.end == null ? now : (next ? next.start : e);
    return { minMs: Math.max(0, e - s.start), maxMs: s.lo == null ? null : Math.max(0, hi - s.lo), open: s.end == null };
  };
  let longestOff = null;
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i];
    if (s.state !== 'off') continue;
    const d = durOf(i);
    const key = d.maxMs ?? d.minMs;
    if (!longestOff || key > (longestOff.maxMs ?? longestOff.ms)) longestOff = { a: s.start, b: s.end ?? tail, ms: d.minMs, maxMs: d.maxMs, open: d.open, fromStart: s.lo == null };
  }
  // 화면 범위 안에서 가장 길게 꺼짐(요약 타일 · 카드는 '이 기간' 을 말한다 — 범위 밖의 긴 꺼짐을 끌어오지 않는다).
  let longestOffInRange = null;
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i];
    if (s.state !== 'off') continue;
    const e = s.end ?? tail;
    const a = Math.max(s.start, from);
    const b = Math.min(e, to);
    if (!(b >= a) || e < from || s.start > to) continue;
    const d = durOf(i);
    const clippedOut = s.start < from || e > to;   // 범위에 잘렸으면 위 끝은 범위 안의 길이로만
    const lo = Math.max(0, b - a);
    const hi = clippedOut ? null : d.maxMs;
    if (!longestOffInRange || (hi ?? lo) > (longestOffInRange.maxMs ?? longestOffInRange.ms)) {
      longestOffInRange = { a, b, ms: lo, maxMs: hi, open: d.open, fromStart: s.lo == null || s.start < from, clipped: clippedOut };
    }
  }
  const sums = { on: 0, off: 0, est: 0, unk: 0 };
  const clipped = [];
  for (const g of segs) {
    const a = Math.max(g.a, from);
    const b = Math.min(g.b, to);
    if (!(b > a)) continue;
    sums[g.st] += b - a;
    clipped.push({ a, b, st: g.st, ...(g.src === 'backfill' ? { src: 'backfill' } : {}) });
  }
  const bf = sp.filter((s) => s.src === 'backfill');
  const watchSpans = sp.filter((s) => s.src !== 'backfill');
  return {
    segments: clipped,
    transitions,
    sums,
    facts: {
      current: last && last.end == null ? { state: last.state, ...(fact(last, sp.length - 1) || {}) } : null,
      gone: !!(last && last.end != null),
      firstOn: firstOnIdx >= 0 ? fact(sp[firstOnIdx], firstOnIdx) : null,
      lastOn: lastOnIdx >= 0 ? fact(sp[lastOnIdx], lastOnIdx) : null,
      lastOff: lastOffIdx >= 0 ? fact(sp[lastOffIdx], lastOffIdx) : null,
      lastOffEnd: lastOffIdx >= 0 ? sp[lastOffIdx].end : null,
      lastOffDur: lastOffIdx >= 0 ? durOf(lastOffIdx) : null,
      longestOff,
      longestOffInRange,
      offCount: sp.filter((s, i) => s.state === 'off' && !(i === 0 && s.lo == null)).length,
      transitionCount: transitions.length,
      recordStart: sp.length ? sp[0].start : null,
      backfill: bf.length ? { from: bf[0].start, to: watchSpans.length ? Math.min(...watchSpans.map((s) => s.start)) : null } : null,
    },
  };
}
