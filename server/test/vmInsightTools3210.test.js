/**
 * vmInsightTools3210.test.js — v3.21.0 VM 분석 화면이 쓰는 특수 기능 도구의 요약 모드(`?summary=1`).
 * 설계 docs/design/vm-insight §10 · 규약 docs/rules/security-api.md '도구 요약 모드' · routes/api/toolSummary.js.
 *
 * **실제 api 라우터**(requirePerm · toolGate · 범위 · memoJson)를 띄워 원본 응답과 요약 응답을 같은 스냅샷 · 같은 DB 로 대조한다:
 *  ① 요약의 법인별 합 = 원본 응답의 합계(판정 그대로 — 새 계산이 아니다)
 *  ② 잘린 목록이 아니라 전체로 센다(원본이 ROWS_MAX · LIST_LIMIT · 상위 50 으로 자르는 도구는 그 잘림을 먼저 확인한다)
 *  ③ 권한 — tools 권한 없는 계정 · 그 도구가 toolsDenied 인 계정은 원본과 같은 거부(상태 · 본문)
 *  ④ 범위 계정은 범위 밖 법인 줄이 없다(응답 어디에도 범위 밖 id · 이름이 없다)
 *  ⑤ 꺼진 지 구간 — 서버 offAgeBucketOf 와 웹 wasteViewText.ageBucketOf 가 같은 입력에 같은 칸
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vminsight3210-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true',
  GUESTDISK_DB_PATH: path.join(TMP, 'guest-disk.db'), VMTRACK_DB_PATH: path.join(TMP, 'vm-track.db'),
});
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
const TOOL_KEYS = ['guest-partition', 'waste', 'contention', 'vm-hygiene', 'vm-track', 'vm-lifecycle'];
// operator = tools 권한 없음 · viewer = tools 는 있으나 여섯 도구가 역할 거부(toolsDenied) · admin = 전부.
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'inv.vms'], viewer: ['dashboard', 'tools', 'inv.vms'], toolsDenied: { operator: [], viewer: TOOL_KEYS } },
}));

const DAY = 86_400_000;
const NOW = Date.now();
const N_A = 2100;   // vc-a 구동 VM — 경합 ROWS_MAX(1000) · 구성 점검 ROWS_MAX(2000) · 낭비 상위 50 을 모두 넘긴다

const VM = (vc, i, extra = {}) => ({
  id: `${vc}:vm-${i}`, vcenterId: vc, name: `${vc}-vm${i}`, powerState: 'POWERED_ON', host: `${vc}-esx1`, cluster: `${vc}-cl`,
  cpuCount: 4, memMB: 4096, cpuUsagePct: 5, memUsagePct: 10, guestOS: 'Rocky Linux 9', toolsStatus: 'RUNNING', storageGB: 20, thin: true, uncommittedGB: 3,
  snapshotCount: 0, snapshotSizeGB: 0,
  perfc: { at: NOW - 60_000, samples: 15, readyPct: { avg: 5 + (i % 9), max: 20 }, costopPct: { avg: 0, max: 0 }, latencyPct: { avg: 0, max: 0 }, readMs: { avg: 10 + (i % 60), max: 90 }, writeMs: { avg: 5, max: 9 }, disk: 'scsi0:0' },
  cfg: { question: i % 2 === 0 ? { text: `질문 ${i}` } : null, consolidationNeeded: i % 3 === 0, cbt: i % 2 === 0 },
  ...extra,
});
function buildSnap() {
  const vms = [];
  for (let i = 0; i < N_A; i++) vms.push(VM('vc-a', i, i < 60 ? { snapshotCount: 1, snapshotSizeGB: 1 + i } : {}));
  for (let i = 0; i < 5; i++) vms.push(VM('vc-a', N_A + i, { powerState: 'POWERED_OFF', storageGB: 100 + i, perfc: null, cpuCount: 2, memMB: 2048, snapshotCount: i === 0 ? 2 : 0, snapshotSizeGB: i === 0 ? 7 : 0 }));
  for (let i = 0; i < 10; i++) vms.push(VM('vc-b', i, { toolsStatus: i < 3 ? 'NOT_RUNNING' : 'RUNNING', cpuUsagePct: i < 4 ? null : 50 }));
  vms.push(VM('vc-b', 10, { powerState: 'POWERED_OFF', storageGB: 300, perfc: null, cpuCount: null }));
  for (let i = 0; i < 3; i++) vms.push(VM('vc-c', i));
  vms.push(VM('vc-c', 99, { template: true }));
  const host = (vc) => ({ id: `${vc}:host-1`, vcenterId: vc, name: `${vc}-esx1`, cluster: `${vc}-cl`, connectionState: 'CONNECTED', cpuTotalMhz: 48000, cpuCores: 16,
    perfc: { at: NOW - 60_000, diskMaxMs: { avg: vc === 'vc-a' ? 60 : 5 }, ds: [{ uuid: `${vc}-uuid`, readMs: { avg: vc === 'vc-b' ? 30 : 2 }, writeMs: { avg: 1 } }] } });
  return {
    source: 'live', generatedAt: new Date(NOW).toISOString(),
    vcenters: ['vc-a', 'vc-b', 'vc-c'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected', location: { region: id === 'vc-c' ? '유럽' : '아시아' } })),
    vms,
    hosts: ['vc-a', 'vc-b', 'vc-c'].map(host),
    datastores: ['vc-a', 'vc-b', 'vc-c'].map((vc) => ({ id: `${vc}:datastore-1`, vcenterId: vc, name: `${vc}-ds1`, type: 'VMFS', dsUuid: `${vc}-uuid`, capacityGB: 1000, usedGB: 100, freeGB: 900 })),
    networks: [], alarms: [],
  };
}

let base; let store; const closers = [];
before(async () => {
  ({ store } = await import('../src/store.js'));
  store.snapshot = { ...(store.get() || {}), ...buildSnap() };
  // 게스트 파티션 — 8일 전 수집(증가의 기준) + 지금 수집. vc-a 6대 · vc-b 3대 · vc-c 1대.
  const gd = await import('../src/guestdisk/db.js');
  const parts = (vc, n, used) => Array.from({ length: n }, (_, i) => ({ vmId: `${vc}:vm-${i}`, vmName: `${vc}-vm${i}`, allocGB: 200, usedGB: 0, partCount: 2,
    parts: [{ path: '/', capGB: 100, usedGB: used(i) }, { path: '/data', capGB: 100, usedGB: 50 }] }));
  const before8 = (i) => 70 + i;
  const nowUsed = (i) => [82, 88, 92, 97, 99, 60][i % 6];
  for (const [vc, n] of [['vc-a', 6], ['vc-b', 3], ['vc-c', 1]]) {
    assert.ok((await gd.commitCollection(vc, vc.toUpperCase(), parts(vc, n, before8), { ts: NOW - 8 * DAY })).ok);
    assert.ok((await gd.commitCollection(vc, vc.toUpperCase(), parts(vc, n, nowUsed), { ts: NOW - 60_000 })).ok);
  }
  // VM 수량 추이 — 두 슬롯(2일 전 · 지금).
  const vt = await import('../src/vmtrack/db.js');
  await vt.getDb();
  const { takeVmSnapshot } = await import('../src/vmtrack/service.js');
  const s0 = buildSnap();
  s0.vms = s0.vms.filter((v) => !(v.vcenterId === 'vc-b' && /vm-[0-2]$/.test(v.id)));   // 2일 전에는 vc-b 3대가 없었다
  assert.ok((await takeVmSnapshot(s0, { trigger: 'test', now: new Date(NOW - 2 * DAY) })).ok);
  assert.ok((await takeVmSnapshot(store.get(), { trigger: 'test', now: new Date(NOW) })).ok);
  // VM 생성 · 삭제 이력.
  const { getLogsDb } = await import('../src/logs/db.js');
  const ldb = await getLogsDb();
  const ev = (vc, k, type, ago, entity) => ({ vcenterId: vc, key: k, ts: NOW - ago, severity: 'info', type, user: 'alice', entity, message: type });
  ldb.insertMany([
    ev('vc-a', 'a1', 'VmCreatedEvent', 1 * DAY, 'n1'), ev('vc-a', 'a2', 'VmCreatedEvent', 2 * DAY, 'n2'), ev('vc-a', 'a3', 'VmClonedEvent', 3 * DAY, 'n3'),
    ev('vc-a', 'a4', 'VmRemovedEvent', 1 * DAY, 'old1'), ev('vc-b', 'b1', 'VmDeployedEvent', 2 * DAY, 'b-new'), ev('vc-b', 'b2', 'VmRemovedEvent', 4 * DAY, 'b-old'),
    ev('vc-c', 'c1', 'VmCreatedEvent', 1 * DAY, 'c-new'), ev('vc-a', 'a5', 'VmCreatedEvent', 30 * DAY, 'too-old'),
  ]);

  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => {
    const role = req.get('x-role') || 'admin';
    const scope = req.get('x-scope') ? { vcenters: req.get('x-scope').split(',') } : null;
    req.user = { username: role === 'admin' ? (scope ? 'adm-scoped' : 'adm') : `u-${role}`, role, scope };
    n();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  const rm = () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦은 flush */ } };
  rm(); process.once('exit', rm);
});

async function get(p, { role = 'admin', scope = '' } = {}) {
  const headers = { 'x-role': role };
  if (scope) headers['x-scope'] = scope;
  const r = await fetch(base + p, { headers });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, text: t };
}
const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
const r1 = (x) => Math.round(x * 10) / 10;

const PATHS = ['/api/tools/guest-partition', '/api/tools/waste', '/api/tools/waste/off-since', '/api/tools/contention', '/api/tools/vm-hygiene', '/api/tools/vm-track', '/api/tools/vm-lifecycle'];

/* ── ③ 권한 · ④ 범위 ─────────────────────────────────────────────────────── */

test('③ 권한: tools 권한 없는 계정 · 도구가 toolsDenied 인 계정은 요약도 원본과 같은 거부', async () => {
  for (const p of PATHS) {
    for (const role of ['operator', 'viewer']) {
      const orig = await get(p, { role });
      const summ = await get(`${p}?summary=1`, { role });
      assert.equal(orig.status, 403, `${p} 원본 ${role}`);
      assert.equal(summ.status, orig.status, `${p}?summary=1 ${role}`);
      assert.deepEqual(summ.j, orig.j, `${p} ${role}: 거부 본문이 원본과 같다`);
      assert.notEqual(summ.j?.summary, true);
    }
    const adm = await get(`${p}?summary=1`);
    assert.equal(adm.status, 200, `${p} 관리자: ${adm.text.slice(0, 200)}`);
    assert.equal(adm.j.summary, true, p);
    assert.ok(Array.isArray(adm.j.rows), p);
  }
});

test('④ 범위: 범위 계정(vc-b)의 요약에는 범위 밖 법인 줄 · id · 이름이 없다', async () => {
  for (const p of PATHS) {
    const r = await get(`${p}?summary=1`, { scope: 'vc-b' });
    assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 200)}`);
    assert.ok(r.j.rows.length >= 1, `${p}: vc-b 줄이 있다`);
    assert.ok(r.j.rows.every((x) => x.vcenterId === 'vc-b'), `${p}: ${JSON.stringify(r.j.rows.map((x) => x.vcenterId))}`);
    assert.doesNotMatch(r.text, /vc-a|vc-c|VC-A|VC-C/, `${p}: 범위 밖 법인이 응답에 있다`);
  }
  // 전체 범위 관리자는 세 법인 줄을 본다(같은 URL 의 캐시가 범위 계정 결과를 돌려주지 않는다 — extraKey).
  const all = await get('/api/tools/contention?summary=1');
  assert.deepEqual(all.j.rows.map((x) => x.vcenterId), ['vc-a', 'vc-b', 'vc-c']);
});

/* ── ① 합 대조 · ② 전체로 센다 ───────────────────────────────────────────── */

test('경합: 법인별 kpi · coverage 합 = 원본 · 원본 목록은 1,000줄로 잘렸지만 요약은 전체', async () => {
  const o = (await get('/api/tools/contention')).j;
  const s = (await get('/api/tools/contention?summary=1')).j;
  assert.ok(o.omitted > 0, `전제: 원본 VM 목록이 잘린다(omitted ${o.omitted})`);
  for (const k of Object.keys(o.kpi)) assert.equal(sum(s.rows, (r) => r.kpi[k]), o.kpi[k], `kpi.${k}`);
  for (const k of Object.keys(o.coverage)) assert.equal(sum(s.rows, (r) => r.coverage[k]), o.coverage[k], `coverage.${k}`);
  assert.equal(sum(s.rows, (r) => r.unmatchedDs), o.unmatchedDs);
  assert.ok(o.kpi.readyWarn + o.kpi.readyCrit > o.vms.length, '판정 수가 잘린 목록보다 많다');
  assert.deepEqual(s.thresholds, o.thresholds, '기준값을 응답에 싣는다');
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.equal(a.top.ready.length, 5);
  for (let i = 1; i < 5; i++) assert.ok(a.top.ready[i - 1].readyAvg >= a.top.ready[i].readyAvg, '대기 큰 순');
  assert.equal(a.top.ready[0].readyAvg, 13, '전체 중 가장 큰 대기(잘린 목록 밖의 VM 이어도)');
  assert.ok(a.top.disk.every((r) => r.codes.some((c) => c.startsWith('disk-'))));
  assert.equal(a.top.disk[0].readAvg, 69);
  assert.equal(a.hostsContended, 1, '경합 VM 이 있는 호스트');
  assert.equal(sum(s.rows, (r) => r.hostsContended), o.hosts.filter((h) => h.contended > 0).length);
  const b = s.rows.find((r) => r.vcenterId === 'vc-b');
  assert.equal(b.top.datastores.length, 1, '느린 데이터스토어(30ms)');
  assert.equal(b.kpi.dsSlow, 1);
});

test('VM 구성 점검: 문제 종류별 · 심각 · 경고 합 = 원본 · 원본 목록은 2,000줄로 잘렸지만 요약은 전체', async () => {
  const o = (await get('/api/tools/vm-hygiene')).j;
  const s = (await get('/api/tools/vm-hygiene?summary=1')).j;
  assert.ok(o.omitted > 0, `전제: 원본 목록이 잘린다(omitted ${o.omitted})`);
  for (const [c, v] of Object.entries(o.byCode)) assert.equal(sum(s.rows, (r) => r.byCode[c]), v.vms, `byCode.${c}`);
  for (const k of ['vms', 'withFindings', 'crit', 'warn', 'notCollected']) assert.equal(sum(s.rows, (r) => r[k]), sum(o.vcenters, (r) => r[k]), k);
  // 참고(info) 판정은 정렬 뒤쪽이라 잘린 목록에서 빠진다 — 요약은 그것까지 센다.
  assert.ok(sum(s.rows, (r) => r.byCode['cbt-off']) > o.rows.filter((r) => r.findings.some((f) => f.code === 'cbt-off')).length, '잘린 목록보다 많이 센다');
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.equal(a.top.question.length, 5);
  assert.ok(a.top.question.every((r) => r.codes.includes('question') && typeof r.question.text === 'string'));
  assert.deepEqual(s.thresholds, { snapAgeDays: o.settings.snapAgeDays, snapCount: o.settings.snapCount, snapSizeGB: o.settings.snapSizeGB, uptimeDays: o.settings.uptimeDays });
  assert.equal(s.settings, undefined, '설정 예외 원문은 싣지 않는다');
});

test('Optimization: 후보 · 할당 · 꺼짐 · 스냅샷 · Tools · Thin 합 = 원본 · 원본 상위 50 은 잘렸지만 요약은 전체', async () => {
  const o = (await get('/api/tools/waste')).j;
  const s = (await get('/api/tools/waste?summary=1')).j;
  assert.equal(o.overAllocated.memTop.length, 50, '전제: 원본 메모리 후보 목록이 50 으로 잘린다');
  assert.ok(o.overAllocated.mem.candidates > 50);
  assert.equal(sum(s.rows, (r) => r.mem.candidates), o.overAllocated.mem.candidates);
  assert.equal(sum(s.rows, (r) => r.cpu.candidates), o.overAllocated.cpu.candidates);
  assert.equal(r1(sum(s.rows, (r) => r.cpu.allocMhz) / 1000), o.overAllocated.cpu.allocGHz);
  assert.equal(r1(sum(s.rows, (r) => r.cpu.usedMhz) / 1000), o.overAllocated.cpu.usedGHz);
  assert.equal(r1(sum(s.rows, (r) => r.mem.allocMB) / 1024), o.overAllocated.mem.allocGB);
  assert.equal(r1(sum(s.rows, (r) => r.mem.idleMB) / 1024), o.overAllocated.mem.idleGB);
  assert.equal(sum(s.rows, (r) => r.usageUnknown.cpu), o.overAllocated.usageUnknown.cpu, '사용률 모름은 따로 센다');
  assert.equal(sum(s.rows, (r) => r.poweredOnVms), o.overAllocated.poweredOnVms);
  assert.equal(sum(s.rows, (r) => r.poweredOff), o.poweredOff.count);
  assert.equal(sum(s.rows, (r) => r.poweredOffGB), o.poweredOff.storageGB);
  assert.equal(sum(s.rows, (r) => r.snapshots), o.snapshots.count);
  assert.equal(r1(sum(s.rows, (r) => r.snapshotGB)), o.snapshots.sizeGB);
  assert.equal(sum(s.rows, (r) => r.noTools), o.noTools.count);
  assert.equal(sum(s.rows, (r) => r.thinVms), o.thinReclaim.count);
  assert.equal(sum(s.rows, (r) => r.thinReclaimGB), o.thinReclaim.reclaimableGB);
  assert.deepEqual(s.thresholds, o.overAllocated.thresholds, '기준값(cpuIdlePct · memIdlePct)을 응답에 싣는다');
  for (const r of s.rows) for (const k of ['mem', 'cpu', 'poweredOff', 'snapshots', 'noTools']) assert.ok(r.top[k].length <= 5, `${r.vcenterId}.${k}`);
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.deepEqual(a.top.poweredOff.map((v) => v.storageGB), [104, 103, 102, 101, 100], '꺼짐 = 디스크 큰 순');
  assert.deepEqual(a.top.snapshots.map((v) => v.snapshotSizeGB), [60, 59, 58, 57, 56], '스냅샷 = 크기 큰 순(원본 상위 50 밖이어도 법인별로)');
  assert.equal(a.offVcpu, 10); assert.equal(a.offMemGB, 10); assert.equal(a.offWithSnapshots, 1);
  const b = s.rows.find((r) => r.vcenterId === 'vc-b');
  assert.equal(b.offAllocUnknown, 1, 'vCPU 를 못 읽은 꺼진 VM 은 합에서 빼고 센다');
  assert.equal(b.offVcpu, 0);
  assert.equal(JSON.stringify(o).includes('perVcAlloc'), false, '원본 응답에는 요약용 누계가 없다');
});

test('꺼진 지(off-since 요약): 법인별 꺼진 VM 수 = 원본 행 수 · 구간 합 = 꺼진 VM 수 · 못 찾은 것은 모름', async () => {
  const o = (await get('/api/tools/waste/off-since')).j;
  const s = (await get('/api/tools/waste/off-since?summary=1')).j;
  assert.equal(sum(s.rows, (r) => r.poweredOff), o.rows.length);
  for (const r of s.rows) assert.equal(Object.values(r.buckets).reduce((a, b) => a + b, 0), r.poweredOff);
  assert.deepEqual(s.ageEdges, [7, 30]);
  const known = o.rows.filter((r) => r.offDays != null).length;
  assert.equal(sum(s.rows, (r) => r.buckets.unknown), o.rows.length - known);
});

test('⑤ 꺼진 지 구간: 서버 offAgeBucketOf = 웹 ageBucketOf(같은 입력 · 같은 칸)', async () => {
  const { offAgeBucketOf, offSinceByVc } = await import('../src/tools/powerOff.js');
  const web = await import('../../web/src/views/tools/wasteViewText.js');
  for (const d of [0, 1, 6, 6.99, 7, 8, 29, 29.9, 30, 31, 365, -1, null, undefined, '', '12', NaN, Infinity, [], {}]) {
    assert.equal(offAgeBucketOf(d), web.ageBucketOf(d), `입력 ${JSON.stringify(d)}`);
  }
  assert.deepEqual(web.AGE_BUCKETS.map((b) => b.k).sort(), ['d7', 'ge30', 'lt7', 'unknown']);
  const m = offSinceByVc([{ id: 'x1', vcenterId: 'v', name: 'a' }, { id: 'x2', vcenterId: 'v', name: 'b' }, { id: 'x3', vcenterId: 'v', name: 'c' }],
    [{ id: 'x1', offDays: 40, offSince: 1, source: 'event', exact: true }, { id: 'x2' }]);
  assert.deepEqual(m.get('v').buckets, { ge30: 1, d7: 0, lt7: 0, unknown: 2 }, '행이 없는 VM 도 모름');
  assert.deepEqual(m.get('v').oldest.map((x) => x.id), ['x1']);
});

test('게스트 파티션: 법인별 합 = 원본 kpi · 원본 목록을 잘라도 요약은 전체로 센다', async () => {
  const o = (await get('/api/tools/guest-partition?limit=1000')).j;
  const s = (await get('/api/tools/guest-partition?summary=1')).j;
  assert.ok(o.kpi.overParts > 2);
  for (const k of ['overVms', 'overParts', 'crit', 'soon', 'guests', 'reported', 'notReported', 'offNotReported', 'unknownParts']) {
    assert.equal(sum(s.rows, (r) => r[k]), o.kpi[k], `kpi.${k}`);
  }
  for (const r of s.rows) {
    assert.equal(r.overBins.reduce((a, b) => a + b, 0), r.overParts, `${r.vcenterId} 구간 합 = 초과 파티션`);
    assert.equal(r.osOver.win + r.osOver.lnx + r.osOver.other, r.overVms, `${r.vcenterId} OS 계열 합 = 초과 VM`);
    assert.ok(r.top.fullest.length <= 5 && r.top.soonest.length <= 5);
  }
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.deepEqual(a.top.fullest.map((x) => x.pct), [99, 97, 92, 88, 82], '가장 찬 순');
  assert.ok(a.top.soonest.length > 0 && a.top.soonest.every((x, i, arr) => i === 0 || arr[i - 1].etaDays <= x.etaDays), '곧 가득 = 예상 빠른 순');
  assert.deepEqual(s.thresholds.overBinEdges, [85, 90, 95]);
  assert.equal(s.thresholds.critPct, 95);
  assert.equal(s.thresholds.soonDays, 30);
  // 원본을 2줄로 자르면 목록 · '곧 가득' 이 잘린 목록 기준이 된다 — 요약은 그 상한을 보지 않는다.
  const cut = (await get('/api/tools/guest-partition?limit=2')).j;
  assert.equal(cut.rows.length, 2); assert.equal(cut.limited, true);
  assert.equal(sum(s.rows, (r) => r.overParts), cut.kpi.overParts, '초과 수는 원본도 전체');
  assert.ok(sum(s.rows, (r) => r.soon) >= cut.kpi.soon);
  assert.equal(sum(s.rows, (r) => r.soon), o.kpi.soon);
});

test('VM 수량 추이: 슬롯마다 법인 점의 합 = 원본 점 · 지금 수 합 = 원본 마지막 점', async () => {
  const o = (await get('/api/tools/vm-track')).j;
  const s = (await get('/api/tools/vm-track?summary=1')).j;
  assert.ok(o.points.length >= 2, `전제: 두 슬롯(${o.points.length})`);
  for (const p of o.points) {
    const tot = sum(s.rows, (r) => (r.points.find((x) => x.slot === p.slot) || {}).total);
    assert.equal(tot, p.total, `슬롯 ${p.slot}`);
  }
  assert.equal(sum(s.rows, (r) => r.current?.total), o.points[o.points.length - 1].total);
  assert.equal(sum(s.rows, (r) => r.base?.total), o.points[0].total);
  assert.deepEqual(s.slots, o.points.map((p) => p.slot));
  const b = s.rows.find((r) => r.vcenterId === 'vc-b');
  assert.equal(b.current.total - b.base.total, 3, 'vc-b 는 2일 사이 3대 늘었다');
  assert.equal(s.status, undefined, '폴러 · DB 상태는 싣지 않는다');
});

test('VM 생성 · 삭제: 법인별 생성 · 삭제 · 종류 · 날마다 합 = 원본(지난 7일 — 30일 전 이벤트는 빠진다)', async () => {
  const o = (await get('/api/tools/vm-lifecycle')).j;
  const s = (await get('/api/tools/vm-lifecycle?summary=1')).j;
  assert.equal(o.life.added, 5); assert.equal(o.life.removed, 2);
  assert.equal(sum(s.rows, (r) => r.added), o.life.added);
  assert.equal(sum(s.rows, (r) => r.removed), o.life.removed);
  for (const k of Object.keys(o.life.byKind)) assert.equal(sum(s.rows, (r) => r.byKind[k]), o.life.byKind[k], `byKind.${k}`);
  assert.equal(s.days, 7);
  for (let i = 0; i < o.life.series.length; i++) {
    assert.equal(sum(s.rows, (r) => r.series[i]?.added), o.life.series[i].added, `날 ${i} 생성`);
    assert.equal(sum(s.rows, (r) => r.series[i]?.removed), o.life.series[i].removed, `날 ${i} 삭제`);
  }
  assert.equal(s.rows.find((r) => r.vcenterId === 'vc-a').added, 3);
  assert.equal(s.truncated, false);
  assert.equal(s.rows[0].events, undefined, '이벤트 목록은 싣지 않는다');
});
