/**
 * 점검 1회차(v2.731) 그룹 G4b — A5-07 서버 쪽: GPU 내보내기 창의 수집 이력 메타(`GET /api/tools/gpu/series-meta`)가
 * DB 오류를 200 + { sampleCount: 0 } 으로 위장하던 것. 화면은 그것을 '아직 수집된 GPU 사용률 이력이 없습니다' 로 그렸다.
 * 이제 실패는 503 + 고정 사유(원문 — DB 파일 경로가 들어갈 수 있다 — 은 콘솔에만)이고 수치는 0 이 아니라 null 이다.
 * 실제 api 라우터를 express 에 띄워 상태코드·본문으로 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2731g4b-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', IPAM_WRITE_WORKER: '0', METRICS_ROLLUP_BACKFILL: '0',
});

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { getMetricsDb } = await import('../src/metrics/db.js');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'admin', role: 'admin', scope: null }; n(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('A5-07 series-meta — DB 오류는 503 + 고정 사유 + 수치 null(0 아님) · 원문(파일 경로)은 응답에 없다', async () => {
  const db = await getMetricsDb();
  const origRange = db.metaRange;
  const origMeta = db.meta;
  const boom = () => { throw new Error('SQLITE_IOERR: disk I/O error at /srv/secret-dir/metrics.db'); };
  db.metaRange = boom; db.meta = boom;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/tools/gpu/series-meta`);
      assert.equal(r.status, 503, 'DB 오류를 200 으로 위장했다');
      const b = await r.json();
      assert.equal(b.ok, false);
      assert.equal(b.code, 'metrics-db-unavailable');
      assert.equal(b.sampleCount, null, '모르는 표본 수를 0 으로 지어냈다');
      assert.equal(b.collectedSince, null);
      assert.match(b.reason, /이력 DB 를 읽지 못했습니다/);
      assert.ok(!JSON.stringify(b).includes('/srv/secret-dir'), 'DB 오류 원문(경로)이 응답에 실렸다');
    });
    assert.ok(warns.some((w) => w.includes('series-meta 조회 실패') && w.includes('SQLITE_IOERR')), '실패를 콘솔에 남기지 않았다(무음 실패)');
  } finally {
    db.metaRange = origRange; db.meta = origMeta; console.warn = origWarn;
  }
});

test('A5-07 series-meta — 정상 응답 모양은 그대로다(실패를 캐시하지 않는다)', async () => {
  const db = await getMetricsDb();
  db.insertMany([{ metric: 'gpu_util', k: 'host-1', v: 10 }], Date.now() - 3_600_000);
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/tools/gpu/series-meta`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.deepEqual(Object.keys(b).sort(), ['collectedSince', 'latestAt', 'sampleCount']);
    assert.ok(Number.isFinite(b.collectedSince));
    assert.ok(b.sampleCount >= 1);
  });
});
