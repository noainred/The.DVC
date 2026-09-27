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
/**
 * v2.630 R2630-04: Windows 패키지(엣지)도 같은 서버를 돌린다 — 드라이브 절대경로(`D:\logs`·`D:/logs`)를 받는다.
 * 예전엔 '/' 시작만 절대경로로 봐서 svcmon 로그 설정에 이미 저장된 Windows 경로가 있으면 다른 칸만 고쳐도 저장이 400 이었다.
 * 드라이브 경로는 **Windows 에서 돌 때만** 절대경로다 — 리눅스에서 `D:\x` 를 받으면 fs 가 현재 디렉터리 아래 상대경로로 만든다.
 * Windows 시스템 디렉터리(Windows·Program Files·Program Files (x86))는 거부한다. UNC(`\\서버\공유`)·장치 경로(`\\?\`)는 받지 않는다.
 */
export const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
/** v2.631: 정규화한 첫 세그먼트로 비교하는 Windows 시스템 디렉터리 이름(WIN_SYSTEM_DIR_RE 와 같은 목록). */
export const WIN_SYSTEM_NAMES = new Set(['windows', 'program files', 'program files (x86)']);
export const WIN_SYSTEM_DIR_RE = /^[A-Za-z]:[\\/]+(windows|program files|program files \(x86\))([\\/]|$)/i;

/** 이름 끝의 점·공백을 뗀다(선형 — 정규식 `[. ]+$` 는 긴 점 열에서 O(n²)). */
function trimDotsSpaces(v) {
  let e = v.length;
  while (e > 0 && (v[e - 1] === '.' || v[e - 1] === ' ')) e--;
  return v.slice(0, e);
}

/** 문제가 없으면 '', 있으면 사유 문자열. platform 은 테스트용(기본 process.platform). */
export function dirPathIssue(raw, { platform = process.platform } = {}) {
  if (typeof raw !== 'string') return '';
  const sp = raw.trim();
  if (!sp) return '';
  if ([...sp].some((c) => c.charCodeAt(0) < 32)) return '제어문자';
  const onWin = platform === 'win32';
  const win = onWin && WIN_ABS_RE.test(sp);
  if (!sp.startsWith('/') && !win) return '절대경로여야 합니다';
  if (sp.split(/[\\/]+/).includes('..')) return '상위 경로(..) 불가';
  // v2.631(감사 R2631-05): '.' 세그먼트·중복 구분자를 정규화한 뒤 판정한다 — 'C:\\.\\Windows'·'/./etc' 가 목록을 비켜 갔다.
  //   ('..' 는 위에서 이미 거부했으므로 정규화가 상위 경로를 풀지 않는다.)
  if (onWin) {
    // Windows 에서는 '/' 로 시작하는 경로도 **현재 드라이브의 루트**다('/Windows/System32' = C:\\Windows\\System32) — Windows 목록으로 본다.
    //   Windows 는 이름 끝의 점·공백을 무시하므로('Windows.' = Windows) 그것도 떼고 비교한다.
    const segs = sp.split(/[\\/]+/).filter((x) => x && x !== '.');
    const top = (win ? segs[1] : segs[0]) || '';
    if (WIN_SYSTEM_NAMES.has(trimDotsSpaces(top).toLowerCase())) return '시스템 디렉터리 불가';
    if (win) return '';
  }
  const norm = `/${sp.split('/').filter((x) => x && x !== '.').join('/')}`;
  if (SYSTEM_DIR_RE.test(norm)) return '시스템 디렉터리 불가';
  return '';
}
