// v2.744 회귀 검토 수정 그룹 RD — v2.744 GD(EDGE-01·EDGE-03) 수정분의 회귀 검토 발견 3건.
//   GD-R1  엣지 iDRAC 등록부 JSON 파싱 오류 원문(자격증명 파일 조각)이 상태 전용 보고 → 중앙 → fleetPartials 로 operator·viewer 응답에 실렸다
//   GD-R2  엣지 fleet 상태 전용 push 가 중앙 응답을 읽지 않고 언제나 '직전 목록을 유지하게 했습니다' 라고 적었다
//   GD-R3  중앙 관리자가 누른 '등록'(위임 등록 잡)을 '자동 경로' 로 거절하고 같은 동작을 다시 하라고 안내했다
// 실제 함수 · 실제 centralRouter · 실제 api/insights 라우터(express 마운트) · 실제 엣지 워커(가짜 중앙)로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rd-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2744rd';
delete process.env.CENTRAL_URL;
delete process.env.AGENT_IDRAC_SCAN_POLL_MS;

const IDRAC_FILE = path.join(TMP, 'idrac.json');
const SECRET = 'SuperSecret123!';
// 비밀번호 칸 따옴표를 빠뜨린 손편집 — V8 오류가 `..."assword": SuperSecre"...` 조각을 싣는다(GD-R1 재현 입력).
const corruptAtPassword = () => {
  const txt = fs.readFileSync(IDRAC_FILE, 'utf8');
  assert.ok(txt.includes(`"password": "${SECRET}"`), '시드가 평문 비밀번호로 저장됐다(기본 secretVault plain)');
  fs.writeFileSync(IDRAC_FILE, txt.replace(`"password": "${SECRET}"`, `"password": ${SECRET}`));
};
const LEAK = /SuperSecre|assword/;   // 원문 조각의 흔적(비밀번호 앞 글자 · 키 이름 조각)
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let registry; let config; let central; let centralUrl; const fleetBodies = [];
before(async () => {
  registry = await import('../src/idrac/registry.js');
  ({ config } = await import('../src/config.js'));
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use((req, _res, next) => { if (req.path === '/api/central/fleet') fleetBodies.push(JSON.stringify(req.body || {})); next(); });
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralUrl = `http://127.0.0.1:${await listen(central)}`;
});
after(() => {
  central?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const seedIdrac = () => registry.importServers([
  { id: 'bm-1', name: 'bm-1', host: '192.0.2.51', username: 'u', password: SECRET },
  { id: 'bm-2', name: 'bm-2', host: '192.0.2.52', username: 'u', password: SECRET },
], 'replace');

/** 엣지 이름·토큰으로 pushFleetNow 를 실제로 부른다(중앙 버전 확인은 2.744+ 로 주입). */
async function asEdge(name, token, fn) {
  const fp = await import('../src/agent/fleetPush.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  try {
    config.agent.centralUrl = centralUrl; config.agent.centralToken = token; config.agent.name = name;
    fp._setFleetStatusOnlySupportForTest(() => ({ ok: true }));
    return await fn(fp);
  } finally {
    fp._setFleetStatusOnlySupportForTest(null);
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
  }
}

/* ════════════════════ GD-R1 — 원문 조각을 노드 밖으로 보내지 않는다 ════════════════════ */

test('GD-R1: summarizeRegistryError — 분류 코드·숫자만 남기고 원문 글자는 하나도 옮기지 않는다', async () => {
  const { summarizeRegistryError, REGISTRY_ERROR_LABEL } = await import('../src/util/registryCore.js');
  let raw = '';
  try { JSON.parse(`{"servers":[{"password": ${SECRET}}]}`); } catch (e) { raw = e.message; }
  assert.match(raw, /SuperSecre/, 'V8 오류 원문은 조각을 싣는다(전제)');
  const a = summarizeRegistryError({ at: 1, reason: raw });
  assert.equal(a.code, 'parse-error');
  assert.doesNotMatch(a.text, LEAK);
  assert.equal(a.text, REGISTRY_ERROR_LABEL['parse-error']);
  // 위치가 있는 V8 형식은 줄·칸만 옮긴다.
  let raw2 = '';
  try { JSON.parse('{\n  "a": 1,\n}'); } catch (e) { raw2 = e.message; }
  const b = summarizeRegistryError({ reason: raw2 });
  assert.equal(b.code, 'parse-error'); assert.equal(b.line, 3); assert.equal(b.column, 1);
  assert.match(b.text, /3번째 줄 1번째 칸/);
  // 손상 보존본만 남은 경우 · 시스템 오류(경로는 옮기지 않는다)
  assert.equal(summarizeRegistryError({ reason: '등록부 파일이 없고 손상 보존본(idrac.json.corrupt.1)만 있습니다' }).code, 'corrupt-only');
  const c = summarizeRegistryError({ reason: "EACCES: permission denied, open '/etc/vmware-portal/idrac.json'" });
  assert.equal(c.code, 'read-error'); assert.equal(c.sysCode, 'EACCES');
  assert.doesNotMatch(c.text, /etc|vmware|idrac\.json/);
  // 알려진 코드가 오면 글자를 보지 않는다(엣지가 보낸 글자를 믿지 않는다) · 숫자 아닌 위치는 버린다.
  const d = summarizeRegistryError({ code: 'parse-error', line: '7', column: 2, reason: `..."assword": ${SECRET}"...` });
  assert.doesNotMatch(d.text, LEAK); assert.equal(d.line, 7); assert.equal(d.column, 2);
  const e = summarizeRegistryError({ code: 'parse-error', line: { toString: () => 'x' }, sysCode: 'rm -rf', reason: 'x' });
  assert.equal(e.line, null); assert.equal(e.sysCode, null);
  // 긴 입력도 선형(정규식 입력 상한)
  const t0 = Date.now(); summarizeRegistryError({ reason: 'E'.repeat(200_000) }); assert.ok(Date.now() - t0 < 1000);
  assert.equal(summarizeRegistryError(null), null);
});

test('GD-R1: 엣지 상태 전용 보고 · 중앙 저장 · 엣지 상태 어디에도 등록부 원문 조각이 없다(실제 pushFleetNow + centralRouter)', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const cf = await import('../src/central/fleet.js');
  const tok = issueAgentToken('edge-rd-r1');
  assert.equal(tok.ok, true);
  await asEdge('edge-rd-r1', tok.token, async (fp) => {
    seedIdrac();
    assert.equal((await fp.pushFleetNow()).ok, true);
    corruptAtPassword();
    const err = registry.registryLoadError();
    assert.match(err.reason, /SuperSecre/, '전제 — 엣지 로드 오류 원문에는 비밀번호 앞 글자가 있다');
    const n0 = fleetBodies.length;
    const r = await fp.pushFleetNow();
    assert.equal(r.statusOnly, true, JSON.stringify(r));
    assert.equal(fleetBodies.length, n0 + 1);
    const sent = fleetBodies.at(-1);
    assert.doesNotMatch(sent, LEAK, `중앙으로 보낸 본문에 원문 조각이 없다: ${sent}`);
    assert.match(sent, /"code":"parse-error"/, '분류 코드를 싣는다');
    const st = fp.fleetPushStatus().last;
    assert.doesNotMatch(JSON.stringify(st), LEAK, '엣지 상태(엣지 로그로 중앙에 당겨진다)에도 없다');
    const row = cf.listEdgeFleet().find((x) => x.agent === 'edge-rd-r1');
    assert.ok(row?.registryUnreadable, JSON.stringify(row));
    assert.doesNotMatch(JSON.stringify(row), LEAK);
    assert.doesNotMatch(JSON.stringify(cf.fleetPartialsSummary({ detail: true })), LEAK, '관리자 요약에도 조각은 없다');
    cf.flushEdgeFleetNow();
    assert.doesNotMatch(fs.readFileSync(path.join(TMP, 'central-fleet.json'), 'utf8'), LEAK, '중앙 파일에도 없다');
  });
  seedIdrac();
});

test('GD-R1: 원문을 보내는 엣지(이 수정 전)의 사유도 중앙이 저장·응답 전에 요약한다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const cf = await import('../src/central/fleet.js');
  const tok = issueAgentToken('edge-rd-raw');
  cf.setEdgeFleet('edge-rd-raw', [{ fleetId: 'f1', name: 'x', serviceTag: 'T1', vcenterId: '', source: 'idrac' }], null, { verified: true });
  const res = await fetch(`${centralUrl}/api/central/fleet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tok.token },
    body: JSON.stringify({ agent: 'edge-rd-raw', statusOnly: true, status: { registryUnreadable: { at: 5, reason: `Unexpected token 'S', ..."assword": SuperSecre"... is not valid JSON` } } }),
  });
  assert.equal(res.status, 200);
  const row = cf.listEdgeFleet().find((x) => x.agent === 'edge-rd-raw');
  assert.equal(row.registryUnreadable.code, 'parse-error');
  assert.doesNotMatch(JSON.stringify(row), LEAK);
  assert.doesNotMatch(JSON.stringify(cf.fleetPartialsSummary({ detail: true })), LEAK);
  cf.flushEdgeFleetNow();
  assert.doesNotMatch(fs.readFileSync(path.join(TMP, 'central-fleet.json'), 'utf8'), LEAK, '저장할 때 이미 요약한다(응답 직전 요약에만 기대지 않는다)');
});

test('GD-R1: /tools/bm-usage · /insights/fleet — 사유의 위치는 관리자에게만, operator·viewer 에게는 분류 고정 문구만(실제 라우터)', async () => {
  const cf = await import('../src/central/fleet.js');
  cf.setEdgeFleet('edge-rd-route', [{ fleetId: 'f3', name: 'z', serviceTag: 'T3', vcenterId: '', source: 'idrac' }], null, { verified: true });
  cf.holdEdgeFleet('edge-rd-route', { registryUnreadable: { at: 9, code: 'parse-error', line: 3, column: 12, reason: `..."assword": ${SECRET}"...` } });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { insightsRouter } = await import('../src/routes/insights.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: String(req.headers['x-u'] || 'u'), role: String(req.headers['x-role'] || 'viewer'), scope: null }; n(); });
  app.use('/api/insights', insightsRouter);
  app.use('/api', api);
  const srv = http.createServer(app);
  const base = `http://127.0.0.1:${await listen(srv)}`;
  const get = async (p, role) => {
    const r = await fetch(base + p, { headers: { 'x-u': role, 'x-role': role } });
    return { s: r.status, j: await r.json().catch(() => null) };
  };
  try {
    const pick = (fp) => (fp?.registryUnreadable || []).find((x) => x.agent === 'edge-rd-route');
    const op = await get('/api/tools/bm-usage', 'operator');
    assert.equal(op.s, 200, JSON.stringify(op.j)?.slice(0, 300));
    const opRow = pick(op.j.fleetPartials);
    assert.ok(opRow, JSON.stringify(op.j.fleetPartials));
    assert.equal(opRow.reasonDetailHidden, true);
    assert.equal(opRow.reason, 'JSON 형식 오류');
    assert.doesNotMatch(JSON.stringify(op.j.fleetPartials), /번째 줄|SuperSecre|assword/);
    const ad = await get('/api/tools/bm-usage', 'admin');
    assert.equal(ad.s, 200);
    const adRow = pick(ad.j.fleetPartials);
    assert.match(adRow.reason, /3번째 줄 12번째 칸/, '관리자는 위치까지 본다');
    assert.equal(adRow.reasonDetailHidden, undefined);
    assert.doesNotMatch(JSON.stringify(ad.j.fleetPartials), LEAK);
    const vw = await get('/api/insights/fleet', 'viewer');
    assert.equal(vw.s, 200, JSON.stringify(vw.j)?.slice(0, 300));
    const vwRow = pick(vw.j.fleetPartials);
    assert.equal(vwRow.reasonDetailHidden, true);
    assert.doesNotMatch(JSON.stringify(vw.j.fleetPartials), /번째 줄|SuperSecre|assword/);
    const ai = await get('/api/insights/fleet', 'admin');
    assert.match(pick(ai.j.fleetPartials).reason, /3번째 줄/);
  } finally { srv.close(); }
});

/* ════════════════════ GD-R2 — 중앙 응답을 읽고 사실대로 말한다 ════════════════════ */

test('GD-R2: fleetHoldOutcome — 보류 수락·이름 미검증·보관분 없음·시한 지남·응답 없음을 구분한다(순수)', async () => {
  const { fleetHoldOutcome } = await import('../src/agent/fleetPush.js');
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 4 }).code, 'held');
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 4 }).held, true);
  // v2.744(최종 검토 RD-R3): 수가 없을 때 조사가 '목록를' 이 되지 않는다
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true }).text, '중앙이 직전 목록을 유지합니다');
  assert.match(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 4 }).text, /직전 목록 4대를 유지합니다/);
  assert.match(fleetHoldOutcome({ ok: true, statusOnly: true, holdExpired: true }).text, /이 엣지 목록을 지웁니다/);
  assert.doesNotMatch(JSON.stringify([fleetHoldOutcome({ ok: true, statusOnly: true }), fleetHoldOutcome({ ok: true, statusOnly: true, holdExpired: true })]), /목록를/);
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 0, unverifiedAgent: true }).code, 'unverified-agent');
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 0, noPrior: true }).code, 'no-prior');
  assert.equal(fleetHoldOutcome({ ok: true, statusOnly: true, kept: 2, holdExpired: true }).code, 'hold-expired');
  for (const r of [null, {}, { ok: true }, 'x', []]) {
    const o = fleetHoldOutcome(r);
    assert.equal(o.code, 'unknown'); assert.equal(o.held, false);
  }
  for (const c of [{ unverifiedAgent: true }, { noPrior: true }, { holdExpired: true }, {}]) {
    const o = fleetHoldOutcome({ statusOnly: true, kept: 1, ...c });
    if (!o.held) assert.doesNotMatch(o.text, /유지합니다|유지하게 했습니다/, `${o.code}: 유지됐다고 말하지 않는다`);
  }
});

test('GD-R2: 실제 push — 중앙이 보류를 받지 않으면(이름 미검증·보관분 없음·시한 지남) 엣지 상태가 그렇게 말하고 error 를 싣는다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const cf = await import('../src/central/fleet.js');
  const notHeldSaysSo = (r, st, code) => {
    assert.equal(r.held, false, JSON.stringify(r));
    assert.equal(r.centralHold, code);
    assert.equal(st.centralHold?.code, code, JSON.stringify(st));
    assert.equal(st.centralHold?.held, false);
    assert.ok(st.error, '유지되지 않았으면 error 에도 싣는다(엣지 로그 화면이 정상으로 보이지 않게)');
    assert.doesNotMatch(st.note, /유지하게 했습니다|직전 목록 \d+대를 유지합니다/, st.note);
  };

  // ① 유지 — 개별 토큰 · 직전 목록 있음
  const tHeld = issueAgentToken('edge-rd-held');
  await asEdge('edge-rd-held', tHeld.token, async (fp) => {
    seedIdrac();
    assert.equal((await fp.pushFleetNow()).ok, true);
    corruptAtPassword();
    const r = await fp.pushFleetNow();
    const st = fp.fleetPushStatus().last;
    assert.equal(r.held, true, JSON.stringify(r)); assert.equal(st.centralHold?.code, 'held');
    assert.equal(st.error, null);
    assert.match(st.note, /중앙이 직전 목록 \d+대를 유지합니다/);
  });

  // ② 보관분 없음 — 개별 토큰이지만 한 번도 목록을 보낸 적 없음
  const tNo = issueAgentToken('edge-rd-noprior');
  await asEdge('edge-rd-noprior', tNo.token, async (fp) => {
    seedIdrac(); corruptAtPassword();
    const r = await fp.pushFleetNow();
    notHeldSaysSo(r, fp.fleetPushStatus().last, 'no-prior');
    assert.equal(cf.listEdgeFleet().find((x) => x.agent === 'edge-rd-noprior'), undefined, '중앙에도 행이 없다(전제)');
  });

  // ③ 이름 미검증 — 공유 토큰 + 중앙이 모르는 이름
  await asEdge('edge-rd-unknown', 'ctok-2744rd', async (fp) => {
    seedIdrac(); corruptAtPassword();
    const r = await fp.pushFleetNow();
    notHeldSaysSo(r, fp.fleetPushStatus().last, 'unverified-agent');
    assert.match(fp.fleetPushStatus().last.note, /개별 토큰/);
  });

  // ④ 시한 지남 — 보류가 UNREADABLE_HOLD_MS 전에 시작된 엣지
  const tExp = issueAgentToken('edge-rd-exp');
  await asEdge('edge-rd-exp', tExp.token, async (fp) => {
    seedIdrac();
    assert.equal((await fp.pushFleetNow()).ok, true);
    // 보류 시작을 시한 + 1분 전으로 · 마지막 연장은 15분 전으로(TTL 30분 안 — 만료로 빠지기 전이어야 'holdExpired' 를 본다).
    cf.holdEdgeFleet('edge-rd-exp', { registryUnreadable: { reason: 'x' }, now: Date.now() - cf.UNREADABLE_HOLD_MS - 60_000 });
    cf.holdEdgeFleet('edge-rd-exp', { registryUnreadable: { reason: 'x' }, now: Date.now() - 15 * 60_000 });
    corruptAtPassword();
    const r = await fp.pushFleetNow();
    notHeldSaysSo(r, fp.fleetPushStatus().last, 'hold-expired');
    assert.match(fp.fleetPushStatus().last.note, /유지 시한/);
  });
  seedIdrac();
});

/* ════════════════════ GD-R3 — 사람이 누른 위임 등록은 '자동' 이 아니다 ════════════════════ */

test('GD-R3: registerScanned(manualRemote) — 손상 등록부에 저장하지 않되 사유가 사람 요청·그 엣지의 조치를 말한다', async () => {
  seedIdrac(); corruptAtPassword();
  assert.ok(registry.registryLoadError());
  const found = [{ ip: '192.0.2.81', serviceTag: 'T81', hostName: 'h81', vendor: 'dell' }];
  const r = registry.registerScanned(found, 'root', 'pw', 'merge', '', '', { manualRemote: 'edge-rd-w' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'registry-unreadable');
  assert.equal(r.manual, true);
  assert.equal(r.refused, 1);
  assert.doesNotMatch(r.reason, /자동/, r.reason);
  assert.match(r.reason, /엣지 ‘edge-rd-w’ 의 포탈/);
  assert.match(r.reason, /요청한 등록을 저장하지 않았습니다/);
  assert.doesNotMatch(JSON.stringify(r), LEAK, '거절 사유(중앙에 회신된다)에 원문 조각이 없다');
  assert.ok(registry.registryLoadError(), '표지 유지');
  assert.equal(fs.existsSync(IDRAC_FILE), false, '손상 자리에 새 파일을 쓰지 않는다');
  // 자동 경로 문구도 원문 조각을 싣지 않는다(엣지 스캐너·로컬 스캔의 회신 — GD-R1 의 형제).
  const a = registry.registerScanned(found, 'root', 'pw', 'merge', '', '', { auto: true });
  assert.match(a.reason, /자동으로 저장하지 않았습니다/);
  assert.doesNotMatch(JSON.stringify(a), LEAK);
  // 읽을 수 있는 등록부면 사람 요청은 저장한다.
  seedIdrac();
  const ok = registry.registerScanned(found, 'root', 'pw', 'merge', '', '', { manualRemote: 'edge-rd-w' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  seedIdrac();
});

test('GD-R3: 실제 엣지 워커 — 중앙이 내린 등록 잡(사람 요청)은 수동 거절 문구로, job.auto 표시가 있으면 자동 문구로 회신한다', async () => {
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  let serve = []; const results = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/idrac-scan-jobs')) { const jobs = serve; serve = []; return res.end(JSON.stringify({ jobs })); }
      if (req.url.startsWith('/api/central/idrac-scan-result')) { try { results.push(JSON.parse(body)); } catch { /* */ } return res.end('{"ok":true}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  const port = await listen(fake);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edge-rd-w';
    seedIdrac(); corruptAtPassword();
    const W = await import('../src/agent/idracScanWorker.js');
    const job = (reqId, extra = {}) => ({ reqId, action: 'register', found: [{ ip: '192.0.2.91', serviceTag: 'T91', hostName: 'h91', vendor: 'dell' }], username: 'u', password: 'p', mode: 'merge', ...extra });
    serve = [job('rq-rd-man')];
    await W.runIdracScanWorkerOnce();
    const man = results.find((x) => x.reqId === 'rq-rd-man');
    assert.ok(man, JSON.stringify(results));
    assert.equal(man.registered, 0);
    assert.doesNotMatch(String(man.error), /자동/, man.error);
    assert.match(String(man.error), /엣지 ‘edge-rd-w’ 의 포탈/);
    assert.doesNotMatch(JSON.stringify(man), LEAK);
    assert.ok(registry.registryLoadError(), '잡이 표지를 지우지 않았다');
    assert.ok(W.getIdracScanWorkerStatus().last?.registerError);
    serve = [job('rq-rd-auto', { auto: true })];
    await W.runIdracScanWorkerOnce();
    const au = results.find((x) => x.reqId === 'rq-rd-auto');
    assert.match(String(au?.error), /자동으로 저장하지 않았습니다/);
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
    await new Promise((r) => fake.close(r));
    seedIdrac();
  }
});
