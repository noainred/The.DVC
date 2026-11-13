/**
 * v2.922(리눅스 성능 3a) — **행 크기 실측**(설계 README §4.4 ‘구현 때 1,000행 샘플로 행 크기를 재서 이 수치를 정정한다’).
 * 실제 적재 경로(insertUsage → 시간 단위 파일)로 서버 1,000행 · 장치 5,000행을 넣고, WAL 을 접은 뒤 파일 크기 ÷ 행 수로 잰다(인덱스 포함).
 * 값은 SQLite 페이지(4KB) 단위라 근사다. 출력은 콘솔(`[size]`)에 남기고, 테스트는 상한(설계 추정을 크게 넘지 않는가)만 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'bm2921size-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('행 크기 실측(1,000대 × 1주기 · 성능 열·피크 채움 · 장치 5개/대) — 원시·1시간·1일·장치', async () => {
  const db = await import('../src/bmusage/db.js');
  const month = await import('../src/bmusage/monthStore.js');
  const { PERF_COL_NAMES, PEAK_COLS } = await import('../src/bmusage/perfCols.js');
  db._resetForTest();
  const HOUR = 3_600_000;
  const t0 = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const N = 1_000;
  const rows = []; const devices = [];
  for (let i = 0; i < N; i++) {
    const r = { key: `SVCTAG${String(i).padStart(4, '0')}`, ts: t0 + (i % 12) * 300_000, name: `bm-kr1-app${i}`, vcenterId: 'vc-0001', src: 'os+idrac',
      cpu_pct: 37.5 + (i % 50), mem_pct: 61.2, disk_busy_pct: 12.3, disk_used_pct: 70.1, net_pct: 4.4, net_bps: 1_234_567.8, hba_pct: null, hba_bps: null, io_pct: 3.3,
      peak_src: 'window10', peak_window_s: 10, peak_n: 11 };
    for (const c of PERF_COL_NAMES) r[c] = (i % 97) + 0.37;
    for (const c of PEAK_COLS) { r[`${c}_peak`] = 88.8; r[`${c}_peak_at`] = r.ts - 1234; }
    rows.push(r);
    for (let d = 0; d < 5; d++) {
      const nic = d >= 3;
      devices.push({ key: r.key, ts: r.ts, kind: nic ? 'nic' : 'disk', dev: nic ? `eno${d}` : `sd${'abc'[d]}`,
        ...(nic ? { rx_bps: 123456.7, tx_bps: 98765.4, util_pct: 2.5, err_delta: 0, drop_delta: 0, speed_bps: 25e9, oper: 'up', rx_bps_peak: 200000, rx_bps_peak_at: r.ts - 5, tx_bps_peak: 1, tx_bps_peak_at: r.ts - 5, util_pct_peak: 3, util_pct_peak_at: r.ts - 5 }
          : { busy_pct: 22.2, await_ms: 1.4, r_iops: 120.5, w_iops: 80.2, iops: 200.7, r_bps: 4_000_000, w_bps: 2_000_000, aqu: 0.42, inflight: 1, busy_pct_peak: 60, busy_pct_peak_at: r.ts - 9, await_ms_peak: 9, await_ms_peak_at: r.ts - 9, iops_peak: 900, iops_peak_at: r.ts - 9, aqu_peak: 3, aqu_peak_at: r.ts - 9 }) });
    }
  }
  const ins = await db.insertUsage(rows, 'EDGE-KR1', { devices });
  assert.equal(ins.inserted, N, JSON.stringify(ins));
  const out = {};
  for (const fam of ['raw', 'h1', 'd1', 'dev', 'dev1h']) {
    const f = month.listFamilyFiles(fam)[0];
    assert.ok(f, fam);
    const conn = await month.openPeriodFile(fam, f.key);
    conn.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const table = month.FAMILIES[fam].table;
    const cnt = conn.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    const pages = conn.prepare('PRAGMA page_count').get().page_count; const psz = conn.prepare('PRAGMA page_size').get().page_size;
    out[fam] = { rows: cnt, bytes: pages * psz, perRow: Math.round((pages * psz) / cnt) };
  }
  console.log(`[size] ${JSON.stringify(out)}`);
  // 상한(회귀 검출용 — 열을 늘려 행이 부풀면 걸린다): 원시 ≤ 1.2KB · 1시간 ≤ 2KB · 장치 ≤ 600B
  assert.ok(out.raw.perRow <= 1_200, JSON.stringify(out.raw));
  assert.ok(out.h1.perRow <= 2_000, JSON.stringify(out.h1));
  assert.ok(out.dev.perRow <= 600, JSON.stringify(out.dev));
  db._resetForTest();
});
