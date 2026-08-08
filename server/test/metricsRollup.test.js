import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 저장소 server/config 오염 방지 — import 전에 CONFIG_DIR 고정(metrics DB 경로가 여기서 파생).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-rollup-'));
process.env.CONFIG_DIR = tmp;

let db;
const HOUR = 3600_000;
// 버킷 경계에 안전하게 정렬된 기준 시각(현재-2일, 2시간 정각 — 2h 버킷 테스트가 경계를 안 걸치게).
const T0 = Math.floor((Date.now() - 2 * 86_400_000) / (2 * HOUR)) * (2 * HOUR);

before(async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  db = await getMetricsDb();
  assert.equal(db.kind, 'sqlite', '테스트 환경은 node:sqlite 를 전제(NDJSON 폴백이면 환경 문제)');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('시간당 롤업: 60분+ 버킷 history 가 적재분과 정확히 일치(avg/min/max 가중 집계)', async () => {
  // 4개 시각(2시간에 걸침) × 1키 적재: h0 에 10,20 / h1 에 30,50
  db.insertMany([{ metric: 'temp_host', k: 'h1', v: 10 }], T0);
  db.insertMany([{ metric: 'temp_host', k: 'h1', v: 20 }], T0 + 10 * 60_000);
  db.insertMany([{ metric: 'temp_host', k: 'h1', v: 30 }], T0 + HOUR);
  db.insertMany([{ metric: 'temp_host', k: 'h1', v: 50 }], T0 + HOUR + 20 * 60_000);

  // 1시간 버킷(롤업 경로): 시간별 avg/min/max
  const h1 = db.history('temp_host', 'h1', T0, HOUR, 100);
  assert.deepEqual(h1, [
    { ts: T0, avg: 15, min: 10, max: 20 },
    { ts: T0 + HOUR, avg: 40, min: 30, max: 50 },
  ]);

  // 2시간 버킷(롤업을 재집계 — n 가중 평균이어야 함: (10+20+30+50)/4 = 27.5)
  const h2 = db.history('temp_host', 'h1', T0, 2 * HOUR, 100);
  assert.equal(h2.length, 1);
  assert.equal(h2[0].avg, 27.5);
  assert.equal(h2[0].min, 10);
  assert.equal(h2[0].max, 50);

  // 60분 미만 버킷은 원본 경로 — 10분 버킷이 4개 나온다.
  const raw = db.history('temp_host', 'h1', T0, 10 * 60_000, 100);
  assert.equal(raw.length, 4);
  assert.deepEqual(raw.map((r) => r.avg), [10, 20, 30, 50]);
});

test('historyAll: 패밀리 일괄 버킷이 키별 history 와 동일한 결과를 낸다', async () => {
  db.insertMany([{ metric: 'gpu_util', k: 'a', v: 1 }, { metric: 'gpu_util', k: 'b', v: 5 }], T0);
  db.insertMany([{ metric: 'gpu_util', k: 'a', v: 3 }, { metric: 'gpu_util', k: 'b', v: 7 }], T0 + 5 * 60_000);
  const all = db.historyAll('gpu_util', T0, 10 * 60_000, 5000);
  for (const k of ['a', 'b']) {
    assert.deepEqual(all.get(k), db.history('gpu_util', k, T0, 10 * 60_000, 5000), `key=${k}`);
  }
  // limitPerKey 는 최근 버킷을 남긴다(오래된 쪽을 자름 — history 의 DESC+LIMIT 정책과 동일).
  db.insertMany([{ metric: 'gpu_util', k: 'a', v: 9 }], T0 + 20 * 60_000);
  const limited = db.historyAll('gpu_util', T0, 10 * 60_000, 1);
  assert.equal(limited.get('a').length, 1);
  assert.equal(limited.get('a')[0].avg, 9);
});

test('latestAll 캐시: 시드 후 쓰기 경로에서 O(1) 갱신, 반환 Map 변형이 캐시를 오염시키지 않음', async () => {
  db.insertMany([{ metric: 'ds_usedgb', k: 'ds1', v: 100 }], T0);
  const first = db.latestAll('ds_usedgb'); // 시드
  assert.equal(first.get('ds1').v, 100);
  first.set('ds1', { v: -1, ts: 0 }); // 호출부가 변형해도
  db.insertMany([{ metric: 'ds_usedgb', k: 'ds1', v: 120 }, { metric: 'ds_usedgb', k: 'ds2', v: 50 }], T0 + HOUR);
  const second = db.latestAll('ds_usedgb');
  assert.equal(second.get('ds1').v, 120, '커밋 후 캐시가 최신값으로 갱신');
  assert.equal(second.get('ds2').v, 50, '새 키도 캐시에 반영');
});

test('prune: 원본·롤업·latest 캐시를 함께 정리한다', async () => {
  db.insertMany([{ metric: 'temp_vc', k: 'old', v: 1 }], T0);
  db.insertMany([{ metric: 'temp_vc', k: 'new', v: 2 }], T0 + 3 * HOUR);
  db.latestAll('temp_vc'); // 캐시 시드(old 포함)
  const cutoff = T0 + 2 * HOUR;
  db.prune(cutoff);
  assert.equal(db.meta('temp_vc').count, 1, '원본에서 old 삭제');
  const latest = db.latestAll('temp_vc');
  assert.equal(latest.has('old'), false, '캐시에서도 old 제거');
  assert.equal(latest.get('new').v, 2);
  // 롤업도 정리됨 — cutoff 이전 창을 조회해도 old 데이터가 되살아나지 않는다.
  const h = db.history('temp_vc', 'old', T0, HOUR, 100);
  assert.equal(h.length, 0, '롤업에 유령 집계가 남지 않음');
});
