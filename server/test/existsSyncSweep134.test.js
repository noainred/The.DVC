/**
 * existsSyncSweep134.test.js — 전체 점검 134회차: `fs.existsSync` 로 '파일 없음' 을 가르는 로더(공통 스윕).
 *
 * `fs.existsSync(file)` 은 stat 이 **어떤 이유로든** 실패하면 false 다(설정 폴더 탐색 권한 EACCES · EIO · ESTALE · ELOOP). 97 · 107 · 119회차가 넣은
 *   '읽기 오류 ≠ 손상 ≠ 없음'(readFileSync 의 오류 코드로 가른다) **앞에서** 이 가드로 먼저 거른 로더는 그 갈래에 닿지 못하고 기본값 · 빈 목록 · 새 키로 떨어졌다.
 *   131회차가 범위 밖에서 재현한 `auth/permissions.js loadMatrix` 가 출발점이고, 148줄(88파일)을 전부 분류했다(아래 표 — 새 `existsSync` 가 들어오면 실패한다).
 *
 * 고친 것(각각 수정 전 판본에서 실패 — 변이 검증은 보고서):
 *  P1 auth/permissions      권한 매트릭스 — 최소 권한이 아니라 기본 매트릭스(저장된 도구 거부 · 권한 축소가 풀림) + 읽기 오류 30초 재읽기(결정 → 권장안)
 *  P2 auth/auth users.json  '없음' = 기본 관리자 시드(DEFAULT_ADMIN_PASSWORD 로 로그인) · 오류가 풀린 뒤 첫 저장이 실계정 전부를 덮음
 *  P3 auth/auth auth-secret 일시 오류 한 번에 영속 시크릿을 새 값으로 덮음
 *  P4 auth/sessionState     세션 폐기 목록이 빈 채 열림(로그아웃한 토큰이 되살아남)
 *  P5 security/secretVault  키 파일 '없음' = 새 키로 덮음(전 암호문 복호 불가) · 정책 '없음' = 신규 설치(plain)
 *  P6 sshaccess/state       키 접속 중지 기록이 사라짐 · 다음 기록이 원본을 덮음
 *  P7 collector/registry    registryLoadError 가 읽기 오류 표지를 **지움**(등록 0개 · 오류 없음)
 *  P8 central/agentTokens   빈 토큰 목록을 표지 없이 재시작까지 캐시   P9 central/token upsertEnvKeyStrict · persistEnv  그 한 줄만 든 env 파일로 덮음
 *  P10 upgrade/signature    호스트 신뢰 키 파일(회수 목록)을 확인하지 못한 채 '없음' 으로 검증 진행
 *  S1~S12 설정 로더 형제(표지 없는 기본값 — 저장 거절 · 설정 pull 503 이 풀림): ipam/subnetNotes · ipam/rangeStore · bmusage/settings(로컬 · 배포) · sanswitch/directorMap ·
 *         sanswitch/storageCheckSettings · horizon · gpu/settings · svcmon/alertSettings · curuser/settings · bmusage/portMap · isidu/settings(statSync catch — 같은 꼴)
 *  V1 vcenters.json '있는데 못 읽음' 판정 4곳(guestdisk · osScanner · central vmclone · central gpu-guest-data) — 못 읽은 등록부를 '미구성' 으로 보고 정리
 *  L1~L6 낮음: securitySettings(재정의 파일 덮음 · 무음) · onboardRun(직전 스냅샷 지움) · vcRangeMigrate(백업 없이 이전) · settingsLoadError(확정 가드) ·
 *         auth reloadUsersFromDisk · secretVault 흔적 · 전환(L3 · L4 · L5 는 행동 재현 없이 소스 대조로 고정 — 코드 확정)
 *  (pyportal 판 PY1 · PY2 는 pyportal/tests/test_sweep134.py)
 *
 * 재현 방법: 자식 프로세스(모듈 캐시가 재시작까지 굳는 로더라 새 프로세스가 필요하다)에서 **그 파일 이름의** `existsSync` = false · `statSync` · `readFileSync` = 코드로 던짐 —
 *   실제 폴더 수준 오류에서 Node 가 주는 그대로다(121회차 rebut121 withDirError 와 같은 주입). 쓰기는 실제로 된다(= 일시 오류 뒤 원본을 덮는 경로까지 본다).
 *   주입이 현실과 같은지는 P1 의 실제 조건판(설정 폴더를 자기 자신을 가리키는 링크로 바꿔 ELOOP — root 여부와 무관)이 고정한다.
 * `S134_SRC` 로 다른 소스 트리(수정 전 판본의 격리 사본)를 가리킬 수 있다 — 변이 검증용.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.S134_SRC ? path.resolve(process.env.S134_SRC) : path.join(HERE, '..', 'src');
const TMP_DIRS = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exists134-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/* ── 자식 프로세스 ─────────────────────────────────────────────────────────────────────── */
const PRELUDE = `
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const SRC = process.env.S134_SRC; const DIR = process.env.CONFIG_DIR;
const o = { ex: fs.existsSync, st: fs.statSync, rd: fs.readFileSync };
const bad = new Map(); let badAll = null;
const hit = (p) => { if (typeof p === 'number') return null; const s = String(p); return bad.get(path.basename(s)) || (badAll && s.startsWith(DIR + path.sep) ? badAll : null); };
const errOf = (code) => Object.assign(new Error(code + ': injected'), { code });
fs.existsSync = (p) => (hit(p) ? false : o.ex.call(fs, p));
fs.statSync = (p, ...a) => { const k = hit(p); if (k) throw errOf(k); return o.st.call(fs, p, ...a); };
fs.readFileSync = (p, ...a) => { const k = hit(p); if (k) throw errOf(k); return o.rd.call(fs, p, ...a); };
const logs = []; for (const k of ['log', 'warn', 'error', 'info']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
const c = {
  fs, path, DIR, logs, bad,
  setBadAll: (code) => { badAll = code; },
  imp: (rel) => import(pathToFileURL(path.join(SRC, rel)).href),
  F: (n) => path.join(DIR, n),
  put: (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); fs.writeFileSync(path.join(DIR, n), s); return s; },
  raw: (n) => { try { return o.rd.call(fs, path.join(DIR, n), 'utf8'); } catch { return null; } },
  tryCall: (fn) => { try { return fn(); } catch (e) { return { threw: true, code: e?.code || null, status: e?.status || null }; } },
};
`;
const CHILD_ENV_DROP = ['CENTRAL_URL', 'CENTRAL_TOKEN', 'AUTH_SECRET', 'SECRETS_KEY', 'SECRETS_KEY_LOST', 'DEFAULT_ADMIN_PASSWORD', 'LOGIN_POLICY_USERS', 'SETTINGS_OWNERS', 'NODE_TEST_CONTEXT'];
function child(scenario, dir, extraEnv = {}) {
  const env = { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir, AUTH_ENABLED: 'true', DATA_SOURCE: 'live', S134_SRC: SRC, ...extraEnv };
  for (const k of CHILD_ENV_DROP) if (!(k in extraEnv)) delete env[k];
  const code = `${PRELUDE}\nconst __r = await (${scenario.toString()})(c);\nprocess.stdout.write('\\n@@' + JSON.stringify(__r) + '\\n');\nprocess.exit(0);\n`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 120_000 });
  const line = String(r.stdout || '').split('\n').filter((l) => l.startsWith('@@')).pop();
  assert.ok(line, `자식 프로세스 결과 없음(status ${r.status}) — ${String(r.stderr || '').slice(-900)}`);
  return JSON.parse(line.slice(2));
}

/* ── P1 권한 매트릭스 ──────────────────────────────────────────────────────────────────── */
const PERM_FILE = { schemaVersion: 99, matrix: { operator: ['dashboard'], viewer: ['dashboard'], toolsDenied: { operator: ['ssh-console'], viewer: ['ssh-console'] } } };

test('P1 권한 매트릭스: 폴더 수준 읽기 오류(existsSync=false) — 기본 매트릭스가 아니라 최소 권한 · 읽기 오류 표지 · 쓰기 거절 · 원본 유지', () => {
  const r = child(async (c) => {
    const orig = c.put('permissions.json', JSON.parse(process.env.S134_PERM));
    const RD = await c.imp('util/jsonFileRead.js');
    let now = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 실제 시각에서 정시 경계로 고정
    RD._setJsonFileLoadClockForTest(() => now);
    const P = await c.imp('auth/permissions.js');
    c.bad.set('permissions.json', 'EACCES');
    const m = P.loadMatrix();
    const e = P.permissionsLoadError();
    const out = {
      operator: m.operator, viewer: m.viewer, toolsDenied: m.toolsDenied.operator, adminDeniedN: m.adminDenied.length,
      remote: P.userHasPermission({ username: 'op', role: 'operator' }, 'remote.access'),
      tools: P.userHasPermission({ username: 'op', role: 'operator' }, 'tools'),
      err: e ? { readError: !!e.readError, reason: e.reason } : null,
      refusal: P.permissionsWriteRefusal()?.status ?? null,
      resetRefusal: P.permissionsWriteRefusal({ reset: true })?.status ?? null,
      refusalText: P.permissionsWriteRefusal()?.body?.reason || '',
    };
    out.save = c.tryCall(() => { P.saveMatrix({ operator: ['dashboard', 'tools', 'remote.access'] }); return { saved: true }; });
    out.userTools = P.setUserTools('op', { mode: 'allow', tools: ['ping'] }).ok;
    out.fileSame = c.raw('permissions.json') === orig;
    // 오류가 풀림 — 간격(30초) 안에는 디스크를 보지 않고, 지나면 재시작 없이 저장된 매트릭스로
    c.bad.clear();
    out.within = { operator: P.loadMatrix().operator, err: !!P.permissionsLoadError() };
    now += RD.READ_RETRY_MS + 1_000;
    const m2 = P.loadMatrix();
    out.healed = { operator: m2.operator, toolsDenied: m2.toolsDenied.operator, err: P.permissionsLoadError(), refusal: P.permissionsWriteRefusal() };
    out.healedSave = c.tryCall(() => { P.saveMatrix({ operator: ['dashboard', 'tools'] }); return { saved: true }; });
    out.healedFile = JSON.parse(c.raw('permissions.json')).matrix.toolsDenied.operator;
    // 읽기 오류 뒤 파일이 사라짐 — 풀지 않는다(재시작이 다시 판정한다)
    if (P._resetPermissionsForTest) {
      P._resetPermissionsForTest();
      c.bad.set('permissions.json', 'EIO');
      P.loadMatrix();
      c.bad.clear(); c.fs.rmSync(c.F('permissions.json'));
      now += RD.READ_RETRY_MS + 1_000;
      const m3 = P.loadMatrix();
      out.vanish = { operator: m3.operator, readError: !!P.permissionsLoadError()?.readError, refusal: P.permissionsWriteRefusal()?.status ?? null };
      P._resetPermissionsForTest();
      out.restart = { n: P.loadMatrix().operator.length, err: P.permissionsLoadError() };
    }
    return out;
  }, tmpDir(), { S134_PERM: JSON.stringify(PERM_FILE) });

  assert.deepEqual(r.operator, ['dashboard'], '못 읽은 권한 파일을 "없음" 으로 보고 기본 매트릭스(operator 권한 13개)로 열었다');
  assert.deepEqual(r.viewer, ['dashboard']);
  assert.equal(r.remote, false, 'operator 원격 접속이 열렸다(저장값은 대시보드만)');
  assert.equal(r.tools, false);
  assert.ok(r.adminDeniedN > 0, '최소 권한 = admin 의 끌 수 있는 키도 끔');
  assert.equal(r.err?.readError, true, '읽기 오류 표지가 서야 한다(서비스 점검 · 화면)');
  assert.match(r.err.reason, /EACCES.*원본은 그대로.*30초마다 다시 읽고/);
  assert.equal(r.refusal, 503); assert.equal(r.resetRefusal, 503, '읽기 오류는 초기화도 거절');
  assert.match(r.refusalText, /30초 안에 다시 읽어 재시작 없이 풀립니다/);
  assert.doesNotMatch(r.refusalText, /`/, '화면 문구에 백틱 금지');
  assert.equal(r.save.threw, true); assert.equal(r.save.status, 503);
  assert.equal(r.userTools, false);
  assert.equal(r.fileSame, true, '못 읽은 원본을 기본값 + 편집으로 덮었다');
  assert.deepEqual(r.within, { operator: ['dashboard'], err: true }, '간격 안에는 디스크를 다시 보지 않는다(요청마다 불리는 경로)');
  assert.deepEqual(r.healed.operator, ['dashboard']);
  assert.deepEqual(r.healed.toolsDenied, ['ssh-console'], '읽히면 저장된 도구 거부로 돌아온다(재시작 없이)');
  assert.equal(r.healed.err, null); assert.equal(r.healed.refusal, null);
  assert.equal(r.healedSave.saved, true);
  assert.deepEqual(r.healedFile, ['ssh-console'], '풀린 뒤의 저장은 읽은 원본 위에 쓴다(도구 거부 유지)');
  assert.deepEqual(r.vanish, { operator: ['dashboard'], readError: true, refusal: 503 }, '읽기 오류 뒤 파일이 사라지면 최소 권한 · 표지를 그대로 둔다(기본 매트릭스로 열지 않는다)');
  assert.ok(r.restart.n > 5 && r.restart.err === null, '재시작 뒤 파일이 정말 없으면 기본 매트릭스(처음 설치와 같다)');
});

test('P1 실제 조건: 설정 폴더가 링크 고리(ELOOP)면 existsSync 는 false 다 — 그래도 최소 권한 · 읽기 오류 · 쓰기 거절', () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'cfg'));
  const r = child(async (c) => {
    c.put('permissions.json', JSON.parse(process.env.S134_PERM));
    const P = await c.imp('auth/permissions.js');
    const link = c.DIR; const real = c.fs.realpathSync(link);
    c.fs.unlinkSync(link); c.fs.symlinkSync(c.path.basename(link), link);   // 자기 자신을 가리키는 링크 — 그 아래 모든 경로가 ELOOP
    let stat = 'ok'; try { c.fs.statSync(c.F('permissions.json')); } catch (e) { stat = e.code; }
    const out = { stat, existsSync: c.fs.existsSync(c.F('permissions.json')) };
    const m = P.loadMatrix();
    Object.assign(out, { operator: m.operator, readError: !!P.permissionsLoadError()?.readError, refusal: P.permissionsWriteRefusal()?.status ?? null });
    c.fs.unlinkSync(link); c.fs.symlinkSync(real, link);
    return out;
  }, path.join(root, 'cfg'), { S134_PERM: JSON.stringify(PERM_FILE) });
  assert.deepEqual({ stat: r.stat, existsSync: r.existsSync }, { stat: 'ELOOP', existsSync: false }, '전제: 폴더 수준 오류에서 existsSync 는 false 다');
  assert.deepEqual(r.operator, ['dashboard']);
  assert.equal(r.readError, true); assert.equal(r.refusal, 503);
});

/* ── P2 · P3 사용자 파일 · 시크릿 ──────────────────────────────────────────────────────── */
test('P2 users.json: 폴더 수준 읽기 오류는 "없음" 이 아니다 — 기본 관리자를 만들지 않는다 · 초기 구축 안내 없음 · 저장 거절 · 원본 유지', () => {
  const r = child(async (c) => {
    const orig = c.put('users.json', { users: [
      { username: 'alice', name: 'Alice', role: 'admin', passwordHash: 'scrypt$00$00', tokenVersion: 7, totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' },
      { username: 'bob', name: 'Bob', role: 'viewer', passwordHash: 'scrypt$00$00', tokenVersion: 2 },
    ] });
    c.bad.set('users.json', 'EACCES');
    const A = await c.imp('auth/auth.js');
    const names = A.loadUsers().map((u) => u.username);
    const out = { names, readErr: A.usersReadError()?.code || null, setup: A.setupState(), seedLogin: !!A.authenticateLocal('admin', process.env.DEFAULT_ADMIN_PASSWORD) };
    c.bad.clear();   // 일시 오류가 풀렸다 — 그래도 이 프로세스는 계정을 만들지도 저장하지도 않는다
    out.create = A.createUser({ username: 'carol', name: 'Carol', role: 'viewer', password: 'Carol!Passw0rd' }, { trusted: true }).ok;
    out.fileSame = c.raw('users.json') === orig;
    out.initFile = c.raw('initial-admin-password.txt') != null;
    return out;
  }, tmpDir(), { DEFAULT_ADMIN_PASSWORD: 'Known!Passw0rd-134' });
  assert.deepEqual(r.names, [], '못 읽은 사용자 파일을 "없음" 으로 보고 기본 관리자 · 데모 계정을 시드했다');
  assert.equal(r.readErr, 'EACCES');
  assert.deepEqual(r.setup, { setupPending: false, initialPasswordFile: null }, '미인증 /auth/config 가 초기 구축 중이라고 안내했다');
  assert.equal(r.seedLogin, false, 'DEFAULT_ADMIN_PASSWORD 로 admin 로그인이 됐다(실계정 파일이 있는데)');
  assert.equal(r.create, false);
  assert.equal(r.fileSame, true, '오류가 풀린 뒤의 저장이 실사용자 전부를 시드로 덮었다');
  assert.equal(r.initFile, false);
});

test('P3 auth-secret: 있는데 못 읽은 시크릿을 새 값으로 덮지 않는다(이 프로세스만 임의 시크릿)', () => {
  const r = child(async (c) => {
    const orig = c.put('auth-secret', 'a1'.repeat(32));
    c.bad.set('auth-secret', 'EIO');
    const A = await c.imp('auth/auth.js');
    c.bad.clear();
    const tok = A.signToken({ sub: 'x', role: 'viewer' });
    return { same: c.raw('auth-secret') === orig, warned: c.logs.some((l) => /시크릿 파일.*읽지 못했습니다\(EIO\).*덮지 않고/.test(l)), tokenWorks: !!A.verifyToken(tok) };
  }, tmpDir());
  assert.equal(r.same, true, '일시 읽기 오류 한 번에 영속 시크릿을 덮었다(오류가 풀려도 예전 세션이 돌아오지 않는다)');
  assert.equal(r.warned, true);
  assert.equal(r.tokenWorks, true, '임의 시크릿으로는 정상 동작한다');
});

/* ── P4 세션 폐기 목록 ─────────────────────────────────────────────────────────────────── */
test('P4 sessionState: 폴더 수준 읽기 오류 — 폐기 목록이 빈 채 열리지 않는다(notBefore = 지금 · 전원 재로그인)', () => {
  const r = child(async (c) => {
    const S = await c.imp('auth/sessionState.js');
    const t0 = Math.floor(Date.now() / 1000);
    S.revokeSession('sid-134', { username: 'kim', untilSec: t0 + 3600, reason: 'logout' });
    S.persistNow();
    S._resetSessionStateForTest();
    const out = { saved: S.isSessionRevoked('sid-134'), nb0: S.sessionNotBefore() };
    S._resetSessionStateForTest();
    c.bad.set('session-state.json', 'EACCES');
    out.revoked = S.isSessionRevoked('sid-134');
    out.notBeforeSet = S.sessionNotBefore() >= t0;
    return out;
  }, tmpDir());
  assert.deepEqual({ saved: r.saved, nb0: r.nb0 }, { saved: true, nb0: 0 }, '전제: 폐기 기록이 파일에 있다');
  assert.equal(r.notBeforeSet, true, '폐기 목록을 못 읽었는데 notBefore 가 0 — 로그아웃 · 강제 종료한 토큰이 되살아난다');
});

/* ── P5 비밀 보관 ──────────────────────────────────────────────────────────────────────── */
test('P5 secretVault: 키 · 정책을 확인하지 못한 것은 "없음" 이 아니다 — 새 키로 덮지 않는다 · 신규 설치(plain)로 내려가지 않는다', () => {
  const dir = tmpDir();
  const s = child(async (c) => {
    const V = await c.imp('security/secretVault.js');
    V.saveSecretsPolicy({ mode: 'encrypted' });
    const sealed = V.sealSecret('S3cret!-134');
    c.put('nsx.json', { managers: [{ id: 'n1', host: 'https://nsx.example', username: 'admin', password: sealed }] });
    const out = { sealed, ok: V.isSealed(sealed), opened: V.openSecret(sealed) };
    // 저장 방식 전환: 확인하지 못한 비밀 파일을 '없음' 으로 보고 조용히 건너뛰지 않는다(오류로 보고)
    c.bad.set('nsx.json', 'EIO');
    const mg = V.migrateSecretFiles({ mode: 'encrypted' });
    c.bad.clear();
    out.migrate = { skipped: mg.files.some((f) => f.file === 'nsx.json'), error: mg.errors.some((e) => e.file === 'nsx.json') };
    return out;
  }, dir);
  assert.equal(s.ok, true); assert.equal(s.opened, 'S3cret!-134');
  assert.deepEqual(s.migrate, { skipped: false, error: true }, '전환이 확인하지 못한 비밀 파일을 "없음(바뀐 것 없음)" 으로 보고했다');
  const r = child(async (c) => {
    const key0 = c.raw('secrets-key');
    const V = await c.imp('security/secretVault.js');
    c.setBadAll('EIO');   // 설정 폴더 전체의 stat · 읽기가 실패(쓰기는 된다 — 일시 오류)
    const pol = V.loadSecretsPolicy();
    const opened = V.openSecret(process.env.S134_SEALED);
    const out = { pol: { mode: pol.mode, locked: !!pol.locked, problem: pol.problem || null }, opened, keySame: c.raw('secrets-key') === key0, keyMissing: !!V.secretsKeyMissing() };
    c.setBadAll(null);
    return out;
  }, dir, { S134_SEALED: s.sealed });
  assert.equal(r.keySame, true, '키 파일을 확인하지 못한 것을 "키 없음" 으로 보고 새 키로 덮었다(모든 암호문 복호 불가)');
  assert.equal(r.keyMissing, true, '키를 쓸 수 없다고 판정해야 한다(새 키 · 임시 메모리 키로 넘어가지 않는다)');
  assert.equal(r.opened, '');
  assert.notEqual(r.pol.mode, 'plain', '정책 · 신뢰 사본을 못 읽었는데 신규 설치(plain)로 열었다 — 새 비밀이 평문으로 저장된다');
  assert.deepEqual(r.pol, { mode: 'unavailable', locked: true, problem: 'unreadable' });
  // 정책 · 신뢰 사본이 정말 없고(ENOENT) 키 파일만 확인하지 못했다 — '암호화를 쓴 흔적 없음(신규 설치)' 으로 읽지 않는다
  const e = child(async (c) => {
    c.put('secrets-key', 'k'.repeat(44));
    const V = await c.imp('security/secretVault.js');
    c.bad.set('secrets-key', 'EIO');
    const pol = V.loadSecretsPolicy();
    return { mode: pol.mode, locked: !!pol.locked, evidence: pol.evidence || [] };
  }, tmpDir());
  assert.deepEqual(e, { mode: 'unavailable', locked: true, evidence: ['key-file'] }, '확인하지 못한 키 파일을 흔적 없음으로 보고 plain 으로 열었다');
});

/* ── P6 SSH 공용 접속 상태 ─────────────────────────────────────────────────────────────── */
test('P6 sshaccess/state: 폴더 수준 읽기 오류 — 중지 기록을 빈 상태로 캐시하지 않는다(잠금 · 쓰기 거절 · 원본 유지)', () => {
  const r = child(async (c) => {
    const S = await c.imp('sshaccess/state.js');
    const set = S.setCorpStop('corp-a', { by: 'adm', reason: '점검' });
    const orig = c.raw('ssh-access-state.json');
    S._resetSshAccessStateForTest();
    const out = { set: set?.ok === true, stopped0: !!S.stopFor('corp-a') };
    S._resetSshAccessStateForTest();
    c.bad.set('ssh-access-state.json', 'EACCES');
    out.err = !!S.stateLoadError();
    out.write = S.setCorpStop('corp-b', { by: 'adm', reason: 'x' })?.ok === true;
    out.fileSame = c.raw('ssh-access-state.json') === orig;
    return out;
  }, tmpDir());
  assert.deepEqual({ set: r.set, stopped0: r.stopped0 }, { set: true, stopped0: true }, '전제: 중지 기록이 파일에 있다');
  assert.equal(r.err, true, '못 읽은 상태 파일을 "없음" 으로 보고 빈 상태를 캐시했다(멈춰 둔 법인의 키 접속이 다시 열린다)');
  assert.equal(r.write, false);
  assert.equal(r.fileSame, true, '빈 상태 + 새 기록으로 원본을 덮었다');
});

/* ── P7 · P8 · P9 등록부 · 토큰 · env ──────────────────────────────────────────────────── */
test('P7 수집 서버 등록부: registryLoadError 가 읽기 오류 표지를 지우지 않는다(등록 0개 · 오류 없음으로 읽히지 않게)', () => {
  const r = child(async (c) => {
    c.put('collectors.json', { collectors: [{ id: 'edge-a', name: 'edge-a', url: 'https://edge-a.example:8443', token: 't'.repeat(32) }, { id: 'edge-b', name: 'edge-b', url: 'https://edge-b.example:8443', token: 'u'.repeat(32) }] });
    c.bad.set('collectors.json', 'EACCES');
    const R = await c.imp('collector/registry.js');
    const n = R.loadCollectors().length;
    const e1 = R.registryLoadError();
    const e2 = R.registryLoadError({ skipLoad: true });
    return { n, e1: e1 ? { readError: !!e1.readError } : null, e2: e2 ? { readError: !!e2.readError } : null, summary: R.registryLoadErrorSummary()?.code || null };
  }, tmpDir());
  assert.equal(r.n, 0);
  assert.deepEqual(r.e1, { readError: true }, '읽기 오류 표지가 지워졌다 — 자동 저장 거절 · clearStaleRemote 건너뜀 · 링크 설정 503 이 풀린다');
  assert.deepEqual(r.e2, { readError: true });
  assert.ok(r.summary, '화면 · 응답용 요약도 있어야 한다');
});

test('P8 엣지 개별 토큰: 폴더 수준 읽기 오류 — 빈 목록을 표지 없이 캐시하지 않는다(발급 거절 · 원본 유지 · 읽히면 돌아옴)', () => {
  const r = child(async (c) => {
    const RD = await c.imp('util/jsonFileRead.js');
    let now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    RD._setJsonFileLoadClockForTest(() => now);
    const T = await c.imp('central/agentTokens.js');
    T.issueAgentToken('edge-a'); T.issueAgentToken('edge-b');
    const orig = c.raw('central-agent-tokens.json');
    T._resetAgentTokenCache();
    c.bad.set('central-agent-tokens.json', 'EACCES');
    const out = { n: T.listAgentTokens().length, err: !!T.agentTokensLoadError() };
    const iss = c.tryCall(() => T.issueAgentToken('edge-c'));
    out.issue = { issued: iss?.ok === true, code: iss?.code || null };
    out.fileSame = c.raw('central-agent-tokens.json') === orig;
    c.bad.clear(); now += RD.READ_RETRY_MS + 1_000;
    out.healed = { n: T.listAgentTokens().length, err: !!T.agentTokensLoadError() };
    return out;
  }, tmpDir());
  assert.equal(r.err, true, '못 읽은 토큰 파일을 "없음" 으로 보고 빈 목록을 표지 없이 캐시했다(개별 토큰 엣지 전부 401)');
  assert.deepEqual(r.issue, { issued: false, code: 'registry-unreadable' }, '읽기 오류 중의 발급은 거절');
  assert.equal(r.fileSame, true, '발급 한 번이 그 토큰 하나만 든 파일로 원본을 덮었다');
  assert.deepEqual(r.healed, { n: 2, err: false }, '읽히면 재시작 없이 돌아온다');
});

test('P9 env 파일 한 키 바꾸기: 있는데 못 읽으면 던진다 — 그 한 줄만 든 파일로 덮지 않는다(upsertEnvKeyStrict · persistEnv)', () => {
  const r = child(async (c) => {
    const orig = c.put('portal.test.env', 'AUTH_SECRET=keepme\nDATA_SOURCE=live\nCENTRAL_TOKEN=old\n');
    const T = await c.imp('central/token.js');
    c.bad.set('portal.test.env', 'EIO');
    const res = c.tryCall(() => T.upsertEnvKeyStrict('CENTRAL_TOKEN', 'f'.repeat(64), c.F('portal.test.env')));
    const out = { threw: res?.threw === true, code: res?.code || null, fileSame: c.raw('portal.test.env') === orig };
    c.bad.clear();
    const ok = c.tryCall(() => T.upsertEnvKeyStrict('CENTRAL_TOKEN', 'e'.repeat(64), c.F('portal.test.env')));
    out.healed = { prev: ok?.prevText === orig, kept: /AUTH_SECRET=keepme/.test(c.raw('portal.test.env') || '') };
    const none = c.tryCall(() => T.upsertEnvKeyStrict('CENTRAL_TOKEN', 'd'.repeat(64), c.F('portal.new.env')));
    out.fresh = { prev: none?.prevText === null ? null : 'x', made: /CENTRAL_TOKEN=/.test(c.raw('portal.new.env') || '') };
    return out;
  }, tmpDir());
  assert.equal(r.threw, true, '확인하지 못한 env 파일을 빈 파일로 보고 그 한 줄만 썼다');
  assert.equal(r.fileSame, true, 'AUTH_SECRET · DATA_SOURCE 가 사라졌다');
  assert.deepEqual(r.healed, { prev: true, kept: true });
  assert.deepEqual(r.fresh, { prev: null, made: true }, '정말 없는 파일(ENOENT)은 예전처럼 새로 만든다');
  const body = stripComments(fs.readFileSync(path.join(SRC, 'central', 'token.js'), 'utf8'));
  assert.doesNotMatch(body, /existsSync\(/, 'persistEnv · upsertEnvKeyStrict 는 existsSync 로 유무를 가르지 않는다');
  assert.equal((body.match(/code !== 'ENOENT'\) throw/g) || []).length, 2, '두 경로 모두 ENOENT 만 없음');
});

/* ── P10 서명 신뢰 키 ──────────────────────────────────────────────────────────────────── */
test('P10 서명 확인: 호스트 신뢰 키 파일을 확인하지 못한 것은 "없음" 이 아니다(회수 목록 없이 검증하지 않는다)', () => {
  const r = child(async (c) => {
    const S = await c.imp('upgrade/signature.js');
    c.put(S.HOST_KEYS_NAME, { keys: [], revoked: ['ed25519:0123456789abcdef'] });
    c.fs.chmodSync(c.F(S.HOST_KEYS_NAME), 0o644);
    const ok = S.loadTrust({ rootOwnedOnly: false });
    c.bad.set(S.HOST_KEYS_NAME, 'EACCES');
    const t = S.loadTrust({ rootOwnedOnly: false });
    return { ok: { present: ok.sources.host.present, revoked: ok.sources.host.revoked }, present: t.sources.host.present, revoked: t.sources.host.revoked, fatal: !!t.fatal };
  }, tmpDir());
  assert.deepEqual(r.ok, { present: true, revoked: 1 }, '전제: 회수 항목이 있는 호스트 키 파일');
  assert.equal(r.present, true, 'stat 실패(existsSync=false)를 "호스트 파일 없음" 으로 읽었다 — 그 파일의 회수 목록 없이 검증한다');
  assert.ok(r.revoked === 1 || r.fatal === true, '회수 목록을 합치거나(읽힘) 검증을 멈춘다(fatal)');
});

/* ── S 설정 로더 형제 ──────────────────────────────────────────────────────────────────── */
test('S1~S12 설정 로더: 폴더 수준 읽기 오류에 표지가 선다(표지 없는 기본값 금지 — 저장 거절 · 설정 pull 503 의 근거)', () => {
  const r = child(async (c) => {
    const cases = [
      ['ipam-subnet-notes.json', { '10.1.2': { purpose: 'p', desc: 'd' } }, 'ipam/subnetNotes.js', (M) => M.subnetNotesLoadError()],
      ['ipam-vcenter-ranges.json', { vcenters: { 'vc-a': { ranges: ['10.0.0.0/24'] } } }, 'ipam/rangeStore.js', (M) => M.vcRangesLoadError()],
      ['bmusage-settings.json', { enabled: true }, 'bmusage/settings.js', (M) => M.bmUsageLocalLoadError()],
      ['bmusage-distribute.json', { enabled: true }, 'bmusage/settings.js', (M) => M.bmUsageSettingsLoadError()],
      ['san-storage-map.json', { kinds: {}, directors: {} }, 'sanswitch/directorMap.js', (M) => M.directorMapLoadError()],
      ['storage-perf-check.json', { values: {} }, 'sanswitch/storageCheckSettings.js', (M) => M.checkSettingsLoadError()],
      ['horizon.json', { servers: [{ id: 'h1', name: 'h', url: 'https://hz.example', username: 'u', password: 'p' }] }, 'horizon/horizon.js', (M) => M.horizonLoadError()],
      ['gpu-guest.json', { enabled: true, vcenters: {} }, 'gpu/settings.js', (M) => M.gpuGuestSettingsLoadError()],
      ['svcmon-alert.json', { enabled: true }, 'svcmon/alertSettings.js', (M) => M.alertSettingsLoadError()],
      ['curuser-settings.json', { enabled: true, vcenters: {} }, 'curuser/settings.js', (M) => M.curUserSettingsLoadError()],
      ['bmusage-portmap.json', { v: 1, entries: [] }, 'bmusage/portMap.js', (M) => { M.listPortMap(); return M.portMapLoadError(); }],
      ['isidu-settings.json', { targets: [], retentionDays: 30 }, 'isidu/settings.js', (M) => M.isiduSettingsLoadError()],
    ];
    const orig = {};
    for (const [name, body] of cases) { orig[name] = c.put(name, body); c.bad.set(name, 'EACCES'); }
    const out = { rows: [] };
    const mods = {};
    for (const [name, , rel, fn] of cases) {
      let e = null; let threw = null;
      try { mods[rel] = mods[rel] || await c.imp(rel); e = fn(mods[rel]); } catch (x) { threw = String(x?.message || x).slice(0, 120); }
      out.rows.push({ name, err: !!e, readError: !!e?.readError, reason: String(e?.reason || '').slice(0, 80), threw });
    }
    // 저장 거절(둘만 — 꼴이 다른 둘): 대역 용도(409 코드) · 디렉터 매핑(issue)
    const note = mods['ipam/subnetNotes.js'].setSubnetNote('10.9.9', { purpose: 'x', desc: '' }, 'adm');
    out.noteSave = { ok: note.ok, code: note.code || null, same: c.raw('ipam-subnet-notes.json') === orig['ipam-subnet-notes.json'] };
    const dm = c.tryCall(() => mods['sanswitch/directorMap.js'].saveDirectorMap({ kinds: {}, directors: {} }, { by: 'adm' }));
    out.mapSave = { refused: !!(dm?.issue || dm?.threw || dm?.ok === false), same: c.raw('san-storage-map.json') === orig['san-storage-map.json'] };
    return out;
  }, tmpDir());
  for (const row of r.rows) {
    assert.equal(row.threw, null, `${row.name}: 로더가 던졌다 — ${row.threw}`);
    assert.equal(row.err, true, `${row.name}: 못 읽은 파일을 "없음" 으로 보고 표지 없는 기본값을 줬다`);
  }
  assert.match(r.rows.find((x) => x.name === 'bmusage-distribute.json').reason, /^배포 설정\(bmusage-distribute\.json\)/, '배포 설정 파일 자신의 표지여야 한다(로컬 설정 표지에 가려지지 않게) — 배포 꺼짐을 200 으로 내려보내지 않는 근거');
  assert.deepEqual(r.noteSave, { ok: false, code: 'settings-unreadable', same: true }, '대역 용도: 그 대역 하나만 든 파일로 원본을 덮었다');
  assert.deepEqual(r.mapSave, { refused: true, same: true });
});

/* ── V1 vcenters.json '있는데 못 읽음' ─────────────────────────────────────────────────── */
test('V1 vCenter 등록부를 확인하지 못한 것은 "미구성" 이 아니다 — 게스트 디스크 정리 판정이 null(지우지 않는다) · 같은 판정 4곳', () => {
  const r = child(async (c) => {
    c.put('vcenters.json', { vcenters: [{ id: 'vc-a', name: 'A', host: 'https://vc-a.example', username: 'u', password: 'p' }, { id: 'vc-b', name: 'B', host: 'https://vc-b.example', username: 'u', password: 'p' }] });
    c.bad.set('vcenters.json', 'EACCES');
    const G = await c.imp('guestdisk/service.js');
    const ids = G.knownVcenterIds({ vcenters: [{ id: 'vc-a' }] });
    return { ids: ids ? [...ids] : null };
  }, tmpDir());
  assert.equal(r.ids, null, '못 읽은 등록부를 "없음" 으로 보고 스냅샷의 vCenter 만 알려진 것으로 판정했다(vc-b 의 행을 지운다)');
  for (const rel of ['guestdisk/service.js', 'inventory/osScanner.js', 'routes/central/opsRoutes.js', 'routes/central.js']) {
    const body = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.doesNotMatch(body, /existsSync\(/, `${rel}: vcenters.json 유무를 existsSync 로 가르지 않는다`);
    assert.match(body, /!fileMissing\(/, `${rel}: 공용 판정(util/fileMissing.js)`);
  }
});

/* ── L 낮음 ────────────────────────────────────────────────────────────────────────────── */
test('L1 로그인 방식 재정의 파일: 확인하지 못했으면 덮지 않는다 · L2 온보딩 스냅샷: 확인하지 못한 원본을 "그때 없던 파일" 로 보고 직전 스냅샷을 지우지 않는다', () => {
  const r = child(async (c) => {
    const orig = c.put('login-policy-users.txt', '# 재정의\nkim=otp\nlee=password\n');
    const SS = await c.imp('security/securitySettings.js');
    c.bad.set('login-policy-users.txt', 'EIO');
    const res = SS.setFileLoginPolicy('park', 'both');
    const out = { l1: { ok: res.ok, same: c.raw('login-policy-users.txt') === orig } };
    SS.invalidateLoginPolicyCache();
    SS.userLoginPolicy?.('kim');
    out.l1.warned = c.logs.some((l) => /login-policy-users.*읽기 실패\(EIO\)/.test(l));
    c.bad.clear();
    // L2
    c.put('idrac.json', { servers: [{ id: 's1', host: '10.0.0.1' }] });
    c.fs.mkdirSync(c.F('onboard-prev'), { recursive: true });
    c.fs.writeFileSync(c.path.join(c.F('onboard-prev'), 'idrac.json'), '{"servers":[{"id":"old"}]}');
    const O = await c.imp('bmusage/onboard/onboardRun.js');
    c.bad.set('idrac.json', 'EIO');
    const snap = c.tryCall(() => O.snapshotRegistries({ files: ['idrac.json'], by: 'adm' }));
    c.bad.clear();
    out.l2 = { threw: snap?.threw === true, prevKept: c.fs.existsSync(c.path.join(c.F('onboard-prev'), 'idrac.json')) };
    const ok = O.snapshotRegistries({ files: ['idrac.json', 'fleet-tags.json'], by: 'adm' });
    out.l2.files = ok.files;
    return out;
  }, tmpDir());
  assert.deepEqual({ ok: r.l1.ok, same: r.l1.same }, { ok: false, same: true }, '재정의 파일을 확인하지 못했는데 그 사용자 한 줄만 든 파일로 덮었다');
  assert.equal(r.l1.warned, true, '확인하지 못한 재정의 파일은 무음이 아니라 읽기 실패 경고로');
  assert.deepEqual({ threw: r.l2.threw, prevKept: r.l2.prevKept }, { threw: true, prevKept: true }, '확인하지 못한 등록부를 "없던 파일" 로 보고 직전 스냅샷을 지웠다');
  assert.deepEqual(r.l2.files, ['idrac.json'], '정말 없는 파일(ENOENT)은 예전처럼 스냅샷에서 뺀다');
});

/* ── 공용 판정 ─────────────────────────────────────────────────────────────────────────── */
test('공용 판정 fileMissing: ENOENT 만 없음 — 그 밖의 stat 실패 · ENOTDIR 은 없음이 아니다 · config.js 도 이것을 쓴다', async () => {
  const { fileMissing } = await import('../src/util/fileMissing.js');
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'a.json'), '{}');
  assert.equal(fileMissing(path.join(d, 'a.json')), false);
  assert.equal(fileMissing(path.join(d, 'none.json')), true);
  assert.equal(fileMissing(path.join(d, 'a.json', 'x.json')), false, 'ENOTDIR 은 없음이 아니다(뒤따르는 읽기가 읽기 오류로 가른다 — readJsonFile 과 같은 판정)');
  fs.symlinkSync('loop', path.join(d, 'loop'));
  assert.equal(fs.existsSync(path.join(d, 'loop', 'x.json')), false, '전제: existsSync 는 ELOOP 에도 false');
  assert.equal(fileMissing(path.join(d, 'loop', 'x.json')), false, 'ELOOP 은 없음이 아니다');
  fs.symlinkSync(path.join(d, 'gone'), path.join(d, 'dangling'));
  assert.equal(fileMissing(path.join(d, 'dangling')), true, '끊어진 링크는 없음(읽기도 ENOENT)');
  const util = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'util', 'fileMissing.js'), 'utf8'));
  assert.match(util, /try \{ fs\.statSync\(file\); return false; \} catch \(e\) \{ return e\?\.code === 'ENOENT'; \}/);
  const cfg = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'config.js'), 'utf8'));
  assert.match(cfg, /import \{ fileMissing \} from '\.\/util\/fileMissing\.js';/);
  assert.match(cfg, /const vcFileMissing = fileMissing;/, '판정 사본을 두지 않는다');
  for (const [rel, re] of [
    ['ipam/vcRangeMigrate.js', /if \(!fileMissing\(src\)\) \{/],
    ['util/settingsLoadError.js', /if \(full && !fileMissing\(full\)\) return \{ ok: false, code: 'file-present'/],
    ['auth/auth.js', /if \(!fileMissing\(path\.join\(CONFIG_DIR, 'users\.json'\)\)\) users = null;/],
    ['security/secretVault.js', /if \(fileMissing\(fp\)\) \{ out\.files\.push\(/],
  ]) assert.match(stripComments(fs.readFileSync(path.join(HERE, '..', 'src', rel), 'utf8')), re, rel);
});

/* ── 전수 분류표 ───────────────────────────────────────────────────────────────────────── */
/*
 * `existsSync(` 가 남은 곳 전부(주석 제외 · 파일별 개수). 분류:
 *  loader-safe  설정 · 등록부 로더지만 뒤의 읽기(공용 읽기 · 오류 코드)가 다시 가르거나, false 가 닫는 쪽 · 무해한 쪽으로만 간다(근거)
 *  cache        다시 만들어지는 사본 · 기록 · 상태(97회차 분류표의 cache 와 같다 — 못 읽으면 빈 값으로 시작하고 다음 push · 수집이 채운다). 읽기 오류 갈래도 같은 결과다
 *  guard        보존(preserveCorrupt) · 표시 앞의 유무 확인 — false 면 그 동작을 건너뛸 뿐이다
 *  probe        상태 표시 · 진단용 유무(표지 · 배지 · 안내) — 판정 · 저장에 쓰이지 않는다
 *  db           DB 파일 유무(없으면 열지 않음 · 정리 건너뜀 — 빈 DB 를 만들지 않게). stat 이 실패하면 여는 것도 실패한다
 *  dir          폴더 유무(mkdir · 목록 앞)
 *  artifact     패키지 · 번들 · 웹 빌드 · sysfs · 로그 파일 유무(없으면 기능 꺼짐 · 안내 · 머리말 쓰기)
 *  cleanup      삭제 · 옮기기 앞(실패해도 다음 기회)
 *  left         결함일 수 있으나 이번에 고치지 않음(사유)
 * 고친 곳(loader-fixed)은 existsSync 가 없어져 이 표에 없다 — 위 테스트가 고정한다. 새 `existsSync` 는 여기 분류해 넣어야 한다(로더면 util/fileMissing.js 머리말을 먼저 읽을 것).
 */
const TABLE = {
  'attach/store.js': [['probe', 3, '본체 유무 표시(missing) · 내보내기 목록 — 목록 · 본체를 지우지 않는다']],
  'auth/auth.js': [['probe', 1, 'initial-admin-password.txt 안내(경로만 · 못 보면 안내 없음)']],
  'backup/service.js': [['artifact', 1, '백업 파일 내려받기 경로(없으면 404)']],
  'backup/stagedRestore.js': [['loader-safe', 3, '예약 복원 표지 파일 — 폴더 수준 오류면 예약 · 중단 흔적 둘 다 false 라 적용하지 않는다(닫는 쪽)'], ['probe', 1, '덮어쓰기 여부 표시(replaced)']],
  'bareos/digest.js': [['cache', 1, '일일 요약 메일 발송 상태(읽기 오류 갈래도 빈 상태)']],
  'bareos/install/job.js': [['cache', 1, '설치 작업 기록']],
  'bareos/notify.js': [['cache', 1, '메일 발송 상태']],
  'bmusage/monthStore.js': [['db', 1, '기간 파일(없으면 열지 않음)']],
  'bmusage/onboard/keyStore.js': [['probe', 1, '저장소 파일 권한 점검(못 보면 null)']],
  'bmusage/onboard/onboardRun.js': [['cleanup', 1, '그때 없던 파일의 옛 스냅샷 지우기 — 앞의 fileMissing 이 정말 없을 때만 이 갈래로 보낸다(L2)']],
  'bmusage/perfAlerts.js': [['cache', 1, '알림 상태(다음 주기부터 다시 셈)']],
  'bmusage/poller.js': [['probe', 2, 'iDRAC 등록부가 손상 보존으로 옮겨졌는지 알아채기(sourceErrors 문구) — 등록부 자체는 공용 읽기'], ['db', 5, 'bm-usage.db 유무(없으면 정리 · 보정 · 마이그레이션 건너뜀)']],
  'bmusage/settings.js': [['guard', 3, '손상 보존(preserveCorrupt) 앞의 유무 확인']],
  'capacity/collectors.js': [['artifact', 4, '/sys/class/net 유무(NIC 종류 판정)']],
  'central/agentGpuGuestConfig.js': [['loader-safe', 1, '오류가 없을 때만 missing() — 보존본 판정을 세울 뿐 지우지 않는다. 읽기는 공용 읽기(103회차)']],
  'central/pduEdge.js': [['cache', 1, '엣지 스냅샷(다음 push)']],
  'central/tokenApplyJob.js': [['cache', 1, '작업 기록']],
  'central/unsupportedServers.js': [['cache', 1, '미지원 서버 표본(다음 push)']],
  'datacenter/store.js': [['cleanup', 1, '옛 파일 지우기']],
  'idrac/db.js': [['cache', 1, 'SQLite 없는 폴백 NDJSON(전력 이력 — 못 읽으면 빈 채 시작 · 재기록은 상한 넘을 때만)']],
  'idrac/invCache.js': [['cache', 1, '인벤토리 캐시(다음 수집)']],
  'idrac/sensorDetailCache.js': [['cache', 1, '센서 상세 캐시(다음 수집)']],
  'index.js': [['artifact', 2, '소개 페이지 · 웹 빌드 폴더']],
  'insights/dbLocation.js': [['dir', 1, 'DB 폴더 만들기']],
  'insights/fleetAssign.js': [['cleanup', 1, '옛 파일 지우기']],
  'insights/fleetTags.js': [['cleanup', 1, '옛 파일 지우기']],
  'ipam/scanLog.js': [['cache', 1, '스캔 로그(최근 n건)']],
  'ipam/scanStore.js': [['left', 1, '스캔 결과 · 이력(readJson) — 97 · 103회차가 남긴 것 그대로(기동 1회 읽기 + 디바운스 저장이라 보류 장치가 필요 — 읽기 오류 갈래도 보존 후 기본값). 설정은 공용 판정']],
  'issues/notify.js': [['cache', 2, '알림 발송 상태']],
  'metrics/vmperfDb.js': [['cleanup', 4, '옛 경로 → 새 경로 옮기기 · 빈 DB 지우기']],
  'net/captureHistory.js': [['cache', 1, '캡처 기록']],
  'partfault/db.js': [['db', 1, 'DB 파일 유무']],
  'pdu/thresholds.js': [['left', 1, 'PDU 임계값 로더 — 다른 회차(133)가 진행 중인 파일이라 고치지 않았다(같은 꼴: 확인하지 못하면 빈 임계값)']],
  'perf/hangLog.js': [['artifact', 4, '멈춤 로그 파일(지우기 · 자르기 · 읽기 앞)']],
  'ping/store.js': [['cleanup', 1, '옛 파일 지우기']],
  'portalcheck/archScan.js': [['artifact', 3, '소스 트리 스캔']],
  'release-notes.js': [['cache', 1, '사용자 릴리스 노트(내장본이 있다)']],
  'rma/testRunner.js': [['artifact', 1, '사용자 정의 점검 file-exists(유무가 곧 결과 — 확인 실패를 "없음" 으로 답한다: 추정으로 보고)']],
  'routes/api/attach.js': [['artifact', 1, '본체 없음 410']],
  'routes/dlsource.js': [['artifact', 4, '패키지 폴더 · 파일']],
  'routes/upgrade.js': [['artifact', 1, '설치 폴더 모양 확인']],
  'sanswitch/errBaseline.js': [['guard', 1, '손상 보존 앞의 유무 확인']],
  'sanswitch/flowJobs.js': [['cache', 1, '흐름 기록']],
  'security/credentialStore.js': [['cache', 1, '사용 횟수(손실 허용)']],
  'security/secretScan.js': [['artifact', 3, '점검 대상 파일 · 폴더']],
  'security/secretVault.js': [
    ['loader-safe', 1, '봉인 흔적 찾기(못 읽은 파일은 건너뜀) — 키 · 정책 판정은 이제 읽기 오류를 따로 가른다(P5)'],
    ['loader-safe', 2, '신뢰 사본 맞추기 — false 면 방금 읽은 정책을 다시 쓸 뿐(같은 내용)'],
    ['loader-safe', 1, 'keyPresent — false 면 키를 만들지 않는 쪽(닫는 쪽)'],
  ],
  'security/securitySettings.js': [['probe', 1, '콘솔 계정 도구의 재정의 표시(읽기 실패도 null)'], ['loader-safe', 1, '설정 소유자 파일 — 못 읽으면 소유자가 줄어든다(닫는 쪽 · 수퍼관리자는 늘 포함)']],
  'settingsStatus/sources.js': [['probe', 1, '설정 상태 배지(손상 보존본만 남음)']],
  'sshaccess/inbox.js': [['probe', 2, '읽지 않은 경로 안내 문구']],
  'sshaccess/usage.js': [['cache', 1, '키 사용 통계']],
  'storage/inspect/runner.js': [['cache', 1, '미전송 고리']],
  'storage/nodeLoadPoller.js': [['cache', 1, '미전송 표본']],
  'svcmon/csvlog.js': [['artifact', 3, 'CSV 로그 파일(머리말 · 내려받기)']],
  'svcmon/settingsSync.js': [['cache', 1, '동기 상태']],
  'tool-usage.js': [['cleanup', 1, '옛 파일 지우기']],
  'upgrade/bundleSource.js': [['artifact', 2, '번들 파일']],
  'upgrade/dbCheckpoint.js': [['db', 1, '-wal 유무']],
  'upgrade/fleetBundle.js': [['artifact', 2, '패키지 폴더의 번들 · manifest(있으면 쓰지 않음 — 다르면 거절)']],
  'upgrade/upgrade.js': [['artifact', 5, '설치 폴더 · 보존 경로 · 번들']],
  'usage/store.js': [['db', 1, 'DB 파일 유무(없으면 정리 건너뜀)']],
  'util/atomicWrite.js': [['guard', 1, 'preserveCorrupt 앞의 유무 확인']],
  'util/registryCore.js': [['loader-safe', 1, 'checkCorruptOnly — 이미 오류가 있으면 돌아가고, false 여도 세우기만 한다(지우지 않는다)']],
  'util/settingsLoadError.js': [['loader-safe', 1, 'currentError — 오류가 없을 때만 missing()(세우기만)']],
  'util/sshKeyStore.js': [['loader-safe', 1, '키 후보 건너뜀 — 새 키는 wx(배타 생성)라 있는 키를 덮지 않는다']],
  'vmclone/notify.js': [['cache', 1, '메일 상태']],
  'vmclone/runner.js': [['artifact', 4, 'NFS 백업 폴더 · manifest(중단된 백업 정리 — 마운트 확인 뒤)']],
  'vmseries/db.js': [['db', 1, 'DB 파일 유무'], ['cleanup', 1, '빈 DB 지우기']],
};
/* 같은 꼴(`statSync` 를 catch 로 '없음' 처리) 가운데 설정 · 보안 로더 — 열어 본 것만(나머지 크기 표시 · mtime 캐시 키는 보고서). */
const STAT_SIBLINGS = {
  'isidu/settings.js': 'fixed — 134회차 S12(ENOENT 만 없음)',
  'idrac/registry.js': 'safe — ENOENT 만 없음 · 그 밖은 공용 읽기가 가른다',
  'security/tlsTrust.js': 'safe — ENOENT 만 없음 · 그 밖은 오류로 남긴다',
  'gpu/settings.js': 'safe — gpuGuestEnabledLight: ENOENT 만 기본값 · 그 밖은 던진다',
  'ipam/rangeStore.js': 'safe — mtime 캐시 키(0) · 유무는 fileMissing(134회차)',
  'idrac/scanRanges.js': 'safe — mtime 캐시 키 · 읽기는 공용 읽기',
  'bmusage/maint/store.js': 'safe — loadAll 은 읽기가 가른다 · loadDeployed 는 못 보면 null(억제하지 않는 쪽)',
  'routes/publicApi.js': 'safe — 못 보면 등록부 0개 + 스냅샷(알려진 vCenter 가 줄어든다 — 닫는 쪽)',
  'bmfolders/edgeCopy.js': 'cache — 중앙 사본(다음 배포가 다시 쓴다)',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const HEAD_SRC = path.join(HERE, '..', 'src');
const CLASSES = ['loader-safe', 'cache', 'guard', 'probe', 'db', 'dir', 'artifact', 'cleanup', 'left'];

test('스윕: existsSync 가 남은 곳은 전부 분류표에 있다(새 existsSync 는 분류해 넣을 것) · 고친 로더에는 없다', () => {
  const found = {};
  for (const f of walk(HEAD_SRC)) {
    const rel = path.relative(HEAD_SRC, f).split(path.sep).join('/');
    const n = (stripComments(fs.readFileSync(f, 'utf8')).match(/\bexistsSync\(/g) || []).length;
    if (n) found[rel] = n;
  }
  const unlisted = Object.keys(found).filter((k) => !TABLE[k]);
  assert.deepEqual(unlisted, [], `분류표에 없는 existsSync — 로더면 util/fileMissing.js 머리말대로(ENOENT 만 없음) 고치고, 아니면 분류해 넣을 것: ${unlisted.join(', ')}`);
  const gone = Object.keys(TABLE).filter((k) => !found[k]);
  assert.deepEqual(gone, [], `분류표에만 있는 파일(existsSync 가 없어졌다 — 줄을 지울 것): ${gone.join(', ')}`);
  const totals = {};
  for (const [rel, rows] of Object.entries(TABLE)) {
    let sum = 0;
    for (const [cls, n, why] of rows) {
      assert.ok(CLASSES.includes(cls), `${rel}: 모르는 분류 ${cls}`);
      assert.ok(Number.isInteger(n) && n > 0 && String(why || '').length > 3, `${rel}: 개수 · 근거`);
      sum += n; totals[cls] = (totals[cls] || 0) + n;
    }
    assert.equal(found[rel], sum, `${rel}: existsSync ${found[rel]}곳인데 분류표는 ${sum}곳 — 새로 들어왔으면 분류해 넣을 것`);
  }
  assert.deepEqual(totals, { 'loader-safe': 12, cache: 22, guard: 5, probe: 12, db: 10, dir: 1, artifact: 40, cleanup: 11, left: 2 });   // 합 115(67파일)
  // 고친 로더(이 회차) — existsSync 로 되돌리면 실패
  for (const rel of ['auth/permissions.js', 'auth/sessionState.js', 'sshaccess/state.js', 'upgrade/signature.js', 'collector/registry.js', 'central/agentTokens.js', 'central/token.js',
    'ipam/subnetNotes.js', 'ipam/rangeStore.js', 'sanswitch/directorMap.js', 'sanswitch/storageCheckSettings.js', 'horizon/horizon.js', 'gpu/settings.js', 'svcmon/alertSettings.js',
    'curuser/settings.js', 'bmusage/portMap.js', 'guestdisk/service.js', 'inventory/osScanner.js', 'routes/central.js', 'routes/central/opsRoutes.js', 'ipam/vcRangeMigrate.js', 'config.js']) {
    assert.doesNotMatch(stripComments(fs.readFileSync(path.join(HEAD_SRC, rel), 'utf8')), /\bexistsSync\(/, `${rel}: existsSync 로 파일 유무를 가르지 말 것(stat 실패도 false 다)`);
  }
  // 같은 꼴(statSync catch)의 표본 — 파일이 있는지만 고정
  for (const rel of Object.keys(STAT_SIBLINGS)) assert.ok(fs.existsSync(path.join(HEAD_SRC, rel)), `${rel} 가 없다 — 표를 고칠 것`);
});
