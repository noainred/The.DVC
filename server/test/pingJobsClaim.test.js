import test from 'node:test';
import assert from 'node:assert/strict';

// v2.290 #6-B 회귀 방지 — 위임 ping 잡 claim→ack(IP 단위 in-flight).
// 배경(종전 1단계 인출의 두 결함):
//   1) 유실 — takePingJobs 가 인출 즉시 IP 를 대기열에서 삭제 → 엣지가 인출 직후 죽으면 그 IP 들은
//      결과가 영영 없음(사용자 재요청 전까지 미상).
//   2) UI 깜빡임 — 인출 즉시 pending 에서 빠져, 에이전트가 ping 도는 몇 초간 'unknown'(회색)으로
//      떨어졌다가 결과 도착 시 색이 바뀌었다.
// 새 구조: 인출 IP 를 in-flight 로 옮겨 기한(ACK 30s) 내 결과 없으면 대기 복귀(MAX_TRIES 2 초과 시
// 폐기 — down 이 아니라 '모름'으로 남긴다), in-flight 도 'pending' 으로 표시.
// 모듈은 인메모리 싱글턴 — 테스트 간 vcenterId 를 달리 해 상태 간섭을 피한다.
import {
  enqueuePing, takePingJobs, setPingResults, getPingResults, reapPingClaims,
} from '../src/central/pingJobs.js';

const ACK = 30_000; // pingJobs.js ACK_TIMEOUT_MS 기본값과 동일(환경변수 미설정 전제)

test('정상 경로: enqueue → take(claim) → 결과(ack) → up/down 표시', () => {
  const vc = 'vc-ping-ok';
  assert.equal(enqueuePing(vc, ['10.1.0.1', '10.1.0.2']), 2);
  assert.equal(getPingResults(vc, ['10.1.0.1'])['10.1.0.1'].state, 'pending');

  const t0 = Date.now();
  const taken = takePingJobs([vc], t0);
  assert.deepEqual(taken[vc].sort(), ['10.1.0.1', '10.1.0.2']);
  // ★ 종전 결함 회귀 방지: 인출 직후에도 'unknown' 이 아니라 'pending'(in-flight) 이어야 한다.
  assert.equal(getPingResults(vc, ['10.1.0.1'])['10.1.0.1'].state, 'pending');

  setPingResults(vc, [{ ip: '10.1.0.1', alive: true, rttMs: 3 }, { ip: '10.1.0.2', alive: false }]);
  const r = getPingResults(vc, ['10.1.0.1', '10.1.0.2']);
  assert.equal(r['10.1.0.1'].state, 'up');
  assert.equal(r['10.1.0.2'].state, 'down');
});

test('유실 복구: 인출 후 무응답 → ACK 기한 경과 시 대기 복귀 → 재인출에 같은 IP 포함', () => {
  const vc = 'vc-ping-req';
  enqueuePing(vc, ['10.2.0.1']);
  const t0 = Date.now();
  assert.deepEqual(takePingJobs([vc], t0)[vc], ['10.2.0.1']); // 1차 인출(tries=1)

  // 기한 전에는 복귀하지 않는다(정상 진행 중 오탐 방지) — 재인출해도 빈 결과.
  assert.equal(takePingJobs([vc], t0 + 5_000)[vc], undefined);

  // 기한 경과 후 재인출 → reap 이 대기로 복귀시켜 같은 IP 가 다시 나온다(tries=2).
  const t1 = t0 + ACK + 1_000;
  assert.deepEqual(takePingJobs([vc], t1)[vc], ['10.2.0.1']);

  // 이번엔 결과 도착 → up.
  setPingResults(vc, [{ ip: '10.2.0.1', alive: true, rttMs: 5 }]);
  assert.equal(getPingResults(vc, ['10.2.0.1'])['10.2.0.1'].state, 'up');
});

test('재시도 소진: MAX_TRIES(2)회 무응답 → 폐기되어 unknown(허위 down 기록 금지)', () => {
  const vc = 'vc-ping-drop';
  enqueuePing(vc, ['10.3.0.1']);
  let t = Date.now();
  // 1차(tries=1) → 만료, 2차(tries=2) → 만료: 한도 도달.
  takePingJobs([vc], t);
  t += ACK + 1_000;
  takePingJobs([vc], t); // reap 복귀분을 즉시 재인출
  t += ACK + 1_000;
  const reaped = reapPingClaims(t);
  assert.equal(reaped.dropped, 1, 'tries 한도 도달 → 폐기');
  // '모름' 으로 정직하게 표시 — 에이전트 미회신을 down(적색)으로 오기록하지 않는다.
  assert.equal(getPingResults(vc, ['10.3.0.1'])['10.3.0.1'].state, 'unknown');
  // 폐기된 IP 는 더 이상 인출되지 않는다.
  assert.equal(takePingJobs([vc], t + 1_000)[vc], undefined);
});

test('진행 중 재요청: in-flight IP 는 중복 적재하지 않는다(결과 도착 직후 불필요 재인출 방지)', () => {
  const vc = 'vc-ping-dup';
  enqueuePing(vc, ['10.4.0.1']);
  const t0 = Date.now();
  takePingJobs([vc], t0); // in-flight 로 이동
  // 사용자가 화면을 다시 열어 같은 IP 를 재요청 — 진행 중이므로 pending 에 다시 쌓이면 안 된다.
  enqueuePing(vc, ['10.4.0.1']);
  assert.equal(takePingJobs([vc], t0 + 1_000)[vc], undefined, '진행 중 재적재 없음');
  // 결과가 오면 정상 반영.
  setPingResults(vc, [{ ip: '10.4.0.1', alive: true, rttMs: 2 }]);
  assert.equal(getPingResults(vc, ['10.4.0.1'])['10.4.0.1'].state, 'up');
});
