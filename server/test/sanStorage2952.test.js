/**
 * test/sanStorage2952.test.js — v2.952 'SAN 스토리지 성능' ⓑ 어레이 측 성능 + 후속(조닝 별칭 폴백 · ISL 단서).
 *  ① arrayPerf 파서(픽스처 — ⚠ 실장비 미확인 · 벤더 문서 모양): PowerMax keys/metrics(응답 시간은 둘 중 큰 값 · HostMBs×1e6) · PowerStore nodes(slot→Node A/B) ·
 *     ports(이름 줄임) · point(µs→ms · total 없으면 read+write · CPU 는 있을 때만) · Unity entries(시각 내림차순) · 누적 카운터 델타(리셋 · 단일 항목은 null) · buildFeSample(부모 먼저 · 64 상한 · 정제)
 *  ② nodeLoad 확장: hbps · queue 지표 · fe 묶음 · 100 초과 % 는 null · sanitizeNodeUnits(아는 필드 · 상한 · 종류) · unitIdOf 는 구분자 · 대소문자 무시
 *  ③ arraySide 순수: 접두(<시리얼>::) 고르기 · 정규화 짝짓기 · 최신(null 은 덮지 않음 · 오래됨) · 시계열 열 · 요약(합은 전부 읽었을 때만 · 최댓값은 단위 이름) · 대조 % · 점검 입력
 *  ④ db: node_unit 저장 · 조회 · fe 표본 적재 → fe 묶음 조회(raw · hourly 롤업 열)
 *  ⑤ 중앙 수신: 표본 안 units 를 정제해 저장(모르는 종류는 '' · 이름 없는 것은 버림)
 *  ⑥ 점검: arraySide 가 있으면 판정 · 없으면 unknown 에 사유 문구 · ISL 단서 문구(순수)
 *  ⑦ 실제 라우트(mock · 인증 끔): /array 의 arraySide(단위 · SAN 대조 · 시계열 · 보고 대조) · /check 의 어레이 측 값 · isl
 *  ⑧ 조닝 별칭 폴백: 심볼릭 이름이 없는 포트가 zone 별칭(Unity_SPA0_p8)으로 SPA 로 묶인다(directorOf 폴백 — 라우트의 aliasFor 경로)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanstorage2952-'));
process.env.CONFIG_DIR = tmp;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0' });

const MIN = 60_000; const HOUR = 3_600_000;
// 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(CLAUDE.md).
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR + 17 * MIN;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

let A; let N; let AS; let C; let I;
before(async () => {
  A = await import('../src/storage/collectors/arrayPerf.js');
  N = await import('../src/storage/nodeLoad.js');
  AS = await import('../src/sanswitch/arraySide.js');
  C = await import('../src/sanswitch/storagePerfCheck.js');
  I = await import('../src/sanswitch/islClue.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① arrayPerf 파서 — PowerMax · PowerStore · Unity · 표본 조립', () => {
  assert.deepEqual(A.parsePmaxDirectorKeys({ feDirectorInfo: [{ directorId: 'FA-1D' }, { directorId: 'FA-2D' }, { directorId: 'FA-1D' }, {}] }), ['FA-1D', 'FA-2D']);
  assert.deepEqual(A.parsePmaxDirectorKeys(null), []);
  const m = A.parsePmaxMetrics({ resultList: { result: [
    { timestamp: 1000, PercentBusy: 12.5, HostIOs: 3400, HostMBs: 120.5, ReadResponseTime: 0.4, WriteResponseTime: 0.9, QueueDepthUtilization: 7 },
    { timestamp: 2000, PercentBusy: '14', HostIOs: 3600, HostMBs: 130, ReadResponseTime: 0.3, WriteResponseTime: 1.1, QueueDepthUtilization: 120 }] } });
  assert.equal(m.ts, 2000); assert.equal(m.busy, 14); assert.equal(m.iops, 3600); assert.equal(m.hbps, 130e6, 'HostMBs × 1e6');
  assert.equal(m.lat, 1.1, '응답 시간은 읽기 · 쓰기 중 큰 값'); assert.equal(m.queue, null, '100 초과 % 는 null(지어내지 않는다)');
  assert.equal(A.parsePmaxMetrics({ resultList: { result: [] } }), null);
  const nodes = A.parsePstoreNodes([{ id: 'N1', slot: 0 }, { id: 'N2', slot: 1 }, { id: 'N3' }, null]);
  assert.deepEqual(nodes.map((n) => n.name), ['Node A', 'Node B', 'Node N3']);
  const ports = A.parsePstorePorts([{ id: 'P1', name: 'BaseEnclosure-NodeA-IoModule0-FEPort0', node_id: 'N1' }, { id: 'P2', name: 'x', node_id: 'N2', port_index: 3 }, { id: 'P3', name: 'weird' }], nodes);
  assert.deepEqual(ports.map((p) => [p.name, p.parent]), [['Node A FC0', 'Node A'], ['Node B FC3', 'Node B'], ['weird', null]]);
  const pt = A.parsePstorePoint([
    { timestamp: '2026-11-09T01:00:00Z', total_iops: 1200, avg_latency: 850, read_bandwidth: 1e6, write_bandwidth: 2e6 },
    { timestamp: '2026-11-09T01:05:00Z', read_iops: 500, write_iops: 700, avg_latency: '900', read_bandwidth: 3e6, write_bandwidth: 1e6, cpu_utilization: 33 }]);
  assert.equal(pt.iops, 1200, 'total 이 없으면 read + write'); assert.equal(pt.lat, 0.9, 'µs → ms'); assert.equal(pt.hbps, 4e6); assert.equal(pt.cpu, 33);
  assert.equal(A.parsePstorePoint([{ timestamp: 't', total_iops: 1 }]).cpu, null, 'CPU 는 응답에 있을 때만');
  const ent = A.parseUnityEntries({ entries: [
    { content: { path: 'p', timestamp: '2026-11-09T01:00:00.000Z', interval: 60, values: { spa: { spa_fc4: 1000, spa_fc5: 500 }, spb: { spb_fc4: 100 } } } },
    { content: { path: 'p', timestamp: '2026-11-09T01:01:00.000Z', interval: 60, values: { spa: { spa_fc4: 1600, spa_fc5: 500 }, spb: { spb_fc4: 40 } } } }] });
  assert.equal(ent[0].ts > ent[1].ts, true, '최신이 먼저');
  const rate = A.unityCounterRate(ent);
  assert.equal(rate.intervalS, 60); assert.equal(rate.perSp.spa, 10, '(1600-1000)/60 + 0'); assert.equal(rate.perSp.spb, null, '줄어든 카운터(리셋)는 null');
  assert.equal(rate.perPort.spa_fc5.rate, 0); assert.equal(rate.perPort.spb_fc4.rate, null);
  assert.deepEqual(A.unityCounterRate(ent.slice(0, 1)), { perSp: {}, perPort: {}, intervalS: null }, '항목 하나면 델타 없음');
  assert.deepEqual(A.unitySpLatest(A.parseUnityEntries({ entries: [{ content: { timestamp: '2026-11-09T01:00:00Z', values: { spa: 12.5, spb: '9' } } }] })), { spa: 12.5, spb: 9 });
  // 조립 — 부모 먼저 · 포트는 남는 자리 · 빈 이름 버림 · % 범위
  const many = Array.from({ length: 70 }, (_, i) => ({ name: `FA-${i}D`, kind: 'fa', busy: i }));
  const s = A.buildFeSample({ ts: NOW, type: 'powermax', source: 't', units: [...many, { name: 'FA-1D 4', kind: 'port', parent: 'FA-1D' }] });
  assert.equal(s.nodes.length, 64); assert.equal(s.probe.omitted, 7, '부모 6 + 포트 1');
  const u = A.buildFeSample({ ts: NOW, type: 'unity480', source: 't', units: [{ name: 'SPA', kind: 'sp', cpu: 101, hbps: 100 }, { name: 'SPA FC4', kind: 'port', parent: 'SPA', hbps: 60 }, { name: '', kind: 'sp' }] });
  assert.deepEqual(u.units.map((x) => [x.name, x.kind, x.parent === u.units[0].id]), [['SPA', 'sp', false], ['SPA FC4', 'port', true]]);
  assert.equal(u.nodes[0].cpu, null, '101% 는 null'); assert.equal(u.nodes[0].hbps, 100); assert.equal(u.probe.measured.hbps, 2);
});

test('② nodeLoad 확장 — 지표 · 묶음 · 정제 · 단위 id', () => {
  assert.deepEqual(N.NODE_LOAD_GROUPS.fe, ['busy', 'cpu', 'iops', 'lat', 'hbps', 'queue']);
  assert.equal(N.METRIC_BY_KEY.get('hbps').unit, 'B/s'); assert.equal(N.METRIC_BY_KEY.get('queue').unit, '%');
  const s = N.sanitizeNodeLoadSample({ ts: NOW, nodes: [{ id: 5, busy: 50, queue: '120', hbps: -1, iops: '3000' }] });
  assert.deepEqual([s.nodes[0].busy, s.nodes[0].queue, s.nodes[0].hbps, s.nodes[0].iops], [50, null, null, 3000]);
  assert.equal(N.unitIdOf('FA-1D'), N.unitIdOf('fa 1d')); assert.equal(N.unitIdOf('Node A'), N.unitIdOf('NodeA')); assert.notEqual(N.unitIdOf('SPA'), N.unitIdOf('SPB'));
  assert.deepEqual(N.sanitizeNodeUnits([{ name: 'FA-1D', kind: 'fa' }, { name: '', kind: 'sp' }, { name: 'SPA', kind: 'zz', parent: '3' }, 'x', { name: 'FA-1D', kind: 'fa' }]),
    [{ id: N.unitIdOf('FA-1D'), name: 'FA-1D', kind: 'fa', parent: null }, { id: N.unitIdOf('SPA'), name: 'SPA', kind: '', parent: 3 }]);
  assert.equal(N.sanitizeNodeUnits(Array.from({ length: 80 }, (_, i) => ({ name: `U${i}`, kind: 'port' }))).length, 64);
  assert.equal(N.unitMatchKey(' spa_fc-4 '), 'SPAFC4');
});

test('③ arraySide 순수 — 접두 · 짝짓기 · 최신 · 시계열 · 요약 · 대조 · 점검 입력', () => {
  const units = AS.unitsForArray([{ id: 1, name: '000197900123::FA-1D', kind: 'fa' }, { id: 2, name: '000197900999::FA-1D', kind: 'fa' }, { id: 3, name: 'SPA', kind: 'sp' }], { serial: '000197900123' });
  assert.deepEqual(units.map((u) => [u.id, u.display]), [[1, 'FA-1D'], [3, 'SPA']], '다른 어레이 접두는 뺀다 · 접두 없는 것은 그대로');
  const m = AS.matchUnits([{ id: 1, display: 'FA-1D', kind: 'fa' }, { id: 4, display: 'Node A', kind: 'node' }, { id: 5, display: 'Node A FC0', kind: 'port' }],
    [{ group: 'FA-1D', parsed: true }, { group: 'NodeA', parsed: true }, { group: 'FA-2D', parsed: true }, { group: '(구분 못 함)', parsed: false }],
    [{ group: 'NodeA', directorPort: 'FC0' }]);
  assert.deepEqual(m.byUnit, { 1: { group: 'FA-1D', port: null }, 4: { group: 'NodeA', port: null }, 5: { group: 'NodeA', port: 'FC0' } });
  assert.deepEqual(m.unmatchedGroups, ['FA-2D']); assert.equal(m.matched, 2);
  const rows = [
    { node: 1, ts: NOW - 10 * MIN, v: { busy: 40, cpu: null, iops: 100, lat: 1, hbps: 1e8, queue: 10 } },
    { node: 1, ts: NOW - 5 * MIN, v: { busy: null, cpu: null, iops: 120, lat: null, hbps: null, queue: 12 } },
    { node: 3, ts: NOW - 60 * MIN, v: { busy: null, cpu: 30, iops: 50, lat: null, hbps: 5e7, queue: null } },
  ];
  const latest = AS.latestByUnit(rows, { now: NOW, staleMs: 15 * MIN });
  assert.equal(latest[1].v.busy, 40, 'null 표본은 마지막 값을 덮지 않는다'); assert.equal(latest[1].at.busy, NOW - 10 * MIN); assert.equal(latest[1].v.iops, 120); assert.equal(latest[1].ts, NOW - 5 * MIN); assert.equal(latest[1].stale, false);
  assert.equal(latest[3].stale, true, '60분 전 표본은 오래됨');
  const ser = AS.feSeries(rows);
  assert.deepEqual(ser.cols, [NOW - 60 * MIN, NOW - 10 * MIN, NOW - 5 * MIN]); assert.deepEqual(ser.byUnit[1].busy, [null, 40, null]); assert.deepEqual(ser.byUnit[3].cpu, [30, null, null]);
  const us = [{ id: 1, display: 'FA-1D', kind: 'fa' }, { id: 3, display: 'SPA', kind: 'sp' }, { id: 9, display: 'FA-1D 4', kind: 'port' }];
  const sum = AS.summarizeLatest(us, latest);
  assert.deepEqual([sum.busy.value, sum.busy.unit], [40, 'FA-1D']); assert.equal(sum.cpu, null, '오래된 단위는 뺀다 → 없음');
  assert.deepEqual([sum.hbps.value, sum.hbps.read, sum.hbps.of], [1e8, 1, 1], '신선한 fa 하나뿐 — 그 합');
  const latest2 = AS.latestByUnit([...rows, { node: 7, ts: NOW - MIN, v: { busy: 10, cpu: null, iops: null, lat: null, hbps: null, queue: null } }], { now: NOW, staleMs: 15 * MIN });
  const sum2 = AS.summarizeLatest([...us, { id: 7, display: 'FA-2D', kind: 'fa' }], latest2);
  assert.equal(sum2.hbps.value, null); assert.equal(sum2.hbps.partial, true, '한 디렉터의 처리량을 못 읽으면 합계 없음(부분 합 금지)'); assert.equal(sum2.busy.value, 40);
  assert.equal(AS.compareDiffPct(1.3e9, 1e9), 30); assert.equal(AS.compareDiffPct(1e9, 1e7), null, '스위치가 한가하면 비율 없음'); assert.equal(AS.compareDiffPct(null, 1e9), null);
  const ci = AS.toCheckInput(sum, { switchBps: 8e7 });
  assert.deepEqual(Object.keys(ci).sort(), ['compare', 'dirBusy', 'queue', 'resp']); assert.equal(ci.dirBusy.value, 40); assert.equal(ci.dirBusy.group, 'FA-1D'); assert.equal(ci.compare.value, 25);
  assert.deepEqual(Object.keys(AS.toCheckInput(sum2, { switchBps: 8e7 })).sort(), ['dirBusy', 'queue', 'resp'], '합계가 없으면 대조도 없다');
});

test('④ db — 단위 카탈로그 · fe 표본 적재 · 조회', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const db = await import('../src/storage/db.js');
  const id = 'st-2952';
  const sample = A.buildFeSample({ ts: NOW - 5 * MIN, type: 'powermax', source: 't', units: [{ name: 'FA-1D', kind: 'fa', busy: 41, iops: 3000, hbps: 2e8, queue: 9, lat: 0.8 }, { name: 'FA-2D', kind: 'fa', busy: 33, iops: 2000, hbps: 1e8 }] });
  const su = await db.saveNodeUnits(id, sample.units, NOW);
  assert.equal(su.saved, 2);
  const again = await db.saveNodeUnits(id, [{ ...sample.units[0], kind: 'fa', name: 'FA-1D' }], NOW + 1000);
  assert.equal(again.saved, 1);
  const units = await db.nodeUnitsOf(id);
  assert.deepEqual(units.map((u) => [u.id, u.name, u.kind]), [[N.unitIdOf('FA-1D'), 'FA-1D', 'fa'], [N.unitIdOf('FA-2D'), 'FA-2D', 'fa']]);
  assert.equal(units[0].firstSeen, NOW, 'first_seen 은 지킨다'); assert.equal(units[0].lastSeen, NOW + 1000);
  const r = await db.saveNodeLoadSample(id, sample);
  assert.equal(r.saved, true, JSON.stringify(r));
  const r2 = await db.saveNodeLoadSample(id, A.buildFeSample({ ts: NOW - 10 * MIN, type: 'powermax', source: 't', units: [{ name: 'FA-1D', kind: 'fa', busy: 39, hbps: 1.8e8 }] }));
  assert.equal(r2.saved, true);
  const q = await db.nodeLoadQuery(id, { group: 'fe', kind: 'raw', from: NOW - HOUR, to: NOW });
  assert.equal(q.rows.length, 3);
  const fa1 = q.rows.filter((x) => x.node === N.unitIdOf('FA-1D')).sort((a, b) => a.ts - b.ts);
  assert.deepEqual(fa1.map((x) => x.v.busy), [39, 41]); assert.deepEqual(fa1.map((x) => x.v.hbps), [1.8e8, 2e8]); assert.equal(fa1[1].v.queue, 9); assert.equal(fa1[0].v.queue, null, '못 읽은 값은 null');
  const b = await db.nodeLoadQuery(id, { group: 'fe', kind: 'bucket', from: NOW - 2 * HOUR, to: NOW, bucketMs: HOUR });
  const bf = b.rows.find((x) => x.node === N.unitIdOf('FA-1D'));
  assert.equal(bf.v.busy, 40, '칸 평균'); assert.equal(bf.mx.busy, 41); assert.equal(bf.n.queue, 1, '큐는 한 표본만 읽혔다');
  // 순수 조립 → 최신 · 요약(DB 행 모양 그대로)
  const latest = AS.latestByUnit(q.rows, { now: NOW, staleMs: 15 * MIN });
  const sum = AS.summarizeLatest(AS.unitsForArray(units, { serial: '' }), latest);
  assert.equal(sum.busy.value, 41); assert.equal(sum.hbps.value, 3e8, '두 디렉터 다 읽었으니 합'); assert.equal(sum.hbps.read, 2);
});

test('⑤ 중앙 수신 — 표본 안 units 정제 저장', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const E = await import('../src/central/storageEdge.js');
  const db = await import('../src/storage/db.js');
  const out = await E.saveEdgeNodeLoadSamples('edge-x', [{ deviceId: 'st-edge-2952', samples: [{ ts: NOW - MIN, nodes: [{ id: 11, busy: 20, hbps: 1e6 }],
    units: [{ id: 11, name: 'Node A', kind: 'node' }, { name: '', kind: 'node' }, { id: 12, name: 'Node A FC0', kind: 'bogus', parent: 11 }] }] }], { now: NOW });
  assert.equal(out.saved, 1); assert.equal(out.units, 2);
  const units = await db.nodeUnitsOf('st-edge-2952');
  assert.deepEqual(units.map((u) => [u.id, u.name, u.kind, u.parent]).sort((a, b) => a[0] - b[0]), [[11, 'Node A', 'node', null], [12, 'Node A FC0', '', 11]], '모르는 종류는 빈 값 · 이름 없는 것은 버린다');
});

test('⑥ 점검 — arraySide 판정 · 사유 문구 · ISL 단서', () => {
  const S = { values: { dirBusyWarnPct: null, dirBusyBadPct: 70, respWarnMs: null, respBadMs: null, queueWarnPct: null, queueBadPct: 75, compareDiffPct: 30, pstoreCpuWarnPct: 50, pstoreCpuBadPct: 70, unityCpuWarnPct: 70, unityCpuBadPct: 90, portSatWarnPct: 70, portSatBadPct: 90, asymMinSharePct: 30 } };
  const row = { key: 'SYMMETRIX::1', vendor: 'powermax', state: 'ok', stateText: '', directors: [], fabrics: [], ports: [], now: { ts: NOW, bps: 1e9 } };
  const r = C.checkArray(row, S, { arraySide: { dirBusy: { value: 72, group: 'FA-1D' }, queue: { value: 20 }, compare: { value: 41 } }, arraySideText: 'x' });
  assert.equal(r.items.dirBusy.status, 'bad'); assert.equal(r.items.queue.status, 'ok'); assert.equal(r.items.compare.status, 'warn');
  assert.equal(r.items.resp.status, 'unknown'); assert.match(r.items.resp.text, /^값 없음/, '어레이 측에 그 지표가 없으면 값 없음(전체 사유가 아니라)');
  const r2 = C.checkArray(row, S, { arraySide: null, arraySideText: 'SSH 로 수집하는 장비는 어레이 측 성능 경로가 없습니다' });
  assert.equal(r2.items.dirBusy.status, 'unknown'); assert.match(r2.items.dirBusy.text, /SSH/);
  assert.equal(C.checkArray(row, S).items.dirBusy.text, '어레이 측 성능 미수집');
  // ISL 단서(순수)
  const sum = I.islSummaryOf([{ port: 1, portType: 'E', speed: '32G', peak: [1e9, 3.2e9] }, { port: 2, portType: 'F', speed: '32G', peak: [4e9] }, { port: 3, portType: 'E-Port', speed: '', peak: [1e9] }]);
  assert.deepEqual([sum.ports, sum.unknownSpeed, sum.peakSatPct, sum.worstPort], [2, 1, 80, 1]);
  const clues = new Map([['sw1', { name: 'SW-A', ports: 2, peakSatPct: 80 }], ['sw2', { name: 'SW-B', ports: 0, peakSatPct: null }], ['sw3', { name: 'SW-C', error: 'x' }]]);
  assert.equal(I.islClueText([{ deviceId: 'sw1', name: 'SW-A' }, { deviceId: 'sw2', name: 'SW-B' }, { deviceId: 'sw3', name: 'SW-C' }], clues, { warnPct: 70 }),
    'ISL 단서 — SW-A: ISL 피크 80%(포화 주의) · SW-B: ISL 없음 · SW-C: ISL 조회 실패');
  assert.equal(I.islClueText([{ deviceId: 'none' }], clues), '');
});

test('⑦ 실제 라우트 — /array 어레이 측 · /check 어레이 측 값 · isl · ⑧ 조닝 별칭 폴백', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const reg = await import('../src/sanswitch/registry.js');
  const { SAN_SWITCH_TYPES } = await import('../src/sanswitch/types.js');
  const { importSamples, invalidatePerfQueries } = await import('../src/sanswitch/perfDb.js');
  const sanStore = await import('../src/sanswitch/store.js');
  const stReg = await import('../src/storage/registry.js');
  const stStore = await import('../src/storage/store.js');
  const db = await import('../src/storage/db.js');
  const swType = SAN_SWITCH_TYPES.find((x) => x.implemented)?.type || SAN_SWITCH_TYPES[0].type;
  reg.saveDevice({ type: swType, name: 'SW-QA', host: '10.72.19.1', username: 'u', password: 'p', datacenterId: 'dcQ' });
  reg.saveDevice({ type: swType, name: 'SW-QB', host: '10.72.19.2', username: 'u', password: 'p', datacenterId: 'dcQ' });
  const devA = reg.listDevices().find((d) => d.name === 'SW-QA'); const devB = reg.listDevices().find((d) => d.name === 'SW-QB');
  const now = Date.now();
  const serial = 'APM00249490001';
  // Unity 어레이: 팹 A 포트는 심볼릭 이름 있음 · 팹 B 포트 하나는 셋째 조각이 SPA/SPB 가 아니다(별칭 폴백 대상) · E-포트 하나(ISL)
  const meta = [
    { d: devA.id, p: 1, ts: now, name: `UNITY::${serial}::SPA FC0::FC::5.3`, wwn: '50:06:01:60:00:00:00:01', speed: '32G', type: 'F' },
    { d: devA.id, p: 2, ts: now, name: `UNITY::${serial}::SPB FC0::FC::5.3`, wwn: '50:06:01:68:00:00:00:02', speed: '32G', type: 'F' },
    { d: devB.id, p: 1, ts: now, name: `UNITY::${serial}::SPA FC1::FC::5.3`, wwn: '50:06:01:61:00:00:00:03', speed: '32G', type: 'F' },
    { d: devB.id, p: 2, ts: now, name: `UNITY::${serial}::port 8::FC::5.3`, wwn: '50:06:01:69:00:00:00:04', speed: '32G', type: 'F' },   // 셋째 조각을 못 읽는 이름 → 별칭 폴백 대상
    { d: devA.id, p: 9, ts: now, name: '', wwn: '', speed: '32G', type: 'E' },
  ];
  const val = { [`${devA.id}|1`]: 100e6, [`${devA.id}|2`]: 100e6, [`${devB.id}|1`]: 100e6, [`${devB.id}|2`]: 100e6, [`${devA.id}|9`]: 3.2e9 };
  const rows = [];
  for (let k = 24; k >= 1; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * HOUR, p: m.p, b: val[`${m.d}|${m.p}`] });
  for (let k = 60; k >= 0; k--) for (const m of meta) rows.push({ d: m.d, ts: now - k * MIN, p: m.p, b: val[`${m.d}|${m.p}`] });
  await importSamples(rows, meta, 90);
  invalidatePerfQueries();
  // 조닝 스냅샷(팹 B): 그 포트의 WWN 을 별칭 Unity_SPB0_p1 로 — 스냅샷 모양은 types.js 의 압축 조닝 계약(zoning.available · zones[].members · aliasOf)
  const zoneSnap = { deviceId: devB.id, name: 'SW-QB', collectedAt: now, ok: true,
    zoning: { available: true, effectiveConfig: 'cfg1', source: 'cfgshow', zones: [{ name: 'z_host1_unity', members: ['50:06:01:69:00:00:00:04', '10:00:00:90:fa:00:00:01'],
      aliasOf: { '50:06:01:69:00:00:00:04': 'Unity_SPB0_p1', '10:00:00:90:fa:00:00:01': 'host1_hba0' } }] } };
  sanStore.putSnapshot(zoneSnap);
  // 스토리지 장비(Unity · REST) + 스냅샷(시리얼 일치) + fe 표본
  stReg.saveDevice({ type: 'unity480', name: 'UNITY-Q', host: '10.72.19.50', username: 'u', password: 'p', datacenterId: 'dcQ', collectMethod: 'api' });
  const stDev = stReg.listDevices().find((d) => d.name === 'UNITY-Q');
  assert.equal(stDev.nodeLoadEnabled, true, 'REST 어레이는 표본 토글 기본 켬');
  stStore.putSnapshot({ deviceId: stDev.id, type: 'unity480', name: 'UNITY-Q', collectedAt: now, ok: true, serial, capacity: { totalBytes: 1e15, usedBytes: 5e14, pct: 50 }, nodes: { count: 2, unhealthy: 0, list: [] }, pools: [], accounts: [], alerts: { unresolved: 3 }, sections: {}, extra: {} });
  const fe = (ts) => A.buildFeSample({ ts, type: 'unity480', source: 't', units: [{ name: 'SPA', kind: 'sp', cpu: 72, iops: 5000, hbps: 2.5e8 }, { name: 'SPB', kind: 'sp', cpu: 40, iops: 3000, hbps: 1.6e8 }, { name: 'SPA FC0', kind: 'port', parent: 'SPA', iops: 2500, hbps: 1.2e8 }] });
  await db.saveNodeUnits(stDev.id, fe(now).units, now);
  for (let k = 12; k >= 0; k--) await db.saveNodeLoadSample(stDev.id, fe(now - k * 5 * MIN));
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, j: await r.json().catch(() => null) }; };
  try {
    const key = encodeURIComponent(`UNITY::${serial}`);
    const a = await get(`/tools/san-storage/array?key=${key}&datacenterId=dcQ&hours=24`);
    assert.equal(a.s, 200, JSON.stringify(a.j).slice(0, 300));
    assert.equal(a.j.capacity?.deviceId, stDev.id, '시리얼로 스토리지 장비 짝');
    assert.equal(a.j.capacity?.alerts, 3, '미해결 알람 수를 싣는다(I)');
    const side = a.j.arraySide;
    assert.equal(side.eligible, true, JSON.stringify(side).slice(0, 200)); assert.equal(side.reason, null);
    assert.deepEqual(side.units.map((u) => [u.name, u.kind, u.group, u.port]), [['SPA', 'sp', 'SPA', null], ['SPB', 'sp', 'SPB', null], ['SPA FC0', 'port', 'SPA', 'FC0']], '부모 먼저 · SAN 그룹 · 포트 대조');
    assert.equal(side.units[0].latest.cpu, 72); assert.equal(side.units[0].stale, false); assert.equal(side.matched, 2); assert.deepEqual(side.unmatchedGroups, []);
    assert.equal(side.series.cols.length, 13); assert.equal(side.seriesKind, 'raw');
    assert.equal(side.summary.cpu.value, 72); assert.equal(side.summary.cpu.unit, 'SPA'); assert.equal(side.summary.hbps.value, 4.1e8, 'SP 둘의 합(포트는 합에 넣지 않는다)');
    assert.equal(side.compare.switchBps, 4e8, '스위치 지금 = 어레이 포트 4개 × 100MB/s'); assert.equal(side.compare.diffPct, 3);
    assert.match(side.docBasis, /문서 경로/);
    // ⑧ 별칭 폴백: 이름 없는 팹 B 포트가 SPB 로 묶였다(zone 별칭) — 디렉터 묶음에 '(구분 못 함)' 이 없다
    const groups = a.j.directors.map((d) => d.group);
    assert.ok(groups.includes('SPB') && !groups.includes('(구분 못 함)'), `별칭 폴백 실패: ${groups.join(',')}`);
    const p = a.j.ports.find((x) => x.deviceId === String(devB.id) && x.port === 2);
    assert.equal(p.group, 'SPB'); assert.equal(p.confidence, 'alias');
    // H: ISL 단서 — SW-QA 의 E-포트(32G · 피크 3.2GB/s = 80%)
    const isl = a.j.isl.find((x) => x.deviceId === String(devA.id));
    assert.equal(isl.ports, 1); assert.equal(isl.peakSatPct, 80); assert.equal(a.j.isl.find((x) => x.deviceId === String(devB.id)).ports, 0);
    // /check — 어레이 측 값이 들어가 판정된다(Unity CPU 72 ≥ 70 주의) · 팹 비대칭 문구에 ISL 단서
    const c = await get('/tools/san-storage/check?datacenterId=dcQ');
    assert.equal(c.s, 200);
    const r = c.j.results.find((x) => x.key === `UNITY::${serial}`);
    assert.ok(r, '점검 행');
    assert.equal(r.items.cpu.status, 'warn', JSON.stringify(r.items.cpu)); assert.match(r.items.cpu.text, /72/);
    assert.equal(r.items.dirBusy.status, 'na'); assert.equal(r.items.compare.status, 'ok'); assert.match(r.items.compare.text, /차이 3%/);
    assert.deepEqual(r.arraySide.keys.sort(), ['compare', 'cpu']); assert.equal(r.arraySide.eligible, true);
    assert.match(r.items.fabric.text, /ISL 단서 — SW-QA: ISL 피크 80%\(포화 주의\) · SW-QB: ISL 없음/);
  } finally { await new Promise((r) => srv.close(r)); }
});
