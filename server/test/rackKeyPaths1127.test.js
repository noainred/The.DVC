// 랙 실장도 — 조회 계정 응답의 **키 경로 스냅샷**(2026-11-27 6회차 반증 R3: 표식 시험의 키 대조는 맨 위 키만 봐서 link · hw 안에 칸을 더하거나
//   link.model · hw.cpu.model 의 가림을 빼는 변이가 살아남았다). 응답의 모든 중첩 키 경로가 아래 목록 안에 있어야 한다 — 칸을 더하려면 `rack/project.js` 에
//   등급을 적고 이 목록과 표식(`rackProject1127`)을 함께 고친다. 상수표(limits · kinds)는 뺀다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackkp-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`); const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`); const invCache = await import(`${S}/idrac/invCache.js`);
const RT = await import(`${S}/routes/api/rack.js`); const R = await import(`${S}/rack/db.js`);
const RI = await import(`${S}/collector/remoteInventory.js`); const L = await import(`${S}/rack/layout.js`);
after(() => R._closeForTest());
const routes = new Map(); RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) { const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end() { return this; } }; const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0] }; for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; } return res; }
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = async (body) => (await call('POST /tools/rack/op', { user: ADMIN, body })).body;
const paths = (o, pre = '', out = new Set()) => { if (Array.isArray(o)) { out.add(`${pre}[]`); for (const x of o) paths(x, `${pre}[]`, out); } else if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) { const p = pre ? `${pre}.${k}` : k; out.add(p); paths(v, p, out); } } return out; };

const ALLOWED = new Set(["detail.changes","detail.changes.counts","detail.changes.counts.placeAdd","detail.changes.counts.placeChange","detail.changes.counts.placeMove","detail.changes.counts.placeRemove","detail.changes.counts.rackAdd","detail.changes.counts.rackChange","detail.changes.counts.rackRemove","detail.changes.counts.roomAdd","detail.changes.counts.roomChange","detail.changes.counts.roomRemove","detail.changes.counts.siteAdd","detail.changes.counts.siteChange","detail.changes.counts.siteRemove","detail.changes.items","detail.changes.items[]","detail.changes.items[].fields","detail.changes.items[].fields[]","detail.changes.items[].id","detail.changes.items[].name","detail.changes.items[].op","detail.changes.items[].type","detail.changes.items[].where","detail.changes.omitted","detail.counts","detail.counts.places","detail.counts.racks","detail.counts.rooms","detail.counts.sites","detail.ok","detail.prevUnreadable","detail.readable","detail.restore","detail.version","detail.version.action","detail.version.detail","detail.version.id","detail.version.ts","detail.version.user","room.canEdit","room.corp","room.corp.id","room.corp.name","room.limits","room.logs","room.logs[]","room.logs[].action","room.logs[].detail","room.logs[].ts","room.logs[].user","room.ok","room.places","room.places[]","room.places[].extraSerials","room.places[].extraSerials[]","room.places[].face","room.places[].id","room.places[].kind","room.places[].label","room.places[].link","room.places[].link.collectedAt","room.places[].link.health","room.places[].link.hw","room.places[].link.hw.cpu","room.places[].link.hw.cpu.model","room.places[].link.hw.cpu.sockets","room.places[].link.hw.fw","room.places[].link.hw.mem","room.places[].link.hw.mem.gib","room.places[].link.model","room.places[].link.parts","room.places[].link.parts.disk","room.places[].link.parts.disk.absent","room.places[].link.parts.disk.fault","room.places[].link.parts.disk.ok","room.places[].link.parts.disk.state","room.places[].link.parts.disk.unknown","room.places[].link.parts.disk.warn","room.places[].link.parts.fan","room.places[].link.parts.fan.absent","room.places[].link.parts.fan.fault","room.places[].link.parts.fan.ok","room.places[].link.parts.fan.state","room.places[].link.parts.fan.unknown","room.places[].link.parts.fan.warn","room.places[].link.parts.mem","room.places[].link.parts.mem.absent","room.places[].link.parts.mem.fault","room.places[].link.parts.mem.ok","room.places[].link.parts.mem.state","room.places[].link.parts.mem.unknown","room.places[].link.parts.mem.warn","room.places[].link.parts.psu","room.places[].link.parts.psu.absent","room.places[].link.parts.psu.fault","room.places[].link.parts.psu.ok","room.places[].link.parts.psu.state","room.places[].link.parts.psu.unknown","room.places[].link.parts.psu.warn","room.places[].link.powerState","room.places[].link.remote","room.places[].link.serverId","room.places[].linkState","room.places[].model","room.places[].opW","room.places[].rackId","room.places[].ratedW","room.places[].serial","room.places[].serialHidden","room.places[].uSize","room.places[].uStart","room.places[].updatedAt","room.places[].weightKg","room.racks","room.racks[]","room.racks[].heightU","room.racks[].id","room.racks[].name","room.racks[].pduA","room.racks[].pduB","room.racks[].role","room.racks[].roomId","room.racks[].row","room.racks[].sort","room.racks[].totals","room.racks[].totals.devices","room.racks[].totals.freeU","room.racks[].totals.heightU","room.racks[].totals.opRead","room.racks[].totals.opW","room.racks[].totals.ratedRead","room.racks[].totals.ratedW","room.racks[].totals.usePct","room.racks[].totals.usedU","room.racks[].totals.weightKg","room.racks[].totals.weightRead","room.racks[].typeId","room.rev","room.room","room.room.id","room.room.name","room.room.rev","room.room.siteId","room.room.sort","room.room.updatedAt","room.serialsHidden","room.serversNoTag","room.site","room.site.corpId","room.site.id","room.site.name","room.site.sort","room.unplaced","room.unplacedListed","room.unplacedTotal","room.unplaced[]","tree.canEditTypes","tree.corps","tree.corps[]","tree.corps[].id","tree.corps[].name","tree.corps[].writable","tree.isAdmin","tree.kinds","tree.limits","tree.ok","tree.rooms","tree.rooms[]","tree.rooms[].id","tree.rooms[].name","tree.rooms[].places","tree.rooms[].racks","tree.rooms[].rev","tree.rooms[].siteId","tree.rooms[].sort","tree.rooms[].updatedAt","tree.sites","tree.sites[]","tree.sites[].corpId","tree.sites[].id","tree.sites[].name","tree.sites[].sort","tree.types","tree.types[]","tree.types[].depthMm","tree.types[].heightU","tree.types[].id","tree.types[].name","tree.types[].widthMm","versions.canRestore","versions.corpId","versions.keep","versions.latestId","versions.ok","versions.versions","versions.versions[]","versions.versions[].action","versions.versions[].counts","versions.versions[].counts.places","versions.versions[].counts.racks","versions.versions[].counts.rooms","versions.versions[].counts.sites","versions.versions[].detail","versions.versions[].id","versions.versions[].ts","versions.versions[].user"]);
// 7회차 반증 R7-2: 자극이 중앙 등록 서버 하나뿐이라 원격 서버에만 붙는 칸(엣지 관리 주소)을 더한 변이가 랙 시험 247개를 모두 통과했다.
//   이제 자극에 엣지 서버 · 인벤토리 없는 서버 · 시리얼 없는 장비 · 못 찾은 서버 · 추가 시리얼을 넣고, 응답 경로와 목록이 **정확히 같은지**(양쪽) 본다 —
//   목록에만 있는 경로 = 자극이 헛도는 칸, 응답에만 있는 경로 = 새 칸.
test('조회 계정 2종의 모든 랙 GET 응답 — 중첩 키 경로가 목록과 같다(엣지 서버 포함) · CPU 모델 · 연결 모델도 가림을 거친다', async () => {
  registry.importServers([{ id: 's1', name: 's1', host: 'https://bmc1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0001', vcenterId: 'vc-a' },
    { id: 's2', name: 's2', host: 'https://bmc2.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0002', vcenterId: 'vc-a' }]);   // s2 — 인벤토리 없음
  RI.setCollectorServers('edgeKP', 'kr', [{ id: 'edgesrvid-k1', name: 'edgesrvname-k1', host: 'https://idrac-k1.edge.example', serviceTag: 'RMTK0001', vcenterId: 'vc-a',
    inv: { system: { serviceTag: 'RMTK0001', model: 'R650', hostName: 'edgehost-k1', health: 'OK', powerState: 'On' }, psus: [{ health: 'OK', present: true }], collectedAt: Date.now() } }]);
  after(() => RI.clearCollectorServers('edgeKP'));
  invCache.setInventory('s1', { system: { serviceTag: 'SVA0001', model: 'R760 bmc1.mgmt.example', hostName: 'h1', health: 'OK', powerState: 'On' },
    cpus: [{ model: 'Xeon 10.1.1.1', present: true }], memoryDimms: [{ sizeGB: 32, present: true }], psus: [{ health: 'OK', present: true }], disks: [{ capacityGB: 100, present: true }], fans: [{ health: 'Warning', present: true }],
    idrac: { firmwareVersion: '7.00.00.171' }, collectedAt: Date.now() });
  const t = await op({ op: 'type.add', name: 'T', heightU: 42 });
  const s = await op({ op: 'site.add', corpId: 'kr', name: 'S' }); const r = await op({ op: 'room.add', siteId: s.id, name: 'R' });
  const k = await op({ op: 'rack.add', roomId: r.id, rev: 0, rack: { name: 'A', heightU: 42, typeId: t.id } });
  const p = await op({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'server', label: 'x', serial: 'SVA0001', note: 'n' } });
  const u = await op({ op: 'place.update', id: p.id, rev: p.rev, place: { note: 'n2', uStart: 3 } });
  const pe = await op({ op: 'place.add', rackId: k.id, rev: u.rev, place: { face: 'full', uStart: 5, uSize: 1, kind: 'server', label: 'edge', serial: 'RMTK0001', extraSerials: ['XS-0001'] } });
  const pn = await op({ op: 'place.add', rackId: k.id, rev: pe.rev, place: { face: 'full', uStart: 7, uSize: 1, kind: 'server', label: 'noinv', serial: 'SVA0002' } });
  const pm = await op({ op: 'place.add', rackId: k.id, rev: pn.rev, place: { face: 'full', uStart: 9, uSize: 1, kind: 'server', label: 'nosrv', serial: 'NOSUCH01' } });
  await op({ op: 'place.add', rackId: k.id, rev: pm.rev, place: { face: 'rear', uStart: 11, uSize: 1, kind: 'other', label: 'plain' } });
  const seenAll = [];
  for (const user of [OP_ALL, OP_A]) {
    const all = new Set();
    for (const x of paths((await call('GET /tools/rack', { user })).body, 'tree')) all.add(x);
    const room = (await call('GET /tools/rack/room/:id', { user, params: { id: r.id } })).body;
    for (const x of paths(room, 'room')) all.add(x);
    const vs = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
    for (const x of paths(vs, 'versions')) all.add(x);
    for (const v of vs.versions) for (const x of paths((await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body, 'detail')) all.add(x);
    const seen = [...all].filter((x) => !/^(tree|room)\.limits\./.test(x) && !/^tree\.kinds\./.test(x));
    const extra = seen.filter((x) => !ALLOWED.has(x));
    assert.deepEqual(extra, [], `${user.username}: 목록에 없는 칸`);
    seenAll.push(...seen);
    // 상수표는 상수와 깊은 비교로(빼놓은 경로에 칸을 숨기지 못하게 — R7-2 ④)
    const tree = (await call('GET /tools/rack', { user })).body;
    assert.deepEqual(tree.limits, L.LIMITS); assert.deepEqual(tree.kinds, L.KIND_LABEL); assert.deepEqual(room.limits, L.LIMITS);
    // 엣지 서버의 이름 · id · 관리 주소 · OS 호스트 이름은 조회 계정 응답 어디에도 없다(R7-2 ③)
    const flat = JSON.stringify({ tree, room });
    for (const mark of ['edgesrvid-k1', 'edgesrvname-k1', 'idrac-k1.edge.example', 'edgehost-k1', 'bmc2.mgmt.example']) assert.ok(!flat.includes(mark), `${user.username}: ${mark}`);
    assert.equal(room.places.find((x) => x.id === pe.id).linkState, 'linked', '전제: 엣지 서버에 이어졌다');
    assert.equal(room.places.find((x) => x.id === pe.id).link.remote, true);
    for (const must of ['room.places[].link.hw.cpu.model', 'room.places[].link.model', 'room.places[].link.parts.fan.state', 'detail.changes.items[].where']) assert.ok(all.has(must), `${user.username}: 자극이 ${must} 를 만들지 못했다(시험이 헛돈다)`);
    const link = room.places.find((x) => x.id === p.id).link;
    assert.ok(!link.hw.cpu.model.includes('10.1.1.1'), `${user.username} CPU 모델: ${link.hw.cpu.model}`);
    assert.ok(!link.model.includes('bmc1.mgmt.example'), `${user.username} 연결 모델: ${link.model}`);
    assert.equal(link.hw.fw, '7.00.00.171');
  }
  const missing = [...ALLOWED].filter((x) => !seenAll.includes(x));
  assert.deepEqual(missing, [], '목록에만 있는 경로 — 자극이 그 칸을 만들지 못한다(시험이 헛돈다) · 없어진 칸이면 목록에서 지운다');
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: r.id } })).body.places.find((x) => x.id === p.id).link;
  assert.equal(a.hw.cpu.model, 'Xeon 10.1.1.1'); assert.equal(a.model, 'R760 bmc1.mgmt.example');
});
