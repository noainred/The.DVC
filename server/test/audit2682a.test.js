/**
 * audit2682a — 3회차 점검 그룹 A(Overview 카드 · 전력 · 스토리지 합계) 회귀.
 *   R3D-03 스토리지 전력 부분 합(일부 PSU 만 읽음) · R3D-08 시스템 합계 되풀이 · R3D-05 용량 카드 사용량 모름·낡음 ·
 *   R3D-10 물리·GPU 카드 비활성·오래된 인벤토리 · R3S-07 원천 오류 원문 가림 · R3A-01 경영 보기 스토리지 추이 knownIds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'audit2682a-'));

const H = 3_600_000;

/* ── R3D-03 ─────────────────────────────────────────────────────────────── */

test('R3D-03 일부 PSU 값을 못 읽으면 partial·missing 을 싣는다(빈 슬롯은 세지 않는다)', async () => {
  const { applyScannedPower } = await import('../src/storage/power.js');
  const ex = {};
  applyScannedPower(ex, [{ inputPower: 300 }, { inputPower: 310 }, { inputPower: null }, { inputPower: 'N/A' }], { source: 'x', scope: 'system' });
  assert.equal(ex.power.watts, 610);
  assert.equal(ex.power.partial, true);
  assert.equal(ex.power.missing, 2);
  // 빈 슬롯(state absent)의 null 은 부품이 아니다 — 온전한 합.
  const ex2 = {};
  applyScannedPower(ex2, [{ inputPower: 300 }, { inputPower: 310 }, { state: 'Absent', inputPower: null }], { source: 'x' });
  assert.equal(ex2.power.watts, 610);
  assert.equal(ex2.power.partial, undefined, '빈 슬롯은 부분 합 표지를 만들지 않는다');
  // 전부 읽었으면 예전 모양 그대로(partial 필드 없음).
  const ex3 = {};
  applyScannedPower(ex3, [{ inputPower: 300 }, { inputPower: 310 }], { source: 'x' });
  assert.equal(ex3.power.partial, undefined);
});

test('R3D-03 power/total.js — 부분 합 스토리지는 measured 가 아니라 partial 로 센다(전력은 더한다)', async () => {
  const { buildPowerTotal } = await import('../src/power/total.js');
  const now = Date.now();
  const mk = (id, power) => ({ id, name: id, type: 'powerstore', collectMethod: 'api', enabled: true, snap: { ok: true, collectedAt: now - 60_000, extra: { power: { watts: 0, at: now - 60_000, ...power } } } });
  const r = buildPowerTotal({ storage: [mk('A', { watts: 600 }), mk('B', { watts: 610, partial: true, missing: 2 })], now });
  assert.equal(r.storage.watts, 1210);
  assert.equal(r.storage.measured, 1);
  assert.equal(r.storage.partial, 1);
  assert.equal(r.storage.partialWatts, 610);
  const b = r.storage.items.find((x) => x.id === 'B');
  assert.equal(b.partial, true);
  assert.equal(b.missing, 2);
});

/* ── R3D-08 ─────────────────────────────────────────────────────────────── */

test('R3D-08 같은 시스템 합계가 한 응답의 두 자리(요약·상세)에 같은 값이면 한 번만 센다', async () => {
  const { applyScannedPower, pickPower, scanPower } = await import('../src/storage/power.js');
  const ex = {};
  applyScannedPower(ex, { summary: { currentPower: 1200 }, system: { currentPower: 1200 } }, { source: 'y' });
  assert.equal(ex.power.watts, 1200, '예전에는 2400');
  // 배열 원소(여러 어레이)는 같은 값이어도 합친다.
  const ex2 = {};
  applyScannedPower(ex2, [{ currentPower: 500 }, { currentPower: 500 }], { source: 'y' });
  assert.equal(ex2.power.watts, 1000);
  // 수집기가 어레이마다 따로 훑은 같은 경로(PowerMax 방식)도 합친다.
  const hits = [...scanPower({ currentPower: 700 }).hits, ...scanPower({ currentPower: 700 }).hits];
  assert.equal(pickPower(hits).watts, 1400);
  // 두 자리의 값이 다르면 예전 그대로 합한다(다른 합계일 수 있다).
  const ex3 = {};
  applyScannedPower(ex3, { a: { currentPower: 100 }, b: { currentPower: 200 } }, { source: 'y' });
  assert.equal(ex3.power.watts, 300);
});

/* ── R3D-05 ─────────────────────────────────────────────────────────────── */

test('R3D-05 용량 카드 — 사용량 모름(usedUnknown)과 낡은 스냅샷(stale)을 따로 센다', async () => {
  const { storageCapacityTotals } = await import('../src/routes/api/overviewCards.js');
  const now = 1_800_000_000_000;
  const items = [
    { agent: '', snap: { ok: true, collectedAt: now - H, capacity: { totalBytes: 1000, usedBytes: 700 } } },
    { agent: '', snap: { ok: true, collectedAt: now - H, capacity: { totalBytes: 1000, usedBytes: null } } },
    { agent: '', snap: { ok: true, collectedAt: now - 10 * 24 * H, capacity: { totalBytes: 1000, usedBytes: 0 } } },
  ];
  const r = storageCapacityTotals(items, { now, staleMsOf: () => 6 * H });
  assert.equal(r.stale, 1);
  assert.equal(r.read, 2);
  assert.equal(r.totalBytes, 2000, '낡은 장비는 합계에서 빠진다');
  assert.equal(r.usedUnknown, 1);
  assert.equal(r.usedPct, 70, '사용률은 사용량을 읽은 장비끼리');
  // staleMsOf 를 주지 않으면 낡음 판정을 하지 않는다(예전 호출 호환).
  assert.equal(storageCapacityTotals(items, { now }).stale, 0);
});

/* ── R3D-10 ─────────────────────────────────────────────────────────────── */

test('R3D-10 물리·GPU 카드 — 비활성 서버는 세지 않고, 오래된 인벤토리는 읽음이 아니다', async () => {
  const { physicalGpuCounts, INVENTORY_STALE_MS } = await import('../src/routes/api/overviewCards.js');
  const now = 1_800_000_000_000;
  const inv = {
    a: { collectedAt: now - H, gpus: [{ model: 'A40' }, { model: 'A40' }] },
    b: { collectedAt: now - INVENTORY_STALE_MS - H, gpus: [{ model: 'T4' }] },
    c: { collectedAt: new Date(now - H).toISOString(), gpus: [{ name: 'L4' }] },
    d: { collectedAt: now - H, gpus: [{ model: 'H100' }] },
  };
  const servers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', enabled: false }, { id: 'e' }];
  const r = physicalGpuCounts(servers, (s) => inv[s.id] || null, now);
  assert.equal(r.count, 4, '비활성 1대 제외');
  assert.equal(r.disabled, 1);
  assert.equal(r.invRead, 2);
  assert.equal(r.invStale, 1);
  assert.equal(r.gpus, 3, '오래된 인벤토리·비활성 서버의 GPU 는 세지 않는다');
});

/* ── R3S-07 ─────────────────────────────────────────────────────────────── */

test('R3S-07 원천 오류 원문은 admin 에게만 — 그 밖에는 실패 사실·개수만', async () => {
  const { cardErrorsFor } = await import('../src/routes/api/overviewCards.js');
  const errors = { network: 'connect ECONNREFUSED 10.20.30.40:443', storage: '' };
  assert.deepEqual(cardErrorsFor(errors, true), { errors });
  const r = cardErrorsFor(errors, false);
  assert.deepEqual(r.errors, { network: true });
  assert.equal(r.errorsHidden, 1);
  assert.ok(!JSON.stringify(r).includes('10.20.30.40'));
});

test('R3S-07 라우트 — 카드 응답의 오류는 cardErrorsFor 를 거치고 캐시 키에 역할이 들어간다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/overviewCards.js', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.cardErrorsFor\(p\.errors, admin\)/);
  assert.doesNotMatch(src, /errors: p\.errors/);
  assert.match(src, /extraKey: `\$\{scopeKey\(req\.user, snap\)\}\|role:/);
  assert.match(src, /errorHidden: true/);
});

/* ── R3A-01 ─────────────────────────────────────────────────────────────── */

test('R3A-01 경영 보기 스토리지 추이 — 등록·활성 장비를 knownIds 로 넘긴다(등록부 오류면 null)', async () => {
  const { storageTrendHistoryOpts } = await import('../src/routes/api/overviewCards.js');
  const devs = [{ id: 'A', agent: '' }, { id: 'B', agent: 'edge1' }, { id: 'C', enabled: false }];
  const poll = { envPoll: H, pollOf: new Map([['', H], ['edge1', 2 * H]]) };
  const o = storageTrendHistoryOpts(devs, 123, { poll });
  assert.deepEqual(o.knownIds, ['A', 'B']);
  assert.equal(o.staleMs, 2 * H);
  assert.equal(o.staleByDevice.get('B'), 4 * H);
  assert.equal(o.nowMs, 123);
  assert.equal(storageTrendHistoryOpts(devs, 1, { poll, registryError: 'corrupt' }).knownIds, null);
});

test('R3A-01 knownIds 가 있으면 수집이 멈춘 등록 장비는 퇴역하지 않고 missing 으로 남는다', async () => {
  const { sumCapacityBuckets } = await import('../src/storage/db.js');
  const { storageTrendHistoryOpts } = await import('../src/routes/api/overviewCards.js');
  const B = H; const now = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000; const since = now - 7 * 24 * H;
  const rows = [];
  for (let t = Math.floor(since / B) * B; t <= now; t += B) {
    rows.push({ device_id: 'A', ts: t, total_bytes: 100, used_bytes: 50 });
    if (t < now - 3 * 24 * H) rows.push({ device_id: 'B', ts: t, total_bytes: 100, used_bytes: 40 });
  }
  const o = storageTrendHistoryOpts([{ id: 'A' }, { id: 'B' }], now, { poll: { envPoll: H, pollOf: new Map([['', H]]) } });
  const r = sumCapacityBuckets(rows, { sinceMs: since, nowMs: now, bucketMs: B, staleMs: o.staleMs, staleByDevice: o.staleByDevice, knownIds: o.knownIds });
  const last = r.points[r.points.length - 1];
  assert.equal(last.missing, 1, '수집이 멈춘 등록 장비가 조용히 빠지면 거짓 하락이다');
});
