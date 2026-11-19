/**
 * v2.923(리눅스 성능 4단계) — 라우트 계약: 장애 기록(부품 장애 **실제 함수** — applyTransition → computeIncidents → 서버로 좁힘 · 요약 5칸) ·
 *   튜닝 · 용도 API(이 노드 · 엣지 보관분 · 범위 404 · 덮어쓰기 손상 503) · 용도 태그 PUT(조회 밖 404 → 쓰기 밖 403 · 감사 · 캐시 세대) ·
 *   덮어쓰기 PUT(설정 소유자 = 전체 범위 · 감사) · part-faults 도구 접근 없음 → 내용 없이 권한 없음.
 * 기준 시각: 정시 −30분(v2.517).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2923op-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = '';
process.env.PARTFAULT_DB_PATH = path.join(DIR, 'part-faults.db');
process.env.SETTINGS_OWNERS = 'adm,sadm';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* skip */ }

fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
  { id: 'o-a', name: 'bm-a', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  { id: 'o-b', name: 'bm-b', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
] }));
fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));

const pdb = await import('../src/partfault/db.js');
const { makePart } = await import('../src/partfault/types.js');
const poller = await import('../src/bmusage/poller.js');
poller._setFleetForTest(async () => ({ bareMetal: [
  { serverId: 's-a', name: 'bm-a', serviceTag: 'TAGA', vcenterId: 'vcA' },
  { serverId: 's-b', name: 'bm-b', serviceTag: 'TAGB', vcenterId: 'vcB' },
], virtualizationHosts: [] }));
const R = await import('../src/routes/api/bmUsage.js');
const OPS = await import('../src/bmusage/opsView.js');
const OV = await import('../src/bmusage/tuning/overrides.js');

const part = (o = {}) => makePart({ scope: 'idrac', deviceId: '10.0.0.5', deviceKey: 'TAGA', deviceName: 'bm-a', kind: 'disk', partId: 'Disk.1', keyKind: 'slot', state: 'fault', ...o });
async function seq(p, steps, agent = '') {
  let prev = null;
  for (const [at, st, reason] of steps) {
    if (st === 'close') { await pdb.applyTransition({ closed: [{ ...prev, agent, closeReason: reason || 'ok' }] }, { now: at }); prev = null; }
    else if (!prev) { prev = { ...p, agent, state: st, firstSeenAt: at, lastSeenAt: at }; await pdb.applyTransition({ opened: [prev] }, { now: at }); }
    else { const n = { ...prev, state: st, prevState: prev.state, lastSeenAt: at }; await pdb.applyTransition({ updated: [n] }, { now: at }); prev = { ...n }; }
  }
}

test('장애 기록 — 실제 partfault(applyTransition → computeIncidents) · 이 서버(서비스 태그 · agent)만 · 요약 5칸은 code 를 세기만 · 다른 법인 엣지의 같은 태그를 섞지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  await seq(part({ partId: 'Disk.1' }), [[NOW - 10 * DAY, 'fault'], [NOW - 8 * DAY, 'close', 'removed']]);              // 교체 · 2일
  await seq(part({ kind: 'psu', partId: 'PSU.2', label: 'PSU 2' }), [[NOW - 5 * DAY, 'warn'], [NOW - 4 * DAY, 'close', 'ok']]);   // 정상 복귀 · 1일
  await seq(part({ kind: 'dimm', partId: 'DIMM.A3', label: 'DIMM A3' }), [[NOW - 2 * DAY, 'warn']]);                     // 진행 중
  await seq(part({ kind: 'fan', partId: 'Fan.3' }), [[NOW - 3 * DAY, 'fault'], [NOW - 3 * DAY + HOUR, 'close', 'manual']]); // 수동 닫음(평균 제외)
  await seq(part({ kind: 'nic', partId: 'NIC.2', label: 'NIC 2' }), [[NOW - 7 * DAY, 'fault'], [NOW - 6 * DAY, 'close', 'ok']]);   // 정상 복귀 하나 더(교체 수와 구분)
  await seq(part({ deviceKey: 'TAGB', deviceId: '10.0.0.6', partId: 'Disk.9' }), [[NOW - DAY, 'fault']]);                 // 다른 서버
  await seq(part({ partId: 'Disk.7' }), [[NOW - DAY, 'fault']], 'EDGE-PL');                                                // 다른 엣지의 같은 태그
  const PF = await import('../src/routes/api/partFaults.js');
  PF._resetIncidentMemoForTest();
  const req = (user, key, q = {}) => ({ user, params: { key }, query: q, headers: {} });
  const adm = { username: 'adm', role: 'admin', scope: null };
  const v = await R.bmFaultsView(req(adm, 'TAGA', { days: '90' }), { vcenters: [] });
  assert.equal(v.ok, true); assert.equal(v.available, true, JSON.stringify(v).slice(0, 300));
  assert.equal(v.incidents.length, 5, '이 서버 · 이 노드(agent "") 것만 — 다른 서버 · 다른 엣지 제외');
  assert.deepEqual(v.kpis, { open: 1, started: 5, avgDurationMs: Math.round((2 * DAY + DAY + DAY) / 3), durationSamples: 3, removed: 1, endUnknown: 0, total: 5 });
  const ended = Object.fromEntries(v.incidents.map((i) => [i.kind, i.endReason]));
  assert.deepEqual(ended, { disk: 'removed', psu: 'ok', dimm: null, fan: 'manual', nic: 'ok' }, '종료 사유는 incidents.js code 그대로');
  assert.equal(v.incidents.find((i) => i.kind === 'dimm').ongoing, true);
  const scoped = await R.bmFaultsView(req({ username: 'sb', role: 'operator', scope: { vcenters: ['vcB'] } }, 'TAGA'), { vcenters: [] });
  assert.equal(scoped.__status, 404, '범위 밖 404');
  const denied = await R.bmFaultsView(req(adm, 'TAGA'), { vcenters: [] }, { partFaultToolIssue: async () => ({ reason: '이 기능(part-faults)에 대한 접근이 관리자 설정으로 차단되어 있습니다.' }) });
  assert.equal(denied.partFaultsAccess, false); assert.equal(denied.incidents, undefined, '도구 접근이 없으면 내용 없음');
  const fleet = await R.bmFaultsFleetView({ user: { username: 'sa', role: 'operator', scope: { vcenters: ['vcA'] } }, query: { days: '90' }, headers: {} }, { vcenters: [] });
  assert.ok(fleet.incidents.length >= 5 && fleet.incidents.every((i) => i.vcenterId === 'vcA'), '범위 계정은 자기 법인 서버 장애만');
  const fleetAll = await R.bmFaultsFleetView({ user: adm, query: {}, headers: {} }, { vcenters: [] });
  assert.equal(fleetAll.incidents.filter((i) => i.key === 'TAGB').length, 1);
  assert.ok(!fleetAll.incidents.some((i) => i.label === 'Disk.7'), '다른 엣지(EDGE-PL)의 같은 태그 장애는 이 노드 서버에 붙지 않는다');
});

test('incidentsForServer — agent 축 · 서비스 태그 · 등록부 id · scope idrac 만(순수)', () => {
  const list = [
    { scope: 'idrac', agent: '', deviceKey: 'taga', deviceId: 'r1' }, { scope: 'storage', agent: '', deviceKey: 'TAGA' },
    { scope: 'idrac', agent: 'E1', deviceKey: 'TAGA' }, { scope: 'idrac', agent: '', deviceKey: 'X', deviceId: 'r1' },
  ];
  assert.equal(OPS.incidentsForServer(list, { agent: '', serviceTag: 'TAGA' }).length, 1);
  assert.equal(OPS.incidentsForServer(list, { agent: '', serviceTag: 'TAGA', regId: 'r1' }).length, 2);
  assert.equal(OPS.incidentsForServer(list, { agent: 'E1', serviceTag: 'TAGA' }).length, 2, '엣지 이름이 있으면 그 이름 + 로컬("") — hwFacts 와 같은 규칙');
  assert.equal(OPS.incidentsForServer(list, { agent: '' }).length, 0, '식별이 없으면 붙이지 않는다');
});

const { config } = await import('../src/config.js');
const rowFor = (key, tuning) => ({ agent: config.agent?.name || '', key, ts: NOW, cpu_pct: 10, disk_used_pct: 80, tuning_json: JSON.stringify(tuning), detail_json: JSON.stringify({ v: 1, nics: [{ dropDelta: 0 }] }) });
const TUN = { v: 1, at: NOW, os: { id: 'rocky', versionId: '9.4', pageSize: 4096 }, sysctl: { 'vm.swappiness': '60', 'tuned.active_profile': 'throughput-performance' }, accounts: ['gpadmin'], procs: { list: ['postgres'], capped: false }, ports: { list: [5432], capped: false }, units: { list: ['chronyd.service'], failed: 0, capped: false }, sections: { sysctl: 'ok', osrel: 'ok', units: 'ok' } };

test('튜닝 · 용도 API — 이 노드 대상(행의 tuning_json) · 엣지 보관분(정제본 tuning) · 범위 밖 404 · 사실 없음은 noFacts + advise 0 · 덮어쓰기 손상 503', async () => {
  const adm = { username: 'adm', role: 'admin', scope: null };
  const deps = { latestUsage: async () => [rowFor('TAGA', TUN)], hwFactsReader: async () => () => null, listEdgeBmUsage: async () => [], purposeOf: async () => null };
  const tv = await R.bmTuningView({ user: adm, params: { key: 'TAGA' }, query: {} }, {}, deps);
  assert.equal(tv.ok, true); assert.equal(tv.via, 'local'); assert.equal(tv.items.length, 26);
  assert.deepEqual(tv.activeApps, ['gpdb']); assert.equal(tv.items.find((x) => x.id === 'mem.swappiness').by, 'profile:gpdb');
  assert.ok(tv.sources.length === 11 && tv.categories.length === 5);
  const pv = await R.bmProfileView({ user: adm, params: { key: 'TAGA' }, query: {} }, {}, deps);
  assert.equal(pv.detection.os.profile, 'rocky9-base');
  assert.equal(pv.profiles.find((p) => p.id === 'gpdb').checks.find((c) => c.id === 'gp.diskSpace').status, 'bad', '행 disk_used_pct 80 ≥ 75');
  const none = await R.bmTuningView({ user: adm, params: { key: 'TAGB' }, query: {} }, {}, deps);
  assert.equal(none.noFacts, true); assert.equal(none.counts.advise, 0);
  const sc = await R.bmTuningView({ user: { username: 's', role: 'operator', scope: { vcenters: ['vcB'] } }, params: { key: 'TAGA' }, query: {} }, {}, deps);
  assert.equal(sc.__status, 404);
  const edge = await R.bmTuningView({ user: adm, params: { key: 'EDG1' }, query: {} }, {}, {
    ...deps, listEdgeBmUsage: async () => [{ agent: 'EDGE-PL', snapAt: NOW, snap: { targets: [{ key: 'EDG1', name: 'e1', vcenterId: 'vcB' }], rows: [{ key: 'EDG1', disk_used_pct: 10 }], perf: [{ key: 'EDG1', tuning: TUN, detail: null, cells: {} }] } }],
  });
  assert.equal(edge.via, 'edge'); assert.equal(edge.agent, 'EDGE-PL'); assert.deepEqual(edge.activeApps, ['gpdb']);
  fs.writeFileSync(path.join(DIR, 'bmusage-tuning.json'), 'nope');
  OV._resetTuningOverridesForTest();
  const broken = await R.bmTuningView({ user: adm, params: { key: 'TAGA' }, query: {} }, {}, deps);
  assert.equal(broken.__status, 503); assert.equal(broken.code, 'settingsUnreadable');
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('bmusage-tuning.json')) fs.rmSync(path.join(DIR, f));
  OV._resetTuningOverridesForTest();
});

test('실제 라우터 — 용도 태그 PUT(admin · 조회 밖 404 → 쓰기 밖 403 · 감사 · 태그 뒤 GET profile 이 바뀐다 = 캐시 세대) · 덮어쓰기 PUT(설정 소유자 · 전체 범위 · 감사) · viewer 403', async (t) => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const audit = await import('../src/audit.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    adm: { username: 'adm', role: 'admin', scope: null },
    sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    other: { username: 'other', role: 'admin', scope: null },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  const put = (u, p, body) => fetch(`${base}${p}`, { method: 'PUT', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put('viewer', '/purpose', { key: 'TAGA', apps: ['gpdb'] })).status, 403);
  assert.equal((await put('sadm', '/purpose', { key: 'TAGB', apps: ['gpdb'] })).status, 404, '조회 밖 404');
  assert.equal((await put('rw', '/purpose', { key: 'TAGB', apps: ['gpdb'] })).status, 403, '조회는 되지만 쓰기 밖 403');
  assert.equal((await put('adm', '/purpose', { key: 'TAGA', apps: ['hadoop'] })).status, 400, '프로파일 없는 기능');
  const g0 = await (await fetch(`${base}/perf/TAGA/profile`, { headers: { 'x-u': 'adm' } })).json();
  assert.equal(g0.manual, null);
  assert.equal((await put('adm', '/purpose', { key: 'TAGA', apps: ['airflow'], role: 'db' })).status, 200);
  const g1 = await (await fetch(`${base}/perf/TAGA/profile`, { headers: { 'x-u': 'adm' } })).json();
  assert.deepEqual(g1.manual.apps, ['airflow'], '태그 저장 뒤 캐시가 아니라 새 값(fleetRev 세대)');
  assert.deepEqual(g1.detection.activeApps, ['airflow']);
  // 반증 W4: GET 에 writable — 조회 무제한 + 쓰기 vcA 만인 관리자는 vcB 서버의 태그 칸이 잠긴다(캐시를 adm 과 나누지 않는다).
  assert.equal(g1.writable, true); assert.equal(g1.canTag, true);
  const gb1 = await (await fetch(`${base}/perf/TAGB/profile`, { headers: { 'x-u': 'adm' } })).json();
  const gb2 = await (await fetch(`${base}/perf/TAGB/profile`, { headers: { 'x-u': 'rw' } })).json();
  assert.equal(gb1.writable, true); assert.equal(gb2.writable, false, '쓰기 밖 — 같은 조회 범위 · 같은 역할이어도 캐시를 나누지 않는다'); assert.equal(gb2.canTag, false);
  assert.ok(audit.auditEntriesWithAction('bm-usage.purpose').length >= 1);
  // 덮어쓰기 — 설정 소유자 + 전체 범위만
  const ov = { scope: 'vcA', role: 'db', itemId: 'mem.swappiness', value: '5' };
  assert.equal((await put('other', '/tuning/overrides', ov)).status, 403, '소유자가 아닌 관리자');
  assert.equal((await put('sadm', '/tuning/overrides', ov)).status, 403, '소유자지만 범위 계정');
  assert.equal((await put('adm', '/tuning/overrides', ov)).status, 200);
  assert.equal((await put('adm', '/tuning/overrides', { ...ov, itemId: 'mem.minFree' })).status, 400);
  assert.ok(audit.auditEntriesWithAction('bm-usage.tuning.override').some((a) => /mem\.swappiness/.test(a.target || '') || /swappiness/.test(a.detail || '')));
  const tv = await (await fetch(`${base}/perf/TAGA/tuning`, { headers: { 'x-u': 'adm' } })).json();
  assert.equal(tv.role, 'db'); assert.equal(tv.items.find((x) => x.id === 'mem.swappiness').rec, '5', '저장 뒤 판정에 바로 반영(덮어쓰기 세대)');
  const fl = await (await fetch(`${base}/profiles`, { headers: { 'x-u': 'sadm' } })).json();
  assert.ok(fl.servers.every((s) => s.vcenterId === 'vcA'), '함대 보기도 범위');
  assert.equal(fl.overrides.corpsScoped, true); assert.equal(fl.canOverride, false);
  assert.equal((await fetch(`${base}/perf/TAGB/tuning`, { headers: { 'x-u': 'sadm' } })).status, 404);
  poller._setFleetForTest(null);
});

test('엣지 봉투(실제 buildBmUsageEnvelope) — 튜닝 사실의 감지 목록은 관찰 대상만(원목록이면 봉투 상한에서 전 서버 상세가 빠진다) · 줄였다는 표지', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a', name: 'bm-a', serviceTag: 'TAGA', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  t.after(() => poller._setFleetForTest(null));
  const db = await import('../src/bmusage/db.js');
  const tun = { ...TUN, procs: { list: ['postgres', 'sshd', ...Array.from({ length: 300 }, (_, i) => `p${i}`)], capped: false }, units: { list: ['chronyd.service', ...Array.from({ length: 200 }, (_, i) => `s${i}.service`)], failed: 0, capped: false } };
  const r = await db.insertUsage([{ key: 'TAGA', ts: NOW, name: 'bm-a', vcenterId: 'vcA', src: 'os', cpu_pct: 10, os_at: NOW, tuning_json: JSON.stringify(tun), detail_json: JSON.stringify({ v: 1 }) }], config.agent?.name || '');
  assert.ok(r.ok, JSON.stringify(r));
  const E = await import('../src/bmusage/edgePull.js');
  const env = await E.buildBmUsageEnvelope({});
  const p = (env.perf || []).find((x) => x.key === 'TAGA');
  assert.ok(p && p.tuning, '성능 항목에 튜닝 사실');
  assert.deepEqual(p.tuning.procs.list, ['postgres']); assert.equal(p.tuning.procs.filtered, true);
  assert.deepEqual(p.tuning.units.list, ['chronyd.service']);
  assert.equal(p.tuning.sysctl['vm.swappiness'], '60', '목록 밖 사실은 그대로');
});


test('장애 기록 이벤트의 종료 사유 code(반증 W5) — 서버 incidents.js closeReasonToEnd 가 정하고 incidentRow 가 이벤트마다 싣는다(웹은 문구만)', async () => {
  const { closeReasonToEnd, INCIDENT_END } = await import('../src/partfault/incidents.js');
  const row = OPS.incidentRow({ id: 'x', events: [
    { at: 1, event: 'open', state: 'fault' }, { at: 2, event: 'close', closeReason: 'removed' }, { at: 3, event: 'close', closeReason: 'key-migrated' },
    { at: 4, event: 'close', closeReason: 'manual' }, { at: 5, event: 'close', closeReason: null }, { at: 6, event: 'change', state: 'warn', prevState: 'fault' },
  ] });
  assert.deepEqual(row.events.map((e) => e.endReason), [null, INCIDENT_END.removed, INCIDENT_END.migrated, INCIDENT_END.manual, INCIDENT_END.ok, null]);
  for (const r of ['removed', 'key-migrated', 'manual', 'ok', null, 'weird']) assert.ok(Object.values(INCIDENT_END).includes(closeReasonToEnd(r)));
});
