/**
 * views/vcd/vcInfo.js — vCenter 알람 · 최근 작업 · 권한 목록(v2.898) 화면 판정(순수 · vitest 고정).
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

/**
 * v2.901: 리소스 풀 설정 행 — 호스트의 클러스터(clusterRef = 풀 owner)로 고르고, 짝을 못 지으면(데모 · 옛 수집) 이 호스트 VM 의 풀 이름으로 고른다.
 *   이름으로 고르면 다른 클러스터의 같은 이름 풀이 섞일 수 있다 — byName 으로 알려 화면이 그렇게 말한다.
 */
export function poolRowsForHost(items, host, poolNames = []) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object');
  const own = host?.clusterRef ? list.filter((x) => x.owner === host.clusterRef) : [];
  if (own.length) return { rows: own, byName: false };
  const names = new Set(poolNames);
  return { rows: list.filter((x) => names.has(x.name)), byName: true };
}
/** 할당 값 문구 — limit -1 = 무제한 · 값이 없으면 '—'(단위를 붙이지 않는다). unit: 'MHz' | 'GB'(MB 를 GB 로). */
export function allocText(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === -1) return '무제한';
  return unit === 'GB' ? `${(Math.round((v / 1024) * 10) / 10).toLocaleString()} GB` : `${v.toLocaleString()} MHz`;
}
export const SHARE_LEVEL_TEXT = Object.freeze({ low: '낮음', normal: '보통', high: '높음', custom: '사용자 지정' });

// ── v2.902: 팀 구성 문구(표준 스위치 hcfg · 분산 포트그룹 vcinfo dvpg 한 벌 — 서버 TEAMING_POLICIES 와 같은 키) ─────────────
export const TEAMING_TEXT = Object.freeze({
  loadbalance_srcid: '원래 가상 포트 기반', loadbalance_srcmac: '원본 MAC 해시 기반', loadbalance_ip: 'IP 해시 기반',
  failover_explicit: '명시적 장애 조치 순서', loadbalance_loadbased: '물리 NIC 부하 기반',
});
export const teamingText = (p) => (p ? TEAMING_TEXT[p] || p : '—');
/** 활성 / 대기 글자 — 팀 구성을 모르면 '—'. */
export const uplinkOrderText = (t) => (t ? `${(t.active || []).join(' · ') || '—'} / ${(t.standby || []).join(' · ') || '없음'}` : '—');
export const failbackText = (t) => (t?.failback === true ? '예' : t?.failback === false ? '아니요' : '—');
/**
 * 이 호스트가 붙은 분산 스위치(hcfg.net 의 kind 'dvs' 이름)의 포트그룹 — 업링크 포트그룹은 뺀다(팀 구성 대상이 아니다).
 * 호스트 구성(hcfg.net)을 아직 읽지 않았으면 unknown(분산 스위치를 모른다). vDS 이름을 못 읽은 포트그룹 수는 noName(짝짓지 못함 — 지어내지 않는다).
 */
export function dvpgRowsForHost(items, host) {
  const sws = host?.hcfg && typeof host.hcfg === 'object' ? host.hcfg.net?.switches : null;
  if (!Array.isArray(sws)) return { rows: [], dvs: [], unknown: true, noName: 0 };
  const dvs = [...new Set(sws.filter((w) => w && w.kind === 'dvs' && w.name).map((w) => w.name))];
  const set = new Set(dvs);
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object' && x.uplinkPg !== true);
  return { rows: list.filter((x) => x.dvsName && set.has(x.dvsName)), dvs, unknown: false, noName: list.filter((x) => !x.dvsName).length };
}
/** 분산 포트그룹 VLAN — VLAN ID(0 = 없음) · 트렁크 범위 · PVLAN. 모르면 '—'. */
export function vlanText(v) {
  if (!v || typeof v !== 'object') return '—';
  if (Array.isArray(v.trunk)) return v.trunk.length ? `트렁크 ${v.trunk.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ')}` : '트렁크';
  if (Number.isInteger(v.pvlan)) return `PVLAN ${v.pvlan}`;
  return Number.isInteger(v.id) ? (v.id === 0 ? '0(없음)' : String(v.id)) : '—';
}
/** LACP — Enhanced LACP 의 LAG(활성 업링크에 있을 때) · 옛 포트그룹 LACP · 안 씀 · 모름. */
export function lacpText(l) {
  if (!l || typeof l !== 'object' || l.enabled == null) return '—';
  if (!l.enabled) return '안 씀';
  return `${l.lag ? `LAG ${l.lag}` : '사용(포트그룹)'}${l.mode === 'active' ? ' · 능동' : l.mode === 'passive' ? ' · 수동' : ''}`;
}

/** 머리 문구 — 읽은 시각 · 갱신 주기(API 값). 주기를 화면에 박지 않는다. */
export function vcInfoHeadText(d) {
  if (!d) return '';
  const every = Number.isFinite(d.refreshMs) && d.refreshMs > 0
    ? (d.refreshMs >= 3_600_000 ? `${Math.round(d.refreshMs / 3_600_000)}시간` : `${Math.round(d.refreshMs / 60_000)}분`) : null;
  return [d.at ? `읽은 시각 ${shortTs(d.at)}` : '아직 읽지 않음', every ? `${every}마다 갱신` : null, d.source === 'edge' ? '엣지 수집' : d.source === 'mock' ? '데모 데이터' : null].filter(Boolean).join(' · ');
}

// ── ④ Linked Mode · 업데이트 · vLCM(v2.898 — REST 읽기 전용, 6시간 주기) ─────────────────────────────
export const NODE_TYPE_TEXT = Object.freeze({ VCSA_EMBEDDED: 'vCenter(내장 PSC)', VCSA_EXTERNAL: 'vCenter(외부 PSC)', PSC_EXTERNAL: '외부 PSC' });
export const UPDATE_STATE = Object.freeze({
  UP_TO_DATE: ['green', '최신'], UPDATES_PENDING: ['amber', '적용 가능 업데이트 있음'], STAGE_IN_PROGRESS: ['blue', '스테이징 중'],
  INSTALL_IN_PROGRESS: ['blue', '설치 중'], INSTALL_FAILED: ['red', '설치 실패'], ROLLBACK_IN_PROGRESS: ['amber', '롤백 중'],
});
export const UPDATE_SEVERITY = Object.freeze({ CRITICAL: ['red', '긴급'], IMPORTANT: ['amber', '중요'], MODERATE: ['blue', '보통'], LOW: ['gray', '낮음'] });
export const UPDATE_TYPE = Object.freeze({ SECURITY: '보안', FIX: '수정', UPDATE: '업데이트', UPGRADE: '업그레이드', PATCH: '패치' });
export const VLCM_STATUS = Object.freeze({ COMPLIANT: ['green', '준수'], NON_COMPLIANT: ['amber', '미준수'], INCOMPATIBLE: ['red', '호환 안 됨'], UNAVAILABLE: ['gray', '결과 없음'] });

/** 복제 상태 요약 — 파트너 연결이 끊긴 것 · 복제 안 됨을 센다(모르는 값은 세지 않는다). */
export function replicationSummary(rows) {
  const out = { total: 0, down: 0, notReplicating: 0, maxLag: null };
  for (const r of Array.isArray(rows) ? rows : []) {
    out.total += 1;
    if (r?.available === false) out.down += 1;
    if (r?.replicating === false) out.notReplicating += 1;
    if (Number.isFinite(r?.lag)) out.maxLag = Math.max(out.maxLag ?? 0, r.lag);
  }
  return out;
}

/** vLCM 행 — 미준수 · 호환 안 됨이 먼저, 이미지 미사용(베이스라인)은 뒤. 개수. */
export function vlcmRows(items) {
  const ord = (x) => (x.status === 'INCOMPATIBLE' ? 0 : x.status === 'NON_COMPLIANT' ? 1 : x.error ? 2 : x.status === 'UNAVAILABLE' ? 3 : x.enabled === true ? 4 : 5);
  return (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object')
    .slice().sort((a, b) => ord(a) - ord(b) || String(a.name || a.cluster).localeCompare(String(b.name || b.cluster)));
}
export function vlcmCounts(rows) {
  const out = { clusters: 0, image: 0, baseline: 0, nonCompliant: 0, unknown: 0 };
  for (const x of rows || []) {
    out.clusters += 1;
    if (x.enabled === true) out.image += 1; else if (x.enabled === false) out.baseline += 1; else out.unknown += 1;
    if (x.status === 'NON_COMPLIANT' || x.status === 'INCOMPATIBLE') out.nonCompliant += 1;
  }
  return out;
}
/** 호스트의 클러스터 행 — clusterRef(moref)가 있으면 그것으로, 없으면(데모 · 옛 수집) 클러스터 이름으로. 이 호스트가 미준수 목록에 있는가. */
export function vlcmForHost(items, host, hostRef) {
  const list = Array.isArray(items) ? items : [];
  const row = (host?.clusterRef && list.find((x) => x.cluster === host.clusterRef)) || (host?.cluster && list.find((x) => x.name === host.cluster)) || null;
  if (!row) return null;
  return { row, nonCompliant: !!hostRef && (row.nc || []).some((h) => h.id === hostRef) };
}
