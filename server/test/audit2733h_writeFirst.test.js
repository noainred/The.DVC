/**
 * v2.733 점검 3회차 그룹 h — C4-04: 설정·등록부 캐시는 **디스크 쓰기 성공 뒤에만** 바꾼다(v2.732 B5-03 의 형제 8곳).
 *
 * 결함: `_cache = next` 를 atomicWriteFileSync **앞**에 두어, 쓰기가 실패해 라우트가 오류를 준 뒤에도 메모리는 새 값이었다 —
 *   폴러·엣지 배포 라우트·GET 이 그 값을 쓰고, 재시작하면 파일의 옛 값으로 조용히 돌아갔다(storage growth 는 실패한 값을
 *   출처 'saved' 로까지 보였다). 변경 리스너(notify)도 쓰기 성공 뒤에만 부른다.
 *
 * 쓰기 실패는 atomicWriteFileSync 의 마지막 단계(fs.renameSync)를 대상 파일에 한해 던지게 해 만든다(audit2732i1_writeFirst 와 같은 방법 —
 *   atomicWrite.js 는 `import fs from 'node:fs'` 의 속성을 호출 시점에 읽는다. root 라 권한으로는 실패를 만들 수 없다).
 * ⚠ config.js 는 import 시점에 CONFIG_DIR 을 굳힌다 — env 를 고정한 뒤 dynamic import 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733h-'));

process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
for (const k of ['PARTFAULT_ENABLED', 'PARTFAULT_RETENTION_DAYS', 'CENTRAL_URL', 'CENTRAL_TOKEN', 'CVP_SETTINGS_LOCAL', 'CURUSER_LOCAL',
  'STORAGE_HISTORY_KEEP_DAYS', 'STORAGE_DAILY_KEEP_DAYS', 'IDRAC_SCAN_INTERVAL_MS']) delete process.env[k];

const mod = (rel, q = '') => import(pathToFileURL(path.join(SRC, rel)).href + q);
const fileOf = (name) => path.join(DIR, name);
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); } catch { return null; } };

/** 대상 파일 이름으로 끝나는 rename 만 실패시키고 원래 함수를 돌려준다. */
function failRenameFor(basename) {
  const real = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (path.basename(String(b)) === basename) { const e = new Error('ENOSPC: 모의 디스크 쓰기 실패'); e.code = 'ENOSPC'; throw e; }
    return real(a, b);
  };
  return () => { fs.renameSync = real; };
}
/** fn 이 던지는지(던진 오류 메시지) — 던지지 않으면 반환값. */
function attempt(fn) { try { return { threw: false, ret: fn() }; } catch (e) { return { threw: true, msg: String(e?.message || e) }; } }

test('① 파트 장애 스위치 — 저장 실패면 판정·배포값·보존일 출처가 그대로(엣지 applyCentral 도)', async () => {
  const pf = await mod('partfault/settings.js');
  pf._resetForTest();
  const before = structuredClone(pf.loadPartFaultSettings());
  const enBefore = pf.partFaultEnabled();
  const retBefore = pf.partFaultRetention();
  const agentBefore = pf.settingsForAgent('edge-a');
  assert.equal(enBefore.enabled, false);
  const restore = failRenameFor('partfault-settings.json');
  let r;
  try {
    r = attempt(() => pf.savePartFaultSettings({ enabled: true, retentionDays: 400, edges: { 'Edge-B': { enabled: true } } }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg), '쓰기 실패는 던져야 한다(라우트가 실패로 말한다)');
    const r2 = attempt(() => pf.applyCentral({ enabled: true }));   // 엣지 경로도 같은 persist
    assert.ok(r2.threw, '엣지 적용도 쓰기 실패를 던져야 한다(다음 pull 이 다시 시도)');
  } finally { restore(); }
  assert.deepEqual(pf.loadPartFaultSettings(), before, '쓰기 실패 뒤 메모리 설정이 새 값이면 안 된다');
  assert.deepEqual(pf.partFaultEnabled(), enBefore, '쓰기 실패 뒤 판정(중앙 판정·알림)은 옛 값 그대로');
  assert.deepEqual(pf.partFaultRetention(), retBefore, '쓰기 실패한 보존일이 출처 settings 로 보이면 안 된다');
  assert.deepEqual(pf.settingsForAgent('edge-a'), agentBefore, '엣지에 배포할 값도 옛 값 그대로');
  assert.equal(readJson('partfault-settings.json'), null, '파일은 쓰이지 않았다');
  // 재시작(새 모듈 인스턴스) 뒤와 지금이 같다
  const pf2 = await mod('partfault/settings.js', '?restart=1');
  assert.deepEqual(pf2.partFaultEnabled(), enBefore);
  // 정상 경로 회귀 없음
  pf.savePartFaultSettings({ enabled: true, retentionDays: 400 });
  assert.equal(pf.partFaultEnabled().enabled, true);
  assert.deepEqual(pf.partFaultRetention(), { days: 400, source: 'settings' });
  assert.equal(pf.applyCentral({ enabled: false }), true);
  assert.equal(pf.loadPartFaultSettings().central.enabled, false);
});

test('② PDU 등록부 — 등록·삭제 저장 실패면 엣지 배포 목록이 바뀌지 않는다', async () => {
  const pdu = await mod('pdu/registry.js');
  pdu._resetForTest();
  const dev = { name: 'pdu-x', host: '10.9.9.9', username: 'apc', password: 'p', agent: 'edge-a' };
  let restore = failRenameFor('pdu-devices.json');
  try {
    const r = attempt(() => pdu.saveDevice(dev));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg), `등록 쓰기 실패는 던져야 한다(${JSON.stringify(r)})`);
  } finally { restore(); }
  assert.deepEqual(pdu.devicesForAgent('edge-a'), [], '실패한 등록이 /pdu-config 로 엣지에 내려가면 안 된다');
  assert.deepEqual(pdu.listDevices(), []);
  assert.equal(pdu.registryLoadError(), null);
  // 정상 등록
  const ok = pdu.saveDevice(dev);
  assert.equal(ok.ok, true);
  assert.equal(pdu.devicesForAgent('edge-a').length, 1);
  // 삭제 실패 → 메모리에서도 남아 있다(재시작 뒤 되살아나는 일 없음)
  restore = failRenameFor('pdu-devices.json');
  try {
    const r = attempt(() => pdu.deleteDevice(ok.device.id));
    assert.ok(r.threw, '삭제 쓰기 실패는 던져야 한다');
  } finally { restore(); }
  assert.equal(pdu.devicesForAgent('edge-a').length, 1, '삭제가 저장되지 않았으면 메모리에서도 지우지 않는다');
  pdu._resetForTest();
  assert.equal(pdu.devicesForAgent('edge-a').length, 1, '재시작 뒤와 같다');
  // 엣지 pull 적용(applyPulledDevices)도 같은 save
  restore = failRenameFor('pdu-devices.json');
  try { assert.ok(attempt(() => pdu.applyPulledDevices([])).threw); } finally { restore(); }
  assert.equal(pdu.listDevices().length, 1, '엣지 적용 쓰기 실패면 목록 그대로');
});

test('③ CVP 설정 — 저장 실패면 메모리·리스너 그대로, 엣지 applyCentralSettings 는 다음 pull 에 다시 시도한다', async () => {
  const cvp = await mod('cvp/settings.js');
  cvp._resetForTest();
  const before = cvp.loadSettings();
  assert.equal(before.enabled, false);
  let calls = 0;
  const off = cvp.onSettingsChange(() => { calls += 1; });
  const restore = failRenameFor('cvp-settings.json');
  try {
    const r = attempt(() => cvp.saveSettings({ enabled: true, intervalMs: 600_000 }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg));
    const r2 = attempt(() => cvp.applyCentralSettings({ enabled: true }));
    assert.ok(r2.threw, '엣지 적용 쓰기 실패는 던져야 한다');
  } finally { restore(); }
  assert.deepEqual(cvp.loadSettings(), before, '쓰기 실패 뒤 메모리 설정이 새 값이면 안 된다');
  assert.equal(calls, 0, '저장되지 않은 변경으로 리스너(타이머 재무장)를 부르면 안 된다');
  cvp._resetForTest();
  assert.deepEqual(cvp.loadSettings(), before, '재시작 뒤와 같다');
  // 실패한 엣지 적용은 다음 pull 에 다시 시도된다(캐시가 '이미 같다' 로 건너뛰지 않는다)
  assert.equal(cvp.applyCentralSettings({ enabled: true }), true);
  assert.equal(cvp.loadSettings().enabled, true);
  assert.equal(calls, 1);
  off();
});

test('④ 현재 사용자 수집 설정 — 저장 실패면 메모리·리스너 그대로(엣지 applyCentral 포함)', async () => {
  const cu = await mod('curuser/settings.js');
  cu._resetForTest();
  const before = cu.load();
  assert.equal(before.enabled, false);
  let calls = 0;
  cu.onCurUserSettingsChange(() => { calls += 1; });
  const restore = failRenameFor('curuser-settings.json');
  try {
    const r = attempt(() => cu.save({ enabled: true, vcenters: { 'vc-1': { enabled: true, folders: ['/DC/vm/A'] } } }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg));
    assert.ok(attempt(() => cu.applyCentral({ enabled: true })).threw, '엣지 적용 쓰기 실패는 던져야 한다');
  } finally { restore(); }
  assert.deepEqual(cu.load(), before, '쓰기 실패 뒤 메모리 설정이 새 값이면 안 된다');
  assert.equal(calls, 0, '저장되지 않은 변경으로 리스너를 부르면 안 된다');
  // 정상 경로 — 저장되면 바뀌고 리스너가 불린다
  cu.save({ enabled: true });
  assert.equal(cu.load().enabled, true);
  assert.equal(calls, 1);
  assert.equal(readJson('curuser-settings.json')?.enabled, true);
});

test('⑤ HAProxy 경로 점검 설정 — 저장 실패면 메모리·리스너 그대로', async () => {
  const rc = await mod('relaycheck/settings.js');
  rc._resetForTest();
  const before = rc.loadSettings();
  assert.equal(before.enabled, true, '기본값은 켜짐');
  let calls = 0;
  const off = rc.onRelayCheckSettingsChange(() => { calls += 1; });
  const restore = failRenameFor('relaycheck-settings.json');
  try {
    const r = attempt(() => rc.saveSettings({ enabled: false, intervalMs: 3_600_000 }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg));
  } finally { restore(); }
  assert.deepEqual(rc.loadSettings(), before, '쓰기 실패 뒤 메모리 설정이 새 값이면 안 된다');
  assert.equal(calls, 0, '저장되지 않은 변경으로 리스너를 부르면 안 된다');
  rc._resetForTest();
  assert.deepEqual(rc.loadSettings(), before, '재시작 뒤와 같다');
  rc.saveSettings({ enabled: false });
  assert.equal(rc.loadSettings().enabled, false);
  assert.equal(calls, 1);
  off();
});

test('⑥ 중계 토폴로지 — 저장 실패면 메모리 토폴로지 그대로(정상 저장의 비열거 필드는 유지)', async () => {
  const rt = await mod('relaytopo/store.js');
  rt._resetForTest();
  const before = rt.loadTopology();
  const rawBefore = rt.loadTopologyRaw();
  assert.equal(before.sites.length, 0);
  const restore = failRenameFor('relay-topology.json');
  try {
    const r = attempt(() => rt.saveTopology({ main: { privateIp: '10.1.1.1' }, sites: [{ dc: 'DC1', edge: { privateIp: '10.2.2.2', ssh: { username: 'u', password: 'pw' } } }] }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg), `쓰기 실패는 던져야 한다(${JSON.stringify(r)})`);
  } finally { restore(); }
  assert.deepEqual(rt.loadTopology(), before, '쓰기 실패 뒤 메모리 토폴로지가 새 값이면 안 된다');
  assert.deepEqual(rt.loadTopologyRaw(), rawBefore, 'SSH 비밀 포함 원본도 그대로');
  rt._resetForTest();
  assert.deepEqual(rt.loadTopology(), before, '재시작 뒤와 같다');
  // 정상 저장 + 호스트를 바꿔 비밀을 버린 사실(비열거 필드)이 응답에 실린다
  rt.saveTopology({ main: { privateIp: '10.1.1.1' }, sites: [{ dc: 'DC1', edge: { privateIp: '10.2.2.2', ssh: { username: 'u', password: 'pw' } } }] });
  assert.deepEqual(rt.loadTopology().sites.map((s) => s.dc), ['DC1']);
  assert.equal(rt.loadTopology().sites[0].edge.ssh.hasPassword, true);
  const out = rt.saveTopology({ ...rt.loadTopologyRaw(), sites: [{ dc: 'DC1', edge: { privateIp: '10.2.2.3' } }] });
  assert.deepEqual(out.secretsDropped, ['DC1 Edge'], '정상 저장의 secretsDropped 는 그대로 넘어간다');
});

test('⑦ 스토리지 사용량 보존 설정 — 저장 실패면 출처 saved 로 보이지 않고 DB 보존 일수도 그대로', async () => {
  const gs = await mod('storage/growthSettings.js');
  const db = await mod('storage/db.js');
  gs._resetForTest();
  gs.saveGrowthSettings({ dailyKeepDays: 1000 });
  const before = gs.loadGrowthSettings();
  const keepBefore = db.effectiveKeepDays();
  assert.equal(before.dailyKeepDays, 1000);
  assert.equal(before.rawKeepDaysSource, 'default');
  const restore = failRenameFor('storage-growth-settings.json');
  try {
    const r = attempt(() => gs.saveGrowthSettings({ rawKeepDays: 200 }));
    assert.ok(r.threw && /모의 디스크 쓰기 실패/.test(r.msg));
  } finally { restore(); }
  assert.deepEqual(gs.loadGrowthSettings(), before, "쓰기 실패한 값이 '저장됨(saved)' 으로 보이면 안 된다");
  assert.deepEqual(db.effectiveKeepDays(), keepBefore, '쓰기 실패면 DB 보존 일수에도 적용하지 않는다');
  gs._resetForTest();
  assert.deepEqual(gs.loadGrowthSettings(), before, '재시작 뒤와 같다');
  const ok = gs.saveGrowthSettings({ rawKeepDays: 200 });
  assert.equal(ok.values.rawKeepDays, 200);
  assert.equal(ok.values.rawKeepDaysSource, 'saved');
  assert.equal(ok.values.dailyKeepDays, 1000, '다른 저장값은 그대로');
  assert.deepEqual(readJson('storage-growth-settings.json'), { dailyKeepDays: 1000, rawKeepDays: 200 });
});

test('⑧ iDRAC 스캔 주기 — 저장 실패 응답이면 상태 화면 주기도 옛 값', async () => {
  const sp = await mod('idrac/scanPoller.js');
  const before = sp.idracScanStatus().intervalMs;
  assert.ok(before !== 3_600_000);
  const restore = failRenameFor('idrac-scan-settings.json');
  let r;
  try { r = sp.setIdracScanIntervalMs(3_600_000); } finally { restore(); }
  assert.equal(r.ok, false);
  assert.match(r.reason, /저장 실패/);
  assert.equal(sp.idracScanStatus().intervalMs, before, "'저장 실패' 라 말해 놓고 상태 주기가 새 값이면 안 된다");
  assert.equal(readJson('idrac-scan-settings.json'), null);
  const sp2 = await mod('idrac/scanPoller.js', '?restart=1');
  assert.equal(sp2.idracScanStatus().intervalMs, before, '재시작 뒤와 같다');
  // 정상 경로
  const ok = sp.setIdracScanIntervalMs(2 * 3_600_000);
  assert.equal(ok.ok, true);
  assert.equal(sp.idracScanStatus().intervalMs, 2 * 3_600_000);
  assert.equal(readJson('idrac-scan-settings.json')?.intervalMs, 2 * 3_600_000);
  assert.equal(sp.setIdracScanIntervalMs(0).ok, true); // 타이머 해제
});
