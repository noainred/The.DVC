/**
 * 중계 토폴로지 저장 요청 조립 + 버린 행 문구(순수 — vitest 고정, v2.606 감사 WEB2606-10).
 *
 * 포트 칸은 원문 문자열 상태로 두고 보낼 때 blankOr 로 바꾼다 — 빈 칸은 보내지 않는다(undefined). 예전에는
 * `Number('')` 가 0 이 되어 ① 서비스 행은 서버 정규화가 **말없이 삭제**했고 ② Main·노드 SSH 포트는 기본값(4000·22)
 * 으로 되돌아갔는데 화면은 `|| 4000`·`|| 22` 로 그 값을 먼저 보여 줬다. 서버는 이제 빈 Main·SSH 포트를 이전 값으로
 * 잇고, 버린 서비스 행은 servicesDropped 로 돌려준다.
 */
import { blankOr } from '../blankOr.js';

const sshOut = (ssh) => (ssh && typeof ssh === 'object' ? { ...ssh, port: blankOr(ssh.port) } : ssh);
const nodeOut = (n) => (n && typeof n === 'object' ? { ...n, ssh: sshOut(n.ssh) } : n);

export function topologyPayload(form) {
  const f = form || {};
  return {
    ...f,
    main: f.main ? { ...f.main, portalPort: blankOr(f.main.portalPort), ssh: sshOut(f.main.ssh) } : f.main,
    services: (f.services || []).map((s) => ({ ...s, listenPort: blankOr(s.listenPort), targetPort: blankOr(s.targetPort) })),
    sites: (f.sites || []).map((s) => ({ ...s, edge: nodeOut(s.edge), irs: nodeOut(s.irs) })),
  };
}

const REASON = {
  'listen-port': '수신 포트가 비었거나 1~65535 가 아님',
  'target-port': '대상 포트가 비었거나 1~65535 가 아님',
  key: '키가 비었거나 형식이 맞지 않음',
  'duplicate-port': '수신 포트 중복',
  limit: '서비스 상한(32개) 초과',
};

/** 저장 응답 → 버린 서비스 행 안내('' 이면 말할 것이 없다). */
export function servicesDroppedText(r) {
  const list = Array.isArray(r?.servicesDropped) ? r.servicesDropped : [];
  if (!list.length) return '';
  const items = list.slice(0, 8).map((d) => `${d.label || d.key || '(이름 없음)'}(${REASON[d.reason] || d.reason})`);
  const more = list.length > 8 ? ` 외 ${list.length - 8}개` : '';
  const reset = r?.servicesReset ? ' — 남은 서비스가 없어 기본 서비스 목록으로 되돌렸습니다' : '';
  return `저장하지 않은 서비스 ${list.length}개: ${items.join(', ')}${more}${reset}.`;
}
