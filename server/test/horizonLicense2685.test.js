// v2.685 — 사용자 신고: 등록 후 연결 테스트가 '라이선스 조회 실패 (HTTP 404)' 한 줄만 말했다.
// 로그인은 성공했는데 이 서버에 라이선스 경로만 없는 경우를 실패와 구분하고, 다른 API 응답·버전을 함께 싣는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hzlic-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';
const hz = await import('../src/horizon/horizon.js');

function fake(routes) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const h = routes[`${req.method} ${req.url}`];
      if (!h) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(h[0], { 'Content-Type': 'application/json' }); res.end(JSON.stringify(h[1]));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}
const LOGIN = { 'POST /rest/login': [200, { access_token: 't', refresh_token: 'r' }], 'POST /rest/logout': [200, {}] };

test('로그인 성공 + 라이선스 404 → ok·licenses null·버전·다른 API 응답', async () => {
  const f = await fake({ ...LOGIN, 'GET /rest/monitor/v1/connection-servers': [200, [{ name: 'cs1', details: { version: '8.6.0' } }]] });
  try {
    const r = await hz.testHorizon({ host: `${f.url}/`, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, true); assert.equal(r.loginOk, true); assert.equal(r.licenses, null);
    // v2.686: 같은 로그인으로 버전을 읽었으면 '주소·계정 문제가 아니다' 를 말하고 UAG 조치를 내지 않는다.
    assert.equal(r.licenseStatus, 404); assert.match(r.licenseError, /8\.6\.0/); assert.doesNotMatch(r.licenseError, /UAG/);
    assert.equal(r.csVersion, '8.6.0'); assert.deepEqual(r.probe, { path: '/rest/monitor/v1/connection-servers', status: 200 });
    assert.ok(f.seen.includes('POST /rest/login'), '끝 슬래시를 정리해 //rest/login 이 되지 않는다');
  } finally { f.srv.close(); }
});

test('라이선스가 있으면 예전과 같다', async () => {
  const f = await fake({ ...LOGIN, 'GET /rest/config/v1/licenses': [200, [{ license_edition: 'Enterprise', expiration_time: 1900000000000 }]] });
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, true); assert.equal(r.licenses, 1); assert.equal(r.first, 'Enterprise');
  } finally { f.srv.close(); }
});

test('로그인 실패는 여전히 실패', async () => {
  const f = await fake({ 'POST /rest/login': [401, {}] });
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, false); assert.match(r.reason, /로그인 실패 \(HTTP 401\)/);
  } finally { f.srv.close(); }
});

test('주기 조회의 404 문구도 로그인 성공을 말한다', () => {
  assert.match(hz.licenseFailText(404), /로그인은 성공/);
  assert.match(hz.licenseFailText(403), /권한/);
});

test('주소 정규화 — IP 만 넣어도 https:// · 경로 제거 · http 는 존중', () => {
  const n = hz.normalizeHorizonHost;
  assert.equal(n('10.1.2.3'), 'https://10.1.2.3');
  assert.equal(n(' cs.example.com:8443/admin/ '), 'https://cs.example.com:8443');
  assert.equal(n('https://cs/rest/login?x=1'), 'https://cs');
  assert.equal(n('http://10.0.0.5/'), 'http://10.0.0.5');
  assert.equal(n('HTTPS://CS.Example.com'), 'https://cs.example.com');
  assert.equal(n('ftp://x'), 'ftp://x', '모르는 스킴은 바꾸지 않는다 — 검증이 거부한다');
  assert.equal(n(''), '');
});

test('저장: IP 만 넣어도 등록되고, 같은 주소의 다른 표기로 다시 저장해도 비밀번호를 버리지 않는다', () => {
  const r1 = hz.upsertHorizon({ id: 'hz1', host: '10.20.30.40', username: 'svc', password: 'pw', domain: 'corp' });
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(hz.loadHorizon().find((s) => s.id === 'hz1').host, 'https://10.20.30.40');
  const r2 = hz.upsertHorizon({ id: 'hz1', host: 'https://10.20.30.40/admin/', username: 'svc', password: '', domain: 'corp' });
  assert.equal(r2.ok, true, r2.reason);
  assert.equal((r2.droppedSecrets || []).length, 0);
  assert.equal(hz.loadHorizon().find((s) => s.id === 'hz1').password, 'pw');
  const r3 = hz.upsertHorizon({ id: 'hz1', host: '10.20.30.41', username: 'svc', password: '', domain: 'corp' });
  // 주소가 바뀌면 여전히 비밀번호를 승계하지 않는다(보안 규칙 — 저장은 되고 폐기 사실을 알린다).
  assert.deepEqual(r3.droppedSecrets, ['password']);
  assert.equal(hz.loadHorizon().find((s) => s.id === 'hz1').password || '', '');
  assert.equal(hz.horizonInputIssue({ id: 'hz2', host: 'ftp://x', username: 'u', password: 'p', domain: 'd' }) != null, true);
});
