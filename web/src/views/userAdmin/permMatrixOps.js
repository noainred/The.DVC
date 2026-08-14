/**
 * permMatrixOps.js — 권한 매트릭스 순수 연산(v2.295, 3차 모듈화 감사 확정 #6).
 * UserAdmin.jsx 93~129행의 setState 래퍼에서 데이터 변환만 추출(React 무의존) —
 * vitest(permMatrixOps.test.js)로 의미론을 고정한다.
 *
 * 왜 고정하는가: 특수 기능 도구 접근은 **거부목록(toolsDenied) 반전 모델**이다 —
 * "목록에 있으면 거부, 없으면 허용"(체크박스 UI 는 반대로 '체크=허용'으로 보여줌).
 * 이 반전은 실수하기 쉬운데(v2.202 React #310 실사고가 난 화면이기도 함) 지키는 테스트가
 * 없었다. 서버(auth/permissions.js)가 진실의 원천이지만, 클라 표시가 어긋나면 관리자가
 * '허용으로 보이는데 실제 거부'인 매트릭스를 저장하게 된다.
 *
 * 모든 함수는 입력 matrix 를 변경하지 않고 새 matrix 를 반환한다(React 상태 규칙).
 * matrix shape: { operator:[keys], viewer:[keys], toolsDenied:{ operator:[k], viewer:[k] } }
 */

/** 역할이 기능 권한 key 를 갖는가. matrix 결측(로드 전/실패) 안전 — false. */
export function hasMatrixKey(matrix, role, key) {
  return ((matrix?.[role]) || []).includes(key);
}

/** 기능 권한 토글 — 있으면 제거, 없으면 추가한 새 matrix. */
export function toggleMatrixKey(matrix, role, key) {
  const cur = new Set(matrix[role] || []);
  cur.has(key) ? cur.delete(key) : cur.add(key);
  return { ...matrix, [role]: [...cur] };
}

/** 도구 허용 여부 — ⚠ 거부목록 반전: 목록에 **없으면** 허용. admin 은 호출부에서 항상 허용 처리. */
export function isToolAllowed(matrix, role, toolKey) {
  return !(((matrix?.toolsDenied?.[role]) || []).includes(toolKey));
}

/** 도구 거부 토글 — 목록에 있으면 제거(=허용), 없으면 추가(=거부)한 새 matrix. */
export function toggleToolDenied(matrix, role, toolKey) {
  const td = { operator: [...(matrix.toolsDenied?.operator || [])], viewer: [...(matrix.toolsDenied?.viewer || [])] };
  const cur = new Set(td[role]);
  cur.has(toolKey) ? cur.delete(toolKey) : cur.add(toolKey);
  td[role] = [...cur];
  return { ...matrix, toolsDenied: td };
}

/**
 * 전체 허용/차단 — 허용=거부목록 비움, 차단=deniableKeys 전부 거부.
 * deniableKeys 는 호출부가 SPECIAL_TOOLS 에서 adminOnly 제외로 계산해 넘긴다(이 모듈은
 * 도구 카탈로그를 모른다 — 카탈로그 결합을 피해 순수성 유지).
 */
export function setAllToolsDenied(matrix, role, allow, deniableKeys) {
  const td = { operator: [...(matrix.toolsDenied?.operator || [])], viewer: [...(matrix.toolsDenied?.viewer || [])] };
  td[role] = allow ? [] : [...deniableKeys];
  return { ...matrix, toolsDenied: td };
}
