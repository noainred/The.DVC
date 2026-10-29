/**
 * v2.748 — SAN 포트 사용량 화면(시안 A안 개정 2) 순수 코어 + 라우트 게이트.
 * 순수 함수는 now 를 주입하므로 고정 시각을 쓴다(docs/rules/common.md — 주입형은 고정 시각 허용).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanpu2748-'));
const pu = await import('../src/sanswitch/portUsage.js');
const H = 3_600_000, D = 86_400_000;
// 2026-10-21 11:30 KST(= 02:30 UTC)
const NOW = Date.UTC(2026, 9, 21, 2, 30);
const KST0 = Date.UTC(2026, 9, 20, 15, 0);   // 2026-10-21 00:00 KST

test('periodOf: 하루·7일·달력 한 달 경계는 한국 자정 기준이고 off 로 과거로 간다', () => {
  const d = pu.periodOf('d', 0, { now: NOW, offsetMin: 540 });
  assert.equal(d.start, KST0); assert.equal(d.end, KST0 + D); assert.equal(d.days.length, 1);
  assert.equal(d.label, '2026-10-21 (수)'); assert.equal(d.current, true); assert.equal(d.fine, true);
  const d1 = pu.periodOf('d', -1, { now: NOW, offsetMin: 540 });
  assert.equal(d1.start, KST0 - D); assert.equal(d1.current, false);
  const w = pu.periodOf('w', 0, { now: NOW, offsetMin: 540 });
  assert.equal(w.end, KST0 + D); assert.equal(w.start, KST0 - 6 * D); assert.equal(w.days.length, 7);
  assert.equal(w.label, '10-15(목) ~ 10-21(수)');
  assert.equal(pu.periodOf('w', -1, { now: NOW, offsetMin: 540 }).end, KST0 - 6 * D);
  const m = pu.periodOf('m', 0, { now: NOW, offsetMin: 540 });
  assert.equal(m.start, Date.UTC(2026, 9, 1) - 540 * 60_000); assert.equal(m.days.length, 31); assert.equal(m.label, '2026년 10월');
  const m1 = pu.periodOf('m', -1, { now: NOW, offsetMin: 540 });
  assert.equal(m1.days.length, 30); assert.equal(m1.end, m.start);
  // 해를 넘긴다
  assert.equal(pu.periodOf('m', -10, { now: NOW, offsetMin: 540 }).label, '2025년 12월');
});

test('periodOf: 15분 칸은 31일 안의 1일 단위만, 하한은 보관 기간 · 틀린 입력은 issue(조용히 자르지 않는다)', () => {
  assert.equal(pu.periodOf('d', -30, { now: NOW }).fine, true);
  assert.equal(pu.periodOf('d', -31, { now: NOW }).fine, false);
  assert.equal(pu.periodOf('w', 0, { now: NOW }).fine, false);
  const r = pu.periodOf('d', 0, { now: NOW, retentionDays: 730 });
  assert.equal(r.minOff, -730);
  assert.equal(pu.periodOf('w', 0, { now: NOW, retentionDays: 730 }).minOff, -103);
  assert.ok(pu.periodOf('d', -731, { now: NOW, retentionDays: 730 }).issue);
  assert.ok(pu.periodOf('d', 1, { now: NOW }).issue);
  assert.ok(pu.periodOf('d', 0.5, { now: NOW }).issue);
  assert.ok(pu.periodOf('d', NaN, { now: NOW }).issue);
  assert.ok(pu.periodOf('y', 0, { now: NOW }).issue);
});

test('capBpsOf: 모르는 속도는 null(0 이 아니다)', () => {
  assert.equal(pu.capBpsOf('16G'), 2e9);
  assert.equal(pu.capBpsOf(''), null); assert.equal(pu.capBpsOf('자동'), null); assert.equal(pu.capBpsOf('0G'), null);
});

test('denseByPort: 성긴 버킷을 위치로 놓고, 지금 이후에 시작하는 칸은 비운다(데모 수식의 미래 값 차단)', () => {
  const since = KST0;
  const res = { buckets: [since, since + 2 * H, since + 20 * H], series: [{ port: 3, avg: [10, 20, 99], peak: [11, 25, 199] }] };
  const m = pu.denseByPort(res, { since, bucketMs: H, n: 24, now: NOW });
  const s = m.get(3);
  assert.equal(s.avg[0], 10); assert.equal(s.avg[1], null); assert.equal(s.avg[2], 20);
  assert.equal(s.avg[20], null, '20시는 지금(11:30) 이후 — 값이 있어도 비운다');
});

test('hoursToDays: 평균은 값 있는 시간만, n 은 값 있는 시간 수, 하나도 없으면 null', () => {
  const avg = new Array(48).fill(null), peak = new Array(48).fill(null);
  avg[0] = 10; peak[0] = 30; avg[5] = 20; peak[5] = 50;
  const days = pu.hoursToDays(avg, peak, 2);
  assert.deepEqual(days[0], [15, 50, 2]);
  assert.equal(days[1], null);
});

test('sumCells·sumSeries: 멤버가 다 있는 칸만 더하고, 일부만 있으면 null + partial', () => {
  const a = [[10, 20, 1], null, [5, 6, 1]], b = [[1, 2, 1], [3, 4, 1], null];
  const r = pu.sumCells([a, b]);
  assert.deepEqual(r.cells[0], [11, 22, 1]); assert.equal(r.cells[1], null); assert.equal(r.cells[2], null); assert.equal(r.partial, 2);
  const s = pu.sumSeries([[1, null, 3], [1, 2, null]]);
  assert.deepEqual(s.values, [2, null, null]); assert.equal(s.partial, 2);
});

function fixture({ withHole = false } = {}) {
  const period = pu.periodOf('w', 0, { now: NOW, offsetMin: 540 });
  const histSince = period.start;
  const buckets = []; for (let t = histSince; t <= NOW; t += H) buckets.push(t);
  const flat = (v) => buckets.map(() => v);
  const series = [
    { port: 0, name: 'SYMMETRIX::000111::FA-1d', speed: '32G', avg: flat(300e6), peak: flat(400e6) },
    { port: 1, name: 'SYMMETRIX::000111::FA-2d', speed: '32G', avg: flat(60e6), peak: flat(80e6) },
    { port: 2, name: 'SYMMETRIX::000111::FA-3d', speed: '32G', avg: withHole ? buckets.map((_, i) => (i === 3 ? null : 60e6)) : flat(60e6), peak: flat(80e6) },
    { port: 5, name: 'esx01 QLE2692', speed: '16G', avg: flat(1e6), peak: flat(1e6) },
  ];
  const ports = pu.portList([
    { index: 0, slotPort: '0', state: 'online', speed: '32G', attachedName: series[0].name },
    { index: 1, slotPort: '1', state: 'online', speed: '32G', attachedName: series[1].name },
    { index: 2, slotPort: '2', state: 'online', speed: '32G', attachedName: series[2].name },
    { index: 5, slotPort: '5', state: 'online', speed: '16G', attachedName: series[3].name },
    { index: 7, slotPort: '7', state: 'offline', speed: '', attachedName: '' },
  ], new Map());
  return { period, histSince, ports, hist: { buckets, series } };
}

test('buildPortUsage: 스토리지 묶음·부분 합 null·편중(1.4배 · 평균 0.5Gb/s 이상)·호스트는 묶지 않는다', () => {
  const f = fixture({ withHole: true });
  const r = pu.buildPortUsage({ ...f, view: 'storage', now: NOW });
  assert.equal(r.rows.length, 1, '호스트 포트(esx01)·이름 없는 포트는 스토리지 묶음이 아니다');
  assert.equal(r.rows[0].storage, 'SYMMETRIX::000111');
  assert.deepEqual(r.rows[0].members, [0, 1, 2]);
  assert.equal(r.rows[0].capBps, 3 * 4e9);
  assert.equal(r.target.kind, 'storage');
  // 차트: 3시(멤버 2 의 빈 칸)는 합을 내지 않는다
  assert.equal(r.target.chart.avg[3], null); assert.equal(r.target.chart.partial >= 1, true);
  assert.equal(r.target.chart.avg[0], 420e6);
  // 편중: 그룹 평균 = (300+60+60)/3 = 140MB/s(1.12Gb/s) ≥ 0.5Gb/s, 포트 0 = 2.14배
  assert.equal(r.imbalance.length, 1); assert.equal(r.imbalance[0].port, 0);
  const share = r.target.memberRows.find((x) => x.port === 0).share;
  assert.ok(share > 70 && share < 72, String(share));
  // 미래 칸은 비어 있다(7일 단위 — 오늘 칸은 값 있는 시간만)
  const todayCell = r.rows[0].cells[6];
  assert.ok(todayCell && todayCell[2] <= 12, '오늘 칸은 지금까지의 시간만 센다');
});

test('buildPortUsage: 그룹 평균이 0.5Gb/s 미만이면 편중이라 하지 않는다(한가한 묶음의 비율 잡음)', () => {
  const f = fixture();
  for (const s of f.hist.series) { s.avg = s.avg.map((v) => v / 100); }
  const r = pu.buildPortUsage({ ...f, view: 'storage', now: NOW });
  assert.equal(r.imbalance.length, 0);
});

test('buildPortUsage: 포트 보기 기본 대상은 평균이 가장 큰 포트, 모르는 target 은 기본값으로', () => {
  const f = fixture();
  const r = pu.buildPortUsage({ ...f, view: 'port', now: NOW });
  assert.equal(r.target.port, 0);
  assert.equal(r.rows.length, 5);
  assert.equal(r.rows.find((x) => x.port === 7).cells.every((c) => c === null), true, '데이터 없는 포트는 0 이 아니라 빈 칸');
  assert.equal(pu.buildPortUsage({ ...f, view: 'port', target: '5', now: NOW }).target.port, 5);
  assert.equal(pu.buildPortUsage({ ...f, view: 'port', target: '99', now: NOW }).target.port, 0);
});

test('idleOf: 꺼진 포트는 따로, 7일 미만은 보류, 속도 모름은 보류, 30일 피크 < 1% 만 유휴', () => {
  const ports = [
    { port: 1, state: 'online', speed: '16G', name: 'a' },
    { port: 2, state: 'online', speed: '16G', name: 'b' },
    { port: 3, state: 'online', speed: '', name: 'c' },
    { port: 4, state: 'offline', speed: '16G', name: '' },
    { port: 5, state: 'online', speed: '16G', name: 'e' },
  ];
  const arr = (v, n) => Array.from({ length: 30 }, (_, i) => (i < n ? v : null));
  const daily = new Map([
    [1, { avg: arr(1e6, 30), peak: arr(1e6, 30) }],          // 1MB/s < 2GB/s × 1% = 20MB/s → 유휴
    [2, { avg: arr(1e6, 3), peak: arr(1e6, 3) }],             // 3일 → 보류
    [3, { avg: arr(1e6, 30), peak: arr(1e6, 30) }],          // 속도 모름 → 보류
    [5, { avg: arr(30e6, 30), peak: arr(30e6, 30) }],        // 30MB/s ≥ 20MB/s → 유휴 아님
  ]);
  const r = pu.idleOf(ports, daily);
  assert.deepEqual(r.idle.map((x) => x.port), [1]);
  assert.deepEqual(r.pending.map((x) => x.port).sort(), [2, 3]);
  assert.deepEqual(r.off.map((x) => x.port), [4]);
});

test('usageCsvRows: 빈 칸은 0 이 아니라 빈 값, 스토리지 보기는 합계 + 멤버 행', () => {
  const f = fixture({ withHole: true });
  const r = pu.buildPortUsage({ ...f, view: 'storage', now: NOW });
  const rows = pu.usageCsvRows(r, { deviceName: 'SW1', offsetMin: 540 });
  assert.equal(rows[0][0], '스위치');
  assert.equal(rows.length - 1, (1 + 3) * 7);
  const future = rows.filter((x) => x[1].endsWith('합계'));
  assert.equal(future.length, 7);
  // 7일 단위의 하루 칸 — 값이 있는 날은 수, 내일 이후는 없다(이번 7일은 오늘로 끝난다)
  assert.equal(future[0][4], '2026-10-15 00:00');
  assert.equal(typeof future[0][6], 'number');
  const pr = pu.buildPortUsage({ ...fixture(), view: 'port', now: NOW });
  const emptyPort = pu.usageCsvRows(pr, {}).filter((x) => x[2] === '7');
  assert.ok(emptyPort.length && emptyPort.every((x) => x[6] === '' && x[7] === ''), '데이터 없는 포트는 빈 값');
});

test('라우트: 조회는 toolsPerm + 전체 범위, CSV 는 data.csv 권한 + 감사 로그', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/api/sanSwitch.js'), 'utf8');
  assert.match(src, /api\.get\('\/tools\/sanswitch\/devices\/:id\/port-usage', toolsPerm, fullScopeOnly,/);
  assert.match(src, /api\.get\('\/tools\/sanswitch\/devices\/:id\/port-usage\.csv', csvPerm, toolsPerm, fullScopeOnly,/);
  assert.match(src, /action: 'SAN 포트 사용량 CSV 내보내기'/);
});
