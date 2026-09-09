/**
 * v2.437 — 수집 서버 경고 배지의 '자세한 오류 메시지'.
 *  ① 엣지의 인증 거부 상세(출처 IP·엔드포인트·사유)를 export 에 실어 중앙에서 볼 수 있게 한다.
 *  ② 정체 충돌 기록에 양쪽 hostname/peer 를 남겨 '어느 장비냐'를 답할 수 있게 한다.
 * 불변조건: 토큰 값은 어떤 경로로도 나가지 않는다(지문·길이만).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { getCollectorDenyStats, _resetCollectorDenyStats, collectorRouter } = await import('../src/routes/collector.js');
const { noteAgentIdentity, noteVcenterOwner, agentIdentitySummary, _resetForTest } = await import('../src/central/agentIdentity.js');
const { config } = await import('../src/config.js');

/** express 라우터를 직접 두드리는 대신, 라우트 핸들러를 찾아 부른다(네트워크 없이 결정적). */
function callRoute(method, path, req) {
  const layer = collectorRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${path} 없음`);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  // json body 파서 등 앞단 미들웨어는 건너뛰고 마지막(실제 핸들러)만 부른다.
  handlers[handlers.length - 1](req, res, () => {});
  return res;
}
const mkReq = (headers = {}, ip = '10.0.0.9') => ({
  ip, socket: { remoteAddress: ip },
  get: (k) => headers[k] ?? headers[String(k).toLowerCase()] ?? undefined,
  body: {},
});

test('거부 상세 — 출처 IP·엔드포인트·사유를 남기고 토큰 값은 남기지 않는다', () => {
  const prev = config.collector.token;
  config.collector.token = 'central-secret-token';
  _resetCollectorDenyStats();
  try {
    // ① 헤더 없음  ② 값 불일치(같은 IP)  ③ 다른 IP
    callRoute('get', '/ping', mkReq({}, '10.0.0.9'));
    callRoute('get', '/ping', mkReq({ 'X-Collector-Token': 'WRONG-VALUE-1234' }, '10.0.0.9'));
    callRoute('get', '/ping', mkReq({ 'X-Collector-Token': 'WRONG-VALUE-1234' }, '10.0.0.77'));

    const d = getCollectorDenyStats();
    assert.equal(d.count, 3);
    assert.equal(d.recent.length, 3);
    assert.equal(d.recent[0].ip, '10.0.0.77');                 // 최신이 앞
    assert.equal(d.recent[0].endpoint, 'ping');
    assert.match(d.recent[2].why, /헤더 없음/);                 // 가장 오래된 = 첫 요청
    assert.match(d.recent[0].why, /불일치/);

    // 출처별 집계 — 어느 IP 가 몇 번 두드렸는지가 조치의 근거다.
    const bySrc = Object.fromEntries(d.bySrc.map((s) => [s.ip, s.count]));
    assert.deepEqual(bySrc, { '10.0.0.9': 2, '10.0.0.77': 1 });

    // 토큰 값은 어디에도 없다 — 지문(앞 4글자)과 길이만.
    const dump = JSON.stringify(d);
    assert.ok(!dump.includes('WRONG-VALUE-1234'), '요청 토큰 원본이 실렸다');
    assert.ok(!dump.includes('central-secret-token'), '엣지 토큰이 실렸다');
    assert.match(d.recent[0].fp, /^sha256:[0-9a-f]{8}\(len=16\)$/);   // 값이 아니라 해시 지문
    assert.equal(d.recent[0].tokenLen, 16);
    // 같은 토큰이면 지문이 같고, 다른 토큰이면 다르다(구분 가능하되 복원 불가).
    assert.equal(d.recent[0].fp, d.recent[1].fp);
  } finally { config.collector.token = prev; _resetCollectorDenyStats(); }
});

test('COLLECTOR_TOKEN 미설정이면 사유가 그렇게 기록된다(해결 절차가 다르다)', () => {
  const prev = config.collector.token;
  config.collector.token = '';
  _resetCollectorDenyStats();
  try {
    callRoute('get', '/ping', mkReq({ 'X-Collector-Token': 'anything' }));
    const d = getCollectorDenyStats();
    assert.equal(d.count, 1);
    assert.match(d.recent[0].why, /COLLECTOR_TOKEN 미설정/);
  } finally { config.collector.token = prev; _resetCollectorDenyStats(); }
});

test('거부 내역은 상한이 있다(고RTT 회선에서 export 본문이 커지지 않게)', () => {
  const prev = config.collector.token;
  config.collector.token = 'tok';
  _resetCollectorDenyStats();
  try {
    for (let i = 0; i < 60; i++) callRoute('get', '/ping', mkReq({}, `10.0.1.${i}`));
    const d = getCollectorDenyStats();
    assert.equal(d.count, 60);          // 집계는 전부
    assert.equal(d.recent.length, 20);  // 목록은 최근 20건
    assert.ok(d.bySrc.length <= 12);
  } finally { config.collector.token = prev; _resetCollectorDenyStats(); }
});

test('AGENT_NAME 충돌 — 양쪽 hostname/peer 를 남긴다(v2.436 은 hostname 만)', () => {
  _resetForTest();
  noteAgentIdentity('hd', { hostname: 'hd-edge', peer: '192.168.79.221' });
  noteAgentIdentity('hd', { hostname: 'hd-irs-edge', peer: '192.168.79.10' });
  const s = agentIdentitySummary();
  const a = s.byAgent.hd;
  assert.equal(a.hostname, 'hd-irs-edge');
  assert.equal(a.peer, '192.168.79.10');
  assert.equal(a.conflict.hostname, 'hd-edge');
  assert.equal(a.conflict.peer, '192.168.79.221');   // ← 새로 추가된 근거
  assert.equal(a.seen, 2);
  assert.ok(a.conflict.prevAt > 0);
  _resetForTest();
});

test('vCenter id 충돌 — 양쪽 엣지의 hostname/peer 가 목록에 들어간다', () => {
  _resetForTest();
  noteVcenterOwner('vc-ap-seoul', 'hd', { peer: '1.1.1.1', hostname: 'hd-edge' });
  noteVcenterOwner('vc-ap-seoul', 'hd-irs', { peer: '2.2.2.2', hostname: 'hd-irs-edge' });
  const [c] = agentIdentitySummary().vcenterConflicts;
  assert.equal(c.vcenterId, 'vc-ap-seoul');
  assert.equal(c.agent, 'hd-irs');
  assert.equal(c.peer, '2.2.2.2');
  assert.equal(c.other, 'hd');
  assert.equal(c.otherPeer, '1.1.1.1');
  assert.equal(c.otherHostname, 'hd-edge');
  _resetForTest();
});

test('충돌이 없으면 목록이 비어 있다(오탐 금지)', () => {
  _resetForTest();
  noteAgentIdentity('gm2', { hostname: 'gm2-edge', peer: '1.1.1.1' });
  noteAgentIdentity('gm2', { hostname: 'gm2-edge', peer: '1.1.1.1' });
  noteVcenterOwner('vc-1', 'gm2', { peer: '1.1.1.1' });
  noteVcenterOwner('vc-1', 'gm2', { peer: '1.1.1.1' });
  const s = agentIdentitySummary();
  assert.equal(s.byAgent.gm2.conflict, null);
  assert.deepEqual(s.vcenterConflicts, []);
  _resetForTest();
});
