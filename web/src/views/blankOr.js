/**
 * 숫자 입력칸 → 요청 값(v2.596, 감사 CLAMP2596-02·05). 빈 칸은 **보내지 않는다**(undefined — JSON 에서 빠진다) —
 * `Number('')` 는 0 이라 '임계 끔'·'보존 무제한' 으로 둔갑했다. 서버도 빈 값을 미지정으로 받지만 두 쪽 다 지킨다.
 * 숫자로 읽히면 숫자, 아니면 undefined.
 */
export function blankOr(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
