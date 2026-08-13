import test from 'node:test';
import assert from 'node:assert/strict';

// v2.290 #6-B 회귀 방지 — 위임 캡처 잡 claim→ack 2단계 확인응답.
// 배경: 종전 takeCaptureJobs 는 인출 즉시 잡을 삭제했다(1단계). 엣지가 인출 직후 재시작/단절되면
// 잡이 유실되고 UI 는 TTL(5분)까지 'pending' → 'unknown' 으로 끝났다(실패 사유 없음).
// 새 구조: 인출(claim) 후 결과(ack)가 기한 내 없으면 대기로 복귀(재인출), MAX_CLAIMS(2) 초과 시
// { ok:false, reason } 오류 결과로 종결해 UI 가 즉시 실패를 안다.
// 모듈은 인메모리 싱글턴이므로 테스트 간 에이전트 이름을 달리 해 상태 간섭을 피한다.
// 시간 제어: takeCaptureJobs/reapCaptureClaims 의 now 주입(운영 기본 Date.now()).
import {
  enqueueCapture, takeCaptureJobs, setCaptureResult, getCaptureResult,
  reapCaptureClaims, captureAgentOfReq,
} from '../src/central/captureJobs.js';

// claim 기한 계산과 동일한 상수(captureJobs.js ACK_GRACE_MS 기본 60s, seconds 기본 10s 클램프).
const GRACE = 60_000;

test('정상 경로: enqueue → take(claim) → 결과(ack) → done', () => {
  const reqId = enqueueCapture('cap-agent-ok', { host: '10.0.0.1', peer: '10.0.0.2', seconds: 10 });
  assert.ok(reqId);
  assert.equal(captureAgentOfReq(reqId), 'cap-agent-ok');
  assert.equal(getCaptureResult(reqId).state, 'pending');

  const t0 = Date.now();
  const taken = takeCaptureJobs('cap-agent-ok', t0);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].reqId, reqId);
  assert.equal(taken[0].spec.peer, '10.0.0.2', 'spec 원본이 그대로 전달돼야 함(SSH 자격증명 포함)');
  // 인출됐어도 UI 는 여전히 pending(종전과 동일 표시 — running 을 따로 구분하지 않음).
  assert.equal(getCaptureResult(reqId).state, 'pending');
  // 재인출 방지: 같은 폴이 또 와도 running 잡은 다시 나가지 않는다.
  assert.equal(takeCaptureJobs('cap-agent-ok', t0 + 1000).length, 0);

  assert.ok(setCaptureResult(reqId, { ok: true, summary: 'test' }));
  const r = getCaptureResult(reqId);
  assert.equal(r.state, 'done');
  assert.equal(r.result.ok, true);
});

test('유실 복구: 인출 후 무응답 → 기한 경과 시 대기 복귀 → 재인출 가능(2단계 확인응답의 핵심)', () => {
  const reqId = enqueueCapture('cap-agent-req', { host: '10.0.1.1', peer: '10.0.1.2', seconds: 10 });
  const t0 = Date.now();
  assert.equal(takeCaptureJobs('cap-agent-req', t0).length, 1); // 1차 claim(claims=1)

  // 기한(캡처 10s + GRACE) 전에는 재수확되지 않는다 — 정상 진행 중 오탐 재인출 금지.
  const early = reapCaptureClaims(t0 + 5_000);
  assert.equal(early.requeued, 0);

  // 기한 경과 → 대기 복귀(claims=1 < MAX 2 이므로 재시도).
  const after = t0 + 10_000 + GRACE + 1_000;
  const reaped = reapCaptureClaims(after);
  assert.equal(reaped.requeued, 1);
  assert.equal(getCaptureResult(reqId).state, 'pending', '복귀 후에도 UI 는 pending 유지(유실 아님)');

  // 재인출(2차 claim) → 이번엔 결과가 도착 → done.
  const retaken = takeCaptureJobs('cap-agent-req', after);
  assert.equal(retaken.length, 1);
  assert.equal(retaken[0].reqId, reqId, '같은 잡이 다시 나가야 함(새 잡 아님)');
  setCaptureResult(reqId, { ok: true });
  assert.equal(getCaptureResult(reqId).state, 'done');
});

test('재시도 소진: MAX_CLAIMS(2)회 무응답 → { ok:false } 오류 결과로 종결(무한 pending 방지)', () => {
  const reqId = enqueueCapture('cap-agent-fail', { host: '10.0.2.1', peer: '10.0.2.2', seconds: 10 });
  let t = Date.now();
  // 1차 claim → 만료, 2차 claim → 만료: 총 2회(=MAX_CLAIMS) 소진.
  for (let i = 0; i < 2; i++) {
    assert.equal(takeCaptureJobs('cap-agent-fail', t).length, 1, `${i + 1}차 인출`);
    t += 10_000 + GRACE + 1_000;
    reapCaptureClaims(t);
  }
  const r = getCaptureResult(reqId);
  assert.equal(r.state, 'done');
  assert.equal(r.result.ok, false);
  assert.match(r.result.reason, /결과를 회신하지 않았습니다/);
  // 종결된 잡은 더 이상 재인출되지 않는다.
  assert.equal(takeCaptureJobs('cap-agent-fail', t).length, 0);
});

test('늦은 결과(ack) 도착: reap 복귀 직후 지연 회신이 와도 done 처리 + 중복 재인출 없음', () => {
  const reqId = enqueueCapture('cap-agent-late', { host: '10.0.3.1', peer: '10.0.3.2', seconds: 10 });
  const t0 = Date.now();
  takeCaptureJobs('cap-agent-late', t0);            // 1차 claim
  reapCaptureClaims(t0 + 10_000 + GRACE + 1_000);   // 기한 만료 → pending 복귀
  // 복귀 직후, 사실은 살아 있던 엣지의 늦은 결과가 도착(경합 시나리오 — idrac 확정 버그 #15 대응과 동일).
  setCaptureResult(reqId, { ok: true, late: true });
  assert.equal(getCaptureResult(reqId).state, 'done');
  // done 잡은 대기 인덱스에 남아 있어도 재인출되지 않아야 한다(중복 캡처 방지).
  assert.equal(takeCaptureJobs('cap-agent-late', t0 + 200_000).length, 0);
});
