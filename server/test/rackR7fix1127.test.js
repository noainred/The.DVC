// 랙 실장도 — 2026-11-27 7회차 점검(6관점 → 결함마다 3관점 반증 · 확정 25건) 수정의 회귀.
//   S7-1 시리얼 칸 '등록 주소' 거절은 쓰는 사람의 조회 범위로 · P7-1/C4/S7-3 메모리 몫이 넘칠 때 지금 값을 잃지 않는다 · 담지 못하면 조회 계정 503 ·
//   C5 긴 주소는 글 속에서도 · 긴 태그는 재료가 아니다 · S7-4/R7-1 종료 때 대기 값을 쓴다 · 실패 간격 상한 2분 · P7-3 조각 읽기 쿼리가 기본 키를 탄다 ·
//   P7-2 색인 꼬리의 양보(결과는 같다) · P7-5 집계의 법인 시리얼 양보 · C1 쌍둥이 이름 · C3 원장을 비운 법인의 시리얼 · C8 옛 키 칸 · R7-2 연결 정보 칸 목록.
//   (변이 축이 만든 시험은 rackMaterialMut1127 · rackRouteMut1127 · rackMemMut1127 — 이 파일은 이번 수정의 동작을 고정한다.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr7fix-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const M = await import(`${S}/rack/material.js`);
const P = await import(`${S}/rack/project.js`);
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
const ADMIN = U('admin', 'admin'); const ADMIN_A = U('admin-a', 'admin', ['vc-a']);
const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
dc.addDatacenter({ id: 'us', name: 'US' }); dc.setVcenterDatacenter('vc-b', 'us');
const op = (body, user = ADMIN) => call('POST /tools/rack/op', { user, body });
const okOp = async (body, user = ADMIN) => { const r = await op(body, user); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const tick = () => new Promise((r) => setImmediate(r));
const quiet = () => { const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); }; return { warns, restore: () => { console.warn = ow; } }; };
function restart({ flush = true } = {}) { R._dropMaskMemoryForTest({ flush }); R._closeForTest(); M._dropIndexForTest(); M._resetAbsorbForTest(); }
const W = {};
const roomOf = async (user, id = W.room) => (await call('GET /tools/rack/room/:id', { user, params: { id } })).body;
const placeOf = async (user, pid, room = W.room) => (await roomOf(user, room)).places.find((p) => p.id === pid);
async function place(label, u, extra = {}, user = ADMIN) {
  const r = await okOp({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: u, uSize: 1, kind: 'other', label, ...extra } }, user);
  W.rev = r.rev; return r.id;
}

test('준비 — 법인 둘(kr · us) · 등록 서버(kr · us)', async () => {
  registry.importServers([
    { id: 'kr1', name: 'kr1', host: 'https://kr-own-bmc.mgmt.example', username: 'root', password: 'x', serviceTag: 'KRSRV001', vcenterId: 'vc-a' },
    { id: 'us1', name: 'us1', host: 'https://us-secret-bmc.mgmt.example', username: 'root', password: 'x', serviceTag: 'USSRV001', vcenterId: 'vc-b' },
  ]);
  W.site = (await okOp({ op: 'site.add', corpId: 'kr', name: 'S' })).id;
  W.room = (await okOp({ op: 'room.add', siteId: W.site, name: 'R' })).id;
  const k = await okOp({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'A1', heightU: 42 } });
  W.rack = k.id; W.rev = k.rev;
  W.p1 = await place('box', 1);
});

// ── S7-1 ──
test('S7-1: 시리얼 칸의 등록 주소 거절은 쓰는 사람이 볼 수 있는 서버로만 — 범위 관리자가 다른 법인 서버의 등록 여부를 맞히지 못한다', async () => {
  const upd = (serial, user, rev = W.rev) => op({ op: 'place.update', id: W.p1, rev, place: { serial } }, user);
  // 범위 관리자(kr): 자기 범위의 등록 주소는 거절 · 다른 법인(us) 등록 주소와 없는 이름은 같은 결과
  let r = await upd('kr-own-bmc.mgmt.example', ADMIN_A);
  assert.equal(r.statusCode, 400, JSON.stringify(r.body)); assert.match(r.body.reason, /등록된 관리 주소/);
  const outcomes = [];
  for (const cand of ['us-secret-bmc.mgmt.example', 'us-guess-bmc.mgmt.example']) {
    const st = await op({ op: 'place.update', id: W.p1, rev: 0, place: { serial: cand } }, ADMIN_A);   // 낡은 rev — 저장 없이 묻던 길(400 vs 409)
    outcomes.push(st.statusCode);
  }
  assert.deepEqual(outcomes, [409, 409], '낡은 rev 로 물어도 등록 여부가 갈리지 않는다');
  r = await upd('us-secret-bmc.mgmt.example', ADMIN_A);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); W.rev = r.body.rev;
  // 출력은 닫혀 있다 — 시리얼을 보는 조회 계정에는 빈칸 · 범위 계정에는 시리얼이 없다
  assert.equal((await placeOf(OP_ALL, W.p1)).serial, '', '시리얼을 보는 판본은 함대 재료로 비운다');
  const pa = await placeOf(OP_A, W.p1);
  assert.equal(pa.serial, ''); assert.equal(pa.serialHidden, true);
  assert.ok(!JSON.stringify(await roomOf(OP_A)).includes('us-secret-bmc'));
  // 전체 범위 관리자는 함대 재료(다른 법인 · 기록 포함)로 거절한다
  r = await upd('us-secret-bmc.mgmt.example', ADMIN);
  assert.equal(r.statusCode, 400, '전체 범위 관리자는 다른 법인 등록 주소도 거절한다');
  r = await op({ op: 'place.update', id: W.p1, rev: W.rev, place: { serial: 'SN-1 us-secret-bmc.mgmt.example' } });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  r = await okOp({ op: 'place.update', id: W.p1, rev: W.rev, place: { serial: '' } }); W.rev = r.rev;
});

// ── P7-1 · C4 · S7-3 · 503 ──
test('P7-1 · C4: 메모리 몫이 넘쳐도 그 흡수의 지금 값은 남는다 · 같은 값을 다시 흡수해도 세대가 오르지 않는다 · 담지 못하면 out.short', async () => {
  const db = await R.openRackDb();
  const have = (await R.maskSeenCounts()).hosts;
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES ('h', ?, 1)");
  for (let i = have; i < 200_000; i += 1) ins.run(`fill-${i}.cap.example`);
  db.exec('COMMIT');
  restart();
  const q = quiet();
  try {
    const cur = 'current-late.mgmt.example';
    await R.maskAbsorb([cur], []);   // 상한 뒤의 지금 값 — over 로
    const stale = Array.from({ length: 49_999 }, (_, i) => `stale-${i}.over.example`);
    await R.maskAbsorb(stale, []);   // over 를 가득(지금 등록부에 없는 값)
    assert.equal((await R.maskSeenCounts()).overflow, 50_000);
    const out = {};
    const g1 = await R.maskAbsorb([cur, 'new-a.over.example', 'new-b.over.example'], [], { out });
    assert.equal(out.short, 0);
    const st = await R.maskState();
    assert.ok(st.overHosts.has(cur), '넘쳐 비울 때 그 흡수의 지금 값은 남긴다(예전엔 먼저 지나간 지금 값이 빠졌다)');
    assert.ok(st.overHosts.has('new-a.over.example') && st.overHosts.has('new-b.over.example'));
    assert.ok(!st.overHosts.has('stale-0.over.example'), '지금 등록부에 없는 값부터 버린다');
    assert.ok((await M.materialIndex()).addrSet.has(cur));
    const g2 = await R.maskAbsorb([cur, 'new-a.over.example', 'new-b.over.example'], []);
    assert.equal(g2, g1, '같은 값을 다시 흡수해도 세대가 오르지 않는다(C4)');
    assert.ok(q.warns.some((w) => w.includes('메모리 몫') && w.includes('버렸습니다')), '비운 사실을 알린다(S7-3)');
    // 그 흡수의 지금 값이 메모리 몫보다 많으면 담지 못한 수를 알린다
    const many = Array.from({ length: 50_001 }, (_, i) => `now-${i}.many.example`);
    const out2 = {};
    await R.maskAbsorb(many, [], { out: out2 });
    assert.equal(out2.short, 1);
    assert.ok(q.warns.some((w) => w.includes('담지 못했습니다')));
  } finally { q.restore(); }
});

test('P7-1 끝: 지금 재료를 다 담지 못하면 조회 계정 요청은 503(maskUnavailable) · 관리자는 그대로', async () => {
  // 위 시험의 상태(기록 20만 + 메모리 몫 5만)에서 엣지가 메모리 몫보다 많은 새 주소를 올린다
  const mk = (n, c) => Array.from({ length: n }, (_, i) => ({ id: `${c}-${i}`, name: `${c}-${i}`, host: `https://${c}-${i}.flood.example`, serviceTag: '', vcenterId: 'vc-a' }));
  RI.setCollectorServers('flood1', 'kr', mk(20_000, 'fa')); RI.setCollectorServers('flood2', 'kr', mk(20_000, 'fb')); RI.setCollectorServers('flood3', 'kr', mk(15_000, 'fc'));
  const q = quiet();
  try {
    for (const user of [OP_ALL, OP_A]) {
      const r = await call('GET /tools/rack/room/:id', { user, params: { id: W.room } });
      assert.equal(r.statusCode, 503, `${user.username}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.code, 'maskUnavailable');
      assert.match(r.body.reason, /상한/);
    }
    assert.equal((await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.room } })).statusCode, 200);
  } finally { q.restore(); for (const c of ['flood1', 'flood2', 'flood3']) RI.clearCollectorServers(c); }
  assert.equal((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: W.room } })).statusCode, 200, '고장이 끝나면 돌아온다');
  // 다음 시험을 위해 기록을 비운다(상한 상태를 끝낸다)
  const db = await R.openRackDb();
  db.exec("DELETE FROM rack_mask_seen WHERE key LIKE 'fill-%'");
  restart();
});

// ── C5 ──
test('C5: 255자 넘는 등록 주소(경로가 붙은 URL)도 여러 낱말 글 속에서 가린다 · 64자 넘는 태그는 재료로 담지 않는다', async () => {
  const longHost = `https://bmc-long.mgmt.example/${'p'.repeat(240)}/ui`;
  assert.ok(longHost.length > 255);
  registry.importServers([{ id: 'lh1', name: 'lh1', host: longHost, username: 'root', password: 'x', serviceTag: 'LHSRV001', vcenterId: 'vc-a' }], 'merge');
  const pid = await place(`kvm ${longHost} rear`, 13);
  for (const user of [OP_ALL, OP_A]) {
    const label = (await placeOf(user, pid)).label;
    assert.ok(!label.includes('p'.repeat(100)), `${user.username}: ${label.slice(0, 80)}`);
  }
  const before = (await R.maskSeenCounts()).overflow;
  await R.maskAbsorb([], ['T'.repeat(65)]);
  assert.equal((await R.maskSeenCounts()).overflow, before, '64자 넘는 태그는 메모리 몫에도 담지 않는다');
});

// ── S7-4 · R7-1 ──
test('R7-1: 종료 때 대기 값을 쓴다(flushMaskOnExit) — 쓰지 않고 죽으면 잃는다 · 잠금이 이어지면 경고하고 남은 수를 돌려준다', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec("CREATE TRIGGER r7x_boom BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7x boom'); END;");
  const q = quiet();
  try {
    await R.maskAbsorb(['exit-lost.example'], []);
    await tick();
    assert.equal((await R.maskSeenCounts()).pending, 1, '전제: 쓰기 실패로 대기');
  } finally { q.restore(); db.exec('DROP TRIGGER r7x_boom'); }
  restart({ flush: false });   // 종료 훅 없이 죽은 프로세스
  assert.ok(!(await R.maskState()).hosts.has('exit-lost.example'), '대기 값은 메모리에만 있다 — 쓰지 않고 죽으면 잃는다(문서의 한계)');

  const db2 = await R.openRackDb();
  db2.exec("CREATE TRIGGER r7x_boom2 BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7x boom'); END;");
  const q2 = quiet();
  try {
    await R.maskAbsorb(['exit-kept.example'], []);
    await tick();
    assert.equal((await R.maskSeenCounts()).pending, 1);
  } finally { q2.restore(); db2.exec('DROP TRIGGER r7x_boom2'); }
  assert.equal(R.flushMaskOnExit(), 0, '종료 훅이 남은 값을 썼다');
  restart({ flush: false });
  assert.ok((await R.maskState()).hosts.has('exit-kept.example'), '종료 훅으로 쓴 값은 다시 띄운 뒤에도 있다');

  // 잠금이 끝까지 이어지면 — 짧게 기다린 뒤 경고 · 남은 수
  await R.maskAbsorb(['exit-locked.example'], []);
  const other = new DatabaseSync(process.env.RACK_DB);
  other.exec('PRAGMA busy_timeout = 0'); other.exec('BEGIN IMMEDIATE');
  const q3 = quiet();
  let left;
  try { left = R.flushMaskOnExit({ busyMs: 50 }); } finally { q3.restore(); other.exec('ROLLBACK'); other.close(); }
  assert.equal(left, 1);
  assert.ok(q3.warns.some((w) => w.includes('종료') && w.includes('남기지 못했습니다')), q3.warns.join('\n'));
  R._flushMaskForTest();
  assert.equal((await R.maskSeenCounts()).pending, 0);
});

test('R7-1: 종료 훅이 index.js 의 정상 종료 경로(done)에 있다', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const done = src.slice(src.indexOf('const done = (code) => {'), src.indexOf('process.exit(code);'));
  assert.ok(done.includes('flushRackMaskOnExit()'), '종료 경로에 랙 가림 재료 쓰기가 없다');
  assert.match(src, /import \{ flushMaskOnExit as flushRackMaskOnExit \} from '\.\/rack\/db\.js'/);
});

test('R7-1: 쓰기 실패 뒤 다시 시도 간격은 30초 → 1분 → 2분에서 멈춘다(예전 상한 16분은 원인이 사라진 뒤에도 그만큼 쓰지 않았다)', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec("CREATE TRIGGER r7x_boom3 BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7x boom'); END;");
  const ot = globalThis.setTimeout; const delays = []; let pendingFn = null;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 30_000) { delays.push(ms); pendingFn = fn; const t = ot(() => {}, 2 ** 31 - 1); t.unref(); return t; } return ot(fn, ms, ...rest); };
  const fire = () => { const f = pendingFn; pendingFn = null; assert.equal(typeof f, 'function'); f(); };
  const q = quiet();
  try {
    await R.maskAbsorb(['backoff-cap.example'], []);
    await tick();
    for (let i = 0; i < 5; i += 1) fire();
  } finally { globalThis.setTimeout = ot; q.restore(); db.exec('DROP TRIGGER r7x_boom3'); }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  assert.equal(q.warns.filter((w) => w.includes('가림 재료를 파일에 남기지 못했습니다')).length, 1, '실패가 이어지는 동안 알림은 처음 한 번(30번마다 다시)');
  assert.ok(q.warns.some((w) => w.includes('이 상태로 포탈을 끄면 대기 값을 잃습니다')));
  R._flushMaskForTest();
  assert.equal((await R.maskSeenCounts()).pending, 0);
});

// ── P7-3 ──
test('P7-3: 기록 조각 읽기는 기본 키로 찾는다(SCAN 이 아니다) · 조각 경계를 넘어 빠짐 · 겹침 없이 읽는다', async () => {
  const db = await R.openRackDb();
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${R._maskPageSqlForTest}`).all('h', 'x').map((r) => r.detail).join(' | ');
  // 두 칸을 함께 비교하는 검색이어야 한다 — 'USING PRIMARY KEY (kind>?)' 는 종류 안에서 다시 훑는다(변이 검증: '?1 OR' 꼴이 그 계획으로 살아남았다)
  assert.match(plan, /SEARCH rack_mask_seen USING PRIMARY KEY \(\(kind,key\)>\(\?,\?\)\)/, plan);
  assert.doesNotMatch(plan, /SCAN rack_mask_seen/, plan);
  R._flushMaskForTest();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES (?, ?, 3)");
  for (let i = 0; i < 6001; i += 1) { ins.run('h', `page-${String(i).padStart(5, '0')}.example`); ins.run('t', `PAGE${String(i).padStart(5, '0')}`); }
  db.exec('COMMIT');
  restart();
  const st = await R.maskState();
  const db2 = await R.openRackDb();
  const fileH = db2.prepare("SELECT COUNT(*) AS n FROM rack_mask_seen WHERE kind = 'h'").get().n;
  const fileT = db2.prepare("SELECT COUNT(*) AS n FROM rack_mask_seen WHERE kind = 't'").get().n;
  assert.equal(st.hosts.size, fileH); assert.equal(st.tags.size, fileT);
  const rows = await R.maskSeenRows();
  assert.equal(rows.filter((x) => !x.pending).length, fileH + fileT);
  assert.equal(new Set(rows.map((x) => `${x.kind}\u0000${x.key}`)).size, rows.length, '겹침 없음');
});

// ── P7-2 ──
test('P7-2: 조각 빌드 색인은 길이 · 앞머리까지 한 번에 만든 색인과 같고, 꼬리에서도 양보한다', async () => {
  // 가장 짧은 항목(2자)이 앞머리 길이(3)보다 짧게 — 앞머리 길이 계산을 빼면 결과가 달라진다(변이 검증에서 그 계산을 뺀 변이가 살아남았다)
  const strs = ['ab', 'abc', 'x'.repeat(300), ...Array.from({ length: 9000 }, (_, i) => `host-${i}.ex${'y'.repeat(i % 40)}`)];
  let n = 0;
  const a = await T.needleIndexOfAsync(strs, { min: 2, max: 2048 }, async () => { n += 1; });
  const b = T.needleIndexOf(strs, { min: 2, max: 2048 });
  assert.equal(b.headLen, 2, '전제: 앞머리 길이가 가장 짧은 항목에 맞춰진다');
  assert.deepEqual([...a.set].sort(), [...b.set].sort());
  assert.deepEqual(a.lens, b.lens); assert.equal(a.headLen, b.headLen);
  assert.deepEqual([...a.heads.entries()].sort(), [...b.heads.entries()].sort());
  // 양보 횟수 = 넣기 고리(512개마다) + 꼬리 앞 한 번 + 꼬리 세 훑기(길이 · 묶음 · 정렬 — 이어 센 4,096개마다). 꼬리의 어느 훑기에서 양보를 빼도 수가 달라진다.
  const tail = Math.floor((2 * a.set.size + a.heads.size) / 4096);
  assert.ok(tail >= 4, `전제: 꼬리에서 여러 번 양보할 크기 ${tail}`);
  assert.equal(n, Math.floor(strs.length / 512) + 1 + tail, `양보 ${n}번`);
  const tags = ['A-B-C1', 'ab', ...Array.from({ length: 9000 }, (_, i) => `TAGX${String(i).padStart(5, '0')}`)];
  const c = await T.tagIndexOfAsync(tags, async () => {});
  const d = T.tagIndexOf(tags);
  assert.deepEqual([...c.set].sort(), [...d.set].sort());
  assert.deepEqual(c.lens, d.lens); assert.equal(c.headLen, d.headLen);
  assert.deepEqual([...c.heads.entries()].sort(), [...d.heads.entries()].sort());
  assert.deepEqual([...c.shapes.entries()].map(([k, v]) => [k, [...v].sort()]).sort(), [...d.shapes.entries()].map(([k, v]) => [k, [...v].sort()]).sort());
  assert.deepEqual(Object.keys(c), Object.keys(d), '같은 칸');
});

// ── P7-5 ──
test('P7-5: 법인 시리얼을 전산실마다 양보하며 읽어도 결과는 같다 · 조각 색인도 같다', async () => {
  const pid = await place('serial box', 15, { serial: 'CSR00015', extraSerials: ['CSX00015'] });
  const db = await R.openRackDb();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_serial_seen (corp_id, key) VALUES ('kr', ?)");
  for (let i = 0; i < 5100; i += 1) ins.run(`seenkey${i}`);
  db.exec('COMMIT');
  let n = 0;
  const a = await R.corpSerials('kr', { pause: async () => { n += 1; } });
  const b = await R.corpSerials('kr');
  assert.deepEqual([...a].sort(), [...b].sort());
  assert.ok(n >= 2, `양보 ${n}번(전산실 · 기록 조각)`);
  const x = await M.corpTagIndexOfAsync(a, async () => {});
  const y = M.corpTagIndexOf(a);
  assert.deepEqual([...x.set].sort(), [...y.set].sort());
  assert.ok(pid);
});

// ── C1 ──
test('C1: 전각 · 반각 쌍둥이 이름이 있는 옛 원장 — 바꾸지 않은 이름 저장은 unchanged · 랙의 다른 칸 고치기는 막히지 않는다 · 진짜 중복은 409', async () => {
  const db = await R.openRackDb();
  const r2 = await okOp({ op: 'room.add', siteId: W.site, name: 'RM-TWIN' });
  const r3 = await okOp({ op: 'room.add', siteId: W.site, name: 'RM-TWIN-W' });
  db.prepare('UPDATE rack_room SET name = ? WHERE id = ?').run('ＲＭ－ＴＷＩＮ', r3.id);   // 이 판 전에 저장된 전각 쌍둥이
  let r = await okOp({ op: 'room.rename', id: r2.id, name: 'RM-TWIN' });
  assert.equal(r.unchanged, true, '반각 쪽 — 같은 이름');
  r = await okOp({ op: 'room.rename', id: r3.id, name: 'ＲＭ－ＴＷＩＮ' });   // 화면은 지금 이름을 그대로 보낸다(입력 정리가 반각으로 접는다)
  assert.equal(r.unchanged, true, '전각 쪽 — 접으면 쌍둥이와 같아지므로 그대로 둔다');
  assert.equal(db.prepare('SELECT name FROM rack_room WHERE id = ?').get(r3.id).name, 'ＲＭ－ＴＷＩＮ');
  assert.equal((await op({ op: 'room.rename', id: W.room, name: 'RM-TWIN' })).statusCode, 409, '다른 전산실 이름으로 바꾸기는 409');
  // 랙
  const k2 = await okOp({ op: 'rack.add', roomId: W.room, rev: W.rev, rack: { name: 'B1', heightU: 42 } }); W.rev = k2.rev;
  const k3 = await okOp({ op: 'rack.add', roomId: W.room, rev: W.rev, rack: { name: 'B1-W', heightU: 42 } }); W.rev = k3.rev;
  db.prepare('UPDATE rack_rack SET name = ? WHERE id = ?').run('Ｂ１', k3.id);
  await R._resyncForTest();
  W.rev = (await roomOf(ADMIN)).rev;
  r = await okOp({ op: 'rack.update', id: k2.id, rev: W.rev, rack: { name: 'B1', role: 'web' } });
  W.rev = r.rev;
  r = await okOp({ op: 'rack.update', id: k3.id, rev: W.rev, rack: { name: 'Ｂ１', role: 'db' } });
  W.rev = r.rev;
  assert.equal(db.prepare('SELECT name, role FROM rack_rack WHERE id = ?').get(k3.id).name, 'Ｂ１', '전각 쌍둥이 이름은 그대로');
  assert.equal(db.prepare('SELECT role FROM rack_rack WHERE id = ?').get(k3.id).role, 'db', '다른 칸은 고쳐졌다');
  assert.equal((await op({ op: 'rack.update', id: k2.id, rev: W.rev, rack: { name: 'A1' } })).statusCode, 409);
});

// ── C3 ──
test('C3: 데이터센터까지 지운 법인의 시리얼 기록도 랙 종류 이름을 가린다', async () => {
  const s = await okOp({ op: 'site.add', corpId: 'us', name: 'US-S' });
  const m = await okOp({ op: 'room.add', siteId: s.id, name: 'US-R' });
  const k = await okOp({ op: 'rack.add', roomId: m.id, rev: 0, rack: { name: 'U1', heightU: 42 } });
  const p = await okOp({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'other', label: 'x', serial: 'USONLY01' } });
  const t = await okOp({ op: 'type.add', name: 'T USONLY01', heightU: 42 });
  const typeName = async () => (await call('GET /tools/rack', { user: OP_A })).body.types.find((x) => x.id === t.id).name;
  assert.equal(await typeName(), 'T •••');
  const p2 = await okOp({ op: 'place.remove', id: p.id, rev: p.rev });
  const k2 = await okOp({ op: 'rack.remove', id: k.id, rev: p2.rev });
  await okOp({ op: 'room.remove', id: m.id, rev: k2.rev });
  await okOp({ op: 'site.remove', id: s.id });
  assert.ok((await R.ledgerCorpIds()).includes('us'), '시리얼 기록만 남은 법인도 든다');
  assert.equal(await typeName(), 'T •••', '원장을 비운 법인의 시리얼도 가린다');
  await okOp({ op: 'type.remove', id: t.id });
});

// ── C8 ──
test('C8: 장비 행의 키 칸이 옛 키로 남아도 연결 · 중복 판정은 시리얼에서 만든 키로 한다(자기 점검이 색인과 훑기를 대조)', async () => {
  registry.importServers([{ id: 'lk7', name: 'lk7', host: 'https://bmc-lk7.mgmt.example', username: 'root', password: 'x', serviceTag: 'LINK0007', vcenterId: 'vc-a' }], 'merge');
  const pid = await place('link me', 17, { kind: 'server', serial: 'LINK0007' });
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_place SET serial = 'ＬＩＮＫ０００７', serial_key = 'ｌｉｎｋ０００７' WHERE id = ?").run(pid);   // 키 다시 만들기가 실패해 남은 옛 칸
  assert.equal((await placeOf(ADMIN, pid)).linkState, 'linked', '옛 키 칸이어도 연결된다');
  const r = await op({ op: 'place.add', rackId: W.rack, rev: (await roomOf(ADMIN)).rev, place: { face: 'full', uStart: 19, uSize: 1, kind: 'server', label: 'dup', serial: 'link-0007' } });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'serialDup');
  W.rev = (await roomOf(ADMIN)).rev;
});

// ── R7-2 ──
test('R7-2: 연결 정보(비관리자)는 칸 목록 — 넘겨받은 값에 다른 칸이 있어도 싣지 않는다 · 전원 상태는 열거값만', () => {
  const v = { admin: false, text: (s) => `T(${s})` };
  const f = { serverToken: 'masked-1', model: 'R650', powerState: 'On 10.1.1.1', health: 'ok', remote: true, collectedAt: 5, via: 'https://idrac.edge.example',
    parts: { psu: { state: 'ok', counts: { ok: 2, warn: 0, fault: 0, unknown: 0, absent: 0, extra: 9 }, word: 'x' }, disk: { state: '', counts: {} }, mem: null, fan: undefined },
    hw: { cpu: { sockets: 2, model: 'Xeon', cores: 8 }, mem: { gib: 64, dimms: 4 }, fw: '7.00.00.171', host: 'h' } };
  const o = P.projectLink(f, v);
  assert.deepEqual(Object.keys(o), ['serverId', 'model', 'powerState', 'health', 'remote', 'collectedAt', 'parts', 'hw']);
  assert.equal(o.powerState, ''); assert.equal(o.model, 'T(R650)');
  assert.deepEqual(o.parts, { psu: { state: 'ok', ok: 2, warn: 0, fault: 0, unknown: 0, absent: 0 }, disk: null, mem: null, fan: null });
  assert.deepEqual(o.hw, { cpu: { sockets: 2, model: 'T(Xeon)' }, mem: { gib: 64 }, fw: '7.00.00.171' });
  assert.equal(P.projectLink({ ...f, powerState: 'PoweringOn' }, v).powerState, 'PoweringOn');
  const routeSrc = fs.readFileSync(new URL('../src/routes/api/rack.js', import.meta.url), 'utf8');
  const lv = routeSrc.slice(routeSrc.indexOf('function linkView('), routeSrc.indexOf('// ───────────────────────── 조회'));
  assert.ok(lv.includes('return projectLink({'), '비관리자 판본은 projectLink 로만');
});
