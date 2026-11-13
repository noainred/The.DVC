/**
 * 7b단계 반증(review-s7b F1~F19 · Q1~Q5) · 보안 감사(audit-s7b H-1 · M-1~M-5 · L-1~L-11) 회귀 — 반증 재현(rv7b/h1~h17)을 시험으로 옮겼다.
 * 실제 api 라우터 · 실제 keyStore + secretVault(encrypted) · 실제 ssh2 가짜 sshd(모든 인증 거부 · 받은 자격을 기록) · 실제 등록부 · 실제 bmstor 폴러.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7brv-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
process.env.SSRF_ALLOW_LOOPBACK = 'true';      // 가짜 sshd(127.0.0.1)를 등록부가 받게 — 이 시험 전용
process.env.SSH_HOSTKEY_POLICY = 'observe';    // 업그레이드 설치 기본(감사 H-1 의 성립 조건) — 이 정책에서도 권한 게이트가 막아야 한다
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'adm', role: 'admin' },
  { username: 'sa', role: 'admin', scope: { vcenters: ['vcA'] } },
] }));
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const BM = await import('../src/bmstor/registry.js');
const IDR = await import('../src/idrac/registry.js');
const ED = await import('../src/bmusage/onboard/edgeDeploy.js');
const RUN = await import('../src/bmusage/onboard/onboardRun.js');
const P = await import('../src/bmusage/onboard/importParse.js');
const A = await import('../src/bmusage/onboard/importAnalyze.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }, { id: 'vcE', name: 'KR-EDGE' }] };

async function fakeSshd() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const seen = [];
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => { seen.push({ method: ctx.method, username: ctx.username, password: ctx.method === 'password' ? ctx.password : undefined }); ctx.reject(['password', 'publickey']); });
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());

async function api(t) {
  const express = (await import('express')).default;
  const { api: router } = await import('../src/routes/api.js');
  const USERS = { own: { username: 'own', role: 'admin', scope: null }, adm: { username: 'adm', role: 'admin', scope: null }, sa: { username: 'sa', role: 'admin', scope: { vcenters: ['vcA'] } } };
  const app = express(); app.use(express.json({ limit: '16mb' }));
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  return async (u, method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
    return { s: r.status, j, txt };
  };
}
let codes = null;
const otpCodes = async () => {
  if (codes) return codes;
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 50));
  const now = Math.floor(Date.now() / 30_000);
  codes = [now - 1, now, now + 1].map((counter) => generateToken(SECRET, { counter }));
  return codes;
};
const HDR = 'name,corp,idrac_host,idrac_cred,service_tag,os_host,os_port,os_cred,os_key,collect_via,class,purposes,role,mounts,enabled,note';
const csv = (lines) => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
const corps = [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }, { id: 'vcE', name: 'KR-EDGE' }];
async function ctxOf(o = {}) {
  const D = await RUN.defaultOnboardDeps();
  const view = o.view || null; const write = o.write || view;
  return RUN.buildOnboardCtx({ D, corps, isEdge: false, myCorps: [], edgeOf: o.edgeOf || (() => null), rttOf: o.rttOf || (() => ({ rttMs: 30, fresh: true })),
    canView: (vc) => (view ? view.includes(vc) : true), canWrite: (vc) => (write ? write.includes(vc) : true), fullScope: !view, ownerTier: o.owner !== undefined ? o.owner : !view,
    tagTarget: o.tagTarget || null, fleetHas: o.fleetHas || null }).ctx;
}

const GLOB = KS.saveAccount({ name: 'glob-ops', kind: 'os', corp: '', username: 'svcmon', password: 'TopSecret-OS-1' }, { by: 'own' });
const GIDR = KS.saveAccount({ name: 'glob-idrac', kind: 'idrac', corp: '', username: 'ro-mon', password: 'TopSecret-iDRAC-1' }, { by: 'own' });
assert.ok(GLOB.ok && GIDR.ok);

test('① H-1 · F1 · F19 · Q4 · L-11 — 저장 비밀을 주소에 묶는 쓰기는 설정 소유자 + 본인 OTP(마지막) · 비소유자/범위 관리자는 가짜 sshd 에 아무것도 못 보낸다 · 계정명은 공통 계정 쪽 · 퇴역 키 거부', async (t) => {
  const call = await api(t);
  const [c1, c2] = await otpCodes();
  const body = { name: 'evil1', host: '127.0.0.1', port: SSHD.port, username: '', mounts: ['/'], credRef: GLOB.account.id };
  // 비소유자 전체 범위 관리자 — 403(OTP 를 묻기 전) · 저장 안 됨
  const na = await call('adm', 'POST', '/tools/bm-storage/servers', { ...body, otp: c1 });
  assert.equal(na.s, 403, na.txt); assert.equal(na.j.requiredOwner, true);
  assert.equal(BM.listBmServersRaw().some((x) => x.name === 'evil1'), false);
  // 소유자 — OTP 없으면 403 needOtp · 있으면 200(c1 은 위에서 소모되지 않았다 — 소유자 게이트가 먼저)
  assert.equal((await call('own', 'POST', '/tools/bm-storage/servers', body)).j.needOtp, true);
  const ok = await call('own', 'POST', '/tools/bm-storage/servers', { ...body, otp: c1 });
  assert.equal(ok.s, 200, ok.txt);
  // 묶은 항목의 연결 시험 — 계정명은 공통 계정(svcmon) 쪽(F19: 서버 칸 기본값 root 로 공통 비밀번호를 보내지 않는다)
  const id = ok.j.server.id;
  const tr = await call('own', 'POST', '/tools/bm-usage/onboard/test', { id });
  assert.equal(tr.j.kind, 'auth-rejected', tr.txt);
  assert.deepEqual(SSHD.seen.filter((x) => x.method === 'password').map((x) => x.username), ['svcmon']);
  // 범위 관리자 CSV — 공통 계정 이름을 쓰는 행은 계정을 찾기 전에 bind-owner-only(주소를 고르는 것으로 비밀을 빼 가지 못한다)
  const f = csv([HDR, `evil2,KR-SEL,,,,127.0.0.1,${SSHD.port},glob-ops,password,central,,,,/,,`]);
  const an = await call('sa', 'POST', '/tools/bm-usage/onboard/analyze', { fileName: 'x.csv', data: f.toString('base64') });
  assert.equal(an.j.rows[0].code, 'bind-owner-only', an.txt);
  // 존재 · 퇴역 · 종류 확인(Q4 · L-11)
  const k1 = KS.addKey({ name: 'rk1', privateKey: F.ed25519Key().pem }, { by: 'own' }); const k2 = KS.addKey({ name: 'rk2', privateKey: F.ed25519Key().pem }, { by: 'own' });
  assert.equal(REFS.rotateKey(k1.key.id, k2.key.id).ok, true);
  const ret = await call('own', 'POST', '/tools/bm-storage/servers', { ...body, name: 'r1', credRef: undefined, keyRef: k1.key.id, otp: c2 });
  assert.equal(ret.s, 400); assert.equal(ret.j.code, 'key-retired');
  assert.equal(REFS.resolveOsAuth({ host: 'h', keyRef: k1.key.id }).code, 'key-retired', '퇴역 키로는 접속하지 않는다');
  assert.equal((await call('own', 'POST', '/tools/bm-storage/servers', { ...body, name: 'r2', credRef: GIDR.account.id, otp: c2 })).j.code, 'account-kind');
  BM.removeBmServer(id);
});

test('② F2 — bmstor 주기 수집의 인증 정지는 해석 뒤 자격으로: 키 회전 · 공통 계정 비밀번호 변경 뒤 다시 시도한다(무한 정지 없음)', async () => {
  for (const s of BM.listBmServersRaw()) BM.removeBmServer(s.id);
  const k1 = KS.addKey({ name: 'f2a', privateKey: F.ed25519Key().pem }, { by: 'own' }); const k2 = KS.addKey({ name: 'f2b', privateKey: F.ed25519Key().pem }, { by: 'own' });
  const acc = KS.saveAccount({ name: 'f2-acc', kind: 'os', corp: '', username: 'f2u', password: 'F2-pass-1' }, { by: 'own' });
  BM.saveBmServer({ name: 'by-key', host: '127.0.0.1', port: SSHD.port, username: 'mon', mounts: ['/'], keyRef: k1.key.id, bindApproved: true });
  BM.saveBmServer({ name: 'by-acc', host: '127.0.0.1', port: SSHD.port, username: 'x', mounts: ['/'], credRef: acc.account.id, bindApproved: true });
  const PL = await import('../src/bmstor/poller.js');
  const n0 = SSHD.seen.length;
  await PL.bmCollectNow('interval');
  const stoppedTries = SSHD.seen.length;
  assert.ok(stoppedTries > n0, '첫 주기는 시도(가짜 sshd 가 거부)');
  await PL.bmCollectNow('interval');
  assert.equal(SSHD.seen.length, stoppedTries, '정지 상태 — 같은 자격으로는 다시 시도하지 않는다(자동 재시도 없음)');
  assert.equal(REFS.rotateKey(k1.key.id, k2.key.id).ok, true);
  assert.equal(KS.saveAccount({ id: acc.account.id, password: 'F2-pass-2' }).ok, true);
  await PL.bmCollectNow('interval');
  const after = SSHD.seen.slice(stoppedTries);
  assert.ok(after.some((x) => x.method === 'publickey'), '회전 뒤 키 서버를 다시 시도');
  assert.ok(after.some((x) => x.method === 'password' && x.username === 'f2u' && x.password === 'F2-pass-2'), '비밀번호 변경 뒤 계정 서버를 다시 시도(계정명은 공통 계정)');
  for (const s of BM.listBmServersRaw()) BM.removeBmServer(s.id);
});

test('③ F3 · F4 · F10 · F16 · Q3 · F12 — os_key 만 바꾼 갱신 반영 · OS 만 행 경고 · class 전체 범위 · purposes 쓰기 범위 · iDRAC id 충돌 · RTT 신선도 · 등록부 세대 서명', async () => {
  const D = await RUN.defaultOnboardDeps();
  const ka = KS.addKey({ name: 'f3-a', privateKey: F.ed25519Key().pem }, { by: 'own' }); const kb = KS.addKey({ name: 'f3-b', privateKey: F.ed25519Key().pem }, { by: 'own' });
  const one = async (lines, o) => RUN.analyzeUpload(csv([HDR, ...lines]), { ctx: await ctxOf(o) });
  let a = await one(['srv-b1,KR-SEL,,,,10.9.9.1,22,glob-ops,f3-a,central,,,,/,,']);
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'own' }).ok, true);
  a = await one(['srv-b1,KR-SEL,,,,10.9.9.1,22,,f3-b,central,,,,/,,']);
  assert.deepEqual(a.rows[0].changes, ['os_key']);
  RUN.applyOnboard(a.rows, { D, by: 'own' });
  const e = BM.listBmServersRaw().find((x) => x.name === 'srv-b1');
  assert.equal(e.keyRef, kb.key.id, 'F3: 분석이 말한 키로 실제로 바뀐다'); assert.equal(e.credRef, GLOB.account.id, '공통 계정은 잇는다');
  a = await one(['srv-b1,KR-SEL,,,,10.9.9.1,22,,password,central,,,,/,,']);
  RUN.applyOnboard(a.rows, { D, by: 'own' });
  assert.equal(BM.listBmServersRaw().find((x) => x.name === 'srv-b1').osAuth, 'password');
  // F4 — 함대에 없는 OS 만 행
  a = await one(['os-only-1,KR-SEL,,,,10.9.9.7,22,개별:mon,password,central,,,,/,,'], { fleetHas: () => false });
  assert.ok(a.rows[0].warnings.some((w) => w.code === 'os-only-untracked'));
  // F10 — 범위 계정 class 거부 · purposes 는 쓰기 범위 대상만
  const tagT = (tag) => ({ TAGB01: { vcenterId: 'vcB' }, TAGA01: { vcenterId: 'vcA' } }[tag] || null);
  a = await one(['t1,KR-SEL,,,TAGB01,10.70.0.1,22,개별:root,password,central,exclude,,db,/,,'], { view: ['vcA'], tagTarget: tagT });
  assert.equal(a.rows[0].code, 'class-full-scope');
  a = await one(['t2,KR-SEL,,,TAGB01,10.70.0.2,22,개별:root,password,central,,,db,/,,'], { view: ['vcA'], tagTarget: tagT });
  assert.ok(a.rows[0].warnings.some((w) => w.code === 'purpose-unresolved'), '조회 밖 대상 = 해석 안 됨(존재 은닉)'); assert.equal(a.rows[0].plan.role, '');
  a = await one(['t3,KR-SEL,,,TAGB01,10.70.0.3,22,개별:root,password,central,,,db,/,,'], { view: ['vcA', 'vcB'], write: ['vcA'], tagTarget: tagT });
  assert.equal(a.rows[0].code, 'purpose-forbidden');
  a = await one(['t4,KR-SEL,,,TAGA01,10.70.0.4,22,개별:root,password,central,,,db,/,,'], { view: ['vcA'], tagTarget: tagT });
  assert.equal(a.rows[0].plan.role, 'db');
  // F16 · M-1 — 새 행 id(tag||name)가 남의 법인 항목 id 와 같으면: 범위 계정은 숨은 겹침(적용 막음) · 전체 범위는 그 항목을 기존으로 보거나 새 id
  IDR.importServers([{ id: 'waw-db-01', name: 'WAW Database Primary', host: '10.3.0.1', username: 'b', password: 'B-Corp-Idrac-PW', serviceTag: 'WAWTAG1', vcenterId: 'vcB' }], 'merge');
  a = await one(['waw-db-01,KR-SEL,10.66.0.1,glob-idrac,,,,,,central,,,,,,'], { view: ['vcA'], owner: false });
  assert.equal(a.rows[0].code, 'bind-owner-only');
  a = await one(['waw-db-01,KR-SEL,10.66.0.1,,,,,,,central,,,,,,'], { view: ['vcA'], owner: false });
  assert.equal(a.rows[0].plan?.hidden ?? true, true, '범위 밖 id 충돌은 숨은 겹침');
  a = await one(['zz-new,KR-SEL,10.66.0.2,glob-idrac,waw-db-01,,,,,central,,,,,,']);
  assert.equal(a.rows[0].plan.idrac.existing, true, '전체 범위 — 같은 id 항목을 기존 항목으로 본다(새로 만들며 덮어쓰지 않는다)');
  const before = IDR.loadRegistry().find((x) => x.id === 'waw-db-01');
  a = await one(['fresh-bmc,KR-SEL,10.66.0.9,glob-idrac,,,,,,central,,,,,,']);
  a.rows[0].plan.idrac.id = 'waw-db-01';   // 분석과 적용 사이에 같은 id 가 생긴 경우를 흉내
  RUN.applyOnboard(a.rows, { D, by: 'own' });
  assert.deepEqual(IDR.loadRegistry().find((x) => x.id === 'waw-db-01'), before, '적용도 새 행은 겹치지 않는 id 로(남의 항목을 덮지 않는다)');
  assert.ok(IDR.loadRegistry().some((x) => x.name === 'fresh-bmc' && /^onb_/.test(x.id)));
  // Q3 — 오래된 핑 값은 RTT 판정에 쓰지 않는다
  a = await one(['q3,KR-SEL,,,,10.70.1.1,22,개별:root,password,central,,,,/,,'], { rttOf: () => ({ rttMs: 900, fresh: false }) });
  assert.ok(a.rows[0].warnings.some((w) => w.code === 'rtt-stale') && !a.rows[0].warnings.some((w) => w.code === 'rtt-high'));
  // F12 — 같은 파일이어도 등록부가 바뀌면 서명이 달라진다(적용 409)
  const lines = ['sig1,KR-SEL,,,,10.70.2.1,22,개별:root,password,central,,,,/,,'];
  const s1 = (await one(lines)).sig;
  BM.saveBmServer({ name: 'other-writer', host: '10.70.2.99', username: 'root', mounts: ['/'] });
  assert.notEqual((await one(lines)).sig, s1);
});

test('④ F5 · L-5 — 봉인을 못 푸는 동안(SECRETS_KEY 불일치) 키 저장소 쓰기를 거절해 봉인본을 지우지 않는다 · 원래 키로 되돌리면 그대로 산다', () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7brv-k-'));
  const run = (key, code) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const V = await import(${JSON.stringify(path.join(HERE, '../src/security/secretVault.js'))});
    const KS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/keyStore.js'))});
    const F = await import(${JSON.stringify(path.join(HERE, './_sshKeyFixtures.js'))});
    ${code}
  `], { env: { ...process.env, CONFIG_DIR: d, SECRETS_KEY: key }, encoding: 'utf8' }).trim().split('\n').pop());
  const KA = 'A'.repeat(64); const KB = 'B'.repeat(64);
  const r1 = run(KA, `V.saveSecretsPolicy({ mode: 'encrypted', level: 1 }); const r = KS.addKey({ name: 'prod-key', privateKey: F.ed25519Key().pem }); console.log(JSON.stringify({ ok: r.ok }));`);
  assert.equal(r1.ok, true);
  const sealed = JSON.parse(fs.readFileSync(path.join(d, 'ssh-keys.json'), 'utf8')).keys[0].privateKey;
  const r2 = run(KB, `const r = KS.addKey({ name: 'new-key', privateKey: F.ed25519Key().pem }); console.log(JSON.stringify({ code: r.code, und: KS.keyStoreUndecryptable() }));`);
  assert.equal(r2.code, 'secrets-undecryptable'); assert.ok(r2.und >= 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'ssh-keys.json'), 'utf8')).keys[0].privateKey, sealed, '봉인본이 그대로');
  const r3 = run(KA, `const k = KS.keyByName('prod-key'); console.log(JSON.stringify({ ok: KS.keyMaterial(k.id).ok }));`);
  assert.equal(r3.ok, true, '원래 키로 되돌리면 산다');
  fs.rmSync(d, { recursive: true, force: true });
});

test('⑤ F6 · F7 · F8 · F9 · L-9 — 이동은 배포 목록 먼저(실패면 중앙 항목 그대로) · 엣지 중간 실패도 만든 항목 기록 · 손으로 둔 항목 안 덮음 · 수집 법인이 비면 적용 · 서명 기록 안 함', async () => {
  const D = await RUN.defaultOnboardDeps();
  for (const s of BM.listBmServersRaw()) BM.removeBmServer(s.id);
  // F6
  let a = await RUN.analyzeUpload(csv([HDR, 'mv1,KR-EDGE,,,,10.81.0.1,22,개별:mon,password,central,,,,/,,']), { ctx: await ctxOf({ edgeOf: () => null }) });
  RUN.applyOnboard(a.rows, { D, by: 'own' });
  a = await RUN.analyzeUpload(csv([HDR, 'mv1,KR-EDGE,,,,10.81.0.1,22,개별:mon,password,edge,,,,/,,']), { ctx: await ctxOf({ edgeOf: (vc) => (vc === 'vcE' ? { agent: 'edge-x', online: true } : null) }) });
  const bad = RUN.applyOnboard(a.rows, { D: { ...D, ED: { ...D.ED, applyEdgeChanges: () => ({ ok: false, reason: 'ENOSPC' }) } }, by: 'own' });
  assert.equal(bad.ok, false); assert.equal(bad.step, 'edge');
  assert.ok(BM.listBmServersRaw().some((x) => x.name === 'mv1'), '배포 목록 쓰기가 실패하면 중앙 항목을 지우지 않는다');
  // F8 · F9 · F7 — 엣지 적용(이 프로세스를 엣지로 보고 직접 부른다)
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  BM.saveBmServer({ name: 'manual-db', host: '10.50.0.5', username: 'dba', password: 'Hand-Typed-PW', mounts: ['/', '/data'] });
  const rowsD = [{ name: 'manual-db', corp: 'vcE', osHost: '10.50.0.99', osUser: 'mon', osKey: 'password', mounts: ['/'], enabled: true }];
  const noCorp = await EA.applyEdgeDeployment(rowsD, { sig: 'a'.repeat(32), D, corps, myCorps: [] });
  assert.equal(noCorp.ok, false); assert.equal(noCorp.noCorps, true);
  assert.notEqual(EA.readAppliedState().state.sig, 'a'.repeat(32), 'F9 · L-9: 서명을 남기지 않는다(다음 인출에 다시)');
  const r8 = await EA.applyEdgeDeployment(rowsD, { sig: 'b'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(r8.rejected, 1, JSON.stringify(r8));
  const man = BM.listBmServersRaw().find((x) => x.name === 'manual-db');
  assert.equal(man.host, '10.50.0.5'); assert.equal(man.password, 'Hand-Typed-PW', 'F8: 손으로 둔 항목은 이름이 같아도 덮지 않는다');
  // F7: iDRAC 단계 실패 — 이미 만든 OS 항목도 '만든 항목' 으로 남아, 배포에서 빠지면 지운다
  // r3: 공통 계정 이름을 쓰는 배포 행 = 중앙이 소유자 + OTP 로 승인한 행(bindOk) — 승인 없는 행은 엣지가 거부한다(아래 ⑪ h20).
  const rowsE = [{ name: 'e7', corp: 'vcE', serviceTag: 'TAGE7', idracHost: '10.82.0.1', idracCred: 'glob-idrac', osHost: '10.82.0.2', osUser: 'mon', osKey: 'password', mounts: ['/'], enabled: true, bindOk: true }];
  const Dfail = { ...D, IDR: { ...D.IDR, importServers: () => ({ ok: false, reason: 'boom' }) } };
  const f7 = await EA.applyEdgeDeployment(rowsE, { sig: 'c'.repeat(32), D: Dfail, corps, myCorps: ['vcE'] });
  assert.equal(f7.ok, false);
  const osId = BM.listBmServersRaw().find((x) => x.name === 'e7')?.id;
  assert.ok(osId); assert.equal(EA.readAppliedState().state.created.e7?.os, osId);
  const gone = await EA.applyEdgeDeployment([], { sig: 'd'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.ok(gone.removed >= 1); assert.equal(BM.listBmServersRaw().some((x) => x.name === 'e7'), false);
});

test('⑥ F14 · F17 · L-2 — 배포에서 뺀 행은 엣지가 반영하기 전까지 central 거부 · 반영 서명이 오면 정리 · 남의 법인 배포 행은 범위 계정에 숨은 겹침/쓰기 밖', async () => {
  const edgeOf = (vc) => ({ agent: 'edge-p', online: true });
  const D = await RUN.defaultOnboardDeps();
  let a = await RUN.analyzeUpload(csv([HDR, 'sw1,KR-SEL,,,,10.83.0.1,22,개별:mon,password,edge,,,,/,,']), { ctx: await ctxOf({ edgeOf }) });
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'own' }).ok, true);
  ED.applyEdgeChanges({ removes: [{ agent: 'edge-p', name: 'sw1' }] }, { by: 'own' });
  a = await RUN.analyzeUpload(csv([HDR, 'sw1,KR-SEL,,,,10.83.0.1,22,개별:mon,password,central,,,,/,,']), { ctx: await ctxOf({ edgeOf: () => null }) });
  assert.equal(a.rows[0].code, 'edge-to-central', '엣지가 반영하기 전 — 제거 대기');
  assert.ok(ED.edgeSummary().some((x) => x.agent === 'edge-p' && x.pending === 1), '행 0 이어도 엣지 요약이 남는다');
  assert.equal(ED.settlePending('edge-p', 'f'.repeat(32)).changed, false, '다른 판 — 정리 안 함');
  assert.equal(ED.settlePending('edge-p', ED.sigOf(ED.edgeRowsFor('edge-p'))).changed, true);
  a = await RUN.analyzeUpload(csv([HDR, 'sw1,KR-SEL,,,,10.83.0.1,22,개별:mon,password,central,,,,/,,']), { ctx: await ctxOf({ edgeOf: () => null }) });
  assert.equal(a.rows[0].action, 'new');
  // F17: vcB 배포 행과 같은 이름 — 범위 계정(vcA) 분석은 숨은 겹침(신규 꼴) · 조회만 되는 범위는 쓰기 밖
  ED.applyEdgeChanges({ upserts: [{ agent: 'edge-p', row: { name: 'b-db01', corp: 'vcB', osHost: '10.5.0.1', osUser: 'b', osKey: 'password', mounts: ['/'] } }] }, { by: 'own' });
  a = await RUN.analyzeUpload(csv([HDR, 'b-db01,KR-SEL,,,,10.99.0.1,22,개별:a,password,edge,,,,/,,']), { ctx: await ctxOf({ view: ['vcA'], edgeOf }) });
  assert.equal(a.rows[0].plan.hidden, true); assert.equal(a.rows[0].action, 'new');
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'sa' }).applied.blocked, 1);
  assert.equal(ED.edgeRowsFor('edge-p').find((x) => x.name === 'b-db01').corp, 'vcB', '남의 법인 배포 행이 그대로');
  a = await RUN.analyzeUpload(csv([HDR, 'b-db01,KR-SEL,,,,10.99.0.1,22,개별:a,password,edge,,,,/,,']), { ctx: await ctxOf({ view: ['vcA', 'vcB'], write: ['vcA'], edgeOf }) });
  assert.equal(a.rows[0].code, 'existing-forbidden');
});

test('⑦ F13 · L-3 · L-4 · F15 — 복원은 백업 뒤 키를 지우지 않는다 · 중앙 수신 사본 가림 · 스냅샷 비밀 파일 정책 · iDRAC 사본 사용처', async () => {
  const BK = await import('../src/backup/service.js');
  KS.addKey({ name: 'k-old', privateKey: F.ed25519Key().pem }, { by: 'own' });
  const bundle = BK.collectConfigDir()['ssh-keys.json'];
  KS.addKey({ name: 'k-new', privateKey: F.ed25519Key().pem }, { by: 'own' });
  const m = KS.mergeRedactedKeyStore(bundle, fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8'));
  assert.ok(JSON.parse(m.text).keys.some((k) => k.name === 'k-new'), '백업 뒤 등록한 키를 남긴다'); assert.ok(m.kept.includes('key:k-new'));
  // L-3: 엣지가 개인키 봉인본째 보낸 ssh-keys.json 을 중앙이 다시 가린다
  const AC = await import('../src/central/agentConfig.js');
  const raw = fs.readFileSync(path.join(DIR, 'ssh-keys.json'), 'utf8');
  AC.setAgentConfig('edge-old', { 'ssh-keys.json': raw });
  const stored = AC.getAllAgentConfigs()['edge-old'].files['ssh-keys.json'];
  assert.equal(stored.includes(JSON.parse(raw).keys[0].privateKey), false); assert.ok(stored.includes('__redacted__'));
  // L-4
  assert.ok(VAULT.SECRET_FILES.includes('onboard-prev/bm-storage.json') && VAULT.SECRET_FILES.includes('onboard-prev/idrac.json'));
  // F15: 적용이 복사한 iDRAC 사본을 사용처로 센다 · 지우기 거절 · 비밀번호 변경 시 사본 수
  const D = await RUN.defaultOnboardDeps();
  const a = await RUN.analyzeUpload(csv([HDR, 'bmc-c1,KR-SEL,10.84.0.1,glob-idrac,TAGC1,,,,,central,,,,,,', 'bmc-c2,KR-SEL,10.84.0.2,glob-idrac,TAGC2,,,,,central,,,,,,']), { ctx: await ctxOf() });
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'own' }).applied.idrac, 2);
  const view = REFS.listAccountsView().accounts.find((x) => x.id === GIDR.account.id);
  const idrNow = IDR.loadRegistry().filter((x) => x.username === 'ro-mon' && x.password === 'TopSecret-iDRAC-1').length;
  assert.equal(view.servers, idrNow, '사본 수 = 그 계정 비밀번호가 복사된 iDRAC 항목 수(앞 시험의 fresh-bmc 포함)'); assert.ok(view.servers >= 2); assert.equal(view.copyMode, true);
  assert.equal(REFS.deleteAccountIfUnused(GIDR.account.id).code, 'in-use');
  assert.equal(KS.saveAccount({ id: GIDR.account.id, password: 'TopSecret-iDRAC-2' }).copiesStale, view.servers);
  assert.ok(fs.existsSync(path.join(DIR, 'onboard-prev', 'meta.json')));
});

test('⑧ M-4 · M-5 · L-7 — 넓은 병합 셀 xlsx 는 exceljs 로드 전에 거부 · 암호화 키 파싱은 한 번만 · 범위 계정에는 키 목록 · 공용 계정 · 사용처를 주지 않는다', async (t) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s'); ws.addRow(['name', 'corp', 'os_host']); ws.addRow(['a', 'b', 'c']);
  let buf = Buffer.from(await wb.xlsx.writeBuffer());
  // 시트 XML 에 넓은 mergeCell 을 넣은 xlsx 를 만든다(zip 을 다시 쓰지 않고 — 같은 파서 경로를 타도록 exceljs 의 mergeCells 대신 모델에 넣는다)
  const wb2 = new ExcelJS.Workbook(); const w2 = wb2.addWorksheet('s'); w2.addRow(['name', 'corp', 'os_host']); w2.addRow(['a', 'b', 'c']);
  w2.mergeCells('A3:Z9000');   // 넓이 233,974칸 — 상한(200,000) 초과
  buf = Buffer.from(await wb2.xlsx.writeBuffer());
  const { xlsxMergeStats } = await import('../src/svcmon/formats.js');
  const st = xlsxMergeStats(buf);
  assert.equal(st.ok, true); assert.equal(st.over, true, JSON.stringify(st));
  const t0 = Date.now(); const r = await P.parseOnboardFile(buf, { fileName: 'm.xlsx' }); const ms = Date.now() - t0;
  assert.equal(r.ok, false); assert.match(r.reason, /병합 셀이 너무/); void ms;
  // M-5: passphrase 키(OpenSSH bcrypt)는 접속마다 풀지 않는다 — 같은 키 두 번 해석에 파싱 1회
  REFS._resetParsedKeysForTest();
  const ek = await F.ed25519KeyEncrypted('pw-m5', 16);
  const k = KS.addKey({ name: 'enc-k', privateKey: ek.pem, passphrase: 'pw-m5' }, { by: 'own' });
  assert.equal(k.ok, true, k.reason);
  const x1 = REFS.resolveOsAuth({ host: 'h', keyRef: k.key.id }); const x2 = REFS.resolveOsAuth({ host: 'h', keyRef: k.key.id });
  assert.ok(x1.ok && x2.ok); assert.equal(REFS._parsedKeyStats().parses, 1);
  assert.equal(typeof x1.privateKey, 'object', 'ssh2 키 객체 — ssh2 가 다시 풀지 않는다'); assert.equal(x1.passphrase, '');
  // L-7
  const call = await api(t);
  const ks = await call('sa', 'GET', '/tools/bm-usage/ssh-keys');
  assert.deepEqual(ks.j.keys, []); assert.equal(ks.j.hidden, 'scoped');
  KS.saveAccount({ name: 'a-only', kind: 'os', corp: 'vcA', username: 'u', password: 'p-1' }, { by: 'own' });
  const ac = await call('sa', 'GET', '/tools/bm-usage/accounts');
  assert.deepEqual(ac.j.accounts.map((x) => x.name), ['a-only'], '자기 법인 소속만(전 법인 공용 계정 이름도 주지 않는다)');
  assert.equal(ac.j.accounts[0].servers, null);
});

test('⑨ 소유자 CSV 적용 — 묶음 행이 있으면 본인 OTP(서명 대조 · 권한 뒤 마지막) · 비소유자에게는 그 행이 분석에서 이미 거부', async (t) => {
  const call = await api(t);
  const [, , c3] = await otpCodes();
  const f = csv([HDR, 'own1,KR-SEL,,,,10.85.0.1,22,glob-ops,,central,,,,/,,']).toString('base64');
  const an = await call('own', 'POST', '/tools/bm-usage/onboard/analyze', { fileName: 'o.csv', data: f });
  assert.equal(an.j.summary.needOwner, 1, an.txt);
  assert.equal((await call('own', 'POST', '/tools/bm-usage/onboard/apply', { fileName: 'o.csv', data: f, sig: 'stale', otp: c3 })).s, 409, '서명이 다르면 OTP 를 쓰기 전에 409');
  const no = await call('own', 'POST', '/tools/bm-usage/onboard/apply', { fileName: 'o.csv', data: f, sig: an.j.sig });
  assert.equal(no.s, 403); assert.equal(no.j.needOtp, true);
  const ok = await call('own', 'POST', '/tools/bm-usage/onboard/apply', { fileName: 'o.csv', data: f, sig: an.j.sig, otp: c3 });
  assert.equal(ok.s, 200, ok.txt);
  // 비소유자 — 주소 · 묶음이 그대로인 행은 묶음이 아니다(변화 없음) · 주소를 바꾸면 거부
  const adm = await call('adm', 'POST', '/tools/bm-usage/onboard/analyze', { fileName: 'o.csv', data: f });
  assert.equal(adm.j.rows[0].action, 'unchanged', adm.txt);
  const moved = csv([HDR, 'own1,KR-SEL,,,,10.85.0.2,22,glob-ops,,central,,,,/,,']).toString('base64');
  assert.equal((await call('adm', 'POST', '/tools/bm-usage/onboard/analyze', { fileName: 'o.csv', data: moved })).j.rows[0].code, 'bind-owner-only');
});

/* ── r3 재검증 R-N1 — 판정 코어 하나(bindRule) + 등록부 choke point(bindApproved) ─────────────────────────────── */
// ⑧ 이 범위 계정 목록을 정확히 보므로 vcA 공통 계정은 ⑩ 에서 만든다(시험 순서대로 돈다).
let KR = null;
const krAcc = () => { if (!KR) { KR = KS.saveAccount({ name: 'kr-ops-r3', kind: 'os', corp: 'vcA', username: 'svcmon', password: 'TopSecret-KR-1' }, { by: 'own' }); assert.ok(KR.ok, KR.reason); } return KR; };
const rawOf = (name) => BM.listBmServersRaw().find((x) => x.name === name);

test('⑩ r3 R-N1(h18) — 소유자가 묶은 서버(credRef + osAuth=password)를 비소유자 · 범위 관리자가 os_cred 빈칸 + os_key=password + 새 주소로 갱신 → 분석 bind-owner-only · 적용 0 · 새 주소로 나간 인증 0', async (t) => {
  const call = await api(t);
  const EVIL = await fakeSshd(); t.after(() => EVIL.close());
  krAcc();
  const up = async (u, line) => {
    const body = { fileName: 'x.csv', data: csv([HDR, line]).toString('base64') };
    const an = await call(u, 'POST', '/tools/bm-usage/onboard/analyze', body);
    const ap = await call(u, 'POST', '/tools/bm-usage/onboard/apply', { ...body, sig: an.j.sig });
    return { row: an.j.rows?.[0] || {}, an, ap };
  };
  for (const [u, name] of [['adm', 'rn1-adm'], ['sa', 'rn1-sa']]) {
    // 소유자가 묶어 둔 상태(소유자 + OTP 를 통과한 쓰기와 같은 결과 — 승인된 쓰기로 만든다)
    const s0 = BM.saveBmServer({ name, host: '127.0.0.1', port: SSHD.port, username: 'svcmon', mounts: ['/'], credRef: KR.account.id, osAuth: 'password', vcenterId: 'vcA', collectVia: 'central', bindApproved: true });
    assert.equal(s0.ok, true, s0.reason);
    // ① R-N1 행 — 계정 · 키 이름은 쓰지 않지만 기존 공통 계정을 새 주소로 잇는다 = 묶음 → 소유자만
    const a = await up(u, `${name},KR-SEL,,,,127.0.0.1,${EVIL.port},,password,central,,,,/,,`);
    assert.equal(a.row.code, 'bind-owner-only', `${u}: ${a.row.reason}`);
    assert.equal(a.ap.j.applied?.os || 0, 0, a.ap.txt);
    const e1 = rawOf(name);
    assert.equal(e1.port, SSHD.port, `${u}: 주소가 바뀌지 않았다`); assert.equal(e1.credRef, KR.account.id, `${u}: 소유자 묶음 그대로`);
    // ② 같은 주소에서 인증 방식만 바꾸기(공통 계정이 있는 항목 — 키 우선 ↔ 비밀번호)도 묶음(bm-storage 라우트와 같은 판정)
    const a2 = await up(u, `${name},KR-SEL,,,,127.0.0.1,${SSHD.port},,,central,,,,/,,`);
    assert.notEqual(a2.row.code, 'bind-owner-only', `${u}: 칸을 비운 같은 주소 행은 묶음이 아니다 ${a2.an.txt}`);
    // ③ bm-storage 라우트 — 클라이언트가 보낸 bindApproved 는 버린다: 참조를 다시 주면 403(소유자 게이트) · 참조 없이 주소만 바꾸면 저장되지만 참조는 버려진다
    if (u === 'adm') {
      const f1 = await call(u, 'POST', '/tools/bm-storage/servers', { id: e1.id, name, host: '127.0.0.1', port: EVIL.port, username: 'svcmon', mounts: ['/'], credRef: KR.account.id, osAuth: 'password', bindApproved: true });
      assert.equal(f1.s, 403, f1.txt); assert.equal(f1.j.requiredOwner, true);
      const f2 = await call(u, 'POST', '/tools/bm-storage/servers', { id: e1.id, name, host: '127.0.0.1', port: EVIL.port, username: 'svcmon', mounts: ['/'], osAuth: 'password', bindApproved: true });
      assert.equal(f2.s, 200, f2.txt); assert.deepEqual(f2.j.droppedSecrets, ['credRef']);
      assert.equal(rawOf(name).credRef, undefined, '클라이언트 bindApproved 로는 묶음이 남지 않는다');
    } else {
      // ④ keepCred(os_cred · os_key 둘 다 빈칸) 이동 — 묶음이 아니라 적용되지만 등록부가 참조를 버린다(choke point · secretCarry)
      const a4 = await up(u, `${name},KR-SEL,,,,127.0.0.1,${EVIL.port},,,central,,,,/,,`);
      assert.equal(a4.row.action, 'update', a4.an.txt); assert.equal(a4.ap.s, 200, a4.ap.txt);
      const e4 = rawOf(name);
      assert.equal(e4.port, EVIL.port); assert.equal(e4.credRef, undefined, 'keepCred 이동은 참조를 잇지 않는다');
    }
    // 연결 시험(그 사용자) — 새 주소로 공통 계정 비밀번호가 나가지 않는다
    const tr = await call(u, 'POST', '/tools/bm-usage/onboard/test', { id: rawOf(name).id });
    assert.ok(tr.s === 200 || tr.s === 400, tr.txt);
    BM.removeBmServer(rawOf(name).id);   // 다음 사용자 행이 같은 공격 주소를 쓴다(주소 겹침 판정과 섞이지 않게)
  }
  assert.deepEqual(EVIL.seen.filter((x) => x.method === 'password' || x.method === 'publickey'), [], '공격자 주소가 받은 인증 0');
  assert.equal(EVIL.seen.some((x) => x.password === 'TopSecret-KR-1'), false);
});

test('⑪ r3 R-N1(h20) — 등록부 choke point: 묶음 쓰기는 bindApproved 가 있을 때만 · 주소 이동은 참조를 버리고 같은 주소는 기존 유지 · 떼기는 된다 · 일괄 적용 · 온보딩 적용 · 엣지 적용(중앙 승인 bindOk 행만)도 같은 함수', async () => {
  krAcc();
  const base = { name: 'cp1', host: '10.90.0.1', port: 22, username: 'svcmon', mounts: ['/'] };
  const id = BM.saveBmServer({ ...base, credRef: KR.account.id, osAuth: 'password', bindApproved: true }).server.id;
  const raw = () => BM.listBmServersRaw().find((x) => x.id === id);
  const rebind = () => BM.saveBmServer({ ...base, id, credRef: KR.account.id, osAuth: 'password', keyRef: '', bindApproved: true });
  // (a) h20: 주소 이동 + 같은 credRef 를 명시로 다시 줌(온보딩 적용이 보내던 꼴) + 승인 없음 → 버림
  for (const mv of [{ host: '10.90.0.66' }, { port: 2222 }, { username: 'other' }]) {
    rebind();
    const r = BM.saveBmServer({ ...base, id, ...mv, credRef: KR.account.id, keyRef: '', osAuth: 'password' });
    assert.equal(r.ok, true); assert.equal(r.bindRefused, true, JSON.stringify(mv)); assert.deepEqual(r.droppedSecrets, ['credRef']);
    assert.equal(raw().credRef, undefined, `${JSON.stringify(mv)}: 승인 없는 이동은 참조를 버린다`);
  }
  rebind();
  assert.equal(BM.saveBmServer({ ...base, id, host: '10.90.0.66', credRef: KR.account.id, bindApproved: 'true' }).bindRefused, true, '엄격한 true 만 승인');
  assert.equal(raw().credRef, undefined);
  // (b) 승인된 쓰기(게이트 통과)는 이동해도 그 값
  rebind();
  let r = BM.saveBmServer({ ...base, id, host: '10.90.0.66', credRef: KR.account.id, keyRef: '', osAuth: 'password', bindApproved: true });
  assert.equal(r.bindRefused, undefined); assert.equal(raw().credRef, KR.account.id);
  assert.equal('bindApproved' in raw(), false, '승인 표지는 저장하지 않는다');
  // (c) 같은 주소 — 인증 방식 변경 · 다른 참조는 승인 없으면 기존 유지 / (d) 떼기는 묶음이 아니다
  rebind();
  r = BM.saveBmServer({ ...base, id, osAuth: '' });
  assert.equal(r.bindRefused, true); assert.equal(raw().osAuth, 'password'); assert.equal(raw().credRef, KR.account.id);
  r = BM.saveBmServer({ ...base, id, credRef: GLOB.account.id });
  assert.equal(r.bindRefused, true); assert.equal(raw().credRef, KR.account.id, '다른 참조로 바꾸기 — 기존 유지');
  r = BM.saveBmServer({ ...base, id, credRef: '' });
  assert.equal(r.bindRefused, undefined); assert.equal(raw().credRef, undefined, '떼기는 된다'); assert.equal(r.droppedSecrets, undefined);
  // (e) 새 항목 + 참조 + 승인 없음 → 참조 없이 저장
  r = BM.saveBmServer({ name: 'cp-new', host: '10.90.0.2', username: 'svcmon', mounts: ['/'], keyRef: 'k_00000000abcd', credRef: KR.account.id });
  assert.equal(r.bindRefused, true); assert.equal(rawOf('cp-new').credRef, undefined); assert.equal(rawOf('cp-new').keyRef, undefined);
  // (f) 일괄 적용(온보딩 · 엣지 적용 경로)도 같은 판정
  rebind();
  const b = BM.applyBmServerBatch([{ ...base, id, host: '10.90.0.77', credRef: KR.account.id, keyRef: '', osAuth: 'password' }]);
  assert.equal(b.ok, true); assert.equal(b.results[0].bindRefused, true); assert.equal(raw().credRef, undefined);
  // (g) 온보딩 — 소유자 문맥은 R-N1 행을 묶음으로 판정하고(plan.binds) 적용이 그 승인을 싣는다 · 비소유자 문맥은 bind-owner-only
  const D = await RUN.defaultOnboardDeps();
  rebind();
  const line = 'cp1,KR-SEL,,,,10.90.0.88,22,,password,central,,,,/,,';
  const non = await RUN.analyzeUpload(csv([HDR, line]), { ctx: await ctxOf({ owner: false }) });
  assert.equal(non.rows[0].code, 'bind-owner-only', JSON.stringify(non.rows[0]));
  const own = await RUN.analyzeUpload(csv([HDR, line]), { ctx: await ctxOf({}) });
  assert.equal(own.rows[0].plan.binds, true); assert.equal(own.summary.needOwner, 1);
  // 분석이 '묶음 아님' 으로 잘못 판정해도(계획 변조) choke point 가 승계를 막는다
  const forged = own.rows.map((x) => ({ ...x, plan: { ...x.plan, binds: false } }));
  assert.equal(RUN.applyOnboard(forged, { D, by: 'own' }).ok, true);
  assert.equal(raw().host, '10.90.0.88'); assert.equal(raw().credRef, undefined, '승인 없는 적용은 참조를 버린다');
  rebind();
  assert.equal(RUN.applyOnboard(own.rows, { D, by: 'own' }).ok, true);
  assert.equal(raw().host, '10.90.0.88'); assert.equal(raw().credRef, KR.account.id, '소유자 승인(plan.binds)이면 그 값');
  // (g2) 찾은 뒤 판정(적용 본문 그대로 bindOfWrite) — 이름 · 주소가 그대로여도 공통 계정의 계정명이 바뀌었으면 접속처(계정)가 바뀌는 묶음이다
  const U = KS.saveAccount({ name: 'kr-u-r3', kind: 'os', corp: 'vcA', username: 'svcmon', password: 'Pw-U-1' }, { by: 'own' });
  BM.saveBmServer({ name: 'cpu', host: '10.90.1.1', port: 22, username: 'svcmon', mounts: ['/'], credRef: U.account.id, vcenterId: 'vcA', bindApproved: true });
  assert.equal(KS.saveAccount({ id: U.account.id, username: 'svc2', password: 'Pw-U-2' }, { by: 'own' }).ok, true);
  const lu = 'cpu,KR-SEL,,,,10.90.1.1,22,kr-u-r3,,central,,,,/,,';
  assert.equal((await RUN.analyzeUpload(csv([HDR, lu]), { ctx: await ctxOf({ owner: false }) })).rows[0].code, 'bind-owner-only', '계정명이 바뀐 재묶음은 소유자만');
  assert.equal((await RUN.analyzeUpload(csv([HDR, lu]), { ctx: await ctxOf({}) })).rows[0].plan.binds, true);
  // (h) 엣지 적용 — 중앙 승인(bindOk)이 없는 행은 엣지 쪽 기존 항목의 공통 계정을 새 주소로 잇지 못한다
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  const row0 = { name: 'eg1', corp: 'vcE', osHost: '10.91.0.1', osCred: 'glob-ops', osKey: 'password', mounts: ['/'], enabled: true };
  const noOk = await EA.applyEdgeDeployment([row0], { sig: '1'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(noOk.rejected, 1); assert.equal(noOk.rejects[0].code, 'bind-owner-only', '승인 없는 새 묶음 행 거부');
  const okd = await EA.applyEdgeDeployment([{ ...row0, bindOk: true }], { sig: '2'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(okd.applied, 1, JSON.stringify(okd)); assert.equal(rawOf('eg1').credRef, GLOB.account.id);
  const carry = { ...row0, osHost: '10.91.0.66', osCred: '', osKey: 'password' };
  const h = await EA.applyEdgeDeployment([carry], { sig: '3'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(h.rejected, 1, JSON.stringify(h)); assert.equal(h.rejects[0].code, 'bind-owner-only');
  assert.equal(rawOf('eg1').host, '10.91.0.1'); assert.equal(rawOf('eg1').credRef, GLOB.account.id);
  const h2 = await EA.applyEdgeDeployment([{ ...carry, bindOk: 'true' }], { sig: '4'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(h2.rejected, 1, '엄격한 true 만 승인(문자열 거부)');
  const h3 = await EA.applyEdgeDeployment([{ ...carry, bindOk: true }], { sig: '5'.repeat(32), D, corps, myCorps: ['vcE'] });
  assert.equal(h3.applied, 1, JSON.stringify(h3)); assert.equal(rawOf('eg1').host, '10.91.0.66'); assert.equal(rawOf('eg1').credRef, GLOB.account.id);
  await EA.applyEdgeDeployment([], { sig: '6'.repeat(32), D, corps, myCorps: ['vcE'] });
  // (i) 중앙 배포 행의 승인 — 묶음 행만 bindOk · 묶음 칸이 그대로인 갱신은 앞 승인을 잇는다 · 비소유자의 묶음 행은 분석에서 거부
  const edgeOf = () => ({ agent: 'edge-r3', online: true });
  const dep = (l, o = {}) => RUN.analyzeUpload(csv([HDR, l]), { ctx: o.ctx });
  let a = await dep('eb1,KR-EDGE,,,,10.92.0.1,22,glob-ops,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf }) });
  assert.equal(a.rows[0].plan.binds, true);
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'own' }).ok, true);
  assert.equal(ED.edgeRowsFor('edge-r3').find((x) => x.name === 'eb1').bindOk, true);
  a = await dep('eb1,KR-EDGE,,,,10.92.0.1,22,glob-ops,password,edge,,,,/,,메모만', { ctx: await ctxOf({ edgeOf, owner: false }) });
  assert.equal(a.rows[0].action, 'update', JSON.stringify(a.rows[0])); assert.equal(a.rows[0].plan.binds, false);
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'adm' }).ok, true);
  assert.equal(ED.edgeRowsFor('edge-r3').find((x) => x.name === 'eb1').bindOk, true, '묶음 칸이 그대로면 앞 승인을 잇는다');
  a = await dep('eb1,KR-EDGE,,,,10.92.0.1,22,glob-ops,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf: () => ({ agent: 'edge-r4', online: true }), owner: false }) });
  assert.equal(a.rows[0].code, 'bind-owner-only', '다른 엣지로 옮기는 행 — 그 엣지에겐 새 묶음');
  a = await dep('eb1,KR-EDGE,,,,10.92.0.66,22,glob-ops,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf, owner: false }) });
  assert.equal(a.rows[0].code, 'bind-owner-only', '비소유자가 배포 행 주소를 바꾸면 거부');
  a = await dep('eb1,KR-EDGE,,,,10.92.0.66,22,,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf, owner: false }) });
  assert.equal(a.rows[0].code, 'bind-owner-only', '엣지에서 무엇이 이어질지 모르는 행(os_cred 빈칸 + os_key)은 묶음으로 본다');
  // 묶음 칸이 바뀐 비묶음 갱신(공통 계정 떼기 → 개별 계정)은 앞 승인을 잇지 않는다 · 처음부터 비묶음인 행도 bindOk 없음
  a = await dep('eb1,KR-EDGE,,,,10.92.0.1,22,개별:mon,,edge,,,,/,,', { ctx: await ctxOf({ edgeOf, owner: false }) });
  assert.equal(a.rows[0].plan.binds, false, JSON.stringify(a.rows[0]));
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'adm' }).ok, true);
  assert.equal(ED.edgeRowsFor('edge-r3').find((x) => x.name === 'eb1').bindOk, false, '떼기 — 승인을 잇지 않는다');
  a = await dep('eb1,KR-EDGE,,,,10.92.0.1,22,,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf, owner: false }) });
  assert.equal(a.rows[0].code, 'bind-owner-only', '배포 행이 공통 계정을 안 써도 엣지 쪽 기존 항목에서 무엇이 이어질지 모른다 — 잇는 행은 묶음');
  a = await dep('eb2,KR-EDGE,,,,10.92.0.2,22,개별:mon,password,edge,,,,/,,', { ctx: await ctxOf({ edgeOf }) });
  assert.equal(RUN.applyOnboard(a.rows, { D, by: 'own' }).ok, true);
  assert.equal(ED.edgeRowsFor('edge-r3').find((x) => x.name === 'eb2').bindOk, false, '비묶음 행은 승인 표지가 없다');
  // 저장 · 적재 정규화도 엄격한 true 만(손댄 파일의 문자열 'true' 는 승인이 아니다)
  assert.equal(A.edgeRowFromPlan({ name: 'x', bindOk: 'true' }).bindOk, false); assert.equal(A.edgeRowFromPlan({ name: 'x', bindOk: 1 }).bindOk, false);
  assert.equal(A.edgeRowFromPlan({ name: 'x', bindOk: true }).bindOk, true);
  ED.applyEdgeChanges({ removes: [{ agent: 'edge-r3', name: 'eb1' }, { agent: 'edge-r3', name: 'eb2' }] }, { by: 'own' });
  for (const s of BM.listBmServersRaw()) if (['cp1', 'cp-new', 'cpu'].includes(s.name)) BM.removeBmServer(s.id);
});

test('⑫ r3 소스 스윕 — bindApproved 는 등록부(읽기) · bm-storage 라우트(게이트 뒤 · 클라이언트 값 버림) · 온보딩 적용(plan.binds)에만 · 엣지 적용 문맥은 행 승인(bindOk)으로만 소유자 · 묶음 판정은 bindRule 하나', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.join(HERE, '../src');
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: SRC, encoding: 'utf8' }).split('\n').filter(Boolean);
  const has = (re) => files.filter((f) => re.test(stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'))));
  assert.deepEqual(has(/bindApproved/).sort(), ['bmstor/registry.js', 'bmusage/onboard/onboardRun.js', 'routes/api/bmstor.js']);
  const reg = stripComments(fs.readFileSync(path.join(SRC, 'bmstor/registry.js'), 'utf8'));
  assert.deepEqual(reg.match(/bindApproved[^\n]{0,12}/g), ['bindApproved !== true;'], '등록부는 엄격한 true 만 읽는다(세우지 않는다)');
  const rt = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/bmstor.js'), 'utf8'));
  const iSet = rt.indexOf('bindApproved: true'); const iGate = rt.indexOf('runGate(reauth, req)'); const iOwner = rt.indexOf('runGate(requireSettingsOwner, req)');
  assert.ok(iOwner > 0 && iGate > iOwner && iSet > iGate, '라우트는 소유자 게이트 → OTP 게이트 뒤에만 세운다');
  assert.equal(rt.match(/bindApproved: true/g).length, 1);
  assert.match(rt, /const \{ otp, bindApproved: _clientApproval, \.\.\.rest \} = body;/, '클라이언트가 보낸 bindApproved 는 버린다');
  assert.match(rt, /saveBmServer\(bind\.binds \? \{ \.\.\.rest, bindApproved: true \} : rest\)/);
  const run = stripComments(fs.readFileSync(path.join(SRC, 'bmusage/onboard/onboardRun.js'), 'utf8'));
  assert.deepEqual(run.match(/bindApproved[^\n,]*/g), ['bindApproved: p.binds === true'], '온보딩 적용은 판정(plan.binds — 라우트가 소유자 + OTP 를 통과시킨 행)만');
  const ea = stripComments(fs.readFileSync(path.join(SRC, 'bmusage/onboard/edgeApply.js'), 'utf8'));
  assert.match(ea, /ownerTier: \(row\) => row\?\.flags\?\.bindOk === true/); assert.doesNotMatch(ea, /ownerTier:\s*true/);
  assert.deepEqual(has(/bindOk/).sort(), ['bmusage/onboard/edgeApply.js', 'bmusage/onboard/edgeDeploy.js', 'bmusage/onboard/importAnalyze.js', 'bmusage/onboard/onboardRun.js']);
  // 판정 코어 하나 — 라우트 · 등록부 · 분석이 bindRule 을 쓰고, 예전 판정 조각(bindOs · osSameAddr · 라우트의 moved 계산)은 남지 않는다
  for (const f of ['bmstor/registry.js', 'routes/api/bmstor.js', 'bmusage/onboard/importAnalyze.js']) assert.match(fs.readFileSync(path.join(SRC, f), 'utf8'), /bindRule\.js/, f);
  assert.doesNotMatch(stripComments(fs.readFileSync(path.join(SRC, 'bmusage/onboard/importAnalyze.js'), 'utf8')), /\bbindOs\b|osSameAddr|idrSameAddr/);
  assert.doesNotMatch(rt, /const moved =/);
});
