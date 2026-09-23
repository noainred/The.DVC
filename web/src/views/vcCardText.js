/**
 * vcCardText.js — vCenter 카드 본문 판정(v2.583 감사 #39, 순수).
 *
 * 예전 카드는 `status !== 'connected'` 이면 전부 "이 vCenter에 연결할 수 없습니다" 였다. 그런데 상태는 넷이고 조치가
 * 다르다(v2.509 '수집 대기로 뭉개지 말 것 — pending 과 unreachable 을 합치지 말 것'):
 *  · pending     — 첫 수집 전·중(기다리면 채워진다). 위임 vCenter 는 엣지가 아직 인벤토리를 보내지 않은 것(note).
 *  · maintenance — 관리자가 점검 모드로 둔 것. **수집한 인벤토리가 있다** — 숨기지 않고 배너와 함께 보여 준다.
 *  · disabled    — 설정에서 수집을 꺼 둔 것.
 *  · 그 밖       — 연결 실패(오류·힌트를 함께).
 * 배지(StateBadge)가 '대기'·'점검중'·'비활성' 이라고 말하는데 본문이 '연결 불가' 라고 말하면 둘이 서로 모순된다.
 */
import { authStopInfo } from './tools/storageAuthText.js';

export function vcCardState(s = {}, now = Date.now()) {
  const st = String(s?.status || '');
  // v2.590(감사 F1): 인증 실패로 **주기 수집을 멈춘** vCenter 는 '연결할 수 없습니다' 가 아니라 '멈췄다' 를 말한다 —
  // 조치(비밀번호 수정)와 이유(계정 잠금 방지)가 다르다. 조용히 멈추면 사용자는 수집이 되는 줄 안다(authGuard 규칙 1).
  // 이월된 마지막 값(stale)이 있으면 지표는 보여 주되 '낡은 값' 임을 같은 문장이 말한다.
  if (s?.authStopped && st !== 'connected') {
    const info = authStopInfo(s.authStopped, { what: '이 vCenter', manual: '설정 › vCenter 의 연결 테스트', now });
    const hasMetricsNow = Number(s?.metrics?.hosts) > 0 || Number(s?.metrics?.vms) > 0;
    return {
      showMetrics: hasMetricsNow, tone: 'bad', bold: true, authStopped: true,
      text: `${info.text}${hasMetricsNow ? ' 아래 값은 정지 전 마지막으로 수집한 인벤토리입니다.' : ''}`,
      showError: true,
    };
  }
  const m = s?.metrics || {};
  const hasMetrics = Number(m.hosts) > 0 || Number(m.vms) > 0;
  if (st === 'connected') return { showMetrics: true, tone: 'ok', text: '' };
  if (st === 'maintenance') {
    return { showMetrics: hasMetrics, tone: 'warn', text: hasMetrics ? '점검 모드(관리자 지정) — 아래 값은 마지막으로 수집한 인벤토리입니다.' : '점검 모드(관리자 지정) — 수집한 인벤토리가 없습니다.' };
  }
  if (st === 'pending') {
    const note = String(s?.note || '').trim();
    return { showMetrics: false, tone: 'wait', text: note ? `수집 대기 — ${note}. 담당 엣지가 인벤토리를 보내면 채워집니다.` : '첫 수집 중입니다 — 잠시 기다리면 채워집니다.' };
  }
  if (st === 'disabled') return { showMetrics: false, tone: 'off', text: '수집이 꺼져 있습니다(설정 › vCenter 에서 켤 수 있습니다).' };
  return { showMetrics: false, tone: 'bad', text: '이 vCenter에 연결할 수 없습니다.', showError: true };
}
