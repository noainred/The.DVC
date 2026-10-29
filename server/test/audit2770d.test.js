/**
 * v2.770(점검 R5 — G4 iDRAC·PDU 임계치·복원 경고·아이실론) 회귀 테스트.
 *  E4-01 인증서 미신뢰(tlsUntrusted) iDRAC 은 replace-datacenter 를 merge 로 강등한다(실재 장비 — authFailed 와 같은 근거).
 *        일반 무응답은 강등하지 않는다(폐기 서버 정리) — 대신 교체로 지운 등록 IP 를 결과·감사 로그에 남긴다.
 *  E4-02 등록부 가져오기·수정이 같은 주소를 스킴 없이 보내도 '접속처 이동' 이 아니다(http↔https 는 이동) · 가져오기 응답에 droppedSecrets ·
 *        CSV 병합이 헤더에 없는 열(serviceTag·vcenterId·hostNames)을 지우지 않는다.
 *  E1-1  중앙 → 엣지 PDU 임계치는 관리자가 바꾼 키(_assigned)만 · enabled 는 배포하지 않는다 · 표지 없는 파일·파일 없음은 {}(중앙 지정 없음).
 *  E1-2  복원 경고 {file, reason} 객체를 문구로('[object Object]' 금지) — 문자열 경고(백업 생성)도 받는다.
 *  E1-5  isidu 옛 상태 호환으로 찾은 '마지막으로 보낸 조사' 를 scanSentScanTs/Id 로 굳힌다(업그레이드 뒤 두 번째 조사에서 한 통 더 금지).
 * 기준 시각은 실제 시각을 정시 경계에서 30분 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2770d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
delete process.env.PDU_THRESHOLDS_LOCAL;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const u = (p) => pathToFileURL(path.join(SRC, p)).href;

const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;

const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const quiet = async (fn) => {
  const w = console.warn; const l = console.log; const e = console.error;
  console.warn = () => {}; console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; console.error = e; }
};

/* ═══════════════════════════ E4-01 iDRAC 스캔 교체 ═══════════════════════════ */

const SCAN = await import('../src/idrac/scan.js');

test('E4-01 scanPartialReasons — 인증서 미신뢰는 부분 결과(강등), 일반 무응답은 아니다', () => {
  assert.deepEqual(SCAN.scanPartialReasons({ unreachable: 1, tlsUntrusted: 1 }), ['장비 인증서 미신뢰 1대'], '수정 전: tlsUntrusted 를 보지 않아 [] — replace 가 그 등록을 지웠다');
  assert.deepEqual(SCAN.scanPartialReasons({ unreachable: 3, tlsUntrusted: 0 }), [], '일반 무응답까지 강등하면 폐기 서버를 영원히 못 지운다');
  assert.deepEqual(SCAN.scanPartialReasons({ unreachable: 3 }), [], '옛 결과(필드 없음)는 예전 그대로');
});

/** 자식 프로세스: redfish.js probeIdrac·poller.js 를 가짜로 바꾸고 실제 runLocalIdracScan(엣지 경로) → registerScanned → importServers 를 돈다. */
async function runScanChild() {
  const cfg = fs.mkdtempSync(path.join(DIR, 'scan-'));
  const stub = (names, override) => '{' + names.map((n) => `${JSON.stringify(n)}: ${override[n] || (/^[A-Z_]+$/.test(n) ? '0' : "() => { throw new Error('stub'); }")}`).join(', ') + '}';
  const rfNames = Object.keys(await import('../src/idrac/redfish.js'));
  const plNames = Object.keys(await import('../src/idrac/poller.js'));
  const probe = `async (ip) => {
    const k = globalThis.__probe[ip];
    if (k === 'tls') return { ok: false, tlsUntrusted: true, vendor: 'dell', redfish: true, reason: '장비 인증서를 신뢰할 수 없어 연결을 끊었습니다' };
    if (k === 'idrac') return { ok: true, isIdrac: true, vendor: 'dell', redfish: true, serviceTag: 'TAG' + ip.split('.').pop(), hostName: 'esx-' + ip.split('.').pop() };
    return { ok: false, reason: 'timeout' };
  }`;
  const script = `
    import { mock } from 'node:test';
    globalThis.__probe = { '10.9.0.11': 'tls', '10.9.0.12': 'idrac', '10.9.0.13': 'down' };
    mock.module(${JSON.stringify(u('idrac/redfish.js'))}, { namedExports: ${stub(rfNames, { probeIdrac: probe })} });
    mock.module(${JSON.stringify(u('idrac/poller.js'))}, { namedExports: ${stub(plNames, { pollNow: 'async () => ({})' })} });
    const reg = await import(${JSON.stringify(u('idrac/registry.js'))});
    const { runLocalIdracScan } = await import(${JSON.stringify(u('idrac/localScan.js'))});
    console.warn = () => {}; console.log = () => {};
    const ips = '10.9.0.11\\n10.9.0.12\\n10.9.0.13';
    reg.registerScanned(['10.9.0.11', '10.9.0.12', '10.9.0.13'].map((ip) => ({ ip, serviceTag: 'T' + ip, hostName: 'h' + ip })), 'root', 'pw', 'replace-datacenter', '', 'DC1', { scanRangeId: 'r1', scanRanges: ips });
    const a = await runLocalIdracScan({ ips, username: 'root', password: 'pw', mode: 'replace-datacenter', datacenterId: 'DC1', rangeId: 'r1' });
    const afterA = reg.loadRegistry().map((s) => s.id).sort();
    globalThis.__probe['10.9.0.11'] = 'down';   // 인증서 문제가 아니라 그냥 무응답(폐기 서버)
    const b = await runLocalIdracScan({ ips, username: 'root', password: 'pw', mode: 'replace-datacenter', datacenterId: 'DC1', rangeId: 'r1' });
    const afterB = reg.loadRegistry().map((s) => s.id).sort();
    const pick = (r) => ({ modeDowngraded: r.modeDowngraded, modeDowngradedReason: r.modeDowngradedReason || '', unreachable: r.unreachable, tlsUntrusted: r.tlsUntrusted, tlsUntrustedIps: r.tlsUntrustedIps, removed: r.removed || 0, removedIps: r.removedIps || [] });
    process.stdout.write('\\n@@' + JSON.stringify({ a: pick(a), afterA, b: pick(b), afterB }));
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-sqlite', '--input-type=module', '-e', script],
    { env: { ...process.env, CONFIG_DIR: cfg, NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 60_000 });
  const i = String(res.stdout).lastIndexOf('@@');
  assert.ok(i >= 0, `자식 실패: ${res.stderr}\n${res.stdout}`);
  const audit = fs.existsSync(path.join(cfg, 'audit.ndjson')) ? fs.readFileSync(path.join(cfg, 'audit.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...JSON.parse(res.stdout.slice(i + 2)), audit };
}

test('E4-01 실제 runLocalIdracScan — 인증서가 바뀐 등록 서버는 지우지 않고(merge 강등), 일반 무응답 교체는 지운 IP 를 결과·감사 로그에 남긴다', async () => {
  const r = await runScanChild();
  assert.equal(r.a.tlsUntrusted, 1);
  assert.deepEqual(r.a.tlsUntrustedIps, ['10.9.0.11']);
  assert.equal(r.a.unreachable, 2, '무응답 집계(화면 뜻)는 그대로 — 인증서 미신뢰는 그 부분집합');
  assert.equal(r.a.modeDowngraded, true, `수정 전: 강등하지 않아 인증서가 바뀐 서버가 지워졌다 — ${JSON.stringify(r.a)}`);
  assert.match(r.a.modeDowngradedReason, /장비 인증서 미신뢰 1대/);
  assert.deepEqual(r.afterA, ['10.9.0.11', '10.9.0.12', '10.9.0.13'], '강등(merge)이면 아무것도 지우지 않는다');
  // 인증서 문제가 아닌 일반 무응답 — replace 그대로(폐기 서버 정리), 지운 것을 밝힌다.
  assert.equal(r.b.modeDowngraded, false, '일반 무응답은 강등하지 않는다');
  assert.deepEqual(r.afterB, ['10.9.0.12']);
  assert.equal(r.b.removed, 2);
  assert.deepEqual([...r.b.removedIps].sort(), ['10.9.0.11', '10.9.0.13'], '수정 전: 지운 IP 가 결과에 없었다');
  const line = r.audit.find((x) => x.action === 'idrac.scan.replace.removed');
  assert.ok(line, `감사 로그에 교체 삭제가 남아야 한다 — ${JSON.stringify(r.audit)}`);
  assert.match(line.detail, /10\.9\.0\.11/); assert.match(line.detail, /10\.9\.0\.13/);
  assert.match(line.target, /DC1/);
  assert.equal(r.audit.filter((x) => x.action === 'idrac.scan.replace.removed').length, 1, '지운 것이 없는 교체(강등 포함)는 감사 줄을 남기지 않는다');
});

test('E4-01 배선 — 중앙 직접 스캔(scanPoller)도 같은 판정 코어 · 지운 IP·인증서 미신뢰를 스캔 로그에 싣는다', () => {
  const sp = stripComments(read('idrac/scanPoller.js'));
  assert.match(sp, /scanPartialReasons\(r, \{ registeredHpe/);
  assert.match(sp, /removedIps = Array\.isArray\(reg\.removedIds\)/);
  assert.match(sp, /tlsUntrusted: r\.tlsUntrusted \|\| 0/);
  const sl = stripComments(read('idrac/scanLog.js'));
  assert.match(sl, /tlsUntrusted: n\(rec\.tlsUntrusted\)/);
  assert.match(sl, /removedIps:/);
});

/* ═══════════════════════════ E4-02 iDRAC 등록부 스킴·CSV 병합 ═══════════════════════════ */

const REG = await import('../src/idrac/registry.js');

test('E4-02 같은 주소를 스킴 없이 — 비밀번호 유지 · CSV 병합이 헤더에 없는 열을 지우지 않는다 · http↔https 는 여전히 이동', () => {
  REG.importServers([{ id: 'srv1', name: 'esx01-idrac', host: '10.0.0.5', username: 'root', password: 'S3cret!', serviceTag: 'ABC1234', vcenterId: 'vc1', hostNames: ['esx01'] }], 'merge');
  const r = REG.importServers(REG.parseCsv('id,name,host,username\nsrv1,esx01-idrac,10.0.0.5,root\n'), 'merge');
  assert.equal(r.ok, true);
  const s1 = REG.loadRegistry().find((s) => s.id === 'srv1');
  assert.equal(s1.host, 'https://10.0.0.5');
  assert.equal(!!s1.password, true, '수정 전: 원문 host 와 비교해 이동으로 판정 — 비밀번호 삭제');
  assert.ok(!('droppedSecrets' in r), '버린 것이 없으면 싣지 않는다');
  assert.equal(s1.serviceTag, 'ABC1234', '수정 전: 열이 없는데 "" 로 덮었다');
  assert.equal(s1.vcenterId, 'vc1');
  assert.deepEqual(s1.hostNames, ['esx01']);
  // 열이 있으면(빈 값이어도) 그 값으로 바꾼다 — 예전 동작.
  REG.importServers(REG.parseCsv('id,name,host,username,serviceTag\nsrv1,esx01-idrac,10.0.0.5,root,\n'), 'merge');
  assert.equal(REG.loadRegistry().find((s) => s.id === 'srv1').serviceTag, '');

  // 수정(updateServer)도 같은 판정.
  REG.importServers([{ id: 'srv2', name: 'n2', host: 'https://10.0.0.6', username: 'root', password: 'pw2' }], 'merge');
  const u1 = REG.updateServer('srv2', { name: 'n2-renamed', host: '10.0.0.6/', username: 'root' });
  assert.deepEqual(u1.droppedSecrets, [], '스킴 없음·끝 슬래시는 같은 주소');
  assert.equal(!!REG.loadRegistry().find((s) => s.id === 'srv2').password, true);
  const u2 = REG.updateServer('srv2', { host: 'http://10.0.0.6', username: 'root' });
  assert.deepEqual(u2.droppedSecrets, ['password'], 'http↔https 는 접속처 이동 — 비밀번호를 승계하지 않는다');
  assert.equal(!!REG.loadRegistry().find((s) => s.id === 'srv2').password, false);

  // 가져오기가 실제로 버렸으면 응답이 말한다.
  REG.importServers([{ id: 'srv3', name: 'n3', host: '10.0.0.7', username: 'root', password: 'pw3' }], 'merge');
  const moved = REG.importServers([{ id: 'srv3', name: 'n3', host: '10.0.0.8', username: 'root' }], 'merge');
  assert.deepEqual(moved.droppedSecrets, [{ id: 'srv3', keys: ['password'] }], '수정 전: importServers 가 droppedSecrets 를 버렸다');
  assert.equal(!!REG.loadRegistry().find((s) => s.id === 'srv3').password, false);
});

test('E4-02 parseCsv — 헤더에 없는 열은 키를 만들지 않는다(있으면 예전 값 그대로)', () => {
  const [a] = REG.parseCsv('name,host,username\nx,10.0.0.9,root\n');
  assert.ok(!('serviceTag' in a) && !('vcenterId' in a) && !('hostNames' in a), JSON.stringify(a));
  const [b] = REG.parseCsv('name,host,username,service_tag,vcenter,esxi\nx,10.0.0.9,root,TAG9,vc9,e1;e2\n');
  assert.equal(b.serviceTag, 'TAG9'); assert.equal(b.vcenterId, 'vc9'); assert.deepEqual(b.hostNames, ['e1', 'e2']);
  // replace 가져오기는 기존 값을 쓰지 않으므로 열이 없으면 예전처럼 빈 값이다.
  const rr = REG.importServers(REG.parseCsv('id,name,host,username,password\nsrvR,r,10.0.0.10,root,pw\n'), 'replace');
  assert.equal(rr.ok, true);
  const s = REG.loadRegistry().find((x) => x.id === 'srvR');
  assert.equal(s.serviceTag, ''); assert.deepEqual(s.hostNames, []);
});

/* ═══════════════════════════ E1-1 PDU 임계치 배포 ═══════════════════════════ */

const TH = await import('../src/pdu/thresholds.js');
const thFile = path.join(DIR, 'pdu-thresholds.json');

test('E1-1 중앙은 관리자가 바꾼 키만 보낸다(enabled 제외) — 엣지 현장값·enabled 를 덮지 않는다', () => {
  fs.rmSync(thFile, { force: true }); TH._resetForTest();
  assert.deepEqual(TH.thresholdsForEdge(), {}, '파일 없음 = 중앙 지정 없음({})');
  TH.saveThresholds({ powerWarnW: 5000, enabled: false });
  const sent = TH.thresholdsForEdge();
  assert.deepEqual(sent, { powerWarnW: 5000 }, `수정 전: 기본값을 채운 전체 + enabled:false — ${JSON.stringify(sent)}`);
  const raw = JSON.parse(fs.readFileSync(thFile, 'utf8'));
  assert.deepEqual(raw._assigned, ['powerWarnW']);
  assert.ok(!('_assigned' in TH.loadThresholds()), '예약 키는 실효 임계치에 섞이지 않는다');
  assert.equal(TH.loadThresholds().enabled, false, '중앙 자신은 enabled:false 로 동작');
  // 화면(PduTool)은 늘 전 키를 문자열로 보낸다 — 바뀌지 않은 키는 지정이 아니다.
  const web = { enabled: false, tempWarnC: '27', tempCritC: '32', humLowPct: '20', humHighPct: '70', powerWarnW: '5000', powerCritW: '', bankWarnA: '12', bankCritA: '14.4' };
  TH.saveThresholds(web);
  assert.deepEqual(TH.thresholdsForEdge(), { powerWarnW: 5000 });
  TH.saveThresholds({ ...web, tempWarnC: '29' });
  assert.deepEqual(TH.thresholdsForEdge(), { tempWarnC: 29, powerWarnW: 5000 });
  TH.saveThresholds({ ...web, tempWarnC: '27' });
  assert.deepEqual(TH.thresholdsForEdge(), { tempWarnC: 27, powerWarnW: 5000 }, '한 번 지정한 키는 기본값으로 되돌려도 중앙 지정');

  // 엣지: 현장 파일(32A 뱅크·더운 DC) + 중앙 배포분.
  const sentNow = JSON.parse(JSON.stringify(TH.thresholdsForEdge()));
  fs.writeFileSync(thFile, JSON.stringify({ enabled: true, tempWarnC: 35, bankWarnA: 24, bankCritA: 28.8 }));
  TH._resetForTest();
  TH.applyCentralThresholds(sentNow);
  const eff = TH.loadThresholds();
  assert.equal(eff.enabled, true, '수정 전: 중앙 enabled:false 가 엣지 경보를 껐다');
  assert.equal(eff.bankWarnA, 24, '수정 전: 엣지 현장 뱅크 임계를 중앙 기본값(12)으로 덮었다');
  assert.equal(eff.bankCritA, 28.8);
  assert.equal(eff.tempWarnC, 27, '중앙이 지정한 키는 중앙 값');
  assert.equal(eff.powerWarnW, 5000);
  fs.rmSync(thFile, { force: true }); TH._resetForTest();
});

test('E1-1 표지 없는 옛 파일 → {} · 엣지는 {} 로 v2.769 가 넣은 전체 세트를 지우고, enabled 는 중앙에서 받지 않는다', () => {
  TH._resetForTest();
  // v2.769 중앙이 엣지에 넣어 둔 전체 세트(엣지 메모리).
  fs.writeFileSync(thFile, JSON.stringify({ enabled: true, tempWarnC: 35, bankWarnA: 24 }));
  TH.applyCentralThresholds({ ...TH.DEFAULTS, enabled: false, powerWarnW: 4000 });
  assert.equal(TH.loadThresholds().enabled, true, '중앙이 보낸 enabled 는 받지 않는다(옛 중앙 대비)');
  assert.equal(TH.loadThresholds().bankWarnA, 12, '(v2.769 중앙의 전체 세트는 아직 덮는다 — 아래 {} 로 풀린다)');
  // 중앙: 표지 없는 v2.769 파일.
  const edgeFile = fs.readFileSync(thFile, 'utf8');
  fs.writeFileSync(thFile, JSON.stringify({ ...TH.DEFAULTS, enabled: false, powerWarnW: 4000 }));
  const fromLegacy = TH.thresholdsForEdge();
  assert.deepEqual(fromLegacy, {}, '표지 없는 옛 파일은 아무 키도 보내지 않는다 — null 이 아니라 {}');
  fs.writeFileSync(thFile, edgeFile);
  assert.equal(TH.applyCentralThresholds(fromLegacy), true, '바뀌었다');
  assert.equal(TH.centralThresholdsApplied(), null, '{} = 중앙 지정 없음');
  const eff = TH.loadThresholds();
  assert.equal(eff.bankWarnA, 24, '수정 전: null 이라 엣지가 직전(전체 세트)을 유지했다');
  assert.equal(eff.tempWarnC, 35);
  assert.equal(eff.powerWarnW, null);
  assert.equal(TH.applyCentralThresholds({}), false, '같은 {} 는 변화 없음');
  // 손상 파일은 여전히 null(호출부는 thresholdsUnreadable — 엣지 직전 값 유지).
  fs.writeFileSync(thFile, '{ 손상');
  assert.equal(quietSync(() => TH.thresholdsForEdge()), null);
  fs.rmSync(thFile, { force: true });
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('pdu-thresholds.json.corrupt')) fs.rmSync(path.join(DIR, f), { force: true });
  TH._resetForTest();
});
function quietSync(fn) { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } }

test('E1-1 실제 엣지 pull — 중앙이 {} 를 보내면 직전 중앙 임계치를 지우고, 필드가 없으면(옛 중앙) 직전 값을 유지한다', async () => {
  TH._resetForTest();
  fs.writeFileSync(thFile, JSON.stringify({ bankWarnA: 24 }));
  const { config } = await import('../src/config.js');
  const pull = await import('../src/agent/pduConfigPull.js');
  let reply = { ok: true, devices: [], collectNow: [], intervals: {}, thresholds: { bankWarnA: 12, enabled: false } };
  const fake = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(q.url.startsWith('/api/central/pdu-config') ? reply : { ok: true })); });
  closers.push(() => new Promise((r) => fake.close(() => r())));
  const fport = await listen(fake);
  const keep = { u: config.agent.centralUrl, t: config.agent.centralToken, n: config.agent.name };
  Object.assign(config.agent, { centralUrl: `http://127.0.0.1:${fport}`, centralToken: 'x', name: 'edge-th' });
  try {
    await quiet(() => pull.pullPduConfigNow());
    assert.equal(TH.loadThresholds().bankWarnA, 12);
    assert.equal(TH.loadThresholds().enabled, true, '중앙 enabled 는 받지 않는다');
    reply = { ok: true, devices: [], collectNow: [], intervals: {} };
    await quiet(() => pull.pullPduConfigNow());
    assert.equal(TH.loadThresholds().bankWarnA, 12, '필드 없음(옛 중앙) = 직전 값 유지');
    reply = { ok: true, devices: [], collectNow: [], intervals: {}, thresholds: {} };
    const r = await quiet(() => pull.pullPduConfigNow());
    assert.equal(r.thresholdsApplied, true);
    assert.equal(TH.loadThresholds().bankWarnA, 24, '{} = 중앙 지정 없음 → 엣지 파일');
    await pull.pduCollectJobSettled();
  } finally { Object.assign(config.agent, { centralUrl: keep.u, centralToken: keep.t, name: keep.n }); fs.rmSync(thFile, { force: true }); TH._resetForTest(); }
});

test('E1-1 배선 — pdu-config 는 thresholdsForEdge 의 {} 도 싣는다(if (th) — {} 는 참)', () => {
  const central = stripComments(read('routes/central.js'));
  const seg = central.slice(central.indexOf("centralRouter.get('/pdu-config'"), central.indexOf("centralRouter.post('/pdu-data'"));
  assert.match(seg, /const th = thresholdsForEdge\(\); if \(th\) thPart = \{ thresholds: th \}/);
});

/* ═══════════════════════════ E1-2 복원 경고 문구 ═══════════════════════════ */

test('E1-2 복원 경고 {file, reason} → 문구 · 문자열(백업 생성)도 · 라우트가 이 함수로 만든다', async () => {
  const { backupWarnText } = await import('../src/routes/admin/backupNetSec.js');
  assert.equal(backupWarnText({ file: 'central-agent-tokens.json', reason: '엣지 토큰 1개(pl)가 되살아납니다' }), 'central-agent-tokens.json: 엣지 토큰 1개(pl)가 되살아납니다');
  assert.equal(backupWarnText('번들 크기가 상한을 넘어 엣지 사본을 뺐습니다'), '번들 크기가 상한을 넘어 엣지 사본을 뺐습니다');
  assert.equal(backupWarnText({ reason: '사유만' }), '사유만');
  for (const bad of [null, undefined, 7, {}, { file: 1, reason: {} }]) assert.equal(backupWarnText(bad), '');
  // 실제 서버 모양(stagedRestore 적용 경고)으로.
  const cfg = fs.mkdtempSync(path.join(DIR, 'bk-'));
  fs.mkdirSync(path.join(cfg, 'backups'), { recursive: true });
  const { stageRestore, applyStagedRestore } = await import('../src/backup/stagedRestore.js');
  fs.writeFileSync(path.join(cfg, 'central-agent-tokens.json'), JSON.stringify({ tokens: [{ agent: 'kr', hash: 'aa' }] }));
  await quiet(async () => stageRestore({ 'central-agent-tokens.json': JSON.stringify({ tokens: [{ agent: 'kr', hash: 'bb' }, { agent: 'pl', hash: 'cc' }] }) }, { configDir: cfg }));
  const r = await quiet(async () => applyStagedRestore({ configDir: cfg }));
  assert.ok(Array.isArray(r.warnings) && r.warnings.length && typeof r.warnings[0] === 'object', JSON.stringify(r.warnings));
  const text = r.warnings.map(backupWarnText).join(' · ');
  assert.ok(!/\[object Object\]/.test(text) && /^central-agent-tokens\.json: /.test(text), text);
  const route = stripComments(read('routes/admin/backupNetSec.js'));
  assert.match(route, /r\.warnings\.map\(backupWarnText\)/);
  assert.ok(!/r\.warnings\.join\(/.test(route), "수정 전: r.warnings.join(' · ') → '주의: [object Object]'");
});

/* ═══════════════════════════ E1-5 isidu 옛 상태 호환 기준 고정 ═══════════════════════════ */

function fakeSmtp() {
  const st = { mails: 0 };
  const srv = net.createServer((sock) => {
    let buf = ''; let inData = false; sock.write('220 x\r\n');
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (l === '.') { inData = false; st.mails++; sock.write('250 ok\r\n'); } continue; }
        const up = l.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-x\r\n250 OK\r\n');
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); } else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { st, srv };
}

test('E1-5 옛 상태(last=조사마다 자동 결과·보냄, scanSentScanTs 없음) — 업그레이드 뒤 같은 결과 두 번 모두 생략하고 기준을 굳힌다', async () => {
  const idb = await import('../src/isidu/db.js');
  const N = await import('../src/isidu/notify.js');
  const { parseDuOutput } = await import('../src/isidu/parse.js');
  const { st, srv } = fakeSmtp();
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const w = (n, v) => fs.writeFileSync(path.join(DIR, n), JSON.stringify(v));
  w('mail.json', { enabled: true, smtp: { host: '127.0.0.1', port, startTls: false, user: '', password: '', from: 'p@corp.local', timeoutMs: 5000 }, defaultTo: [], kinds: {}, rateLimitPerHour: 0 });
  w('isidu-settings.json', { retentionDays: 400, timeoutDefaultMin: 120, mail: { commonTo: [] }, targets: [
    { id: 'tg-old', label: 'old', host: '10.0.0.5', username: 'admin', path: '/ifs/o', topN: 2, mail: { to: ['x@corp.local'], onlyOnChange: true } },
  ] });
  const T0 = NOW - 5 * DAY;
  const insert = async (k) => {
    const p = parseDuOutput('50G\t/ifs/o/alpha\n20G\t/ifs/o/beta\n90G\t/ifs/o\n', '/ifs/o', { mode: 'h' });
    const ts = T0 + k * DAY;
    const r = await idb.insertScan({ agent: '', node: '', targetId: 'tg-old', ts, ok: true, path: '/ifs/o', host: 'h', sizeMode: 'h', durationMs: 1000, trig: 'schedule',
      total: p.total, sumBytes: p.entries.reduce((a, e) => a + e.bytes, 0), sumRes: p.entries.reduce((a, e) => a + e.res, 0), count: p.entries.length, entries: p.entries });
    return { id: r.id, ts };
  };
  const s0 = await insert(0);
  // v2.768 이하 상태 파일 — scanSentScanTs 가 없고 last 가 '조사마다 자동 결과 · 보냄'.
  w('isidu-mail-state.json', { targets: { 'tg-old': { lastScanId: s0.id, lastScanTs: s0.ts, last: { at: s0.ts + 60_000, kind: 'result', scanId: s0.id, scanTs: s0.ts, state: 'sent', to: 1 } } } });
  N._resetForTest();
  const states = [];
  for (const k of [1, 2]) {
    const s = await insert(k);
    states.push((await quiet(() => N.notifyScanStored({ targetId: 'tg-old', scanId: s.id, ok: true, ts: s.ts }))).state);
  }
  assert.deepEqual(states, ['unchanged', 'unchanged'], `수정 전: 두 번째 조사에서 기준이 사라져 한 통 더 — ${states.join(',')}`);
  assert.equal(st.mails, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'isidu-mail-state.json'), 'utf8')).targets['tg-old'];
  assert.equal(saved.scanSentScanTs, s0.ts, '옛 기준을 굳혔다');
  assert.equal(saved.scanSentScanId, s0.id);
  N._resetForTest();
});

test('R5-E4-01 후속 — 중앙 정제가 엣지 스캔의 인증서 미신뢰·교체 삭제·강등 표지를 나른다', async () => {
  const { sanitizeIdracScanData } = await import('../src/central/idracScanJobs.js');
  const o = sanitizeIdracScanData({ tlsUntrusted: 2, tlsUntrustedIps: ['10.0.0.1', '10.0.0.2'], removed: 1, removedIps: ['10.0.0.9'], modeDowngraded: true, modeDowngradedReason: '장비 인증서 미신뢰 2대' });
  assert.equal(o.tlsUntrusted, 2); assert.deepEqual(o.tlsUntrustedIps, ['10.0.0.1', '10.0.0.2']);
  assert.equal(o.removed, 1); assert.deepEqual(o.removedIps, ['10.0.0.9']);
  assert.equal(o.modeDowngraded, true); assert.match(o.modeDowngradedReason, /인증서 미신뢰/);
  const old = sanitizeIdracScanData({ scanned: 3 });
  assert.equal(old.modeDowngraded, false, '옛 엣지(필드 없음)는 강등 아님');
});
