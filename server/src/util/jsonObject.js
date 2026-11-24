/**
 * 설정 · 저장소 파일 읽기의 '객체 JSON' 판정(v3.17.2 — 2차 공통 기능 점검 1회차).
 *
 * 왜: 저장소 27곳이 `JSON.parse(text) || {}` 로 읽었다. 이 형태는 `null` 만 `{}` 로 바꾸고 **객체가 아닌 JSON**(`5` · `"live"` · `true` · `[]`)은
 *   그대로 통과시킨다. 그 값을 캐시로 쓰는 저장소는 다음 쓰기에서 깨진다 — 수 · 글자면 `cache[k] = v` 가 엄격 모드 TypeError(라우트 500),
 *   배열이면 속성이 직렬화되지 않아 **'저장됐다' 고 답하고 재시작 뒤 사라진다**(v3.10.11 runtime-settings 실제 재현 · IP 메모 · IP 재정의 같은 형태),
 *   `Object.assign(맵, "abc")` 는 '0' · '1' · '2' 같은 엉뚱한 키를 만든다. 원자적 쓰기만 하는 포탈 자신은 그런 파일을 만들지 않지만
 *   손 편집 · 다른 판의 복원 · 다른 도구가 쓴 파일이면 생긴다.
 * 규칙: 객체(배열 제외)는 그대로 · `null` 은 `{}`(예전 `|| {}` 와 같다) · 그 밖은 **던진다** — 호출부의 기존 catch 가 깨진 JSON 과 똑같이
 *   다룬다(대부분 preserveCorrupt 로 원본을 `<file>.corrupt.<시각>` 에 보존하고 기본값으로 시작). 오류 문구에 파일 내용을 싣지 않는다.
 */

/** JSON 글 → 평범한 객체. 객체가 아니면(배열 · 수 · 글자 · 참거짓) SyntaxError — 깨진 JSON 과 같은 경로로 처리된다. */
export function parseJsonObject(text) {
  const v = JSON.parse(text);
  if (v == null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  throw new SyntaxError(`객체가 아닌 JSON(${Array.isArray(v) ? '배열' : typeof v === 'string' ? '글자' : typeof v === 'number' ? '수' : typeof v === 'boolean' ? '참거짓' : '알 수 없음'})`);
}

export default parseJsonObject;
