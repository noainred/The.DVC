import { numOrNull } from '../util/numOrNull.js'; // v2.727(C-01)

/**
 * inventory/guestOsAgg.js — Guest OS 분포 + 할당 코어(vCPU) 집계(v2.328, 사용자 요구).
 *
 * "전체 · vCenter별로 Guest OS별 VM 수 / OS별 개수 / 할당 코어(vCPU)"를 한 번의 O(N) 순회로
 * 낸다(롤업 규칙 — vCenter마다 전체 재필터하면 O(vCenter×N)). 순수 함수라 라우트/테스트가 공유.
 *
 * @param {Array} vms  스냅샷 VM 목록(이미 scope·전원·종류 필터가 적용된 것). 각 v: {vcenterId,
 *   guestOS, powerState, cpuCount, memMB, storageGB}
 * @param {(os:string)=>string} osFamily  OS 문자열 → 계열(Windows/Linux 등) 분류기
 * @param {Map<string,{id,name,region}>} [vcMeta]  vcenterId → 표시 메타(byVcenter 이름 채움용)
 * @returns {{total, distinctOs, totalVcpu, families, items, byVcenter}}
 *   families: [{family,total,on,vcpu}] · items: [{os,family,total,on,off,vcpu,memGB,diskGB}]
 *   byVcenter: [{id,name,region,total,vcpu,os:[{os,family,count,vcpu}]}]  (os 는 count desc, 상한 100)
 */
export function aggregateGuestOs(vms, osFamily, vcMeta = new Map()) {
  const byName = new Map();     // os 이름 → 집계
  const byFamily = new Map();   // 계열 → 집계
  const byVc = new Map();       // vcenterId → { total, vcpu, os: Map(os→{count,vcpu,family}) }
  let totalVcpu = 0;
  let storageUnknown = 0;       // v2.727(C-01): storageGB 를 못 읽어(null) diskGB 합에서 뺀 VM 수

  for (const v of vms) {
    const os = (v.guestOS || '미상').trim() || '미상';
    const fam = osFamily(v.guestOS);
    const on = v.powerState === 'POWERED_ON';
    const vcpu = Number(v.cpuCount) || 0;
    const memMB = Number(v.memMB) || 0;
    // v2.727(감사 C-01): v2.719 부터 storageGB 는 못 읽으면 null 이다 — `Number(null) || 0` 은 그 VM 을 0 GB 로 더해 OS 별 디스크 합계를
    //   조용히 작게 만들었다. null 은 합에서 빼고 개수를 센다(보고된 0 은 값 — numOrNull 이 지킨다).
    const diskGB = numOrNull(v.storageGB);
    totalVcpu += vcpu;

    const n = byName.get(os) || { os, family: fam, total: 0, on: 0, off: 0, vcpu: 0, memGB: 0, diskGB: 0, storageUnknown: 0 };
    n.total++; if (on) n.on++; else n.off++; n.vcpu += vcpu; n.memGB += memMB / 1024;
    if (diskGB == null) { n.storageUnknown++; storageUnknown++; } else n.diskGB += diskGB;
    byName.set(os, n);

    const f = byFamily.get(fam) || { family: fam, total: 0, on: 0, vcpu: 0 };
    f.total++; if (on) f.on++; f.vcpu += vcpu;
    byFamily.set(fam, f);

    const vcId = v.vcenterId || '(미지정)';
    let b = byVc.get(vcId);
    if (!b) { b = { total: 0, vcpu: 0, os: new Map() }; byVc.set(vcId, b); }
    b.total++; b.vcpu += vcpu;
    const bo = b.os.get(os) || { os, family: fam, count: 0, vcpu: 0 };
    bo.count++; bo.vcpu += vcpu; b.os.set(os, bo);
  }

  const round0 = (x) => Math.round(x);
  const items = [...byName.values()]
    .map((n) => ({ ...n, memGB: round0(n.memGB), diskGB: round0(n.diskGB) }))
    .sort((a, b) => b.total - a.total);
  const families = [...byFamily.values()].sort((a, b) => b.total - a.total);
  const byVcenter = [...byVc.entries()].map(([id, b]) => {
    const meta = vcMeta.get(id) || {};
    return {
      id, name: meta.name || id, region: meta.region || '',
      total: b.total, vcpu: b.vcpu,
      os: [...b.os.values()].sort((x, y) => y.count - x.count).slice(0, 100),
    };
  }).sort((a, b) => b.total - a.total);

  // storageUnknown(v2.727): items[].diskGB 합에서 뺀 VM 수(전체) — 0 이면 전부 읽었다.
  return { total: vms.length, distinctOs: byName.size, totalVcpu, storageUnknown, families, items, byVcenter };
}
