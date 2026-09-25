/**
 * 끝 '/' 제거 — 선형(v2.611 LEFT2611-06 로 단일 소스화).
 *
 * `s.replace(/\/+$/, '')` 는 '/' 가 길게 이어진 뒤 다른 글자가 오는 입력에서 시작 위치마다 끝까지 훑어 **O(n²)** 다
 * (v2.602 SEC2602-01·04 가 routes/central.js·auth/toolAccess.js 에서 이미 루프로 바꿨는데 collector/registry.js 에는
 * 남아 있었다 — 관리자 등록 본문 1MB 까지 들어온다. 실측 4만 자 620ms). 세 곳이 각자 들고 있던 같은 함수를 여기로 올렸다.
 * 의존 방향(v2.579): util/ 은 도메인을 모른다 — routes/ 를 import 하지 말 것.
 */
export const trimTrailingSlashes = (s) => {
  const t = typeof s === 'string' ? s : String(s ?? '');
  let e = t.length;
  while (e > 0 && t.charCodeAt(e - 1) === 47) e--;
  return e === t.length ? t : t.slice(0, e);
};

/** 수집 서버 URL 길이 상한 — 엣지 자기등록(routes/central.js urlHint)과 관리자 등록(collector/registry.js)이 같은 값을 쓴다. */
export const COLLECTOR_URL_MAX = 2048;
