/**
 * 하드웨어 파트 인벤토리 집계(순수 함수) — '서버 분석 › 파트' 탭의 두 라우트가 공유한다.
 *
 * 원칙:
 *  - 입력은 (서버 목록, 서버→inv 함수)로 받아 라우트/캐시와 분리(테스트 가능).
 *  - 카테고리별로 inv 의 서로 다른 배열을 '설치 단위(unit) 1개 = 항목 1개'로 펼친 뒤
 *    라벨(모델 조합) 기준으로 버킷팅한다 — "어떤 장비가 몇 개, 어느 서버에" 질문에 답하는 구조.
 *  - 필드가 없는 세대/라이선스도 있으므로 라벨 폴백('미상')을 두되, 식별 불가 항목을
 *    조용히 떨어뜨리지 않는다(수량이 실물과 달라지면 자산 파악이 틀어짐).
 *  - NIC 의 '(EthernetInterfaces)' 합성 항목(속도 폴백용 가상 어댑터)은 실물 파트가 아니므로 제외.
 */

const t = (v) => String(v ?? '').trim();
const label = (...parts) => parts.map(t).filter(Boolean).join(' ') || '미상';

// 카테고리 정의: inv 에서 유닛 배열을 뽑고, 유닛 1개를 {label, detail} 로 표준화.
export const PART_CATS = [
  { cat: 'cpu', name: 'CPU', units: (inv) => {
    const arr = Array.isArray(inv.cpus) ? inv.cpus : [];
    if (arr.length) return arr.map((c) => ({ label: label(c.model), detail: [c.cores && `${c.cores}C`, c.maxSpeedMHz && `${(c.maxSpeedMHz / 1000).toFixed(1)}GHz`].filter(Boolean).join(' ') }));
    // 개별 소켓 미수집(구 인벤토리·엣지 콤팩트 구버전) 폴백 — 요약(cpu.model×count)으로 근사.
    const m = t(inv.cpu?.model);
    return m ? Array.from({ length: Math.max(1, Number(inv.cpu?.count) || 1) }, () => ({ label: m, detail: '' })) : [];
  } },
  { cat: 'gpu', name: 'GPU', units: (inv) => (inv.gpus || []).map((g) => ({ label: label(g.model || g.name), detail: t(g.manufacturer) })) },
  { cat: 'dimm', name: '메모리(DIMM)', units: (inv) => (inv.memoryDimms || []).map((m) => ({
    label: label(m.manufacturer, m.sizeGB && `${m.sizeGB}GB`, m.type, m.speedMHz && `${m.speedMHz}MHz`),
    detail: t(m.partNumber),
  })) },
  { cat: 'disk', name: '디스크', units: (inv) => (inv.disks || []).map((d) => ({
    label: label(d.model, d.capacityGB && `${d.capacityGB}GB`, d.media),
    detail: t(d.protocol),
  })) },
  { cat: 'controller', name: '스토리지 컨트롤러', units: (inv) => (inv.storageControllers || []).map((c) => ({
    label: label(c.model || c.name), detail: t(c.protocols),
  })) },
  { cat: 'nic', name: 'NIC', units: (inv) => (inv.nics || [])
    .filter((n) => t(n.model) !== '(EthernetInterfaces)')
    .map((n) => ({ label: label(n.model || n.name), detail: (n.ports || []).length ? `${n.ports.length}포트` : '' })) },
  { cat: 'psu', name: 'PSU', units: (inv) => (inv.psus || []).map((p) => ({
    label: label(p.model, p.capacityWatts && `${p.capacityWatts}W`), detail: t(p.manufacturer),
  })) },
  { cat: 'pcie', name: 'PCIe 카드', units: (inv) => (inv.pcie || [])
    .filter((d) => t(d.model) || t(d.name))
    .map((d) => ({ label: label(d.model || d.name), detail: t(d.deviceType) })) },
  { cat: 'fan', name: '팬', units: (inv) => (inv.fans || []).map((f) => ({
    label: label(f.model || f.partNumber || '팬(모델 미상)'), detail: '',
  })) },
];

const CAT_BY_KEY = new Map(PART_CATS.map((c) => [c.cat, c]));
export const isPartCat = (cat) => CAT_BY_KEY.has(String(cat || ''));

/** 한 서버 inv 에서 카테고리의 유닛 목록. cat 미지정이면 전 카테고리(각 유닛에 cat 부여). */
export function partsOfInv(inv, cat = '') {
  if (!inv) return [];
  const defs = cat ? [CAT_BY_KEY.get(cat)].filter(Boolean) : PART_CATS;
  const out = [];
  for (const d of defs) {
    for (const u of d.units(inv)) out.push({ cat: d.cat, catName: d.name, label: u.label, detail: u.detail || '' });
  }
  return out;
}

/**
 * 파트 버킷 집계. servers: [{id,name,...}], invFor: (s)=>inv|null.
 * 반환: { buckets:[{cat,catName,key,label,detail,count,serverCount}], collected, total, missing }
 * 버킷에 서버 목록은 싣지 않는다 — 1,069대 규모에서 버킷×서버 목록은 응답을 MB 단위로 키운다.
 * 서버 목록은 serversWithPart(드릴다운 전용)로 따로 조회한다.
 */
export function partBuckets(servers, invFor, { cat = '', q = '' } = {}) {
  const needle = t(q).toLowerCase();
  const buckets = new Map(); // key -> bucket
  const missing = [];
  let collected = 0;
  for (const s of servers) {
    const inv = invFor(s);
    if (!inv) { missing.push({ id: s.id, name: s.name }); continue; }
    collected++;
    for (const u of partsOfInv(inv, cat)) {
      if (needle && !`${u.label} ${u.detail}`.toLowerCase().includes(needle)) continue;
      const key = `${u.cat}|${u.label}`;
      let b = buckets.get(key);
      if (!b) { b = { cat: u.cat, catName: u.catName, key, label: u.label, detail: u.detail, count: 0, servers: new Set() }; buckets.set(key, b); }
      b.count++;
      b.servers.add(String(s.id));
      if (!b.detail && u.detail) b.detail = u.detail;
    }
  }
  return {
    buckets: [...buckets.values()]
      .map(({ servers: sv, ...b }) => ({ ...b, serverCount: sv.size }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    collected, total: servers.length, missing,
  };
}

/** 드릴다운 — key(`cat|label`)에 해당하는 파트를 가진 서버 목록(서버당 수량 포함). */
export function serversWithPart(servers, invFor, key) {
  const [cat, ...rest] = String(key || '').split('|');
  const wantLabel = rest.join('|');
  if (!isPartCat(cat) || !wantLabel) return null; // 잘못된 key — 라우트가 400 처리
  const out = [];
  for (const s of servers) {
    const inv = invFor(s);
    if (!inv) continue;
    const units = partsOfInv(inv, cat).filter((u) => u.label === wantLabel);
    if (!units.length) continue;
    const host = t(s.host).replace(/^https?:\/\//, '');
    const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(t(v));
    out.push({
      id: s.id, name: s.name, host,
      // 호스트네임 — ① iDRAC 이 보고한 OS 호스트명(inv.system.hostName) ② 표시명이 IP 가
      // 아니면 그것(엣지가 hostname 을 이름으로 내보내는 경우). vCenter 스냅샷 폴백(서비스태그
      // 매칭)은 스냅샷 접근이 필요해 라우트에서 보충한다.
      hostname: t(inv.system?.hostName) || (!isIp(s.name) && t(s.name) !== host ? t(s.name) : ''),
      serviceTag: s.serviceTag || inv.system?.serviceTag || '', vcenterId: s.vcenterId || '',
      model: inv.system?.model || s.model || '', remote: !!s.remote, count: units.length,
    });
  }
  return out.sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
}
