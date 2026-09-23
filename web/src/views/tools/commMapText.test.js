/** 통신 지도 문구 회귀 — ‘기록 없음’ 을 정상으로 칠하지 않는다 · 첫 조회는 입자 없음 · null 은 0 이 아니다. */
import { describe, it, expect } from 'vitest';
import {
  STATE_LABEL, STATE_COLOR, REASON_TEXT, RES_STATE_LABEL, RES_STATE_COLOR, bytesText, spanText, headerNote, activityOf, edgeSummary, resourceSummary, LEGEND_NOTES,
} from './commMapText.js';

const NOW = 1_800_000_000_000;

describe('commMapText', () => {
  it('unknown·disabled 는 초록도 빨강도 아니다 · registered 는 정상색이 아니다', () => {
    expect(STATE_COLOR.unknown).not.toBe(STATE_COLOR.ok); expect(STATE_COLOR.unknown).not.toBe(STATE_COLOR.fail);
    expect(STATE_COLOR.disabled).not.toBe(STATE_COLOR.ok);
    expect(RES_STATE_COLOR.registered).not.toBe(RES_STATE_COLOR.ok);
    expect(RES_STATE_LABEL.registered).toMatch(/등록부/);
    expect(STATE_LABEL.unknown).toBe('확인 불가');
  });
  it('사유 문구는 제목+조치이고 백틱·3단 대시가 없다', () => {
    for (const [k, v] of Object.entries(REASON_TEXT)) {
      expect(v.title, k).toBeTruthy(); expect(v.fix, k).toBeTruthy();
      expect(`${v.title}${v.fix}`).not.toMatch(/`/);
      expect((`${v.title} ${v.fix}`.match(/ — /g) || []).length).toBeLessThanOrEqual(1);
    }
    for (const n of LEGEND_NOTES) expect(n).not.toMatch(/`/);
  });
  it('spanText — 기간은 ‘N초 전’ 이 아니라 ‘N초’ · null 은 —', () => {
    expect(spanText(15_000)).toBe('15초'); expect(spanText(300_000)).toBe('5분'); expect(spanText(90_000)).toBe('1.5분'); expect(spanText(3_600_000)).toBe('1시간');
    expect(spanText(null)).toBe('—'); expect(spanText('')).toBe('—'); expect(spanText(0)).toBe('0초');
  });
  it('bytesText — null/빈 값은 — 이지 0 B 가 아니다', () => {
    expect(bytesText(null)).toBe('—'); expect(bytesText('')).toBe('—'); expect(bytesText(0)).toBe('0 B');
    expect(bytesText(1536)).toBe('1.5 KB'); expect(bytesText(3 * 1024 ** 3)).toBe('3.00 GB');
  });
  it('headerNote — 0곳 / 전부 unknown / 장애 / 정상을 구분하고 미배정을 덧붙인다', () => {
    expect(headerNote({ counts: { edges: 0 } }).text).toMatch(/등록된 수집 서버.*없습니다/);
    const allUnknown = headerNote({ at: NOW, hub: { pullIntervalMs: 60_000 }, counts: { edges: 3, byState: { unknown: 3 } } }, NOW);
    expect(allUnknown.tone).toBe('amber'); expect(allUnknown.text).toMatch(/확인 불가/); expect(allUnknown.text).toMatch(/재시작/);
    const fail = headerNote({ at: NOW, counts: { edges: 3, byState: { ok: 1, fail: 2 }, unassigned: 2 } }, NOW);
    expect(fail.tone).toBe('red'); expect(fail.text).toMatch(/\*\*장애 2곳\*\*/); expect(fail.text).toMatch(/미배정|담당 엣지를 알 수 없는 자원 2개/);
    const ok = headerNote({ at: NOW - 5000, counts: { edges: 2, byState: { ok: 2 } } }, NOW);
    expect(ok.tone).toBe('green'); expect(ok.text).toMatch(/모두 pull·push 가 정상/);
  });
  it('activityOf — 첫 조회는 전부 false, pull.at 변화·pushes 증가만 true', () => {
    const cur = { edges: [{ id: 'a', pull: { at: 10 }, push: { pushes: 5 } }, { id: 'b', pull: { at: 10 }, push: { pushes: 5 } }] };
    expect(activityOf(null, cur)).toEqual({ a: { pull: false, push: false }, b: { pull: false, push: false } });
    const prev = { edges: [{ id: 'a', pull: { at: 9 }, push: { pushes: 4 } }, { id: 'b', pull: { at: 10 }, push: { pushes: 5 } }] };
    expect(activityOf(prev, cur)).toEqual({ a: { pull: true, push: true }, b: { pull: false, push: false } });
    // pull 기록이 처음 생긴 것도 관측이다 · pushes 가 줄면(재시작) 관측이 아니다
    expect(activityOf({ edges: [{ id: 'a', pull: { at: null }, push: { pushes: 9 } }] }, cur).a).toEqual({ pull: true, push: false });
  });
  it('edgeSummary / resourceSummary 는 값이 없으면 지어내지 않는다', () => {
    expect(edgeSummary({ state: 'unknown', pull: { state: 'none' }, push: { state: 'none' }, resourceCounts: { total: 0 } })).toBe('확인 불가 · pull 기록 없음 · push 기록 없음');
    expect(resourceSummary({ kind: 'storage', name: 'S1', state: 'registered', type: 'unity480' })).toBe('스토리지 S1 · 등록됨(등록부 기준) · unity480');
    const vc = resourceSummary({ kind: 'vcenter', name: 'V', state: 'ok', receivedAt: NOW - 60_000, hosts: 2, vms: null, agentMismatch: true, remoteAgent: 'GM1', collectedBy: 'hg' }, NOW);
    expect(vc).toMatch(/호스트 2 · VM —/); expect(vc).toMatch(/‘GM1’ 인데 실제 push 는 ‘hg’/);
  });
});
