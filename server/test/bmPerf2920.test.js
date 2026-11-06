/**
 * v2.920 리눅스 베어메탈 통합 성능 — **2단계(화면)가 기대는 최소 API 보강** 회귀 고정.
 *  ① 성능 항목의 `psiAbsent`(보드 신뢰 띠 ‘PSI 없음 n’ — 목록 응답에는 detail 이 없어 화면이 셀 수 없었다) — 목록(compact)에도 남는다
 *  ② 중앙 정제 화이트리스트가 `psiAbsent` 를 불리언으로만 전한다(엣지 위임 서버도 보드가 같은 수를 센다)
 *  ③ 데모(mock) 성능 열 — 적재 경로(실제 insertUsage)에 들어가지 않고 응답 단계에서만 겹친다 · 다섯 지표 불변(반증 D2)
 *  ④ 교차 ③ DIMM 근거 수 중복 제거 · 인벤토리 없을 때 부품 장애 수(반증 D5)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmperf2920-'));
const PREV_CFG = process.env.CONFIG_DIR;
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';   // ③ 데모 겹침은 mock 에서만
test.after(() => {
  if (PREV_CFG === undefined) delete process.env.CONFIG_DIR; else process.env.CONFIG_DIR = PREV_CFG;
  fs.rmSync(CFG, { recursive: true, force: true });
});
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

test('① psiAbsent — detail.sections.psi 가 absent 일 때만 참 · 목록(compact)에도 남는다', async () => {
  const PV = await import('../src/bmusage/perfView.js');
  const S = await import('../src/bmusage/settings.js');
  const row = (psi) => ({ key: 'K', ts: NOW, os_at: NOW, src: 'os', cpu_pct: 10, mem_pct: 20, detail_json: JSON.stringify({ osKind: 'linux', sections: { psi } }) });
  const a = PV.buildPerfEntry({ row: row('absent'), th: S.PERF_DEFAULTS, intervalMs: 300_000, now: NOW });
  assert.equal(a.psiAbsent, true);
  assert.equal(PV.compactPerfEntry(a).psiAbsent, true);
  for (const p of ['ok', 'missing']) assert.equal(PV.buildPerfEntry({ row: row(p), th: S.PERF_DEFAULTS, intervalMs: 300_000, now: NOW }).psiAbsent, false);
  assert.equal(PV.buildPerfEntry({ row: { key: 'K', ts: NOW }, th: S.PERF_DEFAULTS, intervalMs: 300_000, now: NOW }).psiAbsent, false, 'detail 이 없으면 거짓(모름을 ‘없음’ 으로 세지 않는다)');
});

test('② 중앙 정제 — psiAbsent 는 true 일 때만 참(문자열·숫자는 거짓)', async () => {
  const { sanitizePerfEntry } = await import('../src/central/bmPerfSanitize.js');
  assert.equal(sanitizePerfEntry({ key: 'K', psiAbsent: true }, NOW).psiAbsent, true);
  for (const v of ['true', 1, null, undefined]) assert.equal(sanitizePerfEntry({ key: 'K', psiAbsent: v }, NOW).psiAbsent, false);
});

test('③ 데모 성능 열(반증 D2) — 적재 경로(demoBmUsageResults → 실제 insertUsage)에는 성능 열이 없고 다섯 지표는 그대로 · 조회 응답 단계에서만 겹친다', async () => {
  const { setDataSource } = await import('../src/runtime-settings.js');
  assert.equal(setDataSource('mock').ok, true);
  const bm = await import('../src/mock/demo/baremetal.js');
  const db = await import('../src/bmusage/db.js');
  const { PERF_COL_NAMES } = await import('../src/bmusage/perfCols.js');
  const targets = Array.from({ length: 9 }, (_, i) => ({ key: `T${i}`, serverId: `mock-bmsrv-${i}`, idrac: { regId: `mock-bmsrv-${i}` }, name: `bm-${i}`, vcenterId: 'vc-a' }));
  // ① 적재 경로 — 폴러가 insertUsage 로 넘기는 행 그대로 실제 DB 에 넣는다
  const rows = bm.demoBmUsageResults(targets, NOW).map((r) => r.built.row);
  for (const r of rows) {
    for (const c of PERF_COL_NAMES) assert.equal(r[c], undefined, `적재 행에 성능 열 ${c} 없음`);
    assert.equal(r.os_at, undefined); assert.equal(r.detail_json, undefined);
    assert.deepEqual(r, bm.demoBmUsageRow(targets.find((x) => x.key === r.key), NOW), '다섯 지표는 백필 생성기와 같다(덮어쓰지 않는다)');
  }
  const ins = await db.insertUsage(rows, '');
  assert.ok(ins.ok, JSON.stringify(ins));
  const hist = await db.usageHistory('T0', { agent: '', hours: 24 * 400 });
  const h0 = (Array.isArray(hist) ? hist : hist.rows || [])[0];
  assert.ok(h0, '이력 행이 있다');
  for (const c of PERF_COL_NAMES) assert.ok(h0[c] == null, `usage_history.${c} 는 비어 있다`);
  const days = await db.usageDaily({ key: 'T0', agent: '', days: 400 });
  for (const d of days) for (const c of PERF_COL_NAMES) assert.ok(d[`${c}_max`] == null, `usage_daily.${c}_max 는 비어 있다`);
  // ② 응답 단계 — 최신값을 읽어 겹친다(DB 에는 쓰지 않는다)
  const latest = (await db.latestUsage()).filter((r) => r.key.startsWith('T'));
  const shown = bm.demoPerfLatestRows(latest, targets);
  assert.deepEqual(shown, bm.demoPerfLatestRows(latest, targets), '결정적');
  const withOs = shown.filter((r) => r.os_at != null);
  assert.equal(withOs.length, 8, '9개 중 iDRAC 만 1');
  for (const r of shown) {
    const o = latest.find((x) => x.key === r.key);
    for (const c of ['cpu_pct', 'mem_pct', 'disk_busy_pct', 'disk_used_pct', 'net_pct', 'hba_pct']) assert.equal(r[c], o[c], `${c} 는 덮지 않는다`);
    assert.ok(String(r.src).split('+').includes('demo'), '데모 표지 유지');
  }
  const det = withOs.map((r) => JSON.parse(r.detail_json));
  assert.ok(det.some((d) => d.firstSample) && det.some((d) => d.sections.psi === 'absent'), '첫 주기 · PSI 없음 시나리오');
  // DB 의 최신값은 그대로(응답 단계 겹침이 저장되지 않는다)
  for (const r of await db.latestUsage()) if (r.key.startsWith('T')) assert.equal(r.os_at ?? null, null);
  // mock 이 아니면 입력 그대로 · 데모 대상이 아니면 그대로
  assert.equal(bm.demoPerfLatestRows(latest, [{ key: 'T0', serverId: 'real-1', idrac: { regId: 'real-1' } }]), latest);
  assert.equal(setDataSource('live').ok, true);
  try { assert.equal(bm.demoPerfLatestRows(latest, targets), latest); } finally { setDataSource('mock'); }
});

test('④ 교차 ③(반증 D5) — 같은 DIMM 이 인벤토리 health 와 부품 장애에 함께 있어도 한 번 센다 · 인벤토리를 못 읽어도 부품 장애 수를 적는다', async () => {
  const { crossJudge } = await import('../src/bmusage/useJudge.js');
  const { shapeHwFacts } = await import('../src/bmusage/hwFacts.js');
  const now = NOW;
  const hw = shapeHwFacts({ inv: { collectedAt: now, memoryDimms: [{ locator: 'DIMM.Socket.A4', health: 'Warning' }, { locator: 'DIMM.Socket.A1', health: 'OK' }] }, faults: [{ kind: 'dimm', label: 'DIMM.Socket.A4', state: 'warn' }] }, { now });
  const c3 = crossJudge({ use: { cells: {} }, hw, coverage: 'both' })[2];
  assert.equal(c3.state, 'candidate');
  assert.equal(c3.evidence[0], 'DIMM 이상 1');
  assert.deepEqual(c3.devices, ['DIMM.Socket.A4']);
  // 인벤토리 없음(dimmBad null) + 부품 장애 2건 → ‘—’ 가 아니라 2
  const hw2 = shapeHwFacts({ faults: [{ kind: 'dimm', label: 'A1', state: 'fault' }, { kind: 'dimm', label: 'B2', state: 'warn' }], sensor: { t: now, cpu: 10, temps: {} } }, { now });
  assert.equal(hw2.dimmBad, null);
  const d = crossJudge({ use: { cells: {} }, hw: hw2, coverage: 'both' })[2];
  assert.equal(d.state, 'candidate');
  assert.equal(d.evidence[0], 'DIMM 이상 2');
  // 둘 다 못 읽음 → ‘—’ · missing
  const hw3 = shapeHwFacts({ sensor: { t: now, cpu: 10, temps: {} } }, { now });
  const m = crossJudge({ use: { cells: {} }, hw: hw3, coverage: 'both' })[2];
  assert.equal(m.state, 'missing');
  assert.equal(m.evidence[0], 'DIMM 이상 —');
});
