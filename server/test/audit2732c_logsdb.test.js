/**
 * v2.732(점검 2회차 그룹 c) — vCenter 이벤트 로그 DB 의 **적재 양보(B6-01)** · **조회 조각(B6-03)**.
 *
 * B6-01: 로그 폴러가 vCenter 마다 한 트랜잭션(최대 5,000행)을 양보 없이 이어 붙여 따라잡기 주기마다 약 2.4초 멈췄다(재현 28×5,000).
 *   insertManyAsync 는 같은 결과를 **조각 트랜잭션 + COMMIT 뒤 양보**로 넣는다. 조각은 'ts 가 바뀌는 안전 지점' 에서만 자른다
 *   (조각 COMMIT 직후 크래시해도 다음 수집 sinceTs = MAX(ts)+1 이 같은 ts 묶음의 나머지를 건너뛰지 않게) — tsSafeChunks 의 성질을 고정한다.
 * B6-03: 미보호 VM 리포트가 'Snapshot' 4열 LIKE 로 조회 창 전체를 한 문장으로 훑었다(합성 7일 80만 행 431ms · 범위 계정 693ms).
 *   queryAsync 는 query(f, limit, 0) 과 **같은 행·같은 순서**를 1시간 조각(최신부터) + 시간 기준 양보로 읽는다.
 * ⚠ 성능 단언은 절대 ms 가 아니라 **비율·조각 수**다(CPU 가 바뀌어도 회귀와 갈리게). 큰 배열은 isDeepStrictEqual + assert.ok 로 본다
 *   (deepStrictEqual 의 actual 로 수만 행을 넘기면 실패 보고기가 직렬화하다 메모리로 죽는다 — CLAUDE.md v2.731).
 * ⚠ 기준 시각은 Date.now() 가 아니라 정시에서 떨어뜨린 고정값(CLAUDE.md v2.517).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2732c-logsdb-'));
process.env.CONFIG_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { getLogsDb, resetLogsDb, tsSafeChunks } = await import('../src/logs/db.js');
const { saveLogSettings, _resetLogSettingsForTest } = await import('../src/logs/settings.js');

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_790_000_000_000 / H) * H - 30 * 60_000;   // 정시 −30분(고정)

/** 저장 디렉터리를 바꿔 새 DB 파일을 연다(같은 프로세스에서 두 DB 를 비교하려고). */
async function openDbAt(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  _resetLogSettingsForTest();
  saveLogSettings({ storagePath: dir });
  resetLogsDb();
  const db = await getLogsDb();
  assert.equal(db.kind, 'sqlite', 'node:sqlite 가 있어야 이 시험이 뜻이 있다');
  return db;
}

/**
 * setImmediate 프로브 — 그 동안 이벤트 루프가 가장 오래 멈춘 시간과 틱 수.
 * ⚠ 단언이 stop() 전에 던지면 프로브가 끝없이 돌아 프로세스가 끝나지 않는다(변이 검증에서 실제로 그랬다) —
 *   열린 프로브는 전부 after() 가 끄고, 스스로도 60초 뒤 멈춘다.
 */
const openProbes = new Set();
after(() => { for (const off of openProbes) off(); });
function probe() {
  let max = 0; let ticks = 0; let last = performance.now(); let on = true;
  const t = () => { const n = performance.now(); max = Math.max(max, n - last); last = n; ticks++; if (on) setImmediate(t); };
  setImmediate(t);
  const off = () => { on = false; clearTimeout(kill); openProbes.delete(off); };
  const kill = setTimeout(off, 60_000); kill.unref?.();
  openProbes.add(off);
  return () => { off(); return { max, ticks }; };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

// ── tsSafeChunks — 성질 고정 ────────────────────────────────────────────────
test('B6-01 ① tsSafeChunks: 자르는 지점마다 "앞의 최대 ts < 뒤의 최소 ts" · 이어 붙이면 전체 · 순서를 바꾸지 않는다', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rnd() * 400);
    const rows = [];
    let ts = 1_000;
    for (let i = 0; i < n; i++) {
      if (rnd() < 0.7) ts += Math.floor(rnd() * 3);   // 같은 ts 묶음이 자주 생긴다
      // 가끔 순서가 어긋난 행(늦게 온 옛 이벤트)
      rows.push({ ts: rnd() < 0.03 ? ts - Math.floor(rnd() * 50) : ts });
    }
    const per = 1 + Math.floor(rnd() * 60);
    const parts = tsSafeChunks(rows, per);
    assert.equal(parts[0][0], 0);
    assert.equal(parts[parts.length - 1][1], n);
    for (let k = 1; k < parts.length; k++) {
      assert.equal(parts[k][0], parts[k - 1][1], '구간이 이어져야 한다');
      const cut = parts[k][0];
      const preMax = Math.max(...rows.slice(0, cut).map((r) => r.ts));
      const sufMin = Math.min(...rows.slice(cut).map((r) => r.ts));
      assert.ok(preMax < sufMin, `안전하지 않은 자르기(trial ${trial}): 앞 최대 ${preMax} ≥ 뒤 최소 ${sufMin}`);
      assert.ok(parts[k - 1][1] - parts[k - 1][0] >= per, '조각은 최소 행 수를 채운 뒤에만 자른다');
    }
  }
});

test('B6-01 ② tsSafeChunks: 같은 ts 가 끝까지 이어지면 자르지 않는다 · 숫자가 아닌 ts 를 넘어서는 자르지 않는다 · 정렬된 입력은 실제로 나눈다', () => {
  const same = Array.from({ length: 50 }, () => ({ ts: 7 }));
  assert.deepEqual(tsSafeChunks(same, 10), [[0, 50]]);
  const sorted = Array.from({ length: 50 }, (_, i) => ({ ts: i }));
  assert.equal(tsSafeChunks(sorted, 10).length, 5);
  // 숫자가 아닌 ts(25번)가 있으면 그 행의 앞(뒤에 판정 불가 행이 남는다)도 뒤(앞에 판정 불가 행이 있다)도 자르지 않는다 — 한 조각
  const bad = sorted.map((r, i) => (i === 25 ? { ts: null } : r));
  assert.deepEqual(tsSafeChunks(bad, 10), [[0, 50]]);
  // 순서가 어긋난 늦은 행(뒤쪽에 옛 ts)이 있으면 그 행보다 큰 ts 를 넣은 뒤로는 그 행 앞에서 자르지 않는다
  const late = Array.from({ length: 40 }, (_, i) => ({ ts: i }));
  late.push({ ts: 5 });
  for (const [a] of tsSafeChunks(late, 4).slice(1)) assert.ok(a <= 6, `늦은 행(ts 5)을 남겨 둔 채 ts>5 를 먼저 넣었다: 자르기 ${a}`);
  assert.deepEqual(tsSafeChunks([], 10), []);
});

// ── insertManyAsync — insertMany 와 같은 결과 + 이벤트 루프 양보 ─────────────────
/** vCenter 마다 한 배열(폴러가 넘기는 모양 — 한 호출 = 한 vCenter · 오래된 것부터). */
function makeRowsPerVc() {
  const out = [];
  const types = ['UserLoginSessionEvent', 'VmPoweredOnEvent', 'VmReconfiguredEvent', 'TaskEvent', 'VmMigratedEvent'];
  for (let v = 0; v < 8; v++) {
    const rows = [];
    for (let i = 0; i < 5_000; i++) {
      // ts 는 오름차순 + 같은 ts 묶음(3행씩)
      const ts = NOW - 7 * DAY + Math.floor(i / 3) * 60_000;
      rows.push({ vcenterId: `vc-${v}`, key: `${v}-${i}`, ts, severity: i % 11 ? 'info' : 'warning', type: types[i % types.length],
        user: 'VSPHERE.LOCAL\\svc', entity: `vm-${i % 300}`, message: `event ${v}-${i} on vm-${i % 300} with some longer message text`, detail: i % 4 ? null : JSON.stringify({ i }) });
      // 같은 배치 안 중복 키(같은 ts 자리) — INSERT OR IGNORE 의 첫 행 우선이 두 판에서 같아야 한다
      if (i === 10) rows.push({ ...rows[rows.length - 1], message: 'duplicate key — must be ignored' });
    }
    out.push(rows);
  }
  return out;
}

test('B6-01 ③ insertManyAsync: insertMany 와 같은 행·같은 순서(rowid 포함) · 조각이 여럿 · 최장 정지가 한 트랜잭션 판의 1/4 미만', async () => {
  const perVc = makeRowsPerVc();
  const total = perVc.reduce((n, r) => n + r.length, 0);
  const a = await openDbAt('ins-sync');
  await settle();
  let stop = probe();
  await new Promise((r) => setImmediate(r));
  for (const rows of perVc) a.insertMany(rows);   // 예전 폴러 — vCenter 마다 한 트랜잭션, 사이 양보 없음
  await settle();
  const sync = stop();
  const resA = a.query({}, 50_000, 0);
  const countA = a.count({});

  const b = await openDbAt('ins-async');
  assert.equal(typeof b.insertManyAsync, 'function', '조각 적재 API 가 있어야 한다');
  await settle();
  stop = probe();
  let chunks = 0;
  for (const rows of perVc) chunks += (await b.insertManyAsync(rows)).chunks;
  await settle();
  const asy = stop();
  const resB = b.query({}, 50_000, 0);

  assert.equal(b.count({}), countA, '행 수가 같아야 한다');
  assert.equal(countA, total - perVc.length, 'vCenter 마다 중복 키 1행은 무시된다');
  assert.ok(isDeepStrictEqual(resA, resB), '조회 결과(ts DESC, rowid DESC 순서 포함)가 한 트랜잭션 판과 같아야 한다');
  assert.ok(resB.every((x) => x.message !== 'duplicate key — must be ignored'), '첫 행 우선(INSERT OR IGNORE) 그대로');
  assert.ok(chunks > perVc.length * 3, `조각으로 나눠 넣어야 한다(조각 ${chunks})`);
  assert.ok(asy.ticks > 3, `적재 중에 이벤트 루프가 돌아야 한다(틱 ${asy.ticks})`);
  assert.ok(asy.max < sync.max / 4, `최장 정지가 줄어야 한다: 조각 ${asy.max.toFixed(1)}ms vs 한 번에 ${sync.max.toFixed(1)}ms`);
});

test('B6-01 ④ insertManyAsync: 조각 하나가 실패하면 그 조각만 되돌리고 던진다 — 앞 조각은 남고, 남은 행은 모두 MAX(ts) 보다 뒤(다음 수집이 다시 읽는다)', async () => {
  const db = await openDbAt('ins-fail');
  const rows = Array.from({ length: 3_000 }, (_, i) => ({ vcenterId: 'vc-f', key: `f${i}`, ts: NOW - DAY + Math.floor(i / 3) * 1_000, severity: 'info', type: 'TaskEvent', user: 'u', entity: 'e', message: `m${i}` }));   // 같은 ts 3행 묶음 — 500행 경계가 묶음 한가운데에 걸린다
  rows[2_500] = { ...rows[2_500], entity: { notBindable: true } };   // 바인딩 불가 값 — 이 행이 든 조각에서 던진다(OR IGNORE 로도 넘어가지 않는다)
  await assert.rejects(() => db.insertManyAsync(rows, { chunkRows: 500 }));
  const last = db.lastTs('vc-f');
  const stored = db.count({ vcenterId: 'vc-f' });
  assert.ok(stored > 0 && stored < rows.length, `앞 조각은 들어가 있어야 한다(${stored})`);
  // 들어가지 못한 행 중 ts 가 MAX(ts) 이하인 것이 없어야 한다 — 있으면 다음 수집(sinceTs = MAX+1)이 영영 건너뛴다
  const have = new Set(db.query({ vcenterId: 'vc-f' }, 10_000, 0).map((r) => r.message));
  const lost = rows.filter((r) => !have.has(r.message) && r.ts <= last);
  assert.equal(lost.length, 0, `MAX(ts)=${last} 이하인데 들어가지 못한 행 ${lost.length}개`);
});

// ── queryAsync — query(f, limit, 0) 과 같은 결과 + 조각 사이 양보 ─────────────────
let qdb = null;
async function queryDb() {
  if (qdb) return qdb;
  qdb = await openDbAt('query');
  const types = ['TaskEvent', 'UserLoginSessionEvent', 'UserLogoutSessionEvent', 'VmPoweredOnEvent', 'AlarmStatusChangedEvent', 'VmReconfiguredEvent', 'EventEx'];
  const PER_DAY = 40_000; const DAYS = 8; const total = PER_DAY * DAYS;
  let batch = [];
  for (let i = 0; i < total; i++) {
    const snap = i % 50 === 0;
    // 1시간 경계에 정확히 걸린 행 + 같은 ts 묶음을 일부러 만든다(조각 경계에서 순서가 갈리지 않는지)
    let ts = NOW - DAYS * DAY + Math.floor(i * (DAYS * DAY / total));
    if (i % 997 === 0) ts = Math.floor(ts / H) * H;
    batch.push({ vcenterId: `vc-${i % 28}`, key: `k${i}`, ts, severity: i % 13 ? 'info' : 'error', type: snap ? 'TaskEvent' : types[i % types.length],
      user: snap ? 'DOMAIN\\svc-backup' : 'VSPHERE.LOCAL\\Administrator', entity: `vm-${i % 6000}`,
      message: snap ? `Task: Create virtual machine snapshot vm-${i % 6000}` : `User logged in as pyvmomi session ${i}` });
    if (batch.length === 20_000) { qdb.insertMany(batch); batch = []; }
  }
  // 같은 ts(경계) 묶음 + vCenter 시계가 앞선 미래 이벤트(맨 위 조각은 위가 열려 있어야 한다)
  for (let j = 0; j < 40; j++) batch.push({ vcenterId: `vc-${j % 28}`, key: `tie${j}`, ts: NOW - 3 * H, severity: 'info', type: 'TaskEvent', user: 'DOMAIN\\svc-backup', entity: `vm-t${j}`, message: 'Task: Create virtual machine snapshot tie' });
  for (let j = 0; j < 30; j++) batch.push({ vcenterId: `vc-${j % 28}`, key: `fut${j}`, ts: NOW + (j + 1) * 7 * 60_000, severity: 'info', type: 'TaskEvent', user: 'DOMAIN\\svc-backup', entity: `vm-f${j}`, message: 'Task: Create virtual machine snapshot future' });
  qdb.insertMany(batch);
  return qdb;
}

test('B6-03 ① queryAsync: 관리자·범위·기간·심각도·until·상한 조합에서 query 와 같은 행·같은 순서(미래 ts·같은 ts 경계 포함)', async () => {
  const db = await queryDb();
  assert.equal(typeof db.queryAsync, 'function', '조각 조회 API 가 있어야 한다');
  const scoped = Array.from({ length: 14 }, (_, i) => `vc-${i * 2}`);
  const cases = [
    [{ q: 'Snapshot', since: NOW - 7 * DAY }, 20_000],
    [{ q: 'Snapshot', since: NOW - 30 * DAY }, 20_000],
    [{ q: 'Snapshot', since: NOW - 7 * DAY, vcenterIds: scoped }, 20_000],
    [{ q: 'Snapshot', since: NOW - 7 * DAY, vcenterIds: [] }, 20_000],
    [{ q: 'Snapshot', since: NOW - 2 * DAY, vcenterId: 'vc-3' }, 20_000],
    [{ q: 'Snapshot', since: NOW - 7 * DAY, until: NOW - 2 * DAY }, 20_000],
    [{ q: 'Snapshot', since: NOW - 7 * DAY }, 50],          // 상한이 첫 조각들 안에서 찬다
    [{ severity: 'error', since: NOW - 3 * DAY }, 20_000],
    [{ q: 'session 1', since: NOW - DAY }, 300],
    [{ q: 'no-such-text-anywhere', since: NOW - 7 * DAY }, 20_000],
    [{ q: 'snapshot tie', since: NOW - 3 * H }, 20_000],    // 창 하한 = 같은 ts 묶음
    [{ q: 'Snapshot' }, 500],                                // since 없음 — 한 문장 판 그대로
  ];
  for (const [f, lim] of cases) {
    const one = db.query(f, lim, 0);
    const sl = await db.queryAsync(f, lim, { now: NOW });
    assert.ok(isDeepStrictEqual(one, sl), `결과가 달라졌다: ${JSON.stringify(f)} lim ${lim} — 한 문장 ${one.length}행 vs 조각 ${sl.length}행`);
  }
  // 미래 ts 행이 실제로 결과에 들어 있는 경우를 하나는 확인한다(맨 위 조각이 위로 열려 있다)
  const fut = await db.queryAsync({ q: 'snapshot future', since: NOW - DAY }, 1000, { now: NOW });
  assert.equal(fut.length, 30, '시계가 앞선 이벤트도 빠지지 않는다');
});

test('B6-03 ② queryAsync: 조각 사이에서 이벤트 루프가 돈다 · 최장 정지가 한 문장 판의 1/4 미만(관리자·범위 계정)', async () => {
  const db = await queryDb();
  const scoped = Array.from({ length: 14 }, (_, i) => `vc-${i * 2}`);
  for (const extra of [{}, { vcenterIds: scoped }]) {
    const f = { q: 'Snapshot', since: NOW - 7 * DAY, ...extra };
    await settle();
    let stop = probe();
    await new Promise((r) => setImmediate(r));
    db.query(f, 20_000, 0);
    await settle();
    const one = stop();
    stop = probe();
    await db.queryAsync(f, 20_000, { now: NOW });
    await settle();
    const sl = stop();
    assert.ok(sl.ticks > 5, `조각 사이에서 양보해야 한다(틱 ${sl.ticks})`);
    assert.ok(sl.max < one.max / 4, `최장 정지: 조각 ${sl.max.toFixed(1)}ms vs 한 문장 ${one.max.toFixed(1)}ms (${JSON.stringify(extra).slice(0, 40)})`);
  }
});
