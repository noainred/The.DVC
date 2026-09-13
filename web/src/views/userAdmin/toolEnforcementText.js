/**
 * userAdmin/toolEnforcementText.js — '도구별 접근' 표의 **서버 집행 여부** 문구(순수, v2.506).
 *
 * 왜 필요한가: 이 표에서 체크를 끄면 관리자는 '그 도구가 막혔다' 고 읽는다. 그런데 `toolsDenied`
 * 를 서버가 실제로 막는 것은 `/api/tools/*` 중 **매핑된 경로**뿐이다(server/src/auth/toolAccess.js).
 * 매핑이 없는 도구는 프론트 메뉴만 사라지고 curl 직접 호출은 200 이다 — v2.447 이 이 모듈군을
 * 만든 이유가 그 '무음 실패' 였고, v2.506 까지 서버는 사실을 `/admin/permissions` 응답의
 * `toolEnforcement` 로 내려주기 시작했는데 **화면이 그것을 쓰지 않았다**. 여기서 쓴다.
 *
 * 컴포넌트 렌더 테스트가 불가한 환경(웹 테스트는 node, DOM 없음)이라 판정·문구는 순수 함수로
 * 두고 회귀로 고정한다(CLAUDE.md 프론트 규칙 — accessDeniedText.js 와 같은 방식).
 */

/** 서버가 내려주는 분류(server/src/auth/toolAccess.js ENFORCE_*) → 배지 문구. */
export const KIND_BADGE = Object.freeze({
  'other-router': '다른 경계',
  'shared-endpoint': '공유 경로',
  partial: '부분 집행',
  'no-api': 'API 없음',
});

export const LEVEL_SERVER = 'server';     // 서버가 실제로 403 을 만든다
export const LEVEL_PARTIAL = 'partial';   // 전용 하위경로만 막힌다
export const LEVEL_DECLARED = 'declared'; // 못 막는 이유가 선언돼 있다
export const LEVEL_UNKNOWN = 'unknown';   // 선언도 없다 — 새 도구를 추가하고 신고를 안 한 상태

/**
 * 도구 하나의 집행 상태. `info` 는 `/admin/permissions` 응답의 `toolEnforcement`
 * (`{ enforced: string[], notes: { [k]: [kind, why] } }`). 응답이 없는 구버전 서버면 null 을 넘긴다.
 * @returns {{level:string, badge:string, title:string}}
 */
export function enforcementOf(toolKey, info) {
  const k = String(toolKey || '');
  if (!info || !Array.isArray(info.enforced)) {
    return { level: LEVEL_UNKNOWN, badge: '?', title: '이 서버는 집행 정보를 내려주지 않습니다(구버전).' };
  }
  const note = (info.notes || {})[k] || null;
  const kind = note ? String(note[0] || '') : '';
  const why = note ? String(note[1] || '') : '';
  if (kind === 'partial') {
    return { level: LEVEL_PARTIAL, badge: KIND_BADGE.partial, title: `일부만 막힙니다 — ${why}` };
  }
  if (info.enforced.includes(k)) {
    return { level: LEVEL_SERVER, badge: '서버 차단', title: '체크를 끄면 서버가 직접 403 으로 막습니다(API 직접 호출도 차단).' };
  }
  if (note) {
    return { level: LEVEL_DECLARED, badge: KIND_BADGE[kind] || kind || '미집행', title: `이 도구는 도구별 접근으로 막히지 않습니다 — ${why}` };
  }
  return {
    level: LEVEL_UNKNOWN,
    badge: '미확인',
    title: '서버가 이 도구를 막을 수 있는지 확인되지 않았습니다 — 화면에서만 숨겨질 수 있습니다(서버 auth/toolAccess.js 에 선언 필요).',
  };
}

/** 표 위에 띄우는 한 줄 요약. 숫자를 화면에 하드코딩하지 않고 응답에서 센다. */
export function enforcementSummary(toolKeys = [], info) {
  const counts = { [LEVEL_SERVER]: 0, [LEVEL_PARTIAL]: 0, [LEVEL_DECLARED]: 0, [LEVEL_UNKNOWN]: 0 };
  for (const k of toolKeys) counts[enforcementOf(k, info).level] += 1;
  if (!info || !Array.isArray(info.enforced)) return '집행 정보를 제공하지 않는 서버입니다 — 아래 체크는 화면 노출만 보장합니다.';
  const parts = [`서버 차단 ${counts[LEVEL_SERVER]}개`];
  if (counts[LEVEL_PARTIAL]) parts.push(`부분 집행 ${counts[LEVEL_PARTIAL]}개`);
  if (counts[LEVEL_DECLARED]) parts.push(`화면 노출만 ${counts[LEVEL_DECLARED]}개`);
  if (counts[LEVEL_UNKNOWN]) parts.push(`미확인 ${counts[LEVEL_UNKNOWN]}개`);
  return `${parts.join(' · ')} — '서버 차단' 이 아닌 도구는 체크를 꺼도 API 직접 호출을 막지 못합니다.`;
}
