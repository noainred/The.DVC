/**
 * 전체 점검 93회차 — iDRAC · 파트 장애 2차(server/src/idrac · partfault).
 *
 *  F1(81회차 남긴 것 P1 — 재현): iDRAC 인벤토리가 매니저 로그(SEL · LC)를 둘 다 못 읽거나 매니저 id 가 없어도 `events` 가 빈 배열이라
 *     하드웨어 U 의 'SEL Critical 0건 · ok' · 스냅샷 '최근 이벤트 없음' 이 나왔다 → redfish 가 `collections.events` 'ok'|'failed' 를 남기고
 *     hwFacts · 스냅샷은 'failed' 면 null(못 읽음). 이 표지는 장비 도달(reachable) 판정에 넣지 않는다(예전 판정 그대로).
 *  F2(재현): iDRAC 등록부 **읽기 오류** 중 가져오기 · 일괄 등록 · 스캔 등록(수동) · 일괄 삭제가 saveRegistry 의 마지막 방어선에서 던져
 *     사유 없는 'bad request' 를 받았고, 소속 vCenter 일괄 지정은 빈 목록을 읽고 '0대 변경 · 성공' 이라 했다 → 먼저 409 결과.
 *  F3(재현 — 34회차 F4 · 결정 78 ① 의 형제): `idrac-scan-ranges.json`(스캔 계정 · iLO 계정) 읽기 오류를 손상으로 보고 원본을 옮겼다 →
 *     공용 판정(registryCore makeLoadError.read) · 읽기 오류 중 저장 · 삭제 · 라벨 · CSV 가져오기 409 · 30초마다 다시 읽음.
 *  F4(재현 — 같은 꼴): `partfault-settings.json` 읽기 오류도 원본을 옮기고 기본값(꺼짐)을 재시작까지 캐시했다(중앙 판정 · 알림 조용히 꺼짐) →
 *     공용 로더(makeJsonFileLoader) · 저장 409 · 읽히면 재시작 없이 풀림.
 * 픽스처 식별자는 전부 합성(SYNTH…)이다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-part-93-'));
process.env.CONFIG_DIR = CFG;
process.env.IDRAC_TIMEOUT_MS = '1500';
// 읽기 오류 = 파일 자리에 디렉터리(EISDIR — 테스트가 root 로 돌아도 재현되는 읽기 오류. 운영의 EACCES 와 같은 갈래).
for (const f of ['idrac.json', 'idrac-scan-ranges.json', 'partfault-settings.json']) fs.mkdirSync(path.join(CFG, f));

const { fetchInventory } = await import('../src/idrac/redfish.js');
const { shapeHwFacts } = await import('../src/bmusage/hwFacts.js');
const { idracSnapshotFacts } = await import('../src/bmusage/snapshot/run.js');
const reg = await import('../src/idrac/registry.js');
const sr = await import('../src/idrac/scanRanges.js');
const pf = await import('../src/partfault/settings.js');
const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');

// 기준 시각 — 실제 시각을 정시로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다).
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const backups = (name) => fs.readdirSync(CFG).filter((n) => n.startsWith(`${name}.corrupt.`));

async function startFakeRedfish(routes) {
  const srv = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const r = routes[p];
    const status = r == null ? 404 : (typeof r === 'number' ? r : 200);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? r : { error: { message: `synthetic ${status}` } }));
  });
  await new Promise((ok, ng) => { srv.on('error', ng); srv.listen(0, '127.0.0.1', ok); });
  return { host: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => srv.close(ok)) };
}
const SYS = '/redfish/v1/Systems/System.Synth.1';
const MGR = '/redfish/v1/Managers/iDRAC.Synth.1';
const BASE = {
  '/redfish/v1/Systems': { Members: [{ '@odata.id': SYS }] },
  [SYS]: { Model: 'PowerEdge SYNTH', SKU: 'SYNTH0000093', Status: { Health: 'OK' } },
  '/redfish/v1/Managers': { Members: [{ '@odata.id': MGR }] },
  [MGR]: { FirmwareVersion: '9.9.9' },
};

test('F1 ① redfish: SEL · LC 둘 다 실패 → events failed · 매니저 없음 → failed · 하나라도 읽으면 ok(0건도 ok)', async () => {
  const both = await startFakeRedfish({ ...BASE, [`${MGR}/LogServices/Sel/Entries`]: 500, [`${MGR}/LogServices/Lclog/Entries`]: 500 });
  try {
    const inv = await fetchInventory({ id: 'x', host: both.host, username: 'u', password: 'p' });
    assert.equal(inv.collections.events, 'failed');
    assert.deepEqual(inv.events, [], '하위 호환 — 배열은 그대로 빈 배열');
  } finally { await both.close(); }

  const noMgr = await startFakeRedfish({ '/redfish/v1/Systems': BASE['/redfish/v1/Systems'], [SYS]: BASE[SYS] });
  try {
    const inv = await fetchInventory({ id: 'x', host: noMgr.host, username: 'u', password: 'p' });
    assert.equal(inv.collections.events, 'failed', '매니저 id 가 없으면 로그를 시도조차 못 했다');
  } finally { await noMgr.close(); }

  const empty = await startFakeRedfish({ ...BASE, [`${MGR}/LogServices/Sel/Entries`]: { Members: [] } });   // Lclog 404
  try {
    const inv = await fetchInventory({ id: 'x', host: empty.host, username: 'u', password: 'p' });
    assert.equal(inv.collections.events, 'ok', 'SEL 을 읽었다 — 0건은 0건');
    assert.deepEqual(inv.events, []);
  } finally { await empty.close(); }

  const lc = await startFakeRedfish({ ...BASE, [`${MGR}/LogServices/Sel/Entries`]: 500,
    [`${MGR}/LogServices/Lclog/Entries`]: { Members: [{ Severity: 'Critical', Created: '2026-11-17T00:00:00Z', Message: 'SYNTH PSU lost' }] } });
  try {
    const inv = await fetchInventory({ id: 'x', host: lc.host, username: 'u', password: 'p' });
    assert.equal(inv.collections.events, 'ok', 'SEL 실패 · LC 성공 = 읽었다');
    assert.equal(inv.events.length, 1);
  } finally { await lc.close(); }
});

test('F1 ② redfish: 매니저 로그만 읽힌 장비는 reachable 판정이 예전 그대로(events 는 도달 판정에 넣지 않는다)', async () => {
  const fake = await startFakeRedfish({
    '/redfish/v1/Systems': 500, '/redfish/v1/Chassis': 500,
    '/redfish/v1/Managers': BASE['/redfish/v1/Managers'], [MGR]: BASE[MGR], [`${MGR}/LogServices/Sel/Entries`]: { Members: [] },
  });
  try {
    const inv = await fetchInventory({ id: 'x', host: fake.host, username: 'u', password: 'p' });
    assert.equal(inv.collections.events, 'ok');
    assert.equal(inv.reachable, false, '부품 컬렉션 · Systems 가 전부 실패 — 예전과 같이 닿지 못함(파트 장애 보류 사유가 바뀌지 않는다)');
  } finally { await fake.close(); }
});

test('F1 ③ hwFacts selCritical: failed → null(못 읽음) · ok → 건수 · 표지 없는 예전 캐시 → 예전 그대로', () => {
  const now = T0;
  const inv = (events, coll) => ({ collectedAt: now - 60_000, events, ...(coll ? { collections: coll } : {}) });
  const crit = [{ severity: 'Critical' }, { severity: 'Warning' }];
  assert.equal(shapeHwFacts({ inv: inv([], { events: 'failed' }) }, { now }).selCritical, null, "읽지 못한 로그는 '0건 · ok' 가 아니다");
  assert.equal(shapeHwFacts({ inv: inv([], { events: 'ok' }) }, { now }).selCritical, 0);
  assert.equal(shapeHwFacts({ inv: inv(crit, { events: 'ok' }) }, { now }).selCritical, 1);
  assert.equal(shapeHwFacts({ inv: inv(crit, { psus: 'ok' }) }, { now }).selCritical, 1, '표지 없는 예전 인벤토리는 예전 판정');
  assert.equal(shapeHwFacts({ inv: inv([]) }, { now }).selCritical, 0, '메타 없는 아주 예전 캐시도 예전 판정');
});

test('F1 ④ 스냅샷 iDRAC 칸: 로그를 못 읽었으면 events null(화면 — 못 읽음) · 읽었으면 배열', async () => {
  const deps = (inv) => ({ getInventory: async () => inv, getSensorSeries: async () => null, powerLatest: async () => null });
  const failed = await idracSnapshotFacts({ idrac: { regId: 'SYNTH-1' } }, deps({ collectedAt: T0, events: [], collections: { events: 'failed' } }));
  assert.equal(failed.events, null);
  const ok = await idracSnapshotFacts({ idrac: { regId: 'SYNTH-1' } }, deps({ collectedAt: T0, events: [], collections: { events: 'ok' } }));
  assert.deepEqual(ok.events, []);
  // 화면: null 이면 '못 읽음' 문구 — '최근 이벤트 없음' 으로 접지 않는다.
  const tab = stripComments(fs.readFileSync(new URL('../../web/src/views/tools/BmSnapshotTab.jsx', import.meta.url), 'utf8'));
  assert.ok(/r\.idrac\.events == null \?/.test(tab), 'BmSnapshotTab 이 null(못 읽음)을 따로 말해야 한다');
});

test('F2 iDRAC 등록부 읽기 오류: 가져오기 · 일괄 등록 · 스캔 등록 · 일괄 삭제 · vCenter 지정이 던지지 않고 409 결과 · 원본은 그대로', () => {
  const calls = {
    importServers: () => reg.importServers([{ id: '10.0.0.5', host: '10.0.0.5', username: 'u', password: 'p' }], 'merge'),
    bulkAddByIps: () => reg.bulkAddByIps({ ips: '10.0.0.6', username: 'u', password: 'p' }),
    registerScanned: () => reg.registerScanned([{ ip: '10.0.0.7' }], 'u', 'p', 'merge'),
    deleteServersAll: () => reg.deleteServers({ all: true }),
    assignVcenter: () => reg.assignVcenter({ ids: null, vcenterId: 'vc-synth' }),
  };
  for (const [name, fn] of Object.entries(calls)) {
    let r;
    assert.doesNotThrow(() => { r = fn(); }, `${name} 이 던졌다(전역 오류 처리기 — 사유 없는 'bad request')`);
    assert.equal(r.ok, false, name);
    assert.equal(r.status, 409, name);
    assert.equal(r.code, 'registry-unreadable', name);
    assert.ok(/읽지 못한/.test(r.reason), name);
  }
  assert.ok(fs.statSync(path.join(CFG, 'idrac.json')).isDirectory(), '원본 자리를 건드리지 않았다');
  assert.deepEqual(backups('idrac.json'), [], '읽기 오류는 손상 보존본을 만들지 않는다');
  // 라우트는 결과의 status 를 쓴다(예전 고정 400 · 200).
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/idracScan.js', import.meta.url), 'utf8'));
  for (const [route, fn] of [['/idrac/import', 'importServers'], ['/idrac/bulk-add', 'bulkAddByIps'], ['/idrac/register-scanned', 'registerScanned'], ['/idrac/delete', 'deleteServers'], ['/idrac/assign-vcenter', 'assignVcenter']]) {
    const i = src.indexOf(`'${route}'`);
    assert.ok(i > 0, route);
    const body = src.slice(i, src.indexOf('\n});', i));   // 그 라우트 본문만(다음 라우트의 같은 줄로 통과하지 않게)
    assert.ok(body.includes(`${fn}(`), `${route} 가 ${fn} 을 부른다`);
    assert.ok(/res\.status\(result\.ok \? 200 : \(result\.status \|\| 400\)\)/.test(body), `${route} 라우트가 result.status(409)를 써야 한다`);
  }
});

test('F3 스캔 대역 읽기 오류: 원본을 옮기지 않음 · 저장 · 삭제 · 라벨 409 · 실행 이력 쓰기 없음 · 읽히면 재시작 없이 풀림 · 손상은 예전처럼 보존', () => {
  let clock = T0;
  _setJsonFileLoadClockForTest(() => clock);
  try {
    const file = path.join(CFG, 'idrac-scan-ranges.json');
    assert.deepEqual(sr.listScanRanges(), []);
    assert.ok(fs.statSync(file).isDirectory(), '원본 자리를 옮기지 않았다');
    assert.deepEqual(backups('idrac-scan-ranges.json'), []);
    assert.equal(sr.scanRangesLoadError()?.readError, true);
    const save = sr.saveScanRanges({ datacenterId: 'dc-synth', ranges: ['10.9.0.0/30'], username: 'u', password: 'p' });
    assert.equal(save.ok, false); assert.equal(save.status, 409); assert.equal(save.code, 'registry-unreadable');
    const del = sr.removeScanRanges('any-id');
    assert.equal(del.status, 409, "읽기 오류는 '없는 항목' 404 보다 먼저 409");
    assert.equal(sr.setScanRangeLabel('any-id', 'svc', { datacenterId: 'dc-synth' }).status, 409);
    sr.recordScanRangeRun('any-id', { found: 1 });
    assert.ok(fs.statSync(file).isDirectory(), '실행 이력 갱신이 원본 자리를 덮지 않았다');
    assert.equal(sr.scanRangesWriteRefusal()?.status, 409);

    // 회복: 사람이 권한(여기서는 자리)을 고치면 30초 뒤 다시 읽어 풀린다(재시작 없이).
    fs.rmdirSync(file);
    fs.writeFileSync(file, JSON.stringify({ entries: { 'e-synth': { datacenterId: 'dc-synth', service: '', ranges: ['10.9.0.0/30'], username: 'u', password: 'p', agent: '', enabled: true, mode: 'merge' } } }));
    clock += 31_000;
    assert.equal(sr.listScanRanges().length, 1, '읽히면 목록이 돌아온다');
    assert.equal(sr.scanRangesLoadError(), null);
    assert.equal(sr.scanRangesWriteRefusal(), null);
    const ok = sr.saveScanRanges({ id: 'e-synth', datacenterId: 'dc-synth', ranges: ['10.9.0.0/30'], username: 'u' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(sr.getScanRangeRaw('e-synth')?.password, 'p', '비밀번호 빈 칸 = 기존 유지(회복 뒤 저장)');

    // 손상(파싱 실패)은 예전처럼 보존본으로 옮기고 관리자 저장을 막지 않는다.
    fs.writeFileSync(file, '{ not json');
    clock += 1_000;
    const t = fs.statSync(file).mtimeMs; fs.utimesSync(file, new Date(t + 5_000), new Date(t + 5_000));
    assert.deepEqual(sr.listScanRanges(), []);
    assert.equal(backups('idrac-scan-ranges.json').length, 1, '손상은 보존본으로');
    assert.equal(sr.scanRangesWriteRefusal(), null, '손상은 쓰기 거절이 아니다(v2.612 규약)');
    assert.equal(sr.saveScanRanges({ datacenterId: 'dc-synth', ranges: ['10.9.1.0/30'], username: 'u', password: 'p' }).ok, true);
  } finally { _setJsonFileLoadClockForTest(); }
});

test('F4 파트 장애 설정 읽기 오류: 원본을 옮기지 않음 · 기본값(꺼짐) · 저장 409 · 읽히면 재시작 없이 풀림', () => {
  let clock = T0;
  _setJsonFileLoadClockForTest(() => clock);
  try {
    const file = path.join(CFG, 'partfault-settings.json');
    pf._resetForTest();
    assert.equal(pf.loadPartFaultSettings().enabled, false, '켜진 척하지 않는다');
    assert.ok(fs.statSync(file).isDirectory(), '원본 자리를 옮기지 않았다');
    assert.deepEqual(backups('partfault-settings.json'), []);
    assert.equal(pf.partFaultSettingsLoadError()?.readError, true, '엣지 배포 라우트(503)가 보는 오류가 서 있다');
    const no = pf.partFaultSettingsWriteRefusal();
    assert.equal(no?.status, 409); assert.equal(no?.readError, true);
    assert.throws(() => pf.savePartFaultSettings({ enabled: true }), (e) => e.status === 409);
    assert.throws(() => pf.applyCentral({ enabled: true }), (e) => e.status === 409, '엣지 적용도 원본을 덮지 않는다(호출부 pull 이 잡는다)');
    assert.ok(fs.statSync(file).isDirectory());

    fs.rmdirSync(file);
    fs.writeFileSync(file, JSON.stringify({ enabled: true, edges: { 'edge-synth': { enabled: false } }, retentionDays: 400 }));
    clock += 31_000;
    const s = pf.loadPartFaultSettings();
    assert.equal(s.enabled, true, '읽히면 원래 값(켜짐)으로 돌아온다');
    assert.equal(s.edges['edge-synth'].enabled, false);
    assert.equal(pf.partFaultSettingsLoadError(), null);
    assert.equal(pf.partFaultSettingsWriteRefusal(), null);
    assert.equal(pf.savePartFaultSettings({ retentionDays: 500 }).retentionDays, 500);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).edges['edge-synth'].enabled, false, '엣지별 스위치가 보존됐다');
  } finally { _setJsonFileLoadClockForTest(); }
  // 라우트: 저장 전에 409 + 사유
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/partFaults.js', import.meta.url), 'utf8'));
  const i = src.indexOf("api.put('/tools/part-faults/settings'");
  assert.ok(i > 0 && src.indexOf('partFaultSettingsWriteRefusal()', i) > i && src.indexOf('partFaultSettingsWriteRefusal()', i) < src.indexOf('savePartFaultSettings(', i));
});
