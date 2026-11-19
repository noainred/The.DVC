/**
 * test/rebut100.test.js — 전체 점검 100회차: 97 · 98 · 99회차 반증 + 그 회차들이 남긴 결정(권장안) 구현.
 *
 *  ① 97 ③ 결정: 게스트 디스크 · 디렉터리 사용량 설정이 손상으로 보존본만 남긴 뒤 재시작하면 '파일 없음' 이라 표지가 사라져 기본 보관 일수(180 · 365일)로
 *     이력을 지웠다 → 본 파일이 없고 그 설정의 손상 보존본이 남아 있으면 관리자가 다시 저장할 때까지 같은 표지(정리는 저장 상한 RETENTION_MAX_DAYS) · 저장은 허용.
 *  ② 97 추정 → 확정: sshaccess/state.js 읽기 실패 뒤 파일이 없어지면 checkCorruptOnly 가 '이미 오류' 로 돌아가 읽기 실패 표지가 남았다
 *     (키 접속 정지 · 쓰기 거절이 OTP 재읽기 · 재시작 전까지 풀리지 않음).
 *  ③ 98 ③ 결정: 세션 보안 회복 상태(recovery)를 자가 점검 · 설정 화면이 말한다(이름표는 서버 · 웹 두 벌 — 대조).
 *  ④ 98 ③ 결정: /collectors/test · /gpu-physical/test 가 저장 비밀을 쓸 때 본문 주소가 저장값과 다르면 조용히 저장 주소로 시험하던 것 → carry-refused.
 *  ⑤ 99 남김: proxy/registry 포트 셋 envPort · collector/registry 자기등록 상한 envPositive(자식 프로세스로 실제 상수 대조).
 *
 * ⚠ 기준 시각은 실제 시각을 정시로 떨어뜨린 T0(고정 epoch · Date.now() 직접 금지 — docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const DIR = tmpDir('rebut100-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_HTTP_ALLOW = '*';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const F = (n) => path.join(DIR, n);
const corruptOf = (n) => fs.readdirSync(DIR).filter((x) => x.startsWith(`${n}.corrupt.`));

const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const jfr = await import('../src/util/jsonFileRead.js');
let clock = T0;
jfr._setJsonFileLoadClockForTest(() => clock);
after(() => jfr._setJsonFileLoadClockForTest());

// ── ① 97 ③: 손상 보존본만 남은 뒤 재시작 — 기본 보관 일수로 이력을 지우지 않는다 ───────────────────────────
for (const [rel, file, big, deflt] of [['guestdisk/settings.js', 'guest-disk.json', 3000, 180], ['dirusage/settings.js', 'dirusage.json', 3000, 365]]) {
  test(`① ${rel}: 손상 → 보존본만 남은 채 재시작해도 표지(정리는 저장 상한) · 저장은 허용 · 저장하면 풀림`, async () => {
    const M = await import(`../src/${rel}`);
    M.invalidate();
    assert.equal(M.save({ retentionDays: big }).retentionDays, big, '늘려 둔 보관 일수');
    fs.writeFileSync(F(file), '{"retentionDays": 30');   // 잘린 쓰기 · 디스크 오류
    M.invalidate();
    assert.ok(M.settingsLoadError(), '이 프로세스에서 본 손상 — 표지(97회차 그대로)');
    assert.equal(corruptOf(file).length, 1, '손상본은 보존본으로');
    assert.equal(fs.existsSync(F(file)), false);
    // 재시작(모듈 상태가 빈 것과 같다): 본 파일 없음 + 보존본만
    M.invalidate();
    assert.equal(M.load().retentionDays, deflt, '값은 기본값으로 돈다(진짜 값은 보존본에)');
    const le = M.settingsLoadError();
    assert.ok(le, '재시작 뒤 보존본만 남았는데 표지가 없으면 정리가 기본 보관 일수로 이력을 지운다');
    assert.equal(le.corruptKept, true);
    assert.equal(!!le.readError, false, '읽기 오류가 아니다 — 저장은 막지 않는다');
    assert.match(le.reason, new RegExp(`${M.RETENTION_MAX_DAYS}일`), '문구가 실제 정리 기준(저장 상한)을 말한다');
    // 관리자 저장은 허용 — 본 파일이 생겨 풀린다
    assert.equal(M.save({ retentionDays: 400 }).retentionDays, 400);
    assert.equal(M.settingsLoadError(), null);
    M.invalidate();
    assert.equal(M.settingsLoadError(), null, '본 파일이 있으면 보존본이 남아 있어도 표지 없음');
    // 첫 설치(본 파일 · 보존본 모두 없음)는 표지 없음
    for (const c of corruptOf(file)) fs.rmSync(F(c));
    fs.rmSync(F(file));
    M.invalidate();
    assert.equal(M.settingsLoadError(), null, '첫 설치는 오류가 아니다');
    M.invalidate();
  });
}

test('① 스윕: 읽기 오류 · 손상 사유 문구가 "정리를 멈춘다" 고 말하지 않는다(실제로는 저장 상한으로 정리 — 97 메인 검토)', () => {
  for (const rel of ['guestdisk/settings.js', 'dirusage/settings.js']) {
    const s = fs.readFileSync(path.join(SRC, rel), 'utf8');
    for (const line of s.split('\n').filter((l) => /reason:\s*`/.test(l) || /console\.warn\(/.test(l))) {
      assert.doesNotMatch(line, /이력 정리를 멈춥|정리는 멈춥|정리는 저장 전까지 멈춤/, `${rel}: ${line.trim().slice(0, 120)}`);
    }
  }
});

// ── ② sshaccess/state: 읽기 실패 뒤 파일이 없어지면 표지가 풀린다 ─────────────────────────────────────────────
test('② SSH 공용 접속 상태: 읽기 실패 뒤 파일이 없어지면(재시작과 같은 상태) 읽기 실패 표지가 30초 뒤 풀린다 · 보존본만이면 다시 잠금', async () => {
  const ST = await import('../src/sshaccess/state.js');
  const file = F(ST.STATE_FILE_NAME);
  fs.writeFileSync(file, JSON.stringify({ stops: {}, events: [] }));
  ST._resetSshAccessStateForTest();
  const origRead = fs.readFileSync; const origNow = Date.now;
  let now = T0; Date.now = () => now;
  try {
    fs.readFileSync = function patched(p, ...a) {
      if (path.resolve(String(p)) === path.resolve(file)) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; }
      return origRead.call(this, p, ...a);
    };
    assert.ok(ST.stateLoadError(), '읽기 실패는 잠금(fail-closed)');
    assert.equal(ST.stopMatch({ corps: ['vc-a'] })?.unreadable, true);
    fs.readFileSync = origRead;
    fs.rmSync(file);   // 사람이 읽지 못하는 파일을 치웠다
    now += 31_000;
    assert.equal(ST.stateLoadError(), null, '파일이 없으면 재시작과 같다 — 읽기 실패 표지가 남으면 키 접속 정지 · 쓰기 거절이 OTP 재읽기 전까지 풀리지 않는다');
    assert.equal(ST.stopMatch({ corps: ['vc-a'] }), null);
    // 읽기 실패 → 손상 보존본만 남은 경우는 다시 잠근다(손상에서 온 잠금은 그대로)
    ST._resetSshAccessStateForTest();
    fs.writeFileSync(file, '{"stops": [');
    assert.ok(ST.stateLoadError(), '손상 → 잠금');
    assert.equal(corruptOf(ST.STATE_FILE_NAME).length, 1);
    ST._resetSshAccessStateForTest();   // 재시작
    assert.ok(ST.stateLoadError(), '보존본만 남음 → 잠금');
    fs.writeFileSync(file, '{}');
    fs.readFileSync = function patched(p, ...a) {
      if (path.resolve(String(p)) === path.resolve(file)) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return origRead.call(this, p, ...a);
    };
    ST._resetSshAccessStateForTest();
    assert.ok(ST.stateLoadError(), '읽기 실패');
    fs.readFileSync = origRead;
    fs.rmSync(file);
    now += 31_000;
    assert.ok(ST.stateLoadError(), '읽기 실패가 풀려도 손상 보존본만 남았으면 다시 잠금');
  } finally { fs.readFileSync = origRead; Date.now = origNow; }
  for (const c of corruptOf(ST.STATE_FILE_NAME)) fs.rmSync(F(c));
  ST._resetSshAccessStateForTest();
});

// ── ③ 세션 보안 회복 상태 — 자가 점검 · 화면 ───────────────────────────────────────────────────────────────
test('③ 자가 점검: 세션 보안이 엄격 값 · 신뢰 사본으로 돌면 warn + 한 줄(예전에는 ok) · 이름표는 웹과 같다', async () => {
  const SS = await import('../src/security/securitySettings.js');
  const SC = await import('../src/security/selfCheck.js');
  const web = await import('../../web/src/views/sessionSecurityBody.js');
  assert.deepEqual(JSON.parse(JSON.stringify(web.SESSION_RECOVERY_LABELS)), JSON.parse(JSON.stringify(SC.SESSION_RECOVERY_LABELS)), '서버 · 웹 이름표가 갈라지면 같은 상태를 다르게 말한다');
  for (const source of ['last-good', 'trusted-copy', 'strict']) {
    for (const problem of ['read-error', 'corrupt', 'missing']) {
      const rec = { source, problem, at: T0 };
      const a = SC.sessionRecoveryText(rec); const b = web.sessionRecoveryText(rec);
      assert.ok(a.includes(SC.SESSION_RECOVERY_LABELS.source[source]) && a.includes(SC.SESSION_RECOVERY_LABELS.problem[problem]), a);
      assert.ok(b.includes(SC.SESSION_RECOVERY_LABELS.source[source]) && b.includes(SC.SESSION_RECOVERY_LABELS.problem[problem]), b);
      assert.doesNotMatch(b, /`/, '화면 문구에 백틱 금지');
    }
  }
  for (const v of [null, undefined, {}, { source: 'x' }, 'strict']) { assert.equal(SC.sessionRecoveryText(v), ''); assert.equal(web.sessionRecoveryText(v), ''); }
  assert.match(web.sessionRecoveryText({ source: 'last-good', problem: 'read-error' }), /권한/, '읽기 오류면 저장 대신 권한부터');

  const main = F('security-session.json'); const trusted = F('security-session.trusted.json');
  for (const f of [main, trusted]) fs.rmSync(f, { force: true });
  SS._resetSessionSecurityReadForTest();
  clock += 60_000;
  let item = SC.collectSelfCheck({ dir: DIR }).checks.find((c) => c.id === 'session-security');
  assert.equal(item.status, 'ok', '신규 설치(파일 없음 · 사본 없음)는 기본값 — 회복이 아니다');
  fs.writeFileSync(main, '{"loginPolicy": "otp_on');   // 손상 · 사본 없음 → 엄격 값
  SS._resetSessionSecurityReadForTest();
  clock += 60_000;
  item = SC.collectSelfCheck({ dir: DIR }).checks.find((c) => c.id === 'session-security');
  assert.equal(item.status, 'warn', '엄격 값으로 도는 중인데 ok 로 보이면 관리자가 모른다');
  assert.match(item.detail, /엄격 값/);
  assert.match(item.detail, /데모 세션 모드 (전역 따름\(기본\)|중복 허용|중복 차단\(단일 세션\))/, '데모 세션 모드는 저장 필드(demoSession)를 읽는다');
  for (const c of corruptOf('security-session.json')) fs.rmSync(F(c));
  for (const f of [main, trusted]) fs.rmSync(f, { force: true });
  SS._resetSessionSecurityReadForTest();
});

test('③ 화면: 설정 › 세션 보안이 응답의 recovery 를 한 줄로 말한다(소스)', () => {
  const jsx = fs.readFileSync(path.resolve(HERE, '../../web/src/views/SessionSecurity.jsx'), 'utf8');
  assert.match(jsx, /sessionRecoveryText\(s\.recovery\)/);
});

// ── ④ 연결 시험: 저장 비밀을 쓸 때 본문 주소가 다르면 거절 ───────────────────────────────────────────────────
async function adminApp(register) {
  const express = (await import('express')).default;
  const app = express(); app.use(express.json());
  const rt = express.Router(); register(rt); app.use('/api/admin', rt);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/admin${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { srv, post };
}

test('④ /collectors/test: 저장 토큰을 쓰면서 URL 이 저장값과 다르면 carry-refused(예전: 조용히 저장 주소로 시험) · 같은 주소(대소문자 · 끝 / · 스킴 생략)는 그대로', async () => {
  const express = (await import('express')).default;
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const creg = await import('../src/collector/registry.js');
  const seen = { edge: [], other: [] };
  const listen = (bucket) => new Promise((r) => {
    const a = express();
    a.get('/api/collector/export', (req, res) => { seen[bucket].push(req.get('X-Collector-Token') || ''); res.json({ agent: bucket, version: 't', hosts: 1 }); });
    const s = a.listen(0, '127.0.0.1', () => r(s));
  });
  const edge = await listen('edge'); const other = await listen('other');
  const { srv, post } = await adminApp(registerCollectorsDc);
  try {
    const savedUrl = `http://127.0.0.1:${edge.address().port}`;
    const add = creg.addCollector({ id: 'edge100', name: 'edge100', url: savedUrl, token: 'saved-token-100' }, { managed: true });
    assert.equal(add.ok, true, JSON.stringify(add));
    const r1 = await post('/collectors/test', { id: 'edge100', url: `http://127.0.0.1:${other.address().port}`, token: '' });
    assert.equal(r1.ok, false); assert.equal(r1.method, 'carry-refused', JSON.stringify(r1));
    assert.deepEqual(seen, { edge: [], other: [] }, '거절이면 어느 주소로도 보내지 않는다(조용히 저장 주소로 바꿔 시험하지 않는다)');
    const r2 = await post('/collectors/test', { id: 'edge100', url: `HTTP://127.0.0.1:${edge.address().port}/`, token: '' });
    assert.equal(r2.ok, true, `같은 주소(표기만 다름)는 정상 경로: ${JSON.stringify(r2)}`);
    assert.deepEqual(seen.edge, ['saved-token-100']);
    const r3 = await post('/collectors/test', { id: 'edge100' });
    assert.equal(r3.ok, true, `본문 URL 없음 = 저장 주소: ${JSON.stringify(r3)}`);
    const r4 = await post('/collectors/test', { id: 'edge100', url: `http://127.0.0.1:${other.address().port}`, token: 'typed-token' });
    assert.equal(r4.ok, true, '토큰을 함께 입력하면 입력한 주소로 시험(예전과 같다)');
    assert.deepEqual(seen.other, ['typed-token']);
    assert.ok(!seen.other.includes('saved-token-100'));
  } finally { srv.close(); edge.close(); other.close(); }
});

test('④ /gpu-physical/test: 저장 비밀번호를 쓰면서 주소 · 포트 · 계정이 저장값과 다르면 carry-refused · 빈 칸 · 같은 값은 저장값', async () => {
  const { registerGpuGuest } = await import('../src/routes/admin/gpuGuest.js');
  const preg = await import('../src/gpu/physicalRegistry.js');
  const gs = await import('../src/gpu/settings.js');
  gs.saveGpuGuestSettings({ timeoutMs: 3_000 });
  const add = preg.addPhysical({ id: 'pg100', host: '10.255.255.1', port: 22, username: 'gpuops', password: 'saved-pw-100' });
  assert.equal(add.ok, true, JSON.stringify(add));
  const { srv, post } = await adminApp(registerGpuGuest);
  try {
    for (const body of [{ id: 'pg100', host: '10.255.255.2' }, { id: 'pg100', username: 'root' }, { id: 'pg100', port: 2222 }]) {
      const r = await post('/gpu-physical/test', body);
      assert.equal(r.method, 'carry-refused', `${JSON.stringify(body)} → ${JSON.stringify(r)}`);
      assert.equal(r.ok, false);
    }
    const same = await post('/gpu-physical/test', { id: 'pg100', host: '10.255.255.1', username: 'GPUOPS', port: '22' });
    assert.notEqual(same.method, 'carry-refused', '같은 값(대소문자 · 문자열 포트)은 거절하지 않는다');
    const blank = await post('/gpu-physical/test', { id: 'pg100', host: '', username: '', port: '' });
    assert.notEqual(blank.method, 'carry-refused', '빈 칸 = 저장값 그대로(행의 테스트 버튼)');
  } finally { srv.close(); }
});

// ── ⑤ 99 남김: 포트 · 자기등록 상한 env ─────────────────────────────────────────────────────────────────────
test('⑤ proxy/registry 포트 · collector/registry 자기등록 상한: 위험한 env 는 기본값 · 정상 값은 그대로(자식 프로세스)', () => {
  const probe = (env) => {
    const cfg = tmpDir('rebut100env-');
    const code = `const p = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'proxy/registry.js')).href)});
const c = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'collector/registry.js')).href)});
const g = p.getConfig();
console.log(JSON.stringify({ ssh: g.deploy.port, base: g.publicPortBase, guacd: g.guacd.port, self: c.SELF_REG_MAX, unv: c.SELF_REG_UNVERIFIED_MAX }));`;
    const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: cfg, DATA_DIR: cfg, ...env }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const D = { ssh: 22, base: 20000, guacd: 4822, self: 256, unv: 16 };
  for (const bad of ['-1', '70000', 'Infinity', '1e400', 'abc', '0']) {
    const v = probe({ PROXY_SSH_PORT: bad, PROXY_PUBLIC_PORT_BASE: bad, GUACD_PORT: bad, ...(bad === '70000' ? {} : { CENTRAL_SELF_REGISTER_MAX: bad, CENTRAL_SELF_REGISTER_UNVERIFIED_MAX: bad }) });
    assert.deepEqual(v, D, `env=${bad}`);
  }
  assert.deepEqual(probe({ PROXY_SSH_PORT: '2222', PROXY_PUBLIC_PORT_BASE: '30000', GUACD_PORT: '4823', CENTRAL_SELF_REGISTER_MAX: '512', CENTRAL_SELF_REGISTER_UNVERIFIED_MAX: '32' }),
    { ssh: 2222, base: 30000, guacd: 4823, self: 512, unv: 32 }, '정상 값은 그대로');
});

// ── ⑥ 98회차 반증: 신뢰 사본이 '있는데 못 읽음' 은 신규 설치가 아니다 ─────────────────────────────────────────
test('⑥ 세션 보안: 본 파일 없음 + 신뢰 사본 손상 · 읽기 오류 → 엄격 값 + recovery(예전: 조용히 기본값 — 레거시 · 단일 세션 끔 · 무제한) · 둘 다 없음만 기본값', async () => {
  const SS = await import('../src/security/securitySettings.js');
  const main = F('security-session.json'); const trusted = F('security-session.trusted.json');
  const clean = () => { for (const f of [main, trusted]) fs.rmSync(f, { recursive: true, force: true }); for (const c of corruptOf('security-session.json')) fs.rmSync(F(c)); SS._resetSessionSecurityReadForTest(); };
  clean();
  SS.saveSessionSecurity({ loginPolicy: 'otp_only', singleSession: true, sessionMaxHours: 8 });
  assert.ok(fs.existsSync(trusted), '저장하면 신뢰 사본이 맞춰진다(98회차)');
  for (const breakTrusted of [() => fs.writeFileSync(trusted, '{"loginPolicy": "otp_'), () => { fs.rmSync(trusted); fs.mkdirSync(trusted); }]) {
    fs.rmSync(main, { force: true });   // 손상 보존 뒤 재시작 · 지움 — 본 파일 없음
    breakTrusted();
    SS._resetSessionSecurityReadForTest();
    clock += 60_000;
    const c = SS.loadConfiguredSecurity();
    assert.equal(c.loginPolicy, 'otp_only', '사본이 남아 있는데(깨짐 · 읽기 오류) 기본값(레거시)으로 내려가면 안 된다');
    assert.equal(c.singleSession, true);
    assert.equal(c.sessionMaxHours, 8);
    assert.equal(SS.sessionSecurityRecovery()?.source, 'strict', '그 사실을 recovery 로 밝힌다');
    fs.rmSync(trusted, { recursive: true, force: true });
    SS._resetSessionSecurityReadForTest();
    SS.saveSessionSecurity({ loginPolicy: 'otp_only', singleSession: true, sessionMaxHours: 8 });
  }
  clean();
  clock += 60_000;
  assert.equal(SS.loadConfiguredSecurity().loginPolicy, null, '두 파일 모두 없음 = 신규 설치 — 기본값(예전과 같다)');
  assert.equal(SS.sessionSecurityRecovery(), null);
  clean();
});

// ── ⑦ 98회차 반증: 복원은 신뢰 사본으로 돌고 있는 값보다 약하게 되돌리지 않는다 ──────────────────────────────────
test('⑦ 백업 복원: 본 파일이 없거나 깨졌으면 신뢰 사본과 견준다(예전: 기본값과 견줘 otp_only · 단일 세션 · 8시간 · 소유자 목록을 OTP 없이 내림)', async () => {
  const SR = await import('../src/backup/stagedRestore.js');
  const d = tmpDir('rebut100rs-');
  const strong = { loginPolicy: 'otp_only', singleSession: true, sessionMaxHours: 8, idleLogoutEnabled: true, idleLogoutMin: 15, settingsOwners: ['noainred'] };
  const weak = { loginPolicy: 'password_only', singleSession: false, sessionMaxHours: 0, idleLogoutEnabled: false, settingsOwners: ['noainred', 'eve'] };
  fs.writeFileSync(path.join(d, 'security-session.trusted.json'), JSON.stringify(strong));
  for (const mainState of ['missing', 'corrupt']) {
    if (mainState === 'corrupt') fs.writeFileSync(path.join(d, 'security-session.json'), '{"loginPolicy": "otp_on');
    const out = JSON.parse(SR.reconcileForApply('security-session.json', JSON.stringify(weak), d).content);
    assert.equal(out.loginPolicy, 'otp_only', `${mainState}: 정책`);
    assert.equal(out.singleSession, true, `${mainState}: 단일 세션`);
    assert.equal(out.sessionMaxHours, 8, `${mainState}: 총 상한`);
    assert.deepEqual(out.settingsOwners, ['noainred'], `${mainState}: 복원으로 소유자를 늘리지 않는다`);
  }
  // 사본을 못 읽으면 이 파일만 적용하지 않는다(지금 값을 모른 채 덮지 않는다 — 91회차 규칙)
  fs.rmSync(path.join(d, 'security-session.trusted.json')); fs.mkdirSync(path.join(d, 'security-session.trusted.json'));
  assert.throws(() => SR.reconcileForApply('security-session.json', JSON.stringify(weak), d), /신뢰 사본/);
  // 둘 다 없으면 예전과 같다(기본값과 견줌 — 재해 복구)
  fs.rmSync(path.join(d, 'security-session.trusted.json'), { recursive: true }); fs.rmSync(path.join(d, 'security-session.json'));
  const out = JSON.parse(SR.reconcileForApply('security-session.json', JSON.stringify(weak), d).content);
  assert.deepEqual(out.settingsOwners, ['noainred', 'eve'], '두 파일 모두 없으면 재해 복구 — 백업 소유자 그대로(예전과 같다)');
});
