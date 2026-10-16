/**
 * audit2742k.test.js — v2.742 감사 수정 그룹 GI2(스토리지 REST 인증 판정 · Isilon SSH 명령 순서 · PDU 세션 예산) 회귀.
 *
 *  · DEV-03    스토리지 REST 수집기 약 25곳이 `/401/.test(e.message)` 로 '자격증명 거부인가' 를 판정했다. 오류 문구에는 장비 주소
 *              (`<host>:<port>`)·응답 본문 앞 200자·SID 가 그대로 실리므로, 호스트명·본문·SID 속 '401' 이 섹션 오류 하나로 그 주기
 *              수집 전체를 실패시키고 후보 경로 폴백(tryAny·tryPaths)도 멈췄다. 판정은 getter 가 싣는 표지(authFailed·status)를
 *              보는 `restCommon.isCredReject` 하나다. 실제 수집기를 가짜 fetch 로 돌려 '섹션만 실패·폴백 진행' 과
 *              '진짜 401 은 즉시 중단(계정 잠금 예방)' 을 둘 다 고정한다.
 *  · RECENT-04 Isilon SSH 의 부가 명령 순서 — 버전·계정 조회가 정확 용량 통계보다 앞이라, 둘이 느리면 예산이 바닥나 용량이
 *              '반올림 표기' 로 떨어졌다. 가짜 SSH 서버로 실제 수집기를 돌려 통계가 먼저 실행되는지 고정한다.
 *  · DEV-05    PDU(APC SSH) 수집에 세션 예산이 없어 느린 명령 두 개면 장비 시한(90초)에 걸려 이미 읽은 전력·센서까지 버려졌다.
 *              가짜 SSH 서버로 실제 수집기·연결 테스트를 돌리고, 기본값 산수(예산 < 장비 시한)를 깨끗한 환경으로 고정한다.
 *
 * ⚠ 환경 변수(SSH 명령 시한 1초)는 모듈 로드 시 굳으므로 **프로젝트 모듈은 전부 아래에서 동적 import** 한다.
 *   기본값 산수는 이 축척의 영향을 받지 않게 **깨끗한 환경의 자식 프로세스**로 실제 모듈을 읽어 확인한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742k-'));
process.env.CONFIG_DIR = TMP;
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SSH_EXEC_TIMEOUT_MS = '1000';    // SSH exec 기본 시한 60초 → 1초로 축척
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const SRC = new URL('../src/', import.meta.url);
const require = createRequire(import.meta.url);
const ssh2 = require('ssh2');
// ⚠ ssh2 의 ed25519 생성기는 자기 파서가 거부하는 키를 0.5% 만든다(v2.590 릴리스 CI 사고) — EC SEC1 PEM 을 쓴다.
const HOST_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });

/* ═══════════════════════════════ 공용: 가짜 fetch · 가짜 SSH ═══════════════════════════════ */

/**
 * globalThis.fetch 를 경로 라우터로 바꾼다. route(path, init) → { status, body } | Error(던짐) | undefined(404).
 * 수집기는 전역 fetch 를 호출 시점에 찾으므로(restCommon fetchOrExplain · isilon get) 그대로 가로챈다.
 */
function stubFetch(route) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    calls.push({ path: p, method: init.method || 'GET', host: u.hostname });
    const r = route(p, init);
    if (r instanceof Error) throw r;
    const { status = 404, body = { error: 'not found' } } = r || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
/** undici 가 연결 실패 때 던지는 모양(TypeError('fetch failed') + cause.code). */
const transportError = (code, host) => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} ${host}`), { code }) });

/** 명령별로 응답하거나(문자열) 응답하지 않는(null) 가짜 SSH 서버. */
async function fakeSsh(respond) {
  const seen = [];
  const srv = new ssh2.Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const ch = acc(); const cmd = info.command; seen.push(cmd);
        const out = respond(cmd);
        if (out == null) return; // 장비가 느린 명령 — 응답하지 않는다(클라이언트 시한까지 매달린다)
        ch.write(out); ch.exit(0); ch.end();
      });
    }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(() => r())) };
}

/* ═══════════════════════ DEV-03 — 자격증명 거부 판정은 문구가 아니라 표지다 ═══════════════════════ */

test('DEV-03 ① isCredReject — 표지·접두만 자격증명 거부다(주소·본문·SID 속 401 은 아니다)', async () => {
  const rc = await import(new URL('storage/collectors/restCommon.js', SRC));
  // 거부
  assert.equal(rc.isCredReject(rc.credRejectError()), true);
  assert.equal(rc.isCredReject(Object.assign(new Error('x'), { status: 401 })), true);
  assert.equal(rc.isCredReject(Object.assign(new Error('x'), { authFailed: true })), true);
  assert.equal(rc.isCredReject(new Error('인증 실패(401) — 계정/비밀번호 확인')), true, '표지 없는 옛 오류도 접두가 같으면 거부');
  // 거부 아님 — 예전 `/401/` 은 전부 참이었다
  for (const msg of [
    'vmax-401.corp:8443 응답이 없습니다(30초 초과) — 방화벽·ACL 차단이거나 장비 관리 서비스가 응답하지 않는 상태입니다',
    'HTTP 500 — Symmetrix 000197601401 is not local to this Unisphere',
    'HTTP 404 — resource /api/types/pool_401 not found',
    'unity-401.lab:443 연결이 거부됐습니다',
    'HTTP 403 — forbidden',
  ]) assert.equal(rc.isCredReject(new Error(msg)), false, msg);
  assert.equal(rc.isCredReject(null), false);
  assert.equal(rc.isCredReject('인증 실패(401)'), false, '문자열은 오류 객체가 아니다');
});

test('DEV-03 ② tryAny — 본문·주소의 401 은 다음 후보로 넘어가고, 진짜 401 은 즉시 던진다', async () => {
  const { tryAny, credRejectError } = await import(new URL('storage/collectors/restCommon.js', SRC));
  for (const msg of [
    'vmax-401.corp:8443 응답이 없습니다(30초 초과)',
    'HTTP 500 — Symmetrix 000197601401 is not local to this Unisphere',
    'HTTP 404 — resource /api/types/pool_401 not found',
  ]) {
    const r = await tryAny(async (p) => { if (p === '/a') throw new Error(msg); return { path: p }; }, ['/a', '/b']);
    assert.equal(r.path, '/b', `폴백이 이어져야 한다: ${msg}`);
  }
  let calls = 0;
  await assert.rejects(tryAny(async () => { calls++; throw credRejectError(); }, ['/a', '/b', '/c']), (e) => e.authFailed === true && e.status === 401);
  assert.equal(calls, 1, '401 뒤에는 다음 후보를 시도하지 않는다(계정 잠금 예방)');
});

test('DEV-03 ③ makeGetter·makeRawGetter·makePoster — 401 은 표지를 싣고, 401 이 든 HTTP 500 본문은 싣지 않는다', async () => {
  const rc = await import(new URL('storage/collectors/restCommon.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  const f = stubFetch((p) => (p === '/deny' ? { status: 401, body: '' } : { status: 500, body: { message: 'device SN 000197601401 busy' } }));
  try {
    const dev = { host: 'array-401.corp', username: 'u', password: 'pw' };
    const getters = [
      (p) => rc.makeGetter(dev)(p),
      (p) => rc.makeRawGetter(dev)(p),
      (p) => rc.makePoster(dev)(p, {}),
    ];
    for (const g of getters) {
      const deny = await g('/deny').then(() => null, (e) => e);
      assert.ok(deny, '401 은 던져야 한다');
      assert.equal(deny.authFailed, true); assert.equal(deny.status, 401);
      assert.equal(rc.isCredReject(deny), true);
      // 주기 수집 정지 판정(authGuard)도 그대로 인증 실패로 본다 — 문구는 바뀌지 않았다
      assert.equal(isAuthFailure({ ok: false, error: deny.message, sections: {} }), true);
      const busy = await g('/busy').then(() => null, (e) => e);
      assert.match(busy.message, /^HTTP 500 — .*000197601401/);
      assert.equal(rc.isCredReject(busy), false, 'SID 속 401 은 자격증명 거부가 아니다');
    }
  } finally { f.restore(); }
});

test('DEV-03 ④ Unity REST — 본문의 401 이 든 섹션 오류는 그 섹션만 실패이고 수집은 이어진다 / 진짜 401 은 1회로 끝난다', async () => {
  const unity = await import(new URL('storage/collectors/unity.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  const route = (p) => {
    if (p.startsWith('/api/types/system/')) return { status: 200, body: { entries: [{ content: { name: 'u-401', model: 'Unity 480', serialNumber: 'CKM00184401401' } }] } };
    if (p.startsWith('/api/types/installedSoftwareVersion/')) return { status: 500, body: { error: { messages: [{ 'en-US': 'x' }] }, message: 'internal error for CKM00184401401' } };
    if (p.startsWith('/api/types/systemCapacity/')) return { status: 200, body: { entries: [{ content: { sizeTotal: 1_000_000_000_000, sizeUsed: 400_000_000_000 } }] } };
    return { status: 200, body: { entries: [] } };
  };
  let f = stubFetch(route);
  try {
    const out = await unity.collect({ id: 'u1', type: 'unity480', name: 'u1', host: 'unity-401.corp', username: 'admin', password: 'pw' });
    assert.ok(!out.error, `수집 전체가 실패하면 안 된다: ${out.error}`);
    assert.equal(out.capacity?.totalBytes, 1_000_000_000_000, '용량 섹션까지 이어서 읽어야 한다');
    assert.ok(f.calls.some((c) => c.path.startsWith('/api/types/systemCapacity/')));
    assert.equal(isAuthFailure(out), false);
  } finally { f.restore(); }
  f = stubFetch(() => ({ status: 401, body: '' }));
  try {
    const out = await unity.collect({ id: 'u2', type: 'unity480', name: 'u2', host: 'unity-2.corp', username: 'admin', password: 'bad' });
    assert.equal(f.calls.length, 1, '자격증명 거부면 다음 섹션을 시도하지 않는다(계정 잠금 예방)');
    assert.equal(isAuthFailure(out), true);
  } finally { f.restore(); }
});

test('DEV-03 ⑤ Isilon REST — 호스트명에 401 이 든 전송 오류는 나머지 섹션을 계속 시도한다 / 진짜 401 은 config 1회로 끝난다', async () => {
  const isi = await import(new URL('storage/collectors/isilon.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  const dev = { id: 'i1', type: 'isilon', name: 'i1', host: 'isi-401.corp', username: 'root', password: 'pw', collectMethod: 'api' };
  let f = stubFetch((p) => {
    if (p === '/platform/1/cluster/config') return transportError('ECONNRESET', 'isi-401.corp');
    if (p.startsWith('/platform/1/statistics/current?key=ifs.bytes.total')) {
      return { status: 200, body: { stats: [{ key: 'ifs.bytes.total', value: 1000, devid: 0 }, { key: 'ifs.bytes.used', value: 400, devid: 0 }] } };
    }
    return { status: 404, body: { message: 'nope' } };
  });
  try {
    const out = await isi.collect(dev);
    assert.match(String(out.sections.config), /^오류: .*isi-401\.corp/, 'config 섹션은 실패로 남는다');
    assert.ok(f.calls.some((c) => c.path.startsWith('/platform/1/statistics/current?key=ifs.bytes.total')), '용량 통계를 시도해야 한다');
    assert.ok(f.calls.length > 3, `나머지 섹션을 시도해야 한다(${f.calls.length}회)`);
    assert.equal(isAuthFailure(out), false);
  } finally { f.restore(); }
  f = stubFetch(() => ({ status: 401, body: '' }));
  try {
    const out = await isi.collect({ ...dev, id: 'i2', host: 'isi-2.corp' });
    assert.equal(f.calls.length, 1, '자격증명 거부면 config 한 번으로 끝난다');
    assert.equal(isAuthFailure(out), true);
  } finally { f.restore(); }
});

test('DEV-03 ⑥ XtremIO — v3 목록이 본문에 401 을 담은 404 면 v2 후보로 · 컨트롤러 섹션의 401 본문은 그 섹션만 실패', async () => {
  const x = await import(new URL('storage/collectors/xtremio.js', SRC));
  const f = stubFetch((p) => {
    if (p === '/api/json/v3/types/clusters') return { status: 404, body: { message: 'type not found (XMS build 4401)' } };
    if (p === '/api/json/v2/types/clusters') return { status: 200, body: { clusters: [{ name: 'xc1' }] } };
    if (p.startsWith('/api/json/v2/types/clusters?name=')) return { status: 200, body: { content: { name: 'xc1', 'ud-ssd-space': '1000', 'ud-ssd-space-in-use': '100' } } };
    if (p.includes('/types/storage-controllers')) return { status: 500, body: { message: 'controller X1-SC401 is down' } };
    if (p.includes('/types/user-accounts')) return { status: 200, body: { 'user-accounts': [{ name: 'admin', role: 'admin' }] } };
    return { status: 404, body: { message: 'nope' } };
  });
  try {
    const out = await x.collect({ id: 'x1', type: 'xtremio', name: 'x1', host: 'xms.corp', username: 'admin', password: 'pw' });
    assert.ok(!out.error, `수집 전체가 실패하면 안 된다: ${out.error}`);
    assert.ok(f.calls.some((c) => c.path === '/api/json/v2/types/clusters'), 'v2 후보를 시도해야 한다');
    assert.equal(out.name, 'xc1');
    assert.match(String(out.sections.nodes), /^오류: .*X1-SC401/, '컨트롤러 섹션만 실패로 남는다');
    assert.ok(f.calls.some((c) => c.path.includes('/types/user-accounts')), '다음 섹션(계정)까지 이어서 읽어야 한다');
  } finally { f.restore(); }
});

test('DEV-03 ⑦ PowerMax — SID 에 401 이 든 어레이 상세 오류는 다음 버전 경로로 넘어간다', async () => {
  const pm = await import(new URL('storage/collectors/powermax.js', SRC));
  const SID = '000197601401';
  const f = stubFetch((p) => {
    if (p === '/univmax/restapi/version') return { status: 200, body: { supported_api_versions: ['102'] } };
    if (p === '/univmax/restapi/102/system/symmetrix') return { status: 200, body: { symmetrixId: [SID] } };
    if (p === `/univmax/restapi/102/system/symmetrix/${SID}`) return { status: 500, body: { message: `Symmetrix ${SID} is not local to this Unisphere` } };
    if (/^\/univmax\/restapi\/\d+\/system\/symmetrix\/000197601401$/.test(p)) return { status: 200, body: { symmetrixId: SID, model: 'PowerMax_8000', ucode: '6079', local: true } };
    return { status: 404, body: { message: 'nope' } };
  });
  try {
    const out = await pm.collect({ id: 'p1', type: 'powermax', name: 'p1', host: 'u4v.corp', username: 'smc', password: 'pw' });
    assert.ok(!out.error, `수집 전체가 실패하면 안 된다: ${out.error}`);
    const detail = f.calls.filter((c) => c.path.endsWith(`/system/symmetrix/${SID}`));
    assert.ok(detail.length >= 2, `다음 후보 경로를 시도해야 한다(${detail.map((c) => c.path).join(', ')})`);
  } finally { f.restore(); }
});

test('DEV-03 ⑧ PowerStore — 본문의 401 은 섹션만 실패 · 공간 지표의 진짜 401 은 다른 구간·폴백을 시도하지 않고 던진다', async () => {
  const ps = await import(new URL('storage/collectors/powerstore.js', SRC));
  const rc = await import(new URL('storage/collectors/restCommon.js', SRC));
  // (a) fetchSpaceMetrics: POST 401 → 즉시 던진다(구간 3개 × 재시도로 로그인 실패를 쌓지 않는다)
  let posts = 0; let gets = 0;
  await assert.rejects(ps.fetchSpaceMetrics({
    post: async () => { posts++; throw rc.credRejectError(); }, get: async () => { gets++; return []; }, csrf: null, entity: 'space_metrics_by_cluster', entityId: 0,
  }), (e) => rc.isCredReject(e));
  assert.equal(posts, 1, 'POST 401 뒤에 다른 구간을 보내지 않는다');
  assert.equal(gets, 0, '폴백 GET 도 보내지 않는다');
  // (b) POST 는 422(비-401), 폴백 GET 이 401 — 묶음 오류 문구가 'HTTP 422' 로 시작해도 자격증명 거부로 던져야 한다
  await assert.rejects(ps.fetchSpaceMetrics({
    post: async () => { throw new Error('HTTP 422 — invalid interval'); }, get: async () => { throw rc.credRejectError(); }, csrf: null, entity: 'space_metrics_by_cluster', entityId: 0,
  }), (e) => rc.isCredReject(e));
  // (c) collect: 소프트웨어 버전 조회의 HTTP 500 본문에 401 이 있어도 공간 지표까지 이어서 읽는다
  const f = stubFetch((p, init) => {
    if (p.startsWith('/api/rest/cluster?')) return { status: 200, body: [{ id: '0', name: 'ps-401', global_id: 'PS4401401' }] };
    if (p.startsWith('/api/rest/software_installed')) return { status: 500, body: { messages: [{ message_l10n: 'build 4401 query failed' }] } };
    if (p === '/api/rest/metrics/generate' && init.method === 'POST') return { status: 200, body: [{ physical_total: 1_000_000, physical_used: 400_000, timestamp: '2026-10-16T00:00:00Z' }] };
    if (p.startsWith('/api/rest/appliance?')) return { status: 200, body: [] };
    return { status: 200, body: [] };
  });
  try {
    const out = await ps.collect({ id: 'ps1', type: 'powerstore', name: 'ps1', host: 'ps-401.corp', username: 'admin', password: 'pw' });
    assert.ok(!out.error, `수집 전체가 실패하면 안 된다: ${out.error}`);
    assert.ok(f.calls.some((c) => c.path === '/api/rest/metrics/generate'), '공간 지표를 이어서 읽어야 한다');
  } finally { f.restore(); }
});

test('DEV-03 ⑨ VPLEX — v2 오류 본문의 401 을 v2 인증 거부로 읽지 않는다(그것을 인증 실패로 종결하면 주기 수집이 정지된다)', async () => {
  const vp = await import(new URL('storage/collectors/vplex.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  const dev = { id: 'v1', type: 'vplex', name: 'v1', host: 'vplex.corp', username: 'service', password: 'pw' };
  let f = stubFetch((p) => {
    if (p === '/vplex/v2/clusters') return { status: 500, body: { message: 'cluster-401 is offline' } };
    if (p === '/vplex/clusters') return { status: 404, body: { message: 'nope' } };
    return { status: 404, body: { message: 'nope' } };
  });
  try {
    const out = await vp.collect(dev);
    assert.equal(isAuthFailure(out), false, `인증 실패로 종결하면 안 된다: ${out.error}`);
    assert.ok(f.calls.some((c) => c.path.startsWith('/vplex/v2/directors') || c.path.startsWith('/vplex/engines')), '디렉터 섹션까지 이어서 시도해야 한다');
  } finally { f.restore(); }
  // 두 세대 모두 거부(v2 401 · v1 비-401 실패) — 예전처럼 인증 실패로 종결하고 표지를 싣는다
  f = stubFetch((p) => (p === '/vplex/v2/clusters' ? { status: 401, body: '' } : { status: 404, body: { message: 'nope' } }));
  try {
    const out = await vp.collect({ ...dev, id: 'v2' });
    assert.equal(isAuthFailure(out), true);
    assert.equal(f.calls.length, 2, 'v2 1회 + v1 1회로 끝난다(세대별 1회씩 — 잠금 예방 불변조건)');
  } finally { f.restore(); }
});

test('DEV-03 ⑩ 스윕 — 스토리지 REST 수집기에 401 부분 문자열 판정이 남지 않는다(판정은 isCredReject 하나)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  for (const f of ['restCommon.js', 'powermax.js', 'xtremio.js', 'unity.js', 'powerstore.js', 'vplex.js', 'isilon.js']) {
    const s = stripComments(fs.readFileSync(new URL(`storage/collectors/${f}`, SRC), 'utf8'));
    assert.doesNotMatch(s, /\/401\/\.test|\/401\|/, `${f}: 401 부분 문자열 판정이 남아 있다`);
    if (f !== 'restCommon.js') assert.match(s, /isCredReject\(/, `${f}: isCredReject 를 써야 한다`);
  }
});

/* ═══════════════════════ RECENT-04 — Isilon SSH: 정확 용량 통계가 버전·계정보다 먼저 ═══════════════════════ */

const ISI_STATUS = `Cluster Name: isi-demo
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             100.0T (100.0T Raw) 0 (0 Raw)
VHS Size:         0
Used:             40.0T (40%)         0 (n/a)
Avail:            60.0T (60%)         0 (n/a)

                   Health  Throughput (bps)  HDD Storage      SSD Storage
ID |IP Address     |DASR |  In   Out  Total| Used / Size     |Used / Size
---+---------------+-----+-----+-----+-----+-----------------+-----------------
  1|10.0.0.1       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
  2|10.0.0.2       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
`;
const TOTAL = 109_951_162_777_600; const USED = 43_980_465_111_040;

test('RECENT-04 Isilon SSH — 버전·계정 조회가 느려 예산이 모자라도 정확 용량 통계가 먼저 실행된다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const { withDeadline } = await import(new URL('proxy/sshExec.js', SRC));
  // isi status·통계·전원 키는 즉시, 버전·계정·시리얼은 응답하지 않는다(시한까지 매달린다).
  const srv = await fakeSsh((c) => {
    if (c === 'isi status') return ISI_STATUS;
    if (c === isi.ISI_STATS_CMD) return JSON.stringify([{ key: 'ifs.bytes.total', value: TOTAL }, { key: 'ifs.bytes.used', value: USED }]);
    if (c.startsWith('isi statistics list keys')) return '';
    return null;
  });
  try {
    const dev = { id: 'isi-order', type: 'isilon', name: 'isi', host: '127.0.0.1', sshPort: srv.port, username: 'root', password: 'pw' };
    // 축척: exec 시한 1초 · 예산 2초. 예전 순서(버전 1초 → 계정 ~1초)에서는 통계가 예산 밖으로 밀렸다.
    const snap = await withDeadline(6_000, (signal) => isi.collectViaSsh({ ...dev, _signal: signal }, { budgetMs: 2_000 }), '수집 타임아웃');
    assert.equal(snap.ok, true, snap.error);
    const at = (pred) => srv.seen.findIndex(pred);
    const iStats = at((c) => c === isi.ISI_STATS_CMD);
    const iVer = at((c) => c === 'isi version');
    assert.ok(iStats >= 0, `정확 용량 통계를 실행해야 한다: ${srv.seen.join(' | ')}`);
    assert.ok(iVer < 0 || iStats < iVer, `통계가 버전 조회보다 먼저다: ${srv.seen.join(' | ')}`);
    assert.equal(snap.extra.capacityBasis, 'isi statistics (ifs.bytes.*)', '용량은 정확 바이트 기준이어야 한다');
    assert.equal(snap.capacity.totalBytes, TOTAL);
    assert.equal(snap.capacity.usedBytes, USED);
    assert.ok(!(snap.extra.cliSkippedCmds || []).includes(isi.ISI_STATS_CMD.split(/\s+/).slice(0, 3).join(' ')), '통계가 건너뛴 목록에 있으면 안 된다');
  } finally { await srv.close(); }
});

test('RECENT-04 소스 순서 — isi status → 통계 → 전원 → 버전 → 계정 → 시리얼', () => {
  const s = fs.readFileSync(new URL('storage/collectors/isilonSsh.js', SRC), 'utf8');
  const body = s.slice(s.indexOf('export async function collectViaSsh'));
  const pos = [
    "sh.exec('isi status')", 'bsh.exec(ISI_STATS_CMD', 'readIsiPowerSsh(bsh', "bsh.exec('isi version')", "bsh.exec('isi auth users list", 'readIsiHwSsh(bsh',
  ].map((k) => { const i = body.indexOf(k); assert.ok(i >= 0, k); return i; });
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i - 1] < pos[i], `순서가 바뀌었다: ${i}`);
});

/* ═══════════════════════ DEV-05 — PDU(APC SSH) 세션 예산 ═══════════════════════ */

const ABOUT = 'E000: Success\nHardware Factory\n---------------\nModel Number: AP8858\nSerial Number: ZA0000000000\n\nApplication Module\n---------------\nName: rpdu2g\nVersion: v6.9.6\n';

test('DEV-05 ① 느린 명령이 이어져도 장비 시한 안에 끝나고, 이미 읽은 전력을 지킨다(뒤 탐지는 사유와 함께 생략)', async () => {
  const apc = await import(new URL('pdu/collectors/apcSsh.js', SRC));
  const { withDeadline } = await import(new URL('proxy/sshExec.js', SRC));
  // about·유닛 1 전력만 즉시, 나머지(누적 전력량·피상 전력·역률·뱅크·상·센서)는 응답하지 않는다.
  const srv = await fakeSsh((c) => (c === 'about' ? ABOUT : c === 'devReading 1:power' ? 'E000: Success\n1.98 kW\napc>' : null));
  try {
    const dev = { id: 'pdu-budget', name: 'pdu', host: '127.0.0.1', sshPort: srv.port, username: 'apc', password: 'pw' };
    // 축척: exec 시한 1초 · 예산 2초 · 장비 시한 3.5초. 예산이 없으면 응답 없는 명령 4개(4초)에 장비 시한을 넘어 통째로 버려진다.
    const t0 = Date.now();
    const snap = await withDeadline(3_500, (signal) => apc.collect(dev, { signal, budgetMs: 2_000 }), '수집 타임아웃');
    const ms = Date.now() - t0;
    assert.ok(ms < 3_500, `장비 시한 안에 끝나야 한다(${ms}ms)`);
    assert.equal(snap.ok, true, snap.error);
    assert.equal(snap.units.length, 1);
    assert.equal(snap.units[0].powerW, 1980, '이미 읽은 전력을 버리지 않는다');
    assert.equal(snap.model, 'AP8858');
    assert.equal(snap.unitsIncomplete, true, '뒤 유닛은 확인하지 않았다 — 합계가 부분 합임을 밝힌다');
    assert.equal(snap.sensorsIncomplete, true, '센서는 확인하지 않았다 — 미장착이라 단정하지 않는다');
    assert.ok(snap.notes.some((n) => /수집 시간 예산\(2초\)/.test(n)), JSON.stringify(snap.notes));
    assert.ok(!snap.notes.some((n) => /미장착/.test(n)), "'센서 없음' 이라 말하면 안 된다");
    assert.ok(snap.cliSkipped >= 1 && snap.cliBudgetMs === 2_000, JSON.stringify({ s: snap.cliSkipped, b: snap.cliBudgetMs }));
    assert.ok(!snap.notes.some((n) => /`|\*\*/.test(n)), '문구에 백틱·별표 금지');
  } finally { await srv.close(); }
});

test('DEV-05 ② 예산이 접속하자마자 바닥이면 전력을 읽지 않았다고 말한다(계정 권한 탓을 하지 않는다)', async () => {
  const apc = await import(new URL('pdu/collectors/apcSsh.js', SRC));
  const srv = await fakeSsh(() => 'E000: Success\n1.0 kW\napc>');
  try {
    const snap = await apc.collect({ id: 'pdu-zero', name: 'pdu', host: '127.0.0.1', sshPort: srv.port, username: 'apc', password: 'pw' }, { budgetMs: 1 });
    assert.equal(snap.ok, false);
    assert.equal(snap.error, apc.PDU_BUDGET_SKIP_REASON);
    assert.equal(snap.unitsIncomplete, true);
    assert.ok(!snap.notes.some((n) => /계정 권한/.test(n)), JSON.stringify(snap.notes));
    assert.equal(srv.seen.length, 0, '명령을 하나도 시작하지 않는다');
  } finally { await srv.close(); }
});

test('DEV-05 ③ 연결 테스트도 자기 시한보다 작은 예산으로 돈다(읽은 값을 돌려준다)', async () => {
  const poller = await import(new URL('pdu/poller.js', SRC));
  const srv = await fakeSsh((c) => (c === 'about' ? ABOUT : c === 'devReading 1:power' ? 'E000: Success\n1.98 kW\napc>' : null));
  try {
    const t0 = Date.now();
    const r = await poller.testDeviceConnection({ id: 'pdu-test', name: 'pdu', host: '127.0.0.1', sshPort: srv.port, username: 'apc', password: 'pw' }, { timeoutMs: 4_000 });
    assert.ok(Date.now() - t0 < 4_000);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.detected.units[0].powerW, 1980);
  } finally { await srv.close(); }
});

/** 깨끗한 환경(축척 env 없음)의 자식 프로세스에서 실제 모듈의 예산 상수를 읽는다. */
function readPdu(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['SSH_EXEC_TIMEOUT_MS', 'PDU_DEVICE_TIMEOUT_MS', 'PDU_SESSION_BUDGET_MS']) if (!(k in extraEnv)) delete env[k];
  const code = `const a = await import(${JSON.stringify(new URL('pdu/collectors/apcSsh.js', SRC).href)});
const s = await import(${JSON.stringify(new URL('proxy/sshExec.js', SRC).href)});
console.log(JSON.stringify({ exec: s.execTimeoutMs(), dev: a.PDU_DEVICE_TIMEOUT_MS, margin: a.PDU_DEADLINE_MARGIN_MS, budget: a.PDU_SESSION_BUDGET_MS, slice: a.PDU_MIN_SLICE_MS }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).trim().split('\n').pop());
}

test('DEV-05 ④ 기본값 산수 — 세션 예산 < 장비 시한(명령을 늘리기 전에 이 산수를 볼 것)', () => {
  const d = readPdu();
  assert.equal(d.dev, 90_000); assert.equal(d.exec, 60_000);
  assert.equal(d.budget, 75_000);
  assert.equal(d.slice, 5_000);
  assert.ok(d.budget + 10_000 <= d.dev, `예산 ${d.budget} 은 장비 시한 ${d.dev} 보다 여유 있게 작아야 한다`);
  // 응답 없는 명령 하나(exec 60초)가 예산 안이어야 첫 명령의 결과를 버리지 않는다
  assert.ok(d.exec <= d.budget);
  // 어떤 env 조합에서도 예산은 장비 시한보다 작다
  for (const e of [{ PDU_DEVICE_TIMEOUT_MS: '10000' }, { PDU_DEVICE_TIMEOUT_MS: '20000' }, { PDU_SESSION_BUDGET_MS: '999999999' }, { PDU_DEVICE_TIMEOUT_MS: '30000', PDU_SESSION_BUDGET_MS: '600000' }]) {
    const x = readPdu(e);
    assert.ok(x.budget < x.dev, `${JSON.stringify(e)} → 예산 ${x.budget} ≥ 장비 시한 ${x.dev}`);
    assert.ok(x.budget > 0);
  }
  // 장비 시한 식은 예전 폴러 식과 같은 결과다: Math.max(10_000, Number(env) || 90_000)
  for (const v of ['', '0', 'abc', '5000', '-5', '120000']) {
    const want = Math.max(10_000, Number(v) || 90_000);
    assert.equal(readPdu({ PDU_DEVICE_TIMEOUT_MS: v }).dev, want, `PDU_DEVICE_TIMEOUT_MS='${v}'`);
  }
});

test('DEV-05 ⑤ 폴러는 수집기가 소유한 장비 시한을 쓴다(식을 두 곳에 두지 않는다)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const s = stripComments(fs.readFileSync(new URL('pdu/poller.js', SRC), 'utf8'));
  assert.match(s, /DEVICE_TIMEOUT_MS = apcSsh\.PDU_DEVICE_TIMEOUT_MS/);
  assert.doesNotMatch(s, /process\.env\.PDU_DEVICE_TIMEOUT_MS/);
  assert.match(s, /budgetMs: testBudgetMs/, '연결 테스트가 예산을 넘겨야 한다');
});
