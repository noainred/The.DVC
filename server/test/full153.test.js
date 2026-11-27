/**
 * full153.test.js — 전체 점검 153회차 2축(vCenter 수집 · 인벤토리 · 지표 · 이력 DB · 폴러 · 공용 util).
 *   N153-1 스냅샷 보류 파일을 읽지 못한 채 만든 설정 캐시가 빈 보류를 굳힌다 — 파일이 다시 읽혀도 보류한 VM 이 위반으로 판정됐다
 *   N153-2 보류로 스냅샷 정책 판정에서 뺀 VM 수를 VM 구성 점검 요약 · 알림 문구가 말하지 않았다(‘예외 N대’ 만 — 조용한 제외)
 *   N153-3 요청 값으로 여는 고정 표가 상속 키(constructor · __proto__ · toString)를 받아 ‘모르는 값 = 자동’ 으로 떨어지지 않았다
 *   N153-4 만든 계정 — 이벤트 DB 가 그 vCenter 의 31일을 다 덮지 못해도 'ok' 라 화면이 못 찾은 VM 을 ‘31일 안 기록 없음’ 으로 단정했다
 *   N153-5 비교 매트릭스(tools/compareMatrix.js) — vCPU · 메모리를 못 읽은 켜진 VM 을 0 으로 더해 vCPU:코어 · 메모리 과할당이 표지 없이 작게 나왔다
 * 원칙: 실제 함수 · 실제 라우터를 불러 값으로 판정한다(소스 grep 이 아니다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const TMP = tmpDir('full153-');
process.env.CONFIG_DIR = TMP;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

const { hygieneFindings, analyzeVmHygiene, snapshotPolicySummary } = await import('../src/vmhygiene/analyze.js');
const { loadVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
const { loadHolds, setHold, holdsGeneration, HOLDS_FILE_NAME, _resetHoldsForTest } = await import('../src/vmhygiene/holds.js');
const { _setJsonFileLoadClockForTest, READ_RETRY_MS } = await import('../src/util/jsonFileRead.js');

const DAY = 86_400_000;
// 기준 시각 — 실제 시각에서 정시 경계로(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const HOLDS_FILE = path.join(TMP, HOLDS_FILE_NAME);
const vmOf = (id, extra = {}) => ({ id: `va:${id}`, vcenterId: 'va', name: id, snapshotCount: 5, snapshotSizeGB: 20, snapshotOldestTs: NOW - 50 * DAY, powerState: 'POWERED_ON', ...extra });
const holdRow = (id, days = 3) => ({ vcenterId: 'va', vmId: `va:${id}`, vmName: id, until: Date.now() + days * DAY, reason: 'DB 이관', by: 'admin1', at: Date.now() });

test('N153-1 보류 파일을 읽지 못한 채 만든 설정 캐시 — 다시 읽히면 보류가 판정에 돌아온다', () => {
  _resetHoldsForTest(); _resetVmHygieneSettings();
  let clock = Date.now();
  _setJsonFileLoadClockForTest(() => clock);
  try {
    // ① 기동 직후 읽기 오류(EISDIR — 손상이 아니다): 직전 목록이 없어 빈 목록 + unreadable
    fs.mkdirSync(HOLDS_FILE);
    const s1 = loadVmHygieneSettings();
    assert.equal(s1.holds.size, 0);
    assert.equal(loadHolds().unreadable, true);
    const gen0 = holdsGeneration();
    // ② 파일이 바로잡혔다. 재읽기 간격 안에서는 디스크를 보지 않는다(여전히 못 읽음 — 요청마다 동기로 다시 읽지 않는다)
    fs.rmdirSync(HOLDS_FILE);
    fs.writeFileSync(HOLDS_FILE, JSON.stringify({ holds: [holdRow('vm1')] }));
    const mid = loadVmHygieneSettings();
    assert.equal(mid.holds.size, 0, '재읽기 간격 안에서는 다시 읽지 않는다');
    assert.equal(loadHolds().unreadable, true);
    // ③ 간격이 지나면 다시 읽고, **이미 만들어 둔 설정 캐시**의 판정에도 보류가 돌아온다(수정 전: 빈 Map 이 그대로 — 재시작 · 보류 쓰기 전까지)
    clock += READ_RETRY_MS + 1_000;
    const s2 = loadVmHygieneSettings();
    assert.equal(s2, s1, '설정 캐시 객체는 그대로다(다시 만들지 않고 보류만 다시 붙인다)');
    assert.equal(s2.holds.size, 1);
    const f = hygieneFindings(vmOf('vm1'), s2, Date.now());
    assert.equal(f.held?.reason, 'DB 이관');
    assert.equal(f.findings.filter((x) => x.code.startsWith('snap-')).length, 0, '보류한 VM 이 스냅샷 정책 위반으로 판정됐다');
    assert.ok(holdsGeneration() > gen0, '읽기 오류가 풀리면 세대가 오른다(스냅샷 화면 응답 캐시 열쇠)');
    assert.equal(Object.keys(s2).includes('holds'), false, 'holds 는 여전히 열거되지 않는다');
    // ④ 읽히고 난 뒤에는 호출마다 다시 붙이지 않는다(같은 Map)
    const m = s2.holds;
    assert.equal(loadVmHygieneSettings().holds, m);
    // ⑤ 보류 쓰기는 예전대로 캐시를 버린다(새 캐시에도 보류가 붙는다)
    const r = setHold({ vcenterId: 'va', vmId: 'va:vm2', vmName: 'vm2', days: 5, reason: '점검' }, 'admin1');
    assert.equal(r.ok, true);
    const s3 = loadVmHygieneSettings();
    assert.notEqual(s3, s1);
    assert.equal(s3.holds.size, 2);
  } finally {
    _setJsonFileLoadClockForTest();
    try { fs.rmSync(HOLDS_FILE, { recursive: true, force: true }); } catch { /* */ }
    _resetHoldsForTest(); _resetVmHygieneSettings();
  }
});

test('N153-1 읽기 오류 동안에는 직전에 읽은 목록을 이어 쓴다(보류 없음이 아니다) — 캐시를 새로 만들어도', () => {
  _resetHoldsForTest(); _resetVmHygieneSettings();
  let clock = Date.now();
  _setJsonFileLoadClockForTest(() => clock);
  try {
    fs.writeFileSync(HOLDS_FILE, JSON.stringify({ holds: [holdRow('vm1')] }));
    assert.equal(loadVmHygieneSettings().holds.size, 1);
    fs.rmSync(HOLDS_FILE); fs.mkdirSync(HOLDS_FILE);          // 읽기 오류로 바뀐다
    _resetVmHygieneSettings();                                // 설정 저장 등으로 캐시가 새로 만들어진다
    const s = loadVmHygieneSettings();
    assert.equal(s.holds.size, 1, '읽기 오류 동안 직전 목록을 이어 쓴다');
    assert.equal(loadHolds().unreadable, true);
    // 다시 읽히면 새 목록(vm1 은 풀리고 vm9 가 걸렸다)으로 바뀐다
    fs.rmdirSync(HOLDS_FILE);
    fs.writeFileSync(HOLDS_FILE, JSON.stringify({ holds: [holdRow('vm9')] }));
    clock += READ_RETRY_MS + 1_000;
    const s2 = loadVmHygieneSettings();
    assert.deepEqual([...s2.holds.keys()], ['va\nva:vm9']);
  } finally {
    _setJsonFileLoadClockForTest();
    try { fs.rmSync(HOLDS_FILE, { recursive: true, force: true }); } catch { /* */ }
    _resetHoldsForTest(); _resetVmHygieneSettings();
  }
});

test('N153-2 보류로 뺀 VM 수 — VM 구성 점검 coverage.held · 알림 문구', () => {
  const s = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, uptimeDays: 365, exceptions: ['skip-me'] };
  Object.defineProperty(s, 'holds', { value: new Map([
    ['va\nva:vm1', { until: NOW + DAY, reason: '이관' }],
    ['va\nva:vm3', { until: NOW - DAY, reason: '기한 지남' }],     // 지난 보류 — 세지 않는다
    ['va\nva:tpl', { until: NOW + DAY, reason: '템플릿' }],        // 템플릿 — 판정 대상이 아니다(세지 않는다)
    ['va\nva:skip-me-1', { until: NOW + DAY, reason: '예외와 겹침' }],   // 예외 목록이 먼저다(예외로 센다)
  ]), enumerable: false });
  const vms = [vmOf('vm1'), vmOf('vm2'), vmOf('vm3'), vmOf('tpl', { template: true }), vmOf('skip-me-1')];
  const r = analyzeVmHygiene(vms, s, { now: NOW });
  assert.equal(r.coverage.held, 1, '보류로 뺀 VM 수');
  assert.equal(r.coverage.excepted, 1);
  assert.equal(r.byCode['snap-age'].vms, 2, 'vm2 · vm3(기한 지난 보류)만 위반');
  const text = snapshotPolicySummary(r);
  assert.match(text, /스냅샷 정책 위반 2대/);
  assert.match(text, /예외 1대 · 보류 1대 제외\)/, '알림 문구가 보류로 뺀 수를 말한다');
  assert.equal(text.includes('`'), false);
  // 보류가 없으면 문구는 예전 그대로다
  const s0 = { ...s }; // 펼치면 holds(열거되지 않음)가 빠진다
  const r0 = analyzeVmHygiene(vms, s0, { now: NOW });
  assert.equal(r0.coverage.held, 0);
  assert.match(snapshotPolicySummary(r0), /예외 1대 제외\)/);
  assert.equal(snapshotPolicySummary(r0).includes('보류'), false);
});

test('N153-4 만든 계정 — 이벤트 DB 가 31일을 빠짐없이 가진 vCenter 만 ok, 아니면 partial(찾은 계정은 그대로)', async () => {
  const D = await import('../src/veeam/snapDb.js');
  const { snapshotCreators } = await import('../src/snaphist/creators.js');
  const { ROW_LIMIT } = await import('../src/veeam/snapEvents.js');
  const db = await D.getSnapDb();
  assert.ok(db, '스냅샷 이벤트 DB 를 열지 못했다');
  try {
    const ev = (vc, ts, user, entity) => ({ vcenterId: vc, ts, severity: 'info', type: 'TaskEvent', user, entity, message: 'Task: Create virtual machine snapshot' });
    db.ingest([ev('vc-full', NOW - 2 * DAY, 'CORP\\kim', 'vm-a'), ev('vc-part', NOW - DAY, 'CORP\\lee', 'vm-b'), ev('vc-edge', NOW - DAY, 'CORP\\x', 'vm-e')]);
    db.setCoveredFrom('vc-full', NOW - D.RETENTION_MS - DAY, NOW);   // 31일을 다 덮었다
    db.setCoveredFrom('vc-edge-cov', NOW - D.RETENTION_MS, NOW);     // 경계 — 정확히 31일 전부터(덮음)
    db.setCoveredFrom('vc-part', NOW - 8 * DAY, NOW);                // 백필 1단계(8일)까지만
    // vc-none: 덮음 기록이 없다(백필 전 · 이벤트를 모으지 않는 vCenter · 적재 실패로 무효)
    const vmOfVc = (vc, n, name) => ({ id: `${vc}:${n}`, vcenterId: vc, name });
    const snap = {
      vcenters: [{ id: 'vc-full' }, { id: 'vc-edge-cov' }, { id: 'vc-part' }, { id: 'vc-none' }, { id: 'vc-edge', collectSource: 'site' }],
      vms: [vmOfVc('vc-full', 1, 'vm-a'), vmOfVc('vc-full', 2, 'vm-quiet'), vmOfVc('vc-part', 1, 'vm-b'), vmOfVc('vc-part', 2, 'vm-old'), vmOfVc('vc-none', 1, 'vm-c'), vmOfVc('vc-edge', 1, 'vm-e')],
    };
    const r = await snapshotCreators({ snap, vcIds: new Set(['vc-full', 'vc-edge-cov', 'vc-part', 'vc-none', 'vc-edge']), now: NOW });
    assert.deepEqual(r.vcenters, { 'vc-full': 'ok', 'vc-edge-cov': 'ok', 'vc-part': 'partial', 'vc-none': 'partial', 'vc-edge': 'site' },
      '31일을 덮지 못한 vCenter 를 ok 로 말했다(화면이 못 찾은 VM 을 기록 없음으로 단정한다)');
    assert.deepEqual(r.coveredFrom, { 'vc-part': NOW - 8 * DAY, 'vc-none': null }, '덮은 가장 이른 시각(모르면 null) — 덮은 vCenter 는 싣지 않는다');
    // 찾은 계정은 partial 이어도 그대로다(읽은 만큼은 맞다)
    assert.equal(r.byVm['vc-full\nvc-full:1'].user, 'CORP\\kim');
    assert.equal(r.byVm['vc-part\nvc-part:1'].user, 'CORP\\lee');
    assert.equal(r.byVm['vc-edge\nvc-edge:1'], undefined, '위임 vCenter 는 비운다');
    // 이벤트가 쌓이지 않는 조건 — 로그 수집 끔 · 정보 등급 미저장 · 이 포탈이 모으지 않는 vCenter(비활성 · 점검중). 덮음이 온전해도 ok 가 아니다
    const only = new Set(['vc-full']);
    const st = async (extra) => (await snapshotCreators({ snap, vcIds: only, now: NOW, ...extra }));
    assert.equal((await st({ logSettings: { enabled: false, minSeverity: 'info' } })).vcenters['vc-full'], 'log-off');
    assert.equal((await st({ logSettings: { enabled: true, minSeverity: 'warning' } })).vcenters['vc-full'], 'severity-filter');
    assert.equal((await st({ logSettings: { enabled: true, minSeverity: 'info' } })).vcenters['vc-full'], 'ok');
    assert.equal((await st({ logSettings: null })).vcenters['vc-full'], 'ok', '설정을 모르면 그 사유로는 판정하지 않는다');
    for (const why of ['disabled', 'maintenance']) {
      const r4 = await st({ notCollected: new Map([['vc-full', why]]) });
      assert.equal(r4.vcenters['vc-full'], 'not-collected', why);
      assert.equal(r4.byVm['vc-full\nvc-full:1'].user, 'CORP\\kim', '예전에 쌓인 이벤트로 찾은 계정은 그대로 싣는다');
    }
    const r5 = await st({ notCollected: new Map([['vc-full', 'site']]) });
    assert.equal(r5.vcenters['vc-full'], 'site'); assert.deepEqual(r5.byVm, {});
    // 적재 실패로 덮음이 무효가 되면 그 vCenter 는 partial 로 돌아간다(지어낸 ok 금지)
    db.setCoveredFrom('vc-full', NOW - 3 * DAY, NOW);
    const r2 = await snapshotCreators({ snap, vcIds: new Set(['vc-full']), now: NOW });
    assert.equal(r2.vcenters['vc-full'], 'partial');
    // 상한까지 읽은 vCenter 는 덮음과 무관하게 truncated(더 오래된 행은 못 봤다)
    const many = [];
    for (let i = 0; i < ROW_LIMIT; i += 1) many.push(ev('vc-big', NOW - DAY - i * 1000, 'CORP\\kim', `vm-${i % 50}`));
    db.ingest(many);
    const r3 = await snapshotCreators({ snap: { vcenters: [{ id: 'vc-big' }], vms: [] }, vcIds: new Set(['vc-big']), now: NOW });
    assert.equal(r3.vcenters['vc-big'], 'truncated');
  } finally {
    D._resetSnapDbForTest();
  }
});

test('N153-5 비교 매트릭스 — 할당을 못 읽은 켜진 VM 은 0 이 아니다(비율 null + 못 읽은 수 · 다 읽은 셀은 그대로)', async () => {
  const { clusterMatrix, CLUSTER_METRICS } = await import('../src/tools/compareMatrix.js');
  const host = (vc, cluster) => ({ vcenterId: vc, name: `esx-${vc}-${cluster}`, cluster, connectionState: 'CONNECTED', cpuCores: 10, cpuTotalMhz: 30_000, cpuUsageMhz: 3_000, memTotalMB: 100_000, memUsageMB: 10_000 });
  const vm = (vc, cluster, o = {}) => ({ vcenterId: vc, cluster, powerState: 'POWERED_ON', cpuCount: 5, memMB: 25_000, ...o });
  const slice = {
    vcenters: [{ id: 'va', name: 'A' }, { id: 'vb', name: 'B' }, { id: 'vc', name: 'C' }, { id: 'vd', name: 'D' }],
    hosts: [host('va', 'PROD'), host('vb', 'PROD'), host('vc', 'PROD'), host('vd', 'PROD')],
    vms: [
      vm('va', 'PROD'), vm('va', 'PROD'),                                                    // 다 읽음: 10 vCPU / 10 코어 = 1 · 50,000 / 100,000 = 50%
      vm('vb', 'PROD'), vm('vb', 'PROD', { cpuCount: null, memMB: null }),                   // 한 대를 못 읽음(REST 폴백 · 엣지 정제)
      vm('vc', 'PROD', { cpuCount: null, memMB: '' }), vm('vc', 'PROD', { cpuCount: undefined, memMB: null }),   // 전부 못 읽음
      vm('vd', 'PROD', { cpuCount: null }),                                                  // vCPU 만 못 읽음 — 메모리 비율은 낸다
      vm('vd', 'PROD', { powerState: 'POWERED_OFF', cpuCount: null, memMB: null }),          // 꺼진 VM 은 이 합에 들지 않는다(못 읽은 수에도)
      vm('va', 'PROD', { cpuCount: 0, memMB: 0 }),                                           // 보고된 0 은 값이다
    ],
    datastores: [],
  };
  const m = clusterMatrix(slice);
  const row = m.rows.find((r) => r.name === 'PROD');
  const c = row.cells;
  assert.equal(c.va.vcpuPerCore, 1); assert.equal(c.va.memOvercommitPct, 50);
  assert.equal('vcpuUnknown' in c.va, false); assert.equal('ramUnknown' in c.va, false);
  // 수정 전: vb = 0.5 · 25%(못 읽은 VM 을 0 으로) · vc = 0 · 0%(가장 여유 있는 셀)
  assert.equal(c.vb.vcpuPerCore, null, '부분 합으로 낸 vCPU:코어는 실제보다 작다');
  assert.equal(c.vb.memOvercommitPct, null);
  assert.equal(c.vb.vcpuUnknown, 1); assert.equal(c.vb.ramUnknown, 1);
  assert.equal(c.vc.vcpuPerCore, null, '전부 못 읽은 셀이 0(여유 최대)으로 나왔다');
  assert.equal(c.vc.memOvercommitPct, null);
  assert.equal(c.vc.vcpuUnknown, 2); assert.equal(c.vc.ramUnknown, 2);
  assert.equal(c.vd.vcpuPerCore, null); assert.equal(c.vd.vcpuUnknown, 1);
  assert.equal(c.vd.memOvercommitPct, 25, '메모리는 읽었다 — vCPU 를 못 읽었다고 메모리 비율까지 비우지 않는다');
  assert.equal('ramUnknown' in c.vd, false);
  // 규모 지표 · 사용률은 그대로다
  assert.equal(c.vb.vmsOn, 2); assert.equal(c.vd.vms, 2); assert.equal(c.vd.vmsOn, 1); assert.equal(c.vb.cpuUsagePct, 10);
  // 행 합계 · 열 합계도 같은 규칙(못 읽은 수는 더해진다 — 문자열 · NaN 이 아니다)
  assert.equal(row.total.vcpuPerCore, null); assert.equal(row.total.vcpuUnknown, 4); assert.equal(row.total.ramUnknown, 3);
  assert.equal(m.colTotals.va.vcpuPerCore, 1); assert.equal(m.colTotals.vb.vcpuPerCore, null); assert.equal(m.colTotals.vb.vcpuUnknown, 1);
  for (const cell of [...Object.values(c), row.total, ...Object.values(m.colTotals)]) {
    for (const mt of CLUSTER_METRICS) assert.ok(cell[mt.key] === null || (typeof cell[mt.key] === 'number' && Number.isFinite(cell[mt.key])), `${mt.key} = ${cell[mt.key]}`);
  }
});

/** 실제 api 라우터를 목(mock) 모드로 띄워 부른다(자식 프로세스 — 127.0.0.1 포트를 연다). */
function viaRoutes(urlsOf) {
  const dir = tmpDir('full153-route-');
  const script = `
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    try { await store.refresh(); } catch { /* */ }
    const snap = store.get();
    const ids = { vc: snap.vcenters[0].id, vm: snap.vms[0].id, host: snap.hosts[0].id };
    const urls = (${urlsOf.toString()})(ids);
    const out = [];
    for (const [name, u] of urls) {
      const r = await fetch(base + u);
      let b = null; try { b = await r.json(); } catch { /* */ }
      const pts = b && Array.isArray(b.points) ? b.points.length : null;
      out.push({ name, status: r.status, bucket: b?.bucket ?? null, bucketMs: b?.bucketMs ?? null, bucketMsType: typeof b?.bucketMs, range: b?.range ?? null,
        interval: b?.interval ?? null, requested: b?.requested ?? null, points: pts, limit: b?.limit ?? null });
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, TEMP_DB_PATH: path.join(dir, 'host-temp.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${String(r.stderr || '').slice(-800)}`);
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${String(r.stdout || '').slice(-600)}`);
  return new Map(JSON.parse(line.slice(2)).map((x) => [x.name, x]));
}

test('N153-3 요청 값으로 여는 고정 표는 자기 키만 — 상속 키는 모르는 값(자동 · 기본)으로 떨어진다', () => {
  const res = viaRoutes((ids) => {
    const e = encodeURIComponent; const out = [];
    for (const k of ['', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const q = k ? '&bucket=' + k : '';
      out.push(['temp|' + k, '/api/tools/esxi-temp/history?level=host&key=' + e(ids.host) + '&days=1' + q]);
      out.push(['waste|' + k, '/api/tools/waste/history?vcenterId=' + e(ids.vc) + '&days=3' + q]);
      out.push(['disk|' + k, '/api/tools/capacity/disk-history?vcenterId=' + e(ids.vc) + '&days=3' + q]);
      out.push(['gpu|' + k, '/api/tools/gpu/history?level=host&key=' + e(ids.host) + '&days=1' + q]);
      out.push(['usage|' + k, '/api/vcenters/' + e(ids.vc) + '/usage-history' + (k ? '?range=' + k : '')]);
      out.push(['vm|' + k, '/api/vms/' + e(ids.vm) + '/metrics?type=cpu' + (k ? '&interval=' + k : '')]);
      out.push(['host|' + k, '/api/hosts/' + e(ids.host) + '/metrics?type=cpu' + (k ? '&interval=' + k : '')]);
      out.push(['vms|' + k, '/api/vms/' + e(ids.vm) + '/metrics?types=cpu,mem' + (k ? '&interval=' + k : '')]);
    }
    // 아는 값은 그대로 받는다
    out.push(['temp|hour', '/api/tools/esxi-temp/history?level=host&key=' + e(ids.host) + '&days=1&bucket=hour']);
    out.push(['temp|minute', '/api/tools/esxi-temp/history?level=host&key=' + e(ids.host) + '&days=1&bucket=minute']);
    out.push(['gpu|10m', '/api/tools/gpu/history?level=host&key=' + e(ids.host) + '&days=1&bucket=10m']);
    out.push(['usage|1h', '/api/vcenters/' + e(ids.vc) + '/usage-history?range=1h']);
    out.push(['vm|day', '/api/vms/' + e(ids.vm) + '/metrics?type=cpu&interval=day']);
    out.push(['waste|day', '/api/tools/waste/history?vcenterId=' + e(ids.vc) + '&days=3&bucket=day']);
    return out;
  });
  const pick = (x) => ({ status: x.status, bucket: x.bucket, bucketMs: x.bucketMs, range: x.range, interval: x.interval, requested: x.requested, points: x.points, limit: x.limit });
  for (const route of ['temp', 'waste', 'disk', 'gpu', 'usage', 'vm', 'host', 'vms']) {
    const base = res.get(`${route}|`);
    assert.equal(base.status, 200, `${route} 기본 호출`);
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const got = res.get(`${route}|${k}`);
      // 모르는 값을 보낸 응답 = 값을 보내지 않은 응답(자동 · 기본값) — 수정 전: bucket 'constructor' · bucketMs 없음({}·함수) · 점 0~1개 · interval 'constructor'
      assert.deepEqual(pick(got), pick(base), `${route} ?${k} 가 기본값으로 떨어지지 않았다: ${JSON.stringify(got)}`);
    }
  }
  // 기본 응답 자체가 뜻이 있는 값인지(대조군이 둘 다 깨진 값이면 위 비교가 무의미하다)
  assert.equal(res.get('temp|').bucket, 'auto'); assert.equal(res.get('temp|').bucketMs, 3_600_000); assert.ok(res.get('temp|').points >= 2);
  assert.equal(res.get('waste|').bucketMsType, 'number'); assert.equal(res.get('disk|').bucketMsType, 'number'); assert.equal(res.get('gpu|').bucketMsType, 'number');
  assert.equal(res.get('usage|').range, '24h');
  assert.equal(res.get('vm|').interval, 'realtime'); assert.ok(res.get('vm|').points > 0);
  assert.equal(res.get('host|').interval, 'realtime'); assert.ok(res.get('host|').points > 0);
  assert.equal(res.get('vms|').requested, 'realtime');
  // 아는 값은 그대로
  assert.equal(res.get('temp|hour').bucket, 'hour'); assert.equal(res.get('temp|hour').bucketMs, 3_600_000);
  assert.equal(res.get('temp|minute').bucket, 'minute'); assert.equal(res.get('temp|minute').bucketMs, 60_000);
  assert.equal(res.get('gpu|10m').bucket, '10m'); assert.equal(res.get('gpu|10m').bucketMs, 600_000);
  assert.equal(res.get('usage|1h').range, '1h');
  assert.equal(res.get('vm|day').interval, 'day');
  assert.equal(res.get('waste|day').bucketMs, 86_400_000);
});
