/**
 * test/vmChanges2932.test.js — v2.932(문서 후보 — 구성 변경 이력 보고서가 최신 2만 행만 읽어 '7일' 이 약 1시간으로 짧아지던 것).
 *  ① 누적기: 행을 조각으로 나눠 넣어도 한 번에 넣은 analyzeMoves · analyzeChanges 와 결과가 같다(목록 상한 · 개수는 전부)
 *  ② logs DB trackedEventsEach: 모으지 않고 최신 조각부터 흘려보낸다 — 순서 · 내용이 trackedEventsAsync 와 같고,
 *     상한에 닿으면 truncated + coveredSince(그보다 새 행은 빠짐없이 넘겼다)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmchg2932-'));
process.env.CONFIG_DIR = TMP;
const { analyzeMoves, analyzeChanges, createMovesAcc, createChangesAcc, EVENT_ROWS_MAX } = await import('../src/vmchanges/analyze.js');

const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;   // 정시에서 떨어뜨린 기준 시각(규약 — 실제 시각 기준)

function synth(n) {
  const types = ['DrsVmMigratedEvent', 'VmMigratedEvent', 'VmReconfiguredEvent', 'PermissionAddedEvent', 'VmRelocatedEvent'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length];
    const detail = type === 'VmReconfiguredEvent' ? JSON.stringify({ numCpu: (i % 8) + 1 }) : type.includes('Migrat') ? JSON.stringify({ from: `esx-${i % 3}`, to: `esx-${(i + 1) % 3}`, kind: type.startsWith('Drs') ? 'drs' : 'vmotion' }) : null;
    out.push({ vcenterId: `vc${i % 2}`, ts: NOW - i * 60_000, type, user: `u${i % 7}`, entity: `vm-${i % 40}`, message: `m${i}`, detail });
  }
  return out;   // 최신 먼저(trackedEvents 순서)
}

test('① 누적기 — 조각으로 나눠 넣어도 한 번에 넣은 결과와 같다(목록 상한 · 개수 전부)', () => {
  const rows = synth(EVENT_ROWS_MAX * 3 + 17);
  const opts = { days: 7, now: NOW, vcName: new Map([['vc0', 'VC-0'], ['vc1', 'VC-1']]), q: '' };
  const mv = createMovesAcc(opts); const ch = createChangesAcc(opts);
  for (let i = 0; i < rows.length; i += 997) { mv.add(rows.slice(i, i + 997)); ch.add(rows.slice(i, i + 997)); }
  assert.deepEqual(mv.result(), analyzeMoves(rows, opts));
  const once = analyzeChanges(rows, opts);
  assert.deepEqual(ch.result(), once);
  assert.equal(once.events.length, EVENT_ROWS_MAX);
  assert.ok(once.omitted > 0 && once.matched === once.events.length + once.omitted, '목록은 최신 상한까지 · 개수는 전부');
  assert.equal(once.events[0].ts, Math.max(...rows.filter((r) => r.type === 'VmReconfiguredEvent' || r.type === 'PermissionAddedEvent').map((r) => r.ts)), '목록 첫 줄은 가장 최신');
  // 검색 · 종류로 좁혀도 같다
  const o2 = { ...opts, q: 'vm-3', kind: 'reconfig' };
  const ch2 = createChangesAcc(o2); for (let i = 0; i < rows.length; i += 500) ch2.add(rows.slice(i, i + 500));
  assert.deepEqual(ch2.result(), analyzeChanges(rows, o2));
});

test('② logs DB trackedEventsEach — 최신 조각부터 흘려보낸다 · 상한이면 truncated + coveredSince', async () => {
  const { getLogsDb, resetLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  const recs = synth(3000).map((r, i) => ({ ...r, key: `k${i}`, severity: 'info', ts: NOW - i * 3 * 60_000 }));   // 3분 간격 · 약 6.25일
  await db.insertManyAsync(recs);
  const f = { vcenterIds: ['vc0', 'vc1'], since: NOW - 7 * DAY };
  const all = await db.trackedEventsAsync(f, 50_000, { now: NOW });
  const got = [];
  let r = await db.trackedEventsEach(f, (rows) => { got.push(...rows); }, { now: NOW, maxRows: 1_000_000 });
  assert.equal(r.truncated, false);
  assert.equal(r.rows, all.length);
  assert.deepEqual(got, all, '순서 · 내용이 조각 판과 같다');
  // 상한 — 그보다 새 행은 빠짐없이
  const part = [];
  r = await db.trackedEventsEach(f, (rows) => { part.push(...rows); }, { now: NOW, maxRows: 1234 });
  assert.equal(r.truncated, true);
  assert.equal(r.rows, 1234);
  assert.equal(r.coveredSince, part[part.length - 1].ts);
  assert.deepEqual(part, all.slice(0, 1234), '상한까지는 최신부터 빠짐없이');
  // 화면 라우트가 쓰는 누적기 결과 = 모아서 센 결과(상한 안)
  const mv = createMovesAcc({ days: 7, now: NOW });
  await db.trackedEventsEach(f, (rows) => mv.add(rows), { now: NOW });
  assert.deepEqual(mv.result(), analyzeMoves(all, { days: 7, now: NOW }));
  // 빈 vCenter 목록 = 0건(전체가 아니다)
  assert.deepEqual(await db.trackedEventsEach({ vcenterIds: [], since: 0 }, () => { throw new Error('부르면 안 된다'); }), { rows: 0, truncated: false, coveredSince: null });
  resetLogsDb();
});

test('③ 라우트 — 화면은 흘려보내며 센다(행을 모으지 않는다) · CSV 만 READ_MAX', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/vmChanges.js', import.meta.url), 'utf8');
  assert.match(src, /trackedEventsEach\(\{ vcenterIds: ids, since \}, stream, \{ maxRows: SCAN_MAX \}\)/);
  assert.match(src, /coveredSince: L\.truncated \? L\.coveredSince : null/);
  assert.doesNotMatch(src, /analyzeMoves\(L\.rows/, '화면이 모은 행을 다시 세지 않는다');
});
