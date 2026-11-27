// ipamMacText.js — IP 대장 '제조사 · MAC' 칸 · IP 상세 창 MAC 묶음 · 스캔 에이전트 표 'MAC' 칸의 문구(순수 · v2.999,
// 시안 docs/design/ipam-alerts-mac-dns ④ ⑥). 판정(표시 MAC · 제조사 · 종류 · 오래됨)은 서버 `ipam/macVendor.js` 가 하고
// 행(netMacFields) · 상세(scanDetailOf.hw)에 실어 보낸다 — 여기는 라벨 · 요약 문구만(웹 vitest 가 고정). 값이 없으면 '—'(0 으로 세지 않는다).
import { numOrNull } from '../../numOrNull.js';

/** MAC 출처(서버 macSrc 값과 1:1). */
export const MAC_SRC = Object.freeze({
  arp: { label: 'ARP', tone: 'gray', title: '스캐너의 이웃 표(ARP)에서 읽은 값 — 같은 서브넷에서 스캐너가 직접 본 MAC 입니다' },
  netbios: { label: 'NetBIOS', tone: 'purple', title: 'Windows · Samba 가 UDP 137 로 답한 어댑터 MAC — 상대가 말한 값이고, NIC 가 여럿이면 다른 NIC 의 MAC 일 수 있습니다' },
});

/** 종류 배지(서버 macKind) — null 이면 배지 없음. */
export function macKindBadge(kind, platform) {
  if (kind === 'virtual') return { label: platform ? `가상 NIC · ${platform}` : '가상 NIC', tone: 'teal', title: '가상 NIC 의 MAC 대역입니다. ESXi 의 vmkernel 포트(vMotion 등)도 VMware 대역을 씁니다' };
  if (kind === 'gateway') return { label: platform ? `게이트웨이 이중화 · ${platform}` : '게이트웨이 이중화', tone: 'gray', title: '게이트웨이 이중화(VRRP · HSRP · GLBP)가 쓰는 가상 MAC 입니다 — 장비 하나의 MAC 이 아닙니다' };
  if (kind === 'random') return { label: '임의 지정', tone: 'gray', title: '장비 · 운영체제가 정한 MAC(로컬 관리 비트) — 제조사가 받은 대역이 아니라 제조사를 추정하지 않습니다' };
  return null;
}

/** 제조사 칸 글자 — 종류가 제조사를 대신하는 경우(이중화 · 임의 지정)와 표에 없는 경우를 가른다. */
export function macVendorText({ vendor, kind, platform } = {}) {
  if (kind === 'gateway') return `게이트웨이 이중화${platform ? `(${platform})` : ''}`;
  if (kind === 'random') return '임의 지정 MAC';
  if (vendor) return vendor;
  if (kind === 'virtual' && platform) return platform;
  return '제조사 미상';
}

/** 행이 '미등록 가상 NIC' 인가 — vCenter 가 모르는 IP(스캔 행)인데 MAC 이 가상 NIC 대역. */
export function isUnregisteredVirtual(r) {
  return !!r && r.ownerType === 'scanned' && r.macKind === 'virtual';
}

/** 스캔으로만 확인한 IP 행의 MAC 요약 — 목록 위 한 줄 · '미등록 가상 NIC' 칩. */
export function scanMacSummary(rows) {
  const s = { total: 0, withMac: 0, vendor: 0, random: 0, gateway: 0, unknown: 0, virtualUnreg: 0 };
  for (const r of rows || []) {
    if (r?.ownerType !== 'scanned') continue;
    s.total += 1;
    if (!r.mac) continue;
    s.withMac += 1;
    if (r.macKind === 'random') s.random += 1;
    else if (r.macKind === 'gateway') s.gateway += 1;
    else if (r.macVendor) s.vendor += 1;
    else s.unknown += 1;
    if (isUnregisteredVirtual(r)) s.virtualUnreg += 1;
  }
  return s;
}
/** 요약 배지 조각 — 0 인 것은 뺀다. */
export function scanMacSummaryParts(sum) {
  if (!sum) return [];
  const out = [];
  const add = (key, label, n, tone = 'gray') => { if (n > 0) out.push({ key, label: `${label} ${n.toLocaleString()}`, tone }); };
  add('vendor', '제조사 확인', sum.vendor);
  add('unknown', '제조사 미상', sum.unknown);
  add('random', '임의 지정', sum.random);
  add('gateway', '게이트웨이 이중화', sum.gateway);
  return out;
}

/** 목록 정렬 값 — 제조사 글자 + MAC(없으면 null — 항상 뒤로). */
export function macSortValue(r) {
  if (!r?.mac) return null;
  return `${macVendorText({ vendor: r.macVendor, kind: r.macKind, platform: r.macPlatform })} ${r.mac}`;
}

/** IP 상세 창의 '오래됨' 문구 — hw = 서버 scanDetailOf(ip).hw. 지금 확인된 값이면 ''. */
export function macStaleText(hw, missMax = null) {
  if (!hw || !hw.stale) return '';
  const miss = numOrNull(hw.arpMiss) ?? 0;
  const max = numOrNull(missMax);
  if (miss > 0) return `지난 스캔 ${miss}회 연속 스캐너 이웃 표에 없었습니다${max != null ? ` — ${max}회가 되면 이 MAC 을 지웁니다` : ''}`;
  return '마지막 스캔이 이 MAC 을 다시 보지 못했습니다(다른 서브넷의 에이전트가 보고했거나 이웃 표를 읽지 못함) — 아래 시각에 확인한 값입니다';
}

const REASON_TEXT = Object.freeze({
  unsupported: '이 에이전트는 리눅스가 아니라 이웃 표를 읽지 않습니다(NetBIOS 가 답한 MAC 만 있습니다)',
  unreadable: '이웃 표(/proc/net/arp)를 읽지 못했습니다 — 컨테이너 · 권한을 확인하세요',
  off: 'MAC 읽기가 꺼져 있습니다',
});
/**
 * 에이전트 표 'MAC' 칸 — x 는 agentReportRows 의 줄(마지막 완료 보고의 nameStats.mac).
 * @returns {{ text:string, title:string, tone:''|'amber'|'muted' }}
 */
export function macStatsCell(x) {
  const ns = x?.nameStats;
  const m = ns && typeof ns === 'object' ? ns.mac : null;
  if (!m || typeof m !== 'object') {
    return x && x.at != null && x.alive != null
      ? { text: '보고 없음', title: '이 에이전트는 MAC 요약을 보내지 않습니다 — 이전 버전입니다(업그레이드 뒤 스캐너 이웃 표의 MAC 을 보냅니다).', tone: 'muted' }
      : { text: '—', title: '', tone: 'muted' };
  }
  if (m.reason) return { text: m.reason === 'unsupported' ? '읽지 않음' : '읽기 실패', title: REASON_TEXT[m.reason] || m.reason, tone: m.reason === 'unreadable' ? 'amber' : 'muted' };
  const onLink = numOrNull(m.onLink);
  const found = numOrNull(m.found);
  if (onLink == null) return { text: '—', title: '', tone: 'muted' };
  if (onLink === 0) return { text: '같은 서브넷 없음', title: '응답한 IP 가 모두 스캐너와 다른 서브넷입니다 — 라우터 너머 IP 의 MAC 은 이웃 표로 알 수 없습니다(NetBIOS 가 답한 MAC 만).', tone: 'muted' };
  return { text: `${found == null ? '—' : found.toLocaleString()} / ${onLink.toLocaleString()}`, title: '스캐너와 같은 서브넷에서 응답한 IP 중 이웃 표에서 MAC 을 읽은 수 / 같은 서브넷 IP 수', tone: '' };
}
/** 스캔 한 번의 MAC 요약 문구(상태 카드 · 실행 이력) — 요약이 없으면 ''. */
export function macStatsText(ns) {
  const m = ns && typeof ns === 'object' ? ns.mac : null;
  if (!m || typeof m !== 'object') return '';
  if (m.reason) return m.reason === 'unreadable' ? 'MAC 이웃 표 읽기 실패' : '';
  const onLink = numOrNull(m.onLink);
  if (!onLink) return '';
  return `MAC ${(numOrNull(m.found) ?? 0).toLocaleString()}/${onLink.toLocaleString()}`;
}
