import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  statusKeyOf, speedLabel, intfOfPartName, xcvrMapOf, intfRows, statusBuckets, speedBuckets, xcvrBuckets, donutArcs, filterRows,
  descCell, deviceOptions, INTF_NOTE,
} from './cvpIntfText.js';

const ports = [
  { name: 'Ethernet1', desc: 'L03_Image_LESAIRSWPOA39_iDRAC', speedBps: 1e9, oper: 'up', admin: 'up', duplex: 'full', fwdModel: 'bridged', mac: 'a4:3f:68:85:30:2e', mtu: 9214, operRaw: 'linkUp' },
  { name: 'Ethernet2', desc: null, speedBps: null, oper: 'nolink', admin: 'up' },
  { name: 'Ethernet3', desc: '', speedBps: 25e9, oper: 'down', admin: 'up' },
  { name: 'Ethernet4', speedBps: 1e8, oper: 'weird' },
];
const parts = [
  { kind: 'xcvr', name: 'all › Ethernet1', state: 'unknown', media: '1000BASE-T' },
  { kind: 'xcvr', name: 'all › Ethernet2', state: 'absent' },
  { kind: 'xcvr', name: 'all › Ethernet3', state: 'unknown' },
  { kind: 'psu', name: 'PowerSupply1', state: 'ok' },
];

describe('cvpIntfText (v2.649)', () => {
  it('상태 칸 — 미연결·확인 불가를 정상에 섞지 않는다', () => {
    expect(ports.map(statusKeyOf)).toEqual(['connected', 'notconnect', 'down', 'unknown']);
  });
  it('speedLabel — 못 읽으면 null(0 bps 아님)', () => {
    expect(speedLabel(1e9)).toBe('1 Gbps'); expect(speedLabel(25e9)).toBe('25 Gbps'); expect(speedLabel(1e8)).toBe('100 Mbps');
    expect(speedLabel(null)).toBeNull(); expect(speedLabel('')).toBeNull(); expect(speedLabel(0)).toBeNull();
  });
  it('xcvrMapOf — 트랜시버 목록이 없으면 null, 빈 슬롯은 미장착, 종류 모르면 null', () => {
    expect(intfOfPartName('all › Ethernet49 › domInfo')).toBe('Ethernet49');
    expect(xcvrMapOf(null)).toBeNull(); expect(xcvrMapOf([{ kind: 'psu', name: 'x' }])).toBeNull();
    const m = xcvrMapOf(parts);
    expect(m.get('Ethernet1').type).toBe('1000BASE-T'); expect(m.get('Ethernet2').type).toBe('미장착'); expect(m.get('Ethernet3').type).toBeNull();
  });
  it('intfRows — 세부 필드·설명 null/"" 구분·트랜시버', () => {
    const r = intfRows(ports, parts);
    expect(r[0]).toMatchObject({ duplex: 'Full Duplex', fwdModel: 'Bridged', mac: 'a4:3f:68:85:30:2e', mtu: 9214, speed: '1 Gbps', xcvr: '1000BASE-T', statusText: '연결됨' });
    expect(r[1].desc).toBeNull(); expect(r[2].desc).toBe('');
    expect(r[2].xcvr).toBe('종류 모름'); expect(r[3].xcvr).toBe('트랜시버 정보 없음');
    expect(intfRows(ports, null)[0].xcvr).toBeNull();
    expect(intfRows(null, parts)).toBeNull();
  });
  it('도넛 칸 — 상태 순서 고정, 모르는 칸은 회색·맨 뒤, 트랜시버 목록 못 읽으면 null', () => {
    const r = intfRows(ports, parts);
    expect(statusBuckets(r).map((b) => b.label)).toEqual(['연결됨', '다운', '미연결', '확인 불가']);
    const sp = speedBuckets(r);
    expect(sp.at(-1)).toMatchObject({ label: '속도 모름', count: 1, color: '#8a94a6' });
    expect(sp.reduce((a, b) => a + b.count, 0)).toBe(4);
    const xb = xcvrBuckets(r);
    expect(xb.map((b) => b.label)).toContain('미장착'); expect(xb.at(-1).label).toBe('종류 모름'); expect(xb.at(-1).count).toBe(2);
    expect(xcvrBuckets(intfRows(ports, null))).toBeNull();
  });
  it('donutArcs — 합이 둘레', () => {
    const a = donutArcs([{ key: 'a', count: 1 }, { key: 'b', count: 3 }], 100);
    expect(a[0].len).toBe(25); expect(a[1].off).toBe(25); expect(donutArcs([], 100)).toEqual([]);
  });
  it('filterRows — 열별 부분 일치 AND, 대소문자 무시', () => {
    const r = intfRows(ports, parts);
    expect(filterRows(r, { name: 'ethernet1' }).length).toBe(1);
    expect(filterRows(r, { desc: 'idrac', statusText: '연결' }).length).toBe(1);
    expect(filterRows(r, { mtu: '9214' }).length).toBe(1);
    expect(filterRows(r, { name: '   ' }).length).toBe(4);
  });
  it('자연 순서 — Ethernet2 가 Ethernet10 앞', () => {
    const r = intfRows([{ name: 'Ethernet10' }, { name: 'Ethernet2' }, { name: 'Ethernet1' }], null);
    expect(r.map((x) => x.name)).toEqual(['Ethernet1', 'Ethernet2', 'Ethernet10']);
  });
  it('descCell·deviceOptions', () => {
    expect(descCell(null).title).toContain('읽지 못'); expect(descCell('').title).toContain('설정되지'); expect(descCell('srv').text).toBe('srv');
    const o = deviceOptions([{ cvpId: 'a', key: 'k2', hostname: 'sw10' }, { cvpId: 'a', key: 'k1', hostname: 'sw2' }, { key: 'x' }]);
    expect(o.map((x) => x.label)).toEqual(['sw2', 'sw10']); expect(o[0].id).toBe('a|k1');
  });
  it('문구에 백틱 없음 · 화면 파일에 uppercase 없음', () => {
    expect(INTF_NOTE.includes('`')).toBe(false);
    const src = fs.readFileSync(new URL('./CvpInterfaces.jsx', import.meta.url), 'utf8');
    expect(/uppercase/i.test(src)).toBe(false);
  });
});
