// v2.706 — C5 VM 생성·삭제 이력 · C4 크래시 대비(스크래치·로그·진단 파티션·PSOD·재부팅 분류) · C2/C3 CPU 경합·디스크 지연.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ops2706-'));
process.env.CONFIG_DIR = TMP;
const { eventDetail, detailJson, LIFE_TYPES, OPS_TYPES, OPS_SQL, TRACKED_TYPES, LIFE_KIND } = await import('../src/vmchanges/eventDetail.js');
const { analyzeLifecycle, LIFE_ROWS_MAX } = await import('../src/vmlife/analyze.js');
const { analyzeReboots, REBOOT_KINDS, PLANNED_WINDOW_MS, LOST_WINDOW_MS } = await import('../src/hostcfg/reboots.js');
const hc = await import('../src/hostcfg/parse.js');
const cp = await import('../src/contention/parse.js');
const { analyzeContention, staleAfterMs } = await import('../src/contention/analyze.js');
const cache = await import('../src/contention/cache.js');

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)

// ── C5 ──────────────────────────────────────────────────────────────────────
test('① 생성·삭제 상세 — 종류·호스트·DS·원본·이름 변경 전후 / 추적 인덱스와 겹치지 않는다', () => {
  const clone = eventDetail('VmClonedEvent', '<host><host type="HostSystem">h1</host><name>esx-a</name></host><ds><datastore type="Datastore">d</datastore><name>DS1</name></ds><sourceVm><vm type="VirtualMachine">vm-9</vm><name>gold</name></sourceVm>');
  assert.deepEqual(clone, { kind: 'clone', host: 'esx-a', ds: 'DS1', source: 'gold' });
  assert.equal(eventDetail('VmDeployedEvent', '<srcTemplate><vm>vm-1</vm><name>tpl-rhel</name></srcTemplate>').source, 'tpl-rhel');
  assert.deepEqual(eventDetail('VmRenamedEvent', '<oldName>a&amp;b</oldName><newName>c</newName>'), { kind: 'rename', oldName: 'a&b', newName: 'c' });
  assert.deepEqual(eventDetail('VmRemovedEvent', ''), { kind: 'remove' });
  for (const t of OPS_TYPES) { assert.match(t, /^[A-Za-z]+$/); assert.ok(!TRACKED_TYPES.includes(t), `${t} 가 두 인덱스에 겹친다`); }
  for (const t of LIFE_TYPES) assert.ok(LIFE_KIND[t]);
});

test('② opsEvents — 부분 인덱스로 읽고 종류·기간·엔티티로 거른다 · firstTs', async () => {
  const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  db.insertMany([
    { vcenterId: 'vc1', key: 'a', ts: NOW - H, severity: 'info', type: 'VmCreatedEvent', user: 'alice', entity: 'new01', message: 'c', detail: detailJson(eventDetail('VmCreatedEvent', '')) },
    { vcenterId: 'vc1', key: 'b', ts: NOW - 2 * H, severity: 'info', type: 'EnteredMaintenanceModeEvent', user: 'bob', entity: 'esx-a', message: 'm' },
    { vcenterId: 'vc1', key: 'c', ts: NOW - 3 * H, severity: 'info', type: 'VmMigratedEvent', user: 'x', entity: 'web', message: 'mv' },
    { vcenterId: 'vc2', key: 'd', ts: NOW - 30 * DAY, severity: 'info', type: 'VmRemovedEvent', user: 'y', entity: 'old', message: 'r' },
  ]);
  const all = db.opsEvents({ vcenterIds: ['vc1', 'vc2'], since: NOW - 60 * DAY }, 100);
  assert.deepEqual(all.map((r) => r.type), ['VmCreatedEvent', 'EnteredMaintenanceModeEvent', 'VmRemovedEvent'], '이동 이벤트는 빠진다');
  assert.equal(db.opsEvents({ vcenterIds: ['vc1'], types: LIFE_TYPES, since: 0 }, 10).length, 1);
  assert.equal(db.opsEvents({ vcenterIds: ['vc1'], since: 0, entity: 'esx-a' }, 10).length, 1);
  assert.deepEqual(db.opsEvents({ vcenterIds: [] }, 10), [], '빈 vCenter 목록은 0건');
  assert.equal(db.firstTs('vc2'), NOW - 30 * DAY);
  resetLogsDb();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 'vcenter-logs.db'));
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events INDEXED BY idx_events_ops WHERE type IN ${OPS_SQL} AND vcenterId IN (?) AND ts>=? ORDER BY ts DESC LIMIT 10`).all('vc1', 0).map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_events_ops/, plan);
  raw.close();
  assert.match(fs.readFileSync(new URL('../src/logs/db.js', import.meta.url), 'utf8'), /FROM events INDEXED BY idx_events_ops WHERE/);
});

const life = (vc, vm, ts, type, user = 'u', d) => ({ vcenterId: vc, ts, type, user, entity: vm, message: '', detail: d === undefined ? detailJson(eventDetail(type, '')) : d });

test('③ 생성·삭제 분석 — 순증·사용자·단명 VM·지금 있는가·상한', () => {
  const rows = [
    life('vc1', 'tmp1', NOW - 5 * H, 'VmClonedEvent', 'alice'),
    life('vc1', 'tmp1', NOW - 2 * H, 'VmRemovedEvent', 'alice'),
    life('vc1', 'web01', NOW - DAY, 'VmCreatedEvent', 'bob'),
    life('vc1', 'web01', NOW - DAY + 1, 'VmRenamedEvent', 'bob'),
    life('vc2', 'old', NOW - 2 * DAY, 'VmRemovedEvent', 'carol', null),
    { vcenterId: 'vc1', ts: NOW, type: 'VmMigratedEvent', user: '', entity: 'x', message: '', detail: null },
  ];
  const live = new Map([['vc1', new Set(['web01'])], ['vc2', new Set()]]);
  const r = analyzeLifecycle(rows, { days: 7, now: NOW, liveNames: live });
  assert.equal(r.total, 5, '이동 이벤트는 세지 않는다');
  assert.equal(r.added, 2); assert.equal(r.removed, 2); assert.equal(r.net, 0);
  assert.equal(r.byKind.rename, 1);
  assert.equal(r.noDetail, 1);
  assert.equal(r.shortLivedCount, 1); assert.equal(r.shortLived[0].vm, 'tmp1'); assert.equal(r.shortLived[0].lifeMs, 3 * H);
  assert.equal(r.series.length, 7);
  assert.equal(r.series.reduce((a, s) => a + s.added, 0), 2); assert.equal(r.series.reduce((a, s) => a + s.removed, 0), 2);
  assert.equal(r.events.find((e) => e.vm === 'web01' && e.kind === 'create').existsNow, true);
  assert.equal(r.events.find((e) => e.vm === 'old').existsNow, false);
  assert.equal(analyzeLifecycle(rows, { days: 7, now: NOW }).events[0].existsNow, null, '인벤토리를 모르면 null');
  assert.equal(analyzeLifecycle(rows, { kind: 'added', now: NOW }).matched, 2);
  assert.equal(analyzeLifecycle(rows, { kind: 'added', now: NOW }).total, 5, '필터는 전체 개수를 바꾸지 않는다');
  assert.equal(analyzeLifecycle(rows, { q: 'CAROL', now: NOW }).matched, 1);
  const u = r.users.find((x) => x.user === 'alice');
  assert.deepEqual([u.added, u.removed], [1, 1]);
  const many = Array.from({ length: LIFE_ROWS_MAX + 3 }, (_, i) => life('vc1', `v${i}`, NOW - i, 'VmCreatedEvent'));
  const m = analyzeLifecycle(many, { now: NOW });
  assert.equal(m.events.length, LIFE_ROWS_MAX); assert.equal(m.omitted, 3);
});

// ── C4 ──────────────────────────────────────────────────────────────────────
test('④ 스크래치·로그 위치 판정 — 램디스크·빈 값·스크래치를 따라가는 로그 · 모르면 판정하지 않는다', () => {
  assert.equal(hc.scratchVolatile('/tmp/scratch'), true);
  assert.equal(hc.scratchVolatile(''), true, '빈 값 = 영구 위치 없음');
  assert.equal(hc.scratchVolatile('/vmfs/volumes/ds1/.locker'), false);
  assert.equal(hc.scratchVolatile(null), false, '못 읽음은 판정하지 않는다');
  assert.equal(hc.logDirVolatile('[] /scratch/log', '/tmp/scratch'), true);
  assert.equal(hc.logDirVolatile('[] /scratch/log', '/vmfs/volumes/x/.locker'), false);
  assert.equal(hc.logDirVolatile('[] /scratch/log', null), null, '스크래치를 모르면 모른다');
  assert.equal(hc.logDirVolatile('/tmp/log', null), true);
  assert.equal(hc.logDirVolatile('[ds1] logs/esx', null), false);
  assert.equal(hc.logDirVolatile('', '/tmp/scratch'), null);
});

test('⑤ 크래시 대비 판정 코드 — 로그 소실·휘발성·진단 파티션·PSOD · 정제', () => {
  const base = { connectionState: 'CONNECTED', hcfg: { scratch: '/tmp/scratch', logDir: '[] /scratch/log', syslogHost: '', diagPartition: false, bsodTimeout: 0 } };
  const codes = hc.hostCfgFindings(base, NOW).map((f) => f.code);
  for (const c of ['scratch-volatile', 'logs-lost', 'coredump-partition-none', 'psod-no-reboot']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('logs-volatile'));
  const remote = hc.hostCfgFindings({ ...base, hcfg: { ...base.hcfg, syslogHost: 'udp://log:514' } }, NOW).map((f) => f.code);
  assert.ok(remote.includes('logs-volatile') && !remote.includes('logs-lost'), '원격 syslog 가 있으면 소실이 아니라 휘발성');
  const unknown = hc.hostCfgFindings({ connectionState: 'CONNECTED', hcfg: { scratch: null, logDir: null, syslogHost: null, diagPartition: null, bsodTimeout: null } }, NOW).map((f) => f.code);
  for (const c of ['scratch-volatile', 'logs-lost', 'logs-volatile', 'coredump-partition-none', 'psod-no-reboot']) assert.ok(!unknown.includes(c), `모르는 값으로 ${c} 를 내지 않는다`);
  assert.equal(hc.HOST_CFG_CODES['logs-lost'], 'crit');
  const s = hc.sanitizeHostCfg({ ...base.hcfg, bsodTimeout: '0', diagPartition: 'yes', scratch: '/tmp/scratch' });
  assert.equal(s.diagPartition, null, '불리언이 아니면 null');
  assert.equal(s.scratch, '/tmp/scratch');
  assert.ok(hc.ADV_OPTIONS.includes('ScratchConfig.CurrentScratchLocation') && hc.ADV_OPTIONS.includes('Misc.BlueScreenTimeout'));
});

test('⑥ 재부팅 분류 — 계획(유지보수)·예기치 않음(연결 끊김)·원인 불명·이벤트 없음 · 끊긴 호스트 제외', () => {
  const boot = NOW - 5 * H;
  const hosts = [
    { id: 'h1', name: 'esx-a', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h2', name: 'esx-b', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h3', name: 'esx-c', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h4', name: 'esx-d', vcenterId: 'vc2', connectionState: 'CONNECTED', bootTime: boot },
    { id: 'h5', name: 'esx-e', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: null },
    { id: 'h6', name: 'esx-f', vcenterId: 'vc1', connectionState: 'DISCONNECTED', bootTime: boot },
    { id: 'h7', name: 'esx-g', vcenterId: 'vc1', connectionState: 'CONNECTED', bootTime: NOW - 40 * DAY },
  ];
  const ev = [
    { vcenterId: 'vc1', entity: 'esx-a', ts: boot - 3 * H, type: 'EnteredMaintenanceModeEvent', user: 'adm' },
    { vcenterId: 'vc1', entity: 'esx-b', ts: boot - 10 * 60_000, type: 'HostConnectionLostEvent' },
    { vcenterId: 'vc1', entity: 'esx-c', ts: boot - LOST_WINDOW_MS - 60_000, type: 'HostConnectionLostEvent' },
  ];
  const cov = (vc) => (vc === 'vc1' ? { firstTs: NOW - 60 * DAY, lastTs: NOW } : null);
  const r = analyzeReboots(hosts, ev, { now: NOW, days: 30, coverageOf: cov });
  const k = Object.fromEntries(r.rows.map((x) => [x.name, x.kind]));
  assert.deepEqual(k, { 'esx-a': 'planned', 'esx-b': 'unexpected', 'esx-c': 'unknown', 'esx-d': 'no-events' });
  assert.equal(r.bootUnknown, 1);
  assert.deepEqual(r.counts, { unexpected: 1, unknown: 1, 'no-events': 1, planned: 1 });
  assert.equal(r.rows[0].kind, 'unexpected', '예기치 않은 재부팅이 먼저');
  assert.equal(r.rows.find((x) => x.name === 'esx-a').evidence.user, 'adm');
  assert.ok(PLANNED_WINDOW_MS > LOST_WINDOW_MS);
  assert.deepEqual([...REBOOT_KINDS].sort(), Object.keys(r.counts).sort());
  // 수집 시작이 부팅 2시간 전보다 늦으면 받았다고 보지 않는다
  const late = analyzeReboots([hosts[2]], [], { now: NOW, coverageOf: () => ({ firstTs: boot - H, lastTs: NOW }) });
  assert.equal(late.rows[0].kind, 'no-events');
});

// ── C2·C3 ───────────────────────────────────────────────────────────────────
const perfXml = (ent, type, series) => `<returnval><entity type="${type}">${ent}</entity>${series.map(([cid, inst, vals]) => `<value><id><counterId>${cid}</counterId><instance>${inst}</instance></id>${vals.map((v) => `<value>${v}</value>`).join('')}</value>`).join('')}</returnval>`;

test('⑦ VM 요약 — Ready %/vCPU 환산·latency ×100·가장 나쁜 디스크 · -1·vCPU 모름은 null', () => {
  const ids = { ready: 1, costop: 2, latency: 3, read: 4, write: 5 };
  const xml = perfXml('vm-1', 'VirtualMachine', [
    [1, '', [4000, 2000, -1]],          // 2 vCPU · 20초 → 4000ms = 10%, 2000 = 5%
    [2, '', [400]],
    [3, '', [1250]],                    // 12.5%
    [4, 'scsi0:0', [3, 5]], [4, 'scsi0:1', [30, 60]], [5, 'scsi0:1', [2]],
  ]);
  const by = cp.parsePerfInstances(xml, 'VirtualMachine').get('vm-1');
  const s = cp.summarizeVm(by, ids, 2, NOW);
  assert.deepEqual(s.readyPct, { avg: 7.5, max: 10 });
  assert.deepEqual(s.costopPct, { avg: 1, max: 1 });
  assert.deepEqual(s.latencyPct, { avg: 12.5, max: 12.5 });
  assert.deepEqual(s.readMs, { avg: 45, max: 60 });
  assert.equal(s.disk, 'scsi0:1');
  assert.equal(s.samples, 2, '-1 표본은 버린다');
  const noCpu = cp.summarizeVm(by, ids, null, NOW);
  assert.equal(noCpu.readyPct, null, 'vCPU 를 모르면 % 를 지어내지 않는다');
  const missing = cp.summarizeVm(by, { ready: 1 }, 2, NOW);
  assert.equal(missing.readMs, null, '카운터가 없으면 그 값만 null(0 아님)');
  assert.equal(cp.avgMax([]), null);
});

test('⑧ VM 판정 — 기준 경계·꺼진 VM·ready 가 높으면 latency 는 따로 말하지 않는다', () => {
  const vm = (p) => ({ powerState: 'POWERED_ON', perfc: p });
  const codes = (p) => cp.vmContentionFindings(vm(p)).map((f) => f.code);
  assert.deepEqual(codes({ readyPct: { avg: 5, max: 6 } }), ['cpu-ready']);
  assert.deepEqual(codes({ readyPct: { avg: 4.9, max: 9 } }), [], '판정은 평균');
  assert.deepEqual(codes({ readyPct: { avg: 10, max: 20 } }), ['cpu-ready-crit']);
  assert.deepEqual(codes({ costopPct: { avg: 3, max: 3 } }), ['cpu-costop']);
  assert.deepEqual(codes({ readyPct: { avg: 6, max: 6 }, latencyPct: { avg: 15, max: 15 } }), ['cpu-ready']);
  assert.deepEqual(codes({ latencyPct: { avg: 15, max: 15 } }), ['cpu-latency']);
  assert.deepEqual(codes({ readMs: { avg: 20, max: 20 }, writeMs: { avg: 51, max: 60 } }), ['disk-latency-crit']);
  assert.deepEqual(codes({ readMs: null, writeMs: null }), []);
  assert.deepEqual(cp.vmContentionFindings({ powerState: 'POWERED_OFF', perfc: { readyPct: { avg: 50 } } }), []);
});

test('⑨ 호스트 요약·DS UUID·엣지 정제', () => {
  const ids = { diskMax: 7, dsRead: 8, dsWrite: 9 };
  const xml = perfXml('host-1', 'HostSystem', [[7, '', [10, 30]], [8, 'uuid-a', [4]], [9, 'uuid-a', [25]], [8, '', [99]]]);
  const s = cp.summarizeHost(cp.parsePerfInstances(xml, 'HostSystem').get('host-1'), ids, NOW);
  assert.deepEqual(s.diskMaxMs, { avg: 20, max: 30 });
  assert.deepEqual(s.ds, [{ uuid: 'uuid-a', readMs: { avg: 4, max: 4 }, writeMs: { avg: 25, max: 25 } }]);
  assert.equal(cp.dsUuidOf('<url>ds:///vmfs/volumes/5f1a-22/</url>'), '5f1a-22');
  assert.equal(cp.dsUuidOf('<x/>'), null);
  const v = cp.sanitizeVmPerfc({ at: NOW, samples: 15, readyPct: { avg: '9', max: 1 }, readMs: { avg: 3, max: 'x' }, disk: '<script>', extra: 1 });
  assert.equal(v.readyPct, null, '문자열 수치는 받지 않는다');
  assert.deepEqual(v.readMs, { avg: 3, max: 3 });
  assert.equal(v.disk, null); assert.equal('extra' in v, false);
  assert.equal(cp.sanitizeVmPerfc([1]), null);
  const h = cp.sanitizeHostPerfc({ at: NOW, diskMaxMs: { avg: 1, max: 2 }, ds: [null, 'x', { uuid: 'ok-1', readMs: { avg: 1 } }, { uuid: '../x' }] });
  assert.deepEqual(h.ds.map((x) => x.uuid), ['ok-1']);
});

test('⑩ 경합 분석 — 측정 범위·오래된 값 제외·시끄러운 이웃·DS 잇기', () => {
  const p = (r, at = NOW - 60_000) => ({ at, samples: 15, readyPct: r == null ? null : { avg: r, max: r }, costopPct: null, latencyPct: null, readMs: { avg: 1, max: 2 }, writeMs: null, disk: null });
  const snap = {
    vms: [
      { id: 'v1', name: 'hot', vcenterId: 'vc1', host: 'esx-a', powerState: 'POWERED_ON', cpuCount: 4, cpuUsagePct: 50, perfc: p(12) },
      { id: 'v2', name: 'big', vcenterId: 'vc1', host: 'esx-a', powerState: 'POWERED_ON', cpuCount: 16, cpuUsagePct: 90, perfc: p(1) },
      { id: 'v3', name: 'none', vcenterId: 'vc1', host: 'esx-a', powerState: 'POWERED_ON', cpuCount: 2, cpuUsagePct: 5 },
      { id: 'v4', name: 'stale', vcenterId: 'vc1', host: 'esx-a', powerState: 'POWERED_ON', perfc: p(30, NOW - 2 * H) },
      { id: 'v5', name: 'off', vcenterId: 'vc1', host: 'esx-a', powerState: 'POWERED_OFF', perfc: p(30) },
    ],
    hosts: [{ id: 'h1', name: 'esx-a', vcenterId: 'vc1', connectionState: 'CONNECTED', perfc: { at: NOW - 60_000, diskMaxMs: { avg: 60, max: 90 }, ds: [{ uuid: 'u1', readMs: { avg: 25, max: 30 }, writeMs: null }, { uuid: 'zz', readMs: { avg: 1, max: 1 } }] } }],
    datastores: [{ id: 'd1', name: 'DS1', vcenterId: 'vc1', dsUuid: 'u1' }],
  };
  const r = analyzeContention(snap, { now: NOW, refreshMs: 900_000 });
  assert.deepEqual(r.coverage, { poweredOn: 4, measured: 2, notMeasured: 1, stale: 1, hostsConnected: 1, hostsMeasured: 1 });
  assert.equal(r.kpi.readyCrit, 1); assert.equal(r.kpi.hostsDisk, 1); assert.equal(r.kpi.dsSlow, 1);
  assert.equal(r.vms[0].name, 'hot');
  assert.equal(r.hosts[0].neighbors[0].name, 'big', '경합 VM 은 이웃에서 뺀다');
  assert.equal(r.hosts[0].diskSev, 'crit');
  assert.equal(r.datastores[0].name, 'DS1'); assert.equal(r.datastores[0].sev, 'warn');
  assert.equal(r.unmatchedDs, 1);
  assert.equal(staleAfterMs(60_000), 45 * 60_000, '하한 45분');
  assert.equal(analyzeContention(snap, { now: NOW, sev: 'issue' }).matched, 1);
});

test('⑪ 캐시 — 오래된 것부터 상한만큼 · 사라진 대상 정리', () => {
  cache._resetContentionCache();
  cache.put('vc', 'vm', 'a', { at: NOW - 3 * H });
  cache.put('vc', 'vm', 'b', { at: NOW - H });
  const due = cache.pickDue('vc', ['a', 'b', 'c'], 'vm', { now: NOW, periodMs: 30 * 60_000, max: 2 });
  assert.deepEqual(due, ['c', 'a'], '없는 것 → 오래된 것 순');
  cache.prune('vc', 'vm', new Set(['b']));
  assert.equal(cache.get('vc', 'vm', 'a'), null);
  assert.ok(cache.get('vc', 'vm', 'b'));
});

test('⑫ 배선 — 수집기·엣지 수신·도구 등록·설정', () => {
  const soap = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(soap, /refreshContention\(/);
  assert.match(soap, /'runtime\.bootTime'/);
  const central = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(central, /sanitizeVmPerfc/); assert.match(central, /sanitizeHostPerfc/); assert.match(central, /'bootTime'/);
  const access = fs.readFileSync(new URL('../src/auth/toolAccess.js', import.meta.url), 'utf8');
  assert.match(access, /'vm-lifecycle': 'vm-lifecycle'/); assert.match(access, /'contention': 'contention'/);
});
