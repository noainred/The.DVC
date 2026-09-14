/**
 * v2.510 — 실시간(20초) 스파이크 수집 순수 로직 회귀.
 *
 * 고정하는 경계:
 *  · 임계 판정은 지표별(cpu/mem 은 % , ready 는 vCPU 당 %, 벌룬·스왑은 0 초과) — 하나로 뭉개지 않는다.
 *  · 결측(-1)은 어떤 트리거도 만족하지 않는다(0 으로 읽지 않는다).
 *  · 겹침 구간(afterTs 이하)은 버린다 — 50분 주기 × 60분 버퍼의 10분 겹침을 두 번 세지 않는다.
 *  · 패킹 ↔ 언패킹이 손실 없다(시각·값·결측).
 *  · run 은 표본 간격 1.5배 안에서만 이어지고, 길이는 표본 수 × 20초다(1표본 run 은 20초).
 *  · scope: 폴더는 접두 '경로' 일치('a/b' ≠ 'a/bc'), 호스트 선택은 그 위 VM 을 포함, 꺼진 VM 제외.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VM_COUNTERS, REALTIME_STEP_SEC } from '../src/vmseries/counters.js';
import { alignMoments, isSpike, splitSpikes, runsOf, packMoments, unpackMoments, momentToObject } from '../src/vmseries/spikes.js';
import { resolveTargets, folderMatches, normFolder, vcenterSelected, summarizeScope } from '../src/vmseries/scope.js';

const cols = VM_COUNTERS.map((c, i) => ({ ...c, cid: String(100 + i) }));
const T0 = Date.parse('2026-09-14T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const thr = { cpuPct: 50, memPct: 50, readyPct: 5 };

function seriesFor(vals, n = 6) {
  // vals: name -> (i) => v
  const m = new Map();
  cols.forEach((c) => {
    const f = vals[c.name];
    if (!f) return;
    m.set(c.cid, Array.from({ length: n }, (_, i) => ({ t: iso(T0 + i * 20_000), v: f(i) })));
  });
  return m;
}

test('alignMoments — 계열을 시각으로 합치고 없는 열은 -1', () => {
  const by = seriesFor({ cpuUsagePct: (i) => i * 1000, memActiveMB: () => 4096 }, 3);
  const ms = alignMoments(by, cols);
  assert.equal(ms.length, 3);
  assert.equal(ms[1].vals[cols.findIndex((c) => c.name === 'cpuUsagePct')], 1000);
  assert.equal(ms[1].vals[cols.findIndex((c) => c.name === 'memConsumedMB')], -1);
});

test('isSpike — 지표별 임계 · 결측 제외 · 벌룬/스왑은 0 초과', () => {
  const ci = (n) => cols.findIndex((c) => c.name === n);
  const base = () => new Array(cols.length).fill(-1);
  let v = base(); v[ci('cpuUsagePct')] = 4999; assert.equal(isSpike(v, cols, thr), false);
  v = base(); v[ci('cpuUsagePct')] = 5000; assert.equal(isSpike(v, cols, thr), true, '50.00% 는 임계 이상');
  v = base(); v[ci('memUsagePct')] = 5100; assert.equal(isSpike(v, cols, thr), true);
  // ready: 20초 창 = 20000ms. vCPU 4 → 5% = 4000ms
  v = base(); v[ci('cpuReadyMs')] = 3999; assert.equal(isSpike(v, cols, thr, { vcpu: 4 }), false);
  v = base(); v[ci('cpuReadyMs')] = 4000; assert.equal(isSpike(v, cols, thr, { vcpu: 4 }), true);
  v = base(); v[ci('cpuReadyMs')] = 99999; assert.equal(isSpike(v, cols, thr, {}), false, 'vCPU 를 모르면 ready 판정 안 함');
  v = base(); v[ci('memBalloonMB')] = 1; assert.equal(isSpike(v, cols, thr), true);
  v = base(); v[ci('memSwappedMB')] = 0; assert.equal(isSpike(v, cols, thr), false);
  v = base(); assert.equal(isSpike(v, cols, thr), false, '전부 결측이면 스파이크 아님');
  v = base(); v[ci('cpuUsagePct')] = 9000; assert.equal(isSpike(v, cols, { cpuPct: 0, memPct: 50, readyPct: 5 }), false, '임계 0 = 그 트리거 끔');
});

test('splitSpikes — 겹침(afterTs) 제외 · 시간별 표본 수 · 스파이크만 추림', () => {
  const by = seriesFor({ cpuUsagePct: (i) => (i % 2 ? 8000 : 1000) }, 6); // 1,3,5 가 스파이크
  const ms = alignMoments(by, cols);
  const r = splitSpikes(ms, cols, thr, { afterTs: T0 + 20_000 }); // 0,1 제외
  assert.equal(r.samples, 4);
  assert.equal(r.spikes.length, 2);
  assert.equal(r.firstTs, T0 + 40_000);
  assert.equal(r.lastTs, T0 + 100_000);
  assert.equal([...r.perHour.values()].reduce((a, b) => a + b, 0), 4);
});

test('runsOf — 연속 run 분할과 길이', () => {
  const at = (s) => ({ ts: T0 + s * 1000, vals: [] });
  const r = runsOf([at(0), at(20), at(40), at(100), at(200)]);
  assert.equal(r.count, 3);
  assert.equal(r.maxSec, 60, '3표본 run = 60초');
  assert.equal(r.totalSec, 100, '60 + 20 + 20');
  assert.equal(r.runs[1].n, 1);
});

test('packMoments ↔ unpackMoments — 무손실(시각·값·결측)', () => {
  const ms = [
    { ts: T0 + 20_000, vals: [5000, 12345, -1, 7000, 4096, 8192, 0, 0, 12, 3] },
    { ts: T0 + 40_000, vals: [9999, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  ];
  const p = packMoments(ms, 10);
  assert.equal(p.n, 2);
  assert.equal(p.t0, T0 + 20_000);
  assert.equal(p.t1, T0 + 40_000);
  const back = unpackMoments(p.buf, p.t0, 10);
  assert.deepEqual(back, ms);
  assert.equal(packMoments([], 10), null);
  const o = momentToObject(back[0], cols);
  assert.equal(o.cpuUsagePct, 50);
  assert.equal(o.cpuReadyMs, null, '결측은 null');
  assert.equal(o.memActiveMB, 4);
});

test('scope — 폴더 경로 접두 일치, 호스트 선택은 그 위 VM 포함, 꺼진 VM 제외', () => {
  assert.equal(normFolder('/vm/a/b/'), 'a/b');
  assert.equal(folderMatches('a/b/c', 'a/b'), true);
  assert.equal(folderMatches('a/bc', 'a/b'), false, "'a/b' 는 'a/bc' 의 접두가 아니다");
  const vc = 'apac:vc01';
  const snap = {
    vcenters: [{ id: vc }],
    hosts: [
      { id: `${vc}:host-1`, vcenterId: vc, name: 'esx1', cluster: 'C1', connectionState: 'CONNECTED' },
      { id: `${vc}:host-2`, vcenterId: vc, name: 'esx2', cluster: 'C2', connectionState: 'CONNECTED' },
      { id: `${vc}:host-3`, vcenterId: vc, name: 'esx3', cluster: 'C2', connectionState: 'DISCONNECTED' },
    ],
    vms: [
      { id: `${vc}:vm-1`, vcenterId: vc, name: 'a', host: 'esx1', cluster: 'C1', folder: 'prod/web', powerState: 'POWERED_ON', cpuCount: 2, memMB: 1024 },
      { id: `${vc}:vm-2`, vcenterId: vc, name: 'b', host: 'esx2', cluster: 'C2', folder: 'prod/db', powerState: 'POWERED_ON', cpuCount: 4, memMB: 2048 },
      { id: `${vc}:vm-3`, vcenterId: vc, name: 'c', host: 'esx2', cluster: 'C2', folder: 'dev', powerState: 'POWERED_OFF', cpuCount: 1, memMB: 512 },
      { id: `${vc}:vm-4`, vcenterId: vc, name: 'd', host: 'esx2', cluster: 'C2', folder: 'production', powerState: 'POWERED_ON', cpuCount: 1, memMB: 512, template: true },
    ],
  };
  const all = resolveTargets(snap, { scope: 'all' }, vc);
  assert.deepEqual(all.vms.map((v) => v.ref), ['vm-1', 'vm-2'], '꺼진 VM·템플릿 제외');
  assert.deepEqual(all.hosts.map((h) => h.ref), ['host-1', 'host-2'], '연결 끊긴 호스트 제외');

  const byHost = resolveTargets(snap, { scope: 'selected', targets: { [vc]: { hosts: [`${vc}:host-2`] } } }, vc);
  assert.deepEqual(byHost.hosts.map((h) => h.ref), ['host-2']);
  assert.deepEqual(byHost.vms.map((v) => v.ref), ['vm-2'], '호스트 위의 켜진 VM 포함');

  const byFolder = resolveTargets(snap, { scope: 'selected', targets: { [vc]: { folders: ['prod'] } } }, vc);
  assert.deepEqual(byFolder.vms.map((v) => v.ref), ['vm-1', 'vm-2']);
  assert.equal(byFolder.hosts.length, 0);

  const notListed = resolveTargets(snap, { scope: 'selected', targets: {} }, vc);
  assert.equal(notListed.mode, 'none');
  assert.equal(vcenterSelected({ enabled: true, scope: 'selected', targets: { [vc]: { all: true } } }, vc), true);
  assert.equal(vcenterSelected({ enabled: true, scope: 'selected', targets: {} }, vc), false);
  assert.equal(vcenterSelected({ enabled: false, scope: 'all' }, vc), false);
  const sum = summarizeScope(snap, { scope: 'all' });
  assert.deepEqual(sum, [{ vcenterId: vc, mode: 'all', vms: 2, hosts: 2 }]);
});

test('REALTIME_STEP_SEC 는 20 — ready %/vCPU 산식의 분모', () => {
  assert.equal(REALTIME_STEP_SEC, 20);
});
