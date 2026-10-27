/**
 * v2.767 점검 2회차 — 수정 그룹 F3(포탈 점검·LLM·인트로·데모 + 1회차 후속) 회귀 고정.
 *  R2-B4-1  인벤토리 점검의 '인벤토리를 보내지 않는 엣지' 판정이 마지막 push 하나(last)만 봐서 인벤토리 직후 svcmon 하트비트가 덮으면
 *           신선한 담당 엣지가 FAULT 로 깜빡였다 — 경로별 '/inventory' lastAt(낡음 경계 안)으로 본다. last 의 의미는 그대로.
 *  R2-B4-2  Ollama 자동설치 라우트가 본문 port(화면의 SSH 포트)를 Ollama 포트로 빼 가 SSH 는 늘 22, 포탈 LLM 주소는 http://host:22 로 저장됐다.
 *  R2-B4-3  /intro/<없는 경로> 가 SPA 폴백으로 메인 index.html 을 INTRO_CSP('unsafe-eval')와 함께 받았다 — 404.
 *  R2-B4-4  토큰 점검: 낡은 엣지 보고(STALE_MS 초과)의 거부·이름·지문 결함이 고친 뒤에도 FAULT 로 남았다 — 확인 불가 + edge-report-stale.
 *  R2-B4-5  비활성 수집 서버가 '중앙 등록부에 토큰이 저장돼 있지 않습니다' 로 안내됐다 — NOT_RUN + '비활성'.
 *  R2-B4-6  데모 계정이 인벤토리 점검에서 사람이 등록한 엣지 이름·거부 원문을 받았다 — 실등록 항목만 가린다(데모 엣지 행은 유지).
 *  R2-B1-1  Veeam 전용 수집기 덮음 판정이 요약 7일 창의 계정만 봐서, 로그 폴러가 7일 넘게 밀리면 이름 규칙('veeam') 계정이 빠져 수집기 시각이 섞였다 —
 *           본 적 있는 Veeam 계정을 snap_meta 'vu:<vc>' 에 누적(상한·시한)해 판정에 쓴다 · 잘린(truncated) 요약도 '모름'.
 *  R2-B1-2  JSON 폴백 로그 DB 는 prune 재기록으로 inode 가 바뀌어 거짓 'DB 바뀜' 으로 커서가 비었다 — 같은 경로·종류의 JSON 만 inode 무시.
 *  R2-B1-3  VM 상세 lastTask.message 가림이 포트 없는 FQDN·UNC 를 못 잡았다 — VM 이름을 먼저 빼고 판정.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2767c-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
delete process.env.DB_DIR;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');
const u = (rel) => new URL(rel, SRC).href;

/* ── R2-B4-1 ─────────────────────────────────────────────────────────────── */

test('R2-B4-1 — 인벤토리 push 직후 svcmon 하트비트가 와도 담당 엣지는 인벤토리를 보내는 중이다(FAULT 아님) · 낡은 인벤토리는 미전송', async () => {
  const { recordIngest, getIngestStats, resetIngestStats } = await import('../src/central/ingestStats.js');
  const { scanInventory, findingsOf } = await import('../src/portalcheck/invScan.js');
  resetIngestStats();
  recordIngest('edge-a', '/inventory', { wireBytes: 50_000, verified: true, summary: { vcenterId: 'vc-1', hosts: 10, vms: 100, gzip: true } });
  recordIngest('edge-a', '/svcmon-report', { wireBytes: 300, verified: true, summary: { accepted: 0, dropped: 0, rows: 0 } });
  const ingestRows = getIngestStats().rows;
  assert.equal(ingestRows[0].last.endpoint, '/svcmon-report', '전제: last 는 요약을 실은 마지막 push(의미 그대로)');
  const t = Date.now();
  const input = { vcenters: [{ id: 'vc-1', name: 'VC1', collectMode: 'site' }], inventory: [{ vcenterId: 'vc-1', agent: 'edge-a', at: t, hosts: 10, vms: 100, datastores: 3 }], ingestRows, staleMs: 300_000 };
  const scan = scanInventory({ ...input, now: t });
  const a = scan.agents.find((x) => x.agent === 'edge-a');
  assert.equal(a.sentInventory, true, '경로별 /inventory lastAt 이 신선하면 보내는 중');
  assert.equal(a.lastEndpoint, 'svcmon-report', '마지막 대상 표기는 그대로');
  assert.equal(a.lastHosts, null, '마지막 요약이 인벤토리가 아니면 수량은 모른다(0 아님)');
  assert.ok(Number(a.lastInventoryAt) > 0);
  assert.ok(!findingsOf(scan).some((f) => f.code === 'inv-agent-no-inventory'), JSON.stringify(findingsOf(scan)));
  // 낡음 경계를 넘긴 인벤토리 + 그 뒤 svcmon 만 → 미전송(담당이면 FAULT)
  const later = scanInventory({ ...input, now: t + 10 * 60_000 });
  assert.equal(later.agents.find((x) => x.agent === 'edge-a').sentInventory, false);
  assert.ok(findingsOf(later).some((f) => f.code === 'inv-agent-no-inventory'));
  // 마지막 요약이 인벤토리면 예전처럼 수량을 싣는다
  recordIngest('edge-a', '/inventory', { wireBytes: 50_000, verified: true, summary: { vcenterId: 'vc-1', hosts: 11, vms: 101, gzip: true } });
  const s2 = scanInventory({ ...input, ingestRows: getIngestStats().rows, now: Date.now() });
  assert.equal(s2.agents.find((x) => x.agent === 'edge-a').lastHosts, 11);
  resetIngestStats();
});

/* ── R2-B4-2 ─────────────────────────────────────────────────────────────── */

function runOllamaRoute(body) {
  const cfg = fs.mkdtempSync(path.join(TMP, 'llm-'));
  const script = `
    import { mock } from 'node:test';
    let creds = null; const files = {};
    mock.module(${JSON.stringify(u('proxy/sshExec.js'))}, { namedExports: {
      withSsh: async (c, fn) => { creds = c; return fn({
        exec: async (cmd) => (cmd === 'id -u' ? { code: 0, stdout: '0\\n', stderr: '' } : { code: 0, stdout: 'ok', stderr: '' }),
        writeFile: async (p, txt) => { files[p] = String(txt); }, putFile: async () => {},
      }); },
      sshExec: async () => ({}),
    } });
    const { registerDeployLlm } = await import(${JSON.stringify(u('routes/admin/deployLlm.js'))});
    const handlers = {};
    const router = new Proxy({}, { get: (_t, m) => (p, ...hs) => { handlers[String(m).toUpperCase() + ' ' + p] = hs[hs.length - 1]; } });
    registerDeployLlm(router);
    let out; let code = 200; const res = { status(c) { code = c; return this; }, json(o) { out = o; } };
    await handlers['POST /ollama-deploy']({ body: ${JSON.stringify(body)}, user: { role: 'admin' } }, res);
    const { loadLlmConfig } = await import(${JSON.stringify(u('llm/config.js'))});
    console.log(JSON.stringify({ sshPort: creds?.port ?? null, code, out, saved: loadLlmConfig().url, override: files['/etc/systemd/system/ollama.service.d/override.conf'] || '' }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('R2-B4-2 — 화면의 SSH 포트(본문 port)는 SSH 접속에 쓰고, 포탈 LLM 주소는 Ollama 포트(기본 11434)로 저장한다', () => {
  // LlmSettings.jsx 가 보내는 본문 그대로(포트 칸 = SSH 포트, 기본 22 · 여기선 2222)
  const r = runOllamaRoute({ host: '10.40.0.9', port: '2222', username: 'root', password: 'x', privateKey: '', mode: 'online', binaryPath: '', model: '', applyToPortal: true });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(String(r.sshPort), '2222', 'SSH 는 사용자가 넣은 포트로 접속한다');
  assert.equal(r.saved, 'http://10.40.0.9:11434', '저장된 LLM 주소는 Ollama 포트');
  assert.match(r.override, /OLLAMA_HOST=0\.0\.0\.0:11434/);
  // 기본 흐름(SSH 22) — 예전에는 http://host:22 가 저장됐다
  const d = runOllamaRoute({ host: '10.40.0.10', port: 22, username: 'root', password: 'x', mode: 'online', applyToPortal: true });
  assert.equal(d.saved, 'http://10.40.0.10:11434');
  // 별도 키 ollamaPort — 서비스가 듣는 포트와 저장 주소가 같은 값
  const o = runOllamaRoute({ host: '10.40.0.11', port: 22, ollamaPort: '8080', username: 'root', password: 'x', mode: 'online', applyToPortal: true });
  assert.equal(o.saved, 'http://10.40.0.11:8080');
  assert.match(o.override, /OLLAMA_HOST=0\.0\.0\.0:8080/);
  const bad = runOllamaRoute({ host: '10.40.0.12', port: 22, ollamaPort: '70000', username: 'root', password: 'x', mode: 'online', applyToPortal: true });
  assert.equal(bad.code, 400);
  assert.equal(bad.sshPort, null, '잘못된 포트면 SSH 에 붙지 않는다');
  // 형제 테스트 라우트와 키 의미가 같다 — 둘 다 본문 port 를 SSH 포트로 쓴다
  const src = stripComments(read('routes/admin/deployLlm.js'));
  assert.match(src, /'\/ollama-deploy\/test'[^\n]*testTarget\(req\.body \|\| \{\}\)/);
  assert.match(src, /const \{ mode, binaryPath, model, ollamaPort, applyToPortal, \.\.\.target \} = req\.body/);
  assert.match(fs.readFileSync(new URL('../../web/src/views/LlmSettings.jsx', import.meta.url), 'utf8'), /<label>SSH 포트<input/);
});

/* ── R2-B4-3 ─────────────────────────────────────────────────────────────── */

test('R2-B4-3 — /intro 아래 정적 파일이 없는 경로는 SPA 폴백(메인 index.html)을 받지 않는다(404) · 판정 함수는 하나', () => {
  const s = stripComments(read('index.js'));
  const i = s.indexOf("app.get('*'");
  assert.ok(i > 0, 'SPA 폴백을 찾지 못했다');
  const body = s.slice(i, s.indexOf('});', i));
  const at404 = body.indexOf('if (isIntroPath(req.path)) return res.status(404).end();');
  assert.ok(at404 > 0, '/intro 폴백 404 가 사라졌다 — INTRO_CSP 가 붙은 채 메인 앱이 뜬다');
  assert.ok(at404 < body.indexOf('res.sendFile('), '404 는 index.html 을 보내기 전에');
  assert.match(s, /isIntroPath\(req\.path\) && !process\.env\.CSP \? INTRO_CSP : CSP_HEADER/, 'CSP 분기와 같은 판정 함수를 써야 한다');
});

/* ── R2-B4-4 ─────────────────────────────────────────────────────────────── */

test('R2-B4-4 — 낡은 엣지 보고의 거부 결함은 FAULT 가 아니다(확인 불가 + edge-report-stale) · 신선한 보고는 그대로 FAULT', async () => {
  const P = await import('../src/central/tokenCheckPull.js');
  const { scanTokens, mergeEdgeReport, withRowStates, kpisOf } = await import('../src/portalcheck/tokenScan.js');
  const { findingsOf, FINDING, FINDING_GRADE } = await import('../src/portalcheck/tokenFindings.js');
  P._resetForTest();
  const rejected = { ok: true, report: { node: { agent: 'edge-a' }, tokens: {}, selfProbe: { ran: true, ok: false, kind: 'rejected' } } };
  const m = mock.method(Date, 'now', () => NOW - 5 * HOUR);
  try { P.putEdgeTokenReport('edge-a', rejected); } finally { m.mock.restore(); }
  const cols = [{ id: 'edge-a', url: 'http://10.0.0.1:4000', token: 'x'.repeat(32) }];
  const old = withRowStates(mergeEdgeReport(scanTokens({ collectors: cols }), P.listEdgeTokenReports()));
  const r = old.rows[0];
  assert.equal(r.edge.stale, true, '보고 나이 > STALE_MS');
  assert.ok(r.edge.ageMs >= 5 * HOUR - 1000);
  assert.equal(r.state, 'unknown', '낡은 거부는 결함으로도 정상으로도 세지 않는다');
  const f = findingsOf(old);
  assert.ok(!f.some((x) => x.code === 'edge-central-rejected'), JSON.stringify(f));
  const st = f.find((x) => x.code === FINDING.EDGE_REPORT_STALE);
  assert.ok(st, '다시 당기라는 한 줄');
  assert.equal(FINDING_GRADE[FINDING.EDGE_REPORT_STALE], 'unknown');
  assert.equal(st.facts.staleFact, 'rejected');
  assert.equal(kpisOf(old).fault, 0);
  // 신선한 보고 → 예전대로 FAULT
  P.putEdgeTokenReport('edge-a', rejected);
  const fresh = withRowStates(mergeEdgeReport(scanTokens({ collectors: cols }), P.listEdgeTokenReports()));
  assert.equal(fresh.rows[0].edge.stale, false);
  assert.equal(fresh.rows[0].state, 'fault');
  assert.ok(findingsOf(fresh).some((x) => x.code === 'edge-central-rejected'));
  // 낡음 경계는 tokenCheckPull.STALE_MS 하나(화면 limits.staleMs 와 같은 값)
  assert.equal(fresh.rows[0].edge.staleMs, P.STALE_MS);
  P._resetForTest();
});

/* ── R2-B4-5 ─────────────────────────────────────────────────────────────── */

test("R2-B4-5 — 비활성 수집 서버는 '토큰 미저장' 이 아니라 NOT_RUN + '비활성' 이고 네트워크를 쓰지 않는다(예산 초과로도 세지 않는다)", async () => {
  const { probeAll } = await import('../src/portalcheck/tokenProbe.js');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('호출되면 안 된다'); };
  const row = { agent: 'edge-off', url: 'http://10.0.0.9:4000', collector: { set: true }, disabled: true };
  const out = await probeAll([row], { tokenOf: () => '', fetchImpl, budgetMs: 0, timeoutMs: 2000 });
  assert.equal(fetches, 0);
  assert.equal(out.budgetExceeded, 0);
  assert.equal(out.probes[0].probe.state, 'not-run');
  assert.match(out.probes[0].probe.reason, /비활성/);
  assert.ok(!/저장돼 있지 않습니다/.test(out.probes[0].probe.reason));
  // 라우트가 등록부의 enabled:false 를 행에 싣는다(같은 키의 활성 항목이 있으면 활성)
  fs.writeFileSync(path.join(TMP, 'collectors.json'), JSON.stringify({ collectors: [
    { id: 'edge-off', name: 'edge-off', url: 'https://10.0.0.9:4000', token: 'a'.repeat(40), enabled: false },
    { id: 'edge-on', name: 'edge-on', url: 'https://10.0.0.10:4000', token: 'b'.repeat(40), enabled: true },
  ] }));
  const { registerPortalCheck } = await import('../src/routes/api/portalCheck.js');
  const handlers = {};
  registerPortalCheck(new Proxy({}, { get: (_t, m) => (p, ...hs) => { handlers[`${String(m).toUpperCase()} ${p}`] = hs[hs.length - 1]; } }));
  let body = null; const res = { status() { return this; }, json(o) { body = o; } };
  await handlers['GET /tools/portal-check/tokens']({ user: { role: 'admin' } }, res);
  const off = body.rows.find((x) => x.agent === 'edge-off');
  const on = body.rows.find((x) => x.agent === 'edge-on');
  assert.equal(off?.disabled, true, JSON.stringify(off));
  assert.ok(!on?.disabled);
  // 비활성 행은 "다시 누르면 이어서 점검" 발견을 내지 않는다(활성 행은 그대로)
  const notRun = body.findings.filter((f) => f.code === 'probe-not-run').map((f) => f.agent);
  assert.ok(!notRun.includes('edge-off'), JSON.stringify(notRun));
  assert.ok(notRun.includes('edge-on'));
});

/* ── R2-B4-6 ─────────────────────────────────────────────────────────────── */

test('R2-B4-6 — 데모 계정 판본은 사람이 등록한 엣지·vCenter 행만 가리고 데모 엣지 행은 그대로(KPI·가린 수 재계산)', async () => {
  const { scanInventory, maskInventoryForDemoGuest, findingsOf } = await import('../src/portalcheck/invScan.js');
  const { isDemoEdgeId } = await import('../src/mock/demo/edge.js');
  const t = Date.now();
  const scan = scanInventory({
    vcenters: [{ id: 'vc-real', name: 'REAL-VC', collectMode: 'site' }, { id: 'vc-us-east-1', name: 'demo', collectMode: 'site', demo: true }],
    inventory: [{ vcenterId: 'vc-real', agent: 'corp-edge-01', at: t, hosts: 3, vms: 9 }, { vcenterId: 'vc-us-east-1', agent: 'mock-Edge-NewYork', at: t, hosts: 5, vms: 50 },
      { vcenterId: 'vc-orphan', agent: 'corp-edge-02', at: t, hosts: 1, vms: 1 }],
    ingestRows: [{ agent: 'corp-edge-01', pushes: 3, last: { endpoint: '/svcmon-report' }, byEndpoint: [] }, { agent: 'mock-Edge-NewYork', pushes: 2, last: { endpoint: '/inventory', hosts: 5, vms: 50 }, byEndpoint: [] }],
    rejects: { rows: [{ agent: 'corp-edge-03', total: 4, lastReason: '10.20.30.40 토큰 불일치', byKind: { auth: 4 } }], recent: [] },
    now: t, staleMs: 300_000,
  });
  const demoIds = new Set(['vc-us-east-1']);
  const m = maskInventoryForDemoGuest(scan, { isDemoVcenter: (id) => demoIds.has(id), isDemoAgent: isDemoEdgeId });
  assert.deepEqual(m.rows.map((r) => r.vcenterId), ['vc-us-east-1']);
  assert.deepEqual(m.agents.map((a) => a.agent), ['mock-Edge-NewYork']);
  assert.deepEqual(m.orphans, []);
  assert.equal(m.kpis.total, 1);
  assert.deepEqual(m.demoMasked, { rows: 1, agents: 2, orphans: 1 });
  const json = JSON.stringify({ ...m, findings: findingsOf(m) });
  for (const leak of ['corp-edge-01', 'corp-edge-02', 'corp-edge-03', 'REAL-VC', '10.20.30.40']) assert.ok(!json.includes(leak), `${leak} 가 데모 판본에 남았다`);
  // 라우트는 데모 계정일 때만 가린다(관리자 판본은 그대로)
  const src = stripComments(read('routes/api/portalCheck.js'));
  assert.match(src, /isDemoGuest\(req\.user\)\s*\?\s*maskInventoryForDemoGuest\(scan0/);
});

/* ── R2-B1-1 ─────────────────────────────────────────────────────────────── */

const C = await import('../src/veeam/snapCollector.js');
const D = await import('../src/veeam/snapDb.js');
const S = await import('../src/veeam/snapEvents.js');
const B = await import('../src/veeam/backupCounts.js');
const { saveLogSettings } = await import('../src/logs/settings.js');

/** 가짜 vCenter — CreateCollectorForEvents 의 beginTime·userList 를 지킨다(audit2766a 와 같은 방식). */
function fakeVcenter() {
  const state = { events: [], view: [], served: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        const users = [...b.matchAll(/<userList>([^<]*)<\/userList>/g)].map((x) => x[1]);
        state.view = state.events.filter((e) => e.ts >= begin && (!users.length || users.includes(e.user))).sort((x, y) => x.ts - y.ts);
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        return send(`<ReadNextEventsResponse>${page.map((e) => `<returnval xsi:type="TaskEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>${e.user}</userName><vm><name>${e.vm}</name></vm><fullFormattedMessage>${e.msg}</fullFormattedMessage></returnval>`).join('')}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const SNAP = 'Task: Create virtual machine snapshot';
const ev = (key, ts, user, vm) => ({ key: String(key), ts, user, vm, msg: SNAP });
const row = (vc, ts, user, entity) => ({ vcenterId: vc, ts, severity: 'info', type: 'TaskEvent', user, entity, message: SNAP });
async function withVc(fn) {
  const q = [mock.method(console, 'warn', () => {}), mock.method(console, 'log', () => {})];
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info', pollIntervalMin: 10 });
    S._resetForTest(); C._resetForTest();
    await fn(srv, state);
  } finally { for (const x of q) x.mock.restore(); await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }); }
}
const writeVc = (srv, list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list.map((v) => ({ host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000, ...v })) }));

test('R2-B1-1 — 로그 폴러가 7일 넘게 밀려 옛 행만 넣는 동안에도 본 적 있는 이름 규칙 Veeam 계정(svc-veeam)을 기억해 전용 수집기 시각을 섞지 않는다', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc2', name: 'OC2' }]);
    S.saveManualAccounts(['CORP\\svc-bk']);   // VBR1 — 사람이 적은 계정(공용 아님). VBR2 는 CORP\svc-veeam(이름 규칙으로만 판정 — 목록에 없음)
    state.events = [ev('b1', NOW - HOUR, 'CORP\\svc-bk', 'web01'), ev('v1', NOW - 2 * HOUR, 'CORP\\svc-veeam', 'db01'), ev('v2', NOW - 3 * HOUR, 'CORP\\svc-veeam', 'db02')];
    const r = await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(r.read, 1, '전제: 전용 수집기는 svc-bk 만 읽는다');
    assert.equal(C.snapCollectorOkAt('oc2'), NOW);
    const db = await D.getSnapDb();
    // 로그 폴러(13일 지연)가 지금 넣고 있는 것은 10일 전 행 — svc-veeam 이 그때도 백업했다(요약 7일 창 밖)
    await D.ingestSnapRows([row('oc2', NOW - 10 * DAY, 'CORP\\svc-veeam', 'db01')]);
    assert.ok(D.seenVeeamUsers('oc2').includes('svc-veeam@corp'), '전용 DB 적재가 본 Veeam 계정을 기록한다');
    db.setCoveredFrom('oc2', NOW - 11 * DAY, Date.now());
    const vms = [{ id: 'oc2:vm-1', name: 'web01' }, { id: 'oc2:vm-2', name: 'db01' }, { id: 'oc2:vm-3', name: 'db02' }];
    const sum = await S.localSnapSummary(null, 'oc2', vms, { now: NOW, snapDb: db });
    assert.deepEqual(sum.veeamUsers, ['svc-bk@corp'], '전제: 7일 창에는 svc-bk 뿐(1회차 A1-1 ③ 만으로는 통과한다)');
    assert.equal(C.snapEventsOkAt('oc2', { dedicated: true, summary: sum }), null, '본 적 있는 svc-veeam 을 이 수집기가 덮지 않는다 → 섞지 않는다');
    const logOkAt = NOW - 13 * DAY;
    const combined = C.combineOkAt(logOkAt, C.snapEventsOkAt('oc2', { dedicated: true, summary: sum }));
    assert.deepEqual(B.snapVerdict({ status: 'ok', collectedAt: combined, staleMs: 6 * HOUR, accounts: sum.accounts, events: sum.events, unpaired: sum.unpaired, byVm: sum.byVm, at: NOW }, NOW),
      { ok: false, reason: 'stale-events' }, "db01·db02 를 '7일 미백업' 으로 세지 않는다");
    // svc-veeam 을 목록에 넣으면(수집기가 읽는다) 다시 섞는다 — 영구 차단이 아니다
    S.saveManualAccounts(['CORP\\svc-bk', 'CORP\\svc-veeam']);
    await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(C.snapEventsOkAt('oc2', { dedicated: true, summary: sum }), NOW);
  });
});

test('R2-B1-1 — 요약(로그 DB 경로 포함)이 본 Veeam 계정도 누적 · 잘린 요약은 모름 · 재시작 뒤에도 남는다 · 상한·시한', async () => {
  await withVc(async (srv, state) => {
    writeVc(srv, [{ id: 'oc7', name: 'OC7' }]);
    S.saveManualAccounts(['CORP\\svc-bk']);
    state.events = [ev('b1', NOW - HOUR, 'CORP\\svc-bk', 'web01')];
    await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(C.snapCollectorOkAt('oc7'), NOW);
    const db = await D.getSnapDb();
    const vms = [{ id: 'oc7:vm-1', name: 'web01' }, { id: 'oc7:vm-2', name: 'db01' }];
    // 전용 DB 덮음이 아직 없는 vCenter — 로그 DB(검색) 경로의 요약이 svc-veeam 을 봤다(전용 DB 에는 넣지 않았다)
    const logsDb = { query: () => [row('oc7', NOW - 2 * HOUR, 'CORP\\svc-veeam', 'db01'), row('oc7', NOW - HOUR, 'CORP\\svc-bk', 'web01')] };
    const s1 = await S.localSnapSummary(logsDb, 'oc7', vms, { now: NOW, snapDb: db });
    assert.deepEqual(s1.veeamUsers, ['svc-bk@corp', 'svc-veeam@corp']);
    assert.ok(D.seenVeeamUsers('oc7').includes('svc-veeam@corp'), '요약이 본 계정을 기록한다');
    const onlyBk = { veeamUsers: ['svc-bk@corp'], truncated: false };
    assert.equal(C.snapEventsOkAt('oc7', { dedicated: true, summary: onlyBk }), null);
    // 재시작 — 메모리 사본을 버리고 meta 에서 다시 읽는다
    D._resetSnapDbForTest();
    await D.getSnapDb();
    assert.ok(D.seenVeeamUsers('oc7').includes('svc-veeam@corp'), "snap_meta 'vu:<vc>' 영속");
    // 잘린 요약은 모름(덮인 계정뿐이어도)
    const other = await D.getSnapDb();
    D.rememberVeeamUsers('oc8', [], NOW, other);
    writeVc(srv, [{ id: 'oc8', name: 'OC8' }]);
    state.events = [ev('b2', NOW - HOUR, 'CORP\\svc-bk', 'web01')];
    C._resetForTest();
    await C.pollVeeamSnapOnce({ now: NOW });
    assert.equal(C.snapEventsOkAt('oc8', { dedicated: true, summary: { veeamUsers: ['svc-bk@corp'], truncated: false } }), NOW, '전제: 덮이면 섞는다');
    assert.equal(C.snapEventsOkAt('oc8', { dedicated: true, summary: { veeamUsers: ['svc-bk@corp'], truncated: true } }), null, '잘린 요약은 모름');
    // 상한·시한(순수 경로 — meta 쓰기 포함)
    const many = Array.from({ length: D.VEEAM_USERS_MAX + 6 }, (_, i) => `veeam${i}@corp`);
    D.rememberVeeamUsers('oc9', many, NOW, other);
    assert.equal(D.seenVeeamUsers('oc9', NOW).length, D.VEEAM_USERS_MAX);
    D.rememberVeeamUsers('oc10', ['svc-veeam@corp'], NOW - D.VEEAM_USERS_TTL_MS - DAY, other);
    assert.deepEqual(D.seenVeeamUsers('oc10', NOW), [], '시한이 지난 계정은 판정에 쓰지 않는다');
  });
});

/* ── R2-B1-2 ─────────────────────────────────────────────────────────────── */

test('R2-B1-2 — JSON 폴백 로그 DB 의 prune 재기록(inode 변경)은 같은 DB 다 · SQLite 의 inode 변경은 여전히 다른 DB', async () => {
  const P = await import('../src/logs/poller.js');
  const { atomicWriteFileSync } = await import('../src/util/atomicWrite.js');
  const file = path.join(TMP, 'vcenter-logs.ndjson');
  fs.writeFileSync(file, '{"a":1}\n');
  P._resetCursorsForTest();
  const k1 = P.logsDbKey({ kind: 'json', path: file });
  assert.equal(P.syncCursorDbKey(k1), false);
  atomicWriteFileSync(file, '{"a":1}\n', { mode: 0o600 });   // logs/db.js rewrite() 와 같은 호출(prune 이 1건이라도 지우면)
  const k2 = P.logsDbKey({ kind: 'json', path: file });
  assert.notEqual(k1.ino, k2.ino, '전제: 재기록이 inode 를 바꾼다');
  const w = mock.method(console, 'warn', () => {});
  try { assert.equal(P.syncCursorDbKey(k2), false, '거짓 DB 바뀜으로 커서를 비우지 않는다'); assert.equal(w.mock.callCount(), 0); } finally { w.mock.restore(); }
  assert.equal(P.sameLogsDb({ kind: 'sqlite', path: '/a/x.db', ino: '1' }, { kind: 'sqlite', path: '/a/x.db', ino: '2' }), false, 'SQLite 파일 교체 감지(A2-01)는 그대로');
  assert.equal(P.sameLogsDb({ kind: 'json', path: '/a/x.ndjson', ino: '1' }, { kind: 'json', path: '/b/x.ndjson', ino: '1' }), false, '경로가 다르면 다른 DB');
  assert.equal(P.sameLogsDb({ kind: 'json', path: '/a/x', ino: '1' }, { kind: 'sqlite', path: '/a/x', ino: '1' }), false, '종류가 다르면 다른 DB');
  P._resetCursorsForTest();
});

/* ── R2-B1-3 ─────────────────────────────────────────────────────────────── */

test('R2-B1-3 — 작업 메시지의 포트 없는 FQDN·UNC 는 가리고, 점 든 VM 이름·숫자 버전은 가리지 않는다', async () => {
  const { publicTaskMessage } = await import('../src/routes/api/veeam.js');
  const HID = '작업 메시지에 주소가 들어 있어 관리자 화면에서만 보입니다';
  assert.equal(publicTaskMessage('Error: Failed to connect to vbr-proxy01.corp.local'), HID);
  assert.equal(publicTaskMessage('Cannot access repository \\\\nas01\\veeam'), HID);
  assert.equal(publicTaskMessage('Cannot access //nas01/veeam'), HID);
  assert.equal(publicTaskMessage('Error: 10.1.2.3:443 refused'), HID, '예전 규칙은 그대로');
  assert.equal(publicTaskMessage('Processing db01.corp.local completed', { vmName: 'db01.corp.local' }), 'Processing db01.corp.local completed', 'VM 이름은 먼저 뺀다');
  assert.equal(publicTaskMessage('DB01.CORP.LOCAL failed: cannot reach vbr01.corp.local', { vmName: 'db01.corp.local' }), HID, 'VM 이름을 빼도 다른 호스트가 남으면 가린다');
  assert.equal(publicTaskMessage('Veeam 12.1.2 job finished'), 'Veeam 12.1.2 job finished');
  // 선형 — 긴 입력도 300자로 먼저 자른다(자르지 않으면 이 입력에서 FQDN 규칙이 O(n²) 로 수 초 — 그것과 확실히 갈리는 상한)
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) publicTaskMessage(`${'a.'.repeat(50_000)}!`);
  const tookMs = Date.now() - t0;
  assert.ok(tookMs < 2000, `${tookMs}ms`);
  assert.match(stripComments(read('routes/api/veeam.js')), /maskDetail\(buildVmDetail\(m\.byVm\[vmId\]\), isAdminDetailUser\(req\.user\), vm\.name\)/);
});
