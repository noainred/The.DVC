/**
 * readErrorSweep107.test.js — 전체 점검 107회차: 공통 스윕 '읽기 오류 ≠ 손상' 잔여(97회차 분류표의 'left' 30개).
 *
 * 꼴은 97 · 103회차와 같다 — 설정 · 원장 · 상태 파일의 **읽기 오류**(EACCES · EIO · EISDIR)를 손상(parse 실패)과 같은 catch 하나로 받아 온전한 원본을
 *   `.corrupt.*` 로 옮기고 빈 값 · 기본값을 캐시했다 → 다음 저장이 원본 자리를 덮었다. 고친 모듈마다 같은 것을 고정한다:
 *     원본 유지(옮기지 않음 · 보존본 없음) · 캐시 안 함(30초 간격 재읽기 — 시계 주입) · 쓰기 거절(503 settingsUnreadable) · 읽히면 원본 값으로 풀림 · 손상은 예전처럼 보존.
 *   읽기 오류는 root 컨테이너라 EACCES 대신 **EISDIR**(파일 자리에 폴더 — 실제 fs 오류)로 재현한다.
 *
 *  높음: rma/settings(접속 허용 IP — 못 읽으면 '전부 허용' · 다음 저장이 한 법인만) · hostaccess/settings(방화벽 적용 · 확정 대기 상태)
 *  중간: ipam/rangePolicies · ipam/settings · usermenu/store · attach/store · svcmon/batches · runtime-settings(데이터 소스) · llm/config · focusmon(계속 수집 정의 · 점검 상태) ·
 *        bareos/drRunner · central/agentConfig · storage/usageMail(처리 기록 — 같은 메일 재발송) · issues/inbox · wiki/userState · ipam/changeLog · storage/inspect/store
 *  낮음: 동작 · 표시 설정(guestpart · diskbad · osScanner · loginMonitor · dailyReport · finops · powerOff · toolcats · bundleSource · ping/settings · ui-settings · sshaccess/installed)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'readErr107-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const F = (n) => path.join(TMP, n);
const corruptOf = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
const put = (n, v) => fs.writeFileSync(F(n), typeof v === 'string' ? v : JSON.stringify(v));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

let seq = 0;
/** 캐시 초기화 함수가 없는 모듈은 새 인스턴스로 읽는다(모듈 수준 캐시 · 기동 시 읽기). */
const fresh = (rel) => import(`../src/${rel}?r107=${++seq}`);

/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep107`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
function untouched(name) {
  assert.ok(fs.statSync(F(name)).isDirectory(), `${name}: 원본 자리를 옮기면 안 된다(읽기 오류는 손상이 아니다)`);
  assert.deepEqual(corruptOf(name), [], `${name}: 읽기 오류에 보존본을 만들면 안 된다`);
}
/** 거절 본문 모양 — 화면이 503 을 '일시 장애' 로 바꾸지 않게 code 가 Unreadable 로 끝나야 한다(web serviceDownKind). */
function isRefusal(no, label) {
  assert.ok(no, `${label}: 읽기 오류 중에는 저장 거절 본문이 있어야 한다`);
  assert.equal(no.ok, false); assert.equal(no.status, 503); assert.equal(no.code, 'settingsUnreadable'); assert.equal(no.readError, true);
  assert.match(no.reason, /읽기 오류\(EISDIR\).*원본은 그대로/, label);
}
/** 던진 거절 — 라우트의 fail(res, e) 는 e.status · e.extra 를 응답에 싣는다(extra.code 가 있어야 화면이 사유를 그대로 보인다). */
const throws503 = (fn) => { try { fn(); } catch (e) { return e?.status === 503 && e?.extra?.code === 'settingsUnreadable' && e?.extra?.readError === true; } return false; };
const quiet = async (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

test('F1 RMA 분배 · 접속 허용 IP(rma-settings.json): 읽기 오류면 원본 유지 · 저장 503 · 읽히면 허용 목록이 돌아온다', () => quiet(async () => {
  const M = await import('../src/rma/settings.js');
  put('rma-settings.json', { version: 1, defaultMode: 'active-backup', agents: { 'edge-a': { allowedIps: ['10.1.1.0/24'], comment: 'c' } } });
  M._resetRmaSettings();
  assert.deepEqual(M.accessFor('edge-a').allowedIps, ['10.1.1.0/24']);
  M._resetRmaSettings();
  const restore = asDir('rma-settings.json');
  assert.deepEqual(M.accessFor('edge-a').allowedIps, [], '못 읽은 동안은 빈 값(캐시하지 않는다)');
  isRefusal(M.rmaSettingsWriteRefusal(), 'rma');
  assert.ok(throws503(() => M.setAgentAccess('edge-b', { allowedIps: ['10.2.2.2'] })), '한 법인만 든 파일로 원본을 덮지 않는다');
  assert.ok(throws503(() => M.setDefaultMode('active-active')));
  untouched('rma-settings.json');
  restore();
  assert.deepEqual(M.accessFor('edge-a').allowedIps, [], '간격(30초) 안에는 디스크를 다시 보지 않는다');
  pass();
  assert.deepEqual(M.accessFor('edge-a').allowedIps, ['10.1.1.0/24'], '읽히면 원래 허용 목록(재시작 없이)');
  assert.equal(M.rmaSettingsWriteRefusal(), null);
  assert.equal(M.modeFor('edge-a').mode, 'active-backup');
  // 손상은 예전과 같다
  put('rma-settings.json', '{깨짐'); M._resetRmaSettings();
  assert.deepEqual(M.accessFor('edge-a').allowedIps, []);
  assert.equal(corruptOf('rma-settings.json').length, 1);
  M._resetRmaSettings();
}));

test('F2 호스트 접근 제어(host-access.json): 읽기 오류면 원본(적용 · 확정 대기) 유지 · 저장 503 · 읽히면 돌아온다', () => quiet(async () => {
  const M = await import('../src/hostaccess/settings.js');
  put('host-access.json', { draft: {}, applied: { at: 1, by: 'adm', fingerprint: 'fp-1', rich: [] }, pending: { at: 2, deadline: 3, by: 'adm', fingerprint: 'fp-2', rich: [] } });
  M._resetHostAccessCache();
  const restore = asDir('host-access.json');
  const st = M.loadHostAccess();
  assert.equal(st.applied, null); assert.equal(st.pending, null);
  isRefusal(M.hostAccessWriteRefusal(), 'hostaccess');
  assert.ok(throws503(() => M.saveHostAccess({ pending: null })), '기본값 위에 쓰면 확정 대기 · 적용 기록이 사라진다');
  untouched('host-access.json');
  restore(); pass();
  assert.equal(M.loadHostAccess().applied?.fingerprint, 'fp-1');
  assert.equal(M.loadHostAccess().pending?.fingerprint, 'fp-2');
  assert.equal(M.hostAccessWriteRefusal(), null);
  M._resetHostAccessCache();
}));

test('F3 IP 대역 정책 · IP 관리 설정: 읽기 오류면 원본 유지 · 저장 503 · 읽히면 리비전이 올라 판정 캐시가 풀린다', () => quiet(async () => {
  put('ipam-range-policies.json', { policies: [{ id: 'p1', spec: '10.5.0.0/24', specLo: 168099841, specHi: 168100094, specSize: 254, status: 'reserved', priority: 100, enabled: true }] });
  let restore = asDir('ipam-range-policies.json');
  const P = await fresh('ipam/rangePolicies.js');
  assert.deepEqual(P.getPolicies(), []);
  isRefusal(P.rangePoliciesWriteRefusal(), 'rangePolicies');
  const no = P.setPolicy({ spec: '10.6.0.0/24', status: 'reserved' }, { username: 'adm' });
  assert.equal(no.ok, false); assert.equal(no.status, 503);
  assert.equal(P.deletePolicy('p1').status, 503);
  untouched('ipam-range-policies.json');
  const rev0 = P.policiesRev();
  restore(); pass();
  assert.equal(P.getPolicies().length, 1, '읽히면 원래 정책');
  assert.ok(P.policiesRev() > rev0, '읽기 오류 동안 빈 정책으로 만든 대장 · 매칭 캐시를 버리게 리비전을 올린다');
  assert.equal(P.rangePoliciesWriteRefusal(), null);

  put('ipam-settings.json', { global: ['10.9.0.0/16'], vcenters: {}, publicRanges: [], privateRanges: [] });
  restore = asDir('ipam-settings.json');
  const S = await fresh('ipam/settings.js');
  assert.deepEqual(S.loadSettings().global, []);
  isRefusal(S.ipamSettingsWriteRefusal(), 'ipam-settings');
  assert.ok(throws503(() => S.saveSettings({ global: [] })), '화면이 보낸 빈 목록으로 원본을 덮지 않는다');
  untouched('ipam-settings.json');
  const r0 = S.settingsRev();
  restore(); pass();
  assert.deepEqual(S.loadSettings().global, ['10.9.0.0/16']);
  assert.ok(S.settingsRev() > r0);
}));

test('F4 사용자 메뉴 · 위키 사용자 상태 · 알림함: 읽기 오류면 원본 유지 · 쓰기 거절 · 읽히면 돌아온다', () => quiet(async () => {
  const U = await import('../src/usermenu/store.js');
  put('user-menus.json', { v: 1, users: {}, distributed: null, history: [{ at: 1, by: 'adm', mode: 'keep', counts: { users: 3, custom: 1, forced: 0 } }] });
  U.invalidateUserMenus();
  let restore = asDir('user-menus.json');
  assert.deepEqual(U.distributeStatus([]).history, []);
  isRefusal(U.userMenuWriteRefusal(), 'usermenu');
  untouched('user-menus.json');
  restore(); pass();
  assert.equal(U.distributeStatus([]).history.length, 1);
  assert.equal(U.userMenuWriteRefusal(), null);
  U.invalidateUserMenus();

  const W = await import('../src/wiki/userState.js');
  put('wiki-user.json', { v: 1, users: { adm: { fav: ['W1'], recent: [] } }, views: {} });
  W._resetWikiUserCache();
  restore = asDir('wiki-user.json');
  assert.deepEqual(W.userLists('adm').fav, []);
  assert.ok(throws503(() => W.setFavorite('adm', 'W2', true)), '저장되지 않을 즐겨찾기를 성공으로 답하지 않는다');
  assert.equal(W.recordView('adm', 'W3', NOW).recorded, false);
  await W.flushWikiUserNow();
  untouched('wiki-user.json');
  restore(); pass();
  assert.deepEqual(W.userLists('adm').fav, ['W1']);
  W._resetWikiUserCache();

  const I = await import('../src/issues/inbox.js');
  put('issue-inbox.json', { v: 1, users: { adm: [{ id: 'a1', at: Date.now() - 1000, kind: 'status', text: '첫 알림', key: '', pageId: '', vcenterId: '', actor: '', read: false }] }, seen: {} });
  I._resetInboxForTest();
  restore = asDir('issue-inbox.json');
  assert.equal(I.inboxStatus().items, 0);
  assert.equal(I.inboxStatus().readError, 'EISDIR', '못 읽음을 0 건으로 단정하지 않는다');
  assert.equal(I.addInbox('adm', { kind: 'status', text: '둘째' }), false);
  I.flushInboxNow();
  untouched('issue-inbox.json');
  restore(); pass();
  assert.equal(I.inboxStatus().items, 1, '원본 알림이 돌아온다');
  assert.equal(I.inboxStatus().readError, undefined);
  I._resetInboxForTest();
}));

test('F5 첨부 목록 · 설정: 읽기 오류면 원본 유지 · 올리기는 본체를 쓰기 전에 503 · 읽히면 돌아온다', () => quiet(async () => {
  const A = await import('../src/attach/store.js');
  A._resetAttachCache();
  const it = A.addAttachment('wiki', 'W1', 'a.txt', Buffer.from('hello'), 'adm');
  assert.equal(A.saveAttachSettings({ maxTotalMB: 777 }).maxTotalMB, 777);
  A._resetAttachCache();
  const blobs = () => fs.readdirSync(A.attachDir()).length;
  const n0 = blobs();
  let restore = asDir('attachments.json');
  assert.deepEqual(A.listFor('wiki', 'W1'), []);
  isRefusal(A.attachIndexWriteRefusal(), 'attach-index');
  assert.ok(throws503(() => A.addAttachment('wiki', 'W1', 'b.txt', Buffer.from('x'), 'adm')));
  assert.equal(blobs(), n0, '목록을 못 쓰는데 본체만 남기지 않는다');
  assert.ok(throws503(() => A.removeAttachment(it.id)), '없는 첨부(404)로 답하지 않는다');
  untouched('attachments.json');
  restore(); pass();
  assert.equal(A.listFor('wiki', 'W1').length, 1);

  A._resetAttachCache();
  restore = asDir('attach-settings.json');
  assert.equal(A.loadAttachSettings().maxTotalMB, A.ATTACH_LIMITS.maxTotalMBDefault);
  assert.match(A.attachSettingsError(), /읽기 오류/);
  assert.ok(throws503(() => A.saveAttachSettings({ maxTotalMB: 100 })));
  untouched('attach-settings.json');
  restore(); pass();
  assert.equal(A.loadAttachSettings().maxTotalMB, 777);
  assert.equal(A.attachSettingsError(), null);
  A._resetAttachCache();
}));

test('F6 배치 원장 · SSH 키 설치 기록: 읽기 오류면 원본 유지 · 쓰지 않음 · 롤백 거절', () => quiet(async () => {
  const B = await import('../src/svcmon/batches.js');
  B._resetBatchCache();
  const rec = B.recordBatch({ source: 'test', targets: 2, tests: 3 });
  assert.ok(rec?.id);
  B._resetBatchCache();
  let restore = asDir('svcmon-batches.json');
  assert.equal(B.getBatch(rec.id), null);
  assert.equal(B.batchLedgerReadError(), 'EISDIR');
  B.recordBatch({ source: 'test', targets: 1 });   // 등록은 계속(원장은 부가 정보) — 쓰지는 않는다
  const rb = B.rollbackBatch(rec.id, { user: 'adm' });
  assert.equal(rb.removed, 0); assert.match(rb.error, /읽지 못해 롤백하지 않았습니다/, "'이미 롤백' 가드를 못 보는 동안은 지우지 않는다");
  untouched('svcmon-batches.json');
  restore(); pass();
  assert.equal(B.getBatch(rec.id)?.id, rec.id);
  assert.equal(B.batchLedgerReadError(), '');
  B._resetBatchCache();

  const K = await import('../src/sshaccess/installed.js');
  K._resetInstalledForTest();
  assert.equal(K.noteInstalled('s1', { host: '10.0.0.1', username: 'root', keys: [] }).ok, true);
  K._resetInstalledForTest();
  restore = asDir('ssh-access-installed.json');
  assert.equal(K.installedOf('s1'), null);
  assert.equal(K.installedLoadFailed(), true);
  const no = K.noteInstalled('s2', { host: '10.0.0.2', keys: [] });
  assert.equal(no.ok, false); assert.equal(no.status, 503);
  untouched('ssh-access-installed.json');
  restore(); pass();
  assert.equal(K.installedOf('s1')?.host, '10.0.0.1');
  assert.equal(K.installedLoadFailed(), false);
  K._resetInstalledForTest();
}));

test('F7 매번 읽는 설정(LLM · 화면): 읽기 오류 동안 마지막으로 읽은 값으로 돈다 · 저장 503 · 원본 유지', () => quiet(async () => {
  const L = await import('../src/llm/config.js');
  put('llm.json', { enabled: true, url: 'http://10.0.0.9:11434', model: 'm1' });
  assert.equal(L.loadLlmConfig().model, 'm1');
  let restore = asDir('llm.json');
  assert.equal(L.loadLlmConfig().model, 'm1', 'env 기본값(꺼짐 · localhost)으로 뒤집히지 않는다');
  assert.equal(L.loadLlmConfig().enabled, true);
  isRefusal(L.llmConfigWriteRefusal(), 'llm');
  assert.ok(throws503(() => L.saveLlmConfig({ model: 'm2' })));
  untouched('llm.json');
  restore(); pass();
  assert.equal(L.llmConfigWriteRefusal(), null);
  put('llm.json', '{깨짐');
  L.loadLlmConfig();
  assert.equal(corruptOf('llm.json').length, 1, '손상은 예전처럼 보존');

  const U = await import('../src/ui-settings.js');
  put('ui.json', { mapHeight: 555 });
  pass();
  assert.equal(U.loadUiSettings().mapHeight, 555);
  restore = asDir('ui.json');
  assert.equal(U.loadUiSettings().mapHeight, 555);
  isRefusal(U.uiSettingsWriteRefusal(), 'ui');
  assert.ok(throws503(() => U.saveUiSettings({ mapHeight: 600 })));
  untouched('ui.json');
  restore(); pass();
  assert.equal(U.uiSettingsWriteRefusal(), null);
  assert.equal(U.saveUiSettings({ mapHeight: 600 }).mapHeight, 600);
}));

test('F8 런타임 설정(데이터 소스): 기동 때 읽기 오류면 원본 유지 · 변경 503 · 읽히면 저장된 소스로 돌아온다', () => quiet(async () => {
  put('runtime.json', { dataSource: 'mock' });
  const restore = asDir('runtime.json');
  const R = await fresh('runtime-settings.js');
  assert.equal(R.getDataSource(), 'live', '못 읽은 동안은 env 기본값(캐시하지 않는다)');
  const no = R.setDataSource('auto');
  assert.equal(no.ok, false); assert.equal(no.status, 503); assert.equal(no.code, 'settingsUnreadable');
  untouched('runtime.json');
  restore(); pass();
  assert.equal(R.getDataSource(), 'mock', '읽히면 화면에서 정한 소스(재시작 없이)');
  assert.equal(R.runtimeSettingsWriteRefusal(), null);
}));

test('F9 동작 설정 9종: 읽기 오류면 원본 유지 · 캐시 안 함 · 저장 거절(503) · 읽히면 원래 값', () => quiet(async () => {
  /** [파일, 씨앗, 모듈 얻기, 초기화, 값 읽기, 원래 값, 거절 함수, 저장 시도(던지거나 거절 본문)] */
  const CASES = [
    ['guest-partition.json', { threshold: 77 }, () => import('../src/guestpart/settings.js'), (M) => M.invalidate(), (M) => M.load().threshold, 77, (M) => M.guestPartWriteRefusal(), (M) => M.save({ threshold: 91 })],
    ['disk-bad-settings.json', { autoEnabled: true, intervalHours: 12 }, () => import('../src/diskbad/settings.js'), (M) => M._resetDiskBadSettingsForTest(), (M) => M.loadDiskBadSettings().autoEnabled, true, (M) => M.diskBadWriteRefusal(), (M) => M.saveDiskBadSettings({ autoEnabled: false })],
    ['os-scan.json', { enabled: true, intervalMin: 60, maxVms: 33 }, () => fresh('inventory/osScanner.js'), null, (M) => M.loadOsScanSettings().maxVms, 33, (M) => M.osScanWriteRefusal(), (M) => M.saveOsScanSettings({ maxVms: 10 })],
    ['login-monitor.json', { enabled: false, intervalMin: 7, days: 3, threshold: 9, windowMin: 11, alert: false }, () => fresh('security/loginMonitor.js'), null, (M) => M.loadLoginMonitor().threshold, 9, (M) => M.loginMonitorWriteRefusal(), (M) => M.saveLoginMonitor({ threshold: 3 })],
    ['daily-report.json', { enabled: true, hour: 7, minute: 30, snapshotAgeDays: 5, dsWarnPct: 90 }, () => import('../src/reports/dailyReport.js'), (M) => M._resetDailyReportForTest(), (M) => M.loadDailyReportSettings().hour, 7, (M) => M.dailyReportWriteRefusal(), (M) => M.saveDailyReportSettings({ hour: 9 })],
    ['finops.json', { tariffPerKwh: 999 }, () => fresh('insights/finops.js'), null, (M) => M.loadFinopsConfig().tariffPerKwh, 999, (M) => M.finopsWriteRefusal(), (M) => M.saveFinopsConfig({ pue: 2 })],
    ['power-off-check.json', { enabled: false, intervalHours: 24 }, () => import('../src/tools/powerOffSettings.js'), (M) => M._resetPowerOffSettingsCache(), (M) => M.loadPowerOffSettings().intervalHours, 24, (M) => M.powerOffWriteRefusal(), (M) => M.savePowerOffSettings({ intervalHours: 12 })],
    ['tool-categories.json', { enabled: true, showUncategorized: false, categories: [] }, () => import('../src/toolcats/settings.js'), (M) => M.invalidate(), (M) => M.load().showUncategorized, false, (M) => M.toolCatsWriteRefusal(), (M) => M.save({ enabled: false })],
    ['bareos-bundle-source.json', { baseUrl: '', importDir: '/data/bb' }, () => import('../src/bareos/install/bundleSource.js'), (M) => M._resetBundleSourceForTest(), (M) => M.getBundleSource().importDir, '/data/bb', (M) => M.bundleSourceWriteRefusal(), (M) => M.saveBundleSource({ importDir: '/data/x' })],
  ];
  for (const [name, seed, getMod, reset, value, want, refusal, save] of CASES) {
    put(name, seed);
    const restore = asDir(name);
    const M = await getMod();
    if (reset) reset(M);
    assert.notDeepEqual(value(M), want, `${name}: 못 읽은 동안은 기본값`);
    isRefusal(refusal(M), name);
    let refused = false;
    try { const r = save(M); refused = r?.status === 503 || r?.ok === false || fs.statSync(F(name)).isDirectory(); } catch (e) { refused = e?.status === 503; }
    assert.ok(refused, `${name}: 기본값 위에 저장하지 않는다`);
    untouched(name);
    restore();
    assert.notDeepEqual(value(M), want, `${name}: 간격(30초) 안에는 디스크를 다시 보지 않는다`);
    pass();
    assert.deepEqual(value(M), want, `${name}: 읽히면 원래 값(재시작 없이)`);
    assert.equal(refusal(M), null, name);
    // 손상은 예전처럼 보존본으로
    put(name, '{깨짐');
    const M2 = reset ? M : await getMod();
    if (reset) reset(M);
    value(M2);
    assert.equal(corruptOf(name).length, 1, `${name}: 손상은 예전처럼 보존`);
    if (reset) reset(M);
  }
}));

test('F10 게스트 파티션 · 디스크 점검 설정은 읽기 오류를 표지로도 싣는다(무음 금지) · Ping 설정은 마지막 값으로 돈다', () => quiet(async () => {
  const G = await import('../src/guestpart/settings.js');
  put('guest-partition.json', { threshold: 66 });
  G.invalidate();
  let restore = asDir('guest-partition.json');
  assert.match(String(G.settingsLoadError()), /읽기 오류\(EISDIR\)/);
  const r = G.save({ threshold: 91 });
  assert.equal(r.status, 503); assert.equal(r.code, 'settingsUnreadable'); assert.match(r.error, /읽기 오류/);
  restore(); pass();
  assert.equal(G.settingsLoadError(), null);
  G.invalidate();

  const D = await import('../src/diskbad/settings.js');
  put('disk-bad-settings.json', { autoEnabled: true, intervalHours: 12 });
  D._resetDiskBadSettingsForTest();
  restore = asDir('disk-bad-settings.json');
  assert.equal(D.diskBadSettingsLoadError()?.readError, true);
  restore(); pass();
  assert.equal(D.diskBadSettingsLoadError(), null);
  D._resetDiskBadSettingsForTest();

  const P = await import('../src/ping/settings.js');
  put('ping-settings.json', { probeIntervalMs: 2000, timeoutMs: 900 });
  P._resetPingSettingsForTest();
  assert.equal(P.loadPingSettings().probeIntervalMs, 2000);
  restore = asDir('ping-settings.json');   // mtime · 크기가 바뀌어 다시 읽는다 → EISDIR
  const s = P.loadPingSettings();
  assert.equal(s.probeIntervalMs, 2000, '마지막으로 읽은 값으로 돈다(env 기본값으로 뒤집히지 않는다)');
  assert.equal(s.loadError?.readError, true);
  assert.equal(P.savePingSettings({ timeoutMs: 800 }, { actor: 'adm' }).ok, false);
  untouched('ping-settings.json');
  restore(); pass();
  assert.equal(P.loadPingSettings().loadError, null);
  assert.equal(P.savePingSettings({ timeoutMs: 800 }, { actor: 'adm' }).ok, true, '읽히면 저장이 다시 열린다');
  P._resetPingSettingsForTest();
}));

test('F11 스토리지 사용량 메일: 설정 · 처리 기록 읽기 오류면 원본 유지 · 저장 409 · 정기 발송 멈춤(같은 회차 재발송 금지)', () => quiet(async () => {
  const M = await import('../src/storage/usageMail.js');
  M._resetForTest();
  put('storage-usage-mail.json', { enabled: false });
  let restore = asDir('storage-usage-mail.json');
  assert.equal(M.usageMailLoadError()?.readError, true);
  const r = M.saveUsageMailSettings({ enabled: true });
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.match(r.error, /읽기 오류이고 원본은 그대로/);
  untouched('storage-usage-mail.json');
  restore(); pass();
  assert.equal(M.usageMailLoadError(), null);

  M._resetForTest();
  put('storage-usage-mail-state.json', { lastSlot: 123, lastSentAt: 456, history: [] });
  restore = asDir('storage-usage-mail-state.json');
  assert.equal(M.usageMailLoadError()?.readError, true, '마지막 회차를 모르는 동안은 보내지 않는다');
  untouched('storage-usage-mail-state.json');
  restore(); pass();
  assert.equal(M.usageMailLoadError(), null);
  M._resetForTest();
}));

test('F12 점검 이력 · IP 변화 기록: 읽기 오류면 원본 유지 · 그동안 쓰지 않는다 · 읽히면 돌아온다', () => quiet(async () => {
  const S = await import('../src/storage/inspect/store.js');
  S._resetStoreForTest({ reload: true });
  put('storage-inspect-runs.json', { version: 1, at: 1, devices: {} });
  let restore = asDir('storage-inspect-runs.json');
  assert.match(String(S.inspectStoreLoadError()), /읽기 오류\(EISDIR\)/);
  assert.equal(S.inspectStoreStatus().devices, 0);
  const rr = S.recordRun('dev-1', { at: NOW - 1000, ms: 10, method: 'ssh', facts: {}, why: [], errors: [] });
  assert.equal(rr.saved, false, '못 읽은 이력 위에 쌓지 않는다(엣지는 ack 받지 못한 실행을 다시 보낸다)');
  S._flushStoreForTest();
  untouched('storage-inspect-runs.json');
  restore(); pass();
  assert.equal(S.inspectStoreLoadError(), null);
  S._resetStoreForTest({ reload: true });

  const C = await import('../src/ipam/changeLog.js');
  C._resetChangeLogForTest();
  C.appendChanges([{ type: 'new-ip', ip: '10.0.0.1' }]);
  C._flushChangeLogForTest();
  C._resetChangeLogForTest();
  restore = asDir('ipam-changes.json');
  assert.equal(C.listChanges({}).total, 0);
  assert.equal(C.changeLogReadError(), 'EISDIR');
  C.appendChanges([{ type: 'new-ip', ip: '10.0.0.2' }]);
  C._flushChangeLogForTest();
  untouched('ipam-changes.json');
  restore(); pass();
  assert.equal(C.listChanges({}).total, 1, '원본 기록이 돌아온다');
  assert.equal(C.changeLogReadError(), '');
  C._resetChangeLogForTest();
}));

test('F13 재해 복구 실행 상태: 읽기 오류면 원본 유지 · 실행기 멈춤 · 새 회차 거절 · 읽히면 이어 간다', () => quiet(async () => {
  const D = await import('../src/bareos/drRunner.js');
  D._resetDrRunsForTest();
  put('bareos-dr-runs.json', { runs: [] });
  const restore = asDir('bareos-dr-runs.json');
  assert.match(D.drRunsLoadError(), /읽기 오류 EISDIR.*원본은 그대로/);
  assert.throws(() => D.createRun({ vcenterId: 'vc-a', directorId: 'd1', by: 'adm', waves: [] }), (e) => e?.code === 'unavailable');
  assert.equal(await D.drTick(NOW), null, '못 읽은 동안은 걷지 않는다');
  untouched('bareos-dr-runs.json');
  restore(); pass();
  assert.equal(D.drRunsLoadError(), '', '읽히면 멈춤이 풀린다(손상과 달리 이 프로세스에 굳지 않는다)');
  D._resetDrRunsForTest();
}));

test('F14 집중 모니터링: 계속 수집 정의 · 엣지 키 · 점검 상태 — 읽기 오류면 원본 유지 · 읽히면 돌아온다', () => quiet(async () => {
  const F1 = await import('../src/focusmon/store.js');
  F1._resetForTest();
  put('focusmon-sessions.json', { v: 1, sessions: [{ id: 'fs-abcdef12', mode: 'record', by: 'adm', targets: ['fm-aaaaaa1', 'fm-bbbbbb2'], interval: 5, startedAt: NOW - 60_000 }] });
  put('focusmon-keys.json', { v: 1, edges: { 'edge-a': { agent: 'edge-a', at: 1, version: '3.0', key: null, keySeenAt: 0 } } });
  let restore = asDir('focusmon-sessions.json');
  const restoreK = asDir('focusmon-keys.json');
  assert.deepEqual(F1.listSessions(NOW), []);
  assert.equal(F1.sessionsReadError(), 'EISDIR');
  assert.deepEqual(F1.edgeStates(), []);
  // 못 읽은 동안 시작한 계속 수집 — 메모리에서는 돌고 정의 파일은 쓰지 않는다
  const st = F1.startSession({ targets: ['fm-bbbbbb2', 'fm-cccccc3'], mode: 'record', by: 'op' }, NOW);
  untouched('focusmon-sessions.json');
  untouched('focusmon-keys.json');
  restore(); restoreK(); pass();
  const all = F1.listSessions(NOW);
  const byId = Object.fromEntries(all.map((x) => [x.id, x.targets]));
  assert.deepEqual(byId['fs-abcdef12'], ['fm-aaaaaa1'], '파일의 계속 수집이 돌아온다 — 그동안 시작한 수집이 맡은 서버는 뺀다(서버는 수집 하나에만)');
  if (st?.session?.id || st?.id) assert.ok(all.length >= 2, '그동안 시작한 수집도 남는다');
  assert.equal(F1.sessionsReadError(), '');
  assert.equal(F1.edgeStates().length, 1);
  const saved = JSON.parse(fs.readFileSync(F('focusmon-sessions.json'), 'utf8'));
  assert.ok(saved.sessions.some((x) => x.id === 'fs-abcdef12'), '다시 읽힌 뒤에는 함께 쓴다(원본의 수집을 잃지 않는다)');
  F1._resetForTest();

  const A = await import('../src/focusmon/audit/service.js');
  A._resetForTest();
  put('focusmon-audit.json', { v: 1, ready: { 'fm-abcd12': { state: 'ready', at: 1 } }, jobs: [], lost: {} });
  restore = asDir('focusmon-audit.json');
  assert.match(A.auditStateError(), /읽기 오류\(EISDIR\)/);
  assert.equal(A.readinessOf('fm-abcd12'), null);
  untouched('focusmon-audit.json');
  restore(); pass();
  assert.equal(A.auditStateError(), '');
  assert.equal(A.readinessOf('fm-abcd12')?.state, 'ready', '그동안 메모리 상태가 바뀌지 않았으면 파일 상태로 돌아온다');
  // 못 읽은 동안 상태가 바뀌었으면(쓰기 시도) 바꿔 끼우지 않고 메모리로 계속 — 원본은 그대로
  A._resetForTest();
  restore = asDir('focusmon-audit.json');
  A.auditStateError();
  A.forgetTarget('fm-zzzz99');   // persist → 쓰지 않는다
  untouched('focusmon-audit.json');
  restore(); pass();
  assert.match(A.auditStateError(), /읽기 오류/, '진행 중 작업을 잃지 않게 이 프로세스는 메모리로 계속 돈다');
  assert.equal(JSON.parse(fs.readFileSync(F('focusmon-audit.json'), 'utf8')).ready['fm-abcd12'].state, 'ready', '원본은 그대로(재시작 때 읽는다)');
  A._resetForTest();
}));

test('F15 엣지 설정 사본(central-agent-config.json): 기동 때 읽기 오류면 원본 유지 · 받은 사본은 메모리에만 · 읽히면 합친다', () => quiet(async () => {
  put('central-agent-config.json', { 'edge-a': { at: 1, files: { 'a.json': '{}' } } });
  const restore = asDir('central-agent-config.json');
  const C = await fresh('central/agentConfig.js');
  assert.deepEqual(C.listAgentConfigs(), []);
  assert.equal(C.agentConfigUnread(), true);
  assert.equal(C.setAgentConfig('edge-b', { 'b.json': '{}' }).ok, true, '엣지 push 는 받는다(메모리)');
  untouched('central-agent-config.json');
  restore(); pass();
  assert.deepEqual(C.listAgentConfigs().map((x) => x.agent).sort(), ['edge-a', 'edge-b'], '파일의 사본 + 그동안 받은 사본');
  assert.equal(C.agentConfigUnread(), false);
}));

/** fs.readFileSync 에 EIO 를 주입한다(그 파일 이름만) — 파일은 그대로 있는 읽기 오류(권한 · 디스크). 쓰기는 실제로 성공할 수 있는 상태다. */
function withEio(name, fn) {
  const orig = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(fs, f, ...a); };
  try { return fn(); } finally { fs.readFileSync = orig; }
}
const raw = (n) => { const orig = fs.readFileSync; return orig.call(fs, F(n), 'utf8'); };

test('F16 파일이 그대로 있는 읽기 오류(EIO): 쓰기 길목이 빈 값 · 한 건짜리로 원본을 덮지 않는다', () => quiet(async () => {
  // 폴더(EISDIR) 재현은 원자 쓰기의 rename 도 실패해 '덮지 않음' 을 가리지 못한다 — 쓰기가 성공할 수 있는 상태에서 다시 본다.
  const B = await import('../src/svcmon/batches.js');
  B._resetBatchCache();
  const rec = B.recordBatch({ source: 'test', targets: 2 });
  B._resetBatchCache();
  let before = raw('svcmon-batches.json');
  withEio('svcmon-batches.json', () => { B.recordBatch({ source: 'test', targets: 1 }); B.deleteBatchRecord(rec.id); });
  assert.equal(raw('svcmon-batches.json'), before, '배치 원장: 못 읽은 동안 한 건짜리 원장을 쓰지 않는다');
  B._resetBatchCache();

  const S = await import('../src/storage/inspect/store.js');
  put('storage-inspect-runs.json', { version: 1, at: 1, devices: { 'dev-keep': [{ at: 1000, ms: 1, method: 'ssh', facts: {}, why: [], errors: [] }] } });
  S._resetStoreForTest({ reload: true });
  before = raw('storage-inspect-runs.json');
  withEio('storage-inspect-runs.json', () => { S.recordRun('dev-1', { at: NOW - 1000, ms: 10, method: 'ssh', facts: {}, why: [], errors: [] }); S._flushStoreForTest(); });
  assert.equal(raw('storage-inspect-runs.json'), before, '점검 이력: 빈 이력으로 원본을 덮지 않는다');
  S._resetStoreForTest({ reload: true });

  const F1 = await import('../src/focusmon/store.js');
  F1._resetForTest();
  put('focusmon-sessions.json', { v: 1, sessions: [{ id: 'fs-abcdef12', mode: 'record', by: 'adm', targets: ['fm-aaaaaa1'], interval: 5, startedAt: NOW - 60_000 }] });
  before = raw('focusmon-sessions.json');
  withEio('focusmon-sessions.json', () => { F1.startSession({ targets: ['fm-cccccc3'], mode: 'record', by: 'op' }, NOW); });
  assert.equal(raw('focusmon-sessions.json'), before, '계속 수집 정의: 그동안 시작한 수집만 든 파일로 덮지 않는다');
  F1._resetForTest();

  const A = await import('../src/focusmon/audit/service.js');
  A._resetForTest();
  put('focusmon-audit.json', { v: 1, ready: { 'fm-abcd12': { state: 'ready', at: 1 } }, jobs: [], lost: {} });
  before = raw('focusmon-audit.json');
  withEio('focusmon-audit.json', () => { A.forgetTarget('fm-zzzz99'); });
  assert.equal(raw('focusmon-audit.json'), before, '점검 상태: 빈 상태로 원본을 덮지 않는다');
  A._resetForTest();

  put('os-scan.json', { enabled: true, intervalMin: 60, maxVms: 33 });
  const O = await fresh('inventory/osScanner.js');
  before = raw('os-scan.json');
  withEio('os-scan.json', () => { O.saveOsScanSettings({ maxVms: 10 }); });
  assert.equal(raw('os-scan.json'), before, 'OS 스캔 설정: 기본값(꺼짐) 위에 쓰지 않는다');

  const D = await import('../src/reports/dailyReport.js');
  put('daily-report.json', { enabled: true, hour: 7, minute: 30 });
  D._resetDailyReportForTest();
  before = raw('daily-report.json');
  withEio('daily-report.json', () => { try { D.saveDailyReportSettings({ hour: 9 }); } catch { /* 503 */ } });
  assert.equal(raw('daily-report.json'), before);
  D._resetDailyReportForTest();

  const R = await import('../src/rma/settings.js');
  put('rma-settings.json', { version: 1, defaultMode: 'active-backup', agents: { 'edge-a': { allowedIps: ['10.1.1.0/24'] } } });
  R._resetRmaSettings();
  before = raw('rma-settings.json');
  withEio('rma-settings.json', () => { try { R.setAgentAccess('edge-b', { allowedIps: ['10.2.2.2'] }); } catch { /* 503 */ } });
  assert.equal(raw('rma-settings.json'), before, 'RMA 접속 허용 IP: 한 법인만 든 파일로 덮지 않는다');
  R._resetRmaSettings();

  const H = await import('../src/hostaccess/settings.js');
  put('host-access.json', { draft: {}, applied: { at: 1, fingerprint: 'fp-1', rich: [] }, pending: null });
  H._resetHostAccessCache();
  before = raw('host-access.json');
  withEio('host-access.json', () => { try { H.saveHostAccess({ pending: null }); } catch { /* 503 */ } });
  assert.equal(raw('host-access.json'), before, '호스트 접근 제어: 적용 기록을 잃지 않는다');
  H._resetHostAccessCache();
}));

test('스윕: 107회차에 고친 파일의 catch 가 읽기 오류를 다시 손상 보존으로 보내지 않는다', () => {
  const FIXED = ['attach/store.js', 'bareos/drRunner.js', 'bareos/install/bundleSource.js', 'central/agentConfig.js', 'diskbad/settings.js', 'focusmon/audit/service.js', 'focusmon/store.js',
    'guestpart/settings.js', 'hostaccess/settings.js', 'insights/finops.js', 'inventory/osScanner.js', 'ipam/changeLog.js', 'ipam/rangePolicies.js', 'ipam/settings.js', 'issues/inbox.js',
    'llm/config.js', 'ping/settings.js', 'reports/dailyReport.js', 'rma/settings.js', 'runtime-settings.js', 'security/loginMonitor.js', 'sshaccess/installed.js', 'storage/inspect/store.js',
    'storage/usageMail.js', 'svcmon/batches.js', 'toolcats/settings.js', 'tools/powerOffSettings.js', 'ui-settings.js', 'usermenu/store.js', 'wiki/userState.js'];
  const bad = [];
  for (const rel of FIXED) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.match(s, /makeJsonFileReader\(/, `${rel}: 공용 읽기를 써야 한다`);
    // 원본을 직접 읽는 readFileSync 가 남아 있으면(설정 · 상태 파일) 읽기 오류가 다시 catch 하나로 간다
    for (const m of s.matchAll(/\b(?:preserveCorrupt|backupCorrupt)\(/g)) {
      const c = s.lastIndexOf('catch', m.index);
      const t = c >= 0 ? s.lastIndexOf('try', c) : -1;
      if (t >= 0 && /\bfs\.readFileSync\(/.test(s.slice(t, c))) bad.push(`${rel}:${s.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], '읽기(readFileSync)와 parse 를 한 try 에 두고 그 catch 에서 손상 보존을 부르면 읽기 오류도 원본을 옮긴다');
});

test('스윕: 저장 라우트는 저장 함수보다 먼저 읽기 오류 거절(503)을 본다 — 전역 오류 처리기는 사유를 싣지 않는다', () => {
  /** [라우트 파일, 거절 함수, 저장 호출] */
  const ROUTES = [
    ['routes/api/rma.js', 'rmaSettingsWriteRefusal', 'setAgentAccess(agent,'], ['routes/api/rma.js', 'rmaSettingsWriteRefusal', 'setAgentRemote(agent,'],
    ['routes/api/rma.js', 'rmaSettingsWriteRefusal', 'setAgentMode(agent,'], ['routes/api/rma.js', 'rmaSettingsWriteRefusal', 'setDefaultMode(String('],
    ['routes/admin/hostAccess.js', 'hostAccessWriteRefusal', 'saveDraft(req.body'], ['routes/admin/hostAccess.js', 'hostAccessWriteRefusal', 'await applyHostAccess('], ['routes/admin/hostAccess.js', 'hostAccessWriteRefusal', 'await confirmHostAccess('],
    ['routes/api/ipamExport.js', 'rangePoliciesWriteRefusal', 'setPolicy(req.body || {}, req.user)'], ['routes/api/ipamExport.js', 'rangePoliciesWriteRefusal', 'deletePolicy(req.params.id)'],
    ['routes/admin/centralIpam.js', 'ipamSettingsWriteRefusal', 'saveIpamSettings(body)'],
    ['routes/admin/deployLlm.js', 'llmConfigWriteRefusal', 'saveLlmConfig(req.body'], ['routes/api/toolsInfo.js', 'uiSettingsWriteRefusal', 'res.json(saveUiSettings('],
    ['routes/admin/backupNetSec.js', 'loginMonitorWriteRefusal', 'res.json(saveLoginMonitor('], ['routes/admin/opsSettings.js', 'osScanWriteRefusal', 'settings: saveOsScanSettings('],
    ['routes/admin/opsSettings.js', 'dailyReportWriteRefusal', 'const s = saveDailyReportSettings('], ['routes/api/toolsCapacity.js', 'powerOffWriteRefusal', 'savePowerOffSettings(kg.patch)'],
    ['routes/admin/toolCategories.js', 'toolCatsWriteRefusal', 'saveCfg(body, info)'], ['routes/api/diskBad.js', 'diskBadWriteRefusal', 'next = saveDiskBadSettings(patch)'],
    ['routes/api/bareosInstall.js', 'bundleSourceWriteRefusal', 'saveBundleSource(body)'], ['routes/insights.js', 'finopsWriteRefusal', 'saveFinopsConfig(req.body'],
  ];
  for (const [rel, fn, call] of ROUTES) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    const at = s.indexOf(call);
    assert.ok(at > 0, `${rel}: ${call}`);
    const before = s.slice(Math.max(0, at - 1200), at);
    assert.match(before, new RegExp(`const no = ${fn}\\(\\); if \\(no\\) return res\\.status\\(503\\)\\.json\\(no\\);`), `${rel}: ${call} 앞에 ${fn} 사전 검사가 있어야 한다`);
  }
  // 저장 함수가 거절 본문 · 상태를 돌려주는 라우트는 그 상태(503)와 code 를 응답에 싣는다
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/vcenters.js'), 'utf8')), /result\.status === 503 \? 503 : 400/);
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes/api/toolsGuestPart.js'), 'utf8')), /r\.status === 503 \? 503 : 400[\s\S]{0,160}code: r\.code/);
  assert.match(stripComments(fs.readFileSync(path.join(SRC, 'routes/api/userMenu.js'), 'utf8')), /e\.readError === true && e\.code \? \{ code: e\.code/);
});
