/**
 * views/vcd/vcInfo.js — vCenter 알람 · 최근 작업 · 권한 목록(v2.897) 화면 판정(순수 · vitest 고정).
 * 값은 /vcenter-info/<alarms|tasks|perms>?vcenterId (서버 vcinfo 캐시 — 수집 주기 안에서 종류별 주기로 읽은 것).
 * 못 읽은 값은 '—'(지어내지 않는다). 권한 목록은 관리자 판본에서만 서버가 준다(그 밖은 403 — 화면은 부르지 않는다).
 */
import { vcHash } from './vcdRoute.js';
import { shortTs } from './vcdTabs.js';

export const VC_ALARM_STATUS = Object.freeze({ red: ['red', '경보'], yellow: ['amber', '주의'], gray: ['gray', '알 수 없음'], green: ['green', '정상'] });
export const TASK_STATE = Object.freeze({ success: ['green', '완료'], error: ['red', '실패'], running: ['blue', '실행 중'], queued: ['gray', '대기'] });
export const TASK_REASON = Object.freeze({ user: '사용자', schedule: '예약 작업', alarm: '알람 동작', system: '시스템' });
export const ENTITY_TYPE_TEXT = Object.freeze({
  VirtualMachine: 'VM', HostSystem: '호스트', Datastore: '데이터스토어', ClusterComputeResource: '클러스터', ComputeResource: '단독 호스트',
  Datacenter: '데이터센터', Folder: '폴더', ResourcePool: '리소스 풀', VirtualApp: 'vApp', Network: '네트워크', DistributedVirtualPortgroup: '분산 포트그룹',
  VmwareDistributedVirtualSwitch: '분산 스위치', DistributedVirtualSwitch: '분산 스위치', StoragePod: '데이터스토어 클러스터', OpaqueNetwork: 'NSX 세그먼트',
});
const STATUS_ORDER = { red: 0, yellow: 1, gray: 2, green: 3 };

export const entityTypeText = (t) => ENTITY_TYPE_TEXT[t] || t || '—';
/** VM · 호스트면 포탈 개체 보기 주소(이 vCenter 안), 그 밖은 null. 포탈 id 는 '<vcenterId>:<moref>'. */
export function entityHash(vcenterId, type, ref) {
  if (!ref || !vcenterId) return null;
  if (type === 'VirtualMachine') return vcHash(vcenterId, { type: 'vm', id: `${vcenterId}:${ref}` });
  if (type === 'HostSystem') return vcHash(vcenterId, { type: 'host', id: `${vcenterId}:${ref}` });
  return null;
}

/** 알람 행 — 경보 · 주의 순, 같으면 최신 순. 확인(ack)된 것은 뒤로 보내지 않는다(vSphere Client 처럼 함께 보인다). */
export function vcAlarmRows(items) {
  return (Array.isArray(items) ? items : []).filter((a) => a && typeof a === 'object')
    .slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.time ?? 0) - (a.time ?? 0));
}
export function vcAlarmCounts(items) {
  const out = { total: 0, red: 0, yellow: 0, acked: 0 };
  for (const a of Array.isArray(items) ? items : []) {
    out.total += 1;
    if (a?.status === 'red') out.red += 1; else if (a?.status === 'yellow') out.yellow += 1;
    if (a?.ack === true) out.acked += 1;
  }
  return out;
}

/** 걸린 시간 — 시작 · 완료를 둘 다 알 때만(실행 중이면 지금까지). 모르면 '—'. */
export function taskDurText(t, now = Date.now()) {
  const s = t?.started;
  const e = t?.completed ?? (t?.state === 'running' ? now : null);
  if (!(Number.isFinite(s) && Number.isFinite(e)) || e < s) return '—';
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}분 ${sec % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 작업 행 — 최신 순(완료 → 시작 → 대기 시각). entity 를 주면 그 개체를 대상으로 한 것만. */
export function vcTaskRows(items, { entityType = null, entity = null } = {}) {
  const when = (t) => t.completed ?? t.started ?? t.queued ?? 0;
  return (Array.isArray(items) ? items : []).filter((t) => t && typeof t === 'object')
    .filter((t) => !entity || (t.entity === entity && (!entityType || t.entityType === entityType)))
    .slice().sort((a, b) => when(b) - when(a));
}
export function vcTaskCounts(rows) {
  const out = { total: 0, error: 0, running: 0 };
  for (const t of rows || []) { out.total += 1; if (t.state === 'error') out.error += 1; if (t.state === 'running' || t.state === 'queued') out.running += 1; }
  return out;
}

/** 권한 행 — entity 를 주면 그 개체에 직접 정의된 것만(상위에서 전파되는 것은 이 목록으로 알 수 없다 — 화면이 그렇게 말한다). */
export function vcPermRows(items, { entityType = null, entity = null } = {}) {
  return (Array.isArray(items) ? items : []).filter((p) => p && typeof p === 'object')
    .filter((p) => !entity || (p.entity === entity && (!entityType || p.entityType === entityType)))
    .slice().sort((a, b) => String(a.entityName || a.entity || '').localeCompare(String(b.entityName || b.entity || '')) || String(a.principal).localeCompare(String(b.principal)));
}

/** 머리 문구 — 읽은 시각 · 갱신 주기(API 값). 주기를 화면에 박지 않는다. */
export function vcInfoHeadText(d) {
  if (!d) return '';
  const every = Number.isFinite(d.refreshMs) && d.refreshMs > 0
    ? (d.refreshMs >= 3_600_000 ? `${Math.round(d.refreshMs / 3_600_000)}시간` : `${Math.round(d.refreshMs / 60_000)}분`) : null;
  return [d.at ? `읽은 시각 ${shortTs(d.at)}` : '아직 읽지 않음', every ? `${every}마다 갱신` : null, d.source === 'edge' ? '엣지 수집' : d.source === 'mock' ? '데모 데이터' : null].filter(Boolean).join(' · ');
}
