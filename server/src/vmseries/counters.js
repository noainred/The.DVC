/**
 * vmseries/counters.js — 실시간(20초) 스파이크 수집이 다루는 카운터 카탈로그(v2.510).
 *
 * 사용자 결정(2026-09-14): "50% 이상만 저장하고, 차트를 그리고, 평균은 vCenter 자료를 병행" +
 * "모든 값 수집". 그래서 저장 단위는 **스파이크 순간(moment)** 이다 — 트리거 지표 중 하나라도
 * 임계를 넘는 20초 표본 시각에 **그 시각의 카운터 값 전부**를 남긴다. 임계 미만 순간은 저장하지
 * 않는다(평균·p95 는 vCenter 롤업이 맡는다 — 롤업은 평균을 보존하지만 피크를 파괴하고, 이 수집은
 * 그 반대다).
 *
 * 값은 vCenter 가 준 **정수 그대로**(cpu.usage 는 ×100, 메모리는 KB, ready 는 ms) 저장하고
 * 읽을 때 `div` 로 나눈다 — 저장 시 나누면 정밀도를 버리고, 단위를 바꾸면 과거를 되돌릴 수 없다.
 * vCenter 결측은 -1 이며 그대로 둔다(0 으로 바꾸면 '유휴' 로 오해).
 *
 * 카운터 이름·의미는 자원 축소 리포트(vcenter/soapClient.js RIGHTSIZE_COUNTERS)와 같다 — 리포트
 * 8계열에 disk/net 사용량 2계열을 더해 '모든 값' 을 만족시킨다(전 카운터 수백 개를 다 받는 것은
 * 응답 크기·파싱 CPU 때문에 하지 않는다 — 필요하면 여기 한 줄 추가).
 */

/** VM 카운터. trigger 가 있는 계열이 스파이크 순간을 결정한다. */
export const VM_COUNTERS = [
  { name: 'cpuUsagePct',   key: 'cpu.usage.average',    div: 100,  unit: '%',    trigger: 'cpuPct' },
  { name: 'cpuUsageMhz',   key: 'cpu.usagemhz.average', div: 1,    unit: 'MHz' },
  { name: 'cpuReadyMs',    key: 'cpu.ready.summation',  div: 1,    unit: 'ms',   trigger: 'readyPct' },
  { name: 'memUsagePct',   key: 'mem.usage.average',    div: 100,  unit: '%',    trigger: 'memPct' },
  { name: 'memActiveMB',   key: 'mem.active.average',   div: 1024, unit: 'MB' },
  { name: 'memConsumedMB', key: 'mem.consumed.average', div: 1024, unit: 'MB' },
  { name: 'memBalloonMB',  key: 'mem.vmmemctl.average', div: 1024, unit: 'MB',   trigger: 'nonzero' },
  { name: 'memSwappedMB',  key: 'mem.swapped.average',  div: 1024, unit: 'MB',   trigger: 'nonzero' },
  { name: 'diskKBps',      key: 'disk.usage.average',   div: 1,    unit: 'KBps' },
  { name: 'netKBps',       key: 'net.usage.average',    div: 1,    unit: 'KBps' },
];

/** 호스트 카운터 — 호스트 자체의 CPU/메모리 스파이크(선택 대상에 호스트가 있을 때). */
export const HOST_COUNTERS = [
  { name: 'cpuUsagePct',   key: 'cpu.usage.average',    div: 100,  unit: '%',    trigger: 'cpuPct' },
  { name: 'cpuUsageMhz',   key: 'cpu.usagemhz.average', div: 1,    unit: 'MHz' },
  { name: 'memUsagePct',   key: 'mem.usage.average',    div: 100,  unit: '%',    trigger: 'memPct' },
  { name: 'memActiveMB',   key: 'mem.active.average',   div: 1024, unit: 'MB' },
  { name: 'memConsumedMB', key: 'mem.consumed.average', div: 1024, unit: 'MB' },
  { name: 'diskKBps',      key: 'disk.usage.average',   div: 1,    unit: 'KBps' },
  { name: 'netKBps',       key: 'net.usage.average',    div: 1,    unit: 'KBps' },
  { name: 'powerW',        key: 'power.power.average',  div: 1,    unit: 'W' },
];

export const COUNTERS_BY_KIND = { vm: VM_COUNTERS, host: HOST_COUNTERS };

/** ESXi 실시간 구간 — 20초 표본, 호스트가 약 1시간(180개) 보관. 폴러가 maxSample 로 쓴다. */
export const REALTIME_STEP_SEC = 20;
export const REALTIME_MAX_SAMPLES = 180;

/** 기본 임계(설정으로 바뀐다). readyPct 는 vCPU 당 %Ready(리포트 경고선과 같은 5%). */
export const DEFAULT_THRESHOLDS = { cpuPct: 50, memPct: 50, readyPct: 5 };

/** 카탈로그 이름 → 정의. */
export function counterDef(kind, name) {
  return (COUNTERS_BY_KIND[kind] || []).find((c) => c.name === name) || null;
}
