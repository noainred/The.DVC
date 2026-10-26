// v2.702(A7·A8) — VM 이동·구성 변경 이력 문구. 판정은 서버 vmchanges/analyze.js 가 한다(이동 종류 키는 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
import { notCollectedNote, notCollectedItems, notCollectedWhyText, lagDurText } from '../eventCoverageText.js'; // v2.733(C1-01) · v2.772(Z4-2)
export const MOVE_KIND_LABEL = Object.freeze({ drs: 'DRS 자동 이동', vmotion: 'vMotion(호스트)', svmotion: 'Storage vMotion', both: '호스트+스토리지', relocate: '이전(재배치)' });
export const CHANGE_KIND_LABEL = Object.freeze({ reconfig: '구성 변경', permission: '권한 변경', role: '역할 변경' });
const DAY = 86_400_000;

export function fmtTs(ts) {
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function routeText(from, to) {
  if (!from && !to) return '—';
  if (from && to && from === to) return `${from}(같은 호스트)`;
  return `${from || '?'} → ${to || '?'}`;
}
/** 수집 범위 문구 — 이벤트는 이 포탈이 받아 둔 것만이다. 수집이 꺼졌거나 받은 적 없는 vCenter 를 '이동 없음' 이라 말하지 않는다. */
export function coverageNote(data, now = Date.now(), { what = '이동', events = '이동·변경' } = {}) {
  if (!data) return null;
  if (data.logs && data.logs.enabled === false) return `vCenter 이벤트 수집이 꺼져 있습니다(설정 › vCenter 로그 보관) — 이 화면은 그동안의 ${events}을 보여 줄 수 없습니다.`;
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  // v2.733(점검 3회차 C1-01): 이 포탈이 지금 이벤트를 수집하지 않는 vCenter(엣지 위임·비활성·점검중)는 '받은 적 없음'·'이틀 지남' 보다 먼저
  //   그 사실을 말한다(원인이 다르다 — 기다려도 채워지지 않는다). 목록은 서버 notCollected(범위로 거른 전체), 없으면 항목의 notCollected.
  const ncList = Array.isArray(data.notCollected) && data.notCollected.length
    ? data.notCollected : vcs.filter((v) => v && v.notCollected).map((v) => ({ vcenterId: v.vcenterId, why: v.notCollected, name: v.name }));
  const ncIds = new Set(notCollectedItems(ncList).map((x) => x.vcenterId));
  const none = vcs.filter((v) => !v.lastTs && !ncIds.has(v.vcenterId));
  const stale = vcs.filter((v) => v.lastTs && now - v.lastTs > 2 * DAY && !ncIds.has(v.vcenterId));
  const parts = [];
  const nc = notCollectedNote(ncList, { what, tail: `그 vCenter 의 ${events} 기록은 수집을 멈추기 전 것만 있습니다(‘${what} 없음’ 이 아닙니다)` });
  if (nc) parts.push(nc.replace(/\.$/, ''));
  if (none.length) parts.push(`이벤트를 받은 적 없는 vCenter ${none.length}곳(${none.slice(0, 4).map((v) => v.name).join(', ')}${none.length > 4 ? ' 외' : ''})은 결과에 없습니다 — '${what} 없음' 이 아닙니다`);
  if (stale.length) parts.push(`마지막 이벤트가 이틀 넘게 지난 vCenter ${stale.length}곳은 그 뒤가 비어 있을 수 있습니다`);
  if (data.logs?.minSeverity && data.logs.minSeverity !== 'info') parts.push(`수집 최소 심각도가 ${data.logs.minSeverity} 라 정보 수준의 ${events} 이벤트는 쌓이지 않습니다`);
  return parts.length ? `${parts.join(' · ')}.` : null;
}
export function truncNote(data) {
  if (!data?.truncated) return null;
  return `이벤트가 많아 최신 ${Number(data.readMax || 0).toLocaleString()}건까지만 분석했습니다 — 기간이나 vCenter 를 좁혀 보세요.`;
}
export function noDetailNote(n, total) {
  if (!n) return null;
  return `${n.toLocaleString()}건(전체 ${total.toLocaleString()}건 중)은 상세를 싣기 전에 받은 이벤트라 출발·도착이나 변경 내용을 모릅니다.`;
}
/** 구성 변경 한 줄 요약 — vCenter 가 준 변경 원문(6.7+)이 먼저, 없으면 바뀐 항목 이름. */
export function changeText(e) {
  if (!e) return '—';
  if (e.kind === 'permission' || e.kind === 'role') {
    const who = e.principal ? `${e.principal}${e.group ? '(그룹)' : ''}` : '';
    return [who, e.role ? `역할 ${e.role}` : '', e.propagate ? '하위 전파' : ''].filter(Boolean).join(' · ') || '—';
  }
  if (Array.isArray(e.lines) && e.lines.length) return e.lines.map((l) => `${l.k === 'modified' ? '변경' : l.k === 'added' ? '추가' : '삭제'}: ${l.text}`).join(' / ');
  const parts = [];
  if (e.numCpu != null) parts.push(`vCPU ${e.numCpu}`);
  if (e.memoryMB != null) parts.push(`메모리 ${Math.round(e.memoryMB / 1024 * 10) / 10} GB`);
  if (Array.isArray(e.devices) && e.devices.length) parts.push(`장치 ${e.devices.join(', ')}`);
  if (!parts.length && Array.isArray(e.fields) && e.fields.length) parts.push(`바뀐 항목 ${e.fields.join(', ')}`);
  return parts.join(' · ') || (e.hasDetail === false ? '변경 내용 모름(상세 없는 이벤트)' : '—');
}

/**
 * v2.733(점검 3회차 C1-01): VM 상세 '이동·구성 변경' 칸 — 이 VM 의 vCenter 를 이 포탈이 지금 이벤트로 수집하지 않으면(서버 `/of` 의
 * notCollected = 사유) '변경이 없습니다' 대신 이 문장을 쓴다. 남은 이력이 있으면 그것은 수집을 멈추기 전 것이다. 없으면 null.
 */
export function vmHistoryNotCollectedText(d) {
  const why = d && typeof d.notCollected === 'string' && d.notCollected ? d.notCollected : null;
  if (!why) return null;
  const has = Array.isArray(d.items) && d.items.length > 0;
  return `이 VM 의 vCenter 는 이 포탈이 지금 이벤트를 수집하지 않습니다(${notCollectedWhyText(why)}) — ${has ? '아래는 수집을 멈추기 전 이력이고 그 뒤는 알 수 없습니다.' : '‘이동·변경 없음’ 이 아닙니다.'}`;
}

/** v2.772(Z4-2): VM 상세 이력의 '마지막 이벤트가 낡았다' 기준 — 서버가 지연(lagging)을 주지 않을 때만 쓰는 목록 화면(coverageNote)과 같은 2일. */
export const HISTORY_STALE_MS = 2 * DAY;
/**
 * v2.772(Z4-2): VM 상세 이동·변경 이력 — 이 VM 의 vCenter 이벤트 수집이 뒤처졌으면 그 사실(없으면 null).
 * 서버가 `lagging`({okAt, lagMs} — logs/coverage.js 판정)을 주면 그것을, false(지연 없음 판정 — v2.785)면 null, 키가 없거나 null(옛 서버·판정 실패)이면 마지막 이벤트 시각이
 * 목록 화면과 같은 기준(2일)보다 오래됐을 때만 말한다. 지금 수집하지 않는 vCenter(notCollected)는 다른 문장이 말하므로 null.
 * '받아 둔 이벤트 중 이동·변경 없음' 이 그 뒤까지 뜻하지 않게 한다.
 */
export function vmHistoryLagText(d, now = Date.now()) {
  if (!d || (typeof d.notCollected === 'string' && d.notCollected)) return null;
  // v2.785(GV D-B2): 서버가 '지연 없음' 을 판정했다(false) — 마지막 이벤트가 오래됐어도 조용한 vCenter 일 뿐이다(수집 정상). 아래 lastTs 대체 판단은
  //   키가 없거나(옛 서버) null(판정 실패)일 때만 쓴다. 예전에는 서버가 둘을 같은 null 로 보내 조용한 vCenter 의 모든 VM 에 거짓 '수집 지연·정지' 가 떴다.
  if (d.lagging === false) return null;
  const lg = d.lagging && typeof d.lagging === 'object' ? d.lagging : null;
  const lagMs = lg && Number.isFinite(lg.lagMs) && lg.lagMs > 0 ? lg.lagMs
    : (!lg && Number.isFinite(d.lastTs) && d.lastTs > 0 && now - d.lastTs > HISTORY_STALE_MS ? now - d.lastTs : null);
  if (lagMs == null) return null;
  const dur = lagDurText(lagMs);
  return lg
    ? `이 VM 의 vCenter 는 이벤트 수집이 ${dur} 뒤처져 있습니다(따라잡는 중일 수 있음) — 그 사이의 이동·변경은 아직 받지 못했습니다. 이 기간 결과는 일부입니다.`
    : `이 VM 의 vCenter 에서 받은 마지막 이벤트가 ${dur} 전입니다 — 그 뒤의 이동·변경은 아직 받지 못했을 수 있습니다(수집 지연·정지).`;
}
