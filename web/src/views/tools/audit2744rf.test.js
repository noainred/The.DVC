// v2.744(세 번 반복 3회차) 회귀 검토 RF — IP 대장 호스트 행의 원격 접속 대상(GG-R2)과 owner 지연 조회(GG-R3).
//
// GG-R2: VC-01 로 FQDN ESXi 의 관리 IP 가 스캔 행(owner 없음 → 행 IP 로 원격 접속)에서 호스트 행이 되면서, IP 사용 이력 창이
//   스냅샷 호스트 객체(ipAddresses 없음 — 관리 IP 는 mgmtIp)를 원격 접속 대상으로 넘겨 '수집된 IP가 없습니다' 로 막혔다.
// GG-R3: 목록·시트 응답의 호스트 행은 owner 본문 없이 hasOwner·ownerId 만 온다 — 상세는 /hosts(inv.hosts)로 1건만.
//   renderToStaticMarkup 이라 효과(지연 조회)·클릭은 보지 못한다(Chromium 확인 몫).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasOwnerRow, ipRemoteItem, pickHostOwner } from './IpamCore.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// /tools/ipam 이 실제로 주는 호스트 행 모양(서버 ipamExport.js slimHostRow — server/test/audit2744rf.test.js 가 고정).
const hostRow = { ip: '10.20.0.11', ownerType: 'host', ownerName: 'esx01.corp.local', hostName: 'esx01.corp.local', vcenterId: 'vc-n', guestOS: 'ESXi 8.0.2', hasOwner: true, ownerId: 'vc-n:host-9' };
// 시트 행(hostname·os 를 쓴다)
const sheetHostRow = { ip: '10.20.0.11', ownerType: 'host', hostname: 'esx01.corp.local', os: 'ESXi 8.0.2', vcenterId: 'vc-n', hasOwner: true, ownerId: 'vc-n:host-9', ownerName: 'esx01.corp.local' };
// 스냅샷 호스트 객체(권한 있는 역할이 /hosts 로 받는 것) — ipAddresses·ipAddress 가 없다.
const hostObj = { id: 'vc-n:host-9', vcenterId: 'vc-n', name: 'esx01.corp.local', mgmtIp: '10.20.0.11', connectionState: 'CONNECTED' };

const remoteTitle = (item) => {
  const html = renderToStaticMarkup(React.createElement(VmRemoteButton, { item }));
  const m = html.match(/title="([^"]*)"/);
  return m ? m[1] : '';
};

describe('GG-R2 호스트 행의 원격 접속 대상은 행의 IP', () => {
  it('owner 본문이 없을 때(목록·시트)와 지연 조회로 호스트 객체를 받은 뒤 모두 행의 IP 로 접속한다', () => {
    for (const [row, owner] of [[hostRow, null], [hostRow, hostObj], [sheetHostRow, null], [sheetHostRow, hostObj]]) {
      const item = ipRemoteItem(row, owner, '');
      expect(item.ipAddresses).toEqual(['10.20.0.11']);
      expect(item.name).toBe('esx01.corp.local');
      expect(item.vcenterId).toBe('vc-n');
      expect(remoteTitle(item)).not.toContain('수집된 IP가 없습니다');
    }
  });
  it('회귀 근거 — 호스트 객체를 그대로 넘기면 버튼이 막힌다(예전 remoteItem = owner)', () => {
    expect(remoteTitle(hostObj)).toContain('수집된 IP가 없습니다');
  });
  it('VM 행은 예전 그대로 VM 객체 · 스캔 행은 IP 폴백(scope 를 vCenter 로)', () => {
    const vm = { id: 'vc1:vm-1', name: 'app1', vcenterId: 'vc1', ipAddresses: ['10.0.0.5', '10.0.0.6'] };
    expect(ipRemoteItem({ ip: '10.0.0.5', ownerType: 'vm', vcenterId: 'vc1', hasOwner: true }, vm, '')).toBe(vm);
    expect(ipRemoteItem({ ip: '10.9.9.9', ownerType: 'scanned', hostname: 'box', vcenterId: '' }, null, 'vc-x'))
      .toEqual({ name: 'box', ipAddresses: ['10.9.9.9'], vcenterId: 'vc-x' });
  });
});

describe('GG-R3 호스트 행 지연 조회', () => {
  it('hasOwner 호스트 행도 소유 자원 칸이 눌린다(VM 과 같은 규칙)', () => {
    expect(hasOwnerRow(hostRow)).toBe(true);
    expect(hasOwnerRow({ ...hostRow, hasOwner: false })).toBe(false);
    expect(hasOwnerRow({ ip: '1.1.1.1', ownerType: 'scanned', owner: null })).toBe(false);
    expect(hasOwnerRow({ ownerType: 'vm', hasOwner: true })).toBe(true);
  });
  it('/hosts?vcenterId=&q= 결과에서 id 로 고르고, id 가 없으면 같은 vCenter 의 같은 이름(대소문자 무시)', () => {
    const items = [{ id: 'vc-n:host-1', vcenterId: 'vc-n', name: 'esx01.corp.local.old' }, hostObj, { id: 'vc-z:host-9', vcenterId: 'vc-z', name: 'esx01.corp.local' }];
    expect(pickHostOwner(items, hostRow)).toBe(hostObj);
    expect(pickHostOwner(items, { ...hostRow, ownerId: '', ownerName: 'ESX01.corp.local' })).toBe(hostObj);
    expect(pickHostOwner(items, { ...hostRow, ownerId: 'nope', vcenterId: 'vc-q' })).toBeNull();
    expect(pickHostOwner(undefined, hostRow)).toBeNull();
  });
  it('소스: 호스트 상세는 /hosts 로 지연 조회하고 403 은 권한 안내로 말한다 · remoteItem 은 ipRemoteItem 한 벌', () => {
    const src = fs.readFileSync(path.join(HERE, 'IpamCore.jsx'), 'utf8');
    expect(src).toMatch(/fetchJson\('\/hosts', \{/);
    expect(src).toMatch(/e\?\.status === 403 \? 'denied'/);
    expect(src).toMatch(/const remoteItem = useMemo\(\(\) => ipRemoteItem\(row, owner, scope\)/);
    expect(src).not.toMatch(/const remoteItem = owner \|\|/);
  });
});
