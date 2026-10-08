// v2.702 — VM 이동 이력(A7)·구성 변경 diff·권한 변경(A8): 이벤트 상세 파싱 · logs DB 열·부분 인덱스 · 분석 · 라우트 범위.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmchg-'));
process.env.CONFIG_DIR = TMP;
const { eventDetail, detailJson, parseDetail, moveKind, TRACKED_TYPES, TRACKED_SQL, MOVE_TYPES, DETAIL_MAX } = await import('../src/vmchanges/eventDetail.js');
const { analyzeMoves, analyzeChanges, vmHistory, churnThreshold, VM_ROWS_MAX } = await import('../src/vmchanges/analyze.js');

const DAY = 86_400_000;
const NOW = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000 - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)

const MIG = `<vm><vm type="VirtualMachine">vm-1</vm><name>web01</name></vm>
<host><host type="HostSystem">host-2</host><name>esx-b</name></host>
<ds><datastore type="Datastore">ds-2</datastore><name>DS-B</name></ds>
<sourceHost><host type="HostSystem">host-1</host><name>esx-a</name></sourceHost>
<sourceDatastore><datastore type="Datastore">ds-1</datastore><name>DS-A</name></sourceDatastore>`;

test('① 이동 상세 — 출발·도착 호스트/데이터스토어와 종류. <hostX> 같은 다른 태그를 host 로 읽지 않는다', () => {
  const d = eventDetail('VmMigratedEvent', MIG);
  assert.deepEqual(d, { from: 'esx-a', to: 'esx-b', fromDs: 'DS-A', toDs: 'DS-B', kind: 'both' });
  assert.equal(eventDetail('DrsVmMigratedEvent', MIG).kind, 'drs', 'DRS 는 호스트·DS 와 무관하게 drs');
  assert.equal(eventDetail('vim25:VmMigratedEvent', MIG).kind, 'both', '네임스페이스 접두를 뗀다');
  const hostOnly = MIG.replace('DS-B', 'DS-A');
  assert.equal(eventDetail('VmMigratedEvent', hostOnly).kind, 'vmotion');
  const dsOnly = MIG.replace('<name>esx-b</name>', '<name>esx-a</name>');
  assert.equal(eventDetail('VmRelocatedEvent', dsOnly).kind, 'svmotion');
  const tricky = '<hostX><name>zzz</name></hostX><host><name>esx-real</name></host>';
  assert.equal(eventDetail('VmMigratedEvent', tricky).to, 'esx-real');
  assert.equal(moveKind('VmRelocatedEvent', {}), 'relocate', '이름을 모르면 이벤트 종류로만');
  assert.equal(moveKind('VmMigratedEvent', null), 'vmotion');
  assert.equal(eventDetail('VmPoweredOnEvent', MIG), null, '대상 종류가 아니면 상세를 싣지 않는다');
  assert.equal(eventDetail('VmMigratedEvent', null), null);
});

test('② 구성 변경 — configChanges 원문 우선 + configSpec 의 아는 필드·장치 변경 / 권한 변경', () => {
  const body = `<configSpec><numCPUs>8</numCPUs><memoryMB>32768</memoryMB>
<deviceChange><operation>add</operation><device xsi:type="VirtualDisk"><key>-1</key></device></deviceChange>
<deviceChange><operation>remove</operation><device xsi:type="vim25:VirtualE1000"></device></deviceChange></configSpec>
<configChanges><modified>config.hardware.numCPU: 4 -&gt; 8;</modified><added></added><deleted>config.extraConfig("x"): "1" -&gt; &lt;unset&gt;;</deleted></configChanges>`;
  const d = eventDetail('VmReconfiguredEvent', body);
  assert.equal(d.modified, 'config.hardware.numCPU: 4 -> 8;');
  assert.equal(d.added, undefined, '빈 원문은 싣지 않는다');
  assert.match(d.deleted, /<unset>/);
  assert.equal(d.numCpu, 8); assert.equal(d.memoryMB, 32768);
  assert.deepEqual(d.devices, ['add VirtualDisk', 'remove VirtualE1000']);
  assert.ok(d.fields.includes('numCPUs') && d.fields.includes('deviceChange'));
  assert.equal(eventDetail('VmReconfiguredEvent', '<x/>'), null, '아무것도 못 읽으면 null(빈 객체로 지어내지 않는다)');
  const p = eventDetail('PermissionAddedEvent', '<principal>CORP\\ops</principal><role><role>-1</role><name>Admin</name></role><group>true</group><propagate>false</propagate>');
  assert.deepEqual(p, { principal: 'CORP\\ops', role: 'Admin', group: true, propagate: null });
});

test('③ 상세 문자열 상한 — 넘치면 텍스트를 줄이고, 잘린 JSON 을 저장하지 않는다', () => {
  const big = { modified: 'x'.repeat(9000), kind: 'reconfig' };
  const s = detailJson(big);
  assert.ok(s.length <= DETAIL_MAX);
  assert.ok(parseDetail(s), 'JSON 으로 다시 읽혀야 한다');
  assert.equal(detailJson(null), null);
  assert.equal(parseDetail('{bad'), null); assert.equal(parseDetail('[1]'), null); assert.equal(parseDetail(''), null);
});

test('④ 부분 인덱스 리터럴 — 이름은 [A-Za-z]+ 이고 조회가 인덱스를 탄다 · 옛 DB 에 detail 열을 더한다', async () => {
  for (const t of TRACKED_TYPES) assert.match(t, /^[A-Za-z]+$/);
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(TMP, 'vcenter-logs.db');
  const old = new DatabaseSync(file);   // v2.701 까지의 스키마(detail 없음)
  old.exec('CREATE TABLE events (vcenterId TEXT NOT NULL, k TEXT, ts INTEGER NOT NULL, severity TEXT, type TEXT, user TEXT, entity TEXT, message TEXT)');
  old.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)').run('vc1', 'old1', NOW - DAY, 'info', 'VmMigratedEvent', 'u', 'web01', 'old');
  old.close();
  const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  db.insertMany([
    { vcenterId: 'vc1', key: 'a', ts: NOW - 3600_000, severity: 'info', type: 'DrsVmMigratedEvent', user: 'vpxd', entity: 'web01', message: 'm', detail: detailJson(eventDetail('DrsVmMigratedEvent', MIG)) },
    { vcenterId: 'vc1', key: 'b', ts: NOW - 7200_000, severity: 'info', type: 'VmPoweredOnEvent', user: 'x', entity: 'web01', message: 'on' },
    { vcenterId: 'vc2', key: 'c', ts: NOW - 7200_000, severity: 'info', type: 'VmReconfiguredEvent', user: 'adm', entity: 'db01', message: 'r', detail: '{"numCpu":4}' },
  ]);
  const rows = db.trackedEvents({ vcenterIds: ['vc1', 'vc2'], since: NOW - 2 * DAY }, 100);
  assert.deepEqual(rows.map((r) => r.type), ['DrsVmMigratedEvent', 'VmReconfiguredEvent', 'VmMigratedEvent'], '전원 이벤트는 빠지고 옛 행도 읽힌다');
  assert.equal(rows[2].detail, null, '옛 행의 상세는 null');
  assert.equal(parseDetail(rows[0].detail).kind, 'drs');
  assert.equal(db.trackedEvents({ vcenterIds: ['vc1'], since: NOW - 2 * DAY, entity: 'web01', types: MOVE_TYPES }, 100).length, 2);
  assert.deepEqual(db.trackedEvents({ vcenterIds: [] }, 10), [], '빈 vCenter 목록은 전체가 아니라 0건');
  assert.deepEqual(db.trackedEvents({ types: ['VmPoweredOnEvent'] }, 10), [], '추적 종류 밖은 0건');
  // v2.727(감사 F-01): 조각 판은 한 문장 판과 같은 결과다(화면·CSV 가 이것을 쓴다) — 큰 합성 DB 대조는 audit2727d.test.js
  assert.deepEqual(await db.trackedEventsAsync({ vcenterIds: ['vc1', 'vc2'], since: NOW - 2 * DAY }, 100, { now: NOW }), rows);
  assert.deepEqual(await db.trackedEventsAsync({ vcenterIds: [] , since: 0 }, 10), []);
  resetLogsDb();
  const raw = new DatabaseSync(file);
  assert.ok(raw.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'detail'));
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM events INDEXED BY idx_events_tracked WHERE type IN ${TRACKED_SQL} AND vcenterId IN (?) AND ts>=? ORDER BY ts DESC LIMIT 10`).all('vc1', 0).map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_events_tracked/, plan);
  raw.close();
  // 조회 코드가 같은 강제를 쓰는지(없으면 플래너가 (vcenterId,ts) 인덱스로 기간 전체를 훑는다 — v2.702 실측)
  assert.match(fs.readFileSync(new URL('../src/logs/db.js', import.meta.url), 'utf8'), /FROM events INDEXED BY idx_events_tracked WHERE/);
  // v2.727(감사 F-01): 화면·CSV 의 load() 는 조각 판을 쓰고, 동기 판은 /of(entity 전용 인덱스)에만 남는다.
  const route = fs.readFileSync(new URL('../src/routes/api/vmChanges.js', import.meta.url), 'utf8');
  assert.match(route, /await db\.trackedEventsAsync\(\{ vcenterIds: ids, since \}/);
  assert.equal((route.match(/db\.trackedEvents\(/g) || []).length, 1, '동기 trackedEvents 는 /of 한 곳뿐');
});

function mv(vc, vm, ts, type = 'VmMigratedEvent', d = {}) {
  return { vcenterId: vc, ts, type, user: 'u', entity: vm, message: '', detail: JSON.stringify({ ...d, kind: d.kind ?? moveKind(type, d) }) };
}

test('⑤ 이동 분석 — 종류별 개수·VM 별 묶음·과다 이동 기준은 기간 비례 · 한국 날짜 칸 · 상세 없는 행 개수', () => {
  assert.equal(churnThreshold(7), 10); assert.equal(churnThreshold(1), 3); assert.equal(churnThreshold(30), 43);
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(mv('vc1', 'hot', NOW - i * 3600_000, i % 2 ? 'DrsVmMigratedEvent' : 'VmMigratedEvent', { from: `h${i}`, to: `h${i + 1}` }));
  rows.push(mv('vc1', 'cold', NOW - DAY, 'VmRelocatedEvent', { fromDs: 'a', toDs: 'b' }));
  rows.push({ vcenterId: 'vc1', ts: NOW - DAY, type: 'VmMigratedEvent', user: '', entity: 'cold', message: '', detail: null });
  rows.push({ vcenterId: 'vc1', ts: NOW, type: 'VmReconfiguredEvent', user: '', entity: 'x', message: '', detail: null });
  const r = analyzeMoves(rows, { days: 7, now: NOW, vcName: new Map([['vc1', 'VC-One']]) });
  assert.equal(r.total, 12);
  assert.equal(r.byKind.drs, 5); assert.equal(r.byKind.svmotion, 1); assert.equal(r.byKind.vmotion, 6);
  assert.equal(r.noDetail, 1);
  assert.equal(r.churnVms, 1);
  assert.equal(r.vms[0].vm, 'hot'); assert.equal(r.vms[0].moves, 10); assert.equal(r.vms[0].churn, true);
  assert.equal(r.vms[0].hosts, 11); assert.equal(r.vms[0].lastTo, 'h1', '마지막 이동은 가장 늦은 행');
  assert.equal(r.vms[0].vcenterName, 'VC-One');
  assert.equal(r.vms[1].storage, 1);
  assert.equal(r.series.length, 7);
  assert.equal(r.series.reduce((a, s) => a + s.moves, 0), 12, '기간 칸의 합 = 이동 수');
  assert.equal(analyzeMoves(rows, { days: 7, now: NOW, q: 'COLD' }).matched, 1, '검색은 대소문자 무시');
  assert.equal(analyzeMoves(rows, { days: 7, now: NOW, q: 'cold' }).churnVms, 1, '과다 이동 수는 검색과 무관한 전체 기준');
  const many = Array.from({ length: VM_ROWS_MAX + 5 }, (_, i) => mv('vc1', `v${i}`, NOW - i));
  const m = analyzeMoves(many, { days: 7, now: NOW });
  assert.equal(m.vms.length, VM_ROWS_MAX); assert.equal(m.omitted, 5);
});

test('⑥ 구성 변경 분석 — 종류·사용자·필터 · VM 상세 이력', () => {
  const rows = [
    { vcenterId: 'vc1', ts: NOW, type: 'VmReconfiguredEvent', user: 'alice', entity: 'web01', message: 'm', detail: JSON.stringify({ modified: 'cpu 4 -> 8' }) },
    { vcenterId: 'vc1', ts: NOW - 1, type: 'PermissionAddedEvent', user: 'bob', entity: 'Datacenter', message: '', detail: JSON.stringify({ principal: 'CORP\\x', role: 'Admin' }) },
    { vcenterId: 'vc1', ts: NOW - 2, type: 'RoleUpdatedEvent', user: '', entity: '', message: '', detail: null },
    mv('vc1', 'web01', NOW - 3),
  ];
  const c = analyzeChanges(rows, {});
  assert.equal(c.total, 3);
  assert.deepEqual(c.byKind, { reconfig: 1, permission: 1, role: 1 });
  assert.equal(c.noDetail, 1);
  assert.deepEqual(c.users.map((u) => u.user).sort(), ['(사용자 미상)', 'alice', 'bob']);
  assert.equal(c.events[0].lines[0].text, 'cpu 4 -> 8');
  assert.equal(c.events[1].principal, 'CORP\\x');
  assert.equal(analyzeChanges(rows, { kind: 'permission' }).matched, 1);
  assert.equal(analyzeChanges(rows, { kind: 'permission' }).total, 3, '종류 필터는 전체 개수를 바꾸지 않는다');
  assert.equal(analyzeChanges(rows, { q: 'corp' }).matched, 1, '권한 주체로도 찾는다');
  const h = vmHistory(rows.filter((r) => r.entity === 'web01'));
  assert.deepEqual(h.map((x) => x.cat), ['change', 'move']);
  assert.equal(vmHistory(Array.from({ length: 50 }, (_, i) => mv('vc1', 'a', NOW - i)), 20).length, 20);
});

test('⑦ 수집 경로 — soapClient 가 이벤트 행에 detail 을 싣고, poller 가 그것을 DB 로 넘긴다', () => {
  const soap = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(soap, /detail:\s*detailJson\(eventDetail\(type, body\)\)/);
  const poller = fs.readFileSync(new URL('../src/logs/poller.js', import.meta.url), 'utf8');
  assert.match(poller, /detail/);
});

test('⑧ 라우트 — 범위 계정은 범위 밖 VM 의 이력이 404(존재 은닉), 목록은 범위 vCenter 만 · CSV 는 data.csv', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmchg-rt-'));
  const script = `
    const express = (await import('express')).default;
    const { store } = await import('./src/store.js');
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const inVc = vcs[0], outVc = vcs[1];
    const vmIn = snap.vms.find((v) => v.vcenterId === inVc), vmOut = snap.vms.find((v) => v.vcenterId === outVc);
    const { getLogsDb } = await import('./src/logs/db.js');
    const db = await getLogsDb();
    const now = Date.now();
    db.insertMany([
      { vcenterId: inVc, key: 'i1', ts: now - 60000, severity: 'info', type: 'VmMigratedEvent', user: 'u', entity: vmIn.name, message: 'm', detail: JSON.stringify({ from: 'a', to: 'b', kind: 'vmotion' }) },
      { vcenterId: outVc, key: 'o1', ts: now - 60000, severity: 'info', type: 'VmMigratedEvent', user: 'u', entity: vmOut.name, message: 'm', detail: null },
    ]);
    const { api } = await import('./src/routes/api.js');
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'scoped', role: 'operator', scope: { vcenters: [inVc] } }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch {} return { status: r.status, b }; };
    const out = {
      inOf: await get('/api/tools/vm-changes/of?vmId=' + encodeURIComponent(vmIn.id)),
      outOf: await get('/api/tools/vm-changes/of?vmId=' + encodeURIComponent(vmOut.id)),
      list: await get('/api/tools/vm-changes?days=7'),
      csv: (await fetch(base + '/api/tools/vm-changes.csv')).status,
      inVc, outVc,
    };
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr.slice(-800)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-400));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.inOf.status, 200);
  assert.equal(o.inOf.b.items[0].cat, 'move');
  assert.equal(o.outOf.status, 404, '범위 밖 VM 은 404(존재 은닉)');
  assert.equal(o.list.status, 200);
  assert.deepEqual(o.list.b.vcenters.map((v) => v.vcenterId), [o.inVc], '목록은 범위 vCenter 만');
  assert.equal(o.list.b.moves.total, 1, '범위 밖 이벤트는 세지 않는다');
  assert.equal(o.csv, 403, 'CSV 는 data.csv(admin) 권한');
});
