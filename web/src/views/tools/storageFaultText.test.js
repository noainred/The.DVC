/**
 * storageFaultText 회귀(v2.567) — '장애 장비' 카드의 판정·문구.
 *
 * 이 화면이 만들 수 있는 최악의 거짓은 **'장애 0' 이라는 초록**이다. 상태를 읽지 못한 장비를
 * 정상으로 세면 그 거짓이 바로 생기므로, 세 칸(장애·정상·확인 불가)과 항등식을 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  deviceFault, faultRows, faultKpi, faultKpiMeta, faultKpiTone, faultKpiTitle, faultFilterNote,
} from './storageFaultText.js';

const dev = (snap) => ({ id: 'd', name: 'D', snap });
const nodes = (count, unhealthy) => ({ nodes: { count, unhealthy, list: [] }, ok: true });

describe('deviceFault — 노드 이상', () => {
  it('노드 비정상이 있으면 장애다', () => {
    const r = deviceFault(dev(nodes(24, 1)));
    expect(r.kind).toBe('fault');
    expect(r.reasons[0]).toMatch(/24대 중 1대/);
  });
  it('노드가 전부 정상이면 정상이다', () => {
    expect(deviceFault(dev(nodes(66, 0))).kind).toBe('ok');
  });
});

describe('⚠ 확인 불가를 장애로도 정상으로도 세지 않는다', () => {
  it('스냅샷이 없으면 확인 불가', () => {
    expect(deviceFault({ id: 'x' }).kind).toBe('unknown');
  });
  it('수집이 실패했으면 확인 불가다 — 장애가 아니다(회선 장애 ≠ 장비 장애)', () => {
    expect(deviceFault(dev({ ok: false, error: 'timeout', nodes: { count: 0 } })).kind).toBe('unknown');
  });
  it('판정 근거가 하나도 없으면 확인 불가다 — 정상으로 세면 초록 거짓이 된다', () => {
    // nodes.count 0 은 계약상 허용이고(types.js), 헬스 필드도 없는 타입이 있다.
    expect(deviceFault(dev({ ok: true, nodes: { count: 0, unhealthy: 0 } })).kind).toBe('unknown');
  });
  it("헬스가 'unknown'·빈 값이면 근거로 세지 않는다(v2.526 회색 규약)", () => {
    for (const raw of ['unknown', '', '   ']) {
      expect(deviceFault(dev({ ok: true, nodes: { count: 0 }, extra: { healthState: raw } })).kind).toBe('unknown');
    }
  });
});

describe('deviceFault — 헬스 문자열·부품', () => {
  it("헬스 'OK' 는 정상이다(Unity 가 OK 를 싣는다)", () => {
    expect(deviceFault(dev({ ok: true, nodes: { count: 0 }, extra: { healthState: 'OK' } })).kind).toBe('ok');
  });
  it('헬스가 이상 문자열이면 장애이고 원문을 사유에 남긴다', () => {
    const r = deviceFault(dev({ ok: true, nodes: { count: 0 }, extra: { healthState: 'degraded' } }));
    expect(r.kind).toBe('fault');
    expect(r.reasons.join(' ')).toMatch(/degraded/i);
  });
  it('부품 이상 개수도 장애 근거다', () => {
    const r = deviceFault(dev({ ok: true, nodes: { count: 0 }, extra: { inventory: { hardware: { unhealthy: 3 } } } }));
    expect(r.kind).toBe('fault');
    expect(r.reasons.join(' ')).toMatch(/부품 이상 3건/);
  });
  it('부품 이상 0 은 정상 근거다(0 을 확인 불가로 만들지 않는다)', () => {
    expect(deviceFault(dev({ ok: true, nodes: { count: 0 }, extra: { inventory: { hardware: { unhealthy: 0 } } } })).kind).toBe('ok');
  });
  it('여러 근거가 동시에 나쁘면 사유를 모두 남긴다', () => {
    const r = deviceFault(dev({ ok: true, nodes: { count: 4, unhealthy: 2 }, extra: { healthState: 'degraded' } }));
    expect(r.reasons).toHaveLength(2);
  });
});

describe('faultKpi — ⚠ 항등식', () => {
  const list = [
    dev(nodes(24, 1)),                                              // fault
    dev(nodes(66, 0)),                                              // ok
    dev({ ok: false }),                                             // unknown(수집 실패)
    { id: 'n' },                                                    // unknown(스냅샷 없음)
    dev({ ok: true, nodes: { count: 0 } }),                         // unknown(근거 없음)
    dev({ ok: true, nodes: { count: 0 }, extra: { healthState: 'degraded' } }), // fault
  ];
  it('합계 = 장애 + 정상 + 확인 불가', () => {
    const k = faultKpi(list);
    expect(k.total).toBe(6);
    expect(k.fault + k.ok + k.unknown).toBe(k.total);
    expect(k).toMatchObject({ fault: 2, ok: 1, unknown: 3 });
  });
  it('빈 목록에도 던지지 않는다', () => {
    expect(faultKpi([])).toMatchObject({ total: 0, fault: 0, ok: 0, unknown: 0 });
    expect(faultKpi()).toMatchObject({ total: 0 });
  });
  it('faultRows 는 장애만 돌려준다 — 개수가 KPI 와 같다', () => {
    expect(faultRows(list)).toHaveLength(faultKpi(list).fault);
  });
});

describe('문구 — 초록 거짓을 만들지 않는다', () => {
  it('⚠ 장애 0 이라도 확인 불가가 있으면 초록으로 칠하지 않고 그 사실을 적는다', () => {
    const k = faultKpi([dev(nodes(4, 0)), dev({ ok: false })]);
    expect(k.fault).toBe(0);
    expect(faultKpiTone(k)).toBe('muted');
    expect(faultKpiMeta(k)).toMatch(/확인 불가 1대/);
    expect(faultKpiMeta(k)).toMatch(/정상이라는 뜻 아님/);
  });
  it('전부 판정했고 장애가 없으면 초록이다', () => {
    const k = faultKpi([dev(nodes(4, 0)), dev(nodes(8, 0))]);
    expect(faultKpiTone(k)).toBe('green');
    expect(faultKpiMeta(k)).toMatch(/2대 모두 정상/);
  });
  it('장애가 있으면 빨강이고 클릭 안내를 적는다', () => {
    const k = faultKpi([dev(nodes(4, 1)), dev(nodes(8, 0))]);
    expect(faultKpiTone(k)).toBe('red');
    expect(faultKpiMeta(k)).toMatch(/클릭/);
  });
  it('등록 0대는 초록도 빨강도 아니다', () => {
    expect(faultKpiTone(faultKpi([]))).toBe('muted');
    expect(faultKpiMeta(faultKpi([]))).toMatch(/등록된 장비 없음/);
  });
  it('title 은 세 수를 모두 적고 수집 실패가 별도 카드임을 밝힌다', () => {
    const t = faultKpiTitle(faultKpi([dev(nodes(4, 1)), dev({ ok: false })]));
    expect(t).toMatch(/장애 1/); expect(t).toMatch(/확인 불가 1/);
    expect(t).toMatch(/수집 실패\/대기/);
  });
  it('필터 0건이어도 왜 0건인지 말한다', () => {
    const k = faultKpi([dev(nodes(4, 0)), dev({ ok: false })]);
    expect(faultFilterNote(k, 0)).toMatch(/단정할 수 없습니다/);
    const k2 = faultKpi([dev(nodes(4, 0))]);
    expect(faultFilterNote(k2, 0)).toBe('장애로 판정된 장비가 없습니다.');
  });
  it('필터가 걸리면 몇 대 중 몇 대인지 적는다', () => {
    const k = faultKpi([dev(nodes(4, 1)), dev(nodes(8, 0))]);
    expect(faultFilterNote(k, 1)).toMatch(/전체 2대 중 장애 1대/);
  });
  it('⚠ 문구에 ** 와 백틱을 쓰지 않는다', () => {
    const k = faultKpi([dev(nodes(4, 1)), dev({ ok: false })]);
    for (const v of [faultKpiMeta(k), faultKpiTitle(k), faultFilterNote(k, 1)]) {
      expect(v).not.toContain('**');
      expect(v).not.toContain('`');
    }
  });
});
