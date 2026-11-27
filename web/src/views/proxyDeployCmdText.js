/**
 * 보안 잔여 11-27 M1 — 중계 서버 SSH 자동 배포의 검증 · 재적재 명령 칸 표시(순수 모듈 — 화면 · 시험이 같이 쓴다).
 *
 * 문법 판정은 서버 하나다(server/src/proxy/registry.js resolveDeployCmd). 이 파일은 문법 · 상한을 **복제하지 않는다** —
 *   서버가 GET /remote/config · /remote/proxies/full 의 deployCommands.<종류> = { value, stored, source, issue, help } 로 실어 준 것을 글로 바꿀 뿐이다.
 *   옛 서버(deployCommands 없음)면 아무것도 보이지 않는다(null).
 * docs/COMMON.md 확인: 결과 문구 헬퍼(changeResult.js)는 '응답이 실패인가' 판정이고, 배포 결과 목록(results[])을 잇는 헬퍼는 없어 여기에 둔다.
 */

const q = (s) => `‘${String(s)}’`;

/** 칸 아래 안내 줄 — null(옛 서버) | { tone: 'error'|'info'|'muted', text }. */
export function deployCmdNote(view) {
  if (!view || typeof view !== 'object') return null;
  if (view.issue) return { tone: 'error', text: `저장된 값이 허용 형식 밖이라 배포 · 시험 · 상태 확인이 중계 서버에 접속하기 전에 거절됩니다 — ${view.issue} 고치거나 칸을 비워 기본값을 쓰세요.` };
  if (view.source === 'env') {
    return view.stored
      ? { tone: 'info', text: `저장된 값이 호스트 운영자 값(portal.env)과 같아 그대로 씁니다: ${q(view.value)}` }
      : { tone: 'info', text: `비어 있어 호스트 운영자 값(portal.env)을 씁니다: ${q(view.value)}` };
  }
  if (view.source === 'builtin') return { tone: 'muted', text: `비어 있어 기본값 ${q(view.value)} 을 씁니다.` };
  if (view.source === 'saved' && view.value) return { tone: 'muted', text: `실행할 명령: ${q(view.value)}` };
  return null;
}

/** 입력 칸 placeholder — 빈 칸일 때 실제로 쓰이는 기본(운영자 값 또는 내장 기본). 서버가 알려 주지 않으면 ''. */
export function deployCmdPlaceholder(view) {
  if (!view || typeof view !== 'object') return '';
  if ((view.source === 'env' || view.source === 'builtin') && typeof view.value === 'string') return view.value;
  return '';
}

/** 형식 안내(서버 문구 그대로) — 없으면 ''. */
export function deployCmdHelp(view) {
  return view && typeof view.help === 'string' ? view.help : '';
}

/**
 * POST /remote/deploy 응답 → 화면 문구. 응답은 { ok, results: [{ proxy, ok, reason, deployed }] } 이고 최상위 reason 이 없다 —
 *   예전 화면은 r.reason 을 그대로 보여 '배포 실패: undefined' 였다. 실패한 중계 서버를 ‘이름’: 사유 로 잇는다.
 */
export function deployResultText(r) {
  if (!r || typeof r !== 'object') return { ok: false, text: '배포 실패: 응답이 없습니다.' };
  const results = Array.isArray(r.results) ? r.results : [];
  const fails = results.filter((x) => x && x.ok !== true);
  if (r.ok === true && fails.length === 0) {
    if (!results.length) return { ok: true, text: 'SSH 자동 배포를 켠 중계 서버가 없어 배포하지 않았습니다.' };
    return { ok: true, text: `배포 완료(reload) — 중계 서버 ${results.length}곳.` };
  }
  if (fails.length) {
    const parts = fails.map((x) => `${q(x.proxy || '이름 없음')}: ${x.reason || '사유 미상'}`);
    return { ok: false, text: `배포 실패 ${fails.length}곳 / ${results.length}곳 — ${parts.join(' · ')}` };
  }
  return { ok: false, text: `배포 실패: ${r.reason || r.error || '사유 미상'}` };
}

/** 매핑 상태 배지 글 — 서버 상태 코드는 그대로 두고 사람이 읽을 이름만. */
export const MAPPING_STATUS_LABEL = Object.freeze({ 'teardown-pending': '철거 보류' });
export const MAPPING_TEARDOWN_TITLE = '삭제했지만 중계 서버의 자동 배포 설정(명령 · 설정 파일 경로) 문제로 HAProxy 포트를 아직 닫지 못했습니다 — 관리자가 설정 › 중계 서버에서 고치면 자동으로 정리됩니다.';
