/**
 * corpSiteStatus.js — 법인별 서버 표의 vCenter 상태 표지(v2.631 감사 WEB2631-03, 순수).
 *
 * 서버 롤업은 호스트가 없는 vCenter 를 hosts:0·vms:0 으로 준다 — 측정 불가와 '0대' 가 구분되지 않는다. 첫 수집 중·연결 실패·
 * 비활성 vCenter 를 '호스트 0 · VM 0' 으로 그리면 '서버가 없다' 는 거짓이 된다. 그런 행은 호스트·VM·서버 합계를 null('—')로 두고
 * 짧은 표지를 단다. 개발 포탈 개요와 V6 서버 메뉴가 이 함수 하나를 쓴다(판정은 vcCardText.vcCardState 와 같은 방향).
 *
 * 세는 것: connected · 상태 없음(구버전·목) · maintenance(마지막 인벤토리 — 표지 '점검중') ·
 *          unreachable 이지만 마지막 정상 값을 이월 중(stale — 표지 '낡은 값').
 * 세지 않는 것: pending(첫 수집 중) · disabled(비활성) · 인증 정지 · 그 밖의 연결 실패.
 */
export function corpSiteStatus(s) {
  const st = String(s?.status || '');
  const m = s?.metrics || {};
  const hasMetrics = Number(m.hosts) > 0 || Number(m.vms) > 0;
  if (!st || st === 'connected' || st === 'ok') return { countable: true, mark: null, title: null };
  if (st === 'maintenance') return { countable: true, mark: '점검중', title: '점검 모드(관리자 지정) — 마지막으로 수집한 인벤토리입니다' };
  if (st === 'pending') return { countable: false, mark: '첫 수집 중', title: '아직 인벤토리를 받지 못했습니다 — 기다리면 채워집니다(0대가 아닙니다)' };
  if (st === 'disabled') return { countable: false, mark: '비활성', title: '수집이 꺼져 있습니다 — 호스트·VM 수를 모릅니다(0대가 아닙니다)' };
  if (s?.authStopped) {
    return hasMetrics
      ? { countable: true, mark: '인증 정지', title: '인증 실패로 주기 수집을 멈췄습니다 — 정지 전 마지막 값입니다' }
      : { countable: false, mark: '인증 정지', title: '인증 실패로 주기 수집을 멈췄습니다 — 호스트·VM 수를 모릅니다' };
  }
  if (st === 'unreachable' && s?.stale && hasMetrics) return { countable: true, mark: '낡은 값', title: '연결 실패 — 마지막 정상 수집 값입니다' };
  return { countable: false, mark: '연결 실패', title: '이 vCenter 에 연결할 수 없습니다 — 호스트·VM 수를 모릅니다(0대가 아닙니다)' };
}

/** 합계 행의 부분 합 표기 — 세지 못한 행이 있으면 개수를 밝힌다(조용한 제외 금지). */
export function corpTotalLabel(rows) {
  const miss = (Array.isArray(rows) ? rows : []).filter((r) => r && r.countable === false).length;
  return miss > 0 ? `합계(최소 · 미수집 ${miss}곳 제외)` : '합계';
}
