/**
 * test/bareosConsole.test.js — Bareos Director 콘솔 클라이언트(src/bareos/console.js·base64.js) 계약.
 *  ① Bareos 식 base64 = C 원본(BinToBase64) 참조 구현과 같다(두 변형 · 무작위 입력) + 손으로 계산한 고정값
 *  ② TLS-PSK(identity R_CONSOLE␞이름 · PSK=MD5 16진) → 인사(18.2 이상 형식) → CRAM-MD5 양방향 → 1000/1002 → JSON 모드
 *  ③ JSON-RPC result/error · 비 API 모드 EOD 종료 · 응답 크기 상한 · 절대 시한(조금씩 계속 보내는 상대)
 *  ④ 거부 분류: 비밀번호 틀림(auth) · 가짜 Director(역챌린지 불일치 — 명령을 보내지 않는다) · PAM · 미등록 콘솔 · 차단 주소 · 입력 검증
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bareosBase64, cramResponse, passwordMd5Hex } from '../src/bareos/base64.js';
import {
  openConsole, withConsole, normalizeConsoleOptions, BareosConsoleError, jsonRpcErrorText, bashName, CONSOLE_VERSION,
} from '../src/bareos/console.js';
import { startFakeDirector, refBase64, LOOPBACK_DEPS } from './_fakeBareosDirector.js';

const servers = [];
after(async () => { for (const s of servers) await s.close(); });
const start = async (o) => { const s = await startFakeDirector(o); servers.push(s); return s; };
const opts = (port, extra = {}) => ({ host: '127.0.0.1', port, name: 'portal', password: 'S3cret-비번', timeoutMs: 5000, ...extra });

test('① base64: 손 계산 고정값 — 0x00 · 0xFF(부호 확장 차이) · 표준 base64 와 호환 변형의 관계', () => {
  assert.equal(bareosBase64(Buffer.from([0x00]), false), 'AA');
  assert.equal(bareosBase64(Buffer.from([0xff]), false), '/D');   // int8_t 로 늘어나 남은 2비트가 11
  assert.equal(bareosBase64(Buffer.from([0xff]), true), '/w');    // 표준 '/w==' 에서 패딩만 뺀 것
  const std = (b) => b.toString('base64').replace(/=+$/, '');
  for (const n of [1, 2, 3, 16, 20]) {
    const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 128)); // 0x80 미만이면 호환 변형 = 표준
    assert.equal(bareosBase64(b, true), std(b), `n=${n}`);
  }
});

test('① base64: C 원본 참조 구현(BigInt uint32)과 무작위 300건 일치', () => {
  for (let k = 0; k < 300; k++) {
    const b = crypto.randomBytes(k % 34);
    assert.equal(bareosBase64(b, false), refBase64(b, false), `plain ${b.toString('hex')}`);
    assert.equal(bareosBase64(b, true), refBase64(b, true), `compat ${b.toString('hex')}`);
  }
});

test('① CRAM 응답은 HMAC-MD5(key=비밀번호 MD5 16진, data=챌린지)', () => {
  const key = passwordMd5Hex('pw');
  assert.equal(key, crypto.createHash('md5').update('pw').digest('hex'));
  const r = cramResponse('<1.2@x>', key);
  const d = crypto.createHmac('md5', key).update('<1.2@x>').digest();
  assert.equal(r.plain, refBase64(d, false));
  assert.equal(r.compatible, refBase64(d, true));
});

test('② TLS-PSK 로 인증하고 JSON 모드에서 명령 결과를 받는다', async () => {
  const fd = await start({ name: 'portal', password: 'S3cret-비번', handle: (cmd) => (cmd === '.clients' ? { clients: [{ name: 'kr-fd' }, { name: 'pl-fd' }] } : null) });
  const s = await openConsole(opts(fd.port), LOOPBACK_DEPS);
  try {
    assert.equal(s.info.tls?.protocol, 'TLSv1.3');
    assert.match(s.info.banner, /^OK: bareos-dir Version: 25\.0\.4/);
    assert.match(s.info.infoMessage, /logged in as: portal/);
    assert.deepEqual(await s.call('.clients'), { clients: [{ name: 'kr-fd' }, { name: 'pl-fd' }] });
    // 인사 형식: bconsole 과 같다(Director 는 18.2 미만을 거부) · identity 는 R_CONSOLE + 0x1E + 이름
    assert.equal(fd.hellos[0], `Hello portal calling version ${CONSOLE_VERSION} Version="${CONSOLE_VERSION}"\n`);
    assert.deepEqual(fd.identities, ['R_CONSOLE\x1eportal']);
    assert.deepEqual(fd.log.slice(0, 2), ['.api json', '.api json compact=yes']);
  } finally { s.close(); }
});

test('② 콘솔 이름의 공백은 0x01 로 바꿔 인사한다(bash)', async () => {
  assert.equal(bashName('my console'), 'my\x01console');
  const fd = await start({ name: 'my console', password: 'pw', tls: false, handle: () => ({ ok: 1 }) });
  const r = await withConsole(opts(fd.port, { name: 'my console', password: 'pw', tls: 'none' }), (s) => s.call('version'), LOOPBACK_DEPS);
  assert.deepEqual(r, { ok: 1 });
  assert.match(fd.hellos[0], /^Hello my\x01console calling version /);
});

test('③ JSON-RPC 오류는 messages.error 를 담은 jsonrpc 오류로 · 다음 명령은 계속된다', async () => {
  const fd = await start({ name: 'portal', password: 'S3cret-비번', handle: (cmd) => (cmd.startsWith('run') ? { error: ['Job "nope" not found.'] } : { ok: true }) });
  const s = await openConsole(opts(fd.port), LOOPBACK_DEPS);
  try {
    await assert.rejects(s.call('run job=nope yes'), (e) => e instanceof BareosConsoleError && e.code === 'jsonrpc' && /not found/.test(e.message));
    assert.deepEqual(await s.call('version'), { ok: true });
  } finally { s.close(); }
  assert.equal(jsonRpcErrorText({ message: 'failed' }), 'failed');
  assert.equal(jsonRpcErrorText({ message: 'failed', data: { messages: { error: ['a\n', ' b '] } } }), 'a / b');
});

test('③ 응답 크기 상한을 넘으면 too-large 로 끊는다', async () => {
  const big = 'x'.repeat(200_000);
  const fd = await start({ name: 'portal', password: 'S3cret-비번', handle: () => ({ big }) });
  const s = await openConsole(opts(fd.port, { maxResponseBytes: 100_000 }), LOOPBACK_DEPS);
  try {
    await assert.rejects(s.call('list jobs'), (e) => e.code === 'too-large');
  } finally { s.close(); }
});

test('③ 절대 시한: 상대가 조금씩 계속 보내도 timeout 으로 끊는다(유휴 시한이 아님)', async () => {
  const fd = await start({ name: 'portal', password: 'S3cret-비번', mode: 'drip', handle: () => null });
  const s = await openConsole(opts(fd.port), LOOPBACK_DEPS);
  const t0 = Date.now();
  try {
    await assert.rejects(s.call('list jobs', { timeoutMs: 1_200 }), (e) => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 4_000, '절대 시한 안에 끝나야 한다');
  } finally { s.close(); }
});

test('③ 인사 뒤 응답이 없으면 접속 시한 안에 timeout', async () => {
  const fd = await start({ name: 'portal', password: 'S3cret-비번', mode: 'silent-after-hello', handle: () => null });
  await assert.rejects(openConsole(opts(fd.port, { timeoutMs: 1_200 }), LOOPBACK_DEPS), (e) => e.code === 'timeout');
});

test('④ 비밀번호가 틀리면 PSK 단계(tls) 또는 CRAM 단계(auth)에서 거부 — 명령은 보내지 않는다', async () => {
  const fd = await start({ name: 'portal', password: 'right', handle: () => ({ ok: 1 }) });
  await assert.rejects(openConsole(opts(fd.port, { password: 'wrong' }), LOOPBACK_DEPS), (e) => e.code === 'tls');
  const plain = await start({ name: 'portal', password: 'right', tls: false, handle: () => ({ ok: 1 }) });
  await assert.rejects(openConsole(opts(plain.port, { password: 'wrong', tls: 'none' }), LOOPBACK_DEPS), (e) => e.code === 'auth');
  assert.ok(plain.log.includes('auth-failed'));
  assert.ok(!plain.log.some((c) => c.startsWith('.api')));
});

test('④ 가짜 Director(우리 챌린지에 틀린 응답): 거부하고 어떤 명령도 보내지 않는다', async () => {
  const fd = await start({ name: 'portal', password: 'pw', tls: false, mode: 'wrong-dir-secret', handle: () => ({ ok: 1 }) });
  await assert.rejects(openConsole(opts(fd.port, { password: 'pw', tls: 'none' }), LOOPBACK_DEPS),
    (e) => e.code === 'auth' && /등록한 Director 가 아닐 수/.test(e.message));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fd.log.includes('client-rejected-director'));
  assert.ok(!fd.log.some((c) => c.startsWith('.api')));
});

test('④ 미등록 콘솔(1999) · PAM 요구(1001) · 안내 메시지 없음은 각각 auth · pam · protocol', async () => {
  const fd = await start({ name: 'other', password: 'pw', tls: false, handle: () => null });
  await assert.rejects(openConsole(opts(fd.port, { password: 'pw', tls: 'none' }), LOOPBACK_DEPS), (e) => e.code === 'auth');
  const pam = await start({ name: 'portal', password: 'pw', tls: false, mode: 'pam', handle: () => null });
  await assert.rejects(openConsole(opts(pam.port, { password: 'pw', tls: 'none' }), LOOPBACK_DEPS), (e) => e.code === 'pam');
  const noinfo = await start({ name: 'portal', password: 'pw', tls: false, mode: 'no-info', handle: () => null });
  await assert.rejects(openConsole(opts(noinfo.port, { password: 'pw', tls: 'none', timeoutMs: 1_500 }), LOOPBACK_DEPS), (e) => e.code === 'protocol' || e.code === 'timeout');
});

test('④ 기본 의존성은 SSRF 차단 주소(루프백·링크로컬)를 연결 전에 거부한다', async () => {
  await assert.rejects(openConsole({ host: '127.0.0.1', port: 9101, name: 'portal', password: 'x' }), (e) => e.code === 'blocked');
  await assert.rejects(openConsole({ host: '169.254.169.254', port: 9101, name: 'portal', password: 'x' }), (e) => e.code === 'blocked');
});

test('④ 입력 검증: 주소·포트·이름·비밀번호 · 시한 범위 · TLS 기본값은 psk', () => {
  const bad = (o) => assert.throws(() => normalizeConsoleOptions(o), (e) => e.code === 'invalid');
  bad({ host: 'https://dir', port: 9101, name: 'p', password: 'x' });
  bad({ host: 'dir/x', port: 9101, name: 'p', password: 'x' });
  bad({ host: 'dir', port: 70000, name: 'p', password: 'x' });
  bad({ host: 'dir', port: 9101, name: 'p"q', password: 'x' });
  bad({ host: 'dir', port: 9101, name: 'p', password: '' });
  const ok = normalizeConsoleOptions({ host: 'bareos-dir.corp', name: '*UserAgent*', password: 'x', timeoutMs: 999_999 });
  assert.equal(ok.port, 9101);
  assert.equal(ok.tls, 'psk');
  assert.equal(ok.timeoutMs, 120_000);
  assert.equal(normalizeConsoleOptions({ host: 'd', name: 'p', password: 'x', tls: 'off' }).tls, 'psk', "'none' 이 아닌 값은 전부 psk");
});

test('명령에 줄바꿈·NUL 은 넣을 수 없다(명령 주입 방지)', async () => {
  const fd = await start({ name: 'portal', password: 'pw', tls: false, handle: () => ({ ok: 1 }) });
  await withConsole(opts(fd.port, { password: 'pw', tls: 'none' }), async (s) => {
    await assert.rejects(s.call('version\nrun job=x yes'), (e) => e.code === 'invalid');
    assert.deepEqual(await s.call('version'), { ok: 1 });
  }, LOOPBACK_DEPS);
});
