import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { dbCountText, dbMetaText } from './ipamDbInfoText.js';

describe('v2.732 IP관리 공유 DB 카드 — count 가 null 이어도 죽지 않는다(B3-08 후속)', () => {
  it('범위 계정(count:null + fleetCountsHidden) 은 — 와 사유', () => {
    const db = { count: null, kind: 'sqlite', fleetCountsHidden: true };
    expect(dbCountText(db)).toBe('—');
    expect(dbMetaText(db)).toContain('범위 계정');
  });
  it('못 읽은 경우(count:null) 는 0 이 아니라 —', () => {
    expect(dbCountText({ count: null, kind: 'ndjson' })).toBe('—');
    expect(dbMetaText({ count: null, kind: 'ndjson' })).toContain('읽지 못했습니다');
  });
  it('숫자면 예전처럼', () => {
    expect(dbCountText({ count: 12345, kind: 'sqlite' })).toBe((12345).toLocaleString());
    expect(dbMetaText({ count: 12345, kind: 'sqlite' })).toBe('SQLITE');
  });
  it('IpamCore 는 count 를 직접 toLocaleString 하지 않는다', () => {
    const src = fs.readFileSync(new URL('./IpamCore.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/db\.count\.toLocaleString/);
    expect(src).toMatch(/dbCountText\(db\)/);
  });
});
