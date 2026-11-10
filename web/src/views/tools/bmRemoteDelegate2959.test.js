/**
 * v2.959 — 엣지 iDRAC 스캔 서버가 중앙에서 ‘iDRAC 등록 없음’ 으로 보이던 결함의 화면 쪽(순수).
 *  · ‘대상이 아닌 서버 — 사유별’ 의 엣지 수집 줄에 **엣지별 대수**(응답 제외 목록에서 센다 — 범위 계정은 서버가 범위 안 행만 준다) · 그 엣지의 상태(엣지 보관분 표와 같은 판정)
 *  · 표에 없는 엣지의 상태를 지어내지 않는다 · 새 사유 code(remote-collector-unknown) 라벨 · 빈 화면 진단 · 누락 점검 사유 문구
 *  · 문구 규약: 백틱 없음 · 숫자 박지 않음(대수는 입력에서) · 이름은 ‘ ’ 인용(BoldText 의 ** 와 섞이지 않게)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeDelegatedByAgent, edgeDelegatedChip, edgeDelegatedGuide, skippedNotes, SKIP_LABEL, emptyDiag, edgePullState } from './bmUsageText.js';
import { MISS_REASON_TEXT } from './bmOnboardText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('v2.959 엣지 수집 — 엣지별', () => {
  const skipped = [
    { reason: 'edge-delegated', agent: 'edge-pl', serviceTag: 'A' },
    { reason: 'edge-delegated', agent: 'Edge-PL', serviceTag: 'B' },   // 대소문자만 다른 이름 — 한 묶음
    { reason: 'edge-delegated', agent: 'edge-us', serviceTag: 'C' },
    { reason: 'edge-delegated', agent: '', serviceTag: 'D' },
    { reason: 'no-idrac', serviceTag: 'E' },
    { reason: 'remote-collector-unknown', serviceTag: 'F' },
    null, 'x',
  ];
  it('엣지별 대수(대수 내림차순 · 이름순) · 이름 없는 행은 한 묶음 · 다른 사유는 세지 않는다', () => {
    const l = edgeDelegatedByAgent(skipped);
    expect(l.map((x) => [x.agent, x.count])).toEqual([['edge-pl', 2], ['', 1], ['edge-us', 1]]);
    expect(l.every((x) => x.state === null)).toBe(true);
    expect(edgeDelegatedByAgent(undefined)).toEqual([]);
  });
  it('상태는 엣지 표 판정(edgePullState) 그대로 — 표에 없으면 지어내지 않는다', () => {
    const offRow = { agent: 'edge-pl', enabled: true, hasUrl: true, snapAt: Date.now(), enabledOnEdge: false, nodeRole: 'edge' };
    const st = edgePullState(offRow, { canEnableCentral: true });
    const l = edgeDelegatedByAgent(skipped, { stateOf: (a) => (a.toLowerCase() === 'edge-pl' ? st : null) });
    expect(l[0].state.label).toBe('엣지에서 꺼짐');
    expect(edgeDelegatedChip(l[0])).toBe('‘edge-pl’ 2대 · 엣지에서 꺼짐');
    expect(edgeDelegatedChip(l.find((x) => x.agent === 'edge-us'))).toBe('‘edge-us’ 1대 · 엣지 보관분 표에 없음');
    expect(edgeDelegatedChip(l.find((x) => x.agent === ''))).toBe('이름 모름 1대');
    const g = edgeDelegatedGuide(l);
    expect(g).toMatch(/그 엣지가 수집/);
    expect(g).toMatch(/\*\*엣지에서 꺼짐\*\*/);   // 꺼진 엣지가 있으면 강조
    expect(g).toMatch(/중앙에서 켜기/);
    expect(g).toMatch(/표에 없는 엣지는/);
    expect(edgeDelegatedGuide([])).toBe('');
    // 꺼진 엣지가 없고 전부 표에 있으면 표 없음 안내를 붙이지 않는다
    const okSt = edgePullState({ agent: 'edge-us', enabled: true, hasUrl: true, snapAt: Date.now(), enabledOnEdge: true });
    const g2 = edgeDelegatedGuide([{ agent: 'edge-us', count: 3, state: okSt }]);
    expect(g2).not.toMatch(/표에 없는 엣지는/);
    expect(g2).not.toMatch(/\*\*엣지에서 꺼짐\*\*/);
    // stateOf 가 던져도 화면이 죽지 않는다
    expect(edgeDelegatedByAgent(skipped, { stateOf: () => { throw new Error('x'); } })[0].state).toBe(null);
  });
  it('새 사유 code — 라벨 · 빈 화면 진단 · 누락 점검 문구', () => {
    expect(SKIP_LABEL['remote-collector-unknown']).toBe('수집 서버 모름');
    const notes = skippedNotes({ 'remote-collector-unknown': 3, 'edge-delegated': 2 }, { 'remote-collector-unknown': '서버 문구', 'edge-delegated': '엣지 문구' });
    expect(notes).toEqual(['**수집 서버 모름 3대** — 서버 문구', '**엣지 수집 2대** — 엣지 문구']);
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [], skippedCounts: { 'remote-collector-unknown': 4 } });
    expect(d.kind).toBe('no-target');
    expect(d.text).toMatch(/원격 수집 서버를 모르는 서버 \*\*4대\*\*/);
    expect(MISS_REASON_TEXT['remote-collector-unknown']).toMatch(/모름/);
  });
  it('문구 규약 — 백틱 없음 · 대문자 변환 없음(소스 스윕)', () => {
    const src = fs.readFileSync(path.join(HERE, 'bmUsageText.js'), 'utf8');
    const block = src.slice(src.indexOf('export const SKIP_LABEL'), src.indexOf('v2.744(최종 검토 RV-1·RV-2)'));
    expect(block.length).toBeGreaterThan(500);
    expect(block.includes('`**')).toBe(true);   // 템플릿 리터럴은 쓰되
    const strings = block.match(/'[^'\n]*'/g) || [];
    expect(strings.some((s) => s.includes('`'))).toBe(false);   // 문구 안에 백틱 없음
    const jsx = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    const seg = jsx.slice(jsx.indexOf('v2.959 엣지 수집 — 엣지별 대수'), jsx.indexOf('엣지 보관분 표로 이동'));
    expect(seg.length).toBeGreaterThan(200);
    expect(seg).toMatch(/flexWrap: 'wrap'/);
    expect(seg).not.toMatch(/uppercase/);
  });
});
