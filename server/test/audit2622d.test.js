// v2.622 감사 그룹 D — 이름 목록·원문 절단 하한값을 추이에 실제 값으로 적재하지 않는다 / 합집합이 하한을 밝힌다.
//   DATA-02: Horizon 합계(combineServers)가 서버당 maxUsers 로 잘린 이름 목록으로 합집합을 낸 주기
//   DATA-03: 현재 사용자(Windows) 발행기 원문 절단 서버가 섞인 주기 — vc_series 가 NOT NULL 이라 partial 표지로
//   DATA-06: '전체' 합집합(combineSources)이 출처의 하한(lowerBound)을 전달·표시
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2622d-'));
process.env.CONFIG_DIR = TMP;
process.env.CURUSER_DB_PATH = path.join(TMP, 'curuser.db');
// 기준 시각은 경계에서 떨어뜨려 고정한다(CLAUDE.md — Date.now() 금지).
const T0 = Date.UTC(2026, 8, 20, 3, 30, 0);

const mkSessions = (pre, n) => Array.from({ length: n }, (_, i) => ({ user_name: `${pre}${i}`, session_state: 'CONNECTED' }));

test('DATA-02: 이름 목록이 잘린 Horizon 합계의 사용자 수는 추이에 NULL(세션 수는 유지)', async () => {
  const { normalizeSessions, combineServers, seriesRow } = await import('../src/horizon/sessions.js');
  const a = { ok: true, serverId: 'cs1', ...normalizeSessions(mkSessions('a', 2500), { maxUsers: 2000 }) };
  const b = { ok: true, serverId: 'cs2', ...normalizeSessions(mkSessions('b', 2500), { maxUsers: 2000 }) };
  const t = combineServers([a, b]);
  assert.equal(t.usersLowerBound, true);
  assert.equal(t.truncated, false);
  const row = seriesRow(t);
  assert.equal(row.users, null, '하한(4000)을 실제 값(5000)처럼 적재하지 않는다');
  assert.equal(row.usersConnected, null);
  assert.equal(row.sessions, 5000, '세션은 전부 읽었으므로 그대로');
  assert.equal(row.connected, 5000);
  // 서버 한 대의 users 는 자르기 전 개수라 정확하다 — 서버 행은 그대로 적재한다.
  assert.equal(a.usersOmitted, 500);
  assert.equal(seriesRow(a).users, 2500);
  // 상한 안이면 예전 그대로.
  const small = combineServers([{ ok: true, serverId: 'cs1', ...normalizeSessions(mkSessions('c', 10)) }]);
  assert.equal(seriesRow(small).users, 10);
});

test('DATA-03: 원문 절단 서버가 섞인 주기는 partial 로 적재되고 seriesRange 가 null 로 읽는다', async () => {
  const { aggregateAll, seriesRow } = await import('../src/curuser/aggregate.js');
  const recs = [
    { vmId: 'vm1', vcenterId: 'vc1', ok: true, kind: 'ok', truncated: true, sessions: 2, active: 2, users: [{ name: 'a', kind: 'active' }, { name: 'b', kind: 'active' }] },
    { vmId: 'vm2', vcenterId: 'vc1', ok: true, kind: 'ok', sessions: 1, active: 1, users: [{ name: 'c', kind: 'active' }] },
  ];
  const agg = aggregateAll(recs);
  assert.equal(agg.total.usersLowerBound, true);
  const row = seriesRow(agg.total);
  assert.equal(row.partial, true);
  assert.equal(row.users, null);
  assert.equal(row.sessions, null);
  assert.equal(row.vmsOk, 2);
  const full = seriesRow(aggregateAll([recs[1]]).total);
  assert.equal(full.partial, false);
  assert.equal(full.users, 1);

  const db = await import('../src/curuser/db.js');
  db._resetForTest?.();
  const c1 = await db.commitCurUser({ ts: T0, records: recs, series: [{ vcenterId: '', ...row }], replaceVcenters: ['vc1'] });
  assert.equal(c1.ok, true, String(c1.reason || ''));
  await db.commitCurUser({ ts: T0 + 600_000, records: [recs[1]], series: [{ vcenterId: '', ...full }], replaceVcenters: ['vc1'] });
  const r = await db.seriesRange('', T0 - 1, T0 + 700_000);
  assert.equal(r.available, true);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].users, null, '하한 주기는 0 이 아니라 null');
  assert.equal(r.rows[0].sessions, null);
  assert.equal(r.rows[1].users, 1);
  assert.equal(r.partialRows, 1);
  assert.equal(r.unknownRows, 0);
});

test('DATA-06: combineSources 는 출처의 lowerBound 를 unionLowerBound 로 밝힌다', async () => {
  const { combineSources } = await import('../src/curuser/combine.js');
  const c = combineSources({
    windows: { state: 'ok', names: [{ name: 'x' }] },
    vdi: { state: 'ok', names: [{ name: 'y' }], lowerBound: true },
  });
  assert.equal(c.partial, false);
  assert.equal(c.unionLowerBound, true);
  assert.deepEqual(c.lowerBoundSources.map((s) => s.key), ['vdi']);
  const d = combineSources({ windows: { state: 'ok', names: [{ name: 'x' }] }, vdi: { state: 'ok', names: [] } });
  assert.equal(d.unionLowerBound, false);
  // 꺼진 출처의 lowerBound 는 의미가 없다(읽지 않았다).
  const e = combineSources({ windows: { state: 'off', names: [], lowerBound: true }, vdi: { state: 'ok', names: [{ name: 'y' }] } });
  assert.equal(e.unionLowerBound, false);
});

test('DATA-06: 합집합 라우트가 두 출처의 usersLowerBound 를 lowerBound 로 싣는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/horizonSessions.js', import.meta.url), 'utf8'));
  assert.match(src, /names:\s*rep\.total\.names,\s*lowerBound:\s*!!rep\.total\.usersLowerBound/);
  assert.match(src, /names:\s*total\.names,\s*lowerBound:\s*!!total\.usersLowerBound/);
});
