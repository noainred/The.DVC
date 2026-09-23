/**
 * v2.595 — 6차 점검(7축 병렬 감사 + 축별 반증 검증) 확정분 회귀 고정.
 *
 * 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 릴리스 노트에 기록).
 * 상태를 가진 모듈은 임시 CONFIG_DIR 을 먼저 정한 뒤 동적으로 불러온다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2595-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';

/* ── R2595-01 IPAM 범위 판정 — 선행 0 표기로 범위 밖 IP 에 쓰던 것 ── */
test('R2595-01 — 범위 판정은 정규형 IP 로 소유자를 찾는다(선행 0 표기 우회 차단)', async () => {
  const { ipInWriteScope } = await import('../src/routes/api/ipamExport.js');
  const owners = new Map([['10.37.0.1', new Set(['vc-us-west'])]]);
  const allowed = new Set(['vc-us-east']);
  assert.equal(ipInWriteScope(allowed, owners, '10.37.0.1', 'vc-us-east'), false);
  assert.equal(ipInWriteScope(allowed, owners, '010.37.0.1', 'vc-us-east'), false, '예전: true(미귀속으로 보고 claim 만 확인)');
  assert.equal(ipInWriteScope(allowed, owners, '10.99.0.1', 'vc-us-east'), true, '진짜 미귀속 IP 는 claim 으로 허용');
  assert.equal(ipInWriteScope(allowed, owners, 'not-an-ip', 'vc-us-east'), false);
  const { canonIp } = await import('../src/util/ipv4.js');
  assert.equal(canonIp('010.037.000.001'), '10.37.0.1');
  assert.equal(canonIp('x'), null);
  assert.ok(!/export const canonIp/.test(read('ipam/overrides.js')), '정규형은 util/ipv4.js 하나(코어는 하나다)');
});

/* ── C2595-01 SSH 스토리지 사용량 결측 ── */
test('C2595-01 — SSH 수집기(PowerStore·Isilon)는 못 읽은 사용량을 0 으로 만들지 않는다', async () => {
  const { toBytesOrNull } = await import('../src/storage/collectors/cliSsh.js');
  assert.equal(toBytesOrNull('N/A'), null);
  assert.equal(toBytesOrNull(''), null);
  assert.equal(toBytesOrNull('abc'), null);
  assert.equal(toBytesOrNull('0'), 0, '보고된 0 은 값이다');
  assert.equal(toBytesOrNull('0 (0.0T)'), 0);
  const { normalizePowerstoreSsh } = await import('../src/storage/collectors/powerstoreSsh.js');
  const p = normalizePowerstoreSsh({ id: 'p', type: 'powerstore', host: 'h' }, { space: JSON.stringify([{ physical_total: '1000', physical_used: 'N/A' }]) });
  assert.equal(p.capacity.totalBytes, 1000);
  assert.equal(p.capacity.usedBytes, null);
  assert.equal(p.capacity.pct, null);
  const { normalizeIsiStatus, parseSizeOrNull } = await import('../src/storage/collectors/isilonSsh.js');
  assert.equal(parseSizeOrNull('-'), null);
  assert.equal(parseSizeOrNull('2.0T'), 2 * 1024 ** 4);
  const i = normalizeIsiStatus({ id: 'i', type: 'isilon', host: 'h' }, { name: 'c', hdd: { sizeBytes: 1000, usedBytes: null }, ssd: { sizeBytes: 100, usedBytes: 30 }, nodes: [] });
  assert.equal(i.capacity.totalBytes, 1100);
  assert.equal(i.capacity.usedBytes, null, '부분 합(30)을 전체라 말하지 않는다');
  assert.match(read('storage/collectors/xtremioSsh.js'), /toBytesOrNull\(pick\(c, 'Physical-Space-In-Use'/);
});

/* ── C2595-02 iDRAC 텔레메트리 퍼센트 ── */
test('C2595-02 — MetricValue null·N/A·-1·150 은 퍼센트가 아니다', async () => {
  const { pctFromMetric } = await import('../src/idrac/redfish.js');
  for (const v of [null, undefined, '', 'N/A', '-1', '150', -1, 101, 'abc']) assert.equal(pctFromMetric(v), null, String(v));
  assert.equal(pctFromMetric('37'), 37);
  assert.equal(pctFromMetric('37.5 %'), 37.5);
  assert.equal(pctFromMetric(0), 0);
  assert.ok(!/replace\(\/\[\^\\d\.\]\/g, ''\)\)/.test(read('idrac/redfish.js')), '숫자만 뽑는 옛 파서가 남았다');
});

/* ── C2595-03 디렉터 sfpshow 슬롯 ── */
test('C2595-03 — 디렉터 sfpshow 는 slot/port 로 구분한다(다른 포트의 광량이 붙지 않는다)', async () => {
  const { parseSfpShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const t = ['Slot  1/Port  0:', 'RX Power: -3.0 dBm (500 uW)', 'Slot  2/Port  0:', 'RX Power: -9.5 dBm (100 uW)'].join('\n');
  const r = parseSfpShow(t);
  assert.equal(r['1/0'].rxPowerDbm, -3);
  assert.equal(r['2/0'].rxPowerDbm, -9.5);
  const fixed = parseSfpShow('Port  4:\nRX Power: -2.0 dBm (600 uW)');
  assert.equal(fixed[4].rxPowerDbm, -2, '픽스드 스위치는 예전처럼 포트 번호 키');
  assert.match(read('sanswitch/collectors/fosSsh.js'), /p\.slot != null \? sfps\[p\.slotPort\] : sfps\[p\.index\]/);
});

/* ── C2595-04·05 ── */
test('C2595-04 — 끝의 슬래시를 뗀 경로로 df 와 대조 · C2595-05 Isilon 전체 용량 키 없음은 섹션 오류', async () => {
  const { sanitizeMounts, parseDfOutput } = await import('../src/bmstor/collect.js');
  const { mounts } = sanitizeMounts(['/data/', '/']);
  assert.deepEqual(mounts, ['/data', '/']);
  const df = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdb1 100 40 60 40% /data';
  assert.equal(parseDfOutput(df, mounts).mounts.length, 1);
  const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
  const s = normalizeIsilon({ id: 'i', type: 'isilon', host: 'h' }, { stats: { stats: [{ key: 'ifs.bytes.used', value: 5 }] } });
  assert.notEqual(s.sections.capacity, 'ok');
  assert.match(s.sections.capacity, /ifs\.bytes\.total 없음/);
});

/* ── R2595-03 vmtrack 대기 기준 · T2595-04 prune 첫 틱 ── */
test('R2595-03 — vmtrack 첫 수집 대기는 pending 을 처음 본 시각 기준 · T2595-04 prune 은 기동 첫 틱에 돌지 않는다', () => {
  const p = read('vmtrack/poller.js');
  assert.match(p, /const first = waiting\?\.slot === cur \? waiting\.firstSeenAt : Date\.now\(\);/);
  assert.ok(!/slotStartMs\(cur\)/.test(p), '슬롯 시작 기준이 남았다');
  assert.match(p, /let lastPruneAt = Date\.now\(\);/);
  assert.match(read('guestdisk/poller.js'), /let lastPruneTs = Date\.now\(\);/);
});

/* ── R2595-04·05 · WT-01 사용률 기준 ── */
test('R2595-04·WT-01 — 사용량을 읽을 호스트가 없으면 사용률 null · 제외 대수를 싣는다 · /summary 도 같은 기준', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const h = (id, st, u) => ({ id, vcenterId: 'vc1', connectionState: st, cpuTotalMhz: 1000, cpuUsageMhz: u, memTotalMB: 1000, memUsageMB: u });
  const all = scopedRollups({ vcenters: [{ id: 'vc1', status: 'connected' }], hosts: [h('a', 'DISCONNECTED', 0), h('b', 'NOT_RESPONDING', 0)], vms: [], datastores: [], networks: [], alarms: [] }, new Set(['vc1']));
  assert.equal(all.global.cpuUsagePct, null, '예전: 0%');
  assert.equal(all.global.memUsagePct, null);
  assert.equal(all.global.hostsUsageExcluded, 2, 'NOT_RESPONDING 도 센다(hostsDisconnected 에는 없다)');
  const mix = scopedRollups({ vcenters: [{ id: 'vc1', status: 'connected' }], hosts: [h('a', 'CONNECTED', 500), h('b', 'DISCONNECTED', 0)], vms: [], datastores: [], networks: [], alarms: [] }, new Set(['vc1']));
  assert.equal(mix.global.cpuUsagePct, 50);
  assert.equal(mix.global.cpuTotalReadableGhz, 1);
  const inv = read('routes/api/inventory.js');
  assert.match(inv, /cpuUsagePct: cpuPctR/);
  assert.match(inv, /hostsUsageExcluded: hosts\.length - hostsR\.length/);
});

/* ── AUTHZ-2595-01~04 ── */
test('AUTHZ-2595-01 — svcmon 엣지 주소는 admin + 전체 범위만', async () => {
  const { redactEdgeSummary } = await import('../src/auth/scopeStatus.js');
  const e = [{ agent: 'a', sourceIp: '10.0.0.9', portalPort: 4000, items: 3 }];
  assert.deepEqual(redactEdgeSummary(e, false)[0], { agent: 'a', sourceIp: null, portalPort: null, items: 3 });
  assert.equal(redactEdgeSummary(e, true)[0].sourceIp, '10.0.0.9');
  for (const f of ['routes/svcmon/edge.js', 'routes/svcmon/overview.js']) {
    const s = read(f);
    assert.ok(!/edges: edgeSummary\(/.test(s), `${f}: 가리지 않은 edgeSummary 가 응답에 남았다`);
  }
});
test('AUTHZ-2595-02~04 — vmseries push 범위 · DB 경로는 admin 만', () => {
  const v = read('routes/api/vmSeries.js');
  assert.ok(!/push: vmSeriesPushStatus\(\)/.test(v), 'push 가 거르지 않은 채 나간다');
  assert.match(v, /function scopeVmSeriesPush/);
  assert.match(read('routes/api/vmtrack.js'), /req\.user\?\.role !== 'admin' \? \(\(\{ dbPath, \.\.\.r \}\)/);
  assert.ok(!/db: await hzSessionDbStatus\(\)/.test(read('routes/api/horizonSessions.js')));
  assert.ok(!/(db|historyDb): await healthHistoryStatus\(\)/.test(read('routes/api/sanSwitch.js')));
});

/* ── FS-1~5 ── */
test('FS-1 — 설정·실행 결과가 섞인 파일은 last* 만 바뀌면 지문이 같다', async () => {
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const a = { 'os-scan.json': JSON.stringify({ enabled: true, intervalMin: 60, lastRun: 1, lastFound: 3 }) };
  const b = { 'os-scan.json': JSON.stringify({ enabled: true, intervalMin: 60, lastRun: 2, lastFound: 4 }) };
  const c = { 'os-scan.json': JSON.stringify({ enabled: true, intervalMin: 30, lastRun: 2, lastFound: 4 }) };
  assert.equal(settingsFingerprint(a), settingsFingerprint(b));
  assert.notEqual(settingsFingerprint(a), settingsFingerprint(c), '설정 변경은 여전히 잡는다');
});
test('FS-2·FS-3 — 실행 결과는 id 로 찾은 현재 항목에 쓴다', () => {
  const m = read('net/monitor.js');
  assert.match(m, /function recordRun\(m, fields\)/);
  assert.ok(!/m\.lastRun = Date\.now\(\); m\.lastWorst/.test(m));
  assert.match(read('security/guestScanScheduler.js'), /const cur = \(load\(\) \|\| \[\]\)\.find\(\(x\) => x\.id === j\.id\);/);
});
test('FS-4 — finops 설정 손상은 원본을 보존하고 기본값으로 시작한다', async () => {
  fs.writeFileSync(path.join(CFG, 'finops.json'), '{broken');
  const { loadFinopsConfig } = await import('../src/insights/finops.js');
  const c = loadFinopsConfig();
  assert.ok(c && typeof c === 'object');
  assert.ok(fs.readdirSync(CFG).some((n) => n.startsWith('finops.json.corrupt')), '손상 원본을 남긴다');
  assert.match(read('reports/dailyReport.js'), /preserveCorrupt\(FILE, e\?\.message\)/);
});
test('FS-5 — portalDb 용도 표의 키는 실제 파일명이다', () => {
  const s = read('insights/portalDb.js');
  for (const ghost of ['session-security.json', 'os-results.json', 'backup-settings.json', 'log-settings.json', 'net-monitors.json', 'central-token.json', 'idrac-assignments.json']) {
    assert.ok(!s.includes(`'${ghost}'`), `유령 이름 ${ghost}`);
  }
});

/* ── T2595-01 알림 주기 상한 ── */
test('T2595-01 — 알림 엔진 주기는 1일을 넘지 않는다(24.8일 초과 → 1ms 틱)', async () => {
  const a = await import('../src/alerts.js');
  a.saveAlertConfig({ intervalSec: 9_999_999_999 });
  assert.ok(a.loadAlertConfig().intervalSec <= a.ALERT_INTERVAL_MAX_SEC);
  assert.ok(a.ALERT_INTERVAL_MAX_SEC * 1000 < 2 ** 31 - 1);
});

/* ── WT-02·03 서버 문구 백틱 ── */
test('WT-02·03 — BoldText 로 그려지는 서버 문구에 백틱이 없다', async () => {
  const { adviseRow } = await import('../src/util/bulkAdvice.js');
  const r = adviseRow({ _line: 3, type: 'nope' }, 'type 이 올바르지 않습니다', { lineText: 'x,nope', order: ['host', 'type'], ctx: { types: ['isilon', 'unity480'] } });
  assert.ok(!/`/.test(r.advice), r.advice);
  for (const f of ['util/bulkAdvice.js', 'central/scanRemedy.js']) {
    const s = read(f);
    assert.equal((s.match(/\\`/g) || []).length, 0, `${f}: 이스케이프된 백틱`);
    assert.equal([...s.matchAll(/'(?:[^'\\\n]|\\.)*'/g)].filter((m) => m[0].includes('`')).length, 0, `${f}: 문자열 안 백틱`);
  }
});

/* ── WT-06 vmtrack DS 사용률 ── */
test('WT-06 — 데이터스토어 사용률은 모르면 null(0% 가 아니다)', () => {
  const s = read('vmtrack/service.js');
  assert.ok(!/usagePct: r\.cap_gb \? Math\.round\(\(\(r\.used_gb \|\| 0\)/.test(s));
  assert.match(s, /const dsPct = \(used, cap\) => \(cap > 0 && used != null/);
});

/* ── DEPS2595-01·02 ── */
test('DEPS2595-01 — 숫자 설정의 빈 칸은 이전 값을 유지한다 · DEPS2595-02 인시던트 limit 하한', async () => {
  const { clampSetting } = await import('../src/util/clampSetting.js');
  assert.equal(clampSetting('', { min: 5, max: 100, def: 720 }), 720, '예전: 5');
  assert.equal(clampSetting(null, { min: 5, def: 7 }), 7);
  assert.equal(clampSetting('0', { min: 0, max: 10, def: 3 }), 0, '명시적 0 은 값');
  assert.equal(clampSetting('3.6', { min: 1, max: 10, def: 1 }), 4);
  const os2 = await import('../src/inventory/osScanner.js');
  const before = os2.loadOsScanSettings();
  const after = os2.saveOsScanSettings({ intervalMin: '', rescanDays: '', maxVms: '', concurrency: '' });
  assert.equal(after.intervalMin, before.intervalMin);
  assert.equal(after.rescanDays, before.rescanDays);
  assert.equal(after.maxVms, before.maxVms);
  assert.equal(after.concurrency, before.concurrency);
  assert.match(read('routes/insights.js'), /limit: pageArgs\(req\.query, \{ def: 200, max: 1000 \}\)\.limit/);
});
