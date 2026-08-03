/**
 * 좀비/방치 리소스 리포트(RVTools 스타일) — 스냅샷 데이터만으로 계산(추가 수집 없음).
 *   · 고아/접근불가 VM: runtime.connectionState가 connected가 아닌 VM(orphaned/inaccessible/invalid)
 *   · 장기 정지 VM: 전원 OFF 비템플릿 VM(디스크 점유 큰 순)
 *   · 템플릿: 방치 여부 검토 대상(점유 용량 표시)
 *   · 스냅샷 대식가: 스냅샷 크기/나이 임계 초과 VM
 * 주의: 데이터스토어 파일 전수 스캔 기반 '고아 VMDK'(어느 VM에도 속하지 않은 디스크 파일)는
 * HostDatastoreBrowser 스캔이 필요해 포함하지 않는다(리포트에 한계 명시).
 */

const DAY = 86_400_000;
const slim = (v) => ({
  id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host || '', cluster: v.cluster || '',
  powerState: v.powerState, storageGB: v.storageGB || 0, guestOS: v.guestOS || '',
});

export function computeZombies(snap, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const snapSizeMin = Number(opts.snapshotMinGB) || 10;   // 스냅샷 대식가 크기 임계
  const snapAgeDays = Number(opts.snapshotAgeDays) || 7;  // 스냅샷 나이 임계

  const vms = snap.vms || [];
  const orphaned = vms
    .filter((v) => v.connectionState && v.connectionState !== 'connected')
    .map((v) => ({ ...slim(v), connectionState: v.connectionState }));

  const poweredOff = vms
    .filter((v) => v.powerState === 'POWERED_OFF' && !v.template && (!v.connectionState || v.connectionState === 'connected'))
    .map(slim)
    .sort((a, b) => b.storageGB - a.storageGB);

  const templates = vms.filter((v) => v.template).map(slim).sort((a, b) => b.storageGB - a.storageGB);

  const snapshotHogs = vms
    .filter((v) => (v.snapshotCount || 0) > 0)
    .map((v) => ({
      ...slim(v), snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB || 0,
      snapshotOldestTs: v.snapshotOldestTs || null,
      snapshotAgeDays: v.snapshotOldestTs ? Math.floor((now - v.snapshotOldestTs) / DAY) : null,
    }))
    .filter((v) => v.snapshotSizeGB >= snapSizeMin || (v.snapshotAgeDays != null && v.snapshotAgeDays >= snapAgeDays))
    .sort((a, b) => b.snapshotSizeGB - a.snapshotSizeGB);

  const sumGB = (arr, k = 'storageGB') => Math.round(arr.reduce((a, x) => a + (x[k] || 0), 0));
  return {
    config: { snapshotMinGB: snapSizeMin, snapshotAgeDays: snapAgeDays },
    summary: {
      orphanedCount: orphaned.length,
      poweredOffCount: poweredOff.length, poweredOffGB: sumGB(poweredOff),
      templateCount: templates.length, templateGB: sumGB(templates),
      snapshotHogCount: snapshotHogs.length, snapshotHogGB: sumGB(snapshotHogs, 'snapshotSizeGB'),
      // 회수 가능 추정: 정지 VM 디스크 + 스냅샷 델타(템플릿은 보존 가능성이 높아 제외).
      reclaimableGB: sumGB(poweredOff) + sumGB(snapshotHogs, 'snapshotSizeGB'),
    },
    orphaned: orphaned.slice(0, 300),
    poweredOff: poweredOff.slice(0, 500),
    templates: templates.slice(0, 300),
    snapshotHogs: snapshotHogs.slice(0, 300),
    note: '고아 VMDK(어느 VM에도 연결되지 않은 디스크 파일) 탐지는 데이터스토어 파일 스캔이 필요해 이 리포트에 포함되지 않습니다.',
  };
}
