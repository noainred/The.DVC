/**
 * audit2732a — 점검 2회차(v2.732) 그룹 a: vCenter 낡은 값 + 공개 API 정직성.
 *
 *  B2-01 엣지 push 가 멈춘 위임(site) vCenter 는 status 가 'connected' 로 남는다(헤더 'N/M' 계약 — 바꾸지 않는다).
 *        대신 ① 롤업 vcentersStale ② /health vcentersStale 로 따로 센다 ③ 공개 API 행 collectedAt 은 **실제 수신 시각**
 *        (site → receivedAt, 마지막 정상 값 이월 → staleSince)이고 행 stale · collection stale 개수를 싣는다.
 *        예전 collectedAt 은 vCenter 객체에 없는 필드를 읽어 **언제나 스냅샷 시각**(= 지금)이었다 — 3일 전 값이 '방금' 이었다.
 *  B2-04 /capacity/storage — 수집 실패·용량 미수집 장비를 '0 바이트 · 사용량 읽음' 으로 주던 것 → null + usedUnknown:true.
 *        내부 Overview storageCapacityTotals 와 같은 판정(`!(total>0) || ok===false`).
 *  B2-05 경보를 조회하지 않은 vCenter(REST 폴백) — 행 alarms 를 0 이 아니라 null, /faults/alarms meta 에 개수·id.
 *
 * 실제 store.refresh · 실제 /api/v1 라우터 · 실제 /api 라우터(/health)를 띄워 값으로 본다(소스 grep 아님).
 * ⚠ config.js 는 import 시점에 env 를 굳힌다 — 아래 env 고정이 모든 import 보다 앞이다.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2732a-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0',
});
const HOUR = 3_600_000;
const DAY = 86_400_000;
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  // 담당 엣지가 3일 전에 멈춘 위임 vCenter — 엣지가 마지막으로 보낸 status 는 connected
  { id: 'vc-site-old', name: 'SiteOld', host: 'https://10.9.9.9', collectMode: 'site', remoteAgent: 'edge1', enabled: true },
  // 방금 push 한 위임 vCenter — 엣지가 REST 폴백으로 수집해 경보를 조회하지 않았다
  { id: 'vc-site-new', name: 'SiteNew', host: 'https://10.9.9.8', collectMode: 'site', remoteAgent: 'edge2', enabled: true },
  // 중앙 직접 수집 — 접속 실패 중이고 마지막 정상 값을 이월(LASTGOOD)
  { id: 'vc-direct-lg', name: 'DirectLG', host: 'https://10.9.9.7', username: 'u', password: 'p', enabled: true, pollIntervalSec: 86400 },
  // 중앙 직접 수집 — 정상
  { id: 'vc-direct-ok', name: 'DirectOK', host: 'https://10.9.9.6', username: 'u', password: 'p', enabled: true, pollIntervalSec: 86400 },
] }));

const inv = await import('../src/central/inventory.js');
const storeMod = await import('../src/store.js');
const { store, scopedRollups } = storeMod;
const express = (await import('express')).default;
const v1 = (await import('../src/routes/publicApi.js')).default;
const keys = await import('../src/publicapi/keys.js');
const { api } = await import('../src/routes/api.js');
const { putSnapshot } = await import('../src/storage/store.js');
const { emptySnapshot } = await import('../src/storage/types.js');

const T0 = Date.now();
const OLD_AT = T0 - 3 * DAY;
const LG_AT = T0 - 2 * HOUR;
const host = (vc, n) => ({ id: `${vc}:h${n}`, vcenterId: vc, name: `h${n}`, connectionState: 'CONNECTED', cpuTotalMhz: 1000, cpuUsageMhz: 500, memTotalMB: 1000, memUsageMB: 500 });
const vm = (vc, n) => ({ id: `${vc}:v${n}`, vcenterId: vc, name: `v${n}`, powerState: 'POWERED_ON' });
const alarm = (vc, n) => ({ id: `${vc}:a${n}`, vcenterId: vc, entity: 'h1', entityType: 'host', severity: 'warning' });

inv.setInventory('vc-site-old', { vcenter: { id: 'vc-site-old', name: 'SiteOld', status: 'connected', version: '8.0' },
  hosts: [host('vc-site-old', 1)], vms: [vm('vc-site-old', 1)], datastores: [], networks: [], alarms: [alarm('vc-site-old', 1)] }, 'edge1', T0);
inv.getInventory('vc-site-old').at = OLD_AT;   // 엣지 push 가 3일 전에 멈췄다
inv.setInventory('vc-site-new', { vcenter: { id: 'vc-site-new', name: 'SiteNew', status: 'connected', version: '8.0', collectSource: 'rest', alarmsUnknown: true },
  hosts: [host('vc-site-new', 1)], vms: [vm('vc-site-new', 1)], datastores: [], networks: [], alarms: [] }, 'edge2', T0);
const lgData = { vcenter: { id: 'vc-direct-lg', name: 'DirectLG', status: 'connected', version: '7.0' },
  hosts: [host('vc-direct-lg', 1)], vms: [vm('vc-direct-lg', 1)], datastores: [], networks: [], alarms: [] };
const okData = { vcenter: { id: 'vc-direct-ok', name: 'DirectOK', status: 'connected', version: '8.0' },
  hosts: [host('vc-direct-ok', 1)], vms: [vm('vc-direct-ok', 1)], datastores: [], networks: [], alarms: [alarm('vc-direct-ok', 1), alarm('vc-direct-ok', 2)] };
// 주기가 하루라 이번 refresh 에는 수집하지 않는다(외부 접속 0) — 캐시만 병합된다.
store.vcLast.set('vc-direct-lg', T0); store.vcLast.set('vc-direct-ok', T0);
store.vcCache.set('vc-direct-lg', { ok: false, err: { message: 'connect ETIMEDOUT' }, at: T0, lastGood: lgData, lastGoodAt: LG_AT });
store.vcCache.set('vc-direct-ok', { ok: true, data: okData, at: T0 });
await store.refresh({ force: true });

// 스토리지 스냅샷 — 수집 실패(emptySnapshot 그대로) · 용량 섹션 없음(VPLEX 류) · 정상 · 사용량만 못 읽음
{
  const fail = emptySnapshot({ id: 'st-fail', type: 'unity480', name: 'Unity-Fail' }); fail.error = 'connect ECONNREFUSED';
  putSnapshot(fail);
  const skip = emptySnapshot({ id: 'st-skip', type: 'vplex', name: 'Vplex' }); skip.ok = true; skip.sections.config = 'ok';
  putSnapshot(skip);
  const good = emptySnapshot({ id: 'st-good', type: 'unity480', name: 'Unity-Good' }); good.ok = true;
  good.capacity = { totalBytes: 1000, usedBytes: 250, pct: 25 }; good.sections.capacity = 'ok';
  putSnapshot(good);
  // 수집 실패(ok:false)인데 capacity 에 값이 남아 있는 스냅샷 — Overview 와 같이 '못 읽음' 으로 본다(ok 판정을 빼면 잡힌다)
  const failCap = emptySnapshot({ id: 'st-failcap', type: 'powerstore', name: 'PS' }); failCap.error = '수집 타임아웃';
  failCap.capacity = { totalBytes: 500, usedBytes: 100, pct: 20 };
  putSnapshot(failCap);
  const noUsed = emptySnapshot({ id: 'st-noused', type: 'isilon', name: 'Isi' }); noUsed.ok = true;
  noUsed.capacity = { totalBytes: 2000, usedBytes: null, pct: null }; noUsed.sections.capacity = 'ok';
  putSnapshot(noUsed);
}

const app = express(); app.use(express.json());
app.use('/api/v1', v1);
app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
const KEY = keys.issueApiKey({ name: 'all', groups: ['inventory', 'capacity', 'faults'] }).plaintext;
const call = async (p) => (await fetch(`${base}/api/v1${p}`, { headers: { 'X-Api-Key': KEY } })).json();

after(() => {
  srv.close();
  try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ }
});

test('B2-01 ① 롤업: 엣지 push 가 낡은 위임 vCenter 를 vcentersStale 로 센다(status·연결 수는 그대로)', () => {
  const snap = store.get();
  const old = snap.vcenters.find((v) => v.id === 'vc-site-old');
  assert.equal(old.status, 'connected', '엣지가 보낸 status 는 바꾸지 않는다(헤더 N/M 계약)');
  assert.equal(old.stale, true);
  const g = snap.rollups.global;
  assert.equal(g.vcentersStale, 1, `롤업 vcentersStale=${g.vcentersStale} — 엣지 push 가 3일 전에 멈춘 vCenter 를 세지 않았다`);
  // 접속 실패 이월(LASTGOOD)은 이미 unreachable 로 센다 — 여기에 겹쳐 세지 않는다(리드 결정: 엣지 push 가 낡은 site vCenter 수)
  assert.equal(g.vcentersUnreachable, 1);
  assert.equal(g.vcentersConnected, 3, '연결 수 계약은 그대로(site-old·site-new·direct-ok)');
  // 범위 롤업도 같은 판정으로 다시 센다
  assert.equal(scopedRollups(snap, new Set(['vc-site-old'])).global.vcentersStale, 1);
  assert.equal(scopedRollups(snap, new Set(['vc-site-new', 'vc-direct-lg'])).global.vcentersStale, 0);
});

test('B2-01 ② /health 도 vcentersStale 를 싣는다', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.vcentersStale, 1, `/health vcentersStale=${h.vcentersStale}`);
  assert.equal(h.vcentersConnected, 3);
});

test('B2-01 ③ 공개 API /inventory/vcenters — collectedAt 은 실제 수신 시각이고 stale 을 밝힌다', async () => {
  const j = await call('/inventory/vcenters');
  const by = Object.fromEntries(j.data.map((r) => [r.id, r]));
  // 3일 전 값을 '방금' 이라 말하지 않는다
  assert.equal(by['vc-site-old'].collectedAt, OLD_AT, `site collectedAt 이 receivedAt 이 아니다(나이 ${((T0 - by['vc-site-old'].collectedAt) / 1000).toFixed(0)}초)`);
  assert.equal(by['vc-site-old'].stale, true);
  assert.equal(by['vc-site-old'].status, 'connected');
  // 마지막 정상 값 이월은 그 값을 수집한 시각
  assert.equal(by['vc-direct-lg'].collectedAt, LG_AT, '이월 값의 collectedAt 이 staleSince 가 아니다');
  assert.equal(by['vc-direct-lg'].stale, true);
  // 정상 직접 수집·신선한 위임은 stale:false — 직접 수집은 예전처럼 스냅샷 시각(숫자)
  assert.equal(by['vc-direct-ok'].stale, false);
  assert.equal(typeof by['vc-direct-ok'].collectedAt, 'number');
  assert.equal(by['vc-site-new'].stale, false);
  assert.ok(Math.abs(by['vc-site-new'].collectedAt - T0) < 5_000, 'site collectedAt 은 그 vCenter 의 수신 시각');
  assert.equal(j.meta.staleCount, 2, `meta.staleCount=${j.meta.staleCount}`);
});

test('B2-01 ④ 공개 API /inventory/collection — stale 개수(/health 와 같은 기준)', async () => {
  const j = await call('/inventory/collection');
  assert.equal(j.data.stale, 1, `collection.stale=${j.data.stale}`);
  assert.equal(j.data.connected, 3);
  assert.equal(j.data.unreachable, 1);
});

test('B2-05 경보를 조회하지 않은 vCenter — 행 alarms 는 0 이 아니라 null · /faults/alarms meta 에 개수', async () => {
  const j = await call('/inventory/vcenters');
  const by = Object.fromEntries(j.data.map((r) => [r.id, r]));
  assert.equal(by['vc-site-new'].alarms, null, `REST 폴백 vCenter 의 alarms=${by['vc-site-new'].alarms} — 미조회를 0 건으로 줬다`);
  assert.equal(by['vc-direct-ok'].alarms, 2, '조회한 vCenter 는 그대로 센다');
  assert.equal(by['vc-site-old'].alarms, 1);
  assert.equal(j.meta.alarmsUnknownCount, 1);
  const fa = await call('/faults/alarms');
  assert.equal(fa.meta.alarmsUnknownVcenters, 1, `/faults/alarms meta.alarmsUnknownVcenters=${fa.meta.alarmsUnknownVcenters}`);
  assert.deepEqual(fa.meta.alarmsUnknownVcenterIds, ['vc-site-new']);
  assert.match(fa.meta.note, /경보를 조회하지 않은/);
});

test('B2-04 /capacity/storage — 수집 실패·용량 미수집 장비는 0 바이트가 아니라 null + usedUnknown', async () => {
  const j = await call('/capacity/storage');
  const by = Object.fromEntries(j.data.map((r) => [r.deviceId, r]));
  for (const id of ['st-fail', 'st-skip', 'st-failcap']) {
    const r = by[id];
    assert.ok(r, `${id} 행이 없다`);
    assert.equal(r.totalBytes, null, `${id} totalBytes=${r.totalBytes} — 못 읽은 용량을 0 으로 줬다`);
    assert.equal(r.usedBytes, null, `${id} usedBytes=${r.usedBytes}`);
    assert.equal(r.usedPct, null);
    assert.equal(r.usedUnknown, true, `${id} usedUnknown=${r.usedUnknown}`);
  }
  assert.deepEqual([by['st-good'].totalBytes, by['st-good'].usedBytes, by['st-good'].usedPct, by['st-good'].usedUnknown], [1000, 250, 25, false]);
  assert.deepEqual([by['st-noused'].totalBytes, by['st-noused'].usedBytes, by['st-noused'].usedUnknown], [2000, null, true]);
  assert.equal(j.meta.capacityUnreadCount, 3, `meta.capacityUnreadCount=${j.meta.capacityUnreadCount}`);
  assert.equal(j.meta.usedUnknownCount, 4);
  assert.match(j.meta.note, /용량을 읽지 못한 장비 3대/);
});

test('투사 계약 — 바뀐 세 경로의 응답 키 == allowlist 선언 fields', async () => {
  const { ENDPOINT_BY_PATH } = await import('../src/publicapi/allowlist.js');
  for (const p of ['/inventory/vcenters', '/inventory/collection', '/capacity/storage', '/faults/alarms']) {
    const j = await call(p);
    const one = Array.isArray(j.data) ? j.data[0] : j.data;
    assert.ok(one, `${p} 데이터 없음`);
    assert.deepEqual(Object.keys(one).sort(), [...ENDPOINT_BY_PATH[p].fields].sort(), `${p} 응답 키가 선언과 다르다`);
  }
});
