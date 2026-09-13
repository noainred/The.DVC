/**
 * routes/admin/securityCheck.js — 설정 › 보안 자가진단 API(v2.500).
 *
 * 2026-09-13 전수 감사에서 드러난 문제: 기존 '프로그램 보안·완성도 점검' 화면은 2026-08-08 외부
 * 점검 결과를 **상수로 굳혀 둔 과거 스냅샷**인데도 화면에는 현재 상태처럼 보였다(테스트 결과까지
 * "543 pass / 4 fail" 로 남아 있었다 — 실제는 1,720 pass / 0 fail). 그래서 지금 이 서버의 상태를
 * 매번 조회해 보여주는 화면을 따로 둔다.
 *
 * 권한: adminOnly. 담는 내용은 정책 값·파일 권한·완화 스위치 on/off·계정 통계이며 **비밀 값과
 * 계정명은 싣지 않는다**(계정 열거 단서 금지 규약). 파일 내용을 읽지 않고 stat 만 본다.
 */
import { collectSelfCheck } from '../../security/selfCheck.js';
import { listUsers } from '../../auth/auth.js';
import { currentVersion } from '../../config.js';
import { adminOnly } from './shared.js';

export function registerSecurityCheck(adminRouter) {
  adminRouter.get('/security/self-check', adminOnly, (_req, res) => {
    let users = null;
    try { users = listUsers(); } catch { users = null; }   // 조회 실패는 unknown 으로 내려간다(추정 금지)
    const { checks, summary } = collectSelfCheck({ users });
    res.json({
      ok: true,
      // 점검 시각은 **조회 시각**이다 — 과거 스냅샷을 오늘 날짜로 보여주던 문제의 반대 규약.
      checkedAt: new Date().toISOString(),
      version: currentVersion(),
      summary,
      checks,
      // 이 화면이 무엇을 보는지 명시 — '전수 침투테스트' 로 오해하지 않게.
      scope: '이 서버의 설정 값·파일 권한·환경변수만 확인합니다. 코드 취약점 점검이나 침투테스트가 아닙니다.',
    });
  });
}
