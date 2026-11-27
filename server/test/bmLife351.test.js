// 물리서버 부품 수명 지표(v3.51 — 설계 docs/design/bm-feature-proposals ⑧).
//   SSD 잔여 수명(표준 값 · 0~100 · 못 읽음 null · HDD 제외 · 같은 모델 대비 낮음) · 요약/엣지 정제 짝 · 수집 서버 축약 · 정제 짝 ·
//   메모리 교정 오류 경고(SEL 문구 · 슬롯 · 기간 · 덮음 판정) · /hwlog 응답의 memCe · 인벤토리 수집(가짜 장비 — 추가 요청 0).
//   픽스처 식별자는 전부 합성(SYNTH · 192.0.2.x).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmlife351-'));
// 인벤토리 캐시는 종료 때 한 번 더 쓴다 — after 에서 지우면 그 뒤에 다시 생긴다(반증 A20). 종료 때도 지운다
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';

const PL = await import('../src/idrac/partLife.js');
const HS = await import('../src/idrac/hwSummary.js');

test('SSD 잔여 수명 — 0~100 만 · 못 읽음은 null(0 이 아니다) · HDD 제외 · 낮음 · 같은 모델 가운데값 대비 혼자 빨리 닳음', () => {
  assert.deepEqual([PL.lifePctOf(97), PL.lifePctOf('61'), PL.lifePctOf(0), PL.lifePctOf(100), PL.lifePctOf(55.55)], [97, 61, 0, 100, 55.6]);
  for (const bad of [null, undefined, '', 'x', -1, 101, NaN, true, [50], { v: 1 }]) assert.equal(PL.lifePctOf(bad), null, String(bad));
  const D = (name, life, extra = {}) => ({ name, model: 'SYNTH-SSD-960', capacityGB: 960, media: 'SSD', protocol: 'SAS', lifeLeftPct: life, ...extra });
  const rows = PL.ssdLifeRows([D('Bay 0', 97), D('Bay 1', 94), D('Bay 2', 61), D('Bay 3', null), { name: 'Bay 4', media: 'HDD', capacityGB: 4000 }, D('Bay 5', 8, { model: 'OTHER' }), { name: 'NVMe 0', protocol: 'NVMe', lifeLeftPct: 99 }]);
  assert.deepEqual(rows.map((r) => [r.name, r.life, r.low, r.gap]), [['Bay 0', 97, false, null], ['Bay 1', 94, false, null], ['Bay 2', 61, false, 34.5], ['Bay 3', null, false, null], ['Bay 5', 8, true, null], ['NVMe 0', 99, false, null]], 'HDD 는 빠지고 NVMe 는 들어간다');
  assert.equal(PL.ssdLifeRows([D('a', 90), D('b', 20)]).every((r) => r.gap == null), true, '비교할 다른 SSD 가 2개 미만이면 견주지 않는다');
  // 경계 — 낮음은 LIFE_LOW_PCT ‘이하’ · 같은 모델 차이는 LIFE_PEER_GAP ‘이상’(변이 L04 · L05)
  assert.deepEqual(PL.ssdLifeRows([D('lo', PL.LIFE_LOW_PCT), D('hi', PL.LIFE_LOW_PCT + 0.1)]).map((r) => r.low), [true, false]);
  assert.deepEqual(PL.ssdLifeRows([D('a', 90), D('b', 90), D('c', 90 - PL.LIFE_PEER_GAP), D('d', 90 - PL.LIFE_PEER_GAP + 0.1)]).map((r) => r.gap), [null, null, PL.LIFE_PEER_GAP, null]);
  assert.equal(PL.ssdLifeRows(null), null, '디스크를 못 읽음');
  assert.deepEqual(PL.ssdLifeRows([{ media: 'HDD' }]), [], 'SSD 없음');
  // 읽기 전 판 인벤토리(키 없음)와 장비가 값을 주지 않음(null)을 가른다(반증 B7)
  assert.deepEqual(PL.ssdLifeRows([{ name: 'old', media: 'SSD' }, D('none', null)]).map((r) => [r.name, r.life, r.stale === true]), [['old', null, true], ['none', null, false]]);
  assert.deepEqual(PL.lifeSummaryOf([D('a', 90), D('b', null), D('c', 70)]), { n: 3, read: 2, min: 70 });
  assert.deepEqual(PL.lifeSummaryOf([D('a', null)]), { n: 1, read: 0, min: null });
  assert.equal(PL.lifeSummaryOf([{ media: 'HDD' }]), null);
});

test('요약 · 상세 · 엣지 정제 — SSD 가 있으면 disk.life · 정제는 아는 키만 · read ≤ n · 구버전 엣지(키 없음)는 키를 만들지 않는다', () => {
  const inv = { collectedAt: 1, collections: { disks: 'ok' }, disks: [
    { name: 'Bay 0', model: 'M', capacityGB: 960, media: 'SSD', lifeLeftPct: 97 }, { name: 'Bay 1', model: 'M', capacityGB: 960, media: 'SSD', lifeLeftPct: 40 },
    { name: 'Bay 2', model: 'H', capacityGB: 4000, media: 'HDD' }] };
  const sm = HS.hwSummaryOf(inv);
  assert.deepEqual(sm.disk.life, { n: 2, read: 2, min: 40 });
  assert.deepEqual(HS.hwDetailOf(inv).life.map((x) => x.life), [97, 40]);
  assert.deepEqual(HS.sanitizeHwSummary(sm).disk.life, { n: 2, read: 2, min: 40 });
  const bad = (life) => HS.sanitizeHwSummary({ ...sm, disk: { ...sm.disk, life } }).disk;
  assert.equal('life' in bad({ n: 2, read: 5, min: 3 }), false, 'read > n');
  assert.equal('life' in bad({ n: 'x', read: 1, min: 3 }), false);
  assert.equal('life' in bad({ n: 2, read: 1, min: 300 }), false, '읽었다면서 최솟값이 범위 밖이면 요약을 싣지 않는다(어긋난 값 — 디버깅 2회차 엣지 #7)');
  assert.equal(bad({ n: 2, read: 0, min: 50 }).life.min, null, '읽은 것이 없으면 최솟값도 없다');
  assert.equal('life' in HS.sanitizeHwSummary({ ...sm, disk: { n: 3, gb: 1, ssd: 2, hdd: 1, nvme: 0 } }).disk, false, '구버전 엣지');
  const hddOnly = HS.hwSummaryOf({ collectedAt: 1, collections: { disks: 'ok' }, disks: [{ media: 'HDD', capacityGB: 1 }] });
  assert.equal('life' in hddOnly.disk, false);
  assert.equal(HS.hwDetailOf({ collectedAt: 1, collections: { disks: 'failed' } }).life, null, '디스크를 못 읽음');
});

test('수집 서버 경로 — 엣지 축약(compactInv) ↔ 중앙 정제(sanitizeRemoteInv) 짝에 lifeLeftPct', async () => {
  const { compactInv } = await import('../src/collector/compactInv.js');
  const rinv = await import('../src/collector/remoteInventory.js');
  const c = compactInv({ collectedAt: 1, collections: { disks: 'ok' }, system: { serviceTag: 'SYNTH01' }, disks: [{ name: 'Bay 0', model: 'M', capacityGB: 960, media: 'SSD', protocol: 'SAS', health: 'OK', state: 'Enabled', lifeLeftPct: 87 }] });
  assert.equal(c.disks[0].lifeLeftPct, 87);
  const back = rinv.sanitizeRemoteInv(c);
  assert.equal(HS.hwDetailOf(back).life[0].life, 87);
  assert.equal('lifeLeftPct' in compactInv({ disks: [{ name: 'x', media: 'HDD' }] }).disks[0], false, '읽기 전 판 인벤토리(키 없음)는 키를 만들지 않는다');
  // 읽었으나 장비가 값을 주지 않음 — null 로 싣고 중앙에서도 null(‘읽기 전 판’ 으로 보이지 않게 — 반증 B7)
  const cn = compactInv({ collectedAt: 1, collections: { disks: 'ok' }, disks: [{ name: 'Bay 1', media: 'SSD', lifeLeftPct: null }] });
  assert.equal(cn.disks[0].lifeLeftPct, null);
  const row = HS.hwDetailOf(rinv.sanitizeRemoteInv(cn)).life[0];
  assert.deepEqual([row.life, row.stale === true], [null, false]);
});

test('인벤토리 수집 — 디스크 응답의 PredictedMediaLifeLeftPercent 를 싣는다(추가 요청 0)', async () => {
  const src = fs.readFileSync(new URL('../src/idrac/redfish.js', import.meta.url), 'utf8');
  assert.match(src, /lifeLeftPct: lifePctOf\(drive\.PredictedMediaLifeLeftPercent\)/);
  // 디스크마다 GET 하는 자원 그대로(새 경로 없음) — Drives 루프 안의 같은 drive 응답
  const loop = src.slice(src.indexOf('for (const d of (ctrl.Drives'), src.indexOf("inv.collections.disks = 'ok'"));
  assert.equal((loop.match(/await G\(/g) || []).length, 1, '디스크마다 GET 은 하나 그대로');
});

test('메모리 교정 오류 경고 — SEL 문구 · 슬롯(Dell · HPE) · 30일 · 교정 불가는 빼고 · 덮음 판정(0 을 없음으로 단정하지 않는다)', () => {
  assert.deepEqual(['Correctable memory error rate exceeded for DIMM_B3.', 'Correctable memory error rate exceeded for DIMM B12 (demo).', 'x DIMM.Socket.A1 y', 'Corrected Memory Error threshold exceeded (Processor 1, Memory Module 3)', 'no slot'].map(PL.dimmSlotOf), ['B3', 'B12', 'A1', 'P1-M3', '']);
  assert.equal(PL.isMemCeRow({ msg: 'Correctable memory error rate exceeded for DIMM_B3.' }), true);
  assert.equal(PL.isMemCeRow({ msg: 'Multi-bit memory errors detected on DIMM_B3. Uncorrectable.' }), false, '교정 불가는 교정 오류 경고가 아니다');
  assert.equal(PL.isMemCeRow({ msg: 'The memory health monitor feature has detected a degradation in the DIMM installed in DIMM_A1. uncorrectable' }), false);
  assert.equal(PL.isMemCeRow({ msg: 'Drive 4 failed' }), false);
  assert.deepEqual(['DIMM.Socket.A1', 'A2', 'DIMM_B3', 'PROC 1 DIMM 3', ''].map(PL.dimmLocatorKey), ['A1', 'A2', 'B3', '', '']);
  const now = Date.UTC(2026, 10, 26);
  const day = 86_400_000;
  const R = (dAgo, msg) => ({ at: now - dAgo * day, sev: 'warning', code: 'MEM0701', msg });
  const ce = (slot) => `Correctable memory error rate exceeded for DIMM_${slot}.`;
  const log = { status: 'ok', total: 4, read: 4, stopped: '', gap: 0, rows: [R(1, ce('B3')), R(2, ce('B3')), R(3, 'Correctable memory error rate exceeded.'), R(40, ce('A1'))] };
  const m = PL.memCeOf(log, { now, dimms: ['DIMM.Socket.A1', 'DIMM.Socket.B3', 'DIMM.Socket.A2'] });
  assert.deepEqual([m.covered, m.total, m.slots, m.unknownSlot], [true, 3, [['A1', 0], ['A2', 0], ['B3', 2]], 1], '40일 전 기록은 기간 밖 · 슬롯 모름은 따로');
  // 쪽 상한으로 일부만 읽었고 가장 오래된 기록이 기간 안 — 덮지 못함
  const part = PL.memCeOf({ status: 'ok', total: 5000, read: 1000, stopped: 'max', gap: 0, rows: [R(1, ce('B3')), R(5, 'x')] }, { now });
  assert.equal(part.covered, false);
  // 일부만 읽었으면(쪽 상한 · 건너뜀 · 시한) 가장 오래된 기록이 기간 밖이어도 덮었다고 하지 않는다 — 장비 정렬을 모른다(반증 A9)
  assert.equal(PL.memCeOf({ status: 'ok', total: 5000, read: 1000, stopped: 'max', gap: 0, rows: [R(1, 'x'), R(45, 'y')] }, { now }).covered, false);
  assert.equal(PL.memCeOf({ status: 'ok', total: 5000, read: 1000, stopped: '', gap: 3000, rows: [R(1, 'x'), R(45, 'y')] }, { now }).covered, false);
  assert.equal(PL.memCeOf({ status: 'ok', total: null, read: 50, stopped: 'skip', gap: 0, rows: [R(1, 'x'), R(45, 'y')] }, { now }).covered, false);
  // 다 읽었다(멈춤 · 건너뜀 없음) — 읽은 것이 화면 줄 안이면 덮음 · 줄보다 많으면 가장 오래된 화면 줄이 기간 밖일 때만
  assert.equal(PL.memCeOf({ status: 'ok', total: null, read: 2, stopped: '', gap: 0, rows: [R(1, 'x'), R(2, 'y')] }, { now }).covered, true);
  assert.equal(PL.memCeOf({ status: 'ok', total: 900, read: 900, stopped: '', gap: 0, rows: [R(1, 'x'), R(2, 'y')] }, { now }).covered, false, '900건 중 화면 줄은 가장 새 것 — 기간 안이면 더 있을 수 있다');
  assert.equal(PL.memCeOf({ status: 'ok', total: 900, read: 900, stopped: '', gap: 0, rows: [R(1, 'x'), R(45, 'y')] }, { now }).covered, true);
  // 슬롯 상한을 넘은 경고도 어딘가엔 센다(반증 S4)
  const many = Array.from({ length: 70 }, (_, i) => R(1, `Correctable memory error rate exceeded for DIMM_${String.fromCharCode(65 + Math.floor(i / 20))}${(i % 20) + 1}.`));
  const mm = PL.memCeOf({ status: 'ok', total: 70, read: 70, stopped: '', gap: 0, rows: many }, { now });
  assert.equal(mm.slots.reduce((a, x) => a + x[1], 0) + mm.unknownSlot, mm.total);
  // 문구 — 설정 · 기타 문구는 세지 않는다(반증 A19) · HPE 꼴
  assert.equal(PL.isMemCeRow({ msg: 'Memory configuration error corrected after reboot.' }), false);
  assert.equal(PL.isMemCeRow({ msg: 'Corrected Memory Error threshold exceeded (Processor 2, DIMM 5)' }), true);
  assert.deepEqual(['(Processor 2, DIMM 5)', '(Slot 1, Memory Module 3)', 'CPU 1, Memory Module 4'].map(PL.dimmSlotOf), ['P2-M5', 'S1-M3', 'P1-M4']);
  assert.equal(PL.memCeOf({ status: 'empty', rows: [] }, { now }).covered, true, '로그가 비었다 — 다 읽었다');
  for (const st of ['auth', 'auth-stopped', 'timeout', 'error', 'absent']) assert.equal(PL.memCeOf({ status: st, rows: [] }, { now }), null, st);
  assert.equal(PL.memCeOf(null), null);
  // 길이에 비례
  const t0 = Date.now(); for (let i = 0; i < 2000; i++) PL.isMemCeRow({ msg: 'correctable '.repeat(25) }); assert.ok(Date.now() - t0 < 1500);
});

test('/hwlog 응답에 memCe — 가리기 전 원문에서 센다 · 이 노드 서버는 DIMM 목록으로 0 인 슬롯도 · 엣지 서버는 기록에 나온 슬롯만', async () => {
  const fleet = await import('../src/central/fleet.js');
  const bs = await import('../src/bmfolders/store.js');
  const sm = await import('../src/servicemap/store.js');
  const registry = await import('../src/idrac/registry.js');
  const invCache = await import('../src/idrac/invCache.js');
  const { store } = await import('../src/store.js');
  const { registerBmFolders, _setTrendDepsForTest } = await import('../src/routes/api/bmFolders.js');
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  registry.importServers([{ id: 's1', name: 'synth-db-s1', host: 'https://192.0.2.11', username: 'root', password: 'x', serviceTag: 'SYNTH01', model: 'PowerEdge R750', vcenterId: 'vc-a' }], 'replace');
  invCache.setInventory('s1', { collectedAt: 1, collections: { system: 'ok', memoryDimms: 'ok' }, system: { serviceTag: 'SYNTH01', model: 'PowerEdge R750' }, memoryDimms: [{ locator: 'DIMM.Socket.A1' }, { locator: 'DIMM.Socket.B3' }] });
  const routes = new Map();
  registerBmFolders({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
  const now = Date.now();
  const log = { ok: true, at: now, status: 'ok', read: 2, total: 2, pages: 1, gap: 0, stopped: '', counts: { critical: 0, warning: 2, ok: 0, other: 0 },
    rows: [{ at: now - 3_600_000, sev: 'warning', code: 'MEM0701', sensor: 'Memory', msg: 'Correctable memory error rate exceeded for DIMM_B3 on 192.0.2.5.' }, { at: now - 7_200_000, sev: 'warning', code: 'X', sensor: '', msg: 'other' }] };
  _setTrendDepsForTest({ resolvePerfTarget: async () => null, perfTargetFail: () => ({}), targets: {}, hwLogEntry: async (id) => (id === 's1' ? { id, host: 'https://192.0.2.11' } : null), hwLogLocal: async () => log, hwLogEdge: async () => ({ ok: false, kind: 'old-version' }), hwLogDemo: async () => null });
  const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  const OPER = { username: 'oper1', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };
  const call = async (key, { user = ADMIN, query = {} } = {}) => {
    const res = { statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; }, set() { return this; }, setHeader() {} };
    await routes.get(key).at(-1)({ user, query, body: {}, ip: '127.0.0.1', headers: {}, originalUrl: `/api${key.slice(4)}?${new URLSearchParams(query)}&u=${user.username}&n=${Math.random()}` }, res);
    return res;
  };
  const prev = store.snapshot;
  try {
    store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now() + 5000, vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }], hosts: [], vms: [] };
    const list = (await call('GET /tools/bm-folders')).body;
    const k1 = list.servers.find((x) => x.name === 'synth-db-s1').key;
    const op = (await call('GET /tools/bm-folders/hwlog', { user: OPER, query: { key: k1 } })).body;
    assert.match(op.rows[0].msg, /•••/, '글자는 가린다');
    assert.deepEqual([op.memCe.total, op.memCe.slots, op.memCe.covered], [1, [['A1', 0], ['B3', 1]], true], '가리기 전 원문에서 센다 · DIMM 목록으로 0 인 슬롯도');
  } finally { store.snapshot = prev; _setTrendDepsForTest(null); }
});
