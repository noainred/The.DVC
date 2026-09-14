/**
 * version_4/mode.js — '경영 보기 ↔ 엔지니어 보기' 모드 판정(v2.508, 순수).
 *
 * ⚠ 모드는 **보기 설정이지 권한이 아니다.** 모드를 바꿔서 볼 수 있는 데이터가 늘거나 줄지 않는다.
 *   보장하는 것: **권한 · 데이터 범위 · 임계값(75/90)** 은 두 모드가 완전히 같다.
 *   보장하지 않는 것: 패널 구성이 다르므로 **호출하는 API 집합은 다를 수 있다**
 *     (예: 경영 화면은 /tools/waste 를, 엔지니어 화면은 /tool-usage/top 을 더 부른다).
 *     시안(Shell.dc.html)에는 '호출 API 도 동일' 이라고 적혀 있었지만 ②/⑤ 의 패널이 서로 달라
 *     문자 그대로는 성립하지 않는다 — 화면 문구도 여기 기준으로 쓴다.
 *
 * 판정 우선순위: ① URL 질의(?view=) → ② localStorage → ③ 역할 기본값.
 *   ① 은 **그 탭에만** 적용하고 저장하지 않는다(딥링크로 남에게 보낸 링크가 내 설정을 바꾸면 안 된다).
 *
 * DOM·localStorage 접근은 이 파일에 두지 않는다 — 웹 테스트가 node 환경(DOM 없음)이라
 * 판정을 순수 함수로 고정해야 회귀가 잡힌다(accessDeniedText.js · sensorText.js 와 같은 패턴).
 */

export const MODES = Object.freeze(['exec', 'eng']);
export const MODE_KEY = 'vmportal.viewMode';

export const MODE_LABEL = Object.freeze({ exec: '경영 보기', eng: '엔지니어 보기' });

/** 아는 값만 통과시킨다. 모르는 값은 null — 호출자가 다음 순위로 넘어간다. */
export function normMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return MODES.includes(s) ? s : null;
}

/**
 * 역할 기본값.
 *   admin    → 경영  (전사 현황을 먼저 본다)
 *   operator → 엔지니어 (수집 상태·원시 값이 필요한 역할)
 *   viewer   → 경영
 *
 * viewer 를 경영으로 두는 이유는 **엔지니어 랜딩이 더 많이 잠기기 때문**이지, 경영 화면이
 * viewer 에게 다 보이기 때문이 아니다 — viewer 는 `tools` 권한이 없어 경영 화면의
 * /tools/* 패널(용량 소진·회수 가능 자원·VM 추이)도 똑같이 잠긴다. 화면 문구를 그렇게 쓴다.
 */
export function defaultMode(role) {
  return String(role || '').toLowerCase() === 'operator' ? 'eng' : 'exec';
}

/** ① query → ② stored → ③ 역할 기본값. 어느 것도 유효하지 않으면 역할 기본값. */
export function resolveMode({ query, stored, role } = {}) {
  return normMode(query) || normMode(stored) || defaultMode(role);
}

/**
 * 모드가 **바꾸는 것만** 모아 둔다. 권한·API 경로·임계값은 여기 없다(바꾸지 않으므로).
 *   rows      표 기본 행수
 *   days      추이 차트 기본 기간(일)
 *   rawCols   vCenter ID · 서비스태그 · moref 같은 원시 식별자 열을 보이는가
 *   collect   수집 상태 바를 펼치는가
 *   unit      숫자 단위 표기 계열
 */
export function modeSpec(mode) {
  return normMode(mode) === 'eng'
    ? { rows: 50, days: 7, rawCols: true, collect: true, unit: 'raw' }
    : { rows: 10, days: 90, rawCols: false, collect: false, unit: 'exec' };
}

/** 해시 질의(`#/v4/overview?view=exec`)에서 view 값을 읽는다. 없으면 null. */
export function viewFromHash(hash) {
  const q = String(hash || '').split('?')[1];
  if (!q) return null;
  for (const part of q.split('&')) {
    const [k, v] = part.split('=');
    if (k === 'view') return normMode(decodeURIComponent(v || ''));
  }
  return null;
}
