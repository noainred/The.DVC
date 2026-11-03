/**
 * test/bareosRestoresDeadline2870.test.js — v2.870 감사 A5-01: 묶음 복원 · 복원 검증(restores)에 전체 시한.
 *   예전: 두 호출(routes/api/bareosBackup.js 묶음 복원 · bareos/rehearsal.js 검증)이 signal 없이 onDirector 를 불러, 중앙 직접 Director 에서
 *   항목마다 명령을 차례로 보내는 동안(명령마다 콘솔 시한) 대상 잠금 · 업그레이드 대기 표지 · 리허설 busy 가 수십 분 남았다(그룹 실행은 이미 시한이 있다).
 *   ⚠ 행동 시험이 아니라 산수 + 소스 스윕이다 — 지연하는 가짜 Director 가 없고 시한이 7분대라 실제로 끊기는 것은 돌려 보지 않았다(정직 기록).
 *   시한이 끊은 뒤의 분류(보낸 뒤 끊김 = unknown · 남은 항목 = skipped)는 ops.restores 의 기존 코드와 시험이 덮는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';
import { RESTORES_DEADLINE_MS, PICKUP_MS, RESULT_MS, MARGIN_MS } from '../src/bareos/edgeOps.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('시한 산수 — 엣지 대행(인출 + 회신)보다 길고 유한하다(엣지 경로를 먼저 끊지 않는다)', () => {
  assert.ok(Number.isFinite(RESTORES_DEADLINE_MS));
  assert.equal(RESTORES_DEADLINE_MS, PICKUP_MS + RESULT_MS.restores + MARGIN_MS);
  assert.ok(RESTORES_DEADLINE_MS > PICKUP_MS + RESULT_MS.restores);
  assert.ok(RESTORES_DEADLINE_MS <= 15 * 60_000, '15분을 넘지 않는다(예전 상한 50 × 3 × 15초 ≈ 37분)');
});

test('소스 스윕 — onDirector(…, ‘restores’ …) 호출은 전부 signal 을 넘긴다', () => {
  const files = [path.join(SRC, 'routes/api/bareosBackup.js'), path.join(SRC, 'bareos/rehearsal.js')];
  let n = 0;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/onDirector\([^;]*?'restores'[^;]*?\)\s*;?/g)) {
      n += 1;
      assert.match(m[0], /signal:\s*AbortSignal\.timeout\(RESTORES_DEADLINE_MS\)/, `${path.basename(f)}: ${m[0].slice(0, 160)}`);
    }
  }
  assert.equal(n, 2, '호출 두 곳(묶음 복원 · 복원 검증)');
});
