// v2.744 점검 3회차 — 그룹 GA(VM 수량·스토리지 추적 vmtrack — 부분 합 판정 · 조회 성능 · 정리).
//
// RECENT-01 — v2.743 VC-01 회귀: 비활성·캐시 없는 점검중 vCenter 를 diff 에서 빼면서 그 개수를 DB 합계 행 skipped 열에 그대로 넣었다.
//   overview/trend.js vmTrend 는 skipped>0 인 버킷을 통째로 null(partial)로 만들어, 비활성 vCenter 가 하나라도 등록돼 있으면
//   경영 보기 VM 추이가 그 상태가 끝날 때까지 전부 비었다(VM 수량 추이 화면의 '부분 합' 배지도 사라지지 않았다).
//   규칙: skipped(부분 합) 에는 '기다리면 다시 읽힐' 사유만 · 비활성은 분모 밖(v2.617) · 점검중은 기한 없는 상태라 합계를 막지 않는다(v2.622).
// DB-01 — 스토리지 변경 이력(ds-change-log·ds-pivot)이 기간 전체 ds_changes 를 정렬해 한 번에 읽었다(365일 1.5~9.6초 정지).
// DB-04 — pruneVmtrack 이 DELETE 넷을 한 트랜잭션으로 동기 실행(보존일을 줄인 첫 정리 약 1.9초 정지).
// DB-05 — /tools/vm-track 30초 폴링이 365일이면 스냅샷 2만 행을 매번 다시 읽고 묶었다(결과 기억 없음).
//
// 실제 함수(takeVmSnapshot · vmtrackSeries · vmTrend · vmtrackDsChangeLog · vmtrackDsPivot · pruneVmtrack)를 부르고,
// 결과 동일성은 **옛 한 문장 조회를 테스트 안에서 그대로 돌려** 대조한다. 기준 시각은 Date.now() 를 쓰지 않고 정시 경계에서 떨어뜨려 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.VMTRACK_DB_PATH = path.join(tmp, 'vm-track.db');
process.env.PRUNE_CHUNK_ROWS = '500';   // DB-04: 청크가 여러 번 돌게(하한 500)

const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);
const SKIP = !sqliteOk ? 'node:sqlite 미지원 런타임' : false;
const H = 3_600_000;
const D = 86_400_000;
// 기준 시각 — 12시간 epoch 경계로 내린 뒤 6시간을 더한다(UTC 06·18시 = KST 15·03시: 포탈 슬롯(KST 00·12시) 시작에서 3시간 떨어진 자리).
//   보존 기간(1,095일) 안에 있도록 지금에서 거꾸로 잡는다 — 테스트마다 다른 구간을 써서 슬롯(전체 합계 행)이 겹치지 않게 한다.
const BASE12 = Math.floor(Date.now() / (12 * H)) * (12 * H) + 6 * H;

const vm = (i, vc, on = true) => ({ id: `${vc}:vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: on ? 'POWERED_ON' : 'POWERED_OFF', cpuCount: 2, memMB: 4096, storageGB: 10, host: 'h1', cluster: 'c1' });
const ds = (i, vc, used = 400) => ({ id: `${vc}:ds${i}`, name: `ds${i}`, vcenterId: vc, capacityGB: 1000, usedGB: used, freeGB: 1000 - used, storageType: 'VMFS' });

// ─────────────────────────────── RECENT-01 ───────────────────────────────

test('RECENT-01 ① 비활성 vCenter 는 부분 합이 아니다 — 경영 보기 VM 추이가 비지 않는다(결과의 skippedByReason 에는 남는다)', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const T = await import('../src/overview/trend.js');
  const NOW = BASE12 - 40 * D;
  const vmsA = Array.from({ length: 10 }, (_, i) => vm(i, 'r1-vcA'));
  const res = [];
  for (let k = 6; k >= 0; k -= 1) {
    const r = await svc.takeVmSnapshot({ vcenters: [{ id: 'r1-vcA', status: 'connected' }, { id: 'r1-vcOff', status: 'disabled' }], vms: vmsA, datastores: [ds(1, 'r1-vcA')] },
      { trigger: 'test', now: new Date(NOW - k * 12 * H) });
    assert.equal(r.ok, true);
    assert.equal(r.total, 10);
    res.push(r);
  }
  // 결과 계약: 빠진 vCenter 는 사유와 함께 남는다(조용히 빼지 않는다) — 다만 부분 합으로 세지 않는다.
  assert.equal(res.at(-1).skippedByReason?.disabled, 1, '비활성은 사유별 개수에 남는다');
  assert.equal(res.at(-1).partialSkipped ?? 0, 0, '비활성은 부분 합(partialSkipped)이 아니다');
  const ser = await svc.vmtrackSeries({ days: 400 });
  const mine = ser.points.filter((p) => res.some((r) => r.slot === p.slot));
  assert.equal(mine.length, 7);
  assert.ok(mine.every((p) => (p.skipped || 0) === 0), `비활성 vCenter 때문에 skipped 가 붙지 않는다: ${JSON.stringify(mine.map((p) => p.skipped))}`);
  const trend = T.vmTrend(mine, 7, NOW + 2 * H);
  const nonNull = trend.filter((p) => p.v != null);
  assert.ok(nonNull.length >= 6, `추이가 비지 않는다(유효 ${nonNull.length}/${trend.length})`);
  assert.equal(T.partialCount(trend), 0, '부분 합 칸 0');
  assert.ok(nonNull.every((p) => p.v === 10));
});

test('RECENT-01 ② 캐시 없는 점검중 vCenter 는 합계를 막지 않고 제외 수(maintExcluded)로 밝힌다 · unreachable 은 여전히 부분 합', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const T = await import('../src/overview/trend.js');
  const NOW = BASE12 - 100 * D;
  const vmsA = Array.from({ length: 4 }, (_, i) => vm(i, 'r2-vcA'));
  const vmsM = Array.from({ length: 3 }, (_, i) => vm(i, 'r2-vcM'));
  const vmsU = Array.from({ length: 2 }, (_, i) => vm(i, 'r2-vcU'));
  const all = [{ id: 'r2-vcA', status: 'connected' }, { id: 'r2-vcM', status: 'connected' }, { id: 'r2-vcU', status: 'connected' }];
  const s0 = await svc.takeVmSnapshot({ vcenters: all, vms: [...vmsA, ...vmsM, ...vmsU], datastores: [] }, { trigger: 'test', now: new Date(NOW - 4 * 12 * H) });
  assert.equal(s0.total, 9);
  // 슬롯 1·2 — 점검중(재시작 직후 캐시 없음 — VM 0)
  const mt = [{ id: 'r2-vcA', status: 'connected' }, { id: 'r2-vcM', status: 'maintenance', maintenance: true }, { id: 'r2-vcU', status: 'connected' }];
  const s1 = await svc.takeVmSnapshot({ vcenters: mt, vms: [...vmsA, ...vmsU], datastores: [] }, { trigger: 'test', now: new Date(NOW - 3 * 12 * H) });
  const s2 = await svc.takeVmSnapshot({ vcenters: mt, vms: [...vmsA, ...vmsU], datastores: [] }, { trigger: 'test', now: new Date(NOW - 2 * 12 * H) });
  assert.equal(s1.maintExcluded, 1, '점검중 제외 수를 결과에 싣는다');
  assert.equal(s1.partialSkipped ?? 0, 0);
  assert.equal(s1.removed, 0, '점검중 vCenter 의 VM 을 삭제로 세지 않는다(v2.743 그대로)');
  // 슬롯 3 — 연결 실패(unreachable · VM 0) — 기다리면 다시 읽힐 상태라 부분 합이다
  const ur = [{ id: 'r2-vcA', status: 'connected' }, { id: 'r2-vcM', status: 'connected' }, { id: 'r2-vcU', status: 'unreachable' }];
  const s3 = await svc.takeVmSnapshot({ vcenters: ur, vms: [...vmsA, ...vmsM], datastores: [] }, { trigger: 'test', now: new Date(NOW - 1 * 12 * H) });
  assert.equal(s3.partialSkipped, 1, 'unreachable 은 부분 합');
  assert.equal(s3.skippedByReason?.unreachable, 1);
  const ser = await svc.vmtrackSeries({ days: 400 });
  const by = new Map(ser.points.map((p) => [p.slot, p]));
  assert.equal(by.get(s1.slot).skipped, 0, '점검중은 skipped(부분 합 표지)가 아니다');
  assert.equal(by.get(s1.slot).maintExcluded, 1, '시계열 점에 점검중 제외 수');
  assert.equal(by.get(s3.slot).skipped, 1, 'unreachable 은 skipped 1');
  assert.equal(by.get(s3.slot).maintExcluded || 0, 0);
  const pts = [s0, s1, s2, s3].map((r) => by.get(r.slot));
  const trend = T.vmTrend(pts, 7, NOW + 2 * H);
  const at = (slotTs) => trend.find((b) => b.ts === Math.floor(slotTs / (12 * H)) * (12 * H));
  const b1 = at(by.get(s1.slot).ts);
  assert.equal(b1.v, 6, '점검중 슬롯은 추이를 null 로 만들지 않는다(값은 읽은 vCenter 합)');
  assert.equal(b1.maintExcluded, 1, '추이 점이 점검중 제외 수를 싣는다(화면이 말한다)');
  const b3 = at(by.get(s3.slot).ts);
  assert.equal(b3.v, null, 'unreachable 슬롯은 여전히 부분 합(null)');
  assert.equal(b3.partial, true);
  // 범위 계정 경로도 같은 규칙 — 점검중은 부분 합이 아니다
  const sc = await svc.vmtrackSeries({ days: 400, scopeIds: new Set(['r2-vcA', 'r2-vcM']) });
  const sby = new Map(sc.points.map((p) => [p.slot, p]));
  assert.equal(sby.get(s1.slot).skipped, 0, '범위 계정: 점검중 슬롯은 부분 합이 아니다');
  assert.equal(sby.get(s1.slot).maintExcluded, 1, '범위 계정: 점검중 제외 수');
  assert.equal(sby.get(s3.slot).skipped, 0, '범위 밖(vcU) 실패는 범위 계정의 부분 합이 아니다');
});

// ─────────────────────────────── DB-05 ───────────────────────────────

test('DB-05 시계열 결과 기억 — 같은 조건은 같은 결과를 다시 쓰고, 커밋·정리가 세대를 올리면 버린다 · 조건이 다르면 따로 기억한다', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const db = await import('../src/vmtrack/db.js');
  const NOW = BASE12 - 160 * D;
  const vcs = [{ id: 'r5-vcA', status: 'connected' }, { id: 'r5-vcB', status: 'connected' }];
  const vms = [...Array.from({ length: 3 }, (_, i) => vm(i, 'r5-vcA')), ...Array.from({ length: 2 }, (_, i) => vm(i, 'r5-vcB'))];
  await svc.takeVmSnapshot({ vcenters: vcs, vms, datastores: [] }, { trigger: 'test', now: new Date(NOW - 12 * H) });
  const a = await svc.vmtrackSeries({ days: 400 });
  const b = await svc.vmtrackSeries({ days: 400 });
  assert.ok(a === b, '같은 조건 두 번째 호출은 기억한 결과를 그대로 쓴다(스냅샷 행을 다시 읽지 않는다)');
  const sc1 = await svc.vmtrackSeries({ days: 400, scopeIds: new Set(['r5-vcA']) });
  const sc2 = await svc.vmtrackSeries({ days: 400, scopeIds: new Set(['r5-vcA']) });
  assert.ok(sc1 === sc2, '범위도 같으면 같은 기억');
  assert.ok(sc1 !== a, '범위가 다르면 다른 기억(무제한 결과가 범위 계정에 새지 않는다)');
  const scB = await svc.vmtrackSeries({ days: 400, scopeIds: new Set(['r5-vcB']) });
  assert.ok(scB !== sc1, '다른 범위는 다른 기억');
  const vcA = await svc.vmtrackSeries({ days: 400, vcenterId: 'r5-vcA' });
  assert.ok(vcA !== a, 'vCenter 지정도 키에 들어간다');
  // 기간이 달라도 '창 안 첫 행'(경계)이 같으면 읽을 행이 같다 — 같은 기억을 써도 결과가 같다(키는 기간이 아니라 경계다).
  //   (takeVmSnapshot 은 ts 를 실제 시각으로 찍으므로 여기 행은 전부 지금 근처다 — 7일·400일 창의 경계가 같다.)
  const d7 = await svc.vmtrackSeries({ days: 7 });
  assert.ok(isDeepStrictEqual(d7.points, a.points), '경계가 같으면 결과가 같다');
  // 커밋 → 세대가 오르고 새 슬롯이 보인다
  const gen0 = db.vmtrackGeneration();
  const s2 = await svc.takeVmSnapshot({ vcenters: vcs, vms: vms.slice(0, 4), datastores: [] }, { trigger: 'test', now: new Date(NOW) });
  assert.ok(db.vmtrackGeneration() > gen0, '커밋이 세대를 올린다');
  const c = await svc.vmtrackSeries({ days: 400 });
  assert.ok(c !== a, '커밋 뒤에는 기억을 버리고 다시 읽는다');
  assert.ok(c.points.some((p) => p.slot === s2.slot && p.total === 4), '새 슬롯이 결과에 있다');
  assert.ok(!a.points.some((p) => p.slot === s2.slot), '옛 기억에는 없던 슬롯');
  // 정리(지울 것이 없어도) → 세대가 오르고 기억을 버린다
  const g1 = db.vmtrackGeneration();
  const pr = await db.pruneVmtrack(1095);
  assert.equal(pr.ok, true);
  assert.equal(db.vmtrackGeneration(), g1 + 1, '정리는 끝난 뒤 세대를 한 번 올린다');
  const e = await svc.vmtrackSeries({ days: 400 });
  assert.ok(e !== c, '정리 뒤에는 다시 읽는다');
  assert.ok(isDeepStrictEqual(e.points, c.points), '지운 행이 없으면 결과는 같다');
  // 변경 이력(시각별)도 같은 규칙
  svc._vmtrackMemoForTest().clear();
  const l1 = await svc.vmtrackDsChangeLog({ days: 400 });
  const l2 = await svc.vmtrackDsChangeLog({ days: 400 });
  assert.ok(l1 === l2, '변경 이력도 같은 조건은 기억을 쓴다');
  const l3 = await svc.vmtrackDsChangeLog({ days: 400, chipLimit: 1 });
  assert.ok(l3 !== l1, '칩 상한이 다르면 다른 기억');
});

// ─────────────────────────────── DB-01 ───────────────────────────────

// 옛 조회(기간 전체를 한 문장으로 정렬해 읽던 것) — 대조 기준. v2.743 service.js 의 묶음 규칙을 그대로 옮겼다.
const OLD_WINDOW_SQL = `SELECT d.kind, d.ds_id, d.name, d.type, d.cap_gb, d.used_gb,
    d.usage_pct, d.prev_used_gb, d.delta_gb, d.vcenter_id, s.slot, s.ts AS slot_ts
  FROM ds_changes d JOIN snaps s ON s.id=d.snap_id
  WHERE d.ts>=? ORDER BY s.ts DESC, ABS(COALESCE(d.delta_gb,0)) DESC, d.name`;

async function oldChangeLog(x, { days, vcenterId = '', scopeIds = null, chipLimit = 24 }) {
  const { slotStartMs } = await import('../src/vmtrack/diff.js');
  const sinceTs = Date.now() - Math.max(1, Math.min(1095, days)) * D;
  const rows = x.db.prepare(OLD_WINDOW_SQL).all(sinceTs)
    .filter((r) => (!vcenterId || r.vcenter_id === vcenterId) && (!scopeIds || scopeIds.has(r.vcenter_id)));
  const bySlot = new Map();
  for (const r of rows) {
    let g = bySlot.get(r.slot);
    if (!g) bySlot.set(r.slot, g = { slot: r.slot, ts: slotStartMs(r.slot) ?? r.slot_ts, items: [], more: 0, sumDeltaGB: 0 });
    g.sumDeltaGB = Math.round((g.sumDeltaGB + (r.delta_gb || 0)) * 10) / 10;
    if (g.items.length >= Math.max(1, Math.min(100, chipLimit))) { g.more += 1; continue; }
    g.items.push({ dsId: r.ds_id, name: r.name || r.ds_id, vcenterId: r.vcenter_id, type: r.type || '', kind: r.kind, deltaGB: r.delta_gb ?? null, usedGB: r.used_gb ?? null, capGB: r.cap_gb ?? null, usagePct: r.usage_pct ?? null });
  }
  return { slots: [...bySlot.values()].sort((a, b) => b.ts - a.ts) };
}

async function oldPivot(x, svc, db, { days, vcenterId = '', scopeIds = null, q = '', changedOnly = true, sort = 'cum', offset = 0, limit = 20, slotCount = 6 }) {
  const { slotStartMs } = await import('../src/vmtrack/diff.js');
  const sinceTs = Date.now() - Math.max(1, Math.min(1095, days)) * D;
  const roster = await db.listDsRoster();
  const changeRows = x.db.prepare(OLD_WINDOW_SQL).all(sinceTs);
  const startVals = await svc._dsStartValuesForTest(sinceTs);
  const scoped = (vc) => (!vcenterId || vc === vcenterId) && (!scopeIds || scopeIds.has(vc));
  const snapRows = await db.readSeries({ vcenterId: vcenterId || '', sinceTs });
  const slotCols = snapRows.map((r) => ({ slot: r.slot, ts: slotStartMs(r.slot) ?? r.ts })).sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, Math.min(14, slotCount)));
  const colSet = new Set(slotCols.map((c) => c.slot));
  const perDs = new Map();
  for (const r of changeRows) {
    if (!scoped(r.vcenter_id) || !colSet.has(r.slot)) continue;
    let m = perDs.get(r.ds_id);
    if (!m) perDs.set(r.ds_id, m = {});
    m[r.slot] = { kind: r.kind, deltaGB: r.delta_gb ?? null, usedGB: r.used_gb ?? null };
  }
  const ql = String(q || '').trim().toLowerCase();
  const items = [];
  for (const r of roster) {
    if (!scoped(r.vcenter_id)) continue;
    if (ql && !String(r.name || '').toLowerCase().includes(ql) && !String(r.type || '').toLowerCase().includes(ql)) continue;
    const start = startVals.carry.has(r.ds_id) ? startVals.carry.get(r.ds_id) : startVals.firstIn.get(r.ds_id);
    const cumGB = (start == null || r.used_gb == null) ? 0 : Math.round((r.used_gb - start) * 10) / 10;
    const slots = {};
    let any = false;
    for (const c of slotCols) {
      const hit = perDs.get(r.ds_id)?.[c.slot];
      if (hit) { slots[c.slot] = hit; if (hit.deltaGB || hit.kind !== 'ds_changed') any = true; continue; }
      slots[c.slot] = (r.first_seen != null && c.ts < r.first_seen) ? null : { kind: 'none', deltaGB: 0 };
    }
    if (changedOnly && !any && !cumGB) continue;
    items.push({ dsId: r.ds_id, name: r.name || r.ds_id, vcenterId: r.vcenter_id, type: r.type || '', capGB: r.cap_gb || 0, usedGB: r.used_gb ?? null, cumGB, slots });
  }
  return { slotCols, items, sort, offset, limit };
}

test('DB-01 스토리지 변경 이력(시각별·DS 피벗)은 슬롯마다 나눠 읽어도 옛 한 문장 조회와 결과가 같다 · 기간 전체를 한 번에 읽지 않는다', { skip: SKIP }, async () => {
  const svc = await import('../src/vmtrack/service.js');
  const db = await import('../src/vmtrack/db.js');
  const { slotKey } = await import('../src/vmtrack/diff.js');
  const x = await db.getDb();
  // 데이터: 지금에서 3시간 전부터 12시간 간격 40슬롯(20일) — 7일 창 경계(since)에서 가장 가까운 행도 3시간 떨어진다.
  //   vCenter 둘(q1-vcA·q1-vcB) + 전체 합계 행. 일부 슬롯은 ① vCenter 마다 스냅샷 시각이 다르고(같은 슬롯 안 정렬) ② 재실행처럼
  //   스냅샷 시각이 변경 행 시각보다 늦다(창 경계를 걸치는 슬롯 포함 — 변경 행은 창 밖, 스냅샷은 창 안).
  const R0 = Date.now() - 3 * H;
  const insSnap = x.db.prepare('INSERT INTO snaps (slot, ts, vcenter_id, total) VALUES (?, ?, ?, ?)');
  const insDc = x.db.prepare(`INSERT INTO ds_changes (snap_id, ts, vcenter_id, kind, ds_id, name, type, cap_gb, used_gb, free_gb, usage_pct, prev_used_gb, delta_gb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insRoster = x.db.prepare('INSERT OR REPLACE INTO ds_roster (vcenter_id, ds_id, name, type, cap_gb, used_gb, free_gb, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const kinds = ['ds_changed', 'ds_changed', 'ds_changed', 'ds_added', 'ds_removed'];
  x.db.exec('BEGIN');
  for (let k = 0; k < 40; k += 1) {
    const t = R0 - k * 12 * H;
    const slot = slotKey(new Date(t));
    insSnap.run(slot, t, '', 100);
    for (const vc of ['q1-vcA', 'q1-vcB']) {
      // ① vcB 는 한 시간 늦게 · ② 재실행(스냅샷 시각만 늦다) — k=14 는 7일 창 경계를 걸친다
      const sTs = vc === 'q1-vcB' && k % 3 === 0 ? t + H : (k === 14 || k % 7 === 2 ? t + 4 * H : t);
      const sid = Number(insSnap.run(slot, sTs, vc, 50).lastInsertRowid);
      const n = 2 + ((k * 7 + vc.length) % 6);   // 슬롯당 2~7행 — 칩 상한 1·3 에서 more 가 생긴다
      for (let i = 0; i < n; i += 1) {
        const dsId = `${vc}:ds${(i * 3 + k) % 9}`;
        const delta = ((i * 13 + k * 5) % 17) - 8;   // 음수·0·양수 섞임(같은 |증감| 동률 → 이름 순)
        insDc.run(sid, t, vc, kinds[(i + k) % kinds.length], dsId, `ds${(i * 3 + k) % 9}`, i % 2 ? 'NFS' : 'VMFS', 1000, 400 + delta, 600 - delta, 40, 400, delta);
      }
    }
  }
  for (const vc of ['q1-vcA', 'q1-vcB']) for (let j = 0; j < 9; j += 1) insRoster.run(vc, `${vc}:ds${j}`, `ds${j}`, j % 2 ? 'NFS' : 'VMFS', 1000, 400 + j, 600 - j, R0 - (j * 3) * 12 * H);
  x.db.exec('COMMIT');
  const sinceProbe = Date.now() - 7 * D;
  const nearest = Math.min(...x.db.prepare("SELECT ts FROM snaps WHERE vcenter_id LIKE 'q1-%' UNION ALL SELECT ts FROM ds_changes WHERE vcenter_id LIKE 'q1-%'").all().map((r) => Math.abs(Number(r.ts) - sinceProbe)));
  assert.ok(nearest > 30 * 60_000, `7일 창 경계에서 가장 가까운 행이 30분 넘게 떨어져 있어야 한다(${nearest}ms)`);
  // 직접 넣은 행은 세대를 올리지 않으므로 기억을 비운다
  svc._vmtrackMemoForTest().clear();

  // ⚠ 옛 경로(기간 전체 한 문장)를 부르면 실패하게 막아 둔다 — 새 구현이 그 경로로 돌아가면 이 테스트가 잡는다.
  const saved = x.st.dsChangesWindow;
  x.st.dsChangesWindow = { all() { throw new Error('기간 전체를 한 문장으로 읽었다(DB-01 회귀)'); } };
  try {
    const cases = [
      { days: 7 }, { days: 30 }, { days: 400 }, { days: 7, vcenterId: 'q1-vcA' }, { days: 30, vcenterId: 'q1-vcB', chipLimit: 1 },
      { days: 30, chipLimit: 3 }, { days: 400, scopeIds: new Set(['q1-vcB']) }, { days: 7, scopeIds: new Set(['q1-vcA', 'nope']), chipLimit: 2 },
    ];
    for (const c of cases) {
      svc._vmtrackMemoForTest().clear();
      const got = await svc.vmtrackDsChangeLog(c);
      const want = await oldChangeLog(x, c);
      assert.ok(want.slots.length > 0, `대조 기준이 비어 있지 않다(${JSON.stringify({ ...c, scopeIds: c.scopeIds && [...c.scopeIds] })})`);
      assert.ok(isDeepStrictEqual(got, want), `시각별 변경 이력이 옛 조회와 같다: ${JSON.stringify({ ...c, scopeIds: c.scopeIds && [...c.scopeIds] })}`);
    }
    const pcases = [
      { days: 7 }, { days: 30, slotCount: 3 }, { days: 30, slotCount: 14, changedOnly: false }, { days: 7, vcenterId: 'q1-vcA', q: 'ds1' },
      { days: 400, scopeIds: new Set(['q1-vcB']), slotCount: 14 }, { days: 30, q: 'nfs', sort: 'name', limit: 50 },
    ];
    for (const c of pcases) {
      const got = await svc.vmtrackDsPivot(c);
      const want = await oldPivot(x, svc, db, c);
      assert.ok(isDeepStrictEqual(got.slotCols, want.slotCols), `피벗 열이 같다 ${JSON.stringify({ ...c, scopeIds: c.scopeIds && [...c.scopeIds] })}`);
      // 정렬·자르기는 바뀌지 않았다 — DS 별 칸(slots)·누적이 같은지 DS 단위로 대조한다(옛 결과 전체에서 찾는다).
      const byId = new Map(want.items.map((it) => [it.dsId, it]));
      assert.ok(got.total === want.items.length, `피벗 행 수가 같다(${got.total} vs ${want.items.length}) ${JSON.stringify({ ...c, scopeIds: c.scopeIds && [...c.scopeIds] })}`);
      for (const it of got.items) {
        const w = byId.get(it.dsId);
        assert.ok(w, `옛 결과에 있는 DS(${it.dsId})`);
        assert.ok(isDeepStrictEqual(it.slots, w.slots) && it.cumGB === w.cumGB, `DS ${it.dsId} 의 칸·누적이 같다`);
      }
    }
  } finally {
    x.st.dsChangesWindow = saved;
  }
});

// ─────────────────────────────── DB-04 ───────────────────────────────

const OLD_PRUNE_SQL = [
  `DELETE FROM changes WHERE ts < ? AND rowid NOT IN (
    SELECT MAX(c.rowid) FROM changes c WHERE c.ts < ? AND c.kind IN ('powered_off','powered_on')
      AND (EXISTS (SELECT 1 FROM roster r WHERE r.vcenter_id = c.vcenter_id AND r.vm_id = c.vm_id)
           OR NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.vcenter_id = c.vcenter_id))
    GROUP BY c.vcenter_id, c.vm_id, c.kind)`,
  'DELETE FROM ds_changes WHERE ts < ?',
  'DELETE FROM ds_series WHERE ts < ? AND rowid NOT IN (SELECT MAX(rowid) FROM ds_series WHERE ts < ? GROUP BY ds_id)',
  'DELETE FROM snaps WHERE ts < ?',
];
const dumpTables = (x) => Object.fromEntries(['changes', 'ds_changes', 'ds_series', 'snaps'].map((t) => [t, x.db.prepare(`SELECT rowid AS rid, * FROM ${t} ORDER BY rowid`).all()]));

test('DB-04 보존 정리는 청크로 지우고 사이마다 양보한다 — 남기는 행(경계 이전 마지막 행·로스터 VM 마지막 전원 전이)까지 옛 한 방 정리와 같다', { skip: SKIP }, async () => {
  const db = await import('../src/vmtrack/db.js');
  const x = await db.getDb();
  const DAYS = 30;
  const C = Date.now() - DAYS * D;   // 정리 경계(pruneVmtrack 이 계산할 값과 몇 ms 차이 — 행은 경계에서 3시간 넘게 떨어뜨린다)
  const before = (i) => C - 3 * H - i * 60_000;
  const after = (i) => C + 3 * H + i * 60_000;
  const insCh = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (?, ?, ?, ?, ?)');
  const insRoster = x.db.prepare('INSERT OR REPLACE INTO roster (vcenter_id, vm_id, name, first_seen) VALUES (?, ?, ?, ?)');
  const insDc = x.db.prepare('INSERT INTO ds_changes (snap_id, ts, vcenter_id, kind, ds_id) VALUES (?, ?, ?, ?, ?)');
  const insDs = x.db.prepare('INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb) VALUES (?, ?, ?, ?, ?, ?)');
  const insSnap = x.db.prepare('INSERT INTO snaps (slot, ts, vcenter_id, total) VALUES (?, ?, ?, ?)');
  const kinds = ['powered_off', 'powered_on', 'added', 'removed'];
  x.db.exec('BEGIN');
  let n = 0;
  // changes — p4-vcR: 로스터에 있는 VM(live-*)과 없는 VM(gone-*) · p4-vcN: 로스터가 빈 vCenter. 종류·시각을 섞어 rowid 와 ts 순서가 다르게 넣는다.
  for (let v = 0; v < 30; v += 1) insRoster.run('p4-vcR', `live-${v}`, `live${v}`, C - 90 * D);
  for (const [vc, prefix, vmsN] of [['p4-vcR', 'live', 30], ['p4-vcR', 'gone', 20], ['p4-vcN', 'x', 15]]) {
    for (let v = 0; v < vmsN; v += 1) {
      for (let r = 0; r < 30; r += 1) {
        const ts = r % 5 === 4 ? after(n % 600) : before((n * 7) % 600);
        insCh.run(1, ts, vc, kinds[(r + v) % 4], `${prefix}-${v}`);
        n += 1;
      }
    }
  }
  // ds_changes · snaps — 대부분 경계 이전
  for (let i = 0; i < 2000; i += 1) insDc.run(1, i % 10 === 0 ? after(i % 300) : before(i % 600), 'p4-vcR', 'ds_changed', `p4-ds${i % 40}`);
  for (let i = 0; i < 1800; i += 1) insSnap.run(`p4s-${i}`, i % 20 === 0 ? after(i % 300) : before(i % 600), 'p4-vcR', 1);
  // ds_series — DS 40개 × 슬롯 50개: 경계 이전 행만 있는 DS · 경계 뒤 행도 있는 DS · 경계 뒤 행만 있는 DS
  for (let d = 0; d < 40; d += 1) {
    for (let j = 0; j < 50; j += 1) {
      const ts = d >= 35 ? after(j) : (d % 3 === 0 && j >= 45 ? after(j) : before(((d * 50 + j) * 11) % 600));
      insDs.run(`p4s-${j}`, ts, 'p4-vcR', `p4-dsS${d}`, 1000, 100 + j);
    }
  }
  x.db.exec('COMMIT');
  // 옛 한 방 정리 결과(트랜잭션 안에서 실행하고 되돌린다)
  x.db.exec('BEGIN');
  x.db.prepare(OLD_PRUNE_SQL[0]).run(C, C);
  x.db.prepare(OLD_PRUNE_SQL[1]).run(C);
  x.db.prepare(OLD_PRUNE_SQL[2]).run(C, C);
  x.db.prepare(OLD_PRUNE_SQL[3]).run(C);
  const want = dumpTables(x);
  x.db.exec('ROLLBACK');
  const beforeCounts = Object.fromEntries(Object.entries(dumpTables(x)).map(([k, v]) => [k, v.length]));
  // 새 정리 — 도중에 이벤트 루프가 다른 일을 할 수 있어야 한다(양보)
  let ticks = 0;
  let stop = false;
  const probe = () => { if (stop) return; ticks += 1; setImmediate(probe); };
  setImmediate(probe);
  const g0 = db.vmtrackGeneration();
  const r = await db.pruneVmtrack(DAYS);
  stop = true;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.cut - C) < 10 * 60_000, '정리 경계가 대조 기준과 같은 자리');
  assert.equal(db.vmtrackGeneration(), g0 + 1, '세대는 끝난 뒤 한 번 올린다');
  const got = dumpTables(x);
  for (const t of Object.keys(want)) {
    assert.ok(isDeepStrictEqual(got[t], want[t]), `${t}: 청크 정리 결과가 옛 한 방 정리와 같다(옛 ${want[t].length}행 · 새 ${got[t].length}행 · 정리 전 ${beforeCounts[t]}행)`);
  }
  // 표마다 1,000행 넘게 지운다 — 청크(500행)가 표마다 세 번 이상 돌아야 한다(한 방 DELETE·큰 청크로 되돌리면 여기서 걸린다).
  const del = { changes: r.changesDeleted, dsChanges: r.dsChangesDeleted, dsSeries: r.dsSeriesDeleted, snaps: r.snapsDeleted };
  for (const [k, v] of Object.entries(del)) {
    assert.ok(v > 1000, `${k}: 지운 행이 청크 여러 번 분량이다(${v})`);
    assert.ok(r.chunks?.[k] >= Math.ceil(v / 500), `${k}: 청크 ${r.chunks?.[k]}회 — ${Math.ceil(v / 500)}회 이상이어야 한다`);
  }
  // 청크 사이마다 양보한다 — 이벤트 루프 한 바퀴에 청크 하나 · 프로브 한 번이므로 프로브 횟수는 '청크 경계 수' 이상이어야 한다.
  const boundaries = Object.values(r.chunks).reduce((a, n) => a + (n - 1), 0);
  assert.ok(ticks >= boundaries - 1, `청크 경계(${boundaries})마다 이벤트 루프에 양보했다(setImmediate 진행 ${ticks}회)`);
  // 남기는 규칙 표본: 경계 이전 행만 있는 DS 는 정확히 한 행 · 로스터 VM 의 경계 이전 전원 전이는 종류마다 한 행 · 삭제된 VM 의 것은 없다
  const dsLeft = x.db.prepare("SELECT ds_id, COUNT(*) n, MIN(ts) mn FROM ds_series WHERE ds_id = 'p4-dsS1' GROUP BY ds_id").get();
  assert.equal(Number(dsLeft.n), 1, '경계 이전 행만 있는 DS 는 마지막 한 행이 남는다');
  const liveOld = x.db.prepare("SELECT kind, COUNT(*) n FROM changes WHERE vcenter_id='p4-vcR' AND vm_id='live-3' AND ts < ? GROUP BY kind ORDER BY kind").all(C).map((q) => `${q.kind}:${q.n}`);
  assert.deepEqual(liveOld, ['powered_off:1', 'powered_on:1']);
  const goneOld = Number(x.db.prepare("SELECT COUNT(*) n FROM changes WHERE vcenter_id='p4-vcR' AND vm_id LIKE 'gone-%' AND ts < ?").get(C).n);
  assert.equal(goneOld, 0, '로스터에 없는 VM 의 경계 이전 행은 지운다');
  const noRoster = Number(x.db.prepare("SELECT COUNT(*) n FROM changes WHERE vcenter_id='p4-vcN' AND kind IN ('powered_off','powered_on') AND ts < ?").get(C).n);
  assert.ok(noRoster > 0, '로스터가 빈 vCenter 의 전원 전이 마지막 행은 남긴다');
});
