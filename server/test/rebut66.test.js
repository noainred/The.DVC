/**
 * 전체 점검 66회차 — 63 · 64 · 65회차 수정 반증(적대적 재검토).
 *
 *  R1(높음 · 63 F1 덜 고침) relaytopo/store.js — IRS 의 **접속 경로**(중계 엣지 경유 ↔ IRS 주소 직접)도 접속처다. 주소는 그대로 두고
 *     IRS SSH 포트(또는 중계 서비스)만 바꾸면 경로가 'Edge:중계 포트' 에서 'IRS 사설 주소:새 포트' 로 바뀌는데 저장 비밀번호를 그대로 이었다(재현).
 *     저장(normalizeTopology) · 가져오기(mergeImport) 양쪽 — 접속 판정과 같은 함수(irsRelayService · irsAccessHost).
 *  R2(중간 · 63 '남긴 것' 확인) routes/api/portalCheck.js — 꺼진 수집 서버의 id 가 다른 켜진 항목의 표시 이름과 같으면
 *     ① 그 행이 '활성' 으로 판정되고 ② 프로브 토큰 조회가 남의 수집 토큰을 그 이름 칸에 넣어, **꺼진 엣지 주소로 남의 토큰이 나갔다**(재현 — 로컬 수신기).
 *     ③ 이름 접기(collectorAlias)도 한 루프 덮어쓰기(63 F5 와 같은 꼴). id 를 먼저 · 꺼진 id 도 자리를 잡는다.
 *  R4(중간 · 65 F1 형제) commmap/build.js — 통신 지도가 엣지 링크 보고를 표기 그대로(edgeReports[linkFrom] || [id]) 찾아 대소문자만 다르면 reportAt 이 null.
 *  개선: 중계 토폴로지 가져오기 미리보기도 secretsDropped 를 싣는다(적용 뒤에야 알던 것).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const TMP = tmpDir('rebut66-');
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.DB_DIR;

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const MAIN = { privateIp: '192.168.20.143', publicIp: '10.94.40.217', portalPort: 4000 };
const EDGE = { privateIp: '192.168.30.221', publicIp: '10.112.158.217' };
const IRS = { privateIp: '192.168.31.11' };

/* ── R1 ─────────────────────────────────────────────────────────────────── */

test('R1: IRS SSH 포트만 바꿔 경로가 중계 → 직접으로 바뀌면 IRS 비밀을 잇지 않는다(저장 경로) · 같은 경로면 잇는다', async () => {
  const st = await import('../src/relaytopo/store.js');
  const { resolveNodeAccess } = await import('../src/relaytopo/ops.js');
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW', privateKey: 'IRS-KEY', port: 22 } } }] });
  let raw = st.loadTopologyRaw();
  assert.equal(resolveNodeAccess(raw, raw.sites[0], 'irs').host, EDGE.publicIp, '전제: IRS 는 중계 엣지 경유(기본 ssh 서비스 :4067 → 22)');
  // 같은 경로(포트 22 그대로 · 메모만 수정) → 잇는다
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE }, irs: { ...IRS, ssh: { username: 'root', port: 22 } }, note: 'n' }] });
  assert.equal(st.loadTopologyRaw().sites[0].irs.ssh.password, 'IRS-PW');
  // IRS SSH 포트만 2222 → 중계 서비스가 맞지 않아 IRS 사설 주소로 직접 접속하게 된다
  const moved = st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE }, irs: { ...IRS, ssh: { username: 'root', port: 2222 } } }] });
  raw = st.loadTopologyRaw();
  const acc = resolveNodeAccess(raw, raw.sites[0], 'irs');
  assert.equal(acc.host, IRS.privateIp, '전제: 경로가 직접 접속으로 바뀌었다');
  assert.equal(raw.sites[0].irs.ssh.password, '', '경로가 바뀌면 비밀번호를 버린다');
  assert.equal(raw.sites[0].irs.ssh.privateKey, '');
  assert.equal(acc.creds, undefined, 'IRS 비밀이 새 접속처로 나가지 않는다');
  assert.ok((moved.secretsDropped || []).some((x) => /^AZ IRS\(접속 경로/.test(x)), JSON.stringify(moved.secretsDropped));
});

test('R1: 중계 서비스를 끄거나(서비스 목록 변경) 가져오기로 SSH 포트를 바꿔도 같은 규칙 · Edge 의 포트만 바뀐 것은 잇는다', async () => {
  const st = await import('../src/relaytopo/store.js');
  st._resetForTest();
  const svcs = st.DEFAULT_SERVICES.map((s) => ({ ...s }));
  st.saveTopology({ main: MAIN, services: svcs, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', password: 'EDGE-PW' } }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW', port: 22 } } }] });
  // 같은 host 의 Edge SSH 포트만 변경 → Edge 비밀은 잇는다(다른 노드와 같은 규칙), 중계 리슨 포트만 바꿔도 IRS 경로 host 는 그대로 → 잇는다
  const svcs2 = svcs.map((s) => (s.key === 'ssh' ? { ...s, listenPort: 4167 } : s));
  st.saveTopology({ main: MAIN, services: svcs2, sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', port: 2200 } }, irs: { ...IRS, ssh: { username: 'root' } } }] });
  let raw = st.loadTopologyRaw();
  assert.equal(raw.sites[0].edge.ssh.password, 'EDGE-PW');
  assert.equal(raw.sites[0].irs.ssh.password, 'IRS-PW', '중계 포트만 바뀐 것은 같은 Edge host — 잇는다');
  // 중계 ssh 서비스를 끔 → IRS 직접 접속 → 버린다
  const off = st.saveTopology({ main: MAIN, services: svcs2.map((s) => (s.key === 'ssh' ? { ...s, enabled: false } : s)), sites: [{ dc: 'AZ', edge: { ...EDGE, ssh: { username: 'root', port: 2200 } }, irs: { ...IRS, ssh: { username: 'root' } } }] });
  raw = st.loadTopologyRaw();
  assert.equal(raw.sites[0].irs.ssh.password, '', '중계 서비스를 끄면 경로가 바뀐다');
  assert.ok((off.secretsDropped || []).some((x) => x.startsWith('AZ IRS(접속 경로')), JSON.stringify(off.secretsDropped));
  // 가져오기(CSV): IRS 행의 sshPort 만 2222 → 병합 결과(입력)에 비밀을 싣지 않고 정규화도 버린다
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW', port: 22 } } }] });
  const prev = st.loadTopologyRaw();
  const HDR = 'dc,role,privateIp,publicIp,vcenterIp,sshPort,sshUser,portalPort,note\n';
  const same = st.parseTopologyTable(`${HDR}AZ,IRS,${IRS.privateIp},,,22,root,,\n`);
  assert.equal(st.normalizeTopology(st.mergeImport(prev, same), prev).sites[0].irs.ssh.password, 'IRS-PW', '같은 경로면 가져오기도 잇는다');
  const parsed = st.parseTopologyTable(`${HDR}AZ,IRS,${IRS.privateIp},,,2222,root,,\n`);
  const merged = st.mergeImport(prev, parsed);
  assert.equal(merged.sites[0].irs.ssh.password, undefined, '병합 결과(입력)에 IRS 비밀을 싣지 않는다');
  assert.equal(String(merged.sites[0].irs.ssh.port), '2222');
  const n = st.normalizeTopology(merged, prev);
  assert.equal(n.sites[0].irs.ssh.password, '');
  assert.equal(n.sites[0].irs.ssh.port, 2222, '비밀만 빼고 포트는 잇는다');
  assert.ok((n.secretsDropped || []).some((x) => x.startsWith('AZ IRS')));
});

test('R1 실제 라우트 + 개선: 가져오기 미리보기가 폐기될 비밀을 말하고, 적용 뒤 GET access 는 자격증명 없음', async () => {
  const express = (await import('express')).default;
  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const st = await import('../src/relaytopo/store.js'); st._resetForTest();
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const api = express.Router(); registerRelayTopo(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r)); const base = `http://127.0.0.1:${srv.address().port}/api`;
  const call = (m, p, body) => fetch(`${base}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  try {
    let r = await call('PUT', '/tools/relaytopo', { main: MAIN, sites: [{ dc: 'AZ', edge: { ...EDGE }, irs: { ...IRS, ssh: { username: 'root', password: 'IRS-PW', port: 22 } } }] });
    assert.equal(r.ok, true);
    const text = `dc,role,privateIp,publicIp,vcenterIp,sshPort,sshUser,portalPort,note\nAZ,IRS,${IRS.privateIp},,,2222,root,,\n`;
    r = await call('POST', '/tools/relaytopo/import', { text, apply: false });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.secretsDropped) && r.secretsDropped.some((x) => x.startsWith('AZ IRS')), `미리보기도 폐기를 말한다: ${JSON.stringify(r.secretsDropped)}`);
    assert.equal((await call('GET', '/tools/relaytopo')).access.AZ.irs.source, 'topology', '미리보기는 저장하지 않는다');
    r = await call('POST', '/tools/relaytopo/import', { text, apply: true });
    assert.ok(r.secretsDropped.some((x) => x.startsWith('AZ IRS')));
    r = await call('GET', '/tools/relaytopo');
    assert.equal(r.access.AZ.irs.host, IRS.privateIp);
    assert.equal(r.access.AZ.irs.source, '', 'IRS 비밀이 직접 경로로 가지 않는다');
  } finally { srv.close(); }
});

/* ── R2 ─────────────────────────────────────────────────────────────────── */

test('R2: 꺼진 수집 서버 id 와 같은 표시 이름을 가진 다른 항목이 있어도 그 토큰이 꺼진 엣지 주소로 나가지 않는다 · 꺼짐 판정 · 이름 접기', async () => {
  const seen = [];
  const edgeA = http.createServer((req, res) => { seen.push({ path: req.url, tok: String(req.headers['x-collector-token'] || '') }); res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => edgeA.listen(0, '127.0.0.1', r));
  const TB = 'B'.repeat(40);
  fs.writeFileSync(path.join(TMP, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'seoul', name: 'Seoul HQ', url: `http://127.0.0.1:${edgeA.address().port}`, token: 'A'.repeat(40), enabled: false, allowInsecureHttp: true },
    { id: 'seoul-2', name: 'seoul', url: 'https://10.255.255.1:4000', token: TB, enabled: true },
  ] }));
  try {
    const { registerPortalCheck } = await import('../src/routes/api/portalCheck.js');
    const handlers = {};
    registerPortalCheck(new Proxy({}, { get: (_t, m) => (p, ...hs) => { handlers[`${String(m).toUpperCase()} ${p}`] = hs[hs.length - 1]; } }));
    let body = null; const res = { status() { return this; }, json(o) { body = o; } };
    await handlers['GET /tools/portal-check/tokens']({ user: { role: 'admin' } }, res);
    const row = body.rows.find((x) => x.agent === 'seoul');
    assert.equal(row?.disabled, true, `꺼진 'seoul' 은 꺼짐(다른 항목의 표시 이름 때문에 활성이 되지 않는다): ${JSON.stringify(row)}`);
    assert.ok((row.nameFrom || []).includes('registry'), `등록부 출처가 남의 행으로 접히지 않는다: ${JSON.stringify(row.nameFrom)}`);
    await handlers['POST /tools/portal-check/tokens/probe']({ user: { role: 'admin' }, body: { agent: 'seoul' } }, res);
    assert.ok(!seen.some((s) => s.tok === TB), `남의 수집 토큰이 꺼진 엣지 주소로 나가지 않는다: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((s) => s.path.startsWith('/api/collector/ping')), '꺼진 행은 프로브하지 않는다');
  } finally { edgeA.close(); }
});

/* ── R4 ─────────────────────────────────────────────────────────────────── */

test('R4: 통신 지도 — 엣지 링크 보고가 등록부 이름과 대소문자만 달라도 그 엣지에 붙는다 · 표시 이름이 남의 id 를 가로채지 않는다', async () => {
  const { buildCommMap } = await import('../src/commmap/build.js');
  const out = buildCommMap({
    now: NOW, linkCheckEnabled: true,
    collectors: [{ id: 'Edge-KR', name: 'Edge-KR', url: 'https://10.0.0.1:4000' }, { id: 'seoul', name: 'Seoul HQ' }, { id: 'seoul-2', name: 'seoul' }],
    edgeReports: { 'edge-kr': { at: NOW - 1000, stale: false, version: '3.12.0' }, seoul: { at: NOW - 2000, stale: false, version: '3.11.0' } },
  });
  const by = Object.fromEntries(out.edges.map((e) => [e.id, e]));
  assert.equal(by['Edge-KR'].linkCheck.reportAt, NOW - 1000, '대소문자만 다른 보고도 붙는다');
  assert.equal(by['Edge-KR'].linkCheck.reportVersion, '3.12.0');
  assert.equal(by.seoul.linkCheck.reportAt, NOW - 2000, "'seoul' 의 보고는 id 'seoul' 에");
  assert.equal(by['seoul-2'].linkCheck.reportAt, null, '표시 이름이 같은 다른 엣지에 붙지 않는다');
});
