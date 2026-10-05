/**
 * corelicense/analyze.js — 특수 기능 '코어 라이선스 산정'(도구 키 `core-license`, v2.703 — A13) 판정(순수).
 * 입력은 스냅샷(vcenters·hosts·datastores). vCenter 왕복 0.
 *
 * 산정 규칙(Broadcom 코어 단위 구독 — 정직 기록: 공식 문서는 이 환경에서 확인하지 못했고 공개 공지 기준이다)
 *  · 호스트 필요 코어 = 소켓 수 × max(소켓당 최소 16, 소켓당 코어). 소켓당 코어는 '코어 ÷ 소켓' 올림.
 *  · 소켓 수나 코어 수를 못 읽은 호스트는 **산정하지 않고 따로 센다**(1 소켓·16 코어로 지어내지 않는다).
 *  · 끊긴 호스트도 라이선스 대상이다(하드웨어는 그대로다) — 사용률 계산과 다르다. 다만 몇 대인지 밝힌다.
 *  · vSAN 은 vSAN 데이터스토어의 **용량 합(TiB)** 만 낸다. 포함 용량(코어당 TiB)은 에디션·계약마다 달라
 *    가정값(`vsanTibPerCore`)을 화면이 밝히고, 사람이 고른다.
 *  · vCenter 가 보고한 코어 단위 라이선스(costUnit 'core')의 사용량과 나란히 둔다 — 둘이 다르면 그 사실만 말한다.
 */
export const MIN_CORES_PER_SOCKET = 16;
export const VSAN_TIB_PER_CORE = Object.freeze({ none: 0, vvf: 0.25, vcf: 1 });

/** @returns {{sockets:number, cores:number, perSocket:number, licensed:number, padded:number}|null} */
export function hostCoreLicense(h) {
  const sockets = Number(h?.cpuSockets);
  const cores = Number(h?.cpuCores);
  if (!Number.isFinite(sockets) || sockets <= 0 || !Number.isFinite(cores) || cores <= 0) return null;
  const perSocket = Math.ceil(cores / sockets);
  const licensed = sockets * Math.max(MIN_CORES_PER_SOCKET, perSocket);
  return { sockets, cores, perSocket, licensed, padded: licensed - cores };
}

const GIB_PER_TIB = 1024;

export function analyzeCoreLicense(snap, { vcenterIds = null, vsanPlan = 'none' } = {}) {
  const allow = vcenterIds ? new Set(vcenterIds) : null;
  const vcs = (snap?.vcenters || []).filter((v) => !allow || allow.has(v.id));
  const rate = VSAN_TIB_PER_CORE[vsanPlan] ?? 0;
  const rows = new Map(vcs.map((v) => [v.id, {
    vcenterId: v.id, vcenterName: v.name || v.id, hosts: 0, counted: 0, unknown: 0, disconnected: 0,
    sockets: 0, cores: 0, licensed: 0, padded: 0, paddedHosts: 0,
    vsanTib: 0, vsanDs: 0, vsanUnknown: 0, reportedCoreUsed: null, reportedCoreTotal: null, coreLicenses: 0,
  }]));
  const hostRows = [];
  for (const h of snap?.hosts || []) {
    const r = rows.get(h.vcenterId);
    if (!r) continue;
    r.hosts += 1;
    if (h.connectionState === 'DISCONNECTED' || h.connectionState === 'NOT_RESPONDING') r.disconnected += 1;
    const c = hostCoreLicense(h);
    if (!c) { r.unknown += 1; hostRows.push({ vcenterId: h.vcenterId, name: h.name, cluster: h.cluster, unknown: true, cores: Number(h.cpuCores) || null, sockets: Number(h.cpuSockets) || null }); continue; }
    r.counted += 1; r.sockets += c.sockets; r.cores += c.cores; r.licensed += c.licensed; r.padded += c.padded;
    if (c.padded > 0) r.paddedHosts += 1;
    hostRows.push({ vcenterId: h.vcenterId, name: h.name, cluster: h.cluster, unknown: false, ...c });
  }
  for (const d of snap?.datastores || []) {
    const r = rows.get(d.vcenterId);
    if (!r || !/vsan/i.test(d.type || '')) continue;
    r.vsanDs += 1;
    const cap = Number(d.capacityGB);
    if (Number.isFinite(cap) && cap > 0) r.vsanTib += cap / GIB_PER_TIB; else r.vsanUnknown += 1;
  }
  for (const v of vcs) {
    const r = rows.get(v.id);
    const core = (Array.isArray(v.licenses) ? v.licenses : []).filter((l) => String(l?.costUnit || '').toLowerCase() === 'core');
    if (core.length) {
      r.coreLicenses = core.length;
      r.reportedCoreUsed = core.reduce((a, l) => a + (Number(l.used) > 0 ? Number(l.used) : 0), 0);
      r.reportedCoreTotal = core.reduce((a, l) => a + (Number(l.total) > 0 ? Number(l.total) : 0), 0);
    }
  }
  const list = [...rows.values()].map((r) => {
    const vsanTib = Math.round(r.vsanTib * 100) / 100;
    const included = r.licensed * rate;
    return {
      ...r, vsanTib,
      vsanIncludedTib: rate ? Math.round(included * 100) / 100 : null,
      vsanAddonTib: rate ? Math.max(0, Math.round((vsanTib - included) * 100) / 100) : null,
      // vCenter 보고와의 차이 — 산정 못 한 호스트가 있으면 비교하지 않는다(부분 합끼리 비교하면 거짓 차이).
      reportedDiff: r.reportedCoreUsed != null && r.unknown === 0 ? r.reportedCoreUsed - r.licensed : null,
    };
  }).sort((a, b) => b.licensed - a.licensed || String(a.vcenterName).localeCompare(String(b.vcenterName)));
  const sum = (k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = {
    vcenters: list.length, hosts: sum('hosts'), counted: sum('counted'), unknown: sum('unknown'), disconnected: sum('disconnected'),
    sockets: sum('sockets'), cores: sum('cores'), licensed: sum('licensed'), padded: sum('padded'), paddedHosts: sum('paddedHosts'),
    vsanTib: Math.round(sum('vsanTib') * 100) / 100, vsanUnknown: sum('vsanUnknown'),
    vsanIncludedTib: rate ? Math.round(sum('licensed') * rate * 100) / 100 : null,
  };
  // 포함 용량은 계약 전체에서 합쳐진다(법인별 초과를 더하면 다른 법인의 남는 몫을 무시해 과대가 된다) — 합계는 전체 기준.
  totals.vsanAddonTib = rate ? Math.max(0, Math.round((totals.vsanTib - totals.licensed * rate) * 100) / 100) : null;
  hostRows.sort((a, b) => (b.padded ?? -1) - (a.padded ?? -1) || String(a.name).localeCompare(String(b.name)));
  return { rule: { minCoresPerSocket: MIN_CORES_PER_SOCKET, vsanPlan, vsanTibPerCore: rate }, totals, vcenters: list, hosts: hostRows.slice(0, 3000), hostsOmitted: Math.max(0, hostRows.length - 3000) };
}
