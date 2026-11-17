/**
 * rebut79.test.js — 전체 점검 79회차(76 · 77 · 78회차 수정 반증 — 적대적 재검토).
 *
 * 77회차(bmusage 온보딩 · SSH 키 · 정비 창) 반증:
 *  R1 백업 복원이 지금 SSH 키 저장소의 **읽기 오류**(EACCES · EIO)를 '없음' 으로 보고 합쳐, 번들의 키(개인키가 가려진)를 전부 빼고
 *     지금 봉인본(유일한 사본) 자리에 빈 저장소를 썼다(예약 · 적용 둘 다 — 재현). 77 F1 이 지킨 원본을 복원 경로가 덮었다 → 읽기 오류면 그 파일은 복원하지 않는다.
 *  R2 정비 창 계수(77 F5): 읽기 오류 동안 메모리에 센 계수 · ‘창 끝 뒤 억제’ 점검 결과를 회복 때 파일 값으로 덮어 버렸다(leak 1 → 0 · 재현) → 합친다.
 *  R3 키 회전 · 삭제가 저장소를 못 읽은 동안 '키를 찾을 수 없습니다'(404)로 답했다(본인 OTP 소모 뒤 틀린 안내) → 못 읽음(503)을 먼저.
 *
 * 76회차(원격 접속 게이트웨이) 반증 · 남긴 결정의 권장안:
 *  P1 RDP 동시 세션 상한(결정 — 권장안): SSH 와 같은 값(전체 REMOTE_MAX_SESSIONS · 계정당 REMOTE_MAX_SESSIONS_PER_USER) · 티켓 소비 전에 4429 + 사유 · 한 번만 푼다
 *  P2 중계 프록시 삭제(결정 — 권장안): 그 중계를 쓰는 매핑이 있으면 409 + 매핑 이름 · 개수(범위 admin 은 보이는 이름만)
 *  P3 76 F5 읽기 오류 중의 빈 목록이 화면 · 설정 상태에서 '대상 없음 · 중계 서버 0(꺼짐)' 으로 보였다 → 표지(registryReadError)
 *
 * 78회차(PDU · 전력 · 중계 점검) 반증:
 *  Q1 PDU 연결 테스트 — 판정(pduAccessMoved)은 저장과 같은데 접속값이 달랐다: 요청에 없는 SSH 포트를 판정은 '저장값 유지' 로 보고 접속은 22 로 —
 *     저장 비밀번호가 저장 포트가 아닌 22 번으로 나갔다(재현) → 수정 장비는 저장 경로와 같은 규칙으로 접속값을 먼저 정하고 그 값으로 판정 · 접속
 *  Q2 PDU 부분 합 표지(78 F4)가 관제 콘솔 설비 KPI(pduSummary)에는 가지 않았다 → 부분 합 장비 수
 */
import { test, before } from 'node:test';
import { EventEmitter } from 'node:events';
import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut79-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.OTP_ROLE_ENFORCE = 'false';
process.env.DATA_SOURCE = 'live';
process.env.REMOTE_MAX_SESSIONS = '3';            // P1 — SSH 와 같은 env 를 RDP 도 읽는다(모듈 로드 전에)
process.env.REMOTE_MAX_SESSIONS_PER_USER = '2';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = (n) => path.join(DIR, n);
const realRead = fs.readFileSync;
/** 그 경로 읽기만 EACCES(root 로 도는 시험에서는 chmod 로 재현되지 않는다). */
function denyRead(file, fn) {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { return fn(); } finally { fs.readFileSync = realRead; }
}
const HOUR = 3_600_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR;
let clock = BASE;
const JFL = await import('../src/util/jsonFileLoad.js');
JFL._setJsonFileLoadClockForTest(() => clock);
test.after(() => JFL._setJsonFileLoadClockForTest());

const KEY_DOC = { keys: [{ id: 'k_aaaaaa', name: 'kr-ops', algo: 'ed25519', fingerprint: 'SHA256:x', publicKey: 'ssh-ed25519 AAAA', privateKey: 'enc$1$SEALED-ONLY-COPY', status: 'active' }], accounts: [] };

test('R1 예약 복원 적용 — 지금 키 저장소 읽기 오류면 그 파일을 덮지 않는다(봉인본 유지 · 실패로 남김)', async () => {
  const { redactKeyStoreText } = await import('../src/bmusage/onboard/keyBundle.js');
  const SR = await import('../src/backup/stagedRestore.js');
  const file = F('ssh-keys.json');
  fs.writeFileSync(file, JSON.stringify(KEY_DOC));
  const bundle = redactKeyStoreText(JSON.stringify(KEY_DOC)).text;
  assert.doesNotMatch(bundle, /SEALED-ONLY-COPY/, '번들에는 개인키가 없다(전제)');
  // 합치기 함수 자체: 읽기 오류면 던진다(빈 저장소를 돌려주지 않는다)
  assert.throws(() => denyRead(file, () => SR.reconcileForApply('ssh-keys.json', bundle, DIR)), /읽지 못해\(EACCES\)/);
  // 적용 전체: 예약 파일을 만들어 적용 → 실패로 남고 지금 파일은 그대로
  fs.mkdirSync(path.join(DIR, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'backups', '.restore-staged.json'), JSON.stringify({ v: 1, stagedAt: clock, source: 'test', files: { 'ssh-keys.json': bundle } }));
  const r = denyRead(file, () => SR.applyStagedRestore({ configDir: DIR }));
  assert.ok(r, '적용 결과');
  assert.equal(r.applied.includes('ssh-keys.json'), false, '읽기 오류면 적용하지 않는다');
  assert.ok(r.failed.some((f) => f.file === 'ssh-keys.json' && /읽지 못해/.test(f.reason)), '실패로 남긴다(무음 아님)');
  assert.match(realRead(file, 'utf8'), /SEALED-ONLY-COPY/, '지금 봉인본 그대로');
  // 파일이 없으면(ENOENT) 예전과 같다 — 번들 그대로 합친다(되살릴 수 없는 키는 빠짐)
  fs.unlinkSync(file);
  const rc = SR.reconcileForApply('ssh-keys.json', bundle, DIR);
  assert.equal(JSON.parse(rc.content).keys.length, 0);
});

test('R1 복원 예약(restoreCentral) — 지금 키 저장소 읽기 오류면 예약하지 않고 failed 로 알린다', async () => {
  const { redactKeyStoreText } = await import('../src/bmusage/onboard/keyBundle.js');
  const SVC = await import('../src/backup/service.js');
  const file = F('ssh-keys.json');
  fs.writeFileSync(file, JSON.stringify(KEY_DOC));
  const bundle = redactKeyStoreText(JSON.stringify(KEY_DOC)).text;
  let out;
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { out = await SVC.restoreCentral({ central: { files: { 'ssh-keys.json': bundle } } }, { retention: 5, source: 'rebut79' }); } finally { fs.readFileSync = realRead; }
  const failed = out.failed || [];
  assert.ok(failed.some((f) => f.file === 'ssh-keys.json' && /읽지 못해\(EIO\)/.test(f.reason)), JSON.stringify(out).slice(0, 400));
  let staged = null;
  try { staged = JSON.parse(realRead(path.join(DIR, 'backups', '.restore-staged.json'), 'utf8')); } catch { staged = null; }
  assert.ok(!staged || !staged.files || staged.files['ssh-keys.json'] === undefined, '예약에 넣지 않는다');
  assert.match(realRead(file, 'utf8'), /SEALED-ONLY-COPY/);
});

test('R2 정비 창 계수 — 읽기 오류 동안 센 계수 · 점검 결과를 회복 때 파일 값과 합친다(덮지 않는다)', async () => {
  const RT = await import('../src/bmusage/maint/runtime.js');
  const file = F('maintenance-stats.json');
  RT._resetMaintRuntimeForTest();
  fs.writeFileSync(file, JSON.stringify({ v: 1, byWindow: { 'mw-aaaaaa': { alerts: 5, after: 1, hold: 0, focus: 0, collect: 2, collectFail: 0, at: BASE - 1000 } }, leak: { n: 0, last: 3, at: BASE - 1000 } }));
  // 읽기 오류 동안: 메모리로 센다 · 점검이 leak 1 을 찾는다 · 저장은 건너뛴다
  denyRead(file, () => {
    RT.countSuppression('alerts', ['mw-aaaaaa'], { now: BASE + 10 });
    RT.countSuppression('collect', ['mw-bbbbbb'], { now: BASE + 20 });
    RT.noteApplied('alerts', 'srv', BASE - 10, ['mw-aaaaaa'], BASE + 30);   // 끝(until) 뒤 적용 = leak
    return RT.auditCycle({ now: BASE + 40, factsOf: () => ({ ok: true, byId: new Map() }) }).then((a) => assert.equal(a.leak, 1));
  });
  await new Promise((r) => setImmediate(r));
  assert.match(realRead(file, 'utf8'), /"alerts":5/, '읽기 오류 중에는 파일을 덮지 않는다(77 F5)');
  clock += JFL.READ_RETRY_MS + 1;
  const st = RT.maintStats();
  assert.equal(st.byWindow['mw-aaaaaa'].alerts, 6, '파일 5 + 메모리 1');
  assert.equal(st.byWindow['mw-aaaaaa'].collect, 2);
  assert.equal(st.byWindow['mw-bbbbbb'].collect, 1, '메모리에만 있던 창');
  assert.equal(st.leak.n, 1, '읽기 오류 동안 찾은 leak 을 옛 파일 값(0)으로 덮지 않는다');
  assert.equal(st.readError, undefined, '회복 뒤 읽기 오류 표지는 풀린다');
  RT.flushMaintStats();
  const saved = JSON.parse(realRead(file, 'utf8'));
  assert.equal(saved.byWindow['mw-aaaaaa'].alerts, 6); assert.equal(saved.leak.n, 1);
  // 순수 합치기 — 점검 묶음별 결과는 늦은 쪽
  const m = RT.mergeStats({ byWindow: {}, leak: { n: 2, at: 50 }, leakBy: { cycle: { n: 2, at: 50 }, hold: { n: 0, at: 60 } } },
    { byWindow: { 'mw-cccccc': { alerts: 1, at: 70 } }, leak: { n: 0, at: 40 }, leakBy: { cycle: { n: 0, at: 40 } } });
  assert.equal(m.leak.n, 2, '더 새 점검 결과(파일)');
  assert.equal(m.leakBy.cycle.n, 2);
  assert.equal(m.byWindow['mw-cccccc'].alerts, 1);
  RT._resetMaintRuntimeForTest();
});

test('R3 키 회전 · 삭제 — 저장소를 못 읽은 동안은 404(키 없음)가 아니라 503(못 읽음)', async () => {
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const REFS = await import('../src/bmusage/onboard/refs.js');
  const file = F('ssh-keys.json');
  fs.writeFileSync(file, JSON.stringify(KEY_DOC));
  KS._resetKeyStoreForTest();
  denyRead(file, () => {
    for (const r of [REFS.rotateKey('k_aaaaaa', 'k_bbbbbb'), REFS.deleteKeyIfUnused('k_aaaaaa'), REFS.deleteAccountIfUnused('a_aaaaaa')]) {
      assert.equal(r.ok, false); assert.equal(r.code, 'registry-unreadable'); assert.equal(r.status, 503);
      assert.match(r.reason, /읽기 오류/);
    }
    // 키 인증 서버는 비밀번호로 넘어가지 않는다(7b — 77 F1 의 빈 캐시가 '키 없음' 판정을 만들지 않는다)
    const a = REFS.resolveOsAuth({ keyRef: 'k_aaaaaa', password: 'old-pw', username: 'root' });
    assert.equal(a.ok, false); assert.equal(a.code, 'store-unreadable');
    const b = REFS.resolveOsAuth({ credRef: 'a_aaaaaa', password: 'old-pw' });
    assert.equal(b.ok, false); assert.equal(b.code, 'store-unreadable');
  });
  KS._resetKeyStoreForTest();
});

/* ─────────────────────────── 76회차 반증 ─────────────────────────── */

const auth = await import('../src/auth/auth.js');
const sessions = await import('../src/auth/sessions.js');
const gw = await import('../src/proxy/sshGateway.js');
const gd = await import('../src/proxy/guacdTunnel.js');
const reg = await import('../src/proxy/registry.js');
const { issueRdpTicket, consumeRdpTicket } = await import('../src/proxy/rdpTicket.js');
const { store } = await import('../src/store.js');

const allWs = [];
class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.frames = []; this.closed = null; this.bufferedAmount = 0; allWs.push(this); }
  send(d, cb) { this.frames.push(String(d)); if (cb) setImmediate(() => cb()); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
}
test.after(async () => { for (const w of allWs) { try { w.close(1000, 'test end'); } catch { /* */ } } await new Promise((r) => setTimeout(r, 30)); });
function fakeGuacd() {
  return Object.assign(new EventEmitter(), {
    writes: [], destroyed: false,
    write(s) { if (this.destroyed) throw new Error('destroyed'); this.writes.push(String(s)); return true; },
    destroy() { if (this.destroyed) return; this.destroyed = true; setImmediate(() => this.emit('close')); },
    end() { this.destroy(); }, setTimeout() {},
  });
}
function mkUser(username, role = 'operator') {
  const r = auth.createUser({ username, role, password: 'Passw0rd!x', scope: {} }, { trusted: true });
  assert.equal(r.ok, true, r.reason);
}
function login(username) {
  const u = auth.getUser(username);
  const s = sessions.newSessionId();
  sessions.setActiveSession(username, s);
  return auth.signToken({ sub: username, role: u.role, name: username, src: 'local', tv: u.tokenVersion || 0, sid: s });
}
const tick = () => new Promise((r) => setImmediate(r));

before(() => {
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }], vms: [{ id: 'vm1', vcenterId: 'vc-a', name: 'vm1', ipAddresses: ['10.1.1.5'] }, { id: 'vm2', vcenterId: 'vc-b', name: 'vm2', ipAddresses: ['10.2.2.5'] }], hosts: [] };
});

test('P1 RDP 동시 세션 상한 — SSH 와 같은 값 · 계정당 · 전체 · 티켓을 쓰지 않고 4429 + 사유 · 닫히면 한 번만 푼다', async () => {
  assert.equal(gw.MAX_SESSIONS, 3, 'SSH 상수(전체)');
  assert.equal(gw.MAX_SESSIONS_PER_USER, 2, 'SSH 상수(계정당)');
  assert.deepEqual({ max: gd.rdpSessionCounts().max, per: gd.rdpSessionCounts().perUserCap }, { max: 3, per: 2 }, 'RDP 도 같은 값');
  gd._resetRdpSessionsForTest();
  reg.saveConfig({ guacd: { host: '127.0.0.1', port: 4822 } });
  mkUser('rdpcapa'); mkUser('rdpcapb');
  const ta = login('rdpcapa'); const tb = login('rdpcapb');
  const ma = reg.addMapping({ protocol: 'rdp', targetHost: '10.1.1.5', targetPort: 3389, owner: 'rdpcapa', vcenterId: 'vc-a' }).mapping;
  const mb = reg.addMapping({ protocol: 'rdp', targetHost: '10.1.1.5', targetPort: 3389, owner: 'rdpcapb', vcenterId: 'vc-a' }).mapping;
  const socks = [];
  gd._setRdpDepsForTest({ connect: () => { const s = fakeGuacd(); socks.push(s); return s; } });
  const open = (tok, owner, m) => {
    const ticket = issueRdpTicket({ username: 'u', password: 'p' }, { owner });
    const ws = new FakeWs();
    gd._rdpHandleForTest(ws, new URLSearchParams({ mappingId: m.id, ticket }), auth.resolveTokenUser(tok), tok);
    return { ws, ticket };
  };
  try {
    const a1 = open(ta, 'rdpcapa', ma); const a2 = open(ta, 'rdpcapa', ma);
    assert.equal(a1.ws.closed, null); assert.equal(a2.ws.closed, null);
    assert.equal(gd.rdpSessionCounts().active, 2);
    // 계정당(2) 초과 — 티켓을 쓰지 않고 닫는다
    const a3 = open(ta, 'rdpcapa', ma);
    assert.deepEqual(a3.ws.closed, { code: 4429, reason: 'too-many-sessions-user' });
    assert.ok(consumeRdpTicket(a3.ticket, { user: 'rdpcapa' }), '넘쳐 닫힌 연결은 티켓을 소비하지 않는다');
    // 전체(3) — b 하나는 열리고 둘째는 전체 상한
    const b1 = open(tb, 'rdpcapb', mb);
    assert.equal(b1.ws.closed, null);
    const b2 = open(tb, 'rdpcapb', mb);
    assert.deepEqual(b2.ws.closed, { code: 4429, reason: 'too-many-sessions' });
    assert.equal(gd.rdpSessionCounts().active, 3, '거절된 연결은 세지 않는다');
    // 닫힘 — ws close 와 guacd close 가 둘 다 와도 한 번만 푼다
    a1.ws.close(1000, 'bye');
    await tick(); await tick(); await tick();
    assert.equal(gd.rdpSessionCounts().active, 2, '한 번만 푼다(ws close + guacd close)');
    const a4 = open(ta, 'rdpcapa', ma);
    assert.equal(a4.ws.closed, null, '자리가 나면 다시 열린다');
    // 티켓 없는 연결은 세지 않는다(상한 판정은 통과했지만 티켓에서 닫힘)
    for (const x of [a2, b1, a4]) x.ws.close(1000, 'bye');
    await tick(); await tick(); await tick();
    assert.equal(gd.rdpSessionCounts().active, 0);
    const nt = new FakeWs();
    gd._rdpHandleForTest(nt, new URLSearchParams({ mappingId: ma.id }), auth.resolveTokenUser(ta), ta);
    assert.equal(nt.closed?.code, 1011);
    await tick();
    assert.equal(gd.rdpSessionCounts().active, 0, '티켓이 없어 닫힌 연결은 세지 않는다');
  } finally { gd._setRdpDepsForTest(null); gd._resetRdpSessionsForTest(); }
  // 웹 문구(사유 코드와 1:1) — 서버 소스의 4429 사유마다 문구가 있다
  const { remoteCloseReasonText } = await import('../../web/src/remote/sshSend.js');
  for (const c of ['too-many-sessions', 'too-many-sessions-user', 'too many sessions', 'too many sessions for user']) assert.match(remoteCloseReasonText(c) || '', /원격/, c);
});

test('P2 중계 프록시 삭제 — 그 중계를 쓰는 매핑이 있으면 409 + 매핑 이름 · 개수(데이터를 지우지 않고 막는다) · 매핑을 지우면 삭제된다', async () => {
  mkUser('rmadmin', 'admin');
  const tok = login('rmadmin');
  const p = reg.saveProxy({ name: 'relay-b', proxyHost: '10.9.9.9', vcenterIds: ['vc-b'] });
  assert.equal(p.ok, true, p.reason);
  const m1 = reg.addMapping({ name: 'db-rdp', protocol: 'rdp', targetHost: '10.2.2.5', targetPort: 3389, owner: 'rmadmin', vcenterId: 'vc-b' });
  assert.equal(m1.ok, true, m1.reason);
  assert.equal(m1.mapping.proxyId, p.proxy.id, '전제: vc-b 매핑은 relay-b 중계');
  const r = reg.removeProxy(p.proxy.id);
  assert.equal(r.ok, false); assert.equal(r.code, 'proxy-in-use'); assert.equal(r.status, 409); assert.equal(r.inUse, 1);
  assert.ok(reg.listProxies().some((x) => x.id === p.proxy.id), '중계는 남는다');
  assert.ok(reg.getMapping(m1.mapping.id), '매핑도 남는다');
  const { remoteRouter } = await import('../src/routes/remote.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = auth.resolveTokenUser(tok); next(); });
  app.use('/api/remote', remoteRouter);
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/proxies/${p.proxy.id}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'proxy-in-use'); assert.equal(body.inUse, 1);
    assert.deepEqual(body.mappings.map((x) => x.name), ['db-rdp']);
    assert.match(body.reason, /매핑 1개/); assert.match(body.reason, /db-rdp/);
    reg.removeMapping(m1.mapping.id);
    const res2 = await fetch(`http://127.0.0.1:${srv.address().port}/api/remote/proxies/${p.proxy.id}`, { method: 'DELETE' });
    assert.equal(res2.status, 200);
    assert.equal(reg.listProxies().some((x) => x.id === p.proxy.id), false);
  } finally { await new Promise((res) => srv.close(() => res())); }
  // 사유 문구 — 열 개 넘으면 나머지는 개수로
  assert.match(reg.proxyInUseReason(Array.from({ length: 12 }, (_, i) => `m${i}`), 12), /외 2개/);
  assert.doesNotMatch(reg.proxyInUseReason(['a\u0000b'], 1), /\u0000/, '이름의 제어 문자는 문구에 싣지 않는다');
  assert.match(reg.proxyInUseReason(['NSX x'], 1, { nsx: 1 }), /NSX 매니저 설정/, 'NSX 매핑은 수집이 다시 만든다 — 매니저 설정을 먼저');
});

test('P3 76 F5 읽기 오류 중 — 매핑 목록 · 설정 상태가 빈 목록을 \'없음 · 0\' 으로 말하지 않는다', async () => {
  const FILE = F('remote-access.json');
  assert.ok(fs.existsSync(FILE), '전제: 앞 시험이 쓴 파일');
  const jfl = await import('../src/util/jsonFileLoad.js');
  const fresh = await import(`../src/proxy/registry.js?r79p3=${Date.now()}`);
  fs.readFileSync = function (p, ...a) {
    if (String(p) === FILE) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try {
    const e = fresh.registryReadError();
    assert.ok(e && e.readError === true && /읽기 오류/.test(e.reason));
    assert.equal(fresh.listMappings().length, 0, '전제: 빈 목록으로 돈다');
  } finally { fs.readFileSync = realRead; }
  void jfl;
  // 원본 모듈(라우트 · 설정 상태가 쓰는 것)로 표지가 응답 · 설정 상태에 실리는지 — 원본 모듈은 캐시가 있어 새로 읽게 만든다
  const src = (await import('./_stripComments.js')).stripComments(realRead(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/routes/remote.js'), 'utf8'));
  assert.match(src, /registryReadError: rre\.reason/, 'GET /mappings 가 읽기 오류 표지를 싣는다');
  const ss = (await import('./_stripComments.js')).stripComments(realRead(path.join(path.dirname(new URL(import.meta.url).pathname), '../src/settingsStatus/sources.js'), 'utf8'));
  assert.match(ss, /const rre = !!proxyReadError\(\); const loadError = damaged\('remote-access\.json'\) \|\| rre;/, '설정 상태 — 읽기 오류도 주의(중계 서버 0 · 꺼짐 아님) · 로드를 먼저');
});

/* ─────────────────────────── 78회차 반증 ─────────────────────────── */

test('Q1 PDU 연결 테스트 — 요청에 없는 SSH 포트는 저장값으로 접속한다(판정과 접속이 같은 값 — 저장 비밀번호가 다른 포트로 가지 않는다)', async () => {
  const net = await import('node:net');
  const reg78 = await import('../src/pdu/registry.js');
  const { registerPdu } = await import('../src/routes/api/pdu.js');
  const counting = async () => { const o = { n: 0 }; o.srv = net.createServer((sock) => { o.n += 1; sock.destroy(); }); await new Promise((r) => o.srv.listen(0, '127.0.0.1', r)); o.port = o.srv.address().port; return o; };
  const prevLb = process.env.SSRF_ALLOW_LOOPBACK;
  process.env.SSRF_ALLOW_LOOPBACK = 'true';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'full', role: 'admin', scope: null }; next(); });
  const router = express.Router(); registerPdu(router); app.use('/api', router);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const s = await counting();
  try {
    const saved = reg78.saveDevice({ name: 'Q1', host: '127.0.0.1', username: 'apc', password: 'Q1-secret', sshPort: s.port });
    assert.equal(saved.ok, true, saved.reason);
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/pdu/test`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: saved.device.id, name: 'Q1', host: '127.0.0.1', username: 'apc', password: '' }) });   // SSH 포트 칸 없음(API 직접 호출 — 계정은 입력 검사가 요구한다)
    const j = await r.json().catch(() => null);
    assert.ok(!/비밀번호가 필요|접속처/.test(String(j?.reason || '')), JSON.stringify(j));
    assert.ok(s.n >= 1, `저장 포트로 접속해야 한다(예전: 22 번으로 저장 비밀번호를 들고 접속) — ${JSON.stringify(j)}`);
  } finally {
    s.srv.close(); await new Promise((r) => srv.close(() => r()));
    if (prevLb === undefined) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = prevLb;
  }
});

test('Q2 관제 콘솔 설비 — PDU 부분 합(유닛 일부 · 탐지 멈춤) 장비 수를 함께 센다', async () => {
  const { pduSummary } = await import('../../web/src/console/consoleData.js');
  const snap = (summary) => ({ snapshot: { ok: true, summary } });
  const s = pduSummary({ devices: [snap({ powerW: 1000, powerPartial: true, powerUnitsRead: 1, units: 2 }), snap({ powerW: 500, unitsIncomplete: true }), snap({ powerW: 700 })] });
  assert.equal(s.powerW, 2200); assert.equal(s.powerRead, 3);
  assert.equal(s.powerPartial, 2, '부분 합 장비 2대');
  const full = pduSummary({ devices: [snap({ powerW: 700 })] });
  assert.equal(full.powerPartial, undefined, '부분 합이 없으면 칸을 싣지 않는다(기존 모양 그대로)');
  const page = realRead(new URL('../../web/src/console/pages/ConsoleFacility.jsx', import.meta.url), 'utf8');
  assert.match(page, /ps\.powerPartial \?/, 'KPI 문구가 부분 합을 밝힌다');
});
