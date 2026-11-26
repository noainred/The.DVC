import { describe, it, expect } from 'vitest';
import * as V from './rackView.js';
import * as S from '../../../../server/src/rack/layout.js';

describe('rackView — 서버 판정과 같은 입력으로 대조', () => {
  it('placementIssue / facesClash 결과 코드가 서버와 같다(면 · 범위 · 겹침 · 맞닿음 · 자기 자신)', () => {
    const rack = { heightU: 42 };
    const places = [
      { id: 'a', face: 'full', uStart: 3, uSize: 2, label: 'a' },
      { id: 'f', face: 'front', uStart: 42, uSize: 1, label: 'f' },
      { id: 'r', face: 'rear', uStart: 20, uSize: 1, label: 'r' },
    ];
    for (const face of ['full', 'front', 'rear', 'x']) {
      for (const uStart of [0, 1, 2, 3, 4, 5, 19, 20, 21, 41, 42]) {
        for (const uSize of [1, 2, 3]) {
          for (const ignore of ['', 'a']) {
            const cand = { face, uStart, uSize };
            const w = V.placementIssue(rack, places, cand, ignore);
            const s = S.placementIssue(rack, places, cand, ignore);
            expect(w?.code ?? null).toBe(s?.code ?? null);
            if (w?.code === 'overlap') expect(w.withId).toBe(s.withId);
          }
        }
      }
    }
    for (const a of ['full', 'front', 'rear']) for (const b of ['full', 'front', 'rear']) expect(V.facesClash(a, b)).toBe(S.facesClash(a, b));
  });
});

describe('rackView — 화면 계산', () => {
  it('dropStartU: 커서가 가리키는 U 를 맨 위로 · 랙 밖으로 넘치지 않게 자른다', () => {
    expect(V.dropStartU(0, 42, 2)).toBe(41);          // 맨 위 칸(U42)에 2U → U41–42
    expect(V.dropStartU(16 * 41 + 3, 42, 1)).toBe(1);  // 맨 아래 칸
    expect(V.dropStartU(16 * 41 + 3, 42, 2)).toBe(1);  // 맨 아래에 2U 는 U1–2 로
    expect(V.dropStartU(16 * 10, 42, 4)).toBe(29);     // U32 를 가리키면 U29–32
    expect(V.dropStartU(0, 40, 41)).toBe(null);        // 랙보다 큰 장비
  });

  it('statusKeyOf: 연결 못 한 서버 · 상태 못 읽음은 정상이 아니다 · 서버가 아니면 감시 안 함', () => {
    expect(V.statusKeyOf({ kind: 'server', linkState: 'linked', link: { health: 'ok' } })).toBe('ok');
    expect(V.statusKeyOf({ kind: 'server', linkState: 'linked', link: { health: '' } })).toBe('unknown');
    expect(V.statusKeyOf({ kind: 'server', linkState: 'not-found', link: null })).toBe('nolink');
    expect(V.statusKeyOf({ kind: 'storage' })).toBe('na');
  });

  it('wattText: 값 없음은 — · 부분 합은 몇 대 중 몇 대', () => {
    expect(V.wattText(null)).toBe('—');
    expect(V.wattText(560)).toBe('560 W');
    expect(V.wattText(9502, 13, 14)).toBe('9.5 kW (14대 중 13대)');
    expect(V.wattText(9502, 14, 14)).toBe('9.5 kW');
  });

  it('roomSummary: 랙 높이 혼재 · 상태별 수', () => {
    const s = V.roomSummary({
      racks: [{ heightU: 42, totals: { usedU: 10 } }, { heightU: 40, totals: { usedU: 4 } }, { heightU: 42, totals: { usedU: 0 } }],
      places: [{ kind: 'server', linkState: 'linked', link: { health: 'crit' } }, { kind: 'server', linkState: 'not-found' }, { kind: 'other' }],
      unplacedTotal: 5,
    });
    expect(s.heightsText).toBe('42U 2 · 40U 1');
    expect(s.totalU).toBe(124); expect(s.usedU).toBe(14); expect(s.usePct).toBe(11);
    expect(s.crit).toBe(1); expect(s.nolink).toBe(1); expect(s.manual).toBe(1); expect(s.unplaced).toBe(5);
  });

  it('placesForFace: 전면은 앞 반깊이를, 후면은 후면 전용을 보여 준다(전체 깊이는 둘 다)', () => {
    const ps = [{ id: 1, face: 'full' }, { id: 2, face: 'front' }, { id: 3, face: 'rear' }];
    expect(V.placesForFace(ps, 'front').map((p) => p.id)).toEqual([1, 2]);
    expect(V.placesForFace(ps, 'rear').map((p) => p.id)).toEqual([1, 3]);
  });

  it('partChips: 못 읽은 부품은 따로 센다', () => {
    const c = V.partChips({ psu: { state: 'fault', ok: 1, fault: 1 }, disk: { state: 'unknown', ok: 6, unknown: 2 }, mem: null });
    expect(c.map((x) => x.text)).toEqual(['전원공급장치 1/2 · 장애 1', '디스크 6/8 · 못 읽음 2']);
    expect(c[0].state).toBe('crit');
  });

  it('matchPlace: 시리얼 · 호스트 이름 부분 일치, 빈 검색어는 강조 없음', () => {
    const p = { label: '가상화서버 #1', serial: 'ABC1234', link: { hostname: 'kr-esx-01' } };
    expect(V.matchPlace(p, 'abc')).toBe(true);
    expect(V.matchPlace(p, 'esx-01')).toBe(true);
    expect(V.matchPlace(p, 'zzz')).toBe(false);
    expect(V.matchPlace(p, '  ')).toBe(null);
  });

  it('matchUnplaced: 이름 · 호스트 이름 · 모델 · 서비스 태그 부분 일치 · 빈 검색어는 전부 · 가려진 필드(없음)는 맞지 않는다', () => {
    const u = { name: 'esxi-kr-01', hostname: 'KR-ESX-01.corp', model: 'PowerEdge R750', serviceTag: 'ABC1234' };
    expect(V.matchUnplaced(u, '')).toBe(true);
    expect(V.matchUnplaced(u, '   ')).toBe(true);
    expect(V.matchUnplaced(u, 'r750')).toBe(true);
    expect(V.matchUnplaced(u, 'abc12')).toBe(true);
    expect(V.matchUnplaced(u, 'kr-esx')).toBe(true);
    expect(V.matchUnplaced(u, 'zzz')).toBe(false);
    expect(V.matchUnplaced({ name: 'masked-1a2b (이름 가림)' }, 'abc12')).toBe(false);
    expect(V.matchUnplaced(null, 'x')).toBe(false);
    expect(V.UNPLACED_PAGE).toBeGreaterThan(0);
  });

  it('diffCountText: 0 인 항목은 빼고, 바뀐 것이 없으면 그렇게 말한다', () => {
    expect(V.diffCountText({ placeAdd: 2, placeMove: 1, rackRemove: 1 })).toBe('랙 삭제 1 / 장비 추가 2 · 이동 1');
    expect(V.diffCountText({ placeAdd: 0 })).toBe('바뀐 것 없음');
    expect(V.diffCountText(null)).toBe('—');
    expect(V.fieldsText(['label', 'opW', 'zzz'])).toBe('이름 · 운전 전력 · zzz');
  });
});
