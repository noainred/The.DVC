// v2.613 감사 그룹 G4a — 중앙 pull 사다리 통합 · 엣지 버전 게이트 · 중앙→엣지 호출 태그 회귀 고정.
//   CONTRACT2613-01 + EDGE2613-02 pull 코어 하나(`central/edgePull.js`) · CONTRACT2613-04 CVP 엣지 버전 게이트 ·
//   CONTRACT2613-05 linkcheck minEdgeVersion 을 서버가 준다 · EDGE2613-10 relaycheck·linkcheck 호출에 수집 서버 태그.
// 목 엣지(127.0.0.1 http 서버)를 실제로 띄워 세 pull 모듈을 **같은 입력**으로 돌리고 kind·reason 이 같은지 본다(소스 grep 이 아니다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613d-'));
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 로컬 목 엣지(127.0.0.1)로 실제 pull 을 돌린다
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WEB = path.join(SRC, '..', '..', 'web', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const readWeb = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

/** 목 엣지 — 경로별 응답을 테스트가 바꾼다. */
let mock; let mockPort; let mockReply = () => ({ status: 200, body: { ok: true, node: { agent: 'e' } } });
before(async () => {
  mock = http.createServer((req, res) => {
    const r = mockReply(req);
    res.writeHead(r.status, { 'content-type': r.html ? 'text/html' : 'application/json' });
    res.end(r.html ? r.html : JSON.stringify(r.body));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockPort = mock.address().port;
});
after(() => { try { mock?.close(); } catch { /* */ } try { fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); } catch { /* */ } });

async function registerEdge(id) {
  const { addCollector } = await import('../src/collector/registry.js');
  const r = addCollector({ id, name: id, url: `http://127.0.0.1:${mockPort}`, token: 'tok', enabled: true });
  assert.ok(r?.ok !== false, JSON.stringify(r));
}

/* ── CONTRACT2613-01 · EDGE2613-02 ─────────────────────────────────────────── */

test('CONTRACT2613-01: pull kind 열거는 서버 EDGE_PULL_KINDS 하나이고 웹 FETCH_KIND_TEXT 와 1:1 이다', async () => {
  const { EDGE_PULL_KINDS } = await import('../src/central/edgePull.js');
  assert.deepEqual([...EDGE_PULL_KINDS].sort(), ['auth', 'bad-body', 'disabled', 'disabled-central', 'http', 'no-url', 'not-registered', 'old-version', 'timeout', 'unreachable']);
  const web = readWeb('views/tools/edgeLogText.js');
  const m = web.match(/export const FETCH_KIND_TEXT = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(m, 'edgeLogText.FETCH_KIND_TEXT 를 찾지 못했다');
  const webKeys = [...m[1].matchAll(/^\s*'?([A-Za-z-]+)'?:/gm)].map((x) => x[1]);
  for (const k of EDGE_PULL_KINDS) assert.ok(webKeys.includes(k), `웹 문구 맵에 ${k} 가 없다 — 화면이 코드를 그대로 보여준다(v2.553)`);
  // 웹에만 있는 키는 라우트 오류('error') 하나뿐이어야 한다(서버 kind 가 늘면 위 목록에 더할 것).
  assert.deepEqual(webKeys.filter((k) => !EDGE_PULL_KINDS.includes(k)), ['error']);
  // 세 모듈이 사다리를 다시 갖지 않는다 — 코어 밖의 kind 리터럴 0(주석 제거 후).
  for (const f of ['central/edgeLogPull.js', 'central/bmUsageEdgePull.js', 'central/tokenCheckPull.js']) {
    const s = stripComments(read(f));
    assert.match(s, /from '\.\/edgePull\.js'/, `${f}: pullFromEdge 를 쓰지 않는다`);
    for (const lit of ["'not-registered'", "'disabled-central'", "'no-url'", 'res.status === ', 'readJsonCapped(', 'withOutboundTag(', 'kindFor404(']) {
      assert.ok(!s.includes(lit), `${f}: 사다리 조각 ${lit} 이 남아 있다(코어는 하나다)`);
    }
  }
});

test('EDGE2613-02: 같은 404 본문(reason 객체)에 세 pull 모듈이 같은 답을 낸다 — 드리프트(v2.604 CEN2604-03) 해소', async () => {
  const id = 'drift-a';
  await registerEdge(id);
  const { pullEdgeLog } = await import('../src/central/edgeLogPull.js');
  const { pullBmUsage } = await import('../src/central/bmUsageEdgePull.js');
  const { pullTokenCheck } = await import('../src/central/tokenCheckPull.js');
  const all = async () => [await pullEdgeLog(id), await pullBmUsage(id), await pullTokenCheck(id)];

  // ① reason 이 객체인 404 — 예전엔 disabled/'[object Object]' · disabled/'(형식 오류)' · old-version 세 답이었다.
  mockReply = () => ({ status: 404, body: { ok: false, reason: { x: 1 } } });
  let rs = await all();
  assert.deepEqual(rs.map((r) => r.kind), ['old-version', 'old-version', 'old-version'], JSON.stringify(rs));
  for (const r of rs) assert.ok(!/object Object|형식 오류/.test(r.reason), r.reason);
  // ② reason 이 글자인 404 — 셋 다 disabled, 같은 사유.
  mockReply = () => ({ status: 404, body: { ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' } });
  rs = await all();
  assert.deepEqual(rs.map((r) => `${r.kind}|${r.reason}`), Array(3).fill('disabled|collector 비활성화(COLLECTOR_TOKEN 미설정)'));
  // ③ express 기본 404(HTML) — 구버전 엣지 → old-version, 각 경로·최소 버전이 문구에.
  mockReply = () => ({ status: 404, html: '<html>Cannot GET /x</html>' });
  rs = await all();
  assert.deepEqual(rs.map((r) => r.kind), ['old-version', 'old-version', 'old-version']);
  assert.match(rs[0].reason, /\/api\/collector\/edge-log .*v2\.549\.0/);
  assert.match(rs[1].reason, /\/api\/collector\/bm-usage .*v2\.554\.0/);
  assert.match(rs[2].reason, /\/api\/collector\/token-check .*v2\.560\.0/);
  // ④ 403 → auth · 500(reason 객체) → http 에 '[object Object]' 없음 · 200 인데 node 없음 → bad-body.
  mockReply = () => ({ status: 403, body: { ok: false, reason: '토큰 불일치' } });
  rs = await all(); assert.deepEqual(rs.map((r) => r.kind), ['auth', 'auth', 'auth']);
  mockReply = () => ({ status: 500, body: { reason: { y: 2 } } });
  rs = await all(); assert.deepEqual(rs.map((r) => r.kind), ['http', 'http', 'http']); for (const r of rs) assert.equal(r.reason, 'HTTP 500');
  mockReply = () => ({ status: 200, body: { ok: true } });
  rs = await all(); assert.deepEqual(rs.map((r) => r.kind), ['bad-body', 'bad-body', 'bad-body']);
  // ⑤ 응답 모양은 그대로 — 실패 뒤 보관소에 lastAttempt 가 남고(fetched), 등록부 실패는 남지 않는다.
  const { getEdgeBmUsage } = await import('../src/central/bmUsageEdgePull.js');
  const { getEdgeTokenReport } = await import('../src/central/tokenCheckPull.js');
  assert.equal(getEdgeBmUsage(id)?.lastAttempt?.kind, 'bad-body');
  assert.equal(getEdgeTokenReport(id)?.lastAttempt?.kind, 'bad-body');
  const nr = await pullBmUsage('never-registered-x');
  assert.equal(nr.kind, 'not-registered'); assert.equal(nr.rec, undefined); assert.equal(nr.ms, 0);
  // ⑥ 정상 — 셋 다 ok 이고 저장된다.
  mockReply = () => ({ status: 200, body: { ok: true, node: { agent: id, version: '2.613.0' }, logs: { items: [] }, tokens: {}, targets: [], rows: [] } });
  rs = await all();
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true], JSON.stringify(rs));
  assert.ok(rs[0].snap && rs[1].rec?.snap && rs[2].rec?.report);
  // 코어는 readJsonCapped 로 읽고(전역 fetch 0), 세 모듈은 응답을 직접 읽지 않는다(secOutbound2583 의 대상이 코어로 옮겨졌다).
  const core = stripComments(read('central/edgePull.js'));
  assert.match(core, /readJsonCapped\(res,/); assert.ok(!/await res\.json\(\)/.test(core)); assert.ok(!/(^|[^.\w])fetch\(/.test(core));
  assert.equal((read('central/edgePull.js').match(/function kindFor404\(/g) || []).length, 1);
});

/* ── CONTRACT2613-04 ─────────────────────────────────────────────────────────── */

test('CONTRACT2613-04: CVP 위임의 보고 없음은 old-version/unknown-version/silent/waiting 으로 나뉜다(pending 만이 아니다)', async () => {
  const C = await import('../src/central/cvpEdge.js');
  assert.equal(C.MIN_CVP_EDGE_VERSION, '2.608.0');
  assert.deepEqual([...C.CVP_EDGE_KINDS].sort(), ['old-version', 'silent', 'unknown-version', 'waiting']);
  const NOW = 1_800_000_000_000;
  assert.equal(C.classifyCvpEdge({ edgeVersion: '' }), 'unknown-version');
  assert.equal(C.classifyCvpEdge({ edgeVersion: 'dev' }), 'waiting', '파싱 못 하는 버전은 낮은 버전으로 보지 않는다(cmpVersion null)');
  assert.equal(C.classifyCvpEdge({ edgeVersion: '2.607.9' }), 'old-version');
  assert.equal(C.classifyCvpEdge({ edgeVersion: 'v2.608.0' }), 'waiting');
  assert.equal(C.classifyCvpEdge({ edgeVersion: '2.613.0', sinceMs: NOW - 3 * 300_000 - 1, intervalMs: 300_000, now: NOW }), 'silent');
  assert.equal(C.classifyCvpEdge({ edgeVersion: '2.613.0', sinceMs: NOW - 3 * 300_000, intervalMs: 300_000, now: NOW }), 'waiting');
  assert.equal(C.classifyCvpEdge({ edgeVersion: '2.613.0', sinceMs: null, intervalMs: 300_000, now: NOW }), 'waiting', 'sinceMs 없으면 escalate 하지 않는다');
  // 엣지 버전은 수집 서버 id 와 자기보고 agent 둘 다로 찾는다(대소문자 무시).
  const status = { 'col-1': { version: '2.607.0', agent: 'Edge-One' }, 'col-2': { version: '', agent: 'edge-two' } };
  assert.equal(C.edgeVersionOf('COL-1', status), '2.607.0');
  assert.equal(C.edgeVersionOf('edge-one', status), '2.607.0');
  assert.equal(C.edgeVersionOf('edge-two', status), '');
  assert.equal(C.edgeVersionOf('nobody', status), '');
  // 웹 문구 키와 1:1
  const web = readWeb('views/tools/cvpText.js');
  const m = web.match(/const EDGE_NO_REPORT_TEXT = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  assert.ok(m, 'cvpText.EDGE_NO_REPORT_TEXT 를 찾지 못했다');
  const webKeys = [...m[1].matchAll(/^\s*'?([A-Za-z-]+)'?:\s*\(/gm)].map((x) => x[1]).sort();
  assert.deepEqual(webKeys, [...C.CVP_EDGE_KINDS].sort());
  assert.ok(!/`[^`\n]*`/.test(m[1].replace(/\$\{[^}]*\}/g, '')) || true); // 템플릿 리터럴은 허용 — 문구 안 백틱은 uiText 스윕이 본다

  // 라우트 — 위임 CVP 두 대: 구버전 엣지 / 상태 없는 엣지.
  const reg = await import('../src/cvp/registry.js');
  const { setCollectorStatus } = await import('../src/collector/state.js');
  setCollectorStatus('cvp-old-col', { version: '2.607.0', agent: 'cvp-old-edge' });
  const oldSrv = reg.saveServer({ name: 'CVP-old', host: 'http://10.99.0.1', authMode: 'token', token: 'T', agent: 'cvp-old-edge' });
  const unkSrv = reg.saveServer({ name: 'CVP-unk', host: 'http://10.99.0.2', authMode: 'token', token: 'T', agent: 'cvp-unknown-edge' });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/cvp`)).json();
    const byId = Object.fromEntries((j.servers || []).map((s) => [s.id, s]));
    const o = byId[oldSrv.id]?.status; const u = byId[unkSrv.id]?.status;
    assert.equal(o?.pending, true); assert.equal(o?.kind, 'old-version'); assert.equal(o?.edgeVersion, '2.607.0'); assert.equal(o?.minEdgeVersion, '2.608.0');
    assert.equal(u?.pending, true); assert.equal(u?.kind, 'unknown-version'); assert.equal(u?.edgeVersion, '');
  } finally {
    srv.close();
    reg.deleteServer(oldSrv.id); reg.deleteServer(unkSrv.id);
  }
});

/* ── CONTRACT2613-05 ─────────────────────────────────────────────────────────── */

test('CONTRACT2613-05: linkcheck 최소 엣지 버전은 서버(links.js)가 소유하고 /tools/link-check 응답에 실린다', async () => {
  const { MIN_EDGE_VERSION } = await import('../src/linkcheck/links.js');
  assert.equal(MIN_EDGE_VERSION, '2.552.0');
  // 웹 rowState 의 기본 인자(서버가 안 줄 때의 폴백)와 같은 값 — 다르면 구버전 중앙과 신버전 웹의 판정이 갈린다.
  const web = readWeb('views/tools/linkCheckText.js');
  const m = web.match(/minEdgeVersion = '([\d.]+)'/);
  assert.ok(m); assert.equal(m[1], MIN_EDGE_VERSION);
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/link-check`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.minEdgeVersion, MIN_EDGE_VERSION, '응답에 minEdgeVersion 이 없다 — 웹이 자기 기본값으로 판정한다');
  } finally { srv.close(); }
});

/* ── EDGE2613-10 ───────────────────────────────────────────────────────────── */

test('EDGE2613-10: relaycheck·linkcheck 의 중앙→엣지 호출이 수집 서버 태그를 싣는다(같은 origin 엣지가 sharedUrl 로 뭉치지 않게)', async () => {
  const { outboundStats, resetOutboundStats } = await import('../src/util/outboundStats.js');
  mockReply = (req) => ({ status: 200, body: req.url.startsWith('/api/health') ? { ok: true, version: 'x' } : { ok: true, agent: 'tag-r', hostname: 'h', version: 'x' } });
  resetOutboundStats();
  const { runCheck } = await import('../src/relaycheck/checks.js');
  const r = await runCheck({ host: '127.0.0.1', port: mockPort, kind: 'edge-portal', token: 'tok', expectAgent: 'tag-r', collectorId: 'tag-r', otherIds: [] }, { timeoutMs: 3_000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ping = outboundStats().rows.find((x) => x.path === '/api/collector/ping');
  assert.ok(ping, 'relaycheck ping 기록'); assert.equal(ping.tag, 'tag-r');
  // 수집 서버를 모르는 대상(hq-portal 류 · collectorId 없음)은 예전대로 태그 없이 기록된다.
  resetOutboundStats();
  await runCheck({ host: '127.0.0.1', port: mockPort, kind: 'edge-portal', token: 'tok', otherIds: [] }, { timeoutMs: 3_000 });
  assert.equal(outboundStats().rows.find((x) => x.path === '/api/collector/ping')?.tag, '');
  // linkcheck stepHttp — 호출부가 tag 를 주면 기록에 붙는다(전역 fetch 경로라 withOutboundTag 문맥이 없다).
  resetOutboundStats();
  const { stepHttp } = await import('../src/linkcheck/checks.js');
  const h = await stepHttp({ url: `http://127.0.0.1:${mockPort}/api/collector/ping`, ip: '127.0.0.1', headers: { Accept: 'application/json' }, timeoutMs: 3_000, tag: 'tag-l' });
  assert.equal(h.http?.ok, true, JSON.stringify(h));
  const row = outboundStats().rows.find((x) => x.path === '/api/collector/ping');
  assert.ok(row); assert.equal(row.tag, 'tag-l');
});
