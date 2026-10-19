/**
 * v2.744 감사 후속 그룹 FB — 리드 통합 뒤 남은 서버 잔여 넷.
 *
 * FB-1 postNo503Retry 한 벌: 중앙 puller 가 같은 규칙의 GET 판 사본(fetchExportNo503Retry)을 두고 있었다 — 차이는 재시도 로그(onRetry)뿐.
 *      util/postNo503Retry.js 가 onRetry 를 받고(메서드·본문은 init 이 정한다 — GET 가능) puller 는 그것을 쓴다(사본 루프 삭제).
 *      onRetry 를 주지 않는 기존 호출부의 동작은 그대로다(audit2744i ②·audit2742c 가 고정).
 * FB-2 /24 대역 제안의 FQDN 호스트: ipam/scanDatacenter.js suggestAgentSubnets 는 이름이 IP 일 때만 호스트 IP 를 셌다 — 원장(v2.744 VC-01
 *      hostLedgerIp)은 FQDN 호스트의 관리 IP(mgmtIp)를 올리는데 제안은 그 /24 를 'IP 없음' 으로 뺐다. 판정은 원장 함수를 **주입**받는다
 *      (scanDatacenter → ledger 를 직접 import 하면 ledger → scanDatacenterSource → scanDatacenter 와 순환 — arch2579 SCC 상한).
 * FB-3 설정 소유자 표시: v2.744 AUTHZ-02 로 requireSettingsOwner 는 소유자 + 전체 범위만 통과한다. /auth/me·로그인 응답이 그 판정
 *      (settingsOwnerTier)을 싣고, 세션 보안 조회도 범위 계정 소유자 경고(ownerWarnings)를 싣는다. isSettingsOwner(설정 메뉴 노출)의 뜻은
 *      그대로다 — 웹이 그 값 하나로 설정 탭 전체를 숨긴다(범위 계정이 쓰는 설정 화면까지 사라지지 않게).
 * FB-4 큰 본문 세션 풀: mock 데모 계정(요청 문맥 admin + demoGuest)은 로그 분석 붙여넣기·svcmon 가져오기에서 403(denyDemoGuest)인데,
 *      본문 파서 단계의 bigJsonGate 가 role 만 보고 슬롯을 내줘 최대 16MB 를 해석한 뒤에야 403 이었다(hostmap/parse 는 데모에도 열린
 *      읽기성 POST 라 예전처럼 통과).
 *
 * 실제 함수·실제 라우터(authRouter·adminRouter)·실제 resolveTokenUser 를 부른다. 시각에 기대는 단언은 없다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
// 임시 폴더 기준: 환경변수(리드·그룹이 지정) → 없으면 OS 임시 폴더. 저장소 안에 만들지 않는다.
const TMP_ROOT = process.env.AUDIT2744L_TMP && fs.existsSync(process.env.AUDIT2744L_TMP) ? process.env.AUDIT2744L_TMP : os.tmpdir();
const CFG = fs.mkdtempSync(path.join(TMP_ROOT, 'dvc-2744l-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'z'.repeat(48), OTP_ROLE_ENFORCE: 'false',
  SETTINGS_OWNERS: 'sadm,fadm', IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});

const closers = [];
test.after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* 정리는 best-effort */ } }
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ }
});

/* ═══════════════ FB-1 — postNo503Retry 한 벌 ═══════════════ */

async function fakeServer() {
  const hits = { p502: 0, p503: 0, get: 0, method: null };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const k = req.url.slice(1);
      if (k === 'get') { hits.get += 1; hits.method = req.method; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      hits[k] = (hits[k] || 0) + 1;
      res.writeHead(k === 'p503' ? 503 : 502, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return { base: `http://127.0.0.1:${srv.address().port}`, hits };
}

test('FB-1 ① onRetry — 다시 보내기 직전에만 부른다(502 는 2번 · 503·마지막 시도는 부르지 않는다) · 콜백이 던져도 재시도는 그대로', async () => {
  const u = await import('../src/util/postNo503Retry.js');
  const { base, hits } = await fakeServer();
  const calls = [];
  const r1 = await u.postNo503Retry(`${base}/p502`, { method: 'POST', body: 'x', timeoutMs: 5000 }, { backoffMs: 5, onRetry: (i) => calls.push(i) });
  assert.equal(r1.status, 502);
  assert.equal(hits.p502, 3, '502 는 예전처럼 호출 안에서 재시도(기본 2회)');
  assert.deepEqual(calls, [{ attempt: 1, status: 502 }, { attempt: 2, status: 502 }], `수정 전: onRetry 를 받지 않았다 — ${JSON.stringify(calls)}`);
  const c503 = [];
  const r2 = await u.postNo503Retry(`${base}/p503`, { method: 'POST', body: 'x', timeoutMs: 5000 }, { backoffMs: 5, onRetry: (i) => c503.push(i) });
  assert.equal(r2.status, 503);
  assert.equal(hits.p503, 1, '503 은 다시 보내지 않는다');
  assert.deepEqual(c503, [], '503 에는 재시도 로그가 없다');
  hits.p502 = 0;
  const r3 = await u.postNo503Retry(`${base}/p502`, { method: 'POST', body: 'x', timeoutMs: 5000 }, { backoffMs: 5, onRetry: () => { throw new Error('log-sink-down'); } });
  assert.equal(r3.status, 502);
  assert.equal(hits.p502, 3, '로그 콜백 오류가 재시도를 막지 않는다');
});

test('FB-1 ② GET 판 — 메서드·본문이 없는 호출은 GET · fetchNo503Retry 는 같은 함수 · 연결 오류 재시도도 onRetry 로 알린다', async () => {
  const u = await import('../src/util/postNo503Retry.js');
  assert.equal(u.fetchNo503Retry, u.postNo503Retry, '두 이름은 한 함수다(규칙이 두 벌이 되지 않게)');
  const { base, hits } = await fakeServer();
  const r = await u.fetchNo503Retry(`${base}/get`, { headers: { Accept: 'application/json' }, timeoutMs: 5000 });
  assert.equal(r.status, 200);
  assert.equal(hits.method, 'GET');
  // 닫힌 포트 — ECONNREFUSED(일시 오류) 는 재시도하고 그 사실을 onRetry 로 남긴다.
  const tmp = http.createServer(); await new Promise((ok) => tmp.listen(0, '127.0.0.1', ok));
  const dead = tmp.address().port; await new Promise((ok) => tmp.close(ok));
  const errs = [];
  await assert.rejects(u.fetchNo503Retry(`http://127.0.0.1:${dead}/x`, { timeoutMs: 3000 }, { backoffMs: 5, onRetry: (i) => errs.push(i) }));
  assert.equal(errs.length, 2, `연결 오류 재시도 2회가 로그로 남는다 — ${JSON.stringify(errs)}`);
  assert.ok(errs.every((e, i) => e.attempt === i + 1 && typeof e.error === 'string' && e.error.length > 0));
});

test('FB-1 ③ puller 는 사본 루프를 두지 않고 util 함수를 쓴다(재시도 규칙 한 벌)', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, 'collector/puller.js'), 'utf8'));
  assert.match(code, /from '\.\.\/util\/postNo503Retry\.js'/, 'puller 는 util/postNo503Retry.js 에서 가져온다');
  assert.match(code, /fetchNo503Retry\(/);
  assert.doesNotMatch(code, /RETRYABLE_STATUS|retryDelayMs|abortableSleep|for \(let attempt/, '재시도 루프 사본이 남아 있다');
  assert.doesNotMatch(code, /fetchExportNo503Retry/);
  // 재시도 로그 문장은 여전히 puller 가 만든다(로그 분석 규칙 collector-pull-retry — audit2744c ⑥ 이 동작으로 고정).
  assert.match(code, /onRetry: \(i\) => console\.warn\(`\[collector\] \$\{c\.id\} 재시도 \$\{i\.attempt\}/);
});

/* ═══════════════ FB-2 — /24 제안의 FQDN 호스트 ═══════════════ */

test('FB-2 ① 원장 판정(hostLedgerIp)을 넘기면 FQDN 호스트의 관리 IP /24 도 제안한다 · 비정규 관리 IP 는 쓰지 않는다 · 개수와 규칙을 밝힌다', async () => {
  const { suggestAgentSubnets } = await import('../src/ipam/scanDatacenter.js');
  const { hostLedgerIp } = await import('../src/ipam/ledger.js');
  const hosts = [
    { vcenterId: 'vc-a', name: 'esx01.corp.local', mgmtIp: '10.5.6.7' },   // FQDN + 관리 IP — 수정 전에는 'IP 없음'
    { vcenterId: 'vc-a', name: '10.5.6.8' },                               // 이름이 IP — 예전 그대로
    { vcenterId: 'vc-a', name: 'esx02.corp.local' },                       // 관리 IP 없음 — 뺀다
    { vcenterId: 'vc-a', name: 'esx03.corp.local', mgmtIp: '010.5.6.9' },  // 비정규 표기(8진 오해석 위험) — 원장도 쓰지 않는다
    { vcenterId: 'vc-other', name: 'esx09.corp.local', mgmtIp: '10.9.9.9' }, // 다른 에이전트의 vCenter — 대상 밖
  ];
  const r = suggestAgentSubnets({ vcenterIds: ['vc-a'], vcName: { 'vc-a': 'VC-A' }, vms: [], hosts, idrac: [], hostIp: hostLedgerIp });
  assert.deepEqual(r.subnets.map((x) => `${x.cidr}:${x.ips}:${x.vcenterIps}`), ['10.5.6.0/24:2:2'], JSON.stringify(r.subnets));
  assert.equal(r.totals.hostIps, 2);
  assert.equal(r.totals.hostMgmtIps, 1, '관리 IP 로 센 호스트 수');
  assert.deepEqual(r.skipped, { hostsNoIp: 2, idracNoIp: 0 });
  assert.equal(r.hostIpRule, 'name-or-mgmt');
  // 원장과 같은 판정인지 — 제안이 센 호스트 IP 는 hostLedgerIp 가 원장에 올리는 IP 와 같다.
  const ledgerIps = hosts.filter((h) => h.vcenterId === 'vc-a').map((h) => hostLedgerIp(h)?.ip).filter(Boolean).sort();
  assert.deepEqual(ledgerIps, ['10.5.6.7', '10.5.6.8']);
});

test('FB-2 ② 판정을 주지 않으면 예전 규칙(이름이 IP 일 때만) — hostIpRule 이 그 사실을 말한다 · 모듈은 ledger.js 를 import 하지 않는다(순환 금지)', async () => {
  const { suggestAgentSubnets } = await import('../src/ipam/scanDatacenter.js');
  const r = suggestAgentSubnets({ vcenterIds: ['vc-a'], hosts: [{ vcenterId: 'vc-a', name: 'esx01.corp.local', mgmtIp: '10.5.6.7' }, { vcenterId: 'vc-a', name: '10.5.6.8' }] });
  assert.equal(r.hostIpRule, 'name-only');
  assert.deepEqual(r.skipped, { hostsNoIp: 1, idracNoIp: 0 });
  assert.equal(r.totals.hostMgmtIps, 0);
  // 판정 함수가 던지면 그 호스트만 'IP 없음' 이다(전체 제안이 실패하지 않는다).
  const r2 = suggestAgentSubnets({ vcenterIds: ['vc-a'], hosts: [{ vcenterId: 'vc-a', name: 'x' }, { vcenterId: 'vc-a', name: 'y', mgmtIp: '10.1.1.1' }], hostIp: (h) => { if (h.name === 'x') throw new Error('bad'); return { ip: h.mgmtIp }; } });
  assert.equal(r2.skipped.hostsNoIp, 1);
  assert.equal(r2.totals.hostIps, 1);
  const imps = [...stripComments(fs.readFileSync(path.join(SRC, 'ipam/scanDatacenter.js'), 'utf8')).matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imps, ['../util/ipv4.js'], `scanDatacenter.js 는 순수 모듈로 남는다(ledger.js import 금지 — 순환): ${imps.join(', ')}`);
});

test('FB-2 ③ 화면 문구 — 관리 IP 로 센 호스트와 뺀 호스트를 나눠 말한다 · 구버전 응답(규칙 없음)은 예전 문구', async () => {
  const w = await import(pathToFileURL(path.resolve(HERE, '../../web/src/views/tools/ipScanDcText.js')).href);
  const now = w.suggestSummaryText({ totals: { subnets: 1, vmIps: 0, hostIps: 2, hostMgmtIps: 1, idracIps: 0 }, skipped: { hostsNoIp: 2 }, hostIpRule: 'name-or-mgmt', omitted: 0, subnets: [] });
  assert.match(now, /이름으로 등록된 ESXi 호스트 1대는 관리 IP\(첫 VMkernel 포트의 IPv4\)로 셌습니다/);
  assert.match(now, /이름으로 등록된 ESXi 호스트 2대는 관리 IP 도 수집되지 않아 뺐습니다/);
  const old = w.suggestSummaryText({ totals: { subnets: 1, vmIps: 0, hostIps: 1, idracIps: 0 }, skipped: { hostsNoIp: 1 }, omitted: 0, subnets: [] });
  assert.match(old, /이름으로 등록된 ESXi 호스트 1대는 주소를 몰라 뺐습니다/);
  assert.doesNotMatch(old, /관리 IP/);
});

/* ═══════════════ FB-3 · FB-4 — 실제 라우터 · 실제 resolveTokenUser ═══════════════ */

const auth = await import('../src/auth/auth.js');
const { store } = await import('../src/store.js');
await store.refresh();
const mk = (u) => auth.createUser(u, { trusted: true });
mk({ username: 'sadm', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-us-east'] } }); // 범위 관리자 + 소유자(SETTINGS_OWNERS)
mk({ username: 'fadm', role: 'admin', password: 'Passw0rd!long1' });                                       // 전체 범위 소유자
mk({ username: 'nadm', role: 'admin', password: 'Passw0rd!long1' });                                       // 전체 범위 admin(소유자 아님)
const tok = (name) => {
  const u = auth.getUser(name); const sid = `sid-${name}`; const exp = Math.floor(Date.now() / 1000) + 3600;
  const t = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
  auth.noteIssuedSession({ sub: name, sid, exp });
  return t;
};
const TOK = { sadm: tok('sadm'), fadm: tok('fadm'), nadm: tok('nadm'), demo: tok(auth.DEMO_USERNAME) };

async function app() {
  const express = (await import('express')).default;
  const { authRouter } = await import('../src/routes/auth.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const a = express(); a.use(express.json({ limit: '1mb' }));
  a.use('/api/auth', authRouter);
  a.use('/api/admin', auth.authMiddleware, auth.requireEnrolled, adminRouter);
  a.use((err, _req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
  const srv = await new Promise((ok) => { const s = a.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(() => ok()); }));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (who, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(who ? { authorization: `Bearer ${TOK[who]}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { json = null; }
    return { st: r.status, json };
  };
}
const call = await app();

test('FB-3 ① /auth/me — settingsOwnerTier 는 소유자 등급 라우트의 실제 판정과 같다 · isSettingsOwner(설정 메뉴 노출)는 뜻이 그대로다', async () => {
  for (const [who, owner, tier] of [['sadm', true, false], ['fadm', true, true], ['nadm', false, false]]) {
    const me = await call(who, 'GET', '/api/auth/me');
    assert.equal(me.st, 200, `${who} /auth/me ${me.st}`);
    assert.equal(me.json.user.isSettingsOwner, owner, `${who} isSettingsOwner(설정 메뉴 노출 — 소유자 목록 기준)`);
    assert.equal(me.json.user.settingsOwnerTier, tier, `${who} settingsOwnerTier — 수정 전: 필드가 없어 화면이 범위 소유자에게 소유자 등급 화면을 그대로 보였다`);
    const gate = await call(who, 'GET', '/api/admin/security/session');
    assert.equal(gate.st === 200, tier, `${who}: 화면 판정(settingsOwnerTier)과 서버 게이트(requireSettingsOwner)가 어긋난다 — ${gate.st}`);
  }
});

test('FB-3 ② 로그인 응답도 같은 판정(ownerFields 한 곳) — 범위 소유자는 isSettingsOwner true · settingsOwnerTier false', async () => {
  const r = await call(null, 'POST', '/api/auth/login', { username: 'sadm', password: 'Passw0rd!long1' });
  assert.equal(r.st, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.isSettingsOwner, true);
  assert.equal(r.json.user.settingsOwnerTier, false);
  const f = await call(null, 'POST', '/api/auth/login', { username: 'fadm', password: 'Passw0rd!long1' });
  assert.equal(f.st, 200, JSON.stringify(f.json));
  assert.equal(f.json.user.settingsOwnerTier, true);
  const code = stripComments(fs.readFileSync(path.join(SRC, 'routes/auth.js'), 'utf8'));
  assert.equal((code.match(/owners\.includes\(/g) || []).length, 1, '소유자 판정은 ownerFields 한 곳(로그인·/auth/me 두 벌 금지)');
});

test('FB-3 ③ 세션 보안 조회도 범위 계정 소유자 경고를 싣는다(저장 응답과 같은 함수) · 범위 계정이 없으면 필드를 싣지 않는다', async () => {
  const sec = await import('../src/security/securitySettings.js');
  sec.saveSessionSecurity({ settingsOwners: ['fadm', 'sadm'] });
  const g = await call('fadm', 'GET', '/api/admin/security/session');
  assert.equal(g.st, 200);
  assert.deepEqual((g.json.ownerWarnings || []).map((w) => w.username), ['sadm'], `수정 전: 조회 응답에는 경고가 없었다 — ${JSON.stringify(g.json.ownerWarnings)}`);
  assert.match(g.json.ownerWarnings[0].reason, /전체 범위/);
  sec.saveSessionSecurity({ settingsOwners: ['fadm'] });
  const g2 = await call('fadm', 'GET', '/api/admin/security/session');
  assert.equal(g2.st, 200);
  assert.ok(!('ownerWarnings' in g2.json), '범위 계정 소유자가 없으면 싣지 않는다');
});

test('FB-4 데모 계정은 403 을 받을 세션 큰 본문 경로에서 슬롯을 잡지 않는다 — 세 경로 각각 denyDemoGuest 판정과 같다', async () => {
  const { bigJsonGate, sessionBigBodyAllowed } = await import('../src/util/bigJsonGate.js');
  const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
  const { rolePermissionSet } = await import('../src/auth/permissions.js');
  const { scopedVcenterIds } = await import('../src/auth/scope.js');
  const demo = auth.resolveTokenUser(TOK.demo);
  assert.equal(demo?.demoGuest, true, '전제: mock 모드의 데모 계정 요청 문맥');
  assert.equal(demo.role, 'admin', '전제: 요청 문맥 role 은 admin(그래서 예전 판정이 통과시켰다)');
  const PATHS = ['/api/admin/log-analysis/paste', '/api/svcmon/targets/import', '/api/svcmon/targets/hostmap/parse'];
  const deps = { permsOf: rolePermissionSet, scoped: (x) => !!scopedVcenterIds(x, store.get()) };
  const routeAllowsDemo = Object.fromEntries(PATHS.map((p) => [p, demoGuestDenial('POST', p) == null]));
  // 전제(현재 정책): 로그 분석·svcmon 가져오기는 데모 계정에 403 · hostmap/parse 는 읽기성 POST 라 열려 있다.
  assert.deepEqual(routeAllowsDemo, { [PATHS[0]]: false, [PATHS[1]]: false, [PATHS[2]]: true }, JSON.stringify(routeAllowsDemo));
  for (const p of PATHS) {
    assert.equal(sessionBigBodyAllowed(demo, p, deps), routeAllowsDemo[p], `${p}: 큰 본문 슬롯 판정이 라우트의 데모 판정과 다르다(수정 전 언제나 true)`);
    assert.equal(sessionBigBodyAllowed(auth.resolveTokenUser(TOK.fadm), p, deps), true, `${p}: 전체 범위 admin 은 예전처럼 통과`);
  }
  // index.js 와 같은 배선으로 실제 게이트 — 데모 토큰은 큰 파서를 타지 않는다(본문을 읽지 않고 next).
  let parsed = 0;
  const gate = bigJsonGate((_q, _s, next) => { parsed += 1; next(); }, {
    central: () => false,
    session: (req) => auth.resolveTokenUser(String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '')) || false,
    sessionAllowed: (_req, u, full) => sessionBigBodyAllowed(u, full, deps),
  });
  const fakeReq = (t) => ({ baseUrl: '/api/admin/log-analysis/paste', path: '/', ip: '127.0.0.1', complete: true, get: (h) => ({ authorization: `Bearer ${t}`, 'content-length': '2000000' })[String(h).toLowerCase()] || '', once() {} });
  const fakeRes = () => ({ once() {}, set() { return this; }, status() { return this; }, json() { return this; } });
  let nexted = 0;
  gate(fakeReq(TOK.demo), fakeRes(), () => { nexted += 1; });
  assert.equal(parsed, 0, '데모 토큰 — 큰 파서를 타지 않는다(수정 전 1)');
  assert.equal(nexted, 1, '그냥 다음으로 넘긴다(전역 1MB 파서가 413 · 라우트가 403)');
  gate(fakeReq(TOK.fadm), fakeRes(), () => {});
  assert.equal(parsed, 1, '전체 범위 admin — 예전처럼 큰 파서');
});
