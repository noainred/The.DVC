// ipamHomeText.js — IP 관리 '현황' 탭과 대역 주소 맵의 순수 계산(v3.4.0 재설계 묶음 가 · 설계 docs/design/ipam-redesign §3.1).
// 판정은 새로 만들지 않는다 — 대장 행(/tools/ipam rows)과 IpamCore 의 recon 집계 · /tools/ipam/subnets 의 used 를 읽어 모양만 바꾼다.
// 못 읽은 값(목록을 못 받음)은 0 이 아니라 null 이고 화면은 '—' 를 쓴다.

/** /24 한 대역의 주소 수(.1 ~ .254). 서브넷 목록의 used 는 대장에 있는 주소 수다(subnetsFromRows — .1~.255 끝 조각). */
export const SUBNET_HOSTS = 254;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 대역 하나의 점유 수 — 대장 주소(used) + 대역 정책의 예약 · DHCP(rsv · dhcp — v3.5.0 서버 policyCellCounts). 254 를 넘지 않는다. */
export function occOf(s) {
  const used = Math.max(0, num(s?.used) ?? 0);
  return Math.min(SUBNET_HOSTS, used + Math.max(0, num(s?.rsv) ?? 0) + Math.max(0, num(s?.dhcp) ?? 0));
}

/**
 * 주소 공간 사용률 — (대장 주소 + 예약 + DHCP) / (대역 수 × 254). v3.5.0(재설계 묶음 나 — 설계 §5-0 '예약 · DHCP 포함'):
 * 예약 · DHCP 는 대장에 없는 주소 가운데 대역 정책이 잡은 것만 센다(서버가 대장 주소를 빼고 센다 — 겹쳐 세지 않는다).
 * @param {Array<{used:number,rsv?:number,dhcp?:number}>|null} subnets 못 읽었으면 null
 */
export function utilSummary(subnets) {
  if (!Array.isArray(subnets)) return null;
  let used = 0; let rsv = 0; let dhcp = 0; let over80 = 0;
  for (const s of subnets) {
    const u = Math.max(0, Math.min(SUBNET_HOSTS, num(s?.used) ?? 0));
    used += u;
    rsv += Math.max(0, num(s?.rsv) ?? 0);
    dhcp += Math.max(0, num(s?.dhcp) ?? 0);
    if (occOf(s) / SUBNET_HOSTS >= 0.8) over80 += 1;
  }
  const cap = subnets.length * SUBNET_HOSTS;
  const occ = Math.min(cap, used + rsv + dhcp);
  return { nets: subnets.length, used, rsv, dhcp, occ, cap, free: Math.max(0, cap - occ), pct: cap ? (occ / cap) * 100 : null, over80 };
}

/** 사용률(%) → 지도 칸 단계 0~4(20% 간격 · 80% 이상이 4). 못 읽음은 null. */
export function heatBin(pct) {
  const p = num(pct);
  if (p == null) return null;
  if (p >= 80) return 4;
  if (p >= 60) return 3;
  if (p >= 40) return 2;
  if (p >= 20) return 1;
  return 0;
}
export const HEAT_LABELS = Object.freeze(['20% 미만', '20 – 40%', '40 – 60%', '60 – 80%', '80% 이상']);

/** 막대 색 단계 — 80% 이상 주의 · 90% 이상 심각(현황 · 대역 목록 공용). */
export function meterTone(pct) {
  const p = num(pct);
  if (p == null) return 'none';
  return p >= 90 ? 'crit' : p >= 80 ? 'warn' : 'ok';
}

/** 사용률 높은 대역 — 점유(대장 + 예약 + DHCP) 내림차순(같으면 대역 순) 상위 n개. 대역 용도가 있으면 함께. */
export function topSubnets(subnets, n = 10) {
  if (!Array.isArray(subnets)) return [];
  return subnets
    .map((s, i) => {
      const occ = occOf(s);
      return { base: s.base, subnet: s.subnet, purpose: s.purpose || '', used: occ, free: SUBNET_HOSTS - occ, pct: (occ / SUBNET_HOSTS) * 100, i };
    })
    .sort((a, b) => (b.used - a.used) || (a.i - b.i))
    .slice(0, Math.max(0, n))
    .map(({ i, ...rest }) => rest);
}

/** 퍼센트 글자 — 0.1 단위(100 은 100). 못 읽음은 '—'. */
export function pctText(pct) {
  const p = num(pct);
  if (p == null) return '—';
  return `${p >= 99.95 ? 100 : Math.round(p * 10) / 10}%`;
}

/**
 * '지금 확인할 것' 칸 — 대장 목록의 필터와 1:1(누르면 그 필터로 IP 주소 탭을 연다).
 * recon 은 IpamCore 의 집계(useMemo), data 는 /tools/ipam 응답. 못 받았으면 n 은 null.
 * @returns {Array<{k:string,label:string,n:number|null,sev:'crit'|'warn'|'info',sub:string,go:{recon?:string,row?:string}}>}
 */
export function checkCards(data, recon) {
  const has = !!(data && recon);
  const n = (v) => (has ? (num(v) ?? 0) : null);
  return [
    { k: 'conflict', label: '충돌', n: n(recon?.conflict), sev: 'crit', sub: '다른 vCenter 와 같은 주소', go: { recon: 'conflict' } },
    { k: 'duplicate', label: '중복', n: n(data?.duplicateIps), sev: 'crit', sub: '한 vCenter 안에서 겹침', go: { row: 'duplicate' } },
    { k: 'macalert', label: '충돌 의심 · MAC 변경', n: n(recon?.macAlert), sev: 'crit', sub: 'VM 주소에 다른 MAC 이 응답', go: { recon: 'macalert' } },
    { k: 'reserved', label: '예약 만료 · 임박', n: n(recon?.reserved), sev: 'warn', sub: '정리할 예약', go: { recon: 'reserved' } },
    { k: 'dnsbad', label: 'DNS 불일치', n: n(recon?.dnsBad), sev: 'warn', sub: '역DNS 이름이 이 IP 를 가리키지 않음', go: { recon: 'dnsbad' } },
    { k: 'multihomed', label: '복수IP', n: n(data?.multiHomed), sev: 'info', sub: '장비 한 대가 주소를 둘 이상', go: { row: 'multihomed' } },
  ];
}

/** 칸의 배지 — 0 이면 '없음'(정상), 못 읽음은 null(배지 없음). */
export function checkBadge(card) {
  if (card?.n == null) return null;
  if (card.n === 0) return { label: '없음', tone: 'green' };
  if (card.sev === 'crit') return { label: '심각', tone: 'red' };
  if (card.sev === 'warn') return { label: '주의', tone: 'amber' };
  return { label: '정보', tone: 'blue' };
}

/**
 * 대역 주소 맵의 칸 종류 — 서브넷 대장 행(sheet.rows) 하나. 표의 행 색(ROWBG)과 같은 뜻으로 묶는다.
 *  nw 네트워크 주소 · bad 중복 · used 사용 중(복수IP 포함) · scan 스캔으로만 확인 · rsv 예약(관리상태 · 정책) · dhcp · rel 해제(이력) · free 빈 주소
 */
export function mapCellKind(r) {
  const st = r?.status || 'empty';
  if (st === 'network') return 'nw';
  if (st === 'duplicate') return 'bad';
  if (st === 'used' || st === 'multihomed') return 'used';
  if (st === 'scanned') return 'scan';
  if (r?.mgmtStatus === 'dhcp') return 'dhcp';
  if (r?.mgmtStatus === 'reserved' || r?.mgmtStatus === 'deprecated') return 'rsv';
  if (st === 'released') return 'rel';
  return 'free';
}
export const MAP_KINDS = Object.freeze([
  ['used', '사용 중'], ['scan', '스캔으로만 확인'], ['bad', '중복'], ['rsv', '예약'], ['dhcp', 'DHCP'], ['rel', '해제(이력)'], ['free', '빈 주소'],
]);

/** 맵 칸 개수 집계(범례 숫자). */
export function mapCounts(rows) {
  const c = Object.fromEntries(MAP_KINDS.map(([k]) => [k, 0]));
  c.nw = 0;
  for (const r of rows || []) c[mapCellKind(r)] += 1;
  return c;
}

/** 대역 목록 검색 — 대역 글자(10.20.30 · 10.20.30.0/24) · 대역 용도로 찾는다. */
export function filterSubnets(subnets, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return subnets || [];
  return (subnets || []).filter((s) => String(s.subnet || '').toLowerCase().includes(t) || String(s.base || '').startsWith(t) || String(s.purpose || '').toLowerCase().includes(t)); // v3.5.0: 대역 용도로도 찾는다
}
