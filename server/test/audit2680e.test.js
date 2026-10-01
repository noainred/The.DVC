/**
 * v2.680 감사(1회차) — CVP 확정분 회귀.
 *  B-01 확인 불가 장비(오래됨·스트리밍 아님)의 남은 포트 down·BGP down 을 합산하지 않는다.
 *  B-02 오래된 부품 목록(조회 실패로 남은 직전 값)은 '이번 주기 관측' 이 아니다 — 장애 전이는 collection-failed 로 보류,
 *       Overview 는 부품을 읽지 않은 것으로 본다.
 *  B-03 텔레메트리 실패 장비는 Overview 에서도 정상이 아니다(장애 판정과 같은 기준).
 *  B-04 장비 상세의 장애 이력은 SQL 에서 장비 키로 고른다(CVP 단위 상한 뒤 거르기 금지).
 *  B-05 Overview '최근 장애 전이' 는 등록부로 거른 뒤 10건을 자른다.
 *  E-04 parts_json·bgp_json 은 원문이 같을 때만 직전 파싱을 재사용한다(바뀌면 새로 읽는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2680e-'));

const { buildCvpOverview, deviceHealth } = await import('../src/cvp/overview.js');
const F = await import('../src/cvp/faults.js');
const { stripComments } = await import('./_stripComments.js');

const NOW = 1_800_000_000_000;
const IV = 300_000;
const base = (o = {}) => ({
  agent: '', cvpId: 'c1', key: 'SN1', hostname: 'leaf1', collectedAt: NOW - 60_000, telemetry: 'ok', streaming: true,
  partsList: [], partsAt: NOW - 60_000, bgpPeers: [], portsRead: true, ports: { total: 4, up: 4, down: 0 }, ...o,
});

test('B-01 — 오래된 장비의 포트·BGP down 은 합산하지 않는다', () => {
  const r = buildCvpOverview({
    now: NOW, intervalMs: IV, servers: [{ id: 'c1', name: 'C', datacenterId: 'd' }], datacenters: [{ id: 'd', name: 'D' }],
    devices: [base({ collectedAt: NOW - 10 * 86_400_000, ports: { total: 48, up: 10, down: 7 }, bgpPeers: [{ peer: '1.1.1.1', state: 'Idle' }] })],
  });
  assert.equal(r.totals.health.unknown, 1);
  assert.equal(r.totals.portsDown, 0);
  assert.equal(r.totals.bgpDown, 0);
  assert.equal(r.corps[0].portsDown, 0);
  assert.equal(r.corps[0].bgpDown, 0);
  // 신선한 장비는 그대로 센다
  const r2 = buildCvpOverview({ now: NOW, intervalMs: IV, devices: [base({ ports: { total: 48, up: 10, down: 7 } })] });
  assert.equal(r2.totals.portsDown, 7);
});

test('B-02 — 오래된 부품 목록은 관측이 아니다(전이 보류 · Overview 미판정)', () => {
  const stale = base({ partsAt: NOW - 5 * 86_400_000, partsList: [{ kind: 'psu', name: 'PowerSupply1', state: 'fault' }] });
  const o = F.observeDevice(stale, { intervalMs: IV, now: NOW });
  assert.ok(o.kindsFailed.includes('psu'), '부품 종류가 수집 실패로 보류돼야 한다');
  assert.equal(o.observed.filter((x) => x.kind === 'psu').length, 0);
  const fresh = F.observeDevice({ ...stale, partsAt: NOW - 60_000 }, { intervalMs: IV, now: NOW });
  assert.equal(fresh.observed.filter((x) => x.kind === 'psu').length, 1);
  // 전이: 열린 PSU 장애가 오래된 목록으로 '지속' 갱신되지 않고 collection-failed 로 보류
  const tr = F.transition({
    open: [{ agent: '', cvpId: 'c1', deviceKey: 'SN1', faultKey: 'psu:PowerSupply1', kind: 'psu', label: 'PowerSupply1', state: 'fault', firstSeen: NOW - 9e7 }],
    observedByDevice: new Map([[F.devIdOf(stale), { ...o, agent: '', cvpId: 'c1', deviceKey: 'SN1' }]]), now: NOW,
  });
  assert.equal(tr.updated.length, 0);
  assert.equal(tr.held[0]?.holdReason, F.HOLD_REASON.collectionFailed);
  // Overview: 오래된 ok 목록으로 초록을 칠하지 않는다 — 다른 항목(포트)이 있으면 partial
  const h = deviceHealth({ ...stale, partsList: [{ kind: 'psu', name: 'P', state: 'fault' }] }, { now: NOW, staleMs: 30 * 60_000, intervalMs: IV });
  assert.notEqual(h.state, 'bad');
  assert.equal(h.partial, true);
  // 구버전 행(partsAt 없음)은 예전대로 판정한다
  assert.ok(F.partsFresh({ partsAt: null }, { now: NOW }));
  assert.ok(F.partsStaleAfterMs(IV) >= 3 * F.PARTS_EVERY_MS);
});

test('B-03 — 텔레메트리 실패 장비는 Overview 에서 확인 불가', () => {
  const h = deviceHealth(base({ telemetry: 'failed', ports: null, bgpPeers: null, partsList: [{ kind: 'psu', name: 'P', state: 'ok' }] }), { now: NOW, intervalMs: IV });
  assert.equal(h.state, 'unknown');
  assert.deepEqual(h.reasons, ['telemetry-failed']);
  // 구버전 행(빈 값)·부분 성공은 예전처럼 읽은 것으로 본다
  assert.notEqual(deviceHealth(base({ telemetry: '' }), { now: NOW }).state, 'unknown');
  assert.notEqual(deviceHealth(base({ telemetry: 'budget-partial' }), { now: NOW }).state, 'unknown');
  const r = buildCvpOverview({ now: NOW, intervalMs: IV, devices: [base({ telemetry: 'failed' })] });
  assert.equal(r.totals.unknownBy['telemetry-failed'], 1);
});

test('B-04/B-05 — 장비 이력은 장비 키로 SQL 에서 고르고, 최근 전이는 거른 뒤 자른다', async () => {
  const db = await import('../src/cvp/db.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/cvp.js', import.meta.url), 'utf8'));
  assert.match(src, /recentFaultEvents\(\{\s*agent,\s*cvpId,\s*deviceKey:\s*key/);
  assert.match(src, /\.filter\(own\)\.slice\(0,\s*RECENT_EVENTS_MAX\)/);
  const dbSrc = stripComments(fs.readFileSync(new URL('../src/cvp/db.js', import.meta.url), 'utf8'));
  assert.match(dbSrc, /device_key=\?/);
  // 실제 DB: 다른 장비 이벤트가 많아도 그 장비 이력이 나온다
  const mk = (key, at) => ({ agent: '', cvpId: 'c9', deviceKey: key, faultKey: 'psu:P', kind: 'psu', label: 'P', state: 'fault', detail: '', firstSeen: at, lastSeen: at, deviceName: key });
  const opened = [mk('MINE', Date.now() - 5000)]; // 먼저 기록 → id 가 가장 작다(최신순 상한 밖)
  for (let i = 0; i < 30; i++) opened.push(mk(`OTHER${i}`, Date.now() - 1000 - i));
  const r = await db.applyFaultTransition({ opened, updated: [], closed: [], held: [] }, { now: Date.now() });
  if (r?.unavailable) return; // node:sqlite 없음
  const all = await db.recentFaultEvents({ cvpId: 'c9', limit: 5 });
  assert.equal(all.rows.some((x) => x.deviceKey === 'MINE'), false, '상한 5건 안에는 MINE 이 없다(재현 조건)');
  const mine = await db.recentFaultEvents({ cvpId: 'c9', deviceKey: 'MINE', limit: 5 });
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].deviceKey, 'MINE');
});

test('E-04 — 파싱 재사용은 원문이 같을 때만', async () => {
  const src = stripComments(fs.readFileSync(new URL('../src/cvp/db.js', import.meta.url), 'utf8'));
  assert.match(src, /hit && hit\.raw === raw/);
  const db = await import('../src/cvp/db.js');
  const T0 = Date.now();
  const dev = (state, ts) => ({ ts, key: 'SNX', hostname: 'x', model: 'm', serial: 'SNX', streaming: true, telemetry: 'ok',
    parts: [{ kind: 'psu', name: 'P1', state }], partsAt: Date.now(), bgp: [], ports: [] });
  const s1 = await db.saveDevices({ agent: '', cvpId: 'cvp-e4', devices: [dev('ok', T0)] });
  if (s1?.unavailable) return;
  const a = (await db.listDeviceRows({ cvpId: 'cvp-e4' })).rows[0];
  const b = (await db.listDeviceRows({ cvpId: 'cvp-e4' })).rows[0];
  assert.equal(a.partsList, b.partsList, '같은 원문은 같은 파싱 결과를 재사용한다');
  await db.saveDevices({ agent: '', cvpId: 'cvp-e4', devices: [dev('fault', T0 + 1000)] });
  const c = (await db.listDeviceRows({ cvpId: 'cvp-e4' })).rows[0];
  assert.equal(c.partsList[0].state, 'fault', '원문이 바뀌면 새로 읽는다');
});

test('F-01 — 대소문자 변형 병합이 장애·이벤트·CPU 표본까지 옮긴다(처음 본 시각은 더 이른 쪽)', async () => {
  const cdb = await import('../src/cvp/db.js');
  const now = Date.now();
  const s = await cdb.saveDevices({ agent: 'Edge-F', cvpId: 'cvpF', devices: [{ key: 'SN1', hostname: 'sw1', ts: now, ports: [] }] });
  if (s?.unavailable) return;
  await cdb.importDevSamples('Edge-F', [['cvpF', 'SN1', now, 10, 20, 100]]);
  await cdb.saveEvents('Edge-F', 'cvpF', [{ key: 'ev1', ts: now, severity: 'error', title: 't' }]);
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path.join(process.env.CONFIG_DIR, 'cvp.db'));
  const ins = d.prepare("INSERT INTO cvp_fault_state (agent,cvp_id,device_key,fault_key,kind,state,first_seen,last_seen) VALUES (?,'cvpF','SN1','psu:P1','psu','fault',?,?)");
  ins.run('Edge-F', now - 9000, now - 2000); // 변형: 더 일찍 봤지만 마지막 관측은 저장 키가 더 새것
  ins.run('edge-f', now - 1000, now - 500);  // 저장 키
  d.prepare("INSERT INTO cvp_fault_event (at,agent,cvp_id,device_key,fault_key,kind,event) VALUES (?, 'Edge-F','cvpF','SN1','psu:P1','psu','open')").run(now);
  await cdb.adoptAgentVariants('edge-f', { wait: true });
  for (const t of ['device_latest', 'device_sample', 'cvp_event', 'cvp_fault_state', 'cvp_fault_event']) {
    const rows = d.prepare(`SELECT agent, COUNT(*) n FROM ${t} WHERE cvp_id='cvpF' GROUP BY agent`).all();
    assert.deepEqual(rows.map((r) => r.agent), ['edge-f'], `${t} 가 저장 키로 모여야 한다`);
  }
  const fs1 = d.prepare("SELECT first_seen, last_seen FROM cvp_fault_state WHERE cvp_id='cvpF'").get();
  assert.equal(Number(fs1.first_seen), now - 9000);
  assert.equal(Number(fs1.last_seen), now - 500);
  d.close();
});

test('F-05 — 온도 0개 + CPU 만 읽은 위임 서버도 CPU 를 받는다', async () => {
  const { sanitizeRemoteSensors } = await import('../src/collector/remoteInventory.js');
  const r = sanitizeRemoteSensors({ t: NOW, temps: {}, cpu: 42 });
  assert.equal(r?.cpu, 42);
  assert.deepEqual(r.temps, {});
  assert.equal(sanitizeRemoteSensors({ t: NOW, cpu: 42 })?.cpu, 42);
  assert.equal(sanitizeRemoteSensors({ t: NOW, temps: {} }), null, '아무것도 없으면 예전처럼 null');
  assert.equal(sanitizeRemoteSensors({ t: NOW, temps: {}, cpu: 140 }), null, '범위 밖 CPU 는 퍼센트가 아니다');
  const src = stripComments(fs.readFileSync(new URL('../src/collector/agent.js', import.meta.url), 'utf8'));
  assert.match(src, /&& !cpuOk\) return null/);
});

test('F-06 — 엣지 스토리지 전력은 아는 필드로 좁히고 시각을 수신 시각 이하로 자른다', async () => {
  const { narrowStorageSnapshot } = await import('../src/central/storageEdge.js');
  const fut = Date.now() + 365 * 86_400_000;
  const { snap } = narrowStorageSnapshot({ id: 'x', extra: { power: { watts: 1200, source: 's', basis: 'input', scope: 'system', at: fut, evil: { a: 1 } } } });
  assert.ok(snap.extra.power.at <= Date.now());
  assert.equal(snap.extra.power.watts, 1200);
  assert.equal(snap.extra.power.evil, undefined);
  const bad = narrowStorageSnapshot({ id: 'x', extra: { power: 'nope', powerProbe: 5 } });
  assert.equal(bad.snap.extra.power, null);
  assert.equal(bad.snap.extra.powerProbe, null);
  assert.ok(bad.narrowed >= 2);
});

test('F-04 — CVP 이벤트 push 는 바이트 예산 안에서 오래된 것부터, 같은 시각 묶음은 쪼개지 않는다', async () => {
  const { pickEventsForPush, EVENT_PUSH_BYTES } = await import('../src/cvp/push.js');
  assert.ok(EVENT_PUSH_BYTES <= 8 * 1024 * 1024);
  const big = 'x'.repeat(1000);
  const evs = [];
  for (let i = 0; i < 50; i++) evs.push({ key: `e${i}`, ts: 1000 + Math.floor(i / 2), title: big }); // 2개씩 같은 시각
  const r = pickEventsForPush(evs, 999, 10_500);
  assert.ok(r.fresh.length > 0 && r.fresh.length < 50);
  assert.equal(r.fresh.length % 2, 0, '같은 시각 묶음을 쪼개지 않는다');
  assert.equal(r.held, 50 - r.fresh.length);
  assert.ok(r.fresh.every((e, i, a) => i === 0 || e.ts >= a[i - 1].ts), '오래된 것부터');
  // 다음 주기: 보낸 것의 최대 시각을 워터마크로 쓰면 나머지가 빠짐없이 온다
  const wm = Math.max(...r.fresh.map((e) => e.ts));
  const r2 = pickEventsForPush(evs, wm, 1e9);
  assert.equal(r.fresh.length + r2.fresh.length, 50);
  // 첫 묶음은 예산을 넘어도 넣는다(영원히 못 가는 것 방지)
  assert.equal(pickEventsForPush([{ ts: 5, title: big }], 0, 10).fresh.length, 1);
});
