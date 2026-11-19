/**
 * test/rebut91.test.js — 전체 점검 91회차(88 · 89 · 90회차 수정 반증 + 남긴 결정 권장안) 회귀.
 *
 *  89 ⓑ 증분 수집 세션(updateSession) — 여는 동안 데드라인 신호를 몰랐고 맵에 없어, 다음 주기가 세션을 하나 더 열고 늦게 끝난 옛 열기의 실패 처리가
 *       새 세션을 맵에서 지워 그 세션이 로그아웃 없이 남았다(재현) → 신호를 로그인부터 · '여는 중' 표지 · 맵 자리가 자기 것일 때만 바꿈 · 수집기 생성 실패도 로그아웃.
 *  89 ⓐ 연결 테스트(vCenter · NSX · iDRAC · Horizon)가 body.username(· 주소 · 도메인)이 저장값과 달라도 저장 비밀번호를 물려받았다 → 저장 경로(secretCarry)와 같은 판정.
 *  89 ⓒ SOAP 데이터스토어 용량을 못 읽으면 0 → null(REST 와 같은 규칙).
 *  88 ③ 긴급중단 파일을 한 번도 못 읽은 읽기 오류 동안은 멈춤 쪽(fail-closed) · 상태에 사유.
 *  88 ④ 장비 신뢰 정책 observe(약화)는 소유자 + 본인 OTP · enforce(강화)는 OTP 없이.
 *  88 남긴 것 ① 복원이 peer-trust.json 의 enforce · 회수한 지문을 되돌리지 않는다 · 88 F6/F7 형제 — 세션 보안 · 자격증명 정책 파일도 지금 파일 읽기 오류면 적용하지 않는다.
 *  88 ⓓ PUT /security/session 저장 예외의 상태(503)를 400 으로 바꾸지 않는다 · 88 ⑤ 사용자 삭제가 사용자별 도구 재정의도 지운다.
 *  90 ⓐ Horizon 전체 추이 — 같은 사유로 연속 N주기 실패한 서버는 부분 합 판정에서 뺀다(현재 사용자와 같은 규칙 한 벌).
 *
 * ⚠ 기준 시각은 실제 시각을 정시로 떨어뜨린 T0(고정 epoch · Date.now() 직접 금지 — docs/rules/common.md).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('rebut91-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_SECRET = 'rebut91-secret-0123456789abcdef0123456789abcdef';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'adm2', role: 'admin', totpEnabled: true, totpSecret: generateSecret() },
  { username: 'bob', role: 'viewer', passwordHash: 'x' },
] }));
fs.writeFileSync(path.join(DIR, 'settings-owners.txt'), 'adm\n');

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const jfr = await import('../src/util/jsonFileRead.js');
let clock = T0;
jfr._setJsonFileLoadClockForTest(() => clock);
after(() => jfr._setJsonFileLoadClockForTest());

/** 그 파일의 readFileSync 만 EIO 로 던진다. 돌려준 함수로 되돌린다. */
function eioOn(file) {
  const orig = fs.readFileSync;
  fs.readFileSync = function patched(p, ...a) {
    if (path.resolve(String(p)) === path.resolve(file)) { const e = new Error(`EIO: i/o error, read '${file}'`); e.code = 'EIO'; throw e; }
    return orig.call(this, p, ...a);
  };
  return () => { fs.readFileSync = orig; };
}
/** 30초 경계에서 떨어뜨린 TOTP 단계(검증 창 ±1 안) — 경계 15초 안이면 다음 단계까지 기다린다. */
async function freshCounter() {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 50));
  return Math.floor(Date.now() / 30_000);
}

// ── 89 ⓑ 증분 수집 세션 — 여는 동안 겹친 주기 ─────────────────────────────────────
test('89 ⓑ 여는 중인 세션이 데드라인을 넘겨도 세션이 새지 않는다 · 다음 주기는 여는 중이면 전체 조회로', async () => {
  const { inventoryViaUpdates, closeAllUpdateSessions } = await import('../src/vcenter/updateSession.js');
  const live = new Set(); let seq = 0; const gates = []; const calls = [];
  const gated = new Set([1]);
  const makeClient = () => {
    const id = ++seq; const c = { id, signal: null, sc: { propertyCollector: 'pc', viewManager: 'vm', rootFolder: 'g' } };
    c.login = async () => { if (gated.has(id)) await new Promise((r) => gates.push(r)); live.add(id); };
    c.logout = async () => { live.delete(id); };
    c.callRaw = async (body, { ignoreExternal } = {}) => {
      if (!ignoreExternal && c.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      calls.push(`${id}:${/<(\w+) xmlns/.exec(body)?.[1]}`);
      if (body.includes('CreatePropertyCollector')) return `<returnval type="PropertyCollector">pc${id}</returnval>`;
      if (body.includes('CreateContainerView')) return '<returnval type="ContainerView">v</returnval>';
      if (body.includes('CreateFilter')) return '<returnval type="PropertyFilter">f</returnval>';
      return '';
    };
    return c;
  };
  const vc = { id: 'vc-91b', host: 'https://a', username: 'u', password: 'p' };
  const T = ['VirtualMachine']; const S = [{ type: 'VirtualMachine', paths: ['name'] }];
  const ac1 = new AbortController();
  const p1 = inventoryViaUpdates(vc, T, S, { makeClient, signal: ac1.signal, now: T0 }).then(() => 'ok', (e) => `err:${e.message}`);
  await new Promise((r) => setTimeout(r, 5));
  ac1.abort();   // 수집 데드라인
  const r2 = await inventoryViaUpdates(vc, T, S, { makeClient, signal: new AbortController().signal, now: T0 + 30_000 }).then(() => 'ok', (e) => `err:${e.message}`);
  assert.match(r2, /여는 중/, '앞 주기의 열기가 끝나지 않았으면 이 주기는 세션을 하나 더 열지 않는다(전체 조회로)');
  gates.shift()();
  assert.match(await p1, /^err:/);
  assert.deepEqual([...live], [], '데드라인을 넘긴 열기의 세션은 로그아웃된다(남는 세션 없음)');
  assert.deepEqual(calls.filter((c) => c.startsWith('1:')), [], '데드라인 신호가 로그인부터 실려 끊긴 열기는 수집기 · 뷰 · 필터를 만들지 않는다');
  // 다음 주기는 새로 열고 정상으로 돈다
  const r3 = await inventoryViaUpdates(vc, T, S, { makeClient, signal: new AbortController().signal, now: T0 + 60_000 }).then(() => 'ok', (e) => `err:${e.message}`);
  assert.equal(r3, 'ok');
  assert.equal(live.size, 1);
  await closeAllUpdateSessions();
  assert.equal(live.size, 0);
});

test('89 ⓑ 로그인 뒤 수집기 생성이 실패해도 로그아웃한다 · 맵의 다른 세션을 지우지 않는다', async () => {
  const { inventoryViaUpdates, closeAllUpdateSessions, updateSessionStatus } = await import('../src/vcenter/updateSession.js');
  const live = new Set(); let seq = 0;
  const makeClient = () => {
    const id = ++seq; const c = { id, signal: null, sc: { propertyCollector: 'pc', viewManager: 'vm', rootFolder: 'g' } };
    c.login = async () => { live.add(id); };
    c.logout = async () => { live.delete(id); };
    c.callRaw = async (body) => {
      if (body.includes('CreatePropertyCollector')) { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; }
      return '';
    };
    return c;
  };
  const vc = { id: 'vc-91b2', host: 'https://b', username: 'u', password: 'p' };
  const r = await inventoryViaUpdates(vc, ['VirtualMachine'], [{ type: 'VirtualMachine', paths: ['name'] }], { makeClient, now: T0 }).then(() => 'ok', (e) => `err:${e.message}`);
  assert.match(r, /socket hang up/);
  assert.deepEqual([...live], [], '로그인한 세션이 남지 않는다');
  assert.ok(updateSessionStatus().sessions['vc-91b2']?.failUntil, '열기 실패(데드라인 아님)는 예전처럼 쉰다');
  await closeAllUpdateSessions();
});

// ── 89 ⓐ 연결 테스트 — 저장 비밀번호 승계 판정 ───────────────────────────────────
test('89 ⓐ vCenter 연결 테스트 — 계정명 · 주소가 저장값과 다르면 저장 비밀번호를 쓰지 않고 인증 정지도 풀지 않는다', async () => {
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc1', name: 'VC1', host: 'https://127.0.0.1:1', username: 'svc', password: 'Saved-PW-91', location: { region: 'APAC' } }] }));
  const reg = await import('../src/vcenter/registry.js');
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const saved = reg.loadRegistry().find((v) => v.id === 'vc1');
  vcAuthGuard.markAuthStopped('vc1', saved, 'test stop');
  const a = await reg.testConnection({ id: 'vc1', username: 'other-admin' });
  assert.equal(a.ok, false); assert.equal(a.reason, reg.CARRY_MOVED_REASON);
  const b = await reg.testConnection({ id: 'vc1', host: 'https://evil.example', username: 'svc' });
  assert.equal(b.reason, reg.CARRY_MOVED_REASON);
  const c = await reg.testConnection({ id: 'vc1', username: 'other-admin' }, { pinSavedHost: true });
  assert.equal(c.reason, reg.CARRY_MOVED_REASON, '범위 관리자 경로(pinSavedHost)도 같다');
  assert.ok(vcAuthGuard.authStopFor(saved), '다른 계정명 시험으로 저장 계정의 인증 정지가 풀리지 않는다');
  // 같은 계정 · 주소면 예전처럼 저장 비밀번호로 시험한다(여기서는 닫힌 포트라 실패 — 승계 거절 사유가 아니다)
  const d = await reg.testConnection({ id: 'vc1', host: 'https://127.0.0.1:1', username: 'SVC ' });
  assert.equal(d.ok, false); assert.notEqual(d.reason, reg.CARRY_MOVED_REASON);
  // 비밀번호를 새로 주면 계정명이 달라도 시험한다(승계가 아니다)
  const e = await reg.testConnection({ id: 'vc1', username: 'other-admin', password: 'typed' });
  assert.notEqual(e.reason, reg.CARRY_MOVED_REASON);
});

test('89 ⓐ 형제 — NSX · iDRAC · Horizon 연결 테스트도 같은 판정(iDRAC 은 저장과 같은 정규화 주소로 비교)', async () => {
  fs.writeFileSync(path.join(DIR, 'nsx.json'), JSON.stringify({ managers: [{ id: 'n1', name: 'N1', host: 'https://127.0.0.1', username: 'admin', password: 'Saved-NSX' }] }));
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'i1', name: 'I1', host: 'https://127.0.0.1', username: 'root', password: 'Saved-IDRAC', type: 'idrac' }] }));
  fs.writeFileSync(path.join(DIR, 'horizon.json'), JSON.stringify({ servers: [{ id: 'h1', name: 'H1', host: 'https://127.0.0.1', username: 'hzadmin', password: 'Saved-HZ', domain: 'CORP' }] }));
  const nsx = await import('../src/nsx/registry.js');
  const idrac = await import('../src/idrac/registry.js');
  const hz = await import('../src/horizon/horizon.js');
  const MOVED = /저장값과 달라 저장된 비밀번호를 쓰지 않습니다/;
  assert.match((await nsx.testConnection({ id: 'n1', username: 'other' })).reason, MOVED);
  assert.match((await nsx.testConnection({ id: 'n1', host: 'https://evil.example' })).reason, MOVED);
  assert.doesNotMatch(String((await nsx.testConnection({ id: 'n1', username: 'admin' })).reason), MOVED);
  assert.match((await idrac.testServer({ id: 'i1', username: 'other' })).reason, MOVED);
  assert.match((await idrac.testServer({ id: 'i1', host: '10.9.9.9' })).reason, MOVED);
  assert.doesNotMatch(String((await idrac.testServer({ id: 'i1', host: '127.0.0.1/', username: 'root' })).reason), MOVED, '스킴 없는 같은 주소는 이동이 아니다(저장과 같은 정규화)');
  assert.match((await hz.testHorizon({ id: 'h1', username: 'other' })).reason, MOVED);
  assert.match((await hz.testHorizon({ id: 'h1', domain: 'OTHER' })).reason, MOVED, 'Horizon 은 도메인도 신원이다(저장 경로와 같다)');
  assert.doesNotMatch(String((await hz.testHorizon({ id: 'h1', host: '127.0.0.1', username: 'hzadmin', domain: 'corp' })).reason), MOVED);
});

// ── 89 ⓒ SOAP 데이터스토어 용량 ───────────────────────────────────────────────
test('89 ⓒ SOAP 데이터스토어 — 용량을 못 읽으면 0 이 아니라 null(여유 · 사용량도) · 보고된 값은 그대로', async () => {
  const { soapDatastoreSpace } = await import('../src/vcenter/soapClient.js');
  const GB = 1024 ** 3;
  assert.deepEqual(soapDatastoreSpace({ 'summary.capacity': String(2048 * GB), 'summary.freeSpace': String(512 * GB) }), { capacityGB: 2048, freeGB: 512, usedGB: 1536, usagePct: 75 });
  for (const cap of [undefined, '', null, 'abc']) {
    assert.deepEqual(soapDatastoreSpace({ 'summary.capacity': cap, 'summary.freeSpace': String(5 * GB) }), { capacityGB: null, freeGB: null, usedGB: null, usagePct: null }, `capacity=${cap}`);
  }
  assert.deepEqual(soapDatastoreSpace({ 'summary.capacity': '0', 'summary.freeSpace': '0' }), { capacityGB: 0, freeGB: 0, usedGB: 0, usagePct: null }, '보고된 0 은 값이다');
  assert.equal(soapDatastoreSpace({ 'summary.capacity': String(10 * GB) }).freeGB, null, '여유를 못 읽으면 예전처럼 null(v2.598)');
  const { dsUsageUnknownOf } = await import('../src/store.js');
  assert.equal(dsUsageUnknownOf({ ...soapDatastoreSpace({}) }), true, '용량 미상 DS 는 사용량 미상으로 센다(예전 0 은 빠졌다)');
});

// ── 88 ③ 긴급중단 읽기 오류 fail-closed ─────────────────────────────────────────
test('88 ③ 긴급중단 파일을 한 번도 못 읽은 읽기 오류 동안은 멈춤 쪽 · 상태에 사유 · 읽히면 저장된 상태(꺼짐이면 재개)', async () => {
  const es = await import('../src/security/emergencyStop.js');
  const file = path.join(DIR, 'emergency-stop.json');
  fs.writeFileSync(file, JSON.stringify({ active: false, by: [], at: T0 }));
  es._resetEmergencyStopForTest();
  const undo = eioOn(file);
  try {
    clock += 1;
    assert.equal(es.isStopped(), true, '읽지 못하는 동안은 멈춤');
    const st = es.getEmergencyStatus();
    assert.equal(st.active, true); assert.equal(st.readError?.code, 'EIO'); assert.equal(st.readError?.failClosed, true);
  } finally { undo(); }
  clock += 31_000;
  assert.equal(es.isStopped(), false, '읽히는 순간 저장된 상태(꺼짐)로 돌아간다');
  assert.equal(es.getEmergencyStatus().readError, undefined);
  // 이미 읽은 값은 그 뒤 읽기 오류에도 그대로(마지막 값 — 캐시)
  es.setEmergencyStop(true, ['adm', 'adm2']);
  const undo2 = eioOn(file);
  try { clock += 1; assert.equal(es.isStopped(), true); } finally { undo2(); }
  es.setEmergencyStop(false, ['adm', 'adm2']);
  assert.equal(es.isStopped(), false);
});

// ── 88 ③ 복원 — 지금 파일 읽기 오류 · peer-trust 켜기만 ───────────────────────────
test('88 남긴 것 ① 복원 — peer-trust.json 은 enforce · 회수한 지문을 되돌리지 않고 이후 항목은 남긴다', async () => {
  const { reconcilePeerTrustText } = await import('../src/backup/stagedRestore.js');
  const FP_A = `SHA256:${'A'.repeat(43)}`; const FP_B = `SHA256:${'B'.repeat(43)}`; const FP_C = `SHA256:${'C'.repeat(43)}`;
  const backup = { v: 1, policy: { ssh: 'observe', tls: 'observe' }, origin: { ssh: { origin: 'upgrade-migration' } },
    entries: [
      { kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_A, state: 'approved' }, trustedMore: [{ fp: FP_B, state: 'approved' }] },
      { kind: 'ssh', host: '10.0.0.6', port: 22, trusted: { fp: FP_C, state: 'observed' } },
    ] };
  const current = { v: 1, policy: { ssh: 'enforce', tls: 'observe' }, origin: { ssh: { origin: 'admin', at: T0 } },
    entries: [
      { kind: 'ssh', host: '10.0.0.5', port: 22, trusted: { fp: FP_B, state: 'approved' }, rejected: [{ fp: FP_A, at: T0, by: 'adm' }] },
      { kind: 'ssh', host: '10.0.0.7', port: 22, trusted: { fp: FP_C, state: 'approved' } },
    ] };
  const r = reconcilePeerTrustText(JSON.stringify(backup), JSON.stringify(current));
  const out = JSON.parse(r.text);
  assert.equal(out.policy.ssh, 'enforce', '지금 enforce 면 enforce(켜기만)');
  assert.equal(out.policy.tls, 'observe', '지금도 observe 면 백업 그대로');
  assert.deepEqual(r.keptPolicy, ['ssh']);
  const e5 = out.entries.find((e) => e.host === '10.0.0.5');
  assert.equal(e5.trusted.fp, FP_B, '회수한 지문 A 는 신뢰 목록에서 빠진다');
  assert.equal(e5.trustedMore, undefined);
  assert.ok(e5.rejected.some((x) => x.fp === FP_A), '거부 기록은 남긴다');
  assert.equal(r.keptRevoked, 1);
  assert.ok(out.entries.some((e) => e.host === '10.0.0.6'), '백업 항목은 복원한다');
  assert.ok(out.entries.some((e) => e.host === '10.0.0.7'), '백업 이후 생긴 항목은 남긴다');
  // 지금 파일이 없으면(재해 복구) 백업 그대로
  assert.equal(reconcilePeerTrustText(JSON.stringify(backup), null).text, JSON.stringify(backup));
  // 로더가 받아 enforce 로 판정하는지(실제 모듈 — 복원 결과 파일로)
  const d2 = tmpDir('rebut91-pt-');
  fs.writeFileSync(path.join(d2, 'peer-trust.json'), r.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d2, 'peer-trust.json'), 'utf8')).policy.ssh, 'enforce');
});

test('88 F6/F7 형제 — 세션 보안 · 자격증명 정책 · 장비 신뢰 파일은 지금 파일 읽기 오류면 복원 적용하지 않는다(없음만 기본/백업)', async () => {
  const { reconcileForApply } = await import('../src/backup/stagedRestore.js');
  const d = tmpDir('rebut91-rc-');
  // 읽기 오류 흉내: 같은 이름의 폴더(EISDIR)
  for (const name of ['security-session.json', 'secrets-policy.json', 'secrets-policy.trusted.json', 'peer-trust.json']) fs.mkdirSync(path.join(d, name));
  const weakSession = JSON.stringify({ loginPolicy: 'password_only', singleSession: false });
  assert.throws(() => reconcileForApply('security-session.json', weakSession, d), /읽지 못해\(EISDIR\)/);
  assert.throws(() => reconcileForApply('secrets-policy.json', JSON.stringify({ mode: 'plain' }), d), /읽지 못해/);
  assert.throws(() => reconcileForApply('secrets-policy.trusted.json', JSON.stringify({ mode: 'plain' }), d), /읽지 못해/);
  assert.throws(() => reconcileForApply('peer-trust.json', JSON.stringify({ v: 1, policy: { ssh: 'observe' }, entries: [] }), d), /읽지 못해/);
  // 없음(ENOENT)은 예전 그대로 — 세션 보안은 기본값(엄격)과 견주고, 정책은 백업 그대로
  const e = tmpDir('rebut91-rc2-');
  const rs = reconcileForApply('security-session.json', weakSession, e);
  assert.equal(JSON.parse(rs.content).loginPolicy, null, '없음이면 기본(레거시)보다 약하게 되돌리지 않는다(예전 규칙)');
  assert.equal(reconcileForApply('secrets-policy.json', JSON.stringify({ mode: 'plain' }), e).content, JSON.stringify({ mode: 'plain' }));
  // 지금 파일이 읽히고 더 강하면 지금 값(예전 규칙 그대로)
  fs.writeFileSync(path.join(e, 'security-session.json'), JSON.stringify({ loginPolicy: 'otp_only' }));
  assert.equal(JSON.parse(reconcileForApply('security-session.json', weakSession, e).content).loginPolicy, 'otp_only');
});

// ── 88 ⑤ 사용자 삭제 → 도구 재정의 정리 ──────────────────────────────────────────
test('88 ⑤ 사용자 삭제가 그 계정의 사용자별 도구 재정의도 지운다(같은 이름 재생성 · AD 세션에 옛 제한이 남지 않게)', async () => {
  const perm = await import('../src/auth/permissions.js');
  const auth = await import('../src/auth/auth.js');
  const set = perm.setUserTools('bob', { mode: 'deny', tools: ['vm-finder'], by: 'adm' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.ok(Object.hasOwn(perm.userToolOverrides(), 'bob'));
  const del = auth.deleteUser('bob', { trusted: true });
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.equal(del.toolOverrideCleared, true);
  assert.equal(Object.hasOwn(perm.userToolOverrides(), 'bob'), false);
});

// ── HTTP — 88 ④ peer-trust observe OTP · 88 ⓓ 세션 보안 저장 503 ────────────────
let srvHttp, base;
const USERS = { adm: { username: 'adm', role: 'admin', scope: null } };
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: Date.now(), source: 'live', vcenters: [{ id: 'vc1', name: 'VC1' }], hosts: [], datastores: [], vms: [], alarms: [], networks: [] };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  srvHttp = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srvHttp.address().port}/api`;
});
after(() => { try { srvHttp?.close(); } catch { /* */ } });
async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j };
}

test('88 ④ 장비 신뢰 — observe(약화)는 본인 OTP 없으면 403 · enforce(강화)는 OTP 없이', async () => {
  const pt = await import('../src/security/peerTrust.js');
  // 앞 시험이 등록부를 만들어 '기존 현장'(observe)일 수 있다 — enforce 로 닫는 것은 OTP 를 묻지 않는다
  const close = await call('adm', 'PUT', '/admin/security/peer-trust/policy', { kind: 'ssh', mode: 'enforce' });
  assert.equal(close.s, 200, JSON.stringify(close.j));
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
  const noOtp = await call('adm', 'PUT', '/admin/security/peer-trust/policy', { kind: 'ssh', mode: 'observe' });
  assert.equal(noOtp.s, 403); assert.equal(noOtp.j.code, 'otp-required');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce', '거절되면 바뀌지 않는다');
  const bad = await call('adm', 'PUT', '/admin/security/peer-trust/policy', { kind: 'ssh', mode: 'observe', otp: '000000' });
  assert.equal(bad.s, 403);
  const ctr = await freshCounter();
  const ok = await call('adm', 'PUT', '/admin/security/peer-trust/policy', { kind: 'ssh', mode: 'observe', otp: generateToken(SECRET, { counter: ctr }) });
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  assert.equal(pt.getPeerPolicy('ssh').mode, 'observe');
  const back = await call('adm', 'PUT', '/admin/security/peer-trust/policy', { kind: 'ssh', mode: 'enforce' });
  assert.equal(back.s, 200, 'enforce 로 닫는 것은 OTP 를 묻지 않는다');
  assert.equal(pt.getPeerPolicy('ssh').mode, 'enforce');
});

test('88 ⓓ 세션 보안 저장 — 파일 읽기 오류 중 거절은 503(400 아님) · 사유 · code', async () => {
  const sec = await import('../src/security/securitySettings.js');
  const file = path.join(DIR, 'security-session.json');
  fs.writeFileSync(file, JSON.stringify({ settingsOwners: ['adm'], idleLogoutMin: 15 }));
  sec._resetSessionSecurityReadForTest();
  sec.loadConfiguredSecurity();
  const undo = eioOn(file);
  try {
    clock += 1;
    const ctr = await freshCounter();
    const r = await call('adm', 'PUT', '/admin/security/session', { idleLogoutMin: 20, otp: generateToken(SECRET, { counter: ctr + 1 }) });
    assert.equal(r.s, 503, JSON.stringify(r.j));
    assert.equal(r.j.code, 'settings-unreadable');
    assert.match(r.j.reason, /읽지 못하는 상태/);
  } finally { undo(); }
  clock += 31_000;
  assert.equal(sec.loadConfiguredSecurity().idleLogoutMin, 15, '원본은 그대로');
});

// ── 90 ⓐ Horizon 전체 추이 — 영구 실패 제외 ──────────────────────────────────────
test('90 ⓐ Horizon 전체 추이 — 같은 사유로 N주기 연속 실패한 서버는 부분 합 판정에서 빠진다 · 막 실패한 서버는 예전처럼 보류', async () => {
  const { hzTrendTotal } = await import('../src/horizon/sessionPoller.js');
  const { combineServers } = await import('../src/horizon/sessions.js');
  const { PERSISTENT_FAIL_CYCLES } = await import('../src/curuser/aggregate.js');
  const okRec = { serverId: 's1', ok: true, kind: 'ok', users: 3, usersConnected: 2, sessions: 4, connected: 3, disconnected: 1, pending: 0, stateUnknown: 0, names: [{ name: 'a', sessions: 2, connected: 2 }, { name: 'b', sessions: 1, connected: 1 }, { name: 'c', sessions: 1, connected: 0 }] };
  const stopped = { serverId: 's2', ok: false, kind: 'auth-stopped', names: [] };
  const fresh = [okRec, stopped];
  const total = combineServers(fresh);
  let state = new Map();
  const rows = [];
  for (let i = 0; i < PERSISTENT_FAIL_CYCLES + 1; i += 1) {
    const t = hzTrendTotal(total, fresh, state, { advance: true });
    state = t.state; rows.push(t);
  }
  assert.equal(rows[0].row.users, null, '막 실패한 서버(1주기)는 예전처럼 부분 합 — 적재하지 않는다');
  assert.equal(rows[PERSISTENT_FAIL_CYCLES - 2].row.users, null);
  const last = rows[PERSISTENT_FAIL_CYCLES - 1];
  assert.equal(last.persistentIds.has('s2'), true);
  assert.equal(last.row.users, 3, `${PERSISTENT_FAIL_CYCLES}주기 연속 같은 사유면 나머지 서버 값으로 적재`);
  assert.equal(last.row.serversFailed, 0);
  // 사유가 바뀌면 처음부터
  const changed = [okRec, { ...stopped, kind: 'error' }];
  const t2 = hzTrendTotal(combineServers(changed), changed, state, { advance: true });
  assert.equal(t2.row.users, null);
  assert.equal(t2.persistentIds.size, 0);
  // 수동 실행(advance:false)은 칸을 진행하지 않는다
  const t3 = hzTrendTotal(total, fresh, new Map(), { advance: false });
  assert.equal(t3.state.size, 0);
});

// ── 89 F1 반증 — auto 모드 목 채움 분기도 등록부 region ───────────────────────────
test('89 F1 형제 — auto 모드 목 채움(수집 실패 · lastGood 없음)도 등록부 region 이 이긴다', async () => {
  const rs = await import('../src/runtime-settings.js');
  const { store } = await import('../src/store.js');
  const { scopedVcenterIds } = await import('../src/auth/scope.js');
  const vcFile = path.join(DIR, 'vcenters.json');
  const before = fs.readFileSync(vcFile, 'utf8');
  fs.writeFileSync(vcFile, JSON.stringify({ vcenters: [{ id: 'vc-us-east', name: 'US East', host: 'https://127.0.0.1:1', username: 'u', password: 'p', location: { region: 'APAC' } }] }));
  rs.setDataSource('auto');
  try {
    const now = Date.now();
    store.vcLast.set('vc-us-east', now);   // 이번 주기 수집 안 함
    store.vcCache.set('vc-us-east', { ok: false, vc: {}, err: { message: 'timeout' }, at: now });
    await store.refresh();
    const v = store.get().vcenters.find((x) => x.id === 'vc-us-east');
    assert.equal(v?.mock, true, '목으로 채운 항목');
    assert.equal(v.location.region, 'APAC', '목 데이터의 지역이 아니라 등록부 지역');
    assert.deepEqual([...scopedVcenterIds({ username: 'ap', role: 'viewer', scope: { regions: ['APAC'] } }, store.get())], ['vc-us-east']);
  } finally {
    rs.setDataSource('live');
    fs.writeFileSync(vcFile, before);
  }
});

// ── 90 F4 반증 — 하한 사유 목록에 대상 아님을 섞지 않는다(소스) ─────────────────────
test('90 F4 형제 — Windows 하한 사유(읽지 못한 서버 N대)의 종류 목록은 대상 아님(발행기 없음 · VM 없음)을 빼고 센다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/routes/api/horizonSessions.js'), 'utf8'));
  assert.match(src, /unreadKindText = Object\.entries\(rep\.kinds \|\| \{\}\)\s*\.filter\(\(\[k\]\) => k !== 'ok' && !CU_NOT_TARGET\.includes\(k\)\)/);
  assert.match(src, /빠졌습니다 — \$\{unreadKindText \|\| '사유 미상'\}/);
  const { NOT_TARGET_KINDS } = await import('../src/curuser/aggregate.js');
  assert.deepEqual([...NOT_TARGET_KINDS].sort(), ['no-agent', 'not-found'], '대상 아님 종류(vmsTransient 에 들지 않는 것) — aggregate 와 같은 목록');
});
