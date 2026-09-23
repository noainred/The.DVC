/**
 * v2.594 — 5차 점검(7축 병렬 감사 + 축별 반증 검증) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 릴리스 노트에 기록).
 * 상태를 가진 모듈은 임시 CONFIG_DIR 을 먼저 정한 뒤 동적으로 불러온다(node --test 는 파일마다 프로세스가 따로다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2594-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

/* ── R2594-01 PowerMax: 사용량 결측이 normalize 에서 0 으로 되돌아가던 것 ── */
test('R2594-01 — PowerMax 사용량을 못 읽으면 합계·풀 사용량이 null 이다(0 이 아니다)', async () => {
  const { normalizePowermax, powermaxCapacity } = await import('../src/storage/collectors/powermax.js');
  const dev = { id: 'pm', type: 'vmax', name: 'PM', host: '10.0.0.1' };
  const snap = normalizePowermax(dev, { arrays: [{ symmetrixId: 'A1' }], caps: { A1: powermaxCapacity({ symmetrixId: 'A1', physicalCapacity: { total_capacity_gb: 100 } }) } });
  assert.ok(snap.capacity.totalBytes > 0);
  assert.equal(snap.capacity.usedBytes, null);
  assert.equal(snap.capacity.pct, null);
  assert.equal(snap.pools[0].usedBytes, null);
  assert.equal(snap.extra.poolsUsedUnreadable, 1);
  // 옛 caps 형태(usable_*_tb)는 그대로 읽는다
  const old = normalizePowermax(dev, { arrays: [{ symmetrixId: 'B' }], caps: { B: { usable_total_tb: 10, usable_used_tb: 4 } } });
  assert.equal(old.capacity.pct, 40);
  // 화면 문구(BoldText)에 백틱이 없다
  const all = normalizePowermax(dev, { arrays: [{ symmetrixId: 'C' }], caps: { C: powermaxCapacity({ symmetrixId: 'C', physicalCapacity: { total_capacity_gb: 10, used_capacity_gb: 10 } }) } });
  assert.ok(!/`/.test(all.extra.capacityBasisNote));
});

/* ── R2594-03 Isilon: 사용량 null 에서 HDD 사용량이 0 으로 계산되던 것 ── */
test('R2594-03 — Isilon 사용량을 못 읽으면 media.hdd 사용량·% 도 null 이다', async () => {
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const i = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [
    { key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.ssd.bytes.total', value: 100 }, { key: 'ifs.ssd.bytes.used', value: 30 }] } });
  assert.equal(i.capacity.usedBytes, null);
  assert.equal(i.media.hdd.usedBytes, null);
  assert.equal(i.media.hdd.pct, null);
  assert.equal(i.media.ssd.usedBytes, 30);
  const ok = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [
    { key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.used', value: 500 }, { key: 'ifs.ssd.bytes.total', value: 100 }, { key: 'ifs.ssd.bytes.used', value: 30 }] } });
  assert.equal(ok.media.hdd.usedBytes, 470);
  // 노드 풀 — 사용량 키가 없으면 null(있으면 값)
  const n = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { nodes: { nodes: [{ lnn: 1, status: 'OK' }] },
    nodeStats: { stats: [{ devid: 1, key: 'node.ifs.bytes.total', value: 500 }] } });
  assert.equal(n.nodes.list[0].hdd.usedBytes, null);
  assert.equal(n.nodes.list[0].hdd.pct, null);
});

/* ── R2594-05 통합 용량 추이 — 사용량 결측 장비가 있는 버킷은 사용량을 비운다 ── */
test('R2594-05 — 전체 합산 추이는 사용량 결측 장비가 있는 버킷의 사용량을 null 로 두고 개수를 준다', async () => {
  const db = await import('../src/storage/db.js');
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시 −30분(경계에서 떨어뜨린다)
  const mk = (id, used, t) => ({ deviceId: id, ok: true, collectedAt: t, capacity: { totalBytes: 1000, usedBytes: used, pct: null } });
  await db.saveCapacityPoint(mk('d1', 800, now));
  await db.saveCapacityPoint(mk('d2', null, now + 1000));
  await db.saveCapacityPoint(mk('d1', 800, now - 3_600_000));
  await db.saveCapacityPoint(mk('d2', 700, now - 3_600_000 + 1000));
  const pts = await db.capacityHistoryAll(now - 3 * 3_600_000, 3_600_000);
  assert.ok(pts.length >= 2, `버킷 ${pts.length}`);
  const partial = pts.find((p) => p.used_unknown === 1);
  const full = pts.find((p) => p.used_unknown === 0);
  assert.ok(partial && full);
  assert.equal(partial.used_bytes, null, '부분 합(800/2000=40%)을 전체처럼 주지 않는다');
  assert.equal(partial.total_bytes, 2000);
  assert.equal(full.used_bytes, 1500);
});

/* ── R2594-04 relaytopo — 비-admin 결과 경로의 주소 가림 ── */
test('R2594-04 — 비-admin 결과에는 IP·오류·점검 문구가 없다(개수만)', async () => {
  const ops = await import('../src/relaytopo/ops.js');
  ops._resetForTest();
  ops._setResultForTest('SEOUL', {
    ok: true, dc: 'SEOUL', at: 1,
    edge: { role: 'edge', host: '203.0.113.7', port: 22, via: 'jump 10.1.2.3', source: 'deploy', ok: false, error: 'connect ECONNREFUSED 203.0.113.7:22', listeners: [4000] },
    irs: { role: 'irs', host: '10.9.9.9', port: 22, ok: true, haproxy: { cfg: 'x' } },
    rows: [{ key: 'hq', expected: { host: '10.0.0.5', port: 4000 }, actual: { host: '10.0.0.6', port: 4000 }, status: 'mismatch', issue: '백엔드 10.0.0.6 이 다릅니다', fix: '10.0.0.5 로' }],
    irsIssues: [{ level: 'warn', text: 'CENTRAL_URL(http://10.0.0.5:4000)', fix: 'x' }],
    summary: { total: 1, bad: 1 },
  });
  const masked = JSON.stringify(ops.lastResults({ full: false }));
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(masked), `IP 가 남았다: ${masked}`);
  const r = ops.lastResults({ full: false }).SEOUL;
  assert.equal(r.maskedAddress, true);
  assert.equal(r.irsIssueCount, 1);
  assert.equal(r.summary.bad, 1, '요약 수치는 남긴다');
  assert.ok(/203\.0\.113\.7/.test(JSON.stringify(ops.lastResults({ full: true }))), 'admin 은 원문');
  const route = read('routes/api/relaytopo.js');
  assert.match(route, /present: !!\(n\.privateIp \|\| n\.publicIp\)/, 'IRS 존재 여부는 불리언으로 남긴다(R2594-06)');
});

/* ── SEC-2594-01~03 페이징 하한 ── */
test('SEC-2594-01 — pageArgs: 음수·실수·거대값·비숫자 limit/offset 을 막는다', async () => {
  const { pageArgs } = await import('../src/util/pageArgs.js');
  assert.deepEqual(pageArgs({ limit: '-1' }), { limit: 1, offset: 0 });
  assert.deepEqual(pageArgs({ limit: '0' }), { limit: 200, offset: 0 });
  assert.deepEqual(pageArgs({ limit: '5000' }), { limit: 1000, offset: 0 });
  assert.deepEqual(pageArgs({ limit: '0.5', offset: '1e400' }), { limit: 200, offset: 0 });
  assert.deepEqual(pageArgs({ limit: '50.9', offset: '1e20' }), { limit: 50, offset: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(pageArgs({ limit: 'x', offset: '-3' }), { limit: 200, offset: 0 });
  for (const f of ['routes/api/checksLogs.js', 'routes/api/reports.js']) {
    assert.ok(!/Math\.min\(1000, Number\(req\.query\.limit\)/.test(read(f)), `${f}: 하한 없는 limit 가 남았다`);
  }
  assert.match(read('logs/db.js'), /\.\.\.clampPage\(limit, offset\)/, '헬퍼 쪽에서도 클램프한다(새 호출부 자동 보호)');
});
test('SEC-2594-01 — logs DB query 는 음수 LIMIT 를 무제한으로 넘기지 않는다', async () => {
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const rows = Array.from({ length: 260 }, (_, i) => ({ vcenterId: 'vc', ts: 1_000 + i, severity: 'info', type: 't', user: '', entity: '', message: `m${i}` }));
  db.insertMany(rows);
  assert.equal(db.query({}, -1, 0).length, 200, '음수 limit 는 기본 200');
  assert.equal(db.query({}, 1e20, 0).length, 260);
  assert.equal(db.query({}, 10, 0.5).length, 10, '실수 offset 이 500 을 만들지 않는다');
});
test('SEC-2594-04 — vmware-config 다운로드 파일명은 안전한 문자만', () => {
  const s = read('routes/api/checksLogs.js');
  assert.match(s, /replace\(\/\[\^A-Za-z0-9\._-\]\+\/g, '_'\)/);
  assert.ok(!/vmware-config-\$\{data\.meta\.scope\}/.test(s));
});

/* ── EDGE2-01 svcmon 엣지 보고 부속 객체 크기 상한 ── */
test('EDGE2-01 — svcmon 엣지 poller·caps·log 가 16KB 를 넘으면 버리고 그 사실을 남긴다', async () => {
  const m = await import('../src/central/svcmonEdge.js');
  const big = { junk: 'x'.repeat(40_000) };
  m.ingestReport('edge-big', { snapId: 's1', seq: 1, total: 1, poller: big, caps: { portalPort: 4000, blob: 'y'.repeat(40_000) }, log: { small: 1 }, rows: [] });
  const a = m.getAgentRaw('edge-big');
  assert.equal(a.poller.dropped, true);
  assert.ok(a.poller.bytes > m.EDGE_AUX_MAX_BYTES);
  assert.equal(a.caps.dropped, true);
  assert.equal(a.portalPort, 4000, '포트는 원본에서 읽는다');
  assert.deepEqual(a.log, { small: 1 }, '작은 객체는 그대로');
});

/* ── EDGE2-02 SAN 사용량 엣지 상태 퇴출 순서 ── */
test('EDGE2-02 — 방금 보고한 엣지는 상한 퇴출에서 밀려나지 않는다', () => {
  const s = read('central/sanSwitchPerfEdge.js');
  assert.match(s, /m\.delete\(a\);\s*m\.set\(a, \{ at: Date\.now\(\), status: st \}\)/);
});

/* ── EDGE2-03·04 ── */
test('EDGE2-03 — ip-scan-result 는 병합한 개수만 보고한다 · EDGE2-04 진행 보고 실패를 남긴다', () => {
  const c = read('routes/central.js');
  assert.match(c, /merged: validAlive\.length/);
  assert.match(c, /alive: validAlive\.length/);
  const w = read('agent/idracScanWorker.js');
  assert.ok(!/idrac-scan-progress[\s\S]{0,300}\.catch\(\(\) => \{\}\)/.test(w), '진행 보고 catch 무음이 남았다');
  assert.match(w, /progressError: _progressError/);
});

/* ── LO-2 IPAM override 키 정규형 ── */
test('LO-2 — 선행 0 표기로 저장해도 정규 키로 붙고 유령 키가 남지 않는다', async () => {
  const ov = await import('../src/ipam/overrides.js');
  assert.equal(ov.setOverride('010.39.0.1', { label: 'LZ' }, { username: 't' }).ok, true);
  assert.equal(ov.getOverride('10.39.0.1')?.label, 'LZ');
  const keys = Object.keys(ov.getOverrides ? ov.getOverrides() : JSON.parse(fs.readFileSync(path.join(CFG, 'ipam-overrides.json'), 'utf8')));
  assert.ok(keys.includes('10.39.0.1') && !keys.includes('010.39.0.1'), `키: ${keys}`);
  const b = ov.setOverrideBatch(['010.39.0.2', '10.39.0.2'], { status: 'reserved' }, { username: 't' });
  assert.equal(b.changed, 1, '같은 IP 의 두 표기는 하나다');
  ov.clearOverride('010.39.0.1');
  assert.equal(ov.getOverride('10.39.0.1'), null);
  const an = await import('../src/ipam/annotations.js');
  an.setAnnotation('010.39.0.9', { memo: 'm' }, { username: 't' });
  assert.equal(an.getAnnotation('10.39.0.9')?.memo, 'm');
});

/* ── DATA2594-03 vmtrack — 첫 수집 중인 vCenter 가 있으면 슬롯 기록을 미룬다 ── */
test('DATA2594-03 — vmtrack 폴러는 pending vCenter 가 있으면 대기 상한까지 기다리고, 결과에 빠진 vCenter 를 싣는다', () => {
  const p = read('vmtrack/poller.js');
  assert.match(p, /if \(pending && Date\.now\(\) - slotStartMs\(cur\) < PENDING_WAIT_MS\)/);
  assert.match(read('vmtrack/service.js'), /skippedVcenters/);
});

/* ── DATA2594-05 PDU 데이지체인 — E1xx 외 실패는 부분 합임을 밝힌다 ── */
test('DATA2594-05 — PDU 유닛 읽기 실패(E1xx 아님)는 조용히 멈추지 않는다', async () => {
  const s = read('pdu/collectors/apcSsh.js');
  assert.match(s, /if \(!\/\^E1\/i\.test\(String\(power\.code \|\| ''\)\) && i > 1\)/);
  const { summarize } = await import('../src/pdu/types.js');
  assert.equal(summarize({ units: [{ powerW: 100 }], sensors: [], unitsIncomplete: true }).unitsIncomplete, true);
});

/* ── LO-1(= v2.593 DATA-03) 끊긴 호스트는 사용률 분모에서 뺀다 ── */
test('LO-1 — 연결 끊긴 호스트는 사용률 계산에서 빠지고 용량 합계에는 남는다', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const h = (id, st, u) => ({ id, vcenterId: 'vc1', connectionState: st, cpuTotalMhz: 1000, cpuUsageMhz: u, memTotalMB: 1000, memUsageMB: u, cpuCores: 4 });
  const snap = { vcenters: [{ id: 'vc1', region: 'AP', status: 'connected' }],
    hosts: [h('a', 'CONNECTED', 800), h('b', 'CONNECTED', 800), h('c', 'DISCONNECTED', 0), h('d', 'NOT_RESPONDING', 0)],
    vms: [], datastores: [], networks: [], alarms: [] };
  const r = scopedRollups(snap, new Set(['vc1']));
  assert.equal(r.global.cpuUsagePct, 80, '예전: 40');
  assert.equal(r.global.memUsagePct, 80);
  assert.equal(r.global.cpuTotalGhz, 4, '용량 합계는 네 대 전부');
  const vc = (r.byVcenter || []).find((x) => x.key === 'vc1') || (r.byRegion || [])[0];
  if (vc) assert.equal(vc.cpuUsagePct, 80, 'vCenter/지역 롤업도 같은 기준');
});

/* ── UI-2594-02 · R2594-07 · PERF-2594-01 ── */
test('UI-2594-02·R2594-07·PERF-2594-01 — 로그 undefined · MIG 진단 0% · 워커 레코드 전송', () => {
  assert.ok(!/perWorkerConcurrency/.test(read('svcmon/poller.js')));
  assert.match(read('gpu/poller.js'), /util: r\.utilNA \? null : r\.utilPct, utilNA: !!r\.utilNA/);
  assert.match(read('ipam/db.js'), /postMessage\(\{ id, records: rows\.map\(\(r\) => toRecord\(r, updatedAt\)\) \}\)/);
});
test('PERF-2594-01 — 워커가 레코드 배열로 적재한 결과가 인라인 레코드와 같다', async () => {
  const { COLUMNS, toRecord } = await import('../src/ipam/record.js');
  const row = { ip: '10.0.0.1', ipNum: 167772161, ownerType: 'vm', label: 'x' };
  const rec = toRecord(row, 't');
  assert.equal(rec.length, COLUMNS.length);
  // structuredClone 을 지나도 같은 값(워커로 보내는 것은 이 배열이다)
  assert.deepEqual(structuredClone([rec])[0], rec);
});
