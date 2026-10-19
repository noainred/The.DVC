// v2.744 최종 검토 그룹 FF — RA-R1(RA 판 정리가 만든 성능 퇴행) 회귀.
//
// RA-R1 — RA(회귀 검토 GA-R1)는 VM 추이 보존 정리의 상관 서브쿼리를 없애려고 '남길 행 표'(묶음별 경계 이전 MAX(rowid))를 정리마다 한 번
//   묶음 인덱스 전체를 나눠 읽어 만들었다. 그 쪽의 LIMIT 은 '내보낼 묶음 수' 만 묶어서, 경계(cut) 이전 행이 없거나 드문 표 — 기본 보존 1,095일이라
//   설치 3년 미만인 지금 모든 현장 — 에서는 한 문장이 changes·ds_series 묶음 인덱스를 끝까지 읽었다(양보 없음). 측정(FF, 같은 스크립트):
//   changes 50만·ds_series 25만 행 · 경계 이전 0행 → RA 판 정리 1회 70~92ms(전부 한 동기 구간) / 고친 판 0.8~2.7ms ·
//   100만·50만 행 → RA 판 145~254ms / 고친 판 0.6~2.1ms · 경계 이전 20행 → RA 판 84~128ms / 고친 판 1.1~15ms.
//   이제 묶음 기준은 **후보가 나온 묶음만**, 그 묶음의 경계 이전 범위만 읽는 문장 하나로 구한다(db.js makeGroupResolver · keepChangesOne · keepDsOne).
//
// ① 결과 동일성 — 결정적 난수 입력 여러 벌로 '지금 판(44952f3, RA 판)' 의 규칙을 테스트 안에서 그대로 돌려(묶음 인덱스로 구한 MAX 표 +
//    같은 판정 함수) 남은 행이 같은지 대조한다. 옛 한 방 정리 문장과도 같은지 함께 본다(두 기준이 같아야 기준이 맞다).
//    청크를 끊는 경로(묶음 기준 예산 0 — 청크마다 새 묶음 하나)로도 같은지 본다.
// ② 성능 — 시간은 절대값이 아니라 비율과 실행 계획으로 본다(CLAUDE.md v2.611): 경계 이전 행이 없거나 드문 표에서 정리가 실행한 문장은
//    전부 범위 탐색(SEARCH)이고 표·인덱스를 처음부터 훑는 문장(SCAN)이 없다 · 묶음 기준 조회 횟수 = 경계 이전 행이 있는 묶음 수 ·
//    정리 1회 시간이 같은 인덱스를 한 번 훑는 시간의 일부다(RA 판은 그 이상).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744ff-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const SKIP = !sqliteOk ? 'node:sqlite 미지원 런타임' : false;
const H = 3_600_000;
const D = 86_400_000;
const DAYS = 30;
const POWER = new Set(['powered_off', 'powered_on']);
const KINDS = ['powered_off', 'powered_on', 'added', 'removed'];

/** 결정적 난수(mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ['changes', 'ds_changes', 'ds_series', 'snaps'];
const rowidsOf = (x, t) => x.db.prepare(`SELECT rowid AS rid FROM ${t} ORDER BY rowid`).all().map((r) => Number(r.rid));
const clearAll = (x) => { for (const t of [...TABLES, 'roster']) x.db.exec(`DELETE FROM ${t}`); };

/**
 * 난수 픽스처 — 경계 C 기준으로 앞(경계 이전)·뒤 행을 섞는다. 행은 경계에서 3시간 넘게 떨어뜨린다(정리가 잡는 경계와 몇 ms 차이).
 *   같은 시각을 여러 행이 나눠 갖게 하고(슬롯 — (ts, rowid) 커서), 넣는 순서를 섞어 rowid 순서와 ts 순서를 다르게 한다.
 *   로스터: vCenter 마다 로스터가 비었거나 · 일부 VM 만 있다.
 */
function buildRandom(x, C, seed, { oldFrac, vcN, vmN, dsN, perGroup }) {
  const R = rng(seed);
  const pick = (n) => Math.floor(R() * n);
  const tsOf = (old) => (old ? C - 3 * H - pick(400) * 12 * H : C + 3 * H + pick(400) * 12 * H);
  const insCh = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  const insRoster = x.db.prepare('INSERT OR REPLACE INTO roster (vcenter_id, vm_id, name, first_seen) VALUES (?, ?, ?, ?)');
  const insDs = x.db.prepare('INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb) VALUES (?, ?, ?, ?, 1, 1)');
  const insDc = x.db.prepare('INSERT INTO ds_changes (snap_id, ts, vcenter_id, kind, ds_id) VALUES (1, ?, ?, ?, ?)');
  const insSnap = x.db.prepare('INSERT INTO snaps (slot, ts, vcenter_id, total) VALUES (?, ?, ?, 1)');
  const rows = [];
  for (let v = 0; v < vcN; v += 1) {
    const vc = `ff${seed}-vc${v}`;
    const rosterMode = v % 3;   // 0: 로스터 빈 vCenter · 1: VM 절반만 로스터 · 2: VM 전부 로스터
    for (let m = 0; m < vmN; m += 1) {
      const vmId = `vm-${m}`;
      if (rosterMode === 2 || (rosterMode === 1 && m % 2 === 0)) insRoster.run(vc, vmId, vmId, C - 900 * D);
      const n = pick(perGroup + 1);
      for (let k = 0; k < n; k += 1) rows.push(['ch', tsOf(R() < oldFrac), vc, KINDS[pick(4)], vmId]);
    }
  }
  for (let d = 0; d < dsN; d += 1) {
    const n = pick(perGroup + 1);
    for (let k = 0; k < n; k += 1) rows.push(['ds', tsOf(R() < oldFrac), `ff${seed}-vc0`, `ff${seed}-ds${d}`, k]);
  }
  for (let i = 0; i < 300; i += 1) rows.push(['dc', tsOf(R() < oldFrac), `ff${seed}-vc0`, 'ds_changed', `ff${seed}-ds${i % 7}`]);
  for (let i = 0; i < 200; i += 1) rows.push(['sn', tsOf(R() < oldFrac), `ff${seed}-vc${i % vcN}`, i]);
  // 섞는다(Fisher–Yates) — rowid 순서 ≠ ts 순서
  for (let i = rows.length - 1; i > 0; i -= 1) { const j = pick(i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  x.db.exec('BEGIN');
  for (const r of rows) {
    if (r[0] === 'ch') insCh.run(r[1], r[2], r[3], r[4]);
    else if (r[0] === 'ds') insDs.run(`${r[3]}-s${r[4]}`, r[1], r[2], r[3]);
    else if (r[0] === 'dc') insDc.run(r[1], r[2], r[3], r[4]);
    else insSnap.run(`ff${seed}-sn${r[3]}`, r[1], r[2]);
  }
  x.db.exec('COMMIT');
}

/**
 * '지금 판(44952f3)' 의 지우는 규칙을 그대로 — 묶음별 경계 이전 MAX(rowid) 를 묶음 인덱스로 구한 표(그 판의 keepChangesFirst/Next·keepDsFirst/Next 와
 *   같은 문장을 쪽 나눔 없이) + 같은 판정(changesDeletable·groupDeletable) + 같은 로스터 문장. 남을 rowid 를 표마다 돌려준다.
 */
function referenceRemaining(x, C) {
  const chKey = (vc, kind, vm) => `${String(vc).length}:${vc}|${kind}|${vm}`;
  const keepCh = new Map();
  for (const r of x.db.prepare(`SELECT vcenter_id AS vc, kind, vm_id AS vm, MAX(rowid) AS m FROM changes INDEXED BY idx_changes_vc_kind
      WHERE kind IN ('powered_off','powered_on') AND ts < ? GROUP BY vcenter_id, kind, vm_id ORDER BY vcenter_id, kind, vm_id`).all(C)) {
    keepCh.set(chKey(r.vc, r.kind, r.vm), Number(r.m));
  }
  const keepDs = new Map();
  for (const r of x.db.prepare(`SELECT ds_id AS g, MAX(rowid) AS m FROM ds_series INDEXED BY idx_dsseries_ds
      WHERE ts < ? GROUP BY ds_id ORDER BY ds_id`).all(C)) keepDs.set(r.g, Number(r.m));
  const roster = x.db.prepare(`SELECT (EXISTS (SELECT 1 FROM roster r WHERE r.vcenter_id = ? AND r.vm_id = ?)
      OR NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.vcenter_id = ?)) AS k`);
  const del = { changes: new Set(), ds_series: new Set(), ds_changes: new Set(), snaps: new Set() };
  for (const r of x.db.prepare('SELECT rowid AS rid, kind, vcenter_id AS vc, vm_id AS vm FROM changes WHERE ts < ?').all(C)) {
    const rid = Number(r.rid);
    if (!POWER.has(r.kind)) { del.changes.add(rid); continue; }
    const m = keepCh.get(chKey(r.vc, r.kind, r.vm));
    if (m == null || rid > m) continue;
    if (rid < m || !roster.get(r.vc, r.vm, r.vc)?.k) del.changes.add(rid);
  }
  for (const r of x.db.prepare('SELECT rowid AS rid, ds_id AS g FROM ds_series WHERE ts < ?').all(C)) {
    const m = keepDs.get(r.g);
    if (m != null && Number(r.rid) < m) del.ds_series.add(Number(r.rid));
  }
  for (const t of ['ds_changes', 'snaps']) for (const r of x.db.prepare(`SELECT rowid AS rid FROM ${t} WHERE ts < ?`).all(C)) del[t].add(Number(r.rid));
  return Object.fromEntries(TABLES.map((t) => [t, rowidsOf(x, t).filter((rid) => !del[t].has(rid))]));
}

/** 옛 한 방 정리 문장(v2.743 — audit2744a·audit2744ra 와 같은 기준)의 결과 — 트랜잭션 안에서 돌리고 되돌린다. */
function oneShotRemaining(x, C) {
  x.db.exec('BEGIN');
  try {
    x.db.prepare(`DELETE FROM changes WHERE ts < ? AND rowid NOT IN (
      SELECT MAX(c.rowid) FROM changes c WHERE c.ts < ? AND c.kind IN ('powered_off','powered_on')
        AND (EXISTS (SELECT 1 FROM roster r WHERE r.vcenter_id = c.vcenter_id AND r.vm_id = c.vm_id)
             OR NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.vcenter_id = c.vcenter_id))
      GROUP BY c.vcenter_id, c.vm_id, c.kind)`).run(C, C);
    x.db.prepare('DELETE FROM ds_changes WHERE ts < ?').run(C);
    x.db.prepare('DELETE FROM ds_series WHERE ts < ? AND rowid NOT IN (SELECT MAX(rowid) FROM ds_series WHERE ts < ? GROUP BY ds_id)').run(C, C);
    x.db.prepare('DELETE FROM snaps WHERE ts < ?').run(C);
    return Object.fromEntries(TABLES.map((t) => [t, rowidsOf(x, t)]));
  } finally { x.db.exec('ROLLBACK'); }
}

/** 경계 이전 행이 있는 묶음 수(전원 전이 (vCenter, 종류, VM) · ds) — 묶음 기준 조회 횟수의 기대값. */
function oldGroupCounts(x, C) {
  const ch = Number(x.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM changes WHERE ts < ? AND kind IN ('powered_off','powered_on') GROUP BY vcenter_id, kind, vm_id)`).get(C).n);
  const ds = Number(x.db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM ds_series WHERE ts < ? GROUP BY ds_id)').get(C).n);
  return { changes: ch, dsSeries: ds };
}

const SEEDS = [
  { seed: 11, oldFrac: 0, vcN: 3, vmN: 30, dsN: 40, perGroup: 12 },       // 경계 이전 0행(지금 모든 현장)
  { seed: 23, oldFrac: 0.02, vcN: 4, vmN: 40, dsN: 60, perGroup: 10 },    // 드묾
  { seed: 37, oldFrac: 0.3, vcN: 3, vmN: 30, dsN: 40, perGroup: 20 },     // 섞임
  { seed: 41, oldFrac: 0.85, vcN: 5, vmN: 25, dsN: 30, perGroup: 30 },    // 대부분(보존일을 줄인 첫 정리)
  { seed: 53, oldFrac: 1, vcN: 2, vmN: 20, dsN: 25, perGroup: 40 },       // 전부 경계 이전
  { seed: 67, oldFrac: 0.5, vcN: 6, vmN: 12, dsN: 80, perGroup: 6 },      // 작은 묶음 다수
];

test('FF ① 정리가 지우는 행은 지금 판(44952f3)의 규칙·옛 한 방 정리와 같다 — 결정적 난수 6벌 × (기본 예산 · 청크를 끊는 예산 0)', { skip: SKIP }, async () => {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  for (const cfg of SEEDS) {
    for (const budget of [undefined, 0]) {
      clearAll(x);
      const C = Date.now() - DAYS * D;
      buildRandom(x, C, cfg.seed, cfg);
      const want = referenceRemaining(x, C);
      const shot = oneShotRemaining(x, C);
      for (const t of TABLES) assert.ok(isDeepStrictEqual(want[t], shot[t]), `기준 둘이 같아야 한다(seed ${cfg.seed} ${t}: 지금 판 규칙 ${want[t].length}행 · 한 방 ${shot[t].length}행)`);
      const r = await db.pruneVmtrack(DAYS, budget === undefined ? undefined : { resolveBudgetMs: budget });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(Math.abs(r.cut - C) < 10 * 60_000);
      for (const t of TABLES) {
        const got = rowidsOf(x, t);
        assert.ok(isDeepStrictEqual(got, want[t]), `seed ${cfg.seed} · 예산 ${budget ?? '기본'} · ${t}: 남은 행이 지금 판과 같다(기대 ${want[t].length}행 · 실제 ${got.length}행)`);
      }
    }
  }
});

test('FF ② 묶음 기준은 경계 이전 행이 있는 묶음마다 한 번만 구한다 · 예산을 넘기면 청크를 끊는다(지우는 행은 같다)', { skip: SKIP }, async () => {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  const cfg = SEEDS[3];
  const runOnce = async (opt) => {
    clearAll(x);
    const C = Date.now() - DAYS * D;
    buildRandom(x, C, cfg.seed, cfg);
    const groups = oldGroupCounts(x, C);
    const r = await db.pruneVmtrack(DAYS, opt);
    return { r, groups, left: Object.fromEntries(TABLES.map((t) => [t, rowidsOf(x, t).length])) };
  };
  const a = await runOnce(undefined);
  assert.ok(a.groups.changes > 50 && a.groups.dsSeries > 10, JSON.stringify(a.groups));
  assert.deepEqual(a.r.keepLookups, a.groups, `묶음 기준 조회 = 경계 이전 행이 있는 묶음 수(묶음마다 한 번): ${JSON.stringify(a.r.keepLookups)}`);
  const b = await runOnce({ resolveBudgetMs: 0 });
  assert.deepEqual(b.r.keepLookups, b.groups, '청크를 끊어도 묶음마다 한 번만 구한다');
  assert.ok(b.r.chunks.changes >= b.groups.changes && b.r.chunks.dsSeries >= b.groups.dsSeries,
    `예산 0 이면 청크마다 새 묶음 하나에서 끊는다(청크 ${JSON.stringify(b.r.chunks)} · 묶음 ${JSON.stringify(b.groups)})`);
  assert.ok(b.r.chunks.changes > a.r.chunks.changes, `끊는 경로를 실제로 탔다(기본 ${a.r.chunks.changes} · 예산 0 ${b.r.chunks.changes})`);
  assert.deepEqual(b.left, a.left, '끊는 자리와 무관하게 남는 행 수가 같다');
  assert.ok(b.r.done && a.r.done);
});

// ─────────────────────────────── ② 성능 ───────────────────────────────

/** 정리 1회를 돌리며 실제로 실행된 준비 문장 이름을 모은다(실행 계획 검사용). */
async function pruneRecording(db, x) {
  const used = new Set();
  const orig = x.st;
  const wrapped = {};
  for (const [k, s] of Object.entries(orig)) {
    wrapped[k] = { sourceSQL: s.sourceSQL, all: (...a) => { used.add(k); return s.all(...a); }, get: (...a) => { used.add(k); return s.get(...a); }, run: (...a) => { used.add(k); return s.run(...a); } };
  }
  x.st = wrapped;
  try {
    const t0 = performance.now();
    const r = await db.pruneVmtrack(DAYS);
    return { r, used, ms: performance.now() - t0 };
  } finally { x.st = orig; }
}
const planOf = (x, sql) => x.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => 1)).map((p) => String(p.detail));
const minOf = async (n, fn) => { let best = Infinity; for (let i = 0; i < n; i += 1) best = Math.min(best, await fn()); return best; };

let BIG = null;   // ③·④ 가 쓰는 큰 픽스처(경계 뒤 행만) — ③ 이 만든다
async function buildBig() {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  clearAll(x);
  const C = Date.now() - DAYS * D;
  const insCh = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  const insDs = x.db.prepare('INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb) VALUES (?, ?, ?, ?, 1, 1)');
  const N = 200_000;
  x.db.exec('BEGIN');
  for (let i = 0; i < N; i += 1) insCh.run(C + 3 * H + (i % 600) * 12 * H, `big-vc${i % 28}`, KINDS[i % 4], `vm-${Math.floor(i / 28) % 6000}`);
  for (let i = 0; i < N / 2; i += 1) insDs.run(`bs${i}`, C + 3 * H + (i % 600) * 12 * H, 'big-vc0', `big-ds${i % 1100}`);
  x.db.exec('COMMIT');
  // 같은 인덱스를 한 번 훑는 비용(RA 판 정리가 한 동기 구간에서 하던 일과 같은 종류 — 인덱스 열 조건으로 항목마다 판정)
  const scanCh = x.db.prepare('SELECT COUNT(*) AS n FROM changes INDEXED BY idx_changes_vc_kind WHERE ts >= ?');
  const scanDs = x.db.prepare('SELECT COUNT(*) AS n FROM ds_series INDEXED BY idx_dsseries_ds WHERE ts >= ?');
  const scanMs = async () => { const t0 = performance.now(); scanCh.get(0); scanDs.get(0); return performance.now() - t0; };
  return { db, x, C, scanMs };
}

function assertNoFullScan(x, used, label) {
  assert.ok(used.size > 0, `${label}: 정리가 문장을 실행했다`);
  for (const k of used) {
    const plan = planOf(x, x.st[k].sourceSQL);
    assert.ok(!plan.some((d) => /^SCAN\b/.test(d) && !/^SCAN CONSTANT ROW/.test(d)), `${label}: 정리가 실행한 ${k} 는 표·인덱스를 처음부터 훑지 않는다(범위 탐색만) — ${plan.join(' | ')}`);
  }
}

test('FF ③ 경계 이전 행이 없는 표(지금 모든 현장)의 정리는 묶음 인덱스를 훑지 않는다 — 범위 탐색만 · 묶음 기준 조회 0 · 시간은 인덱스 한 번 훑기의 일부', { skip: SKIP }, async () => {
  BIG = await buildBig();
  const { db, x, scanMs } = BIG;
  await db.pruneVmtrack(DAYS);   // 데운다(첫 호출의 준비 비용을 빼고 본다)
  const rec = await pruneRecording(db, x);
  assert.equal(rec.r.ok, true, JSON.stringify(rec.r));
  assert.equal(rec.r.changesDeleted + rec.r.dsSeriesDeleted, 0);
  const scan = await minOf(5, scanMs);
  const prune = await minOf(5, async () => { const t0 = performance.now(); await db.pruneVmtrack(DAYS); return performance.now() - t0; });
  console.log(`[FF ③] 정리 1회 ${prune.toFixed(2)}ms · 같은 두 인덱스 한 번 훑기 ${scan.toFixed(2)}ms(각 5회 중 최소)`);
  // RA 판은 정리 한 번이 두 인덱스를 끝까지 훑었다(측정: 같은 크기에서 훑기 시간 이상). 고친 판은 ts 범위 탐색 넷뿐이다.
  assert.ok(prune < scan * 0.3, `정리 1회 ${prune.toFixed(2)}ms < 인덱스 한 번 훑기 ${scan.toFixed(2)}ms × 0.3`);
  assertNoFullScan(x, rec.used, '경계 이전 0행');
  assert.deepEqual(rec.r.keepLookups, { changes: 0, dsSeries: 0 }, `경계 이전 행이 없으면 묶음 기준을 하나도 구하지 않는다: ${JSON.stringify(rec.r.keepLookups)}`);
});

test('FF ④ 경계 이전 행이 드문 표의 정리도 나머지 인덱스를 훑지 않는다 — 묶음 기준 조회 = 그 묶음 수', { skip: SKIP }, async () => {
  assert.ok(BIG, '③ 이 먼저 돌아야 한다');
  const { db, x, C, scanMs } = BIG;
  const insCh = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  const insDs = x.db.prepare('INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb) VALUES (?, ?, ?, ?, 1, 1)');
  x.db.exec('BEGIN');
  for (let k = 0; k < 20; k += 1) insCh.run(C - 3 * H - k * 12 * H, `big-vc${k % 28}`, k % 2 ? 'powered_on' : 'powered_off', `vm-${k * 7}`);
  for (let k = 0; k < 20; k += 1) insDs.run(`bold${k}`, C - 3 * H - k * 12 * H, 'big-vc0', `big-ds${k}`);
  x.db.exec('COMMIT');
  const groups = oldGroupCounts(x, C);
  const rec = await pruneRecording(db, x);
  assert.equal(rec.r.ok, true, JSON.stringify(rec.r));
  const scan = await minOf(5, scanMs);
  const prune = await minOf(5, async () => { const t0 = performance.now(); await db.pruneVmtrack(DAYS); return performance.now() - t0; });
  console.log(`[FF ④] 정리 1회 ${prune.toFixed(2)}ms · 같은 두 인덱스 한 번 훑기 ${scan.toFixed(2)}ms(각 5회 중 최소)`);
  assert.ok(prune < scan * 0.3, `정리 1회 ${prune.toFixed(2)}ms < 인덱스 한 번 훑기 ${scan.toFixed(2)}ms × 0.3`);
  assertNoFullScan(x, rec.used, '경계 이전 20행');
  assert.deepEqual(rec.r.keepLookups, groups, `묶음 기준은 경계 이전 행이 있는 묶음만 구한다: ${JSON.stringify(rec.r.keepLookups)} · ${JSON.stringify(groups)}`);
  // 묶음 기준 문장은 그 묶음의 경계 이전 범위만 읽는다(묶음 인덱스 앞 열 등호 + ts 범위).
  assert.match(planOf(x, x.st.keepChangesOne.sourceSQL).join(' | '), /SEARCH changes USING COVERING INDEX idx_changes_vc_kind \(vcenter_id=\? AND kind=\? AND vm_id=\? AND ts<\?\)/);
  assert.match(planOf(x, x.st.keepDsOne.sourceSQL).join(' | '), /SEARCH ds_series USING COVERING INDEX idx_dsseries_ds \(ds_id=\? AND ts<\?\)/);
});
