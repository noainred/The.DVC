/**
 * 설정 › 연동 키 — **판정·문구 단일 소유자**(v2.562). 순수 모듈(웹 테스트는 node 환경이라
 * 컴포넌트 렌더 테스트가 불가하므로 판정·문구를 여기서 회귀로 고정한다 —
 * `accessDeniedText.js`·`version_4/loadState.js` 와 같은 관례).
 *
 * ⚠ **문구에 백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석하고 백틱은 **글자로 샌다**
 *   (v2.439·2.440·2.505·2.545·2.553 실제 사고). 값 인용은 홑화살괄호 ‘ ’ 로 한다.
 */

/** 키 상태 — 겹치지 않는다. KPI 항등식: 합계 = 사용중 + 폐기 + 만료 + 분류없음. */
export const KEY_STATES = Object.freeze({
  live: { label: '사용중', tone: 'ok' },
  revoked: { label: '폐기', tone: 'muted' },
  expired: { label: '만료', tone: 'bad' },
  'no-groups': { label: '분류 없음', tone: 'warn' },
});

/**
 * 행 상태 판정 — **화면은 이것을 읽기만 한다**(v2.560 규약: 두 곳이 각자 판정하면 KPI 합계와
 * 표의 색이 어긋난다). 판정 순서가 계약이다 — 폐기가 만료를 이긴다(폐기는 되돌릴 수 없다).
 * @param {object} k  서버 `publicKey()` 형태
 * @param {number} [now]
 * @returns {'live'|'revoked'|'expired'|'no-groups'}
 */
export function keyState(k, now = Date.now()) {
  if (!k) return 'no-groups';
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt != null && now > k.expiresAt) return 'expired';
  if (!(k.groups || []).length) return 'no-groups';
  return 'live';
}

/**
 * 만료 예고. ⚠ `null`(무기한)을 '오늘 만료' 로 말하지 않는다 —
 * `Number(null) === 0` 함정의 시각판이다(v2.525·2.550·2.552 규약).
 * @returns {{kind:'none'|'soon'|'past'|'far', days:number|null, text:string}}
 */
export function expiryNote(expiresAt, now = Date.now()) {
  if (expiresAt == null || expiresAt === '') {
    return { kind: 'none', days: null, text: '무기한 — 기한을 두는 것을 권합니다.' };
  }
  const t = Number(expiresAt);
  if (!Number.isFinite(t)) return { kind: 'none', days: null, text: '만료일을 읽지 못했습니다.' };
  const days = Math.floor((t - now) / 86_400_000);
  if (days < 0) return { kind: 'past', days, text: `${-days}일 전에 만료됐습니다 — 이 키로는 조회되지 않습니다.` };
  if (days <= 14) return { kind: 'soon', days, text: `${days}일 남았습니다 — 만료되면 상대 포탈 조회가 멈춥니다.` };
  return { kind: 'far', days, text: `${days}일 남았습니다.` };
}

/**
 * 범위 표기. ⚠ **빈 배열은 '전체'** 다 — 도구 권한의 허용목록(빈 배열 = 전면 차단)과
 * **방향이 반대**이므로 화면이 그 차이를 말한다(v2.555 규약을 여기서 뒤집어 쓰면 거짓이 된다).
 */
export function scopeText(vcenters) {
  const n = (vcenters || []).length;
  if (!n) return '전체 vCenter (범위 제한 없음)';
  return `vCenter ${n}곳으로 제한`;
}

/**
 * 분류를 하나도 고르지 않은 키의 뜻 — **조용히 '전부 허용' 으로 읽지 않는다**(거부 기본값).
 */
export function groupsText(groups, catalog = []) {
  const list = groups || [];
  if (!list.length) return '없음 — 이 키로는 **아무것도 조회할 수 없습니다**(거부 기본값).';
  /*
   * ⚠ **카탈로그에 없는 분류를 라벨인 척 보여주지 말 것**(v2.562 스크린샷 판독에서 발견).
   *   분류를 없앤 릴리스 뒤에는 옛 키가 사라진 분류를 들고 있을 수 있고, 그것은 아무 경로도
   *   열지 않는다(거부 기본값). 코드만 덩그러니 보여주면 사용자는 **아직 유효한 분류**로 읽는다.
   *   지우지는 않는다 — 그 키가 무엇을 들고 있었는지가 진단이다.
   */
  return list.map((k) => {
    const g = catalog.find((x) => x.key === k);
    return g ? g.label : `${k}(무효)`;
  }).join(' · ');
}

/** 키가 들고 있는, 지금은 없는 분류 — 각주에서 한 번만 설명한다(행마다 반복 금지). */
export function staleGroups(keys, catalog = []) {
  const known = new Set((catalog || []).map((g) => g.key));
  const out = new Set();
  for (const k of keys || []) for (const g of (k.groups || [])) if (!known.has(g)) out.add(g);
  return [...out];
}

/**
 * 허용목록 방향 안내 — 이 성질을 화면이 **먼저** 말한다.
 * 도구 권한의 거부목록은 새 항목을 자동 허용하지만, 이쪽은 **자동 차단**이다.
 */
export const DIRECTION_NOTE = '이 키는 **고른 분류만** 조회할 수 있습니다. 앞으로 추가되는 엔드포인트도 '
  + '분류를 켜지 않으면 **자동으로 차단**됩니다(거부 기본값).';

/** 발급 직후 1회 표시 경고 — 이 문구를 지우면 사용자가 값을 잃는다. */
export const ONCE_NOTE = '이 값은 **지금 한 번만** 보입니다 — 서버는 해시만 보관합니다. '
  + '옮겨 적은 뒤 창을 닫으세요. 잃으면 **재발급**해야 합니다(같은 값은 복구할 수 없습니다).';

/** 조회 전용임을 밝힌다 — 상대 포탈이 쓰기를 기대하지 않게. */
export const READONLY_NOTE = '이 API 는 **조회 전용**입니다. 이 키로는 어떤 값도 바꿀 수 없습니다.';

/**
 * 범위 지정 키가 못 쓰는 엔드포인트를 **미리** 말한다.
 * ⚠ 이것을 숨기면 상대 포탈이 403 을 받고 '토큰이 거부됐다' 고 오해한다(v2.553 규약).
 * @returns {{blocked:string[], text:string}|null}
 */
export function fullScopeWarning(vcenters, endpoints = []) {
  if (!(vcenters || []).length) return null;
  const blocked = (endpoints || []).filter((e) => e.requiresFullScope).map((e) => e.path);
  if (!blocked.length) return null;
  return {
    blocked,
    text: `vCenter 범위를 지정하면 **법인 축이 없는 자원**은 조회할 수 없습니다(${blocked.length}개 경로가 403). `
      + '스토리지 장비는 vCenter 귀속이 없어 범위와 교집합할 수 없습니다 — 빈 목록을 주면 '
      + '‘장비 0대’ 라는 거짓이 되므로 거절합니다.',
  };
}

/**
 * KPI — **겹치지 않게** 센다(v2.553 규약). 합계 = 네 칸의 합이어야 한다.
 */
export function kpisOf(keys, now = Date.now()) {
  const out = { total: 0, live: 0, revoked: 0, expired: 0, 'no-groups': 0 };
  for (const k of keys || []) { out.total += 1; out[keyState(k, now)] += 1; }
  return out;
}

/** 합계가 칸의 합과 맞는지 — 화면에서 한 칸을 빼면 합이 어긋난다(v2.553 실제 사고). */
export function kpiIdentityOk(kpi) {
  if (!kpi) return false;
  return kpi.total === kpi.live + kpi.revoked + kpi.expired + kpi['no-groups'];
}

/**
 * 사용 이력 표기. ⚠ **한 번도 안 쓴 키를 '오래 안 씀' 이라 말하지 않는다** — 뜻이 다르다
 * (발급 직후일 수 있다).
 */
export function lastUsedText(lastUsedAt, useCount, now = Date.now()) {
  if (lastUsedAt == null) return { kind: 'never', text: '아직 사용된 적 없습니다.' };
  const t = Number(lastUsedAt);
  if (!Number.isFinite(t)) return { kind: 'unknown', text: '사용 시각을 읽지 못했습니다.' };
  const mins = Math.floor((now - t) / 60_000);
  const n = Number.isFinite(Number(useCount)) ? Number(useCount) : null;
  const cnt = n == null ? '' : ` · 누적 ${n.toLocaleString()}회`;
  if (mins < 1) return { kind: 'recent', text: `방금 전${cnt}` };
  if (mins < 60) return { kind: 'recent', text: `${mins}분 전${cnt}` };
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return { kind: 'recent', text: `${hrs}시간 전${cnt}` };
  return { kind: 'stale', text: `${Math.floor(hrs / 24)}일 전${cnt}` };
}

/**
 * 사용 예시 — 상대 포탈 개발자가 그대로 붙여 쓴다.
 * ⚠ 평문 키를 예시에 넣지 말 것(발급 모달에서만 실제 값을 보여준다).
 */
export function curlExample(baseUrl, apiPath = '/inventory/summary') {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return `curl -H "X-Api-Key: <발급한 키>" ${b}/api/v1${apiPath}`;
}

/** 상한 초과 안내 — 분당 상한은 숫자를 화면에 박지 않고 서버 값을 쓴다(v2.493 규약). */
export function rpmNote(rpm) {
  const n = Number(rpm);
  if (!Number.isFinite(n) || n <= 0) return '분당 상한을 읽지 못했습니다.';
  return `분당 ${n.toLocaleString()}회까지입니다. 넘기면 **429** 와 함께 재시도 시각(Retry-After)을 돌려줍니다.`;
}
