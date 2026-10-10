// v2.733 점검 3회차 그룹 j — C6-05: vmperfMeta 가 `MIN(ts), MAX(ts), COUNT(*)` 한 문장으로 키의 전 이력(1분 × 90일 = 약 13만 행)을 훑었다
//   (vCenter 상세 사용량 추이를 열 때마다 2회 · 디스크 추이 2회 · 낭비 추이 1회). v2.729 가 metrics/db.js metaKey 에서 고친 것의 형제 누락이다.
//   이제 단독 MIN · 단독 MAX 두 문장이고 행 수는 vmperfCount 로 따로 센다(화면은 쓰지 않는다).
//   ⚠ 결과가 예전과 같아야 한다 — 같은 DB 파일을 직접 열어 옛 한 문장의 값과 대조한다(다른 지표·다른 키(구버전 충돌 행) 섞음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733j-vmperf-'));
process.env.VMPERF_DB_DIR = path.join(tmp, 'vmperf');
process.env.CONFIG_DIR = tmp;

const sqlite = await import('node:sqlite').catch(() => null);
const db = await import('../src/metrics/vmperfDb.js');
const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000 - 10 * 24 * HOUR; // 경계에서 떨어뜨린 고정 기준(v2.517 규약)

test('vmperfMeta 의 첫·마지막 시각은 옛 한 문장(MIN·MAX·COUNT)과 같고, 행 수는 vmperfCount 가 센다', { skip: !sqlite ? 'node:sqlite 미지원' : false }, async () => {
  const vc = 'vc-meta';
  for (let i = 0; i < 40; i++) {
    const ts = T0 + i * HOUR;
    const rows = [{ metric: 'vm_cpu_alloc_mhz', k: vc, v: 1000 + i }];
    if (i % 3 === 0) rows.push({ metric: 'ds_cap_gb_vc', k: vc, v: 50 });
    if (i >= 5 && i < 9) rows.push({ metric: 'vm_cpu_alloc_mhz', k: 'other-legacy', v: 1 }); // 구버전 충돌 행 — 같은 파일 · 다른 키
    await db.insertVmperf(vc, rows, ts);
  }
  // 옛 구현 — 같은 파일을 직접 열어 v2.732 의 준비문 그대로
  const file = path.join(process.env.VMPERF_DB_DIR, `${db.dbFileName(vc)}.db`);
  const raw = new sqlite.DatabaseSync(file, { readOnly: true });
  const oldMeta = (metric, k) => {
    const r = raw.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM samples WHERE metric=? AND k=?').get(metric, k);
    return { firstTs: r?.mn ?? null, lastTs: r?.mx ?? null, count: Number(r?.n || 0) };
  };
  try {
    for (const metric of ['vm_cpu_alloc_mhz', 'ds_cap_gb_vc', 'vm_disk_prov_gb' /* 없는 지표 */]) {
      const want = oldMeta(metric, vc);
      const got = await db.vmperfMeta(vc, metric);
      assert.deepEqual(got, { firstTs: want.firstTs, lastTs: want.lastTs }, `${metric}: 첫·마지막 시각이 옛 문장과 다르다`);
      assert.equal(await db.vmperfCount(vc, metric), want.count, `${metric}: 행 수가 옛 문장과 다르다`);
    }
    assert.equal((await db.vmperfMeta(vc, 'vm_cpu_alloc_mhz')).firstTs, T0);
    assert.equal((await db.vmperfMeta(vc, 'vm_cpu_alloc_mhz')).lastTs, T0 + 39 * HOUR);
    assert.deepEqual(await db.vmperfMeta(vc, 'vm_disk_prov_gb'), { firstTs: null, lastTs: null }, '없는 지표는 null(0 이 아니다)');
    // 응답에 행 수를 싣지 않는다 — 함께 세면 키의 전 이력을 훑는다(그래서 v2.729 스윕이 이 파일도 본다)
    assert.equal('count' in (await db.vmperfMeta(vc)), false, 'vmperfMeta 가 여전히 행 수를 센다');
  } finally { raw.close(); }
});
