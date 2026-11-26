// 랙 실장도 1회차 점검(2026-11-26) — 1회차에 고친 코드(바뀐 것 없는 저장 · 표시 이름/이력/판 글 가림 · 색인 재시도 · 이름 정리 · 엑셀 후면 줄 · textMask)의 회귀:
//   바뀐 것 없는 저장 · 시리얼 키 색인 재시도/훑기 · 표시 이름 · 이력 · 판 글자의 주소 · 태그 가림 · textMask · 이름 정리 문자 집합 · 엑셀 후면 줄.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackprobehd-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp;
process.env.RACK_DB = path.join(tmp, 'rack.db');
process.env.RACK_SELF_CHECK = '1';

const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
const TM = await import(`${S}/rack/textMask.js`);
const registry = await import(`${S}/idrac/registry.js`);
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
const ADMIN = U('admin', 'admin'); const OP_A = U('op-a', 'operator', ['vc-a']); const OP_ALL = U('op', 'operator');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a', 'vc-b'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (user, body) => call('POST /tools/rack/op', { user, body });
const rev = async (roomId) => (await R.getRoom(roomId)).room.rev;
const room = async (user, id) => (await call('GET /tools/rack/room/:id', { user, params: { id } })).body;
const srv = (id, name, host, serviceTag) => ({ id, name, host, username: 'root', password: 'x', serviceTag, vcenterId: 'vc-a' });

let kr;
test('준비', async () => {
  const s1 = (await op(ADMIN, { op: 'site.add', corpId: 'kr', name: 'KR-1' })).body.id;
  const r1 = (await op(ADMIN, { op: 'room.add', siteId: s1, name: 'R1' })).body.id;
  const a1 = (await op(ADMIN, { op: 'rack.add', roomId: r1, rev: 0, rack: { name: 'A1', heightU: 42, pduA: 1, pduB: 1 } })).body.id;
  kr = { s1, r1, a1 };
  registry.importServers([
    srv('s-a', 'bmc-other.corp.example', 'https://192.0.2.80', 'NAMEA01'),          // 이름이 **다른 서버(s-b)** 의 관리 주소와 같다
    srv('s-b', 'kr-esx-b', 'https://bmc-other.corp.example', 'NAMEB01'),
  ], 'replace');
});
const place = async (p) => { const r = await op(ADMIN, { op: 'place.add', rackId: kr.a1, rev: await rev(kr.r1), place: { face: 'full', uSize: 1, kind: 'other', ...p } }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body.id; };
const vcount = async () => (await R.listVersions('kr')).length;

test('탐침 H01~H03 · H05~H07 · H15 · H27: 바뀐 것 없는 저장은 rev · 판 · 이력 · 감사를 만들지 않고, 한 칸만 바꾼 저장은 버리지 않는다', async () => {
  const db = await R.openRackDb();
  const pid = await place({ uStart: 1, label: 'noop', model: 'M', note: 'n', opW: 100, ratedW: 200, weightKg: 10, serial: 'NOOP-1', extraSerials: ['NOOP-X'] });
  const logs = () => db.prepare('SELECT COUNT(*) AS n FROM rack_log').get().n;
  const before = { rev: await rev(kr.r1), v: await vcount(), l: logs() };
  const same = await R.updatePlace({ roomId: kr.r1, rev: before.rev, user: 'a', id: pid, input: { label: 'noop', uStart: 1, opW: 100, extraSerials: ['NOOP-X'] } });
  assert.equal(same.unchanged, true, 'H03'); assert.equal(same.rev, before.rev, 'H01 rev 그대로');
  const sameRack = await R.updateRack({ roomId: kr.r1, rev: before.rev, user: 'a', id: kr.a1, input: { name: 'A1', pduA: 1 } });
  assert.equal(sameRack.unchanged, true, 'H02');
  assert.equal((await R.renameSite({ id: kr.s1, name: 'KR-1', user: 'a' })).unchanged, true, 'H05');
  assert.equal((await R.renameRoom({ id: kr.r1, name: 'R1', user: 'a' })).unchanged, true, 'H06');
  assert.deepEqual({ rev: await rev(kr.r1), v: await vcount(), l: logs() }, before, '판 · 이력 · rev 가 늘지 않는다');
  const nAud = audit.auditEntriesWithAction('rack.site.rename').length;
  assert.equal((await op(ADMIN, { op: 'site.rename', id: kr.s1, name: 'KR-1' })).statusCode, 200);
  assert.equal(audit.auditEntriesWithAction('rack.site.rename').length, nAud, 'H27 바뀐 것 없는 저장은 감사에도 없다');
  // 한 칸만 바꾼 저장은 '바뀐 것 없음' 이 아니다(비교에서 빠진 칸이 있으면 조용히 버려진다)
  let rv = before.rev;
  for (const [k, v] of [['opW', 101], ['ratedW', 201], ['weightKg', 11], ['note', 'n2'], ['model', 'M2'], ['kind', 'network'], ['face', 'front'], ['uSize', 2], ['extraSerials', ['NOOP-Y']]]) {
    const r = await R.updatePlace({ roomId: kr.r1, rev: rv, user: 'a', id: pid, input: { [k]: v } });
    assert.ok(!r.unchanged && r.rev === rv + 1, `H07 장비 ${k}`); rv = r.rev;
    assert.deepEqual((await R.getRoom(kr.r1)).places.find((x) => x.id === pid)[k], v, `장비 ${k} 저장`);
  }
  for (const [k, v] of [['pduA', 2], ['pduB', 3], ['role', 'net'], ['row', 'B'], ['heightU', 45]]) {
    const r = await R.updateRack({ roomId: kr.r1, rev: rv, user: 'a', id: kr.a1, input: { [k]: v } });
    assert.ok(!r.unchanged && r.rev === rv + 1, `H15 랙 ${k}`); rv = r.rev;
    assert.equal((await R.getRoom(kr.r1)).racks[0][k], v, `랙 ${k} 저장`);
  }
});

test('탐침 H18~H26 · H29 · H30 · H13 · H16 · H12: 비관리자 판본 — 표시 이름 · 이력 · 판 글자에 주소 · 시리얼이 없다', async () => {
  const tagged = await place({ uStart: 5, kind: 'server', label: 'idrac-LEDGER77', serial: 'LEDGER77' });   // 등록부에 없는 시리얼(원장에만) — 이름에 시리얼
  const ipLabel = await place({ uStart: 6, label: '10.9.8.7' });                                              // 이름이 IP
  const hostText = await place({ uStart: 7, label: 'mgmt bmc-other.corp.example 옆' });                        // 이름 속 등록부 관리 주소
  const linkA = await place({ uStart: 8, kind: 'server', label: 'A', serial: 'NAMEA01' });
  const old = await place({ uStart: 9, label: 'old-OLDSER99', serial: 'OLDSER99' });
  const vOld = (await R.listVersions('kr'))[0];   // 'old-OLDSER99' 를 놓은 판
  await op(ADMIN, { op: 'place.update', id: old, rev: await rev(kr.r1), place: { serial: 'NEWSER11' } });   // 시리얼이 바뀌어 지금 원장에는 OLDSER99 가 없다(이름에는 남았다)
  for (const user of [OP_A, OP_ALL]) {
    const v = await room(user, kr.r1);
    const j = JSON.stringify({ places: v.places, logs: v.logs });
    assert.ok(!j.includes('10.9.8.7'), `${user.username} H18 · H19 · H25: 이름 · 이력의 IP`);
    assert.ok(!j.includes('bmc-other.corp.example'), `${user.username} H26 · H30: 등록부 관리 주소(이름 속 · 다른 서버의 주소와 같은 이름)`);
    assert.ok(v.places.find((x) => x.id === linkA).link.name.includes('이름 가림'), `${user.username} H30`);
    const l = await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } });
    assert.ok(!JSON.stringify(l.body).includes('10.9.8.7') && !JSON.stringify(l.body).includes('bmc-other.corp'), `${user.username} H20`);
    for (const ver of l.body.versions.slice(0, 8)) {
      const d = await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(ver.id) }, query: { corp: 'kr' } });
      assert.ok(!JSON.stringify(d.body).includes('10.9.8.7') && !JSON.stringify(d.body).includes('bmc-other.corp'), `${user.username} H21 · H22 판 #${ver.id}`);
    }
    void ipLabel; void hostText;
  }
  // 시리얼을 가리는 판본(범위 비관리자)만: 원장 시리얼이 든 이름 · 이력 · 판 글자
  const v = await room(OP_A, kr.r1);
  assert.ok(!JSON.stringify({ places: v.places, logs: v.logs }).toLowerCase().includes('ledger77'), 'H18 · H19 · H24 · H29');
  assert.equal(v.places.find((x) => x.id === tagged).label, 'idrac-•••');
  const l = await call('GET /tools/rack/versions', { user: OP_A, query: { corp: 'kr' } });
  assert.ok(!JSON.stringify(l.body).toLowerCase().includes('ledger77'), 'H20 · H24');
  await call('GET /tools/rack/versions/:vid', { user: ADMIN, params: { vid: String(vOld.id) }, query: { corp: 'kr' } });   // 관리자가 먼저 본다(캐시)
  const d = await call('GET /tools/rack/versions/:vid', { user: OP_A, params: { vid: String(vOld.id) }, query: { corp: 'kr' } });
  assert.equal(d.statusCode, 200);
  // ⚠ version.detail 은 여기서 보지 않는다 — HEAD 에서 그 글에는 옛 시리얼이 남는다(별도 재현: rackProbeR1headLeak.test.js).
  assert.ok(!JSON.stringify([d.body.changes, d.body.restore]).toLowerCase().includes('oldser99'), `H12 · H13 · H16 · H23: 지금 원장에 없는 옛 시리얼도 차이 이름에서 걷어 낸다 ${JSON.stringify(d.body.changes?.items)}`);
  const all = await room(OP_ALL, kr.r1);
  assert.equal(all.places.find((x) => x.id === tagged).label, 'idrac-LEDGER77', '시리얼을 보는 판본은 이름 그대로');
  const adm = await call('GET /tools/rack/versions/:vid', { user: ADMIN, params: { vid: String(vOld.id) }, query: { corp: 'kr' } });
  assert.ok(adm.body.changes.items.some((i) => i.name === 'old-OLDSER99'), `H12 관리자 판본의 차이 이름은 원문(가린 판본이 캐시로 섞이지 않는다) ${JSON.stringify(adm.body.changes.items)}`);
});

test('탐침 H08~H11: 색인을 열 때 못 채웠으면 원장 훑기로 판정하고, 다음에 다시 채운다', async () => {
  let db = await R.openRackDb();
  await place({ uStart: 20, label: 'k1', serial: 'KEY-0001' });
  db.exec('DELETE FROM rack_place_key'); db.exec("DELETE FROM rack_meta WHERE k = 'placeKeys'");
  db.exec("CREATE TRIGGER rk_fail BEFORE INSERT ON rack_place_key BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const warn = console.warn; console.warn = () => {};
  try {
    db = await R.openRackDb();   // 채우기 실패(색인은 비어 있다)
    assert.ok((await R.placedSerialKeys('kr')).has('key0001'), 'H10 · H11 놓인 키 집합은 원장에서');
    await assert.rejects(R.addPlace({ roomId: kr.r1, rev: await rev(kr.r1), user: 'a', rackId: kr.a1, input: { face: 'full', uStart: 21, uSize: 1, kind: 'other', label: 'dup', serial: 'key-0001', extraSerials: [] } }),
      (e) => e.extra?.code === 'serialDup', 'H09 · H11 중복 판정은 원장 훑기로');
    const ok = await R.addPlace({ roomId: kr.r1, rev: await rev(kr.r1), user: 'a', rackId: kr.a1, input: { face: 'full', uStart: 21, uSize: 1, kind: 'other', label: 'k2', serial: 'KEY-0002', extraSerials: [] } });
    assert.ok(ok.id, 'H08 색인이 준비되지 않았으면 조각을 넣으려 하지 않는다(쓰기는 된다)');
  } finally { db.exec('DROP TRIGGER rk_fail'); console.warn = warn; }
  // 실패한 뒤 재시도 대기(30초) 동안은 원인이 사라져도 훑기로만 답한다 — 색인은 아직 비어 있고 판정은 맞다
  assert.ok((await R.placedSerialKeys('kr')).has('key0002'), '대기 중에도 놓인 키 집합은 원장에서');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_place_key WHERE key LIKE 'key000%'").get().n, 0, '대기 중에는 다시 채우지 않는다(요청마다 잠금 대기 · 경고를 되풀이하지 않게)');
  R._keysRetryNowForTest();   // 대기 시간이 지났다고 본다
  assert.ok((await R.placedSerialKeys('kr')).has('key0002'));
  assert.deepEqual(db.prepare("SELECT key FROM rack_place_key WHERE key LIKE 'key000%' ORDER BY key").all().map((r) => r.key), ['key0001', 'key0002'], '다음 조회에서 색인을 통째로 다시 채웠다');
});

test('탐침 H17 · H28 · H31~H34: 이름 정리 문자 집합 · 엑셀 후면 줄의 추가 시리얼 · textMask 순수 판정', async () => {
  assert.equal(L.cleanText('ab‮cd​ef\u0085', 20), 'ab cd ef', 'H17');
  const view = { corp: { name: 'c' }, site: { name: 's' }, room: { name: 'X' },
    racks: [{ id: 'r', name: 'R', heightU: 4, pduA: 0, pduB: 0, totals: { usePct: 0, usedU: 0, devices: 1 } }],
    places: [{ rackId: 'r', face: 'rear', uStart: 1, uSize: 1, label: 'REAR', model: 'M', serial: 'S1', extraSerials: ['EX-REAR-9'] }] };
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await RT.buildRoomXlsx(view));
  const texts = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => texts.push(String(c.value ?? ''))));
  assert.ok(texts.some((t) => t.includes('REAR') && t.includes('EX-REAR-9')), 'H28');
  const idx = TM.tagIndexOf(['ABC1234', 'ab', 'abcd', 'abcdef']);
  assert.equal(TM.stripTags('idrac-ABC1234-x', idx), 'idrac-•••-x', 'H32 · H34');
  assert.equal(TM.stripTags('lab-ab', idx), 'lab-ab', 'H31 임계 미만 태그는 가리지 않는다');
  assert.equal(TM.stripTags('x-abcdef', idx), 'x-•••', 'H33 긴 태그 먼저');
});

test.after(() => R._closeForTest());
