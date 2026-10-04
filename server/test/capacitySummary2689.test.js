/**
 * v2.689 G2 — /capacity/summary 요약 계산(B1).
 *  ① 계산이 시간 기준으로 양보한다 — 합성 DB(호스트 300 × 지표 10 × 15일 시간당 롤업)에서 계산 도중
 *     setImmediate 큐에 자기를 다시 거는 프로브가 1회 이상 돈다(양보가 없으면 0회).
 *     ⚠ 벽시계 타이머(setInterval)로 재지 않는다 — v2.581 BUG-E: 타이머 하한 1ms 대 양보 루프가 플래키를 만든다.
 *  ② stale-while-revalidate — TTL 이 지난 캐시는 옛 값을 바로 주고 뒤에서 1건만 다시 계산한다.
 *  ③ 뒤 재계산이 실패해도 옛 값을 지우지 않는다.
 * 기준 시각은 정시 −30분으로 고정(v2.517 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'capsum2689-'));
const HOUR = 3600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const METRICS = ['cpu_system', 'cpu_process', 'event_loop_lag', 'mem_system', 'mem_rss', 'load_per_core', 'disk_used', 'net_rx', 'net_tx', 'extra_m'];

const { config } = await import('../src/config.js');
const { getCapacityDb } = await import('../src/capacity/db.js');
const ev = await import('../src/capacity/evaluate.js');
const capDb = await getCapacityDb();

// 대량 적재는 별도 연결로(insertSnapshot 은 원본 표본까지 쓰므로 300×10×720 이면 느리다).
{
  const raw = new DatabaseSync(config.capacity.dbPath);
  raw.exec('BEGIN');
  const ins = raw.prepare('INSERT OR IGNORE INTO samples_hourly (metric, k, h, n, sum, mn, mx) VALUES (?,?,?,?,?,?,?)');
  const hi = raw.prepare('INSERT OR IGNORE INTO hosts (k, lastTs, meta) VALUES (?,?,?)');
  const h0 = Math.floor(NOW / HOUR) * HOUR;
  for (let i = 0; i < 300; i++) {
    hi.run(`h${String(i).padStart(3, '0')}`, NOW, '{}');
    for (const m of METRICS) for (let h = 1; h <= 360; h++) ins.run(m, `h${String(i).padStart(3, '0')}`, h0 - h * HOUR, 12, 600, 10, 90);
  }
  raw.exec('COMMIT');
  raw.close();
}

test('① 호스트 300 × 지표 10: 요약 계산 도중 이벤트 루프가 돈다(setImmediate 프로브 ≥ 1)', async () => {
  ev._resetSummaryCache();
  let ticks = 0; let stop = false;
  const probe = () => { ticks++; if (!stop) setImmediate(probe); };
  setImmediate(probe);
  const t0 = performance.now();
  const rows = await ev.summarizeHosts();
  const ms = performance.now() - t0;
  stop = true;
  assert.equal(rows.length, 300);
  assert.ok(ms > ev.SUMMARY_SLICE_MS, `계산이 너무 짧아(${ms.toFixed(1)}ms) 양보를 검증할 수 없다 — 합성 규모를 키울 것`);
  assert.ok(ticks >= 1, `계산(${ms.toFixed(0)}ms) 동안 이벤트 루프가 한 번도 돌지 않았다 — 양보 없음`);
  assert.ok(ev.summarizeHostsYields() >= 1, '계산이 양보 횟수를 남긴다');
  assert.equal(rows[0].groups.cpu, 'scale_up', '판정은 예전과 같다(시간당 max 90 → p95 ≥ bad 85)');
});

test('② TTL 이 지난 캐시: 옛 값을 바로 주고 뒤에서 1건만 다시 계산한다(stale-while-revalidate)', async () => {
  ev._resetSummaryCache();
  await ev.summarizeHosts();
  ev._ageSummaryCache(ev.SUMMARY_TTL_MS + 1_000);
  const oldAt = ev.summarizeHostsAt();
  const orig = capDb.windowStats;
  let calls = 0;
  capDb.windowStats = (...a) => { calls++; return orig.apply(capDb, a); };
  try {
    const [a, b] = await Promise.all([ev.summarizeHosts(), ev.summarizeHosts()]);
    assert.equal(a.length, 300);
    assert.equal(b.length, 300);
    assert.equal(ev.summarizeHostsAt(), oldAt, '옛 값을 기다림 없이 줬다(계산 시각 그대로)');
    assert.equal(ev.summarizeHostsRefreshing(), true, '뒤에서 재계산이 진행 중이다');
    await ev.summarizeHosts();   // 재계산 중 또 호출 — 새 계산을 시작하지 않는다
    while (ev.summarizeHostsRefreshing()) await new Promise((r) => setImmediate(r));
    assert.ok(ev.summarizeHostsAt() > oldAt, '재계산이 끝나면 계산 시각이 갱신된다');
    const hosts = 300; const warnMetrics = 5;
    assert.equal(calls, hosts * warnMetrics, `재계산은 1건이어야 한다(windowStats ${calls}회)`);
  } finally { capDb.windowStats = orig; }
});

test('③ 뒤 재계산이 실패해도 옛 값은 남는다', async () => {
  ev._resetSummaryCache();
  await ev.summarizeHosts();
  ev._ageSummaryCache(ev.SUMMARY_TTL_MS + 1_000);
  const oldAt = ev.summarizeHostsAt();
  const orig = capDb.windowStats;
  const warn = console.warn; const warned = [];
  console.warn = (m) => { warned.push(String(m)); };
  capDb.windowStats = () => { throw new Error('boom'); };
  try {
    const rows = await ev.summarizeHosts();
    assert.equal(rows.length, 300);
    while (ev.summarizeHostsRefreshing()) await new Promise((r) => setImmediate(r));
    assert.equal(ev.summarizeHostsAt(), oldAt, '실패한 재계산이 옛 값을 지우지 않았다');
    assert.ok(warned.some((m) => m.includes('직전 값 유지')), '실패를 콘솔에 남긴다');
    const again = await ev.summarizeHosts();
    assert.equal(again.length, 300);
  } finally { capDb.windowStats = orig; console.warn = warn; }
});
