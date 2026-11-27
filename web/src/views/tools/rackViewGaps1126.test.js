// 랙 실장도 1회차 점검(2026-11-26 · 살아남은 변이를 막는 테스트) — rackView.js 화면 계산의 테스트 공백.
import { describe, it, expect } from 'vitest';
import * as V from './rackView.js';

describe('탐침 — rackView', () => {
  it('W01 · W02 · W04 · W05: matchUnplaced — 이름으로 찾기 · 대문자 검색어 · 64자까지만 · 필드 경계를 넘지 않는다', () => {
    const u = { name: 'esxi-kr-01', hostname: 'KR-ESX-01.corp', model: 'PowerEdge R750', serviceTag: 'ABC1234' };
    expect(V.matchUnplaced(u, 'esxi-kr')).toBe(true);            // W01 이름
    expect(V.matchUnplaced({ name: 'only-name' }, 'only')).toBe(true);
    expect(V.matchUnplaced(u, 'R750')).toBe(true);               // W02 대문자 검색어
    expect(V.matchUnplaced(u, 'ABC12')).toBe(true);
    expect(V.matchUnplaced({ name: 'a'.repeat(64) }, 'a'.repeat(64) + 'zzz')).toBe(true);   // W04 검색어는 64자까지만 본다
    expect(V.matchUnplaced({ name: 'ab', model: 'cd' }, 'abcd')).toBe(false);               // W05 이름 끝 + 모델 앞이 이어 붙지 않는다
  });

  it('W06 · W07 · W08: matchPlace — 장비 이름 · 추가 시리얼 · 연결 이름 · 메모 · 대문자 검색어', () => {
    const p = { label: '가상화서버 #1', model: 'R740', serial: 'ABC1234', extraSerials: ['NODE-02'], note: '이전 예정', link: { hostname: 'kr-esx-01', name: 'idrac-kr-01' } };
    expect(V.matchPlace(p, '가상화')).toBe(true);     // W06
    expect(V.matchPlace(p, 'node-02')).toBe(true);    // W07 추가 시리얼
    expect(V.matchPlace(p, 'idrac-kr')).toBe(true);   // W07 연결 이름
    expect(V.matchPlace(p, '이전')).toBe(true);        // W07 메모
    expect(V.matchPlace(p, 'R740')).toBe(true);       // W08 대문자 검색어
    expect(V.matchPlace(p, 'ESX-01')).toBe(true);
  });

  it('W09 · W10 · W11: 상자 위치 · 높이 · U 글자', () => {
    expect(V.boxOf({ uStart: 1, uSize: 1 })).toEqual({ bottom: 0, height: V.U_PX - 1 });
    expect(V.boxOf({ uStart: 3, uSize: 2 })).toEqual({ bottom: 2 * V.U_PX, height: 2 * V.U_PX - 1 });
    expect(V.fmtU({ uStart: 3, uSize: 1 })).toBe('U3');
    expect(V.fmtU({ uStart: 3, uSize: 2 })).toBe('U3–4');
  });

  it('W12 · W13 · W14 · W27 · W34: 색 — 상태 모드 · 종류 모드 · 모르는 값의 기본', () => {
    const srv = { kind: 'server', uSize: 2, linkState: 'linked', link: { health: 'crit' } };
    expect(V.colorOf(srv, 'status').val).toBe('장애');
    expect(V.colorOf(srv, 'kind').val).toBe('2U');                // W34
    expect(V.colorOf(srv, 'status').bd).not.toBe(V.colorOf(srv, 'kind').bd);
    expect(V.colorOf({ kind: 'weird', uSize: 1 }, 'kind')).toEqual(V.colorOf({ kind: 'other', uSize: 1 }, 'kind'));   // W13
    expect(V.legendOf('status').map((x) => x.k)).toEqual(['ok', 'warn', 'crit', 'unknown', 'nolink', 'na']);         // W14
    expect(V.legendOf('kind').map((x) => x.label)).toEqual(['서버', '스토리지', '네트워크', 'SAN 스위치', '기타']);
    expect(V.chipColor('nope')).toEqual(V.chipColor('unknown'));   // W27
    expect(V.chipColor('crit')[3]).toBe('장애');
  });

  it('W15: wattText — 1000 W 는 kW 로', () => {
    expect(V.wattText(1000)).toBe('1.0 kW');
    expect(V.wattText(999)).toBe('999 W');
  });

  it('W16~W20 · W25 · W26: roomSummary · statusKeyOf — 남은 U · 경고 · 못 읽음 · 장비 수 · 서버 수', () => {
    const s = V.roomSummary({
      racks: [{ heightU: 42, totals: { usedU: 10 } }],
      places: [
        { kind: 'server', linkState: 'linked', link: { health: 'warn' } },
        { kind: 'server', linkState: 'linked', link: { health: 'weird' } },
        { kind: 'server', linkState: 'linked', link: { health: 'ok' } },
        { kind: 'storage' }, { kind: 'network' },
      ],
    });
    expect(s.freeU).toBe(32);        // W16
    expect(s.warn).toBe(1);          // W18 · W25
    expect(s.unknown).toBe(1);       // W17
    expect(s.devices).toBe(5);       // W19
    expect(s.servers).toBe(3);       // W20
    expect(s.manual).toBe(2);
    expect(V.statusKeyOf({ kind: 'server', linkState: 'linked', link: { health: 'warn' } })).toBe('warn');   // W25
    expect(V.statusKeyOf({ kind: 'server', linkState: 'not-found', link: { health: 'ok' } })).toBe('nolink');   // W26 연결 상태가 linked 가 아니면 상태를 믿지 않는다
  });

  it('W21 · W22 · W29: partChips — 못 읽은 부품 · 주의 부품은 정상이 아니다', () => {
    const c = V.partChips({ psu: { ok: 1, warn: 1 }, disk: { ok: 6, unknown: 2 }, fan: { ok: 4 } });
    expect(c.map((x) => x.state)).toEqual(['warn', 'unknown', 'ok']);
    expect(c[0].text).toBe('전원공급장치 1/2 · 주의 1');
  });

  it('W24: diffCountText — 수정 개수', () => {
    expect(V.diffCountText({ rackChange: 2, placeChange: 3, siteChange: 1 })).toBe('데이터센터 수정 1 / 랙 수정 2 / 장비 수정 3');
  });

  it('W31: dropStartU — 높이를 모르면(빈 값 · 0) 1U 자리로 미리 본다', () => {
    expect(V.dropStartU(0, 42, undefined)).toBe(42);
    expect(V.dropStartU(0, 42, 0)).toBe(42);
    expect(V.dropStartU(16 * 41, 42, '')).toBe(1);
  });
});
