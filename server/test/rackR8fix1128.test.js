// 랙 실장도 — 2026-11-28 8회차(7회차 수정분 반증) 확정 결함 수정의 회귀.
//   N8-1 담지 못한 상태에서 같은 값을 다시 흡수해도 세대가 오르지 않고, 503 은 색인을 만들기 전에 · N8-2 태그 길이는 비교 키로 ·
//   N8-3 인벤토리 태그를 빼고 모은 흡수는 그 종류의 값을 버리지 않는다 · N8-4 담지 못한 수는 종류별 — 시리얼을 보는 판본은 태그 때문에 막지 않는다 ·
//   N8-5 범위 계정 목록의 법인 시리얼은 양보하며 읽는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr8fix-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const M = await import(`${S}/rack/material.js`);
const T = await import(`${S}/rack/textMask.js`);
after(() => R._closeForTest());
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const quiet = () => { const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); }; return { warns, restore: () => { console.warn = ow; } }; };
function restart() { R._dropMaskMemoryForTest(); R._closeForTest(); M._dropIndexForTest(); M._resetAbsorbForTest(); }
const W = {};
const roomOf = (user) => call('GET /tools/rack/room/:id', { user, params: { id: W.room } });

test('준비', async () => {
  const s = await okOp({ op: 'site.add', corpId: 'kr', name: 'S' });
  W.room = (await okOp({ op: 'room.add', siteId: s.id, name: 'R' })).id;
  const k = await okOp({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'A1', heightU: 42 } });
  W.rack = k.id; W.rev = k.rev;
});

test('N8-2: 원문은 64자를 넘어도 비교 키(구분자를 뺀 것)가 64자 안인 태그는 재료다 · 키가 64자를 넘는 태그만 뺀다', async () => {
  const tag = `${'XY12-'.repeat(12)}XY12Z`;              // 원문 65자 · 키 53자
  assert.equal(tag.length, 65); assert.equal(T.tagKeyLength(tag), 53);
  const longKey = 'Q'.repeat(65);
  RI.setCollectorServers('edgeT', 'kr', [{ id: 'et1', name: 'et1', host: 'https://idrac-et1.edge.example', serviceTag: tag, vcenterId: 'vc-a' }]);
  try {
    const p = await okOp({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: `spare ${tag} unit` } });
    W.rev = p.rev;
    const label = (await roomOf(OP_A)).body.places.find((x) => x.id === p.id).label;
    assert.equal(label, 'spare ••• unit', '키가 64자 안인 긴 태그도 가린다(7회차 수정은 원문 길이로 잘라 원문으로 나갔다)');
    assert.ok((await R.maskState()).overTags.has(tag), '파일에는 64자까지 — 메모리 몫에');
    const before = (await R.maskSeenCounts()).overflow;
    await R.maskAbsorb([], [longKey]);
    assert.equal((await R.maskSeenCounts()).overflow, before, '키가 64자를 넘는 태그는 담지 않는다');
  } finally { RI.clearCollectorServers('edgeT'); }
});

test('N8-1 · N8-3 · N8-4: 담지 못한 상태 — 세대가 오르지 않는다 · 종류별로 센다 · 인벤토리를 빼고 모은 흡수는 버리지 않는다', async () => {
  // 태그 기록을 상한(20만)까지 채운다
  const db = await R.openRackDb();
  const have = (await R.maskSeenCounts()).tags;
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES ('t', ?, 1)");
  for (let i = have; i < 200_000; i += 1) ins.run(`FILLT${String(i).padStart(6, '0')}`);
  db.exec('COMMIT');
  restart();
  // 엣지 셋이 서로 다른 태그 5만 5천 개(주소 없음 — 태그만 모자라게)
  const mk = (n, c) => Array.from({ length: n }, (_, i) => ({ id: `${c}${i}`, name: `${c}${i}`, serviceTag: `${c.toUpperCase()}T${String(i).padStart(6, '0')}`, vcenterId: 'vc-a' }));
  RI.setCollectorServers('tg1', 'kr', mk(20_000, 'tga')); RI.setCollectorServers('tg2', 'kr', mk(20_000, 'tgb')); RI.setCollectorServers('tg3', 'kr', mk(15_000, 'tgc'));
  const q = quiet();
  try {
    let r = await roomOf(OP_A);
    assert.equal(r.statusCode, 503, '태그를 가리는 판본은 태그가 모자라면 503');
    assert.match(r.body.reason, /상한/);
    r = await roomOf(OP_ALL);
    assert.equal(r.statusCode, 200, '시리얼을 보는 판본은 태그를 가리지 않으므로 태그가 모자라도 막지 않는다(N8-4)');
    const g0 = (await R.maskState()).gen;
    for (let i = 0; i < 3; i += 1) assert.equal((await roomOf(OP_A)).statusCode, 503);
    assert.equal((await R.maskState()).gen, g0, '담지 못한 상태에서 같은 값을 다시 흡수해도 세대가 오르지 않는다(N8-1 — 예전엔 요청마다 색인을 통째로 다시 만들었다)');
    const out = {};
    await R.maskAbsorb([], mk(20_000, 'tga').map((s) => s.serviceTag).concat(mk(20_000, 'tgb').map((s) => s.serviceTag), mk(15_000, 'tgc').map((s) => s.serviceTag)), { out });
    assert.deepEqual(out.shortBy, { h: 0, t: 5000 }); assert.equal(out.short, 5000);
    // N8-3: 그 종류의 지금 값 전부가 아닌 목록(인벤토리 태그를 빼고 모은 흡수)은 메모리 몫을 비우지 않는다
    const st = await R.maskState();
    assert.equal(st.overTags.size, 50_000);
    const keep = [...st.overTags][0];
    const out2 = {};
    await R.maskAbsorb([], ['PARTIAL01'], { out: out2, complete: { t: false } });
    assert.ok((await R.maskState()).overTags.has(keep), '목록에 없다고 지금 등록부에 없는 값이 아니다');
    assert.equal(out2.shortBy.t, 1);
    assert.equal((await R.maskState()).gen, g0, '바뀐 것이 없으면 세대도 그대로');
  } finally { q.restore(); for (const c of ['tg1', 'tg2', 'tg3']) RI.clearCollectorServers(c); }
  // 고장이 끝나면(엣지 목록이 비면) 다시 열린다 — 기록을 정리해 다음 시험에 넘긴다
  assert.equal((await roomOf(OP_A)).statusCode, 200);
  (await R.openRackDb()).exec("DELETE FROM rack_mask_seen WHERE key LIKE 'FILLT%'");
  restart();
});

test('N8-1 · N8-5 배선: 503 판정은 색인 빌드보다 먼저 · 범위 계정의 법인 시리얼은 양보하며 읽는다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/rack.js', import.meta.url), 'utf8');
  const v = src.slice(src.indexOf('async function viewerOf('), src.indexOf('function linkView('));
  const iShort = v.indexOf('if (out.shortBy.h || (!showSerial && out.shortBy.t))');
  const iIx = v.indexOf('ix = await materialIndex();');
  assert.ok(iShort > 0 && iIx > 0 && iShort < iIx, '담지 못함 판정이 색인 빌드보다 앞에 있어야 한다');
  assert.ok(v.includes('await R.corpSerials(id, { pause })') && v.includes('await corpTagIndexOfAsync(serials, pause)'), '범위 계정 목록도 양보하며 읽는다');
  const mat = fs.readFileSync(new URL('../src/rack/material.js', import.meta.url), 'utf8');
  assert.ok(mat.includes('complete: { h: true, t: inv }'), '인벤토리 태그를 모은 흡수만 태그 목록이 지금 값 전부');
});
