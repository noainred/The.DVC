// v2.700 — 데이터스토어 운영·vSAN 문구·판정. 서버 dscfg/parse.js·analyze.js 와 같은 입력으로 대조한다(번들 경계라 두 벌).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
export const DS_CFG_CODES = Object.freeze({
  'ds-inaccessible': 'crit',
  'ds-mount-partial': 'warn',
  'ds-maintenance': 'warn',
  'ds-overcommit': 'warn',
  'ds-vmfs-old': 'info',
  'ds-sioc-off': 'info',
  'ds-many-vms': 'info',
});
export const VSAN_CODES = Object.freeze({ 'vsan-partition': 'crit', 'vsan-disk-issue': 'warn', 'vsan-capacity-high': 'warn' });
export const DS_OVERCOMMIT_PCT = 150;
export const DS_MANY_VMS = 40;

export const DS_TEXT = Object.freeze({
  'ds-inaccessible': { title: '데이터스토어에 접근할 수 없습니다', fix: '스토리지 연결·LUN 상태·NFS 서버를 확인하세요' },
  'ds-mount-partial': { title: '일부 호스트에서 마운트되지 않았거나 접근할 수 없습니다', fix: '해당 호스트에서 스토리지를 다시 검색(rescan)하고 경로·조닝을 확인하세요 · vMotion·HA 가 그 호스트로 갈 수 없습니다' },
  'ds-maintenance': { title: '데이터스토어가 유지보수 모드입니다', fix: '작업이 끝났으면 유지보수 모드를 해제하세요' },
  'ds-overcommit': { title: '프로비저닝이 용량을 크게 넘었습니다(씬 오버할당)', fix: 'Thin 디스크가 다 차면 데이터스토어가 가득 찹니다 · 증설하거나 VM 을 옮기세요' },
  'ds-vmfs-old': { title: 'VMFS 5 이하입니다', fix: 'VMFS 6 으로 옮기면 자동 공간 회수(UNMAP)를 씁니다 · 새 데이터스토어로 Storage vMotion 후 교체하세요' },
  'ds-sioc-off': { title: '공유 데이터스토어에 SIOC 가 꺼져 있습니다', fix: '참고 · 혼잡 시 VM 간 I/O 공정성을 보장하려면 Storage I/O Control 을 켜세요' },
  'ds-many-vms': { title: '한 데이터스토어에 VM 이 많습니다', fix: '참고 · 큐 깊이·잠금 경합을 줄이려면 분산을 검토하세요' },
  'vsan-partition': { title: 'vSAN 클러스터가 분할된 것으로 보입니다', fix: '멤버 수가 vSAN 호스트 수보다 적습니다 · vSAN VMkernel 네트워크(MTU·VLAN·멀티캐스트/유니캐스트)를 확인하세요' },
  'vsan-disk-issue': { title: 'vSAN 디스크 문제가 보고됐습니다', fix: 'vSAN 디스크 관리에서 해당 호스트의 디스크 상태를 확인하세요' },
  'vsan-capacity-high': { title: 'vSAN 사용률이 높습니다', fix: '리빌드·리싱크 여유(권장 25~30%)를 남기세요 · 증설하거나 정리하세요' },
});
export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray' });

/** 서버 dsCfgFindings 와 같은 규칙. */
export function dsCfgFindings(ds) {
  const out = [];
  if (!ds) return out;
  const add = (code, facts = {}) => out.push({ code, sev: DS_CFG_CODES[code], facts });
  if (ds.accessible === false) add('ds-inaccessible');
  if (Number.isFinite(ds.vmfsMajor) && ds.vmfsMajor > 0 && ds.vmfsMajor < 6) add('ds-vmfs-old', { version: ds.vmfsMajor });
  const d = ds.dcfg;
  if (!d) return out;
  if (d.mounts && (d.mounts.notAccessible > 0 || d.mounts.notMounted > 0)) add('ds-mount-partial', { ...d.mounts });
  if (d.maintenance === 'inMaintenance' || d.maintenance === 'enteringMaintenance') add('ds-maintenance', { mode: d.maintenance });
  if (Number.isFinite(d.uncommittedGB) && Number.isFinite(ds.usedGB) && ds.capacityGB > 0) {
    const pct = Math.floor(((ds.usedGB + d.uncommittedGB) / ds.capacityGB) * 100);
    if (pct >= DS_OVERCOMMIT_PCT) add('ds-overcommit', { pct, provisionedGB: ds.usedGB + d.uncommittedGB });
  }
  const shared = d.mounts ? d.mounts.total > 1 : false;
  if (d.sioc === false && shared && /vmfs|nfs/i.test(ds.type || '')) add('ds-sioc-off');
  if (Number.isFinite(d.vmCount) && d.vmCount > DS_MANY_VMS) add('ds-many-vms', { count: d.vmCount, limit: DS_MANY_VMS });
  return out;
}

export function findingDetail(f) {
  const x = f?.facts || {};
  switch (f?.code) {
    case 'ds-mount-partial': return `마운트 ${x.total} · 접근 불가 ${x.notAccessible} · 미마운트 ${x.notMounted}`;
    case 'ds-maintenance': return x.mode === 'enteringMaintenance' ? '유지보수 진입 중' : '유지보수 중';
    case 'ds-overcommit': return `프로비저닝 ${x.pct}%`;
    case 'ds-vmfs-old': return `VMFS ${x.version}`;
    case 'ds-many-vms': return `VM ${x.count}대(기준 ${x.limit}대 초과)`;
    case 'vsan-partition': return `멤버 ${x.members} · vSAN 호스트 ${x.hosts}`;
    case 'vsan-disk-issue': return `${x.count}건${x.hosts?.length ? ` · ${x.hosts.join(', ')}` : ''}`;
    case 'vsan-capacity-high': return `사용률 ${x.pct}%(기준 ${x.limit}%)`;
    default: return '';
  }
}

export function dsCoverageText(c) {
  if (!c) return '';
  return [`데이터스토어 ${c.datastores.toLocaleString()}개`, `운영 속성 읽음 ${c.cfg.toLocaleString()}`, c.notCollected ? `아직 안 읽음 ${c.notCollected.toLocaleString()}(접근 불가·VMFS 버전만 판정)` : null].filter(Boolean).join(' · ');
}
export function pathCoverageText(c) {
  if (!c) return '';
  return [`호스트 ${c.hosts.toLocaleString()}대(연결)`, `경로 읽음 ${c.read.toLocaleString()}`, c.notCollected ? `아직 안 읽음 ${c.notCollected.toLocaleString()}` : null].filter(Boolean).join(' · ');
}
export const gbText = (g) => (g == null ? '—' : g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${Math.round(g)} GB`);
