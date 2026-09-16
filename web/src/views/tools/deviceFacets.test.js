/**
 * deviceFacets.test.js — 법인·장비 종류 필터 판정(v2.532).
 *
 * 사용자 요청(스토리지 증가량): "법인별로 구분해서 볼 수 있도록" · "장비 종류별로 …
 * **다른 화면에서 사용했던 메뉴와 동일하게**". '동일하게' 를 지키는 방법은 같은 코드를
 * 쓰는 것이고, 그 코드가 맞는지 고정하는 것이 이 파일이다.
 * 여기 담긴 규칙은 전부 v2.407~2.522 에 스토리지 모니터링에서 실제 결함으로 배운 것이다.
 */
import { describe, it, expect } from 'vitest';
import { facetState, toggleIn, groupBy } from './deviceFacets.js';

const ROWS = [
  { name: 'WA-isilon', type: 'isilon', datacenterId: 'dc-wa', host: '10.0.0.1' },
  { name: 'WA-unity', type: 'unity480', datacenterId: 'dc-wa', host: '10.0.0.2' },
  { name: 'AZ-isilon', type: 'isilon', datacenterId: 'dc-az', host: '10.0.0.3' },
  { name: 'AZ-ps', type: 'powerstore', datacenterId: 'dc-az', host: '10.0.0.4' },
];
const dcName = (id) => ({ 'dc-wa': 'WA', 'dc-az': 'AZ' }[id] || id || '미지정');
const typeLabel = (t) => ({ isilon: 'Isilon', unity480: 'Unity', powerstore: 'PowerStore' }[t] || t);
const S = (o = {}) => facetState({ rows: ROWS, dcSel: new Set(), typeSel: new Set(), query: '', dcName, typeLabel, ...o });

describe('필터 결합', () => {
  it('아무것도 안 고르면 전체다', () => {
    const r = S();
    expect(r.shown).toHaveLength(4);
    expect(r.facetOn).toBe(false);
  });

  it('★ 두 축은 AND — "WA + Isilon" 이면 WA 의 Isilon 만', () => {
    const r = S({ dcSel: new Set(['WA']), typeSel: new Set(['isilon']) });
    expect(r.shown.map((x) => x.name)).toEqual(['WA-isilon']);
    expect(r.facetOn).toBe(true);
  });

  it('여러 개를 고르면 OR 로 합쳐진다(한 축 안에서)', () => {
    expect(S({ dcSel: new Set(['WA', 'AZ']) }).shown).toHaveLength(4);
  });
});

describe('칩 목록·개수', () => {
  it('★ 칩 목록은 "검색만 적용한" 집합에서 만든다 — 고른 칩이 사라져 해제 불가가 되면 안 된다', () => {
    // Isilon 만 고른 상태에서도 Unity·PowerStore 칩이 **남아 있어야** 한다.
    const r = S({ typeSel: new Set(['isilon']) });
    expect(r.typeChips.map((c) => c.type).sort()).toEqual(['isilon', 'powerstore', 'unity480']);
  });

  it('★ 칩의 개수는 "다른 축의 선택을 반영한" 수 — 고르면 몇 대가 남는지 미리 보인다', () => {
    const r = S({ dcSel: new Set(['WA']) });
    const byType = Object.fromEntries(r.typeChips.map((c) => [c.type, c.count]));
    expect(byType.isilon).toBe(1);      // WA 의 Isilon 1대
    expect(byType.powerstore).toBe(0);  // WA 에는 PowerStore 가 없다 — 칩은 남고 개수만 0
  });

  it('법인 칩의 개수는 장비 종류 선택을 반영한다', () => {
    const r = S({ typeSel: new Set(['isilon']) });
    expect(Object.fromEntries(r.dcChips.map((c) => [c.dc, c.count]))).toEqual({ WA: 1, AZ: 1 });
  });

  it('칩은 이름순으로 정렬된다(매 렌더 순서가 흔들리면 누르기 어렵다)', () => {
    expect(S().dcChips.map((c) => c.dc)).toEqual(['AZ', 'WA']);
  });
});

describe('빠른 찾기', () => {
  it('공백 구분 다중 키워드 AND', () => {
    expect(S({ query: 'wa isilon' }).shown.map((x) => x.name)).toEqual(['WA-isilon']);
  });

  it('법인명·장비명·host·타입명에서 찾는다', () => {
    expect(S({ query: '10.0.0.4' }).shown.map((x) => x.name)).toEqual(['AZ-ps']);
    expect(S({ query: 'powerstore' }).shown.map((x) => x.name)).toEqual(['AZ-ps']);
    expect(S({ query: 'az' }).shown).toHaveLength(2);
  });

  it('★ 거른 뒤에 그룹핑한다 — 매칭된 법인 안의 매칭 안 된 장비가 딸려오면 안 된다', () => {
    const r = S({ query: 'unity' });
    expect(r.shown.map((x) => x.name)).toEqual(['WA-unity']);
    expect(r.dcChips).toHaveLength(1);
    expect(r.dcChips[0].list.map((x) => x.name)).toEqual(['WA-unity']);
  });

  it('검색은 대소문자를 가리지 않는다', () => {
    expect(S({ query: 'ISILON' }).shown).toHaveLength(2);
  });

  it('건초더미를 주입해 화면마다 다른 필드를 더할 수 있다', () => {
    const rows = [{ name: 'A', type: 'isilon', datacenterId: 'dc-wa', snap: { name: 'LGES-bigdata' } }];
    const r = facetState({ rows, dcSel: new Set(), typeSel: new Set(), query: 'lges', dcName, typeLabel,
      hay: (x) => [x.name, x.snap?.name] });
    expect(r.shown).toHaveLength(1);
  });
});

describe('토글·그룹', () => {
  it('toggleIn 은 불변이다(원본 Set 을 건드리면 리렌더가 안 된다)', () => {
    const a = new Set(['x']);
    const b = toggleIn(a, 'y');
    expect([...a]).toEqual(['x']);
    expect([...b].sort()).toEqual(['x', 'y']);
    expect([...toggleIn(b, 'x')]).toEqual(['y']);
  });

  it('★ 빈 그룹을 만들지 않는다 — 0대 행은 "0대" 라는 거짓이 아니라 없는 것이다', () => {
    const g = groupBy(S({ dcSel: new Set(['WA']) }).shown, (r) => r.datacenterId, dcName);
    expect(g.map((x) => x.label)).toEqual(['WA']);
  });

  it('그룹은 표시명순으로 정렬된다', () => {
    expect(groupBy(ROWS, (r) => r.datacenterId, dcName).map((x) => x.label)).toEqual(['AZ', 'WA']);
  });
});

describe('방어', () => {
  it('빈 입력·잘못된 Set 에도 터지지 않는다', () => {
    expect(facetState({}).shown).toEqual([]);
    expect(facetState({ rows: ROWS, dcSel: null, typeSel: undefined }).shown).toHaveLength(4);
  });
});
