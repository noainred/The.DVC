/**
 * 베어메탈 사용률 점검 반복 7회차 — 회귀 고정.
 *  C1: 정비 창 '창 끝 뒤 억제' 점검 기록 버퍼를 먼저 부른 폴러가 통째로 비워, 파트 장애 폴러(10분)가 bmusage 주기 도중 끼면
 *      그 주기 끝 점검이 checked 0 · leak 0(수집 건강 '0 · 정상' ↔ 저장값 leak 1) → 점검 묶음별로 비운다(cycle · hold) · 저장 결과도 묶음별 합.
 *  ①(6회차 A1 뒤 표지): 알림 규칙 GET 의 readOnly 가 조회 범위만 봐서 쓰기가 일부인 관리자에게 '시험 실행' 이 열리고 누르면 403 →
 *      쓰기 게이트와 같은 isFullReadWriteScope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop7-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const R = await import('../src/bmusage/maint/runtime.js');
const H = await import('../src/bmusage/maint/partfaultHold.js');
const NOW = Date.UTC(2027, 0, 20, 3);
const noFacts = () => ({ ok: true, byId: new Map() });

test('C1 — 파트 장애 폴러의 점검(hold 묶음)이 bmusage 주기 기록(collect · alerts · focus)을 가져가지 않는다 · 주기 끝 점검이 그 기록을 센다', async () => {
  await R.auditCycle({ now: NOW, factsOf: noFacts });   // 버퍼 비우기(앞 시험 영향 없음)
  // bmusage 주기 앞 — 창 끝 뒤 억제(after-end) 1건 · 정상 1건
  R.noteApplied('collect', 'K1', NOW - 60_000, ['mw-aaaaaa'], NOW);           // until < at → after-end
  R.noteApplied('alerts', 'K2', NOW + 3_600_000, ['mw-bbbbbb'], NOW);         // 정상
  // 그 사이 파트 장애 폴러(hold 창 없음 → 실제 함수가 auditCycle 을 부른다)
  const judge = { windows: [] };
  const hr = await H.partfaultMaintHold([], { now: NOW, deps: { judge } });
  assert.equal(hr.hold.size, 0);
  // bmusage 주기 끝 — 재현 r7: 예전 checked 0 · leak 0(파트 장애가 통째로 비움)
  const a = await R.auditCycle({ now: NOW, factsOf: noFacts, group: 'cycle' });
  assert.equal(a.checked, 2, '주기 기록 2건을 센다(예전 0)');
  assert.equal(a.leak, 1); assert.deepEqual(a.reasons, { 'after-end': 1 });
  assert.equal(R.maintStats().leak.n, 1);
});

test('C1 — hold 묶음 점검은 hold 기록만 · 저장 결과는 묶음별 합(한 묶음의 0 이 다른 묶음의 leak 을 지우지 않는다)', async () => {
  await R.auditCycle({ now: NOW, factsOf: noFacts });
  R.noteApplied('collect', 'K1', NOW - 60_000, ['mw-aaaaaa'], NOW);           // cycle: after-end
  R.noteApplied('hold', 'D1', NOW + 3_600_000, ['mw-cccccc'], NOW);          // hold: 정상
  const h = await R.auditCycle({ now: NOW + 1000, factsOf: noFacts, group: 'hold' });
  assert.equal(h.checked, 1); assert.equal(h.leak, 0);
  const c = await R.auditCycle({ now: NOW + 2000, factsOf: noFacts, group: 'cycle' });
  assert.equal(c.checked, 1); assert.equal(c.leak, 1);
  // 다음 hold 점검이 정상(0)이어도 cycle 의 leak 1 은 남는다
  R.noteApplied('hold', 'D1', NOW + 3_600_000, ['mw-cccccc'], NOW + 3000);
  await R.auditCycle({ now: NOW + 3000, factsOf: noFacts, group: 'hold' });
  const st = R.maintStats().leak;
  assert.equal(st.n, 1, `hold 의 0 이 cycle 의 leak 을 덮지 않는다 · ${JSON.stringify(st)}`); assert.equal(st.last, 2);
  assert.deepEqual(st.reasons, { 'after-end': 1 });
  // 범위 없는 점검(옛 호출)은 전부 — 그대로
  R.noteApplied('focus', 'K9', NOW + 3_600_000, ['mw-dddddd'], NOW + 4000);
  R.noteApplied('hold', 'D9', NOW + 3_600_000, ['mw-eeeeee'], NOW + 4000);
  const all = await R.auditCycle({ now: NOW + 4000, factsOf: noFacts });
  assert.equal(all.checked, 2);
  // 다시 읽어도(파일) 묶음별 결과가 남는다
  R.noteApplied('collect', 'K1', NOW - 60_000, ['mw-aaaaaa'], NOW + 5000);
  await R.auditCycle({ now: NOW + 5000, factsOf: noFacts, group: 'cycle' });
  const f = JSON.parse(fs.readFileSync(path.join(DIR, 'maintenance-stats.json'), 'utf8'));
  assert.ok(f.leakBy?.cycle, JSON.stringify(f));
});

test('C1 — 실제 폴러 · 파트 장애 호출처가 묶음을 준다(소스)', async () => {
  const strip = (await import('./_stripComments.js')).stripComments;   // 주석 제거기는 하나(TESTDOC2613-08)
  const poller = strip(fs.readFileSync(new URL('../src/bmusage/poller.js', import.meta.url), 'utf8'));
  assert.match(poller, /auditCycle\(\{\s*group:\s*'cycle'\s*\}\)/);
  const pf = strip(fs.readFileSync(new URL('../src/bmusage/maint/partfaultHold.js', import.meta.url), 'utf8'));
  assert.equal((pf.match(/auditCycle\)\(\{\s*now,\s*group:\s*'hold'\s*\}\)/g) || []).length, 2);
});

test('①(6회차 A1 뒤) — 알림 규칙 GET readOnly = 쓰기 게이트와 같은 판정(조회 ∧ 쓰기 전체)', async () => {
  const { bmRulesRead } = await import('../src/routes/api/bmPerfOps.js');
  const snap = { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] };
  const deps = { listEdgeBmUsage: async () => [], currentTargets: async () => ({ targets: [] }), bmAddressHosts: async () => [] };
  const reqOf = (scope) => ({ user: { username: 'u', role: 'admin', scope }, query: {}, params: {} });
  assert.equal((await bmRulesRead(reqOf(null), snap, deps)).readOnly, false, '전체 관리자');
  assert.equal((await bmRulesRead(reqOf({ vcenters: [], writeVcenters: ['vcA'] }), snap, deps)).readOnly, true, '재현 r7 — 예전 false(시험 실행이 열리고 누르면 403)');
  assert.equal((await bmRulesRead(reqOf({ vcenters: ['vcA'] }), snap, deps)).readOnly, true, '조회 범위 관리자 — 그대로');
  assert.equal((await bmRulesRead({ user: { username: 'o', role: 'operator', scope: null }, query: {}, params: {} }, snap, deps)).readOnly, true, '운영자 — 그대로');
  // 재확인 R1: 화면 괄호 ‘자기 법인 예외만’ 은 조회 범위 표지(scoped)로 — 쓰기만 일부인 계정은 전 법인 예외를 받는다(readOnly 로 가르면 틀린 말)
  assert.equal((await bmRulesRead(reqOf({ vcenters: [], writeVcenters: ['vcA'] }), snap, deps)).scoped, false);
  assert.equal((await bmRulesRead(reqOf({ vcenters: ['vcA'] }), snap, deps)).scoped, true);
  const strip = (await import('./_stripComments.js')).stripComments;   // 주석 제거기는 하나(TESTDOC2613-08)
  const panel = strip(fs.readFileSync(new URL('../../web/src/views/tools/BmPerfRulesPanel.jsx', import.meta.url), 'utf8'));
  assert.match(panel, /resp\.scoped && hasRole\('admin'\) \? '\(범위가 지정된 계정은 자기 법인 예외만 봅니다\)'/);
});

test('C1 재확인 — 운영 코드의 auditCycle 은 모두 묶음을 준다(범위 없는 호출은 다른 묶음 기록까지 가져가고 leakBy 를 비운다 — 시험 · 옛 호출 전용)', async () => {
  const strip = (await import('./_stripComments.js')).stripComments;   // 주석 제거기는 하나(TESTDOC2613-08)
  const root = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.js'));
  const bad = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(new URL(String(f), root), 'utf8'));
    for (const m of src.matchAll(/auditCycle\)?\(\s*([^)]*)\)/g)) {
      if (/export\s+async\s+function\s+auditCycle/.test(src.slice(Math.max(0, m.index - 30), m.index + 12))) continue;
      if (!/group\s*:/.test(m[1])) bad.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, []);
});
