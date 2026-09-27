// v2.632 감사 그룹 C(서버 데이터 정확성) 회귀 — AX2-2632-02..07.
// 원칙: '못 읽은 것' 을 0·지금·정상으로 만들지 않는다(부분 합을 전체라 말하지 않는다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2632c-'));
process.env.CONFIG_DIR = tmp;

// 고정 기준 시각(정시에서 30분 떨어진 과거 — CLAUDE.md '기준 시각은 경계에서 떨어뜨려 고정').
const T0 = Date.UTC(2026, 0, 5, 3, 30, 0);

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/* ── AX2-2632-02: NSX 읽지 못한 매니저 ───────────────────────────────── */
test('AX2-2632-02: 연결 실패 매니저가 섞이면 rollup 목록 합계는 null 이고 managersUnread 로 밝힌다', async () => {
  const { merge, rollup, unreadPart } = await import('../src/nsx/store.js');
  const ok = {
    manager: { id: 'm1', name: 'ok', status: 'connected' },
    gateways: [{ tier: 'T0' }, { tier: 'T1' }], segments: [{ type: 'OVERLAY' }, { type: 'VLAN' }],
    transportNodes: [{ type: 'host' }], firewall: { policies: 10, rules: 200 }, groups: 30,
  };
  const bad = unreadPart({ id: 'm2', name: 'down', status: 'unreachable' });
  const snap = rollup(merge([ok, bad], [], 'vcenter'));
  const r = snap.rollup;
  for (const f of ['t0', 't1', 'segments', 'overlaySegments', 'vlanSegments', 'hostNodes', 'edgeNodes', 'dfwPolicies', 'dfwRules', 'groups']) {
    assert.equal(r[f], null, `${f} 는 부분 합이 아니라 null 이어야 한다(실제 ${r[f]})`);
  }
  assert.equal(r.managersUnread, 1);
  const row = snap.managers.find((m) => m.id === 'm2');
  assert.equal(row.segments, null); assert.equal(row.gateways, null); assert.equal(row.transportNodes, null);
  assert.equal(row.groups, null); assert.equal(row.firewall.rules, null);
  // 전부 읽은 경우는 예전과 같다.
  const good = rollup(merge([ok], [], 'vcenter')).rollup;
  assert.equal(good.segments, 2); assert.equal(good.dfwRules, 200); assert.equal(good.groups, 30); assert.equal(good.managersUnread, 0);
});

test('AX2-2632-02: 수집 경로(unreachable·정지·대기)는 unreadPart 를 쓴다(소스)', () => {
  const src = fs.readFileSync(new URL('../src/nsx/store.js', import.meta.url), 'utf8');
  assert.equal((src.match(/unreadPart\((unreachableManager|pendingManager)\(/g) || []).length, 3);
  assert.ok(!/unreachableManager\([^)]*\)[^;]*firewall: \{ policies: 0/.test(src), '실패 매니저를 firewall 0 으로 합치지 않는다');
});

/* ── AX2-2632-03: Horizon 서버 실패 주기 ─────────────────────────────── */
test('AX2-2632-03: 읽지 못한 서버가 있는 주기의 합계는 추이에 적재하지 않는다(NULL)', async () => {
  const { combineServers, seriesRow } = await import('../src/horizon/sessions.js');
  const srv = (id, n) => ({ serverId: id, ok: true, sessions: n, connected: n - 20, disconnected: 20, pending: 0, users: n, usersConnected: n - 20, stateUnknown: 0,
    names: Array.from({ length: 3 }, (_, i) => ({ name: `${id}-u${i}`, sessions: 1, connected: 1 })) });
  const both = seriesRow(combineServers([srv('p1', 500), srv('p2', 500)]));
  assert.equal(both.sessions, 1000);
  const oneFailed = combineServers([srv('p1', 500), { serverId: 'p2', ok: false, error: 'timeout' }]);
  assert.equal(oneFailed.serversFailed, 1);
  const row = seriesRow(oneFailed);
  for (const k of ['users', 'usersConnected', 'sessions', 'connected', 'disconnected', 'pending']) assert.equal(row[k], null, k);
  // 서버 한 대의 레코드(serversFailed 없음)는 그대로 적재된다.
  assert.equal(seriesRow(srv('p1', 500)).sessions, 500);
});

/* ── AX2-2632-04: 이상탐지 척도 하한 ─────────────────────────────────── */
test('AX2-2632-04: pickScale — MAD·sd 가 하한보다 작으면 하한을 쓰고 그 사실을 밝힌다', async () => {
  const { pickScale } = await import('../src/insights/anomaly.js');
  assert.deepEqual(pickScale({ mad: 0, sd: 0.03, floor: 5 }), { scale: 5, source: 'floor' });
  assert.equal(pickScale({ mad: 10, sd: 3, floor: 5 }).source, 'mad');
  assert.equal(pickScale({ mad: 0, sd: 8, floor: 5 }).source, 'sd');
  assert.equal(pickScale({ mad: 0, sd: 0, floor: 0 }).scale, 0);
});

test('AX2-2632-04: 평탄한 DS 사용량 1000→1002GB 는 이상이 아니고, 1000→1100GB 는 이상이다', async () => {
  const db = await (await import('../src/metrics/db.js')).getMetricsDb();
  const { detectAnomalies } = await import('../src/insights/anomaly.js');
  // detectAnomalies 는 Date.now() 기준 24시간 창을 본다 — 표본은 창 한가운데(2~15시간 전)에 두어 경계와 떨어뜨린다.
  const now = Date.now();
  for (const [k, last] of [['ds-flat', 1002], ['ds-jump', 1100]]) {
    for (let i = 14; i >= 2; i--) db.insertMany([{ metric: 'ds_usedgb', k, v: 1000 }], now - i * 3600_000);
    db.insertMany([{ metric: 'ds_usedgb', k, v: last }], now - 20 * 60_000);
  }
  const res = await detectAnomalies({ bucketMin: 60 });
  const items = res.families.find((f) => f.metric === 'ds_usedgb').items;
  assert.ok(!items.some((i) => i.key === 'ds-flat'), `2GB 변화는 이상이 아니다: ${JSON.stringify(items)}`);
  const jump = items.find((i) => i.key === 'ds-jump');
  assert.ok(jump, '100GB 급증은 이상으로 잡혀야 한다');
  assert.ok(['mad', 'sd', 'floor'].includes(jump.scaleSource), '어느 척도를 썼는지 항목에 싣는다');
});

/* ── AX2-2632-05: 인시던트 발생 시각 ─────────────────────────────────── */
test('AX2-2632-05: 발생 시각을 모르는 vCenter 수집 실패는 at:null — 최근 24시간·일자별에 넣지 않는다', async () => {
  const { getIncidents, vcFailureStartTs } = await import('../src/insights/incidents.js');
  const { store } = await import('../src/store.js');
  assert.equal(vcFailureStartTs({ staleSince: T0 }), T0);
  assert.equal(vcFailureStartTs({ authStopped: { since: T0 } }), T0);
  assert.equal(vcFailureStartTs({ staleSince: String(T0) }), T0, '숫자 문자열은 연도로 파싱하지 않는다');
  assert.equal(vcFailureStartTs({}), null);
  const snap = store.get();
  snap.vcenters = [
    { id: 'vc-u', name: 'NoTime', status: 'unreachable', error: 'x' },
    { id: 'vc-s', name: 'StaleSince', status: 'unreachable', error: 'y', staleSince: T0 },
  ];
  const r = getIncidents({});
  const u = r.timeline.find((e) => e.key === 'vc:vc-u');
  assert.equal(u.ts, null); assert.equal(u.at, null); assert.equal(u.timeUnknown, true);
  const s = r.timeline.find((e) => e.key === 'vc:vc-s');
  assert.equal(s.ts, T0);
  assert.equal(r.summary.recent24h, 0, '10일 전 시작된 실패·시각 미상은 최근 24시간이 아니다');
  assert.equal(r.summary.timeUnknown, 1);
  const days = r.byDay.map((d) => d.day);
  const { dayKey } = await import('../src/util/dayKey.js');
  assert.deepEqual(days, [dayKey(T0)], '시각 미상은 어느 날짜 칸에도 들어가지 않는다');
  assert.equal(r.timeline[r.timeline.length - 1].key, 'vc:vc-u', '시각 미상은 뒤로');
});

/* ── AX2-2632-06: 자연어 검색 정렬 ───────────────────────────────────── */
test('AX2-2632-06: null 값은 방향과 무관하게 항상 뒤로', async () => {
  const { nlSortCompare } = await import('../src/llm/nlSearch.js');
  const rows = [{ p: 92 }, { p: null }, { p: 40 }, {}, { p: 7 }, { p: NaN }, { p: '' }];
  const desc = [...rows].sort(nlSortCompare('p', -1)).map((r) => r.p);
  assert.deepEqual(desc.slice(0, 3), [92, 40, 7]);
  assert.ok(desc.slice(3).every((v) => v == null || v === '' || Number.isNaN(v)));
  const asc = [...rows].sort(nlSortCompare('p', 1)).map((r) => r.p);
  assert.deepEqual(asc.slice(0, 3), [7, 40, 92]);
});

/* ── AX2-2632-07: 서버 온도 오래된 표본 ──────────────────────────────── */
test('AX2-2632-07: stale iDRAC 표본은 행에 남되 평균·최고·보고 수에서 빠지고 개수를 밝힌다', async () => {
  const { buildServerTempReport } = await import('../src/tools/serverTemp.js');
  const rep = buildServerTempReport({
    idracServers: [{ id: 'a', name: 'a', datacenterId: 'dc1' }, { id: 'b', name: 'b', datacenterId: 'dc1' }],
    latestOf: (s) => (s.id === 'a' ? { t: T0, temps: { 'System Board Inlet Temp': 22 } } : { t: T0 - 3 * 86_400_000, temps: { 'System Board Inlet Temp': 45 } }),
    now: T0 + 60_000,
  });
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.counts.stale, 1);
  assert.equal(rep.summary.all.reporting, 1);
  assert.equal(rep.summary.all.avgC, 22);
  assert.equal(rep.summary.all.curMaxC, 22);
  assert.equal(rep.summary.all.staleExcluded, 1);
  assert.equal(rep.byDatacenter[0].all.curMaxC, 22, '3일 전 45℃ 가 법인 최고가 되지 않는다');
});
