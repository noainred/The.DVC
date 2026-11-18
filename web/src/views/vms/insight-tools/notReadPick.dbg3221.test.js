// dbg3221 5회차 — 분석 화면의 '못 읽은 · 수집하지 않는 법인' 안내를 바로가기에서 고른 법인으로 거른다.
//   서버는 notReadVcenters · notCollected 를 사용자 범위 전체로 만든다 — 고른 법인을 다 읽었는데 고르지 않은 법인 하나가 불통이면
//   '값을 읽지 못한 법인이 있어 일부만 센 수입니다(1곳)' · '이벤트를 수집하지 않는 법인 1곳은 세지 않았습니다' 가 떴다.
//   못 읽은 법인을 고르면 행이 없어 missing(Foot)에도 한 번 더 셌다 — missing 에서는 뺀다.
import { describe, it, expect } from 'vitest';
import { hygieneView, lifeView } from './vmToolPanelsText.js';
import { hostHygieneView } from '../../hosts/insight-tools/hostToolPanelsText.js';
import { pickByVc, notReadPartialIn, notReadPicked } from './toolSumText.js';

const VM_ROW = (id) => ({ vcenterId: id, vms: 10, withFindings: 1, crit: 0, warn: 1, notCollected: 0, byCode: {}, top: {} });
const HOST_ROW = (id) => ({ vcenterId: id, hosts: 4, problem: 0, crit: 0, warn: 0, byCode: {}, top: {}, coverage: {} });
const LIFE_ROW = (id) => ({ vcenterId: id, added: 1, removed: 0, net: 1, byKind: {}, series: [] });

describe('dbg3221 — 못 읽은 법인 수는 고른 법인 안에서만 센다', () => {
  const down = [{ vcenterId: 'b', why: 'unreachable' }];
  it('VM 구성 점검 — a 만 골랐고 b 가 불통이면 경고 없음 · b 를 고르면 1곳 · missing 에 두 번 세지 않는다', () => {
    const resp = { rows: [VM_ROW('a')], notReadVcenters: down, partial: true };
    const a = hygieneView(resp, ['a']);
    expect(a.partial).toBe(false); expect(a.notReadVcenters).toBe(0); expect(a.missing).toEqual([]);
    const ab = hygieneView(resp, ['a', 'b']);
    expect(ab.partial).toBe(true); expect(ab.notReadVcenters).toBe(1); expect(ab.missing).toEqual([]);
    const all = hygieneView(resp, []);
    expect(all.partial).toBe(true); expect(all.notReadVcenters).toBe(1);
    // 줄도 못 읽음도 없는 법인은 그대로 missing
    expect(hygieneView(resp, ['a', 'c']).missing).toEqual(['c']);
  });
  it('호스트 구성 점검 — 같은 규칙', () => {
    const resp = { rows: [HOST_ROW('a')], notReadVcenters: down, partial: true };
    const a = hostHygieneView(resp, ['a']);
    expect(a.partial).toBe(false); expect(a.notReadVcenters).toBe(0); expect(a.missing).toEqual([]);
    const ab = hostHygieneView(resp, ['a', 'b']);
    expect(ab.partial).toBe(true); expect(ab.notReadVcenters).toBe(1); expect(ab.missing).toEqual([]);
  });
  it('비활성만 고르면 partial 은 false(서버 notReadPartialOf 와 같은 뜻) · 수는 비활성으로 따로 센다(7회차)', () => {
    const resp = { rows: [VM_ROW('a')], notReadVcenters: [{ vcenterId: 'd', why: 'disabled' }, ...down], partial: true };
    const ad = hygieneView(resp, ['a', 'd']);
    // 7회차: 예전에는 notReadVcenters 1 이라 패널이 ‘값을 읽지 못한 법인이 있어 일부만 센 수(1곳)’ 를 띄웠다 — 비활성은 못 읽음이 아니다
    expect(ad.partial).toBe(false); expect(ad.notReadVcenters).toBe(0); expect(ad.notReadDisabled).toBe(1);
  });
  it('생성 · 삭제 이력 — notCollected 도 고른 법인 안에서만', () => {
    const resp = { rows: [LIFE_ROW('a'), LIFE_ROW('b')], notCollected: [{ vcenterId: 'b', why: 'edge' }] };
    expect(lifeView(resp, ['a']).notCollected).toBe(0);
    expect(lifeView(resp, ['a', 'b']).notCollected).toBe(1);
    expect(lifeView(resp, []).notCollected).toBe(1);
  });
  it('보조 함수 — 객체가 아닌 항목 · 빈 선택', () => {
    expect(pickByVc([null, 1, { vcenterId: 'a' }, { vcenterId: 'b' }], ['b'])).toEqual([{ vcenterId: 'b' }]);
    expect(pickByVc(undefined, ['a'])).toEqual([]);
    expect(notReadPartialIn([{ why: 'disabled' }])).toBe(false);
    expect(notReadPartialIn([{ why: 'stale' }])).toBe(true);
    expect(notReadPicked({ partial: true }, [], ['x'])).toEqual({ list: [], partial: true, nMissing: 0, nDisabled: 0, missing: ['x'] });
  });
});
