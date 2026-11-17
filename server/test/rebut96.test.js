/**
 * test/rebut96.test.js — 전체 점검 96회차: 92 · 93 · 94 · 95회차 수정 반증(적대적 재검토) + 남긴 결정(권장안).
 *
 *  ⓐ 93 F5 결정: 엣지 partfault push 에 시리얼 키 파트 이름(serialLabels · partIdents 표지) — 중앙이 새 판 보고에서만 교체 규칙을 적용
 *  R1 92 F3 덜 고침: 로그 설정 읽기 오류 동안 기본 위치 로그 DB 를 열어 캐시하면 회복 뒤에도 수집이 그 DB 에 쓴다 · 화면이 '수집 꺼짐' 이라 말한다
 *  R2 93 F3 덜 고침: 스캔 대역 GET 의 loadError 를 화면이 버려 '저장된 스캔 대역이 없습니다' 라고 말한다
 *  ⓒ 93 P2: 수동 닫기와 폴러 전이가 겹치면 close 이벤트가 두 번 — 행을 실제로 지운 쪽만 이벤트를 남긴다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut96-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'mock', PARTFAULT_DB_PATH: path.join(TMP, 'pf.db'), CENTRAL_TOKEN: 'tok-rebut96-shared' });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
async function quiet(fn) {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
}

test('ⓐ 93 F5: 새 판 엣지(serialLabels)는 시리얼 키 PSU 교체 뒤 옛 장애가 제거됨으로 닫힌다 · 옛 판 엣지는 예전처럼 누락 보류 · 프로토콜 판은 2 그대로', async () => {
  const { extractIdracParts } = await import('../src/partfault/extract/idrac.js');
  const { transition } = await import('../src/partfault/transition.js');
  const { buildPayload } = await import('../src/partfault/push.js');
  const edge = await import('../src/central/partFaultEdge.js');
  const { PUSH_PROTOCOL } = await import('../src/partfault/types.js');
  const server = { id: '10.0.0.5', name: 'srv1', serviceTag: 'ABC1234', agent: '' };
  const coll = { system: 'ok', psus: 'ok', disks: 'ok', storageControllers: 'ok', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'ok', fans: 'ok' };
  const inv = (psus) => ({ reachable: true, collections: coll, system: { serviceTag: 'ABC1234', model: 'R750' }, psus, disks: [], memoryDimms: [], cpus: [], gpus: [], pcie: [], storageControllers: [], fans: [] });
  const ps2 = { name: 'PS2 Status', serial: 'PS2SER', health: 'OK', state: 'Enabled' };
  const scanOf = (psus) => { const x = extractIdracParts(server, inv(psus)); return { devices: [{ scope: 'idrac', deviceId: server.id, deviceKey: x.deviceKey, deviceKeyKind: x.deviceKeyKind, deviceName: 'srv1', ok: true, failedKinds: [], parts: x.parts }] }; };
  const before = scanOf([{ name: 'PS1 Status', serial: 'OLD111', health: 'Critical', state: 'Enabled' }, ps2]);
  const afterRep = scanOf([{ name: 'PS1 Status', serial: 'NEW222', health: 'OK', state: 'Enabled' }, ps2]);
  const T = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const run = async (body0, body1, { strip = false } = {}) => {
    edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
    const strip1 = (b) => { if (!strip) return b; const c = JSON.parse(JSON.stringify(b)); delete c.partIdents; for (const d of c.devices) delete d.serialLabels; return c; };
    await edge.putEdgeReport('edge-a', strip1(body0));
    let m = edge.mergeEdgeReports({ now: Date.now() });
    const t1 = transition({ open: [], observed: m.observed, scan: { deviceOk: m.deviceOk, kindFailed: m.kindFailed, agentsReported: new Set(['edge-a']) }, now: T });
    assert.equal(t1.opened.length, 1);
    await edge.putEdgeReport('edge-a', strip1(body1));
    m = edge.mergeEdgeReports({ now: Date.now() });
    return { t2: transition({ open: t1.opened, observed: m.observed, scan: { deviceOk: m.deviceOk, kindFailed: m.kindFailed, agentsReported: new Set(['edge-a']) }, now: T + 60_000 }), m };
  };
  const b0 = buildPayload(before, { agent: 'edge-a', version: '3.18.10', now: T });
  const b1 = buildPayload(afterRep, { agent: 'edge-a', version: '3.18.10', now: T + 60_000 });
  assert.equal(b1.v, PUSH_PROTOCOL, '프로토콜 판(v)은 올리지 않는다 — 옛 중앙이 프로토콜 1(닫지 않는 쪽)로 접지 않게');
  assert.equal(b1.partIdents, 1);
  assert.ok(Object.values(b1.devices[0].serialLabels || {}).includes('PS1 Status'), '시리얼 키 파트의 이름을 싣는다');
  const neu = await run(b0, b1);
  assert.deepEqual(neu.t2.closed.map((c) => c.closeReason), ['removed'], '새 판 엣지: 교체 규칙이 맞아 옛 장애가 제거됨으로 닫힌다');
  assert.equal(neu.m.agents[0].idents, true);
  const old = await run(b0, b1, { strip: true });
  assert.equal(old.t2.closed.length, 0, '옛 판 엣지: 예전 그대로 닫지 않는다');
  assert.equal(old.t2.held[0]?.holdReason, 'missing');
  assert.equal(old.m.agents[0].idents, false);
  // 정제: 표지가 없는 보고의 serialLabels 는 쓰지 않는다 · 글자가 아닌 값 · 프로토타입 키는 버린다
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const evil = JSON.parse(JSON.stringify(b1));
  evil.devices[0].serialLabels = { ['__proto__']: 'x', [Object.keys(b1.devices[0].serialLabels)[0]]: { a: 1 } };
  await edge.putEdgeReport('edge-a', evil);
  const parts = edge.edgeReport('edge-a').devices[0].parts;
  assert.ok(parts.every((p) => p.keyKind === 'name' && typeof p.label === 'string'), '모르는 모양은 예전처럼 이름 키');
  const notV = JSON.parse(JSON.stringify(b1)); notV.partIdents = 'yes';
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  await edge.putEdgeReport('edge-a', notV);
  assert.equal(edge.edgeReport('edge-a').idents, false, '표지가 정수가 아니면 옛 판');
  // 분류 · 화면 문구
  const { classifyEdges } = await import('../src/routes/api/partFaults.js');
  const rows = classifyEdges({ collectors: [{ id: 'c1', name: 'edge-a' }], status: { c1: { version: '3.18.10' } }, reports: old.m.agents }).rows;
  assert.equal(rows[0].replaceRule, false);
  assert.match(src('web/src/views/tools/partFaultText.js'), /replaceRule === false/);
});

test('ⓒ 93 P2: 같은 열린 행을 두 번 닫으면(수동 닫기 + 폴러 전이) close 이벤트는 한 번 · 두 번째 결과의 closed 는 0', async () => {
  const pf = await import('../src/partfault/db.js');
  const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const p = { agent: 'edge-x', partKey: 'idrac:SVC1:psu:SER1', scope: 'idrac', deviceId: '10.1.1.1', deviceKey: 'SVC1', deviceKeyKind: 'serviceTag',
    deviceName: 'srv', kind: 'psu', partId: 'SER1', keyKind: 'serial', label: 'PS1', state: 'fault', rawState: 'Critical', firstSeenAt: T0, lastSeenAt: T0 };
  const r0 = await pf.applyTransition({ opened: [p], updated: [], closed: [], held: [] }, { now: T0 });
  if (r0.saved === false) { assert.ok(true, `node:sqlite 없음 — ${r0.reason}`); return; }
  const a = await pf.applyTransition({ opened: [], updated: [], closed: [{ ...p, closedAt: T0 + 1000, closeReason: 'manual' }], held: [] }, { now: T0 + 1000 });
  const b = await pf.applyTransition({ opened: [], updated: [], closed: [{ ...p, closedAt: T0 + 2000, closeReason: 'ok' }], held: [] }, { now: T0 + 2000 });
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 0, '이미 닫힌 행은 세지 않는다');
  const ev = (await pf.recentEvents({ sinceMs: 10 * 86_400_000, limit: 50, partKey: p.partKey, agent: 'edge-x' })) || [];
  const list = Array.isArray(ev) ? ev : (ev.events || ev.rows || []);
  const closes = list.filter((e) => (e.event || e.e) === 'close');
  assert.equal(closes.length, 1, `close 이벤트는 한 번이어야 한다: ${JSON.stringify(list).slice(0, 400)}`);
  assert.equal(closes[0].closeReason ?? closes[0].close_reason, 'manual', '먼저 닫은 쪽(수동)의 사유가 남는다');
});

test('R1 92 F3 덜 고침: 로그 설정 읽기 오류 동안 연 로그 DB 는 회복 뒤 지정 위치로 다시 열린다 · 상태는 DB 를 열지 않고 표지 · 조회는 503', async () => {
  const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');
  let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  _setJsonFileLoadClockForTest(() => NOW);
  try {
    const settings = await import('../src/logs/settings.js');
    const ldb = await import('../src/logs/db.js');
    const poller = await import('../src/logs/poller.js');
    const { vcLogsUnreadableBody } = await import('../src/routes/api/checksLogs.js');
    const F = path.join(TMP, 'vcenter-logs.json');
    const SUB = path.join(TMP, 'logs-sub');
    fs.mkdirSync(F);   // 파일 자리에 디렉터리 — 읽기 단계 실패(EISDIR)
    settings._resetLogSettingsForTest(); ldb.resetLogsDb();
    await quiet(async () => {
      assert.equal(settings.logSettingsUnknown(), true);
      const st = await poller.logStatus();
      assert.equal(st.settingsUnreadable, true, '상태에 표지');
      assert.equal(st.dbPath, null);
      assert.equal(fs.existsSync(path.join(TMP, 'vcenter-logs.db')), false, '상태 조회가 기본 위치에 DB 를 만들지 않는다');
      assert.equal(vcLogsUnreadableBody()?.reason, 'settingsUnreadable', '조회 라우트는 503 본문');
      const r = await poller.pollLogsOnce({ manual: true });
      assert.equal(r.settingsUnreadable, true);
      // 다른 읽기 소비처가 '모름' 동안 연다(기본 위치)
      const d0 = await ldb.getLogsDb();
      assert.equal(path.dirname(d0.path), TMP);
      // 회복: 관리자가 지정한 저장 위치가 든 원본이 다시 읽힌다
      fs.rmSync(F, { recursive: true, force: true });
      fs.writeFileSync(F, JSON.stringify({ enabled: true, storagePath: SUB }));
      NOW += 31_000;
      assert.equal(settings.logSettingsUnknown(), false);
      const d1 = await ldb.getLogsDb();
      assert.equal(path.dirname(d1.path), SUB, '회복 뒤 수집 · 조회는 지정 위치 DB — 기본 위치 캐시에 이어 쓰지 않는다');
      assert.equal(vcLogsUnreadableBody(), null);
    });
    ldb.resetLogsDb();
    // 화면 문구 — '수집 꺼짐' 이 아니다
    const web = src('web/src/views/VcenterLogs.jsx');
    assert.match(web, /lastRun\.settingsUnreadable/);
    assert.match(web, /r\.settingsUnreadable/);
  } finally { _setJsonFileLoadClockForTest(); }
});

test('ⓑ 92 · 93 남긴 것: perf · 전력 · 스캔 주기 설정 · 로그 커서 — 읽기 오류는 원본을 옮기지 않고 · 캐시하지 않고 · 저장 409 · 회복 · perf 보존일은 허용 최장', async () => {
  const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');
  let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  _setJsonFileLoadClockForTest(() => NOW);
  const corrupt = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt`));
  const unreadable = (n) => { try { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); } catch { /* */ } fs.mkdirSync(path.join(TMP, n)); };
  const restore = (n, body) => { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); fs.writeFileSync(path.join(TMP, n), body); };
  try {
    await quiet(async () => {
      // perf
      const perf = await import('../src/perf/settings.js');
      unreadable('perf-monitor.json'); perf._resetPerfSettingsCache();
      const p0 = perf.loadPerfSettings();
      assert.equal(p0.retentionDays, perf.LIMITS.retentionDays.max, '모르는 동안 hang 로그 정리는 허용 최장 보존으로만(83회차 R1)');
      assert.equal(perf.perfSettingsWriteRefusal()?.status, 409);
      assert.throws(() => perf.savePerfSettings({ retentionDays: 3 }), (e) => e.status === 409);
      assert.equal(corrupt('perf-monitor.json').length, 0, '원본을 옮기지 않는다');
      restore('perf-monitor.json', JSON.stringify({ retentionDays: 60 })); NOW += 31_000;
      assert.equal(perf.loadPerfSettings().retentionDays, 60, '다시 읽히면 저장값');
      assert.equal(perf.perfSettingsWriteRefusal(), null);
      // 전력 표시
      const pw = await import('../src/idrac/powerSettings.js');
      unreadable('power-settings.json'); pw._resetPowerSettingsForTest();
      assert.equal(pw.loadPowerSettings().excludeUnmapped, false);
      assert.equal(pw.powerSettingsWriteRefusal()?.status, 409);
      assert.throws(() => pw.savePowerSettings({ excludeUnmapped: true }), (e) => e.status === 409);
      assert.equal(corrupt('power-settings.json').length, 0);
      restore('power-settings.json', JSON.stringify({ excludeUnmapped: true })); NOW += 31_000;
      assert.equal(pw.loadPowerSettings().excludeUnmapped, true, '읽기 오류의 기본값을 캐시하지 않았다');
      // 스캔 주기
      const sp = await import('../src/idrac/scanPoller.js');
      unreadable('idrac-scan-settings.json'); sp._resetScanSettingsForTest();
      const r = sp.setIdracScanIntervalMs(0);
      assert.equal(r.ok, false); assert.equal(r.status, 409);
      assert.ok(fs.statSync(path.join(TMP, 'idrac-scan-settings.json')).isDirectory(), '원본 자리에 쓰지 않았다');
      assert.equal(corrupt('idrac-scan-settings.json').length, 0);
      restore('idrac-scan-settings.json', JSON.stringify({ intervalMs: 0 })); NOW += 31_000;
      assert.equal(sp.scanSettingsWriteRefusal(), null);
      // 로그 수집 커서(상태 파일)
      const lp = await import('../src/logs/poller.js');
      unreadable(lp.CURSOR_FILE_NAME);
      lp.loadCursorFile({ force: true });
      assert.equal(corrupt(lp.CURSOR_FILE_NAME).length, 0, '커서 파일 읽기 오류는 손상 보존본을 만들지 않는다');
      assert.ok(fs.statSync(path.join(TMP, lp.CURSOR_FILE_NAME)).isDirectory());
    });
  } finally { _setJsonFileLoadClockForTest(); }
  // 라우트 · 화면 연결(소스 — 주석 제거)
  const { stripComments } = await import('./_stripComments.js');
  const code = (p) => stripComments(src(p));
  assert.match(code('server/src/routes/admin/perfMonitor.js'), /perfSettingsWriteRefusal\(\); if \(no\) return res\.status\(409\)/);
  assert.match(code('server/src/routes/admin/idracCore.js'), /powerSettingsWriteRefusal\(\); if \(no\) return res\.status\(409\)/);
  assert.match(code('server/src/routes/admin/nfsMounts.js'), /nfsMountsReadError\(\)/);
  assert.match(code('server/src/routes/admin/backupNetSec.js'), /monitorsWriteRefusal\(\)/);
  assert.match(code('web/src/views/NfsMounts.jsx'), /d\.loadError/);
  assert.match(code('web/src/views/NetTrafficAnalysis.jsx'), /loadError\?\.readError/);
  assert.match(code('web/src/views/IdracAdmin.jsx'), /scanRangesLoadErrorText\(d\)/);
});

test('94 남긴 것 ① 결정: Veeam 결과가 상한에서 잘렸으면(truncated) 대조에 없는 · 복원 지점 없는 VM 은 모름 — 포탈 전용 잡 배치에서 빠진다 · 엣지 정제 화이트리스트 · 마지막 성공분에도 표지', async () => {
  const { runStatusOf, planBackup } = await import('../src/veeam/run/plan.js');
  const servers = [{ id: 'vbr-1', name: 'VBR1' }];
  const vm = { id: 'vm-1', name: 'a', vcenterId: 'vc1', moref: 'vm-101' };
  assert.equal(runStatusOf(vm, { servers, known: true }).status, 'unprotected', '잘리지 않은 결과는 예전 그대로');
  const u = runStatusOf(vm, { servers, known: true, truncated: true });
  assert.equal(u.status, 'unknown', '잘린 결과의 대조 없음은 모름');
  const inJob = runStatusOf(vm, { servers, known: true, truncated: true, entry: { rp: 0, lb: null, jobs: ['J'], servers: ['VBR1'] } });
  assert.equal(inJob.status, 'unknown', '복원 지점 목록이 잘렸을 수 있다 — in-job 도 모름');
  const prot = runStatusOf(vm, { servers, known: true, truncated: true, entry: { rp: 3, lb: 1, jobs: ['J'], servers: ['VBR1'] } });
  assert.equal(prot.status, 'protected', '근거가 있는 VM 은 잘림과 무관하게 보호');
  const plan = planBackup([{ vm, run: u, hostName: 'vc1' }], { mode: 'quick', unprotected: 'portal' });
  assert.ok(plan.vms.every((x) => x.how === 'skip'), `모름은 포탈 잡에 넣지 않는다: ${JSON.stringify(plan.vms)}`);
  // 중앙 정제(엣지 결과) — 아는 키만 · VM 상한을 넘긴 보고는 vms 표지
  const { sanitizeServerResult } = await import('../src/veeam/parse.js');
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const r1 = sanitizeServerResult({ ok: true, ts: now - 1000, jobs: [], vms: [{ n: 'a', m: 'vm-1' }], truncated: ['backupObjects', 'evil', 7, 'backupObjects'] }, now);
  assert.deepEqual(r1.truncated, ['backupObjects']);
  const r2 = sanitizeServerResult({ ok: true, ts: now - 1000, jobs: [], vms: [{ n: 'a', m: 'vm-1' }, { n: 'b', m: 'vm-2' }] }, now, { maxVms: 1 });
  assert.deepEqual(r2.truncated, ['vms'], '정제가 VM 을 잘랐으면 표지');
  const r3 = sanitizeServerResult({ ok: true, ts: now - 1000, jobs: [], vms: [] }, now);
  assert.equal(r3.truncated, undefined, '표지 없음은 키도 없음(옛 모양)');
  // 마지막 성공분(lastOk)에도 표지가 따라간다
  const st = await import('../src/veeam/store.js');
  st._resetForTest();
  st.putResult('vbr-9', { ok: true, ts: now, jobs: [], vms: [], counts: {}, notes: [], backups: [], truncated: ['restorePoints'] });
  st.putResult('vbr-9', { ok: false, ts: now + 1, error: 'x' });
  assert.deepEqual(st.usableResult(st.getRecord('vbr-9')).truncated, ['restorePoints']);
  // 대조 · 계획 연결(소스 — 주석 제거)
  const { stripComments } = await import('./_stripComments.js');
  assert.match(stripComments(src('server/src/routes/api/veeam.js')), /x\.result\?\.truncated/);
  assert.match(stripComments(src('server/src/routes/api/backupRun.js')), /truncated: !!m\.truncated/);
  assert.match(stripComments(src('server/src/veeam/client.js')), /truncated/);
});

test('94 F2 반증(화면): 실행 기록 읽기 오류는 서버마다 진행 중이 아니라 진행 여부 모름', async () => {
  const { busyFlags } = await import('../src/routes/api/backupRun.js');
  assert.deepEqual(busyFlags({ id: '', kind: 'runs-unreadable', reason: 'x' }), { active: false, busyUnknown: true });
  assert.deepEqual(busyFlags({ id: 'vbr_1', kind: 'quick' }), { active: true });
  assert.deepEqual(busyFlags(null), { active: false });
});

test('95 남긴 것 ② 결정: web/src 의 text-transform: uppercase 0곳(CSS · JSX 인라인 · 템플릿 CSS — 주석 제외)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const WEB = path.join(ROOT, 'web', 'src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)) { const body = e.name.endsWith('.css') ? fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') : stripComments(fs.readFileSync(p, 'utf8')); if (/text-?transform['"]?\s*:\s*['"]?uppercase/i.test(body)) hits.push(path.relative(WEB, p)); } } };
  walk(WEB);
  assert.deepEqual(hits, []);
});

test('95 남긴 것 ① 결정: 모달 배경 닫기는 backdropClose 하나 — e.target === e.currentTarget 로 닫는 오버레이 0곳(Palette 는 누름 즉시 닫기 · 키보드 행 토글 제외)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const WEB = path.join(ROOT, 'web', 'src');
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.jsx$/.test(e.name) && !/\.test\./.test(e.name)) { const body = stripComments(fs.readFileSync(p, 'utf8')); if (/onClick=\{\(e\) => \{ if \(e\.target === e\.currentTarget/.test(body)) hits.push(path.relative(WEB, p)); } } };
  walk(WEB);
  assert.deepEqual(hits, []);
});

test('95 추정 ③ 반증: vcenters.json 을 못 읽는 동안 gpu-guest-data 는 TOFU 통과가 아니라(예전에도 전부 버렸다) 지속형 503 registryUnreadable — 읽히면 다시 받는다', async () => {
  const express = (await import('express')).default;
  const { centralRouter, _resetVcModesForTest } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/central', centralRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/central`;
  const F = path.join(TMP, 'vcenters.json');
  const post = (body) => fetch(`${base}/gpu-guest-data`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'tok-rebut96-shared' }, body: JSON.stringify(body) });
  const body = { agent: 'edge-g', hosts: [{ hostId: 'vc-s:host-1', utilPct: 10 }], vms: [] };
  try {
    await quiet(async () => {
      fs.rmSync(F, { recursive: true, force: true }); fs.mkdirSync(F);   // 읽기 단계 실패(EISDIR)
      _resetVcModesForTest();
      const r1 = await post(body);
      const j1 = await r1.json();
      assert.equal(r1.status, 503, JSON.stringify(j1));
      assert.equal(j1.reason, 'registryUnreadable');
      assert.equal(r1.headers.get('retry-after'), '60');
      assert.ok(!/hunter|password/i.test(JSON.stringify(j1)));
      fs.rmSync(F, { recursive: true, force: true });
      fs.writeFileSync(F, JSON.stringify({ vcenters: [{ id: 'vc-s', name: 'S', host: 'https://10.0.0.5', collectMode: 'site' }] }));
      _resetVcModesForTest();
      const r2 = await post(body);
      assert.equal(r2.status, 200, '읽히면 예전처럼 받는다');
      fs.rmSync(F);
      _resetVcModesForTest();
      const r3 = await post(body);
      assert.equal(r3.status, 200, '파일이 없는 것(등록 0)은 못 읽음이 아니다 — 예전 동작');
    });
  } finally { srv.close(); }
});

test('95 F2 반증: GPU 모델 낱말 맞춤 — 밑줄도 경계(웹 modelHasFamily 와 같은 규칙) · 픽스처 꼴은 예전과 같거나 바르게 · 칩 이름 안 모델 글자는 맞추지 않음', async () => {
  const { inferGpuMemGB } = await import('../src/gpu/gpuModelMem.js');
  const cases = { 'NVIDIA A40': 48, 'GA102GL [A40]': 48, 'NVIDIA A10': 24, 'GA102GL [A10]': 24, 'NVIDIA L4': 24, 'AD104GL [L4]': 24, 'AD104GL': 24, 'NVIDIA L40S': 48, 'AD102GL [L40S]': 48,
    'NVIDIA T4': 16, 'Tesla T4': 16, 'TU104GL [Tesla T4]': 16, 'TU104GL': 16, 'NVIDIA A16': 16, 'GA107GL [A16]': 16, 'NVIDIA A30': 24, 'GA100GL [A30 PCIe]': 24,
    'NVIDIA A100': 80, 'NVIDIA A100 80GB PCIe': 80, 'NVIDIA A100-SXM4-40GB': 40, 'GA100 [A100 PCIe 40GB]': 40, 'NVIDIA H100': 80, 'GH100 [H100 PCIe]': 80, 'Tesla V100': 32,
    'NVIDIA_A10': 24, 'grid_a40-24q': 48, 'nvidia_l4-12q': 24,
    'NVIDIA RTX A4000': 0, 'GA104GL [RTX A4000]': 0, 'GA102GL [RTX A5000]': 0, 'GA102GL': 0, 'NVIDIA A10G': 0 };
  for (const [m, gb] of Object.entries(cases)) assert.equal(inferGpuMemGB(m), gb, m);
});
