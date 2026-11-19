/**
 * v2.932(최근 변경 점검 E1-02 · E1-03 · E1-04) — 베어메탈 사용률 적재·보정·이관의 이벤트 루프 정지.
 *  ① 재집계 코어(aggregateRows)는 예전 판본과 결과가 같다(행 × 열 문자열 열쇠를 없앴다 — 순서·비교 규칙 그대로)
 *  ② 보정(repairPending)은 원시 SELECT * + 예전 집계와 같은 롤업을 쓰고, 버킷·날 사이에 실제로 양보한다(setImmediate 가 끼어든다)
 *  ③ 시간 상한: 한 실행에 적어도 한 묶음 · 남은 대기는 deferred 로 다음 실행이 잇는다(나눠 해도 결과가 같다)
 *  ④ 같은 롤업 파일이 잇달아 실패하면 한 실행에 한 번만 열고 · 재시도 간격을 늘리고 · 상태(backoff · repeatFail · ok:false)에 밝힌다
 *  ⑤ insertUsage 조각 적재: 한 번에 넣은 것과 모든 파일·표의 행이 같다 · 조각 사이에 양보한다 · 그 사이 읽는 쪽은 서버마다 ‘전부 아니면 전무’ 만 본다
 *  ⑥ 장치 목록 ord: 서버·종류마다 한 번 읽는 판본이 예전 SQL(행마다 SELECT 1 + MAX(ord)) 판본과 같은 ord 를 준다
 *  ⑦ 마이그레이션 청크 하나 안에서도 양보한다(예전에는 청크 사이에서만) · 끝까지 가면 1시간 표본 수가 예전 행 수와 같다
 * 시간 수치는 단언하지 않는다(CI 에서 흔들린다) — 구조(끼어든 횟수 · 같은 결과)로 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sw2932bm-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const DAY = 86_400_000;
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨린다(고정 epoch · Date.now() 직접 둘 다 금지 — common.md)
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const { config } = await import('../src/config.js');
const db = await import('../src/bmusage/db.js');
const month = await import('../src/bmusage/monthStore.js');
const { PERF_COL_NAMES, PEAK_COLS, DEVICE_COL_NAMES } = await import('../src/bmusage/perfCols.js');
const { dayKey, dayIndex, dayStartMs } = await import('../src/util/dayKey.js');
const { numOrNull: n } = await import('../src/util/numOrNull.js');
const { DatabaseSync } = await import('node:sqlite');

function useDir(dir) {
  db._resetForTest();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  config.dbDir = dir;
}
/** 결정적 의사난수(LCG) */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const PSRC = ['window10', 'sampler', 'psi', 'none', null];
function mkRow(r, key, ts) {
  const v = () => { const x = r(); return x < 0.12 ? null : x < 0.16 ? '' : x < 0.2 ? String(Math.round(x * 1000) / 10) : Math.round(x * 10_000) / 100; };
  const o = { key, ts, name: `bm-${key}${r() < 0.2 ? '-x' : ''}`, vcenterId: 'vc1', src: 'os', peak_src: PSRC[Math.floor(r() * PSRC.length)] };
  for (const { col } of month.ROLL) o[col] = v();
  if (r() < 0.5) for (const c of PEAK_COLS) if (r() < 0.6) { o[`${c}_peak`] = Math.round(r() * 10_000) / 100; o[`${c}_peak_at`] = ts - Math.floor(r() * 300_000); }
  return o;
}
/* 예전(v2.926) aggregateRows 판본 그대로 — 대조 기준 */
function refAggregateRows(rows, { agent, key, bucketCol, bucket, rolls }) {
  const hasPeak = (r) => PEAK_COLS.some((c) => n(r[`${c}_peak`]) != null);
  const sorted = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  const last = sorted.at(-1) || {};
  const o = { agent, key, [bucketCol]: bucket, name: String(last.name || ''), vcenter_id: String(last.vcenter_id ?? last.vcenterId ?? ''), samples: sorted.length,
    last_ts: last.ts == null ? null : Number(last.ts), peak_samples: 0, peak_src: null };
  for (const { p } of rolls) { o[`${p}_sum`] = 0; o[`${p}_n`] = 0; o[`${p}_max`] = null; }
  for (const c of PEAK_COLS) { o[`${c}_peak`] = null; o[`${c}_peak_at`] = null; }
  for (const r of sorted) {
    const hp = hasPeak(r);
    if (hp) o.peak_samples += 1;
    o.peak_src = month.mergePeakSrc(o.peak_src, r.peak_src ? String(r.peak_src) : null, hp);
    for (const { col, p } of rolls) {
      const v = n(r[col]);
      if (v == null) continue;
      o[`${p}_sum`] += v; o[`${p}_n`] += 1;
      if (o[`${p}_max`] == null || v > o[`${p}_max`]) o[`${p}_max`] = v;
    }
    for (const c of PEAK_COLS) {
      const v = n(r[`${c}_peak`]);
      if (v != null && (o[`${c}_peak`] == null || v > o[`${c}_peak`])) { o[`${c}_peak`] = v; o[`${c}_peak_at`] = n(r[`${c}_peak_at`]); }
    }
  }
  return o;
}
/** fn 이 도는 동안 setImmediate 가 몇 번 끼어드나(양보가 없으면 0). */
async function interleaves(fn, onTick = null) {
  let ticks = 0; let stop = false;
  const spin = () => { if (stop) return; ticks += 1; if (onTick) onTick(); setImmediate(spin); };
  setImmediate(spin);
  const r = await fn();
  stop = true;
  return { r, ticks };
}
/** 어제(포탈 시각) 하루 안의 정시 — 두 시간 버킷이 같은 날에 들도록. */
const DAY0 = dayStartMs(dayIndex(BASE - DAY));
const H10 = DAY0 + 10 * HOUR; const H11 = DAY0 + 11 * HOUR;
/** 서버 S대 · 08~09시는 정상 적재(롤업 포함) · 10~11시는 원시만 + 보정 대기(1일 포함) — 롤업 실패 뒤의 상태. */
async function seedPending(S, { seed = 7, normal = true } = {}) {
  const r = rng(seed);
  const keys = Array.from({ length: S }, (_, i) => `K${i}`);
  if (normal) for (let i = 0; i < 24; i++) await month.writeServerRows(keys.map((k) => mkRow(r, k, DAY0 + 8 * HOUR + i * 300_000)), '');
  for (let i = 0; i < 24; i++) await month.writeServerRows(keys.map((k) => mkRow(r, k, H10 + i * 300_000)), '', { rollup: false, pend: 'inserted', pendDaily: true });
  return keys;
}
/** 원시 SELECT * + 예전 집계로 기대 롤업을 만든다. */
async function expected(keys) {
  const out = { h1: new Map(), d1: new Map() };
  const D1_ROLLS = [{ col: 'cpu_pct', p: 'cpu' }, { col: 'mem_pct', p: 'mem' }, ...month.ROLL.filter(({ col }) => col !== 'cpu_pct' && col !== 'mem_pct')];
  await month.withPeriodFile('raw', month.periodKeyOf('raw', H10), {}, (raw) => {
    const sel = raw.prepare('SELECT * FROM usage_history WHERE agent=? AND key=? AND ts>=? AND ts<?');
    for (const k of keys) {
      for (const h of [H10, H11]) out.h1.set(`${k}|${h}`, refAggregateRows(sel.all('', k, h, h + HOUR), { agent: '', key: k, bucketCol: 'h', bucket: h, rolls: month.ROLL }));
      out.d1.set(k, refAggregateRows(sel.all('', k, DAY0, DAY0 + DAY), { agent: '', key: k, bucketCol: 'day', bucket: dayKey(H10), rolls: D1_ROLLS }));
    }
  });
  return out;
}
async function assertRollupsEqual(keys, exp, label) {
  for (const k of keys) {
    for (const h of [H10, H11]) {
      const row = await month.withPeriodFile('h1', month.periodKeyOf('h1', h), {}, (d) => d.prepare('SELECT * FROM usage_hourly WHERE agent=? AND key=? AND h=?').get('', k, h));
      const e = exp.h1.get(`${k}|${h}`);
      assert.ok(row, `${label}: 1시간 행 없음 ${k}@${h}`);
      for (const c of Object.keys(e)) assert.equal(row[c], e[c], `${label}: 1시간 ${k}@${h} ${c}`);
    }
    const row = await month.withPeriodFile('d1', dayKey(H10).slice(0, 4), {}, (d) => d.prepare('SELECT * FROM usage_daily WHERE agent=? AND key=? AND day=?').get('', k, dayKey(H10)));
    const e = exp.d1.get(k);
    assert.ok(row, `${label}: 1일 행 없음 ${k}`);
    for (const c of Object.keys(e)) assert.equal(row[c], e[c], `${label}: 1일 ${k} ${c}`);
  }
}

/* ── ① ─────────────────────────────────────────────────────────────── */
test('① aggregateRows — 예전 판본(행 × 열 문자열 열쇠)과 결과가 같다(null·빈 문자열·숫자 문자열·피크·출처 섞임 · 빈 입력 · 다른 rolls)', () => {
  const r = rng(11);
  const rollsB = [month.ROLL[1], month.ROLL[0], ...month.ROLL.slice(2)];
  for (let t = 0; t < 40; t++) {
    const rows = Array.from({ length: Math.floor(r() * 30) }, (_, i) => mkRow(r, 'A', BASE - Math.floor(r() * 50) * 300_000 - i));
    for (const rolls of [month.ROLL, rollsB]) {
      const arg = { agent: 'ag', key: 'A', bucketCol: t % 2 ? 'h' : 'day', bucket: t, rolls };
      assert.deepEqual(month.aggregateRows(rows, arg), refAggregateRows(rows, arg), `t=${t}`);
    }
  }
  // 재집계 SELECT 열은 원시 표에 모두 있고, 집계가 읽는 열(롤업·피크)을 빠짐없이 담는다
  const raw = new DatabaseSync(':memory:'); raw.exec(month.SCHEMA.raw);
  const have = new Set(raw.prepare('PRAGMA table_info(usage_history)').all().map((x) => x.name)); raw.close();
  for (const c of month.REPAIR_SRC_COLS) assert.ok(have.has(c), c);
  for (const c of ['ts', 'name', 'vcenter_id', 'peak_src', ...month.ROLL.map(({ col }) => col), ...PEAK_COLS.flatMap((c) => [`${c}_peak`, `${c}_peak_at`])]) assert.ok(month.REPAIR_SRC_COLS.includes(c), c);
});

/* ── ② ─────────────────────────────────────────────────────────────── */
test('② 보정 — 원시 SELECT * + 예전 집계와 같은 1시간·1일 롤업 · 대기를 다 지운다 · 버킷·날 사이에 setImmediate 가 끼어든다(양보 없으면 0)', async () => {
  useDir(path.join(DIR, 'r2a'));
  const keys = await seedPending(10);
  assert.equal(await month.pendingCount(), 20);
  const exp = await expected(keys);
  const a = await interleaves(() => month.repairPending({ sliceMs: 0.001 }));
  assert.equal(a.r.buckets, 20); assert.equal(a.r.days, 10); assert.equal(a.r.errors.length, 0); assert.equal(a.r.deferred, 0);
  assert.equal(await month.pendingCount(), 0);
  await assertRollupsEqual(keys, exp, '양보 판본');
  assert.ok(a.ticks >= 10, `버킷·날 사이 양보가 있어야 한다(끼어든 횟수 ${a.ticks})`);
  // 같은 입력 · 양보 간격을 아주 길게 → 끼어들지 않는다(위 끼어듦이 양보 때문임을 확인)
  useDir(path.join(DIR, 'r2b'));
  const keysB = await seedPending(10);
  const expB = await expected(keysB);
  const b = await interleaves(() => month.repairPending({ sliceMs: 1e9 }));
  assert.ok(b.ticks <= 1, `양보 간격이 길면 끼어들지 않는다(${b.ticks})`);
  await assertRollupsEqual(keysB, expB, '한 번에');
  // 1시간만 다시 하는 대기(마이그레이션 모양 — daily=0)도 버킷 사이에서 양보한다(날 사이 양보만으로는 끼어들지 않는다)
  useDir(path.join(DIR, 'r2c'));
  const r = rng(3);
  for (let i = 0; i < 12; i++) await month.writeServerRows(['A', 'B', 'C', 'D', 'E', 'F'].map((k) => mkRow(r, k, H10 + i * 300_000)), '', { rollup: false, pend: 'inserted', pendDaily: false });
  const c = await interleaves(() => month.repairPending({ sliceMs: 0.001 }));
  assert.equal(c.r.buckets, 6); assert.equal(c.r.days, 0);
  assert.ok(c.ticks >= 5, `1시간 버킷 사이 양보(끼어든 횟수 ${c.ticks})`);
});

/* ── ③ ─────────────────────────────────────────────────────────────── */
test('③ 시간 상한 — 상한 0 이어도 한 실행에 한 묶음은 끝낸다 · 남은 대기는 deferred/budgetHit 로 밝히고 다음 실행이 잇는다 · 나눠 해도 결과가 같다', async () => {
  useDir(path.join(DIR, 'r3'));
  const keys = await seedPending(5);
  const exp = await expected(keys);
  const first = await month.repairPending({ budgetMs: 0 });
  assert.equal(first.buckets, 2); assert.equal(first.days, 1);
  assert.equal(first.budgetHit, true); assert.equal(first.deferred, 8, JSON.stringify(first));
  assert.equal(await month.pendingCount(), 8, '처리하지 못한 대기는 그대로 남는다');
  let calls = 1;
  while (await month.pendingCount()) { await month.repairPending({ budgetMs: 0 }); calls += 1; assert.ok(calls < 20); }
  assert.equal(calls, 5, '묶음(서버·날) 하나씩');
  await assertRollupsEqual(keys, exp, '나눠 한 판본');
});

/* ── ④ ─────────────────────────────────────────────────────────────── */
test('④ 반복 실패 — 1일 파일을 못 열면 한 실행에 한 번만 열고 나머지는 skipped · 두 번째 실패부터 간격(10분…상한 1시간) · 상태 backoff·repeatFail·ok:false · 고친 뒤 성공하면 지운다', async () => {
  useDir(path.join(DIR, 'r4'));
  const keys = await seedPending(4, { normal: false });
  const d1Name = month.fileNameOf('d1', dayKey(H10).slice(0, 4));
  const bad = path.join(DIR, 'r4', d1Name);
  fs.mkdirSync(bad);   // 열 수 없는 1일 파일
  const r1 = await month.repairPending({});
  assert.equal(r1.errors.length, 1, `같은 파일을 묶음마다 다시 열지 않는다: ${JSON.stringify(r1.errors)}`);
  assert.equal(r1.skipped, 6, '나머지 세 묶음(6 대기)은 이번 실행에서 건너뛴다');
  assert.equal(r1.backoff?.[0]?.file, d1Name); assert.equal(r1.backoff[0].fails, 1);
  assert.equal(r1.backoff[0].nextAt, r1.backoff[0].at, '첫 실패는 다음 틱에 바로 다시(일시 오류)');
  assert.equal(await month.pendingCount(), 8, '대기는 지우지 않는다');
  const r2 = await month.repairPending({});
  assert.equal(r2.errors.length, 1); assert.equal(r2.backoff[0].fails, 2);
  assert.equal(r2.backoff[0].nextAt - r2.backoff[0].at, month.REPAIR_BACKOFF_BASE_MS);
  assert.equal(r2.repeatFail, true);
  const r3 = await month.repairPending({});
  assert.equal(r3.errors.length, 0, '간격 안에서는 다시 열지 않는다'); assert.equal(r3.skipped, 8); assert.equal(r3.buckets, 0);
  assert.equal(r3.repeatFail, true);
  const rr = await db.repairRollups({});
  assert.equal(rr.ok, false, '재시도 간격 중인 파일이 있으면 오류가 없어도 ok 가 아니다'); assert.equal(rr.backoff[0].file, d1Name);
  fs.rmSync(bad, { recursive: true });
  month._resetMonthStoreForTest();
  // 리셋은 간격 상태도 지운다 — 시험을 위해 같은 상태를 다시 만든다(두 번 실패)
  fs.mkdirSync(bad); await month.repairPending({}); await month.repairPending({}); fs.rmSync(bad, { recursive: true });
  assert.equal((await month.repairPending({})).skipped, 8, '고쳐도 간격이 지나기 전에는 건드리지 않는다');
  const ok = await month.repairPending({ ignoreBackoff: true });
  assert.equal(ok.days, 4); assert.equal(ok.errors.length, 0); assert.equal(ok.backoff, undefined, JSON.stringify(ok.backoff));
  assert.deepEqual(month.repairBackoffState(), []);
  assert.equal(await month.pendingCount(), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(month.repairBackoffMs), [0, 0, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  void keys;
});

/* ── ⑤ ─────────────────────────────────────────────────────────────── */
function dumpDir(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((x) => /^bm-usage.*\.db$/.test(x)).sort()) {
    const c = new DatabaseSync(path.join(dir, f));
    try {
      for (const { name } of c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
        if (name === 'bm_meta') continue;   // 마이그레이션 상태(만든 시각) — 적재와 무관
        out[`${f}:${name}`] = c.prepare(`SELECT * FROM ${name}`).all().map((x) => JSON.stringify(x)).sort();
      }
    } finally { c.close(); }
  }
  return out;
}
function cycleData(r, keys, ts, { dupOf = null } = {}) {
  const rows = keys.map((k) => { const o = mkRow(r, k, ts); for (const c of PERF_COL_NAMES) if (o[c] === undefined) o[c] = Math.round(r() * 100); return o; });
  if (dupOf) rows.push({ ...dupOf, cpu_pct: 99 });   // 같은 ts 재전송 — 원시 IGNORE · 롤업·최신값 그대로
  const devices = []; const mounts = [];
  for (const k of keys) {
    for (const [kind, dev] of [['disk', 'sda'], ['disk', 'sdb'], ['nic', 'eno1']]) {
      const d = { key: k, ts, kind, dev, oper: kind === 'nic' ? 'up' : null };
      for (const c of DEVICE_COL_NAMES) d[c] = Math.round(r() * 1000) / 10;
      devices.push(d);
    }
    mounts.push({ key: k, ts, mount: '/data', used_pct: Math.round(r() * 100), inode_pct: 3, size_bytes: 1e12, used_bytes: 5e11 });
  }
  return { rows, devices, mounts };
}
test('⑤ insertUsage 조각 — 한 번에 넣은 것과 모든 파일·표의 행과 반환값이 같다 · 조각 사이에 양보한다 · 그 사이 읽는 쪽은 서버마다 전부 아니면 전무(부분 적재 없음)', async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const H = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const ts1 = H + 10 * 60_000; const ts2 = H + 15 * 60_000;
  const run = async (dir, chunkRows, probe = null) => {
    useDir(dir);
    const r = rng(5);
    const c1 = cycleData(r, keys, ts1);
    const res1 = await db.insertUsage(c1.rows, '', { devices: c1.devices, mounts: c1.mounts, chunkRows });
    const c2 = cycleData(r, keys, ts2, { dupOf: c1.rows[3] });
    const x = await interleaves(() => db.insertUsage(c2.rows, '', { devices: c2.devices, mounts: c2.mounts, chunkRows }), probe ? () => probe(dir) : null);
    return { res: [res1, x.r], ticks: x.ticks, dump: dumpDir(dir) };
  };
  const one = await run(path.join(DIR, 'i5a'), 1e9);
  assert.ok(one.ticks <= 1, `한 조각이면 끼어들지 않는다(${one.ticks})`);
  // 조각 사이 읽기 — 서버마다 원시·1시간·1일·최신값·장치·장치 1시간·마운트가 같이 바뀌었는지
  const f = (fam, ts) => month.fileNameOf(fam, month.periodKeyOf(fam, ts));
  const day = dayKey(ts2);
  let mixed = false; let probes = 0; const bad = [];
  const probe = (dir) => {
    probes += 1;
    const open = (name) => new DatabaseSync(path.join(dir, name));
    const c = { raw: open(f('raw', ts2)), h1: open(f('h1', ts2)), d1: open(f('d1', ts2)), dev: open(f('dev', ts2)), dev1h: open(f('dev1h', ts2)), main: open('bm-usage.db') };
    try {
      let done = 0;
      for (const k of keys) {
        const s = {
          raw: c.raw.prepare('SELECT COUNT(*) c FROM usage_history WHERE key=? AND ts=?').get(k, ts2).c,
          latest: c.main.prepare('SELECT ts FROM usage_latest WHERE key=?').get(k)?.ts ?? null,
          h1: c.h1.prepare('SELECT samples FROM usage_hourly WHERE key=? AND h=?').get(k, H)?.samples ?? 0,
          d1: c.d1.prepare('SELECT samples FROM usage_daily WHERE key=? AND day=?').get(k, day)?.samples ?? 0,
          dev: c.dev.prepare('SELECT COUNT(*) c FROM usage_device_history WHERE key=? AND ts=?').get(k, ts2).c,
          dev1h: c.dev1h.prepare("SELECT samples FROM usage_device_hourly WHERE key=? AND kind='disk' AND dev='sda' AND h=?").get(k, H)?.samples ?? 0,
          mount: c.d1.prepare("SELECT last_ts FROM usage_mount_daily WHERE key=? AND mount='/data'").get(k)?.last_ts ?? null,
        };
        const want = s.raw === 1 ? { raw: 1, latest: ts2, h1: 2, d1: 2, dev: 3, dev1h: 2, mount: ts2 } : { raw: 0, latest: ts1, h1: 1, d1: 1, dev: 0, dev1h: 1, mount: ts1 };
        if (JSON.stringify(s) !== JSON.stringify(want)) bad.push({ k, s, want });
        if (s.raw === 1) done += 1;
      }
      if (done > 0 && done < keys.length) mixed = true;
    } finally { for (const x of Object.values(c)) x.close(); }
  };
  const many = await run(path.join(DIR, 'i5b'), 10, probe);   // 서버 무게 5(행 1 + 장치 3 + 마운트 1) → 조각마다 2대 · 6조각
  assert.ok(many.ticks >= 3, `조각 사이에 양보해야 한다(끼어든 횟수 ${many.ticks})`);
  assert.ok(probes >= 3 && mixed, `주기 도중(일부 서버만 끝난 때)을 읽어 봐야 한다 — probes ${probes} mixed ${mixed}`);
  assert.deepEqual(bad, [], '서버 하나의 부분 적재가 보이면 안 된다');
  assert.deepEqual(many.res, one.res, '반환값(적재 · 중복 · 장치 수)이 같다');
  assert.equal(one.res[1].duplicates, 1);
  assert.deepEqual(Object.keys(many.dump), Object.keys(one.dump));
  for (const k of Object.keys(one.dump)) assert.deepEqual(many.dump[k], one.dump[k], k);
  // 순수 조각기: 서버를 쪼개지 않고 처음 나온 순서 · 서버 안 순서를 지킨다
  const ch = db.chunkByServer([{ key: 'a', i: 1 }, { key: 'b' }, { key: 'a', i: 2 }], [{ key: 'a', d: 1 }, { key: 'c' }, { key: 'a', d: 2 }], [], 2);
  assert.deepEqual(ch.map((x) => [x.rows.map((y) => y.key + (y.i || '')), x.devices.map((y) => y.key + (y.d || ''))]), [[['a1', 'a2'], ['a1', 'a2']], [['b'], ['c']]]);
});

/* ── ⑥ ─────────────────────────────────────────────────────────────── */
test('⑥ 장치 목록 ord — 서버·종류마다 한 번 읽는 판본이 예전 SQL 판본(행마다 SELECT 1 + MAX(ord)+1)과 같은 표를 만든다', async () => {
  useDir(path.join(DIR, 'r6'));
  const T = Math.floor(Date.now() / HOUR) * HOUR - 3 * HOUR;
  const long = 'x'.repeat(300);
  const calls = [
    [{ key: 'A', ts: T, kind: 'disk', dev: 'sdb' }, { key: 'A', ts: T, kind: 'disk', dev: 'sda' }, { key: 'A', ts: T, kind: 'nic', dev: 'eno1' }, { key: 'B', ts: T, kind: 'disk', dev: 'sda' }],
    [{ key: 'A', ts: T + 300_000, kind: 'disk', dev: 'sda' }, { key: 'A', ts: T + 300_000, kind: 'disk', dev: 'nvme0n1' }, { key: 'A', ts: T + 300_000, kind: 'disk', dev: 'nvme0n1' }, { key: 'A', ts: T + 300_000, kind: 'disk', dev: 'sdc' },
      { key: 'B', ts: T + 300_000, kind: 'nic', dev: 'eno2' }, { key: 'B', ts: T + 300_000, kind: 'disk', dev: long }, { key: 'C', ts: T + 300_000, kind: 'disk', dev: 'sda' }],
  ];
  for (const devices of calls) {
    const keys = [...new Set(devices.map((d) => d.key))];
    await db.insertUsage(keys.map((k) => ({ key: k, ts: devices[0].ts, cpu_pct: 1 })), '', { devices, mounts: [{ key: 'A', ts: devices[0].ts, mount: '/', used_pct: 1 }], chunkRows: 3 });
  }
  const main = new DatabaseSync(path.join(DIR, 'r6', 'bm-usage.db'));
  const schema = main.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_devices'").get().sql;
  const got = main.prepare('SELECT agent,key,kind,dev,ord,first_ts,last_ts,info FROM usage_devices ORDER BY agent,key,kind,dev').all().map((x) => ({ ...x }));
  main.close();
  // 예전 판본(v2.926 upsertDeviceList 의 SQL 그대로) — 같은 목록을 같은 순서로
  const ref = new DatabaseSync(':memory:'); ref.exec(schema);
  const nextOrd = ref.prepare('SELECT IFNULL(MAX(ord),0)+1 AS o FROM usage_devices WHERE agent=? AND key=? AND kind=?');
  const ins = ref.prepare(`INSERT INTO usage_devices (agent,key,kind,dev,ord,first_ts,last_ts,info) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(agent,key,kind,dev) DO UPDATE SET last_ts=MAX(IFNULL(last_ts,0),excluded.last_ts), info=COALESCE(excluded.info, info)`);
  const seen = ref.prepare('SELECT 1 FROM usage_devices WHERE agent=? AND key=? AND kind=? AND dev=?');
  const refUpsert = (list) => { for (const d of list) { const key = String(d.key || '').trim(); const kind = String(d.kind || ''); const dv = String(d.dev || '').slice(0, 256); if (!key || !kind || !dv) continue; const ord = seen.get('', key, kind, dv) ? 0 : Number(nextOrd.get('', key, kind)?.o || 1); ins.run('', key, kind, dv, ord, Number(d.ts) || null, Number(d.ts) || null, d.info ? String(d.info).slice(0, 512) : null); } };
  for (const devices of calls) { refUpsert(devices); refUpsert([{ key: 'A', ts: devices[0].ts, kind: 'mount', dev: '/' }]); }
  const want = ref.prepare('SELECT agent,key,kind,dev,ord,first_ts,last_ts,info FROM usage_devices ORDER BY agent,key,kind,dev').all().map((x) => ({ ...x }));
  ref.close();
  assert.deepEqual(got, want);
  assert.deepEqual(got.filter((x) => x.key === 'A' && x.kind === 'disk').map((x) => [x.dev, x.ord]), [['nvme0n1', 3], ['sda', 2], ['sdb', 1], ['sdc', 4]], '처음 본 순서 · 같은 목록 안 중복은 한 번(다음 번호를 건너뛰지 않는다)');
});

/* ── ⑦ ─────────────────────────────────────────────────────────────── */
test('⑦ 마이그레이션 — 청크 하나 안에서도 양보한다(쓰기 · 롤업 · 보정 사이 — 예전에는 청크 사이에서만) · 끝까지 가면 1시간 표본 수 = 예전 행 수', async () => {
  useDir(path.join(DIR, 'r7'));
  const mig = await import('../src/bmusage/monthMigrate.js');
  mig._resetMigrateForTest();
  const conn = await db.mainDbForMigration();
  const T = Math.floor(Date.now() / HOUR) * HOUR - 6 * HOUR;
  const ins = conn.prepare('INSERT INTO usage_history (agent,key,ts,name,vcenter_id,src,cpu_pct,mem_pct) VALUES (?,?,?,?,?,?,?,?)');
  conn.exec('BEGIN');
  let legacy = 0;
  for (let i = 0; i < 48; i++) for (const k of ['A', 'B', 'C', 'D']) { ins.run('', k, T + i * 300_000, `bm-${k}`, 'vc1', 'os', 10 + (i % 7), 40); legacy += 1; }
  conn.exec('COMMIT');
  conn.exec('DELETE FROM bm_meta');
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  db.initMigrationState(conn, now);
  const one = await interleaves(() => mig.runMonthMigration({ now, sliceMs: 0.001, stopAfterChunks: 1 }));
  assert.equal(one.r.interrupted, true); assert.equal(one.r.chunks, 1);
  assert.ok(one.ticks >= 3, `청크 하나(192행) 안에서 양보해야 한다(끼어든 횟수 ${one.ticks})`);
  const rest = await mig.runMonthMigration({ now, sliceMs: 0.001 });
  assert.equal(rest.phase, 'done', JSON.stringify(rest));
  assert.equal(await month.hourlySamplesInPeriod(month.periodKeyOf('h1', T), month.hourOf(T), month.hourOf(T) + 6 * HOUR), legacy);
  assert.equal(await month.pendingCount(), 0, '청크마다 보정 대기를 다 끝낸다(시간 상한 없음)');
});
