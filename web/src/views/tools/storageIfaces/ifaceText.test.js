import { describe, it, expect } from 'vitest';
import { groupByWhy, portWwn, WHY_TEXT, levelColor, rateText, pctText, speedText, timeText, portKindOf, flattenRows, kindMatch, textMatch, isProblem, kpisOf, notesOf, sortVal, stateBadge } from './ifaceText.js';

describe('ifaceText — Unity 인터페이스 화면 문구 · 집계(v3.35.0)', () => {
  it('값이 없으면 단위를 붙이지 않는다(— ) · 0 은 값이다', () => {
    expect(rateText(null)).toBe('—');
    expect(rateText(undefined)).toBe('—');
    expect(rateText('')).toBe('—');
    expect(rateText(0)).toBe('0.00 MB/s');
    expect(rateText(8e9)).toBe('1,000 MB/s');
    expect(rateText(8e9, 'gbps')).toBe('8.00 Gbps');
    expect(pctText(null)).toBe('—');
    expect(pctText(85.4)).toBe('85%');
    expect(pctText(0.4)).toBe('0.4%');
    expect(speedText(null)).toBe('—');
    expect(speedText(16)).toBe('16 Gb');
    expect(sortVal(null)).toBe('');
  });
  it('칸 색은 SAN 포트 사용량과 같은 경계(이상 쪽)', () => {
    expect(levelColor(null)).toBeNull();
    expect(levelColor(19.9)).toBe('#1e3a5f');
    expect(levelColor(80)).toBe('#ea580c');
  });
  it('시각은 포탈(한국) 기준', () => {
    expect(timeText(Date.UTC(2026, 10, 23, 0, 5))).toBe('11-23 09:05');
    expect(timeText(null)).toBe('—');
  });
  it('포트 종류 — 인터페이스로 iSCSI · NAS · 겸용을 가린다', () => {
    const m = new Map([['spa_eth2', [{ kind: 'iscsi' }]], ['spa_eth3', [{ kind: 'nas' }, { kind: 'iscsi' }]]]);
    expect(portKindOf({ id: 'spa_fc0', kind: 'fc' }, m)).toBe('fc');
    expect(portKindOf({ id: 'spa_eth2', kind: 'eth' }, m)).toBe('iscsi');
    expect(portKindOf({ id: 'spa_eth3', kind: 'eth' }, m)).toBe('both');
    expect(portKindOf({ id: 'spa_eth4', kind: 'eth' }, m)).toBe('eth');
  });
  const devices = [{ id: 'u1', name: 'UNITY-1', datacenterId: 'kr', collectMethod: 'api', view: { sp: { fc: { skew: true } },
    interfaces: [{ id: 'if_0', kind: 'iscsi', port: 'spa_eth2', ip: '10.0.0.5', nasServer: '' }],
    ports: [
      { id: 'spa_fc0', kind: 'fc', linkUp: true, state: 'busy', flags: ['busy'], unread: false, peakPct: 90 },
      { id: 'spa_fc1', kind: 'fc', linkUp: true, state: 'slow', flags: ['slow'], unread: false, peakPct: 20 },
      { id: 'spa_eth2', kind: 'eth', linkUp: true, state: 'ok', flags: [], unread: true },
      { id: 'spa_eth4', kind: 'eth', linkUp: false, state: 'unused', flags: [] },
      { id: 'spb_eth3', kind: 'eth', linkUp: false, state: 'down', flags: [] },
    ] } }, { id: 'u2', name: 'UNITY-2', view: null }];
  it('행 · 필터 · KPI — 못 읽음은 따로 센다', () => {
    const rows = flattenRows(devices, (id) => (id === 'kr' ? '한국' : id));
    expect(rows).toHaveLength(5);
    expect(rows[0].corp).toBe('한국');
    expect(rows.find((r) => r.id === 'spa_eth2').portKind).toBe('iscsi');
    expect(rows.filter((r) => kindMatch(r, 'fc'))).toHaveLength(2);
    expect(rows.filter((r) => kindMatch(r, 'iscsi')).map((r) => r.id)).toEqual(['spa_eth2']);
    expect(rows.filter((r) => textMatch(r, '10.0.0.5')).map((r) => r.id)).toEqual(['spa_eth2']);
    expect(rows.filter((r) => textMatch(r, 'unity-1 fc1')).map((r) => r.id)).toEqual(['spa_fc1']);
    expect(rows.filter(isProblem).map((r) => r.id).sort()).toEqual(['spa_fc0', 'spa_fc1', 'spb_eth3']);
    const k = kpisOf(devices, rows);
    expect(k).toMatchObject({ ports: 5, up: 3, down: 1, unused: 1, slow: 1, busy: 1, unreadDevices: 1, unreadPorts: 1, skew: 1, fc: 2, eth: 3 });
  });
  it('주석은 응답의 기준 숫자를 쓴다 · 백틱 없음(BoldText 규약)', () => {
    const n = notesOf({ busyPct: 75, idlePct: 1 });
    expect(n.join(' ')).toContain('75%');
    for (const t of n) expect(t).not.toMatch(/`/);
    expect(stateBadge('nope').text).toBe('상태 못 읽음');
  });
  it('v3.36.1 — 사유별 묶음(사유 없는 장비는 빠짐) · 모든 사유에 문구 · 백틱 없음', () => {
    const g = groupByWhy([{ id: 'a', view: { throughputWhy: 'ssh' } }, { id: 'b', view: { throughputWhy: 'no-match' } }, { id: 'c', view: { throughputWhy: 'ssh' } }, { id: 'd', view: { throughputWhy: '' } }, { id: 'e', view: null }]);
    expect(g.map(([w, l]) => [w, l.map((x) => x.id)])).toEqual([['ssh', ['a', 'c']], ['no-match', ['b']]]);
    for (const k of ['ssh', 'sample-off', 'db-unavailable', 'no-samples', 'sample-failed', 'no-port-units', 'no-match', 'no-recent', 'collect-failed', 'no-config']) {
      expect(WHY_TEXT[k]).toBeTruthy();
      expect(WHY_TEXT[k]).not.toMatch(/`/);
    }
  });
  it('v3.36.1 — WWN 은 포트 WWN(뒤 8바이트)을 통째로(노드 WWN 꼬리가 같아 모든 포트가 같아 보이던 것)', () => {
    expect(portWwn('50:06:01:60:C7:E0:48:62:50:06:01:64:4C:E0:48:62')).toBe('50:06:01:64:4C:E0:48:62');
    expect(portWwn('50:06:01:64:4C:E0:48:62')).toBe('50:06:01:64:4C:E0:48:62');
    expect(portWwn('')).toBe('');
  });
});
