/**
 * decide147.test.js — 147회차: 143회차 결정 D1(138 결정) 권장안 — 스냅샷 이력 추이에서 REST 수집 vCenter 를 ‘빠진 날’ 이 아니라 ‘뺀 vCenter’ 로.
 *   D1(재현 — scratchpad r143work/repro_d1.mjs): REST 폴백으로 수집되는 vCenter(record 가 그날 'no-snap' 으로 남긴다 — 스냅샷 개수를 받지 않는다)가
 *       범위에 하나라도 있으면 전체 줄이 기록 시작부터 매일 null(missing 1) · ‘빠진 날이 있는 vCenter’ 에도 들었다 — SOAP 으로 돌아올 때까지 영영 비었다.
 *   권장안(사용자 ‘권장안대로 반영’): 'no-snap' 을 점검중 · 비활성처럼 그날 묶음에서 뺀다(excluded · 그 가운데 수 excludedRest). 빠진 날(gaps)에도 넣지 않는다.
 *   지키는 것: 일시 실패(unreachable · stale · pending)와 일부만 읽은 날(partial)은 그대로 빠진 날(null + missing — 부분 합 금지) · REST 와 섞지 않는다 ·
 *       판정은 읽을 때(status) — 이미 기록된 'no-snap' 날에도 적용 · VM 이력 · 7일 변화는 그날을 여전히 ‘모름’ 으로 둔다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'decide147-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });
process.env.SNAPHIST_DB_PATH = path.join(TMP, 'snap-history.db');
process.env.CONFIG_DIR = process.env.CONFIG_DIR || TMP;

const { dayRecord } = await import('../src/snaphist/record.js');
const { commitDay, snapHistStmts } = await import('../src/snaphist/db.js');
const H = await import('../src/snaphist/history.js');

const DAY = 86_400_000;
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md) · 날은 달력으로(그날 정오 — 서머타임 지역에서도 하루씩)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const B = new Date(NOW);
const at = (i) => new Date(B.getFullYear(), B.getMonth(), B.getDate() - i, 12).getTime();
const TODAY = at(0);
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [], notify: { enabled: false, hour: 9 } };
const vm = (vc, id, gb) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, powerState: 'POWERED_ON', template: false, snapshotCount: 1, snapshotSizeGB: gb,
  snapshotOldestTs: NOW - 90 * DAY, snapshotTree: [{ d: 0, name: `s-${id}`, ts: NOW - 90 * DAY }] });
const restVm = (vc, id) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, powerState: 'POWERED_ON' });   // REST 폴백 — 스냅샷 개수 · 크기가 없다
const corpOf = (id) => ({ corpId: `vc:${id}` });

/** n 일치 기록 — vcsOf(i) · vmsOf(i) 는 i 일 전(i = n-1 … 0)의 vCenter · VM. */
async function record(n, vcsOf, vmsOf) {
  for (let i = n - 1; i >= 0; i -= 1) {
    const r = await commitDay(dayRecord({ vcenters: vcsOf(i), vms: vmsOf(i) }, { now: at(i), hygiene: HY }));
    assert.equal(r.ok, true, JSON.stringify(r));
  }
}

test('D1 — REST 수집 vCenter 하나가 전체 줄을 매일 비우지 않는다(그날 묶음에서 빼고 더한다) · 빠진 날에도 넣지 않는다', async () => {
  // a1 10 GB 정상 · r1 REST 폴백(처음부터 계속) · m1 30 GB — 뒤 4일 점검중
  await record(8, (i) => [{ id: 'a1', name: 'A', status: 'connected' }, { id: 'r1', name: 'R', status: 'connected', collectSource: 'rest' },
    i <= 3 ? { id: 'm1', name: 'M', status: 'maintenance', maintenance: true } : { id: 'm1', name: 'M', status: 'connected' }],
  () => [vm('a1', 'a', 10), restVm('r1', 'r'), vm('m1', 'm', 30)]);
  const h = await H.historySeries({ vcIds: new Set(['a1', 'r1', 'm1']), days: 8, now: TODAY, corpOf });
  assert.deepEqual(h.series.map((p) => p.gb), [40, 40, 40, 40, 10, 10, 10, 10], '예전: 매일 null(missing 1)');
  assert.deepEqual(h.series.map((p) => p.missing), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(h.series.map((p) => p.excluded), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(h.series.map((p) => p.excludedRest), [1, 1, 1, 1, 1, 1, 1, 1], '뺀 가운데 REST 수집 수를 따로 싣는다(화면이 사유를 가른다)');
  assert.deepEqual(h.gaps, [], '예전: r1 이 ‘빠진 날이 있는 vCenter’ 로 7일');
  // 법인 줄 — REST vCenter 하나뿐인 줄은 더한 것이 없다(null) · 빠진 날이 아니라 뺀 날
  assert.deepEqual(h.byCorp['vc:r1'].map((p) => [p.gb, p.missing, p.excluded, p.excludedRest]), Array(8).fill([null, 0, 1, 1]));
  assert.deepEqual(h.byCorp['vc:a1'].map((p) => p.gb), Array(8).fill(10));
});

test('① SOAP ↔ REST 를 오가는 vCenter — REST 날은 ‘빼고 더한 날’(excluded > 0)로 표시된다 · 부분 합이 표시 없이 이어지지 않는다', async () => {
  const soapDay = (i) => i % 2 === 0;
  await record(6, (i) => [{ id: 'a2', name: 'A', status: 'connected' }, soapDay(i) ? { id: 's2', name: 'S', status: 'connected' } : { id: 's2', name: 'S', status: 'connected', collectSource: 'rest' }],
    (i) => [vm('a2', 'a', 10), soapDay(i) ? vm('s2', 's', 5) : restVm('s2', 's')]);
  const h = await H.historySeries({ vcIds: new Set(['a2', 's2']), days: 6, now: TODAY, corpOf });
  // i = 5 … 0 → REST · SOAP · REST · SOAP · REST · SOAP
  assert.deepEqual(h.series.map((p) => p.gb), [10, 15, 10, 15, 10, 15]);
  for (const p of h.series) {
    if (p.gb === 10) { assert.equal(p.excluded, 1, `${p.day} — 부분 합인 날은 excluded 로 표시`); assert.equal(p.excludedRest, 1); } else { assert.equal(p.excluded, 0); assert.equal(p.excludedRest, 0); }
    assert.equal(p.missing, 0);
  }
  // 엣지가 REST 로 받은 위임 vCenter(collectSource 'site' + collectMethod 'rest' — view.vcReadIssue 'no-snap')도 같다
  await record(2, () => [{ id: 'a3', name: 'A', status: 'connected' }, { id: 'e3', name: 'E', status: 'connected', collectSource: 'site', collectMethod: 'rest' }],
    () => [vm('a3', 'a', 10), restVm('e3', 'e')]);
  const h2 = await H.historySeries({ vcIds: new Set(['a3', 'e3']), days: 2, now: TODAY, corpOf });
  assert.deepEqual(h2.series.map((p) => [p.gb, p.missing, p.excluded, p.excludedRest]), [[10, 0, 1, 1], [10, 0, 1, 1]]);
});

test('② 일시 실패(unreachable · stale · pending)와 일부만 읽은 날(partial)은 그대로 빠진 날 — REST 와 섞지 않는다', async () => {
  const bad = [
    { id: 'b4', name: 'B', status: 'unreachable' },
    { id: 'b4', name: 'B', status: 'connected', collectSource: 'site', stale: true },
    { id: 'b4', name: 'B', status: 'pending' },
    { id: 'b4', name: 'B', status: 'connected' },   // 개수를 못 읽은 VM 이 있다 → partial
  ];
  await record(5, (i) => [{ id: 'a4', name: 'A', status: 'connected' }, i === 4 ? { id: 'b4', name: 'B', status: 'connected' } : bad[3 - i]],
    (i) => [vm('a4', 'a', 10), i === 4 ? vm('b4', 'b', 5) : i === 0 ? { ...restVm('b4', 'b') } : vm('b4', 'b', 5)]);
  const st = await snapHistStmts();
  assert.deepEqual(H.dayKeys(TODAY, 5).map((d) => st.vcdayStatus.get(d, 'b4')?.status), ['ok', 'unreachable', 'stale', 'pending', 'partial'], '시험 재료 — 기록된 사유');
  const h = await H.historySeries({ vcIds: new Set(['a4', 'b4']), days: 5, now: TODAY, corpOf });
  assert.deepEqual(h.series.map((p) => p.gb), [15, null, null, null, null]);
  assert.deepEqual(h.series.map((p) => p.missing), [0, 1, 1, 1, 1]);
  assert.deepEqual(h.series.map((p) => p.excluded), [0, 0, 0, 0, 0], '못 읽은 날을 ‘뺀 날’ 로 세지 않는다');
  assert.deepEqual(h.series.map((p) => p.excludedRest), [0, 0, 0, 0, 0]);
  assert.deepEqual(h.gaps.map((g) => [g.vcenterId, g.days]), [['b4', 3]], '오늘은 세지 않는다 — 앞 3일이 빠진 날');
  // 빠진 vCenter 와 REST vCenter 가 같은 날 있으면 그날은 빠진 날(합이 없다)
  const rows = [{ day: 'd1', vcenter_id: 'x', status: 'ok', vms: 1, snaps: 1, gb: 1, gb_unknown: 0, over: 0 }, { day: 'd1', vcenter_id: 'y', status: 'unreachable' }, { day: 'd1', vcenter_id: 'z', status: 'no-snap' }];
  const [p] = H.aggregateDays(['d1'], rows, new Set(['x', 'y', 'z']), new Map([['x', 'd1'], ['y', 'd1'], ['z', 'd1']]));
  assert.deepEqual([p.gb, p.missing, p.excluded, p.excludedRest], [null, 1, 1, 1]);
});

test('④ 판정은 읽을 때(status) — 이미 기록된 no-snap 날에도 적용된다 · 138회차 전 위임 REST 의 partial 날은 그대로 빠진 날', () => {
  // DB 행 모양 그대로(예전 판이 쓴 행과 같다 — 쓰기 형식은 바뀌지 않았다)
  const days = ['2026-01-01', '2026-01-02'];
  const rows = [
    { day: days[0], vcenter_id: 'a', status: 'ok', vms: 2, snaps: 3, gb: 7.5, gb_unknown: 0, over: 1 }, { day: days[0], vcenter_id: 'r', status: 'no-snap' },
    { day: days[1], vcenter_id: 'a', status: 'ok', vms: 2, snaps: 3, gb: 7.5, gb_unknown: 0, over: 1 }, { day: days[1], vcenter_id: 'r', status: 'partial', vms: 1, snaps: 1, gb: 1, gb_unknown: 0, over: 0 },
  ];
  const s = H.aggregateDays(days, rows, new Set(['a', 'r']), new Map([['a', days[0]], ['r', days[0]]]));
  assert.deepEqual([s[0].vms, s[0].snaps, s[0].gb, s[0].over, s[0].missing, s[0].excluded, s[0].excludedRest], [2, 3, 7.5, 1, 0, 1, 1]);
  assert.deepEqual([s[1].vms, s[1].missing, s[1].excluded], [null, 1, 0], 'partial(개수 못 읽은 VM 있음)은 부분 합 — 추이에 넣지 않는다');
  // 상태 → 사유 표(빼는 것만 · 그 밖은 null)
  assert.deepEqual(['maintenance', 'disabled', 'no-snap', 'ok', 'partial', 'unreachable', 'stale', 'pending', 'toString', '__proto__', undefined].map(H.excludeKindOf),
    ['maint', 'maint', 'rest', null, null, null, null, null, null, null, null]);
});

test('③ 다른 소비처 — REST 날의 VM 이력은 0 이 아니라 모름 · 7일 변화는 그 vCenter 를 모른다(ok 로 기록한 날만)', async () => {
  // c5 는 8일 전 ~ 6일 전 REST · 그 뒤 SOAP
  await record(9, (i) => [{ id: 'c5', name: 'C', status: 'connected', ...(i >= 6 ? { collectSource: 'rest' } : {}) }], (i) => [i >= 6 ? restVm('c5', 'v') : vm('c5', 'v', 4)]);
  const v = await H.vmHistory({ vcenterId: 'c5', vmId: 'c5:v', days: 9, now: TODAY });
  assert.deepEqual(v.series.map((p) => p.count), [null, null, null, 1, 1, 1, 1, 1, 1], 'REST 날은 null(모름) — 0 으로 적지 않는다');
  const ago = await H.dayAgo({ vcIds: new Set(['c5']), n: 7, now: TODAY });
  assert.deepEqual([ago.okVcenters, ago.rows], [[], []], '7일 전이 REST 날이면 그 vCenter 의 변화는 모른다');
});
