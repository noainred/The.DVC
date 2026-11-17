/**
 * test/securityResidual98.test.js — 전체 점검 98회차(보안 잔여 스윕) 회귀.
 *
 *  ① 연결 시험 비밀 승계 전수(91회차 ⓐ 의 형제 — 저장 경로 util/secretCarry.js 와 같은 판정):
 *     · 원격 접속 중계(proxy) SSH 자동배포 시험 — host · port 만 고정하고 username 은 요청값이라 다른 계정명으로 저장 root 비밀번호를 보냈다(실제 SSH 서버로 재현).
 *     · 에이전트 ↔ 수집 서버 진단(probe) — id 로 짝지은 수집 서버의 토큰을 배포 대상 주소(관리자가 바꿀 수 있다)로 보냈다(실제 HTTP 로 재현).
 *     · SMTP — 호스트만 신원이라 포트 · 계정만 바꾸면 저장 비밀번호를 승계했다.
 *     · GPU 게스트 시험 — 입력 계정명이 저장 VM 계정과 달라도 그 VM 의 저장 비밀번호를 보냈다(라우트는 vCenter 로그인이 필요해 원문 대조).
 *  ② 세션 보안 설정 신뢰 사본(91회차 남긴 것 ① — 권장안): 못 읽으면 직전 값 → 신뢰 사본 → ('파일 없음' 만) 기본값 → 그 밖은 엄격 값.
 *  ③ 긴급중단 손상(91회차 남긴 것 ③ — 권장안): 손상도 멈춤 · 원본을 옮기지 않음 · 2인 승인 해제로만 풀림 · 복원 제외.
 *
 * ⚠ 기준 시각은 실제 시각을 정시로 떨어뜨린 T0(고정 epoch · Date.now() 직접 금지 — docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('secres98-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.COLLECTOR_HTTP_ALLOW = '*';
process.env.SSH_HOSTKEY_POLICY = 'observe';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (rel) => stripComments(fs.readFileSync(path.resolve(HERE, '..', 'src', rel), 'utf8'));

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
const corruptCopies = (base) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${base}.corrupt.`));

/** 받은 SSH 인증 시도(계정 · 비밀번호)를 기록하는 가짜 SSH 서버(모두 거절). */
async function fakeSshd() {
  const got = [];
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') got.push({ user: ctx.username, pw: ctx.password });
      ctx.reject(['password']);
    });
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  return { got, port, close: () => srv.close() };
}

// ── ③ 긴급중단 손상 ────────────────────────────────────────────────────────────
test('③ 긴급중단 파일 손상 — 멈춤으로 시작 · 원본을 옮기지 않음(재시작해도 멈춤) · 상태에 사유 · 2인 승인 해제로만 풀림', async () => {
  const es = await import('../src/security/emergencyStop.js');
  const file = path.join(DIR, 'emergency-stop.json');
  fs.writeFileSync(file, '{"active": tr');   // 2인 승인으로 켠 뒤 깨진 파일(잘린 쓰기 · 디스크 오류)
  es._resetEmergencyStopForTest();
  clock += 1;
  assert.equal(es.isStopped(), true, '손상을 비활성으로 읽으면 2인 승인 긴급중단이 깨짐 한 번으로 풀린다');
  const st = es.getEmergencyStatus();
  assert.equal(st.active, true);
  assert.equal(st.corrupt?.failClosed, true, '화면이 사유를 말할 수 있게 상태에 싣는다');
  assert.ok(fs.existsSync(file), '원본을 옮기면 다음 기동이 "파일 없음" = 비활성으로 풀린다');
  assert.equal(corruptCopies('emergency-stop.json').length, 0);
  clock += 60_000;
  assert.equal(es.isStopped(), true, '시간이 지나도 다시 읽어 풀리지 않는다(캐시)');
  es._resetEmergencyStopForTest();   // 재시작
  assert.equal(es.isStopped(), true, '재시작해도 멈춤');
  es.setEmergencyStop(false, ['a1', 'a2']);   // 2인 승인 해제
  assert.equal(es.isStopped(), false);
  assert.equal(es.getEmergencyStatus().corrupt, undefined);
  es._resetEmergencyStopForTest();
  assert.equal(es.isStopped(), false, '해제가 새 상태로 저장된다');
  // 객체가 아닌 JSON 도 손상 · 파일 없음은 신규 설치(비활성)
  for (const t of ['null', '[]', '"x"']) {
    fs.writeFileSync(file, t); es._resetEmergencyStopForTest();
    assert.equal(es.isStopped(), true, `${t} 는 손상이다`);
  }
  fs.rmSync(file, { force: true }); es._resetEmergencyStopForTest();
  assert.equal(es.isStopped(), false, '파일 없음(한 번도 켠 적 없음)은 비활성');
  // 한 번 정상으로 읽은 뒤 파일이 깨져도 이 프로세스는 읽은 값을 그대로 쓴다
  es.setEmergencyStop(true, ['a1', 'a2']);
  fs.writeFileSync(file, '{broken');
  assert.equal(es.isStopped(), true);
  es.setEmergencyStop(false, ['a1', 'a2']);
});

test('③ 형제 — 백업 복원은 긴급중단 상태 · 세션 보안 신뢰 사본을 되돌리지 않는다(복원은 소유자 한 사람 · OTP 없음)', async () => {
  const R = await import('../src/backup/stagedRestore.js');
  assert.equal(R.stagedNameIssue('emergency-stop.json'), '복원 제외', '꺼짐 판본 복원이 2인 승인 긴급중단을 재시작 뒤 풀었다');
  assert.equal(R.stagedNameIssue('security-session.trusted.json'), '복원 제외');
  assert.equal(R.stagedNameIssue('security-session.json'), null, '본 파일은 약화 금지(reconcileForApply)로 복원한다');
  const staged = R.stageRestore({ 'emergency-stop.json': JSON.stringify({ active: false, by: [], at: T0 }), 'alarm-mutes.json': '{}' }, { configDir: DIR });
  assert.deepEqual(staged.files, ['alarm-mutes.json']);
  assert.ok(staged.dropped.some((d) => d.file === 'emergency-stop.json'));
  fs.rmSync(path.join(DIR, 'backups'), { recursive: true, force: true });
});

// ── ② 세션 보안 신뢰 사본 ───────────────────────────────────────────────────────
test('② 세션 보안 — 정상 읽기 · 저장이 신뢰 사본을 맞추고, 손상 · 손상 뒤 없음 · 재시작에도 약해지지 않는다', async () => {
  const sec = await import('../src/security/securitySettings.js');
  const file = path.join(DIR, 'security-session.json');
  const trusted = path.join(DIR, 'security-session.trusted.json');
  const stored = { idleLogoutEnabled: true, idleLogoutMin: 10, settingsOwners: ['alice'], loginPolicy: 'otp_only', singleSession: true, sessionMaxHours: 4 };
  fs.writeFileSync(file, JSON.stringify(stored));
  fs.rmSync(trusted, { force: true });
  sec._resetSessionSecurityReadForTest();
  clock += 1;
  assert.equal(sec.loadConfiguredSecurity().loginPolicy, 'otp_only');
  assert.deepEqual(JSON.parse(fs.readFileSync(trusted, 'utf8')), stored, '정상 읽기가 신뢰 사본을 맞춘다');
  // 손상 — 예전에는 곧바로 기본값(레거시 · 단일 세션 끔 · 총 상한 무제한 · 소유자 noainred)
  fs.writeFileSync(file, '{not json');
  clock += 1;
  let c = sec.loadConfiguredSecurity();
  assert.equal(c.loginPolicy, 'otp_only'); assert.equal(c.singleSession, true); assert.equal(c.sessionMaxHours, 4); assert.deepEqual(c.settingsOwners, ['alice']);
  assert.equal(sec.sessionSecurityRecovery()?.source, 'last-good');
  assert.equal(corruptCopies('security-session.json').length, 1, '손상본은 예전처럼 보존');
  assert.equal(fs.existsSync(file), false);
  clock += 1;
  c = sec.loadConfiguredSecurity();   // 보존본으로 옮겨진 뒤 — '파일 없음'
  assert.equal(c.loginPolicy, 'otp_only', '손상 뒤 둘째 읽기("파일 없음")도 약해지지 않는다(S-07 과 같은 꼴)');
  // 재시작 — 직전 값이 없으면 신뢰 사본
  sec._resetSessionSecurityReadForTest();
  c = sec.loadConfiguredSecurity();
  assert.equal(c.loginPolicy, 'otp_only'); assert.equal(c.sessionMaxHours, 4); assert.deepEqual(c.settingsOwners, ['alice']);
  assert.deepEqual(sec.sessionSecurityRecovery()?.source, 'trusted-copy');
  // 손상 중에는 저장할 수 있다(읽기 오류만 거절) — 저장이 본 파일 · 사본을 함께 맞춘다
  const saved = sec.saveSessionSecurity({ idleLogoutMin: 15 });
  assert.equal(saved.loginPolicy, 'otp_only', '저장 기준값도 사본 값(기본값 위에 저장하지 않는다)');
  assert.equal(JSON.parse(fs.readFileSync(trusted, 'utf8')).idleLogoutMin, 15);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).idleLogoutMin, 15);
  assert.equal(sec.sessionSecurityRecovery(), null);
  for (const f of corruptCopies('security-session.json')) fs.rmSync(path.join(DIR, f));
});

test('② 세션 보안 — 본 파일 · 사본 모두 못 읽은 손상 · 읽기 오류는 엄격 값, 둘 다 없는 "파일 없음" 만 기본값(신규 설치)', async () => {
  const sec = await import('../src/security/securitySettings.js');
  const file = path.join(DIR, 'security-session.json');
  const trusted = path.join(DIR, 'security-session.trusted.json');
  // 손상 + 사본 없음
  fs.writeFileSync(file, '{not json'); fs.rmSync(trusted, { force: true });
  sec._resetSessionSecurityReadForTest();
  clock += 1;
  let c = sec.loadConfiguredSecurity();
  assert.equal(c.loginPolicy, 'otp_only'); assert.equal(c.singleSession, true); assert.equal(c.sessionMaxHours, 8);
  assert.equal(c.idleLogoutEnabled, true); assert.equal(c.bareosSetupOtp, true);
  assert.equal(sec.sessionSecurityRecovery()?.source, 'strict');
  assert.equal(sec.bareosSetupOtpRequired(), true);
  for (const f of corruptCopies('security-session.json')) fs.rmSync(path.join(DIR, f));
  // 읽기 오류 + 사본 없음 — 엄격 값 · 저장 거절(88 F1 그대로)
  fs.writeFileSync(file, JSON.stringify({ loginPolicy: 'password_only' }));
  sec._resetSessionSecurityReadForTest();
  const undo = eioOn(file);
  try {
    clock += 1;
    c = sec.loadConfiguredSecurity();
    assert.equal(c.loginPolicy, 'otp_only', '한 번도 못 읽은 읽기 오류는 기본값(레거시)이 아니라 엄격 값');
    assert.equal(sec.sessionSecurityRecovery()?.problem, 'read-error');
    assert.throws(() => sec.saveSessionSecurity({ idleLogoutMin: 9 }), (e) => e.status === 503);
  } finally { undo(); }
  clock += 31_000;
  assert.equal(sec.loadConfiguredSecurity().loginPolicy, 'password_only', '읽히면 저장된 값(약한 값이어도 소유자가 OTP 로 정한 값)');
  // 읽기 오류 + 사본 있음 — 사본 값
  sec._resetSessionSecurityReadForTest();
  const undo2 = eioOn(file);
  try { clock += 1; assert.equal(sec.loadConfiguredSecurity().loginPolicy, 'password_only'); assert.equal(sec.sessionSecurityRecovery()?.source, 'trusted-copy'); } finally { undo2(); }
  // 둘 다 없음 — 신규 설치(예전과 같은 기본값)
  fs.rmSync(file, { force: true }); fs.rmSync(trusted, { force: true });
  sec._resetSessionSecurityReadForTest();
  clock += 31_000;
  c = sec.loadConfiguredSecurity();
  assert.equal(c.loginPolicy, null); assert.equal(c.singleSession, false); assert.equal(c.sessionMaxHours, 0);
  assert.equal(sec.sessionSecurityRecovery(), null);
  // 설정 화면(GET)이 본 파일 대신 도는 사실을 싣는다
  assert.match(src('routes/admin/opsSettings.js'), /sessionSecurityRecovery\(\)[\s\S]{0,300}recovery \? \{ recovery \}/);
});

// ── ① 연결 시험 비밀 승계 ───────────────────────────────────────────────────────
test('① SMTP — 포트 · 계정이 바뀌어도 저장 비밀번호를 승계하지 않는다(호스트 변경은 예전 사유 그대로)', async () => {
  const M = await import('../src/mail/settings.js');
  const cur = { host: 'smtp.corp.local', port: 25, user: 'svc-mail', password: 'Saved-SMTP-98' };
  assert.deepEqual(M.nextSmtpPassword({ host: 'smtp.corp.local', port: 2525, user: 'svc-mail' }, cur), { password: '', dropped: 'accessChanged' }, '같은 호스트의 다른 포트 리스너로 AUTH 되었다');
  assert.deepEqual(M.nextSmtpPassword({ user: 'other' }, cur), { password: '', dropped: 'accessChanged' }, '다른 계정명으로 저장 비밀번호를 보냈다');
  assert.deepEqual(M.nextSmtpPassword({ host: 'smtp-new.corp.local' }, cur), { password: '', dropped: 'hostChanged' });
  // 같은 신원(빈 칸 = 이전 값 · 대소문자 · 앞뒤 공백 · 글자 포트)은 예전처럼 유지
  for (const s of [{}, { port: '' }, { port: '25', user: ' SVC-mail ' }, { host: 'smtp.corp.local', port: 25, user: 'svc-mail', password: '' }]) {
    assert.deepEqual(M.nextSmtpPassword(s, cur), { password: 'Saved-SMTP-98', dropped: null }, JSON.stringify(s));
  }
  assert.deepEqual(M.nextSmtpPassword({ port: 2525, password: 'typed' }, cur), { password: 'typed', dropped: null }, '새로 준 비밀번호는 승계가 아니다');
  assert.match(M.smtpIssue({ host: 'smtp.corp.local', from: 'a@corp.local', port: 2525, user: 'svc-mail', password: '' }, 'accessChanged'), /포트나 계정이 바뀌어/);
  // 저장 경로(save)도 같은 판정
  M.save({ enabled: false, smtp: { host: 'smtp.corp.local', port: 25, user: 'svc-mail', password: 'Saved-SMTP-98', from: 'p@corp.local' } });
  assert.equal(M.load().smtp.password, 'Saved-SMTP-98');
  assert.equal(M.save({ smtp: { port: 2525 } }).smtp.password, '', '포트만 바꾼 저장도 비밀번호를 버린다');
});

test('① 원격 접속 중계 SSH 자동배포 시험 — 계정명이 저장값과 다르면 저장 비밀번호를 보내지 않는다(실제 SSH 서버)', async () => {
  const sshd = await fakeSshd();
  const express = (await import('express')).default;
  const { remoteRouter } = await import('../src/routes/remote.js');
  const reg = await import('../src/proxy/registry.js');
  reg.saveConfig({ deploy: { enabled: true, host: '127.0.0.1', port: sshd.port, username: 'root', password: 'Saved-Proxy-PW-98' } });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api/remote', remoteRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (body) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/deploy/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const a = await post({ deploy: { host: '127.0.0.1', port: sshd.port, username: 'attacker', password: '********' } });
    assert.equal(a.ok, false); assert.equal(a.method, 'carry-refused', JSON.stringify(a));
    const b = await post({ deploy: { host: '10.9.9.9', username: 'root', password: '********' } });
    assert.equal(b.method, 'carry-refused', '주소가 다르면 몰래 저장 주소로 바꿔 시험하지 않는다');
    assert.deepEqual(sshd.got, [], '저장 비밀번호가 다른 계정명으로 나가면 안 된다');
    // 같은 계정 · 주소(포트 빈 칸 = 저장값)는 예전처럼 저장 비밀번호로 시험한다
    const c = await post({ deploy: { host: '127.0.0.1', port: null, username: 'root', password: '********' } });
    assert.notEqual(c.method, 'carry-refused', JSON.stringify(c));
    assert.ok(sshd.got.some((g) => g.user === 'root' && g.pw === 'Saved-Proxy-PW-98'), JSON.stringify(sshd.got));
    assert.ok(sshd.got.every((g) => g.user === 'root'));
    // 비밀번호를 새로 주면 계정명이 달라도 시험한다(승계가 아니다)
    sshd.got.length = 0;
    await post({ deploy: { host: '127.0.0.1', port: sshd.port, username: 'other', password: 'typed-98' } });
    assert.ok(sshd.got.every((g) => g.pw === 'typed-98'));
  } finally { srv.close(); sshd.close(); }
});

test('① 원격 접속 중계 Data Plane 시험 · 저장 — 계정명도 신원(저장 경로 DP_ID_KEYS 와 같은 판정 · 실제 HTTP)', async () => {
  const express = (await import('express')).default;
  const auths = [];
  const dpApp = express();
  dpApp.use((req, res) => { auths.push(Buffer.from(String(req.get('authorization') || '').replace(/^Basic /, ''), 'base64').toString()); res.status(401).end(); });
  const dpSrv = await new Promise((r) => { const s = dpApp.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${dpSrv.address().port}`;
  const { remoteRouter } = await import('../src/routes/remote.js');
  const reg = await import('../src/proxy/registry.js');
  reg.saveConfig({ dataplane: { url, basePath: '/v3', username: 'admin', password: 'Saved-DP-PW-98' } });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api/remote', remoteRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (body) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const a = await post({ dataplane: { url, basePath: '/v3', username: 'other', password: '********' } });
    assert.equal(a.method, 'carry-refused', JSON.stringify(a));
    assert.ok(!auths.some((x) => x.includes('Saved-DP-PW-98')), `저장 비밀번호가 다른 계정명으로 나갔다: ${JSON.stringify(auths)}`);
    await post({ dataplane: { url, basePath: '/v3', username: 'admin', password: '********' } });
    assert.ok(auths.includes('admin:Saved-DP-PW-98'), `같은 계정은 예전처럼 저장 비밀번호로 시험: ${JSON.stringify(auths)}`);
    // 저장 경로 — 계정명만 바꾼 저장은 비밀번호를 버린다
    reg.saveConfig({ dataplane: { url, basePath: '/v3', username: 'other', password: '********' } });
    assert.equal(reg.getConfig().dataplane.password || '', '');
  } finally { srv.close(); dpSrv.close(); }
});

test('① 에이전트 ↔ 수집 서버 진단 — 수집 서버 토큰은 그 수집 서버의 저장 URL 로만(배포 대상 주소로 보내지 않는다)', async () => {
  const express = (await import('express')).default;
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const creg = await import('../src/collector/registry.js');
  const dreg = await import('../src/agent/deployRegistry.js');
  const seen = { edge: [], attacker: [] };
  const listen = (bucket) => new Promise((r) => {
    const a = express();
    a.get('/api/collector/export', (req, res) => { seen[bucket].push(req.get('X-Collector-Token') || ''); res.status(403).json({ error: 'forbidden' }); });
    const s = a.listen(0, '127.0.0.1', () => r(s));
  });
  const edge = await listen('edge'); const attacker = await listen('attacker');
  const app = express(); app.use(express.json());
  const rt = express.Router(); registerDeployLlm(rt); app.use('/api/admin', rt);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const add = creg.addCollector({ id: 'victim', name: 'victim', url: `http://127.0.0.1:${edge.address().port}`, token: 'victim-collector-token-98' }, { managed: true });
    assert.equal(add.ok, true, JSON.stringify(add));
    // 관리자가 저장한 배포 대상 — 이름(collectorDatacenter)만 피해 수집 서버 id 에 맞추고 주소는 자기 서버
    const t = dreg.saveTarget({ host: '127.0.0.1', port: 22, username: 'root', agentName: 'victim', collectorDatacenter: 'victim', portalPort: attacker.address().port, collectorToken: 'own-target-token' });
    assert.equal(t.ok, true, JSON.stringify(t));
    const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/agent-deploy/collector-sync/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [t.target.id] }) })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!seen.attacker.includes('victim-collector-token-98'), `배포 대상 주소가 수집 서버 토큰을 받았다: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.attacker, ['own-target-token'], '대상 토큰은 예전처럼 대상 주소로');
    assert.deepEqual(seen.edge, ['victim-collector-token-98'], '수집 서버 토큰은 그 수집 서버의 저장 URL 로');
    assert.equal(r.results[0].centralUrl, `http://127.0.0.1:${edge.address().port}`, '두 주소가 다르면 응답이 밝힌다');
    assert.equal(JSON.stringify(r).includes('victim-collector-token-98'), false);
  } finally { srv.close(); edge.close(); attacker.close(); }
});

test('① GPU 게스트 시험 — 입력 계정명이 저장 VM 계정과 다르면 그 VM 의 저장 비밀번호를 쓰지 않는다(저장 경로 carriedPw 와 같은 판정)', async () => {
  const { accessMoved } = await import('../src/util/secretCarry.js');
  const body = src('routes/admin/gpuGuest.js');
  const blk = body.slice(body.indexOf("adminRouter.post('/gpu-guest/test'"), body.indexOf("adminRouter.post('/gpu-guest/test-ssh'"));
  assert.match(blk, /else if \(it\.username\) \{[\s\S]{0,200}const storedVm = vcShared\.vms\?\.\[it\.vmId\];[\s\S]{0,120}!it\.passwordless && !it\.password && storedVm\?\.password && accessMoved\(storedVm, \{ username: it\.username \}, \['username'\]\)/);
  assert.match(blk, /accessMoved\([\s\S]{0,80}\)\) \{\s*results\[i\] = \{[^}]*login: false[\s\S]{0,400}continue;/);
  assert.equal(accessMoved({ username: 'root', password: 'x' }, { username: 'admin' }, ['username']), true);
  assert.equal(accessMoved({ username: 'root', password: 'x' }, { username: ' ROOT ' }, ['username']), false);
});
