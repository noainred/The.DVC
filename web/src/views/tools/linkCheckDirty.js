/**
 * 통신 점검 설정 폼의 '저장하지 않은 편집' 판정(순수 — vitest 고정, v2.631 감사 R2631-04).
 *
 * v2.630 WEB2630-05 가 편집 중 폼을 load 가 덮지 않게 했는데, 편집 표시(formDirty)가 **저장 성공에서만** 내려갔다.
 * 그래서 칸을 고치다 '설정 닫기' 로 버린 편집이 이후 모든 load 에서 서버값을 가렸고, 다시 열면 버린 값이 서버값처럼
 * 보였으며 그대로 저장하면 그 사이 다른 관리자의 변경을 덮었다.
 * - 패널을 닫으면 편집을 버리고 서버값으로 되돌린다(컴포넌트).
 * - 편집 중 서버값이 바뀌면 그 사실을 말한다 — 편집을 시작할 때 본 서버값과 지금 서버값을 비교한다.
 */
import { linkFormFromSettings } from './linkCheckForm.js';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** 서버 설정의 비교용 서명(폼 모양 기준 — 키 순서에 무관). 설정이 없으면 null. */
export function linkSettingsSig(settings) {
  if (!settings || typeof settings !== 'object') return null;
  return stable(linkFormFromSettings(settings));
}

/**
 * 편집 중 서버 설정이 바뀌었는가. 편집 중이 아니거나 기준 서명·새 설정이 없으면 false(모르는 것을 '바뀌었다' 고 하지 않는다).
 * @param {boolean} dirty 저장하지 않은 편집이 있는가
 * @param {string|null} baseSig 편집 기준 서버 설정 서명
 * @param {object|null} serverSettings 방금 받은 서버 설정
 */
export function serverChangedWhileEditing(dirty, baseSig, serverSettings) {
  if (!dirty || baseSig == null) return false;
  const now = linkSettingsSig(serverSettings);
  if (now == null) return false;
  return now !== baseSig;
}

/** 편집 중 서버값이 바뀌었을 때 보일 문구(백틱 없음 — BoldText 로 그린다). */
export const SERVER_CHANGED_NOTE = '편집하는 동안 **서버의 설정이 바뀌었습니다**(다른 관리자가 저장했을 수 있습니다) — 지금 저장하면 그 변경을 덮어씁니다. 편집을 버리고 서버값을 불러오거나, 확인한 뒤 저장하세요.';
