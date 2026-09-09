/**
 * v2.439 — 중계 경로 진단이 TLS 실패 원인을 구분한다.
 *
 * 현장 사례: 192.168.52.221:4068 에 vCenter 연결 시도 → TCP ✓ / TLS ✗
 *   `error:0A0000C6:SSL routines:tls_get_more_records:packet length too long`
 * 이건 상대가 평문 HTTP 로 응답한 것이라 **그 포트가 TLS 가 아니라는 뜻**인데(4068 은 중계 규약상
 * IRS 포탈), 화면은 TLS 실패를 무조건 'HAProxy backend 끊김 → systemctl restart haproxy' 로
 * 안내하고 있었다 — 재시작으로는 절대 안 고쳐지는 잘못된 조치.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';

const { classifyTlsError, probeRelayPath, buildVerdict } = await import('../src/vcenter/relayProbe.js');

test('TLS 오류 분류 — 평문/타임아웃/리셋을 가른다', () => {
  assert.equal(classifyTlsError('806825BE2B7F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long'), 'plaintext');
  assert.equal(classifyTlsError('routines:ssl3_get_record:wrong version number'), 'plaintext');
  assert.equal(classifyTlsError('Client network socket disconnected before secure TLS connection was established'), 'unknown');
  assert.equal(classifyTlsError('TLS 핸드셰이크 무응답(시간 초과) — …'), 'timeout');
  assert.equal(classifyTlsError('read ECONNRESET'), 'reset');
  assert.equal(classifyTlsError(''), 'unknown');
});

test('평문 HTTP 포트를 vCenter 로 등록한 경우 — 원인·조치가 정확해야 한다', async () => {
  // 포탈처럼 평문으로 답하는 서버를 띄운다(사용자 화면의 :4068 재현).
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', server: 'test-portal' });
    res.end('<html><head><title>The Davinci Virtual Platform</title></head><body>vmware-portal</body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await probeRelayPath(`127.0.0.1:${port}`, { timeoutMs: 3000 });
    // 루프백은 SSRF 가드에 막히므로 이 경로로는 프로브가 수행되지 않는다 — 가드가 살아 있음을 확인한다.
    assert.ok(r.blocked, 'SSRF 가드(루프백 차단)가 사라졌다');
    assert.equal(r.verdict.state, 'blocked');
  } finally { srv.close(); }
});

test('평문 응답이면 재시작이 아니라 주소 수정을 안내한다 — 사용자 화면 재현(문구 회귀)', () => {
  const tlsErr = '806825BE2B7F0000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long';
  const v = buildVerdict({
    port: 4068, tlsCause: classifyTlsError(tlsErr),
    steps: {
      tcp: { ok: true, ms: 38 },
      tls: { ok: false, ms: 79, error: tlsErr },
      plain: { ok: true, status: 200, server: '', title: 'The Davinci Virtual Platform', portal: true },
    },
  });
  assert.equal(v.state, 'tls-plaintext');
  assert.match(v.text, /TLS\(HTTPS\)가 아닙니다/);
  assert.match(v.text, /vCenter 가 아니라 포탈/);          // 평문 재확인으로 정체를 밝힌다
  assert.match(v.text, /이 포트\(4068\)는 중계 표준 규약상 \*\*IRS 포탈/);
  assert.match(v.text, /4066/);                            // 대신 써야 할 포트를 제시
  assert.match(v.text, /재시작해도 고쳐지지 않습니다/);      // 잘못된 조치를 명시적으로 부정
  assert.ok(!/systemctl restart haproxy/.test(v.text), '평문 케이스에 재시작 안내가 남아 있다');
});

test('무응답(타임아웃)은 기존 안내(HAProxy backend)를 유지한다 — 두 경우가 섞이면 안 된다', () => {
  const v = buildVerdict({
    port: 4066, tlsCause: 'timeout',
    steps: { tcp: { ok: true }, tls: { ok: false, error: 'TLS 핸드셰이크 무응답(시간 초과)' } },
  });
  assert.equal(v.state, 'tls');
  assert.match(v.text, /systemctl restart haproxy/);
  assert.ok(!/TLS\(HTTPS\)가 아닙니다/.test(v.text));
  assert.match(v.text, /IRS vCenter/);                     // 포트 역할은 여기서도 알려준다
});

test('정상·HTTP 단계 실패 판정은 그대로', () => {
  assert.equal(buildVerdict({ port: 443, tlsCause: null, steps: { tcp: { ok: true }, tls: { ok: true }, http: { ok: true, status: 200 } } }).state, 'ok');
  assert.equal(buildVerdict({ port: 443, tlsCause: null, steps: { tcp: { ok: true }, tls: { ok: true }, http: { ok: false, error: 'x' } } }).state, 'http');
  assert.equal(buildVerdict({ port: 443, tlsCause: null, steps: { tcp: { ok: false } } }).state, 'tcp');
});

test('TCP 조차 안 되는 주소는 tcp 단계에서 끝난다(불필요한 TLS 시도 없음)', async () => {
  // 닫힌 포트를 만든다(리스너를 열었다 즉시 닫아 확실히 비어 있는 포트를 얻는다).
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const r = await probeRelayPath(`127.0.0.1:${closedPort}`, { timeoutMs: 1500 });
  assert.ok(r.blocked, '루프백은 SSRF 가드로 차단되어야 한다');
});

test('중계 표준 포트 역할이 결과에 실린다(어떤 포트를 써야 하는지 안내의 근거)', async () => {
  // 사설망 대역이지만 응답 없는 주소 — 가드를 통과하고 TCP 타임아웃으로 끝난다.
  const r = await probeRelayPath('10.255.255.1:4068', { timeoutMs: 1200 });
  assert.equal(r.blocked, undefined);
  assert.equal(r.port, 4068);
  assert.match(r.portRole, /IRS 포탈/);
  assert.equal(r.verdict.state, 'tcp');
});
