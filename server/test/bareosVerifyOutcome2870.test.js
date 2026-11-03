/**
 * test/bareosVerifyOutcome2870.test.js — v2.870 감사 A2-02: 복원 검증(리허설) 판정 코어 하나.
 *   예전에는 같은 판정이 세 벌이었고 서로 달랐다(재현):
 *    · 일일 요약(digest.js) — finish.verify 'failed' 또는 state error 만 실패로 셌다(재시도 소진 · 추적 놓침 · 취소가 메일에서 사라짐)
 *    · 복원 › 폴더 표(restoreStateText) — 켜 보는 중(nic pending) · 재시도 소진(nic failed)을 '검증 성공'(tone ok)으로 보였다
 *    · 리허설 표(verifyTone) — nic skipped · canceled 를 info 로
 *   이제 서버 digest.verifyOutcome 과 웹 bareosRestoreText.verifyOutcome 이 같은 입력에 같은 값을 낸다(이 시험이 대조).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as DG from '../src/bareos/digest.js';

const W = await import('../../web/src/views/tools/bareosRestoreText.js');
const T = await import('../../web/src/views/tools/bareosRestoreTree.js');

const CASES = [
  [{ verify: true, state: 'ok', finish: { nic: 'ok', verify: 'ok' } }, 'ok'],
  [{ verify: true, state: 'ok', finish: { nic: 'failed', verify: 'failed' } }, 'failed'],
  [{ verify: true, state: 'ok', finish: { nic: 'failed' } }, 'failed'],          // 재시도 소진 · 보내지 못함 · 이름 모름
  [{ verify: true, state: 'canceled', finish: { nic: 'skipped' } }, 'failed'],    // 복원이 성공으로 끝나지 않음
  [{ verify: true, state: 'error' }, 'failed'],
  [{ verify: true, state: 'unknown', abandoned: true }, 'failed'],               // 추적을 놓친 복원
  [{ verify: true, state: 'ok', finish: { nic: 'pending', opId: 'x' } }, 'pending'], // 켜 보는 중
  [{ verify: true, state: 'ok' }, 'pending'],                                     // 마무리 전
  [{ verify: true, state: 'running' }, 'pending'],
  [null, 'pending'],
];

test('서버 · 웹 verifyOutcome 이 같은 입력에 같은 값', () => {
  for (const [r, want] of CASES) {
    assert.equal(DG.verifyOutcome(r), want, JSON.stringify(r));
    assert.equal(W.verifyOutcome(r), want, `웹 ${JSON.stringify(r)}`);
  }
});

test('일일 요약 — 재시도 소진 · 취소 · 훅 실패를 모두 검증 실패로 센다(예전 1 → 3) · 켜 보는 중은 세지 않는다', () => {
  const now = Date.now();
  const settings = { directors: [{ id: 'D1', name: '한국' }], sites: [] };
  const restores = [
    { jobid: 1, at: now - 1000, verify: true, state: 'ok', finish: { nic: 'failed' } },
    { jobid: 2, at: now - 1000, verify: true, state: 'canceled', finish: { nic: 'skipped' } },
    { jobid: 3, at: now - 1000, verify: true, state: 'ok', finish: { nic: 'failed', verify: 'failed' } },
    { jobid: 4, at: now - 1000, verify: true, state: 'ok', finish: { nic: 'pending' } },
    { jobid: 5, at: now - 1000, verify: true, state: 'ok', finish: { nic: 'ok', verify: 'ok' } },
  ];
  const jobs = [{ id: '1', vcenterId: 'vc-a', directorId: 'D1', vmName: 'web', enabled: true, lastRun: { jobid: 11, state: 'ok', endedAt: now - 3600_000 }, restores }];
  const d = DG.digestData(jobs, settings, { D1: { ok: true } }, now);
  const c = d.rows[0];
  assert.deepEqual([c.verifyOk, c.verifyFail, c.restores], [1, 3, 0]);
  assert.equal(d.total.verifyFail, 3);
});

test('복원 › 폴더 표 복원 상태 — 켜 보는 중은 성공이 아니다 · 재시도 소진은 실패', () => {
  const now = Date.now();
  const at = now - 3600_000;
  const pend = T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at, verify: true, finish: { nic: 'pending' } }] }, now);
  assert.doesNotMatch(pend.text, /성공/);
  assert.notEqual(pend.tone, 'ok');
  assert.match(pend.text, /^검증 중/);
  const fail = T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at, verify: true, finish: { nic: 'failed' } }] }, now);
  assert.equal(fail.tone, 'bad');
  assert.match(fail.text, /^검증 실패/);
  const ok = T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at, verify: true, finish: { nic: 'ok', verify: 'ok' } }] }, now);
  assert.equal(ok.tone, 'ok');
  // 일반 복원(검증 아님)은 예전 그대로
  assert.match(T.restoreStateText({ restores: [{ jobid: 1, state: 'ok', at }] }, now).text, /^복원 성공/);
});

test('리허설 표 verifyTone — 복원 실패 · 취소는 bad(문구 ‘복원 실패 — 켜 보지 못함’ 과 맞춤)', () => {
  assert.equal(W.verifyTone({ state: 'canceled', finish: { nic: 'skipped' } }), 'bad');
  assert.equal(W.verifyTone({ state: 'ok', finish: { nic: 'pending' } }), 'info');
  assert.equal(W.verifyTone({ state: 'ok', finish: { verify: 'ok' } }), 'ok');
  assert.equal(W.verifyText({ state: 'canceled', finish: { nic: 'skipped' } }), '복원 실패 — 켜 보지 못함');
});

test('A4-06 요약 문단 — 결과 모름 법인이 있으면 ‘실행 없음’ 수에 한정어(아는 법인만 셌다)', () => {
  const now = Date.now();
  const settings = { directors: [{ id: 'D1', name: '한국' }, { id: 'D2', name: '폴란드' }], sites: [] };
  const jobs = [
    { id: '1', vcenterId: 'vc-a', directorId: 'D1', vmName: 'a', enabled: true, lastRun: { jobid: 1, state: 'ok', endedAt: now - 3 * 86400_000 } },
    { id: '2', vcenterId: 'vc-b', directorId: 'D2', vmName: 'b', enabled: true },
  ];
  const withUnknown = DG.renderDigest(DG.digestData(jobs, settings, { D1: { ok: true }, D2: { ok: false } }, now), now).html;
  assert.match(withUnknown, /24시간 안에 실행 없음 1대\(결과 모름 법인 제외\)/);
  const allKnown = DG.renderDigest(DG.digestData(jobs, settings, { D1: { ok: true }, D2: { ok: true } }, now), now).html;
  assert.doesNotMatch(allKnown, /결과 모름 법인 제외/);
});
