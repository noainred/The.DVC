// [탐침 · 테스트 공백 축 r6] 웹 판정 — 살아남은 변이(W03 · W07 · W11 · W12 · W14 · W15 · W16)를 잡는 시험.
//   사본의 web/src/views/tools/ 에 rackViewR6probe.test.js 로 복사해 돌린다(원 저장소에는 넣지 않는다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './rackView.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const TOOL = strip(fs.readFileSync(path.join(here, 'RackTool.jsx'), 'utf8'));
const CENSUS = strip(fs.readFileSync(path.join(here, 'RackMaskCensus.jsx'), 'utf8'));

describe('linkNameText — 한 키만 실린 응답', () => {
  it('W03: 두 키 중 하나만 있어도 그 값으로 그린다(둘 다 없을 때만 null)', () => {
    expect(V.linkNameText({ name: 'kr-esx-01' })).toBe('kr-esx-01');
    expect(V.linkNameText({ hostname: 'os-host' })).toBe('os-host');
    expect(V.linkNameText({ name: '' })).toBe('—');
  });
});

describe('censusRows — 못 읽은 값', () => {
  it('W07 · W11: 음수 · NaN · Infinity 는 수가 아니다(null)', () => {
    const c = V.censusRows({ fields: { label: { total: -1, addr: NaN, tag: Infinity, firstLabel: 0, altIp: 2 } }, sum: { addr: -3, tag: 1 }, notes: -2 });
    expect([c.rows[0].total, c.rows[0].addr, c.rows[0].tag, c.rows[0].firstLabel, c.rows[0].altIp]).toEqual([null, null, null, 0, 2]);
    expect(c.hidden).toBe(null);
    expect(c.notes).toBe(null);
  });
  it('W14: wider = 첫 마디 + 구분자를 바꾼 IP(태그 수와 다를 때)', () => {
    const c = V.censusRows({ sum: { total: 9, addr: 1, tag: 5, firstLabel: 2, altIp: 3 } });
    expect(c.wider).toBe(5); expect(c.hidden).toBe(6);
  });
  it('W12: notes 도 같은 판정 — 문자열 수 · 음수는 null', () => {
    expect(V.censusRows({ notes: '5' }).notes).toBe(null);
    expect(V.censusRows({ notes: -1 }).notes).toBe(null);
    expect(V.censusRows({ notes: 0 }).notes).toBe(0);
  });
});

describe('배선(문자열이 아니라 그 식이 쓰이는 자리)', () => {
  it('W15: 미배치 대수 머리 — 목록 모드일 때만 “찾은 수 / 전체”', () => {
    expect(TOOL).toContain("{q.trim() && unplacedMode(view) === 'list' ? `${unplacedHit.length} / ${view.unplacedTotal}` : view.unplacedTotal}");
  });
  it('W16: 집계 창 — 성공 · 실패 · 끝 세 갈래가 모두 요청 순번을 본다(늦은 응답을 버린다)', () => {
    expect(CENSUS).toContain('if (my === seq.current) { setData(r); setErr(null); }');
    expect(CENSUS).toContain('if (my === seq.current) setErr(e);');
    expect(CENSUS).toContain('if (my === seq.current) setBusy(false);');
  });
});
