/**
 * IPAM 추천 기능 30선 — 업계에서 가장 널리 쓰이는 IPAM 솔루션
 * (phpIPAM · NetBox · SolarWinds IPAM · Infoblox · GestióIP · Device42 · ManageEngine OpUtils)의
 * 대표 기능을, 포탈이 이미 수집한 IP 대장(vCenter 인식 + 능동 스캔) 데이터로 '실제 계산'해 제공한다.
 *
 * 데이터 소스: buildIpamRows(snap, vcenterId) — ip/scope/discovery/openPorts/services/
 * firstSeen/lastSeen/usageStatus/multiHomed/duplicate/osName 등.
 * 새 수집 없이 O(N)으로 계산(논블로킹). 30개 항목은 features[]로 반환.
 */

import { buildIpamRows, ipToNum } from './ledger.js';

const DAY = 86_400_000;
// 외부 노출 시 위험한 포트(원격/평문/DB) — SolarWinds/Lansweeper 류의 '위험 포트 노출' 점검.
const RISKY_PORTS = new Map([
  [23, 'Telnet(평문)'], [21, 'FTP(평문)'], [3389, 'RDP'], [5900, 'VNC'], [445, 'SMB'],
  [139, 'NetBIOS'], [135, 'MS-RPC'], [1433, 'MSSQL'], [3306, 'MySQL'], [5432, 'PostgreSQL'],
  [6379, 'Redis'], [27017, 'MongoDB'], [9200, 'Elasticsearch'], [11211, 'Memcached'], [2375, 'Docker'],
]);

const octets = (ip) => String(ip).split('.').map(Number);

/** /24 서브넷별 집계 — 사용/여유/사용률/게이트웨이/다음가용/최대연속여유/응답률. */
function buildSubnets(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.ipNum == null) continue;
    const p = octets(r.ip);
    if (p.length !== 4) continue;
    const base = `${p[0]}.${p[1]}.${p[2]}`;
    const host = p[3];
    let s = map.get(base);
    if (!s) { s = { base, used: new Set(), gateway: false, alive: 0, scanned: 0, vcs: new Set() }; map.set(base, s); }
    if (host >= 1 && host <= 254) s.used.add(host);
    if (host === 1) s.gateway = true;
    if (r.vcenterName) s.vcs.add(r.vcenterName);
    if (r.discovery === 'scan' || r.discovery === 'both') {
      s.scanned++;
      if (r.usageStatus !== 'down' && r.powerState !== 'POWERED_OFF') s.alive++;
    }
  }
  const out = [];
  for (const s of map.values()) {
    const usedN = s.used.size;
    const free = 254 - usedN;
    // 다음 가용 IP + 최대 연속 여유 블록(SolarWinds '올바른 크기 서브넷 자동 할당'의 기반).
    let nextFree = null, run = 0, best = 0;
    for (let i = 1; i <= 254; i++) {
      if (!s.used.has(i)) { if (nextFree == null) nextFree = i; run++; if (run > best) best = run; }
      else run = 0;
    }
    out.push({
      base: s.base, cidr: `${s.base}.0/24`, used: usedN, free, total: 254,
      utilizationPct: Math.round((usedN / 254) * 100),
      gateway: s.gateway ? `${s.base}.1` : null,
      nextFree: nextFree != null ? `${s.base}.${nextFree}` : null,
      largestFreeBlock: best,
      aliveRatio: s.scanned ? Math.round((s.alive / s.scanned) * 100) : null,
      vcenters: [...s.vcs],
    });
  }
  out.sort((a, b) => b.utilizationPct - a.utilizationPct || ipToNum(`${a.base}.0`) - ipToNum(`${b.base}.0`));
  return out;
}

/** 30개 추천 기능 카탈로그를 계산해 반환. */
export function buildIpamInsights(snap, vcenterId = '') {
  const { rows } = buildIpamRows(snap, vcenterId);
  const now = Date.now();
  const ipv4 = rows.filter((r) => r.ipNum != null && octets(r.ip).length === 4);
  const ipv6 = rows.filter((r) => /:/.test(String(r.ip)));
  const subnets = buildSubnets(ipv4);

  // 공통 집계
  const dupMap = new Map();
  for (const r of ipv4) dupMap.set(r.ip, (dupMap.get(r.ip) || 0) + 1);
  const duplicates = [...dupMap.entries()].filter(([, c]) => c > 1).map(([ip, c]) => ({ ip, count: c }));
  const hostNameMap = new Map();
  for (const r of ipv4) { const h = (r.ownerName || r.hostName || '').trim().toLowerCase(); if (h) { const a = hostNameMap.get(h) || []; a.push(r.ip); hostNameMap.set(h, a); } }
  const dupHosts = [...hostNameMap.entries()].filter(([, ips]) => new Set(ips).size > 1).map(([h, ips]) => ({ hostName: h, ips: [...new Set(ips)] }));
  const rogue = ipv4.filter((r) => r.discovery === 'scan'); // 스캔으로만 보이고 vCenter가 모르는 IP
  const released = ipv4.filter((r) => r.released || r.usageStatus === 'down');
  const poweredOff = ipv4.filter((r) => r.powerState === 'POWERED_OFF' && !r.released);
  const multiHomed = ipv4.filter((r) => r.multiHomed);
  const publicIps = ipv4.filter((r) => r.scope === 'public');
  const withPorts = ipv4.filter((r) => (r.openPorts || []).length);
  const risky = [];
  for (const r of ipv4) for (const p of (r.openPorts || [])) if (RISKY_PORTS.has(Number(p))) risky.push({ ip: r.ip, port: Number(p), label: RISKY_PORTS.get(Number(p)) });
  const newIps = ipv4.filter((r) => r.firstSeen && now - r.firstSeen < 7 * DAY);
  const staleIps = ipv4.filter((r) => r.lastSeen && now - r.lastSeen > 30 * DAY);
  const noGateway = subnets.filter((s) => !s.gateway);
  const nearFull = subnets.filter((s) => s.utilizationPct >= 80);
  const osCount = new Map();
  for (const r of ipv4) { const o = (r.osName || '').trim(); if (o) osCount.set(o, (osCount.get(o) || 0) + 1); }
  const svcCount = new Map();
  for (const r of ipv4) for (const s of (r.services || [])) svcCount.set(s, (svcCount.get(s) || 0) + 1);
  const totalUsed = subnets.reduce((a, s) => a + s.used, 0);
  const totalCap = subnets.length * 254;
  const overallUtil = totalCap ? Math.round((totalUsed / totalCap) * 100) : 0;
  const scannedN = ipv4.filter((r) => r.discovery === 'scan' || r.discovery === 'both').length;
  const coverage = ipv4.length ? Math.round((scannedN / ipv4.length) * 100) : 0;
  const topN = (arr, n = 10) => arr.slice(0, n);

  // ── 30개 기능 카탈로그 ────────────────────────────────────────────────
  // 각 항목: { n, key, title, tool(영감을 준 솔루션), value(요약), detail, severity, items? }
  const F = [];
  const add = (key, title, tool, value, detail, opts = {}) => F.push({ n: F.length + 1, key, title, tool, value, detail, severity: opts.severity || 'info', items: opts.items });

  add('subnet-util', '서브넷 사용률', 'NetBox · SolarWinds', `${subnets.length}개 서브넷 · 전체 ${overallUtil}%`,
    '발견된 /24 서브넷별 사용/여유/사용률을 자동 계산합니다.', { items: topN(subnets.map((s) => ({ label: s.cidr, value: `${s.used}/254 (${s.utilizationPct}%)` }))) });
  add('near-full', '가득 찬 서브넷 경고', 'SolarWinds IPAM', `${nearFull.length}개 ≥80%`,
    '사용률 80% 이상 서브넷을 경고합니다(고갈 임박).', { severity: nearFull.length ? 'warn' : 'info', items: topN(nearFull.map((s) => ({ label: s.cidr, value: `${s.utilizationPct}%` }))) });
  add('next-free', '다음 사용 가능 IP', 'phpIPAM', `${subnets.filter((s) => s.nextFree).length}개 서브넷 제안`,
    '서브넷별 가장 낮은 미사용 IP를 즉시 제안합니다(할당 자동화).', { items: topN(subnets.filter((s) => s.nextFree).map((s) => ({ label: s.cidr, value: s.nextFree }))) });
  add('free-block', '최대 연속 가용 블록', 'SolarWinds IPAM', `최대 ${Math.max(0, ...subnets.map((s) => s.largestFreeBlock))}개 연속`,
    '서브넷별 가장 긴 연속 미사용 구간 — 올바른 크기의 새 서브넷/풀 할당에 사용.', { items: topN(subnets.map((s) => ({ label: s.cidr, value: `${s.largestFreeBlock}개 연속 여유` }))) });
  add('duplicate', '중복 IP 충돌 탐지', '공통(전체)', `${duplicates.length}건`,
    '둘 이상의 자원이 같은 IPv4를 쓰는 충돌을 탐지합니다.', { severity: duplicates.length ? 'warn' : 'info', items: topN(duplicates.map((d) => ({ label: d.ip, value: `${d.count}개 자원` }))) });
  add('rogue', '미등록(Rogue) IP', 'SolarWinds · OpUtils', `${rogue.length}개`,
    'vCenter는 모르지만 능동 스캔에서 살아있는 IP — 미등록 장비/섀도 IT 의심.', { severity: rogue.length ? 'warn' : 'info', items: topN(rogue.map((r) => ({ label: r.ip, value: r.ownerName || '(호스트명 없음)' }))) });
  add('reclaim', '회수 가능 IP', 'SolarWinds IPAM', `${released.length + poweredOff.length}개`,
    '응답이 끊겼거나(released) 전원 꺼진 VM이 점유 중인 IP — 회수 후보.', { severity: (released.length + poweredOff.length) ? 'warn' : 'info', items: topN([...released, ...poweredOff].map((r) => ({ label: r.ip, value: r.released ? '응답 없음' : '전원 꺼짐' }))) });
  add('gateway', '게이트웨이 자동 탐지', 'phpIPAM', `${subnets.filter((s) => s.gateway).length}/${subnets.length} 서브넷`,
    '서브넷별 .1 게이트웨이 존재 여부를 점검합니다.', { severity: noGateway.length ? 'warn' : 'info', items: topN(noGateway.map((s) => ({ label: s.cidr, value: '게이트웨이(.1) 미발견' }))) });
  add('alive-ratio', '핑 응답률(가용성)', 'OpUtils · SolarWinds', `스캔 ${scannedN}개`,
    '스캔된 IP의 살아있는 비율을 서브넷별로 보여줍니다.', { items: topN(subnets.filter((s) => s.aliveRatio != null).map((s) => ({ label: s.cidr, value: `${s.aliveRatio}% 응답` }))) });
  add('coverage', '스캔 커버리지', 'NetBox · Device42', `${coverage}%`,
    'vCenter 인식 IP 중 능동 스캔으로도 확인된 비율(검증 커버리지).', {});
  add('public', '공인 IP 노출', 'Infoblox · NetBox', `${publicIps.length}개`,
    '사설(RFC1918)이 아닌 공인 IP를 식별합니다(외부 노출 관리).', { severity: publicIps.length ? 'warn' : 'info', items: topN(publicIps.map((r) => ({ label: r.ip, value: r.ownerName || '' }))) });
  add('risky-ports', '위험 포트 노출', 'Lansweeper · OpUtils', `${risky.length}건`,
    'Telnet/RDP/SMB/DB 등 위험 포트가 열린 IP를 점검합니다.', { severity: risky.length ? 'warn' : 'info', items: topN(risky.map((r) => ({ label: `${r.ip}:${r.port}`, value: r.label }))) });
  add('services', '서비스/포트 맵', 'Device42', `${withPorts.length}개 IP에 포트`,
    '스캔으로 식별한 오픈 포트/서비스 분포(자산 식별).', { items: topN([...svcCount.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ label: s, value: `${c}개` }))) });
  add('multihomed', '멀티홈 호스트', 'NetBox', `${multiHomed.length}개`,
    'IP를 2개 이상 가진 VM/호스트(NIC 다중) 목록.', { items: topN(multiHomed.map((r) => ({ label: r.ip, value: r.ownerName || '' }))) });
  add('dup-hostname', '중복 호스트명', 'Infoblox(DNS)', `${dupHosts.length}건`,
    '같은 호스트명이 여러 IP에 매핑된 경우(DNS/명명 충돌).', { severity: dupHosts.length ? 'warn' : 'info', items: topN(dupHosts.map((d) => ({ label: d.hostName, value: d.ips.join(', ') }))) });
  add('ptr', 'DNS 레코드 제안(정방향/PTR)', 'Infoblox · NetBox', `${ipv4.filter((r) => (r.ownerName || r.hostName)).length}개 매핑`,
    '호스트명↔IP 매핑으로 A/PTR 레코드 초안을 만들 수 있습니다.', { items: topN(ipv4.filter((r) => r.ownerName).map((r) => ({ label: r.ip, value: r.ownerName }))) });
  add('new-ip', '신규 IP(최근 7일)', 'SolarWinds(변경)', `${newIps.length}개`,
    '최근 7일 내 처음 발견된 IP — 신규 장비/변경 추적.', { items: topN(newIps.map((r) => ({ label: r.ip, value: r.ownerName || '' }))) });
  add('stale', '오래된 IP(30일+ 미응답)', 'NetBox · OpUtils', `${staleIps.length}개`,
    '30일 이상 스캔에서 안 보인 IP — 정리 후보.', { severity: staleIps.length ? 'warn' : 'info', items: topN(staleIps.map((r) => ({ label: r.ip, value: r.lastSeen ? `${Math.round((now - r.lastSeen) / DAY)}일 전` : '' }))) });
  add('os-dist', 'OS 분포', 'Device42 · Lansweeper', `${osCount.size}종`,
    'IP에 매핑된 게스트 OS 분포(자산 관리).', { items: topN([...osCount.entries()].sort((a, b) => b[1] - a[1]).map(([o, c]) => ({ label: o, value: `${c}개` }))) });
  add('vlan-site', '서브넷↔법인(사이트) 매핑', 'NetBox(VLAN/Site)', `${subnets.length}개`,
    '서브넷이 어느 vCenter(법인/사이트)에 속하는지 매핑합니다.', { items: topN(subnets.map((s) => ({ label: s.cidr, value: s.vcenters.join(', ') || '(미상)' }))) });
  add('ipv6', 'IPv6 인식', 'NetBox(IPv6 parity)', `${ipv6.length}개`,
    'IPv6 주소 존재 여부를 함께 추적합니다.', { items: topN(ipv6.map((r) => ({ label: r.ip, value: r.ownerName || '' }))) });
  add('forecast', '서브넷 고갈 예측', 'SolarWinds(예측)', `${nearFull.length}개 주의`,
    '현재 사용률 기준 고갈 임박 서브넷 — 증설 계획 근거.', { items: topN(subnets.filter((s) => s.utilizationPct >= 50).map((s) => ({ label: s.cidr, value: `${s.utilizationPct}% · 여유 ${s.free}` }))) });
  add('broadcast', '네트워크/브로드캐스트 표시', 'phpIPAM', `${subnets.length}개 서브넷`,
    '각 /24의 네트워크(.0)·브로드캐스트(.255)·사용가능(254) 경계를 표시합니다.', { items: topN(subnets.map((s) => ({ label: s.cidr, value: `net ${s.base}.0 · bcast ${s.base}.255` }))) });
  add('reservation', 'IP 예약/주석', 'phpIPAM · NetBox', '주석 기능 연동',
    'IP/서브넷에 예약·메모를 달아 관리합니다(관리대장 주석과 연동).', {});
  add('search', '통합 검색', '공통', `${ipv4.length}개 색인`,
    'IP·호스트명·서비스로 즉시 검색합니다(관리대장 검색과 연동).', {});
  add('export', 'CSV/Excel/DB 내보내기', 'phpIPAM · SolarWinds', '지원',
    '전체 대장을 CSV·Excel(서브넷 시트)·SQLite로 내보냅니다(외부 공유).', {});
  add('audit', '변경 이력(최초/최근 관측)', 'NetBox(Journaling)', `${ipv4.filter((r) => r.firstSeen).length}개 이력`,
    'IP별 최초 발견/최근 관측 시각으로 점유 이력을 추적합니다.', {});
  add('capacity-summary', '용량 대시보드', 'SolarWinds(위젯)', `사용 ${totalUsed} / 용량 ${totalCap}`,
    '전체 서브넷 용량·사용량 요약 대시보드.', {});
  add('utilization-rank', '사용률 상위 서브넷', 'NetBox', `상위 ${Math.min(10, subnets.length)}개`,
    '사용률이 높은 서브넷 순위(우선 관리 대상).', { items: topN(subnets.map((s) => ({ label: s.cidr, value: `${s.utilizationPct}%` }))) });
  add('recommend', '권장 조치 요약', '종합', `${nearFull.length + duplicates.length + risky.length + rogue.length}건 점검 필요`,
    '가득 찬 서브넷·중복·위험 포트·미등록 IP를 한 번에 요약해 다음 할 일을 제시합니다.',
    { severity: (nearFull.length + duplicates.length + risky.length + rogue.length) ? 'warn' : 'info' });

  return {
    generatedAt: snap?.generatedAt || now,
    scope: vcenterId || '',
    totals: { ips: ipv4.length, subnets: subnets.length, overallUtil, used: totalUsed, capacity: totalCap, scannedCoverage: coverage },
    subnets,
    features: F,
  };
}
