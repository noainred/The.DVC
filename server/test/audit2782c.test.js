/**
 * v2.782(점검 K3) — SAN 포트 사용량 순수 코어·라우트.
 *  I-B2: 진행 중 기간(off=0)의 '앞 기간 대비' KPI 는 앞 기간도 **같은 경과 구간**만 잘라 비교한다
 *        (지금까지(부분) ↔ 앞 기간 전체 비교 → 매일 같은 트래픽인데 평균 −77%·피크 −90% 로 보였다).
 *  I-I1: 기간 하한(minOff)을 루프(−1000 상한) 대신 산술로 — 보관 3650일이면 1일 단위 −1500 도 열린다.
 *  I-I2: 라우트는 무거운 조립(buildPortUsage)을 한 번만 — 대상 고르기는 같은 바탕(usageBase)을 재사용한다.
 * 순수 함수는 now 를 주입하므로 고정 시각을 쓴다(docs/rules/common.md — 주입형은 고정 시각 허용).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2782c-'));
const pu = await import('../src/sanswitch/portUsage.js');
const H = 3_600_000, D = 86_400_000, Q = 900_000;
const KST0 = Date.UTC(2026, 9, 20, 15, 0);   // 2026-10-21 00:00 KST

// 매일 같은 모양: 업무 시간(09~18시) 1GB/s, 그 외 0.1GB/s
const v = (t) => { const h = Math.floor((((t - KST0) % D) + D) % D / H); return h >= 9 && h < 18 ? 1e9 : 1e8; };
const mk = (since, n, bm, now) => {
  const b = [], a = [], p = [];
  for (let i = 0; i < n; i++) { const t = since + i * bm; if (t > now) break; b.push(t); a.push(v(t)); p.push(v(t)); }
  return { buckets: b, series: [{ port: 1, name: 'host', speed: '16G', avg: a, peak: p }] };
};
const PORTS = [{ port: 1, slotPort: '0/1', state: 'online', name: 'host', speed: '16G' }];
const dp = (a, b) => Math.round(((a - b) / b) * 1000) / 10;

function dayCase(now, off = 0, prevBm = Q) {
  const period = pu.periodOf('d', off, { now });
  const histSince = period.start - 6 * D;
  const hist = mk(histSince, 7 * 24, H, now);
  const chart = { res: mk(period.start, 96, Q, now), since: period.start, bucketMs: Q, n: 96 };
  const pp = pu.periodOf('d', off - 1, { now, retentionDays: 1130 });
  const prev = { res: mk(pp.start, (pp.end - pp.start) / prevBm, prevBm, now), since: pp.start, bucketMs: prevBm, n: (pp.end - pp.start) / prevBm };
  return pu.buildPortUsage({ period, ports: PORTS, hist, histSince, chart, prev, view: 'port', target: 1, now });
}

test('I-B2: 진행 중인 오늘(06:10)은 앞 기간도 같은 경과 구간만 — 매일 같은 트래픽이면 변화 0%', () => {
  const now = KST0 + 6 * H + 10 * 60_000;
  const r = dayCase(now);
  const c = r.target.chart;
  assert.equal(r.current, true);
  assert.equal(dp(c.avgMean, c.prev.avgMean), 0, `평균 ${c.avgMean} vs 앞 ${c.prev.avgMean}`);
  assert.equal(dp(c.peakMax, c.prev.peakMax), 0, `피크 ${c.peakMax} vs 앞 ${c.prev.peakMax}`);
  assert.equal(c.prev.sameElapsed, true);
  assert.equal(c.prev.elapsedMs, 6 * H + 10 * 60_000);
  // 비교 구간 끝 = 앞 기간 시작 + (floor(경과/칸폭)+1) 칸 — 겹쳐 그리기의 j = floor(i*bm/prev.bm) 와 같은 기준
  assert.equal(c.prev.cmpEnd, c.prev.since + 25 * Q);
  // 겹쳐 그리는 선은 앞 기간 전체 그대로
  assert.equal(c.prev.avg.length, 96);
  assert.equal(c.prev.avg.filter((x) => x != null).length, 96);
});

test('I-B2: 업무 시간이 걸친 12:10 도, 앞 칸이 1시간(15분↔1시간)이어도 같은 경과 구간', () => {
  const r = dayCase(KST0 + 12 * H + 10 * 60_000);
  const c = r.target.chart;
  assert.equal(dp(c.avgMean, c.prev.avgMean), 0);
  assert.equal(dp(c.peakMax, c.prev.peakMax), 0);
  // 앞 기간 1시간 칸: 06:10 → j ≤ 6(00~07시) — 피크(업무 시간)는 아직 안 들어온다
  const r2 = dayCase(KST0 + 6 * H + 10 * 60_000, 0, H);
  const c2 = r2.target.chart;
  assert.equal(c2.prev.peakMax, 1e8, '아직 오지 않은 피크 시간(09시~)은 비교에 넣지 않는다');
  assert.equal(c2.prev.cmpEnd, c2.prev.since + 7 * H);
});

test('I-B2: 지난 기간(off<0)은 전과 같다 — 앞 기간 전체와 비교하고 새 필드를 붙이지 않는다', () => {
  const now = KST0 + 6 * H + 10 * 60_000;
  const r = dayCase(now, -1);
  const c = r.target.chart;
  assert.equal(r.current, false);
  assert.equal(c.prev.avgMean, 4.375e8, '앞 기간 하루 전체 평균');
  assert.equal(c.prev.peakMax, 1e9);
  assert.equal(c.avgMean, 4.375e8);
  assert.equal('sameElapsed' in c.prev, false);
  assert.equal('cmpEnd' in c.prev, false);
});

test('I-B2: 이번 달(진행 중)의 앞 달이 더 짧으면 앞 달 전체까지만(넘치지 않는다)', () => {
  // 2026-03-30 12:00 KST — 경과 29.5일 > 2월(28일)
  const now = Date.UTC(2026, 2, 30, 3, 0);
  const period = pu.periodOf('m', 0, { now });
  const pp = pu.periodOf('m', -1, { now });
  const hist = mk(period.start, period.days.length * 24, H, now);
  const n = (pp.end - pp.start) / H;
  const prev = { res: mk(pp.start, n, H, now), since: pp.start, bucketMs: H, n };
  const r = pu.buildPortUsage({ period, ports: PORTS, hist, histSince: period.start, prev, view: 'port', target: 1, now });
  const c = r.target.chart;
  assert.equal(c.prev.sameElapsed, true);
  assert.equal(c.prev.cmpEnd, pp.end);
  assert.equal(c.prev.avgMean, 4.375e8);
});

/** 옛 하한 루프(참조 구현 — v2.781 그대로). */
function oldMinOff(unit, { now, offsetMin = 540, retentionDays }) {
  const DAY_MS = D;
  const off = offsetMin * 60_000;
  const today = Math.floor((now + off) / DAY_MS) * DAY_MS - off;
  const oldest = today - Math.max(1, Math.floor(retentionDays)) * DAY_MS;
  const at = (oo) => {
    if (unit === 'd') { const s = today + oo * DAY_MS; return [s, s + DAY_MS]; }
    if (unit === 'w') { const e = today + DAY_MS + oo * 7 * DAY_MS; return [e - 7 * DAY_MS, e]; }
    const d = new Date(today + off);
    const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + oo, 1) - off;
    return [s, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1 + oo, 1) - off];
  };
  let m = 0;
  while (m > -1000 && at(m - 1)[0] >= oldest) m--;
  return m;
}

test('I-I1: 보관 3650일이면 1일 단위 −1500 이 열리고, minOff 는 −3650(루프 상한 −1000 이 아니다)', () => {
  const now = Date.UTC(2026, 9, 21, 2, 30);
  const r = pu.periodOf('d', -1500, { now, retentionDays: 3650 });
  assert.equal(r.issue, undefined, r.issue);
  assert.equal(r.minOff, -3650);
  assert.equal(r.start, KST0 - 1500 * D);
  assert.ok(pu.periodOf('d', -3651, { now, retentionDays: 3650 }).issue);
  assert.equal(pu.periodOf('w', 0, { now, retentionDays: 3650 }).minOff, oldMinOff('w', { now, retentionDays: 3650 }));
  assert.equal(pu.periodOf('m', 0, { now, retentionDays: 3650 }).minOff, oldMinOff('m', { now, retentionDays: 3650 }));
});

test('I-I1: 기존 범위(−1000 안)에서는 옛 루프와 결과가 같다 — 단위·보관 일수·달 경계 전수', () => {
  const nows = [];
  for (let mo = 0; mo < 12; mo++) for (const day of [1, 2, 15, 28, 29, 30, 31]) {
    for (const hr of [0, 14, 15, 23]) { const t = Date.UTC(2024, mo, day, hr, 5); if (new Date(t).getUTCMonth() === mo) nows.push(t); }
  }
  const rets = [1, 2, 3, 6, 7, 8, 13, 14, 15, 27, 28, 29, 30, 31, 32, 59, 60, 61, 90, 365, 366, 400, 730, 999, 1000, 1130, 3650, 0.5, 6.9];
  let n = 0;
  for (const now of nows) for (const R of rets) for (const unit of ['d', 'w', 'm']) {
    const old = oldMinOff(unit, { now, retentionDays: R });
    if (old <= -1000) continue;   // 옛 루프가 상한에 걸린 경우만 다르다(I-I1 의 결함)
    assert.equal(pu.periodOf(unit, 0, { now, retentionDays: R }).minOff, old, `${unit} R=${R} now=${new Date(now).toISOString()}`);
    n++;
  }
  assert.ok(n > 2000, `대조 ${n}건`);
});

function fixture() {
  const now = Date.UTC(2026, 9, 21, 2, 30);
  const period = pu.periodOf('w', 0, { now, offsetMin: 540 });
  const histSince = period.start;
  const buckets = []; for (let t = histSince; t <= now; t += H) buckets.push(t);
  const flat = (x) => buckets.map(() => x);
  const series = [
    { port: 0, name: 'SYMMETRIX::000111::FA-1d', speed: '32G', avg: flat(300e6), peak: flat(400e6) },
    { port: 1, name: 'SYMMETRIX::000111::FA-2d', speed: '32G', avg: flat(60e6), peak: flat(80e6) },
    { port: 2, name: 'UNITY::000222::SPA-1', speed: '32G', avg: buckets.map((_, i) => (i === 3 ? null : 90e6)), peak: flat(95e6) },
    { port: 3, name: 'UNITY::000222::SPB-1', speed: '32G', avg: flat(900e6), peak: flat(950e6) },
    { port: 5, name: 'esx01 QLE2692', speed: '16G', avg: flat(1e6), peak: flat(1e6) },
  ];
  const ports = pu.portList([
    ...series.map((s, i) => ({ index: s.port, slotPort: String(s.port), state: 'online', speed: s.speed, attachedName: series[i].name })),
    { index: 7, slotPort: '7', state: 'offline', speed: '', attachedName: '' },
  ], new Map());
  return { period, histSince, ports, hist: { buckets, series }, now };
}

test('I-I2: 바탕(usageBase)을 재사용한 조립은 새로 조립한 것과 같고, 대상 고르기(usageTargetMembers)는 최종 대상과 같다', () => {
  const f = fixture();
  for (const [view, target] of [['port', null], ['port', '3'], ['port', 99], ['port', ''], ['storage', null], ['storage', 'UNITY::000222'], ['storage', 'NOPE']]) {
    const base = pu.usageBase(f);
    const members = pu.usageTargetMembers(base, { view, target });
    const fresh = pu.buildPortUsage({ ...f, view, target });
    const reused = pu.buildPortUsage({ ...f, view, target, base });
    assert.deepEqual(reused, fresh, `${view}/${target}`);
    assert.deepEqual(members, fresh.target?.members || [], `${view}/${target}`);
  }
  // 다른 입력으로 만든 바탕은 쓰지 않는다(잘못 재사용해도 결과가 틀리지 않게)
  const other = pu.usageBase({ ...f, hist: { buckets: [], series: [] } });
  assert.deepEqual(pu.buildPortUsage({ ...f, view: 'port', base: other }), pu.buildPortUsage({ ...f, view: 'port' }));
});

test('I-I2: 라우트는 buildPortUsage 를 한 번만 부르고, 대상은 같은 바탕에서 고른다', () => {
  const src = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/api/sanSwitch.js'), 'utf8'));
  const body = src.slice(src.indexOf('async function portUsageFor('), src.indexOf("api.get('/tools/sanswitch/devices/:id/port-usage'"));
  assert.ok(body.length > 100);
  assert.equal((body.match(/pu\.buildPortUsage\(/g) || []).length, 1);
  assert.match(body, /pu\.usageBase\(/);
  assert.match(body, /pu\.usageTargetMembers\(base,/);
  assert.match(body, /pu\.buildPortUsage\(\{[^}]*\bbase\b/);
});
