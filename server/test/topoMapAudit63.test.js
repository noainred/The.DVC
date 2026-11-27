/**
 * 전체 점검 63회차 — 토폴로지 · 지도 계열(1차: relaytopo · servicemap · commmap · dataflow · devflow).
 *
 *  F1(높음) relaytopo/store.js — IRS 는 중계 엣지(Edge host:중계 포트)로 접속하는데(ops.js resolveNodeAccess), 저장 비밀 이월은
 *           IRS 자기 IP 만 비교했다. Edge publicIp 만 다른 호스트로 바꾸고 저장하면 IRS 의 SSH 비밀번호가 그 호스트로 나갔다(재현:
 *           resolveNodeAccess 가 host=새 Edge 주소 · creds.password=IRS 비밀번호). 저장(normalizeTopology)·가져오기(mergeImport) 양쪽.
 *  F2(높음) relaytopo/store.js mergeImport — 표/CSV 가져오기로 Main host 가 바뀌어도 현재 Main ssh(비밀 포함)를 입력에 그대로 펼쳐,
 *           normalizeTopology 가 host 변경을 알아도 '입력에 실린 비밀' 로 받아 새 host 로 보냈다(재현 — 사이트 노드 S1(v2.435)의 형제).
 *           Main 비밀을 버린 사실도 secretsDropped 에 싣는다(사이트 노드와 같은 규칙).
 *  F3(중간) relaytopo/ops.js siteSummary — IRS 접속 실패를 summary.bad 에 넣지 않아 사이트 배지가 '모두 정상' 이었다.
 *  F4(낮음) routes/api/relaytopo.js RE_DC — 저장은 공백 · '/' 가 든 사이트 이름을 받는데 사이트별 가져오기 · 적용 · SSH 테스트는
 *           `/^[^\s/\\]{1,40}$/` 로 400 '잘못된 사이트 이름' 이었다(재현 — 전체 가져오기 · 미리보기만 됐다). 이름은 사이트 조회에만 쓴다.
 *  F5(중간) commmap/build.js aliasMap · dataflow/build.js — 등록부 이름 접기에서 다른 엣지의 표시 이름이 이 엣지 id 를 덮어,
 *           'seoul' 이 보낸 push 로 'seoul-2' 가 정상 · 'seoul' 은 기록 없음이 됐다(재현 — 통신 지도 · 데이터 흐름 · 3단 지도 공통). id 가 먼저.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('topomap63-');
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const MAIN = { privateIp: '192.168.20.143', publicIp: '10.94.40.217', portalPort: 4000 };
const EDGE = { privateIp: '192.168.30.221', publicIp: '10.112.158.217' };
const IRS = { privateIp: '192.168.31.11' };
const EVIL = '203.0.113.66';

test('F1: Edge host 가 바뀌면 IRS 의 저장 비밀도 잇지 않는다(IRS 는 Edge 경유로 접속) — 저장 경로', async () => {
  const st = await import('../src/relaytopo/store.js');
  const { resolveNodeAccess } = await import('../src/relaytopo/ops.js');
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', password: 'EDGE-PW' } }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW', privateKey: 'IRS-KEY' } } }] });
  // 전제: Edge 가 그대로면 IRS 비밀은 잇는다(편집 편의 — 화면은 비밀을 되돌려 보내지 않는다)
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root' } }, irs: { ...IRS, ssh: { username: 'root' } }, note: 'n' }] });
  let raw = st.loadTopologyRaw();
  assert.equal(raw.sites[0].irs.ssh.password, 'IRS-PW', 'Edge·IRS host 가 그대로면 유지');
  assert.equal(resolveNodeAccess(raw, raw.sites[0], 'irs').host, EDGE.publicIp, '전제: IRS 는 Edge 경유');
  // Edge publicIp 만 다른 호스트로 → IRS 접속처도 바뀐다
  const moved = st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE, publicIp: EVIL, ssh: { username: 'root' } }, irs: { ...IRS, ssh: { username: 'root' } } }] });
  raw = st.loadTopologyRaw();
  assert.equal(raw.sites[0].irs.ssh.password, '', 'Edge host 가 바뀌면 IRS 비밀번호를 버린다');
  assert.equal(raw.sites[0].irs.ssh.privateKey, '', '키도 함께 끊는다');
  const acc = resolveNodeAccess(raw, raw.sites[0], 'irs');
  assert.equal(acc.creds, undefined, 'IRS 자격증명이 새 Edge 주소로 나가지 않는다');
  assert.match(acc.error || '', /자격증명이 없습니다/);
  assert.ok((moved.secretsDropped || []).some((x) => /^AZ IRS\(Edge/.test(x)), `IRS 폐기 사유(Edge 경유)를 알린다: ${JSON.stringify(moved.secretsDropped)}`);
  assert.ok((moved.secretsDropped || []).includes('AZ Edge'));
});

test('F1: 가져오기(mergeImport)로 Edge host 가 바뀌어도 IRS 비밀을 잇지 않는다 / 그대로면 유지', async () => {
  const st = await import('../src/relaytopo/store.js');
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', password: 'EDGE-PW' } }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW' } } }] });
  const prev = st.loadTopologyRaw();
  // 라우트와 같은 조합: normalizeTopology(mergeImport(raw, parsed), raw)
  const same = st.normalizeTopology(st.mergeImport(prev, { sites: [{ dc: 'AZ', edge: { ...EDGE, vcenterIp: '192.168.30.10' }, irs: {} }] }), prev);
  assert.equal(same.sites[0].irs.ssh.password, 'IRS-PW', 'Edge·IRS 그대로면 유지');
  const evilParsed = { sites: [{ dc: 'AZ', edge: { privateIp: EDGE.privateIp, publicIp: EVIL }, irs: {} }] };
  assert.equal(st.mergeImport(prev, evilParsed).sites[0].irs.ssh.password, undefined, '병합 결과(입력)에 IRS 비밀을 싣지 않는다');
  const merged = st.normalizeTopology(st.mergeImport(prev, evilParsed), prev);
  assert.equal(merged.sites[0].irs.ssh.password, '', 'Edge host 변경 → IRS 비밀 폐기');
  assert.equal(merged.sites[0].edge.ssh.password, '', 'Edge 자신도 폐기(S1)');
});

test('F2: 가져오기로 Main host 가 바뀌면 Main 비밀을 잇지 않는다 / 그대로면 유지 / 저장 경로는 폐기를 알린다', async () => {
  const st = await import('../src/relaytopo/store.js');
  const { resolveNodeAccess } = await import('../src/relaytopo/ops.js');
  st._resetForTest();
  st.saveTopology({ main: { ...MAIN, ssh: { username: 'root', password: 'MAIN-PW' } }, sites: [] });
  const HDR = 'dc,role,privateIp,publicIp,vcenterIp,sshPort,sshUser,portalPort,note\n';
  // 같은 host → 유지
  let parsed = st.parseTopologyTable(`${HDR}Main,Main,${MAIN.privateIp},${MAIN.publicIp},,22,root,4000,\n`);
  st.saveTopology(st.mergeImport(st.loadTopologyRaw(), parsed));
  assert.equal(st.loadTopologyRaw().main.ssh.password, 'MAIN-PW', 'Main host 가 그대로면 유지');
  // publicIp 만 다른 호스트 → 폐기
  parsed = st.parseTopologyTable(`${HDR}Main,Main,${MAIN.privateIp},${EVIL},,22,root,4000,\n`);
  const merged = st.mergeImport(st.loadTopologyRaw(), parsed);
  assert.equal(merged.main.ssh.password, undefined, '병합 결과(입력)에 Main 비밀을 싣지 않는다');
  const saved = st.saveTopology(merged);
  const raw = st.loadTopologyRaw();
  assert.equal(raw.main.publicIp, EVIL);
  assert.equal(raw.main.ssh.password, '', '가져오기로 Main host 가 바뀌면 비밀을 버린다');
  assert.equal(resolveNodeAccess(raw, null, 'main').creds, undefined, 'Main 비밀이 새 host 로 나가지 않는다');
  assert.deepEqual(saved.secretsDropped, ['Main'], 'Main 폐기도 알린다');
  // 저장 경로(PUT) — Main host 변경 폐기도 알린다
  st._resetForTest();
  st.saveTopology({ main: { ...MAIN, ssh: { username: 'root', password: 'MAIN-PW' } }, sites: [] });
  const put = st.saveTopology({ main: { ...MAIN, publicIp: '198.51.100.7', ssh: { username: 'root' } }, sites: [] });
  assert.deepEqual(put.secretsDropped, ['Main']);
  const keep = st.saveTopology({ main: { ...MAIN, publicIp: '198.51.100.7', ssh: { username: 'root', password: 'NEW' } }, sites: [] });
  assert.equal(keep.secretsDropped, undefined, '비밀이 없던 노드는 폐기 목록에 없다');
});

test('F1·F2 실제 라우트: PUT·가져오기 뒤 GET access 가 자격증명 없음으로 바뀐다(비밀이 새 host 로 가지 않는다)', async () => {
  const express = (await import('express')).default;
  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const st = await import('../src/relaytopo/store.js'); st._resetForTest();
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const api = express.Router(); registerRelayTopo(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${srv.address().port}/api`;
  const put = (body) => fetch(`${base}/tools/relaytopo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    let r = await put({ main: { ...MAIN, ssh: { username: 'root', password: 'MAIN-PW' } }, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', password: 'EDGE-PW' } }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW' } } }] });
    assert.equal(r.ok, true);
    r = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(r.access.AZ.irs.source, 'topology', '전제: IRS 자격증명 있음');
    assert.equal(r.access._main.main.source, 'topology', '전제: Main 자격증명 있음');
    // 화면 저장과 같은 모양(비밀 없음)으로 Edge publicIp 만 바꾼다
    r = await put({ main: { ...MAIN, ssh: { username: 'root' } }, sites: [{ dc: 'AZ', edge: { ...EDGE, publicIp: EVIL, ssh: { username: 'root' } }, irs: { ...IRS, ssh: { username: 'root' } } }] });
    assert.ok(r.secretsDropped.some((x) => x.startsWith('AZ IRS')), JSON.stringify(r.secretsDropped));
    r = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(r.access.AZ.irs.host, EVIL, '접속처는 새 Edge 주소');
    assert.equal(r.access.AZ.irs.source, '', 'IRS 비밀이 새 Edge 주소로 가지 않는다');
    assert.match(r.access.AZ.irs.error, /자격증명이 없습니다/);
    // 가져오기(apply)로 Main host 변경
    const csv = `dc,role,privateIp,publicIp,vcenterIp,sshPort,sshUser,portalPort,note\nMain,Main,${MAIN.privateIp},${EVIL},,22,root,4000,\n`;
    r = await (await fetch(`${base}/tools/relaytopo/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: csv, apply: true }) })).json();
    assert.equal(r.ok, true); assert.deepEqual(r.secretsDropped, ['Main']);
    r = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(r.access._main.main.source, '', 'Main 비밀이 새 host 로 가지 않는다');
    assert.match(r.access._main.main.error, /자격증명이 없습니다/);
    assert.equal(JSON.stringify(r).includes('PW'), false, '응답에 비밀 없음');
  } finally { srv.close(); }
});

test('F3: siteSummary — IRS 접속 실패도 문제로 센다(사이트 배지가 모두 정상이 되지 않게)', async () => {
  const { siteSummary } = await import('../src/relaytopo/ops.js');
  const rows = [{ status: 'ok' }, { status: 'ok' }];
  assert.deepEqual(siteSummary({ edge: { ok: true }, irs: null, rows, irsIssues: [] }), { total: 2, bad: 0, edgeFailed: false, irsFailed: false }, 'IRS 없음 · 전부 정상');
  const s = siteSummary({ edge: { ok: true }, irs: { ok: false, error: 'x' }, rows, irsIssues: [] });
  assert.equal(s.irsFailed, true);
  assert.equal(s.bad, 1, 'IRS 접속 실패 1건');
  assert.equal(siteSummary({ edge: { ok: false }, irs: { ok: false }, rows: [], irsIssues: [] }).bad, 2, 'Edge·IRS 둘 다 실패');
  assert.equal(siteSummary({ edge: { ok: true }, irs: { ok: true }, rows: [{ status: 'missing' }], irsIssues: [{ level: 'error' }, { level: 'warn' }] }).bad, 2, '대조 문제 + IRS 오류 수준');
});

test('F4: 공백 · / 가 든 사이트 이름도 사이트별 가져오기 · SSH 테스트가 된다(제어 문자는 400)', async () => {
  const express = (await import('express')).default;
  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const st = await import('../src/relaytopo/store.js'); st._resetForTest();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const api = express.Router(); registerRelayTopo(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    // 자격증명 없는 Edge — SSH 를 시도하지 않고 바로 '자격증명 없음' 으로 끝난다(네트워크 없음)
    st.saveTopology({ main: MAIN, sites: [{ dc: 'Seoul DC', edge: { privateIp: '10.0.1.1' }, irs: {} }, { dc: 'HQ/Seoul', edge: { privateIp: '10.0.2.1' }, irs: {} }] });
    for (const dc of ['Seoul DC', 'HQ/Seoul']) {
      const f = await post(`/tools/relaytopo/fetch/${encodeURIComponent(dc)}`, {});
      assert.equal(f.status, 200, `${dc} 가져오기: ${JSON.stringify(f.body)}`);
      assert.equal(f.body.dc, dc); assert.equal(f.body.edge.ok, false); assert.match(f.body.edge.error, /자격증명이 없습니다/);
      const t = await post('/tools/relaytopo/test-ssh', { dc, role: 'edge' });
      assert.equal(t.status, 200); assert.match(t.body.reason, /자격증명이 없습니다/, `${dc} SSH 테스트`);
    }
    const bad = await post('/tools/relaytopo/test-ssh', { dc: 'A\u0001B', role: 'edge' });
    assert.equal(bad.status, 400, '제어 문자는 거부');
    const long = await post('/tools/relaytopo/test-ssh', { dc: 'x'.repeat(41), role: 'edge' });
    assert.equal(long.status, 400, '40자 초과 거부');
  } finally { srv.close(); }
});

test('개선: exitCodeOf — 끝에 붙은 rc= 만 읽는다(오류 문구 안의 rc=0 을 통과로 읽지 않는다)', async () => {
  const { exitCodeOf } = await import('../src/relaytopo/ops.js');
  assert.equal(exitCodeOf('Configuration file is valid\nrc=0\n'), 0);
  assert.equal(exitCodeOf("[ALERT] parsing [/tmp/x:12] : unknown keyword 'rc=0'\nrc=1"), 1, '첫 일치(rc=0)가 아니라 끝의 rc=1');
  assert.equal(exitCodeOf('replaced\nrc=0'), 0);
  assert.equal(exitCodeOf('rc=91'), 91);
  assert.ok(Number.isNaN(exitCodeOf('')), '없으면 NaN(성공 아님)');
  assert.ok(Number.isNaN(exitCodeOf('rc=0 그리고 뒤에 글자')), '끝이 아니면 읽지 않는다');
  // 장비 출력(외부 입력)에 대한 선형성 — 공백 덩어리 · 긴 숫자
  const t0 = Date.now();
  exitCodeOf(`rc=1${' '.repeat(5000)}x`.repeat(40)); exitCodeOf(`rc=${'1'.repeat(200_000)}x`);
  assert.ok(Date.now() - t0 < 500, `선형이어야 한다(${Date.now() - t0}ms)`);
});

test('F5: 수집 서버 id 가 다른 엣지의 표시 이름보다 먼저 — 기록이 남의 엣지로 접히지 않는다(세 지도 공통)', async () => {
  const { buildCommMap, aliasMap } = await import('../src/commmap/build.js');
  const { buildDataFlow } = await import('../src/dataflow/build.js');
  const { buildDeviceFlow } = await import('../src/devflow/build.js');
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 고정
  const collectors = [{ id: 'seoul', name: 'Seoul Edge', url: 'https://a.example:4000' }, { id: 'seoul-2', name: 'seoul', url: 'https://b.example:4000' }];
  const am = aliasMap(collectors);
  assert.equal(am.get('seoul'), 'seoul', 'id 가 이긴다');
  assert.equal(am.get('seoul edge'), 'seoul'); assert.equal(am.get('seoul-2'), 'seoul-2');
  // 뒤 순서에서도 같다(먼저 온 엣지의 이름이 뒤 엣지의 id 를 덮지 않는다)
  assert.equal(aliasMap([...collectors].reverse()).get('seoul'), 'seoul');
  const ingest = { rows: [{ agent: 'seoul', verified: true, lastAt: now - 1000, pushes: 5, wireBytes: 10, intervalSec: 60, byEndpoint: [{ endpoint: '/inventory', lastAt: now - 1000, count: 1 }] }] };
  const comm = buildCommMap({ now, collectors, status: {}, ingest, resMax: Infinity, directMax: Infinity });
  const byId = Object.fromEntries(comm.edges.map((e) => [e.id, e]));
  assert.equal(byId.seoul.push.state, 'ok', 'seoul 의 push 는 seoul 에');
  assert.equal(byId['seoul-2'].push.state, 'none', 'seoul-2 는 기록 없음(남의 push 로 정상이 되지 않는다)');
  assert.equal(byId['seoul-2'].state, 'unknown');
  const flow = buildDataFlow({ now, routes: [{ side: 'central', method: 'POST', path: '/inventory' }], collectors, ingest });
  const fe = Object.fromEntries(flow.edges.map((e) => [e.id, e]));
  assert.equal(fe.seoul.used, 1); assert.equal(fe['seoul-2'].used, 0);
  const dev = buildDeviceFlow({ now, comm, flow });
  const de = Object.fromEntries(dev.edges.map((e) => [e.id, e]));
  assert.equal(de.seoul.channels.up.state, 'ok'); assert.equal(de['seoul-2'].channels.up.state, 'none', '3단 지도 선도 같은 엣지');
  // 표시 이름으로 온 기록은 여전히 그 엣지로 접힌다(v2.583 '키 하나')
  const byName = buildCommMap({ now, collectors, status: {}, ingest: { rows: [{ ...ingest.rows[0], agent: 'Seoul Edge' }] } });
  assert.equal(byName.edges.find((e) => e.id === 'seoul').push.state, 'ok');
});
