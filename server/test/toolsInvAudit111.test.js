/**
 * test/toolsInvAudit111.test.js — 전체 점검 111회차(도구 · 용량 · 인벤토리 · 상태 모듈과 그 라우트).
 *
 * 확정 5건의 회귀:
 *  A1 고아 VMDK: 템플릿 구성 파일(.vmtx)만 있는 폴더의 디스크가 '소유 VM 없음(vmx 도 없음)' 으로 나왔다 → '미등록 VM 폴더'.
 *  A2 고아 VMDK: 경로 정규화의 '구분자 주변 공백' 정규식이 긴 공백 줄에서 O(n²)(vCenter 가 준 경로 — 길이 상한 없음) → 선형 + 같은 결과.
 *  B  VM 정밀 검색: 평균을 못 읽은 켜진 VM(성능 조회 실패 등)이 idle:false 라 화면이 '사용' 배지를 그렸다 → null(판정 불가) + idleUnknown.
 *  C  서비스 점검 '지표 샘플러': 기동 뒤 한 번도 적재하지 못해도 '정상 · 활성' 이었다 → 경계를 넘기면 warn(pollerCheck 와 같은 규칙).
 *  D  고아 VMDK 보류 창: `?recentHours=abc`(못 읽은 값)가 0 = '보류 끔' 이 됐다 → 기본 24시간. 0 은 명시적 0 만.
 *
 * ⚠ B · D 는 실제 api 라우터를 부른다(audit2733i_authStopGate 와 같은 하니스 — 가짜 vCenter 는 로그인만 통과하고 성능 조회는 실패한다).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit111-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const { findOrphanDisks, normDsPath, isVmConfigFile, fullPathOf, ownedPathSet, EXCLUDE_LABEL } = await import('../src/tools/orphanVmdk.js');
const { vmFinderIdle, orphanRecentHours, ORPHAN_RECENT_HOURS_DEFAULT } = await import('../src/routes/api/toolsCapacity.js');
const { metricsSamplerRow, pollerCheck } = await import('../src/health/services.js');

/* ───────────── A1 고아 VMDK — 템플릿(.vmtx) 폴더 ───────────── */

const NOW = Date.parse('2026-06-01T00:00:00Z');   // 순수 함수에 주입하는 기준 시각
const OLD = new Date(NOW - 40 * 86_400_000).toISOString();
const f = (folder, name, sizeBytes = 1000) => ({ folder, name, type: 'file', sizeBytes, modified: OLD });

test('A1: 템플릿 구성 파일(.vmtx)이 있는 폴더의 디스크는 소유 VM 없음이 아니라 미등록 VM 폴더다', () => {
  const files = [
    f('[ds1] tmpl-rocky9/', 'tmpl-rocky9.vmtx', 3000),
    f('[ds1] tmpl-rocky9/', 'tmpl-rocky9.vmdk', 600),
    f('[ds1] tmpl-rocky9/', 'tmpl-rocky9-flat.vmdk', 40e9),
    f('[ds1] TMPL-WIN/', 'win2022.VMTX', 3000),          // 대소문자 무시
    f('[ds1] TMPL-WIN/', 'win2022.vmdk', 600),
    f('[ds1] vm-a/', 'vm-a.vmx', 3000),                    // 예전부터 되던 .vmx
    f('[ds1] vm-a/', 'vm-a.vmdk', 600),
    f('[ds1] loose/', 'old.vmdk', 600),                    // 구성 파일이 없는 폴더 — 진짜 후보
    f('[ds1] notcfg/', 'notes.vmtx.bak', 10),              // 확장자가 아니다
    f('[ds1] notcfg/', 'x.vmdk', 600),
  ];
  const r = findOrphanDisks(files, new Set(), { now: NOW, recentHours: 24 });
  const by = Object.fromEntries(r.disks.map((d) => [d.folder, d]));
  assert.equal(by['[ds1] tmpl-rocky9/'].verdict, 'unregistered', '.vmtx 폴더는 미등록(템플릿) 폴더');
  assert.equal(by['[ds1] tmpl-rocky9/'].hasVmxInFolder, true);
  assert.equal(by['[ds1] tmpl-rocky9/'].reason, EXCLUDE_LABEL.unregistered);
  assert.equal(by['[ds1] TMPL-WIN/'].verdict, 'unregistered');
  assert.equal(by['[ds1] vm-a/'].verdict, 'unregistered');
  assert.equal(by['[ds1] loose/'].verdict, 'orphan', '구성 파일이 없는 폴더는 그대로 후보');
  assert.equal(by['[ds1] notcfg/'].verdict, 'orphan', "'.vmtx.bak' 은 구성 파일이 아니다");
  assert.equal(r.summary.orphanDisks, 2);
  assert.equal(r.summary.unregisteredDisks, 3);
  assert.match(EXCLUDE_LABEL.unregistered, /\.vmtx/, '사유 문구가 템플릿도 말한다');
  assert.equal(isVmConfigFile('a.vmx'), true);
  assert.equal(isVmConfigFile('a.vmtx'), true);
  assert.equal(isVmConfigFile('a.vmxf'), false);
  assert.equal(isVmConfigFile('a.vmdk'), false);
  assert.equal(isVmConfigFile(null), false);
});

/* ───────────── A2 경로 정규화 — 선형 + 예전과 같은 결과 ───────────── */

/** 수정 전 구현(대조용 — 작은 입력에만 쓴다). */
function normDsPathOld(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  s = s.replace(/^\[\s*([^\]]*?)\s*\]\s*\/*/, (_m, ds) => `[${ds}] `);
  s = s.replace(/\/{2,}/g, '/');
  s = s.replace(/\s*\/\s*/g, '/');
  return s.toLowerCase();
}

test('A2: 경로 정규화는 예전 구현과 같은 결과를 낸다(손으로 고른 경계 + 무작위 2,000건)', () => {
  const fixed = [
    '', '   ', '[ds1]', '[ds1] ', '[ ds1 ]  folder / x.vmdk', '[ds1] a / / b', '[ds1] a /  b', '[ds1]  / x', '[ds1] / /x',
    '[DS1] Folder\\Sub\\X.VMDK', 'a/ b', 'a /b', ' a / b ', '/', ' / ', 'a//b///c', '[ds1] a/\t b\n/ c', 'noslash  spaces',
    '[ds1] a /　b', '[ds] x/', '[ds] /x', '[]', '[ds1]//a', 'a/ /b/ / /c',
  ];
  for (const s of fixed) assert.equal(normDsPath(s), normDsPathOld(s), JSON.stringify(s));
  // 무작위: 경로에 나올 만한 글자 + 공백 · 슬래시 · 대괄호를 섞는다(시드 고정 — 재현 가능).
  let seed = 111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ALPHA = ['a', 'B', ' ', ' ', '/', '/', '\\', '[', ']', '\t', '.', '-', 'x'];
  for (let i = 0; i < 2000; i++) {
    let s = '';
    const n = Math.floor(rnd() * 24);
    for (let j = 0; j < n; j++) s += ALPHA[Math.floor(rnd() * ALPHA.length)];
    assert.equal(normDsPath(s), normDsPathOld(s), JSON.stringify(s));
  }
  // 소유 판정이 깨지지 않는다 — 브라우저 표기와 layoutEx 표기가 같은 키가 된다.
  const owned = ownedPathSet([['[DS1] Folder / Sub/X.vmdk']]);
  assert.ok(owned.has(fullPathOf('[ds1] folder/sub/', 'x.vmdk')));
});

test('A2: 경로 정규화는 긴 공백 줄에서 선형 시간이다(크기 8배 · 번갈아 5회 최솟값 · 기준 24배)', () => {
  const mk = (n) => `[ds1] a${' '.repeat(n)}b/c.vmdk`;
  // 크기: 20만 → 160만 자(실측 약 6ms → 50ms · 비율 7.3~8.5). 4만 → 32만 자는 캐시 경계를 넘어 선형인데도 18~20배가 나왔다 — 쓰지 않는다.
  const SMALL = 200_000; const BIG = SMALL * 8; const REPS = 20;
  // 빠른 실패 — 제곱 구현은 4만 자 한 번에 1초가 넘는다(선형은 1ms 미만). 아래 비율 측정이 수 시간 걸리지 않게 먼저 거른다.
  const t0 = performance.now(); normDsPath(mk(40_000)); const one = performance.now() - t0;
  assert.ok(one < 400, `4만 자 한 번에 ${Math.round(one)}ms — 선형이 아니다`);
  const a = mk(SMALL); const b = mk(BIG);
  const timeOf = (s) => { const t = performance.now(); for (let i = 0; i < REPS; i++) normDsPath(s); return performance.now() - t; };
  let minS = Infinity; let minB = Infinity;
  for (let i = 0; i < 5; i++) { minS = Math.min(minS, timeOf(a)); minB = Math.min(minB, timeOf(b)); }
  const ratio = minB / Math.max(minS, 0.01);
  assert.ok(ratio < 24, `8배 크기에 ${ratio.toFixed(1)}배(${minS.toFixed(2)}ms → ${minB.toFixed(2)}ms) — 선형(약 8배)이 아니다`);
});

/* ───────────── B VM 정밀 검색 유휴 판정 ───────────── */

test('B: vmFinderIdle — 평균을 못 읽으면 사유와 무관하게 null, 읽었으면 켜져 있고 기준 이하일 때만 유휴', () => {
  assert.equal(vmFinderIdle({ powerState: 'POWERED_ON' }, null, 5), null, '못 읽은 평균은 사용(false)이 아니다');
  assert.equal(vmFinderIdle({ powerState: 'POWERED_ON' }, undefined, 5), null);
  assert.equal(vmFinderIdle({ powerState: 'POWERED_OFF' }, null, 5), null);
  assert.equal(vmFinderIdle({ powerState: 'POWERED_ON' }, 0, 5), true, '보고된 0 은 값이다');
  assert.equal(vmFinderIdle({ powerState: 'POWERED_ON' }, 5, 5), true);
  assert.equal(vmFinderIdle({ powerState: 'POWERED_ON' }, 5.1, 5), false);
  assert.equal(vmFinderIdle({ powerState: 'POWERED_OFF' }, 0, 5), false, '꺼진 VM 은 유휴가 아니다(예전 그대로)');
});

/* ───────────── C 서비스 점검 '지표 샘플러' 행 ───────────── */

const MIN = 60_000;
test("C: 지표 샘플러 행 — 실행 기록이 없는데 기동 후 경계를 넘겼으면 warn(예전에는 끝까지 '정상')", () => {
  const now = 1_800_000_000_000;
  // 한 번도 적재하지 못했다 + 기동 2시간 → 경고
  let r = metricsSamplerRow({ intervalMs: 60_000, lastRun: null }, { now, uptimeMs: 120 * MIN });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /실행 기록 없음\(기동 120분\)/);
  assert.match(r.detail, /한 번도 돌지 않았습니다/);
  assert.equal(r.at, now);
  // 기동 직후(경계 전)는 아직 정상 — 첫 샘플은 기동 12초 뒤다
  r = metricsSamplerRow({ intervalMs: 60_000, lastRun: null }, { now, uptimeMs: 5 * MIN });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail, '활성');
  // 경계는 주기의 2배(최소 30분) — 주기 2시간이면 4시간까지 기다린다
  assert.equal(metricsSamplerRow({ intervalMs: 120 * MIN, lastRun: null }, { now, uptimeMs: 180 * MIN }).status, 'ok');
  assert.equal(metricsSamplerRow({ intervalMs: 120 * MIN, lastRun: null }, { now, uptimeMs: 241 * MIN }).status, 'warn');
  // 같은 입력의 공통 판정(pollerCheck)과 같은 결론
  assert.equal(pollerCheck({ intervalMs: 60_000, lastRun: null }, { now, uptimeMs: 120 * MIN }).status, 'warn');
  // 예전 동작은 그대로: 최근 실행 → 정상 · 오래됨 → 경고 · { at } 객체 · 꺼짐
  r = metricsSamplerRow({ intervalMs: 60_000, lastRun: { at: now - 10 * MIN, rows: 9 } }, { now, uptimeMs: 600 * MIN });
  assert.deepEqual(r, { status: 'ok', detail: '활성 · 최근 10분 전', at: now - 10 * MIN });
  r = metricsSamplerRow({ intervalMs: 60_000, lastRun: { at: now - 180 * MIN } }, { now, uptimeMs: 600 * MIN });
  assert.equal(r.status, 'warn');
  assert.equal(r.detail, '활성 · 최근 180분 전');
  r = metricsSamplerRow({ intervalMs: 120 * MIN, lastRun: { at: now - 180 * MIN } }, { now, uptimeMs: 600 * MIN });
  assert.equal(r.status, 'ok', '주기 2시간이면 3시간 전은 아직 경계 안');
  r = metricsSamplerRow({ enabled: false, lastRun: null }, { now, uptimeMs: 600 * MIN });
  assert.deepEqual(r, { status: 'off', detail: '비활성', at: now });
  // 상태를 못 받았어도 던지지 않는다
  assert.equal(metricsSamplerRow(null, { now, uptimeMs: 1 * MIN }).status, 'ok');
});

test('C: getServiceCheck 의 지표 샘플러 행이 그 함수로 만들어진다(기동 직후 — 실행 기록 없음은 아직 정상)', async () => {
  const { getServiceCheck } = await import('../src/health/services.js');
  const row = getServiceCheck().checks.find((c) => c.key === 'metrics');
  assert.ok(row, '지표 샘플러 행이 있다');
  assert.equal(row.label, '지표 샘플러');
  assert.equal(row.specKey, 'collect.metrics');
  assert.equal(row.status, 'ok');
  assert.equal(row.detail, '활성');
});

/* ───────────── D 고아 VMDK 보류 창 해석 ───────────── */

test("D: orphanRecentHours — 못 읽은 값은 0('보류 끔')이 아니라 기본 24시간, 0 은 명시적 0 만", () => {
  assert.equal(ORPHAN_RECENT_HOURS_DEFAULT, 24);
  assert.equal(orphanRecentHours(undefined), 24);
  assert.equal(orphanRecentHours('abc'), 24, '글자는 못 읽은 값');
  assert.equal(orphanRecentHours(''), 24, '빈 값은 못 읽은 값');
  assert.equal(orphanRecentHours('  '), 24);
  assert.equal(orphanRecentHours(['1', '2']), 24);
  assert.equal(orphanRecentHours('-5'), 24, '음수는 끔이 아니다');
  assert.equal(orphanRecentHours('NaN'), 24);
  assert.equal(orphanRecentHours('0'), 0, '명시적 0 은 보류 끔');
  assert.equal(orphanRecentHours(0), 0);
  assert.equal(orphanRecentHours('72'), 72);
  assert.equal(orphanRecentHours('0.5'), 0.5);
  assert.equal(orphanRecentHours('9999'), 720, '상한 720시간');
});

/* ───────────── B · D 실제 라우트 ───────────── */

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<perfManager type="PerformanceManager">PerfMgr</perfManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);

/** 가짜 vCenter — 로그인은 통과하고 그 뒤 호출은 전부 NotSupported(자격증명 거부가 아닌 실패 = 평균을 못 읽는다). */
async function fakeVcenter() {
  const st = { logins: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) { st.logins += 1; return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      return send(500, FAULT('NotSupported', 'not supported in this fake'));
    }
    if (req.url === '/api/session') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

let base; let store; let VC;
const VMS = [
  { id: 'vc-g:vm-1', vcenterId: 'vc-g', name: 'g1', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, host: 'h1', cpuCount: 2, memMB: 4096 },
  { id: 'vc-g:vm-2', vcenterId: 'vc-g', name: 'g2', powerState: 'POWERED_ON', cpuUsagePct: 1, memUsagePct: 5, host: 'h1', cpuCount: 2, memMB: 4096 },
  { id: 'vc-g:vm-3', vcenterId: 'vc-g', name: 'g3', powerState: 'POWERED_OFF', cpuUsagePct: null, memUsagePct: null, host: 'h1', cpuCount: 2, memMB: 4096 },
  // 이 포탈에 접속 정보가 없는 vCenter 의 VM(엣지만 아는 vCenter) — 평균을 조회하지 못한다
  { id: 'vc-x:vm-9', vcenterId: 'vc-x', name: 'x9', powerState: 'POWERED_ON', cpuUsagePct: 3, memUsagePct: 5, host: 'hx', cpuCount: 2, memMB: 4096 },
];
before(async () => {
  VC = await fakeVcenter();
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-g', name: 'VC-G', host: VC.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
  ] }));
  ({ store } = await import('../src/store.js'));
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-g', name: 'VC-G', status: 'connected' }, { id: 'vc-x', name: 'VC-X', status: 'connected' }],
    vms: VMS, hosts: [], datastores: [{ id: 'vc-g:datastore-1', vcenterId: 'vc-g', name: 'ds1', capacityGB: 100, usedGB: 10, freeGB: 90 }], networks: [], alarms: [],
  };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
const call = async (m, p, body) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j };
};

test("B(라우트): vm-finder withAvg — 성능 조회가 실패한 켜진 VM 은 idle:null 이다('사용' 이 아니다) · idleUnknown 으로 센다", async () => {
  const r = await call('POST', '/api/tools/vm-finder', { withAvg: true });
  assert.equal(r.status, 200);
  assert.ok(VC.st.logins > 0, '가짜 vCenter 에 실제로 로그인했다(성능 조회는 그 뒤에 실패한다)');
  assert.equal(r.j.items.length, 4);
  assert.equal(r.j.avgComputed, true);
  for (const it of r.j.items) {
    assert.equal(it.avgDayCpu, null, `${it.name}: 평균을 지어내지 않는다`);
    assert.equal(it.avgWeekCpu, null);
    assert.equal(it.idle, null, `${it.name}(${it.powerState}): 평균을 못 읽었으면 판정 불가 — 예전에는 false('사용')였다`);
  }
  assert.equal(r.j.idleCount, 0);
  assert.equal(r.j.idleUnknown, 4, '판정하지 않은 VM 수를 따로 센다');
  assert.deepEqual(r.j.authStopped, {}, '자격증명 거부가 아니다 — 인증 정지 사유로 가리지 않는다');
  assert.equal(r.j.avgNotQueried, 0);
});

test("D(라우트): /tools/orphan-vmdk — 못 읽은 recentHours 는 기본 24시간으로 스캔한다(0 은 명시적 0 만)", async () => {
  const prev = store.snapshot;
  store.snapshot = { ...prev, source: 'mock' };   // 데모 경로 — vCenter 에 닿지 않고 적용된 보류 창(recentHours)을 그대로 돌려준다
  try {
    const q = (v) => call('GET', `/api/tools/orphan-vmdk?datastoreId=${encodeURIComponent('vc-g:datastore-1')}${v == null ? '' : `&recentHours=${v}`}`);
    let r = await q(null);
    assert.equal(r.status, 200);
    assert.equal(r.j.mock, true);
    assert.equal(r.j.recentHours, 24);
    r = await q('abc');
    assert.equal(r.j.recentHours, 24, "글자는 '보류 끔' 이 아니다");
    r = await q('');
    assert.equal(r.j.recentHours, 24, "빈 값은 '보류 끔' 이 아니다");
    r = await q('0');
    assert.equal(r.j.recentHours, 0, '명시적 0 은 그대로');
    r = await q('72');
    assert.equal(r.j.recentHours, 72);
    r = await q('99999');
    assert.equal(r.j.recentHours, 720);
  } finally { store.snapshot = prev; }
});
