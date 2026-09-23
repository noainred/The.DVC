/**
 * v2.598 감사(그룹 b) 회귀 — iDRAC 텔레메트리·베어메탈 사용률·스토리지 헬스 판정.
 *
 *  IDRAC-2598-01  전수 모드 리포트 선택이 목록 순서 앞 6개라 SystemUsage·NIC 가 잘리던 것 → 종류별 우선순위
 *  IDRAC-2598-02  전수 모드 보드 퍼센트에 범위 검사가 없던 것 → pctFromMetric(단일 소스)
 *  IDRAC-2598-03  iDRAC 누적 카운터를 폴러 시계로 나눠 갱신 안 된 리포트가 0 B/s 가 되던 것 → 리포트 표본 시각
 *  IDRAC-2598-04  임계 알림 지속 조건이 히스테리시스 구간·null 공백을 '지속' 으로 세던 것 → 연속 초과 시간만
 *  IDRAC-2598-05  Unity REST HealthEnum 0(UNKNOWN)이 비정상·fault, 10/15 가 fault 이던 것 → 번역표
 *  IDRAC-2598-06  partfault healthStringState 가 정상어 접두를 먼저 봐 'OK-degraded' 가 ok 이던 것
 *
 * 기준 시각은 고정값이다(Date.now() 금지 — CLAUDE.md v2.517).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2598b-'));
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 Redfish 서버가 127.0.0.1 에 산다 — 이 테스트 전용

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const NOW = 1_790_000_000_000;   // 고정 기준 시각
const MIN = 60_000;

/* ─────────────────────────── IDRAC-2598-01 ─────────────────────────── */

test('IDRAC-2598-01 pickReports: 목록 앞쪽에 스토리지 리포트가 몰려도 SystemUsage·NIC 를 먼저 고른다', async () => {
  const { pickReports } = await import('../src/bmusage/parse/idracTelemetry.js');
  const base = '/redfish/v1/TelemetryService/MetricReports/';
  const ids = ['StorageDiskSMARTData', 'StorageSensor', 'NVMeSMARTData', 'SmartDataA', 'SmartDataB', 'SmartDataC', 'AggregationMetrics', 'NICStatistics', 'SystemUsage', 'PowerMetrics']
    .map((x) => base + x);
  const r = pickReports(ids, 6);
  const tail = r.wanted.map((u) => u.split('/').pop());
  assert.equal(r.wanted.length, 6);
  assert.equal(tail[0], 'SystemUsage', '보드 리포트가 첫 자리');
  assert.ok(tail.includes('NICStatistics'), JSON.stringify(tail));
  assert.ok(tail.includes('AggregationMetrics'), 'cpumem 종류도 1개');
  assert.equal(r.matched, 9, 'PowerMetrics 는 읽을 대상이 아니다');
  assert.equal(r.skipped, 3, '상한으로 뺀 개수를 밝힌다');
});

async function fakeTelemetry(reportIds, reports) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    hits.push(u);
    const J = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u === '/redfish/v1/TelemetryService/MetricReports') {
      return J(200, { Members: reportIds.map((id) => ({ '@odata.id': `/redfish/v1/TelemetryService/MetricReports/${id}` })) });
    }
    const id = u.split('/').pop();
    if (reports[id]) return J(200, reports[id]);
    return J(404, { error: 'nope' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, hits };
}

test('IDRAC-2598-01 fetchUsage(full): 스토리지 리포트 7개 뒤의 SystemUsage·NIC 를 읽고 skippedReports 를 싣는다', async () => {
  const { fetchUsage, _resetReportListForTest } = await import('../src/idrac/redfish.js');
  _resetReportListForTest();
  const storage = ['StorageDiskSMARTData', 'StorageSensor', 'NVMeSMARTData', 'SmartData1', 'SmartData2', 'SmartData3', 'SmartData4'];
  const ts = '2026-09-23T00:00:00Z';
  const reports = {
    SystemUsage: { Id: 'SystemUsage', MetricValues: [{ MetricId: 'SystemBoardCPUUsage', MetricValue: '41', Timestamp: ts }, { MetricId: 'SystemBoardMEMUsage', MetricValue: '63', Timestamp: ts }] },
    NICStatistics: { Id: 'NICStatistics', MetricValues: [{ MetricId: 'RxBytes', MetricValue: '1000', Timestamp: ts, Oem: { Dell: { FQDD: 'NIC.Integrated.1-1-1' } } }] },
  };
  for (const s of storage) reports[s] = { Id: s, MetricValues: [{ MetricId: 'TemperatureReading', MetricValue: '30', Timestamp: ts, Oem: { Dell: { FQDD: `Disk.${s}` } } }] };
  const f = await fakeTelemetry([...storage, 'NICStatistics', 'SystemUsage'], reports);
  const r = await fetchUsage({ host: f.host, username: 'root', password: 'pw' }, { full: true });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.cpuPct, 41, '수정 전: 목록 앞 6개(스토리지)만 읽어 null');
  assert.equal(r.memPct, 63);
  assert.equal(r.nics.length, 1);
  assert.equal(r.skippedReports, 3);
  assert.ok(r.usedReports.includes('SystemUsage'));
});

test('IDRAC-2598-01 fetchUsage(full): 보드 리포트가 목록에 없으면 SystemUsage 단독 조회로 CPU·메모리 빈 칸을 채운다', async () => {
  const { fetchUsage, _resetReportListForTest } = await import('../src/idrac/redfish.js');
  _resetReportListForTest();
  const ts = '2026-09-23T00:00:00Z';
  const reports = {
    // 목록에는 없지만 URL 로는 있는 SystemUsage(단독 경로가 읽는다)
    SystemUsage: { Id: 'SystemUsage', MetricValues: [{ MetricId: 'SystemBoardCPUUsage', MetricValue: '12' }, { MetricId: 'SystemBoardMEMUsage', MetricValue: '34' }] },
    NICStatistics: { Id: 'NICStatistics', MetricValues: [{ MetricId: 'RxBytes', MetricValue: '1000', Timestamp: ts, Oem: { Dell: { FQDD: 'NIC.1' } } }] },
  };
  const f = await fakeTelemetry(['NICStatistics'], reports);
  const r = await fetchUsage({ host: f.host, username: 'root', password: 'pw' }, { full: true });
  assert.equal(r.ok, true);
  assert.equal(r.cpuPct, 12);
  assert.equal(r.memPct, 34);
  assert.equal(r.boardFallback, 'ok');
  assert.ok(r.read.includes('cpumem'));
});

test('IDRAC-2598-01 poller: 텔레메트리가 ok 여도 보드 CPU·메모리가 없으면 Enterprise 대체 경로 대상이다', async () => {
  const src = fs.readFileSync(new URL('../src/bmusage/poller.js', import.meta.url), 'utf8');
  assert.match(src, /const boardRead = !!idrac\?\.ok && \(idrac\.cpuPct != null \|\| idrac\.memPct != null\)/);
  assert.match(src, /telemetryOk: boardRead/);
  const { enterpriseEligible } = await import('../src/bmusage/license.js');
  assert.equal(enterpriseEligible({ tier: 'enterprise', telemetryOk: false, telemetryKind: 'board-missing' }).eligible, true);
});

/* ─────────────────────────── IDRAC-2598-02 ─────────────────────────── */

test('IDRAC-2598-02 전수 모드 보드 퍼센트: -1·150 은 사용률이 아니고 37 % 는 37 이다', async () => {
  const { buildIdracUsage, pctFromMetric } = await import('../src/bmusage/parse/idracTelemetry.js');
  const r = buildIdracUsage([{ Id: 'SystemUsage', MetricValues: [
    { MetricId: 'SystemBoardCPUUsage', MetricValue: '-1' },
    { MetricId: 'SystemBoardMEMUsage', MetricValue: '150' },
    { MetricId: 'SystemBoardIOUsage', MetricValue: '37 %' },
    { MetricId: 'SystemBoardSYSUsage', MetricValue: 55 },
  ] }], ['SystemUsage']);
  assert.equal(r.cpuPct, null, '수정 전: -1');
  assert.equal(r.memPct, null, '수정 전: 150');
  assert.equal(r.ioPct, 37, '수정 전: null(num 이 % 를 못 읽음)');
  assert.equal(r.sysPct, 55);
  assert.equal(r.boardRejected, 2);
  // redfish.js 의 재수출이 같은 함수다(단일 소스).
  const rf = await import('../src/idrac/redfish.js');
  assert.equal(rf.pctFromMetric, pctFromMetric);
});

/* ─────────────────────────── IDRAC-2598-03 ─────────────────────────── */

test('IDRAC-2598-03 iDRAC NIC 카운터: 리포트가 갱신되지 않았으면 0 B/s 가 아니라 null + 안내', async () => {
  const { buildUsage } = await import('../src/bmusage/usage.js');
  const T = NOW - 10 * MIN;   // 리포트 표본 시각(두 주기 모두 같다 — 갱신 안 됨)
  const nic = { iface: 'NIC.1', rxBytes: 5_000_000, txBytes: 7_000_000, bitsPerSec: 10e9, at: T };
  const r = buildUsage({
    target: { key: 'k1', name: 's1' },
    idrac: { ok: true, nics: [nic], fcs: [] },
    prev: { at: NOW - 5 * MIN, idrac: { nics: [{ ...nic }], fcs: [] } },
    now: NOW,
  });
  assert.equal(r.row.net_bps, null, '수정 전: 0');
  assert.equal(r.row.net_pct, null, '수정 전: 0');
  assert.ok(r.notes.some((x) => /갱신되지 않은 장치 1개/.test(x)), JSON.stringify(r.notes));
});

test('IDRAC-2598-03 iDRAC NIC 카운터: 분모는 리포트 표본 시각 차이다(폴러 시계가 아니다)', async () => {
  const { buildUsage } = await import('../src/bmusage/usage.js');
  const T1 = NOW - 6 * MIN; const T2 = T1 + 60_000;   // 리포트는 60초 간격, 폴러는 5분 간격
  const r = buildUsage({
    target: { key: 'k1', name: 's1' },
    idrac: { ok: true, nics: [{ iface: 'NIC.1', rxBytes: 60_000, txBytes: 0, bitsPerSec: 1e9, at: T2 }], fcs: [] },
    prev: { at: NOW - 5 * MIN, idrac: { nics: [{ iface: 'NIC.1', rxBytes: 0, txBytes: 0, at: T1 }], fcs: [] } },
    now: NOW,
  });
  assert.equal(r.row.net_bps, 1000, '60,000B / 60초(수정 전: 5분으로 나눠 200)');
  // 표본 시각이 없는 구버전 상태는 예전처럼 폴러 시계
  const old = buildUsage({
    target: { key: 'k1', name: 's1' },
    idrac: { ok: true, nics: [{ iface: 'NIC.1', rxBytes: 60_000, txBytes: 0 }], fcs: [] },
    prev: { at: NOW - 5 * MIN, idrac: { nics: [{ iface: 'NIC.1', rxBytes: 0, txBytes: 0 }], fcs: [] } },
    now: NOW,
  });
  assert.equal(old.row.net_bps, 200);
});

test('IDRAC-2598-03 파서: 장치별 표본 시각을 싣는다(메트릭 Timestamp → 없으면 리포트 Timestamp)', async () => {
  const { buildIdracUsage } = await import('../src/bmusage/parse/idracTelemetry.js');
  const r = buildIdracUsage([
    { Id: 'NICStatistics', MetricValues: [{ MetricId: 'RxBytes', MetricValue: '10', Timestamp: '2026-09-23T00:00:00Z', Oem: { Dell: { FQDD: 'NIC.1' } } }] },
    { Id: 'FCPortStatistics', Timestamp: '2026-09-23T00:05:00Z', MetricValues: [{ MetricId: 'RxBytes', MetricValue: '10', Oem: { Dell: { FQDD: 'FC.1' } } }] },
  ], ['NICStatistics', 'FCPortStatistics']);
  assert.equal(r.nics[0].at, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(r.fcs[0].at, Date.parse('2026-09-23T00:05:00Z'));
});

/* ─────────────────────────── IDRAC-2598-04 ─────────────────────────── */

const CFG = { pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 5 * MIN };
function run(values) {
  return import('../src/bmusage/alertRules.js').then(({ stepAlert }) => {
    let st = null; const fires = [];
    values.forEach((v, i) => {
      const out = stepAlert(st, v, CFG, NOW + i * 5 * MIN);
      st = out.state; if (out.fire) fires.push([i, out.fire]);
    });
    return { st, fires };
  });
}

test('IDRAC-2598-04 연속 초과 15분이면 알린다(회귀 없음)', async () => {
  const { fires } = await run([95, 95, 95, 95]);
  assert.deepEqual(fires, [[3, 'over']]);
});

test('IDRAC-2598-04 히스테리시스 구간(89)이 사이에 끼면 지속이 끊긴다', async () => {
  const { fires } = await run([95, 89, 95, 95]);
  assert.deepEqual(fires, [], '수정 전: 3번째 관측에서 since(0분)부터 15분으로 세어 알렸다');
});

test('IDRAC-2598-04 null 공백은 지속으로 세지 않는다', async () => {
  const { fires } = await run([95, null, null, 95]);
  assert.deepEqual(fires, [], '수정 전: 공백 10분을 포함해 15분 지속으로 알렸다');
});

test('IDRAC-2598-04 알린 뒤 히스테리시스 구간은 해제를 보류하고 재알림 억제는 유지한다', async () => {
  const { fires, st } = await run([95, 95, 95, 95, 89, 95, 95, 95, 95, 80]);
  assert.deepEqual(fires, [[3, 'over'], [9, 'recovered']], '재초과 15분은 6시간 억제에 걸리고 해제는 1회');
  assert.equal(st, null);
});

test('IDRAC-2598-04 구버전 상태(overMs 없음)는 lastOverAt - since 로 이어받는다', async () => {
  const { stepAlert } = await import('../src/bmusage/alertRules.js');
  const prev = { since: NOW - 10 * MIN, lastOverAt: NOW - 5 * MIN, peak: 95, notifiedAt: null };
  const out = stepAlert(prev, 95, CFG, NOW + 0);
  assert.equal(out.fire, null);
  assert.equal(out.state.overMs, 10 * MIN);
  const out2 = stepAlert(out.state, 95, CFG, NOW + 5 * MIN);
  assert.equal(out2.fire, 'over');
});

/* ─────────────────────────── IDRAC-2598-05 ─────────────────────────── */

test('IDRAC-2598-05 Unity REST HealthEnum: 0 은 unknown(비정상 아님), 10·15 는 비정상이지만 파트는 warn', async () => {
  const { normalizeUnity, unityHealthWord } = await import('../src/storage/collectors/unity.js');
  const { healthStringState } = await import('../src/partfault/classify.js');
  const w = (l) => ({ entries: l.map((c) => ({ content: c })) });
  const snap = normalizeUnity({ id: 'u1', name: 'u1' }, { sps: w([
    { name: 'SP A', health: { value: 0 } }, { name: 'SP B', health: { value: 5 } },
    { name: 'SP C', health: { value: 10 } }, { name: 'SP D', health: { value: 15 } }, { name: 'SP E', health: { value: 20 } },
  ]) });
  assert.deepEqual(snap.nodes.list.map((x) => x.health), ['unknown', 'ok', 'degraded', 'minor', 'health:20']);
  assert.equal(snap.nodes.unhealthy, 3, '수정 전: 0 도 세어 4');
  assert.deepEqual(snap.nodes.list.map((x) => healthStringState(x.health).state), ['unknown', 'ok', 'warn', 'warn', 'fault']);
  // 구버전 수집기가 실은 'health:N' 도 같은 번역표로 읽는다.
  assert.equal(healthStringState('health:0').state, 'unknown', '수정 전: fault');
  assert.equal(healthStringState('health:10').state, 'warn', '수정 전: fault');
  assert.equal(healthStringState('health:99').state, 'fault');
  assert.equal(unityHealthWord(undefined), 'unknown');
});

/* ─────────────────────────── IDRAC-2598-06 ─────────────────────────── */

test('IDRAC-2598-06 healthStringState: 정상어 접두 뒤의 경고어를 놓치지 않는다', async () => {
  const { healthStringState: h } = await import('../src/partfault/classify.js');
  const cases = {
    'OK-degraded': 'warn', 'Up (degraded)': 'warn', 'OK (Warning)': 'warn', 'DEGRADED 3/4': 'warn',
    'FAILED (degraded)': 'fault', 'not ok': 'fault', 'UPGRADE_FAILED': 'fault', 'OKAY_NOT': 'fault', 'critical': 'fault',
    OK: 'ok', Healthy: 'ok', 'ATTENTION_NONE': 'ok', ATTN: 'warn', 'NON-CRITICAL': 'warn', 'MINOR-FAILURE': 'warn',
    REMOVED: 'absent', unknown: 'unknown', '': 'unknown',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(h(raw).state, want, raw);
});
