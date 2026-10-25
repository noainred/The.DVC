/**
 * logs/clockTolerance.js — vCenter 이벤트 시각이 포탈 시각보다 앞서도 받아들이는 여유(ms) 한 벌.
 *
 * v2.783(점검 Q3 L-B1): 값은 v2.781(점검 G1 D-B1)부터 logs/poller.js 의 FUTURE_CLOCK_TOLERANCE_MS 였다(폴러는 그대로 다시 내보낸다).
 *   logs/coverage.js 는 정적 import 그래프에 폴러를 넣지 않는다(loadEventOkAtOf 의 동적 import — 폴러가 store·soapClient 를 끌고 온다)라
 *   상수만 이 import 0 모듈로 옮겼다. 지연 판정(coverage eventLagOf·가용성 측정 끝·수집 진단 lagMs)의 db.lastTs 경계가 폴러와 같은 값을 쓴다.
 * ⚠ import 0 규약 — 이 파일에 다른 모듈을 import 하지 말 것(coverage 가 폴러를 정적으로 끌어오게 된다).
 */
export const FUTURE_CLOCK_TOLERANCE_MS = 10 * 60_000;
