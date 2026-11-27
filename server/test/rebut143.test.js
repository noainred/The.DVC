/**
 * rebut143.test.js — 새 코드 점검 143회차(138회차 스냅샷 이력 수정의 반증).
 *   N143-2: 스냅샷 이력 폴러 상태의 warn 이 ‘이 틱’ 만 봐서, 기록이 실패한 뒤 다시 시도를 기다리는 틱(10분 중 9분)이 ok 로 덮었다 —
 *           디스크 가득처럼 매번 실패해도 포탈 상태는 대부분 ‘정상’ 이었다. 마지막 기록 시도(lastResult)의 실패도 warn 이다.
 *   N143-3: vmtrack(추이 트래킹) 상태가 lastResult(슬롯 기록 — 하루 2번)뿐이라 기록 30분 뒤부터 다음 슬롯까지 거짓 ‘주의’,
 *           재시작 뒤 슬롯이 이미 채워져 있으면 ‘한 번도 돌지 않았습니다’ 였다 — 틱 시각 · 주기 · 실패를 싣는다(vmtrackTick).
 *   N143-4: historySeries 가 법인마다 · vCenter 마다 전체 행을 다시 훑었다(O(vCenter × 행) — 30곳 · 400일 약 110ms 동기) — 한 번 묶는다(결과 같음).
 *   N143-5: dayKeys · dayAgo 가 `now - n×24h` 의 로컬 날짜라 서머타임 지역(엣지)에서 하루를 빼거나 겹쳤다 — 달력으로 센다.
 *   그 밖: 138회차 수정이 지키는 것(지금 읽은 vCenter 의 진짜 ‘다 지운 VM’ · 7일 전 못 읽은 vCenter 의 VM 을 ‘새로 생김’ 으로 세지 않음 ·
 *          record 사유 판정이 예전 판정과 collectMethod 'rest' 외에는 같음)을 실행으로 고정한다.
 */
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut143-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });
process.env.SNAPHIST_DB_PATH = path.join(TMP, 'snap-history.db');
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vmtrack.db');
process.env.CONFIG_DIR = process.env.CONFIG_DIR || TMP;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const { dayRecord } = await import('../src/snaphist/record.js');
const { vcReadIssue } = await import('../src/snaphist/view.js');
const db = await import('../src/snaphist/db.js');
const H = await import('../src/snaphist/history.js');
const P = await import('../src/snaphist/poller.js');
const V = await import('../src/vmtrack/poller.js');
const { store } = await import('../src/store.js');
const { pollerCheck } = await import('../src/health/services.js');
const { unreadVcenterReasons } = await import('../src/metrics/unreadVcenters.js');

const DAY = 86_400_000; const HOUR = 3_600_000; const MIN = 60_000;
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const UP = 48 * HOUR;
const HY = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [], notify: { enabled: false, hour: 9 } };
const vm = (vc, id, o = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, powerState: 'POWERED_ON', template: false, snapshotCount: 1, snapshotSizeGB: 20,
  snapshotOldestTs: NOW - 30 * DAY, snapshotTree: [{ d: 0, name: `s-${id}`, ts: NOW - 30 * DAY }], ...o });

test('N143-2 — 스냅샷 이력: 기록이 실패하면 다시 시도를 기다리는 틱 동안에도 상태는 주의 · 다음 시도가 성공하면 정상', async () => {
  const d = new Date(NOW); d.setHours(4, 0, 0, 0);
  const T = d.getTime() - 60 * DAY;   // 60일 전 04:00 — 다른 시험의 날과 겹치지 않게
  store.snapshot = { generatedAt: 'r143-a', vcenters: [{ id: 'vf', name: 'F', status: 'connected' }], vms: [vm('vf', 'f1', { snapshotCount: 0 })] };
  const st = await db.snapHistStmts();
  const orig = st.vcdayStatus;
  st.vcdayStatus = { get() { throw new Error('database or disk is full'); } };   // commitDay 가 쓰는 문 그대로 — 디스크 가득
  try {
    const r = await P.runSnapHistOnce({ now: T });
    assert.equal(r.ok, false);
    for (const m of [0, 1, 5, 9]) {
      const now = T + m * MIN;
      if (m) assert.equal((await P.runSnapHistOnce({ now })).idle, 'waiting', '다시 시도 간격 안 — 기록하지 않는 틱');
      const row = pollerCheck(P.snapHistPollerStatus(), { now, uptimeMs: UP });
      assert.equal(row.status, 'warn', `실패 ${m}분 뒤(기다리는 틱)도 주의: ${row.detail}`);
      assert.match(row.detail, /disk is full/);
    }
  } finally { st.vcdayStatus = orig; }
  const ok = await P.runSnapHistOnce({ now: T + 10 * MIN });
  assert.equal(ok.ok, true); assert.equal(ok.recorded, 1);
  assert.equal(pollerCheck(P.snapHistPollerStatus(), { now: T + 10 * MIN, uptimeMs: UP }).status, 'ok', '다시 시도가 성공하면 정상');
  assert.equal(pollerCheck(P.snapHistPollerStatus(), { now: T + 10 * MIN + 31 * MIN, uptimeMs: UP }).status, 'warn', '틱이 30분 넘게 멈추면 주의(138 그대로)');
});

test('N143-3 — vmtrack: 슬롯 기록 뒤 틱이 돌면 정상(예전: 30분 뒤부터 다음 슬롯까지 주의) · 틱이 멈추면 주의', async () => {
  store.snapshot = { generatedAt: 'r143-v', vcenters: [{ id: 'vt', name: 'T', status: 'connected' }], vms: [vm('vt', 't1'), vm('vt', 't2')], hosts: [], datastores: [] };
  const d = new Date(NOW); d.setHours(1, 0, 0, 0);
  const T0 = d.getTime() - 50 * DAY;
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    await V.vmtrackTick();
    const s0 = V.vmtrackPollerStatus();
    assert.ok(s0.lastResult, '그 슬롯을 기록했다');
    assert.equal(s0.intervalMs, 60_000);
    for (const h of [1, 6, 10]) {
      mock.timers.setTime(T0 + h * HOUR);
      await V.vmtrackTick();   // 슬롯은 이미 채워져 있다 — 쉬는 틱
      const row = pollerCheck(V.vmtrackPollerStatus(), { now: T0 + h * HOUR, uptimeMs: UP });
      assert.equal(row.status, 'ok', `슬롯 기록 ${h}시간 뒤에도 틱이 돌면 정상: ${row.detail}`);
    }
    assert.equal(pollerCheck(V.vmtrackPollerStatus(), { now: T0 + 10 * HOUR + 31 * MIN, uptimeMs: UP }).status, 'warn', '틱이 30분 넘게 멈추면 주의');
    assert.ok(V.vmtrackPollerStatus().lastResult.at < T0 + 10 * HOUR, 'lastResult(화면 ‘최근 스냅샷’)는 슬롯 기록 시각 — 쉬는 틱은 바꾸지 않는다');
  } finally { mock.timers.reset(); }
});

test('N143-2 · N143-3 — DB 를 열 수 없으면(경로가 폴더) 두 폴러 상태 모두 주의 + 사유(별도 프로세스)', () => {
  const dirA = path.join(TMP, 'snap-as-dir'); const dirB = path.join(TMP, 'vmtrack-as-dir');
  fs.mkdirSync(dirA); fs.mkdirSync(dirB);
  const script = path.join(TMP, 'dbfail.mjs');
  fs.writeFileSync(script, `
    const SRC = ${JSON.stringify(SRC)};
    const { store } = await import(SRC + '/store.js');
    const P = await import(SRC + '/snaphist/poller.js');
    const V = await import(SRC + '/vmtrack/poller.js');
    const { pollerCheck } = await import(SRC + '/health/services.js');
    store.snapshot = { generatedAt: 'f', vcenters: [{ id: 'vx', name: 'X', status: 'connected' }], vms: [] };
    const r = await P.runSnapHistOnce({ force: true });
    await V.vmtrackTick();
    const now = Date.now();
    console.log(JSON.stringify({ r, snap: pollerCheck(P.snapHistPollerStatus(), { now, uptimeMs: ${UP} }), vt: pollerCheck(V.vmtrackPollerStatus(), { now, uptimeMs: ${UP} }) }));
    process.exit(0);
  `);
  const out = spawnSync(process.execPath, [script], { env: { ...process.env, SNAPHIST_DB_PATH: dirA, VMTRACK_DB_PATH: dirB, CONFIG_DIR: TMP }, encoding: 'utf8', timeout: 60_000 });
  const line = String(out.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
  assert.ok(line, `자식 출력 없음: ${out.stderr}`);
  const j = JSON.parse(line);
  assert.equal(j.r.ok, false);
  assert.equal(j.snap.status, 'warn'); assert.match(j.snap.detail, /DB 사용 불가/);
  assert.equal(j.vt.status, 'warn'); assert.match(j.vt.detail, /DB 사용 불가/);
});

test('N143-4 — historySeries 는 행을 vCenter 별로 한 번 묶는다(행 읽기 횟수가 법인 수에 비례하지 않는다) · 결과는 예전 계산과 같다', async () => {
  const vcs = Array.from({ length: 12 }, (_, i) => ({ id: `ve${i}`, name: `E${i}`, status: 'connected' }));
  const base = NOW - 200 * DAY;
  for (let i = 0; i < 10; i += 1) {
    const day = base + i * DAY;
    const cur = vcs.map((vc, j) => ((i + j) % 7 === 3 ? { ...vc, status: 'maintenance', maintenance: true } : (i + j) % 5 === 1 ? { ...vc, status: 'unreachable' } : vc));
    // 앞 2일은 6곳만 기록(나머지는 기록 시작 전) — 점검중(뺀 날) · unreachable(빠진 날)이 섞인다
    await db.commitDay(dayRecord({ vcenters: i < 2 ? cur.slice(0, 6) : cur, vms: vcs.map((vc) => vm(vc.id, 'x', { snapshotSizeGB: 1 + (i % 3) })) }, { now: day, hygiene: HY }));
  }
  const ids = new Set(vcs.map((v) => v.id));
  const corpOf = (id) => ({ corpId: `c${Number(id.slice(2)) % 4}` });
  const now = base + 9 * DAY + 6 * HOUR;
  const st = await db.snapHistStmts();
  const orig = st.vcdaySince;
  let reads = 0; let n = 0;
  st.vcdaySince = { all(...a) {
    const rows = orig.all(...a); n = rows.length;
    return new Proxy(rows, { get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) reads += 1; return Reflect.get(t, k, r); } });
  } };
  let got;
  try { got = await H.historySeries({ vcIds: ids, days: 10, now, corpOf }); } finally { st.vcdaySince = orig; }
  assert.ok(n >= 100, `행 ${n}`);
  assert.ok(reads <= 3 * n, `행 읽기 ${reads}회 — 행 ${n}개의 3배 이하여야(예전: 법인 4 + vCenter 12 번 더 훑어 약 ${18 * n}회)`);
  // 예전 계산(138회차 판본) — 같은 결과
  const keys = H.dayKeys(now, 10);
  const rows = orig.all(keys[0]);
  const firstOk = new Map(); for (const id of ids) { const f = st.firstDay.get(id)?.d; if (f) firstOk.set(id, f); }
  const groups = new Map(); for (const id of ids) { const c = corpOf(id).corpId; if (!groups.has(c)) groups.set(c, new Set()); groups.get(c).add(id); }
  const byCorp = {}; for (const [c, g] of groups) byCorp[c] = H.aggregateDays(keys, rows, g, firstOk);
  const gaps = [];
  for (const id of ids) {
    const f = firstOk.get(id); if (!f) continue;
    const ok = new Set(rows.filter((r) => r.vcenter_id === id && (r.status === 'ok' || r.status === 'maintenance' || r.status === 'disabled')).map((r) => r.day));
    const miss = keys.filter((x) => x >= f && !ok.has(x) && x !== keys[keys.length - 1]);
    if (miss.length) gaps.push({ vcenterId: id, days: miss.length, last: miss[miss.length - 1] });
  }
  assert.deepEqual(got.byCorp, byCorp);
  assert.deepEqual(got.gaps, gaps);
  assert.deepEqual(got.series, H.aggregateDays(keys, rows, ids, firstOk));
  assert.ok(got.gaps.length > 0 && Object.values(got.byCorp).some((s) => s.some((p) => p.excluded > 0)), '시험 재료에 빠진 날 · 뺀 날이 있다');
});

test('N143-5 — 서머타임 지역(TZ=Europe/Warsaw)에서도 날 열쇠는 달력으로(빠지거나 겹치지 않는다) · 7일 전은 달력 7일 전', async () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Europe/Warsaw';
  try {
    const cases = [new Date(2026, 2, 30, 0, 30).getTime(), new Date(2026, 9, 25, 23, 30).getTime(), new Date(2026, 3, 2, 0, 30).getTime()];
    for (const now of cases) {
      const k = H.dayKeys(now, 10);
      assert.equal(new Set(k).size, 10, `겹침 없음: ${k}`);
      const d = new Date(now);
      for (let i = 0; i < 10; i += 1) {
        const want = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (9 - i), 12);
        assert.equal(k[i], `${want.getFullYear()}-${String(want.getMonth() + 1).padStart(2, '0')}-${String(want.getDate()).padStart(2, '0')}`, `${new Date(now).toString()} 의 ${i}번째`);
      }
      const w7 = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7, 12);
      assert.equal(H.dayKeyAgo(now, 7), `${w7.getFullYear()}-${String(w7.getMonth() + 1).padStart(2, '0')}-${String(w7.getDate()).padStart(2, '0')}`);
      const ago = await H.dayAgo({ vcIds: new Set(['none']), n: 7, now });
      assert.equal(ago.day, H.dayKeyAgo(now, 7), 'dayAgo 도 같은 날');
    }
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

test('138 반증 — record 사유 판정은 예전 판정과 collectMethod ‘rest’(엣지 REST 위임) 조합에서만 다르다(전수 대조)', () => {
  // 예전 record.js(611bd380^) 의 판정 그대로
  const old = (vc, vcId, unread) => unread.get(vcId) || (!vc ? 'unreachable' : vc.status === 'pending' ? 'pending' : vc.status === 'disabled' ? 'disabled' : null)
    || (vc.collectSource === 'rest' ? 'no-snap' : null);
  let n = 0; let diff = 0;
  for (const status of ['connected', 'unreachable', 'pending', 'disabled', 'maintenance', 'disconnected', undefined]) {
    for (const collectSource of [undefined, 'rest', 'site', 'soap']) {
      for (const collectMethod of [undefined, 'rest', 'soap']) {
        for (const stale of [undefined, true, false]) {
          for (const maintenance of [undefined, true]) {
            const vc = { id: 'v', status, collectSource, collectMethod, stale, maintenance };
            const unread = unreadVcenterReasons({ vcenters: [vc] });
            const a = old(vc, 'v', unread); const b = vcReadIssue(vc, 'v', unread);
            n += 1;
            if (a !== b) { diff += 1; assert.equal(collectMethod, 'rest', JSON.stringify(vc)); assert.equal(b, 'no-snap'); assert.equal(a, null); }
          }
        }
      }
    }
  }
  assert.ok(n >= 500 && diff > 0);
  assert.equal(vcReadIssue(undefined, 'gone', new Map()), old(undefined, 'gone', new Map()));
});

test('138 반증 — 7일 변화 재료: 지금 읽은 vCenter 의 7일 전 행은 그대로 · 7일 전에 못 읽은 vCenter 는 재료에 없다(‘새로 생김’ 으로 세지 않는 근거)', async () => {
  const now = NOW - 100 * DAY;
  await db.commitDay(dayRecord({ vcenters: [{ id: 'vr', name: 'R', status: 'connected' }, { id: 'vu', name: 'U', status: 'unreachable' }],
    vms: [vm('vr', 'r1'), vm('vr', 'r2')] }, { now: now - 7 * DAY, hygiene: HY }));
  const ago = await H.dayAgo({ vcIds: new Set(['vr', 'vu']), n: 7, now });
  assert.deepEqual(ago.okVcenters, ['vr']);
  assert.deepEqual(ago.rows.map((r) => r.vmId).sort(), ['vr:r1', 'vr:r2'], '지금 r2 를 다 지웠으면 화면이 ‘다 지운 VM’ 으로 셀 재료가 남아 있다');
});
