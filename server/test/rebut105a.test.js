/**
 * rebut105a.test.js — 전체 점검 105회차(최종 반증 A): 102 · 103회차 반증 + 103 이 남긴 추정 · 제안.
 *
 *  A1 backup/settings: 기동 때 읽기 오류면 정기 백업 일정이 다시 읽혀도 걸리지 않았다 → 읽기 오류 동안 재판정 타이머
 *  A2 ipam/vcRangeMigrate: 이전 기록 읽기 오류를 '아직 안 함' 으로 봐 기록을 덮었다 → 이번 이전 · 수동 옮김 · 지움 건너뜀
 *  A3 security/guestScanScheduler: (103 추정 반증) 복호 실패는 옮기지 않는다 — 실제 결함은 키 불일치 뒤 저장 · 실행 기록이 전 작업의 암호문을 '' 로 덮음
 *  A4 ipam/report: 손상 보존 뒤 다음 호출이 기본값(꺼짐) · 표지 사라짐 → corruptKept 표지 유지(저장은 허용)
 *  A5 엣지 배포 설정 4개(bmusage/tuning/overrides · linkcheck/settings · sanswitch/perfSettings · storage/intervals): 읽기 오류 ≠ 손상 · 쓰기 409
 *  A6 svcmon 설정 연동: 감시 대상 읽기 오류 동안 감지 건너뜀 · 적용 · 정리 · 해제 라우트 사전 검사(사유 없는 500 이던 것)
 *  A7 vmclone/corpMounts 거부 사유 · rma 스케줄 삭제 409
 *  A8 웹: 409 본문을 성공으로 읽던 저장(백업 설정 · 통신 점검 설정 · 감시 대상 추가 · 설정 연동 해제 · 적용)
 *
 * 읽기 오류는 root 컨테이너라 EACCES 대신 EISDIR(파일 자리에 폴더)로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut105a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SECRETS_KEY = 'B'.repeat(40);   // A3: 이 프로세스는 '바뀐 키' 로 연다(봉인은 자식 프로세스가 키 A 로)
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const { stripComments } = await import('./_stripComments.js');

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

function asDir(name) {
  const keep = F(`${name}.keep105`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
function untouched(name) {
  assert.ok(fs.statSync(F(name)).isDirectory(), `${name}: 원본 자리를 옮기거나 덮으면 안 된다(읽기 오류는 손상이 아니다)`);
  assert.deepEqual(corruptOf(name), [], `${name}: 읽기 오류에 보존본을 만들면 안 된다`);
}
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('A1 정기 백업: 기동 때 읽기 오류면 재판정 타이머를 걸고, 다시 읽히면 그 설정(정기 백업 켜짐)으로 일정을 건다', async () => {
  fs.writeFileSync(F('backup.json'), JSON.stringify({ scheduleEnabled: true, every: 1, unit: 'day', autoOnChange: false, retention: 40 }));
  const BS = await import('../src/backup/settings.js');
  BS._resetBackupSettingsForTest();
  const restore = asDir('backup.json');
  try {
    const a = BS._rescheduleForTest();
    assert.equal(a.scheduleActive, false, '못 읽은 동안은 기본값(꺼짐)으로 판정한다');
    assert.equal(a.retryPending, true, '읽기 오류 동안 재판정 타이머가 있어야 한다(없으면 저장 · 재시작 전까지 정기 백업이 멈춘다)');
    untouched('backup.json');
    restore();
    pass();
    const b = BS._rescheduleForTest();
    assert.equal(b.scheduleActive, true, '다시 읽히면 파일의 정기 백업 설정으로 일정을 건다');
    assert.equal(b.retryPending, false);
    assert.equal(BS.loadBackupSettings().retention, 40);
  } finally { BS._stopBackupScheduleForTest(); }
});

test('A2 vCenter 별 대역 이전: 이전 기록 읽기 오류면 이번 이전 · 수동 옮김 · 지움을 건너뛰고 기록을 덮지 않는다', async () => {
  const name = 'ipam-vcrange-migration.json';
  const rec = { version: 1, done: true, at: 1, backup: null, dismissedAt: null, items: [{ vcenterId: 'vc-1', vcenterName: 'vc-1', ranges: ['10.1.0.0/24'], reason: 'moved', result: 'moved', target: 'edge-a' }] };
  fs.writeFileSync(F(name), JSON.stringify(rec));
  const M = await import('../src/ipam/vcRangeMigrate.js');
  const restore = asDir(name);
  let r;
  assert.doesNotThrow(() => { r = M.runVcRangeMigration(); });
  assert.equal(r.ran, false, '읽기 오류를 아직 안 함으로 보고 다시 돌면 안 된다');
  assert.match(String(r.reason), /읽기 오류/);
  assert.equal(M.migrationStateReadError()?.code, 'EISDIR');
  const mv = M.moveVcRangeManually('vc-1', 'edge-a');
  assert.equal(mv.ok, false); assert.equal(mv.status, 409); assert.equal(mv.readError, true);
  const rm = M.removeVcRangeManually('vc-1');
  assert.equal(rm.status, 409);
  untouched(name);
  restore();
  assert.deepEqual(M.migratedRangesFor('vc-1'), ['10.1.0.0/24'], '다시 읽히면 옮긴 기록이 그대로');
  assert.equal(M.migrationStateReadError(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(F(name), 'utf8')), rec);
});

test('A3 게스트 조사 작업: 복호 실패는 손상으로 옮기지 않는다(103 추정 반증) · 키가 바뀐 뒤 저장 · 실행 기록이 암호문을 지우지 않는다', async () => {
  // 키 A 로 봉인(별도 프로세스 — 이 프로세스의 금고는 키 B 로 굳는다).
  const seal = `
    const V = await import(${JSON.stringify(path.join(SRC, 'security/secretVault.js'))});
    const fs = await import('node:fs'); const path = await import('node:path');
    V.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const job = (id, pw) => ({ id, name: id, type: 'login-fails', vcenterId: 'vc-none', os: 'all', intervalMin: 60, days: 7, maxVms: 10, enabled: false, guestUser: 'u-' + id, guestPass: pw });
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'guest-scans.json'), JSON.stringify(V.sealSecretsDeep([job('gscan_a', 'pw-a'), job('gscan_b', 'pw-b')])));`;
  execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', seal], { env: { ...process.env, CONFIG_DIR: TMP, DATA_DIR: TMP, SECRETS_KEY: 'A'.repeat(40) }, stdio: 'pipe' });
  const sealedOf = () => JSON.parse(fs.readFileSync(F('guest-scans.json'), 'utf8')).map((x) => String(x.guestPass || ''));
  const before = sealedOf();
  assert.ok(before.every((v) => v.startsWith('enc$1$')), '자식 프로세스가 봉인해 두었다');
  const G = await import('../src/security/guestScanScheduler.js');
  G._resetGuestScansForTest();
  assert.deepEqual(G.listGuestScans().map((x) => x.id).sort(), ['gscan_a', 'gscan_b'], '복호 실패여도 목록은 그대로(손상으로 옮기지 않는다)');
  assert.deepEqual(corruptOf('guest-scans.json'), []);
  assert.equal(G.guestScansUndecryptable(), 2);
  const e = thrown(() => G.saveGuestScan({ id: 'gscan_b', name: 'B2', type: 'login-fails', vcenterId: 'vc-none', os: 'all', intervalMin: 60, days: 7, maxVms: 10, enabled: false, guestUser: 'u-gscan_b' }));
  assert.equal(e?.status, 409, '복호 실패가 있는 동안 저장은 409(저장하면 전 작업의 암호문이 지워진다)');
  assert.equal(e?.code, 'secrets-undecryptable');
  assert.equal(thrown(() => G.removeGuestScan('gscan_a'))?.status, 409);
  const run = await G.runGuestScanNow('gscan_a');   // vCenter 없음 → 실행 기록만 persist 하는 길
  assert.equal(run.ok, true);
  assert.deepEqual(sealedOf(), before, '자동 실행 기록(persist)이 암호문을 지우면 안 된다');
  // 키 분실을 확정한 설치는 예전처럼 저장된다(옛 암호문은 저장 때 지워진다 — 금고 규약).
  process.env.SECRETS_KEY_LOST = 'true';
  try { assert.equal(thrown(() => G.removeGuestScan('gscan_a')), null); } finally { delete process.env.SECRETS_KEY_LOST; }
});

test('A4 IP 정기 보고 설정: 손상 보존 뒤(재시작 포함) 기본값(꺼짐)이어도 표지(corruptKept)를 유지하고 저장은 허용 · 새로 손상된 파일도 보존한다', async () => {
  const R = await import('../src/ipam/report.js');
  R._resetIpamReportForTest();
  fs.writeFileSync(F('ipam-report.json'), '{ broken');
  assert.equal(R.loadReportSettings(), null, '손상 — 보내지 않는다');
  assert.equal(corruptOf('ipam-report.json').length, 1);
  const r2 = R.loadReportSettings();
  assert.equal(r2?.enabled, false);
  const err = R.reportSettingsError();
  assert.equal(err?.corruptKept, true, '보존본만 남은 동안 표지가 사라지면 화면은 꺼져 있음으로만 보인다');
  assert.match(err.reason, /손상 보존본/);
  R._resetIpamReportForTest();   // 재시작
  assert.equal(R.reportSettingsError()?.corruptKept, true, '재시작 뒤에도 같은 표지');
  // 표지가 선 뒤 새로 손상된 파일도 보존한다(try 가 표지를 먼저 비운다 — 회귀 고정).
  fs.writeFileSync(F('ipam-report.json'), '{ broken again');
  assert.equal(R.loadReportSettings(), null);
  assert.equal(corruptOf('ipam-report.json').length, 2, '새 손상본도 옮긴다');
  R.loadReportSettings();
  const saved = R.saveReportSettings({ enabled: false, freq: 'weekly', days: [1], time: '09:00', to: [] });
  assert.ok(!saved.error, `손상 보존본만 있는 동안 저장은 허용(그래야 풀린다): ${saved.error}`);
  assert.equal(R.reportSettingsError(), null, '저장하면 풀린다');
});

test('A5 엣지 배포 설정 4개: 읽기 오류면 원본 유지 · 표지 readError(확정 불가) · 쓰기 거절 · 읽히면 원래 값', async () => {
  // bmusage/tuning/overrides
  fs.writeFileSync(F('bmusage-tuning.json'), JSON.stringify({ v: 1, all: {}, corps: {}, by: 'admin', at: 1 }));
  const O = await import('../src/bmusage/tuning/overrides.js');
  O._resetTuningOverridesForTest();
  let restore = asDir('bmusage-tuning.json');
  assert.equal(O.tuningOverridesLoadError()?.readError, true);
  const so = O.saveTuningOverride({ scope: 'all', role: 'general', itemId: 'x', value: '1' });
  assert.equal(so.ok, false); assert.equal(so.unreadable, true); assert.equal(so.readError, true);
  assert.ok(O.overridesFor({ role: 'general' }).error, '못 읽은 동안 판정은 거부(기본값으로 판정하지 않는다)');
  untouched('bmusage-tuning.json');
  restore(); pass();
  assert.equal(O.tuningOverridesLoadError(), null, '다시 읽히면 재시작 · 확정 없이 풀린다');
  assert.equal(O.loadTuningOverrides().by, 'admin');

  // linkcheck/settings
  fs.writeFileSync(F('linkcheck-settings.json'), JSON.stringify({ enabled: true, intervalMs: 3_600_000 }));
  const L = await import('../src/linkcheck/settings.js');
  restore = asDir('linkcheck-settings.json');
  assert.equal(L.linkCheckSettingsLoadError()?.readError, true);
  assert.equal(L.linkCheckSettingsWriteRefusal()?.status, 409);
  assert.equal(thrown(() => L.saveLinkCheckSettings({ enabled: false }))?.status, 409, '읽기 오류 중 저장은 원본을 보존본도 없이 덮는다 — 409');
  untouched('linkcheck-settings.json');
  restore(); pass();
  assert.equal(L.linkCheckSettingsLoadError(), null);
  assert.equal(L.loadLinkCheckSettings().intervalMs, 3_600_000);

  // sanswitch/perfSettings
  fs.writeFileSync(F('sanswitch-perf-settings.json'), JSON.stringify({ version: 1, enabled: true, retentionDays: 365 }));
  const P = await import('../src/sanswitch/perfSettings.js');
  P._resetForTest();
  restore = asDir('sanswitch-perf-settings.json');
  assert.equal(P.loadPerfSettings().enabled, false, '못 읽은 동안은 기본값(캐시하지 않는다)');
  const le = P.perfSettingsLoadError();
  assert.equal(le?.readError, true, '정리 상한 · 배포 보류 · 저장 409 는 이 표지로 그대로 걸린다');
  untouched('sanswitch-perf-settings.json');
  restore(); pass();
  assert.equal(P.perfSettingsLoadError(), null);
  assert.equal(P.loadPerfSettings().retentionDays, 365);

  // storage/intervals
  fs.writeFileSync(F('storage-intervals.json'), JSON.stringify({ version: 1, global: {}, agents: {} }));
  const I = await import('../src/storage/intervals.js');
  I._resetForTest();
  restore = asDir('storage-intervals.json');
  assert.equal(I.storageIntervalsLoadError()?.readError, true);
  assert.equal(thrown(() => I.saveIntervalConfig({ global: {}, agents: {} }))?.status, 409);
  untouched('storage-intervals.json');
  restore(); pass();
  assert.equal(I.storageIntervalsLoadError(), null);

  // 확정('기본값으로 확정')은 읽기 오류에 열리지 않는다 — 서비스 점검 목록의 confirmable.
  const SL = await import('../src/util/settingsLoadError.js');
  restore = asDir('linkcheck-settings.json');
  pass();
  L.loadLinkCheckSettings();
  const row = SL.listSettingsLoadErrors().find((x) => x.file === 'linkcheck-settings.json');
  assert.equal(row?.readError, true); assert.equal(row?.confirmable, false);
  restore(); pass(); L.loadLinkCheckSettings();
});

test('A5 라우트: 네 설정의 저장 라우트가 읽기 오류를 409 · 사유로 답한다(전역 오류 처리기 · 손상 문구로 가지 않는다)', () => {
  const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  const lc = src('routes/api/linkCheck.js');
  assert.match(lc.slice(lc.indexOf("api.put('/tools/link-check/settings'"), lc.indexOf('saveLinkCheckSettings(req.body')), /linkCheckSettingsWriteRefusal\(\)/);
  const sm = src('routes/api/storageMon.js');
  assert.match(sm.slice(sm.indexOf("api.put('/tools/storage/intervals'"), sm.indexOf('saveIntervalConfig({ global: req.body')), /storageIntervalsWriteRefusal\(\)/);
  const ss = src('routes/api/sanSwitch.js');
  assert.equal((ss.match(/res\.status\(409\)\.json\(perfUnreadable\(perfSettingsLoadError\(\)\)\)/g) || []).length, 2, '저장 · 즉시 정리 두 라우트가 읽기 오류에 손상 문구(확정 · 재시작)를 싣지 않는다');
  assert.ok(!/res\.status\(409\)\.json\(\{ ok: false, code: 'settings-unreadable', reason: PERF_UNREADABLE \}\)/.test(ss));
  const bu = src('routes/api/bmUsage.js');
  assert.match(bu, /r\.readError \? 409/);
});

test('A6 svcmon 설정 연동: 감시 대상 읽기 오류 동안 감지를 건너뛰고(거짓 새 항목 · 일별 요약) 적용 · 정리 · 해제는 사유 있는 409', async () => {
  fs.writeFileSync(F('svcmon.json'), JSON.stringify({ targets: [], folders: [] }));
  const S = await import('../src/svcmon/store.js');
  const SY = await import('../src/svcmon/settingsSync.js');
  S._resetCache();
  const restore = asDir('svcmon.json');
  let built = 0;
  const r = await SY.detectOnce({ build: async () => { built += 1; return { targets: [], problems: [], sourceErrors: [] }; } });
  assert.equal(r, null, '못 읽은 동안 감지하지 않는다');
  assert.equal(built, 0);
  restore(); pass(); S._resetCache();
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/svcmon/settingsSync.js'), 'utf8'));
  for (const route of ["'/settings-sync/apply'", "'/settings-sync/repath'", "'/settings-sync/detach/:id'"]) {
    const i = src.indexOf(route);
    assert.ok(i > 0, route);
    assert.match(src.slice(i, i + 400), /storeUnreadable\(res\)/, `${route}: 사전 검사`);
  }
});

test('A7 vmclone 마운트 지정 거부 사유 · rma 스케줄 삭제: 읽기 오류 동안 따를 수 없는 안내 · 사유 없는 ok:false 를 내지 않는다', async () => {
  fs.writeFileSync(F('vm-clone-corp.json'), JSON.stringify({ version: 1, corps: {} }));
  const C = await import('../src/vmclone/corpMounts.js');
  C._resetCorpMountsForTest();
  const restore = asDir('vm-clone-corp.json');
  const why = C.mountUseDenied({ type: 'nfs', mountId: 'm1' }, 'corp-a');
  assert.match(why, /읽기 오류/);
  assert.ok(!/다시 저장하세요/.test(why), '읽기 오류 동안 지정 저장은 409 — 저장하라는 안내는 따를 수 없다');
  restore(); pass();
  const rma = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/rma.js'), 'utf8'));
  const i = rma.indexOf("api.delete('/tools/rma/agents/:agent/schedule/:id'");
  assert.match(rma.slice(i, i + 500), /rmaSchedulesLoadError\(\)/);
});

test('A8 웹: 409 를 던지지 않는 putJson · postJson 의 본문을 성공으로 읽지 않는다(103 이 409 로 바꾼 저장 길)', () => {
  const w = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));
  assert.match(w('views/PortalBackup.jsx'), /requireChanged\(await putJson\('\/admin\/backup\/settings'/);
  assert.match(w('views/tools/LinkCheck.jsx'), /requireChanged\(await putJson\('\/tools\/link-check\/settings'/);
  const sv = w('views/SvcMonitor.jsx');
  assert.match(sv, /requireChanged\(await postJson\('\/svcmon\/targets', body\)\)/);
  assert.match(sv, /requireChanged\(await postJson\(`\/svcmon\/targets\/\$\{modal\.targetId\}\/tests`, body\)\)/);
  assert.match(sv, /requireChanged\(await postJson\(`\/svcmon\/settings-sync\/detach\//);
  const st = w('views/svcmon/SettingsSyncTab.jsx');
  const i = st.indexOf("postJson('/svcmon/settings-sync/apply', body())");
  assert.match(st.slice(i, i + 300), /r\?\.ok === false && !r\.result/);
  const ir = w('views/tools/IpamReport.jsx');
  assert.match(ir, /d\.settingsError\.corruptKept \? d\.settingsError\.reason/, '손상 보존본만 남은 상태는 사유 그대로');
  assert.match(ir, /d\.settingsError\.readError \? '' : ' 손상본은 옆에 보존했습니다\.'/, '읽기 오류에는 보존했다고 말하지 않는다');
  assert.match(ir, /disabled=\{!!busy \|\| \(!!d\.settingsError && !d\.settingsError\.corruptKept\)\} onClick=\{save\}/, '보존본만 남은 동안 저장은 열린다(그래야 풀린다)');
  assert.ok(!/— 보내지 않습니다\. 손상본은 옆에 보존했습니다\.<\/div>/.test(ir), '읽기 오류에도 손상본 보존이라 말하던 고정 문구');
});
