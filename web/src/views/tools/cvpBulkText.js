/**
 * views/tools/cvpBulkText.js — CVP 서버 대량 등록·내보내기 화면의 **경로·문구**(순수, v2.641).
 *
 * 사용자 요청: "CVP 를 CSV import/export 하는 기능 추가해줘 CVP 가 많아" → "비밀번호도 export 에 추가해줘" → "토큰도 포함".
 *
 * 경로는 서버 `routes/api/cvpBulk.js` 와 1:1 이다. `/tools/cvp/servers/:id/test` 와 겹치지 않게 `/tools/cvp/bulk/servers/…`
 * 를 쓴다(서버 머리말 참조). 공용 모달(BulkDeviceIo)에는 base 와 resource 를 따로 넘긴다.
 *
 * 문구 규칙: `**강조**` 만 쓰고(BoldText 로 그린다) 백틱은 쓰지 않는다(글자로 샌다 — uiText.test.js). 값 인용은 ‘ ’.
 */

export const CVP_BULK_BASE = '/tools/cvp/bulk';
export const CVP_BULK_RESOURCE = 'servers';

/** 내보내기 경로 — 비밀 포함은 서버가 설정 소유자 게이트 + 감사로그를 건다. */
export function cvpExportUrl({ secrets = false } = {}) {
  return `${CVP_BULK_BASE}/${CVP_BULK_RESOURCE}/export.csv${secrets ? '?secrets=1' : ''}`;
}

/** 비밀 포함 내보내기 경고 — 버튼 옆에 **항상** 보인다(누른 뒤에 알리면 늦다). */
export const SECRET_EXPORT_WARNING =
  '**비밀번호·토큰 포함 내보내기**는 CVP 접속 비밀번호와 서비스 계정 토큰을 **평문**으로 파일에 담습니다. '
  + '설정 소유 계정만 받을 수 있고 감사 로그에 남습니다(값은 남기지 않습니다). 받은 파일은 공유 폴더·메일에 두지 말고 사용 뒤 지우세요.';

/** 일반 내보내기 안내 — 비밀 칸은 비어 있고, 다시 가져올 때 빈 비밀 칸은 저장값 유지다. */
export const PLAIN_EXPORT_NOTE =
  '일반 내보내기는 비밀번호·토큰 칸을 **비워서** 내보냅니다. 그대로 고쳐 다시 가져오면 빈 칸은 저장된 값을 유지합니다 — '
  + '단 host·계정·인증 방식을 바꾼 행은 비밀을 다시 적어야 합니다(보안 규칙).';

/** 대량 등록 안내 — 식별 규칙(id 또는 주소+담당 엣지)을 한 줄로. */
export const IMPORT_NOTE =
  '**id** 가 있으면 그 서버를 수정하고, 비우면 **주소+담당 엣지**가 같은 서버를 찾아 수정하며 없으면 새로 등록합니다. '
  + '파일에 없는 열은 저장값을 유지합니다. 엣지가 수집하는 CVP 는 중앙에서 연결 테스트를 하지 않습니다(테스트 불가로 표시 — 실패가 아닙니다).';

/** 다운로드 오류 → 화면 문구. 403 은 소유자 게이트일 수 있다(권한 안내를 따로 한다). */
export function exportErrorText(e, { secrets = false } = {}) {
  const status = e && typeof e === 'object' ? e.status : null;
  if (status === 403 && secrets) return '비밀번호·토큰 포함 내보내기는 **설정 소유 계정**만 받을 수 있습니다 — 설정 › 세션 보안의 설정 소유 계정 목록을 확인하세요.';
  if (status === 403) return '이 계정에는 CVP 등록 내보내기 권한이 없습니다(관리자 · 전체 범위 계정만).';
  const msg = e && typeof e === 'object' ? (e.message || '') : String(e || '');
  return `내보내기 실패: ${msg || '알 수 없는 오류'}`;
}
