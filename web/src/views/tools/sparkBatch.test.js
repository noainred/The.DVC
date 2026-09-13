// v2.502 — 낭비 리소스 '7일 사용률 추이' 배치 조회 판정 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import {
  chunkIds, sparkCellState, sparkCellText, sparkProgressText, sparkCapText, SPARK_ROW_CAP,
} from './sparkBatch.js';

describe('배치 분할', () => {
  it('표의 모든 행을 덮는다 — 앞 24건만 남기지 않는다', () => {
    // 이것이 사용자 신고의 핵심이다: 표는 50대인데 24대만 요청해 나머지가 영원히 '…' 였다.
    const ids = Array.from({ length: 50 }, (_, i) => `vm${i}`);
    const out = chunkIds(ids, 24);
    expect(out.map((b) => b.length)).toEqual([24, 24, 2]);
    expect(out.flat()).toEqual(ids);
  });
  it('배치 크기는 주입값을 따른다(화면에 24 를 굳히지 않는다)', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `vm${i}`);
    expect(chunkIds(ids, 4).map((b) => b.length)).toEqual([4, 4, 2]);
    expect(chunkIds(ids, 64)).toHaveLength(1);
  });
  it('잘못된 크기·빈 목록에 안전하다(무한 루프 없음)', () => {
    expect(chunkIds(['a', 'b'], 0).map((b) => b.length)).toEqual([1, 1]);
    expect(chunkIds(['a'], -5)).toHaveLength(1);
    expect(chunkIds([], 10)).toEqual([]);
    expect(chunkIds(null, 10)).toEqual([]);
  });
  it('빈 id 는 버린다', () => {
    expect(chunkIds(['a', '', null, 'b'], 10)).toEqual([['a', 'b']]);
  });
});

describe("셀 상태 — '대기' 와 '데이터 없음' 을 구분한다", () => {
  it('아직 안 물어본 행은 대기(…)', () => {
    expect(sparkCellState(undefined, false)).toBe('pending');
    expect(sparkCellText('pending').text).toBe('…');
    expect(sparkCellText('pending').title).toContain('순서대로');
  });
  it('물어봤는데 응답에 없으면 데이터 없음(—)', () => {
    // 배치가 실패한 경우도 여기로 온다 — 영원히 '…' 로 남지 않게 한다.
    expect(sparkCellState(undefined, true)).toBe('none');
    expect(sparkCellState(null, true)).toBe('none');
    expect(sparkCellText('none').text).toBe('—');
  });
  it('점이 2개 미만이면 선을 그릴 수 없다', () => {
    expect(sparkCellState([], true)).toBe('short');
    expect(sparkCellState([{ t: 1, v: 5 }], true)).toBe('short');
    expect(sparkCellText('short').text).toBe('—');
  });
  it('점이 2개 이상이면 그린다', () => {
    expect(sparkCellState([{ t: 1, v: 5 }, { t: 2, v: 6 }], true)).toBe('ok');
    expect(sparkCellText('ok')).toBe(null);
  });
});

describe('진행·한계 문구 — 조용히 자르지 않는다', () => {
  it('진행 중에는 몇 대까지 왔는지 말한다', () => {
    expect(sparkProgressText({ done: 24, total: 50 })).toBe('추이 차트를 불러오는 중입니다 — 24/50대');
  });
  it('끝나면 문구를 남기지 않는다(소음 방지)', () => {
    expect(sparkProgressText({ done: 50, total: 50 })).toBe('');
    expect(sparkProgressText({})).toBe('');
  });
  it('건너뛴 대수는 끝난 뒤에도 밝힌다', () => {
    const t = sparkProgressText({ done: 50, total: 50, skipped: 3 });
    expect(t).toContain('3대');
    expect(t).toContain('조회 범위 밖');
  });
  it('상한을 넘으면 자른 사실과 대안을 알린다', () => {
    expect(sparkCapText(50)).toBe('');
    const t = sparkCapText(SPARK_ROW_CAP + 30);
    expect(t).toContain(`상위 ${SPARK_ROW_CAP}대`);
    expect(t).toContain('리포트');
  });
});
