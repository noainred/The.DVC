// 랙 실장도 — 가림 재료 하위 체계(2026-11-27 · 6회차 점검 반영 · 설계 docs/design/rack-mask-redesign J4 '재료는 줄지 않는다').
//   ① 메모리 사본이 진실 · 파일은 응답 뒤에 따라간다(잠금을 기다리지 않는다) ② 세대가 같으면 색인을 다시 만들지 않는다 ③ 기록을 못 읽으면 조회 계정에 503
//   ④ 흡수는 모든 길에서(조회 — 관리자 포함 · 쓰기 · 주기) ⑤ 잘못 들어간 값은 전체 범위 관리자가 지운다(감사) ⑥ 상한 · 너무 긴 값은 메모리에만.
//   첫 판(rackMaskSeen1127 · 탐침 rackR6probeMaterial)의 계약 — '기록 ∪ 지금' 반환 · 관리자는 60초에 한 번 · 기록을 못 읽으면 지금 재료로 — 을 이 파일이 대신한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackmat-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const M = await import(`${S}/rack/material.js`);
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
const ADMIN = U('admin', 'admin'); const ADMIN_A = U('admin-a', 'admin', ['vc-a']); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body, user = ADMIN) => call('POST /tools/rack/op', { user, body });
const edge = (id, host, tag) => ({ id, name: `remote-${id}`, host: `https://${host}`, serviceTag: tag, vcenterId: 'vc-a' });
const roomOf = async (user) => (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } }));
const labelOf = async (user, placeId) => (await roomOf(user)).body.places.find((p) => p.id === placeId).label;
const counts = async () => { const c = await R.maskSeenCounts(); return { hosts: c.hosts, tags: c.tags }; };
const captureWarn = () => { const warns = []; const orig = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); }; return { warns, restore: () => { console.warn = orig; } }; };
const tick = () => new Promise((r) => setImmediate(r));
// 가려진 주소의 두 표기 — 숫자 · 콜론이 든 낱말은 토큰(masked-…), 그렇지 않은 등록 주소는 '(주소 가림)'(textMaskOf 의 기존 규칙)
const GONE = '(?:masked-[0-9a-f]+|\\(주소 가림\\))';
/** 프로세스를 다시 띄운 것과 같게 — 메모리 사본 · 색인 · 간격을 버리고(대기 중인 기록은 먼저 파일에) 원장 핸들을 닫는다. */
function restart() { R._dropMaskMemoryForTest(); R._closeForTest(); M._dropIndexForTest(); M._resetAbsorbForTest(); }

let roomId = ''; let rackId = ''; let rev = 0;
async function place(label, u, user = ADMIN) {
  const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uStart: u, uSize: 1, kind: 'other', label } }, user);
  assert.equal(p.statusCode, 200, JSON.stringify(p.body)); rev = p.body.rev;
  return p.body.id;
}

test('준비', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } });
  rackId = k.body.id; rev = k.body.rev;
});

test('① 엣지 서버 목록이 비어도 · 프로세스를 다시 띄워도 그 서버의 주소 · 태그가 든 이름은 가려진다', async () => {
  RI.setCollectorServers('edge1', 'kr', [edge('r1', 'idrac-r1.edge.example', 'RMT0001')]);
  const pid = await place('kvm idrac-r1.edge.example RMT0001', 1);
  assert.match(await labelOf(OP_ALL, pid), /^kvm masked-[0-9a-f]+ RMT0001$/);
  assert.match(await labelOf(OP_A, pid), /^kvm masked-[0-9a-f]+ •••$/);
  RI.clearCollectorServers('edge1');   // 수집 서버를 끔 · 재시작 직후와 같은 상태(예전엔 두 계정 모두 원문)
  assert.match(await labelOf(OP_ALL, pid), /^kvm masked-[0-9a-f]+ RMT0001$/);
  assert.match(await labelOf(OP_A, pid), /^kvm masked-[0-9a-f]+ •••$/);
  restart();
  assert.match(await labelOf(OP_A, pid), /^kvm masked-[0-9a-f]+ •••$/, '다시 띄운 뒤(파일의 기록만)');
  assert.deepEqual(await counts(), { hosts: 1, tags: 1 }, '같은 값을 두 번 기록하지 않는다');
  assert.equal(await labelOf(ADMIN, pid), 'kvm idrac-r1.edge.example RMT0001', '관리자는 원문');
  const logs = (await roomOf(OP_A)).body.logs.map((l) => l.detail).join('\n');
  assert.ok(!/idrac-r1|RMT0001/i.test(logs), logs);
});

test('④ 관리자 요청도 매번 흡수한다(간격 없음) — 관리자가 연 사이 들어왔다 사라진 서버도 가려진다(6회차 정확성 D3 · 보안 1 · 반증 R2)', async () => {
  await roomOf(ADMIN);
  RI.setCollectorServers('edge2', 'kr', [edge('r2', 'idrac-r2.edge.example', 'RMT0002')]);
  const pid = await place('pdu idrac-r2.edge.example RMT0002', 3);
  assert.equal(await labelOf(ADMIN, pid), 'pdu idrac-r2.edge.example RMT0002');   // 바로 뒤 관리자 요청 — 예전엔 60초 간격 안이라 기록하지 않았다
  RI.clearCollectorServers('edge2');
  restart();
  assert.match(await labelOf(OP_A, pid), /^pdu masked-[0-9a-f]+ •••$/);
  assert.match(await labelOf(OP_ALL, pid), /^pdu masked-[0-9a-f]+ RMT0002$/);
});

test('④ 쓰기도 흡수한다 — 조회 없이 서버를 놓고 그 서버가 사라져도 가려진다', async () => {
  RI.setCollectorServers('edge3', 'kr', [edge('r3', 'idrac-r3.edge.example', 'RMT0003')]);
  const before = await counts();
  const pid = await place('web idrac-r3.edge.example', 5);   // GET 없이 쓰기만
  assert.deepEqual(await counts(), { hosts: before.hosts + 1, tags: before.tags + 1 }, '쓰기가 흡수했다');
  RI.clearCollectorServers('edge3');
  restart();
  assert.match(await labelOf(OP_A, pid), /^web masked-[0-9a-f]+$/);
});

test('④ 인벤토리에서만 읽힌 태그 — 범위 계정 요청은 매번 흡수 · 관리자 · 전체 범위 요청은 간격(그 판본은 태그를 가리지 않는다)', async () => {
  registry.importServers([{ id: 'inv1', name: 'inv1', host: 'https://10.77.0.1', username: 'root', password: 'x', serviceTag: '', vcenterId: 'vc-a' }]);
  invCache.setInventory('inv1', { system: { serviceTag: 'INVONLY71', model: 'R650', hostName: 'h1' }, collectedAt: Date.now() });
  const pid = await place('spare INVONLY71 unit', 7);   // 쓰기가 흡수(간격이 시작된다)
  const after1 = await R.maskState();
  assert.ok(after1.tags.has('INVONLY71') || !after1.tags.has('INVONLY71'));   // 첫 흡수는 간격 밖이면 넣는다 — 순서에 기대지 않게 다음 단언으로 본다
  M._resetAbsorbForTest(); await roomOf(ADMIN);   // 간격 시작
  invCache.setInventory('inv1', { system: { serviceTag: 'INVONLY72', model: 'R650', hostName: 'h1' }, collectedAt: Date.now() });
  await roomOf(ADMIN); await roomOf(OP_ALL);
  assert.ok(!(await R.maskState()).tags.has('INVONLY72'), '관리자 · 전체 범위 요청은 간격 안에서 인벤토리를 다시 훑지 않는다');
  await roomOf(OP_A);
  assert.ok((await R.maskState()).tags.has('INVONLY72'), '범위 계정 요청은 매번 흡수한다');
  const p2 = await place('spare INVONLY72 unit', 9);
  invCache.setInventory('inv1', { system: { serviceTag: '', model: 'R650', hostName: 'h1' }, collectedAt: Date.now() });
  restart();
  assert.equal(await labelOf(OP_A, p2), 'spare ••• unit', '인벤토리에서 태그가 사라져도 기록으로 가린다');
  assert.ok(pid);
});

test('④ 주기 흡수 — 아무도 열지 않아도 등록부의 재료를 기록한다 · 원장 파일이 없으면 돌지 않는다 · 재진입하지 않는다', async () => {
  registry.importServers([{ id: 's5', name: 's5', host: 'https://bmc-s5.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0005', vcenterId: 'vc-a' }], 'merge');
  assert.ok(!(await R.maskState()).hosts.has('https://bmc-s5.mgmt.example'));
  const none = await M.materialWatchTick({ fileExists: async () => false });
  assert.deepEqual(none, { skipped: 'no-ledger' });
  assert.ok(!(await R.maskState()).hosts.has('https://bmc-s5.mgmt.example'), '파일이 없으면 흡수하지 않는다');
  let release; const slow = new Promise((r) => { release = r; });
  const first = M.materialWatchTick({ fileExists: async () => { await slow; return true; } });
  assert.deepEqual(await M.materialWatchTick({ fileExists: async () => true }), { skipped: 'running' }, '진행 중이면 겹쳐 돌지 않는다');
  release(true);
  const r = await first;
  assert.ok(typeof r.gen === 'number', JSON.stringify(r));
  const st = await R.maskState();
  assert.ok(st.hosts.has('https://bmc-s5.mgmt.example') && st.tags.has('SVA0005'));
  assert.equal(R.rackDbFile(), process.env.RACK_DB);
});

test('④ 엣지 서버가 host 없이 id 만 주소일 때 — 점 · 콜론이 든 id 만 주소 재료로', async () => {
  RI.setCollectorServers('edgeId', 'kr', [{ id: 'idrac-r9.edge.example', name: 'r9', serviceTag: 'RMTID009', vcenterId: 'vc-a' }, { id: 'SVCID0010', name: 'r10', serviceTag: 'SVCID0010', vcenterId: 'vc-a' }]);
  const pid = await place('kvm idrac-r9.edge.example rear', 11);
  const p2 = await place('box SVCID0010', 13);
  const st = await R.maskState();
  assert.ok(st.hosts.has('idrac-r9.edge.example') && !st.hosts.has('SVCID0010'));
  RI.clearCollectorServers('edgeId');
  restart();
  assert.match(await labelOf(OP_ALL, pid), /^kvm masked-[0-9a-f]+ rear$/);
  assert.equal(await labelOf(OP_ALL, p2), 'box SVCID0010', '시리얼을 보는 판본 — 태그 꼴 id 는 주소가 아니다');
});

test('② 세대 — 기록이 바뀌지 않으면 같은 색인을 쓰고, 새 값이 오면 한 번만 다시 만든다(동시 요청은 같은 빌드를 기다린다)', async () => {
  const a = await M.materialIndex();
  assert.equal(await M.materialIndex(), a, '같은 세대 — 같은 색인');
  await roomOf(OP_A); await roomOf(OP_ALL);
  assert.equal(await M.materialIndex(), a, '새 값 없는 조회는 세대를 올리지 않는다');
  await R.maskAbsorb(['gen-new.example'], []);
  M._dropIndexForTest();
  const [b, c] = await Promise.all([M.materialIndex(), M.materialIndex()]);
  assert.equal(b, c, '진행 중인 빌드를 함께 기다린다');
  assert.ok(b.gen > a.gen && b.addrSet.has('gen-new.example'));
  await R.maskAbsorb(['gen-new.example'], []);
  assert.equal(await M.materialIndex(), b, '이미 있는 값은 세대를 올리지 않는다');
});

test('① 파일 쓰기가 실패해도 메모리에서 바로 가린다 · 실패는 한 번 알리고 대기 뒤 다시 · 나중에 파일에 남는다', async () => {
  const db = await R.openRackDb();
  db.exec("CREATE TRIGGER rm_boom BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'rm boom'); END;");
  const w = captureWarn();
  let pid;
  try {
    RI.setCollectorServers('edgeF', 'kr', [edge('rf', 'idrac-rf.edge.example', 'RMTF0001')]);
    pid = await place('kvm idrac-rf.edge.example RMTF0001', 15);
    await tick(); await tick();
    const r = await roomOf(OP_A);
    assert.equal(r.statusCode, 200);
    assert.match(r.body.places.find((p) => p.id === pid).label, new RegExp(`^kvm ${GONE} •••$`), '메모리 사본이 바로 가린다');
    const c = await R.maskSeenCounts();
    assert.ok(c.pending >= 2, `파일에 남기지 못한 값: ${JSON.stringify(c)}`);
    assert.equal(w.warns.filter((x) => x.includes('가림 재료를 파일에 남기지 못했습니다')).length, 1, '실패는 콘솔에 한 번(무음 실패 금지)');
    await R.maskAbsorb(['another-while-failing.example'], []);
    await tick(); await tick();
    assert.equal(w.warns.filter((x) => x.includes('가림 재료를 파일에 남기지 못했습니다')).length, 1, '대기 중에는 다시 시도하지 않는다');
  } finally { w.restore(); db.exec('DROP TRIGGER rm_boom'); RI.clearCollectorServers('edgeF'); }
  R._flushMaskForTest();
  assert.equal((await R.maskSeenCounts()).pending, 0);
  restart();
  assert.match(await labelOf(OP_A, pid), new RegExp(`^kvm ${GONE} •••$`), '나중에 쓴 기록으로 다시 띄운 뒤에도 가린다');
  assert.ok((await R.maskState()).hosts.has('another-while-failing.example'));
});

test('③ 기록을 읽지 못하면 조회 계정에는 503(닫힌 쪽) · 관리자는 그대로 · 고쳐지면 돌아온다', async () => {
  R._dropMaskMemoryForTest();
  const db = await R.openRackDb();
  db.exec('ALTER TABLE rack_mask_seen RENAME TO rack_mask_seen_x');
  const w = captureWarn();
  const errs = []; const oe = console.error; console.error = (...a) => { errs.push(a.join(' ')); };
  try {
    for (const user of [OP_ALL, OP_A]) {
      for (const [key, o] of [['GET /tools/rack', {}], ['GET /tools/rack/room/:id', { params: { id: roomId } }], ['GET /tools/rack/versions', { query: { corp: 'kr' } }]]) {
        const r = await call(key, { user, ...o });
        assert.equal(r.statusCode, 503, `${key} · ${user.username}: ${JSON.stringify(r.body).slice(0, 200)}`);
        assert.equal(r.body.code, 'maskUnavailable');
        assert.deepEqual(Object.keys(r.body).sort(), ['code', 'ok', 'reason'], '부분 응답이 없다');
      }
    }
    assert.equal((await roomOf(ADMIN)).statusCode, 200, '관리자는 가리지 않으므로 그대로');
    assert.equal((await call('GET /tools/rack/mask-census', { user: ADMIN })).statusCode, 503);
    assert.ok(w.warns.some((x) => x.includes('가림 재료 기록을 읽지 못했습니다')));
  } finally { w.restore(); console.error = oe; db.exec('ALTER TABLE rack_mask_seen_x RENAME TO rack_mask_seen'); }
  R._dropMaskMemoryForTest();
  const r = await roomOf(OP_A);
  assert.equal(r.statusCode, 200);
  assert.ok(!JSON.stringify(r.body).includes('idrac-r1'));
});

test('⑥ 너무 긴 값(주소 255자 · 태그 64자 초과)은 메모리에만 — 이 프로세스에서는 가리고 파일에는 남기지 않는다', async () => {
  const h255 = `h${'x'.repeat(246)}.example`; const h256 = `h${'y'.repeat(247)}.example`;
  assert.equal(h255.length, 255); assert.equal(h256.length, 256);
  const before = await counts();
  await R.maskAbsorb([h255, h256, '', null, 42], ['U'.repeat(64), 'V'.repeat(65), '', null]);
  const c = await R.maskSeenCounts();
  assert.deepEqual({ hosts: c.hosts, tags: c.tags }, { hosts: before.hosts + 1, tags: before.tags + 1 });
  assert.equal(c.overflow, 2);
  const ix = await M.materialIndex();
  assert.ok(ix.addrSet.has(h256), '긴 값도 이 프로세스의 재료');
  restart();
  const st = await R.maskState();
  assert.ok(st.hosts.has(h255) && !st.hosts.has(h256) && st.tags.has('U'.repeat(64)) && !st.tags.has('V'.repeat(65)));
});

test('⑤ 기록 관리 — 전체 범위 관리자만 · 지금 등록부에 없는 값만 목록 · 지우기(지금 값은 건너뜀) · 지운 값은 다시 가리지 않는다', async () => {
  for (const user of [OP_ALL, OP_A, ADMIN_A]) assert.equal((await call('GET /tools/rack/mask-seen', { user })).statusCode, 403, user.username);
  const r = await call('GET /tools/rack/mask-seen', { user: ADMIN });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const stale = r.body.stale;
  assert.ok(stale.some((x) => x.kind === 'h' && x.key === 'https://idrac-r1.edge.example'), '목록에서 사라진 엣지 서버의 주소');
  assert.ok(!stale.some((x) => x.key === 'https://bmc-s5.mgmt.example'), '지금 등록부에 있는 값은 후보가 아니다');
  assert.ok(stale.every((x) => typeof x.firstSeen === 'number' && x.firstSeen > 0), '처음 본 시각');
  assert.equal(r.body.staleTotal, stale.length);
  // 지우기 — 권한
  assert.equal((await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'https://idrac-r1.edge.example' }] }, OP_ALL)).statusCode, 403);
  assert.equal((await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'https://idrac-r1.edge.example' }] }, ADMIN_A)).statusCode, 403);
  assert.equal((await op({ op: 'mask.forget', items: [] })).statusCode, 400);
  assert.equal((await op({ op: 'mask.forget', items: [{ kind: 'x', key: 'a' }] })).statusCode, 400);
  const f = await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'https://idrac-r1.edge.example' }, { kind: 'h', key: 'https://bmc-s5.mgmt.example' }] });
  assert.equal(f.statusCode, 200, JSON.stringify(f.body));
  assert.deepEqual([f.body.removed, f.body.skippedCurrent], [1, 1]);
  const st = await R.maskState();
  assert.ok(!st.hosts.has('https://idrac-r1.edge.example') && st.hosts.has('https://bmc-s5.mgmt.example'));
  restart();
  assert.ok(!(await R.maskState()).hosts.has('https://idrac-r1.edge.example'), '파일에서도 지워졌다');
  // 지운 값은 다시 가리지 않는다(관리자가 고른 결과) — 태그(RMT0001)는 남아 있으므로 그 부분만 가려진다
  const pid = (await roomOf(ADMIN)).body.places.find((p) => p.label === 'kvm idrac-r1.edge.example RMT0001').id;
  assert.equal(await labelOf(OP_A, pid), 'kvm idrac-r1.edge.example •••');
});

test('⑥ 상한(종류마다 200,000) — 넘는 새 값은 메모리에만(이 프로세스에서는 가린다) · 경고는 한 번', async () => {
  const db = await R.openRackDb();
  const have = (await counts()).hosts;
  db.exec('BEGIN');
  const ins = db.prepare("INSERT INTO rack_mask_seen (kind, key, first_seen) VALUES ('h', ?, 1)");
  for (let i = have; i < 200_000; i += 1) ins.run(`fill-${i}.cap.example`);
  db.exec('COMMIT');
  restart();
  const w = captureWarn();
  try {
    RI.setCollectorServers('edgeCap', 'kr', [edge('rc', 'idrac-rcap.edge.example', 'RMTCAP01')]);
    const pid = await place('kvm idrac-rcap.edge.example', 17);
    const c = await R.maskSeenCounts();
    assert.equal(c.hosts, 200_000); assert.ok(c.overflow >= 1);
    assert.match(await labelOf(OP_A, pid), new RegExp(`^kvm ${GONE}$`), '상한 뒤의 새 값도 이 프로세스에서는 가린다');
    await R.maskAbsorb(['over-cap-2.example'], []);
    assert.equal(w.warns.filter((x) => x.includes('상한')).length, 1, '상한 경고는 한 번');
  } finally { w.restore(); RI.clearCollectorServers('edgeCap'); }
});
