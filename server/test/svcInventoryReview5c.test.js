// 서비스 인벤토리 5차 검토 3차 반영 — docs/design/service-map/README.md §5차 검토(사용자 '3차 진행해줘' · 표준 + 반증 1인).
//   M4·R13 이름 규칙 적용 순서 · M5·R14 태그 여럿(서비스에 걸리는 값 · 모호 표시) · R10 판정 보류 시작 시각·출처 · R11 유령 정리 개수 확인 · M11·R19 CSV 열.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r5c-'));
process.env.CONFIG_DIR = tmp;

const { autoResolve, buildIndex, sortNameRules } = await import('../src/servicemap/resolve.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory, heldWithSince, _resetHeldSinceForTest } = await import('../src/routes/api/svcInventory.js');

const S = (id, name, extra = {}) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '', ...extra });
function mapOf(corps = {}, extra = {}) {
  const out = { rev: 0, corps: {}, globals: [], settings: { tagCategory: '' }, ...extra };
  for (const [vc, c] of Object.entries(corps)) out.corps[vc] = { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c };
  return out;
}
const vm = (key, corp, extra = {}) => ({ key, kind: 'vm', corp, name: key, folderPath: '/x', powered: true, cores: 2, memGB: 4, usage: { state: 'ok', cpuPct: 10, memPct: 10 }, faults: 0, ...extra });

const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: key.replace(/^\w+ /, '/api') }, res);
  return res;
}

test('M4·R13: 이름 규칙은 등록 순이 아니라 접두·접미 > 포함 · 긴 값 먼저 · 그다음 등록 순', () => {
  const rules = [
    { match: 'contains', value: 'db', serviceId: 'c' },       // 먼저 넣은 '포함' 이 뒤의 '접두' 를 가리면 안 된다(R13)
    { match: 'prefix', value: 'erp-', serviceId: 'p1' },
    { match: 'prefix', value: 'erp-db-', serviceId: 'p2' },   // 'erp-' 보다 길다 — 먼저(M4)
    { match: 'suffix', value: '-old', serviceId: 's1' },
    { match: 'prefix', value: 'web-', serviceId: 'p3' },      // '-old' 와 길이(4) 같음 — 등록 순(접미가 먼저)
  ];
  assert.deepEqual(sortNameRules(rules).map((r) => r.value), ['erp-db-', 'erp-', '-old', 'web-', 'db']);
  const map = mapOf({ A: { services: ['c', 'p1', 'p2', 's1', 'p3'].map((id) => S(id, id.toUpperCase())), nameRules: rules } });
  const idx = buildIndex(map);
  const sv = (name) => autoResolve(vm(name, 'A', { name, folderPath: '/' }), idx).serviceId;
  assert.equal(sv('erp-db-01'), 'p2', '가장 긴 접두');
  assert.equal(sv('erp-app-01'), 'p1');
  assert.equal(sv('mydb01'), 'c', '접두·접미가 없으면 포함');
  assert.equal(sv('web-old'), 's1', '같은 길이면 등록 순');
  assert.equal(sv('web-new'), 'p3');
  // 포함 값이 접두 값보다 길어도 접두가 먼저다(R13 — 길이만 보면 '포함' 이 이긴다: 변이 검증에서 처음 놓친 경우)
  const m2 = mapOf({ B: { services: [S('pp', 'PP'), S('cc', 'CC')], nameRules: [{ match: 'contains', value: 'prod-db', serviceId: 'cc' }, { match: 'prefix', value: 'app', serviceId: 'pp' }] } });
  assert.equal(autoResolve(vm('app-prod-db-1', 'B', { name: 'app-prod-db-1', folderPath: '/' }), buildIndex(m2)).serviceId, 'pp');
  assert.deepEqual(sortNameRules(m2.corps.B.nameRules).map((r) => r.match), ['prefix', 'contains']);
  // 법인 행은 적용 순서대로 순번을 싣는다(화면이 다시 계산하지 않게)
  const inv = buildInventory({ members: [], map });
  assert.deepEqual(inv.corps.find((c) => c.vcenterId === 'A').nameRules.map((r) => `${r.order}:${r.value}`), ['1:erp-db-', '2:erp-', '3:-old', '4:web-', '5:db']);
});

test('M5·R14: 태그 여럿 — 서비스에 걸리는 값을 고르고(첫 값만 보지 않는다) · 둘 이상 서비스면 모호로 검토 큐 · 수집 순서와 무관', () => {
  const map = mapOf({ A: { tagEnabled: true, services: [S('db', 'DB'), S('web', 'Web')], aliases: [{ kind: 'tag', value: 'www', serviceId: 'web' }], nameRules: [{ match: 'prefix', value: 'zz', serviceId: 'web' }] } }, { settings: { tagCategory: 'svc' } });
  const idx = buildIndex(map);
  const ctx = { tagCategory: 'svc' };
  const r1 = autoResolve(vm('k1', 'A', { name: 'zz-1', tags: ['backup-daily', 'DB'] }), idx, ctx);
  assert.equal(r1.serviceId, 'db', "첫 값('backup-daily')이 서비스가 아니어도 걸리는 값으로(예전에는 이름 규칙으로 갔다)");
  assert.equal(r1.src, 'tag'); assert.equal(r1.multi, true); assert.deepEqual(r1.tagValues, ['DB', 'backup-daily'], '걸린 값 먼저'); assert.equal(r1.tagAmbiguous, undefined);
  const a = autoResolve(vm('k2', 'A', { tags: ['www', 'DB'] }), idx, ctx);
  const b = autoResolve(vm('k2', 'A', { tags: ['DB', 'www'] }), idx, ctx);
  assert.equal(a.serviceId, b.serviceId, '태그 순서가 바뀌어도 같은 판정');
  assert.equal(a.serviceId, 'db'); assert.equal(a.tagAmbiguous, true, '두 서비스(DB · 별칭 www→Web)에 걸린다');
  const one = autoResolve(vm('k3', 'A', { tags: ['DB'] }), idx, ctx);
  assert.equal(one.multi, undefined, '하나면 표지 없음');
  const none = autoResolve(vm('k4', 'A', { name: 'n1', tags: ['b-tag', 'a-tag'] }), idx, ctx);
  assert.equal(none.reason, 'tag-unmapped'); assert.deepEqual(none.unmapped, { kind: 'tag', value: 'a-tag' }, '걸리는 값이 없으면 정렬 첫 값을 매핑 안 된 값으로');
  const inv = buildInventory({ members: [vm('k2', 'A', { tags: ['www', 'DB'] }), vm('k1', 'A', { tags: ['backup-daily', 'DB'] })], map });
  assert.deepEqual(inv.queues.tagAmbiguous.map((x) => [x.key, x.serviceId, x.tags.join(',')]), [['k2', 'db', 'DB,www']]);
  // 고정한 구성원은 사람이 이미 정했다 — 모호 큐에 올리지 않는다
  const inv2 = buildInventory({ members: [vm('k2', 'A', { tags: ['www', 'DB'] })], map, pins: { k2: { serviceId: 'web', corp: 'A', by: 'a', at: 1 } } });
  assert.equal(inv2.queues.tagAmbiguous.length, 0);
});

test('R10: 판정 보류에는 시작 시각이 붙고(다시 봐도 그대로) · 보류가 풀리면 전체 범위 계산에서 지운다 · 범위 계산은 남의 기록을 지우지 않는다', () => {
  _resetHeldSinceForTest();
  const a = heldWithSince([{ key: 'st:a', corp: 'A' }, { key: 'st:b', corp: 'B' }], true, 1000);
  assert.deepEqual(a.map((x) => x.heldSince), [1000, 1000]);
  const b = heldWithSince([{ key: 'st:a', corp: 'A' }], false, 5000);
  assert.equal(b[0].heldSince, 1000, '처음 본 시각을 유지');
  const c = heldWithSince([{ key: 'st:b', corp: 'B' }], true, 6000);
  assert.equal(c[0].heldSince, 1000, '범위 계정 계산(false)이 st:b 를 지우지 않았다');
  const d = heldWithSince([{ key: 'st:a', corp: 'A' }], true, 7000);
  assert.equal(d[0].heldSince, 7000, '전체 범위 계산에서 풀렸던 st:a 는 지워졌다가 다시 보류되면 새로 센다');
});

test('R11: 유령 정리는 미리 본 개수(expect)와 지금이 다르면 409 — 확인창 뒤에 끼어든 유령을 함께 지우지 않는다', async () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ 'vc-a': { services: [S('s1', 'ERP')] } })));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {
    'iu:vc-a:gone-1': { serviceId: 's1', corp: 'vc-a', by: 'a', at: 1 }, 'iu:vc-a:gone-2': { serviceId: 's1', corp: 'vc-a', by: 'a', at: 1 } } }));
  const prev = store.snapshot;
  try {
    // 살아 있는 VM 1대 — VM 이 0대인 법인의 VM 고정은 6차 1 부터 판정 보류(corp-no-vms)라 유령이 아니다
    store.snapshot = { ...prev, generatedAt: Date.now() + 51, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms: [{ id: 'vm-live', vcenterId: 'vc-a', name: 'live1', instanceUuid: 'u-live', powerState: 'POWERED_ON' }] };
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body)); assert.equal(dry.body.result.keys.length, 2);
    const stale = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', expect: 1 } });
    assert.equal(stale.statusCode, 409); assert.equal(Object.keys(sm.getPins().pins).length, 2, '지우지 않았다');
    const ok = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', expect: 2 } });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body)); assert.equal(ok.body.result.removed, 2);
  } finally { store.snapshot = prev; }
});

test('M11·R19: CSV 에 전역 서비스·등급·담당자·키 종류·드리프트 열 · 백업은 화면과 같은 말(영문 코드 아님)', async () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ 'vc-a': { services: [S('s1', 'ERP', { globalId: 'g1', tier: 1, owner: 'erp-team' }), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } },
    { globals: [{ id: 'g1', name: 'ERP-전사', tier: 1, owner: '', note: '' }] })));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: { 'vm:vm-2': { serviceId: 's2', corp: 'vc-a', by: 'a', at: 1 } } }));
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 61, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [],
      vms: [{ id: 'vm-1', vcenterId: 'vc-a', name: 'erp1', folderPath: '/ERP', instanceUuid: 'u-1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 },
        { id: 'vm-2', vcenterId: 'vc-a', name: 'erp2', folderPath: '/ERP', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 }] };
    const r = await call('GET /tools/svc-inventory.csv');
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const rows = String(r.body).replace(/^﻿/, '').split('\r\n').map((l) => l.split(','));
    const h = rows[0];
    for (const col of ['전역 서비스', '등급', '담당자', '키 종류', '드리프트']) assert.ok(h.includes(col), `열 ${col}`);
    const at = (row, col) => row[h.indexOf(col)];
    const r1 = rows.find((x) => x.includes('erp1')); const r2 = rows.find((x) => x.includes('erp2'));
    assert.equal(at(r1, '전역 서비스'), 'ERP-전사'); assert.equal(at(r1, '등급'), '1'); assert.equal(at(r1, '담당자'), 'erp-team'); assert.equal(at(r1, '키 종류'), 'instanceUuid');
    assert.equal(at(r2, '키 종류'), 'moref(임시)');
    assert.match(at(r2, '드리프트'), /고정과 다름\(자동: ERP\)/);
    for (const x of rows.slice(1)) assert.ok(!['ok', 'fail', 'none'].includes(at(x, '백업 24h')), '백업 칸에 영문 코드 없음');
  } finally { store.snapshot = prev; }
});

// ───────── 3차 반증 반영 ─────────
test('3차 반증 1: 이름 규칙 둘 이상(다른 서비스)이 걸리면 규칙 겹침으로 검토 큐 — 순서를 바꾼 업그레이드에서 옮겨 간 구성원이 드러난다(같은 서비스면 아님)', () => {
  const map = mapOf({ A: { services: [S('erp', 'ERP'), S('erpdb', 'ERP-DB'), S('db', 'DB')], nameRules: [
    { match: 'prefix', value: 'erp-', serviceId: 'erp' }, { match: 'prefix', value: 'erp-db-', serviceId: 'erpdb' },
    { match: 'contains', value: 'db', serviceId: 'db' }, { match: 'suffix', value: '-01', serviceId: 'erpdb' }] } });
  const idx = buildIndex(map);
  const r = autoResolve(vm('erp-db-01', 'A', { name: 'erp-db-01', folderPath: '/' }), idx);
  assert.equal(r.serviceId, 'erpdb'); assert.deepEqual(r.ruleOverlap, ['prefix:erp-', 'contains:db'], '같은 서비스(-01 → erpdb)는 겹침이 아니다');
  assert.equal(autoResolve(vm('erp-app-02', 'A', { name: 'erp-app-02', folderPath: '/' }), idx).ruleOverlap, undefined);
  const inv = buildInventory({ members: [vm('erp-db-01', 'A', { name: 'erp-db-01', folderPath: '/' }), vm('erp-app-02', 'A', { name: 'erp-app-02', folderPath: '/' })], map });
  assert.deepEqual(inv.queues.ruleOverlap.map((x) => [x.key, x.serviceId, x.via]), [['erp-db-01', 'erpdb', 'prefix:erp-db-']]);
});

test('3차 반증 4·7·10: 모호한 자동 판정을 확인한 고정은 불필요한 고정이 아니다 · 태그 표시값은 걸린 값 먼저 · 대소문자만 다른 태그는 한 값', () => {
  const map = mapOf({ A: { tagEnabled: true, services: [S('db', 'DB'), S('web', 'Web')] } }, { settings: { tagCategory: 'svc' } });
  const member = vm('k1', 'A', { tags: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'web', 'DB'] });
  const inv = buildInventory({ members: [member], map, pins: { k1: { serviceId: 'db', corp: 'A', by: 'x', at: 1 } } });
  assert.equal(inv.queues.redundant.length, 0, "'이대로 고정' 을 '불필요한 고정' 정리가 지우면 다시 모호로 돌아간다(순환)");
  const r = autoResolve(member, buildIndex(map), { tagCategory: 'svc' });
  assert.equal(r.tagAmbiguous, true); assert.deepEqual(r.tagValues.slice(0, 2), ['DB', 'web'], '모호의 원인(걸린 값)이 잘리지 않는다');
  const same = autoResolve(vm('k2', 'A', { tags: ['DB', 'db'] }), buildIndex(map), { tagCategory: 'svc' });
  assert.equal(same.multi, undefined, "'DB'·'db' 는 태그 하나");
  assert.equal(autoResolve(vm('k3', 'A', { tags: ['db', 'DB'] }), buildIndex(map), { tagCategory: 'svc' }).multi, undefined, '순서가 바뀌어도(변이 검증에서 놓친 경우)');
});

test('3차 반증 3: 유령 정리는 미리 본 키 ∩ 지금 유령만 지운다(개수만 같아 끼어든 키를 지우지 않는다) · expect 는 정수만', async () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ 'vc-a': { services: [S('s1', 'ERP')] } })));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: Object.fromEntries(['vm:vm-a', 'vm:vm-b', 'vm:vm-c'].map((k) => [k, { serviceId: 's1', corp: 'vc-a', by: 'a', at: 1 }])) }));
  const prev = store.snapshot;
  const vmOf = (id) => ({ id, vcenterId: 'vc-a', name: id, folderPath: '/', powerState: 'POWERED_ON', cpuCount: 1, memMB: 1024 });
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 71, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms: [vmOf('vm-c')] };
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.deepEqual(dry.body.result.keys.sort(), ['vm:vm-a', 'vm:vm-b']);
    // 미리 본 뒤 상태가 바뀜: vm-a 가 살아나고 vm-c 가 사라짐(유령 수는 그대로 2)
    store.snapshot = { ...store.snapshot, generatedAt: Date.now() + 72, vms: [vmOf('vm-a')] };
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', expect: '2' } })).statusCode, 400, "문자열 '2' 는 정수가 아니다");
    const r = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: dry.body.result.keys } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.result, { removed: 1, skipped: 1 });
    assert.deepEqual(Object.keys(sm.getPins().pins).sort(), ['vm:vm-a', 'vm:vm-c'], '확인창에 없던 vm-c 는 남는다 · 살아난 vm-a 도 남는다');
  } finally { store.snapshot = prev; }
});

test('3차 반증 2: 막힌 베어메탈 출처 문구(수집 서버 이름)는 전체 범위 관리자만 — 범위가 지정된 관리자에게는 출처 종류만', async () => {
  fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c-pl', name: 'collector-poland-dc2', url: 'https://192.0.2.9:8443', enabled: false }] }));
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ 'vc-a': { services: [S('s1', 'ERP')] } })));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 81, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }, { id: 'vc-b', name: 'vcenter-b' }], hosts: [], vms: [] };
    const full = await call('GET /tools/svc-inventory/queues');
    assert.equal(full.statusCode, 200, JSON.stringify(full.body)); assert.equal(full.body.bmBlocked, true);
    assert.ok(full.body.bmBlockedSources.some((u) => /collector-poland-dc2/.test(u.reason || '')), '전체 범위 관리자는 이유 문구');
    const scopedAdmin = { username: 'adm-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
    const sc = await call('GET /tools/svc-inventory/queues', { user: scopedAdmin });
    assert.equal(sc.statusCode, 200, JSON.stringify(sc.body));
    assert.ok(sc.body.bmBlockedSources.length && sc.body.bmBlockedSources.every((u) => !('reason' in u)), '범위 관리자는 출처 종류만');
    assert.ok(!JSON.stringify(sc.body).includes('collector-poland-dc2'));
  } finally { store.snapshot = prev; fs.rmSync(path.join(tmp, 'collectors.json'), { force: true }); }
});
