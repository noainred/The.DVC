// 전체 점검 26회차 F2 — 관제 콘솔 '서비스 점검' 타일이 중앙 노드에서 늘 '정상' 이던 것(엣지 합계 · 미실행을 보지 않음)
import { describe, it, expect } from 'vitest';
import { svcmonTile, svcmonLevel, buildDomainTiles } from './consoleData.js';

describe('svcmonTile(26회차 F2)', () => {
  it('중앙(실행 안 함 · 로컬 전부 pending) + 엣지 실패 → 위험(재현 입력)', () => {
    const t = svcmonTile({ total: 120, pending: 120, ok: 0, warn: 0, bad: 0, stale: 0 }, { agents: 3, rows: 59, bad: 15, warn: 0, stale: 4, silent: 1, unknown: 40, assignedNoReport: 0 }, false);
    expect(t.level).toBe(2);
    expect(t.bad).toBe(15);
    expect(t.total).toBe(59);   // 실행하지 않는 노드의 로컬 120 은 세지 않는다
  });
  it('무보고 엣지만 있으면 주의', () => {
    expect(svcmonLevel({ total: 0 }, { agents: 1, rows: 10, silent: 1, unknown: 10 }, false)).toBe(1);
    expect(svcmonLevel(null, { agents: 0, rows: 0, assignedNoReport: 2 }, false)).toBe(1);
  });
  it('전부 미실행이면 null(정상 아님) · 일부 미실행은 잰 것으로만 판정', () => {
    expect(svcmonLevel({ total: 5, pending: 5 })).toBeNull();
    expect(svcmonLevel({ total: 5, ok: 3, pending: 2 })).toBe(0);
    expect(svcmonLevel({ total: 5, pending: 3, disabled: 2 })).toBeNull();
  });
  it('예전 입력(로컬 요약만)은 예전과 같다', () => {
    expect(svcmonLevel(null)).toBeNull();
    expect(svcmonLevel({ total: 3, bad: 1 })).toBe(2);
    expect(svcmonLevel({ total: 3, stale: 1 })).toBe(1);
    expect(svcmonLevel({ total: 3, bad: 0, warn: 0, stale: 0 })).toBe(0);
  });
  it('타일 문구 — 실패 수에 엣지 실패가 들어가고 미실행 · 무보고 엣지를 따로 밝힌다', () => {
    const base = { global: null, alarms: [], nsx: null, pdu: null, idracPoller: null, dsOver: null, storageDevices: null, permission: { svcmon: true } };
    const tile = buildDomainTiles({ ...base, svcmon: { summary: { total: 4, pending: 4 }, executes: false, edgeTotals: { agents: 2, rows: 30, bad: 2, warn: 1, stale: 0, silent: 1, unknown: 5 } } }).find((x) => x.name === '서비스 점검');
    expect(tile.level).toBe(2);
    expect(tile.crit).toBe('2');
    expect(tile.meta).toMatch(/실패 2/);
    expect(tile.meta).toMatch(/무보고 엣지 1/);
    const none = buildDomainTiles({ ...base, svcmon: { summary: { total: 4, pending: 4 }, executes: false, edgeTotals: { agents: 0, rows: 0 } } }).find((x) => x.name === '서비스 점검');
    expect(none.level).toBeNull();
    expect(none.meta).toMatch(/직접 실행하지 않습니다/);
  });
});
