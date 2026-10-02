// v2.686 — 사용자 신고(스크린샷 + 사용자 curl, 실장비 Connection Server 7.13.1).
//  · 연결 테스트가 라이선스 경로 하나만 보고 "실시간 사용자·앱별 사용 수집은 동작할 수 있습니다" 라고 말했는데
//    그 서버의 세션 경로는 404 였다 → 같은 로그인으로 기능별 경로를 실제로 조회한다(featureProbe.js).
//  · 버전(7.13.1)을 읽어 놓고 "UAG·로드밸런서인지 확인" 을 안내했다 → 버전을 읽었으면 그 조치를 내지 않는다.
//  · 세션 404 서버에 주기마다 AD 로그인을 반복했다 → 주기 수집만 쉰다(실제 로그인 횟수로 고정).
//  · 로그인 뒤 403 을 '자격증명 거부' 로 세어 주기 수집을 멈췄다 → 'forbidden'(역할 권한).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hz2686-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.HZSESS_FIRST_DELAY_MS = '3600000';
process.env.DATA_SOURCE = 'live';   // mock 이면 세션 폴러가 접속하지 않는다(⑫)
const hz = await import('../src/horizon/horizon.js');
const fp = await import('../src/horizon/featureProbe.js');
const { SESSION_PATH } = await import('../src/horizon/sessions.js');
const { CATALOG_PATHS } = await import('../src/horizon/appUsage.js');
const { collectServerSessions } = await import('../src/horizon/sessionCollect.js');

/** 가짜 커넥션 서버. routes 키는 'METHOD 경로'(쿼리 제외). 값은 [status, body, contentType?] 또는 함수. */
function fake(routes) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    seen.push(`${req.method} ${p}`);
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const h = routes[`${req.method} ${p}`];
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error_message":"not found"}'); }
      const [st, b, ct = 'application/json'] = typeof h === 'function' ? h(req) : h;
      res.writeHead(st, { 'Content-Type': ct }); res.end(typeof b === 'string' ? b : JSON.stringify(b));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}`, logins: () => seen.filter((x) => x === 'POST /rest/login').length })));
}
const LOGIN = { 'POST /rest/login': [200, { access_token: 't', refresh_token: 'r' }], 'POST /rest/logout': [200, {}] };
/** 사용자 curl 로 확인한 7.13.1 의 응답 그대로(인증된 요청). */
const REAL_7131 = {
  ...LOGIN,
  'GET /rest/monitor/connection-servers': [200, [{ name: 'cs1', version: '7.13.1' }]],
  'GET /rest/inventory/v1/desktop-pools': [200, [{ id: 'p1', name: 'Pool1' }]],
  'GET /rest/inventory/v1/farms': [200, [{ id: 'f1', name: 'Farm1' }]],
};

test('① 실장비 7.13.1: 기능별로 실제 조회해 무엇이 되고 안 되는지 돌려준다(새 로그인 없이)', async () => {
  const f = await fake(REAL_7131);
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, true); assert.equal(r.loginOk, true);
    assert.equal(r.features.license.kind, 'not-found');
    assert.equal(r.features.sessions.kind, 'not-found', '세션 404 를 확인해야 "동작할 수 있습니다" 를 말하지 않는다');
    assert.equal(r.features.apps.kind, 'not-found');
    assert.equal(r.features.desktops.kind, 'ok');
    assert.equal(r.features.farms.kind, 'ok');
    assert.equal(r.csVersion, '7.13.1');
    assert.deepEqual(r.versionProbe.attempts.map((a) => [a.path, a.status]), [['/rest/monitor/v1/connection-servers', 404], ['/rest/monitor/connection-servers', 200]],
      '시도한 경로는 전부 남는다(마지막만 보고하면 앞 경로의 결과가 가려진다)');
    assert.equal(f.logins(), 1, '기능별 확인은 같은 로그인 안에서 한다');
    for (let i = 0; i < 50 && !f.seen.includes('POST /rest/logout'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(f.seen.includes('POST /rest/logout'), '로그아웃한다(세션 누수 금지 — 베스트에포트라 응답 뒤에 도착한다)');
    assert.ok(r.loginMs <= r.ms, '로그인 시간은 전체 시간보다 작다(뒤 조회를 합치지 않는다)');
    assert.doesNotMatch(r.licenseError, /UAG|로드밸런서|2006/, '버전을 읽었으면 UAG 조치·근거 없는 최소 버전을 말하지 않는다');
    assert.match(r.licenseError, /7\.13\.1/);
  } finally { f.srv.close(); }
});

test('② 성공은 2xx 가 아니라 2xx + JSON 이다 — 200 HTML 은 형식 미인식(사용자 브라우저 실측: 무인증 요청은 없는 경로에도 200 HTML)', async () => {
  const f = await fake({ ...REAL_7131, 'GET /rest/inventory/v1/sessions': [200, '<html><body>Horizon</body></html>', 'text/html'] });
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.features.sessions.kind, 'unparsed');
    assert.equal(r.features.sessions.status, 200);
  } finally { f.srv.close(); }
});

test('③ 로그인 2xx 인데 토큰이 없으면 "로그인 성공" 이라 말하지 않는다', async () => {
  const f = await fake({ 'POST /rest/login': [200, '<html>portal</html>', 'text/html'] });
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, false);
    assert.equal(r.loginOk, null, '자격증명 거부가 아니라 판정 불가');
    assert.match(r.reason, /토큰이 없습니다/);
  } finally { f.srv.close(); }
});

test('④ 로그인 404 는 "로그인 API 가 없다" 를 말한다', async () => {
  const f = await fake({});
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    assert.equal(r.ok, false); assert.match(r.reason, /\/rest\/login/);
  } finally { f.srv.close(); }
});

test('⑤ 한 조회의 예외가 결과를 지우지 않는다 — 시도 결과로 남기고 다음 후보로 가지 않는다', async () => {
  const calls = [];
  const get = async (p) => { calls.push(p); if (p.includes('v1/desktop')) throw new Error('The operation was aborted due to timeout'); return { ok: false, status: 404, body: null }; };
  const r = await fp.probePaths(get, CATALOG_PATHS.desktop, { expect: 'array' });
  assert.equal(r.kind, 'timeout');
  assert.equal(calls.length, 1, '404 일 때만 다음 후보로 넘어간다(fetchCatalog 와 같은 규칙)');
  const r2 = await fp.probePaths(async () => ({ ok: false, status: 404 }), CATALOG_PATHS.farm, {});
  assert.equal(r2.kind, 'not-found'); assert.equal(r2.attempts.length, CATALOG_PATHS.farm.length);
});

test('⑥ 버전 판정 — 팟이면 등록 주소와 맞는 항목, 빌드 번호를 메이저로 읽지 않는다', () => {
  const pod = [{ name: 'cs-a.corp', version: '8.6.0' }, { name: 'cs-b.corp', version: '7.13.1' }];
  assert.equal(fp.csVersionInfo(pod, 'https://cs-b.corp').version, '7.13.1');
  assert.equal(fp.csVersionInfo(pod, 'https://cs-b.corp').matched, true);
  assert.deepEqual(fp.csVersionInfo(pod, 'https://10.0.0.9').versions, ['8.6.0', '7.13.1'], '못 맞추면 서로 다른 버전을 함께 밝힌다');
  assert.equal(fp.versionMajor('7.13.1'), 7);
  assert.equal(fp.versionMajor('19053418'), null);
  assert.equal(fp.csVersionOf([{ details: { version: '8.6.0' } }]), '8.6.0', '옛 호출부 호환');
});

test('⑦ 라이선스 404 문구 — 버전을 읽었을 때와 못 읽었을 때가 다르다(근거 없는 최소 버전 금지)', () => {
  const withV = fp.licenseFailText(404, { versionRead: true, version: '7.13.1' });
  assert.match(withV, /7\.13\.1/); assert.doesNotMatch(withV, /UAG|2006/);
  const noV = fp.licenseFailText(404);
  assert.match(noV, /로그인은 성공/); assert.match(noV, /UAG/); assert.doesNotMatch(noV, /2006/);
  assert.equal(hz.licenseFailText, fp.licenseFailText, '옛 export 이름은 재수출 — 두 벌이 아니다');
});

test('⑧ 기능 경로는 실제 수집기 상수를 그대로 쓴다(복제하면 테스트가 확인한 경로와 수집 경로가 갈라진다)', () => {
  const by = Object.fromEntries(fp.FEATURES.map((x) => [x.key, x.paths]));
  assert.deepEqual([...by.sessions], [SESSION_PATH]);
  assert.equal(by.apps, CATALOG_PATHS.app); assert.equal(by.desktops, CATALOG_PATHS.desktop); assert.equal(by.farms, CATALOG_PATHS.farm);
});

test('⑨ 판정 종류는 웹 문구와 1:1 이다', async () => {
  const web = await import('../../web/src/views/horizonAdminText.js');
  assert.deepEqual(Object.keys(web.FEATURE_KIND_TEXT).sort(), [...fp.PROBE_KINDS].sort());
  assert.deepEqual([...web.FEATURE_ORDER], fp.FEATURES.map((x) => x.key));
});

test('⑩ 대량 연결 테스트 요약도 기능별 결과를 말한다(예전: 초록 "로그인 성공" 만)', async () => {
  const f = await fake(REAL_7131);
  try {
    const r = await hz.testHorizon({ host: f.url, username: 'u', password: 'p', domain: 'd' });
    const s = fp.featureSummary(r);
    assert.match(s, /커넥션 서버 7\.13\.1/);
    assert.match(s, /실시간 사용자\(세션\) 이 서버에 없음\(404\)/);
    assert.match(s, /데스크톱 풀 됨/);
    assert.doesNotMatch(s, /`|\*\*/);
  } finally { f.srv.close(); }
});

test('⑪ 세션 수집 분류 — 로그인 단계 401/403 만 auth · 로그인 뒤 403 은 forbidden · 로그인 404 · 토큰 없음', async () => {
  const SRV = (url) => ({ id: 'hzX', host: url, username: 'u', password: 'p', domain: 'd' });
  const cases = [
    [{ 'POST /rest/login': [403, {}] }, 'auth'],
    [{ ...LOGIN, 'GET /rest/inventory/v1/sessions': [403, {}] }, 'forbidden'],
    [{}, 'no-login-endpoint'],
    [{ 'POST /rest/login': [200, {}] }, 'no-token'],
    [REAL_7131, 'no-endpoint'],
  ];
  for (const [routes, kind] of cases) {
    const f = await fake(routes);
    try {
      const r = await collectServerSessions(SRV(f.url), { catalog: false });
      assert.equal(r.kind, kind, JSON.stringify(Object.keys(routes)));
      assert.equal(r.users, null, '실패 주기의 수치는 null');
    } finally { f.srv.close(); }
  }
});

test('⑫ 세션 404 서버에는 주기마다 다시 로그인하지 않는다 — 수동 실행·등록 변경은 즉시 다시 확인', async () => {
  const settings = await import('../src/horizon/sessionSettings.js');
  const poller = await import('../src/horizon/sessionPoller.js');
  const f = await fake(REAL_7131);
  try {
    assert.equal(hz.upsertHorizon({ id: 'hz7', name: 'OC2', host: f.url, username: 'svc', password: 'pw', domain: 'dvc' }).ok, true);
    settings.save({ enabled: true });
    poller._resetHzNoEndpoint();
    const r1 = await poller.runHzSessionsNow('timer');
    assert.equal(f.logins(), 1, '첫 주기는 확인한다');
    assert.equal(r1.serversFailed, 1, '세션 404 는 그 서버의 실패로 센다(전 서버 실패면 실행 결과도 ok:false — 기존 계약)');
    const r2 = await poller.runHzSessionsNow('timer');
    assert.equal(f.logins(), 1, '세션 404 를 확인한 서버에 다음 주기 로그인을 하지 않는다');
    assert.ok(poller.noEndpointBackoffFor(hz.loadHorizon().find((s) => s.id === 'hz7')), '쉬는 중이라는 기록이 있다');
    assert.ok((r2.errors || []).some((e) => /다시 확인합니다/.test(e.error)), '조용히 멈추지 않는다 — 다음 확인 시각을 말한다');
    await poller.runHzSessionsNow('manual');
    assert.equal(f.logins(), 2, '수동 실행은 막지 않는다');
    assert.equal(hz.upsertHorizon({ id: 'hz7', name: 'OC2', host: f.url, username: 'svc2', password: 'pw2', domain: 'dvc' }).ok, true);
    await poller.runHzSessionsNow('timer');
    assert.equal(f.logins(), 3, '계정이 바뀌면 즉시 다시 확인한다');
  } finally { f.srv.close(); poller._resetHzNoEndpoint(); }
});

test('⑬ 라이선스 만료 도구: 404 서버는 길게 기억하고(화면 열 때마다 로그인 반복 금지) 버전을 근거로 말한다', async () => {
  const f = await fake(REAL_7131);
  try {
    hz.upsertHorizon({ id: 'hz7', name: 'OC2', host: f.url, username: 'svc', password: 'pw', domain: 'dvc' });
    for (const s of hz.loadHorizon()) if (s.id !== 'hz7') hz.removeHorizon(s.id);
    const before = f.logins();
    const a = await hz.collectHorizonLicenses({ force: true });
    assert.equal(a.errors[0].kind, 'unsupported');
    assert.equal(a.errors[0].csVersion, '7.13.1');
    assert.doesNotMatch(a.errors[0].reason, /UAG/);
    await hz.collectHorizonLicenses();
    assert.equal(f.logins() - before, 1, '캐시 기간 안에는 다시 로그인하지 않는다');
    assert.ok(hz._horizonLicenseCacheEntry('hz7').ttl >= 3_600_000, '라이선스 API 가 없는 서버는 10분이 아니라 시간 단위로 기억한다');
  } finally { f.srv.close(); }
});

test('⑭ 실패 중 이어 보여 주는 직전 라이선스 행은 낡았다는 표지·마지막 성공 시각을 함께 든다(HZ-10)', async () => {
  let fail = false;
  const f = await fake({ ...LOGIN, 'GET /rest/config/v1/licenses': () => (fail ? [500, {}] : [200, [{ license_edition: 'Enterprise', expiration_time: 1900000000000 }]]) });
  try {
    hz.upsertHorizon({ id: 'hz7', name: 'OC2', host: f.url, username: 'svc', password: 'pw', domain: 'dvc' });
    const a = await hz.collectHorizonLicenses({ force: true });
    assert.equal(a.rows.length, 1); assert.equal(a.rows[0].stale, false);
    fail = true;
    const b = await hz.collectHorizonLicenses({ force: true });
    assert.equal(b.rows.length, 1, '실패해도 직전 행은 남긴다(만료일이 사라지면 더 나쁘다)');
    assert.equal(b.rows[0].stale, true);
    assert.equal(b.errors[0].carried, 1);
    assert.ok(b.errors[0].lastOkAt > 0, '마지막 성공 시각을 함께 준다');
  } finally { f.srv.close(); }
});

test('⑮ 대량 연결 테스트 경로는 단건과 같은 기능별 요약(featureSummary)을 쓴다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/horizonAssign.js', import.meta.url), 'utf8'));
  assert.match(src, /summary:\s*featureSummary\(r\)\s*\|\|/, '대량 결과표가 라이선스 404·세션 404 를 숨기지 않게');
  assert.match(src, /import\s*\{[^}]*\bfeatureSummary\b[^}]*\}\s*from\s*'\.\.\/\.\.\/horizon\/horizon\.js'/);
});
