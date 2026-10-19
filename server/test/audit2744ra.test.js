// v2.744 회귀 검토 그룹 RA — v2.744 수정분(GA: DB-04 · RECENT-01)이 만든 결함.
//
// GA-R2 — 범위 계정 VM 수량 추이 재계산(service.computeSeries)이 사유를 모르는 '범위 안 빠진 vCenter 수' 에 전 함대 합계 행의 사유 수를
//   skipped(부분 합) 먼저 빌려 붙였다. 범위 안 비활성이 범위 밖 점검중 때문에 '점검중 1곳 제외' 로(범위 밖 점검 사실도 드러났다),
//   범위 안 점검중이 범위 밖 연결 실패 때문에 부분 합(vmTrend null)으로 보였다. 이제 합계 행에 빠진 vCenter 의 [id, 사유] 를 남기고
//   범위 안 vCenter 만 사유별로 센다(diff.js skipCategoryOf — 전 함대와 같은 판정).
// GA-R1 — DB-04 커서 정리의 상관 서브쿼리 MAX(rowid) 가 후보 행마다 그 묶음의 경계 이전 범위를 다시 훑어 총 비용이 묶음 크기의 제곱이었다
//   (측정: DS 300 × 1,500행 — 옛 한 방 1.3초 · 처음 판 총 46~62초). 이제 남기는 행(묶음별 MAX(rowid))을 정리마다 한 번 묶음 인덱스 순서로
//   나눠 읽고, 후보는 ts 커서로만 고른다. 지우는 행 집합은 옛 한 방 정리와 같아야 한다(대조).
//
// 실제 함수(takeVmSnapshot · vmtrackSeries · vmTrend · pruneVmtrack)를 부른다. 기준 시각은 Date.now() 를 그대로 쓰지 않고 12시간 경계에서
// 6시간 떨어뜨린다(포탈 슬롯 KST 00·12시 시작에서 3시간 떨어진 자리). 정리 경계 근처의 행은 경계에서 3시간 넘게 떨어뜨린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744ra-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const SKIP = !sqliteOk ? 'node:sqlite 미지원 런타임' : false;
const H = 3_600_000;
const D = 86_400_000;
const BASE12 = Math.floor(Date.now() / (12 * H)) * (12 * H) + 6 * H;

const vm = (i, vc) => ({ id: `${vc}:vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, storageGB: 10, host: 'h1', cluster: 'c1' });
const vmsOf = (vc, n) => Array.from({ length: n }, (_, i) => vm(i, vc));

// ─────────────────────────────── GA-R2 ───────────────────────────────

test('GA-R2 범위 계정의 부분 합·점검중 제외는 범위 안 vCenter 의 사유로 센다(전 함대 사유 수를 빌려 오지 않는다)', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const T = await import('../src/overview/trend.js');
  const NOW = BASE12 - 5 * D;
  const [A, Dv, M, U] = ['ra2-A', 'ra2-D', 'ra2-M', 'ra2-U'];
  const all = (s) => [A, Dv, M, U].map((id) => ({ id, status: s[id] || 'connected' }));
  const full = { [A]: vmsOf(A, 5), [Dv]: vmsOf(Dv, 3), [M]: vmsOf(M, 4), [U]: vmsOf(U, 2) };
  const pick = (...ids) => ids.flatMap((id) => full[id]);
  const snap = async (status, vms, k) => {
    const r = await svc.takeVmSnapshot({ vcenters: all(status), vms, datastores: [] }, { trigger: 'test', now: new Date(NOW + k * 12 * H) });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  await snap({}, pick(A, Dv, M, U), 0);
  // 슬롯1: D 비활성 · M 점검중(캐시 없음 — VM 0)
  const r1 = await snap({ [Dv]: 'disabled', [M]: 'maintenance' }, pick(A, U), 1);
  // 슬롯2: M 점검중 · U 연결 실패
  const r2 = await snap({ [M]: 'maintenance', [U]: 'unreachable' }, pick(A, Dv), 2);
  assert.deepEqual(r1.skippedByReason, { disabled: 1, maintenance: 1 });
  assert.equal(r1.partialSkipped, 0);
  assert.equal(r2.partialSkipped, 1);
  assert.equal(r2.maintExcluded, 1);

  const pointOf = async (scope, slot) => (await svc.vmtrackSeries({ days: 30, scopeIds: scope ? new Set(scope) : null })).points.find((p) => p.slot === slot);
  // ① 범위 {A,D} 슬롯1 — 범위 안 D 는 비활성(합계 밖), 범위 밖 M 의 점검중을 빌려 와 '점검중 제외' 로 말하지 않는다.
  const p1 = await pointOf([A, Dv], r1.slot);
  assert.equal(p1.total, 5);
  assert.equal(p1.skipped, 0, '범위 안 비활성은 부분 합이 아니다');
  assert.equal(p1.maintExcluded, 0, `범위 밖 점검중을 범위 계정 점에 붙이지 않는다: ${JSON.stringify(p1)}`);
  // ② 범위 {A,M} 슬롯2 — 범위 안 M 은 점검중(합계를 막지 않는다), 범위 밖 U 의 연결 실패 때문에 부분 합이 되지 않는다.
  const s2 = await svc.vmtrackSeries({ days: 30, scopeIds: new Set([A, M]) });
  const p2 = s2.points.find((p) => p.slot === r2.slot);
  assert.equal(p2.skipped, 0, `범위 밖 연결 실패를 범위 계정의 부분 합으로 세지 않는다: ${JSON.stringify(p2)}`);
  assert.equal(p2.maintExcluded, 1, '범위 안 점검중은 점검중 제외로 센다');
  const trend = T.vmTrend(s2.points, 7, NOW + 2 * 12 * H + 2 * H);
  const lastCell = trend.filter((x) => x.v != null || x.partial).at(-1);
  assert.equal(lastCell.v, 5, `경영 보기 VM 추이 칸이 비지 않는다: ${JSON.stringify(lastCell)}`);
  assert.equal(lastCell.maintExcluded, 1);
  // ③ 범위 {A,U} 슬롯2 — 범위 안 U 의 연결 실패는 부분 합이다.
  const p3 = await pointOf([A, U], r2.slot);
  assert.equal(p3.skipped, 1);
  assert.equal(p3.maintExcluded, 0);
  // ④ 범위 = 전체 vCenter 면 범위 없는 결과(저장된 합계 행)와 같다 — 판정이 한 벌이다.
  const fleet = await svc.vmtrackSeries({ days: 30 });
  const scopedAll = await svc.vmtrackSeries({ days: 30, scopeIds: new Set([A, Dv, M, U]) });
  for (const slot of [r1.slot, r2.slot]) {
    const f = fleet.points.find((p) => p.slot === slot);
    const s = scopedAll.points.find((p) => p.slot === slot);
    assert.deepEqual({ skipped: s.skipped, maintExcluded: s.maintExcluded, total: s.total }, { skipped: f.skipped, maintExcluded: f.maintExcluded, total: f.total }, slot);
  }
});

test('GA-R2 합계 행의 빠진 vCenter 표지(skip_detail) — 저장 모양 · 옛 행(표지 없음)은 예전 판정으로 떨어진다', { skip: SKIP }, async () => {
  const db = await import('../src/vmtrack/db.js');
  const svc = await import('../src/vmtrack/service.js');
  const x = await db.getDb();
  const NOW = BASE12 - 12 * D;
  const [A, M, U] = ['ra2b-A', 'ra2b-M', 'ra2b-U'];
  const vcs = (s) => [A, M, U].map((id) => ({ id, status: s[id] || 'connected' }));
  await svc.takeVmSnapshot({ vcenters: vcs({}), vms: [...vmsOf(A, 4), ...vmsOf(M, 2), ...vmsOf(U, 1)], datastores: [] }, { trigger: 'test', now: new Date(NOW) });
  const r = await svc.takeVmSnapshot({ vcenters: vcs({ [M]: 'maintenance', [U]: 'unreachable' }), vms: vmsOf(A, 4), datastores: [] }, { trigger: 'test', now: new Date(NOW + 12 * H) });
  const row = x.db.prepare("SELECT skip_detail FROM snaps WHERE slot = ? AND vcenter_id = ''").get(r.slot);
  assert.deepEqual(db.parseSkipDetail(row.skip_detail).sort(), [[M, 'maintenance'], [U, 'unreachable']], '빠진 vCenter 의 id·사유를 합계 행에 남긴다');
  const fresh = (await svc.vmtrackSeries({ days: 30, scopeIds: new Set([A, M]) })).points.find((p) => p.slot === r.slot);
  assert.deepEqual([fresh.skipped, fresh.maintExcluded], [0, 1]);
  // 옛 행 — 표지가 없으면 사유를 모른다: 예전 빌려 오기 판정(범위 안 빠진 수 ≤ 전 함대 부분 합)이 그대로 남는다(바뀌지 않는다).
  x.db.prepare("UPDATE snaps SET skip_detail = NULL WHERE slot = ? AND vcenter_id = ''").run(r.slot);
  svc._vmtrackMemoForTest().clear();
  const old = (await svc.vmtrackSeries({ days: 30, scopeIds: new Set([A, M]) })).points.find((p) => p.slot === r.slot);
  assert.deepEqual([old.skipped, old.maintExcluded], [1, 0], '표지 없는 옛 행은 예전 판정 그대로');
  // 저장 모양: 객체 키가 아니라 [id, 사유] 배열이다 — id '__proto__' 가 프로토타입을 바꾸지 않는다. 형식이 틀리면 null(사유 미상).
  const enc = db.encodeSkipDetail([['__proto__', 'maintenance'], ['v1', 'unreachable']]);
  const dec = db.parseSkipDetail(enc);
  assert.deepEqual(dec, [['__proto__', 'maintenance'], ['v1', 'unreachable']]);
  assert.equal(({}).maintenance, undefined);
  assert.equal(db.parseSkipDetail('{bad'), null);
  assert.equal(db.parseSkipDetail(null), null);
  assert.equal(db.encodeSkipDetail(Array.from({ length: db.SKIP_DETAIL_MAX + 1 }, (_, i) => [`v${i}`, 'pending'])), null, '상한을 넘으면 저장하지 않는다(사유 미상)');
});

// ─────────────────────────────── GA-R1 ───────────────────────────────

const OLD_PRUNE_SQL = {
  changes: `DELETE FROM changes WHERE ts < ? AND rowid NOT IN (
    SELECT MAX(c.rowid) FROM changes c WHERE c.ts < ? AND c.kind IN ('powered_off','powered_on')
      AND (EXISTS (SELECT 1 FROM roster r WHERE r.vcenter_id = c.vcenter_id AND r.vm_id = c.vm_id)
           OR NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.vcenter_id = c.vcenter_id))
    GROUP BY c.vcenter_id, c.vm_id, c.kind)`,
  ds_series: 'DELETE FROM ds_series WHERE ts < ? AND rowid NOT IN (SELECT MAX(rowid) FROM ds_series WHERE ts < ? GROUP BY ds_id)',
};
const rowidsOf = (x, t) => x.db.prepare(`SELECT rowid AS rid FROM ${t} ORDER BY rowid`).all().map((r) => r.rid);
const DAYS = 30;
let FIX = null;   // GA-R1 픽스처 — 첫 테스트가 만들고 정리한다(뒤 테스트가 그 결과를 쓴다)

async function buildFixture() {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  const C = Date.now() - DAYS * D;
  const before = (k) => C - 3 * H - k * 12 * H;
  const after = (k) => C + 3 * H + k * 60_000;
  const insCh = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  const insRoster = x.db.prepare('INSERT OR REPLACE INTO roster (vcenter_id, vm_id, name, first_seen) VALUES (?, ?, ?, ?)');
  const insDs = x.db.prepare('INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb) VALUES (?, ?, ?, ?, 1, 1)');
  const PER = 1200;   // 묶음당 1,000행 이상(검토 지시 — 처음 판의 측정 픽스처는 DS 당 약 136행이라 제곱이 보이지 않았다)
  x.db.exec('BEGIN');
  // ds_series — DS 24개 × 슬롯 1,200개(경계 이전). 절반은 시각 역순으로 넣어 rowid 순서와 ts 순서가 다르게 한다. 일부 DS 는 경계 뒤 행도 있다.
  for (let d = 0; d < 24; d += 1) {
    const ks = Array.from({ length: PER }, (_, k) => k);
    if (d % 2) ks.reverse();
    for (const k of ks) insDs.run(`ra1s-${k}`, before(k), 'ra1-vcR', `ra1-ds${d}`);
    if (d % 3 === 0) insDs.run('ra1s-after', after(d), 'ra1-vcR', `ra1-ds${d}`);
  }
  // changes — 로스터 VM 12대 × 전원 전이 1,200행(켬·끔 번갈아) · 로스터에 없는(삭제된) VM 4대 · 로스터가 빈 vCenter 3대 · 생성/삭제 행.
  for (let v = 0; v < 12; v += 1) insRoster.run('ra1-vcR', `live-${v}`, `live${v}`, C - 900 * D);
  for (let v = 0; v < 12; v += 1) {
    const ks = Array.from({ length: PER }, (_, k) => k);
    if (v % 2) ks.reverse();
    for (const k of ks) insCh.run(before(k), 'ra1-vcR', k % 2 ? 'powered_on' : 'powered_off', `live-${v}`);
    insCh.run(after(v), 'ra1-vcR', 'powered_on', `live-${v}`);
  }
  for (let v = 0; v < 4; v += 1) for (let k = 0; k < 300; k += 1) insCh.run(before(k), 'ra1-vcR', k % 2 ? 'powered_on' : 'powered_off', `gone-${v}`);
  for (let v = 0; v < 3; v += 1) for (let k = 0; k < 300; k += 1) insCh.run(before(k), 'ra1-vcN', k % 2 ? 'powered_on' : 'powered_off', `x-${v}`);
  for (let k = 0; k < 1500; k += 1) insCh.run(before(k % PER), 'ra1-vcR', k % 2 ? 'added' : 'removed', `churn-${k}`);
  x.db.exec('COMMIT');
  // 옛 한 방 정리 결과·시간(트랜잭션 안에서 돌리고 되돌린다)
  x.db.exec('BEGIN');
  const t0 = performance.now();
  x.db.prepare(OLD_PRUNE_SQL.changes).run(C, C);
  x.db.prepare(OLD_PRUNE_SQL.ds_series).run(C, C);
  const oneShotMs = performance.now() - t0;
  const want = { changes: rowidsOf(x, 'changes'), ds_series: rowidsOf(x, 'ds_series') };
  x.db.exec('ROLLBACK');
  const beforeN = { changes: rowidsOf(x, 'changes').length, ds_series: rowidsOf(x, 'ds_series').length };
  return { db, x, C, want, oneShotMs, beforeN };
}

test('GA-R1 ① 남기는 행 표 방식의 정리는 옛 한 방 정리와 지우는 행이 같다(묶음당 1,200행)', { skip: SKIP }, async () => {
  FIX = await buildFixture();
  const { db, x, C, want, beforeN } = FIX;
  let maxGap = 0; let last = performance.now(); let stop = false;
  const probe = () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; if (!stop) setImmediate(probe); };
  setImmediate(probe);
  const t0 = performance.now();
  const r = await db.pruneVmtrack(DAYS);
  FIX.newMs = performance.now() - t0;
  stop = true;
  FIX.maxGap = maxGap;
  console.log(`[GA-R1] 옛 한 방 ${Math.round(FIX.oneShotMs)}ms · 새 정리 총 ${Math.round(FIX.newMs)}ms · 최장 정지 ${Math.round(maxGap)}ms · 청크 ${JSON.stringify(r.chunks)} · 쪽 ${JSON.stringify(r.keepPages)}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.cut - C) < 10 * 60_000);
  for (const t of ['changes', 'ds_series']) {
    const got = rowidsOf(x, t);
    assert.ok(isDeepStrictEqual(got, want[t]), `${t}: 남은 행이 옛 한 방 정리와 같다(옛 ${want[t].length}행 · 새 ${got.length}행 · 정리 전 ${beforeN[t]}행)`);
  }
  assert.ok(r.dsSeriesDeleted > 20_000 && r.changesDeleted > 15_000, JSON.stringify(r));
  // 남기는 행 표는 쪽으로 나눠 읽는다(쪽마다 양보) — 한 문장으로 전 묶음을 읽지 않는다.
  assert.ok(r.keepPages?.dsSeries >= 2 && r.keepPages?.changes >= 2, `남기는 행 표를 여러 쪽으로 읽었다: ${JSON.stringify(r.keepPages)}`);
});

test('GA-R1 ② 후보 선택 문에 상관 서브쿼리가 없고, 남기는 행 표는 묶음 인덱스를 커버링으로 순서대로 읽는다(임시 정렬 없음)', { skip: SKIP }, async () => {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  const plan = (stmt, ...a) => x.db.prepare(`EXPLAIN QUERY PLAN ${stmt.sourceSQL}`).all(...a).map((p) => p.detail).join(' | ');
  for (const k of ['chunkChangesSel', 'chunkDsSeriesSel']) {
    assert.ok(x.st[k], `${k} 가 있다`);
    const p = plan(x.st[k], 1, 1, 1, 1);
    assert.doesNotMatch(p, /CORRELATED/, `${k}: 후보 행마다 묶음을 다시 훑는 상관 서브쿼리가 없다 — ${p}`);
    assert.doesNotMatch(p, /TEMP B-TREE/, `${k}: ${p}`);
  }
  const cases = [
    ['keepDsFirst', 'idx_dsseries_ds', [1, 1]], ['keepDsNext', 'idx_dsseries_ds', ['a', 1, 1]],
    ['keepChangesFirst', 'idx_changes_vc_kind', [1, 1]], ['keepChangesNext', 'idx_changes_vc_kind', ['a', 'b', 'c', 1, 1]],
  ];
  for (const [k, idx, args] of cases) {
    assert.ok(x.st[k], `${k} 가 있다`);
    const p = plan(x.st[k], ...args);
    assert.match(p, new RegExp(`COVERING INDEX ${idx}`), `${k}: ${p}`);
    assert.doesNotMatch(p, /TEMP B-TREE|CORRELATED/, `${k}: ${p}`);
  }
  assert.match(x.st.keepDsFirst.sourceSQL, /MAX\(rowid\)/, '보존 규칙(ds 별 경계 이전 MAX(rowid))은 그대로다');
});

test('GA-R1 ③ 총 소요가 묶음 크기의 제곱으로 늘지 않는다 — 옛 한 방 정리의 상수배 안이다(비율로 본다)', { skip: SKIP }, () => {
  assert.ok(FIX && FIX.newMs > 0, '① 이 먼저 돌아야 한다');
  // 처음 판(상관 서브쿼리)은 이 픽스처에서 후보 한 행마다 묶음 1,200행을 훑었다 — 측정: 옛 한 방 192ms · 처음 판 2,916ms(15배) · 최장 273ms,
  //   이 판 384ms(2.3배) · 최장 53ms. 상한은 두 값 사이(절대 시간이 아니라 같은 데이터의 한 방 정리와의 비율 + 여유 — 부하에 함께 흔들린다).
  const limit = FIX.oneShotMs * 6 + 500;
  assert.ok(FIX.newMs < limit, `새 정리 ${Math.round(FIX.newMs)}ms < 옛 한 방 ${Math.round(FIX.oneShotMs)}ms × 6 + 0.5초(${Math.round(limit)}ms)`);
  assert.ok(FIX.maxGap < 1000, `최장 정지 ${Math.round(FIX.maxGap)}ms < 1초(청크마다 양보한다)`);
});
