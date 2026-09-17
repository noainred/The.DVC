/**
 * 베어메탈 사용률 개선(v2.551) 회귀 — 사용자 요청 "방금 만든 기능 개선해줘".
 * 선택: ① iDRAC 텔레메트리 전수 활용 ② 추이 차트 ③ 법인 필터·상위N·CSV ④ 임계 초과 알림,
 *       사용불가 처리는 "장비별로 무엇을 읽었는지 밝힌다".
 *
 * ⚠⚠ **정직 기록**: 이 현장 iDRAC 의 실제 리포트 목록·메트릭 id 를 본 적이 없다. 픽스처는
 *   Redfish 표준(`MetricValues[]`)과 Dell 문서 기반 **합성**이고, 그래서 코드는 id 를 굳히지 않고
 *   **이름 패턴 + 후보 집합**으로 읽으며 장비가 가진 목록을 그대로 보고한다. 이 테스트가 고정하는
 *   것은 '그 관용적 해석이 의도대로 동작하는가' 이고 '이 현장 id 가 무엇인가' 가 아니다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { reportKinds, isWantedReport, deviceIdOf, parseReport, buildIdracUsage } from '../src/bmusage/parse/idracTelemetry.js';
import { stepAlert, evaluateRows, alertOf, ALERT_METRICS, HYSTERESIS_PCT } from '../src/bmusage/alertRules.js';
import { buildUsage } from '../src/bmusage/usage.js';
import { normalizeSettings, DEFAULTS } from '../src/bmusage/settings.js';

const bare = (rel) => fs.readFileSync(path.join(import.meta.dirname, '../src', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── ① iDRAC 텔레메트리 파서 ───────────────────────────────────────────────────
test('리포트를 **이름 패턴**으로 찾는다 — id 를 굳히지 않는다', () => {
  assert.deepEqual(reportKinds('SystemUsage'), ['system']);
  assert.deepEqual(reportKinds('NICStatistics'), ['nic']);
  assert.deepEqual(reportKinds('FCPortStatistics'), ['fc']);
  assert.deepEqual(reportKinds('StorageDiskSMARTData'), ['storage']);
  // 우리가 쓰지 않는 리포트는 읽지 않는다(왕복을 낭비하지 않는다).
  for (const id of ['ThermalSensor', 'PowerMetrics', 'FanSensor', 'GPUStatistics']) {
    assert.equal(isWantedReport(id), false, `${id} 를 읽으려 한다`);
  }
});

test('장치 식별자는 여러 출처에서 뽑는다(하나로 굳히지 않는다)', () => {
  assert.equal(deviceIdOf({ Oem: { Dell: { FQDD: 'NIC.Integrated.1-1-1' } } }), 'NIC.Integrated.1-1-1');
  assert.equal(deviceIdOf({ Oem: { Dell: { ContextID: 'FC.Slot.1-1' } } }), 'FC.Slot.1-1');
  assert.equal(deviceIdOf({ MetricProperty: '/redfish/v1/Systems/System.Embedded.1/NetworkAdapters/NIC.1/NetworkDeviceFunctions/NIC.1-1-1/Metrics#RxBytes' }), 'NIC.1-1-1');
  assert.equal(deviceIdOf({ Oem: { Dell: { Label: 'NIC.Slot.3-1 RxBytes' } } }), 'NIC.Slot.3-1');
  assert.equal(deviceIdOf({}), '');
});

test('NIC·FC 통계를 읽고 단위를 맞춘다 (Mbps→bit/s, KB→바이트)', () => {
  const nic = { Id: 'NICStatistics', MetricValues: [
    { MetricId: 'RxBytes', MetricValue: '1000000', Oem: { Dell: { FQDD: 'NIC.1-1-1' } } },
    { MetricId: 'TxBytes', MetricValue: '2000000', Oem: { Dell: { FQDD: 'NIC.1-1-1' } } },
    { MetricId: 'LinkSpeedMbps', MetricValue: '25000', Oem: { Dell: { FQDD: 'NIC.1-1-1' } } },
    { MetricId: 'LinkSpeedMbps', MetricValue: '0', Oem: { Dell: { FQDD: 'NIC.2-1-1' } } },
    { MetricId: 'RxBytes', MetricValue: '5', Oem: { Dell: { FQDD: 'NIC.2-1-1' } } },
  ] };
  const fc = { Id: 'FCPortStatistics', MetricValues: [
    { MetricId: 'RxKBCount', MetricValue: '4096', Oem: { Dell: { FQDD: 'FC.1-1' } } },
    { MetricId: 'TxKBCount', MetricValue: '2048', Oem: { Dell: { FQDD: 'FC.1-1' } } },
    { MetricId: 'PortSpeed', MetricValue: '16000', Oem: { Dell: { FQDD: 'FC.1-1' } } },
  ] };
  const r = buildIdracUsage([nic, fc], ['SystemUsage', 'NICStatistics', 'FCPortStatistics', 'ThermalSensor']);
  const n1 = r.nics.find((x) => x.iface === 'NIC.1-1-1');
  assert.equal(n1.bitsPerSec, 25e9, '25000 Mbps → 25 Gb/s');
  assert.equal(n1.rxBytes, 1_000_000);
  const n2 = r.nics.find((x) => x.iface === 'NIC.2-1-1');
  assert.equal(n2.bitsPerSec, null, '링크 속도 0 은 **모른다**(0 이 아니다)');
  assert.equal(r.fcs[0].rxBytes, 4096 * 1024, 'KB → 바이트');
  assert.equal(r.fcs[0].bitsPerSec, 16e9);
  assert.deepEqual(r.read.sort(), ['hba', 'net']);
});

test('⚠ 장비가 가진 리포트 목록을 그대로 보고한다 (사용자 선택: 장비별로 무엇을 읽었는지 밝힌다)', () => {
  const sys = { Id: 'SystemUsage', MetricValues: [{ MetricId: 'SystemBoardCPUUsage', MetricValue: '37' }] };
  const all = ['SystemUsage', 'ThermalSensor', 'PowerMetrics'];
  const r = buildIdracUsage([sys], all);
  assert.deepEqual(r.usedReports, ['SystemUsage']);
  assert.deepEqual(r.seenReports, all, '읽지 않은 것까지 전부 보고한다');
  // NIC·FC·스토리지 리포트가 **없는** 장비 → 그 지표는 '이 경로에 원래 없다'(absent)
  assert.ok(r.absent.includes('net'));
  assert.ok(r.absent.includes('hba'));
  assert.ok(r.absent.includes('disk'));
});

test("⚠ 디스크 busy% 는 이 경로에 없다 — 'absent' 로 밝히고 지어내지 않는다", () => {
  const st = { Id: 'StorageDiskSMARTData', MetricValues: [{ MetricId: 'ReadErrorRate', MetricValue: '0', Oem: { Dell: { FQDD: 'Disk.0' } } }] };
  const r = buildIdracUsage([st], ['StorageDiskSMARTData']);
  assert.ok(!r.absent.includes('disk'), '스토리지 리포트는 있다');
  assert.ok(r.absent.includes('diskbusy'), 'busy% 는 없다고 밝혀야 한다');
  assert.equal(r.disks.some((d) => d.busyPct != null), false);
});

test('빈 문자열이 0 으로 둔갑하지 않는다(파서 전역 규칙)', () => {
  const rep = { Id: 'NICStatistics', MetricValues: [
    { MetricId: 'RxBytes', MetricValue: '', Oem: { Dell: { FQDD: 'NIC.1' } } },
    { MetricId: 'TxBytes', MetricValue: '10', Oem: { Dell: { FQDD: 'NIC.1' } } },
  ] };
  const p = parseReport(rep);
  assert.equal(p.devices.get('NIC.1').rxBytes, undefined, "빈 값은 키를 만들지 않는다");
  assert.equal(p.devices.get('NIC.1').txBytes, 10);
});

// ── iDRAC 누적 카운터 환산(두 주기) ───────────────────────────────────────────
test('⚠⚠ iDRAC 카운터도 next 에 담아야 한다 — 안 담으면 영원히 null 이다', () => {
  const TG = { key: 'K', name: 'bm', vcenterId: 'vc1' };
  const mk = (rx, tx) => ({
    ok: true, full: true, cpuPct: 37, memPct: 55,
    nics: [{ iface: 'NIC.1', rxBytes: rx, txBytes: tx, bitsPerSec: 25e9 }],
    fcs: [], disks: [], read: ['cpumem', 'net'], absent: ['hba', 'disk', 'diskbusy'],
    usedReports: ['SystemUsage', 'NICStatistics'], seenReports: ['SystemUsage', 'NICStatistics'],
  });
  const a = buildUsage({ target: TG, idrac: mk(0, 0), prev: null, now: 1_000 });
  assert.equal(a.row.net_pct, null, '첫 주기는 null(0 이 아니다)');
  assert.ok(a.next?.idrac, 'iDRAC 카운터가 next 에 담겨야 한다');
  // 1초에 rx+tx 62.5MB → 62.5MB/s × 8 / 25Gb = 2%
  const b = buildUsage({ target: TG, idrac: mk(31_250_000, 31_250_000), prev: a.next, now: 2_000 });
  assert.equal(b.row.net_pct, 2);
  assert.equal(b.row.net_bps, 62_500_000);
  assert.equal(b.srcOf.net, 'idrac');
});

test('OS 값이 있으면 iDRAC 이 덮지 않는다 — 빈 칸만 채운다', () => {
  const TG = { key: 'K', name: 'bm', vcenterId: 'vc1' };
  const os = { ok: true, osKind: 'windows', cpuPct: 12, mem: { usedPct: 30 }, disks: [], read: ['cpu', 'mem', 'net'], missing: [],
    nics: [{ iface: 'e', bytesPerSec: 1e6, bitsPerSec: 1e9, pct: 0.8 }], hbas: [] };
  const idrac = { ok: true, full: true, cpuPct: 99, memPct: 99,
    nics: [{ iface: 'NIC.1', rxBytes: 1e9, txBytes: 1e9, bitsPerSec: 25e9 }],
    fcs: [{ host: 'FC.1', rxBytes: 1e8, txBytes: 1e8, bitsPerSec: 16e9 }], disks: [],
    read: ['cpumem', 'net', 'hba'], absent: [], usedReports: [], seenReports: [] };
  const prev = { at: 1_000, counters: null, idrac: { nics: [{ iface: 'NIC.1', rxBytes: 0, txBytes: 0 }], fcs: [{ host: 'FC.1', rxBytes: 0, txBytes: 0 }] } };
  const r = buildUsage({ target: TG, os, idrac, prev, now: 2_000 });
  assert.equal(r.row.cpu_pct, 12, 'CPU 는 OS');
  assert.equal(r.row.net_pct, 0.8, '네트워크도 OS');
  assert.equal(r.srcOf.net, 'os');
  assert.ok(r.row.hba_pct > 0, 'HBA 는 OS 에 없으므로 iDRAC 이 채운다');
  assert.equal(r.srcOf.hba, 'idrac');
});

// ── ④ 임계 초과 알림 ──────────────────────────────────────────────────────────
test('⚠ 한 주기 스파이크로 알리지 않는다(지속 조건)', () => {
  const cfg = { pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000 };
  const T = (m) => 1_789_600_000_000 + m * 60_000;
  let st = null;
  let r = stepAlert(st, 99, cfg, T(0)); st = r.state;
  assert.equal(r.fire, null); assert.equal(r.reason, 'sustaining');
  r = stepAlert(st, 20, cfg, T(5));
  assert.equal(r.fire, null, '내려왔고 알린 적이 없으므로 해제도 없다');
  assert.equal(r.state, null, '추적을 그만둔다');
});

test('지속 시간을 넘기면 알리고, 재알림은 억제한다', () => {
  const cfg = { pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000 };
  const T = (m) => 1_789_600_000_000 + m * 60_000;
  let st = null; let fired = 0;
  for (const [m, v] of [[0, 95], [5, 96], [10, 94], [15, 93], [20, 95], [60, 95]]) {
    const r = stepAlert(st, v, cfg, T(m)); st = r.state;
    if (r.fire === 'over') fired += 1;
  }
  assert.equal(fired, 1, '6시간 억제 안에서는 1회만');
  // 6시간 뒤에는 다시 알린다(계속 나쁘면 다시 알려야 한다)
  const r2 = stepAlert(st, 95, cfg, T(60 + 6 * 60 + 1));
  assert.equal(r2.fire, 'over');
});

test('⚠⚠ 못 읽은 주기는 초과도 정상도 아니다 — 판정 보류', () => {
  const cfg = { pct: 90, sustainMin: 15, repeatHours: 6, intervalMs: 300_000 };
  const T = (m) => 1_789_600_000_000 + m * 60_000;
  const st = { since: T(0), lastOverAt: T(10), peak: 95, notifiedAt: null };
  const r = stepAlert(st, null, cfg, T(12));
  assert.equal(r.fire, null); assert.equal(r.reason, 'unknown');
  assert.deepEqual(r.state, st, '상태를 바꾸지 않는다');
  // 오래 값이 없으면 진행 중이던 초과를 끊는다 — 단 **해제 알림은 없다**(복구가 아니라 모르는 것)
  const stale = stepAlert(st, null, cfg, T(10 + 60));
  assert.equal(stale.state, null);
  assert.equal(stale.fire, null, '모르는 것을 복구라고 말하지 않는다');
});

test('경계에서 떨리는 것을 해제로 보지 않는다(히스테리시스)', () => {
  const cfg = { pct: 90, sustainMin: 0, repeatHours: 6, intervalMs: 300_000 };
  const st = { since: 1000, lastOverAt: 2000, peak: 95, notifiedAt: 2000 };
  assert.equal(stepAlert(st, 90 - HYSTERESIS_PCT + 1, cfg, 3000).fire, null, '임계-2 는 유지');
  assert.equal(stepAlert(st, 90 - HYSTERESIS_PCT - 1, cfg, 3000).fire, 'recovered', '임계-4 는 해제');
});

test('임계가 없으면 판정하지 않는다(설정이 비었을 때 전 서버가 초과가 되지 않게)', () => {
  for (const pct of [0, null, undefined, '']) {
    const r = stepAlert(null, 99, { pct }, 1000);
    assert.equal(r.fire, null, `pct=${JSON.stringify(pct)} 에서 알렸다`);
    assert.equal(r.reason, 'no-threshold');
  }
});

test('evaluateRows — 이번 주기에 없던 서버의 추적을 버리지 않는다', () => {
  const cfg = { pct: 90, sustainMin: 0, repeatHours: 6, intervalMs: 300_000 };
  const now = 1_789_600_000_000;
  const prev = { 'GONE|cpu_pct': { since: now - 60_000, lastOverAt: now - 60_000, peak: 95, notifiedAt: now - 60_000 } };
  const { next } = evaluateRows([{ key: 'A', name: 'a', cpu_pct: 10 }], prev, cfg, now);
  assert.ok(next['GONE|cpu_pct'], '수집이 한 번 빠진 것으로 추적을 버리면 다음 주기가 새 초과가 된다');
  // 아주 오래된 것은 버린다(등록에서 사라진 서버가 영원히 남지 않게)
  const old = { 'OLD|cpu_pct': { since: 0, lastOverAt: now - 30 * 86_400_000, peak: 95, notifiedAt: 0 } };
  const r2 = evaluateRows([], old, cfg, now);
  assert.equal(r2.next['OLD|cpu_pct'], undefined);
});

test('감시 지표는 퍼센트 6개 — 처리량(B/s)에는 임계를 두지 않는다', () => {
  const cols = ALERT_METRICS.map((m) => m.col);
  assert.deepEqual(cols, ['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_used_pct', 'net_pct', 'hba_pct']);
  for (const bad of ['net_bps', 'hba_bps', 'io_pct']) assert.ok(!cols.includes(bad), `${bad} 에 임계를 뒀다`);
});

test('알림 본문에 `**` 를 쓰지 않는다 (Slack·메일엔 BoldText 가 없다 — v2.548 규약)', () => {
  const a = alertOf({ kind: 'over', key: 'K', name: 'bm-1', vcenterId: 'vc1', metric: 'cpu_pct', label: 'CPU', value: 95, peak: 97, sustainedMin: 20, pct: 90 });
  assert.ok(!/\*\*/.test(`${a.title} ${a.detail}`), '별표가 그대로 나간다');
  assert.equal(a.severity, 'critical', '임계+5 이상은 critical');
  const b = alertOf({ kind: 'over', key: 'K', name: 'x', metric: 'mem_pct', label: '메모리', value: 91, sustainedMin: 20, pct: 90 });
  assert.equal(b.severity, 'warning');
  const c = alertOf({ kind: 'recovered', key: 'K', name: 'x', metric: 'cpu_pct', label: 'CPU', value: 70, pct: 90 });
  assert.match(c.title, /해제/);
});

// ── 설정·예산 ────────────────────────────────────────────────────────────────
test('알림은 기본 꺼짐이고 전수 모드는 기본 켜짐 (폭주 위험 vs 사용자가 원한 기능)', () => {
  assert.equal(DEFAULTS.alertEnabled, false);
  assert.equal(DEFAULTS.idracFullTelemetry, true);
  const s = normalizeSettings({ alertEnabled: 'yes', alertPct: 5, alertSustainMin: 9999, alertRepeatHours: 0, idracFullTelemetry: false });
  assert.equal(s.alertEnabled, false, '문자열 truthy 를 켜짐으로 읽지 않는다(명시 true 만)');
  assert.equal(s.alertPct, 50, '하한');
  assert.equal(s.alertSustainMin, 240, '상한');
  assert.equal(s.alertRepeatHours, 1, '하한');
  assert.equal(s.idracFullTelemetry, false, '끌 수 있다(회선이 좁은 법인의 탈출구)');
});

test('⚠⚠ 왕복 예산 — 목록 캐시와 주기당 예산이 둘 다 있어야 한다', () => {
  /*
   * 실제 산수: 장비당 `목록 1 + 리포트 6개(동시 3) = 3배치 × 2초 ≈ 6초`. 200대 · 동시 4면 **300초**로
   * 주기(300초)와 같아진다. 캐시(6시간) + 주기당 목록 조회 예산이 그것을 막는다.
   */
  const rf = bare('idrac/redfish.js');
  assert.match(rf, /REPORT_TTL_MS/, '리포트 목록 캐시가 있어야 한다');
  assert.match(rf, /REPORT_FETCH_CONCURRENCY = 3/, '한 장비 안 동시 GET 상한');
  assert.match(rf, /if \(!allowList\) return null/, '예산이 없으면 목록을 조회하지 않는다');
  const pl = bare('bmusage/poller.js');
  assert.match(pl, /LIST_BUDGET_PER_RUN/);
  assert.match(pl, /_listBudget = LIST_BUDGET_PER_RUN/, '주기 시작마다 리셋');
  assert.match(pl, /if \(allowList\) _listBudget -= 1/, '장비마다 예산을 깎는다');
  // 산수 자체도 고정한다
  const perDev = (1 + Math.ceil(6 / 3)) * 2;
  assert.equal(perDev, 6);
  assert.equal(Math.ceil(200 / 4) * perDev, 300, '캐시 없으면 주기와 같아진다 — 캐시가 필수다');
  assert.equal(Math.ceil(200 / 4) * (Math.ceil(6 / 3) * 2), 200, '캐시 적중 시 200초');
});

test('전수 모드가 실패하면 SystemUsage 단독 경로로 떨어진다 (개선이 퇴행이 되지 않게)', () => {
  const rf = bare('idrac/redfish.js');
  assert.match(rf, /const fb = await fetchUsage\(entry, \{ full: false \}\)/, '폴백이 있어야 한다');
  assert.match(rf, /if \(\/\\b40\[13\]\\b\/\.test\(msg\)\) return \{ ok: false, kind: 'auth'/, '401·403 은 폴백하지 않는다(계정 잠금)');
});

test('알림 상태는 파일에 남긴다 — 인메모리면 재시작마다 알림이 폭주한다', () => {
  const nf = bare('bmusage/notify.js');
  assert.match(nf, /atomicWriteFileSync/, '원자적 쓰기');
  assert.match(nf, /chmodSync\(FILE\(\), 0o600\)/, '0600(v2.535 규약)');
  assert.match(nf, /bmusage-alert-state\.json/);
  assert.match(nf, /await sendAlert\(/, '순차 발송');
  assert.match(nf, /capped:/, '상한으로 잘린 개수를 밝힌다');
  // 위험한 것을 먼저 보낸다 — 상한에 걸려 해제 알림이 초과를 밀어내면 안 된다
  assert.match(nf, /a\.kind === 'over' \? -1 : 1/);
});

test('새 상태 파일은 .gitignore 에 등록한다 (server/CLAUDE.md v2.535 규약)', () => {
  const gi = fs.readFileSync(path.join(import.meta.dirname, '../../.gitignore'), 'utf8');
  for (const f of ['bmusage-alert-state.json', 'bmusage-auth-stops.json', 'bmusage-activity.json', 'bmusage-settings.json']) {
    assert.ok(gi.includes(`server/config/${f}`), `${f} 가 .gitignore 에 없다`);
  }
});
