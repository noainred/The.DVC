/**
 * focusMonMetrics.test.js — v3.12.0 ‘더할 지표’(시안 ⑬ Metrics) 화면 글 · 판정 규칙. 계산은 서버(rates · query) — 여기는 글자로 바꾸는 규칙만 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  DASH, METRICS, CARD_LINE_ITEMS, normCardLine, cardLineCells, metricValueText, metricUnitText,
  fsLevel, fillText, kbText, fsHeadText, EXT_CARDS, extNow, extTone, extSub, reclaimText,
} from './focusMonText.js';

describe('더할 지표 — 글 · 판정', () => {
  it('비교 지표 · 카드 아래 줄에 새 항목(서버 열쇠와 같은 이름)', () => {
    expect(METRICS.map((m) => m.key)).toEqual(['cpu', 'mem', 'net', 'disk', 'fs', 'tcp', 'sched', 'vmp']);
    expect(METRICS.find((m) => m.key === 'sched').items.map((x) => x[0])).toEqual(['cs', 'in', 'fk', 'run', 'D', 'Z']);
    for (const k of ['fsMax', 'tcpRt', 'procD', 'rq', 'swIo']) expect(CARD_LINE_ITEMS.some((x) => x.key === k)).toBe(true);
    expect(normCardLine(['fsMax', 'procD'])).toEqual(['fsMax', 'procD']);
    const cells = cardLineCells({ fsMax: 93.4, tcpRt: null, procD: 2, rq: 1.5, swIo: 0 }, ['fsMax', 'tcpRt', 'procD', 'rq']);
    expect(cells.map((c) => c.text)).toEqual(['FS 최대 93%', `재전송 ${DASH}`, 'D 상태 2', '실행 대기/코어 1.50']);
    expect(metricValueText('tcp', 'lo', 0.2)).toBe('12.0'); // 초당 → 분당
    expect(metricUnitText('tcp', 'lo')).toBe('회/분');
    expect(metricValueText('fs', 'pct', null)).toBe(DASH);
    expect(metricUnitText('vmp', 'si')).toBe('페이지/초');
  });

  it('파일시스템 — 설정 문턱 · 가득 찰 때까지(추정) · 크기 · 머리', () => {
    const st = { warnPct: 80, critPct: 90 };
    expect([fsLevel(79.9, st), fsLevel(80, st), fsLevel(90, st), fsLevel(null, st)]).toEqual(['ok', 'warn', 'crit', null]);
    expect(fsLevel(85, { warnPct: 70, critPct: 85 })).toBe('crit');
    expect(fillText({ state: 'not-record' }, '/').text).toBe(DASH);
    expect(fillText({ state: 'short', spanH: 3 }, '/').title).toMatch(/3시간 — 6시간보다 짧아/);
    const f = { state: 'ok', spanH: 24, rows: { '/var': { days: 2.6, trend: 'up', perDay: 1.1 }, '/': { days: null, trend: 'flat', perDay: 0 }, '/a': { days: null, trend: 'up', perDay: 0.06 }, '/b': { days: 20, trend: 'up', perDay: 0.5 } } };
    expect(fillText(f, '/var')).toMatchObject({ text: '약 2.6일(추정)', tone: 'crit' });
    expect(fillText(f, '/b')).toMatchObject({ text: '약 20일(추정)', tone: 'off' });
    expect(fillText({ state: 'ok', spanH: 24, rows: { '/v': { days: 9, trend: 'up', perDay: 1 } } }, '/v').text).toBe('약 9일(추정)');
    expect(fillText(f, '/').text).toBe('늘지 않음');
    expect(fillText(f, '/a').text).toBe('1년 넘게');
    expect(fillText(f, '/none').text).toBe(DASH);
    expect(kbText(1024)).toBe('1.0 MB'); expect(kbText(null)).toBe(DASH);
    expect(fsHeadText(null)).toMatch(/아직/);
    expect(fsHeadText({ rc: 137, rows: [] })).toMatch(/응답 없음/);
    expect(fsHeadText({ rc: 0, at: 1000, rows: [] }, 31_000)).toMatch(/마지막 확인 30초 전/);
  });

  it('새 카드 칸 — 지금 값 · 경고 색 · 최고 줄(못 읽음은 — · 0 과 구분)', () => {
    const table = { tcp: { rt: 0.84, lo: 0.2 }, sched: { cs: 48210 }, vmp: { si: 0 }, pst: { D: 2, Z: 0 }, run: 6 };
    expect(extNow(table, 'p.rt')).toBe(0.84); expect(extNow(table, 'l.run')).toBe(6); expect(extNow(table, 'q.D')).toBe(2); expect(extNow({}, 'k.cs')).toBe(null);
    expect([extTone('p.rt', 0.84), extTone('p.rt', 0.1), extTone('q.D', 2), extTone('v.si', 0), extTone('q.D', null)]).toEqual(['warn', '', 'warn', '', '']);
    const ext = { 'l.run': { max: 21, maxAt: 5 }, 'q.Z': { max: 0, maxAt: 1 }, 'p.rt': { max: null }, 'p.lo': { max: 0.2, maxAt: 7 } };
    const clock = (t) => `t${t}`;
    expect(extSub('l.run', ext, { cores: 16, clock })).toBe('코어 16개 · 최고 21 — t5');
    expect(extSub('q.Z', ext, { clock })).toBe('구간 내내 0');
    expect(extSub('p.rt', ext, { clock })).toBe('이 구간에 값이 없습니다');
    expect(extSub('p.lo', ext, { clock })).toBe('최고 12.0 — t7'); // 회/분
    expect([reclaimText({ sc: 100, sl: 72 }), reclaimText({ sc: 100, sl: 107 }), reclaimText({ sc: 0, sl: 0 }), reclaimText(null)]).toEqual(['72%', '100%', DASH, DASH]);
    const all = [...EXT_CARDS.tcp, ...EXT_CARDS.sched, ...EXT_CARDS.vmp];
    expect(all.length).toBe(14);
    for (const [, label, unit] of all) { expect(label.includes('`')).toBe(false); expect(unit.includes('`')).toBe(false); }
  });
});
