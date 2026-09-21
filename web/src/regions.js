/**
 * 지역(region) 목록 — 웹 단일 소스(v2.575 IMP-10).
 * ⚠ 값은 서버 `server/src/util/regions.js` 와 **글자 그대로 같아야 한다**(웹은 서버 소스를
 * import 할 수 없어 복사가 불가피하다). `web/src/regions.test.js` 가 두 파일을 대조한다 —
 * 한쪽만 고치면 그 테스트가 깨진다.
 */
export const REGIONS = ['아시아', '중국', '유럽', '북미'];
export default REGIONS;
