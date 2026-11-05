import { describe, it, expect } from 'vitest';
import { entityHash, vcAlarmRows, vcAlarmCounts, taskDurText, vcTaskRows, vcTaskCounts, vcPermRows, vcInfoHeadText, entityTypeText } from './vcInfo.js';
import { parseVcRoute } from './vcdRoute.js';

describe('v2.897 vCenter 알람 · 최근 작업 · 권한 목록 — 화면 판정', () => {
  it('개체 링크 — VM · 호스트만 개체 보기 주소(콜론 든 vCenter id 도 왕복) · 그 밖은 null', () => {
    expect(parseVcRoute(entityHash('vc:1', 'VirtualMachine', 'vm-3'))).toEqual({ vcId: 'vc:1', obj: { type: 'vm', id: 'vc:1:vm-3', tab: '' } });
    expect(parseVcRoute(entityHash('vc1', 'HostSystem', 'host-9')).obj.type).toBe('host');
    expect(entityHash('vc1', 'Datastore', 'datastore-1')).toBe(null);
    expect(entityHash('vc1', 'VirtualMachine', null)).toBe(null);
    expect([entityTypeText('ClusterComputeResource'), entityTypeText('Weird'), entityTypeText(null)]).toEqual(['클러스터', 'Weird', '—']);
  });
  it('알람 — 경보 · 주의 순 · 같으면 최신 · 개수(확인한 것도 센다)', () => {
    const rows = vcAlarmRows([{ status: 'yellow', time: 5 }, { status: 'red', time: 1 }, { status: 'yellow', time: 9, ack: true }, null]);
    expect(rows.map((r) => [r.status, r.time])).toEqual([['red', 1], ['yellow', 9], ['yellow', 5]]);
    expect(vcAlarmCounts(rows)).toEqual({ total: 3, red: 1, yellow: 2, acked: 1 });
  });
  it('작업 — 최신 순 · 개체 거르기 · 걸린 시간은 둘 다 알 때만(실행 중이면 지금까지)', () => {
    const items = [{ key: 'a', entityType: 'VirtualMachine', entity: 'vm-1', started: 1000, completed: 9000, state: 'success' },
      { key: 'b', entityType: 'HostSystem', entity: 'vm-1', queued: 20_000, state: 'queued' }, { key: 'c', entityType: 'VirtualMachine', entity: 'vm-2', started: 5000, state: 'running' }];
    expect(vcTaskRows(items).map((t) => t.key)).toEqual(['b', 'a', 'c']);
    expect(vcTaskRows(items, { entityType: 'VirtualMachine', entity: 'vm-1' }).map((t) => t.key)).toEqual(['a']);
    expect(vcTaskCounts(vcTaskRows(items))).toEqual({ total: 3, error: 0, running: 2 });
    expect(taskDurText(items[0])).toBe('8초');
    expect(taskDurText(items[1])).toBe('—');
    expect(taskDurText(items[2], 5000 + 125_000)).toBe('2분 5초');
    expect(taskDurText({ started: 0, completed: 3_720_000 })).toBe('1시간 2분');
  });
  it('권한 — 개체에 직접 정의된 것만 · 이름순', () => {
    const items = [{ entityType: 'Folder', entity: 'group-d1', entityName: 'Datacenters', principal: 'b' }, { entityType: 'VirtualMachine', entity: 'vm-1', entityName: 'web', principal: 'a' }];
    expect(vcPermRows(items).map((p) => p.principal)).toEqual(['b', 'a']);
    expect(vcPermRows(items, { entityType: 'VirtualMachine', entity: 'vm-1' }).length).toBe(1);
  });
  it('머리 문구 — 주기는 API 값 · 아직 읽지 않음 · 출처', () => {
    expect(vcInfoHeadText({ at: null, refreshMs: 300_000 })).toBe('아직 읽지 않음 · 5분마다 갱신');
    expect(vcInfoHeadText({ at: Date.parse('2026-11-05T03:04:00'), refreshMs: 6 * 3_600_000, source: 'edge' })).toBe('읽은 시각 11-05 03:04 · 6시간마다 갱신 · 엣지 수집');
    expect(vcInfoHeadText(null)).toBe('');
  });
});
