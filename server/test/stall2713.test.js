/**
 * v2.713 — 목업 모드 화면 대기: SAN 트래픽 합계(storageSeriesMulti)는 조회(v2.693 조각·양보) 뒤 **행·시리즈 조립**을 양보 없이
 *   돌아 데모 SAN 86대·24h(33만 행)에서 이벤트 루프가 약 2.9초 멈췄다(stallwatch 실측, 멈춘 지점 storageSeriesMultiInner).
 * ① 조립도 양보한다 — 큰 입력에서 setImmediate 프로브가 막히지 않는다(벽시계 타이머 대신 같은 큐 프로브 — v2.581 BUG-E 규약).
 * ② bucketAgg sort:false 는 같은 행 집합을 준다(정렬만 생략).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stall2713-'));
process.env.SANSW_PERF_QUERY_TTL_MS = '0';

const HOUR = 3600_000;
const BASE = Math.floor(1_790_000_000_000 / HOUR) * HOUR + 17 * 60_000;
const DEVS = Array.from({ length: 50 }, (_, i) => `sw${i}`);

async function seed() {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  const ins = db.conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)');
  const meta = db.conn.prepare('INSERT OR REPLACE INTO port_meta (device_id, port, ts, attached_name) VALUES (?,?,?,?)');
  db.conn.exec('BEGIN');
  for (const dev of DEVS) {
    for (let p = 0; p < 24; p++) meta.run(dev, p, BASE, `ARRAY-${dev}-${p}`);   // 포트마다 다른 스토리지 — 시리즈 수가 크다
    for (let t = BASE - 24 * HOUR; t <= BASE; t += 5 * 60_000 + 7_000) {
      for (let p = 0; p < 24; p++) ins.run(dev, t, p, ((t / 1000) % 997) * (p + 1));
    }
  }
  db.conn.exec('COMMIT');
  return { m, db };
}

test('① 큰 입력에서도 조립이 이벤트 루프를 오래 붙잡지 않는다', async () => {
  const { m } = await seed();
  let maxGap = 0; let last = performance.now(); let running = true;
  const probe = () => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; if (running) setImmediate(probe); };
  setImmediate(probe);
  const r = await m.storageSeriesMulti(DEVS, { from: BASE - 24 * HOUR, to: BASE });
  running = false;
  assert.ok(r.series.length >= 1000, `시리즈 ${r.series.length}`);
  // 수정 전에는 조립 전체(수백 ms~초)가 한 덩어리였다. 양보 단위는 15ms — 병렬 부하 여유를 두고 상한 300ms.
  assert.ok(maxGap < 300, `최장 멈춤 ${maxGap.toFixed(0)}ms`);
});

test('② bucketAgg sort:false 는 정렬만 생략하고 같은 행을 준다', async () => {
  const m = await import('../src/sanswitch/perfDb.js');
  const db = await m._dbForTest();
  const ids = DEVS.slice(0, 5);
  const a = await m.bucketAgg(db, ids, BASE - 6 * HOUR, BASE, 600_000, { lastTs: true });
  const b = await m.bucketAgg(db, ids, BASE - 6 * HOUR, BASE, 600_000, { lastTs: true, sort: false });
  const key = (r) => `${r.device_id}|${r.port}|${r.b}|${r.avg_bps}|${r.max_bps}|${r.last_ts}`;
  assert.deepEqual(b.map(key).sort(), a.map(key).sort());
  for (let i = 1; i < a.length; i++) assert.ok(Number(a[i - 1].b) <= Number(a[i].b), '기본은 정렬된다');
});

test('③ 조립 루프 두 곳에 양보가 있다(합성 입력이 작아 ①만으로는 제거를 못 잡는다 — 정직 기록)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/sanswitch/perfDb.js', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('async function storageSeriesMultiInner'));
  assert.match(body, /for \(let ri = 0; ri < rows\.length; ri\+\+\) \{[\s\S]{0,80}await yielder\(\)/, '행 조립 양보');
  assert.match(body, /for \(const s of byGroup\.values\(\)\) \{\s*await yielder\(\)/, '시리즈 조립 양보');
  assert.match(body, /sort: false/, '정렬 생략');
});
