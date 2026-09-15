/**
 * storageColumns 회귀 테스트(v2.406) — 스토리지 타입별 전용 컬럼.
 *
 * 웹 테스트는 node 환경(DOM 없음)이라 표 렌더 자체는 확인할 수 없다. 그래서 '어떤 타입에
 * 어떤 컬럼이 나오는지'와 '각 칸의 값'(순수 계산)을 여기서 고정한다.
 * 특히 지키려는 것:
 *  - PowerStore 는 사용자가 지정한 열(전체/사용/가용/Physical/Logical/Data Reduction)을 갖는다.
 *  - VPLEX 는 용량 열을 만들지 않는다(자체 물리 용량이 없어 0 으로 오표시된다).
 *  - 단일 타입 표는 '타입' 열을 생략한다(폭 절약 — 오른쪽 '작업' 열 잘림의 직접 원인이었다).
 *  - 값이 없으면 0 이 아니라 null(렌더가 '—').
 */

import { describe, it, expect } from 'vitest';
import { columnsFor, cellValue, hasTypeColumns, MIXED_COLUMNS, sortValue } from './storageColumns.js';

const keys = (type) => columnsFor(type).map((c) => c.key);

describe('columnsFor', () => {
  it('PowerStore 는 지정된 용량 열을 모두 갖는다', () => {
    const k = keys('powerstore');
    for (const need of ['capTotal', 'capUsed', 'capFree', 'physical', 'logical', 'dataReduction', 'status']) {
      expect(k, need).toContain(need);
    }
  });

  it('Isilon 은 기존 HDD/SSD 풀 열을 유지한다(isi status 대조용)', () => {
    const k = keys('isilon');
    expect(k).toContain('hdd');
    expect(k).toContain('ssd');
    expect(k).not.toContain('physical'); // PowerStore 전용 열이 새지 않아야 한다
  });

  it('VPLEX/Metro Node 는 용량 열을 만들지 않는다(자체 물리 용량 없음)', () => {
    for (const t of ['vplex', 'metronode']) {
      const k = keys(t);
      expect(k, t).not.toContain('capTotal');
      expect(k, t).not.toContain('usage');
      expect(k, t).toContain('storageVolumes');
    }
  });

  it('XtremIO 는 감축률과 Brick 열을 갖는다(전량 플래시라 HDD/SSD 구분 없음)', () => {
    const k = keys('xtremio');
    expect(k).toContain('dataReduction');
    expect(k).toContain('bricks');
    expect(k).not.toContain('hdd');
  });

  it('단일 타입 표는 타입 열을 생략하고, 여러 타입이면 넣는다', () => {
    expect(keys('powerstore')).not.toContain('type');
    expect(keys(null)).toContain('type');
  });

  it('모든 표는 장비·상태·작업 열로 시작/끝난다', () => {
    for (const t of [null, 'isilon', 'powerstore', 'unity480', 'xtremio', 'vmax', 'powermax', 'vplex', 'metronode']) {
      const k = keys(t);
      expect(k[0], String(t)).toBe('device');
      expect(k.slice(-2), String(t)).toEqual(['status', 'actions']);
    }
  });

  it('정의 없는 타입은 공통 열로 떨어진다(빈 표가 되지 않게)', () => {
    expect(hasTypeColumns('powerstore')).toBe(true);
    expect(hasTypeColumns('nope')).toBe(false);
    expect(keys('nope')).toEqual(expect.arrayContaining(MIXED_COLUMNS.map((c) => c.key)));
  });
});

describe('cellValue', () => {
  const row = {
    id: 'd1', type: 'powerstore', name: 'PS', host: '10.0.0.1',
    snap: {
      ok: true,
      capacity: { totalBytes: 100e12, usedBytes: 42e12, pct: 42 },
      extra: { space: { physicalUsed: 42e12, logicalUsed: 130e12, dataReduction: 3.1 } },
      nodes: { count: 2, unhealthy: 1 },
      accounts: [{ name: 'admin' }],
      pools: [{ name: 'a' }],
    },
  };

  it('가용 용량 = 전체 − 사용', () => {
    expect(cellValue('capFree', row)).toBe(58e12);
  });

  it('전체를 모르면 가용을 계산하지 않는다(0 으로 위장 금지)', () => {
    const r = { ...row, snap: { ...row.snap, capacity: { totalBytes: 0, usedBytes: 0, pct: null } } };
    expect(cellValue('capFree', r)).toBe(null);
    expect(cellValue('capTotal', r)).toBe(null);
  });

  it('Data Reduction 은 숫자(PowerStore)와 문자열(XtremIO 3.1:1) 모두 숫자로 통일', () => {
    expect(cellValue('dataReduction', row)).toBe(3.1);
    const xt = { type: 'xtremio', snap: { extra: { dataReduction: '3.5:1' } } };
    expect(cellValue('dataReduction', xt)).toBe(3.5);
    const none = { type: 'xtremio', snap: { extra: {} } };
    expect(cellValue('dataReduction', none)).toBe(null);
  });

  it('수집 전(스냅샷 없음)이면 모두 null — 0 으로 표시하지 않는다', () => {
    const bare = { id: 'x', type: 'powerstore', snap: null };
    for (const k of ['usage', 'capTotal', 'capUsed', 'capFree', 'physical', 'logical', 'nodes', 'accounts', 'pools']) {
      expect(cellValue(k, bare), k).toBe(null);
    }
  });

  it('노드/계정/풀 개수는 스냅샷이 있으면 0 도 진짜 0 으로 돌려준다', () => {
    const empty = { id: 'x', type: 'unity480', snap: { ok: true, nodes: { count: 0 }, accounts: [], pools: [] } };
    expect(cellValue('nodes', empty)).toBe(0);
    expect(cellValue('accounts', empty)).toBe(0);
    expect(cellValue('pools', empty)).toBe(0);
  });

  it('VPLEX 는 클러스터/스토리지 볼륨/헬스를 돌려준다', () => {
    const vp = { id: 'v', type: 'vplex', snap: { ok: true, extra: { clusters: [{}, {}], storageVolumes: { count: 120 }, healthState: 'healthy' } } };
    expect(cellValue('clusters', vp)).toBe(2);
    expect(cellValue('storageVolumes', vp)).toBe(120);
    expect(cellValue('health', vp)).toBe('healthy');
  });
});

describe('v2.416 리뷰 회귀 — num() 이 null/undefined 를 0 으로 만들지 않는다', () => {
  it('capacity.pct 가 null 이면 usage 는 null(0% 막대 금지), usedBytes 미수집도 null', () => {
    const row = { snap: { capacity: { totalBytes: 0, usedBytes: null, pct: null } } };
    expect(cellValue('usage', row)).toBeNull();
    expect(cellValue('capUsed', row)).toBeNull();
    expect(cellValue('capTotal', row)).toBeNull();
  });
  it('진짜 0 은 0 으로 남는다', () => {
    expect(cellValue('usage', { snap: { capacity: { pct: 0 } } })).toBe(0);
  });
});

/**
 * v2.514 — 헤더 클릭 정렬이 장비 표에서 통째로 동작하지 않던 버그.
 *
 * 사용자 신고(2026-09-15): "법인 클릭해도 소팅 안되는 버그 · 표 전체에서 소팅 안되는 버그".
 * 원인은 `data-sort` 를 `cellValue` 로 준 것 — `cellValue` 는 **타입 전용 열만** 계산하고
 * 공통 열(device·type·dc·collect·version·status)은 null 이라 STable 이 전부 '빈 값' 으로 보고
 * 원래 순서를 유지했다(브라우저 실측: aria-sort 만 바뀌고 DOM 행 순서 불변).
 *
 * 여기서 고정하는 것: **columnsFor 가 내놓는 모든 열이 정렬 값을 가진다**(작업 열만 예외).
 * 이 테스트가 있으면 새 열을 추가하면서 sortValue 를 빠뜨릴 때 CI 가 잡는다 —
 * 빠뜨려도 오류가 나지 않고 '눌러도 안 되는' 조용한 상태가 되기 때문에 자동 검출이 필요하다.
 */
describe('v2.514 정렬 값 — 모든 열이 정렬 가능해야 한다', () => {
  const labels = { typeLabel: (t) => ({ powerstore: 'PowerStore', isilon: 'Isilon' }[t] || t), dcName: (id) => ({ 'dc-wa': 'WA' }[id] || id) };
  const ROW = {
    id: 'd1', name: 'ZULU-PS', host: '10.20.0.1', type: 'powerstore', datacenterId: 'dc-wa', agent: '',
    snap: {
      ok: true, name: 'ZULU-PS', version: '4.1.0.1', collectedAt: 1,
      capacity: { totalBytes: 1e12, usedBytes: 4e11, pct: 40 },
      nodes: { count: 2 }, accounts: [{ name: 'admin' }], sections: { config: 'ok' },
      pools: [{ name: 'p1' }],
      media: { hdd: { usedBytes: 1e11, totalBytes: 5e11, pct: 20 }, ssd: { usedBytes: 2e11, totalBytes: 4e11, pct: 50 } },
      extra: {
        space: { physicalUsed: 4e11, logicalUsed: 1.6e12, dataReduction: 4 },
        numBricks: 2, arrays: [{ id: 'a' }], clusters: [{ id: 'c' }],
        storageVolumes: { count: 12 }, healthState: 'ok',
      },
    },
  };

  for (const type of ['powerstore', 'isilon', 'unity480', 'xtremio', 'vmax', 'vplex', null]) {
    it(`'${type || '혼합'}' 표의 모든 열이 정렬 값을 갖는다(작업 열 제외)`, () => {
      const missing = columnsFor(type)
        .filter((c) => c.key !== 'actions')
        .filter((c) => sortValue(c.key, { ...ROW, type: type || 'powerstore' }, labels) === '');
      expect(missing.map((c) => c.key)).toEqual([]);
    });
  }

  it('법인은 **표시명**으로 정렬한다(원시 id 로 정렬하면 화면 글자 순서와 달라진다)', () => {
    expect(sortValue('dc', ROW, labels)).toBe('WA');
    expect(sortValue('dc', ROW)).toBe('dc-wa');   // 라벨 함수를 안 주면 원문
  });

  it('장비는 **등록 표시명 우선** — 화면(Cell)과 같은 규칙(v2.515)', () => {
    // v2.514 까지는 스냅샷 이름이 우선이었다. 그래서 이름을 고쳐 저장해도 표에 반영되지 않아
    // 사용자가 '수정이 안 된다' 고 신고했다(저장은 성공했다). 정렬 기준도 보이는 글자와 같아야 한다.
    expect(sortValue('device', { ...ROW, name: '새이름', snap: { ...ROW.snap, name: '옛수집이름' } }, labels)).toBe('새이름');
    expect(sortValue('device', ROW, labels)).toBe('ZULU-PS');
    expect(sortValue('device', { name: '등록명', host: '10.0.0.1' }, labels)).toBe('등록명');
    expect(sortValue('device', { host: '10.0.0.1' }, labels)).toBe('10.0.0.1');
    // 등록명이 비고 스냅샷만 있으면 스냅샷 이름을 쓴다(빈 칸으로 두지 않는다).
    expect(sortValue('device', { snap: { name: '수집이름' }, host: '10.0.0.2' }, labels)).toBe('수집이름');
  });

  it('수집 주체 — 중앙 장비도 빈 값이 아니다(빈 값이면 항상 뒤로 밀린다)', () => {
    expect(sortValue('collect', { ...ROW, agent: '' }, labels)).toBe('중앙');
    expect(sortValue('collect', { ...ROW, agent: 'agent-MI' }, labels)).toBe('agent-MI');
  });

  it('상태 — 오름차순에서 문제 장비가 먼저(실패 < 수집 전 < 부분 < 정상)', () => {
    const at = (snap) => sortValue('status', { ...ROW, snap }, labels);
    expect(at({ ok: false })).toBe('0');
    expect(at(null)).toBe('1');
    expect(at({ ok: true, sections: { alerts: '오류: HTTP 400' } })).toBe('2');
    expect(at({ ok: true, sections: { alerts: 'ok' } })).toBe('3');
    expect([at({ ok: false }), at(null), at({ ok: true, sections: { a: '오류' } }), at({ ok: true, sections: {} })])
      .toEqual(['0', '1', '2', '3']);
  });

  it('스냅샷이 없어도 장비·법인·수집은 정렬된다(수집 전 화면에서 표 전체가 멈추지 않게)', () => {
    const fresh = { id: 'x', name: 'ALPHA-PS', host: '10.0.0.9', type: 'powerstore', datacenterId: 'dc-wa' };
    expect(sortValue('device', fresh, labels)).toBe('ALPHA-PS');
    expect(sortValue('dc', fresh, labels)).toBe('WA');
    expect(sortValue('collect', fresh, labels)).toBe('중앙');
    expect(sortValue('version', fresh, labels)).toBe('');   // 없는 값은 빈 값 — 지어내지 않는다
  });

  it('HDD/SSD 풀은 **객체**라 그대로 쓰면 전 행이 "[object Object]" 가 된다 — 사용률로 정렬한다', () => {
    expect(sortValue('hdd', ROW, labels)).toBe('20');
    expect(sortValue('ssd', ROW, labels)).toBe('50');
    expect(sortValue('hdd', { snap: { media: {} } }, labels)).toBe('');
  });

  it('타입 전용 숫자 열은 cellValue 결과를 그대로 쓴다(기존 동작 보존)', () => {
    expect(sortValue('capTotal', ROW, labels)).toBe(String(1e12));
    expect(sortValue('dataReduction', ROW, labels)).toBe('4');
    expect(sortValue('actions', ROW, labels)).toBe('');
  });
});
