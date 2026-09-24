/**
 * 큰 배열 붙이기(v2.603 감사 CEN2603-03 후속).
 *
 * 왜: `target.push(...src)` 는 원소 수만큼 **함수 인자**를 만든다 — V8 에서 약 12~13만 개를 넘으면
 * `RangeError: Maximum call stack size exceeded` 로 던진다. 인벤토리(VM·이벤트·스캔 결과·지표 행)는 운영 규모에서
 * 그 수에 닿을 수 있고, 던지면 스냅샷 병합·원장 계산 **전체**가 멈춘다(오류는 원소 수에만 달려 있어 테스트 데이터로는 안 보인다).
 * 반복 push 는 원소 수와 무관하다. 작은 고정 배열(인자 몇 개)에는 굳이 쓸 필요가 없다.
 *
 * @template T
 * @param {T[]} target
 * @param {ArrayLike<T> | null | undefined} src  배열이 아니면(없으면) 아무것도 하지 않는다
 * @returns {T[]} target
 */
export function pushAll(target, src) {
  if (!src || typeof src.length !== 'number') return target;
  for (let i = 0; i < src.length; i++) target.push(src[i]);
  return target;
}
