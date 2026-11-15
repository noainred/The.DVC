/**
 * 베어메탈 사용률 점검 반복 6회차 그룹 X(기준판 04fad6d1) — 확정 3건을 재현한 입력으로 고정한다(실제 api · insights · admin 라우터).
 *   A1 공용 게이트(fullScopeOnlyWith · requireSettingsOwner)가 조회 범위만 봐 '조회 무제한 + 쓰기 일부' 계정이 전 법인 공용 쓰기를 했다
 *      (재현: wadm PUT /insights/fleet/assign vcB → 200 · 파일에 씀 · wown PUT perf-rules · backup/settings 200).
 *      메인 결정: 안전 메서드(GET · HEAD · OPTIONS)는 그대로 · 그 밖은 isFullReadWriteScope · 사유 따로 · 던지면 거부 · requireSettingsOwner 의 GET 은 그대로(결정 대기).
 *   A2 공통 계정의 법인 · 기본 키를 함께 바꾸면 그 계정을 쓰는 옛 법인 서버가 key-folder 로 끊겼다 · B-4 거절이 OTP 를 소모했다.
 *   B4 bm-storage 서버 폼의 키 드롭다운이 이 서버에 쓸 수 없는 키를 보였다(고르면 409).
 * 기준 시각: 실제 시각(TOTP 창) — OTP 는 창 끝 12초 안이면 다음 창까지 기다린다(bmOnboard7bKeys 와 같은 꼴).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop6x-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,wown,sown,own2,own3';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HERE = path.dirname(fileURLToPath(import.meta.url));

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret(); const SECRET2 = generateSecret(); const SECRET3 = generateSecret();   // 계정마다 OTP 하나씩(같은 창의 코드는 한 번만 쓴다)
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'own2', role: 'admin', totpEnabled: true, totpSecret: SECRET2 },
  { username: 'own3', role: 'admin', totpEnabled: true, totpSecret: SECRET3 },
] }));
(await import('../src/security/secretVault.js')).saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const PL = await import('../src/bmusage/onboard/placement.js');
const BM = await import('../src/bmstor/registry.js');
const SH = await import('../src/routes/admin/shared.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] };

const U = {
  adm: { username: 'adm', role: 'admin', scope: null },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },    // 조회 무제한 + 쓰기 vcA
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vcA'] } },                         // 조회 vcA
  own: { username: 'own', role: 'admin', scope: null },
  own2: { username: 'own2', role: 'admin', scope: null },
  own3: { username: 'own3', role: 'admin', scope: null },
  wown: { username: 'wown', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
  sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  // 판정이 던지는 계정(쓰기 범위 칸 접근이 던진다 — 스냅샷 · 사용자 객체 이상)
  boom: { username: 'own', role: 'admin', scope: { vcenters: [], get writeVcenters() { throw new Error('boom'); } } },
};
let srv;
const base = async () => {
  if (srv) return `http://127.0.0.1:${srv.address().port}/api`;
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { insightsRouter } = await import('../src/routes/insights.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = U[req.headers['x-u']] || null; next(); });
  app.use('/api/insights', insightsRouter); app.use('/api/admin', adminRouter); app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${srv.address().port}/api`;
};
test.after(() => { try { srv?.close(); } catch { /* */ } });
const call = async (u, method, p, body) => {
  const r = await fetch(`${await base()}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
  return { s: r.status, j, txt };
};
const otpFor = async (secret) => {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 12_000) await new Promise((r) => setTimeout(r, left + 50));
  return generateToken(secret, { counter: Math.floor(Date.now() / 30_000) });
};
const W = SH.WRITE_SCOPE_PARTIAL_REASON;

/* ── A1 ─────────────────────────────────────────────────────────────────── */
test('A1 ① 공용 게이트 — 쓰기 메서드는 조회 ∧ 쓰기 전체 범위 · 안전 메서드는 그대로 · 사유는 따로 · 쓰기 범위 계정은 파일을 쓰지 않는다', async () => {
  // 재현 꼴(기준판 04fad6d1): wadm PUT fleet/assign vcB → 200 · fleet-assign.json { tagb1: vcB }
  const fa = await call('wadm', 'PUT', '/insights/fleet/assign', { key: 'TAGB1', vcenterId: 'vcB' });
  assert.equal(fa.s, 403, fa.txt); assert.equal(fa.j.reason, W); assert.equal(fa.j.writeScope, 'partial');
  assert.equal(fs.existsSync(path.join(DIR, 'fleet-assign.json')), false, '쓰기 범위 계정은 귀속 파일을 쓰지 않는다');
  const sa = await call('sadm', 'PUT', '/insights/fleet/assign', { key: 'TAGB1', vcenterId: 'vcB' });
  assert.equal(sa.s, 403); assert.match(sa.j.reason, /전체 범위\(vCenter 제한 없는\) 계정만 할 수 있습니다/, '조회 범위 사유는 그대로'); assert.equal(sa.j.writeScope, undefined);
  assert.equal((await call('adm', 'PUT', '/insights/fleet/assign', { key: 'TAGB1', vcenterId: 'vcB' })).s, 200, '전체 관리자는 그대로');
  // 계정 × 메서드 표(대표 라우트) — 기대 상태(전체 관리자 · 쓰기 일부 관리자 · 조회 vcA 관리자 · 소유자 · 쓰기 일부 소유자 · 조회 vcA 소유자)
  const T = [
    ['GET', '/tools/bm-storage', null, { adm: 200, wadm: 200, sadm: 403, own: 200, wown: 200, sown: 403 }],
    ['PUT', '/tools/bm-storage/settings', { intervalMinutes: 30 }, { adm: 200, wadm: 403, sadm: 403, own: 200, wown: 403, sown: 403 }],
    ['GET', '/tools/bm-usage/perf-rules', null, { own: 200, wown: 200 }],
    ['PUT', '/tools/bm-usage/perf-rules', { rules: {} }, { adm: 403, wadm: 403, sadm: 403, own: 200, wown: 403, sown: 403 }],
    ['GET', '/admin/backup/status', null, { adm: 403, own: 200, wown: 200, sown: 403 }],   // requireSettingsOwner 의 GET — 결정 대기(그대로)
    ['PUT', '/admin/backup/settings', {}, { adm: 403, wadm: 403, own: 200, wown: 403, sown: 403 }],
    ['POST', '/tools/rma/tests/validate', { test: 'nope' }, { adm: 200, wadm: 403, sadm: 403 }],   // 저장 직전 검증 — 예외 아님
    ['POST', '/tools/cvp/parse-preview', { kind: 'nope', text: 'x' }, { adm: 400, wadm: 400, sadm: 403 }],   // 읽기성 POST 예외(본문만 파싱 — 400 = 게이트 통과 · 본문 검증)
  ];
  for (const [m, p, b, exp] of T) {
    for (const [u, want] of Object.entries(exp)) {
      const r = await call(u, m, p, b);
      assert.equal(r.s, want, `${u} ${m} ${p}: ${r.txt.slice(0, 160)}`);
    }
  }
  const wo = await call('wown', 'PUT', '/admin/backup/settings', {});
  assert.equal(wo.j.reason, SH.SETTINGS_OWNER_WRITE_SCOPE_REASON); assert.equal(wo.j.requiredOwner, undefined, '이미 소유자인 계정에 소유자 등록 안내를 하지 않는다');
  assert.equal((await call('sown', 'PUT', '/admin/backup/settings', {})).j.reason, SH.SETTINGS_OWNER_FULL_SCOPE_REASON, '조회 범위 소유자 사유는 그대로');
  // HEAD · OPTIONS 는 안전 메서드
  const req = (method, user) => ({ method, user });
  assert.equal(SH.isSafeMethod(req('HEAD')), true); assert.equal(SH.isSafeMethod(req('options')), true); assert.equal(SH.isSafeMethod(req('DELETE')), false);
  const g = SH.fullScopeOnlyWith('x');
  for (const [m, want] of [['HEAD', 'next'], ['OPTIONS', 'next'], ['DELETE', 403], ['PATCH', 403], ['POST', 403]]) {
    let got = null; const res = { status: (s) => ({ json: () => { got = s; } }) };
    g(req(m, U.wadm), res, () => { got = 'next'; });
    assert.equal(got, want, m);
  }
  assert.deepEqual(SH.fullScopeOnlyWith('x', { readPost: true }).gate, { kind: 'fullScope', readPost: true }, '아키텍처 점검이 여전히 전체 범위로 센다(kind)');
});

test('A1 ② 판정이 던지면 거부(쓰기) · 안전 메서드는 조회 판정 그대로 · 등급 질의(isOwnerTier)는 쓰기 범위를 보지 않는다', async () => {
  assert.equal((await call('boom', 'PUT', '/tools/bm-storage/settings', { intervalMinutes: 30 })).s, 403);
  assert.equal((await call('boom', 'PUT', '/admin/backup/settings', {})).s, 403);
  assert.equal((await call('boom', 'GET', '/tools/bm-storage')).s, 200, 'GET 은 조회 판정만(예전 그대로)');
  const { isOwnerTier } = await import('../src/routes/api/bmOnboard.js');
  assert.equal(await isOwnerTier({ method: 'POST', user: U.wown }), true, '법인마다 쓰기 범위를 따로 보는 라우트 안 등급(8a 창 · 7b 행) — bmMaint8aRoute 가 vcA 법인 창 200 을 고정');
  assert.equal(await isOwnerTier({ method: 'POST', user: U.sown }), false);
  assert.equal(await isOwnerTier({ method: 'POST', user: U.adm }), false);
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */
const key = (o) => { const r = KS.addKey({ privateKey: F.ed25519Key().pem, ...o }, { by: 'own' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.key; };
const BOTH = ['bm-usage', 'bm-storage'];
const kA = key({ name: 'k-vcA', folderCorp: 'vcA', features: BOTH });
const kB = key({ name: 'k-vcB', folderCorp: 'vcB', features: BOTH });
const kG = key({ name: 'k-global' });
const kS = key({ name: 'k-a9', folderCorp: 'vcA', folderServer: 'db-a9', features: BOTH });
const acc = (o) => { const r = KS.saveAccount({ kind: 'os', ...o }, { by: 'own' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.account; };
const save = (o) => { const r = BM.saveBmServer({ username: 'mon', mounts: ['/'], bindApproved: true, ...o }); assert.equal(r.ok, true, JSON.stringify(r)); return r.server; };
const authOf = (name) => { const s = BM.listBmServersRaw().find((x) => x.name === name); const r = REFS.withResolvedAuth([s], { feature: 'bm-usage' })[0]; return r.authErrorCode || 'ok'; };

test('A2 ① 계정 법인 + 기본 키를 함께 바꾸는 저장은 그 계정을 쓰는 서버가 끊기면 409(대수만) · OTP 앞 · 비밀번호 계정의 법인 이동도 · 같으면 통과', async () => {
  const ops = acc({ name: 'ops', corp: 'vcA', username: 'mon', keyRef: kA.id });
  const pw = acc({ name: 'pw-ops', corp: 'vcA', username: 'mon2', password: 'pw-A' });
  save({ name: 'db-a', host: '10.1.0.1', vcenterId: 'vcA', credRef: ops.id });
  save({ name: 'db-a2', host: '10.1.0.2', vcenterId: 'vcA', credRef: ops.id });
  save({ name: 'db-p', host: '10.1.0.3', vcenterId: 'vcA', credRef: pw.id });
  save({ name: 'db-k', host: '10.1.0.4', vcenterId: 'vcA', credRef: ops.id, keyRef: kG.id });   // 서버 키가 있으면 계정 키를 쓰지 않는다(법인 대조는 한다)
  assert.deepEqual([authOf('db-a'), authOf('db-a2')], ['ok', 'ok']);
  // 재현 꼴(기준판): 200 → db-a · db-a2 key-folder
  const otp = await otpFor(SECRET);
  const r = await call('own', 'POST', '/tools/bm-usage/accounts', { id: ops.id, corp: 'vcB', keyRef: kB.id, otp });
  assert.equal(r.s, 409, r.txt); assert.equal(r.j.code, 'key-folder');
  assert.match(r.j.reason, /이 계정을 쓰는 서버 중 2대가 바꾼 기본 키의 폴더/); assert.match(r.j.reason, /3대가 다른 법인의 계정을 쓰게 됩니다/);
  assert.ok(!/db-a|k-vcB|vcB/.test(r.j.reason), '거부 문구에 서버 · 키 이름 · 폴더 값 없음');
  assert.deepEqual(r.j.servers, { kind: 0, keyFolder: 2, otherCorp: 3 });
  assert.equal(KS.accountById(ops.id).corp, 'vcA', '저장하지 않았다'); assert.deepEqual([authOf('db-a'), authOf('db-a2')], ['ok', 'ok']);
  // 409 는 OTP 앞 — 같은 코드로 이어 보낸 정상 저장이 통과(예전: B-4 거절이 OTP 를 먹어 403 ‘이미 사용된 코드’)
  const ok = await call('own', 'POST', '/tools/bm-usage/accounts', { id: ops.id, name: 'ops-renamed', otp });
  assert.equal(ok.s, 200, ok.txt); assert.equal(KS.accountById(ops.id).name, 'ops-renamed');
  // 비밀번호만 쓰는 계정을 다른 법인으로 — 옛 법인 서버가 다른 법인 계정 비밀번호로 접속하던 경로(대조 재현)
  const otp2 = await otpFor(SECRET2);
  const p = await call('own2', 'POST', '/tools/bm-usage/accounts', { id: pw.id, corp: 'vcB', password: 'pw-B', otp: otp2 });
  assert.equal(p.s, 409, p.txt); assert.equal(p.j.code, 'cred-other-corp'); assert.match(p.j.reason, /1대가 다른 법인의 계정을 쓰게 됩니다/);
  // 전 법인 공용('')으로 바꾸는 것은 어느 법인에나 맞는다(accountCorpOk — 분석의 credOk 와 같은 함수)
  const pub = await call('own2', 'POST', '/tools/bm-usage/accounts', { id: pw.id, corp: '', password: 'pw-C', otp: otp2 });
  assert.equal(pub.s, 200, pub.txt);
  // B-4 거절(vcA 계정 + vcB 키)도 OTP 앞 — 같은 코드로 정상 새 계정 저장
  const otp3 = await otpFor(SECRET3);
  assert.equal((await call('own3', 'POST', '/tools/bm-usage/accounts', { name: 'bad', kind: 'os', corp: 'vcA', username: 'x', keyRef: kB.id, otp: otp3 })).s, 400);
  assert.equal((await call('own3', 'POST', '/tools/bm-usage/accounts', { name: 'good', kind: 'os', corp: 'vcA', username: 'y', keyRef: kA.id, otp: otp3 })).s, 200);
});

test('A2 ② 판정(순수 쪽) — 이미 어긋나 있던 서버는 세지 않는다 · 종류 변경 · 새 계정 · 서버 키 · 비밀번호 고정 · 판정 하나', async () => {
  const a = acc({ name: 'mix', corp: 'vcA', username: 'mon', keyRef: kA.id });
  save({ name: 'db-m1', host: '10.2.0.1', vcenterId: 'vcA', credRef: a.id });
  const m2 = save({ name: 'db-m2', host: '10.2.0.2', vcenterId: 'vcB', credRef: a.id });   // 이미 어긋남(vcB 서버 · vcA 계정 · vcA 키)
  save({ name: 'db-m3', host: '10.2.0.3', vcenterId: 'vcA', credRef: a.id, osAuth: 'password', password: 'p' });
  const before = KS.accountById(a.id);
  assert.equal(REFS.accountUseIssue(before, { kind: 'os', corp: 'vcA', keyRef: kA.id }), null, '그대로면 통과(db-m2 는 이미 어긋나 있었다)');
  assert.equal(REFS.accountUseIssue(before, { kind: 'os', corp: '', keyRef: kG.id }), null, '공용 계정 · 전역 키');
  const u = REFS.accountUseIssue(before, { kind: 'os', corp: 'vcB', keyRef: kB.id });
  assert.deepEqual(u.servers, { kind: 0, keyFolder: 1, otherCorp: 2 }, 'db-m1 은 키 · 법인 둘 다 · db-m3 는 비밀번호 고정이라 법인만 · db-m2 는 새로 어긋나지 않음');
  assert.equal(REFS.accountUseIssue(before, { kind: 'idrac', corp: 'vcA', keyRef: '' }).code, 'account-kind');
  assert.equal(REFS.accountUseIssue(null, { kind: 'os', corp: 'vcB', keyRef: kB.id }), null, '새 계정 — 쓰는 서버 없음');
  // bm-storage 서버 저장도 같은 규칙 — 이미 어긋나 있던 서버의 무관한 수정(마운트)은 막지 않고, 같은 서버에 다른 법인 계정을 새로 고르면 막는다
  const { bmBindCheck } = await import('../src/routes/api/bmstor.js');
  assert.deepEqual(await bmBindCheck({ id: m2.id, name: 'db-m2', host: '10.2.0.2', username: 'mon', mounts: ['/', '/data'] }), { binds: false });
  assert.equal((await bmBindCheck({ id: m2.id, name: 'db-m2', host: '10.2.0.2', username: 'mon', credRef: acc({ name: 'mix2', corp: 'vcA', username: 'mon9', password: 'p' }).id })).code, 'cred-other-corp');
  // 판정 하나: 온보딩 분석 cred-other-corp 와 같은 함수
  for (const [x, y, want] of [['', 'vcB', true], ['vcA', '', true], ['vcA', 'VCA', true], ['vcA', 'vcB', false]]) assert.equal(PL.accountCorpOk(x, y), want, `${x}/${y}`);
  const src = fs.readFileSync(path.join(HERE, '../src/bmusage/onboard/importAnalyze.js'), 'utf8');
  assert.match(src, /const credOk = \(acc\) => accountCorpOk\(acc\.corp, vc\);/);
});

test('A2 ③ 등록부를 못 읽으면 모름 — 503 · 저장하지 않는다(실제 모듈 · 새 프로세스)', () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop6x-c-'));
  fs.writeFileSync(path.join(d, 'bm-storage.json'), '{"servers": [ broken');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const REFS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/refs.js'))});
    const r = REFS.accountUseIssue({ id: 'a_1', kind: 'os', corp: 'vcA', keyRef: '' }, { kind: 'os', corp: 'vcB', keyRef: '' });
    console.log(JSON.stringify({ code: r && r.code, status: r && r.status }));
  `], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { code: 'registry-unreadable', status: 503 });
  fs.rmSync(d, { recursive: true, force: true });
});

/* ── B4 ─────────────────────────────────────────────────────────────────── */
test('B4 bm-storage 폼 인증 목록 — 서버 판정(저장과 같은 함수)으로 이 서버에 쓸 수 있는 것만 · 법인 귀속 없음 표지 · 지금 설정 표시 · 소유자만', async () => {
  const accB = acc({ name: 'b-ops', corp: 'vcB', username: 'bmon', password: 'b' });
  const accA = acc({ name: 'a-ops', corp: 'vcA', username: 'amon', keyRef: kA.id });
  const by = (l) => Object.fromEntries(l.map((x) => [x.name, x]));
  // 재현 꼴(기준판): 경로 없음(폼은 /tools/bm-usage/ssh-keys 의 활성 키 전부) → 새 서버에 k-vcA 를 고르면 저장 409
  const n = await call('own', 'GET', '/tools/bm-storage/auth-choices?name=new1&host=10.9.9.9');
  assert.equal(n.s, 200, n.txt); assert.equal(n.j.corpless, true);
  const nk = by(n.j.keys);
  assert.deepEqual([nk['k-vcA'].selectable, nk['k-vcA'].issue, nk['k-vcB'].selectable, nk['k-global'].selectable, nk['k-a9'].selectable], [false, 'key-folder', false, true, false]);
  assert.equal(by(n.j.accounts)['a-ops'].selectable, false, '계정 기본 키도 같은 판정');
  assert.equal(by(n.j.accounts)['b-ops'].selectable, true, '법인 귀속 없는 서버에는 계정 법인 대조가 통과(accountCorpOk)');
  // 같은 입력으로 저장 판정과 대조(판정 하나)
  const { bmBindCheck } = await import('../src/routes/api/bmstor.js');
  for (const k of n.j.keys) assert.equal(!(await bmBindCheck({ name: 'new1', host: '10.9.9.9', username: 'mon', keyRef: k.id })).code, k.selectable, k.name);
  // 기존 vcA 서버(db-a9 — 서버별 폴더 키의 서버) · 지금 설정 표시
  const ex = save({ name: 'db-a9', host: '10.3.0.9', vcenterId: 'vcA', keyRef: kB.id });   // 이미 폴더 밖(예전 상태)
  const e = await call('own', 'GET', `/tools/bm-storage/auth-choices?id=${ex.id}&name=db-a9&host=10.3.0.9`);
  const ek = by(e.j.keys); const ea = by(e.j.accounts);
  assert.equal(e.j.corpless, false);
  assert.deepEqual([ek['k-vcA'].selectable, ek['k-a9'].selectable, ek['k-global'].selectable], [true, true, true]);
  assert.deepEqual([ek['k-vcB'].current, ek['k-vcB'].selectable], [true, true], '지금 설정 그대로 두는 것은 이 쓰기가 만든 문제가 아니다(저장 판정과 같다)');
  assert.equal(ea['a-ops'].selectable, true); assert.equal(ea['b-ops'].selectable, false); assert.equal(ea['b-ops'].issue, 'cred-other-corp');
  const ren = await call('own', 'GET', `/tools/bm-storage/auth-choices?id=${ex.id}&name=db-a9-new&host=10.3.0.9`);
  assert.equal(by(ren.j.keys)['k-a9'].selectable, false, '이름을 바꾸면 서버별 폴더 키는 맞지 않는다(폼 값으로 다시 묻는다)');
  // 소유자만 · 응답에 비밀 없음
  assert.equal((await call('adm', 'GET', '/tools/bm-storage/auth-choices')).s, 403);
  assert.equal((await call('sown', 'GET', '/tools/bm-storage/auth-choices')).s, 403);
  assert.ok(!/privateKey|password|"b"/.test(e.txt), '비밀 칸 없음');
  void accB; void accA;
});
