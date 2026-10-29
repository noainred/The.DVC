/**
 * test/bareosDiagnose2822.test.js — 단계별 연결 진단(v2.822, console.diagnoseConsole) + 그 과정에서 고친 결함.
 *  ① 정상: 주소 → DNS(IP 면 건너뜀) → TCP → TLS-PSK → 인증 → JSON 모드 → .clients 전부 ok
 *  ② 실패 단계가 정확하다: 차단 주소(접속 0) · DNS 없음 · DNS 가 차단 대역 · TCP 거부 · 비밀번호 틀림(TLS) · PAM · 가짜 Director(역챌린지) · .clients ACL 거부
 *     실패 뒤 단계는 '시도 안 함'(실패로 세지 않는다) · 실패 단계에는 조치 안내(hint)
 *  ③ B1: 이름이 차단 대역으로 풀리면 openConsole 도 'blocked'(예전에는 'connect') · B6: TLS 핸드셰이크 중 취소
 *  ④ DNS 로 잰 주소에 고정해 붙는다(다시 풀지 않는다)
 *  C7: 핸드셰이크 중 소켓 끊김은 'closed'(인증 정지 대상 아님) · TLS 경보(ERR_SSL_*)만 'tls'
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 Director 가 127.0.0.1 에 있다(실제 ipBlockReason·pinnedLookup 경로 그대로 — 루프백만 허용)
const { diagnoseConsole, openConsole, DIAG_STAGES } = await import('../src/bareos/console.js');
const { startFakeDirector } = await import('./_fakeBareosDirector.js');

const servers = [];
const start = async (o) => { const s = await startFakeDirector(o); servers.push(s); return s; };
after(async () => { for (const s of servers) await s.close(); });

const ok = (cmd) => (cmd === '.clients' ? { clients: [{ name: 'kr-fd' }, { name: 'pl-fd' }] } : {});
const conn = (fd, extra = {}) => ({ host: '127.0.0.1', port: fd.port, name: 'portal', password: 'pw-1', timeoutMs: 4000, ...extra });
const byKey = (r) => Object.fromEntries(r.stages.map((x) => [x.key, x]));
const KEYS = DIAG_STAGES.map(([k]) => k);

test('① 정상 — 모든 단계 ok · IP 주소면 DNS 는 건너뜀 · 단계 순서 고정 · 클라이언트 목록', async () => {
  const fd = await start({ name: 'portal', password: 'pw-1', handle: ok });
  const r = await diagnoseConsole(conn(fd));
  assert.equal(r.ok, true, JSON.stringify(r.stages));
  assert.deepEqual(r.stages.map((x) => x.key), KEYS);
  const s = byKey(r);
  assert.equal(s.dns.skipped, true);
  for (const k of ['address', 'tcp', 'tls', 'auth', 'api', 'command']) assert.equal(s[k].ok, true, k);
  assert.deepEqual(r.clients, ['kr-fd', 'pl-fd']);
  assert.match(s.auth.detail, /bareos-dir Version: 25/);
  assert.ok(r.tls.protocol);
  assert.equal(r.failed, null);
});

test('② 비밀번호 틀림 → TLS 단계 실패(조치: 콘솔 이름·비밀번호) · 뒤 단계는 시도 안 함', async () => {
  const fd = await start({ name: 'portal', password: 'pw-1', handle: ok });
  const r = await diagnoseConsole(conn(fd, { password: 'wrong' }));
  const s = byKey(r);
  assert.equal(r.ok, false);
  assert.equal(s.tcp.ok, true);
  assert.equal(s.tls.ok, false);
  assert.equal(s.tls.code, 'tls');
  assert.match(s.tls.hint, /비밀번호/);
  for (const k of ['auth', 'api', 'command']) assert.equal(s[k].skipped, true, k);
  assert.deepEqual(r.failed.key, 'tls');
});

test('② PAM 콘솔 · 가짜 Director(역챌린지 응답 불일치) → 인증 단계 실패', async () => {
  const pam = await start({ name: 'portal', password: 'pw-1', handle: ok, mode: 'pam' });
  let s = byKey(await diagnoseConsole(conn(pam)));
  assert.equal(s.auth.ok, false); assert.equal(s.auth.code, 'pam'); assert.match(s.auth.hint, /PAM/);
  const fake = await start({ name: 'portal', password: 'pw-1', handle: ok, mode: 'wrong-dir-secret' });
  s = byKey(await diagnoseConsole(conn(fake)));
  assert.equal(s.auth.ok, false); assert.equal(s.auth.code, 'auth'); assert.match(s.auth.detail, /Director 가 아닐 수 있습니다/);
});

test('② .clients 가 ACL 로 거부되면 시험 명령 단계만 실패(조치: Command ACL)', async () => {
  const fd = await start({ name: 'portal', password: 'pw-1', handle: (cmd) => (cmd === '.clients' ? { error: ['.clients: is an invalid command or needs access right'] } : {}) });
  const r = await diagnoseConsole(conn(fd));
  const s = byKey(r);
  assert.equal(s.api.ok, true);
  assert.equal(s.command.ok, false);
  assert.equal(s.command.code, 'jsonrpc');
  assert.match(s.command.hint, /Command ACL/);
  assert.match(s.command.detail, /access right/);
});

test('② 차단 주소는 접속하지 않는다 · DNS 없음 · DNS 가 차단 대역 · TCP 거부', async () => {
  const fd = await start({ name: 'portal', password: 'pw-1', handle: ok });
  const before = fd.identities.length;
  let r = await diagnoseConsole({ host: '169.254.169.254', port: fd.port, name: 'portal', password: 'pw-1' });
  assert.equal(byKey(r).address.ok, false); assert.equal(byKey(r).address.code, 'blocked'); assert.equal(byKey(r).tcp.skipped, true);
  assert.equal(fd.identities.length, before, '차단 주소로는 접속하지 않는다');
  const notFound = (h, o, cb) => { const e = new Error(`getaddrinfo ENOTFOUND ${h}`); e.code = 'ENOTFOUND'; cb(e); };
  r = await diagnoseConsole({ host: 'nope.corp', port: fd.port, name: 'portal', password: 'pw-1' }, { lookup: notFound });
  assert.equal(byKey(r).dns.ok, false); assert.match(byKey(r).dns.detail, /ENOTFOUND/); assert.equal(byKey(r).tcp.skipped, true);
  const blocked = (h, o, cb) => { const e = new Error('차단된 주소로 해석됩니다(169.254.169.254)'); e.code = 'ESSRFBLOCKED'; cb(e); };
  r = await diagnoseConsole({ host: 'meta.corp', port: fd.port, name: 'portal', password: 'pw-1' }, { lookup: blocked });
  assert.equal(byKey(r).dns.code, 'blocked'); assert.match(byKey(r).dns.hint, /차단 대역/);
  const closed = await new Promise((res) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  r = await diagnoseConsole({ host: '127.0.0.1', port: closed, name: 'portal', password: 'pw-1', timeoutMs: 3000 });
  assert.equal(byKey(r).tcp.ok, false); assert.equal(byKey(r).tcp.code, 'connect'); assert.match(byKey(r).tcp.detail, /연결 거부/);
});

test('④ DNS 로 잰 주소에 고정해 붙는다 — 이름을 다시 풀지 않는다', async () => {
  const fd = await start({ name: 'portal', password: 'pw-1', handle: ok });
  let calls = 0;
  const lookup = (h, o, cb) => { calls += 1; return cb(null, '127.0.0.1', 4); };
  const r = await diagnoseConsole({ host: 'bareos-dir.corp', port: fd.port, name: 'portal', password: 'pw-1', timeoutMs: 4000 }, { lookup });
  assert.equal(r.ok, true, JSON.stringify(r.stages));
  assert.equal(calls, 1, 'DNS 는 한 번');
  assert.equal(byKey(r).dns.detail, '127.0.0.1');
  assert.equal(r.address, '127.0.0.1');
});

test('③ B1: 이름이 차단 대역으로 풀리면 openConsole 도 blocked(예전에는 connect) · B6: TLS 핸드셰이크 중 취소', async () => {
  const blocked = (h, o, cb) => { const e = new Error('차단된 주소로 해석됩니다'); e.code = 'ESSRFBLOCKED'; cb(e); };
  await assert.rejects(openConsole({ host: 'meta.corp', port: 9101, name: 'portal', password: 'x' }, { lookup: blocked }), (e) => e.code === 'blocked');
  // S4: 차단 문구에 Director 이름·해석 결과를 싣지 않는다(lastError 로 범위 계정 목록에도 간다)
  const loud = (h, o, cb) => { const e = new Error(`차단된 대상입니다 — ${h} 의 DNS 해석 결과가 169.254.169.254`); e.code = 'ESSRFBLOCKED'; cb(e); };
  await assert.rejects(openConsole({ host: 'bareos-dir.kr.corp', port: 9101, name: 'portal', password: 'x' }, { lookup: loud }), (e) => e.code === 'blocked' && !/kr\.corp|169\.254/.test(e.message));
  // TLS 를 받지 않는 서버(접속만 받고 아무 말 없음) — 핸드셰이크가 시한까지 매달린다. 취소하면 바로 끝나야 한다.
  const mute = net.createServer((s) => { s.on('error', () => {}); s.resume(); });   // 읽어 버린다(안 읽으면 상대가 끊어도 'end' 가 오지 않아 close 가 매달린다)
  await new Promise((r) => mute.listen(0, '127.0.0.1', r));
  servers.push({ close: () => new Promise((r) => mute.close(() => r())) });
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(openConsole({ host: '127.0.0.1', port: mute.address().port, name: 'portal', password: 'x', timeoutMs: 10_000 }, { signal: ac.signal }), (e) => e.code === 'aborted');
  assert.ok(Date.now() - t0 < 5_000, '취소가 시한(10초)까지 매달리지 않는다');
});

test('C7(v2.822): TLS 핸드셰이크 중 소켓 끊김은 closed(일시적 — 주기 조회를 멈추지 않는다) · TLS 경보만 tls', async () => {
  const rst = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.resetAndDestroy()); });
  await new Promise((r) => rst.listen(0, '127.0.0.1', r));
  servers.push({ close: () => new Promise((r) => rst.close(() => r())) });
  await assert.rejects(openConsole({ host: '127.0.0.1', port: rst.address().port, name: 'portal', password: 'x', timeoutMs: 4000 }), (e) => e.code === 'closed' && /끊겼습니다/.test(e.message));
  const s = byKey(await diagnoseConsole({ host: '127.0.0.1', port: rst.address().port, name: 'portal', password: 'x', timeoutMs: 4000 }));
  assert.equal(s.tls.code, 'closed');
  assert.match(s.tls.hint, /다시 시험/);
  const fd = await start({ name: 'portal', password: 'pw-1', handle: ok });
  for (const tlsMaxVersion of ['TLSv1.3', 'TLSv1.2']) {
    await assert.rejects(openConsole({ ...conn(fd, { password: 'wrong' }), tlsMaxVersion }), (e) => e.code === 'tls', tlsMaxVersion);
  }
});
