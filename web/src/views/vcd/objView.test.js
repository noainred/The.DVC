import { describe, it, expect } from 'vitest';
import { parseVcRoute, vcHash, currentHash, goHash, onHashChange, replaceHash } from './vcdRoute.js';
import {
  VM_OBJ_TABS, HOST_OBJ_TABS, normObjTab, vmDiskRows, vmDatastoreRows, vmsOnHost, resourcePoolRows,
  hostDatastoresFromVms, sameBuildCount, vmSnapshotFacts, toolsStatusBadge,
} from './objTabs.js';

describe('개체 보기 주소(v2.895)', () => {
  it('목록 · 상세 · VM · 호스트 · 탭 — 콜론이 든 id 도 왕복한다', () => {
    expect(parseVcRoute('#/vcenters')).toEqual({ vcId: null, obj: null });
    expect(parseVcRoute('#/vcenters/vc-us-east')).toEqual({ vcId: 'vc-us-east', obj: null });
    const h = vcHash('vc-us-east', { type: 'vm', id: 'vc-us-east:vm-1203' });
    expect(h).toBe('#/vcenters/vc-us-east/vm/vc-us-east%3Avm-1203');
    expect(parseVcRoute(h)).toEqual({ vcId: 'vc-us-east', obj: { type: 'vm', id: 'vc-us-east:vm-1203', tab: '' } });
    const h2 = vcHash('a b', { type: 'host', id: 'a b:host-9', tab: 'vms' });
    expect(parseVcRoute(h2)).toEqual({ vcId: 'a b', obj: { type: 'host', id: 'a b:host-9', tab: 'vms' } });
  });
  it('모르는 모양은 목록 · 상세로 읽는다(지어내지 않는다)', () => {
    expect(parseVcRoute('#/hosts/x')).toEqual({ vcId: null, obj: null });
    expect(parseVcRoute('#/vcenters/vc1/cluster/c1')).toEqual({ vcId: 'vc1', obj: null });
    expect(parseVcRoute('#/vcenters/vc1/vm')).toEqual({ vcId: 'vc1', obj: null });
    expect(parseVcRoute('#/vcenters/%E0%A4%A')).toEqual({ vcId: null, obj: null });   // 잘못된 인코딩
    expect(vcHash(null)).toBe('#/vcenters');
    expect(vcHash('vc1', { type: 'datastore', id: 'x' })).toBe('#/vcenters/vc1');
  });
  it('브라우저가 아니면 해시 도우미는 던지지 않는다', () => {
    const saved = globalThis.window;
    delete globalThis.window;
    try {
      expect(currentHash()).toBe('');
      expect(() => goHash('#/x')).not.toThrow();
      expect(() => replaceHash('#/x')).not.toThrow();
      expect(typeof onHashChange(() => {})).toBe('function');
    } finally { if (saved !== undefined) globalThis.window = saved; }
  });
});

describe('개체 탭 · 묶음', () => {
  it('vSphere 개체 탭 순서 · 모르는 키는 요약', () => {
    expect(VM_OBJ_TABS.map((t) => t.label)).toEqual(['요약', '모니터', '구성', '사용 권한', '데이터스토어', '네트워크', '스냅샷', '업데이트']);
    expect(HOST_OBJ_TABS.map((t) => t.label)).toEqual(['요약', '모니터', '구성', '사용 권한', 'VM', '리소스 풀', '데이터스토어', '네트워크', '업데이트']);
    expect(normObjTab('vm', 'snapshots')).toBe('snapshots');
    expect(normObjTab('vm', 'pools')).toBe('summary');
    expect(normObjTab('host', 'pools')).toBe('pools');
    expect(normObjTab('host', '')).toBe('summary');
  });
  it('VM 디스크 — dev 를 아직 읽지 않았으면 null(디스크 없음이 아니다) · 데이터스토어 사용률 대조', () => {
    expect(vmDiskRows({}, [])).toBeNull();
    const rows = vmDiskRows({ dev: { disks: [{ label: 'Hard disk 1', datastore: 'ds1', capacityGB: 80 }, { label: 'Hard disk 2', datastore: 'ds1', capacityGB: null }, { label: 'Hard disk 3', datastore: 'ds9', capacityGB: 20 }] } },
      [{ name: 'ds1', usagePct: 92, type: 'VMFS' }]);
    expect(rows[0]).toMatchObject({ datastore: 'ds1', dsUsagePct: 92, dsKnown: true, capacityGB: 80 });
    expect(rows[2]).toMatchObject({ datastore: 'ds9', dsKnown: false, dsUsagePct: null });
    const ds = vmDatastoreRows(rows);
    expect(ds.find((d) => d.datastore === 'ds1')).toMatchObject({ disks: 2, capacityGB: 80 });
    expect(vmDatastoreRows(null)).toBeNull();
  });
  it('호스트 위 VM · 리소스 풀 합 · VM 디스크로 역산한 데이터스토어(못 읽은 VM 은 따로)', () => {
    const host = { name: 'h1', vcenterId: 'vc' };
    const vms = [
      { id: 'a', host: 'h1', vcenterId: 'vc', resourcePool: 'RP-DB', powerState: 'POWERED_ON', cpuCount: 8, memMB: 32768, dev: { disks: [{ datastore: 'ds1' }, { datastore: 'ds2' }] } },
      { id: 'b', host: 'h1', vcenterId: 'vc', resourcePool: 'RP-DB', powerState: 'POWERED_OFF', cpuCount: 2, memMB: 4096 },
      { id: 'c', host: 'h1', vcenterId: 'other', resourcePool: 'X' },
      { id: 'd', host: 'h2', vcenterId: 'vc' },
    ];
    const on = vmsOnHost(vms, host);
    expect(on.map((v) => v.id)).toEqual(['a', 'b']);
    expect(resourcePoolRows(on)).toEqual([{ pool: 'RP-DB', vms: 2, on: 1, vcpu: 10, memMB: 36864 }]);
    const r = hostDatastoresFromVms(on, [{ name: 'ds1', usagePct: 50, type: 'VMFS', capacityGB: 100 }]);
    expect(r.unread).toBe(1);
    expect(r.rows.map((x) => [x.datastore, x.vms, x.usagePct])).toEqual([['ds1', 1, 50], ['ds2', 1, null]]);
  });
  it('같은 빌드 수 · 스냅샷 사실 · Tools 상태 문구', () => {
    const hosts = [{ version: '8.0.3', build: '1' }, { version: '8.0.3', build: '1' }, { version: '8.0.3', build: '2' }];
    expect(sameBuildCount(hosts, { version: '8.0.3', build: '1' })).toEqual({ same: 2, total: 3 });
    expect(sameBuildCount(hosts, { version: '' })).toBeNull();
    const now = Date.parse('2026-11-05T00:00:00Z');
    const f = vmSnapshotFacts({ snapshotCount: 2, snapshotSizeGB: 3.5, snapshotOldestTs: now - 35 * 86_400_000, snapshotNames: ['a', 1, 'b'] }, now);
    expect(f).toMatchObject({ count: 2, sizeGB: 3.5, oldestDays: 35, names: ['a', 'b'] });
    expect(vmSnapshotFacts({}).count).toBeNull();
    expect(toolsStatusBadge('guestToolsCurrent')).toEqual(['green', '최신']);
    expect(toolsStatusBadge('')).toEqual(['gray', '—']);
    expect(toolsStatusBadge('somethingNew')[1]).toBe('somethingNew');
  });
});
