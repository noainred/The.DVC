/**
 * v2.633 — 서비스 점검 '중앙 설정 파일' 행의 [기본값으로 확정] 문구(순수 — 판정·문구만, 테스트가 고정한다).
 *
 * 왜 버튼인가: 손상 보존본(.corrupt.*)만 남은 설정 파일은 설정 pull 이 503 으로 답해 엣지가 직전 설정을 유지한다(v2.631).
 *   보존본의 나이로 자동 해제하면 그 순간 기본값(대개 '꺼짐')이 전 엣지에 배포되어 v2.631 사고를 시간차로 되살린다 —
 *   그래서 **사람이 '이 기본값을 배포해도 된다' 고 확인할 때만** 푼다. 확인 문구는 그 결과를 줄이지 않고 말한다.
 */

/** 확인 창 문구 — 무엇이 배포되는지와 보존본이 남는다는 사실을 함께 말한다. */
export function confirmPrompt(f) {
  const name = f?.label ? `${f.label}(${f.file})` : String(f?.file || '');
  return `${name} 을(를) 지금 적용 중인 기본값으로 확정합니다.\n\n`
    + '이 기본값이 전 엣지에 배포됩니다(대개 해당 기능 꺼짐 · 엣지가 가진 직전 설정을 덮습니다).\n'
    + '손상 보존본(.corrupt.*)은 지우지 않습니다 — 복구가 필요하면 그 파일에서 값을 옮겨 다시 저장하세요.\n\n'
    + '계속할까요?';
}

const FAIL_TEXT = {
  'unknown-file': '이 서버가 모르는 설정 파일입니다(목록이 바뀌었을 수 있습니다 — 새로고침 후 다시 보세요).',
  'not-in-error': '이미 정상입니다 — 그 사이 누군가 저장했거나 파일이 복구됐습니다.',
  'not-confirmable': '이 설정은 여기서 확정할 수 없습니다 — 그 설정 화면에서 저장하세요.',
  'confirm-failed': '저장에 실패했습니다',
  'still-error': '저장했지만 여전히 읽지 못합니다 — 설정 디렉터리 권한·디스크 상태를 확인하세요.',
};

/** 결과 문구. r 은 서버 응답(성공·실패 모두) 또는 오류 메시지. */
export function resultText(r) {
  if (r && r.ok) return `확정했습니다 — ${r.label || r.file}. 다음 설정 pull 부터 이 기본값이 엣지에 배포됩니다.`;
  const base = FAIL_TEXT[r?.code] || '확정하지 못했습니다';
  return r?.detail ? `${base}: ${r.detail}` : base;
}

/** 버튼을 보일지 — 관리자이고 서버가 확정 가능하다고 한 파일만. 범위 제한 계정은 서버가 403 으로 거절한다. */
export function canConfirm(f, isAdmin) {
  return !!(isAdmin && f && f.confirmable && f.file);
}
