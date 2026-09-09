/**
 * views/idrac/scanRunText.js — '법인별 iDRAC 장비 스캔' 표의 **최근 결과** 문구(순수, v2.441).
 *
 * 사용자 요구: "최근 결과에 몇 개를 발견했다고 발견(xx대) 이렇게 코멘트 넣어줘, 성공/실패도 넣어줘".
 * 예전에는 위임 스캔이면 `위임(AZ) · 시각` 만 보여 주고 수치를 버렸다 — 위임은 던진 시점만
 * 기록되고 결과 회신이 이 엔트리에 반영되지 않았기 때문(v2.441 에서 반영 경로를 추가).
 *
 * 판정·문구를 여기에 모아 회귀로 고정한다(웹 테스트는 node 환경이라 컴포넌트 렌더 불가 — CLAUDE.md 규약).
 */

/** 소요 시간 표기(초/분). null 이면 ''. */
function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n < 60_000 ? `${Math.round(n / 1000)}초` : `${Math.round(n / 60_000)}분`;
}

/**
 * lastRun → 화면 표시용 구조(순수).
 * @returns {{state:'none'|'pending'|'ok'|'fail', badge:string, tone:'muted'|'amber'|'green'|'red',
 *            text:string, title:string, when:string}}
 */
export function describeScanRun(r, now = Date.now()) {
  if (!r) return { state: 'none', badge: '', tone: 'muted', text: '—', title: '아직 실행 기록이 없습니다.', when: '' };
  const when = r.at ? new Date(r.at).toLocaleString('ko-KR') : '';
  const who = r.agent ? `위임(${r.agent})` : '중앙';

  // ① 실패 — 사유를 그대로 보여준다(툴팁에 전문).
  if (r.error) {
    return {
      state: 'fail', badge: '실패', tone: 'red',
      text: `${String(r.error).slice(0, 70)}${String(r.error).length > 70 ? '…' : ''}`,
      title: `${who} · ${r.error}`, when,
    };
  }

  // ② 위임했지만 결과가 아직 안 온 상태(pending) — '성공' 으로 오인하게 두지 않는다.
  //    pending 플래그가 없는 구버전 기록은 found 가 null 인 위임 건을 같게 취급한다.
  const isPending = r.pending === true || (r.delegated && r.found == null && r.ok !== true);
  if (isPending) {
    const waited = r.dispatchedAt ? Math.max(0, Math.round((now - r.dispatchedAt) / 1000)) : null;
    return {
      state: 'pending', badge: '대기', tone: 'amber',
      text: `${who} 요청함 · 결과 대기${waited != null ? ` ${waited >= 60 ? `${Math.round(waited / 60)}분` : `${waited}초`}째` : ''}`,
      title: `${who} 에 스캔을 요청했고 아직 결과가 오지 않았습니다.${r.dispatch === 'push' ? ' (중앙→엣지 직접 PUSH)' : ' (에이전트 폴링)'}`,
      when,
    };
  }

  // ③ 성공 — 사용자 요구 형식: '발견 N대'. 등록/스캔/무응답/인증실패는 뒤에 덧붙인다.
  const found = Number(r.found) || 0;
  const parts = [`발견 ${found}대`];
  if (r.registered != null) parts.push(`등록 ${Number(r.registered) || 0}대`);
  if (r.scanned != null) parts.push(`스캔 ${Number(r.scanned) || 0}개`);
  const extra = [];
  if (r.unreachable) extra.push(`무응답 ${r.unreachable}`);
  if (r.authFailed) extra.push(`인증실패 ${r.authFailed}`);
  const d = dur(r.durationMs);
  return {
    state: 'ok', badge: '성공', tone: found > 0 ? 'green' : 'muted',
    text: `${parts.join(' · ')}${extra.length ? ` (${extra.join(' · ')})` : ''}`,
    title: `${who}${d ? ` · 소요 ${d}` : ''}${extra.length ? ` · ${extra.join(' · ')}` : ''}`,
    when,
  };
}
