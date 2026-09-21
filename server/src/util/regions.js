/**
 * 지역(region) 목록 — **단일 소스**(v2.575 IMP-10).
 *
 * v2.574 까지 같은 배열이 **7벌**이었다(서버 `vcenter/registry.js`·`nsx/registry.js`·
 * `llm/nlSearch.js` 인라인, 웹 `App.jsx`·`UserAdmin.jsx`·`VCenterAdmin.jsx`·`NsxAdmin.jsx`).
 * 값은 그때 전부 같았지만 **테스트가 0건**이라 지역을 하나 추가하면 어디가 빠졌는지 알 길이
 * 없었다 — 특히 `nlSearch.js:135` 의 인라인은 자연어 검색에서만 쓰여 **그 화면만 조용히
 * 새 지역을 못 찾는다**(오류 없이 결과가 비는 유형).
 * 웹은 `web/src/regions.js` 가 이 파일과 **같은 값임을 테스트가 대조**한다(웹은 서버 소스를
 * import 할 수 없다 — 번들 경계).
 */
export const REGIONS = ['아시아', '중국', '유럽', '북미'];
export default REGIONS;
