// 랙 실장도 1회차 점검(2026-11-26 · 살아남은 변이를 막는 테스트 — 테스트 이름의 번호가 그 변이) — routes/api/rack.js 의 테스트 공백(인벤토리가 있을 때의 가림 · 서버만 잇기 · 미배치 상한 · 엑셀 시트 나누기 ·
//   랙 종류 치수 경계 · 감사 기록 · 데모 관리자 · 입력 id 모양).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackprober-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';

const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const V = await import(`${S}/rack/versions.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const remoteInv = await import(`${S}/collector/remoteInventory.js`);
const audit = await import(`${S}/audit.js`);

const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = [], writeVcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters } });
const ADMIN = U('admin', 'admin');
const OP_A = U('op-a', 'operator', ['vc-a']);
const OP_ALL = U('op', 'operator');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a', 'vc-b', 'vc-big'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR 법인' }); dc.addDatacenter({ id: 'pl', name: 'PL' }); dc.addDatacenter({ id: 'big', name: 'BIG' });
dc.setVcenterDatacenter('vc-a', 'kr'); dc.setVcenterDatacenter('vc-b', 'pl'); dc.setVcenterDatacenter('vc-big', 'big');
const op = (user, body) => call('POST /tools/rack/op', { user, body });
const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;
const room = async (user, id) => (await call('GET /tools/rack/room/:id', { user, params: { id } })).body;
const srv = (id, name, host, serviceTag, vcenterId = 'vc-a') => ({ id, name, host, username: 'root', password: 'x', ...(serviceTag ? { serviceTag } : {}), vcenterId });

let kr;
test('준비', async () => {
  const s1 = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-1' })).body.id;
  const r1 = (await op(ADMIN, { op: 'room.add', siteId: s1, name: 'R1' })).body.id;
  const a1 = (await op(ADMIN, { op: 'rack.add', roomId: r1, rev: 0, rack: { name: 'A1', heightU: 42 } })).body.id;
  kr = { s1, r1, a1 };
  registry.importServers([
    srv('inv1', 'kr-inv-01', 'https://192.0.2.50', 'INV0001'),
    srv('inv2', 'kr-inv-02', 'https://192.0.2.51', 'INV0002'),
    srv('inv3', 'kr-inv-03', 'https://192.0.2.52', 'INV0003'),
    srv('srv-dns', 'bmc-kr-09.corp.example', 'https://bmc-kr-09.corp.example', 'DNS0001'),
    srv('bmc-kr-10.corp.example', 'KR 서버 10', 'https://192.0.2.70', 'DNS0002'),
    srv('short1', 'lab1-server', 'https://192.0.2.71', 'AB1'),
    srv('sto1', 'kr-sto-01', 'https://192.0.2.72', 'STO0001'),
    srv('notag', 'no-tag-server', 'https://192.0.2.73', ''),
  ], 'replace');
  invCache.setInventory('inv1', { system: { hostName: 'os-host-secret.corp', model: 'R750', serviceTag: 'INV0001', health: 'Warning', powerState: 'On' }, collectedAt: Date.now() });
  invCache.setInventory('inv2', { system: { hostName: 'os-host-two.corp', model: 'R750', serviceTag: 'INV0002', health: 'Weird' }, collectedAt: Date.now() });
  invCache.setInventory('inv3', { system: { model: 'R650', serviceTag: 'INV0003' }, collectedAt: Date.now() });
  // 엣지(원격) 서버 — 이름 없이 등록된 서버(이름 자리에 OS 호스트 이름이 떨어진다)
  remoteInv.setCollectorServers('edge-kr', 'kr', [{ id: 'rem-1', host: 'https://192.0.2.60', serviceTag: 'REM0001', datacenterId: 'kr', vcenterId: 'vc-a', inv: { system: { hostName: 'remote-os-host.corp', serviceTag: 'REM0001' } } },
    // 중앙 등록 서버(inv1)와 서비스 태그가 같은 원격 서버 — 연결은 먼저 온(중앙) 서버로
    { id: 'rem-dup', name: 'remote-dup', host: 'https://192.0.2.61', serviceTag: 'INV0001', datacenterId: 'kr', vcenterId: 'vc-a' }]);
});

const place = async (rackId, roomId, p) => { const r = await op(ADMIN, { op: 'place.add', rackId, rev: await rev(roomId), place: { face: 'full', uSize: 1, kind: 'server', label: '', ...p } }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body.id; };

test('탐침 K03 · K04 · K05 · K22 · K23: 인벤토리가 있는 서버 — 비관리자에게 OS 호스트 이름(연결 · 미배치 · hw.host) 없음 · 건강 상태 매핑', async () => {
  const p1 = await place(kr.a1, kr.r1, { uStart: 1, serial: 'INV0001' });
  const p3 = await place(kr.a1, kr.r1, { uStart: 2, serial: 'INV0003' });
  const pr = await place(kr.a1, kr.r1, { uStart: 3, serial: 'REM0001' });
  const adm = await room(ADMIN, kr.r1);
  const al = adm.places.find((x) => x.id === p1).link;
  assert.equal(al.hostname, 'os-host-secret.corp', '관리자 판본은 그대로'); assert.equal(al.hw.host, 'os-host-secret.corp');
  assert.equal(al.health, 'warn', 'K22 Warning → warn');
  assert.equal(al.serverId, 'inv1', 'K21 같은 서비스 태그가 둘이면 먼저 온(중앙 등록) 서버에 잇는다');
  assert.equal(adm.places.find((x) => x.id === p3).link.health, '', '건강 상태를 못 받았으면 빈 값');
  assert.equal(adm.unplaced.find((u) => u.serverId === 'inv2').hostname, 'os-host-two.corp');
  assert.equal(adm.places.find((x) => x.id === pr)?.link?.name, 'remote-os-host.corp', '이름 없는 원격 서버 — 관리자에게는 호스트 이름이 이름 자리에');
  for (const user of [OP_ALL, OP_A]) {
    const v = await room(user, kr.r1);
    const l = v.places.find((x) => x.id === p1).link;
    assert.equal(l.hostname, '', `K03 ${user.username}`); assert.equal(l.hw.host, '', `K05 ${user.username}`);
    assert.equal(l.name, 'kr-inv-01', '등록 이름은 그대로');
    assert.equal(v.places.find((x) => x.id === pr).link.name, '', `K04 ${user.username}: 호스트 이름으로 떨어진 이름도 비운다`);
    const j = JSON.stringify(v);
    assert.ok(!j.includes('os-host-secret') && !j.includes('os-host-two') && !j.includes('remote-os-host'), `${user.username}: OS 호스트 이름이 응답 어디에도 없다`);
  }
  // K23: 모르는 건강 값은 '못 읽음'(정상 · 빈 값으로 접지 않는다)
  const p2 = await place(kr.a1, kr.r1, { uStart: 4, serial: 'INV0002' });
  assert.equal((await room(ADMIN, kr.r1)).places.find((x) => x.id === p2).link.health, 'unknown', 'K23');
});

test('탐침 K01 · K02: 가림 판정기는 host 와 id 를 모두 본다(이름 = DNS 주소 · id = DNS 주소)', async () => {
  const pa = await place(kr.a1, kr.r1, { uStart: 6, serial: 'DNS0001' });
  const pb = await place(kr.a1, kr.r1, { uStart: 7, serial: 'DNS0002' });
  const v = await room(OP_ALL, kr.r1);
  assert.ok(v.places.find((x) => x.id === pa).link.name.includes('이름 가림'), 'K01 이름이 관리 주소(host)와 같으면 가린다');
  assert.ok(v.places.find((x) => x.id === pb).link.serverId.startsWith('masked-'), 'K02 id 가 주소면 토큰으로');
  assert.ok(!JSON.stringify(v.places).includes('bmc-kr-'), JSON.stringify(v.places.filter((x) => [pa, pb].includes(x.id)).map((x) => x.link)));
});

test('탐침 K07: 짧은 서비스 태그(임계 미만)는 이름에서 걷어 내지 않는다', async () => {
  const p = await place(kr.a1, kr.r1, { uStart: 8, serial: 'AB1' });
  assert.equal((await room(OP_A, kr.r1)).places.find((x) => x.id === p).link.name, 'lab1-server');
});

test('탐침 K12 · K18: 서버만 서비스 태그로 잇는다 · 시리얼 없는 서버는 no-serial', async () => {
  const st = await place(kr.a1, kr.r1, { uStart: 10, kind: 'storage', label: '스토리지', serial: 'STO0001' });
  const ns = await place(kr.a1, kr.r1, { uStart: 11, kind: 'server', label: '시리얼 모름' });
  const v = await room(ADMIN, kr.r1);
  const a = v.places.find((x) => x.id === st);
  assert.equal(a.link, null, 'K12 스토리지 장비는 iDRAC 서버에 잇지 않는다'); assert.equal(a.linkState, 'n/a');
  assert.equal(v.places.find((x) => x.id === ns).linkState, 'no-serial', 'K18');
});

test('탐침 K16 · K17 · K24: 태그 없는 서버는 미배치 목록이 아니라 serversNoTag 로 · 법인 이름', async () => {
  const v = await room(ADMIN, kr.r1);
  assert.equal(v.serversNoTag, 1, 'K16');
  assert.ok(!v.unplaced.some((u) => u.serverId === 'notag'), 'K17');
  assert.equal(v.corp.name, 'KR 법인', 'K24');
});

test('탐침 K13 · K14: 미배치 서버는 UNPLACED_MAX 대까지만 싣고 전체 수는 따로', async () => {
  const s = (await op(ADMIN, { op: 'site.add', corpId: 'big', name: 'BIG-1' })).body.id;
  const r = (await op(ADMIN, { op: 'room.add', siteId: s, name: 'BR' })).body.id;
  const many = Array.from({ length: RT.UNPLACED_MAX + 5 }, (_, i) => srv(`big-${i}`, `big-${i}`, `https://198.51.${100 + Math.floor(i / 250)}.${1 + (i % 250)}`, `BIG${String(i).padStart(5, '0')}`, 'vc-big'));
  const imp = registry.importServers(many, 'merge');
  assert.equal(imp.skipped?.length || 0, 0, JSON.stringify((imp.skipped || []).slice(0, 2)));
  const v = await room(ADMIN, r);
  assert.equal(v.unplaced.length, RT.UNPLACED_MAX, 'K13'); assert.equal(v.unplacedTotal, RT.UNPLACED_MAX + 5, 'K14');
});

test('탐침 E01 · E02 · E04~E12: 엑셀 — 랙 13대는 시트 2장 · 13번째 랙은 둘째 시트 첫 칸 · U 줄 · 병합 · 값 칸 · 후면 줄 · 부분 합 · 랙 없는 전산실', async () => {
  const sid = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'XL' })).body.id;
  const rid = (await op(ADMIN, { op: 'room.add', siteId: sid, name: 'XL13' })).body.id;
  let rv = 0; const racks = [];
  for (let i = 1; i <= RT.RACKS_PER_SHEET + 1; i += 1) { const r = await op(ADMIN, { op: 'rack.add', roomId: rid, rev: rv, rack: { name: `RK${String(i).padStart(2, '0')}`, heightU: 10 } }); rv = r.body.rev; racks.push(r.body.id); }
  assert.equal(RT.RACKS_PER_SHEET, 12, 'E01 시트당 랙 수(측정으로 정한 값 — 300랙 한 시트 21초 정지)');
  for (const [rackId, p] of [[racks[0], { face: 'full', uStart: 1, uSize: 3, kind: 'other', label: 'DEV-R1', weightKg: 11, opW: 22, ratedW: 33 }], [racks[0], { face: 'full', uStart: 5, uSize: 1, kind: 'other', label: 'NOVAL' }],
    [racks[0], { face: 'rear', uStart: 7, uSize: 1, kind: 'network', label: 'REAR-R1', ratedW: 300 }], [racks[12], { face: 'full', uStart: 2, uSize: 1, kind: 'other', label: 'DEV-R13' }]]) {
    const r = await op(ADMIN, { op: 'place.add', rackId, rev: rv, place: p }); assert.equal(r.statusCode, 200); rv = r.body.rev;
  }
  const res = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: rid } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.raw);
  assert.deepEqual(wb.worksheets.map((w) => w.name), RT.sheetNamesOf('XL13', 13), 'E02 · E10 시트 2장 · 이름');
  assert.equal(wb.worksheets.length, 2);
  const [w1, w2] = wb.worksheets;
  const textsOf = (ws) => { const t = []; ws.eachRow((row) => row.eachCell((c) => { if (!c.isMerged || c.master.address === c.address) t.push(String(c.value ?? '')); })); return t; };
  const t1 = textsOf(w1); const t2 = textsOf(w2);
  assert.ok(String(w1.getCell(3, 1).value).startsWith('RK01'), '첫 시트 첫 칸 = 1번째 랙');
  assert.ok(t1.some((t) => t.startsWith('RK12')) && !t1.some((t) => t.startsWith('RK13')), '첫 시트에는 12번째 랙까지');
  assert.ok(String(w2.getCell(3, 1).value).startsWith('RK13'), 'E09 둘째 시트 첫 칸 = 13번째 랙');
  assert.ok(t1.some((t) => t.startsWith('DEV-R1')) && !t1.some((t) => t.includes('DEV-R13')), 'E02 13번째 랙이 1번째 랙을 덮어쓰지 않는다');
  assert.ok(t2.some((t) => t.includes('DEV-R13')));
  // U 줄: 위가 큰 U(높이 10 → 5행 = U10 · 14행 = U1)
  assert.equal(w1.getCell(5, 1).value, 10, 'E12'); assert.equal(w1.getCell(14, 1).value, 1, 'E12');
  // DEV-R1 = U1–3 → 12~14행 병합 · 값 칸 순서(무게 · 운전 · 정격)
  assert.ok(String(w1.getCell(12, 2).value).startsWith('DEV-R1'), 'E12 장비 줄 위치');
  assert.equal(w1.getCell(14, 2).master.address, w1.getCell(12, 2).address, 'E11 여러 U 장비는 한 칸으로 병합');
  assert.deepEqual([3, 4, 5].map((c) => w1.getCell(12, c).value), [11, 22, 33], 'E08 무게 · 운전 전력 · 정격 전력 칸');
  assert.ok(t1.some((t) => t.includes('REAR-R1') && t.includes('정격 300 W')), 'E04 후면 줄의 정격 전력');
  assert.ok(t1.includes('11 kg (3대 중 1대)'), `E06 ${t1.filter((t) => t.includes('kg')).join('|')}`);
  assert.ok(t1.includes('333 W (3대 중 2대)'), `E07 ${t1.filter((t) => t.includes(' W')).join('|')}`);
  // 랙 없는 전산실 — 제목 시트 하나
  const empty = (await op(ADMIN, { op: 'room.add', siteId: sid, name: 'EMPTY-ROOM' })).body.id;
  const e = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: empty } });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(e.raw);
  assert.equal(wb2.worksheets.length, 1, 'E05'); assert.ok(String(wb2.worksheets[0].getCell(1, 1).value).includes('EMPTY-ROOM'), 'E05');
});

test('탐침 E03: 엑셀 그리기는 랙마다 이벤트 루프에 양보한다', async () => {
  const view = { corp: { name: 'c' }, site: { name: 's' }, room: { name: 'YIELD' }, places: [],
    racks: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, name: `R${i}`, heightU: 4, pduA: 0, pduB: 0, totals: { usePct: 0, usedU: 0, devices: 0 } })) };
  const real = globalThis.setImmediate; let yields = 0;
  // yieldTurn 은 new Promise((r) => setImmediate(r)) — 콜백이 약속의 resolve(네이티브 함수)다. ExcelJS 내부의 setImmediate(일반 함수)와 구분한다.
  globalThis.setImmediate = (fn, ...a) => { if (/\[native code\]/.test(Function.prototype.toString.call(fn))) yields += 1; return real(fn, ...a); };
  try { await RT.buildRoomXlsx(view); } finally { globalThis.setImmediate = real; }
  assert.ok(yields >= 8, `랙 9대 → 양보 8번 이상(실제 ${yields})`);
});

test('탐침 S02: 법인 목록에 없는 법인은 데이터센터가 여럿이어도 한 번만 나온다', async () => {
  await R.addSite({ corpId: 'gone2', name: 'G1', user: 'admin' }); await R.addSite({ corpId: 'gone2', name: 'G2', user: 'admin' });
  const t = await call('GET /tools/rack', { user: ADMIN });
  assert.equal(t.body.corps.filter((c) => c.id === 'gone2').length, 1);
});

test('탐침 T01 · T02 · T03 · T05: 랙 종류 — 치수 경계(100~3000mm) · 높이 · 이름 없으면 400', async () => {
  const add = async (b) => (await op(ADMIN, { op: 'type.add', ...b })).statusCode;
  assert.equal(await add({ name: 'T-a', heightU: 42, widthMm: 99 }), 400, 'T01 하한');
  assert.equal(await add({ name: 'T-b', heightU: 42, depthMm: 3001 }), 400, 'T02 상한');
  assert.equal(await add({ name: 'T-c', heightU: 42, widthMm: 100, depthMm: 3000 }), 200, '경계값은 받는다');
  assert.equal(await add({ name: 'T-d' }), 400, 'T03 높이 없음');
  assert.equal(await add({ heightU: 42 }), 400, 'T05 이름 없음');
  const t = (await call('GET /tools/rack', { user: ADMIN })).body.types.find((x) => x.name === 'T-c');
  assert.equal(t.widthMm, 100); assert.equal(t.depthMm, 3000);
});

test('탐침 A01~A08: 감사 기록 — 연산마다 남고 · 장비 놓기 상세는 서버가 만든 id · 되돌리기 상세에 새 판 번호 · 내보내기', async () => {
  const last = (action) => audit.auditEntriesWithAction(action).at(-1);
  const sid = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'AUD-SITE' })).body.id;
  assert.equal(last('rack.site.add')?.detail, 'AUD-SITE', 'A03');
  const rid = (await op(ADMIN, { op: 'room.add', siteId: sid, name: 'AUD-ROOM' })).body.id;
  assert.equal((await op(ADMIN, { op: 'room.rename', id: rid, name: 'AUD-ROOM2' })).statusCode, 200);
  assert.equal(last('rack.room.rename')?.detail, 'AUD-ROOM2', 'A04');
  const rk = await op(ADMIN, { op: 'rack.add', roomId: rid, rev: 0, rack: { name: 'AUD', heightU: 42 } });
  const p = await op(ADMIN, { op: 'place.add', rackId: rk.body.id, rev: rk.body.rev, id: 'SPOOFED-PLACE-ID', place: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'aud' } });
  assert.equal(p.statusCode, 200);
  assert.ok(last('rack.place.add')?.detail.includes(p.body.id), `A01 · A06 ${JSON.stringify(last('rack.place.add'))}`);
  assert.ok(!audit.auditEntriesWithAction('rack.place.add').some((h) => h.detail.includes('SPOOFED')), 'A01 요청의 검증 안 된 id 를 싣지 않는다');
  const u = await op(ADMIN, { op: 'place.update', id: p.body.id, rev: p.body.rev, place: { label: 'aud2' } });
  assert.equal(last('rack.place.update')?.detail, p.body.id, 'A06');
  const x = await call('GET /tools/rack/room/:id/xlsx', { user: ADMIN, params: { id: rid } });
  assert.equal(x.statusCode, 200); assert.ok(last('rack.export')?.detail.includes('AUD-ROOM2'), 'A05');
  const d = await op(ADMIN, { op: 'place.remove', id: p.body.id, rev: u.body.rev });
  assert.equal(last('rack.place.remove')?.detail, p.body.id, 'A06');
  const l = await R.listVersions('kr');
  const r = await op(ADMIN, { op: 'version.restore', corpId: 'kr', versionId: l[1].id, expectLatestId: l[0].id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(last('rack.version.restore')?.detail, `판 #${l[1].id} → 새 판 #${r.body.latestId}`, 'A02 · A08');
  void d;
  const t = await op(ADMIN, { op: 'type.add', name: 'AUD-TYPE', heightU: 42 });
  assert.equal(last('rack.type.add')?.detail, '42U', 'A07');
  assert.equal((await op(ADMIN, { op: 'type.remove', id: t.body.id })).statusCode, 200);
  assert.ok(last('rack.type.remove'), '랙 종류 삭제도 남는다');
});

test('탐침 R04 · R08: 데모 관리자(role admin + demoGuest)는 고칠 수 없고 isAdmin 도 아니다', async () => {
  const DEMO = { ...U('demo', 'admin'), demoGuest: true };
  const r = await op(DEMO, { op: 'site.add', corpId: 'kr', name: 'DEMO-SITE' });
  assert.equal(r.statusCode, 403, 'R04');
  assert.equal((await op(DEMO, { op: 'bogus' })).statusCode, 403, 'R04 연산을 보기 전에 거절한다(알 수 없는 연산 400 이 먼저 나오지 않는다)');
  assert.ok(!(await R.listTree(new Set(['kr']))).sites.some((s) => s.name === 'DEMO-SITE'));
  const t = await call('GET /tools/rack', { user: DEMO });
  assert.equal(t.body.isAdmin, false, 'R08'); assert.equal(t.body.canEditTypes, false);
});

test('탐침 R05 · R07 · R09 · R11 · R13: 판 보관 수 · 입력 id 모양 400 · 할당 vCenter 없는 법인은 범위 쓰기 불가', async () => {
  const v = await call('GET /tools/rack/versions', { user: ADMIN, query: { corp: 'kr' } });
  assert.equal(v.body.keep, V.VERSION_KEEP, 'R05'); assert.equal(v.body.keep, 30);
  assert.equal((await op(ADMIN, { op: 'version.restore', corpId: 'kr', versionId: 'abc', expectLatestId: v.body.latestId })).statusCode, 400, 'R07');
  const any = (await room(ADMIN, kr.r1)).places[0];
  assert.equal((await op(ADMIN, { op: 'place.update', id: any.id, rackId: 'not-an-id', rev: await rev(kr.r1), place: { uStart: 30 } })).statusCode, 400, 'R09');
  assert.equal((await op(ADMIN, { op: 'place.remove', id: 'bad', rev: 0 })).statusCode, 400, 'R11');
  const ADMIN_RW = U('admin-rw', 'admin', [], ['vc-a']);
  const acc = RT.corpAccessOf(ADMIN_RW, store.get(), new Map([['kr', ['vc-a']], ['empty', []]]));
  assert.deepEqual([...acc.write], ['kr'], 'R13 할당 vCenter 가 없는 법인은 쓰기 범위 계정에 열리지 않는다');
});

test.after(() => R._closeForTest());
