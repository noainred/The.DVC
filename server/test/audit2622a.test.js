// v2.622 감사 그룹 A — iDRAC 세션 폴백·Sensors absent 캐시·OME 전력 신선도.
//   LEFT-01: 세션 단계 비-401 실패(POST 503·타임아웃, 토큰 GET 타임아웃)가 Basic 401 로 바뀌어 authGuard 가 멀쩡한 서버를 멈추던 것
//   LEFT-02: Sensors GET 의 일시 오류(503)를 'Sensors 컬렉션 없음' 으로 6시간 캐시하던 것
//   DATA-01: OME 전력이 신선도 컷·비활성 판정 없이 '현재 전력' 에 합산되던 것
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2622a-'));
process.env.CONFIG_DIR = TMP;
process.env.IDRAC_TIMEOUT_MS = '800';

let redfish; let service; let omeCache;
before(async () => {
  redfish = await import('../src/idrac/redfish.js');
  omeCache = await import('../src/idrac/omeCache.js');
  service = await import('../src/idrac/service.js');
});
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/** 가짜 Redfish(Basic 은 항상 401 — 세션 토큰 전용 iDRAC). mode 로 세션 단계 동작을 바꾼다. */
function sessionOnlyServer(mode) {
  const timers = new Set();
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/redfish/v1/SessionService/Sessions') {
      if (mode === 'sess503') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"max sessions"}'); }
      if (mode === 'sess401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad creds"}'); }
      if (mode === 'sessHang') { return; }   // 응답하지 않음 → 요청 시한 초과
      res.writeHead(201, { 'x-auth-token': `tok-${mode}`, location: '/redfish/v1/SessionService/Sessions/1' }); return res.end();
    }
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.headers['x-auth-token'] === `tok-${mode}`) {
      if (mode === 'slowget') return;   // 토큰 GET 이 시한을 넘긴다
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"Members":[]}');
    }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"basic disabled"}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    close: () => { for (const t of timers) clearTimeout(t); srv.closeAllConnections?.(); srv.close(); },
  })));
}

async function powerOutcome(mode, user) {
  const s = await sessionOnlyServer(mode);
  try {
    const r = await redfish.fetchPower({ host: s.base, username: user, password: 'pw' });
    return { ok: true, r };
  } catch (e) {
    return { ok: false, authFailed: e.authFailed === true, status: e.status, message: e.message };
  } finally { s.close(); }
}

test('LEFT-01 세션 POST 503 은 자격증명 거부(authFailed·401)가 아니다', async () => {
  const o = await powerOutcome('sess503', 'u503');
  assert.equal(o.ok, false);
  assert.equal(o.authFailed, false);
  assert.notEqual(o.status, 401);
  assert.doesNotMatch(o.message, /\b401\b|인증 실패/);
});

test('LEFT-01 세션 POST 시한 초과는 자격증명 거부가 아니다', async () => {
  const o = await powerOutcome('sessHang', 'uhang');
  assert.equal(o.ok, false);
  assert.equal(o.authFailed, false);
  assert.notEqual(o.status, 401);
});

test('LEFT-01 세션 생성 뒤 토큰 GET 시한 초과는 자격증명 거부가 아니다', async () => {
  const o = await powerOutcome('slowget', 'uslow');
  assert.equal(o.ok, false);
  assert.equal(o.authFailed, false);
  assert.notEqual(o.status, 401);
});

test('LEFT-01 양성: 세션 POST 명시적 401 은 여전히 인증 실패', async () => {
  const o = await powerOutcome('sess401', 'u401');
  assert.equal(o.ok, false);
  assert.equal(o.authFailed, true);
  assert.equal(o.status, 401);
});

test('LEFT-01 정상: 세션 토큰 경로 성공', async () => {
  const s = await sessionOnlyServer('ok');
  try {
    const base = s.base;
    // fetchPower 는 Chassis 를 따라가므로 여기서는 '던지지 않음 또는 비-인증 오류' 만 본다 — 토큰 GET 이 200 이다.
    let err = null;
    try { await redfish.fetchPower({ host: base, username: 'uok', password: 'pw' }); } catch (e) { err = e; }
    assert.ok(!err || err.authFailed !== true);
  } finally { s.close(); }
});

test('LEFT-02 Sensors 503 은 absent 로 캐시하지 않고 다음 호출이 다시 묻는다', async () => {
  let sensorsCalls = 0;
  const srv = http.createServer((req, res) => {
    const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/redfish/v1/Chassis') return j(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] });
    if (req.url === '/redfish/v1/Chassis/System.Embedded.1/Sensors') {
      sensorsCalls += 1;
      if (sensorsCalls === 1) return j(503, { error: 'busy' });
      return j(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1/Sensors/SystemBoardCPUUsage' }] });
    }
    if (req.url.endsWith('/SystemBoardCPUUsage')) return j(200, { Reading: 42 });
    j(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    redfish._resetSensorPathsForTest();
    const e = { host: `http://127.0.0.1:${srv.address().port}`, username: 'root', password: 'pw' };
    const a = await redfish.fetchUsageSensors(e);
    assert.equal(a.kind, 'unreachable');
    assert.notEqual(a.kind, 'absent');
    const b = await redfish.fetchUsageSensors(e);
    assert.equal(sensorsCalls, 2, '두 번째 호출은 Sensors 를 다시 묻는다');
    assert.notEqual(b.kind, 'absent');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('LEFT-02 양성: Sensors 404 는 여전히 absent', async () => {
  let sensorsCalls = 0;
  const srv = http.createServer((req, res) => {
    const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/redfish/v1/Chassis') return j(200, { Members: [{ '@odata.id': '/redfish/v1/Chassis/C1' }] });
    if (req.url === '/redfish/v1/Chassis/C1/Sensors') { sensorsCalls += 1; return j(404, {}); }
    j(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    redfish._resetSensorPathsForTest();
    const e = { host: `http://127.0.0.1:${srv.address().port}`, username: 'root', password: 'pw' };
    const a = await redfish.fetchUsageSensors(e);
    assert.equal(a.kind, 'absent');
    await redfish.fetchUsageSensors(e);
    assert.equal(sensorsCalls, 1, 'absent 는 캐시된다');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('DATA-01 OME 전력: 오래된 캐시·비활성 연결은 현재 전력에서 빠진다', async () => {
  fs.writeFileSync(path.join(TMP, 'idrac.json'), JSON.stringify({ servers: [
    { id: 'ome-on', type: 'ome', host: 'https://10.0.0.1', username: 'u', password: 'p', enabled: true },
    { id: 'ome-off', type: 'ome', host: 'https://10.0.0.2', username: 'u', password: 'p', enabled: false },
  ] }));
  const now = Date.now();
  // 경계(POWER_STALE_MS 2시간)에서 멀리 떨어뜨린다: 72시간 전 / 1분 전.
  omeCache.setOmeDevices('ome-on', [{ serviceTag: 'STALE1', name: 'srv-stale', watts: 500 }], { at: now - 72 * 3_600_000 });
  omeCache.setOmeDevices('ome-off', [{ serviceTag: 'OFF1', name: 'srv-off', watts: 300 }], { at: now - 60_000 });
  omeCache.setOmeDevices('ome-fresh', [{ serviceTag: 'FRESH1', name: 'srv-fresh', watts: 200 }], { at: now - 60_000 });
  const list = await service.allMeasuredPower();
  const ome = list.filter((e) => e.source === 'ome').map((e) => e.serviceTag).sort();
  assert.deepEqual(ome, ['FRESH1']);
});
