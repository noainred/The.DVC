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
import { columnsFor, cellValue, hasTypeColumns, MIXED_COLUMNS } from './storageColumns.js';

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
