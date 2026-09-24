/**
 * tools/diskTrend.js — 디스크(스토리지) 트렌드 판정·근거 (순수 모듈, v2.446).
 *
 * 사용자 요구: "용량 산정 메뉴에 할당된 디스크·사용된 디스크·사용하지 않은 회수 가능한 용량을
 * 차트로 보여 트렌드를 분석 — 레퍼런스를 많이 찾아 근거와 함께".
 *
 * 세 축의 정의(vSphere 용어 그대로 — 화면 문구도 이 정의를 쓴다):
 *  · 용량(capacity)      : 데이터스토어 summary.capacity 합.
 *  · 사용(used)          : 데이터스토어 capacity − freeSpace 합. VM 외 파일(ISO·템플릿·고아 디스크·
 *                          스왑·로그)까지 포함한 **실제 점유량**.
 *  · 할당(provisioned)   : VM summary.storage.committed + uncommitted 합 = VM 이 최대로 커밋할 수
 *                          있는 양. thin 디스크 때문에 용량을 넘을 수 있다(over-subscription).
 *  · VM 커밋(committed)  : VM 이 현재 실제로 점유한 양(스냅샷·스왑 포함).
 *  · 회수 가능(reclaim)  : Aria Operations 의 Reclaim 분류 중 이 포탈이 **관측할 수 있는** 두 가지
 *                          — 전원 OFF VM 의 커밋 용량 + 스냅샷 크기. 유휴(idle) VM 은 CPU/메모리
 *                          축이라(rightsize 리포트 담당) 제외, 고아(orphaned) 디스크는 데이터스토어
 *                          파일 탐색 없이는 알 수 없어 **추정하지 않는다**(VM 외 사용량으로만 힌트).
 *
 * 정직 원칙: 관측 시작 이전 구간은 결측(null)이며 추정하지 않는다. 증가율은 표본이 정책 하한
 * (점 수·기간)을 넘을 때만 계산하고, 못 미치면 이유를 문장으로 돌려준다.
 */

export const CITATIONS = [
  {
    id: 'aria-reclaim',
    title: 'VMware Aria Operations — Using Reclaim to Free Up Resources (Broadcom TechDocs 8.18)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/optimizing-capacity-and-improving-performance/how-to-optimize-capacity-and-improve-performance/using-reclaim-to-free-up-resources.html',
    usedFor: '회수 가능 자원의 분류(전원 OFF VM · 유휴 VM · 스냅샷 · 고아 디스크) — 이 리포트의 "회수 가능" 정의',
  },
  {
    id: 'aria-reclaim-settings',
    title: 'VMware Aria Operations — Reclamation Settings (Broadcom TechDocs 8.18)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/optimizing-capacity-and-improving-performance/how-to-optimize-capacity-and-improve-performance/using-reclaim-to-free-up-resources/reclamation-settings.html',
    usedFor: '전원 OFF·스냅샷을 "일정 기간 이상" 조건으로 회수 대상에 넣는 방식 — 스냅샷 보존 기준을 정책값으로 둔 근거',
  },
  {
    id: 'kb-snapshot-bp',
    title: 'Best practices for using VMware snapshots in the vSphere environment (Broadcom KB 318825)',
    url: 'https://knowledge.broadcom.com/external/article/318825/best-practices-for-using-vmware-snapshot.html',
    usedFor: '스냅샷은 72시간 이상 보관하지 말 것 — 커질수록 데이터스토어 고갈·성능 저하. "오래된 스냅샷" 판정 기준(72h)',
  },
  {
    id: 'kb-orphaned',
    title: 'Identify Zombie / Orphaned disks in the datastore using VMware Aria Operations (Broadcom KB 383876)',
    url: 'https://knowledge.broadcom.com/external/article/383876/how-to-identify-zombie-orphaned-disks-i.html',
    usedFor: '등록된 VM 에 연결되지 않은 VMDK(고아 디스크)의 정의 — 이 포탈은 파일 탐색 없이 판별할 수 없어 "VM 외 사용량" 으로만 힌트를 준다',
  },
  {
    id: 'vsphere-thin',
    title: 'Virtual Disk Thin Provisioning with vSphere Storage (Broadcom TechDocs, vSphere 9.0 Storage)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/9-0/vsphere-storage/storage-provisioning-and-space-reclamation-in-vsphere/virtual-disk-thin-provisioning-in-vsphere.html',
    usedFor: 'thin 디스크의 프로비저닝(provisioned) 과 실제 사용(used) 의 정의 — 할당 계열과 커밋 계열의 구분',
  },
  {
    id: 'vsphere-oversub',
    title: 'Handling Datastore Over-Subscription (Broadcom TechDocs, vSphere Storage)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/7-0/vsphere-storage/storage-provisioning-and-space-reclamation-in-vsphere/virtual-disk-thin-provisioning-in-vsphere/handling-datastore-over-subscription.html',
    usedFor: '프로비저닝 합이 용량을 넘는 over-subscription 의 위험과 알람 권고 — "오버서브스크립션" 경고 규칙',
  },
  {
    id: 'vsphere-unmap',
    title: 'Space Reclamation on vSphere VMFS Datastores (Broadcom TechDocs, vSphere 8.0 Storage)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/8-0/vsphere-storage/storage-provisioning-and-space-reclamation-in-vsphere/storage-space-reclamation-in-vsphere/space-recalmation-on-vsphere-vmfs-datastores.html',
    usedFor: 'VM 삭제·스냅샷 정리 뒤 배열에 공간을 돌려주는 UNMAP(VMFS6 자동) — 회수 조치 뒤 실제 여유가 늘어나는 조건',
  },
  {
    id: 'kb-ds-alarm',
    title: 'Getting "Datastore usage on disk" alert on datastore (Broadcom KB 392458)',
    url: 'https://knowledge.broadcom.com/external/article/392458/getting-datastore-usage-on-disk-alert-o.html',
    usedFor: 'vCenter 기본 알람 임계 — 경고 75% · 위험 85%. 이 리포트의 사용률 판정선',
  },
  {
    id: 'aria-capacity-tab',
    title: 'VMware Aria Operations — Viewing Object Capacity in the Capacity Tab (Broadcom TechDocs 8.18)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/optimizing-capacity-and-improving-performance/how-to-view-and-assess-capacity/viewing-object-capacity-in-the-capacity-tab.html',
    usedFor: '이력 사용량으로 남은 기간(Time Remaining)을 투영하는 방식 — 증가율·가득 찰 예상일 산정의 근거',
  },
  {
    id: 'aria-ds-dashboard',
    title: 'VMware Aria Operations — Datastore Capacity Dashboard (Broadcom TechDocs 8.18)',
    url: 'https://techdocs.broadcom.com/us/en/vmware-cis/aria/aria-operations/8-18/vmware-aria-operations-configuration-guide-8-18/predefined-dashboards-in-vrealize-operations-manager/capacity-dashboards/datastore-capacity-dashboard.html',
    usedFor: '데이터스토어 용량 대시보드의 구성(용량·사용·프로비저닝·남은 기간) — 이 화면의 KPI 구성',
  },
];

export const DEFAULT_POLICY = Object.freeze({
  warnPct: 75,          // vCenter 기본 알람 경고선(KB 392458)
  critPct: 85,          // vCenter 기본 알람 위험선
  snapshotMaxHours: 72, // KB 318825
  minPoints: 3,         // 증가율 산정 최소 표본
  minSpanDays: 3,       // 증가율 산정 최소 관측 기간
  etaWarnDays: 90,      // 위험선 도달 예상이 이 안이면 경고
  etaCritDays: 30,      // 이 안이면 위험
});

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pct = (a, b) => (b > 0 && a != null ? Math.round((a / b) * 1000) / 10 : null);
/** 문장용 용량 표기 — 1 TB 이상은 TB(소수 1자리), 미만은 GB. */
export const fmtGB = (x) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x) >= 1024 ? `${(Number(x) / 1024).toFixed(1)} TB` : `${Math.round(Number(x) * 10) / 10} GB`);

/** 최소제곱 기울기(y per x). 표본 2 미만·분산 0 이면 null. */
export function slopeOf(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let nu = 0; let de = 0;
  for (let i = 0; i < n; i++) { nu += (xs[i] - mx) * (ys[i] - my); de += (xs[i] - mx) ** 2; }
  return de === 0 ? null : nu / de;
}

/**
 * 현재 스냅샷의 디스크 구성(할당·사용·회수 가능) — 범위 슬라이스(vms/datastores)를 받는다.
 * @param {object[]} vms  스냅샷 VM(범위 적용 후)
 * @param {object[]} datastores 스냅샷 데이터스토어(범위 적용 후)
 */
export function diskBreakdown(vms, datastores, { now = Date.now(), policy: pol } = {}) {
  const policy = { ...DEFAULT_POLICY, ...(pol || {}) };
  const withCap = (datastores || []).filter((d) => num(d.capacityGB) > 0); // 용량 미상은 제외(추정 금지)
  // v2.599 RECENT2599-03: 사용량을 못 읽은 DS(usedGB·freeGB 둘 다 null — v2.598 부터 SOAP 경로도 null 을 낸다)는
  // 용량·사용량 **양쪽에서** 뺀다. 예전에는 capacity − num(null) = capacity 라 그 DS 가 '100% 사용' 으로 세였다.
  // vmtrack diffDatastores 와 같은 규칙이고 뺀 개수를 usageUnknown 으로 밝힌다.
  const usageKnown = (d) => d.usedGB != null || d.freeGB != null;
  const dss = withCap.filter(usageKnown);
  const usageUnknown = withCap.length - dss.length;
  const capGB = dss.reduce((a, d) => a + num(d.capacityGB), 0);
  const usedGB = dss.reduce((a, d) => a + (d.usedGB != null ? num(d.usedGB) : Math.max(0, num(d.capacityGB) - num(d.freeGB))), 0);
  const freeGB = Math.max(0, capGB - usedGB);
  const dsUsagePct = pct(usedGB, capGB);
  const dsPct = (d) => (d.usagePct != null ? num(d.usagePct) : pct(num(d.usedGB), num(d.capacityGB)));
  const warnCount = dss.filter((d) => dsPct(d) >= policy.warnPct && dsPct(d) < policy.critPct).length;
  const critCount = dss.filter((d) => dsPct(d) >= policy.critPct).length;

  const all = vms || [];
  const real = all.filter((v) => !v.template);
  const templates = all.filter((v) => v.template);
  const committedOf = (arr) => arr.reduce((a, v) => a + num(v.storageGB), 0);
  const committedGB = committedOf(real);
  const uncommittedGB = real.reduce((a, v) => a + num(v.uncommittedGB), 0);
  const provGB = committedGB + uncommittedGB;
  const templateGB = committedOf(templates);
  const thin = real.filter((v) => v.thin);
  const on = real.filter((v) => v.powerState === 'POWERED_ON');
  const off = real.filter((v) => v.powerState !== 'POWERED_ON');

  const snaps = real.filter((v) => num(v.snapshotCount) > 0);
  const snapGB = snaps.reduce((a, v) => a + num(v.snapshotSizeGB), 0);
  const maxMs = policy.snapshotMaxHours * 3_600_000;
  const ageDays = (v) => (v.snapshotOldestTs ? Math.floor((now - v.snapshotOldestTs) / 86_400_000) : null);
  const snapOld = snaps.filter((v) => v.snapshotOldestTs && now - v.snapshotOldestTs > maxMs);
  const snapOldGB = snapOld.reduce((a, v) => a + num(v.snapshotSizeGB), 0);
  const snapUnknownAge = snaps.filter((v) => !v.snapshotOldestTs).length;
  const offGB = committedOf(off);
  const reclaimGB = offGB + snapGB;

  // VM 외 사용량 = 데이터스토어 실제 점유 − (VM+템플릿 커밋). ISO·고아 디스크·vSAN 오버헤드·범위 밖 VM 등.
  // 음수(범위 밖 VM 이 그 DS 를 쓰거나 로컬 DS 가 목록에 없을 때)는 의미가 없으므로 null.
  const otherRaw = usedGB - committedGB - templateGB;
  // 사용량을 못 읽은 DS 가 있으면 그 DS 위 VM 커밋은 빼지 못하므로 계산하지 않는다(부분 차이는 거짓).
  const otherGB = capGB > 0 && otherRaw >= 0 && usageUnknown === 0 ? otherRaw : null;

  const top = (arr, fn, n = 10) => [...arr].sort((a, b) => fn(b) - fn(a)).slice(0, n);
  return {
    policy,
    ds: { count: dss.length, usageUnknown, capGB: r1(capGB), usedGB: r1(usedGB), freeGB: r1(freeGB), usagePct: dsUsagePct, warnCount, critCount },
    vm: {
      count: real.length, on: on.length, off: off.length, thinCount: thin.length, templates: templates.length,
      provGB: r1(provGB), committedGB: r1(committedGB), uncommittedGB: r1(uncommittedGB), templateGB: r1(templateGB),
      overcommitPct: pct(provGB, capGB),            // 할당 ÷ 용량 (100 초과 = over-subscription)
      committedPctOfCap: pct(committedGB, capGB),
    },
    reclaim: {
      off: { count: off.length, gb: r1(offGB) },
      snap: { count: snaps.length, gb: r1(snapGB) },
      snapOld: { count: snapOld.length, gb: r1(snapOldGB), maxHours: policy.snapshotMaxHours, unknownAge: snapUnknownAge },
      totalGB: r1(reclaimGB),
      pctOfUsed: pct(reclaimGB, usedGB),
      afterReclaimUsagePct: capGB > 0 ? pct(Math.max(0, usedGB - reclaimGB), capGB) : null,
    },
    other: { gb: r1(otherGB) },
    topOff: top(off, (v) => num(v.storageGB)).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, storageGB: num(v.storageGB), guestOS: v.guestOS || '' })),
    topSnap: top(snaps, (v) => num(v.snapshotSizeGB)).map((v) => ({ id: v.id, name: v.name, vcenterId: v.vcenterId, snapshotCount: num(v.snapshotCount), snapshotSizeGB: r1(num(v.snapshotSizeGB)), ageDays: ageDays(v), powerState: v.powerState })),
  };
}

/**
 * 트렌드 분석 — 시계열(points: {ts, dsCapGB, dsUsedGB, provGB, usedGB, offGB, snapGB}) + 현재 구성.
 * 결측(null)은 건너뛰고, 표본이 정책 하한에 못 미치면 growth 를 null 로 두고 이유를 적는다.
 */
export function analyzeDiskTrend({ points = [], breakdown, days = 30, policy: pol, now = Date.now() } = {}) {
  const policy = { ...DEFAULT_POLICY, ...(breakdown?.policy || {}), ...(pol || {}) };
  const b = breakdown;
  const DAY = 86_400_000;

  const seriesSlope = (key) => {
    const pts = points.filter((p) => p && p[key] != null && Number.isFinite(p.ts));
    if (!pts.length) return { slope: null, n: 0, spanDays: 0 };
    const span = (pts[pts.length - 1].ts - pts[0].ts) / DAY;
    if (pts.length < policy.minPoints || span < policy.minSpanDays) return { slope: null, n: pts.length, spanDays: r1(span) };
    return { slope: slopeOf(pts.map((p) => p.ts / DAY), pts.map((p) => p[key])), n: pts.length, spanDays: r1(span) };
  };
  const used = seriesSlope('dsUsedGB');
  const prov = seriesSlope('provGB');
  const reclaimS = seriesSlope('reclaimGB');
  const growth = {
    usedGBperDay: r1(used.slope), provGBperDay: r1(prov.slope), reclaimGBperDay: r1(reclaimS.slope),
    samples: used.n, spanDays: used.spanDays,
    reason: used.slope == null
      ? (used.n === 0 ? '사용량 시계열이 아직 없습니다(수집 시작 전).'
        : `표본 ${used.n}점 · 관측 ${used.spanDays}일 — 정책 하한(${policy.minPoints}점 · ${policy.minSpanDays}일) 미만이라 증가율을 산정하지 않습니다.`)
      : null,
  };

  const cap = b?.ds?.capGB || 0; const usedNow = b?.ds?.usedGB || 0;
  const eta = (targetPct) => {
    if (used.slope == null || used.slope <= 0.01 || cap <= 0) return null;
    const remain = cap * (targetPct / 100) - usedNow;
    return remain <= 0 ? 0 : Math.round(remain / used.slope);
  };
  const daysToWarn = eta(policy.warnPct);
  const daysToCrit = eta(policy.critPct);
  const daysToFull = eta(100);
  const reclaimGB = b?.reclaim?.totalGB || 0;
  const daysGainedByReclaim = used.slope != null && used.slope > 0.01 ? Math.round(reclaimGB / used.slope) : null;

  const verdicts = [];
  const usagePct = b?.ds?.usagePct;
  if (usagePct != null) {
    if (usagePct >= policy.critPct) verdicts.push({ level: 'crit', key: 'usage', title: `데이터스토어 사용률 ${usagePct}% — 위험선(${policy.critPct}%) 초과`, detail: `vCenter 기본 알람 기준(경고 ${policy.warnPct}% · 위험 ${policy.critPct}%)을 넘었습니다. 위험 데이터스토어 ${b.ds.critCount}개 · 경고 ${b.ds.warnCount}개.`, cite: ['kb-ds-alarm'] });
    else if (usagePct >= policy.warnPct) verdicts.push({ level: 'warn', key: 'usage', title: `데이터스토어 사용률 ${usagePct}% — 경고선(${policy.warnPct}%) 초과`, detail: `위험선 ${policy.critPct}% 까지 ${fmtGB(r1(cap * policy.critPct / 100 - usedNow))} 남았습니다. 위험 데이터스토어 ${b.ds.critCount}개 · 경고 ${b.ds.warnCount}개.`, cite: ['kb-ds-alarm'] });
    else verdicts.push({ level: 'ok', key: 'usage', title: `데이터스토어 사용률 ${usagePct}% — 경고선(${policy.warnPct}%) 이내`, detail: `개별 데이터스토어 중 경고 ${b.ds.warnCount}개 · 위험 ${b.ds.critCount}개(합계가 낮아도 개별 DS 는 찰 수 있습니다).`, cite: ['kb-ds-alarm'] });
  }
  const oc = b?.vm?.overcommitPct;
  if (oc != null) {
    if (oc > 100) verdicts.push({ level: 'warn', key: 'oversub', title: `thin 오버서브스크립션 — 할당(프로비저닝)이 용량의 ${oc}%`, detail: `VM 이 커밋할 수 있는 최대량(${fmtGB(b.vm.provGB)})이 데이터스토어 용량(${fmtGB(cap)})을 넘습니다. thin 디스크가 동시에 채워지면 용량이 부족해지므로 프로비저닝 알람을 두고 증가율을 감시해야 합니다. 미커밋 ${fmtGB(b.vm.uncommittedGB)} 는 "회수 가능" 이 아니라 "아직 쓰지 않은 약속" 입니다.`, cite: ['vsphere-oversub', 'vsphere-thin'] });
    else verdicts.push({ level: 'ok', key: 'oversub', title: `할당(프로비저닝) ${oc}% — 용량 이내`, detail: `VM 최대 커밋 가능량 ${fmtGB(b.vm.provGB)} ≤ 용량 ${fmtGB(cap)}. thin 디스크 ${b.vm.thinCount}대의 미커밋 ${fmtGB(b.vm.uncommittedGB)} 가 채워져도 용량을 넘지 않습니다.`, cite: ['vsphere-thin'] });
  }
  if (b?.reclaim) {
    const r = b.reclaim;
    verdicts.push({
      level: r.totalGB > 0 ? 'info' : 'ok', key: 'reclaim',
      title: `회수 가능 ${fmtGB(r.totalGB)} — 정지 VM ${r.off.count}대(${fmtGB(r.off.gb)}) + 스냅샷 ${r.snap.count}대(${fmtGB(r.snap.gb)})`,
      detail: r.totalGB > 0
        ? `사용량의 ${r.pctOfUsed}% 입니다. 전부 회수하면 사용률 ${usagePct}% → ${r.afterReclaimUsagePct}%${daysGainedByReclaim != null ? `, 현재 증가율 기준 약 ${daysGainedByReclaim}일치 여유` : ''}. 회수 뒤 배열에 공간이 돌아가려면 UNMAP(VMFS6 자동)이 동작해야 합니다. 유휴 VM·고아 디스크는 이 수치에 포함되지 않습니다(관측 불가).`
        : '정지 VM 과 스냅샷이 없어 이 방식으로 회수할 용량이 없습니다.',
      cite: ['aria-reclaim', 'vsphere-unmap'],
    });
    if (r.snapOld.count > 0) verdicts.push({ level: 'warn', key: 'snapshot-age', title: `${r.snapOld.maxHours}시간 넘은 스냅샷 ${r.snapOld.count}대(${fmtGB(r.snapOld.gb)})`, detail: `스냅샷은 오래 둘수록 커져 데이터스토어를 고갈시키고 성능을 떨어뜨립니다(권고: 72시간 이내 삭제). 백업 소프트웨어가 남긴 스냅샷이면 백업 성공 후 삭제됐는지 확인하세요.${r.snapOld.unknownAge ? ` 생성 시각을 모르는 스냅샷 ${r.snapOld.unknownAge}대는 나이 판정에서 제외했습니다.` : ''}`, cite: ['kb-snapshot-bp', 'aria-reclaim-settings'] });
  }
  if (b?.other?.gb != null && cap > 0 && b.other.gb > cap * 0.05) {
    verdicts.push({ level: 'info', key: 'other', title: `VM 외 사용량 ${fmtGB(b.other.gb)} (용량의 ${pct(b.other.gb, cap)}%)`, detail: '데이터스토어 실제 점유에서 VM·템플릿 커밋을 뺀 값입니다. ISO·콘텐츠 라이브러리·vSAN/VMFS 오버헤드·범위 밖 VM 외에 **고아 디스크(등록된 VM 에 연결되지 않은 VMDK)** 가 섞여 있을 수 있습니다. 이 포탈은 파일 탐색을 하지 않아 고아 디스크를 판별하지 못하므로 vCenter 데이터스토어 브라우저 또는 Aria Operations 로 확인하세요.', cite: ['kb-orphaned'] });
  }
  if (growth.usedGBperDay != null) {
    if (daysToCrit != null && daysToCrit <= policy.etaCritDays) verdicts.push({ level: 'crit', key: 'eta', title: `현재 증가율(${fmtGB(growth.usedGBperDay)}/일)이면 ${daysToCrit}일 뒤 위험선(${policy.critPct}%) 도달`, detail: `관측 ${growth.spanDays}일 · ${growth.samples}점의 최소제곱 기울기입니다. 가득 찰 예상 ${daysToFull ?? '—'}일. 증설 또는 회수 조치가 필요합니다.`, cite: ['aria-capacity-tab'] });
    else if (daysToCrit != null && daysToCrit <= policy.etaWarnDays) verdicts.push({ level: 'warn', key: 'eta', title: `현재 증가율(${fmtGB(growth.usedGBperDay)}/일)이면 ${daysToCrit}일 뒤 위험선(${policy.critPct}%) 도달`, detail: `관측 ${growth.spanDays}일 · ${growth.samples}점 기준. 경고선 도달 ${daysToWarn ?? '—'}일 · 가득 참 ${daysToFull ?? '—'}일.`, cite: ['aria-capacity-tab'] });
    else verdicts.push({ level: growth.usedGBperDay <= 0 ? 'ok' : 'info', key: 'eta', title: growth.usedGBperDay <= 0 ? `사용량 증가 없음(${fmtGB(growth.usedGBperDay)}/일)` : `증가율 ${fmtGB(growth.usedGBperDay)}/일 — 위험선까지 ${daysToCrit ?? '—'}일`, detail: `관측 ${growth.spanDays}일 · ${growth.samples}점 기준${daysToFull != null ? ` · 가득 찰 예상 ${daysToFull}일` : ''}. 할당(프로비저닝) 증가율 ${fmtGB(growth.provGBperDay ?? '—')}/일.`, cite: ['aria-capacity-tab'] });
  } else {
    verdicts.push({ level: 'insufficient', key: 'eta', title: '증가율·가득 찰 예상일 — 근거 부족으로 산정하지 않음', detail: growth.reason, cite: ['aria-capacity-tab'] });
  }

  const order = { crit: 0, warn: 1, insufficient: 2, info: 3, ok: 4 };
  verdicts.sort((x, y) => order[x.level] - order[y.level]);
  const worst = verdicts[0]?.level || 'ok';

  const methodology = [
    `용량 = 데이터스토어 capacity 합, 사용 = capacity − freeSpace 합(VM 외 파일 포함), 할당 = VM committed + uncommitted 합(VM 이 최대로 커밋할 수 있는 양), VM 커밋 = committed 합. 템플릿은 VM 통계에서 빼고 "VM 외 사용량" 계산에만 더합니다.`,
    `회수 가능 = 전원 OFF VM 의 커밋 용량 + 스냅샷 크기(Aria Operations Reclaim 분류 중 이 포탈이 관측 가능한 두 가지). 유휴 VM·고아 디스크·thin 미커밋은 포함하지 않습니다.`,
    `사용률 판정선은 vCenter 기본 알람(경고 ${policy.warnPct}% · 위험 ${policy.critPct}%), 스냅샷 나이 기준은 ${policy.snapshotMaxHours}시간입니다. 정책은 서버 env(DISKTREND_WARN_PCT · DISKTREND_CRIT_PCT · DISKTREND_SNAPSHOT_MAX_HOURS)로 바꿀 수 있습니다.`,
    `증가율은 최근 ${days}일 사용량 시계열의 최소제곱 기울기(GB/일)이며 표본 ${policy.minPoints}점·관측 ${policy.minSpanDays}일 이상일 때만 산정합니다. 예상일 = (임계 용량 − 현재 사용) ÷ 증가율.`,
    `시계열은 포탈 샘플러가 vCenter 인벤토리 스냅샷을 주기 집계해 저장한 값(용량/사용은 v2.377 부터, 할당/커밋/정지/스냅샷은 v2.446 부터)입니다. 그 이전 구간은 결측이며 소급 추정하지 않습니다.`,
  ];

  return {
    days, policy, growth,
    eta: { daysToWarn, daysToCrit, daysToFull, daysGainedByReclaim },
    verdicts, worst, methodology, citations: CITATIONS,
    generatedAt: now,
  };
}

/** env → 정책(빈 값은 기본값 유지). */
export function diskTrendPolicyFromEnv(env = process.env) {
  const p = {};
  const set = (k, v) => { const n = Number(v); if (v != null && v !== '' && Number.isFinite(n) && n > 0) p[k] = n; };
  set('warnPct', env.DISKTREND_WARN_PCT);
  set('critPct', env.DISKTREND_CRIT_PCT);
  set('snapshotMaxHours', env.DISKTREND_SNAPSHOT_MAX_HOURS);
  return p;
}
