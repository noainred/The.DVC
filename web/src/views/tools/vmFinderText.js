// vmFinderText.js — VM 정밀 검색(유휴 VM 분석)의 순수 표시 판정. 화면(VmFinderTool.jsx)과 테스트가 같이 쓴다.
import { numOrNull } from '../../numOrNull.js';

/**
 * 122회차(111회차 결정 3 — 권장안 구현): '유휴 VM' 카드.
 * 서버는 111회차부터 평균을 못 읽은 VM 을 유휴(true)에도 사용(false)에도 넣지 않고 `idleUnknown` 으로 따로 센다. 그런데 카드는 `idleCount` 만
 * 봐서, 분석한 VM 전부의 평균을 못 읽었을 때(성능 조회 실패 · 인증 정지 · 직접 수집 대상 아님) **초록 '0'** 이었다 — 판정하지 못한 것을 '유휴 없음' 으로.
 *  · 판정한 VM 이 하나도 없으면 값은 '—'(색 없음) + 사유
 *  · 일부만 판정했으면 값은 유휴 수 그대로, 설명에 '판정 불가 N대' — 유휴가 0 이어도 초록이 아니라 노랑(전부를 본 것이 아니다)
 *  · idleUnknown 이 없는 응답(옛 서버)은 예전과 같다
 * @param {object} data  POST /tools/vm-finder 응답(withAvg)
 * @param {number} itemCount 검색 결과 행 수
 * @returns {{value:(number|string), accent:(string|undefined), meta:string}}
 */
export function idleCardOf(data, itemCount = 0) {
  const idle = numOrNull(data?.idleCount) ?? 0;
  const unknown = Math.max(0, numOrNull(data?.idleUnknown) ?? 0);
  const cap = numOrNull(data?.avgCap);
  const total = Math.max(0, numOrNull(itemCount) ?? 0);
  const analyzed = cap == null ? total : Math.min(total, cap);   // 평균을 조회한 대상 수(상위 avgCap 대)
  const base = `평균 CPU ≤ ${data?.idleThreshold}%`;
  if (unknown > 0 && analyzed - unknown <= 0) {
    return { value: '—', accent: undefined, meta: `${base} · 분석한 ${analyzed.toLocaleString()}대 모두 평균을 읽지 못해 판정하지 못했습니다` };
  }
  if (unknown > 0) {
    return { value: idle, accent: idle ? 'var(--red)' : 'var(--amber)', meta: `${base} · 판정 불가 ${unknown.toLocaleString()}대(평균을 읽지 못함)` };
  }
  return { value: idle, accent: idle ? 'var(--red)' : 'var(--green)', meta: base };
}
