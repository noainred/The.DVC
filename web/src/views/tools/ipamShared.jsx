// ipamShared.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React from 'react';

// IP 확인 출처 배지: vCenter 인식 / Ping(TCP)스캔 / 둘 다
const DISCOVERY = { vcenter: ['vCenter', 'blue'], scan: ['Ping스캔', 'teal'], both: ['vCenter+스캔', 'green'], manual: ['수동등록', 'purple'] };
export function DiscoveryBadge({ d }) {
  const m = DISCOVERY[d];
  if (!m) return <span className="muted">—</span>;
  const tip = d === 'both' ? 'vCenter 인벤토리 + 능동 스캔 양쪽에서 확인' : d === 'scan' ? '능동 스캔(Ping/TCP)으로만 확인'
    : d === 'manual' ? '운영자가 직접 등록한 IP(자동 발견 없음)' : 'vCenter 인벤토리에서 확인';
  return <span className={`badge ${m[1]}`} title={tip}>{m[0]}</span>;
}

// IP 수동 관리상태(override) 라벨/색 — 백엔드 overrides.js STATUSES와 일치.
export const MGMT = {
  active: ['사용중(확정)', 'green'], reserved: ['예약', 'blue'], deprecated: ['폐기예정', 'gray'],
  dhcp: ['DHCP', 'amber'], static: ['고정할당', 'teal'], ignored: ['숨김', 'gray'],
};
export function MgmtBadge({ s }) {
  const m = MGMT[s];
  if (!m) return null;
  return <span className={`badge ${m[1]}`} title="운영자가 지정한 IP 관리상태">{m[0]}</span>;
}
export const DEVTYPE_LABEL = {
  vm: 'VM', host: 'ESXi', switch: '스위치', router: '라우터', firewall: '방화벽', storage: '스토리지',
  idrac: 'iDRAC', printer: '프린터', server: '서버', loadbalancer: 'LB', appliance: '어플라이언스', other: '기타',
};
