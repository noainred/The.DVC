/**
 * v2.743(감사 AUTHZ-02): VM 복제 화면의 NFS 마운트 표기 — 판정·문구 단일 소스.
 *
 * 서버(`GET /tools/vm-clone`)는 범위 계정·데모 계정에 NFS 서버 주소·export 경로·마운트 절대 경로를 싣지 않고
 * `{ id, label, mounted }` + `mountsMasked:true` 를 준다(마운트에는 법인 귀속이 없다 — 귀속 없는 데이터 미노출 규칙).
 * 화면은 label 을 그대로 쓰고, 구버전 서버(label 없음)면 예전처럼 서버:경로로 그린다. 가렸다는 사실은 한 줄로 말한다.
 */

/** 마운트 한 개의 표시 이름. 마운트가 없으면 빈 문자열(호출부가 mountId 로 대신 그린다). */
export function mountLabel(m) {
  if (!m || typeof m !== 'object') return '';
  if (typeof m.label === 'string' && m.label) return m.label;
  if (typeof m.server === 'string' && m.server) return `${m.server}:${m.exportPath || ''}`;
  return typeof m.id === 'string' ? m.id : '';
}

/** 가린 응답일 때 한 번 보여 줄 안내. */
export const MOUNTS_MASKED_NOTE = 'NFS 서버 주소·경로는 전체 범위 관리자에게만 보입니다 — 여기서는 마운트 id 로 표시합니다.';

/** 안내를 띄울지 — 가린 응답이고 NFS 마운트나 NFS 대상 잡이 하나라도 있을 때만(아무 NFS 도 없으면 말할 것이 없다). */
export function showMountsMaskedNote(d) {
  if (!d || d.mountsMasked !== true) return false;
  const mounts = Array.isArray(d.mounts) ? d.mounts.length : 0;
  const nfsJobs = Array.isArray(d.jobs) ? d.jobs.filter((j) => j?.dest?.type === 'nfs').length : 0;
  return mounts + nfsJobs > 0;
}
