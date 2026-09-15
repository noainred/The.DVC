// v2.513 — 대량 등록(CSV·자유텍스트) 화면 판정·문구 회귀 고정(node 환경 — 순수 함수만).
//
// 여기서 고정하는 것은 '예쁜가' 가 아니라 **정직한가**다:
//  · '테스트 불가'(엣지 위임)를 '실패' 로 말하지 않는다
//  · 기본 선택에서 '테스트 불가' 를 빼지 않는다(등록해야 엣지가 수집한다)
//  · 입력을 고치면 옛 검증·테스트 결과를 근거로 저장하지 않는다
//  · 제외 건수를 감추지 않는다
import { describe, it, expect } from 'vitest';
import {
  FORMATS, actionLabel, actionClass, testLabel, dryRunSummary, testProgressText,
  stageFlags, defaultSelection, selectableLines, testOnlyNote, registerSummary,
  tokenHint, ioUrl,
} from './bulkIoText.js';

const REPORT = [
  { line: 1, action: 'add' },
  { line: 2, action: 'update' },
  { line: 3, action: 'error', reason: "알 수 없는 타입 'brocadee'" },
];
const CHECK = { total: 3, summary: { add: 1, update: 1, error: 1, withPassword: 2 }, report: REPORT };

describe('형식·배지', () => {
  it('두 형식만 있고 확장자가 서로 다르다', () => {
    expect(FORMATS.map((f) => f.key)).toEqual(['csv', 'text']);
    expect(FORMATS.map((f) => f.ext)).toEqual(['csv', 'txt']);
  });
  it('동작 배지 — 오류는 빨강', () => {
    expect(actionLabel('add')).toBe('추가');
    expect(actionLabel('update')).toBe('수정');
    expect(actionLabel('error')).toBe('오류');
    expect(actionClass('error')).toBe('red');
  });
});

describe("'테스트 불가' 는 '실패' 가 아니다(정직 규약)", () => {
  it('skipped 문구에 실패라는 말이 없다', () => {
    const s = testLabel('skipped');
    expect(s.text).toBe('테스트 불가');
    expect(s.text).not.toMatch(/실패/);
    expect(s.cls).not.toBe('red');
  });
  it('pending 은 실패로 시작하지 않는다(아직 안 한 것)', () => {
    expect(testLabel('pending').text).toBe('대기');
    expect(testLabel('pending').cls).not.toBe('red');
  });
  it('진행 요약은 테스트 불가를 따로 센다', () => {
    const t = testProgressText({ status: 'done', done: 5, total: 5, summary: { ok: 2, fail: 1, skipped: 2, pending: 0 } });
    expect(t).toMatch(/성공 2/);
    expect(t).toMatch(/실패 1/);
    expect(t).toMatch(/테스트 불가 2/);
  });
  it('진행 중과 완료를 구분한다', () => {
    expect(testProgressText({ status: 'running', done: 1, total: 4, summary: { ok: 1, fail: 0, skipped: 0, pending: 3 } }))
      .toMatch(/진행 중 1\/4/);
    expect(testProgressText({ status: 'done', done: 4, total: 4, summary: { ok: 4, fail: 0, skipped: 0, pending: 0 } }))
      .toMatch(/완료/);
  });
});

describe('기본 선택', () => {
  it('오류 행은 고를 수 없다', () => {
    expect(selectableLines(REPORT)).toEqual([1, 2]);
  });
  it('테스트 전에는 오류 아닌 전부', () => {
    expect(defaultSelection(REPORT, null)).toEqual([1, 2]);
  });
  it('연결 실패만 빼고 **테스트 불가는 남긴다**', () => {
    const run = { status: 'done', results: [{ line: 1, status: 'skipped' }, { line: 2, status: 'fail' }] };
    expect(defaultSelection(REPORT, run)).toEqual([1]);
  });
  it('성공한 행은 당연히 남는다', () => {
    const run = { status: 'done', results: [{ line: 1, status: 'ok' }, { line: 2, status: 'ok' }] };
    expect(defaultSelection(REPORT, run)).toEqual([1, 2]);
  });
});

describe('단계 게이팅 — 옛 판정으로 저장하지 않는다', () => {
  it('검증 전에는 테스트·등록이 막힌다', () => {
    const f = stageFlags({ text: 'a\tb', check: null, checkedText: null });
    expect(f.canVerify).toBe(true);
    expect(f.canTest).toBe(false);
    expect(f.canRegister).toBe(false);
  });
  it('빈 입력이면 검증도 막힌다', () => {
    expect(stageFlags({ text: '   ' }).canVerify).toBe(false);
  });
  it('검증 후 입력을 고치면 재검증을 요구한다', () => {
    const f = stageFlags({ text: 'BBB', check: CHECK, checkedText: 'AAA' });
    expect(f.changed).toBe(true);
    expect(f.verified).toBe(false);
    expect(f.canRegister).toBe(false);
    expect(f.note).toMatch(/다시 검증/);
  });
  it('검증 통과 + 정상 행이 있으면 테스트·등록이 열린다', () => {
    const f = stageFlags({ text: 'AAA', check: CHECK, checkedText: 'AAA' });
    expect(f.verified).toBe(true);
    expect(f.okRows).toBe(2);
    expect(f.canTest).toBe(true);
    expect(f.canRegister).toBe(true);
  });
  it('전 행이 오류면 등록 버튼을 열지 않고 이유를 말한다', () => {
    const allBad = { total: 1, summary: { add: 0, update: 0, error: 1, withPassword: 0 }, report: [{ line: 1, action: 'error' }] };
    const f = stageFlags({ text: 'AAA', check: allBad, checkedText: 'AAA' });
    expect(f.canRegister).toBe(false);
    expect(f.note).toMatch(/오류를 먼저 고치세요/);
  });
  it('테스트 진행 중에는 재검증·재테스트·등록을 모두 막는다(장비 로그인 중복 방지)', () => {
    const f = stageFlags({ text: 'AAA', check: CHECK, checkedText: 'AAA', runText: 'AAA', run: { status: 'running', results: [] } });
    expect(f.testRunning).toBe(true);
    expect(f.canVerify).toBe(false);
    expect(f.canTest).toBe(false);
    expect(f.canRegister).toBe(false);
  });
  it('테스트 뒤 입력을 고치면 테스트 결과를 쓰지 않는다고 밝힌다', () => {
    const f = stageFlags({ text: 'AAA', check: CHECK, checkedText: 'AAA', runText: 'OLD', run: { status: 'done', results: [] } });
    expect(f.testStale).toBe(true);
    expect(f.testDone).toBe(false);
    expect(f.note).toMatch(/연결 테스트 결과는 쓰지 않습니다/);
  });
});

describe('조용한 제외 금지', () => {
  it("'연결 성공분만' 은 테스트 불가가 함께 빠지는 사실을 말한다", () => {
    expect(testOnlyNote({ summary: { ok: 1, fail: 0, skipped: 2 } })).toMatch(/테스트 불가' 2건/);
    expect(testOnlyNote({ summary: { ok: 1, fail: 0, skipped: 0 } })).not.toMatch(/테스트 불가/);
  });
  it('등록 결과에 제외 건수를 싣는다', () => {
    const t = registerSummary({ total: 6, added: 2, updated: 0, failed: [], skipped: [{ line: 3 }, { line: 4 }] });
    expect(t).toMatch(/제외 2/);
  });
  it('드라이런 요약에 오류 건수가 보인다', () => {
    expect(dryRunSummary(CHECK)).toMatch(/오류 1/);
    expect(dryRunSummary(null)).toBe('');
  });
});

describe('토큰 위치 — 특정 못 하면 말하지 않는다', () => {
  it('키=값 / 순서 / 누락', () => {
    expect(tokenHint({ field: 'host', token: { form: 'keyed' } })).toBe('`host=` 값');
    expect(tokenHint({ field: 'host', token: { form: 'positional', col: 3 } })).toBe('3번째 항목');
    expect(tokenHint({ field: 'host', token: { form: 'missing', col: 5 } })).toBe('5번째 항목이 없음');
  });
  it('토큰이 없으면 빈 문자열(지어내지 않는다)', () => {
    expect(tokenHint({ field: 'host', token: null })).toBe('');
    expect(tokenHint(null)).toBe('');
  });
});

describe('다운로드 경로', () => {
  it('도구 base + 형식 확장자', () => {
    expect(ioUrl('/tools/storage', 'sample', 'csv')).toBe('/tools/storage/devices/sample.csv');
    expect(ioUrl('/tools/sanswitch', 'export', 'text')).toBe('/tools/sanswitch/devices/export.txt');
  });
});
