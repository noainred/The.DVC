/**
 * 전체 점검 34회차(베어메탈 사용률) 회귀.
 *  F1: 엣지 CPU 행 시각은 수신 시각으로 자른다(cpuLatest) — 멈춘 엣지 값이 '신선' 으로 남지 않게.
 *  F2: 전력 24h 피크는 측정 서버가 다 모인 시간만 — 어느 시간도 다 모이지 않으면 null(부분 합을 피크로 쓰지 않는다).
 *  F3: 덧붙인 exec(로그 · 스냅샷)는 피크 창보다 먼저 — 줄일 수 있는 피크 창이 로그 exec 시한을 깎지 않게.
 *  F4: 설정 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고, 그동안 저장을 거절한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmusage-audit34-'));
process.env.CONFIG_DIR = path.join(TMP, 'cfg');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SRC = new URL('../src/', import.meta.url);

test('F1: 시계가 앞선 엣지의 멈춘 CPU 값은 6시간 뒤 낡음(stale)', async () => {
  const edge = await import('../src/central/bmUsageEdgePull.js');
  const { cpuLatestRows } = await import('../src/bmusage/cpuLatest.js');
  const { cpuIndexOf, cpuOf } = await import('../src/tools/serverSensors.js');
  const { bmCpuRowOf } = await import('../src/idrac/serverTrendSeries.js');
  const recv = Date.now();
  const future = recv + 24 * 3600_000;
  edge.putEdgeBmUsage('edge-a', { ok: true, ms: 10, snap: { node: { agent: 'edge-a', version: '3.17.0', role: 'edge' }, at: future, enabled: true,
    settings: { intervalMs: 300000 }, targets: [{ key: 'ABC1234', name: 'srv', vcenterId: 'vc1' }],
    rows: [{ key: 'ABC1234', name: 'srv', ts: future, cpu_pct: 87.5, src: 'idrac' }] } });
  const r = await cpuLatestRows();
  const row = r.rows.find((x) => x.key === 'ABC1234');
  assert.ok(row.ts <= Date.now(), '행 시각이 수신 시각 이하');
  const idx = cpuIndexOf(r.rows);
  const later = recv + 6 * 3600_000;
  assert.equal(cpuOf({ serviceTag: 'ABC1234' }, { cpuIndex: idx, now: later }).state, 'stale');
  assert.equal(bmCpuRowOf({ serviceTag: 'ABC1234', id: 'x' }, idx, later).fresh, false);
});

test('F2: 어느 시간도 측정 서버가 다 모이지 않으면 24h 피크는 null · 부분 시간을 센다', async () => {
  const { aggregatePower, hourSummary } = await import('../src/bmusage/powerAgg.js');
  const H = 3_600_000; const base = Math.floor(Date.now() / H) * H - 24 * H;
  const hours = (from, to, w) => Array.from({ length: to - from }, (_, i) => ({ ts: base + (from + i) * H, avg: w, max: w }));
  const mk = (key, h, w) => ({ key, name: key, vcenterId: 'vc1', w, h24: hourSummary(h) });
  const f = aggregatePower([mk('A', hours(0, 12, 500), null), mk('B', hours(12, 24, 500), 500), mk('C', hours(0, 24, 400), 400)], {}).fleet;
  assert.equal(f.peak24Kw, null);
  assert.equal(f.partialHours, 24);
  // 대조: 셋 다 24시간이면 피크가 있다
  const g = aggregatePower([mk('A', hours(0, 24, 500), 500), mk('C', hours(0, 24, 400), 400)], {}).fleet;
  assert.equal(g.peak24Kw, 0.9);
  assert.equal(g.partialHours, 0);
  const { powerCards } = await import('../../web/src/views/tools/bmPowerText.js');
  const card = powerCards(f).find((c) => c.k === 'peak');
  assert.match(card.sub, /다 모인 시간이 없습니다/);
});

test('F3: 덧붙인 exec 는 피크 창 계획보다 먼저(소스 순서)', () => {
  const s = fs.readFileSync(new URL('bmusage/collectors/osSsh.js', SRC), 'utf8');
  const iExtra = s.indexOf('for (const x of Array.isArray(extraCommands)');
  const iPeak = s.indexOf('const plan = planWindow(');
  assert.ok(iExtra > 0 && iPeak > 0);
  assert.ok(iExtra < iPeak, '로그 · 스냅샷 exec 가 피크 창보다 먼저 예산을 쓴다');
});

test('F4: 설정 경로를 읽지 못하면(EISDIR) 원본을 옮기지 않고 저장을 거절한다', async () => {
  const file = path.join(process.env.CONFIG_DIR, 'bmusage-settings.json');
  fs.mkdirSync(file, { recursive: true });   // 디렉터리 — root 로도 읽기 오류가 난다
  try {
    const M = await import('../src/bmusage/settings.js');
    const s = M.loadBmUsageSettings();
    assert.equal(s.enabled, false);
    const err = M.bmUsageSettingsLoadError();
    assert.ok(err && !/옮겼습니다/.test(err.reason), JSON.stringify(err));
    assert.ok(fs.statSync(file).isDirectory(), '원래 경로가 그대로');
    assert.deepEqual(fs.readdirSync(process.env.CONFIG_DIR).filter((x) => x.includes('.corrupt.')), []);
    assert.throws(() => M.saveBmUsageSettings({ enabled: true }), (e) => e.code === 'settings-unreadable' && e.status === 409);
  } finally { fs.rmSync(file, { recursive: true, force: true }); }
});
