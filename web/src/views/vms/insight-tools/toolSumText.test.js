// v3.21.0 — VM 분석 화면 특수 기능 요약 공용 보조: 법인 줄 합산 · 상위 N 병합 · 호스트 대수 환산 · 표기.
import { describe, it, expect } from 'vitest';
import {
  fmtN, fmt1, gbText, mbText, ghzText, pctOf, pctText, pickRows, sumOf, sumArrays, sumObjects, mergeTop, descNull, byName,
  corpNameOf, hostAvgMemGB, hostsEq, toolHref, singleVc, synthNote, missingText, segsOf, barPct, toolLabel,
} from './toolSumText.js';

describe('표기 — 못 읽은 값은 0 이 아니다 · 단위 없는 —', () => {
  it('fmtN · fmt1 — 천 단위 쉼표 · null/빈 글자는 —', () => {
    expect(fmtN(1234567)).toBe('1,234,567');
    expect(fmtN(null)).toBe('—');
    expect(fmtN('')).toBe('—');
    expect(fmtN(0)).toBe('0');
    expect(fmt1(1234.56)).toBe('1,234.6');
  });
  it('gbText — 1,024 GB 이상은 TB · 값이 없으면 단위 없이 —', () => {
    expect(gbText(512)).toBe('512 GB');
    expect(gbText(1536)).toBe('1.5 TB');
    expect(gbText(14336)).toBe('14 TB');
    expect(gbText(null)).toBe('—');
    expect(mbText(2048)).toBe('2 GB');
    expect(ghzText(2499700)).toBe('2,499.7 GHz');
    expect(ghzText(undefined)).toBe('—');
  });
  it('pctText — 분모 0 · 결측이면 —(—% 로 쓰지 않는다)', () => {
    expect(pctText(1, 4)).toBe('25%');
    expect(pctText(1, 0)).toBe('—');
    expect(pctText(null, 4)).toBe('—');
    expect(pctOf(3, 3)).toBe(100);
  });
});

describe('법인 줄 고르기 · 더하기', () => {
  const rows = [{ vcenterId: 'a', n: 1 }, { vcenterId: 'b', n: 2 }, { vcenterId: 'c', n: null }];
  it('vcIds 가 비면 전부 · 고르면 그 줄만 · 응답에 없는 법인은 missing(0 으로 채우지 않는다)', () => {
    expect(pickRows(rows, []).rows).toHaveLength(3);
    const p = pickRows(rows, ['b', 'z']);
    expect(p.rows.map((r) => r.vcenterId)).toEqual(['b']);
    expect(p.missing).toEqual(['z']);
  });
  it('sumOf — 못 읽은 줄은 합에서 빼고 센다 · 하나도 못 읽으면 null', () => {
    expect(sumOf(rows, (r) => r.n)).toEqual({ sum: 3, n: 2, unknown: 1 });
    expect(sumOf([{ n: null }], (r) => r.n).sum).toBeNull();
    expect(sumOf([], (r) => r.n).sum).toBeNull();
  });
  it('sumArrays · sumObjects — 칸마다 · 키마다', () => {
    expect(sumArrays([{ b: [1, 2, 3] }, { b: [1, null, 1] }], (r) => r.b, 3)).toEqual([2, 2, 4]);
    expect(sumArrays([], (r) => r.b)).toBeNull();
    expect(sumObjects([{ o: { x: 1, y: 2 } }, { o: { x: 3 } }, { o: null }], (r) => r.o)).toEqual({ x: 4, y: 2 });
  });
});

describe('상위 N 병합 — 합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다', () => {
  // 법인 6곳에 VM 을 무작위로 두고, 서버처럼 법인마다 상위 5 만 준 뒤 화면이 합쳐 다시 고른 결과가 전체의 상위 5 와 같은지 본다.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  it('무작위 40회 — 어떤 법인 조합을 골라도 전체 정렬의 상위 5 와 같다', () => {
    for (let t = 0; t < 40; t++) {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      const all = [];
      for (const id of ids) for (let i = 0; i < 3 + Math.floor(rnd() * 12); i++) all.push({ vcenterId: id, name: `${id}-${i}`, v: Math.floor(rnd() * 50) });
      const cmp = (a, b) => descNull(a.v, b.v) || byName(a, b);
      const rows = ids.map((id) => ({ vcenterId: id, top: all.filter((x) => x.vcenterId === id).sort(cmp).slice(0, 5) }));
      const pick = ids.filter(() => rnd() < 0.6);
      const want = all.filter((x) => !pick.length || pick.includes(x.vcenterId)).sort(cmp).slice(0, 5).map((x) => x.name);
      const got = mergeTop(pickRows(rows, pick).rows, (r) => r.top, cmp, 5).map((x) => x.name);
      expect(got).toEqual(want);
    }
  });
  it('항목에 vcenterId 가 없으면 줄의 것을 붙인다(경합 응답의 VM 항목)', () => {
    const got = mergeTop([{ vcenterId: 'x', top: [{ name: 'v1', v: 1 }] }], (r) => r.top, (a, b) => b.v - a.v);
    expect(got[0].vcenterId).toBe('x');
  });
  it('cmp 가 null 이면 도구가 준 순서 그대로(Tools 미실행 — 순위가 아니다)', () => {
    const got = mergeTop([{ vcenterId: 'a', top: [{ name: 'z' }, { name: 'a' }] }, { vcenterId: 'b', top: [{ name: 'm' }] }], (r) => r.top, null, 5);
    expect(got.map((x) => x.name)).toEqual(['z', 'a', 'm']);
  });
});

describe('S2 — 호스트 대수 환산(메모리만)', () => {
  const corps = [
    { id: 'a', hosts: 10, capUnknown: 2, memTotalGB: 4096 },   // 읽은 호스트 8대 · 512 GB/대
    { id: 'b', hosts: 4, capUnknown: 0, memTotalGB: 2048 },    // 4대 · 512 GB/대
    { id: 'c', hosts: 3, capUnknown: 3, memTotalGB: 0 },       // 전부 못 읽음 — 분모에서 뺀다
  ];
  it('용량을 못 읽은 호스트는 분모에서도 뺀다(0 GB 호스트로 세지 않는다)', () => {
    expect(hostAvgMemGB(corps, [])).toEqual({ avgGB: 512, hosts: 12 });
    expect(hostAvgMemGB(corps, ['c'])).toBeNull();
    expect(hostAvgMemGB(null, [])).toBeNull();
  });
  it('미사용 메모리 ÷ 평균 = 약 N대분(소수 첫째) · 모르면 null', () => {
    expect(hostsEq(1280, { avgGB: 512 })).toBe(2.5);
    expect(hostsEq(null, { avgGB: 512 })).toBeNull();
    expect(hostsEq(100, null)).toBeNull();
  });
});

describe('링크 · 이름 · 안내', () => {
  it('도구 주소 · 고른 법인 1곳만 범위로 든다', () => {
    expect(toolHref('waste', 'off')).toBe('#/tools/waste/off');
    expect(toolHref('guest-partition')).toBe('#/tools/guest-partition');
    expect(singleVc(['a'])).toBe('a');
    expect(singleVc(['a', 'b'])).toBe('');
    expect(singleVc([])).toBe('');
  });
  it('도구 이름은 카탈로그에서', () => {
    expect(toolLabel('guest-partition')).toBe('게스트 파티션 사용률');
    expect(toolLabel('no-such')).toBe('no-such');
  });
  it('법인 이름 — VM 집계 줄이 먼저 · 없으면 도구 줄 · 그것도 없으면 id', () => {
    const nameOf = corpNameOf([{ id: 'a', name: '서울' }], [{ vcenterId: 'a', name: 'vc-a' }, { vcenterId: 'b', name: 'vc-b' }]);
    expect(nameOf('a')).toBe('서울');
    expect(nameOf('b')).toBe('vc-b');
    expect(nameOf('z')).toBe('z');
  });
  it('합성 값 · 빠진 법인 안내', () => {
    expect(synthNote({ synthesized: true })).toMatch(/목\(mock\)/);
    expect(synthNote({})).toBe('');
    expect(missingText(['a', 'b'], (x) => x.toUpperCase())).toMatch(/2곳\(A · B\)/);
    expect(missingText([])).toBe('');
  });
  it('조각 막대는 0 · 결측 조각을 그리지 않는다 · 막대 폭은 최소 2%', () => {
    expect(segsOf([{ key: 'a', n: 0 }, { key: 'b', n: 3 }, { key: 'c', n: null }]).map((s) => s.key)).toEqual(['b']);
    expect(barPct(1, 1000)).toBe(2);
    expect(barPct(0, 10)).toBe(0);
    expect(barPct(null, 10)).toBe(0);
    expect(barPct(5, 10)).toBe(50);
  });
});
