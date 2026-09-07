/**
 * v2.421 — SAN 스위치 연결 테스트 진단: 실패 분류·추적 로그·사전 점검·비동기 실행 등록부·엣지 대행·
 * SSH 추적(ssh -vvv 상당)·구형 알고리즘 폴백.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sansw2421-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function closedPort() {
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; await new Promise((r) => srv.close(r)); return port;
}

test('classifyFailure: 메시지 → 단계/안내 (DNS·TCP·핸드셰이크·인증·exec·타임아웃)', async () => {
  const { classifyFailure, makeTracer, traceText } = await import('../src/sanswitch/testDiag.js');
  assert.equal(classifyFailure('getaddrinfo ENOTFOUND sw1').phase, 'dns');
  assert.equal(classifyFailure('TCP 연결 실패: ECONNREFUSED').phase, 'tcp');
  assert.equal(classifyFailure('TCP 연결 타임아웃(10초) — SYN 에 응답 없음').phase, 'tcp');
  assert.match(classifyFailure('TCP 연결 타임아웃(10초)').hint, /수집 주체/, '중앙 실행이면 엣지로 바꾸라는 안내가 붙는다');
  assert.doesNotMatch(classifyFailure('TCP 연결 타임아웃(10초)', 'tcp', { agentDelegated: true, ranOn: 'agent-WA' }).hint, /수집 주체/);
  assert.equal(classifyFailure('Timed out while waiting for handshake').phase, 'ssh-handshake');
  const hs = classifyFailure('Handshake failed: no matching key exchange algorithm');
  assert.equal(hs.phase, 'ssh-handshake'); assert.match(hs.hint, /no matching key exchange algorithm/);
  assert.equal(classifyFailure('All configured authentication methods failed').phase, 'ssh-auth');
  assert.equal(classifyFailure('SSH exec 타임아웃(45s): switchshow').phase, 'exec');
  assert.equal(classifyFailure('테스트 타임아웃(60초)', 'ssh-auth').phase, 'ssh-auth', '타임아웃은 마지막 단계를 유지');
  assert.equal(classifyFailure('엣지 "x" 가 10분 안에 테스트 요청을 가져가지 않았습니다(pull 없음)').phase, 'edge');
  assert.equal(classifyFailure('???').phase, 'unknown');
  const tr = makeTracer(Date.now(), { limit: 2 });
  tr.push('a'); tr.push('b', 'error'); tr.push('c');
  assert.equal(tr.lines.length, 2); assert.equal(tr.dropped, 1);
  assert.match(traceText(tr.lines), /\[\+0\.\d{3}s\] a\n\[\+0\.\d{3}s\] ✖ b/);
});

test('precheckTarget: 닫힌 포트는 tcp 단계 ECONNREFUSED, 열린 포트는 성공, IP 는 DNS 를 건너뛴다', async () => {
  const { precheckTarget } = await import('../src/sanswitch/precheck.js');
  const lines = [];
  const p = await closedPort();
  const r = await precheckTarget('127.0.0.1', p, { trace: (m) => lines.push(m), timeoutMs: 3000 });
  assert.equal(r.ok, false); assert.equal(r.phase, 'tcp'); assert.match(r.reason, /ECONNREFUSED/);
  assert.ok(!lines.some((l) => /DNS 해석:/.test(l)), 'IP 는 DNS 단계를 건너뛴다');
  const srv = net.createServer(); await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const ok = await precheckTarget('localhost', srv.address().port, { trace: (m) => lines.push(m), timeoutMs: 3000 });
  assert.equal(ok.ok, true);
  assert.ok(lines.some((l) => /DNS 해석 결과: localhost →/.test(l)));
  assert.ok(lines.some((l) => /TCP 연결 성공/.test(l)));
  await new Promise((res) => srv.close(res));
});

test('testRuns: 중앙 실행은 즉시 runId 를 주고 진행 로그를 폴링으로 본다 — 닫힌 포트면 tcp 단계에서 빨리 끝난다', async () => {
  const { startTestRun, getTestRun, _resetForTest } = await import('../src/sanswitch/testRuns.js');
  _resetForTest();
  const port = await closedPort();
  const { id, target } = startTestRun({ type: 'brocade', collectMethod: 'ssh', host: '127.0.0.1', sshPort: port, username: 'admin', password: 'secret', agent: '' }, { verbose: true, user: 'u' });
  assert.equal(target, '');
  let run = getTestRun(id);
  assert.ok(run && !('password' in run) && !('device' in run), '응답에 비밀번호/장비 원본이 없다');
  for (let i = 0; i < 100 && run.status !== 'done'; i++) { await sleep(50); run = getTestRun(id); }
  assert.equal(run.status, 'done');
  assert.equal(run.result.ok, false); assert.equal(run.result.phase, 'tcp');
  assert.match(run.result.hint, /포트 번호/);
  assert.ok(run.trace.some((l) => /TCP 연결 시도/.test(l.msg)) && run.trace.some((l) => l.level === 'error'));
  assert.ok(run.elapsedMs < 5000, 'readyTimeout(60초)을 기다리지 않는다');
  assert.ok(!JSON.stringify(run).includes('secret'));
  _resetForTest();
});

test('testRuns: 엣지 위임 장비는 큐 → 엣지가 가져감(비밀번호 포함) → 대상 엣지만 결과 회신 가능', async () => {
  const { startTestRun, getTestRun, takeTestRequestsForAgent, completeTestRun, _resetForTest } = await import('../src/sanswitch/testRuns.js');
  _resetForTest();
  const { id } = startTestRun({ type: 'brocade', collectMethod: 'ssh', host: '10.93.95.37', sshPort: 22, username: 'admin', password: 'pw', agent: 'agent-WA' }, { verbose: false });
  assert.equal(getTestRun(id).status, 'queued');
  assert.deepEqual(takeTestRequestsForAgent('agent-KR'), [], '다른 엣지에는 안 간다');
  const mine = takeTestRequestsForAgent('AGENT-wa');
  assert.equal(mine.length, 1); assert.equal(mine[0].id, id); assert.equal(mine[0].device.password, 'pw', '엣지는 로그인해야 하므로 비밀번호를 받는다');
  assert.equal(getTestRun(id).status, 'dispatched');
  assert.deepEqual(takeTestRequestsForAgent('agent-WA'), [], '한 번 가져가면 다시 주지 않는다');
  assert.equal(completeTestRun(id, 'agent-KR', { ok: true }).ok, false, '남의 결과 회신 거부');
  const r = completeTestRun(id, 'agent-WA', { ok: false, ms: 1234, reason: 'All configured authentication methods failed', phase: 'ssh-auth', hint: 'h', trace: [{ t: 5, msg: 'TCP 연결 성공', level: 'info' }], cliRaw: [], secret: 'x' });
  assert.equal(r.ok, true);
  const run = getTestRun(id);
  assert.equal(run.status, 'done'); assert.equal(run.result.ok, false); assert.equal(run.result.phase, 'ssh-auth'); assert.equal(run.result.ranOn, 'agent-WA');
  assert.ok(run.trace.some((l) => /\[엣지\] TCP 연결 성공/.test(l.msg)), '엣지 추적 로그가 중앙 로그에 합쳐진다');
  assert.equal(run.result.secret, undefined, '정화되지 않은 필드는 버린다');
  assert.equal(completeTestRun('nope', 'agent-WA', {}).ok, false);
  _resetForTest();
});

/** 로컬 ssh2 서버 — 비밀번호 인증 + exec 'echo' 응답. algorithms 로 구형 전용 서버를 흉내낼 수 있다. */
function startSshServer({ algorithms, respond = (cmd) => `ran:${cmd}\n` } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const server = new ssh2.Server({ hostKeys: [privateKey], banner: 'FOS-TEST', ...(algorithms ? { algorithms } : {}) }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc, _rej, info) => { const st = acc(); st.write(respond(info.command)); st.exit(0); st.end(); });
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

test('withSsh 추적: 접속·배너·핸드셰이크·세션 준비·실행 로그를 남기고, verbose 면 ssh2 프로토콜 로그(ssh -vvv 상당)도 남긴다', async () => {
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const srv = await startSshServer();
  const lines = [];
  const r = await withSsh({ host: '127.0.0.1', port: srv.port, username: 'admin', password: 'pw', trace: (m, lv) => lines.push({ m, lv }), verbose: true }, async (sh) => {
    const x = await sh.exec('switchshow', 5000);
    return { out: x.stdout };
  });
  await srv.close();
  assert.match(r.out, /ran:switchshow/);
  const txt = lines.map((l) => l.m);
  assert.ok(txt.some((m) => /SSH 접속 시도 → 127\.0\.0\.1:\d+ 계정=admin 인증=비밀번호/.test(m)));
  assert.ok(txt.some((m) => /서버 배너: FOS-TEST/.test(m)));
  assert.ok(txt.some((m) => /핸드셰이크 완료 .*kex=/.test(m)));
  assert.ok(txt.some((m) => /SSH 세션 준비 완료\(인증 성공\)/.test(m)));
  assert.ok(txt.some((m) => /^실행: switchshow$/.test(m)) && txt.some((m) => /^완료\(exec\): exit=0/.test(m)));
  assert.ok(lines.filter((l) => l.lv === 'debug' && /^ssh2: /.test(l.m)).length > 5, 'verbose 프로토콜 로그');
  assert.ok(!txt.some((m) => m.includes('pw')), '비밀번호는 로그에 없다');
});

test('withSsh 인증 실패는 오류 로그로 남고 reject 된다; verbose 아니면 ssh2 프로토콜 로그가 없다', async () => {
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const srv = await startSshServer();
  const lines = [];
  await assert.rejects(withSsh({ host: '127.0.0.1', port: srv.port, username: 'admin', password: 'wrong', trace: (m, lv) => lines.push({ m, lv }) }, async () => ({})), /authentication methods failed/i);
  await srv.close();
  assert.ok(lines.some((l) => l.lv === 'error' && /SSH 오류: All configured authentication methods failed/.test(l.m)));
  assert.equal(lines.filter((l) => /^ssh2: /.test(l.m)).length, 0);
});

test('구형 알고리즘 전용 서버(dh-group1-sha1/aes128-cbc)에는 1회 폴백으로 붙고 추적 로그에 남는다', async () => {
  const { withSsh } = await import('../src/proxy/sshExec.js');
  const srv = await startSshServer({ algorithms: { kex: ['diffie-hellman-group1-sha1'], cipher: ['aes128-cbc'], serverHostKey: ['ssh-rsa'], hmac: ['hmac-sha1'] } });
  const lines = [];
  const r = await withSsh({ host: '127.0.0.1', port: srv.port, username: 'admin', password: 'pw', trace: (m) => lines.push(m) }, async (sh) => ({ out: (await sh.exec('x', 5000)).stdout }));
  await srv.close();
  assert.match(r.out, /ran:x/);
  assert.ok(lines.some((m) => /구형 알고리즘.*재시도/.test(m)), '폴백이 로그에 남는다');
  assert.ok(lines.some((m) => /\[구형 알고리즘 포함 재시도\]/.test(m)));
  assert.ok(lines.some((m) => /kex=diffie-hellman-group1-sha1/.test(m)), '협상된 약한 알고리즘이 표시된다');
});

test('testDeviceConnection(SSH): 로컬 ssh 서버에 붙어 단계 추적을 남기고, 명령이 없으면 exec 단계 실패로 분류', async () => {
  const { testDeviceConnection } = await import('../src/sanswitch/poller.js');
  // 명령을 모르는 서버(제한 셸 흉내) — 필수 명령 switchshow 가 없으면 실패해야 한다.
  const srv = await startSshServer({ respond: (cmd) => `sh: ${cmd.split(' ')[0]}: command not found\n` });
  const r = await testDeviceConnection({ type: 'brocade', collectMethod: 'ssh', host: '127.0.0.1', sshPort: srv.port, username: 'admin', password: 'pw' }, { timeoutMs: 20_000, verbose: false });
  await srv.close();
  assert.equal(r.ok, false, '가짜 서버는 switchshow 를 모른다 → 실패');
  assert.ok(['exec', 'parse'].includes(r.phase), `phase=${r.phase}`);
  const msgs = r.trace.map((l) => l.msg);
  assert.ok(msgs.some((m) => /연결 테스트 시작/.test(m)) && msgs.some((m) => /TCP 연결 성공/.test(m)) && msgs.some((m) => /SSH 세션 준비 완료/.test(m)));
  assert.ok(r.hint && r.hint.length > 10);
  assert.ok(!JSON.stringify(r).includes('"pw"'));
});
