// v2.702(A7·A8) — VM 이동·구성 변경 이력 문구. 판정은 서버 vmchanges/analyze.js 가 한다(이동 종류 키는 1:1 — 테스트 대조).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
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
export function coverageNote(data, now = Date.now()) {
  if (!data) return null;
  if (data.logs && data.logs.enabled === false) return 'vCenter 이벤트 수집이 꺼져 있습니다(설정 › vCenter 로그) — 이 화면은 그동안의 이동·변경을 보여 줄 수 없습니다.';
  const vcs = Array.isArray(data.vcenters) ? data.vcenters : [];
  const none = vcs.filter((v) => !v.lastTs);
  const stale = vcs.filter((v) => v.lastTs && now - v.lastTs > 2 * DAY);
  const parts = [];
  if (none.length) parts.push(`이벤트를 받은 적 없는 vCenter ${none.length}곳(${none.slice(0, 4).map((v) => v.name).join(', ')}${none.length > 4 ? ' 외' : ''})은 결과에 없습니다 — '이동 없음' 이 아닙니다`);
  if (stale.length) parts.push(`마지막 이벤트가 이틀 넘게 지난 vCenter ${stale.length}곳은 그 뒤가 비어 있을 수 있습니다`);
  if (data.logs?.minSeverity && data.logs.minSeverity !== 'info') parts.push(`수집 최소 심각도가 ${data.logs.minSeverity} 라 정보 수준의 이동·변경 이벤트는 쌓이지 않습니다`);
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
