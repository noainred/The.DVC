// v2.600 감사 수정 — 그룹 a(중앙 수신 경로). 실제 central 라우터를 express 에 띄워 상태코드·응답·저장 결과로 본다.
//   RECENT2600-01 · RECENT2600-02 · RECENT2600-05 · CEN2600-01 · CEN2600-02 · CEN2600-03 · CEN2600-10 · T2600-03 ·
//   EDGE2600-03 · LO2600-01
// 각 테스트는 **수정을 되돌리면 실패하도록** 입력을 골랐다(변이 검증은 감사 기준 커밋 72aa866 판본으로 했다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 3_600_000;
const TOKEN = 'tok-2600a-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2600a-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.GUESTDISK_DB_PATH = path.join(CFG, 'guest-disk.db');
process.env.CURUSER_DB_PATH = path.join(CFG, 'curuser.db');
const REG_LOC = { city: 'Warsaw', country: 'PL', region: 'EMEA', lat: 52.2, lon: 21.0 };
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-site1', name: 'Site1', host: 'https://10.0.0.1', collectMode: 'site', location: REG_LOC },
  // 점검중(maintenance)이라 store.refresh 가 접속하지 않는다 — 판정에 쓰는 것은 collectMode 뿐이다.
  { id: 'vc-direct', name: 'Direct', host: 'https://10.0.0.9', collectMode: 'direct', maintenance: true },
] }));

let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
});
after(() => { srv?.close(); });

const post = (p, body, { token = TOKEN } = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// ── RECENT2600-01 ────────────────────────────────────────────────────────────
test('RECENT2600-01 — /inventory 는 vcenter.location 객체를 지우지 않고 하위 필드만 좁힌다', async () => {
  const { getInventory } = await import('../src/central/inventory.js');
  const r = await post('/inventory', { agent: 'edge-a', vcenterId: 'vc-site1',
    vcenter: { id: 'vc-site1', name: 'Site1', location: { city: 'Warsaw', country: 'PL', region: 'EMEA', lat: 52.2, lon: '21', evil: { x: 1 }, site: { o: 1 } } },
    hosts: [], vms: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const loc = getInventory('vc-site1').data.vcenter.location;
  assert.ok(loc && typeof loc === 'object', `정상 push 의 위치가 사라지면 안 된다: ${JSON.stringify(loc)}`);
  assert.equal(loc.region, 'EMEA');
  assert.equal(loc.city, 'Warsaw');
  assert.equal(loc.lon, 21, '숫자 글자는 수로');
  assert.ok(!('evil' in loc), '모르는 키는 싣지 않는다');
  assert.ok(!('site' in loc), '객체 하위 값은 뺀다');
  const { sanitizeVcLocation } = await import('../src/routes/central.js');
  assert.deepEqual(sanitizeVcLocation({ lat: 999, lon: 'x', region: 'KR' }), { value: { region: 'KR' }, coerced: 2 });
  assert.equal(sanitizeVcLocation('Seoul').value, null);
});

test('RECENT2600-01 2차 방어 — 저장된 site 인벤토리의 location 이 null 이어도 병합은 등록부 위치로 지역을 묶는다', async () => {
  const { setInventory } = await import('../src/central/inventory.js');
  const { store } = await import('../src/store.js');
  setInventory('vc-site1', { vcenter: { id: 'vc-site1', name: 'Site1', location: null }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] }, 'edge-a', null);
  await store.refresh({ force: true });
  assert.equal(store.lastError, null, `refresh 실패: ${store.lastError}`);
  const vc = store.get().vcenters.find((v) => v.id === 'vc-site1');
  assert.equal(vc.location?.region, 'EMEA', JSON.stringify(vc.location));
});

// ── LO2600-01 ────────────────────────────────────────────────────────────────
test('LO2600-01 — DS 사용량을 하나도 못 읽으면 스토리지 사용률은 0% 가 아니라 null', async () => {
  const { scopedRollups } = await import('../src/store.js');
  const DS_UNKNOWN = { id: 'ds-u', vcenterId: 'vc1', capacityGB: 1000, usedGB: null, freeGB: null };
  const snap = { vcenters: [{ id: 'vc1', location: { region: 'KR' } }], hosts: [], vms: [], alarms: [], networks: [], datastores: [DS_UNKNOWN] };
  const r = scopedRollups(snap, new Set(['vc1']));
  assert.equal(r.global.storageUsagePct, null);
  assert.equal(r.global.datastoresUsageUnknown, 1);
  assert.equal(r.sites.find((x) => x.id === 'vc1').metrics.storageUsagePct, null);
  assert.equal(r.byRegion[0].storageUsagePct, null);
});

// ── CEN2600-10 ───────────────────────────────────────────────────────────────
test('CEN2600-10 — 공유 토큰 본문 agent 가 객체여도 500 이 아니다', async () => {
  const r = await post('/result', { agent: { toString: 'x' }, scanned: 1 });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const g = await post('/gpu-guest-data', { agent: { toString: 'x' }, hosts: [] });
  assert.equal(g.status, 400, JSON.stringify(g.body));
  const reg = await post('/register-collector', { name: { toString: 'x' }, port: 1, collectorToken: 't' });
  assert.equal(reg.status, 400, JSON.stringify(reg.body));
  const ok = await post('/result', { agent: 'edge-ok', scanned: 1 });
  assert.equal(ok.status, 200);
});

// ── CEN2600-01 ───────────────────────────────────────────────────────────────
test('CEN2600-01 — gpu-guest-data 는 사용률을 0~100 유한수로 좁힌다(객체가 지표 적재를 롤백시키지 않게)', async () => {
  const { getGuestGpuHost, getGuestGpuVms } = await import('../src/gpu/store.js');
  const r = await post('/gpu-guest-data', { agent: 'edge-g', hosts: [
    { hostId: 'vc-site1:host-evil', utilPct: { evil: 1 } },
    { hostId: 'vc-site1:host-ok', utilPct: '42.5' },
    { hostId: { o: 1 }, utilPct: 10 },
  ], vms: [{ vmId: 'vc-site1:vm-1', utilPct: 150, memUsedPct: [3], host: { h: 1 }, vcenterId: 'vc-site1' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(getGuestGpuHost('vc-site1:host-evil'), null, '사용률이 객체면 오버레이를 만들지 않는다(null)');
  assert.equal(getGuestGpuHost('vc-site1:host-ok').utilPct, 42.5);
  const vm = getGuestGpuVms().find((v) => v.vmId === 'vc-site1:vm-1');
  assert.equal(vm, undefined, '범위 밖 사용률(150)은 null 이고 utilNA 도 아니므로 싣지 않는다');
  const { narrowGpuRow } = await import('../src/routes/central.js');
  const d = { badPct: 0 };
  assert.deepEqual(narrowGpuRow({ vmId: 'v', utilPct: 5, memUsedPct: { a: 1 }, host: { h: 1 }, vcenterId: 'vc' }, d),
    { vmId: 'v', utilPct: 5, memUsedPct: null, host: null, vcenterId: 'vc' });
  assert.equal(d.badPct, 1);
  for (const v of [...(await import('../src/gpu/store.js')).getGuestGpuAllHosts().values()]) {
    assert.ok(v.utilPct == null || Number.isFinite(v.utilPct), `저장된 사용률은 수 또는 null: ${JSON.stringify(v.utilPct)}`);
  }
});

// ── CEN2600-02 · CEN2600-03 ──────────────────────────────────────────────────
test('CEN2600-02 — 개별 토큰 엣지도 direct vCenter 의 curuser·guest-disk·vmseries·ping-result 를 쓸 수 없다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const A = issueAgentToken('edgeA').token;
  const cu = await post('/curuser', { chunk: 0, chunks: 1, vcenterIds: ['vc-direct'], records: [{ vmId: 'vm-1', vcenterId: 'vc-direct', name: 'x', at: 1, kind: 'ok', ok: true, users: [{ name: 'attacker', kind: 'active' }] }] }, { token: A });
  assert.equal(cu.status, 200, JSON.stringify(cu.body));
  assert.equal(cu.body.records, 0, 'direct vCenter 레코드는 받지 않는다');
  assert.deepEqual(cu.body.rejected, ['vc-direct']);
  assert.equal(cu.body.replaced, 0, 'direct vCenter 의 latest 를 교체하지 않는다');
  const gd = await post('/guest-disk', { vcenterId: 'vc-direct', vcenterName: 'Direct', vms: [] }, { token: A });
  assert.equal(gd.status, 403, JSON.stringify(gd.body));
  const vs = await post('/vmseries', { vcenterId: 'vc-direct', spikes: [] }, { token: A });
  assert.equal(vs.status, 403, JSON.stringify(vs.body));
  const pr = await post('/ping-result', { vcenterId: 'vc-direct', results: [{ ip: '10.0.0.1', alive: true }] }, { token: A });
  assert.equal(pr.status, 403, JSON.stringify(pr.body));
  // 공유 토큰도 같다(대상의 구조적 성질)
  const gdS = await post('/guest-disk', { vcenterId: 'vc-direct', vcenterName: 'Direct', vms: [] });
  assert.equal(gdS.status, 403);
});

test('CEN2600-03 — vmseries 는 등록되지 않은 vcenterId 로 파일을 만들지 않는다 · site 는 그대로 받는다', async () => {
  const dir = path.join(CFG, 'vmseries');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  for (let i = 0; i < 3; i++) {
    const r = await post('/vmseries', { vcenterId: `ghost-${i}`, spikes: [] });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  const afterN = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('ghost')).length : 0;
  assert.equal(afterN, 0, `ghost 파일 ${afterN}개(전 ${before})`);
  const ok = await post('/vmseries', { vcenterId: 'vc-site1', spikes: [], chunk: 0, chunks: 1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ── EDGE2600-03 ──────────────────────────────────────────────────────────────
test('EDGE2600-03 — 같은 청크의 재전송은 cover 표본을 두 번 더하지 않는다 · 다른 청크는 더한다', async () => {
  const { coverageOf } = await import('../src/vmseries/db.js');
  // 기준 시각은 정시에서 떨어뜨려 고정한다(v2.517 규약) — 라우트의 '최근 1년' 창 안에 있어야 해 현재 시각을 정시로 내린다.
  const h = Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR;
  const body = { vcenterId: 'vc-site1', chunk: 0, chunks: 1, generatedAt: 'gen-1', spikes: [], cover: [{ kind: 'vm', ref: 'vm-42', h, samples: 150 }] };
  assert.equal((await post('/vmseries', body)).status, 200);
  const dup = await post('/vmseries', body);   // 시한 초과 뒤 resilientFetch 재시도와 같은 본문
  assert.equal(dup.status, 200);
  assert.equal(dup.body.coverDuplicate, true);
  let rows = (await coverageOf('vc-site1', 'vm', 'vm-42', h - HOUR, h + HOUR)).hours;
  assert.deepEqual(rows.map((r) => Number(r.samples)), [150], JSON.stringify(rows));
  // 다음 주기(다른 generatedAt)는 가산한다 — 정상 누적은 그대로
  assert.equal((await post('/vmseries', { ...body, generatedAt: 'gen-2', cover: [{ kind: 'vm', ref: 'vm-42', h, samples: 30 }] })).status, 200);
  rows = (await coverageOf('vc-site1', 'vm', 'vm-42', h - HOUR, h + HOUR)).hours;
  assert.deepEqual(rows.map((r) => Number(r.samples)), [180]);
});

// ── RECENT2600-05 ────────────────────────────────────────────────────────────
test('RECENT2600-05 — agent-config 길이 상한은 엣지 수집 상한(8MiB)과 같고, 빠진 파일은 이름을 밝힌다', async () => {
  const mid = 'x'.repeat(8_100_000);            // 예전 상한(8,000,000) 과 8MiB 사이 — 예전에는 기록 없이 사라졌다
  const big = 'y'.repeat(8 * 1024 * 1024 + 10);
  const r = await post('/agent-config', { agent: 'edge-cfg', files: { 'mid.json': mid, 'big.json': big, 'obj.json': { a: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.files, 1, 'mid.json 은 받는다');
  assert.equal(r.body.rejectedFileCount, 2);
  assert.deepEqual(r.body.rejectedFiles.map((x) => `${x.name}:${x.reason}`).sort(), ['big.json:too-large', 'obj.json:not-string']);
});

// ── T2600-03 ─────────────────────────────────────────────────────────────────
test('T2600-03 — 관리자 소유권 해제·지정은 즉시 디스크에 쓰이고, 종료 flush 가 등록돼 있다', async () => {
  const inv = await import('../src/central/inventory.js');
  inv.setInventory('vc-own', { vcenter: { id: 'vc-own' }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] }, 'edge-old', null);
  const r = inv.setInventoryOwner('vc-own', 'edge-new');
  assert.equal(r.ok, true); assert.equal(r.persisted, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(CFG, 'central-inventory.json'), 'utf8'));
  assert.equal(onDisk.inventory['vc-own'].agent, 'edge-new', '5초 디바운스를 기다리지 않고 바로 저장돼야 한다');
  const { exitFlushNames } = await import('../src/util/exitFlush.js');
  assert.ok(exitFlushNames().includes('central/inventory'));
});

// ── RECENT2600-02 ────────────────────────────────────────────────────────────
function bigSanDevice(zones, aliases) {
  const wwn = (i, j) => `10:00:00:00:c9:${String(i % 100).padStart(2, '0')}:${String(j).padStart(2, '0')}:aa`;
  return {
    deviceId: 'san-big', name: 'dir-1', ok: true,
    ports: { total: 128, list: Array.from({ length: 128 }, (_, i) => ({ index: i, state: 'online', rxPowerDbm: -3 })) },
    zoning: {
      effectiveConfig: 'cfg1', source: 'cfgshow', zoneCount: zones,
      zones: Array.from({ length: zones }, (_, i) => ({ name: `zone_host_${i}_array`, members: Array.from({ length: 6 }, (_, j) => wwn(i, j)), aliasOf: {} })),
      aliases: Object.fromEntries(Array.from({ length: aliases }, (_, i) => [`alias_${i}`, [wwn(i, 1)]])),
      counts: { zones, definedZones: zones, aliases, cfgs: 1 }, truncated: false, limited: false,
    },
  };
}

test('RECENT2600-02 — 중앙은 조닝이 큰 SAN 스위치를 통째로 버리지 않고 조닝을 잘라 limited·개수를 싣는다', async () => {
  const { sanitizeEdgeDevices, EDGE_DEVICE_MAX_BYTES } = await import('../src/central/edgeRecord.js');
  const d = bigSanDevice(4000, 8000);
  assert.ok(JSON.stringify(d).length > EDGE_DEVICE_MAX_BYTES, '재현 입력은 장비 상한을 넘어야 한다');
  const r = sanitizeEdgeDevices([d], { idKey: 'deviceId' });
  assert.equal(r.devices.length, 1, `버려지면 안 된다: ${JSON.stringify(r.dropped)}`);
  assert.equal(r.dropped.tooLarge, 0);
  const z = r.devices[0].zoning;
  assert.equal(z.limited, true);
  assert.ok(z.trimmed.zonesOmitted + z.trimmed.aliasesOmitted > 0);
  assert.equal(z.zones.length + z.trimmed.zonesOmitted, 4000, '남긴 수 + 뺀 수 = 전체');
  assert.equal(Object.keys(z.aliases).length + z.trimmed.aliasesOmitted, 8000);
  assert.equal(z.counts.zones, 4000, '요약 개수는 전체 기준 유지');
  assert.ok(JSON.stringify(r.devices[0]).length <= EDGE_DEVICE_MAX_BYTES);
  assert.equal(d.zoning.zones.length, 4000, '입력 원본은 바꾸지 않는다');
});

test('RECENT2600-02 — 엣지 scopeSnapshot 도 포트 축약 뒤 조닝을 잘라 1회 전송 상한 안에 맞춘다', async () => {
  const { scopeSnapshot } = await import('../src/sanswitch/push.js');
  const maxBytes = 900 * 1024;
  const out = scopeSnapshot(bigSanDevice(4000, 8000), { scope: 'full', maxBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= maxBytes, `${Buffer.byteLength(JSON.stringify(out))}`);
  assert.equal(out.zoning.trimmed.by, 'edge');
  assert.equal(out.ports.portsScope, 'problem');
  // 작은 장비는 그대로(회귀 없음)
  const small = scopeSnapshot(bigSanDevice(10, 10), { scope: 'full', maxBytes });
  assert.equal(small.ports.portsScope, 'full');
  assert.equal(small.zoning.trimmed, undefined);
});

// ── EDGE2600-04(중앙쪽 · 그룹 c 에서 이관) ────────────────────────────────────
test('EDGE2600-04 — 인벤토리를 읽지 못한 빈 조각(unreachable·호스트/VM 0)은 중앙의 마지막 정상 목록을 지우지 않는다', async () => {
  const inv = await import('../src/central/inventory.js');
  const good = { vcenter: { id: 'vc-site1', name: 'Site1', status: 'connected', location: REG_LOC },
    hosts: [{ id: 'h1', name: 'esx1', vcenterId: 'vc-site1' }], vms: [{ id: 'v1', name: 'vm1', vcenterId: 'vc-site1' }], datastores: [], networks: [], alarms: [] };
  const r0 = await post('/inventory', { agent: 'edge-a', vcenterId: 'vc-site1', ...good });
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const at0 = inv.getInventory('vc-site1').at;
  // 구버전 엣지: 재시작 직후 첫 수집 실패 → 빈 unreachable 조각
  const r1 = await post('/inventory', { agent: 'edge-a', vcenterId: 'vc-site1',
    vcenter: { id: 'vc-site1', name: 'Site1', status: 'unreachable', error: 'connect ETIMEDOUT' }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.held, true);
  const e = inv.getInventory('vc-site1');
  assert.deepEqual(e.data.hosts.map((h) => h.id), ['h1'], '마지막 정상 호스트 목록이 남아야 한다');
  assert.deepEqual(e.data.vms.map((v) => v.id), ['v1']);
  assert.equal(e.data.vcenter.status, 'unreachable', '상태는 갱신한다(지금 값인 척하지 않는다)');
  assert.equal(e.data.vcenter.error, 'connect ETIMEDOUT');
  assert.equal(e.at, at0, '데이터 시각은 그대로 — store 가 stale 로 표시한다');
  assert.ok(e.pushAt >= at0, 'push 시각은 갱신(엣지는 살아 있다)');
  // 목록이 실제로 0 인 정상 조각은 그대로 받는다(회귀 없음)
  const r2 = await post('/inventory', { agent: 'edge-a', vcenterId: 'vc-site1', vcenter: { id: 'vc-site1', status: 'connected' }, hosts: [], vms: [] });
  assert.equal(r2.body.held, undefined);
  assert.equal(inv.getInventory('vc-site1').data.hosts.length, 0);
});

// ── CEN2600-09 마무리(그룹 c 에서 이관) ──────────────────────────────────────
test('CEN2600-09 — 위임 단일 캡처 이력의 hostA 를 라우트가 글자·제어문자 제거·길이 제한으로 넘긴다', async () => {
  const { enqueueCapture } = await import('../src/central/captureJobs.js');
  const { listCaptures } = await import('../src/net/captureHistory.js');
  const reqId = enqueueCapture('edge-cap', { host: '10.1.1.1', peer: '10.2.2.2', seconds: 5 });
  const r = await post('/capture-result', { reqId, result: { ok: true, hostA: '10.1.1.1\n\u001b[31mX', peer: '10.2.2.2', captured: 3, analysis: { stat: { packets: 3 }, issues: [] } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = listCaptures({ limit: 5 }).find((x) => x.via === 'agent');
  assert.ok(rec, '이력이 기록돼야 한다');
  assert.equal(rec.hostA, '10.1.1.1[31mX', `제어문자는 지운다: ${JSON.stringify(rec.hostA)}`);
  // 객체 hostA 는 넘기지 않는다(글자만)
  const reqId2 = enqueueCapture('edge-cap', { host: '10.1.1.1', peer: '10.2.2.2', seconds: 5 });
  const r2 = await post('/capture-result', { reqId: reqId2, result: { ok: true, hostA: { x: 1 }, peer: '10.2.2.2', captured: 1, analysis: { issues: [] } } });
  assert.equal(r2.status, 200);
});
