// [7회차 변이 축] 가림 재료 하위 체계(material.js · db.js 가림 재료 구역)에서 살아남은 변이를 잡는 시험.
//   각 시험 제목 앞의 [변이 id] = 이 시험이 잡는 변이(r7-mut/mutants.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackMatMut-'));
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
const ADMIN = U('admin', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body, user = ADMIN) => call('POST /tools/rack/op', { user, body });
const tick = () => new Promise((r) => setImmediate(r));
const quiet = () => { const warns = []; const ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); }; return { warns, restore: () => { console.warn = ow; } }; };
function restart() { R._dropMaskMemoryForTest(); R._closeForTest(); M._dropIndexForTest(); M._resetAbsorbForTest(); }
const W = {};
async function place(label, u, extra = {}) {
  const p = await op({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: u, uSize: 1, kind: 'other', label, ...extra } });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body)); W.rev = p.body.rev;
  return p.body.id;
}
const labelOf = async (user, id) => (await call('GET /tools/rack/room/:id', { user, params: { id: W.room } })).body.places.find((p) => p.id === id).label;

test('준비', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  W.room = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'A1', heightU: 42 } });
  W.rack = k.body.id; W.rev = k.body.rev;
});

test('[m12] 인벤토리 간격은 흡수를 **마친 뒤** 시작한다 — 기록을 못 읽어 실패한 흡수가 간격만 먹으면 그 60초 동안 인벤토리 태그가 빠진다', async () => {
  registry.importServers([{ id: 'iv1', name: 'iv1', host: 'https://10.88.0.1', username: 'root', password: 'x', serviceTag: '', vcenterId: 'vc-a' }], 'merge');
  invCache.setInventory('iv1', { system: { serviceTag: 'INVA0001' }, collectedAt: Date.now() });
  M._resetAbsorbForTest();
  const db = await R.openRackDb();
  R._dropMaskMemoryForTest(); M._dropIndexForTest();
  db.exec('ALTER TABLE rack_mask_seen RENAME TO rack_mask_seen_x');
  const q = quiet();
  try { await assert.rejects(M.absorbFleet(M.fleetServers()), (e) => e instanceof R.MaskUnavailable); }
  finally { q.restore(); db.exec('ALTER TABLE rack_mask_seen_x RENAME TO rack_mask_seen'); }
  R._dropMaskMemoryForTest();   // 5초 대기도 푼다
  await M.absorbFleet(M.fleetServers());   // forceInv 없이 — 앞선 실패가 간격을 시작하지 않았어야 인벤토리를 훑는다
  assert.ok((await R.maskState()).tags.has('INVA0001'), '실패한 흡수 뒤의 첫 흡수가 인벤토리 태그를 모았다');
});

test('[m14] 진행 중인 **다른 세대의** 색인 빌드를 공유하지 않는다 — 빌드 중에 흡수한 새 값이 그 뒤 요청의 색인에 있다', async () => {
  await R.maskAbsorb(Array.from({ length: 40_000 }, (_, i) => `bulk-${i}.gen.example`), []);
  M._dropIndexForTest();
  let done = false;
  const p1 = M.materialIndex().then((x) => { done = true; return x; });
  await tick();
  await R.maskAbsorb(['late-gen.example'], []);
  assert.equal(done, false, '전제: 앞 세대 빌드가 아직 진행 중(시험이 헛돌지 않게)');
  const ix2 = await M.materialIndex();
  assert.ok(ix2.addrSet.has('late-gen.example'), '빌드 중 흡수한 값이 새 색인에 있다');
  await p1;
});

test('[m24] 주기 흡수는 간격과 무관하게 인벤토리 태그까지 모은다', async () => {
  registry.importServers([{ id: 'iv2', name: 'iv2', host: 'https://10.88.0.2', username: 'root', password: 'x', serviceTag: '', vcenterId: 'vc-a' }], 'merge');
  M._resetAbsorbForTest();
  await M.absorbFleet(M.fleetServers());   // 간격 시작
  invCache.setInventory('iv2', { system: { serviceTag: 'INVWATCH2' }, collectedAt: Date.now() });
  await M.absorbFleet(M.fleetServers());
  assert.ok(!(await R.maskState()).tags.has('INVWATCH2'), '전제: 간격 안의 보통 흡수는 인벤토리를 훑지 않는다');
  const r = await M.materialWatchTick({ fileExists: async () => true });
  assert.ok(typeof r.gen === 'number', JSON.stringify(r));
  assert.ok((await R.maskState()).tags.has('INVWATCH2'), '주기 흡수(forceInv)가 모았다');
});

test('[m23] 회차 시한(5분)을 넘긴 회차는 다음 회차를 막지 않는다', async () => {
  const realNow = Date.now;
  let release; const stuck = new Promise((r) => { release = r; });
  const first = M.materialWatchTick({ fileExists: async () => { await stuck; return false; } });
  try {
    assert.deepEqual(await M.materialWatchTick({ fileExists: async () => false }), { skipped: 'running' }, '전제: 시한 안에서는 겹쳐 돌지 않는다');
    const base = realNow();
    Date.now = () => base + 5 * 60_000 + 1000;
    assert.deepEqual(await M.materialWatchTick({ fileExists: async () => false }), { skipped: 'no-ledger' }, '시한이 지난 회차의 표식은 다음 회차를 막지 않는다');
  } finally { Date.now = realNow; release(); await first; }
});

test('[m26] 원장 파일을 stat 하지 못한 오류(ENOENT 아님)는 \'없음\' 으로 넘기지 않고 경고한다(무음 실패 금지)', async () => {
  const prev = process.env.RACK_DB;
  const notDir = path.join(tmp, 'plainfile');
  fs.writeFileSync(notDir, 'x');
  process.env.RACK_DB = path.join(notDir, 'rack.db');   // 경로 중간이 파일 — ENOTDIR
  const q = quiet();
  let r;
  try { r = await M.materialWatchTick(); } finally { q.restore(); process.env.RACK_DB = prev; }
  assert.ok(r && typeof r.error === 'string' && /ENOTDIR/.test(r.error), JSON.stringify(r));
  assert.ok(q.warns.some((w) => w.includes('[rack-material]')), q.warns.join('\n'));
});

test('[m27] startMaterialWatch 를 두 번 불러도 주기 타이머는 하나', () => {
  const oi = globalThis.setInterval; let n = 0;
  globalThis.setInterval = (...a) => { n += 1; return oi(...a); };
  const ot = globalThis.setTimeout; const timeouts = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { const t = ot(() => {}, 0); timeouts.push(ms); return t; };   // 첫 회차는 돌리지 않는다
  try { M.startMaterialWatch(); M.startMaterialWatch(); } finally { globalThis.setInterval = oi; globalThis.setTimeout = ot; M.stopMaterialWatch(); }
  assert.equal(n, 1, `setInterval ${n}번`);
  assert.equal(timeouts.length, 1, `첫 회차 예약 ${timeouts.length}번`);
});

test('[m28] 주기 흡수 경고의 중복 억제는 성공하면 풀린다 — 실패 · 성공 · 같은 실패면 두 번 알린다', async () => {
  const q = quiet();
  try {
    const boom = async () => { throw new Error('watch-boom-x'); };
    await M.materialWatchTick({ fileExists: boom });
    await M.materialWatchTick({ fileExists: boom });
    assert.equal(q.warns.filter((w) => w.includes('watch-boom-x')).length, 1, '같은 사유는 한 번');
    await M.materialWatchTick({ fileExists: async () => true });
    await M.materialWatchTick({ fileExists: boom });
  } finally { q.restore(); }
  assert.equal(q.warns.filter((w) => w.includes('watch-boom-x')).length, 2, q.warns.join('\n'));
});

test('[d01] 기록 읽기에 실패하면 5초 동안은 다시 읽지 않고 바로 MaskUnavailable', async () => {
  const db = await R.openRackDb();
  R._dropMaskMemoryForTest(); M._dropIndexForTest();
  db.exec('ALTER TABLE rack_mask_seen RENAME TO rack_mask_seen_x');
  const q = quiet();
  try { await assert.rejects(R.maskState(), (e) => e instanceof R.MaskUnavailable); } finally { q.restore(); db.exec('ALTER TABLE rack_mask_seen_x RENAME TO rack_mask_seen'); }
  // 표는 고쳐졌지만 5초 안 — 다시 읽지 않는다(요청마다 실패하는 SELECT 를 반복하지 않게)
  await assert.rejects(R.maskState(), (e) => e instanceof R.MaskUnavailable);
  R._dropMaskMemoryForTest();
  assert.ok((await R.maskState()).gen > 0);
});

test('[d05] 메모리에만 둔 값(over)을 다시 흡수해도 세대를 올리지 않는다(같은 긴 값이 요청마다 색인을 다시 만들게 하지 않는다)', async () => {
  const long = `o${'z'.repeat(260)}.example`;
  const g1 = await R.maskAbsorb([long], []);
  const g2 = await R.maskAbsorb([long], []);
  assert.equal(g2, g1);
});

test('[d08] 메모리에만 두는 값(over)은 5만 개를 넘지 않는다', async () => {
  const pre = `p${'q'.repeat(250)}`;
  const vals = Array.from({ length: 50_005 }, (_, i) => `${pre}-${i}.ex`);
  await R.maskAbsorb(vals, []);
  const c = await R.maskSeenCounts();
  assert.ok(c.overflow <= 50_000, `over ${c.overflow}`);
});

test('[d13] 파일 쓰기는 잠금을 기다리지 않는다 — 다른 연결이 쓰기 잠금을 쥐고 있어도 응답 뒤 쓰기가 이벤트 루프를 막지 않는다', async () => {
  const other = new DatabaseSync(process.env.RACK_DB);
  other.exec('PRAGMA busy_timeout = 0'); other.exec('BEGIN IMMEDIATE');
  const q = quiet();
  let ms;
  try {
    await R.maskAbsorb(['lock-wait.example'], []);
    const t0 = performance.now();
    await tick();
    ms = performance.now() - t0;
  } finally { q.restore(); other.exec('ROLLBACK'); other.close(); }
  assert.ok(ms < 1000, `쓰기 시도가 ${Math.round(ms)}ms 막았다`);
  assert.ok(q.warns.some((w) => w.includes('가림 재료를 파일에 남기지 못했습니다')), '실패는 알린다');
  R._flushMaskForTest();
});

test('[d14] 파일 쓰기 뒤 연결의 busy_timeout 을 원래 값으로 되돌린다(다른 쓰기가 잠금을 기다리지 못하게 되지 않게)', async () => {
  const db = await R.openRackDb();
  const before = db.prepare('PRAGMA busy_timeout').get().timeout;
  assert.ok(before > 0, `전제: ${before}`);
  await R.maskAbsorb(['busy-restore.example'], []);
  await tick(); await tick();
  assert.equal((await R.maskSeenCounts()).pending, 0, '전제: 썼다');
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, before);
});

test('[d16 · d19] 파일 쓰기는 2,000행씩 나눠 하고, 남은 조각은 이어서 쓴다', async () => {
  R._flushMaskForTest();
  await R.maskAbsorb(Array.from({ length: 5000 }, (_, i) => `chunk-${i}.ex`), []);
  assert.equal((await R.maskSeenCounts()).pending, 5000);
  await tick();
  assert.equal((await R.maskSeenCounts()).pending, 3000, '한 번에 2,000행');
  for (let i = 0; i < 6; i += 1) await tick();
  assert.equal((await R.maskSeenCounts()).pending, 0, '남은 조각도 이어서');
});

test('[d17 · d48] 파일 쓰기 실패 뒤 다시 시도 간격은 30초부터 두 배 · 성공하면 처음부터', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec("CREATE TRIGGER r7_boom BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7 boom'); END;");
  const ot = globalThis.setTimeout; const delays = []; let pendingFn = null;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 30_000) { delays.push(ms); pendingFn = fn; const t = ot(() => {}, 2 ** 31 - 1); t.unref(); return t; } return ot(fn, ms, ...rest); };   // 진짜 타이머(멈춰 둔 것)를 돌려준다 — 가짜 객체는 clearImmediate 가 즉시 실행 대기 수를 깨뜨린다
  const fire = () => { const f = pendingFn; pendingFn = null; assert.equal(typeof f, 'function', `전제: 미룬 시도가 있다 ${JSON.stringify(delays)}`); f(); };
  const q = quiet();
  try {
    await R.maskAbsorb(['backoff-1.example'], []);
    await tick();                 // 첫 시도 실패 → 30초
    assert.equal(typeof pendingFn, 'function', `전제: 첫 실패가 30초 뒤로 미뤘다 ${JSON.stringify(delays)} · warns=${q.warns.length}`);
    fire();                       // 시각이 된 것처럼 — 다시 실패 → 60초
    fire();                       // → 120초
    db.exec('DROP TRIGGER r7_boom');
    fire();                       // 성공
    assert.equal((await R.maskSeenCounts()).pending, 0);
    db.exec("CREATE TRIGGER r7_boom BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7 boom'); END;");
    await R.maskAbsorb(['backoff-2.example'], []);
    await tick();                 // 성공 뒤 첫 실패 → 다시 30초
  } finally { globalThis.setTimeout = ot; q.restore(); try { db.exec('DROP TRIGGER r7_boom'); } catch { /* */ } }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 30_000]);
  R._flushMaskForTest();
  assert.equal((await R.maskSeenCounts()).pending, 0);
});

test('[d20] 관리 목록(mask-seen)은 아직 파일에 못 쓴 값도 보여 준다(pending)', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec("CREATE TRIGGER r7_boom2 BEFORE INSERT ON rack_mask_seen BEGIN SELECT RAISE(ABORT, 'r7 boom'); END;");
  const q = quiet();
  let rows;
  try {
    await R.maskAbsorb(['pending-row.example'], []);
    await tick();
    rows = await R.maskSeenRows();
  } finally { q.restore(); db.exec('DROP TRIGGER r7_boom2'); }
  const row = rows.find((x) => x.key === 'pending-row.example');
  assert.ok(row && row.pending === true, JSON.stringify(row));
  R._flushMaskForTest();
});

test('[d21] 관리 목록은 기록 5,000행을 넘어도 전부 센다', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES ('t', ?, 5)");
  for (let i = 0; i < 6000; i += 1) ins.run(`ROWS${String(i).padStart(5, '0')}`);
  db.exec('COMMIT');
  const rows = await R.maskSeenRows();
  assert.ok(rows.filter((x) => /^ROWS\d{5}$/.test(x.key)).length === 6000, `${rows.length}`);
});

test('[d22] 아직 파일에 못 쓴 값을 지우면 나중에 파일에 쓰이지 않는다(다시 띄워도 되살아나지 않는다)', async () => {
  R._flushMaskForTest();
  await R.maskAbsorb(['forget-pending.example'], []);
  assert.equal((await R.maskSeenCounts()).pending, 1, '전제: 파일에 아직');
  assert.equal(await R.maskForget([{ kind: 'h', key: 'forget-pending.example' }]), 1);
  R._flushMaskForTest();
  restart();
  assert.ok(!(await R.maskState()).hosts.has('forget-pending.example'), '되살아났다');
});

test('[d23] 메모리에만 둔 값(over)도 지운다', async () => {
  const long = `f${'g'.repeat(260)}.example`;
  await R.maskAbsorb([long], []);
  assert.ok((await R.maskState()).overHosts.has(long));
  assert.equal(await R.maskForget([{ kind: 'h', key: long }]), 1);
  assert.ok(!(await R.maskState()).overHosts.has(long));
});

test('[d24] 지우면 세대가 올라 색인이 그 자리에서 바뀐다(다시 띄우지 않아도 지운 값은 가리지 않는다)', async () => {
  await R.maskAbsorb(['forget-now.example'], []);
  const pid = await place('kvm forget-now.example', 21);
  assert.match(await labelOf(OP_A, pid), /^kvm \(주소 가림\)$/);
  const g0 = (await M.materialIndex()).gen;
  const f = await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'forget-now.example' }] });
  assert.equal(f.body.removed, 1, JSON.stringify(f.body));
  assert.ok((await M.materialIndex()).gen > g0);
  assert.equal(await labelOf(OP_A, pid), 'kvm forget-now.example');
});

test('[d36] seenKeys 판이 1(폭에 무관한 키 전)인 원장을 열면 시리얼 기록을 다시 채워 접은 키를 더한다', async () => {
  // 원장에 전각 시리얼 장비(이 판 이전에 저장된 값) · 기록 표에는 옛 키(접지 않은 키)만 · 판 번호 1 — 업그레이드 직전 원장을 SQL 로 만든다
  const pid = await place('old wide', 23, { serial: 'TMPW0001' });
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_place SET serial = 'ＷＩＤＥ０００９', serial_key = 'ｗｉｄｅ０００９' WHERE id = ?").run(pid);   // 이 판이 나오기 전에 저장된 전각 시리얼(옛 키)
  await R._resyncForTest();
  db.exec("DELETE FROM rack_serial_seen WHERE key LIKE '%wide%' OR key LIKE '%ｗｉｄｅ%'");
  db.prepare("INSERT OR IGNORE INTO rack_serial_seen (corp_id, key) VALUES ('kr', 'ｗｉｄｅ０００９')").run();
  db.prepare("UPDATE rack_meta SET v = 1 WHERE k = 'seenKeys'").run();
  restart();
  const keys = (await R.openRackDb()).prepare("SELECT key FROM rack_serial_seen WHERE corp_id = 'kr'").all().map((x) => x.key);
  assert.ok(keys.includes('wide0009'), `접은 키가 없다: ${keys.filter((k) => /wide|ｗｉｄｅ/.test(k))}`);
});

test('[d37] 집계용 corpTexts 는 전산실마다 양보한다', async () => {
  let n = 0;
  const t = await R.corpTexts('kr', { pause: async () => { n += 1; } });
  assert.ok(t.places > 0);
  assert.ok(n >= 1, `양보 ${n}번`);
});

test('[d44] first_seen 칸이 없는 옛 기록 표를 열면 칸을 더해 쓰기 · 관리 목록이 돈다', async () => {
  R._flushMaskForTest();
  R._closeForTest();
  const raw = new DatabaseSync(process.env.RACK_DB);
  raw.exec('DROP TABLE rack_mask_seen');
  raw.exec('CREATE TABLE rack_mask_seen (kind TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (kind, key)) WITHOUT ROWID');
  raw.exec("INSERT INTO rack_mask_seen (kind, key) VALUES ('h', 'legacy-row.example')");
  raw.close();
  R._dropMaskMemoryForTest(); M._dropIndexForTest();
  await R.openRackDb();
  await R.maskAbsorb(['after-migrate.example'], []);
  await tick(); await tick();
  assert.equal((await R.maskSeenCounts()).pending, 0, '새 값을 파일에 썼다');
  const rows = await R.maskSeenRows();
  assert.ok(rows.some((x) => x.key === 'legacy-row.example') && rows.some((x) => x.key === 'after-migrate.example'));
  restart();
  const st = await R.maskState();
  assert.ok(st.hosts.has('legacy-row.example') && st.hosts.has('after-migrate.example'));
});
