/**
 * v2.743(점검 2회차 그룹 GJ) — 중계 점검·CSV 이스케이프·vCenter 로그 '지금 수집' 문구의 회귀.
 *
 *  WEB-01   HAProxy 경로 '지금 점검' 응답의 ok 가 정상 개수(숫자)로 덮였다 — `{ ok: true, ..._last }` 에서 _last.ok(정상 개수)가 뒤에 펼쳐져
 *           정상 0개(전부 실패·대상 0)면 ok 가 0 이 되고 화면이 '점검 실패: undefined' 라고 말했다. 개수는 okCount, 반환의 ok 는 언제나 true.
 *  INJPKG-04 응답 JSON 의 agent 가 문자열이 아니면 remedyFor 의 got.toLowerCase() 가 TypeError — 그 호출이 try 밖이라 runRelayChecks 가
 *           통째로 거부됐다(그 대상 결과·_last·빠진 대상 정리가 사라진다). 실제 가짜 포탈(HTTP)로 재현한다.
 *  INJPKG-03 (relaycheck 쪽) 원격 agent·hostname 의 탭·CR·LF 가 알림 제목(remedy.title)에 그대로 들어가 그 알림 메일이 통째로 실패했다.
 *  INJPKG-05 손으로 쓴 CSV 칸 이스케이프 4곳이 단독 CR 을 따옴표로 감싸지 않았다 — 공용 csvCell 로 모으고 라우트의 자체 사본을 스윕으로 막는다.
 *  WEB-04   vCenter 로그 '지금 수집' — 진행 중이면 직전 결과(lastRun)를 돌려줘 화면이 그 건수를 이번 결과로 말했다. busy·skipped·failed 를 밝힌다.
 *
 * ⚠ 이 파일은 live 모드다(가짜 포탈·닫힌 포트에 실제로 접속한다). 재현물·CONFIG_DIR 은 os.tmpdir 아래다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743j-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 포탈이 127.0.0.1 에 산다 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* 정리 실패 무시 */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ }
});

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/;

/** 닫힌(아무도 듣지 않는) 127.0.0.1 포트 하나 — 잠깐 열었다 닫아 번호만 얻는다. */
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** /api/collector/ping 에 body 를 돌려주는 가짜 포탈. */
async function fakePortal(body) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/collector/ping')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return srv.address().port;
}

const writeCollectors = (list) => fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: list }, null, 2));

async function relayModules() {
  const settings = await import('../src/relaycheck/settings.js');
  const poller = await import('../src/relaycheck/poller.js');
  return { settings, poller };
}

// ─────────────────────────────── WEB-01 ───────────────────────────────
test('WEB-01 runRelayChecks — 정상 0개(전부 실패)여도 반환의 ok 는 true · 정상 개수는 okCount', async () => {
  const { settings, poller } = await relayModules();
  writeCollectors([]);
  const port = await closedPort();
  settings._resetForTest?.();
  settings.saveSettings({ enabled: true, autoHosts: false, topologyHosts: false, failStreak: 1, alerts: false, timeoutMs: 2000,
    profile: [{ port, kind: 'irs-vcenter' }], hosts: [{ host: '127.0.0.1' }] });
  poller._resetForTest();
  const r = await poller.runRelayChecks({ force: true });
  assert.equal(r.ok, true, `점검이 끝났으면 ok 는 true 다(숫자 0 이면 화면이 '점검 실패' 로 간다): ${JSON.stringify(r)}`);
  assert.equal(r.total, 1);
  assert.equal(r.okCount, 0, '정상 개수는 okCount');
  assert.equal(r.fail, 1);
  const st = poller.relayCheckStatus();
  assert.equal(st.last.okCount, 0, '상태 화면(last)도 같은 이름');
  assert.equal(st.last.ok, undefined, '상태 객체에 개수를 ok 라는 이름으로 두지 않는다(다시 덮이지 않게)');
});

test('WEB-01 runRelayChecks — 대상 0개도 ok:true · total 0', async () => {
  const { settings, poller } = await relayModules();
  writeCollectors([]);
  settings.saveSettings({ enabled: true, autoHosts: false, topologyHosts: false, failStreak: 1, alerts: false,
    profile: [{ port: 4066, kind: 'irs-vcenter' }], hosts: [] });
  poller._resetForTest();
  const r = await poller.runRelayChecks({ force: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.total, 0);
  assert.equal(r.okCount, 0);
});

// ─────────────────────────────── INJPKG-04 · INJPKG-03 ───────────────────────────────
for (const [name, body] of [
  ['숫자 agent', { agent: 7, hostname: 9 }],
  ['객체 agent(toString 칸을 가진 JSON)', { agent: { toString: 1, valueOf: 1 }, hostname: { x: 1 } }],
]) {
  test(`INJPKG-04 응답 ${name} — 주기 점검 전체가 멈추지 않고 그 대상은 '대상 불일치' 로 남는다`, async () => {
    const { settings, poller } = await relayModules();
    const port = await fakePortal(body);
    // IRS 포트(port) 항목은 토큰·기대 이름이 있고, 같은 호스트의 :4000 항목이 중계 엣지(relayAgent)다 — remedyFor 가 got.toLowerCase() 를 부르는 경로.
    writeCollectors([
      { id: 'AZ', url: 'http://127.0.0.1:4000', token: 'tA', enabled: true },
      { id: 'AZ-IRS', url: `http://127.0.0.1:${port}`, token: 'tB', enabled: true },
    ]);
    const closed = await closedPort();
    settings.saveSettings({ enabled: true, autoHosts: true, topologyHosts: false, failStreak: 1, alerts: false, timeoutMs: 3000,
      profile: [{ port, kind: 'irs-portal' }, { port: closed, kind: 'irs-vcenter' }], hosts: [] });
    poller._resetForTest();
    const r = await poller.runRelayChecks({ force: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 2, '두 대상 모두 결과가 남는다');
    const res = poller.relayCheckStatus().results;
    assert.equal(res.length, 2, '실패한 대상의 결과·나머지 대상 결과가 모두 상태에 남는다');
    const irs = res.find((x) => x.target.port === port);
    assert.equal(irs.ok, false);
    assert.equal(irs.phase, 'identity', `문자열이 아닌 agent 는 불일치다(이름 없음 = 통과로 바뀌면 안 된다): ${JSON.stringify(irs)}`);
    assert.equal(irs.got.agent, '', '문자열이 아닌 값은 상태·화면에 싣지 않는다');
    assert.equal(irs.got.hostname, '');
    assert.equal(typeof irs.remedy?.title, 'string');
    assert.match(irs.remedy.title, /응답 '\?'/);
  });
}

test('INJPKG-03 응답 agent·hostname 의 CR·LF·탭은 상태·해결방안 제목에 들어가지 않는다(알림 메일 제목이 깨지지 않게)', async () => {
  const { settings, poller } = await relayModules();
  const port = await fakePortal({ agent: 'OTHER\r\nBcc: x@example.invalid\t', hostname: 'h1\nh2' });
  writeCollectors([
    { id: 'AZ', url: 'http://127.0.0.1:4000', token: 'tA', enabled: true },
    { id: 'AZ-IRS', url: `http://127.0.0.1:${port}`, token: 'tB', enabled: true },
  ]);
  settings.saveSettings({ enabled: true, autoHosts: true, topologyHosts: false, failStreak: 1, alerts: false, timeoutMs: 3000,
    profile: [{ port, kind: 'irs-portal' }], hosts: [] });
  poller._resetForTest();
  const r = await poller.runRelayChecks({ force: true });
  assert.equal(r.ok, true);
  const irs = poller.relayCheckStatus().results.find((x) => x.target.port === port);
  assert.equal(irs.phase, 'identity');
  assert.ok(!CTRL.test(irs.got.agent) && irs.got.agent.startsWith('OTHER'), JSON.stringify(irs.got));
  assert.ok(!CTRL.test(irs.got.hostname), JSON.stringify(irs.got));
  assert.ok(!CTRL.test(irs.remedy.title), `제목에 제어 문자: ${JSON.stringify(irs.remedy.title)}`);
  assert.ok(!CTRL.test(irs.remedy.cause), JSON.stringify(irs.remedy.cause));
  assert.ok(!CTRL.test(irs.error), JSON.stringify(irs.error));
});

test('INJPKG-04 remedyFor(순수) — got.agent 가 숫자·객체·제어 문자여도 던지지 않는다 · 자기 되돌림 판정은 문자열일 때만', async () => {
  const { remedyFor } = await import('../src/relaycheck/remedy.js');
  const base = { kind: 'irs-portal', host: '10.0.0.1', port: 4068, phase: 'identity', expect: { agent: 'AZ-IRS', relayAgent: 'AZ' } };
  for (const agent of [7, { a: 1 }, ['AZ'], true, null]) {
    const x = remedyFor({ ...base, got: { agent, hostname: { h: 1 } } });
    assert.match(x.title, /응답 '\?'/);
    assert.doesNotMatch(x.cause, /자신\(:4000\)/, '모르는 값을 자기 되돌림으로 판정하지 않는다');
  }
  const own = remedyFor({ ...base, got: { agent: 'az' } });
  assert.match(own.cause, /자신\(:4000\)으로 되돌아/, '대소문자 무시 판정은 그대로');
  const ctl = remedyFor({ ...base, got: { agent: 'X\r\nY', hostname: 'a\tb' } });
  assert.ok(!CTRL.test(ctl.title) && !CTRL.test(ctl.cause), JSON.stringify(ctl));
});

test('INJPKG-04 checks.remoteText — 문자열만 받고 제어 문자를 지우고 자른다', async () => {
  const { remoteText } = await import('../src/relaycheck/checks.js');
  assert.equal(remoteText(7), '');
  assert.equal(remoteText({ toString: () => 'x' }), '', '객체의 toString 을 부르지 않는다');
  assert.equal(remoteText(null), '');
  assert.equal(remoteText(' a\r\nb\t '), 'a  b');
  assert.equal(remoteText('x'.repeat(500), 128).length, 128);
});

// ─────────────────────────────── INJPKG-05 ───────────────────────────────
test('INJPKG-05 csvCell — 단독 CR 도 따옴표로 감싼다 · csvLine 은 csvCell 과 같은 결과(동작 불변)', async () => {
  const { csvCell, csvLine, guardCell } = await import('../src/util/csv.js');
  assert.equal(csvCell('a\rb'), '"a\rb"', '단독 CR 이 든 값은 따옴표 안에 있어야 행이 갈라지지 않는다');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=cmd'), "'=cmd", '수식 가드는 그대로');
  assert.equal(csvCell(-12.5), '-12.5');
  assert.equal(csvCell(null), '');
  // map(csvCell) 로 써도 index 가 끼어들지 않는다
  assert.deepEqual(['x', 'y,z'].map(csvCell), ['x', '"y,z"']);
  // csvLine 은 예전 구현과 같은 출력
  const old = (cells) => cells.map((c) => { const s = guardCell(c); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',');
  const samples = [['a', 1, null, undefined, 'b"c', 'd,e', 'f\rg', 'h\ni', '=1', '+82', '-3', '@x', '\tt', 0, -0.5, true]];
  for (const s of samples) assert.equal(csvLine(s), old(s));
});

test('INJPKG-05 스윕 — CSV 내보내기 라우트는 칸 이스케이프를 손으로 쓰지 않는다(공용 csvCell·csvLine)', () => {
  const ROUTES = path.join(SRC, 'routes');
  // 허용 목록 — 사유를 함께 적는다(조용한 예외 금지).
  const ALLOW = new Map([
    ['api/checksLogs.js', '값을 언제나 따옴표로 감싼다(`"${guardCell(v).replace(…)}"`) — CR·LF·쉼표 판정이 필요 없어 안전하다'],
  ]);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(ROUTES);
  const bad = [];
  for (const f of files) {
    const rel = path.relative(ROUTES, f).split(path.sep).join('/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // 따옴표 두 배 치환(CSV 칸 이스케이프의 표지) — 허용 목록 밖에는 0 이어야 한다
    const hits = src.split('\n').filter((l) => /\.replace\(\s*\/"\/g\s*,\s*'""'\s*\)/.test(l));
    if (hits.length && !ALLOW.has(rel)) bad.push(`${rel}: ${hits.map((h) => h.trim().slice(0, 120)).join(' | ')}`);
  }
  assert.deepEqual(bad, [], `손으로 쓴 CSV 칸 이스케이프가 있다 — util/csv.js csvCell/csvLine 을 쓸 것:\n${bad.join('\n')}`);
  // 허용 목록이 실재하는지(파일이 바뀌었는데 사유만 남지 않게)
  for (const rel of ALLOW.keys()) assert.ok(fs.existsSync(path.join(ROUTES, rel)), rel);
  // 이번에 고친 네 곳은 csvCell 을 쓴다
  for (const rel of ['api/ipamExport.js', 'api/hardwareGpu.js']) {
    const src = stripComments(fs.readFileSync(path.join(ROUTES, rel), 'utf8'));
    assert.equal((src.match(/const esc = csvCell;/g) || []).length, 2, `${rel}: 칸 이스케이프는 csvCell`);
  }
  // server/src 전체에서 CR 을 빠뜨린 칸 판정 정규식(/[",\n]/) 금지
  const all = [];
  const walkAll = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkAll(p); else if (e.name.endsWith('.js')) all.push(p); } };
  walkAll(SRC);
  const noCr = all.filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes('/[",\\n]/')).map((f) => path.relative(SRC, f));
  assert.deepEqual(noCr, [], 'CR 을 빠뜨린 CSV 칸 판정');
});

// ─────────────────────────────── WEB-04 ───────────────────────────────
test('WEB-04 pollLogsOnce — 진행 중이면 직전 결과가 아니라 busy · 끝난 결과는 수집 실패 vCenter 를 failed 로 밝힌다(상태에는 싣지 않는다)', async () => {
  const port = await closedPort();
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-x', name: 'X', host: `https://127.0.0.1:${port}`, username: 'u', password: 'p', timeoutMs: 3000 },
  ] }, null, 2));
  const { saveLogSettings } = await import('../src/logs/settings.js');
  saveLogSettings({ enabled: true });
  const P = await import('../src/logs/poller.js');
  const p1 = P.pollLogsOnce({ manual: true });
  const r2 = await P.pollLogsOnce({ manual: true });
  assert.equal(r2.busy, true, `진행 중에 들어온 요청은 busy 다(직전 결과·null 이 아니다): ${JSON.stringify(r2)}`);
  assert.ok(Number.isFinite(r2.runningSince), '진행 중인 수집이 언제 시작됐는지');
  assert.equal(r2.collected, undefined, '이번 요청은 수집하지 않았다 — 건수를 싣지 않는다');
  const r1 = await p1;
  assert.equal(r1.busy, undefined);
  assert.equal(r1.collected, 0);
  assert.ok(Array.isArray(r1.failed) && r1.failed.some((x) => x.vcenterId === 'vc-x' && typeof x.error === 'string' && x.error), `수집 실패를 밝힌다: ${JSON.stringify(r1)}`);
  const st = await P.logStatus();
  assert.equal(st.lastRun.failed, undefined, '상태(lastRun)에는 오류 원문을 싣지 않는다(범위 계정도 읽는다)');
  // 꺼져 있으면 skipped(수집하지 않음)
  saveLogSettings({ enabled: false });
  const r3 = await P.pollLogsOnce({ manual: true });
  assert.equal(r3.skipped, true);
  saveLogSettings({ enabled: true });
});

test('WEB-04 라우트 /vclogs/collect — pollLogsOnce 결과(busy·skipped·failed)를 그대로 싣는다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/admin/backupNetSec.js'), 'utf8'));
  const i = src.indexOf("'/vclogs/collect'");
  assert.ok(i > 0);
  const body = src.slice(i, i + 400);
  assert.match(body, /res\.json\(\{ ok: true, \.\.\.\(await pollLogsOnce\(\{ manual: true \}\)\) \}\)/, '결과를 펼쳐 싣는다(busy·skipped·failed 가 빠지지 않게)');
});
