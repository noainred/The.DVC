/**
 * test/bareosSetupOtp2842.test.js — v2.842 Bareos 자동 설정 본인 OTP 재확인 켜고 끄기(사용자 요청 '설정에서 otp 사용여부 변경' — 고른 범위 'Bareos 자동 설정만' · 검증 '전체').
 *  ① 설정 값: 기본 켬 · 파일의 **불리언 false 만** 끔(문자열 'false'·0·null·없음·손상 = 켬) · 저장은 불리언일 때만 바꾼다(무관한 저장·옛 화면이 끄지 않는다)
 *  ② 라우트 게이트: 켬이면 OTP 없는 쓰기 단계 403(otpRequired) · OTP 미등록 403(needEnroll) · 끔이면 OTP 없이 지나가고 감사 앞에 '[본인 OTP 재확인 꺼짐]' ·
 *     **끔이어도 OTP 미등록 계정은 403**(반증 F2 — 실행 계정을 넓히지 않는다) · 실패 경로도 표시 · fd-plugin 라우트도 같다 ·
 *     요청마다 지금 값(다시 켜면 바로 403) · 쓰기가 아닌 단계(사전 점검)는 감사 표시 없음 · 조회 응답 setupOtp · setupOtpOff
 *  ⑤ 복원(반증 F1 — 재현): 백업 판본의 '끔' 은 지금 파일도 끔일 때만 — 아니면 켬으로 적용하고 경고(복원 라우트는 OTP 를 묻지 않는다)
 *  ③ 바꾸는 경로: 설정 › 세션 보안 PUT — 소유자가 아니면 403 · 본인 OTP 가 틀리면 403(바뀌지 않음) · 바뀌면 감사에 켬 → 끔
 *  ④ 범위: 복원 등 다른 작업의 OTP 는 이 설정을 보지 않는다(소스 — verifyUserOtp 를 이 값으로 감싸는 곳은 setupGate 하나)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosotp2842-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [
  { username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'noot', role: 'admin' },
] }));
fs.writeFileSync(path.join(tmp, 'settings-owners.txt'), 'adm\n');

const SEC = await import('../src/security/securitySettings.js');
const A = await import('../src/bareos/autoSetup.js');
const S = await import('../src/bareos/settings.js');
const DIR = S.addDirector({ name: '한국 본사', host: '10.20.30.40', port: 9101 }).director.id;
const { fakeServer, fakeConsole } = await import('./_fakeBareosSsh.js');
const SSH_PW = 'ssh-Secret-2842';
const DIR_BODY = { host: '10.20.30.40', username: 'root', password: SSH_PW, restoreClient: 'kr-fd', restoreStorage: 'File', restorePool: 'Full' };
const SEC_FILE = path.join(tmp, 'security-session.json');
const writeSec = (o) => fs.writeFileSync(SEC_FILE, typeof o === 'string' ? o : JSON.stringify(o));

/** 30초 경계에서 떨어뜨린 TOTP(검증 창 ±1 안) — 경계 15초 안이면 다음 단계까지 기다린다. */
async function freshCounter() {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 50));
  return Math.floor(Date.now() / 30_000);
}

test('① 설정 값 — 기본 켬 · 불리언 false 만 끔 · 손상은 켬 · 저장은 불리언일 때만', () => {
  fs.rmSync(SEC_FILE, { force: true });
  assert.equal(SEC.bareosSetupOtpRequired(), true, '파일 없음 = 켬');
  assert.equal(SEC.loadConfiguredSecurity().bareosSetupOtp, true);
  for (const v of ['false', 0, null, 'off', '']) { writeSec({ bareosSetupOtp: v }); assert.equal(SEC.bareosSetupOtpRequired(), true, `${JSON.stringify(v)} 은 끔이 아니다`); }
  writeSec({ bareosSetupOtp: false });
  assert.equal(SEC.bareosSetupOtpRequired(), false);
  writeSec('{ bad json');
  assert.equal(SEC.bareosSetupOtpRequired(), true, '손상 = 켬(약하게 읽지 않는다)');
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('security-session.json.corrupt')), '손상본은 보존');

  fs.rmSync(SEC_FILE, { force: true });
  assert.equal(SEC.saveSessionSecurity({ bareosSetupOtp: 'false' }).bareosSetupOtp, true, '글자 false 로는 끄지 않는다');
  assert.equal(SEC.saveSessionSecurity({ bareosSetupOtp: false }).bareosSetupOtp, false);
  assert.equal(SEC.saveSessionSecurity({ idleLogoutMin: 20 }).bareosSetupOtp, false, '무관한 저장은 그대로 둔다');
  assert.equal(SEC.saveSessionSecurity({ bareosSetupOtp: undefined }).bareosSetupOtp, false);
  assert.equal(SEC.saveSessionSecurity({ bareosSetupOtp: true }).bareosSetupOtp, true);
});

/* ───────────── HTTP ───────────── */
let srvHttp, base, auditMod;
const USERS = { adm: { username: 'adm', role: 'admin', scope: null }, noot: { username: 'noot', role: 'admin', scope: null }, other: { username: 'other', role: 'admin', scope: null } };
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const { store } = await import('../src/store.js');
  auditMod = await import('../src/audit.js');
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp' }], hosts: [], datastores: [], vms: [], alarms: [], networks: [] };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  srvHttp = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srvHttp.address().port}/api`;
});
after(() => { try { srvHttp?.close(); } catch { /* */ } A._setDepsForTest(); });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}
const SETUP = (p) => `/tools/bareos-backup/settings/directors/${DIR}/auto-setup${p}`;
const auditRows = () => auditMod.listAudit({ limit: 500 }).items || auditMod.listAudit({ limit: 500 });
const lastAudit = (action) => [].concat(auditRows()).filter((x) => x.action === action)[0];

test('② 라우트 게이트 — 켬: OTP 없이 403 · 끔: OTP 없이 지나가고 감사 표시 · 다시 켜면 바로 403 · 조회 응답 setupOtp', async () => {
  fs.rmSync(SEC_FILE, { force: true });
  const srv = fakeServer();
  A._setDepsForTest({ ssh: srv.ssh, openConsole: fakeConsole().open, sleep: async () => {} });

  const g1 = await call('adm', 'GET', '/tools/bareos-backup/settings');
  assert.equal(g1.j.setupOtp, true); assert.equal(g1.j.setupOtpOff, null);
  const r1 = await call('adm', 'POST', SETUP('/director'), DIR_BODY);
  assert.equal(r1.s, 403); assert.equal(r1.j.otpRequired, true);
  const n1 = await call('noot', 'POST', SETUP('/director'), DIR_BODY);
  assert.equal(n1.s, 403); assert.equal(n1.j.needEnroll, true);
  assert.equal(srv.st.cmds.length, 0, '켬이면 OTP 없는 요청은 원격 접속 0');

  SEC.saveSessionSecurity({ bareosSetupOtp: false });
  const g2 = await call('adm', 'GET', '/tools/bareos-backup/settings');
  assert.equal(g2.j.setupOtp, false); assert.equal(g2.j.setupOtpOff, 'setting');
  const r2 = await call('adm', 'POST', SETUP('/director'), DIR_BODY);
  assert.equal(r2.s, 200, r2.t);
  assert.match(lastAudit('Bareos 자동 설정(Director)').detail, /^\[본인 OTP 재확인 꺼짐\] 성공 — /, '표시는 앞에(1000자 자름에 잘리지 않게 — 반증 F5)');
  const cmdsBefore = srv.st.cmds.length;
  const n2 = await call('noot', 'POST', SETUP('/director'), DIR_BODY);
  assert.equal(n2.s, 403, `끔이어도 OTP 미등록 계정은 실행하지 못한다(반증 F2): ${n2.t}`);
  assert.equal(n2.j.needEnroll, true);
  assert.equal(n2.j.otpRequired, undefined, '끔이면 화면이 OTP 칸을 다시 열 이유가 없다');
  assert.equal(srv.st.cmds.length, cmdsBefore, '미등록 거부는 원격 접속 0');
  // fd-plugin 라우트도 같은 게이트 — 끔이면 OTP 없이 지나가고(가짜 서버라 원격 단계는 실패) 실패 감사에도 표시
  const fp = await call('adm', 'POST', SETUP('/fd-plugin'), { host: '10.20.30.40', password: SSH_PW });
  assert.notEqual(fp.s, 403, fp.t);
  assert.match(lastAudit('Bareos 자동 설정(FD 플러그인)').detail, /^\[본인 OTP 재확인 꺼짐\] (실패|성공|이미)/);
  // 쓰기가 아닌 단계는 원래 OTP 를 묻지 않는다 — 감사에 '꺼짐' 을 붙이지 않는다
  const pf = await call('adm', 'POST', SETUP('/preflight'), { host: '10.20.30.40', password: SSH_PW });
  assert.equal(pf.s, 200, pf.t);
  assert.doesNotMatch(lastAudit('Bareos 자동 설정(사전 점검)').detail, /OTP 재확인 꺼짐/);
  // 입력 오류는 여전히 400(게이트의 다른 판정은 그대로)
  assert.equal((await call('adm', 'POST', SETUP('/director'), { ...DIR_BODY, restoreClient: 'a b' })).s, 400);

  SEC.saveSessionSecurity({ bareosSetupOtp: true });
  const f3 = await call('adm', 'POST', SETUP('/fd-plugin'), { host: '10.20.30.40', password: SSH_PW });
  assert.equal(f3.s, 403); assert.equal(f3.j.otpRequired, true);
  const r3 = await call('adm', 'POST', SETUP('/director'), DIR_BODY);
  assert.equal(r3.s, 403, '다시 켜면 캐시 없이 바로 OTP 를 묻는다'); assert.equal(r3.j.otpRequired, true);
  const now = await freshCounter();
  const r4 = await call('adm', 'POST', SETUP('/director'), { ...DIR_BODY, otp: generateToken(SECRET, { counter: now }) });
  assert.equal(r4.s, 200, r4.t);
  assert.doesNotMatch(lastAudit('Bareos 자동 설정(Director)').detail, /OTP 재확인 꺼짐/, '켬 상태의 실행에는 표시가 없다');
  assert.ok(!JSON.stringify(auditRows()).includes(SSH_PW), '감사에 비밀 없음');
});

test('③ 세션 보안 PUT — 소유자 + 본인 OTP · 틀리면 바뀌지 않음 · 감사에 켬 → 끔', async () => {
  fs.rmSync(SEC_FILE, { force: true });
  const notOwner = await call('other', 'PUT', '/admin/security/session', { bareosSetupOtp: false, otp: '000000' });
  assert.equal(notOwner.s, 403); assert.equal(notOwner.j.requiredOwner, true);
  const badOtp = await call('adm', 'PUT', '/admin/security/session', { bareosSetupOtp: false, otp: '000000' });
  assert.equal(badOtp.s, 403);
  assert.equal(SEC.bareosSetupOtpRequired(), true, 'OTP 가 틀리면 바뀌지 않는다');
  const g = await call('adm', 'GET', '/admin/security/session');
  assert.equal(g.j.bareosSetupOtp, true, '조회에 지금 값');
  // ② 가 이번 30초 단계의 코드를 이미 썼다(1회용 — 재사용 거부) → 다음 단계 코드(검증 창 ±1 안)
  const now = await freshCounter();
  const ok = await call('adm', 'PUT', '/admin/security/session', { bareosSetupOtp: false, otp: generateToken(SECRET, { counter: now + 1 }) });
  assert.equal(ok.s, 200, ok.t);
  assert.equal(ok.j.settings.bareosSetupOtp, false);
  assert.equal(SEC.bareosSetupOtpRequired(), false);
  assert.match(lastAudit('세션 보안/설정 접근 변경').detail, /Bareos 자동 설정 본인 OTP 재확인 켬 → 끔\(OTP 없이 실행\)/);
  SEC.saveSessionSecurity({ bareosSetupOtp: true });
});

test('④ 범위 — 이 설정으로 OTP 를 건너뛰는 곳은 Bareos 자동 설정 게이트 하나', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) { const s = stripComments(fs.readFileSync(p, 'utf8')); if (s.includes('bareosSetupOtpRequired(')) hits.push(path.relative(root, p)); } } };
  walk(root);
  assert.deepEqual(hits.sort(), ['routes/api/bareosBackup.js', 'security/securitySettings.js']);
  // 함수를 거치지 않고 값을 직접 읽는 우회도 없다(반증 F6) — 값을 아는 곳은 정의·저장 라우트(감사)·복원 맞춤뿐
  const direct = [];
  const walk2 = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk2(p); else if (p.endsWith('.js') && /\.bareosSetupOtp\b/.test(stripComments(fs.readFileSync(p, 'utf8')))) direct.push(path.relative(root, p)); } };
  walk2(root);
  assert.deepEqual(direct.sort(), ['backup/stagedRestore.js', 'routes/admin/opsSettings.js', 'security/securitySettings.js']);
  const src = stripComments(fs.readFileSync(path.join(root, 'routes/api/bareosBackup.js'), 'utf8'));
  const gate = /function setupGate\([\s\S]*?\n\}\n/.exec(src)?.[0] || '';
  assert.match(gate, /bareosSetupOtpRequired\(\)/, '판정은 setupGate 안');
  assert.match(gate, /writeStep && !getUser\(name\)\?\.totpEnabled/, 'OTP 미등록 검사는 끔이어도 돈다(반증 F2)');
  // 쓰기 세 라우트는 게이트를 지난 뒤에만 실행(엣지 대행 runSetup 포함) — 게이트가 runSetup 보다 앞
  for (const step of ['director', 'fd-plugin', 'fd']) {
    const route = new RegExp(`auto-setup/${step}',[\\s\\S]*?\\n\\}\\);`).exec(src)?.[0] || '';
    assert.ok(route.indexOf('setupGate(') > 0 && route.indexOf('setupGate(') < route.indexOf('runSetup('), `${step}: setupGate → runSetup 순서`);
    assert.doesNotMatch(route, /otp:\s*false/, `${step}: OTP 단계`);
  }
  // 복원(restoreRoute)의 본인 OTP 는 그대로(설정과 무관)
  const restore = /async function restoreRoute\([\s\S]*?\n\}\n/.exec(src)?.[0] || '';
  assert.ok(restore.length > 200, 'restoreRoute 를 찾았다');
  assert.match(restore, /verifyUserOtp\(/);
  assert.doesNotMatch(restore, /bareosSetupOtpRequired/);
});

test('⑤ 복원 — 백업의 끔은 지금도 끔일 때만 · 아니면 켬으로 적용하고 경고(반증 F1)', async () => {
  const R = await import('../src/backup/stagedRestore.js');
  const off = JSON.stringify({ idleLogoutMin: 30, bareosSetupOtp: false });
  const on = JSON.stringify({ idleLogoutMin: 30, bareosSetupOtp: true });
  const t1 = R.reconcileSecuritySessionText(off, on);
  assert.equal(t1.forcedOn, true); assert.equal(JSON.parse(t1.text).bareosSetupOtp, true); assert.equal(JSON.parse(t1.text).idleLogoutMin, 30, '다른 값은 백업 그대로');
  assert.equal(R.reconcileSecuritySessionText(off, null).forcedOn, true, '지금 파일 없음(새 서버) = 켬');
  assert.equal(R.reconcileSecuritySessionText(off, '{ bad').forcedOn, true, '지금 파일 손상 = 켬');
  assert.equal(R.reconcileSecuritySessionText(off, JSON.stringify({ bareosSetupOtp: 'false' })).forcedOn, true, '글자 false 는 끔이 아니다');
  const keep = R.reconcileSecuritySessionText(off, JSON.stringify({ bareosSetupOtp: false }));
  assert.equal(keep.forcedOn, false); assert.equal(keep.text, off, '지금도 끔이면 그대로');
  assert.equal(R.reconcileSecuritySessionText(on, JSON.stringify({ bareosSetupOtp: false })).text, on, '복원은 켜기는 한다');
  assert.equal(R.reconcileSecuritySessionText('{ bad', on).text, '{ bad', '깨진 판본은 그대로(로더가 손상 보존 → 켬)');
  // 적용 경로(applyStagedRestore 가 부르는 reconcileForApply) — 지금 파일을 읽어 맞춘다
  fs.writeFileSync(SEC_FILE, on);
  const rc = R.reconcileForApply('security-session.json', off, tmp);
  assert.equal(JSON.parse(rc.content).bareosSetupOtp, true);
  assert.match(rc.warning.reason, /복원으로는 끄지 않습니다/);
  fs.writeFileSync(SEC_FILE, JSON.stringify({ bareosSetupOtp: false }));
  assert.equal(R.reconcileForApply('security-session.json', off, tmp).content, off);
  fs.rmSync(SEC_FILE, { force: true });
});
