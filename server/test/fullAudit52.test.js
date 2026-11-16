/**
 * 전체 점검 52회차(백업 2차) 회귀.
 *  F1 중앙 직접 Director 의 상태 변경(등록 · 실행 · 복원)도 업그레이드 대기 목록에
 *  F4 '초기화 후 재설치' 사전 점검은 그 Director 를 쓰는 대상 전부를 세고 함께 쓰는 vCenter 를 밝힌다(소스 — 실제 SSH 가 필요)
 *  F5 Veeam 대행 워커는 인출만 겹치지 않게 · 빈 자리만큼 인출 · 중앙은 max 를 지킨다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fa52-'));
process.env.CONFIG_DIR = DIR;
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const rd = (rel) => stripComments(fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8'));

test('52회차 F1: 중앙 직접 상태 변경은 끝날 때까지 업그레이드 대기 목록에 있다', async () => {
  const IF = await import('../src/bareos/inflight.js');
  IF._resetInflightForTest();
  const id = IF.noteDirectOpStart('addJobs', 'dir-1');
  const w = IF.runningBareosWork().filter((x) => x.key.startsWith('direct:'));
  assert.equal(w.length, 1);
  assert.match(w[0].label, /Bareos 직접 실행 addJobs\(Director dir-1\)/);
  IF.noteDirectOpEnd(id);
  assert.equal(IF.runningBareosWork().filter((x) => x.key.startsWith('direct:')).length, 0);
  const svc = rd('bareos/service.js');
  assert.match(svc, /const noteId = EDGE_MUTATING\.has\(kind\) && kind !== 'poll' \? noteDirectOpStart\(kind, directorId\) : null;/);   // 53회차 N3: 주기 조회는 뺀다
  assert.match(svc, /finally \{ if \(noteId\) noteDirectOpEnd\(noteId\); \}/);
});

test('52회차 F4: 재설치 사전 점검은 그 Director 를 쓰는 대상 전부 · 함께 쓰는 vCenter 를 싣는다(소스)', () => {
  const j = rd('bareos/install/job.js');
  // 53회차 N4: 공유 목록 계산을 sharedOfDirector(directorId, vcenterId) 로 옮겼다(시작 · 0단계 다시 하기가 같은 계산을 쓴다) — 판정 jobDirectorId 는 그대로
  assert.match(j, /listJobs\(\)\.filter\(\(x\) => !x\.demo && jobDirectorId\(x, st\) === directorId\)/);
  assert.match(j, /sharedOfDirector\(t\.director\.id, vcenterId\)/);
  assert.match(j, /ledgerTargets: ledger, sharedVcenters,/);
  const web = fs.readFileSync(new URL('../../web/src/views/tools/BareosInstall.jsx', import.meta.url), 'utf8');
  assert.match(web, /pre\.sharedVcenters/);
});

test('52회차 F5: Veeam 대행 — 중앙은 엣지가 알려 온 빈 자리(max)만큼만 넘긴다 · 워커는 인출만 가드', async () => {
  const E = await import('../src/veeam/run/edgeOps.js');
  const W = rd('agent/veeamRunWorker.js');
  assert.match(W, /if \(fetching \|\| inflight >= SLOT_MAX\) \{/);
  assert.match(W, /veeam-run-ops\?max=\$\{SLOT_MAX - inflight\}/);
  assert.equal(typeof E.takeEdgeOps, 'function');
  assert.equal(E.TAKE_MAX, 5);
  const R = rd('routes/central/opsRoutes.js');
  assert.match(R, /takeEdgeOps\(req\.centralAuth\.agent, max\)/);
  assert.deepEqual(E.takeEdgeOps('edge-none', 0), [], 'max 0 이면 넘기지 않는다');
});

test('52회차 F2: 폴러가 못 읽는 Director 법인은 결과 모름 — 웹 배지 · 합계 제외(소스)', async () => {
  const web = await import('../../web/src/views/tools/bareosLiveText.js');
  assert.match(web.corpBadge({ running: 0, waiting: 0, resultsKnown: false }).text, /결과 모름/);
  assert.equal(web.corpBadge({ running: 0, waiting: 0, resultsKnown: false }).key, 'fail');
  assert.equal(web.corpBadge({ running: 0, waiting: 0 }).key, 'idle');
  const L = rd('routes/api/bareosLive.js');
  assert.match(L, /directorInfo\(site\.vcenterId, settings, pollerStatus\(\), demo\)/);
  assert.match(L, /c\.resultsKnown === false \? 0 : \(c\.today\[k\] \|\| 0\)/);
});

test('52회차 F3: 볼륨을 못 읽은 풀은 가득 참 · 오류 볼륨을 0 으로 세지 않는다(세는 곳 셋이 같은 판정)', async () => {
  const P = await import('../src/bareos/policy.js');
  const acc = P.newPoolKpi();
  P.addPoolKpi(acc, { full: null, pct: null, vol: null });
  P.addPoolKpi(acc, { full: true, pct: 100, vol: { status: { Error: 2 } } });
  assert.deepEqual(acc, { n: 2, full: 1, unknownFull: 1, errorVols: 2, errorVolsUnknown: 1, maxPct: 100 });
  const src = rd('bareos/policy.js');
  assert.ok((src.match(/addPoolKpi\(/g) || []).length >= 3, 'policySummary · policyView 가 addPoolKpi 를 쓴다(정의 포함)');
  assert.match(src, /const one = addPoolKpi\(newPoolKpi\(\), p\);/);   // 53회차 N6: 풀 탭도 같은 판정 하나
  const web = await import('../../web/src/views/tools/bareosPolicyText.js');
  assert.match(web.poolKpiText({ full: 0, unknownFull: 2, errorVols: 0, errorVolsUnknown: 2 }), /판정 모름 2 · 오류 볼륨 0\(볼륨 모르는 풀 2\)/);
});

/* ── 53회차(52회차 수정 반증) ── */
test('53회차 N1 · N3 · N5: 시한에 잘렸어도 읽은 행이 있으면 결과는 안다 · 주기 조회는 대기 목록 밖 · 실행 중 법인의 멈춤 · 느림을 덮지 않는다', async () => {
  const { directorState } = await import('../src/bareos/vmView.js');
  const base = { mapped: true, configured: true, authStopped: false };
  assert.equal(directorState({ ...base, poll: { ok: false, code: 'aborted', checked: 3 } }).resultsKnown, true);
  assert.equal(directorState({ ...base, poll: { ok: false, code: 'aborted', checked: 3 } }).state, 'error', '상태는 그대로(잘림을 밝힌다)');
  assert.equal(directorState({ ...base, poll: { ok: false, code: 'aborted', checked: 0 } }).resultsKnown, false);
  assert.equal(directorState({ ...base, poll: { ok: false, code: 'ssh', checked: 5 } }).resultsKnown, false);
  assert.match(rd('bareos/service.js'), /EDGE_MUTATING\.has\(kind\) && kind !== 'poll' \? noteDirectOpStart/);
  const web = await import('../../web/src/views/tools/bareosLiveText.js');
  assert.equal(web.corpBadge({ running: 2, waiting: 0, live: { ok: true }, slow: 1, stuck: 0, resultsKnown: false }).key, 'slow');
  assert.equal(web.corpBadge({ running: 0, waiting: 0, resultsKnown: false, resultsState: 'unset' }).text, '결과 모름(Director 설정 안 됨)');
});

test('53회차 N2 · N7: Veeam 대행 — 자리는 작업마다 돌려주고 · 동시 상한은 예전 2(소스)', () => {
  const W = rd('agent/veeamRunWorker.js');
  assert.match(W, /export const SLOT_MAX = OP_CONCURRENCY;/);
  assert.match(W, /if \(!released\) \{ released = true; inflight = Math\.max\(0, inflight - 1\); \}/);
});

test('53회차 N6: 풀 탭도 addPoolKpi 하나 · 볼륨을 전부 모르면 오류 볼륨은 0 이 아니라 null(소스)', () => {
  const P = rd('bareos/policy.js');
  assert.match(P, /const one = addPoolKpi\(newPoolKpi\(\), p\);/);
  assert.match(P, /errorVols: poolsN === null \|\| \(poolsN > 0 && errorVolsUnknown === poolsN\) \? null : errorVols/);
});
