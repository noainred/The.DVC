/**
 * 2026-10-09 검토 S-09(그룹 J) — 중앙 ↔ 엣지 전송 보호: '원격 URL 은 HTTPS 가 기본, 평문 HTTP 는 승인된 예외만'.
 *
 *  ① 판정(transportPolicy): 스킴 없는 주소 → https · 루프백 http 허용 · 기존 항목 같은 URL 유지 · 관리자 예외(사유 필수) ·
 *     운영자 허용 목록(COLLECTOR_HTTP_ALLOW — 비정규 IPv4 표기는 맞지 않는다) · URL 이 바뀌면 예외 비승계 · 자기등록은 예외를 못 만든다
 *  ② 실제 저장 경로(collector/registry.js) — 직접 호출 · 자기등록 upsert(https → http 하향 거부 포함) · 거부 기록
 *  ③ 실제 admin 라우터(registerCollectorsDc) — POST/PUT/CSV 가져오기 · 감사 로그 · GET 의 전송 상태
 *  ④ resilientFetch — 사설 CA(WAN_TLS_CA_FILE) 신뢰 · 다른 CA 거부 · https→http 하향 리다이렉트 거부(토큰 비유출) ·
 *     교차 출처 https 리다이렉트에서 토큰 헤더 제거
 *  ⑤ HTTPS 리스너(util/httpsServer.js) — 실제 https 서버 + 실제 SSH 게이트웨이 WS 업그레이드 · 설정 오류 fail-closed ·
 *     HTTP 동시 리스닝 · 인증서 재로드 · 개인키 권한 경고 · 광고 scheme
 *  ⑥ 배포 대상 대조(collectorSync) — TLS 기록 없으면 https 를 지어내지 않고, 평문 행을 드러낸다
 *
 * 인증서는 테스트 안에서 openssl 로 임시 디렉터리에 만든다(기존 테스트 audit2602d·audit2604c 와 같은 방식). 없으면 ④⑤ 를 건너뛴다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rvJ-s09-'));
const CFG = path.join(DIR, 'cfg'); fs.mkdirSync(CFG);
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.COLLECTOR_HTTP_ALLOW;
delete process.env.WAN_TLS_INSECURE;

/* ── 테스트 인증서(CA 두 개 + 서버 인증서 셋) ───────────────────────────────────────────── */
function ssl(args) { execFileSync('openssl', args, { cwd: DIR, stdio: 'pipe' }); }
function makeCa(name) {
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', `/CN=rvJ ${name}`, '-keyout', `${name}.key`, '-out', `${name}.pem`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
}
function makeLeaf(name, ca) {
  fs.writeFileSync(path.join(DIR, `${name}.ext`), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  ssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=localhost',
    '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-days', '2',
    '-out', `${name}.pem`, '-extfile', `${name}.ext`]);
  fs.chmodSync(path.join(DIR, `${name}.key`), 0o600);
}
let PKI = null;
try {
  makeCa('ca1'); makeCa('ca2');
  makeLeaf('srv1', 'ca1'); makeLeaf('srv1b', 'ca1'); makeLeaf('srv2', 'ca2');
  const f = (n) => path.join(DIR, n);
  PKI = { ca1: f('ca1.pem'), ca2: f('ca2.pem'), srv1: { cert: f('srv1.pem'), key: f('srv1.key') }, srv1b: { cert: f('srv1b.pem'), key: f('srv1b.key') }, srv2: { cert: f('srv2.pem'), key: f('srv2.key') } };
  process.env.WAN_TLS_CA_FILE = PKI.ca1; // ⚠ resilientFetch 를 import 하기 전에 — 모듈 로드 때 읽는다
} catch { PKI = null; }
const tlsOpts = (leaf) => ({ cert: fs.readFileSync(leaf.cert), key: fs.readFileSync(leaf.key) });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const close = (srv) => new Promise((r) => srv.close(() => r()));
const readAudit = () => { try { return fs.readFileSync(path.join(CFG, 'audit.ndjson'), 'utf8'); } catch { return ''; } };

/* ── ① 판정 ─────────────────────────────────────────────────────────────────────── */
test('① withDefaultScheme · 루프백 · urlTransport', async () => {
  const tp = await import('../src/collector/transportPolicy.js');
  assert.equal(tp.withDefaultScheme('10.0.0.5:4000'), 'https://10.0.0.5:4000', '스킴 없는 주소의 기본은 https');
  assert.equal(tp.withDefaultScheme('HTTP://10.0.0.5:4000'), 'http://10.0.0.5:4000', '스킴 대소문자 정리');
  assert.equal(tp.withDefaultScheme('https://e'), 'https://e');
  assert.equal(tp.withDefaultScheme('ftp://e'), 'ftp://e', '다른 스킴은 형식 검사가 거부하게 그대로');
  for (const h of ['127.0.0.1', '127.9.9.9', '::1', '[::1]', 'localhost', 'a.localhost']) assert.equal(tp.isLoopbackHost(h), true, h);
  for (const h of ['10.0.0.1', '0127.0.0.1', '128.0.0.1', 'example.com', '']) assert.equal(tp.isLoopbackHost(h), false, h);
  assert.deepEqual(
    [tp.urlTransport('http://10.1.1.1:4000').insecure, tp.urlTransport('https://10.1.1.1').insecure, tp.urlTransport('http://127.0.0.1:4000').insecure],
    [true, false, false]);
});

test('① 운영자 허용 목록: CIDR·IP·호스트·* — 비정규 IPv4 표기는 맞지 않는다, 틀린 항목은 버리지 않고 센다', async () => {
  const tp = await import('../src/collector/transportPolicy.js');
  const env = { COLLECTOR_HTTP_ALLOW: '10.20.0.0/16, edge-gm1.corp.local , 192.168.1.5, bad host, 300.1.1.1/8' };
  const p = tp.parseHttpAllowlist(env);
  assert.deepEqual(p.rules.map((r) => r.text), ['10.20.0.0/16', 'edge-gm1.corp.local', '192.168.1.5']);
  assert.deepEqual(p.invalid, ['bad host', '300.1.1.1/8']);
  assert.equal(tp.allowlistMatch('http://10.20.3.4:4000', env), '10.20.0.0/16');
  assert.equal(tp.allowlistMatch('http://010.20.3.4:4000', env), null, 'URL 파서가 8진수로 읽어 8.20.3.4 가 된다(실제 접속과 같은 해석) — 10.20/16 이 아니다');
  assert.equal(tp.allowlistMatch('http://EDGE-GM1.corp.local:4000', env), 'edge-gm1.corp.local');
  assert.equal(tp.allowlistMatch('http://10.21.0.1:4000', env), null);
  assert.equal(tp.allowlistMatch('http://x:1', { COLLECTOR_HTTP_ALLOW: '*' }), '*');
  assert.equal(tp.allowlistMatch('http://x:1', {}), null, '설정이 없으면 아무것도 허용하지 않는다');
});

test('① evaluateCollectorUrl: 승인된 예외만 · 사유 필수 · 자기등록은 예외를 만들 수 없다 · URL 이 바뀌면 비승계', async () => {
  const tp = await import('../src/collector/transportPolicy.js');
  const env = {};
  const now = 1_700_000_000_000;
  // https·루프백
  assert.equal(tp.evaluateCollectorUrl({ url: 'https://10.1.1.1:4443', env }).ok, true);
  assert.equal(tp.evaluateCollectorUrl({ url: 'http://127.0.0.1:4000', env }).ok, true);
  // 평문 — 문맥 없음(internal)
  const r0 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.1:4000', env });
  assert.equal(r0.ok, false); assert.equal(r0.code, tp.INSECURE_HTTP_CODE); assert.match(r0.reason, /승인된 예외만/);
  // 관리자 예외 — 사유 없음 → 거부, 사유 있음 → 기록
  const admin = { source: 'admin', actor: 'boss' };
  const r1 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.1:4000', body: { allowInsecureHttp: true, insecureHttpReason: ' ' }, ctx: admin, env });
  assert.equal(r1.ok, false); assert.equal(r1.code, tp.INSECURE_HTTP_REASON_CODE);
  const r2 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.1:4000', body: { allowInsecureHttp: true, insecureHttpReason: 'IPsec 터널\u0007 구간' }, ctx: admin, env, now });
  assert.equal(r2.ok, true); assert.deepEqual(r2.exception, { source: 'admin', reason: 'IPsec 터널 구간', by: 'boss', at: now }, '제어 문자는 지운다');
  // 자기등록·내부 경로는 본문의 예외를 쓰지 못한다
  const r3 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.1:4000', body: { allowInsecureHttp: true, insecureHttpReason: '자기 주장' }, ctx: { source: 'self-register' }, env });
  assert.equal(r3.ok, false); assert.match(r3.reason, /EDGE_ADVERTISE_URL=https/);
  // 기존 항목의 같은 URL(표기만 다름) — 유지
  const existing = { url: 'http://10.1.1.1:4000', insecureHttp: r2.exception };
  const r4 = tp.evaluateCollectorUrl({ url: 'HTTP://10.1.1.1:4000/', existing, ctx: { source: 'self-register' }, env });
  assert.equal(r4.ok, true); assert.equal(r4.keep, true);
  // URL 이 바뀌면 기존 예외가 있어도 거부(승인은 그 주소에 대한 것)
  const r5 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.2:4000', existing, ctx: admin, env });
  assert.equal(r5.ok, false); assert.equal(r5.code, tp.INSECURE_HTTP_CODE);
  // 관리자가 예외를 명시적으로 내리면 기록만 지운다(기존 주소라 계속 동작)
  const r6 = tp.evaluateCollectorUrl({ url: 'http://10.1.1.1:4000', existing, body: { allowInsecureHttp: false }, ctx: admin, env });
  assert.equal(r6.ok, true); assert.equal(r6.exception, null); assert.equal(r6.keep, undefined);
  // 허용 목록
  const r7 = tp.evaluateCollectorUrl({ url: 'http://10.20.0.9:4000', ctx: { source: 'self-register' }, env: { COLLECTOR_HTTP_ALLOW: '10.20.0.0/16' }, now });
  assert.equal(r7.ok, true); assert.deepEqual(r7.exception, { source: 'env', rule: '10.20.0.0/16', at: now });
});

test('① transportOf · transportSummary 는 겹치지 않는다(합계 = 전 항목) · centralUrlTransport · selfRegisterDerivedUrl', async () => {
  const tp = await import('../src/collector/transportPolicy.js');
  const env = { COLLECTOR_HTTP_ALLOW: '10.30.0.0/16' };
  const list = [
    { url: 'https://a:4443' }, { url: 'http://127.0.0.1:4000' },
    { url: 'http://10.1.1.1:4000', insecureHttp: { source: 'admin', reason: 'VPN', by: 'b', at: 1 } },
    { url: 'http://10.30.1.1:4000' }, { url: 'http://10.2.2.2:4000' },
    { url: 'http://10.3.3.3:4000', insecureHttp: { source: 'env', rule: '10.3.0.0/16', at: 1 } }, // 등록 당시 허용 → 지금은 빠짐
    { url: 'nope' },
  ];
  const states = list.map((c) => tp.transportOf(c, env).state);
  assert.deepEqual(states, ['tls', 'loopback', 'http-approved', 'http-allowlisted', 'http-legacy', 'http-legacy', 'invalid']);
  assert.equal(tp.transportOf(list[5], env).formerRule, '10.3.0.0/16');
  const s = tp.transportSummary(list, env);
  assert.equal(s.total, 7);
  assert.equal(s.tls + s.loopback + s.httpApproved + s.httpAllowlisted + s.httpLegacy + s.invalid, s.total, '항등식');
  assert.equal(s.insecure, 4);
  assert.equal(tp.centralUrlTransport('').configured, false);
  assert.equal(tp.centralUrlTransport('http://central:4000').insecure, true);
  assert.match(tp.centralUrlTransport('http://central:4000').warning, /CENTRAL_URL=https/);
  assert.equal(tp.centralUrlTransport('https://central:4443').insecure, false);
  assert.equal(tp.centralUrlTransport('http://127.0.0.1:4000').insecure, false);
  assert.equal(tp.selfRegisterDerivedUrl({ ip: '10.0.0.5', port: 4443, scheme: 'https' }), 'https://10.0.0.5:4443');
  assert.equal(tp.selfRegisterDerivedUrl({ ip: 'fd00::5', port: 4000 }), 'http://[fd00::5]:4000', '알리지 않으면 예전처럼 http');
});

/* ── ② 실제 저장 경로 ──────────────────────────────────────────────────────────────── */
test('② registry: 기본 https · 새 평문 거부 · 업그레이드 전 http 항목은 계속 동작 · 자기등록 하향 거부 · 거부 기록', async () => {
  // 업그레이드 전 상태를 흉내 — 이 릴리스 이전에 저장된 평문 항목(예외 기록 없음)
  fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'legacy-gm1', name: 'legacy-gm1', url: 'http://10.9.1.5:4000', token: 'tok-legacy', datacenter: 'GM1', enabled: true },
    { id: 'tls-edge', name: 'tls-edge', url: 'https://10.9.2.5:4443', token: 'tok-tls', datacenter: 'HB', enabled: true },
  ] }));
  const reg = await import('../src/collector/registry.js');
  const tp = await import('../src/collector/transportPolicy.js');
  tp._resetRejected();
  // 기존 항목 — 같은 URL 갱신(토큰 교체·비활성)은 그대로 된다
  const u1 = reg.updateCollector('legacy-gm1', { token: 'tok-2', enabled: false });
  assert.equal(u1.ok, true, u1.reason);
  assert.equal(u1.collector.transport.state, 'http-legacy', '경고 상태로 드러난다');
  const u1b = reg.updateCollector('legacy-gm1', { enabled: true });
  assert.equal(u1b.ok, true);
  // 같은 URL 자기등록 갱신도 된다(기존 현장이 업그레이드 즉시 끊기지 않게)
  const s1 = reg.upsertCollectorFromAgent({ name: 'legacy-gm1', url: 'http://10.9.1.5:4000', token: 'tok-3', datacenter: 'GM1' });
  assert.equal(s1.ok, true, s1.reason);
  // IP 가 바뀐 평문 자기등록은 거부되고 기록된다(예전에는 조용히 갱신)
  const s2 = reg.upsertCollectorFromAgent({ name: 'legacy-gm1', url: 'http://10.9.1.99:4000', token: 'tok-3' });
  assert.equal(s2.ok, false); assert.equal(s2.code, 'insecure-http');
  assert.equal(reg.loadCollectors().find((c) => c.id === 'legacy-gm1').url, 'http://10.9.1.5:4000', '저장값은 그대로');
  // https 엣지를 평문으로 내리는 자기등록 거부(하향 차단)
  const s3 = reg.upsertCollectorFromAgent({ name: 'tls-edge', url: 'http://10.9.2.5:4000', token: 'tok-tls' });
  assert.equal(s3.ok, false);
  assert.equal(reg.loadCollectors().find((c) => c.id === 'tls-edge').url, 'https://10.9.2.5:4443');
  // 새 평문 자기등록 거부 + 기록
  const s4 = reg.upsertCollectorFromAgent({ name: 'new-edge', url: 'http://10.9.3.5:4000', token: 'tok-new' });
  assert.equal(s4.ok, false);
  const rej = tp.rejectedHttpRegistrations();
  assert.ok(rej.some((r) => r.name === 'new-edge' && r.source === 'self-register' && r.url === 'http://10.9.3.5:4000'), JSON.stringify(rej));
  assert.equal(JSON.stringify(rej).includes('tok-new'), false, '토큰은 기록하지 않는다');
  // 내부 경로(배포 자동 등록 형태 — 문맥 없음)도 예외를 스스로 만들 수 없다
  const a1 = reg.addCollector({ id: 'deploy-x', name: 'deploy-x', url: 'http://10.9.4.5:4000', token: 't', allowInsecureHttp: true, insecureHttpReason: '자기 주장' });
  assert.equal(a1.ok, false); assert.equal(a1.code, 'insecure-http');
  // 스킴 없는 주소는 https · 루프백 http 는 허용
  const a2 = reg.addCollector({ id: 'bare', name: 'bare', url: '10.9.5.5:4443', token: 't' });
  assert.equal(a2.ok, true); assert.equal(a2.collector.url, 'https://10.9.5.5:4443'); assert.equal(a2.collector.transport.state, 'tls');
  const a3 = reg.addCollector({ id: 'lo', name: 'lo', url: 'http://127.0.0.1:4100', token: 't' });
  assert.equal(a3.ok, true); assert.equal(a3.collector.transport.state, 'loopback');
  // 운영자 허용 목록
  process.env.COLLECTOR_HTTP_ALLOW = '10.9.3.0/24';
  try {
    const s5 = reg.upsertCollectorFromAgent({ name: 'new-edge', url: 'http://10.9.3.5:4000', token: 'tok-new' });
    assert.equal(s5.ok, true, s5.reason);
    const saved = reg.loadCollectors().find((c) => c.id === 'new-edge');
    assert.equal(saved.insecureHttp.source, 'env'); assert.equal(saved.insecureHttp.rule, '10.9.3.0/24');
    assert.equal(tp.rejectedHttpRegistrations().some((r) => r.name === 'new-edge'), false, '등록되면 거부 기록을 지운다');
  } finally { delete process.env.COLLECTOR_HTTP_ALLOW; }
  // collectorInputIssue(드라이런)도 같은 판정
  assert.match(reg.collectorInputIssue({ id: 'z', name: 'z', url: 'http://10.9.9.9:4000' }), /승인된 예외만/);
  assert.equal(reg.collectorInputIssue({ id: 'z', name: 'z', url: 'http://10.9.9.9:4000', allowInsecureHttp: true, insecureHttpReason: 'VPN 구간' }, null, { source: 'admin', actor: 'boss' }), null);
});

/* ── ③ 실제 admin 라우터 ───────────────────────────────────────────────────────────── */
test('③ admin 라우터: POST/PUT/CSV 가져오기 — 평문 거부 · 예외는 사유+감사 · GET 이 전송 상태를 싣는다', async () => {
  fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'old-http', name: 'old-http', url: 'http://10.8.1.1:4000', token: 'tok-old', enabled: false },
  ] }));
  // ⚠ 등록·수정 라우트는 pullNow() 를 부른다 — 닿지 않는 주소로 실제 pull 이 나가지 않게 전부 enabled:false 로 둔다.
  const express = (await import('express')).default;
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const tp = await import('../src/collector/transportPolicy.js');
  tp._resetRejected();
  tp.recordRejectedHttpRegistration({ source: 'self-register', name: 'edge-z', url: 'http://10.8.9.9:4000' });
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, _r, n) => { req.user = { username: req.headers['x-u'] || 'boss', role: 'admin', scope: req.headers['x-u'] === 'sadm' ? { vcenters: ['vc-x'] } : null }; n(); });
  const r = express.Router(); registerCollectorsDc(r); app.use('/api/admin', r);
  const srv = http.createServer(app); const port = await listen(srv);
  const call = async (method, p, b, u) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${p}`, { method, headers: { 'content-type': 'application/json', ...(u ? { 'x-u': u } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: res.status, j: await res.json().catch(() => null) };
  };
  try {
    // 새 평문 등록 — 거부(코드로 화면이 예외 칸을 연다)
    let x = await call('POST', '/collectors', { id: 'e1', name: 'E1', url: 'http://10.8.2.2:4000', token: 'tok-e1', enabled: false });
    assert.equal(x.s, 400); assert.equal(x.j.code, 'insecure-http');
    // 예외 체크 + 빈 사유 — 거부
    x = await call('POST', '/collectors', { id: 'e1', name: 'E1', url: 'http://10.8.2.2:4000', token: 'tok-e1', enabled: false, allowInsecureHttp: true, insecureHttpReason: '' });
    assert.equal(x.s, 400); assert.equal(x.j.code, 'insecure-http-reason');
    // 예외 + 사유 — 등록, 누가·왜 기록, 감사 로그
    x = await call('POST', '/collectors', { id: 'e1', name: 'E1', url: 'http://10.8.2.2:4000', token: 'tok-e1', enabled: false, allowInsecureHttp: true, insecureHttpReason: 'IPsec 터널 안 구간' });
    assert.equal(x.s, 201, JSON.stringify(x.j));
    assert.equal(x.j.collector.transport.state, 'http-approved');
    assert.equal(x.j.collector.insecureHttp.by, 'boss'); assert.equal(x.j.collector.insecureHttp.reason, 'IPsec 터널 안 구간');
    assert.match(readAudit(), /평문 HTTP 예외 승인\(사유=IPsec 터널 안 구간\)/);
    assert.equal(readAudit().includes('tok-e1'), false, '감사 로그에 토큰 없음');
    const approvedAt = x.j.collector.insecureHttp.at;
    // 같은 URL 수정(비활성) — 예외 유지
    x = await call('PUT', '/collectors/e1', { name: 'E1', url: 'http://10.8.2.2:4000', enabled: false });
    assert.equal(x.s, 200); assert.equal(x.j.collector.transport.state, 'http-approved');
    // 화면이 체크·사유를 그대로 되돌려 보내도(다른 칸만 고친 저장) 승인자·시각을 덮어쓰지 않는다
    const auditBefore = (readAudit().match(/평문 HTTP 예외 승인\(/g) || []).length;
    await new Promise((r) => setTimeout(r, 5));
    x = await call('PUT', '/collectors/e1', { name: 'E1 이름만', url: 'http://10.8.2.2:4000', enabled: false, allowInsecureHttp: true, insecureHttpReason: 'IPsec 터널 안 구간' });
    assert.equal(x.s, 200); assert.equal(x.j.collector.insecureHttp.at, approvedAt, '재승인으로 덮지 않는다');
    assert.equal((readAudit().match(/평문 HTTP 예외 승인\(/g) || []).length, auditBefore, '감사에 새 승인을 적지 않는다');
    // 사유를 바꾸면 새 승인(누가·언제 갱신)
    x = await call('PUT', '/collectors/e1', { name: 'E1', url: 'http://10.8.2.2:4000', enabled: false, allowInsecureHttp: true, insecureHttpReason: '전용선으로 이전 예정' });
    assert.equal(x.s, 200); assert.ok(x.j.collector.insecureHttp.at > approvedAt); assert.equal(x.j.collector.insecureHttp.reason, '전용선으로 이전 예정');
    // URL 을 다른 평문 주소로 — 예외가 승계되지 않아 거부
    x = await call('PUT', '/collectors/e1', { name: 'E1', url: 'http://10.8.2.3:4000', enabled: false });
    assert.equal(x.s, 400); assert.equal(x.j.code, 'insecure-http');
    // https 로 옮기면 예외 기록이 사라진다
    x = await call('PUT', '/collectors/e1', { name: 'E1', url: 'https://10.8.2.2:4443', token: 'tok-e1', enabled: false });
    assert.equal(x.s, 200); assert.equal(x.j.collector.transport.state, 'tls'); assert.equal(x.j.collector.insecureHttp, undefined);
    // 기존 평문 항목 — 화면 저장(같은 URL)은 그대로 된다
    x = await call('PUT', '/collectors/old-http', { name: 'old-http', url: 'http://10.8.1.1:4000', vcenterId: 'vc-1', enabled: false });
    assert.equal(x.s, 200, JSON.stringify(x.j)); assert.equal(x.j.collector.transport.state, 'http-legacy');
    // 범위 관리자는 여전히 403(전 법인 등록부)
    assert.equal((await call('POST', '/collectors', { id: 'e9', name: 'E9', url: 'https://10.8.9.1:4443', enabled: false }, 'sadm')).s, 403);

    // CSV — 드라이런: 평문 행은 오류 · 덮어쓰기(같은 URL)는 기존 항목 규칙으로 통과
    const csv = 'id,name,url,datacenter,vcenterId,enabled,token\nnew-a,A,http://10.8.3.1:4000,,,false,tok-a\nold-http,old-http,http://10.8.1.1:4000,,,false,\nnew-b,B,10.8.3.2:4443,,,false,tok-b\n';
    x = await call('POST', '/collectors/import', { csv, dryRun: true });
    assert.equal(x.s, 200);
    const by = Object.fromEntries(x.j.report.map((r) => [r.id, r]));
    assert.equal(by['new-a'].action, 'error'); assert.match(by['new-a'].reason, /승인된 예외만/);
    assert.equal(by['old-http'].action, 'overwrite', '기존 항목의 같은 URL 은 예전처럼 통과(예전엔 기존 항목 없이 검증했다)');
    assert.equal(by['new-b'].action, 'add', '스킴 없는 주소는 https');
    assert.equal(x.j.insecureRows, 2);
    // 가져오기 전체 예외(사유) — 드라이런·실행이 같은 판정
    x = await call('POST', '/collectors/import', { csv, dryRun: true, allowInsecureHttp: true, insecureHttpReason: '전용선 구간' });
    assert.equal(x.j.report.find((r) => r.id === 'new-a').action, 'add');
    x = await call('POST', '/collectors/import', { csv, overwrite: true, allowInsecureHttp: true, insecureHttpReason: '전용선 구간' });
    assert.equal(x.s, 200); assert.equal(x.j.added, 2); assert.equal(x.j.overwritten, 1); assert.equal(x.j.httpApproved, 2, 'new-a + 사유를 새로 남긴 old-http');
    assert.match(readAudit(), /평문 HTTP 예외 승인 2건\(사유=전용선 구간\)/);

    // GET — 항목별 상태 + 요약 + 거부 기록(등록된 이름은 빠진다) + 리스너·CA 상태
    x = await call('GET', '/collectors');
    assert.equal(x.s, 200);
    const t = x.j.transport;
    assert.ok(t && t.summary && t.listener && t.wanTls && t.allowlist);
    assert.equal(t.summary.total, x.j.collectors.length);
    assert.equal(t.summary.httpApproved, 2); assert.equal(t.summary.tls, 2);
    assert.deepEqual(t.rejected.map((r) => r.name), ['edge-z']);
    assert.equal(JSON.stringify(x.j).includes('tok-'), false, '토큰 값은 응답에 없다');
    if (PKI) assert.equal(t.wanTls.caCount, 1);
  } finally { await close(srv); }
});

test('③ /collectors/test: 스킴 없는 주소는 https 로 시험 · 평문이면 단계에 경고', async () => {
  const express = (await import('express')).default;
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'boss', role: 'admin', scope: null }; n(); });
  const r = express.Router(); registerCollectorsDc(r); app.use('/api/admin', r);
  const srv = http.createServer(app); const port = await listen(srv);
  try {
    // 닿지 않는 포트 — precheck 단계에서 끝나지만 경고 단계가 먼저 적힌다
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/collectors/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://10.255.255.1:1', token: 'x' }) });
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.steps[0].msg, /평문 HTTP/); assert.equal(j.steps[0].level, 'warn');
  } finally { await close(srv); }
});

/* ── ④ resilientFetch ─────────────────────────────────────────────────────────────── */
test('④ 사설 CA(WAN_TLS_CA_FILE) 로 발급된 엣지는 검증 통과 · 다른 CA 는 거부 · 상태 보고', { skip: !PKI && 'openssl 없음' }, async () => {
  const { resilientFetch, wanTlsStatus, loadWanCa } = await import('../src/util/resilientFetch.js');
  assert.equal(wanTlsStatus().verify, true); assert.equal(wanTlsStatus().caCount, 1); assert.equal(wanTlsStatus().caError, null);
  const good = https.createServer(tlsOpts(PKI.srv1), (q, s) => s.end('{"ok":true}'));
  const bad = https.createServer(tlsOpts(PKI.srv2), (q, s) => s.end('{"ok":true}'));
  const pg = await listen(good); const pb = await listen(bad);
  try {
    const r1 = await resilientFetch(`https://127.0.0.1:${pg}/api/collector/ping`, { retries: 0, timeoutMs: 5000 });
    assert.equal(r1.status, 200);
    await assert.rejects(resilientFetch(`https://127.0.0.1:${pb}/api/collector/ping`, { retries: 0, timeoutMs: 5000 }),
      (e) => /certificate|self[- ]signed|unable to (get|verify)/i.test(`${e.message} ${e.cause?.message || ''} ${e.cause?.code || ''}`), '다른 CA 로 발급된 인증서는 거부');
  } finally { await close(good); await close(bad); }
  // 잘못된 CA 파일은 오류로 보고(검증을 끄는 쪽으로 떨어지지 않는다 — ca 가 null 이면 기본 신뢰만)
  const miss = loadWanCa({ WAN_TLS_CA_FILE: path.join(DIR, 'none.pem') });
  assert.equal(miss.ca, null); assert.match(miss.error, /파일이 없습니다/);
  fs.writeFileSync(path.join(DIR, 'junk.pem'), 'not a cert');
  assert.match(loadWanCa({ WAN_TLS_CA_FILE: path.join(DIR, 'junk.pem') }).error, /BEGIN CERTIFICATE/);
  fs.writeFileSync(path.join(DIR, 'broken.pem'), '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
  assert.ok(loadWanCa({ WAN_TLS_CA_FILE: path.join(DIR, 'broken.pem') }).error);
  assert.equal(loadWanCa({}).ca, null);
  const two = loadWanCa({ WAN_TLS_CA_FILE: PKI.ca1 });
  assert.equal(two.count, 1); assert.ok(two.ca.length > 1, '기본 신뢰 목록을 대체하지 않고 더한다');
});

test('④ https → http 하향 리다이렉트는 따라가지 않는다(토큰·본문이 평문으로 나가지 않음) · 교차 출처 https 는 토큰 헤더 제거', { skip: !PKI && 'openssl 없음' }, async () => {
  const { resilientFetch, isDowngrade } = await import('../src/util/resilientFetch.js');
  assert.equal(isDowngrade('https://a/x', 'http://a/x'), true);
  assert.equal(isDowngrade('http://a/x', 'https://a/x'), false);
  const got = [];
  const sink = http.createServer((q, s) => { got.push({ tok: q.headers['x-collector-token'] || '', path: q.url }); s.end('{}'); });
  const ps = await listen(sink);
  const redir = https.createServer(tlsOpts(PKI.srv1), (q, s) => { s.statusCode = 302; s.setHeader('Location', `http://127.0.0.1:${ps}/steal`); s.end(); });
  const pr = await listen(redir);
  // 교차 출처(127.0.0.1 → localhost, 둘 다 https·같은 CA)
  const seen = [];
  const other = https.createServer(tlsOpts(PKI.srv1), (q, s) => { seen.push(q.headers['x-collector-token'] || ''); s.end('{}'); });
  const po = await listen(other);
  const cross = https.createServer(tlsOpts(PKI.srv1), (q, s) => { s.statusCode = 302; s.setHeader('Location', `https://localhost:${po}/x`); s.end(); });
  const pc = await listen(cross);
  try {
    const r = await resilientFetch(`https://127.0.0.1:${pr}/api/collector/export`, { headers: { 'X-Collector-Token': 'SECRET-TOK' }, retries: 0, timeoutMs: 5000 });
    assert.equal(r.status, 302, '하향은 따라가지 않고 그 응답을 돌려준다(호출부는 실패로 본다)');
    assert.match(r.__redirectRefused, /평문 HTTP 로 내려가는/);
    assert.equal(got.length, 0, '평문 서버에 아무 요청도 가지 않았다');
    const r2 = await resilientFetch(`https://127.0.0.1:${pc}/api/collector/export`, { headers: { 'X-Collector-Token': 'SECRET-TOK' }, retries: 0, timeoutMs: 5000 });
    assert.equal(r2.status, 200);
    assert.deepEqual(seen, [''], '교차 출처로 토큰이 따라가지 않는다');
    assert.deepEqual(r2.__secretsDroppedOnRedirect, ['x-collector-token']);
  } finally { await close(sink); await close(redir); await close(other); await close(cross); }
});

/* ── ⑤ HTTPS 리스너 ─────────────────────────────────────────────────────────────── */
test('⑤ createPortalServers: TLS 설정 오류는 평문으로 내려가지 않고 던진다', async () => {
  const hs = await import('../src/util/httpsServer.js');
  const app = (q, s) => s.end('x');
  assert.throws(() => hs.createPortalServers(app, { port: 0, env: { TLS_CERT_FILE: '/x.pem' } }), /함께 지정/);
  assert.throws(() => hs.createPortalServers(app, { port: 0, env: { TLS_CA_FILE: '/ca.pem' } }), /TLS_CA_FILE 만/);
  assert.throws(() => hs.createPortalServers(app, { port: 4000, env: { TLS_CERT_FILE: '/x', TLS_KEY_FILE: '/y', TLS_HTTP_ALSO: 'true' } }), /TLS_PORT 가 PORT/);
  assert.throws(() => hs.createPortalServers(app, { port: 4000, env: { TLS_CERT_FILE: '/x', TLS_KEY_FILE: '/y', TLS_PORT: '70000' } }), /TLS_PORT 가 올바르지/);
  assert.throws(() => hs.createPortalServers(app, { port: 0, env: { TLS_CERT_FILE: path.join(DIR, 'nope.pem'), TLS_KEY_FILE: path.join(DIR, 'nope.key') } }), /파일이 없습니다/);
  if (PKI) assert.throws(() => hs.createPortalServers(app, { port: 0, env: { TLS_CERT_FILE: PKI.srv1.cert, TLS_KEY_FILE: PKI.srv2.key } }), /쓸 수 없습니다/, '키와 인증서 짝이 틀림');
  // TLS 설정이 없으면 예전처럼 평문 하나 — 광고는 http(지어내지 않는다)
  hs._resetHttpsServerState();
  const p = hs.createPortalServers(app, { port: 4000, env: {} });
  assert.equal(p.servers.length, 1); assert.equal(p.scheme, 'http');
  assert.deepEqual(hs.advertisedListen(4000), { scheme: 'http', port: 4000, insecure: true });
  assert.equal(hs.tlsListenConfig({ TLS_RELOAD_CHECK_MS: '' }, { port: 1 }).reloadMs, 3600000, '빈 값은 기본');
  assert.equal(hs.tlsListenConfig({ TLS_RELOAD_CHECK_MS: '0' }, { port: 1 }).reloadMs, 0, '0 은 끔');
  assert.equal(hs.tlsListenConfig({ TLS_RELOAD_CHECK_MS: '9e15' }, { port: 1 }).reloadMs, 86400000, '상한(setInterval 1ms 함정)');
});

test('⑤ HTTPS 리스너 + 실제 SSH 게이트웨이 WS 업그레이드 + 미일치 경로 파기 + 재로드 + HTTP 동시 리스닝', { skip: !PKI && 'openssl 없음' }, async () => {
  const hs = await import('../src/util/httpsServer.js');
  const { attachSshGateway } = await import('../src/proxy/sshGateway.js');
  const { default: WebSocket } = await import('ws');
  const express = (await import('express')).default;
  const app = express();
  app.get('/api/health', (req, res) => res.json({ ok: true, secure: req.secure }));
  // 빈 포트 두 개(TLS_PORT ≠ PORT — 동시 리스닝)
  const grab = async () => { const s = http.createServer(); const p = await listen(s); await close(s); return p; };
  const pTls = await grab(); const pHttp = await grab();
  // 인증서 사본(재로드 시험 — 파일을 바꾼다). 개인키를 0644 로 둬 권한 경고를 본다.
  const cert = path.join(DIR, 'live.pem'); const key = path.join(DIR, 'live.key');
  fs.copyFileSync(PKI.srv1.cert, cert); fs.copyFileSync(PKI.srv1.key, key); fs.chmodSync(key, 0o644);
  const warns = [];
  const portal = hs.createPortalServers(app, { port: pHttp, env: { TLS_CERT_FILE: cert, TLS_KEY_FILE: key, TLS_PORT: String(pTls), TLS_HTTP_ALSO: 'true', TLS_RELOAD_CHECK_MS: '0' }, log: { warn: (m) => warns.push(m), log: () => {} } });
  assert.deepEqual(portal.servers.map((x) => x.scheme), ['https', 'http']);
  if (process.platform !== 'win32') assert.ok(warns.some((w) => /다른 사용자도 읽을 수/.test(w)), warns.join('\n'));
  // index.js 와 같은 배선: 서버마다 게이트웨이 + 마지막에 미일치 파기
  for (const { server } of portal.servers) {
    attachSshGateway(server);
    server.on('upgrade', (req, socket) => {
      let p = ''; try { p = new URL(req.url, 'http://localhost').pathname; } catch { /* */ }
      if (p !== '/api/remote/ssh' && p !== '/api/remote/rdp') socket.destroy();
    });
  }
  await new Promise((r) => portal.listen(r));
  try {
    const st = hs.tlsListenerStatus();
    assert.equal(st.tls, true); assert.equal(st.httpAlso, true); assert.deepEqual(st.listening, { tls: true, http: true });
    assert.equal(st.cert.selfSigned, false); assert.match(st.cert.san, /127\.0\.0\.1/);
    assert.deepEqual(hs.advertisedListen(pHttp), { scheme: 'https', port: pTls, insecure: false });
    const ca = fs.readFileSync(PKI.ca1);
    const get = (p, opts = {}) => new Promise((res, rej) => {
      const r = https.get({ host: '127.0.0.1', port: p, path: '/api/health', ca, ...opts }, (s) => { const fp = s.socket.getPeerCertificate().fingerprint256; let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => res({ status: s.statusCode, body: JSON.parse(b), fp })); });
      r.on('error', rej);
    });
    const a = await get(pTls);
    assert.equal(a.status, 200); assert.equal(a.body.secure, true, 'express 가 HTTPS 로 인식(req.secure)');
    // 평문 포트도 계속 응답(전환 기간)
    const plain = await (await fetch(`http://127.0.0.1:${pHttp}/api/health`)).json();
    assert.equal(plain.secure, false);
    // WS 업그레이드 — 실제 SSH 게이트웨이가 TLS 위에서 열린다(인증 꺼짐 → 연결 후 auth 프레임에 상태로 답한다)
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${pTls}/api/remote/ssh?token=x`, { ca });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', mappingId: 'none' })));
      ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
      ws.on('error', reject);
    });
    assert.equal(msg.type, 'status'); assert.match(msg.text, /매핑을 찾을 수 없습니다/);
    // 미일치 경로 업그레이드는 파기(무인증 FD 점유 방지 — 서버마다)
    const destroyed = await new Promise((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${pTls}/api/other`, { ca });
      ws.on('open', () => { ws.close(); resolve(false); });
      ws.on('error', () => resolve(true));
    });
    assert.equal(destroyed, true);
    // 인증서 재로드 — 파일이 바뀌면 새 연결부터 새 인증서
    assert.deepEqual(portal.reloadNow(), { ok: true, changed: false }, '안 바뀌었으면 다시 읽지 않는다');
    fs.copyFileSync(PKI.srv1b.cert, cert); fs.copyFileSync(PKI.srv1b.key, key);
    const rr = portal.reloadNow();
    assert.equal(rr.changed, true, JSON.stringify(rr));
    const b = await get(pTls, { agent: false });
    assert.notEqual(b.fp, a.fp, '재시작 없이 새 인증서');
    assert.equal(hs.tlsListenerStatus().reload.count, 1);
    // 깨진 파일로 바뀌면 이전 인증서를 계속 쓰고 사유를 남긴다
    fs.writeFileSync(cert, 'broken');
    const rb = portal.reloadNow();
    assert.equal(rb.ok, false); assert.match(hs.tlsListenerStatus().reload.lastError, /쓸 수 없습니다/);
    const c = await get(pTls, { agent: false });
    assert.equal(c.fp, b.fp);
  } finally {
    await new Promise((r) => portal.close(r));
  }
});

/* ── ⑥ 배포 대상 대조 ──────────────────────────────────────────────────────────────── */
test('⑥ collectorSync: TLS 기록이 없으면 https 를 지어내지 않는다 · 평문 행·차단 행을 드러낸다', async () => {
  const { targetUrl, diffTargets, targetTransport } = await import('../src/agent/collectorSync.js');
  assert.equal(targetUrl({ host: '10.1.1.1', portalPort: 4000 }), 'http://10.1.1.1:4000');
  assert.equal(targetUrl({ host: '10.1.1.1', portalPort: 4443, portalTls: true }), 'https://10.1.1.1:4443');
  assert.equal(targetUrl({ host: '10.1.1.1', advertiseUrl: 'https://relay:4068///' }), 'https://relay:4068');
  assert.deepEqual(targetTransport('http://10.1.1.1:4000', {}), { scheme: 'http', insecure: true, blocked: true });
  assert.deepEqual(targetTransport('http://10.1.1.1:4000', { COLLECTOR_HTTP_ALLOW: '10.1.0.0/16' }), { scheme: 'http', insecure: true, blocked: false, allowRule: '10.1.0.0/16' });
  const { rows, summary } = diffTargets([
    { id: 't1', host: '10.1.1.1', portalPort: 4000, agentName: 'A', collectorToken: 'k1' },
    { id: 't2', host: '10.1.1.2', portalPort: 4443, portalTls: true, agentName: 'B', collectorToken: 'k2' },
  ], []);
  assert.equal(rows[0].transport.insecure, true); assert.match(rows[0].transportNote, /평문 HTTP/);
  assert.equal(rows[1].transport.insecure, false); assert.equal(rows[1].transportNote, undefined);
  assert.equal(summary.insecureHttp, 1); assert.equal(summary.httpBlocked, 1);
});

test('① wanTransportCheckItem(자체점검 항목): 승인 기록 없는 평문 = risk · 예외만 = warn · 전부 https = ok · 엣지 CENTRAL_URL', async () => {
  const tp = await import('../src/collector/transportPolicy.js');
  const tlsL = { tls: true, httpAlso: false, warnings: [] };
  const ok = tp.wanTransportCheckItem({ collectors: [{ id: 'a', url: 'https://a:4443' }], env: {}, listener: tlsL, wanTls: { caError: null } });
  assert.equal(ok.status, 'ok'); assert.equal(ok.id, 'wan-transport');
  const warn = tp.wanTransportCheckItem({ collectors: [{ id: 'a', url: 'http://10.1.1.1:4000', insecureHttp: { source: 'admin', reason: 'VPN', by: 'b', at: 1 } }], env: {}, listener: tlsL });
  assert.equal(warn.status, 'warn'); assert.equal(warn.rows[0].state, 'http-approved'); assert.equal(warn.rows[0].reason, 'VPN');
  const risk = tp.wanTransportCheckItem({ collectors: [{ id: 'a', url: 'http://10.1.1.1:4000' }], env: {}, listener: tlsL });
  assert.equal(risk.status, 'risk'); assert.match(risk.detail, /승인 기록 없는 평문 HTTP 수집 서버 1대/);
  const edge = tp.wanTransportCheckItem({ collectors: [], env: {}, listener: tlsL, centralUrl: 'http://central:4000' });
  assert.equal(edge.status, 'risk'); assert.match(edge.detail, /CENTRAL_URL 이 평문/);
  const plainListener = tp.wanTransportCheckItem({ collectors: [], env: {}, listener: { tls: false, warnings: [] } });
  assert.equal(plainListener.status, 'warn'); assert.match(plainListener.detail, /평문 HTTP 로만 받는다/);
  const caErr = tp.wanTransportCheckItem({ collectors: [], env: {}, listener: tlsL, wanTls: { caError: 'WAN_TLS_CA_FILE(x) 을(를) 쓰지 못했습니다' } });
  assert.equal(caErr.status, 'warn');
});
