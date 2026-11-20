/**
 * readErrorSweep103.test.js — 전체 점검 103회차: '읽기 오류 ≠ 손상' 스윕 잔여(97회차가 남긴 파일 중 위험 순).
 *
 * 꼴(97회차와 같다): 설정 · 원장 파일의 **읽기 오류**(EACCES · EIO · EISDIR)를 손상(parse 실패)과 같은 catch 하나로 받아 온전한 원본을 `.corrupt.*` 로 옮기고
 *   빈 값 · 기본값을 캐시 → 다음 저장이 원본 자리를 한 건짜리 · 기본값 파일로 채웠다(비밀 · 원장 소실).
 *   공용 읽기(util/jsonFileRead.js — 30초 간격 재읽기)로 옮긴 모듈마다 고정한다: 원본 유지(보존본 없음) · 캐시 안 함 · 쓰기 409 · 읽히면 원래 값.
 *   읽기 오류는 root 컨테이너라 EACCES 대신 **EISDIR**(파일 자리에 폴더)로 재현한다.
 *
 *  F1 svcmon/store(감시 대상 — 엣지 배정 · 설정 연동 동기화도 거절)  F2 central/svcmonAssign(엣지 배정)  F3 svcmon/templates(내장본으로 덮음)
 *  F4 relaytopo/store(SSH 비밀)  F5 upgrade/settings(토큰 — 마지막 값으로 돈다)  F6 upgrade/packageSettings(토큰)  F7 security/guestScanScheduler(게스트 비밀)
 *  F8 storage/growthSettings(보존 기간 — 정리는 상한 · 다시 읽히면 그 값)  F9 vmclone/store(잡 · 원장)  F10 upgrade/fleetBundle(보관 기록 — 정리 대상 유실)
 *  F11 ipam/report(설정 · 상태)  F12 alerts.js(알림 설정 · 웹훅)  F13 alarm-mutes(뮤트 — 마지막 규칙 유지)
 *  F14 central/agentGpuGuestConfig(엣지별 게스트 비밀 — 기동 시 한 번 읽던 것)  F15 ping/store(대상 · tombstone — 기동 시 자동 시드가 덮음)
 *  F16 rma/schedules(법인별 점검 스케줄)  F17 vmclone/corpMounts(법인 마운트 지정 — 지정이 사라지면 전부 허용)
 *  F18 backup/settings(보관 개수 — 기본 30개로 백업 정리)  F19 ipam/scanStore 설정(엣지 스캔 배정 — 결과 · 이력은 남김)
 *  F20 cvp/settings(재시작 · 확정 없이 풀림)  F21 vmseries/settings(마지막 값 · 정리는 상한 보존일)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'readErr103-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep103`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
/** 읽기 오류 뒤 공통 확인 — 원본 자리(폴더)는 그대로 · 보존본 없음. */
function untouched(name) {
  assert.ok(fs.statSync(F(name)).isDirectory(), `${name}: 원본 자리를 옮기거나 덮으면 안 된다(읽기 오류는 손상이 아니다)`);
  assert.deepEqual(corruptOf(name), [], `${name}: 읽기 오류에 보존본을 만들면 안 된다`);
}
const is409 = (fn) => { try { fn(); } catch (e) { return e?.status === 409; } return false; };

test('F1 서비스 감시 대상(svcmon.json): 읽기 오류면 원본 유지 · 캐시 안 함 · 쓰기 409 · 배정 동기화 거절 · 읽히면 원래 대상', async () => {
  fs.writeFileSync(F('svcmon.json'), JSON.stringify({ targets: [{ id: 't1', kind: 'infra', path: '', name: 'web-01', host: '10.0.0.1', agent: 'edge-a', tests: [] }], folders: [] }));
  const S = await import('../src/svcmon/store.js');
  S._resetCache();
  const restore = asDir('svcmon.json');
  assert.deepEqual(S.listTargets(), []);
  assert.equal(S.svcmonStoreReadError()?.code, 'EISDIR');
  assert.equal(S.svcmonStoreWriteRefusal()?.status, 409);
  assert.ok(is409(() => S.addFolder({ kind: 'infra', path: '새 폴더' })), '빈 목록 위에 한 건만 든 파일을 쓰지 않는다');
  assert.throws(() => S.bulkAddTargets([{ kind: 'infra', path: '서비스', name: 'web-02', host: '10.0.0.2' }]), (e) => e?.status === 409);
  const SYNC = await import('../src/central/svcmonAssignSync.js');
  const r = SYNC.syncByAgentAssignments(['edge-a'], 'adm');
  assert.equal(r[0].ok, false, '빈 목록을 배정으로 굳히면 엣지가 중앙 배포 점검을 전부 지운다');
  untouched('svcmon.json');
  restore();
  assert.deepEqual(S.listTargets(), [], '간격(30초) 안에는 디스크를 다시 보지 않는다');
  pass();
  assert.equal(S.listTargets().length, 1, '읽히면 원래 대상으로 돌아온다(재시작 없이)');
  assert.equal(S.svcmonStoreReadError(), null);
  // 손상은 예전과 같다 — 보존본으로 옮긴다.
  fs.writeFileSync(F('svcmon.json'), '{깨짐');
  S._resetCache();
  assert.deepEqual(S.listTargets(), []);
  assert.equal(corruptOf('svcmon.json').length, 1);
  S._resetCache();
});

test('F2 성능점검 엣지 배정(central-svcmon-assign.json): 읽기 오류면 원본 유지 · 표지(readError) · 관리자 저장도 409', async () => {
  fs.writeFileSync(F('central-svcmon-assign.json'), JSON.stringify({ v: 1, agents: { 'edge-a': { agent: 'edge-a', scope: { byAgent: true }, targets: [], counts: { targets: 0, tests: 0 }, sig: 'abc' } } }));
  const A = await import('../src/central/svcmonAssign.js');
  A._resetAssignCache();
  const restore = asDir('central-svcmon-assign.json');
  assert.equal(A.svcmonAssignLoadError()?.readError, true, '설정 pull 은 503 으로 답하고(엣지는 직전 배포분 유지) — 손상이 아니다');
  assert.ok(is409(() => A.setAssignment('edge-b', { byAgent: true }, [], { user: 'adm' })), '관리자 저장이 한 건짜리 파일로 덮지 않는다');
  untouched('central-svcmon-assign.json');
  restore(); pass();
  assert.equal(A.svcmonAssignLoadError(), null);
  assert.deepEqual(A.listAssignments().map((x) => x.agent), ['edge-a']);
  A._resetAssignCache();
});

test('F3 서비스 감시 템플릿(svcmon-templates.json): 읽기 오류면 내장본으로 덮지 않는다 · 저장 409 · 읽히면 사용자 템플릿', async () => {
  fs.writeFileSync(F('svcmon-templates.json'), JSON.stringify({ version: 1, templates: [{ id: 'tpl-user1', name: '사용자 템플릿', items: [] }] }));
  const T = await import('../src/svcmon/templates.js');
  T._resetTemplateCache();
  const restore = asDir('svcmon-templates.json');
  assert.ok(T.listTemplates().length >= 1, '못 읽는 동안은 내장 템플릿을 보여 준다(캐시 · 저장하지 않는다)');
  assert.equal(T.templatesReadError()?.code, 'EISDIR');
  assert.ok(is409(() => T.addTemplate({ name: '새 템플릿', items: [] })));
  untouched('svcmon-templates.json');
  restore(); pass();
  assert.ok(T.listTemplates().some((t) => t.id === 'tpl-user1'), '읽히면 사용자 템플릿이 돌아온다(내장본으로 덮이지 않았다)');
  assert.equal(T.templatesReadError(), null);
  T._resetTemplateCache();
});

test('F4 중계 토폴로지(relay-topology.json): 읽기 오류면 원본(SSH 비밀) 유지 · 저장 409 · 읽히면 비밀 그대로', async () => {
  fs.writeFileSync(F('relay-topology.json'), JSON.stringify({ version: 1, main: { privateIp: '10.0.0.10' }, sites: [{ dc: 'DC-A', edge: { privateIp: '10.1.0.1', ssh: { username: 'relay', password: 'pw-a' } }, irs: {} }] }));
  const R = await import('../src/relaytopo/store.js');
  R._resetForTest();
  assert.equal(R.loadTopologyRaw().sites[0].edge.ssh.password, 'pw-a');
  R._resetForTest();
  const restore = asDir('relay-topology.json');
  assert.deepEqual(R.loadTopologyRaw().sites, []);
  assert.equal(R.relayTopologyReadError()?.code, 'EISDIR');
  assert.ok(is409(() => R.saveTopology({ main: { privateIp: '10.0.0.10' }, sites: [{ dc: 'DC-A', edge: { privateIp: '10.1.0.1' } }] })), '이전값(비밀) 없이 저장하면 비밀이 보존본에만 남는다');
  untouched('relay-topology.json');
  restore(); pass();
  assert.equal(R.loadTopologyRaw().sites[0].edge.ssh.password, 'pw-a');
  assert.equal(R.relayTopologyReadError(), null);
  R._resetForTest();
});

test('F5 · F6 업그레이드 설정 · 패키지 설정: 읽기 오류면 원본(토큰) 유지 · 저장 409 · 업그레이드 설정은 마지막 값으로 돈다', async () => {
  fs.writeFileSync(F('upgrade.json'), JSON.stringify({ remoteBase: 'https://mirror.example.local/rel', token: 'tok-1', autoApply: true }));
  const U = await import('../src/upgrade/settings.js');
  U._resetUpgradeSettingsForTest();
  assert.equal(U.loadSettings().token, 'tok-1');
  let restore = asDir('upgrade.json');
  const eff = U.loadSettings();
  assert.equal(eff.remoteBase, 'https://mirror.example.local/rel', '읽기 오류 동안 env 기본값(다른 원격)으로 뒤집히지 않는다');
  assert.equal(eff.token, 'tok-1');
  assert.equal(U.upgradeSettingsWriteRefusal()?.status, 409);
  assert.ok(is409(() => U.saveSettings({ autoApply: false })));
  untouched('upgrade.json');
  restore(); pass();
  assert.equal(U.upgradeSettingsWriteRefusal(), null);
  assert.equal(U.loadSettings().token, 'tok-1');

  fs.writeFileSync(F('packages.json'), JSON.stringify({ baseUrl: 'https://pkg.example.local/', token: 'ptok' }));
  const P = await import('../src/upgrade/packageSettings.js');
  P._resetPackageSettingsForTest();
  restore = asDir('packages.json');
  assert.equal(P.getPackageToken(), '');
  assert.equal(P.packageSettingsWriteRefusal()?.status, 409);
  assert.ok(is409(() => P.savePackageSettings({ baseUrl: 'https://other.example.local/' })), '토큰 없는 파일로 덮지 않는다');
  untouched('packages.json');
  restore(); pass();
  assert.equal(P.getPackageToken(), 'ptok', '캐시하지 않았으니 다시 읽어 원래 토큰');
  P._resetPackageSettingsForTest();
});

test('F7 게스트 조사 예약(guest-scans.json): 읽기 오류면 원본(자격증명) 유지 · 저장 · 삭제 409 · 읽히면 원래 작업', async () => {
  fs.writeFileSync(F('guest-scans.json'), JSON.stringify([{ id: 'gscan_a', name: '조사 A', type: 'login-fails', vcenterId: 'vc-a', os: 'all', intervalMin: 60, days: 7, maxVms: 100, enabled: false, guestUser: 'u', guestPass: 'p' }]));
  const G = await import('../src/security/guestScanScheduler.js');
  G._resetGuestScansForTest();
  const restore = asDir('guest-scans.json');
  assert.deepEqual(G.listGuestScans(), []);
  assert.equal(G.guestScansReadError()?.code, 'EISDIR');
  assert.ok(is409(() => G.saveGuestScan({ name: '조사 B', vcenterId: 'vc-a', guestUser: 'u2', guestPass: 'p2' })));
  assert.ok(is409(() => G.removeGuestScan('gscan_a')));
  untouched('guest-scans.json');
  restore(); pass();
  assert.deepEqual(G.listGuestScans().map((x) => x.id), ['gscan_a']);
  G._resetGuestScansForTest();
});

test('F8 스토리지 증가량 보존 기간: 읽기 오류면 원본 유지(손상 아님) · 확정 불가 표지 · 저장 409 · 읽히면 그 값', async () => {
  fs.writeFileSync(F('storage-growth-settings.json'), JSON.stringify({ rawKeepDays: 300 }));
  const GS = await import('../src/storage/growthSettings.js');
  GS._resetForTest();
  assert.equal(GS.loadGrowthSettings().rawKeepDays, 300);
  GS._resetForTest();
  const restore = asDir('storage-growth-settings.json');
  assert.equal(GS.growthSettingsLoadError()?.readError, true, '읽기 오류 표지(정리는 상한으로 — 23 · 27회차 규약 그대로)');
  assert.throws(() => GS.saveGrowthSettings({ rawKeepDays: 30 }), (e) => e?.code === 'settings-unreadable' && /읽기 오류/.test(e.message));
  untouched('storage-growth-settings.json');
  restore(); pass();
  assert.equal(GS.growthSettingsLoadError(), null, '재시작 · 확정 없이 다시 읽혀 풀린다(예전에는 보존본만 남아 확정이 필요했다)');
  assert.equal(GS.loadGrowthSettings().rawKeepDays, 300);
  GS._resetForTest();
});

test('F9 VM 백업 잡(vm-clone.json): 읽기 오류면 원본 유지 · 표지(readError) · 관리자 저장도 409 · 읽히면 원래 잡', async () => {
  fs.writeFileSync(F('vm-clone.json'), JSON.stringify({ version: 1, jobs: [{ id: 'vc-1', vcenterId: 'vc-a', vmId: 'vm-1', vmName: 'app-01', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'manual' }, keep: 3, clones: [] }], ops: [] }));
  const V = await import('../src/vmclone/store.js');
  V._resetForTest();
  const restore = asDir('vm-clone.json');
  assert.deepEqual(V.listJobs(), []);
  assert.equal(V.jobsLoadError()?.readError, true);
  assert.ok(is409(() => V.saveJob({ vcenterId: 'vc-a', vmId: 'vm-2', vmName: 'app-02', dest: { type: 'datastore', datastoreName: 'ds1' } })), '관리자 저장이 한 건짜리 원장으로 덮지 않는다');
  untouched('vm-clone.json');
  restore(); pass();
  assert.deepEqual(V.listJobs().map((j) => j.id), ['vc-1']);
  assert.equal(V.jobsLoadError(), null);
  V._resetForTest();
});

test('F10 업그레이드 번들 보관 기록: 읽기 오류면 기록을 덮지 않고 그 회차의 기록 · 정리를 건너뛴다', async () => {
  const B = await import('../src/upgrade/fleetBundle.js');
  const dir = F('pkgs'); fs.mkdirSync(dir, { recursive: true });
  const src = F('bundle-src.tar.gz'); fs.writeFileSync(src, 'bundle-bytes');
  const ver = (v) => B.bundleNameFor(v);
  fs.writeFileSync(F('upgrade-kept-bundles.json'), JSON.stringify({ kept: [{ name: ver('3.1.0'), version: '3.1.0', at: 1 }] }));
  const restore = asDir('upgrade-kept-bundles.json');
  const r = B.keepBundle({ archivePath: src, version: '3.2.0', manifestText: '', dir, keep: 1 });
  assert.equal(r.ok, true, '번들 복사는 한다(엣지 업그레이드는 계속)');
  assert.equal(r.keptUnreadable, true);
  untouched('upgrade-kept-bundles.json');
  restore();
  assert.deepEqual(B.keptBundles().map((x) => x.version), ['3.1.0'], '원래 기록 그대로 — 다음 보관 때 3.1.0 이 정리 대상으로 남는다');
});

test('F11 IP 관리 정기 보고 설정: 읽기 오류면 원본 유지 · null(보내지 않음) · 표지 readError · 저장 거절', async () => {
  const REP = await import('../src/ipam/report.js');
  fs.writeFileSync(F('ipam-report.json'), JSON.stringify({ enabled: true, to: ['ops@example.local'] }));
  REP._resetIpamReportForTest();
  const restore = asDir('ipam-report.json');
  assert.equal(REP.loadReportSettings(), null, '읽기 오류 중에는 기본값(꺼짐)으로 단정하지 않는다');
  assert.equal(REP.reportSettingsError()?.readError, true);
  const r = REP.saveReportSettings({ enabled: false });
  assert.equal(r.readError, true);
  untouched('ipam-report.json');
  // 예전에는 두 번째 호출이 ENOENT(원본이 옮겨짐) → 기본값으로 표지가 사라졌다 — 간격 안에서도 같은 표지.
  assert.equal(REP.reportSettingsError()?.readError, true);
  restore(); pass();
  assert.equal(REP.reportSettingsError(), null);
  assert.equal(REP.loadReportSettings()?.enabled, true);
  REP._resetIpamReportForTest();
});

test('F12 알림 설정(alerts.json): 읽기 오류면 원본(웹훅) 유지 · 기본값을 캐시하지 않는다 · 저장 409', async () => {
  const AL = await import('../src/alerts.js');
  const file = 'alerts.json';
  fs.writeFileSync(F(file), JSON.stringify({ channels: { webhook: { enabled: true, url: 'https://hook.example.local/x' } }, rules: {} }));
  AL._resetAlertConfigForTest();
  const restore = asDir(file);
  assert.equal(AL.loadAlertConfig().channels.webhook.enabled, false, '읽기 오류 중에는 기본값으로 돈다(캐시하지 않는다)');
  assert.equal(AL.alertConfigWriteRefusal()?.status, 409);
  assert.ok(is409(() => AL.saveAlertConfig({ channels: {} })));
  untouched(file);
  restore(); pass();
  assert.equal(AL.alertConfigWriteRefusal(), null);
  assert.equal(AL.loadAlertConfig().channels.webhook.url, 'https://hook.example.local/x', '재시작 없이 원래 채널로');
  AL._resetAlertConfigForTest();
});

test('F13 알람 음소거(alarm-mutes.json): 읽기 오류면 원본 유지 · 마지막 규칙을 계속 적용 · 추가 · 삭제 409', async () => {
  const M = await import('../src/alarm-mutes.js');
  M._resetMutesForTest();
  assert.equal(M.addMute({ entityType: 'Datastore', message: 'Datastore usage at 97%' }).ok, true);
  assert.equal(M.loadMutes().length, 1);
  const restore = asDir('alarm-mutes.json');
  assert.equal(M.loadMutes().length, 1, '읽기 오류 동안 뮤트가 풀리지 않는다(마지막으로 읽은 규칙)');
  assert.equal(M.isMuted({ entityType: 'Datastore', message: 'Datastore usage at 88%' }), true);
  const r = M.addMute({ entityType: 'Host', message: 'Host down' });
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.equal(M.removeMute(M.loadMutes()[0].id).status, 409);
  untouched('alarm-mutes.json');
  restore(); pass();
  assert.equal(M.mutesReadError(), null);
  assert.equal(M.loadMutes().length, 1);
  M._resetMutesForTest();
});

test('스윕: 103회차에 고친 파일의 catch 가 읽기 오류를 다시 손상 보존으로 보내지 않는다(읽기 · parse 한 try 금지)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const FIXED = ['svcmon/store.js', 'central/svcmonAssign.js', 'svcmon/templates.js', 'relaytopo/store.js', 'upgrade/settings.js', 'upgrade/packageSettings.js',
    'security/guestScanScheduler.js', 'storage/growthSettings.js', 'vmclone/store.js', 'upgrade/fleetBundle.js', 'ipam/report.js', 'alerts.js', 'alarm-mutes.js', 'central/agentGpuGuestConfig.js', 'ping/store.js', 'rma/schedules.js', 'vmclone/corpMounts.js', 'backup/settings.js', 'cvp/settings.js', 'vmseries/settings.js'];
  const bad = [];
  for (const rel of FIXED) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.match(s, /makeJsonFileReader\(|readJsonFile\(/, `${rel}: 공용 읽기 표지`);
    for (const m of s.matchAll(/\bpreserveCorrupt\(|\bbackupCorrupt\(e\)/g)) {
      const c = s.lastIndexOf('catch', m.index);
      const t = c >= 0 ? s.lastIndexOf('try', c) : -1;
      if (t >= 0 && /\bfs\.readFileSync\(/.test(s.slice(t, c))) bad.push(`${rel}:${s.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], '읽기(readFileSync)와 parse 를 한 try 에 두고 그 catch 에서 손상 보존을 부르면 읽기 오류도 원본을 옮긴다');
});

test('라우트: 읽기 오류 거절(409)과 사유가 화면까지 — 전역 오류 처리기(사유 없음)로 떨어지지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const rd = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  assert.match(rd('routes/upgrade.js'), /const unreadable = upgradeSettingsWriteRefusal\(\);\s*if \(unreadable\) return res\.status\(409\)/);
  assert.match(rd('routes/admin/deployLlm.js'), /const unreadable = packageSettingsWriteRefusal\(\);\s*if \(unreadable\) return res\.status\(409\)/);
  assert.match(rd('routes/admin/opsSettings.js'), /const unreadable = alertConfigWriteRefusal\(\);\s*if \(unreadable\) return res\.status\(409\)/);
  assert.match(rd('routes/svcmon/edge.js'), /const unreadable = svcmonStoreWriteRefusal\(\);\s*if \(unreadable\) return res\.status\(409\)[\s\S]{0,400}listTargetsCopy\(\)\.filter/, '엣지 배정 PUT 은 빈 목록을 굳히기 전에 거절');
  for (const rel of ['routes/svcmon/transfer.js', 'routes/svcmon/generate.js']) assert.match(rd(rel), /const unreadable = svcmonStoreWriteRefusal\(\); if \(unreadable\) return res\.status\(409\)[\s\S]{0,200}bulkAddTargets\(/, rel);
  for (const rel of ['routes/svcmon/tree.js', 'routes/svcmon/templates.js', 'routes/api/relaytopo.js']) assert.doesNotMatch(rd(rel), /catch \(e\) \{ res\.status\(400\)\.json\(\{ (ok: false, reason|error): e\.message \}\)/, `${rel}: 409 를 400 으로 바꾸지 않는다`);
});

test('F14 GPU 게스트 수집 배포(central-agent-gpu-guest.json): 읽기 오류면 원본(엣지별 비밀) 유지 · 표지(readError) · 관리자 저장 409 · 읽히면 재시작 없이 원래 값', async () => {
  fs.writeFileSync(F('central-agent-gpu-guest.json'), JSON.stringify({ 'edge-a': { enabled: true, _updatedAt: 1 } }));
  const G = await import('../src/central/agentGpuGuestConfig.js');
  G._reloadGpuGuestConfigForTest();
  assert.deepEqual(G.listAssignedGpuGuestAgents().map((x) => x.agent), ['edge-a']);
  const restore = asDir('central-agent-gpu-guest.json');
  G._reloadGpuGuestConfigForTest();
  assert.equal(G.gpuGuestConfigLoadError()?.readError, true, '설정 pull 은 503(엣지는 로컬 값 유지) — 손상이 아니다');
  assert.ok(is409(() => G.setAssignedGpuGuest('edge-b', { enabled: true })), '관리자 저장이 한 건짜리 파일로 덮지 않는다');
  assert.equal(G.getAssignedGpuGuest('edge-b'), null, '거절 전에 메모리도 바꾸지 않는다');
  untouched('central-agent-gpu-guest.json');
  restore(); pass();
  assert.deepEqual(G.listAssignedGpuGuestAgents().map((x) => x.agent), ['edge-a'], '간격이 지나면 다시 읽는다(재시작 없이)');
  assert.equal(G.gpuGuestConfigLoadError(), null);
});

test('F15 Ping 대상(ping-targets.json): 읽기 오류면 원본(수동 대상 · tombstone) 유지 · 자동 시드 · 추가가 덮지 않는다', async () => {
  const P = await import('../src/ping/store.js');
  P.resetTargets();
  fs.writeFileSync(F('ping-targets.json'), JSON.stringify({ targets: [{ id: 'm1', name: 'db-gw', host: '10.0.0.5', port: 443, kind: 'tcp', source: 'manual' }], seededVc: ['vc-a'], seededEdge: [], vcPorts: [] }));
  assert.equal(P.listTargets().length, 1);
  const restore = asDir('ping-targets.json');
  assert.deepEqual(P.listTargets(), []);
  assert.equal(P.pingTargetsReadError()?.code, 'EISDIR');
  assert.equal(P.seedVcenterTargets([{ id: 'vc-b', host: 'vc-b.example.local', name: 'vc-b' }]).ok, false, '기동 시 자동 시드가 빈 목록 위에 쓰지 않는다');
  const r = P.addTarget({ name: 'web', host: '10.0.0.6', port: 443, kind: 'tcp' });
  assert.equal(r.ok, false); assert.match(r.reason, /읽기 오류/);
  untouched('ping-targets.json');
  restore(); pass();
  assert.equal(P.pingTargetsReadError(), null);
  assert.ok(P.getTarget('m1'), '원래 수동 대상');
});

test('F16 · F17 RMA 점검 스케줄 · VM 백업 법인 마운트 지정: 읽기 오류면 원본 유지 · 표지(readError) · 저장 409 · 읽히면 원래 값', async () => {
  fs.writeFileSync(F('rma-schedules.json'), JSON.stringify({ version: 1, agents: { 'edge-a': { version: 3, tests: [{ id: 't_a', test: 'rma-itself', args: {}, intervalSec: 60 }] } } }));
  const RS = await import('../src/rma/schedules.js');
  RS._resetSchedules();
  let restore = asDir('rma-schedules.json');
  assert.equal(RS.rmaSchedulesLoadError()?.readError, true, 'rma-poll 은 503(엣지는 직전 스케줄 유지) — 손상이 아니다');
  assert.ok(is409(() => RS.upsertScheduleItem('edge-b', { test: 'rma-itself', intervalSec: 60 })), '한 법인만 든 파일로 덮지 않는다');
  untouched('rma-schedules.json');
  restore(); pass();
  assert.equal(RS.rmaSchedulesLoadError(), null);
  assert.equal(RS.scheduleFor('edge-a').version, 3);
  RS._resetSchedules();

  fs.writeFileSync(F('vm-clone-corp.json'), JSON.stringify({ version: 1, corps: { central: { mountIds: ['m1'], at: 1, by: 'adm' } } }));
  const CM = await import('../src/vmclone/corpMounts.js');
  CM._resetCorpMountsForTest();
  restore = asDir('vm-clone-corp.json');
  assert.equal(CM.corpMountsLoadError()?.readError, true);
  assert.equal(CM.mountUseOf('central'), null);
  assert.ok(is409(() => CM.setMountUse('edge:e1', ['m2'], 'adm')), '다른 법인 지정이 사라져 전부 허용으로 넓어지지 않게');
  untouched('vm-clone-corp.json');
  restore(); pass();
  assert.equal(CM.corpMountsLoadError(), null);
  assert.deepEqual([...CM.mountUseOf('central')], ['m1']);
  CM._resetCorpMountsForTest();
});

test('F18 정기 백업 설정: 읽기 오류면 원본 유지 · 보관 개수는 상한으로(기본 30개로 백업을 지우지 않는다) · 저장 409', async () => {
  const BS = await import('../src/backup/settings.js');
  const name = 'backup.json';
  fs.writeFileSync(F(name), JSON.stringify({ scheduleEnabled: false, retention: 200 }));
  BS._resetBackupSettingsForTest();
  assert.equal(BS.loadBackupSettings().retention, 200);
  BS._resetBackupSettingsForTest();
  const restore = asDir(name);
  const s = BS.loadBackupSettings();
  assert.equal(s.retention, BS.RETENTION_MAX, '보관 개수를 모르는 동안 정리는 상한으로(83 R1)');
  assert.equal(s.loadError?.readError, true);
  assert.ok(is409(() => BS.saveBackupSettings({ retention: 10 })));
  untouched(name);
  restore(); pass();
  assert.equal(BS.loadBackupSettings().retention, 200);
  assert.equal(BS.backupSettingsReadError(), null);
  BS._resetBackupSettingsForTest();
});

test('F19 IP 스캔 설정(엣지 배정): 읽기 오류면 원본 유지 · 표지(readError) · 빈 설정을 캐시하지 않는다 · 저장 409', async () => {
  const SS = await import('../src/ipam/scanStore.js');
  const name = 'ipam-scan.json';
  fs.writeFileSync(F(name), JSON.stringify({ agents: { 'edge-a': { enabled: true, ranges: ['10.1.0.0/24'] } } }));
  assert.deepEqual(SS.loadScanSettings('edge-a').ranges, ['10.1.0.0/24']);
  const restore = asDir(name);
  assert.equal(SS.scanSettingsLoadError()?.readError, true, '배정 pull 은 503(엣지 스캔 유지) — 손상이 아니다');
  assert.deepEqual(SS.loadScanSettings('edge-a').ranges, []);
  assert.ok(is409(() => SS.saveScanSettings('edge-b', { ranges: ['10.2.0.0/24'] })), '에이전트 하나만 든 파일로 덮지 않는다');
  untouched(name);
  restore(); pass();
  assert.equal(SS.scanSettingsLoadError(), null);
  assert.deepEqual(SS.loadScanSettings('edge-a').ranges, ['10.1.0.0/24']);
});

test('F20 CloudVision 수집 설정: 읽기 오류면 원본 유지(손상 아님 — 재시작 · 확정 없이 풀림) · 표지 readError · 캐시 안 함', async () => {
  fs.writeFileSync(F('cvp-settings.json'), JSON.stringify({ version: 1, rawRetentionDays: 20 }));
  const C = await import('../src/cvp/settings.js');
  C._resetForTest();
  const want = C.loadSettings().rawRetentionDays;
  C._resetForTest();
  const restore = asDir('cvp-settings.json');
  assert.equal(C.cvpSettingsLoadError()?.readError, true, '배포 503 · 저장 409 · 정리 보류는 표지로 그대로');
  untouched('cvp-settings.json');
  restore(); pass();
  assert.equal(C.cvpSettingsLoadError(), null, '예전에는 원본이 보존본으로 옮겨져 확정 · 수동 복구로만 풀렸다');
  assert.equal(C.loadSettings().rawRetentionDays, want);
  C._resetForTest();
});

test('F21 실시간 스파이크 수집 설정: 읽기 오류면 원본 유지 · 마지막 값으로 돈다 · 저장 409 · 정리는 상한 보존일로', async () => {
  const VS = await import('../src/vmseries/settings.js');
  const name = path.basename(VS.vmSeriesSettingsFile());
  fs.writeFileSync(F(name), JSON.stringify({ enabled: true, retentionDays: 900 }));
  VS._resetVmSeriesSettingsForTest();
  assert.equal(VS.loadVmSeriesSettings().retentionDays, 900);
  const restore = asDir(name);
  const eff = VS.loadVmSeriesSettings();
  assert.equal(eff.enabled, true, '읽기 오류 동안 env 기본값(꺼짐)으로 뒤집히지 않는다');
  assert.equal(eff.retentionDays, 900);
  assert.equal(VS.vmSeriesSettingsLoadError()?.readError, true);
  assert.ok(is409(() => VS.saveVmSeriesSettings({ intervalMin: 30 })));
  untouched(name);
  restore(); pass();
  assert.equal(VS.vmSeriesSettingsLoadError(), null);
  VS._resetVmSeriesSettingsForTest();
  const { stripComments } = await import('./_stripComments.js');
  const { fileURLToPath } = await import('node:url');
  const src = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vmseries', 'poller.js'), 'utf8'));
  assert.match(src, /const days = vmSeriesSettingsLoadError\(\) \? VMSERIES_LIMITS\.maxRetentionDays : loadVmSeriesSettings\(\)\.retentionDays/, '로드 오류 중 정리는 상한 보존일(기본 60일로 지우지 않는다)');
});

test('F12 후속 · F19 후속: 알림 상태 파일 읽기 오류는 보존본으로 옮기지 않는다 · 스캔 설정은 mtime 이 같은 읽기 오류(EIO)도 캐시에 굳지 않는다', async () => {
  const AL = await import('../src/alerts.js');
  fs.writeFileSync(F('alerts-state.json'), JSON.stringify({ firing: { k1: { since: NOW - 60_000, lastNotified: NOW - 60_000 } } }));
  AL._resetAlertStateForTest();
  const restore = asDir('alerts-state.json');
  assert.equal(AL._loadAlertStateForTest(), 0);
  untouched('alerts-state.json');
  restore();
  AL._resetAlertStateForTest();
  assert.equal(AL._loadAlertStateForTest(), 1, '원본이 그대로라 다시 읽으면 이어받는다');
  AL._resetAlertStateForTest();

  // 스캔 설정: chmod 처럼 mtime 이 그대로인 읽기 오류 — 예전 모양이면 빈 설정이 (mtime,size) 캐시에 굳어 간격이 지나도 풀리지 않는다.
  const SS = await import('../src/ipam/scanStore.js');
  const name = 'ipam-scan.json';
  fs.writeFileSync(F(name), JSON.stringify({ agents: { 'edge-c': { enabled: true, ranges: ['10.3.0.0/24'] } } }));
  pass();
  assert.deepEqual(SS.loadScanSettings('edge-c').ranges, ['10.3.0.0/24']);
  const st = fs.statSync(F(name));
  fs.utimesSync(F(name), st.atime, new Date(st.mtime.getTime() + 7_000));   // 캐시를 비켜 다시 읽게(그 뒤 mtime 은 그대로)
  const orig = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
  try { assert.equal(SS.scanSettingsLoadError()?.readError, true); } finally { fs.readFileSync = orig; }
  assert.deepEqual(corruptOf(name), []);
  pass();
  assert.equal(SS.scanSettingsLoadError(), null, '같은 mtime 이어도 간격이 지나면 다시 읽어 풀린다');
  assert.deepEqual(SS.loadScanSettings('edge-c').ranges, ['10.3.0.0/24']);
});
