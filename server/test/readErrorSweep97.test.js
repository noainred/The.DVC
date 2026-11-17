/**
 * readErrorSweep97.test.js — 전체 점검 97회차: 공통 스윕 '읽기 오류 ≠ 손상'(남은 모듈).
 *
 * 배경: 56~96회차에서 가장 많이 반복된 결함 — 설정 · 등록부 · 원장 파일의 **읽기 오류**(EACCES · EIO · EISDIR · EMFILE)를 손상(parse 실패)과 같은
 *   catch 하나로 받아 온전한 원본을 `.corrupt.*` 로 옮기고 빈 값을 캐시했다 → 다음 저장이 한 건만 든 파일로 원본 자리를 채웠다.
 *   공용 판정(util/jsonFileRead.js · jsonFileLoad.js · registryCore.js read)으로 옮긴 모듈마다 같은 꼴을 고정한다:
 *     원본 유지(옮기지 않음 · 보존본 없음) · 캐시 안 함(30초 간격 재읽기 — 시계 주입) · 쓰기 거절(409) · 읽히면 원본 값으로 풀림 · 손상은 예전처럼 보존.
 *   읽기 오류는 root 컨테이너라 EACCES 대신 **EISDIR**(파일 자리에 폴더 — 실제 fs 오류)로, mtime 이 그대로인 경우는 fs.readFileSync 주입 **EIO** 로 재현한다.
 *
 *  F1 publicapi/keys(연동 키 해시)  F2 rma/agentSecrets(법인 비밀번호)  F3 collector/registry(수집 서버 · 토큰)  F4 bareos 8종(원장 · 설정 · 그룹 · 정책 …)
 *  F5 issues 설정 3종 · usage 설정  F6 issues/store(전 이슈)  F7 wiki/store(전 문서)  F8 issues filters · sprints · templates · wiki templates
 *  F9 security/loginStore  F10 security/loginHistory  F11 ipam/rangeStore(mtime 캐시)  F12 ipam/subnetNotes  F13 bmusage 정비 창(재읽기 간격)
 *  스윕: preserveCorrupt 를 직접 부르는 파일 목록 고정(허용 목록 + 사유) — 새 파일이 공용 판정 없이 손상 보존을 부르면 실패.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'readErr97-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs 를 쓰는 모듈 전부).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep97`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
/** 읽기 오류 뒤 공통 확인 — 원본 자리(폴더)는 그대로 · 보존본 없음. */
function untouched(name) {
  assert.ok(fs.statSync(F(name)).isDirectory(), `${name}: 원본 자리를 옮기면 안 된다(읽기 오류는 손상이 아니다)`);
  assert.deepEqual(corruptOf(name), [], `${name}: 읽기 오류에 보존본을 만들면 안 된다`);
}
/** fs.readFileSync 에 EIO 를 주입한다(그 파일 이름만) — 읽은 횟수를 돌려준다. */
function withEio(name, fn) {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { reads += 1; const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
  try { fn(); } finally { fs.readFileSync = orig; }
  return reads;
}
const is409 = (fn) => { try { fn(); } catch (e) { return e?.status === 409; } return false; };

test('F1 연동 키(api-keys.json): 읽기 오류면 원본 유지 · 캐시 안 함 · 발급 · 폐기 409 · 읽히면 원래 키로', async () => {
  const K = await import('../src/publicapi/keys.js');
  K._resetApiKeyCache();
  const first = K.issueApiKey({ name: 'portal-b', groups: ['inventory'] }, 'adm');
  assert.ok(first.key, JSON.stringify(first.issues));
  K._resetApiKeyCache();
  const restore = asDir('api-keys.json');
  assert.deepEqual(K.listApiKeys(), []);
  assert.equal(K.apiKeysLoadError()?.readError, true);
  assert.equal(K.verifyApiKey(first.plaintext)?.ok === true, false, '읽지 못한 동안 검증은 실패 쪽');
  const r = K.issueApiKey({ name: 'portal-c', groups: ['inventory'] }, 'adm');
  assert.equal(r.key, null); assert.equal(r.status, 409); assert.equal(r.code, 'settings-unreadable');
  assert.equal(K.revokeApiKey(first.key.id, 'adm').status, 409);
  assert.equal(K.deleteApiKey(first.key.id).status, 409);
  untouched('api-keys.json');
  restore();
  assert.deepEqual(K.listApiKeys(), [], '간격(30초) 안에는 디스크를 다시 보지 않는다');
  pass();
  assert.equal(K.listApiKeys().length, 1, '읽히면 원래 키로 돌아온다(재시작 · 사람 조치 없이)');
  assert.equal(K.apiKeysLoadError(), null);
  // 손상은 예전과 같다 — 보존본으로 옮긴다.
  fs.writeFileSync(F('api-keys.json'), '{깨짐');
  K._resetApiKeyCache();
  assert.deepEqual(K.listApiKeys(), []);
  assert.equal(corruptOf('api-keys.json').length, 1);
});

test('F2 RMA 법인 비밀번호(rma-agents.json): 읽기 오류면 원본 유지 · 설정 409 · 읽히면 원래 값', async () => {
  const R = await import('../src/rma/agentSecrets.js');
  R._resetRmaSecrets();
  R.setRmaPassword('edge-a', 'pw-a');
  R._resetRmaSecrets();
  const restore = asDir('rma-agents.json');
  assert.equal(R.rmaPasswordFor('edge-a'), '');
  assert.equal(R.rmaSecretsReadError(), 'EISDIR');
  assert.ok(is409(() => R.setRmaPassword('edge-b', 'pw-b')), '읽기 오류 중 설정은 409 로 거절');
  untouched('rma-agents.json');
  restore(); pass();
  assert.equal(R.rmaPasswordFor('edge-a'), 'pw-a');
  assert.equal(R.rmaSecretsReadError(), null);
});

test('F3 수집 서버 등록부(collectors.json): 읽기 오류면 원본 유지 · 표지(readError) · 관리자 삭제도 409 · 읽히면 풀림', async () => {
  fs.writeFileSync(F('collectors.json'), JSON.stringify({ collectors: [{ id: 'edge-1', name: 'edge-1', url: 'https://10.0.0.1:8443', token: 't-1' }] }));
  const C = await import('../src/collector/registry.js');
  assert.equal(C.loadCollectors().length, 1);
  const restore = asDir('collectors.json');
  assert.deepEqual(C.loadCollectors(), []);
  assert.equal(C.registryLoadError()?.readError, true);
  const r = C.removeCollector('edge-1');
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.code, 'registry-unreadable');
  untouched('collectors.json');
  restore();
  assert.deepEqual(C.loadCollectors(), [], '간격 안');
  pass();
  assert.equal(C.loadCollectors().length, 1);
  assert.equal(C.registryLoadError(), null);
});

test('F4 Bareos 원장 · 설정 · 그룹: 읽기 오류면 원본 유지 · 쓰기 거절 · 읽히면 원래 값(손상은 예전처럼 보존)', async () => {
  fs.writeFileSync(F('bareos-jobs.json'), JSON.stringify({ version: 1, jobs: [{ id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'app-01' }], retired: [] }));
  const REG = await import('../src/bareos/registry.js');
  REG._resetForTest();
  let restore = asDir('bareos-jobs.json');
  assert.deepEqual(REG.listJobs(), []);
  assert.equal(REG.registryLoadError()?.readError, true);
  assert.throws(() => REG.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-2', vmName: 'b', dc: 'DC', folder: '/', directorId: 'dir_x', bareosJob: 'pv-2', client: 'c', storage: 's', pool: 'p', createdBy: 't' }));
  untouched('bareos-jobs.json');
  restore(); pass();
  assert.equal(REG.listJobs().length, 1);
  assert.equal(REG.registryLoadError(), null);

  const S = await import('../src/bareos/settings.js');
  S._resetForTest();
  const d = S.addDirector({ name: '본사', host: '10.20.30.40', port: 9101 });
  assert.ok(d.director?.id, JSON.stringify(d));
  S._resetForTest();
  restore = asDir('bareos.json');
  assert.equal(S.settingsLoadError()?.readError, true);
  assert.ok(is409(() => S.addDirector({ name: '지사', host: '10.20.30.41', port: 9101 })), '읽기 오류 중 저장은 409(assertWritable)');
  untouched('bareos.json');
  restore(); pass();
  assert.equal(S.settingsLoadError(), null);
  assert.equal(S.loadSettings().directors.length, 1);

  const G = await import('../src/bareos/groups.js');
  fs.writeFileSync(F('bareos-groups.json'), '{깨짐');
  G._resetGroupsForTest();
  assert.ok(G.groupsLoadError(), '손상은 예전처럼 오류');
  assert.equal(corruptOf('bareos-groups.json').length, 1, '손상은 예전처럼 보존본');
});

test('F5 이슈 설정 · 사용 기록 설정: 읽기 오류면 저장 409 · 꺼짐 · 원본 유지', async () => {
  const IS = await import('../src/issues/settings.js');
  IS._resetIssueSettingsCache();
  IS.saveIssueSettings({});
  IS._resetIssueSettingsCache();
  let restore = asDir('issue-settings.json');
  assert.ok(IS.issueSettingsLoadError());
  assert.ok(is409(() => IS.saveIssueSettings({})));
  untouched('issue-settings.json');
  restore(); pass();
  assert.equal(IS.issueSettingsLoadError(), null);

  const U = await import('../src/usage/settings.js');
  U._resetUsageSettingsCache();
  U.saveUsageSettings({ enabled: true, keepDays: 400 }, 'adm');
  U._resetUsageSettingsCache();
  restore = asDir('usage-settings.json');
  assert.equal(U.loadUsageSettings().enabled, false, '못 읽으면 꺼짐(fail-closed — 예전과 같다)');
  assert.equal(U.usageSettingsLoadError()?.readError, true);
  assert.ok(is409(() => U.saveUsageSettings({ enabled: true }, 'adm')), '읽기 오류 중 저장은 기본값 위에 쓰지 않는다');
  untouched('usage-settings.json');
  restore(); pass();
  assert.equal(U.loadUsageSettings().keepDays, 400, '읽히면 원래 보관 일수');
  assert.equal(U.usageSettingsLoadError(), null);
});

test('F6 · F7 이슈 · 위키 저장소: 읽기 오류면 원본 유지 · 모든 쓰기 409 · 읽히면 번호까지 이어진다', async () => {
  const I = await import('../src/issues/store.js');
  I._resetIssuesCache();
  const a = I.createIssue({ title: '첫 이슈' }, 'adm');
  I.flushIssuesNow();
  I._resetIssuesCache();
  let restore = asDir('issues.json');
  assert.equal(I.issuesReadError()?.code, 'EISDIR');
  assert.ok(is409(() => I.createIssue({ title: '둘째' }, 'adm')), '빈 목록 위에 한 건만 든 파일을 쓰지 않는다');
  assert.equal(I.issuesPersist().readError, true);
  untouched('issues.json');
  restore(); pass();
  assert.equal(I.issuesReadError(), null);
  const b = I.createIssue({ title: '둘째' }, 'adm');
  assert.equal(b.num, a.num + 1, '원본을 읽었으니 번호가 이어진다(1 부터 다시가 아니다)');
  I.flushIssuesNow();

  const W = await import('../src/wiki/store.js');
  W._resetWikiCache();
  W.createPage({ title: '첫 문서', body: 'x' }, 'adm');
  W.flushWikiNow();
  W._resetWikiCache();
  restore = asDir('wiki.json');
  assert.equal(W.wikiReadError()?.code, 'EISDIR');
  assert.ok(is409(() => W.createPage({ title: '둘째', body: 'y' }, 'adm')));
  untouched('wiki.json');
  restore(); pass();
  assert.equal(W.wikiReadError(), null);
});

test('F8 이슈 스프린트 · 템플릿 · 위키 템플릿: 읽기 오류면 저장 409 · 원본 유지', async () => {
  const SP = await import('../src/issues/sprints.js');
  const DAYS = { startDay: '2026-11-02', endDay: '2026-11-13' };
  SP._resetSprintsCache();
  SP.createSprint({ name: '스프린트 1', ...DAYS }, 'adm');
  SP._resetSprintsCache();
  let restore = asDir('issue-sprints.json');
  assert.ok(is409(() => SP.createSprint({ name: '스프린트 2', ...DAYS }, 'adm')));
  assert.equal(SP.sprintsLoadError()?.readError, true);
  untouched('issue-sprints.json');
  restore(); pass();
  assert.equal(SP.createSprint({ name: '스프린트 2', ...DAYS }, 'adm').num, 2, '원본을 읽었으니 번호가 이어진다');

  const IT = await import('../src/issues/templates.js');
  IT._resetIssueTemplates();
  restore = asDir('issue-templates.json');
  assert.deepEqual(IT.listCustomIssueTemplates(), []);
  assert.ok(is409(() => IT.saveIssueTemplate({ name: 't', body: 'b' }, 'adm')));
  untouched('issue-templates.json');
  restore();

  const WT = await import('../src/wiki/templates.js');
  WT._resetCustomTemplates();
  restore = asDir('wiki-templates.json');
  assert.ok(is409(() => WT.saveCustomTemplate({ name: 't', body: 'b' }, 'adm')));
  assert.ok(WT.customTemplatesLoadError());
  untouched('wiki-templates.json');
  restore();
});

test('F9 · F10 로그인 실패 · 로그인 기록: 읽기 오류면 원본 유지 · 통째 쓰기 안 함 · 다시 읽히면 이어진다', async () => {
  const t0 = NOW - 60_000;
  fs.writeFileSync(F('login-fails.ndjson'), `${JSON.stringify({ ts: t0, source: 'portal', kind: 'portal', user: 'u1', ip: '10.0.0.1' })}\n`);
  const LS = await import('../src/security/loginStore.js');
  LS._resetLoginStoreForTest();
  let restore = asDir('login-fails.ndjson');
  assert.deepEqual(LS.getStoredFails(0), []);
  assert.equal(LS.loginStoreReadError(), 'EISDIR');
  assert.equal(LS.recordLoginFails([{ ts: NOW, kind: 'portal', user: 'u2', ip: '10.0.0.2' }]), 1);
  untouched('login-fails.ndjson');
  restore(); pass();
  const got = LS.getStoredFails(0).map((r) => r.user).sort();
  assert.deepEqual(got, ['u1', 'u2'], '파일 기록 + 읽기 오류 동안 메모리에 쌓인 기록');
  assert.equal(LS.loginStoreReadError(), null);
  LS._resetLoginStoreForTest();

  fs.writeFileSync(F('login-history.ndjson'), `${JSON.stringify({ ts: t0, user: 'u1', ip: '10.0.0.1', role: 'admin', src: '' })}\n`);
  const LH = await import('../src/security/loginHistory.js');
  LH._resetLoginHistoryForTest();
  restore = asDir('login-history.ndjson');
  const s1 = LH.loginHistorySummary({ now: NOW });
  assert.ok(s1.loadError, '못 읽음을 0 건으로 단정하지 않는다');
  untouched('login-history.ndjson');
  restore(); pass();
  const s2 = LH.loginHistorySummary({ now: NOW });
  assert.equal(s2.loadError, null);
  assert.equal(s2.records, 1, '원본 기록이 돌아온다');
  LH._resetLoginHistoryForTest();
});

test('F11 · F12 IP 관리 대역 · 대역 용도: 읽기 오류가 재시작 전까지 굳지 않는다(30초 간격 재읽기)', async () => {
  const R = await import('../src/ipam/rangeStore.js');
  assert.equal(R.saveVcRanges('vcA', { ranges: ['10.1.0.0/24'] }).ok, true);
  // mtime 이 그대로인 읽기 오류(chmod 로 권한만 틀린 경우와 같다) — 예전에는 mtime 캐시가 오류 상태를 재시작 전까지 붙잡았다.
  const t = fs.statSync(F('ipam-vcenter-ranges.json')).mtime;
  fs.utimesSync(F('ipam-vcenter-ranges.json'), t, new Date(t.getTime() + 5_000));   // 캐시를 비켜 다시 읽게
  withEio('ipam-vcenter-ranges.json', () => {
    assert.equal(R.vcRangesLoadError()?.readError, true);
    assert.equal(R.saveVcRanges('vcB', { ranges: ['10.2.0.0/24'] }).code, 'settings-unreadable');
  });
  assert.deepEqual(corruptOf('ipam-vcenter-ranges.json'), []);
  assert.ok(R.vcRangesLoadError(), '간격 안');
  pass();
  assert.equal(R.vcRangesLoadError(), null, '같은 mtime 이어도 간격이 지나면 다시 읽어 풀린다');

  const N = await import('../src/ipam/subnetNotes.js');
  N._resetSubnetNotesForTest();
  assert.equal(N.setSubnetNote('10.9.8', { purpose: 'DB' }, 'adm').ok, true);
  N._resetSubnetNotesForTest();
  const restore = asDir('ipam-subnet-notes.json');
  assert.equal(N.subnetNotesLoadError()?.readError, true);
  const no = N.setSubnetNote('10.9.9', { purpose: 'WEB' }, 'adm');
  assert.equal(no.code, 'settings-unreadable'); assert.match(no.reason, /읽기 오류/);
  untouched('ipam-subnet-notes.json');
  restore(); pass();
  assert.equal(N.subnetNotesLoadError(), null);
  assert.equal(N.getSubnetNote('10.9.8')?.purpose, 'DB');
});

test('F13 베어메탈 정비 창: 읽기 오류 뒤 30초 안에는 디스크를 다시 읽지 않는다(판정 입력마다 EIO 를 두드리지 않게)', async () => {
  fs.writeFileSync(F('maintenance-windows.json'), JSON.stringify({ v: 1, seq: 0, items: [] }));
  const M = await import('../src/bmusage/maint/store.js');
  M._resetMaintStoreForTest();
  const reads = withEio('maintenance-windows.json', () => {
    for (let i = 0; i < 5; i += 1) assert.equal(M.maintLoadError()?.readError, true);
    assert.equal(M.windowsForJudge(NOW).localUnreadable, true, '못 읽은 창 파일은 억제가 아니다');
  });
  assert.equal(reads, 1, `간격 안의 호출은 디스크를 다시 읽지 않는다(읽은 횟수 ${reads})`);
  pass();
  assert.equal(M.maintLoadError(), null);
  M._resetMaintStoreForTest();
});

test('F14 게스트 디스크 · 디렉터리 사용량 설정: 읽기 오류면 저장 409 · 원본 유지 · 기본 보관 일수로 이력을 지우지 않는다', async () => {
  const GD = await import('../src/guestdisk/settings.js');
  GD.invalidate();
  assert.equal(GD.save({ retentionDays: 3650 }).retentionDays, 3650);
  GD.invalidate();
  let restore = asDir('guest-disk.json');
  assert.equal(GD.load().retentionDays, GD.DEFAULTS.retentionDays, '못 읽으면 기본값으로 돈다(예전과 같다)');
  assert.equal(GD.settingsLoadError()?.readError, true, '그 사실을 표지로 — 이력 정리는 이 표지를 보고 건너뛴다');
  assert.ok(is409(() => GD.save({ enabled: true })), '기본값 위에 저장하지 않는다');
  untouched('guest-disk.json');
  restore(); pass();
  assert.equal(GD.load().retentionDays, 3650);
  assert.equal(GD.settingsLoadError(), null);

  const DU = await import('../src/dirusage/settings.js');
  DU.invalidate();
  DU.save({ retentionDays: 3000 });
  DU.invalidate();
  restore = asDir('dirusage.json');
  assert.equal(DU.settingsLoadError()?.readError, true);
  assert.ok(is409(() => DU.save({ enabled: true })));
  untouched('dirusage.json');
  restore(); pass();
  assert.equal(DU.load().retentionDays, 3000);
  // 손상은 예전처럼 보존 — 그리고 이 프로세스에서는 정리를 멈출 표지가 선다(진짜 보관 일수는 보존본에 있다).
  fs.writeFileSync(F('dirusage.json'), '{깨짐');
  DU.invalidate();
  assert.ok(DU.settingsLoadError());
  assert.equal(corruptOf('dirusage.json').length, 1);
  DU.invalidate();
});

test('F14 스윕: 게스트 디스크 · 디렉터리 사용량의 이력 정리는 설정 로드 오류 표지를 먼저 본다', () => {
  for (const rel of ['guestdisk/poller.js', 'dirusage/scheduler.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    const all = s.split('\n');
    const idx = all.map((l, i) => (/\bprune\(/.test(l) && !/function\s+\w*[pP]rune|runOrphanPrune|pruneDue\(\)\s*\{/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(idx.length >= 1, rel);
    // 그 줄 또는 바로 위 두 줄(감싸는 if)에 표지 확인이 있어야 한다.
    for (const i of idx) assert.match(all.slice(Math.max(0, i - 2), i + 1).join('\n'), /settingsLoadError\(\)/, `${rel}: 보관 일수를 못 읽은 채 지우면 안 된다 — ${all[i].trim()}`);
  }
});

/*
 * 스윕: preserveCorrupt(손상 보존)를 직접 부르는 파일 목록 고정. 새 파일이 여기 없이 손상 보존을 부르면 실패한다 —
 *   읽기 단계(공용 판정: util/jsonFileRead.js readJsonFile · makeJsonFileReader · jsonFileLoad.js makeJsonFileLoader · registryCore.js read)와
 *   parse 단계를 가르지 않은 catch 하나가 읽기 오류에도 온전한 원본을 옮긴다(56~96회차 반복 결함).
 *   분류: 'split' = 읽기 단계를 갈랐다(이 테스트가 그 표지를 확인) · 'cache' = 잃어도 다시 만들어지는 파일 · 'left' = 남긴 것(사유 — 다음 점검 후보).
 *   목록에서 빠진 파일(공용 로더로 옮겨 직접 호출이 사라진 것)은 실패로 보지 않는다 — 다른 점검이 동시에 옮긴다.
 */
const SPLIT = /makeJsonFileReader\(|readJsonFile\(|makeJsonFileLoader\(|[lL]oadErr\.read\(|\.readError\(/;
/** 분류 → [분류, 사유]. split = 공용 판정(위 표지가 실제로 있어야 한다) · own = 자체 분리(확인함) · admin = 관리자 명시 초기화 · cache = 잃어도 다시 만들어짐 ·
 *  scope = 다른 점검이 지금 고치는 범위(97회차 제외) · left = 남긴 것(다음 점검 후보 — 설정 · 원장이라 읽기 오류에 원본을 옮기면 다음 저장이 덮는다). */
const ALLOW = {
  'agent/deployRegistry.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'auth/permissions.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/digest.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/edgeStore.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/groups.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/health.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/policy.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/registry.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/rehearsal.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bareos/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/maint/store.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/onboard/edgeApply.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/perfRules.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/portMap.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'bmusage/slo.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'curuser/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'gpu/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'horizon/horizon.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'ipam/rangeStore.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'ipam/subnetNotes.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'isidu/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/alertIssues.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/autoCreate.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/filters.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/sprints.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/store.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'issues/templates.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'logs/poller.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'net/monitor.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'sanswitch/directorMap.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'sanswitch/storageCheckSettings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'sanswitch/storagePerfNotifyStore.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'sanswitch/storagePerfReportMail.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'security/credentialStore.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'storage/inspect/schedule.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'svcmon/alertSettings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'svcmon/logsettings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'usage/settings.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'wiki/store.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'wiki/templates.js': ['split', '공용 판정 · 읽기 단계 분리'],
  'alarm-mutes.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'alerts.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'central/svcmonAssign.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'ipam/report.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'relaytopo/store.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'security/guestScanScheduler.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'storage/growthSettings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'svcmon/store.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'central/agentGpuGuestConfig.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'ping/store.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'rma/schedules.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'vmclone/corpMounts.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'backup/settings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리(정리는 상한 보관 개수)'],
  'cvp/settings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'vmseries/settings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리(정리는 상한 보존일)'],
  'ipam/scanStore.js': ['split', '103회차 — 설정만 공용 판정 · 결과 · 이력(readJson)은 남김(기동 1회 읽기 + 디바운스 저장이라 보류 장치 필요)'],
  'svcmon/templates.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'upgrade/fleetBundle.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'upgrade/packageSettings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'upgrade/settings.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'vmclone/store.js': ['split', '103회차 — 공용 판정 · 읽기 단계 분리'],
  'bmusage/annotations.js': ['own', '읽기 오류는 503 · 보존 안 함(77회차)'],
  'bmusage/compareSets.js': ['own', '읽기 오류는 503 · 보존 안 함(77회차)'],
  'bmusage/keyDecisions.js': ['own', '읽기 오류는 503 · 보존 안 함(77회차)'],
  'focusmon/alerts.js': ['own', '읽기 단계 따로 — 읽기 오류는 loadErr 만'],
  'focusmon/audit/settings.js': ['own', '읽기 단계 따로 — 읽기 오류는 loadErr 만'],
  'provision/saved.js': ['own', '읽기 오류는 readErr · 캐시 안 함'],
  'security/secretVault.js': ['own', '정책 파일 corrupt · invalid 만 보존(S-07)'],
  'sshaccess/state.js': ['own', '읽기 실패는 잠금 · 30초 재읽기 · 보존 안 함'],
  'upgrade/signature.js': ['own', '읽기 오류는 error 로 돌려줌 · parse 실패만 보존'],
  'upgrade/signatureOverride.js': ['own', '읽기 실패 = 켜짐(보존 안 함) · parse 실패만 보존'],
  'upgrade/statusStore.js': ['own', '읽기 오류는 error 로 돌려줌 · parse 실패만 보존'],
  'vmhygiene/notifier.js': ['own', '읽기 실패는 빈 상태(보존 안 함) · parse 실패만 보존'],
  'xferspeed/poller.js': ['own', '읽기 오류는 readError(v2.740)'],
  'xferspeed/settings.js': ['own', '읽기 오류는 직전 값 · transient(v2.740)'],
  'bmfolders/store.js': ['admin', '관리자 손상 초기화 라우트에서만 보존'],
  'servicemap/store.js': ['admin', '관리자 손상 초기화 라우트에서만 보존'],
  'bareos/install/job.js': ['cache', '설치 작업 기록(최근 n건)'],
  'bareos/notify.js': ['cache', '메일 발송 상태'],
  'bmfolders/edgeCopy.js': ['cache', '중앙 사본(다음 배포가 다시 씀)'],
  'bmusage/perfAlerts.js': ['cache', '알림 상태(다음 주기부터 다시 셈)'],
  'central/pduEdge.js': ['cache', '엣지 스냅샷(다음 push)'],
  'central/tokenApplyJob.js': ['cache', '작업 기록'],
  'central/unsupportedServers.js': ['cache', '미지원 서버 표본(다음 push)'],
  'diskbad/cursors.js': ['cache', '읽은 위치(다시 읽음)'],
  'guestpart/notify.js': ['cache', '메일 상태'],
  'insights/portalDb.js': ['cache', '크기 표본'],
  'ipam/scanLog.js': ['cache', '스캔 로그(최근 n건)'],
  'issues/notify.js': ['cache', '알림 발송 상태'],
  'release-notes.js': ['cache', '사용자 릴리스 노트(내장본이 있다)'],
  'sanswitch/errBaseline.js': ['cache', '오류 기준값(다음 수집이 다시 잡음)'],
  'sanswitch/flowJobs.js': ['cache', '흐름 기록'],
  'sshaccess/usage.js': ['cache', '키 사용 통계'],
  'storage/inspect/runner.js': ['cache', '미전송 고리'],
  'storage/nodeLoadPoller.js': ['cache', '미전송 표본'],
  'svcmon/settingsSync.js': ['cache', '동기 상태'],
  'svcmon/trial.js': ['cache', '시험 대기(시한)'],
  'vmclone/notify.js': ['cache', '메일 상태'],
  'vmseries/db.js': ['cache', '색인(다시 만듦) — 119회차: 읽기 오류면 쓰지 않음'],
  // 119회차: 아래 'scope' 줄들을 지금 코드로 재현해 사실대로 바꿨다(vcenter 두 줄은 118회차가 고쳤다 — 남은 scope 0). 회귀는 readErrorSweep119.
  'auth/ad.js': ['split', '88회차 F3 — 공용 읽기 · 읽기 단계 분리(마지막 값 유지 · 저장 거절 · 119회차 재확인)'],
  'auth/auth.js': ['own', 'users.json — 19회차 A-4: 읽기 단계 따로(읽기 오류는 fail-closed · 원본 유지 · 계정 생성 · 저장 거절 — 119회차 재확인)'],
  'auth/sessionState.js': ['own', '읽기 단계 따로 — 읽기 오류는 옮기지 않고 notBefore=지금(전원 재로그인 — 닫는 쪽) · parse 실패만 보존(119회차 재확인)'],
  'backup/stagedRestore.js': ['cache', '마지막 복원 적용 기록(readLast — 다음 적용이 다시 씀). 119회차 확인: 읽기 단계는 갈라지지 않았다(읽기 오류에도 그 기록을 옮긴다 — 표시용 · 110 · 114회차는 다른 곳을 고침)'],
  'isidu/digest.js': ['split', '119회차 — 공용 읽기 · 읽기 단계 분리(처리 기록 — 못 읽으면 정기 발송 멈춤 · 쓰지 않음)'],
  'isidu/notify.js': ['split', '119회차 — 공용 읽기 · 읽기 단계 분리(대상별 기록 — 못 읽으면 자동 발송 멈춤 · 쓰지 않음)'],
  'metrics/vmperfDb.js': ['cache', '색인(열 때 다시 등록) — 119회차: 읽기 오류면 쓰지 않음(한 줄짜리로 덮지 않게) · parse 실패만 보존'],
  'nsx/registry.js': ['split', '116회차 — 공용 판정(registryCore read) · 읽기 단계 분리'],
  'security/peerTrust.js': ['own', '119회차(결정 — v2.732 B4-03 을 고침): 읽기 실패는 원본을 옮기지 않음(쓰기 차단 · enforce · 30초 재읽기) · 손상만 보존'],
  'vcenter/order.js': ['split', '118회차 — 공용 판정(registryCore read) · 읽기 단계 분리(마지막 순서 유지 · 저장 거절 · 손상 보존은 공용 읽기가 한다)'],
  'vcenter/registry.js': ['split', '118회차 — 공용 판정(registryCore read) · 읽기 단계 분리(마지막 목록 유지 · 쓰기 거절 · 손상 보존은 공용 읽기가 한다)'],
  'veeam/snapDb.js': ['own', '덮음 무효 표지 — 읽기 단계 따로: 읽기 오류는 all(전 vCenter 덮음 무효 — 안전 쪽 · 보존 안 함) · parse 실패만 보존(119회차 재확인)'],
  'attach/store.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(목록 · 설정 — 올리기는 본체를 쓰기 전에 503)'],
  'bareos/drRunner.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(읽기 오류 동안 실행기 멈춤 · 읽히면 이어 감)'],
  'bareos/install/bundleSource.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'bmusage/tuning/overrides.js': ['split', '105회차 — 공용 판정 · 읽기 단계 분리'],
  'central/agentConfig.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(기동 1회 읽기 → 30초 재읽기 · 그동안 받은 사본은 메모리에만 · 읽히면 합침)'],
  'diskbad/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'focusmon/audit/service.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(그동안 상태 파일을 쓰지 않음 · 메모리가 바뀌지 않았으면 읽힐 때 파일 상태로)'],
  'focusmon/store.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(계속 수집 정의 · 엣지 키 — 읽히면 합침)'],
  'guestpart/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'hostaccess/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(적용 · 확정 대기 상태 — 초안 · 적용 · 확정 503)'],
  'insights/finops.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'inventory/osScanner.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(스캔 결과 기록도 쓰지 않음)'],
  'ipam/changeLog.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(그동안의 변화는 기록되지 않음)'],
  'ipam/rangePolicies.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(읽히면 리비전을 올림)'],
  'ipam/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(읽히면 리비전을 올림)'],
  'ipam/vcRangeMigrate.js': ['own', '105회차 A2 — 읽기 단계 따로(읽기 오류는 표지만 · 원본 그대로 · 이전 · 수동 옮김 · 지움은 건너뜀/409) · parse 실패만 보존(119회차 재확인 — left 0)'],
  'issues/inbox.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(그동안의 알림은 쌓지 않음 — dropped)'],
  'linkcheck/settings.js': ['split', '105회차 — 공용 판정 · 읽기 단계 분리'],
  'llm/config.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(매번 읽음 — 마지막 값 유지)'],
  'ping/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(마지막 값 유지 · 저장 거절은 예전부터)'],
  'reports/dailyReport.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'rma/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(접속 허용 IP — 그동안의 출처 판정은 남긴 것: 중앙 rma-poll 게이트)'],
  'runtime-settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'sanswitch/perfSettings.js': ['split', '105회차 — 공용 판정 · 읽기 단계 분리'],
  'security/loginMonitor.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'sshaccess/installed.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'storage/inspect/store.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(그동안 받은 실행은 dropped — 엣지가 다시 보냄)'],
  'storage/intervals.js': ['split', '105회차 — 공용 판정 · 읽기 단계 분리'],
  'storage/usageMail.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(설정 · 처리 기록 — 처리 기록을 못 읽으면 정기 발송 멈춤)'],
  'svcmon/batches.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(그동안 쓰지 않음 · 롤백 거절)'],
  'toolcats/settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'tools/powerOffSettings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'ui-settings.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리(매번 읽음 — 마지막 값 유지)'],
  'usermenu/store.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
  'wiki/userState.js': ['split', '107회차 — 공용 읽기 · 읽기 단계 분리'],
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('스윕: preserveCorrupt 를 직접 부르는 새 파일은 허용 목록(사유)에 올리고 읽기 단계를 갈라야 한다', () => {
  const hits = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (rel.startsWith('util/')) continue;   // 공용 판정 자체
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    if (!/\bpreserveCorrupt\(|\bbackupCorrupt\(/.test(s)) continue;
    hits.push({ rel, s });
  }
  const unknown = hits.filter((h) => !ALLOW[h.rel]).map((h) => h.rel);
  assert.deepEqual(unknown, [], `허용 목록에 없는 손상 보존 호출 — 읽기 단계를 공용 판정(util/jsonFileRead.js · registryCore read)으로 가르고 사유와 함께 목록에 올릴 것: ${unknown.join(', ')}`);
  // 'split' 으로 올린 파일은 읽기 단계를 가른 표지가 실제로 있어야 한다(되돌림 감지).
  const lost = hits.filter((h) => ALLOW[h.rel]?.[0] === 'split' && !SPLIT.test(h.s)).map((h) => h.rel);
  assert.deepEqual(lost, [], `읽기 단계 분리 표지가 사라졌다(읽기 오류를 손상으로 되돌렸나): ${lost.join(', ')}`);
});

test('스윕: 97회차에 고친 파일의 catch 가 읽기 오류를 다시 손상 보존으로 보내지 않는다', () => {
  // preserveCorrupt 를 부르는 catch 마다, 그 짝 try 블록 안에 원본을 읽는 readFileSync 가 있으면 실패(읽기 오류도 그 catch 로 간다) — 고친 파일에 다시 생기지 않게.
  const FIXED = ['publicapi/keys.js', 'rma/agentSecrets.js', 'collector/registry.js', 'bareos/registry.js', 'bareos/settings.js', 'bareos/groups.js', 'bareos/policy.js',
    'bareos/digest.js', 'bareos/health.js', 'bareos/rehearsal.js', 'bareos/edgeStore.js', 'issues/settings.js', 'issues/autoCreate.js', 'issues/alertIssues.js',
    'usage/settings.js', 'issues/store.js', 'wiki/store.js', 'issues/filters.js', 'issues/sprints.js', 'issues/templates.js', 'wiki/templates.js',
    'security/loginStore.js', 'security/loginHistory.js', 'guestdisk/settings.js', 'dirusage/settings.js'];
  const bad = [];
  for (const rel of FIXED) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    for (const m of s.matchAll(/\bpreserveCorrupt\(/g)) {
      const c = s.lastIndexOf('catch', m.index);
      const t = c >= 0 ? s.lastIndexOf('try', c) : -1;
      if (t >= 0 && /\bfs\.readFileSync\(/.test(s.slice(t, c))) bad.push(`${rel}:${s.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], '읽기(readFileSync)와 parse 를 한 try 에 두고 그 catch 에서 손상 보존을 부르면 읽기 오류도 원본을 옮긴다 — 공용 읽기(readJsonFile · makeJsonFileReader · registryCore read)로 가를 것');
});

test('F14 후속(메인 검토): 설정을 못 읽는 동안의 이력 정리는 건너뛰지 않고 저장 상한(RETENTION_MAX_DAYS)으로 한다 — 멈춤에도 상한(83 R1)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SRC = pathm.join(pathm.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const rel of ['guestdisk/poller.js', 'dirusage/scheduler.js']) {
    const src = stripComments(fsm.readFileSync(pathm.join(SRC, rel), 'utf8'));
    assert.match(src, /settingsLoadError\(\)\s*\?\s*RETENTION_MAX_DAYS/, `${rel}: 로드 오류 중 정리는 상한 보존일로`);
    assert.doesNotMatch(src, /if\s*\(\s*!\s*settingsLoadError\(\)\s*\)\s*(\{\s*try\s*\{\s*)?await\s+prune/, `${rel}: 정리를 통째로 건너뛰면 무한 증식`);
  }
  const GDS = await import('../src/guestdisk/settings.js');
  const DUS = await import('../src/dirusage/settings.js');
  assert.equal(GDS.RETENTION_MAX_DAYS, 3650);
  assert.equal(DUS.RETENTION_MAX_DAYS, 3650);
});
