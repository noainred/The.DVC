// v3.47 — 물리서버 ‘같은 묶음 대비’ 구역(드로어): 글자 · 좌표(peerText) + 렌더 + 소스 스윕.
//   판정은 서버가 한다(여기는 읽기만) · 판정하지 않은 지표는 띠를 그리지 않고 이유를 쓴다 · 값이 없으면 단위를 붙이지 않는다 ·
//   ‘묶음 밖’ 은 주황(문제라는 뜻이 아니다 — 빨강 · 초록을 쓰지 않는다) · 다른 서버의 이름은 화면에 없다(응답에 없다) ·
//   기준 · 시간 · 기준 수는 응답 값으로(지어내지 않는다) · 같은 값 서버가 그림에서 사라지지 않는다(반증 B1 ~ B15 · 테스트 구멍 T1 ~ T11).
//   그림 폭의 반응(useBoxWidth)은 SSR 에서 재지 못한다 — Chromium 1440 · 400 으로 확인한다(구멍 T10 의 절반).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import { peerView, peerStrip, peerVal, basisText, eunNeun, PEER_STATE, PEER_ORDER, PEER_FOOT, PEER_WHY, PEER_REASONS_MAX, PEER_REASON_LEN, STRIP_H, STRIP_MID, STRIP_COUNT_DY } from './peerText.js';

vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), postJson: () => new Promise(() => {}), can: () => true, canCsv: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const NB = ' ';
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ');
const plain = (s) => String(s).replace(/ /g, ' ');
const M = (o) => ({ state: 'in', value: 22, n: 6, missing: 0, median: 21.5, lo: 10, hi: 33.5, min: 19, max: 23, points: [19, 20, 21, 22, 22, 23], unit: '%', basis: 'avg24', ...o });
const D = (o = {}) => ({
  ok: true, hours: 24, min: 5, minSamples: 12, minCoverage: 0.5, group: { path: 'SVC\\DB', model: 'PowerEdge R750', size: 6, used: 6 },
  metrics: {
    cpu: M({ state: 'high', value: 78, lo: 9.8, hi: 34.3, max: 78, points: [19, 20, 21, 22, 23, 78] }),
    mem: M({ value: 40, median: 40, lo: 29.3, hi: 51.8, min: 38, max: 42, points: [38, 39, 40, 40, 41, 42] }),
    power: M({ value: 410, n: 5, missing: 1, median: 402, lo: 339.7, hi: 465.3, min: 395, max: 410, points: [395, 400, 402, 405, 410], unit: 'W', basis: 'avg24' }),
    inlet: M({ value: 24, n: 5, missing: 1, median: 24, lo: 20, hi: 27, min: 23, max: 24, points: [23, 23, 24, 24, 24], unit: '℃', basis: 'now' }),
  },
  out: 1, judged: 4, notes: {}, self: { cpu: { n: 288, cov: 1 }, mem: { n: 288, cov: 1 }, power: { n: 24, cov: 1 } }, ...o,
});
const R = { key: 'st:SYNTH01', kind: 'bm', name: 'synth-db-01' };
const render = async (props) => { const { PeerSection } = await import('./PeerSection.jsx'); return renderToStaticMarkup(React.createElement(PeerSection, { r: R, ...props })); };
const countOf = (html, re) => (html.match(re) || []).length;

describe('글자(peerText)', () => {
  it('값 글자 — 지표마다 단위 · 자릿수 · 천 단위 구분(한눈에 타일과 같은 표기) · 값이 없으면 단위를 붙이지 않는다', () => {
    expect([peerVal('cpu', 78.4), peerVal('mem', 40), peerVal('power', 410.6), peerVal('inlet', 24)]).toEqual(['78%', '40%', '411 W', '24.0℃']);
    expect([peerVal('power', 2144), peerVal('power', 52340.4), peerVal('inlet', -3.46)]).toEqual(['2,144 W', '52,340 W', '-3.5℃']);
    for (const v of [null, undefined, '', 'x', NaN]) expect(peerVal('power', v)).toBe('—');
    expect(peerVal('cpu', 0)).toBe('0%');
    expect(PEER_ORDER).toEqual(['cpu', 'mem', 'power', 'inlet']);
  });

  it('기준 글자는 응답 값으로 — basis · hours(지어내지 않는다) · 은/는', () => {
    expect([basisText('avg24', 24), basisText('avg24', 168), basisText('avg24', null), basisText('now', 24), basisText('avg7d', 24), basisText(undefined)]).toEqual(['지난 24시간 평균', '지난 168시간 평균', '지난 24시간 평균', '지금 값', '기준 모름', '기준 모름']);
    expect(['전력', '흡기 온도', 'CPU', '메모리', '온도 값'].map(eunNeun)).toEqual(['은', '는', '는', '는', '은']);
    // 머리 기준 글은 지표마다의 basis 를 묶어 만든다(응답이 바뀌면 따라 바뀐다 — 반증 B2)
    expect(plain(peerView(D()).sub)).toBe('CPU · 메모리 · 전력은 지난 24시간 평균 · 흡기 온도는 지금 값');
    const swapped = peerView(D({ hours: 168, metrics: { ...D().metrics, power: { ...D().metrics.power, basis: 'now' }, inlet: { ...D().metrics.inlet, basis: 'avg24' } } }));
    expect(plain(swapped.sub)).toBe('CPU · 메모리 · 흡기 온도는 지난 168시간 평균 · 전력은 지금 값');
    expect(swapped.rows.map((x) => x.basis)).toEqual(['지난 168시간 평균', '지난 168시간 평균', '지금 값', '지난 168시간 평균']);
    // 구분 글자는 뒤 낱말과 붙는다(줄 끝에 ‘·’ 만 남지 않게) · ‘흡기 온도’ 는 한 덩어리
    expect(peerView(D()).sub).toContain(`평균 ·${NB}흡기${NB}온도는`);
  });

  it('구역 모델 — 머리(폴더 · 모델 · 대수) · 배지(단위 있음) · 지표 줄(기준 · 상태 · 가운데값 · 값 범위 · 폭 · 대수)', () => {
    const v = peerView(D());
    expect(plain(v.head)).toBe('SVC › DB · PowerEdge R750 · 6대');
    expect(v.head).toBe(`SVC ›${NB}DB ·${NB}PowerEdge R750 ·${NB}6대`);
    expect(v.badge).toEqual({ label: '지표 1개 묶음 밖', color: 'amber' });
    expect([v.why, v.error, v.anyStrip]).toEqual(['', false, true]);
    expect(v.rows.map((x) => [x.id, x.label, x.basis, x.badge.label, x.valueText, x.judged])).toEqual([
      ['cpu', 'CPU', '지난 24시간 평균', '묶음보다 높음', '78%', true], ['mem', '메모리', '지난 24시간 평균', '묶음 안', '40%', true],
      ['power', '전력', '지난 24시간 평균', '묶음 안', '410 W', true], ['inlet', '흡기 온도', '지금 값', '묶음 안', '24.0℃', true],
    ]);
    expect([v.rows[0].medianText, v.rows[0].spanText, v.rows[0].rangeText, v.rows[0].countText]).toEqual(['가운데값 22%', '값 범위 19% ~ 78%', '묶음의 폭 10% ~ 34%', '값 있는 서버 6대']);
    expect(v.rows[2].countText).toBe('값 있는 서버 5대 · 값 없는 1대 제외');
    expect(v.rows[0].aria).toBe('CPU — 묶음 가운데값 22% · 이 서버 78% · 묶음보다 높음');
    // 폭 안 → 회색(초록이 아니다 — 정상이라는 판정이 아니다) · 판정한 것이 없으면 ‘판정 안 함’ · 견주지 못한 지표가 있으면 그 수를 밝힌다
    expect(peerView(D({ out: 0 })).badge).toEqual({ label: '묶음 안', color: 'gray' });
    expect(peerView(D({ out: 0, judged: 2 })).badge).toEqual({ label: '견준 2개는 묶음 안', color: 'gray' });
    expect(peerView(D({ out: 0, judged: 0 })).badge).toEqual({ label: '판정 안 함', color: 'gray' });
    for (const s of Object.values(PEER_STATE)) expect(['amber', 'gray']).toContain(s.color);
    // 값 범위는 응답에 min · max 가 있을 때만
    expect(peerView(D({ metrics: { ...D().metrics, cpu: M({ min: null }) } })).rows[0].spanText).toBe('');
  });

  it('판정하지 않은 지표 — 이유를 쓴다(값 있는 서버 수 · 표본 수 · 구간 비율 · 응답의 기간) · 띠 좌표는 없다', () => {
    const d = D({ out: 0, judged: 0, self: { cpu: { n: 11, cov: 1 }, mem: { n: 288, cov: 1 }, power: { n: 7, cov: 0.29 } }, metrics: {
      cpu: { state: 'none', value: null, n: 5, missing: 1, unit: '%', basis: 'avg24' },
      mem: { state: 'few', value: 40, n: 4, missing: 2, unit: '%', basis: 'avg24' },
      power: { state: 'none', value: null, n: 0, missing: 6, unit: 'W', basis: 'avg24' },
      inlet: { state: 'few', value: 24, n: 2, missing: 4, unit: '℃', basis: 'now' },
    } });
    const v = peerView(d);
    expect(v.rows.map((x) => [x.badge.label, x.judged, x.valueText])).toEqual([['값 없음', false, '—'], ['판정 안 함', false, '40%'], ['값 없음', false, '—'], ['판정 안 함', false, '24.0℃']]);
    expect(v.rows[0].note).toBe('지난 24시간 표본이 11개입니다 — 12개 이상일 때 평균으로 봅니다.');
    expect(v.rows[1].note).toBe('값이 있는 서버가 4대입니다 — 5대 이상일 때 견줍니다.');
    expect(v.rows[2].note).toBe('지난 24시간 중 값이 있는 구간이 29%입니다 — 50% 이상일 때 평균으로 봅니다.');
    expect(v.rows.every((x) => x.medianText === '' && x.rangeText === '' && x.spanText === '')).toBe(true);
    expect(v.anyStrip).toBe(false);
    for (const id of PEER_ORDER) expect(peerStrip(id, d.metrics[id], 400)).toBe(null);
    // 쌓인 값이 아예 없으면 그렇게 쓴다 · 표본 수 · 비율을 모르면 그 문구를 쓰지 않는다(이유를 지어내지 않는다)
    expect(peerView({ ...d, self: { cpu: { n: 0, cov: 0 }, power: null } }).rows.map((x) => x.note).filter((_, i) => i === 0 || i === 2))
      .toEqual(['지난 24시간 동안 쌓인 값이 없어 견주지 않았습니다.', '이 서버의 값이 없어 견주지 않았습니다.']);
    expect(peerView({ ...d, self: undefined }).rows[0].note).toBe('이 서버의 값이 없어 견주지 않았습니다.');
    // 기간은 응답 값으로 · 지금 값 지표(흡기 온도)는 표본 문구를 쓰지 않는다
    expect(peerView({ ...d, hours: 48 }).rows[0].note).toBe('지난 48시간 표본이 11개입니다 — 12개 이상일 때 평균으로 봅니다.');
    const now = peerView(D({ self: { inlet: { n: 3, cov: 0.1 } }, metrics: { ...D().metrics, inlet: { state: 'none', value: null, n: 5, missing: 1, unit: '℃', basis: 'now' } } }));
    expect(now.rows[3].note).toBe('이 서버의 값이 없어 견주지 않았습니다.');
    // 응답에 기준 수가 없으면 지어내지 않는다(반증 B14)
    const bare = peerView({ ...d, min: undefined, minSamples: undefined, minCoverage: undefined });
    expect([bare.rows[0].note, bare.rows[1].note, bare.rows[2].note]).toEqual(['이 서버의 값이 없어 견주지 않았습니다.', '값이 있는 서버가 4대입니다 — 견주지 않았습니다.', '이 서버의 값이 없어 견주지 않았습니다.']);
  });

  it('견주지 않는 서버 — 미분류 · 묶음이 작음 · 모델 모름 · 모르는 사유 · 판정 응답이 아닌 본문', () => {
    expect(peerView({ ok: true, min: 5, why: 'unplaced' })).toMatchObject({ head: '', badge: null, why: PEER_WHY.unplaced, error: false, rows: [], notes: [] });
    const few = peerView({ ok: true, min: 5, why: 'few', group: { path: 'SVC\\DB', model: 'PowerEdge R750', size: 4 } });
    expect([plain(few.head), few.why]).toEqual(['SVC › DB · PowerEdge R750 · 4대', '같은 폴더 · 같은 모델 서버가 4대입니다 — 5대 이상일 때 견줍니다.']);
    expect(peerView({ ok: true, why: 'few', group: { path: 'A' } }).why).toBe('같은 폴더 · 같은 모델 서버가 모자랍니다 — 견주지 않았습니다.');
    expect(peerView({ ok: true, why: 'no-model' }).why).toBe(PEER_WHY['no-model']);
    expect(peerView({ ok: true, why: 'whatever' }).why).toBe('이 서버는 견주지 않았습니다.');
    // 200 이지만 판정이 아닌 본문 — 오류로(‘판정 안 함’ · 범례를 그리지 않는다 — 반증 B7)
    expect(peerView({ ok: false, reason: '물리서버 폴더 저장소를 읽지 못했습니다.' })).toMatchObject({ error: true, why: '물리서버 폴더 저장소를 읽지 못했습니다.', badge: null });
    expect(peerView({})).toMatchObject({ error: true, why: '응답 형식이 달라 판정을 보여 주지 못했습니다.' });
    expect(peerView(null)).toBe(null); expect(peerView('x')).toBe(null);
  });

  it('따로 센 것 — 묶음 상한 · 수집 대상 아님 · 수집 노드가 모름 · 구버전 엣지 · 엣지 실패 · 이 포탈 읽기 실패 · 사유는 따로(상한 5건 · 200자)', () => {
    const v = peerView(D({ group: { path: 'SVC\\DB', model: 'PowerEdge R750', size: 85, used: 80, truncated: 5 }, notes: { noTarget: 2, unknown: 3, oldEdge: 1, edgeFail: 3, localFail: 1 }, reasons: ['엣지 응답 없음', '', 7] }));
    expect(v.notes).toEqual([
      '묶음이 85대라 80대만 견줬습니다(5대 제외).', '사용률 수집 대상이 아닌 서버 2대는 CPU · 메모리 값이 없습니다.',
      '수집하는 쪽(이 포탈 · 엣지)이 자기 목록에 없다고 답한 서버 3대는 값이 없습니다.',
      '엣지 1곳이 구버전이라 그 엣지가 수집하는 서버의 값을 받지 못했습니다(엣지 업그레이드 뒤 들어옵니다).', '엣지 3곳에서 값을 받지 못했습니다(잠시 뒤 다시 열어 보십시오).',
      '이 포탈이 수집하는 서버의 값을 읽지 못했습니다.',
    ]);
    expect(v.reasons).toEqual(['엣지 응답 없음']);
    expect(peerView(D({ notes: { noTarget: 0, oldEdge: '', edgeFail: null } })).notes).toEqual([]);
    expect(peerView(D({ group: { path: 'A', truncated: 5 } })).notes).toEqual(['묶음이 커서 5대는 견주지 않았습니다.'], '대수를 모르면 null대라 쓰지 않는다');
    const many = peerView(D({ reasons: Array.from({ length: 9 }, (_, i) => `${i}${'가'.repeat(400)}`) }));
    expect([many.reasons.length, many.reasons[0].length]).toEqual([PEER_REASONS_MAX, PEER_REASON_LEN]);
    expect([PEER_REASONS_MAX, PEER_REASON_LEN]).toEqual([5, 200]);
  });
});

describe('띠 좌표(peerStrip)', () => {
  it('% 지표는 0 ~ 100 축 · 띠 = 묶음의 폭 · 점은 이 서버 값을 뺀 나머지 · 표식은 값 자리 · 세로 배치는 겹치지 않는다', () => {
    const s = peerStrip('cpu', D().metrics.cpu, 416);
    expect([s.w, s.h, s.mid, s.axis]).toEqual([416, STRIP_H, STRIP_MID, ['0%', '100%']]);
    const x = (v) => 8 + (v / 100) * 400;
    expect(s.band).toEqual({ x: Math.round(x(9.8) * 10) / 10, w: Math.round((x(34.3) - x(9.8)) * 10) / 10 });
    // 19 ~ 23% 다섯 점은 20px 안 — 9px 칸으로 묶여 쌓인다(사라지지 않는다: 그린 점 + 대수 글자로 센 점 = 5)
    const seen = s.dots.length + s.counts.reduce((a, c) => a + c.n - Math.min(c.n, 3), 0);
    expect(seen).toBe(5);
    expect([s.self.x, s.self.label, s.self.anchor, s.self.out]).toEqual([x(78), '이 서버 78%', 'middle', true]);
    expect(new Set(s.dots.map((p) => `${p.x}|${p.dy}`)).size).toBe(s.dots.length);
    expect(peerStrip('mem', D().metrics.mem, 416).self.out).toBe(false);
    // 세로: 가장 낮은 점(가운데 + 11 + 반지름 3.5) < 대수 글자 윗변(기준선 − 8) · 대수 글자 기준선 < 축 글자 윗변(높이 − 1 − 9)
    expect(STRIP_MID + 11 + 3.5).toBeLessThan(STRIP_MID + STRIP_COUNT_DY - 8); expect(STRIP_MID + STRIP_COUNT_DY).toBeLessThan(STRIP_H - 1 - 9);
  });

  it('같은 값 서버가 그림에서 사라지지 않는다 — 칸에 다 못 그리면 대수 글자 · 이 서버와 같은 값은 표식을 비켜 그린다(반증 B1)', () => {
    // 같은 값 80대(이 서버 포함) — 표식 밑에 숨지 않고 위아래 두 점 + ‘79대’
    const same = peerStrip('cpu', M({ value: 30, points: Array(80).fill(30), lo: 20, hi: 40 }), 441);
    expect(same.dots.map((p) => p.dy).sort((a, b) => a - b)).toEqual([-11, 11]);
    expect(same.counts).toEqual([{ x: same.self.x, n: 79, anchor: 'middle' }]);
    // 정수 온도 25대(6 · 9 · 7 · 3대) — 값마다 따로 칸 · 셋을 넘는 칸은 대수
    const ints = [...Array(6).fill(21), ...Array(9).fill(22), ...Array(7).fill(23), ...Array(3).fill(24)];
    const t = peerStrip('inlet', M({ value: 24, points: ints, lo: 18, hi: 27, unit: '℃', basis: 'now' }), 441);
    expect(t.counts.map((c) => c.n)).toEqual([6, 9, 7]);
    // 가까운 칸의 대수 글자는 한 글자로(겹쳐 ‘140대’ 로 읽히지 않게) · 끝의 글자는 안쪽 정렬 — 95 ~ 99% 25대(칸 둘 · 9px 간격)
    const edge = peerStrip('mem', M({ value: 97, points: Array.from({ length: 25 }, (_, i) => 95 + (i % 5)), lo: 87, hi: 100 }), 441);
    expect(edge.counts.length).toBe(1); expect(edge.counts[0].n).toBeGreaterThan(3);
    for (let i = 1; i < t.counts.length; i += 1) expect(t.counts[i].x - t.counts[i - 1].x).toBeGreaterThanOrEqual(26);
    const end = peerStrip('cpu', M({ value: 50, points: [50, ...Array(9).fill(100)], lo: 0, hi: 100 }), 441);
    expect(end.counts).toEqual([{ x: 433, n: 9, anchor: 'end' }]);
    expect(new Set(t.dots.map((p) => p.x)).size).toBe(4);
    expect(t.dots.filter((p) => p.x === t.self.x).map((p) => p.dy).sort((a, b) => a - b)).toEqual([-11, 11]);
    // 그린 점 + 대수로 센 점 = 이 서버를 뺀 나머지 전부
    expect(t.dots.length + t.counts.reduce((a, c) => a + c.n - Math.min(c.n, 3), 0)).toBe(ints.length - 1);
  });

  it('끝에 붙은 표식의 글자는 안쪽으로 정렬 — 왼쪽 · 오른쪽 64px 문턱(구멍 T1)', () => {
    const at = (v) => peerStrip('cpu', M({ value: v, points: [20, 21, 22, 23, v], lo: 5, hi: 40, state: v > 40 ? 'high' : v < 5 ? 'low' : 'in' }), 416).self.anchor;
    // x = 8 + v × 4 — 13% → 60px(왼쪽 문턱 안) · 15% → 68px · 85% → 348px(416 − 64 = 352 안) · 87% → 356px
    expect([at(2), at(13), at(15), at(50), at(85), at(87), at(99)]).toEqual(['start', 'start', 'middle', 'middle', 'middle', 'end', 'end']);
  });

  it('% 가 아닌 지표 — 값 · 폭 · 점을 모두 담는 축(전력은 10 단위 · 0 아래로 내려가지 않는다) · 깨진 응답은 그리지 않는다', () => {
    const p = peerStrip('power', D().metrics.power, 416);
    expect(p.axis).toEqual(['320 W', '480 W']);
    expect(p.band.x).toBeGreaterThanOrEqual(8); expect(p.band.x + p.band.w).toBeLessThanOrEqual(408.1);
    expect(peerStrip('inlet', D().metrics.inlet, 416).axis).toEqual(['19.0℃', '28.0℃']);
    expect(peerStrip('power', M({ value: 12, points: [10, 11, 12, 13, 14], lo: 0, hi: 32, unit: 'W', basis: 'avg24' }), 300).axis[0]).toBe('0 W');
    expect(peerStrip('power', M({ value: 2144, points: [1900, 2000, 2100, 2144, 2370], lo: 1738, hi: 2407, unit: 'W' }), 300).axis).toEqual(['1,680 W', '2,470 W']);
    // 폭이 좁아도 그림 폭은 160 아래로 내려가지 않는다 · 폭을 못 재면 기본값
    expect(peerStrip('cpu', D().metrics.cpu, 40).w).toBe(160); expect(peerStrip('cpu', D().metrics.cpu, null).w).toBe(420);
    // 판정 값이 깨진 응답은 그리지 않는다 · 점이 아주 많아도 던지지 않는다
    expect(peerStrip('cpu', M({ lo: null }), 300)).toBe(null); expect(peerStrip('cpu', M({ points: 'x' }), 300)).toBe(null); expect(peerStrip('cpu', null, 300)).toBe(null);
    expect(() => peerStrip('power', M({ value: 5, points: Array.from({ length: 200000 }, (_, i) => i % 50), lo: 0, hi: 60, unit: 'W' }), 300)).not.toThrow();
  });
});

describe('구역 렌더(PeerSection)', () => {
  it('띠 넷 · 띠 · 점 · 표식(색) · 배지 · 범례 넷 · 폭의 정의 · 줄마다 기준(구멍 T2 · T4 · T7 · T8)', async () => {
    const loading = await render({ peer: { d: null, err: '' } });
    expect(text(loading)).toContain('같은 묶음 대비'); expect(text(loading)).toContain('읽는 중…');
    expect(text(loading)).not.toContain('지난 24시간 평균');
    const html = await render({ peer: { d: D(), err: '' } });
    const t = text(html);
    expect(t).toContain('SVC › DB · PowerEdge R750 · 6대'); expect(t).toContain('같은 묶음 대비 지표 1개 묶음 밖');
    expect(t).toContain('CPU · 메모리 · 전력은 지난 24시간 평균 · 흡기 온도는 지금 값');
    expect(countOf(html, /<svg/g)).toBe(4);
    expect(countOf(html, /class="peer-band"/g)).toBe(4);
    const dots = PEER_ORDER.reduce((a, id) => a + peerStrip(id, D().metrics[id], 420).dots.length, 0);
    expect(countOf(html, /class="peer-dot"/g)).toBe(dots);
    expect(countOf(html, /class="peer-self"/g)).toBe(4);
    // 표식 색 — 묶음 밖 = 주황 · 안 = 파랑(CPU 만 밖)
    expect([...html.matchAll(/class="peer-self"[^>]*fill="([^"]+)"/g)].map((m) => m[1])).toEqual(['var(--amber, #f59e0b)', 'var(--accent)', 'var(--accent)', 'var(--accent)']);
    expect(html).toContain('aria-label="CPU — 묶음 가운데값 22% · 이 서버 78% · 묶음보다 높음"');
    expect(t).toContain('이 서버 78%'); expect(t).toContain('가운데값 22% · 값 범위 19% ~ 78% · 묶음의 폭 10% ~ 34% · 값 있는 서버 6대');
    expect(t).toContain('값 있는 서버 5대 · 값 없는 1대 제외');
    // 줄마다 기준(머리 글에 같은 낱말이 있어도 줄의 글자로 본다)
    expect([...html.matchAll(/class="muted bmd-peer-basis">([^<]+)</g)].map((m) => m[1])).toEqual(['지난 24시간 평균', '지난 24시간 평균', '지난 24시간 평균', '지금 값']);
    // 범례 넷 · 폭의 정의
    for (const l of ['같은 묶음 서버', '이 서버', '이 서버(묶음 밖)', '묶음의 폭']) expect(t).toContain(l);
    expect(countOf(html, /class="bmf-lg"/g)).toBe(4);
    expect(t).toContain(PEER_FOOT); expect(PEER_FOOT).toContain('가운데 절반(사분위 범위)');
    // 묶음 밖 = 주황 배지(머리 하나 + 줄 하나) · 빨강 · 초록 배지는 없다
    expect(countOf(html, /badge amber/g)).toBe(2); expect(html).not.toMatch(/badge (red|green)/);
  });

  it('같은 값 서버의 대수 글자를 그린다(반증 B1)', async () => {
    const d = D({ metrics: { ...D().metrics, cpu: M({ value: 30, points: Array(80).fill(30), lo: 20, hi: 40, n: 80, max: 30, min: 30 }) } });
    expect(await render({ peer: { d, err: '' } })).toMatch(/class="peer-count"[^>]*>79대</);
  });

  it('판정하지 않은 지표는 띠 대신 이유 · 띠가 없으면 범례 없음 · 견주지 않는 서버는 이유만 · 묶음 작음은 머리 줄도 · 조회 실패 · 판정 아닌 본문 · ESXi 행(구멍 T6)', async () => {
    const d = D({ out: 0, judged: 2, self: { cpu: { n: 288, cov: 1 } }, metrics: { ...D().metrics, cpu: { state: 'few', value: 78, n: 3, missing: 3, unit: '%', basis: 'avg24' }, power: { state: 'none', value: null, n: 5, missing: 1, unit: 'W', basis: 'avg24' } } });
    const html = await render({ peer: { d, err: '' } });
    expect(countOf(html, /<svg/g)).toBe(2);
    const t = text(html);
    expect(t).toContain('값이 있는 서버가 3대입니다 — 5대 이상일 때 견줍니다. 이 서버 78%.'); expect(t).toContain('이 서버의 값이 없어 견주지 않았습니다.');
    expect(t).not.toMatch(/— ?W|—%|— ?℃/);
    const none = D({ out: 0, judged: 0, metrics: Object.fromEntries(PEER_ORDER.map((id) => [id, { state: 'none', value: null, n: 0, missing: 6, basis: 'avg24' }])) });
    expect(countOf(await render({ peer: { d: none, err: '' } }), /class="bmf-lg"/g)).toBe(0);
    const un = await render({ peer: { d: { ok: true, min: 5, why: 'unplaced' }, err: '' } });
    expect(text(un)).toContain(PEER_WHY.unplaced); expect(un).not.toContain('<svg'); expect(text(un)).not.toContain(PEER_FOOT);
    expect(un).not.toMatch(/class="badge/); expect(un).not.toContain('bmd-sh-sub');
    const few = await render({ peer: { d: { ok: true, min: 5, why: 'few', group: { path: 'SVC\\DB', model: 'PowerEdge R750', size: 3 } }, err: '' } });
    expect(few).toMatch(/class="bmd-peer-head">SVC ›/); expect(text(few)).toContain('같은 폴더 · 같은 모델 서버가 3대입니다');
    const err = await render({ peer: { d: null, err: '권한이 없습니다.' } });
    expect(text(err)).toContain('권한이 없습니다.'); expect(text(err)).not.toContain('읽는 중');
    const bad = await render({ peer: { d: { ok: false }, err: '' } });
    expect(text(bad)).toContain('응답 형식이 달라 판정을 보여 주지 못했습니다.'); expect(text(bad)).not.toContain('판정 안 함'); expect(countOf(bad, /class="bmf-lg"/g)).toBe(0);
    const { PeerSection } = await import('./PeerSection.jsx');
    const esxi = renderToStaticMarkup(React.createElement(PeerSection, { r: { key: 'h:1', kind: 'esxi' }, peer: { d: D(), err: '' } }));
    expect(text(esxi)).toContain(PEER_WHY.esxi); expect(esxi).not.toContain('<svg'); expect(esxi).not.toContain('bmd-sh-sub');
  });

  it('다시 묻는 중(폴더를 옮긴 뒤 등)에는 이전 판정을 보이지 않는다(반증 B3)', async () => {
    const html = await render({ peer: { d: D(), err: '', stale: true } });
    expect(text(html)).toContain('다시 읽는 중…'); expect(html).not.toContain('<svg'); expect(text(html)).not.toContain('SVC › DB');
  });

  it('따로 센 것은 줄마다 · 사유는 접어 둔다(반증 B12 · 구멍 T3)', async () => {
    const html = await render({ peer: { d: D({ group: { path: 'SVC\\DB', model: 'PowerEdge R750', size: 85, used: 80, truncated: 5 }, notes: { oldEdge: 1, edgeFail: 2 }, reasons: ['사유 하나', '사유 둘'] }), err: '' } });
    expect(countOf(html, /<li>/g)).toBe(5);
    expect(html).toMatch(/<details class="bmd-peer-why-more"><summary class="muted">엣지 사유 2건<\/summary>/);
    expect(text(html)).toContain('묶음이 85대라 80대만 견줬습니다(5대 제외).');
  });
});

describe('소스 스윕', () => {
  it('드로어가 열 때 1건 조회(베어메탈 행만 · 목록 세대가 바뀌면 다시) · 추이 구역 아래에 그린다 · 다시 묻는 중 표지(stale) · 그림 폭은 칸의 폭', () => {
    const src = read('./BmDrawer.jsx');
    expect(src).toMatch(/useOnce\('\/tools\/bm-folders\/peer', r\?\.key \|\| '', \{ g: gen \}, !!r && isBm\)/);
    expect(src).toMatch(/afterTrend=\{<PeerSection r=\{r\} peer=\{peer\} \/>\}/);
    expect(src).toMatch(/return st\.key === key \? \{ \.\.\.st, stale: st\.sig !== sig \}/);
    const body = src.slice(src.indexOf('export function DrawerSections'));
    expect(body.indexOf('{afterTrend}')).toBeGreaterThan(body.indexOf('aria-label="24시간 추이"'));
    expect(body.indexOf('{afterTrend}')).toBeLessThan(body.indexOf('aria-label="신호"'));
    expect(read('./PeerSection.jsx')).toMatch(/const boxW = useBoxWidth\(boxRef, 420\);\s*const s = peerStrip\(id, m, boxW\);/);
  });

  it('구역 · 글자 모듈은 판정을 복제하지 않는다 · 문구에 백틱이 없다(두 파일 — 구멍 T11) · 대문자 변환 없음 · 좁은 화면 배치(구멍 T10)', () => {
    const sec = read('./PeerSection.jsx'); const txt = read('./peerText.js');
    for (const s of [sec, txt]) { expect(s).not.toMatch(/quantile|1\.5 \*|IQR/); expect(s).not.toMatch(/text-transform/); }
    expect(sec).not.toContain('<table'); expect(sec).not.toMatch(/fetchJson|postJson/);
    for (const s of [sec, txt]) {
      for (const q of s.match(/'[^'\n]*'/g) || []) if (/[가-힣]/.test(q)) expect(q.slice(1, -1)).not.toContain('`');
      for (const j of s.match(/>[^<>{}\n]*[가-힣][^<>{}\n]*</g) || []) expect(j).not.toContain('`');
    }
    const css = fs.readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8');
    const at = css.indexOf('.bmd-peer-head'); const block = css.slice(at, at + 2400);
    expect(at).toBeGreaterThan(0); expect(block).not.toMatch(/text-transform/); expect(block).toMatch(/\.bmd-peer-row \{[^}]*minmax\(0, 1fr\)/);
    expect(block).toMatch(/\.bmd-peer-s \{ min-width: 0; \}/);
    expect(block).toMatch(/@media \(max-width: 520px\) \{ \.bmd-peer-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});
