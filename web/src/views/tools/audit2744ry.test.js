// v2.744(세 번 반복 3회차) 리드 후속 RY — /tools/ipam/sheet 의 VM 칸이 owner 본문(스냅샷 VM 객체 통째) 없이 hasOwner 만 온다(서버 ipamExport.js
//   slimOwnerRow — server/test/audit2744ry.test.js ② 가 고정). 화면은 바꾸지 않았다 — 그 모양을 이미 처리한다는 것을 고정한다:
//   ① 클릭 가능 판정(hasOwnerRow) ② 지연 조회가 끝나기 전·403 일 때 원격 접속 대상은 행의 IP(ipRemoteItem — '수집된 IP가 없습니다' 로 막히지 않는다)
//   ③ 지연 조회가 VM 을 받으면 그 VM 이 대상. renderToStaticMarkup 이라 효과(지연 조회 자체)는 보지 못한다(정직 기록).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hasOwnerRow, ipRemoteItem } from './IpamCore.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';

// 시트가 실제로 주는 VM 칸 모양(서버 subnetSheetsGen 행 + slimOwnerRow) — ownerName 은 없고 hostname 이 VM 이름이다.
const sheetVmRow = { ip: '10.30.0.50', last: 50, hostname: 'app-ry', serverType: 'VM', os: 'Ubuntu', status: 'used', ownerType: 'vm', vcenterId: 'vc-y', hasOwner: true };
const vmObj = { id: 'vc-y:vm-1', vcenterId: 'vc-y', name: 'app-ry', ipAddresses: ['10.30.0.50'], guestOS: 'Ubuntu', powerState: 'POWERED_ON' };
const remoteTitle = (item) => {
  const html = renderToStaticMarkup(React.createElement(VmRemoteButton, { item }));
  const m = html.match(/title="([^"]*)"/);
  return m ? m[1] : '';
};

describe('RY 시트 VM 칸(owner 없음 · hasOwner)', () => {
  it('클릭 가능하고, 지연 조회 전·403 이면 원격 접속은 행의 IP 로 간다', () => {
    expect(hasOwnerRow(sheetVmRow)).toBe(true);
    const item = ipRemoteItem(sheetVmRow, null, '');
    expect(item.ipAddresses).toEqual(['10.30.0.50']);
    expect(item.vcenterId).toBe('vc-y');
    expect(item.name).toBe('app-ry');
    expect(remoteTitle(item)).not.toMatch(/수집된 IP가 없습니다/);
  });
  it('지연 조회가 VM 을 받으면 그 VM 이 원격 접속 대상이다(예전 시트 VM 칸과 같은 대상)', () => {
    expect(ipRemoteItem(sheetVmRow, vmObj, '')).toBe(vmObj);
  });
});
