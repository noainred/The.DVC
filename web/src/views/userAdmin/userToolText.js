/**
 * userAdmin/userToolText.js — **사용자별 특수기능 접근** 구획의 판정·문구(순수, v2.555).
 *
 * 사용자 요청(2026-09-18): "특정 사용자는 특수기능의 특정 기능만 사용할 수 있고, 나머지 기능은
 * 보여주지 않고 싶다 — 예를 들어 스토리지 엔지니어에게 스토리지 메뉴만".
 *
 * 왜 순수 모듈인가: 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가하다.
 * 판정·문구는 여기 두고 vitest 로 고정한다(`accessDeniedText.js`·`toolEnforcementText.js` 와 같은 방식).
 *
 * ⚠⚠ **이 화면이 만들 수 있는 최악의 거짓은 '막았다고 말했는데 안 막힌 것'** 이다. 세 가지를
 *   반드시 말한다 — ① 상위 게이트인 '특수 기능' 권한이 없으면 허용 목록은 뜻이 없다
 *   ② 서버가 막지 못하는 도구는 화면에서만 숨는다(v2.506 `toolEnforcement`)
 *   ③ 허용 목록은 **앞으로 추가되는 도구도 차단**한다(거부 목록과 반대 방향의 성질이다).
 * ⚠ 문구에 백틱을 쓰지 말 것 — `BoldText` 는 **강조** 만 해석하고 백틱은 글자로 샌다
 *   (v2.439·2.440·2.505·2.545·2.553 실제 사고). 값 인용은 홑화살괄호 ‘ ’ 로 한다.
 */

export const MODE_OFF = 'off';
export const MODE_ALLOW = 'allow';
export const MODE_DENY = 'deny';

/** 모드 라벨 — 라디오·배지가 같은 말을 쓰게 하는 단일 지점. */
export const MODE_LABEL = Object.freeze({
  [MODE_OFF]: '제한 없음(역할 기준)',
  [MODE_ALLOW]: '고른 것만 허용',
  [MODE_DENY]: '고른 것만 추가 차단',
});

/** 모드별 설명 — 관리자가 무엇을 고르는지 한 줄로. */
export function modeHelp(mode) {
  if (mode === MODE_ALLOW) {
    return '이 계정은 **아래에서 고른 도구만** 쓸 수 있고 나머지는 메뉴에서 사라집니다. 앞으로 새로 추가되는 도구도 고르지 않으면 보이지 않습니다.';
  }
  if (mode === MODE_DENY) {
    return '역할이 막은 것에 **더해서** 이 계정만 추가로 막습니다. 목록에 없는 도구는 역할 설정을 그대로 따릅니다.';
  }
  return '이 계정만을 위한 재정의를 두지 않습니다 — 위 ‘도구별 접근’ 의 역할 설정을 그대로 따릅니다.';
}

/** 지금 이 사용자에게 적용 중인 것(배지용). `entry` 는 서버 `matrix.users[username]` 또는 null. */
export function overrideBadge(entry) {
  const mode = entry && entry.mode ? String(entry.mode) : MODE_OFF;
  if (mode === MODE_ALLOW) {
    const n = (entry.tools || []).length;
    return { mode, tone: n ? 'warn' : 'bad', text: n ? `허용 ${n}개만` : '특수기능 전면 차단' };
  }
  if (mode === MODE_DENY) {
    return { mode, tone: 'warn', text: `추가 차단 ${(entry.tools || []).length}개` };
  }
  return { mode: MODE_OFF, tone: 'muted', text: '역할 기준' };
}

/** 누가·언제 설정했는지. 값이 없으면 null(지어내지 않는다). */
export function overrideByText(entry) {
  if (!entry) return null;
  const by = String(entry.by || '').trim();
  const at = Number(entry.at) > 0 ? new Date(Number(entry.at)) : null;
  if (!by && !at) return null;
  const when = at ? at.toLocaleString('ko-KR') : '시각 미기록';
  return by ? `${by} · ${when}` : when;
}

/**
 * 상위 게이트 경고 — '특수 기능'(tools) 기능 권한이 없으면 허용 목록은 아무 뜻이 없다.
 * 조용히 두면 관리자가 "골라 줬는데 왜 안 보이지" 로 헤맨다(무음 실패 금지).
 * @param {{mode?:string}} opt.entry  · @param {boolean} opt.hasToolsPerm  그 역할이 tools 권한 보유
 */
export function toolsPermWarning({ entry, hasToolsPerm, role } = {}) {
  const mode = entry && entry.mode ? String(entry.mode) : MODE_OFF;
  if (hasToolsPerm !== false) return null;
  if (mode !== MODE_ALLOW) return null;
  return `이 계정의 역할(${role || '?'})에 ‘특수 기능’ 권한이 없어, 허용 목록을 고쳐도 **아무 도구도 보이지 않습니다**. 위 ‘기능 권한’ 에서 ‘특수 기능’ 을 먼저 켜세요.`;
}

/**
 * 서버 집행 경고 — **차단하기로 한 도구 중 서버가 막지 못하는 것**을 센다.
 * `allow` 모드에서는 '고르지 않은 전부' 가 차단 대상이므로 그 기준으로 센다.
 * 판정은 `toolEnforcementText.enforcementOf` 하나가 소유한다(여기서 재구현 금지).
 * @param {string[]} allKeys  표에 나오는 도구 키 전체(adminOnly 제외분)
 * @param {(k:string)=>string} levelOf  그 키의 집행 등급(LEVEL_SERVER 이면 서버가 막는다)
 * @returns {{count:number, keys:string[], text:string}|null}
 */
export function enforcementGapNote(entry, allKeys = [], levelOf, { serverLevel = 'server' } = {}) {
  const mode = entry && entry.mode ? String(entry.mode) : MODE_OFF;
  if (mode === MODE_OFF) return null;
  const picked = new Set((entry.tools || []).map(String));
  const blocked = mode === MODE_ALLOW
    ? allKeys.filter((k) => !picked.has(k))
    : allKeys.filter((k) => picked.has(k));
  const gaps = blocked.filter((k) => levelOf(k) !== serverLevel);
  if (!gaps.length) return null;
  return {
    count: gaps.length,
    keys: gaps,
    text: `막기로 한 도구 중 **${gaps.length}개**는 서버가 API 호출까지 막지는 못합니다 — 메뉴에서는 사라지지만 주소를 아는 사용자가 직접 호출하면 열립니다. 어느 것인지는 위 ‘도구별 접근’ 표의 ‘서버 집행’ 열에 있습니다.`,
  };
}

/** 저장 버튼 옆 요약 — 무엇을 저장하게 되는지 미리 말한다(되돌릴 수 없는 착오 방지). */
export function saveSummary(mode, tools = [], totalKeys = 0) {
  const n = (tools || []).length;
  if (mode === MODE_ALLOW) {
    const hidden = Math.max(0, Number(totalKeys) - n);
    return n
      ? `허용 ${n}개 · 숨김 ${hidden}개로 저장합니다.`
      : `특수기능 **전부**를 숨깁니다(허용 0개). 의도한 설정이 맞는지 확인하세요.`;
  }
  if (mode === MODE_DENY) {
    return n ? `이 계정만 추가로 ${n}개를 막습니다.` : '추가 차단할 도구를 고르지 않았습니다 — 저장하면 재정의가 없는 상태(역할 기준)가 됩니다.';
  }
  return '이 계정의 재정의를 지웁니다 — 역할 설정만 적용됩니다.';
}

/** 구획 머리말 — 이 기능의 경계를 한 번만 말한다(행마다 반복하면 화면을 덮는다 — v2.509). */
export const SECTION_NOTE = '역할(operator·viewer) 단위 설정으로 부족할 때 **계정 하나만** 따로 조정합니다. '
  + '‘고른 것만 허용’ 은 역할 거부를 대신하므로, 관리자가 고른 것이 역할 설정 때문에 사라지지 않습니다. '
  + 'admin 계정은 대상이 아닙니다(관리자 잠김 방지).';
