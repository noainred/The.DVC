/**
 * util/dirPathGuard.js — 관리자가 입력하는 '저장 디렉터리 절대경로' 검사(v2.629 AUTHZ2629-02).
 *
 * v2.480(3차 감사 S4)이 vCenter 로그 보관 경로(`/admin/vclogs/settings` storagePath)에만 넣은 검사를
 * 한 벌로 올렸다. 성능점검 로그 경로(`PUT /api/svcmon/log` dirPath)는 이 검사가 없어 절대경로면
 * 무엇이든 `mkdir -p` 후 저장했다(시스템 디렉터리 포함). 두 곳이 같은 함수를 쓴다 — 사본을 만들면
 * 한쪽만 목록이 는다.
 *
 * ⚠ 원문(정규화 전)을 본다 — `path.normalize` 는 `..` 를 풀어 버려 상위 경로 검사를 무력화한다.
 * 빈 값은 '미지정'(기본 위치)이라 여기서 문제로 보지 않는다(호출부가 판단).
 */
export const SYSTEM_DIR_RE = /^\/(etc|proc|sys|dev|boot|root|bin|sbin|usr|lib|lib64|run)(\/|$)/;

/** 문제가 없으면 '', 있으면 사유 문자열. */
export function dirPathIssue(raw) {
  if (typeof raw !== 'string') return '';
  const sp = raw.trim();
  if (!sp) return '';
  if ([...sp].some((c) => c.charCodeAt(0) < 32)) return '제어문자';
  if (!sp.startsWith('/')) return '절대경로여야 합니다';
  if (sp.split(/[\\/]+/).includes('..')) return '상위 경로(..) 불가';
  if (SYSTEM_DIR_RE.test(sp.replace(/\/{2,}/g, '/'))) return '시스템 디렉터리 불가';
  return '';
}
