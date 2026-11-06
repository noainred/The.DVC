/**
 * v2.920 리눅스 베어메탈 통합 성능 — **2단계(화면)가 기대는 최소 API 보강** 회귀 고정.
 *  ① 성능 항목의 `psiAbsent`(보드 신뢰 띠 ‘PSI 없음 n’ — 목록 응답에는 detail 이 없어 화면이 셀 수 없었다) — 목록(compact)에도 남는다
 *  ② 중앙 정제 화이트리스트가 `psiAbsent` 를 불리언으로만 전한다(엣지 위임 서버도 보드가 같은 수를 센다)
 *  ③ 데모(mock) 현재 주기 행의 성능 열 합성 — 결정적 · 판정은 하지 않는다(useJudge 가 한다) · 이력 백필 행은 그대로
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmperf2920-'));
const PREV_CFG = process.env.CONFIG_DIR;
process.env.CONFIG_DIR = CFG;
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

test('③ 데모 성능 열 — 결정적 · 시나리오 고루 · iDRAC 만 시나리오는 OS 열이 없다 · 백필 행(demoBmUsageRow)은 그대로', async () => {
  const bm = await import('../src/mock/demo/baremetal.js');
  const targets = Array.from({ length: 9 }, (_, i) => ({ key: `T${i}`, serverId: `mock-bmsrv-${i}`, name: `bm-${i}`, vcenterId: 'vc-a' }));
  const r1 = bm.demoBmUsageResults(targets, NOW);
  assert.deepEqual(r1, bm.demoBmUsageResults(targets, NOW));
  const rows = r1.map((r) => r.built.row);
  const idOnly = rows.filter((r) => r.os_at == null);
  assert.equal(idOnly.length, 1, '9개 중 iDRAC 만 1');
  assert.ok(idOnly.every((r) => r.idrac_at === NOW && r.src === 'idrac+demo' && r.detail_json === undefined));
  const os1 = rows.filter((r) => r.os_at === NOW);
  assert.ok(os1.every((r) => String(r.src).split('+').includes('demo')), '데모 표지 유지');
  const det = os1.map((r) => JSON.parse(r.detail_json));
  assert.ok(det.some((d) => d.firstSample) && det.some((d) => d.sections.psi === 'absent'), '첫 주기 · PSI 없음 시나리오');
  assert.ok(!('perf' in rows[0]) && !('verdict' in rows[0]), '판정은 하지 않는다');
  const plain = bm.demoBmUsageRow(targets[0], NOW);
  assert.equal(plain.os_at, undefined, '이력 백필 행에는 성능 열을 넣지 않는다');
});
