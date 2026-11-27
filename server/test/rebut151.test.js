/**
 * 151회차 — 146회차(141 결정 D1 · D2) 반증 회귀. 실제 키 저장소 + secretVault · 실제 등록부 · 실제 상태 파일 · 실제 ssh2 가짜 sshd(시도를 센다).
 *  ① R1(146 의 OTHER_MAX 완화가 D1 을 되살린다): 성공했던 판의 다시 탐침이 **빨리** 판정을 못 내는 서버(접속 거부 · 호스트키 · 꺼진 sshd) 셋으로 시작하면
 *     매 다시 탐침마다 완화(한 유효 시간 동안 예전처럼 동시)에 들어가, AD 비밀번호가 바뀐 뒤 동시 수만큼 틀린 비밀번호가 갔다(D1 이 그 계정에서 늘 꺼짐).
 *     → 완화는 판정을 못 낸 탐침들이 **실제로 기다리게 한 시간의 합**이 OTHER_MIN_MS(1분)를 넘을 때만(망 장애 · 시한 — 146 이 막으려던 순차 대기). 빠른 실패는 차례로 다음 탐침.
 *  ② 망 장애(느린 실패)에서는 완화가 그대로 든다(146 ③ 의 목적 유지) · 빠른 실패만 이어지면 끝까지 하나씩(영원히 막히지 않음).
 *  ③ 실제 bm-storage 주기: 접속 거부 서버 셋이 앞에 있는 계정 — AD 비밀번호가 바뀐 뒤 틀린 비밀번호 1회(146 판본 4회 = collectMany 동시 수).
 *  ④ R2(범위 밖에서 146 이 본 것 — 판정): 진단 스냅샷(bmusage/snapshot/run.js)은 비밀번호를 한 번만 보낸다(keyboard-interactive 로 같은 비밀번호를 다시 보내지 않는다 —
 *     주기 수집 · 서버 정보와 같은 v3.25 반증 F1 규칙. 스냅샷도 공통 계정 정지를 쓴다 — poller.recordOsAuthOutcome → noteCredOutcome).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rb151-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.BMSTOR_IO_SAMPLE_SEC = '0';   // df 만(I/O 표본 sleep 없음)
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const ssh2 = (await import('ssh2')).default;
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');
const ST = await import('../src/sshaccess/state.js');
const G = await import('../src/sshaccess/accountGate.js');
const BP = await import('../src/bmstor/poller.js');
const SNAP = await import('../src/bmusage/snapshot/run.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
/** 가짜 sshd — password · keyboard-interactive 둘 다 받는다(SSSD/AD 서버처럼) · 모든 인증 시도를 센다 · df 는 '/' 로 답한다. */
async function fakeSshd() {
  const st = { password: null, seen: [] };
  const srv = new ssh2.Server({ hostKeys: [rsa()] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') {
        st.seen.push({ method: 'password', password: ctx.password });
        return st.password && ctx.password === st.password ? ctx.accept() : ctx.reject(['password', 'keyboard-interactive']);
      }
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          st.seen.push({ method: 'keyboard-interactive', password: answers?.[0] });
          return st.password && answers?.[0] === st.password ? ctx.accept() : ctx.reject(['password', 'keyboard-interactive']);
        });
      }
      return ctx.reject(['password', 'keyboard-interactive']);
    });
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const stream = acc();
        stream.write(/^df /.test(info.command) ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n' : 'ok\n');
        stream.exit(0); stream.end();
      });
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, st, close: () => srv.close() };
}
const SSHD = await fakeSshd();
test.after(() => SSHD.close());
/** 닫힌 포트(접속 거부 — 꺼진 sshd · 폐기한 서버) */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const tries = (pw, from = 0) => SSHD.st.seen.slice(from).filter((x) => x.password === pw).length;
function shiftClock(t) {
  const real = Date.now;
  const c = { offset: 0 };
  t.mock.method(Date, 'now', () => real.call(Date) + c.offset);
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = { feature: 'bm-usage', rejected: (r) => r?.authFailed === true, stopped: (code) => ({ ok: false, gated: code }) };
let accSeq = 0;
const acctId = () => `a_${(0xb151000 + (accSeq += 1)).toString(16).padStart(12, '0')}`;




test('④ R2 — 진단 스냅샷은 비밀번호를 한 번만 보낸다(keyboard-interactive 로 같은 비밀번호를 다시 보내지 않는다)', async () => {
  SSHD.st.password = 'Snap-right';
  const db = async () => ({ snapshotStoreAvailable: async () => true, snapshotCountSince: async () => 0, snapshotPrune: async () => {}, snapshotInsert: async () => ({ ok: true }) });
  const deps = { db, authOutcome: async () => null, authStop: async () => null, idrac: () => null };
  const target = { key: 'svc:rb151', vcenterId: 'vcA', osHost: { host: '127.0.0.1', port: SSHD.port, username: 'svc151', password: 'Snap-wrong' } };
  const n0 = SSHD.st.seen.length;
  const r = await SNAP.runSnapshotLocal({ target, reason: '반증 151 시험', settings: {} }, deps);
  assert.equal(r.code, 'auth', JSON.stringify(r).slice(0, 300));
  assert.equal(tries('Snap-wrong', n0), 1, `틀린 비밀번호는 한 번만(지금 ${tries('Snap-wrong', n0)}회 — ${SSHD.st.seen.slice(n0).map((x) => x.method).join(',')})`);
  // 맞는 비밀번호면 그대로 로그인한다(회귀 없음)
  const ok = await SNAP.runSnapshotLocal({ target: { ...target, key: 'svc:rb151b', osHost: { ...target.osHost, password: 'Snap-right' } }, reason: '반증 151 시험', settings: {} }, deps);
  assert.notEqual(ok.code, 'auth');
  assert.equal(tries('Snap-right', n0), 1);
});
