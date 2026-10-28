/**
 * v2.809 — 업그레이드 서명 확인 시한부 끄기(사용자 요청 '서명 검증 활성화/비활성화' · 결정: 확인 불가만 허용 · 설정 소유자 + OTP 재인증 + 감사 ·
 * 시한 후 자동 복구). 되돌리면 안 되는 규칙:
 *  ① 끈 상태 = env warn 과 같은 판정 — manifest 없음은 경고 후 진행, **틀린 manifest·서명은 그대로 거부**
 *  ② env UPGRADE_SIGNATURE_POLICY 가 있으면 env 가 이긴다 · 오프라인 확인(verify CLI, where 'offline')·ignoreOverride 는 보지 않는다
 *  ③ 신뢰 키를 읽지 못하면(fatal) 적용하지 않는다 · 시한이 지나면 켜짐 · 파일 손상·형식 밖이면 켜짐(+ 보존)
 *  ④ 상태 파일(엣지 설정 push·백업 감시 제외) — 다른 포탈로 퍼지지 않는다
 *  ⑤ 라우트: 설정 소유자만(비소유자·범위 관리자 403) · 끄기는 OTP 재인증(틀리면 403 · 저장 안 됨) · 켜기는 OTP 없이 · env 잠금 409 · 감사 로그
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-sigov-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40), OTP_ROLE_ENFORCE: 'false', SETTINGS_OWNERS: 'own,sown' });
for (const k of ['UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ENABLED', 'UPGRADE_WATCH_DIR', 'UPGRADE_REMOTE_BASE', 'CENTRAL_URL', 'EDGE_MODE']) delete process.env[k];
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const SO = await import('../src/upgrade/signatureOverride.js');
const SIG = await import('../src/upgrade/signature.js');
SIG._setRunningAsRootForTest(false);   // 포탈은 서비스 계정으로 돈다(이 컨테이너는 root) — root 판정은 ⑥ 에서 따로
const H = 3_600_000;
const reset = () => { try { fs.unlinkSync(SO.overrideFile()); } catch { /* */ } SO._resetOverrideCacheForTest(); };

test('① 끄면 확인 불가만 통과 · 틀린 manifest 는 거부 · ② env 우선 · 오프라인·ignoreOverride 는 안 봄', () => {
  reset();
  assert.ok(SIG.loadTrust().activeCount > 0, '저장소 신뢰 키가 있어야 이 테스트가 의미 있다');
  assert.equal(SIG.signaturePolicy(process.env).policy, 'require');
  const bytes = Buffer.from('bundle-bytes');
  assert.equal(SIG.decideSignature({ manifestText: null, bytes, name: 'vmware-portal-99.0.0.tar.gz', where: 'watch' }).ok, false, '끄기 전');

  SO.setOverride({ hours: 2, by: 'own' });
  const p = SIG.signaturePolicy(process.env);
  assert.deepEqual([p.policy, p.source, p.by], ['warn', 'ui', 'own']);
  const d = SIG.decideSignature({ manifestText: null, bytes, name: 'vmware-portal-99.0.0.tar.gz', where: 'watch' });
  assert.deepEqual([d.ok, d.verified, d.warned, d.code], [true, false, true, 'manifest-missing']);
  assert.match(d.reason, /업그레이드 화면에서 서명 확인을 .* 끄도록 해\(own\)/);
  const bad = SIG.decideSignature({ manifestText: '{"format":"nope"}', bytes, name: 'vmware-portal-99.0.0.tar.gz', where: 'watch' });
  assert.equal(bad.ok, false, '형식이 틀린 manifest 는 끈 상태에서도 거부');
  assert.equal(SIG.decideSignature({ manifestText: null, bytes, name: 'x.tar.gz', where: 'offline' }).ok, false, '오프라인 확인(verify CLI)은 화면 끄기를 보지 않는다');
  assert.equal(SIG.signaturePolicy(process.env, undefined, { ignoreOverride: true }).policy, 'require');
  assert.deepEqual(SIG.signaturePolicy({ UPGRADE_SIGNATURE_POLICY: 'require' }).policy, 'require', 'env 가 이긴다');
  const st = SIG.signatureStatus();
  assert.deepEqual([st.policySource, st.envLocked, st.override.active, st.override.by], ['ui', false, true, 'own']);
  reset();
});

test('③ 신뢰 키 fatal 이면 적용 안 함 · 시한 지나면 켜짐 · 손상·형식 밖이면 켜짐 + 보존 · 시한 상한', () => {
  reset();
  SO.setOverride({ hours: 5, by: 'own' });
  const fatalTrust = { ...SIG.loadTrust(), fatal: '키 파일 손상' };
  assert.equal(SIG.signaturePolicy({}, fatalTrust).policy, 'require', '회수 목록을 모르는 채로 약하게 만들지 않는다');
  reset();
  SO.setOverride({ hours: 1, by: 'own', now: Date.now() - 2 * H });
  assert.equal(SIG.signaturePolicy({}).policy, 'require', '시한 지남');
  assert.equal(SIG.signatureStatus().override.active, false);
  reset();
  fs.writeFileSync(SO.overrideFile(), '{ broken');
  assert.equal(SIG.signaturePolicy({}).policy, 'require');
  assert.ok(fs.readdirSync(CFG).some((f) => f.startsWith(`${SO.OVERRIDE_NAME}.corrupt.`)), '손상본 보존');
  reset();
  const now = Date.now();
  fs.writeFileSync(SO.overrideFile(), JSON.stringify({ mode: 'warn', at: now, until: now + 30 * 24 * H, by: 'x' }));
  assert.equal(SIG.signaturePolicy({}).policy, 'require', '7일을 넘는 시한은 형식 밖');
  reset();
  fs.writeFileSync(SO.overrideFile(), JSON.stringify({ mode: 'off', at: now, until: now + H }));
  assert.equal(SIG.signaturePolicy({}).policy, 'require', '모르는 mode');
  reset();
  assert.deepEqual([SO.clampHours(0), SO.clampHours(500), SO.clampHours(undefined), SO.clampHours('abc')], [1, 168, 24, null]);
});

test('④ 상태 파일 — 엣지 설정 push·백업 감시에서 빠진다', async () => {
  const B = await import('../src/backup/service.js');
  assert.equal(B.isRuntimeStateFile(SO.OVERRIDE_NAME), true);
  assert.ok(B.RUNTIME_STATE_NAMES.has(SO.OVERRIDE_NAME), '이름 목록에도(이중 안전망)');
  const { isRegisteredStateFile } = await import('../src/util/stateFiles.js');
  assert.equal(isRegisteredStateFile(SO.OVERRIDE_NAME), true, '모듈이 스스로 등록한다(이름 목록과 별개 축)');
});

test('⑤ 라우트 — 소유자만 · 끄기 OTP 재인증 · 켜기 OTP 없이 · env 잠금 409 · 감사', async () => {
  reset();
  const express = (await import('express')).default;
  const auth = await import('../src/auth/auth.js');
  const totp = await import('../src/auth/totp.js');
  const { store } = await import('../src/store.js');
  await store.refresh();
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  const { listAudit } = await import('../src/audit.js');
  const mk = (u) => auth.createUser(u, { trusted: true });
  mk({ username: 'own', role: 'admin', password: 'Passw0rd!long1' });
  mk({ username: 'nown', role: 'admin', password: 'Passw0rd!long1' });
  mk({ username: 'sown', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-us-east'] } });
  const b = auth.beginTotpEnroll('own', '', { trusted: true });
  const c0 = totp.generateToken(b.secret);
  assert.ok(auth.confirmTotpEnroll('own', c0, { trusted: true }).ok);
  let ctr = Math.floor(Date.now() / 30000);
  const nextCode = () => totp.generateToken(b.secret, { counter: ++ctr });   // 등록에 쓴 카운터는 재사용 거부 — 다음 카운터(window 1)
  const tok = (name) => { const u = auth.getUser(name); const sid = `sid-${name}`; const exp = Math.floor(Date.now() / 1000) + 3600;
    const t = auth.signToken({ sub: name, role: u.role, name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
    auth.noteIssuedSession({ sub: name, sid, exp }); return t; };
  const TOK = { own: tok('own'), nown: tok('nown'), sown: tok('sown') };
  const app = express(); app.use(express.json());
  app.use('/api/upgrade', auth.authMiddleware, auth.requireEnrolled, upgradeRouter);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const put = async (who, body) => { const r = await fetch(`${base}/api/upgrade/signature-override`, { method: 'PUT', headers: { authorization: `Bearer ${TOK[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { st: r.status, j: await r.json() }; };
  try {
    const nown = await put('nown', { verify: false, otp: '123456' });
    assert.deepEqual([nown.st, nown.j.requiredOwner], [403, true], '소유자가 아닌 관리자 — 소유자 검사에서 막힌다(OTP 검사 전)');
    const nownOn = await put('nown', { verify: true });
    assert.deepEqual([nownOn.st, nownOn.j.requiredOwner], [403, true], '켜기도 소유자만');
    assert.equal((await put('sown', { verify: false, otp: '123456' })).st, 403, '범위 관리자(소유자 목록에 있어도)');
    assert.equal((await put('own', { verify: 'no' })).st, 400);
    const wrong = await put('own', { verify: false, hours: 24, otp: '000000' });
    assert.equal(wrong.st, 403, 'OTP 재인증 실패는 403(401 이면 화면이 로그아웃한다)');
    assert.equal(fs.existsSync(SO.overrideFile()), false, '재인증 실패는 저장하지 않는다');
    assert.equal((await put('own', { verify: false, hours: 24 })).st, 403, 'OTP 없이 끌 수 없다');
    const off = await put('own', { verify: false, hours: 3, otp: nextCode() });
    assert.equal(off.st, 200, JSON.stringify(off.j));
    assert.deepEqual([off.j.verify, off.j.hours, off.j.by], [false, 3, 'own']);
    assert.equal(SIG.signaturePolicy(process.env).source, 'ui');
    process.env.UPGRADE_SIGNATURE_POLICY = 'require';
    assert.equal((await put('own', { verify: true })).st, 409, 'env 잠금');
    delete process.env.UPGRADE_SIGNATURE_POLICY;
    const on = await put('own', { verify: true });
    assert.deepEqual([on.st, on.j.changed], [200, true], '켜기는 OTP 없이');
    assert.equal(SIG.signaturePolicy(process.env).policy, 'require');
    const acts = listAudit({ limit: 50 }).items.map((e) => e.action).filter(Boolean);
    assert.ok(acts.includes('업그레이드 서명 확인 끔(시한부)') && acts.includes('업그레이드 서명 확인 다시 켬'), JSON.stringify(acts.slice(0, 10)));
  } finally { srv.close(); reset(); }
});

test('⑥ root 로 도는 확인(install.sh·verify CLI)은 화면 끄기를 보지 않는다', () => {
  reset();
  SO.setOverride({ hours: 2, by: 'own' });
  SIG._setRunningAsRootForTest(true);
  try {
    assert.equal(SIG.signaturePolicy({}).policy, 'require');
    assert.equal(SIG.decideSignature({ manifestText: null, bytes: Buffer.from('x'), name: 'vmware-portal-99.0.0.tar.gz', where: 'watch' }).ok, false);
  } finally { SIG._setRunningAsRootForTest(false); reset(); }
});
