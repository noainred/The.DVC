// 42회차 R3: 못 연 시간 단위 파일이 있으면 원시 행 수는 하한('최소') · 장치 1시간 롤업 누락은 따로 밝힌다.
import { describe, it, expect } from 'vitest';
import { retentionNote } from './bmUsageText.js';

describe('retentionNote', () => {
  const st = { rawRetentionDays: 30, dailyRetentionDays: 1825 };
  it('부분이면 최소 · 못 읽은 파일 수', () => {
    expect(retentionNote(st, { rawRows: 10, rawRowsPartial: true, rawUnread: 2 })).toMatch(/현재 원시 최소 10행\(파일 2개 못 읽음\)/);
  });
  it('온전하면 예전 문구 그대로', () => {
    expect(retentionNote(st, { rawRows: 10 })).toMatch(/현재 원시 10행\./);
  });
  it('장치 1시간 롤업 누락', () => {
    expect(retentionNote(st, { rawRows: 10, devRollupMissed: { rows: 3 } })).toMatch(/장치 1시간 롤업에서 빠진 표본 3건/);
  });
});
