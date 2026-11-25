/**
 * mock/demo/vmPower.js — 데모(mock) 모드의 VM 전원 이력(v3.39.0). 데모 스냅샷은 저장된 관측이 없으므로
 *   VM id 로 정한 결정적 '실제 전원 구간' 을 만들고, 운영과 같은 모양(관측 구간 · 끊김 · 이벤트)으로 바꿔 vmpower/spans.js 판정에 넣는다.
 *   최근 75일은 10분 관측 + 이벤트(정확한 시각), 그 앞은 12시간 슬롯 소급 — 화면의 '소급' · '경계 불확실' · '기록 없음' 이 모두 보이게.
 *   지금 전원 상태는 스냅샷의 powerState 와 맞춘다(꺼진 VM 은 마지막 구간이 꺼짐).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WATCH = 10 * MIN;
const SLOT = 12 * HOUR;
const USERS = ['VSPHERE.LOCAL\\Administrator', 'svc-scheduler', 'VSPHERE.LOCAL\\ops-admin'];

function hashOf(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @returns {{spans, gaps, events, watch}} — vmpower/db.js 와 같은 모양 */
export function demoPowerHistory(vm, now = Date.now()) {
  const r = rng(hashOf(vm?.id || vm?.name || 'vm'));
  const isOn = String(vm?.powerState || '').toUpperCase() === 'POWERED_ON';
  const day0 = Math.floor(now / DAY) * DAY;   // 구간은 날짜 경계에 고정 — 조회할 때마다 몇 분씩 움직이지 않게(v3.39.0 Chromium 확인)
  const liveFrom = day0 - 75 * DAY;
  const recordStart = day0 - 520 * DAY;
  const created = r() < 0.3 ? day0 - (120 + Math.floor(r() * 200)) * DAY : day0 - 900 * DAY;
  const begin = Math.max(created, recordStart);

  // 실제 꺼짐 구간 [a, b]
  let offs = [];
  const kind = Math.floor(r() * 4);
  if (kind === 1) {
    const base = day0 - 300 * DAY + Math.floor(r() * 7) * DAY;
    for (let i = 0; i < 14; i++) { const a = base + i * 7 * DAY + 20 * HOUR; offs.push([a, a + 2 * DAY + 11.5 * HOUR]); }
  }
  const n = kind === 0 ? 1 : 3 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const a = begin + r() * Math.max(DAY, now - begin - 5 * DAY);
    const len = (kind === 3 ? r() * 6 * DAY : r() * 10 * HOUR) + 30 * MIN;
    offs.push([a, a + len]);
  }
  offs = offs.filter(([a]) => a > begin && a < now - HOUR).sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const o of offs) {
    const p = merged[merged.length - 1];
    if (p && o[0] <= p[1] + HOUR) p[1] = Math.max(p[1], o[1]); else merged.push([o[0], Math.min(o[1], now - 20 * MIN)]);
  }
  if (!isOn) {
    const since = day0 - (2 + Math.floor(r() * 60)) * DAY - Math.floor(r() * 20) * HOUR;
    while (merged.length && merged[merged.length - 1][1] >= since - HOUR) merged.pop();
    merged.push([since, null]);
  }

  // 관측 모양으로: 전환 t 는 그 뒤 첫 관측(소급 12시간 · 실시간 10분)에서 보이고, 창의 앞 끝은 직전 관측.
  const grid = (t) => (t < liveFrom ? SLOT : WATCH);
  const obs = (t) => Math.ceil(t / grid(t)) * grid(t);
  const spans = [];
  const events = [];
  let cur = { state: 'on', start: begin, lo: created > recordStart ? begin - SLOT : null };
  const flip = (t, to) => {
    const s = obs(t);
    const prevEnd = s - grid(t);
    if (s <= cur.start) return false;   // 한 관측 간격 안에서 바뀌었다 돌아옴 — 운영도 못 본다
    spans.push({ ...cur, end: Math.max(cur.start, prevEnd), src: cur.start < liveFrom ? 'backfill' : 'watch' });
    cur = { state: to, start: s, lo: Math.max(cur.start, prevEnd) };
    if (t >= liveFrom) events.push({ ts: Math.round(t), type: to === 'on' ? 'VmPoweredOnEvent' : 'VmPoweredOffEvent', user: USERS[Math.floor(r() * USERS.length)] });
    return true;
  };
  for (const [a, b] of merged) {
    // 한 관측 간격 안에서 꺼졌다 켜진 것 · 앞 구간과 같은 칸에서 시작한 것은 운영도 보지 못한다 — 통째로 건너뛴다(마지막 상태가 어긋나지 않게).
    if (obs(a) <= cur.start || (b != null && obs(b) <= obs(a))) continue;
    flip(a, 'off');
    if (b != null) flip(b, 'on');
  }
  spans.push({ ...cur, end: null, src: cur.start < liveFrom ? 'backfill' : 'watch' });

  const gaps = [];
  if (r() < 0.4) { const g = liveFrom + (5 + Math.floor(r() * 60)) * DAY; gaps.push({ from: g, to: g + 5 * HOUR }); }
  return { spans, gaps, events, watch: { firstTs: liveFrom, lastTs: Math.floor(now / WATCH) * WATCH, backfilled: true } };
}
