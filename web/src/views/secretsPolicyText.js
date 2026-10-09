/**
 * 자격증명 저장 방식 화면의 정책 상태 문구(S-07, 2026-10-09) — 순수 모듈(node 환경 vitest 로 고정).
 * 서버 loadSecretsPolicy() 가 정책 파일을 못 읽으면 `recovered`(직전 정책·신뢰 사본으로 계속) 또는 `locked`(새 비밀 저장 거부)를 싣는다.
 */
const PROBLEM = { missing: '없습니다', unreadable: '읽을 수 없습니다', corrupt: '손상됐습니다', invalid: '내용이 올바르지 않습니다' };
/** S-07 — 정책 파일을 못 읽어 복구값으로 쓰는 중이거나 잠긴 상태를 말한다(정상이면 null). */
export function policyStateText(p) {
  if (!p) return null;
  const why = `정책 파일(secrets-policy.json)이 ${PROBLEM[p.problem] || '정상이 아닙니다'}`;
  if (p.locked) return `${why}. 신뢰 사본도 없고 암호화를 쓴 흔적이 있어, 평문으로 저장하지 않도록 새 비밀번호·토큰 저장을 막고 있습니다(이미 봉인된 값은 그대로 유지). 아래에서 방식을 직접 골라 저장하거나 손상 보존본(secrets-policy.json.corrupt.*)을 되돌리세요.`;
  if (p.recovered) return `${why}. ${p.recovered === 'last-good' ? '직전 유효 정책' : '신뢰 사본(secrets-policy.trusted.json)'}으로 계속 ${p.mode === 'encrypted' ? '암호화' : '평문'} 저장 중입니다. 아래에서 다시 저장하면 정책 파일이 복구됩니다.`;
  return null;
}
