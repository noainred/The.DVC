import { describe, it, expect } from 'vitest';
import { cageRep, layoutCells, utilOf, utilBand, flagOf, evLabel, headline, barSegs, verdictText, lastLinkText, xcvrText, filterPorts, filterCount, fleetRows, fleetTotals, corpChips, SUB_ORDER, SUB_DEFS } from './cvpPortMapText.js';

const P = (o) => ({ name: 'Ethernet1', mgmt: false, cage: 1, slot: null, sub: 'use', ev: 'match', oper: 'up', ...o });

describe('cvpPortMapText', () => {
  it('사용률 — 링크 없음 · 못 읽음은 0% 가 아니다', () => {
    expect(utilOf(P({ inUtil: 12, outUtil: 40 }))).toBe(40);
    expect(utilOf(P({ inUtil: null, outUtil: null }))).toBeNull();
    expect(utilOf(P({ oper: 'nolink', inUtil: 5 }))).toBeNull();
    expect(utilBand(P({ inUtil: '', outUtil: null }))).toBe('na');
    expect(utilBand(P({ inUtil: 85 }))).toBe('u80');
  });
  it('칸 대표 — 브레이크아웃은 쓰는 레인 · 가장 나쁜 근거 · 가장 높은 사용률', () => {
    const r = cageRep([P({ name: 'Ethernet49/1', sub: 'spareX', ev: 'nolink', oper: 'nolink' }), P({ name: 'Ethernet49/2', sub: 'use', ev: 'mismatch', inUtil: 70 }), P({ name: 'Ethernet49/3', sub: 'use', ev: 'match', inUtil: 10 })]);
    expect([r.sub, r.ev, r.inUtil, r.lanes]).toEqual(['use', 'mismatch', 70, 3]);
    expect(cageRep([])).toBeNull();
  });
  it('배치 — 고정형 칸 · 수집 목록에 없는 칸 · 모듈형 슬롯', () => {
    const lay = layoutCells({ groups: [{ label: 'a', form: 'SFP28', cages: [1, 2] }] }, [P({}), P({ name: 'Management1', mgmt: true, cage: 1 })]);
    expect(lay.groups[0].cells.map((c) => c.name)).toEqual(['Ethernet1', null]);
    const m = layoutCells({ modular: true, slots: [{ slot: 3, label: '슬롯 3', groups: [{ label: 'x', cages: [1] }] }] }, [P({ name: 'Ethernet3/1', slot: 3, cage: 1 }), P({ name: 'Ethernet4/1', slot: 4, cage: 1 })]);
    expect(m.slots[0].groups[0].cells[0].name).toBe('Ethernet3/1');
  });
  it('근거 문구 — LLDP 를 못 읽었으면 이웃 없음으로 쓰지 않는다', () => {
    expect(evLabel(P({ ev: 'desc', lldpUnread: true }), true)).toContain('못 읽음');
    expect(evLabel(P({ ev: 'desc' }), true)).toBe('설명만');
    expect(flagOf(P({ ev: 'mismatch' }))).toBeTruthy();
    expect(flagOf(P({ ev: 'match' }))).toBeNull();
    expect(flagOf(P({ sub: 'check', ev: 'nolink' }))).toBeNull();
    expect(verdictText(P({ sub: 'unknown', oper: 'unknown' }))).toContain('예비로 세지 않습니다');
  });
  it('개수 · 막대', () => {
    const c = { total: 10, use: 6, spare: 3, spareX: 2, spareE: 1, spareC: 0, spareU: 0, check: 1, off: 0, unknown: 0 };
    expect(headline(c)).toBe('10포트 중 6 사용(60%) · 예비 3(30%)');
    expect(headline(null)).toBeNull();
    expect(barSegs(c).map((s) => s.key)).toEqual(['use', 'check', 'spareX', 'spareE']);
    expect(SUB_ORDER.every((k) => SUB_DEFS[k])).toBe(true);
  });
  it('마지막 링크 · 트랜시버 문구', () => {
    const now = Date.UTC(2026, 10, 24, 12);
    expect(lastLinkText(P({}), null, now)).toBe('지금 연결됨');
    expect(lastLinkText(P({ oper: 'nolink', lastLinkAt: null }), null, now)).toBe('기록 없음');
    expect(lastLinkText(P({ oper: 'nolink', lastLinkAt: now - 3 * 86_400_000 }), null, now)).toMatch(/^3일 전/);
    expect(xcvrText(P({ xcvr: undefined }))).toBe('목록 못 읽음');
    expect(xcvrText(P({ copper: true }))).toBe('구리(RJ45)');
    expect(xcvrText(P({ xcvr: { present: false } }))).toBe('빈 케이지');
  });
  it('필터 · 관리 포트는 개수에서 뺀다', () => {
    const ports = [P({}), P({ name: 'Ethernet2', sub: 'spareE' }), P({ name: 'Management1', mgmt: true })];
    expect(filterCount(ports, 'all')).toBe(2);
    expect(filterPorts(ports, 'all')).toHaveLength(3);
    expect(filterPorts(ports, 'spare').map((p) => p.name)).toEqual(['Ethernet2']);
  });
  it('전 스위치 — 예비 적은 순 · 못 읽은 장비는 맨 뒤 · 합계에서 뺀다', () => {
    const d = [{ hostname: 'b', corpName: 'KR1', counts: { total: 10, use: 2, spare: 8, check: 0, off: 0, unknown: 0, spareX: 8, spareE: 0, spareC: 0, spareU: 0 } },
      { hostname: 'x', corpName: 'PL', counts: null }, { hostname: 'a', corpName: 'KR1', counts: { total: 10, use: 9, spare: 1, check: 0, off: 0, unknown: 0, spareX: 1, spareE: 0, spareC: 0, spareU: 0 } }];
    expect(fleetRows(d).map((r) => r.hostname)).toEqual(['a', 'b', 'x']);
    expect(fleetRows(d, { lowOnly: true, lowMax: 4 }).map((r) => r.hostname)).toEqual(['a']);
    const t = fleetTotals(d);
    expect([t.devices, t.read, t.unread, t.total, t.spare]).toEqual([3, 2, 1, 20, 9]);
    expect(corpChips(d).map((c) => c.label)).toEqual(['KR1', 'PL']);
  });
});
