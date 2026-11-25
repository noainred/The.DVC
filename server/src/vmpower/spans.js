/**
 * vmpower/spans.js — VM 전원 구간(켜짐 · 꺼짐) 판정 코어(v3.39.0 · 시안 docs/design/vm-power-calendar A안 · ⑤ · v3.42.0 재검토 반영).
 * 순수 모듈(테스트 server/test/vmPower3390.test.js · vmPower3420.test.js). 저장은 vmpower/db.js, 관측은 vmpower/watcher.js, 조회는 vmpower/history.js.
 *
 * 저장 모델 — VM 마다 '같은 상태가 이어진 구간' 한 행(power_spans):
 *   state 'on' | 'off'  · start = 그 상태를 처음 본 시각 · end = 그 상태로 마지막 본 시각(null = 진행 중)
 *   lo = 그 상태가 시작된 구간의 앞 끝(직전 관측). **null = 기록 시작 전부터 그 상태였다**(언제 바뀌었는지 모른다 — 지어내지 않는다).
 *   src = 'watch'(10분 관측) · 'backfill'(VM 추적 12시간 슬롯 소급) · 'appear' · 'backfill-appear'(목록에 **나타난** 구간 — 전원이 켜진 것이 아니다).
 *   전환이 없으면 행이 생기지 않는다(10분마다 5,850행을 갱신하지 않는다 — 관측 시각은 vCenter 당 한 행 power_watch).
 *   두 구간 사이 [앞 구간 end, 뒤 구간 start] = 전환이 일어난 창(정밀도 = 창 폭). 관측이 끊긴 시간은 power_gaps 에 따로 남긴다.
 * 화면 상태 4가지: on · off · est(경계 불확실 — 창 안 어딘가에서 바뀜) · unk(기록 없음 — 관측이 끊김). est · unk 는 켜짐 · 꺼짐에 넣지 않는다.
 * 비용: buildTimeline 은 구간 · 끊김 · 이벤트 수에 대해 정렬 + 선형(+ 이분 탐색)이다 — 요청 경로에서 돈다(v3.42.0 재검토 #3: 예전 제곱 비용 · 2만 구간에서 10초).
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
/** 소급에서 슬롯 사이가 이보다 벌어지면 추적이 비었던 것 — 그 사이는 '기록 없음'. */
export const TRACK_GAP_MS = 1.5 * TRACK_GRAN_MS;
/** 같은 상태로 이만큼 안에 목록에서 빠졌다 돌아온 VM 은 한 구간으로 본다(빠진 시간은 '기록 없음' — 2회차 N1: 30분이면 관측 간격이 조금만 늘어도 2~3번 빠짐을 놓쳤다). */
export const ABSENT_MERGE_MS = 6 * HOUR;
/** 이벤트 시각과 관측 창의 시계 오차 허용. */
export const EVENT_SLACK_MS = 2 * MIN;

export const isBackfillSrc = (src) => src === 'backfill' || src === 'backfill-appear';
export const isAppearSrc = (src) => src === 'appear' || src === 'backfill-appear';

/** 스냅샷 powerState → 'on' | 'off' | null(모름 — 구간을 건드리지 않는다). 일시 정지는 꺼짐으로 센다. */
export function powerStateOf(ps) {
  const s = String(ps || '').toUpperCase();
  if (s === 'POWERED_ON') return 'on';
  if (s === 'POWERED_OFF' || s === 'SUSPENDED') return 'off';
  return null;
}

/**
 * 관측 1회 → 쓰기 계획. open: Map(vmId → {id, state, start}) · watchLast: 이 vCenter 의 직전 관측 시각(null = 처음).
 * vms: [{vmId, name, state}] (state null = 전원 모름 — 열린 구간을 그대로 둔다 · 같은 vmId 는 처음 것만).
 * 시계가 뒤로 갔으면(ts ≤ 직전 관측) 아무것도 쓰지 않는다(skip) — 거꾸로 된 창 · 겹친 구간을 만들지 않는다(재검토 #7).
 * @returns {{skip?:boolean, gap: {from,to}|null, close: Array<{id,end,gone?}>, insert: Array<{vmId,name,state,start,lo,src}>}}
 */
export function planObservation({ open = new Map(), watchLast = null, vms = [], ts, gapMs = GAP_MS } = {}) {
  const prev = numOrNull(watchLast);
  if (prev != null && !(ts > prev)) return { skip: true, gap: null, insert: [], close: [] };
  const gap = prev != null && ts - prev > gapMs ? { from: prev, to: ts } : null;
  const insert = [];
  const close = [];
  const seen = new Set();
  for (const v of vms || []) {
    if (!v || !v.vmId || seen.has(v.vmId)) continue;   // 한 관측 안 중복 id — 열린 구간이 둘 생기지 않게(재검토 #12)
    seen.add(v.vmId);
    const st = v.state === 'on' || v.state === 'off' ? v.state : null;
    if (!st) continue;
    const o = open.get(v.vmId);
    if (!o) {
      // 처음 보는 VM — 첫 관측이면 기록 시작 전부터 그 상태(lo null), 관측 중이면 '목록에 나타남'(전원이 켜진 것이 아니다 — 재검토 #11).
      insert.push({ vmId: v.vmId, name: v.name || '', state: st, start: ts, lo: prev, src: prev == null ? 'watch' : 'appear' });
      continue;
    }
    if (o.state === st) continue;
    close.push({ id: o.id, end: Math.max(o.start, prev ?? o.start) });
    insert.push({ vmId: v.vmId, name: v.name || '', state: st, start: ts, lo: Math.max(o.start, prev ?? o.start), src: 'watch' });
  }
  // 목록에서 사라진 VM(삭제 · 다른 vCenter 로 이동 · 관측 한 번 빠짐) — 마지막으로 본 관측에서 닫는다.
  //   한 번 빠졌다 같은 상태로 돌아오면 조회 때 이어 붙인다(buildTimeline ① — 재검토 #2).
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
/** 정렬된 수 배열에서 x 이하인 마지막 인덱스(없으면 -1). */
function lastIdxAtMost(sorted, x) {
  let lo = 0; let hi = sorted.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * 소급 — vCenter 의 첫 관측 때 한 번, 기존 VM 추적 기록(12시간 슬롯 diff)으로 지난 구간을 만든다.
 *   vms: 지금 목록 [{vmId,name,state}] · firstSeen: Map(vmId → 추적이 처음 본 시각) · changes: [{vmId, kind:'powered_on'|'powered_off', ts}]
 *   snapTs: 이 vCenter 의 추적 슬롯 시각(오름차순) · ts: 지금.
 * 슬롯 사이에서 바뀌었다 돌아온 것은 추적에 없다 — 소급 구간은 '두 슬롯 사이' 로만 안다. 추적이 빈 기간은 backfillGaps 가 '기록 없음' 으로 남긴다.
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
  const seen = new Set();
  for (const v of vms || []) {
    if (!v || !v.vmId || seen.has(v.vmId)) continue;
    seen.add(v.vmId);
    const now = v.state === 'on' || v.state === 'off' ? v.state : null;
    if (!now) continue;
    const fs = numOrNull(firstSeen.get(v.vmId));
    if (fs == null || fs > ts) { out.push({ vmId: v.vmId, name: v.name || '', state: now, start: ts, lo: null, end: null, src: 'watch' }); continue; }
    const trans = (byVm.get(v.vmId) || []).filter((x) => x.ts >= fs).sort((a, b) => a.ts - b.ts);
    // 추적이 이미 돌고 있을 때 처음 보인 VM 은 '그 사이에 나타났다'(생성 · 이동) — 앞 끝을 직전 슬롯으로(기록 시작 전과 구분).
    const appearedLo = slots.length && fs > slots[0] ? lastBelow(slots, fs) : null;
    let cur = { state: trans.length ? (trans[0].to === 'on' ? 'off' : 'on') : now, start: fs, lo: appearedLo, src: appearedLo != null ? 'backfill-appear' : 'backfill' };
    for (const t of trans) {
      if (t.to === cur.state) continue;
      const prevSlot = lastBelow(slots, t.ts) ?? Math.max(cur.start, t.ts - TRACK_GRAN_MS);
      const end = Math.max(cur.start, prevSlot);
      out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end, src: cur.src });
      cur = { state: t.to, start: t.ts, lo: end, src: 'backfill' };
    }
    if (cur.state === now) out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end: null, src: cur.src });
    else {
      // 마지막 슬롯 뒤에 바뀌었다 — 소급 구간을 마지막 슬롯에서 닫고 지금부터 새 구간(창 = 마지막 슬롯 ~ 지금).
      const last = slots.length ? slots[slots.length - 1] : cur.start;
      const end = Math.max(cur.start, last);
      out.push({ vmId: v.vmId, name: v.name || '', state: cur.state, start: cur.start, lo: cur.lo, end, src: cur.src });
      out.push({ vmId: v.vmId, name: v.name || '', state: now, start: ts, lo: end, end: null, src: 'watch' });
    }
  }
  return out;
}

/**
 * 소급 기간 중 추적이 비었던 구간 — 슬롯 사이가 TRACK_GAP_MS 보다 벌어진 곳과 마지막 슬롯 ~ 지금(재검토 #5: 비어 있던 60일을 '켜짐' 으로 채웠다).
 * @returns {Array<{from,to}>}
 */
export function backfillGaps({ snapTs = [], ts } = {}) {
  const slots = (snapTs || []).map(Number).filter((x) => Number.isFinite(x) && x <= ts).sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < slots.length; i++) if (slots[i] - slots[i - 1] > TRACK_GAP_MS) out.push({ from: slots[i - 1], to: slots[i] });
  if (slots.length && ts - slots[slots.length - 1] > TRACK_GAP_MS) out.push({ from: slots[slots.length - 1], to: ts });
  return out;
}

/** 겹치는 [a,b) 구간을 합친다(정렬 입력 · 선형). */
function unionIntervals(list) {
  const out = [];
  for (const g of list) {
    const p = out[out.length - 1];
    if (p && g.a <= p.b) p.b = Math.max(p.b, g.b);
    else out.push({ a: g.a, b: g.b });
  }
  return out;
}

/** segs(시간순 · 겹침 없음) 위에 overs(합친 · 시간순)를 'unk' 로 덮는다 — segs 가 덮는 범위 안에서만. 두 목록을 한 번 훑는다. */
function paint(segs, overs) {
  if (!segs.length || !overs.length) return segs;
  const minA = segs[0].a;
  const maxB = segs[segs.length - 1].b;
  const ov = overs.map((o) => ({ a: Math.max(o.a, minA), b: Math.min(o.b, maxB) })).filter((o) => o.b > o.a);
  if (!ov.length) return segs;
  const out = [];
  let j = 0;
  for (const s of segs) {
    let a = s.a;
    while (j < ov.length && ov[j].b <= a) j++;
    let k = j;
    while (a < s.b) {
      const o = ov[k];
      if (!o || o.a >= s.b) { out.push({ ...s, a, b: s.b }); break; }
      if (o.a > a) out.push({ ...s, a, b: o.a });
      const e = Math.min(o.b, s.b);
      out.push({ a: Math.max(a, o.a), b: e, st: 'unk' });
      a = e;
      if (o.b <= s.b) k++;
    }
  }
  return out;
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
 *   (같은 이름 VM 이 둘 이상이면 호출부가 [] 를 준다) · watchLast: 이 vCenter 의 마지막 관측 · from/to: 화면 범위 ·
 *   floor: 보존 정리로 그 앞 구간을 지운 시각(power_watch.pruned_to) — 남은 첫 구간의 앞 끝이 그보다 앞이면 '기록 시작 전' 으로 본다(재검토 #10).
 */
export function buildTimeline({ spans = [], gaps = [], events = [], now, watchLast = null, gapMs = GAP_MS, from = -Infinity, to = Infinity, floor = null } = {}) {
  const raw = (spans || [])
    .map((s) => ({ state: s.state, start: numOrNull(s.start), lo: numOrNull(s.lo), end: numOrNull(s.end), src: s.src || 'watch' }))
    .filter((s) => (s.state === 'on' || s.state === 'off') && s.start != null)
    .sort((a, b) => a.start - b.start);
  const fl = numOrNull(floor);
  // 보존 정리로 앞 구간이 지워졌으면(첫 구간의 앞 끝이 정리 경계보다 앞) 그 전 상태를 모른다 — 첫 구간을 기록 시작으로,
  //   '처음 Power On' 도 기록 시작 전으로(남은 첫 구간이 꺼짐이어도 그 뒤 켜짐을 '처음' 으로 지어내지 않는다 — 2회차 N5).
  const truncatedHead = !!(raw.length && fl != null && raw[0].lo != null && raw[0].lo < fl);
  if (truncatedHead) raw[0].lo = null;
  // ① 같은 상태로 잠깐(≤ ABSENT_MERGE_MS) 목록에서 빠졌다 돌아온 것은 한 구간이다(재검토 #2 · 2회차 N1) — 빠진 시간은 켜짐 · 꺼짐이 아니라 '기록 없음'(N2).
  const sp = [];
  const holes = [];
  for (const s of raw) {
    const p = sp[sp.length - 1];
    if (p && p.state === s.state && p.end != null && s.start - p.end <= Math.max(gapMs, ABSENT_MERGE_MS)) {
      if (s.start > p.end) { holes.push({ a: p.end, b: s.start }); p.holeMs = (p.holeMs || 0) + (s.start - p.end); }
      p.end = s.end;
      continue;
    }
    sp.push({ ...s });
  }
  const wl = numOrNull(watchLast);
  const tail = wl != null && now - wl > gapMs ? Math.min(wl, now) : now;   // 진행 중 구간을 어디까지 아는가
  // 마지막 관측이 지금보다 뒤 — 서버 시계가 뒤로 바뀌어 관측을 건너뛰는 중이다. 지금 상태를 단정하지 않는다(4회차 R3).
  const clockHeld = wl != null && wl > now;

  // ② 전환 창을 이벤트로 좁힌다(창 안의 같은 방향 이벤트 중 마지막) — 방향별 정렬 배열 + 이분 탐색.
  const evByType = { VmPoweredOnEvent: [], VmPoweredOffEvent: [] };
  for (const e of events || []) {
    const t = numOrNull(e?.ts);
    if (t == null || !evByType[e.type]) continue;
    evByType[e.type].push({ ts: t, user: e.user || '' });
  }
  for (const k of Object.keys(evByType)) evByType[k].sort((a, b) => a.ts - b.ts);
  const evTs = { VmPoweredOnEvent: evByType.VmPoweredOnEvent.map((e) => e.ts), VmPoweredOffEvent: evByType.VmPoweredOffEvent.map((e) => e.ts) };
  for (let i = 1; i < sp.length; i++) {
    const p = sp[i - 1];
    const s = sp[i];
    if (p.state === s.state || p.end == null) continue;
    const type = EV_OF[s.state];
    const lo = Math.max(p.end - EVENT_SLACK_MS, p.start);
    const hi = Math.min(s.start + EVENT_SLACK_MS, s.end ?? Infinity);
    const idx = lastIdxAtMost(evTs[type], hi);
    if (idx < 0) continue;
    const hit = evByType[type][idx];
    if (hit.ts < lo) continue;
    p.end = hit.ts; s.start = hit.ts; s.lo = hit.ts; s.exact = true; s.user = hit.user;
  }

  // ③ 구간 → 칠할 조각
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
  // ④ 관측이 끊긴 시간은 무엇이었든 '기록 없음'
  const overs = unionIntervals((gaps || []).map((g) => ({ a: numOrNull(g.from), b: numOrNull(g.to) })).concat(holes).filter((g) => g.a != null && g.b != null && g.b > g.a).sort((x, y) => x.a - y.a));
  segs = mergeSegs(paint(segs, overs));
  const overEnds = overs.map((o) => o.b);
  /** [lo, hi) 가 끊김과 겹치는가 — 합친 끊김은 시간순 · 겹침 없음이라 lo 보다 늦게 끝나는 첫 끊김만 보면 된다(이분 탐색). */
  const overlapsGap = (lo, hi) => {
    let a = 0; let b = overEnds.length - 1; let k = overEnds.length;
    while (a <= b) { const m = (a + b) >> 1; if (overEnds[m] > lo) { k = m; b = m - 1; } else a = m + 1; }
    return k < overs.length && overs[k].a < hi;
  };

  // 목록에 나타난 구간(appear)은 그 상태로 '바뀐' 것이 아니다 — 시작 시각을 모른다(길이는 하한 · 꺼짐 횟수에 넣지 않음 — 2회차 N1).
  const startKnown = (s, i) => !(s.lo == null && i === 0) && !(isAppearSrc(s.src) && !s.exact);
  // ⑤ 전환 목록(최신 먼저)
  const transitions = [];
  for (let i = 1; i < sp.length; i++) {
    const p = sp[i - 1];
    const s = sp[i];
    if (p.state === s.state) continue;
    const lo = s.exact ? s.start : (p.end ?? s.lo ?? s.start);
    transitions.push({
      to: s.state, ts: s.start, lo, exact: !!s.exact, src: s.exact ? 'event' : (isBackfillSrc(s.src) ? 'backfill' : 'watch'), user: s.user || '',
      unknownWindow: !s.exact && overlapsGap(lo, s.start),
      // 직전 상태의 시작을 모르면(기록 시작 전 · 목록에 나타남) '… 이상' — 사실(facts)과 같은 startKnown 판정(3회차 R2).
      prevState: p.state, prevMs: Math.max(0, (p.end ?? s.start) - p.start), prevFromStart: !startKnown(p, i - 1),
      // 직전 상태가 이어진 시간의 위 끝 — 앞 창의 시작(lo)부터 이 전환 창의 끝까지. 시작을 모르면 위 끝도 모른다(null).
      prevMaxMs: startKnown(p, i - 1) && p.lo != null ? Math.max(0, s.start - p.lo) : null,
      // 그 길이 안에 목록에서 빠졌던 시간(이어 붙인 구간) — 화면이 '기록 없음 N 포함' 으로 밝힌다.
      prevHoleMs: p.holeMs || 0,
    });
  }
  transitions.reverse();

  // ⑥ 사실
  const fact = (s, idx) => {
    if (!s) return null;
    if (s.lo == null && idx === 0) return { before: s.start, src: isBackfillSrc(s.src) ? 'backfill' : 'watch' };
    return { ts: s.start, lo: s.lo, exact: !!s.exact, src: s.exact ? 'event' : (isBackfillSrc(s.src) ? 'backfill' : 'watch'), user: s.user || '', ...(isAppearSrc(s.src) && !s.exact ? { appeared: true } : {}) };
  };
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
    return { minMs: Math.max(0, e - s.start), maxMs: startKnown(s, i) && s.lo != null ? Math.max(0, hi - s.lo) : null, open: s.end == null };
  };
  let longestOff = null;
  let longestOffInRange = null;
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i];
    if (s.state !== 'off') continue;
    const d = durOf(i);
    const key = d.maxMs ?? d.minMs;
    if (!longestOff || key > (longestOff.maxMs ?? longestOff.ms)) longestOff = { a: s.start, b: s.end ?? tail, ms: d.minMs, maxMs: d.maxMs, open: d.open, fromStart: !startKnown(s, i) };
    // 화면 범위 안에서 가장 길게 꺼짐(요약 타일 · 카드는 '이 기간' 을 말한다 — 범위 밖의 긴 꺼짐을 끌어오지 않는다).
    const e = s.end ?? tail;
    const a = Math.max(s.start, from);
    const b = Math.min(e, to);
    if (!(b >= a) || e < from || s.start > to) continue;
    const clippedOut = s.start < from || e > to;   // 범위에 잘렸으면 위 끝은 범위 안의 길이로만
    const lo = Math.max(0, b - a);
    const hi = clippedOut ? null : d.maxMs;
    if (!longestOffInRange || (hi ?? lo) > (longestOffInRange.maxMs ?? longestOffInRange.ms)) {
      longestOffInRange = { a, b, ms: lo, maxMs: hi, open: d.open, fromStart: !startKnown(s, i) || s.start < from, clipped: clippedOut };
    }
  }
  /** 그 시각 이후 '기록 없음' 합 — '켜짐 · N일째' 가 끊긴 시간을 포함하는지 밝힌다(2회차 남은 것). */
  const unknownSince = (t0) => { let u = 0; for (const g of segs) if (g.st === 'unk' && g.b > t0) u += g.b - Math.max(g.a, t0); return u; };
  const sums = { on: 0, off: 0, est: 0, unk: 0 };
  const clipped = [];
  for (const g of segs) {
    const a = Math.max(g.a, from);
    const b = Math.min(g.b, to);
    if (!(b > a)) continue;
    sums[g.st] += b - a;
    clipped.push({ a, b, st: g.st, ...(isBackfillSrc(g.src) ? { src: 'backfill' } : {}) });
  }
  const bf = sp.filter((s) => isBackfillSrc(s.src));
  const watchSpans = sp.filter((s) => !isBackfillSrc(s.src));
  return {
    segments: clipped,
    transitions,
    sums,
    facts: {
      // 지금 상태 — 관측이 끊긴 채면 '마지막으로 본 상태'(seenTs · stale — 재검토 #4: 3일 끊겨도 '켜짐 · 20일째' 와 녹색 점이었다).
      current: last && last.end == null ? { state: last.state, ...(fact(last, sp.length - 1) || {}), seenTs: tail, stale: tail < now || clockHeld, ...(clockHeld ? { clockHeld: true } : {}), unknownMs: unknownSince(last.start) } : null,
      gone: !!(last && last.end != null),
      firstOn: truncatedHead && sp.length ? { before: sp[0].start, src: isBackfillSrc(sp[0].src) ? 'backfill' : 'watch' } : (firstOnIdx >= 0 ? fact(sp[firstOnIdx], firstOnIdx) : null),
      lastOn: lastOnIdx >= 0 ? fact(sp[lastOnIdx], lastOnIdx) : null,
      lastOff: lastOffIdx >= 0 ? fact(sp[lastOffIdx], lastOffIdx) : null,
      lastOffEnd: lastOffIdx >= 0 ? sp[lastOffIdx].end : null,
      lastOffDur: lastOffIdx >= 0 ? durOf(lastOffIdx) : null,
      longestOff,
      longestOffInRange,
      offCount: sp.filter((s, i) => s.state === 'off' && startKnown(s, i)).length,
      onCount: sp.filter((s, i) => s.state === 'on' && startKnown(s, i)).length,
      transitionCount: transitions.length,
      recordStart: sp.length ? sp[0].start : null,
      backfill: bf.length ? { from: bf[0].start, to: watchSpans.length ? Math.min(...watchSpans.map((s) => s.start)) : null } : null,
    },
  };
}
