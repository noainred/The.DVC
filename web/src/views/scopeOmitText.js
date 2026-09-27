/**
 * 범위(scope) 계정에서 뺀 항목 안내 — iDRAC·서버 분석·전산실 온도 화면 공용(v2.630 UI2630-01 · R2630-05).
 *
 * 서버(v2.629 AUTHZ2629-03, `routes/admin/idracCore.js scopeFields`)는 범위 계정 응답에만
 * `{ scoped: true, omittedOutOfScope: N }` 을 싣는다(전체 범위 계정은 두 필드가 없다). 화면이 이 값을 읽지 않으면
 * 범위 계정은 줄어든 목록을 '전부' 로 읽는다 — 조용한 제외 금지(v2.509·v2.574 '뺀 것은 반드시 밝힌다').
 *
 * - 뺀 것이 없으면(0·없음·범위 계정 아님) null — 문구를 띄우지 않는다.
 * - 숫자가 아닌 값(객체·문자열·음수·소수)은 개수를 지어내지 않고 '일부' 로 말한다(Number('') === 0 함정 회피).
 * - 판정 근거: 범위 밖 vCenter 에 귀속된 서버 + 법인 귀속이 없는 서버(귀속 없는 데이터 미노출 불변조건).
 * @param {object|null|undefined} data 서버 응답
 * @param {string} [unit] 센 단위 이름 — 서버 분석은 '서버', 전산실 온도 월보드 스파크는 '법인 그룹'
 * @param {string} [counter] 개수 단위 — '대'·'곳'·'개'
 * @param {{why?: string}} [opts] 제외 근거 문구(v2.631 A6-2631-06) — 기본은 '내 조회 범위 밖(또는 법인 귀속이 없는)'.
 *   법인 귀속 개념이 없는 자원(예: vCenter 로만 거르는 VM 복제 잡)은 그 자원에 맞는 근거를 준다.
 * @returns {string|null}
 */
export function scopeOmitNote(data, unit = '서버', counter = '대', opts = {}) {
  if (!data || data.scoped !== true) return null;
  const why = typeof opts?.why === 'string' && opts.why.trim() ? opts.why.trim() : '내 조회 범위 밖(또는 법인 귀속이 없는)';
  const o = data.omittedOutOfScope;
  if (o == null || o === '' || o === 0) return null;
  if (typeof o === 'number' && Number.isInteger(o) && o > 0) {
    return `${why} ${unit} ${o}${counter}는 제외했습니다 — 아래 수치는 범위 안의 ${unit}만 셉니다.`;
  }
  if (typeof o === 'number') return null; // 음수·소수·NaN — 뜻이 없는 값은 말하지 않는다
  return `${why} ${unit} 일부는 제외했습니다 — 아래 수치는 범위 안의 ${unit}만 셉니다.`;
}

/**
 * 전산실 온도 월보드 24시간 추이(`/admin/room-temp/spark`) 전용 — 서버는 그룹(법인) 단위로 거른다.
 * 그룹 합계는 그 그룹의 **모든** 서버로 적재된 값이라, 범위 밖(또는 귀속 없는) 서버가 섞인 그룹은 추이를 주지 않는다
 * (`roomTempGroupsAllowed`). 그 타일의 추이가 비는 이유가 '수집이 없어서' 가 아님을 말한다.
 * @returns {string|null}
 */
export function roomSparkScopeNote(sparks) {
  if (!sparks || sparks.scoped !== true) return null;
  const o = sparks.omittedOutOfScope;
  if (!(typeof o === 'number' && Number.isInteger(o) && o > 0)) return null;
  return `범위 밖(또는 법인 귀속이 없는) 서버가 섞인 법인 ${o}곳은 24시간 추이를 보이지 않습니다 — 그 타일의 추이가 비어 있는 것은 수집이 없어서가 아닙니다.`;
}
