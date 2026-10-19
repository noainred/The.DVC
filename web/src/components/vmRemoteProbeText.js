/**
 * VM 원격 접속 버튼의 사전 도달성 점검 문구(순수 — 판정과 문구를 한 곳에 둔다).
 *
 * v2.744(최종 검토 리드 — FD 가 남긴 별건): `/remote/probe` 가 **403(범위 밖 대상)·404(범위 밖 vCenter)** 로 거부하면
 *   예전에는 그 오류를 '도달 불가' 로 그리고 버튼 툴팁이 '방화벽/포트/프록시 경로 확인' 이라 말했다 — 네트워크가 아니라 **계정 범위**가
 *   원인인데 사용자는 방화벽을 의심한다. 거부는 `denied` 로 따로 표시하고 서버가 준 사유를 그대로 보여 준다.
 */

/** probe 실패(throw)를 화면 상태로 바꾼다 — 403·404 는 범위 거부, 그 밖은 예전처럼 실패. */
export function probeFailState(e) {
  const status = Number(e?.status) || 0;
  const reason = String(e?.serverReason || e?.message || '').slice(0, 300);
  if (status === 403 || status === 404) return { loading: false, ok: false, denied: true, reason };
  return { loading: false, ok: false, reason };
}

/** IP 한 줄의 상태(st)·글자(label). */
export function probeRow(p) {
  const q = p || { loading: true };
  if (q.loading) return { st: 'pending', label: '확인 중…' };
  if (q.denied) return { st: 'denied', label: '범위 밖 대상(계정 권한)' };
  if (q.portOpen) return { st: 'up', label: `접속 가능 · 포트 열림${q.pingOk ? ` · ping ${q.pingMs}ms` : ''}` };
  if (q.pingOk) return { st: 'warn', label: '포트 닫힘(ping만 응답)' };
  return { st: 'down', label: '도달 불가' };
}

/**
 * 버튼 툴팁 — 범위 거부만 있으면 그 사실을, 섞였으면 네트워크 안내에 거부 개수를 덧붙인다.
 * @param {{canRemote:(boolean|null), ips:string[], probes:Record<string, object>, probePort:number}} o
 */
export function probeTip({ canRemote, ips = [], probes = {}, probePort }) {
  if (canRemote === false) return '원격 접속은 operator/admin 권한이 필요합니다.';
  if (!ips.length) return '수집된 IP가 없습니다.';
  if (ips.some((x) => probes[x]?.loading)) return '프록시 경유 접속 점검 중…';
  const openIps = ips.filter((x) => probes[x]?.portOpen);
  if (openIps.length) return `접속 가능 IP: ${openIps.join(', ')} (:${probePort})`;
  const denied = ips.filter((x) => probes[x]?.denied);
  if (denied.length === ips.length) {
    const why = probes[denied[0]]?.reason;
    return `이 계정의 범위 밖 대상입니다 — 네트워크 문제가 아닙니다${why ? `(서버: ${why})` : ''}`;
  }
  const tail = denied.length ? ` · ${denied.length}개 IP 는 계정 범위 밖이라 점검하지 않았습니다` : '';
  return `모든 IP 접속 불가(:${probePort}) — 방화벽/포트/프록시 경로 확인${tail}`;
}

/** 버튼 색 — 범위 거부만이면 회색(장애색 금지). */
export function probeColor({ canRemote, ips = [], probes = {} }) {
  if (canRemote === false) return '#94a3b8';
  if (!ips.length) return '#f59e0b';
  if (ips.some((x) => probes[x]?.loading)) return null;
  if (ips.some((x) => probes[x]?.portOpen)) return '#22c55e';
  if (ips.every((x) => probes[x]?.denied)) return '#94a3b8';
  return '#f87171';
}
