/**
 * corpSiteStatus.js — 법인별 서버 표의 vCenter 상태 표지(v2.631 감사 WEB2631-03, 순수).
 *
 * 서버 롤업은 호스트가 없는 vCenter 를 hosts:0·vms:0 으로 준다 — 측정 불가와 '0대' 가 구분되지 않는다. 첫 수집 중·연결 실패·
 * 비활성 vCenter 를 '호스트 0 · VM 0' 으로 그리면 '서버가 없다' 는 거짓이 된다. 그런 행은 호스트·VM·서버 합계를 null('—')로 두고
 * 짧은 표지를 단다. 개요(엔지니어·경영 보기)·Platform 이 이 함수 하나를 쓴다(판정은 vcCardText.vcCardState 와 같은 방향).
 *
 * 세는 것: connected · 상태 없음(구버전·목) · maintenance(마지막 인벤토리 — 표지 '점검중') ·
 *          unreachable 이지만 마지막 정상 값을 이월 중(stale — 표지 '낡은 값') ·
 *          v2.732(B2-01): 담당 엣지의 push 가 기준 시간을 넘긴 위임 vCenter(status 는 엣지가 마지막으로 보낸 connected 그대로 —
 *          stale — 표지 '낡은 값' + 마지막 수신 시각). 낡은 행은 `stale:true` 를 함께 돌려 호출부가 정상 초록으로 칠하지 않게 한다.
 * 세지 않는 것: pending(첫 수집 중) · disabled(비활성) · 인증 정지 · 그 밖의 연결 실패.
 * ⚠ title 은 화면의 title 속성(일반 글자)이라 `**강조**` 를 쓰지 않는다.
 */
import { staleSinceText } from './vcCardText.js';

export function corpSiteStatus(s, now = Date.now()) {
  const st = String(s?.status || '');
  const m = s?.metrics || {};
  const hasMetrics = Number(m.hosts) > 0 || Number(m.vms) > 0;
  if (!st || st === 'connected' || st === 'ok') {
    if (s?.stale === true) {
      const since = staleSinceText(s, now);
      return {
        countable: true, mark: '낡은 값', stale: true,
        title: `${since ? `담당 엣지의 마지막 수신 ${since}` : '마지막 수신 시각을 모릅니다'} — 그 뒤 인벤토리를 받지 못했습니다(지금 값이 아닙니다)`,
      };
    }
    return { countable: true, mark: null, title: null };
  }
  if (st === 'maintenance') return { countable: true, mark: '점검중', title: '점검 모드(관리자 지정) — 마지막으로 수집한 인벤토리입니다' };
  if (st === 'pending') return { countable: false, mark: '첫 수집 중', title: '아직 인벤토리를 받지 못했습니다 — 기다리면 채워집니다(0대가 아닙니다)' };
  if (st === 'disabled') return { countable: false, mark: '비활성', title: '수집이 꺼져 있습니다 — 호스트·VM 수를 모릅니다(0대가 아닙니다)' };
  if (s?.authStopped) {
    return hasMetrics
      ? { countable: true, mark: '인증 정지', title: '인증 실패로 주기 수집을 멈췄습니다 — 정지 전 마지막 값입니다' }
      : { countable: false, mark: '인증 정지', title: '인증 실패로 주기 수집을 멈췄습니다 — 호스트·VM 수를 모릅니다' };
  }
  if (st === 'unreachable' && s?.stale && hasMetrics) {
    const since = staleSinceText(s, now);
    return { countable: true, mark: '낡은 값', stale: true, title: `연결 실패 — 마지막 정상 수집${since ? `(${since})` : ''} 값입니다` };
  }
  return { countable: false, mark: '연결 실패', title: '이 vCenter 에 연결할 수 없습니다 — 호스트·VM 수를 모릅니다(0대가 아닙니다)' };
}

/** 부분 합 표지 — 세지 못한 개수가 있으면 '최소 · 미수집 N곳 제외', 없으면 null. */
export function partialNote(missing) {
  const n = Number(missing) || 0;
  return n > 0 ? `최소 · 미수집 ${n}곳 제외` : null;
}

/** 부분 합 표지의 title — 왜 빠졌는지(0 으로 더하지 않았다)를 말한다. title 속성이라 `**` 를 쓰지 않는다. */
export const PARTIAL_TITLE = '첫 수집 중·비활성·연결 실패 vCenter 는 호스트·VM 수를 모릅니다 — 0 으로 더하지 않고 합계에서 뺐습니다';

/**
 * v2.741(WEB-01): Platform '전체 호스트·전체 VM' KPI 의 합계 — 셀 수 있는 vCenter(corpSiteStatus().countable)만 더한다.
 * 롤업은 첫 수집 중·비활성·이월 값 없는 연결 실패 vCenter 에 hosts:0·vms:0 을 주므로 그대로 더하면 부분 합을 합계처럼 보인다.
 * 하나도 셀 수 없으면(전부 미수집) 값은 null('—') — 0 은 '없다' 는 거짓이다. 등록 0개면 0 그대로다(셀 것이 없는 것이다).
 * `isIrs` 는 화면의 다빈치/IRS 분류 규칙(이름 판정)을 그대로 받는다 — 규칙을 여기에 복제하지 않는다.
 */
export function countableTotals(sites, { isIrs = () => false, now = Date.now() } = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const t = { hosts: 0, vms: 0, irsHosts: 0, irsVms: 0, counted: 0, missing: 0 };
  for (const s of list) {
    if (!s || !corpSiteStatus(s, now).countable) { t.missing += 1; continue; }
    const h = Number(s.metrics?.hosts) || 0;
    const v = Number(s.metrics?.vms) || 0;
    t.counted += 1; t.hosts += h; t.vms += v;
    if (isIrs(s)) { t.irsHosts += h; t.irsVms += v; }
  }
  const none = t.counted === 0 && t.missing > 0;
  return {
    hosts: none ? null : t.hosts,
    vms: none ? null : t.vms,
    irsHosts: none ? null : t.irsHosts,
    irsVms: none ? null : t.irsVms,
    davinciHosts: none ? null : t.hosts - t.irsHosts,
    davinciVms: none ? null : t.vms - t.irsVms,
    counted: t.counted,
    missing: t.missing,
    note: partialNote(t.missing),
  };
}

/**
 * v2.741(WEB-01): 개요 '법인별 VM 분포' 막대·'리전별 워크로드 비중' 파이의 값 — 셀 수 없는 vCenter 는 null 이다
 * (막대 없음 — 0 막대는 'VM 이 없다' 는 거짓). 파이는 셀 수 있는 vCenter 만 더하고 뺀 곳 수를 밝힌다.
 * `groupOf` 는 화면의 리전 묶음(execOverviewText.chartGroup)을 그대로 받는다.
 */
export function corpVmChart(sites, { groupOf = () => 'Unknown', now = Date.now() } = {}) {
  const list = Array.isArray(sites) ? sites : [];
  let missing = 0;
  const groups = {};
  const bars = list.map((s) => {
    const ok = !!s && corpSiteStatus(s, now).countable;
    if (!ok) missing += 1;
    else {
      const k = groupOf(s);
      groups[k] = (groups[k] || 0) + (Number(s.metrics?.vms) || 0);
    }
    return {
      name: s?.id || s?.name,
      VM: ok ? (Number(s.metrics?.vms) || 0) : null,
      On: ok ? (Number(s.metrics?.vmsPoweredOn) || 0) : null,
      uncounted: !ok,
    };
  });
  return {
    bars, groups, missing,
    note: missing > 0 ? `미수집 ${missing}곳은 막대를 그리지 않았습니다(0대가 아닙니다)` : null,
    pieNote: missing > 0 ? `미수집 ${missing}곳의 VM 은 비중에서 뺐습니다(수를 모릅니다)` : null,
  };
}
