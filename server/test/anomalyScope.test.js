import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.289 확정 #2 회귀 방지 — detectAnomalies 의 allowedKeys(스코프) 필터.
// 배경: 이상탐지는 metrics 시계열의 엔티티 키(호스트 id·데이터스토어 id·vCenter id)를 순회한다.
// 범위 제한 계정(scopedVcenterIds ≠ null)에는 그 계정의 소유 엔티티 이상치만 노출돼야 하고,
// 범위 밖 키의 이상치가 새면 안 된다(CLAUDE.md '조회 경로 scope 강제'). allowedKeys=null 이면 전체.
// 저장소 server/config 오염 방지 — import 전에 CONFIG_DIR 고정(metrics DB 경로가 여기서 파생).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-scope-'));
process.env.CONFIG_DIR = tmp;

let db;
let detectAnomalies;

before(async () => {
  db = await (await import('../src/metrics/db.js')).getMetricsDb();
  assert.equal(db.kind, 'sqlite', '테스트 환경은 node:sqlite 전제(NDJSON 폴백이면 환경 문제)');
  ({ detectAnomalies } = await import('../src/insights/anomaly.js'));

  // 두 키에 동일 패턴을 적재: 안정 baseline(~20) 을 10분 간격 13개 버킷 + 최신 스파이크(500).
  // robust Z 가 임계(3.5)를 크게 상회 → 두 키 모두 이상치로 탐지되는 상태를 만든다.
  const now = Date.now();
  for (const k of ['anom-allowed', 'anom-denied']) {
    for (let i = 13; i >= 1; i--) {
      db.insertMany([{ metric: 'temp_host', k, v: 20 + (i % 3) }], now - i * 10 * 60_000); // 각기 다른 10분 버킷
    }
    db.insertMany([{ metric: 'temp_host', k, v: 500 }], now - 30_000); // 최신값(latest) = 스파이크
  }
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// temp_host 패밀리에서 탐지된 이상치 키 목록.
const tempKeys = (res) => (res.families.find((f) => f.metric === 'temp_host')?.items || []).map((i) => i.key);

test('무스코프(allowedKeys 미지정): 두 키 모두 이상치로 탐지', async () => {
  const keys = tempKeys(await detectAnomalies({}));
  assert.ok(keys.includes('anom-allowed'), `허용 키 탐지 기대: ${keys}`);
  assert.ok(keys.includes('anom-denied'), `범위 밖 키도 무스코프에선 탐지: ${keys}`);
});

test('스코프(allowedKeys=허용 키만): 범위 밖 키의 이상치는 노출되지 않는다', async () => {
  const keys = tempKeys(await detectAnomalies({ allowedKeys: new Set(['anom-allowed']) }));
  assert.ok(keys.includes('anom-allowed'), '허용 키는 포함돼야 함');
  assert.ok(!keys.includes('anom-denied'), '범위 밖 키(anom-denied)는 스코프에서 제외돼야 함');
});
