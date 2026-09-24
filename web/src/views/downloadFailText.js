/**
 * 파일 내려받기 실패 문구(v2.602 감사 WEB2602-01, 순수 — vitest 가 고정).
 *
 * 예전에는 다운로드 버튼 8곳이 `fetch → res.blob() → a.download` 로 **응답 코드를 보지 않아**, 서버가 409
 * (`export_busy` — 다른 내보내기 진행 중)·403(권한)·500 을 주면 **오류 JSON 을 .xlsx/.csv 파일로 저장**했다.
 * 사용자는 '파일이 받아졌다' 고 보고 열어 본 뒤에야 깨진 파일임을 안다(화면은 아무 말도 하지 않았다).
 * 이제 다운로드는 `api.js downloadFile`(res.ok 확인 + HttpError)을 거치고, 실패는 이 문구로 **화면에** 말한다.
 * ⚠ '파일은 저장하지 않았습니다' 를 지우지 말 것 — 예전 동작(깨진 파일 저장)과 구분되는 사실이다.
 */
export function downloadFailText(e) {
  const status = Number(e?.status) || 0;
  const reason = String(e?.serverReason || e?.message || '').trim();
  const tail = ' 파일은 저장하지 않았습니다.';
  if (status === 409) {
    return `내려받지 못했습니다 — ${reason || '다른 내보내기가 진행 중입니다. 끝난 뒤 다시 시도하세요.'}${tail}`;
  }
  if (status === 403) {
    const role = Array.isArray(e?.requiredRole) && e.requiredRole.length ? ` (필요 역할: ${e.requiredRole.join('/')})` : '';
    const perm = Array.isArray(e?.requiredPerm) && e.requiredPerm.length ? ` (필요 권한: ${e.requiredPerm.join('/')})` : '';
    return `내려받지 못했습니다 — 이 계정에는 권한이 없습니다${role}${perm}.${tail}`;
  }
  const code = status ? ` (HTTP ${status})` : '';
  return `내려받지 못했습니다${code} — ${reason || '알 수 없는 오류'}.${tail}`;
}
