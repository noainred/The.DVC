// v2.631 감사 그룹 c — IPAM 예약 만료일 되읽기(R2631-02·A6-2631-02). 기준 시각은 고정값.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { reservedDayOf, reservedUntilText, reservedFieldForSave } from './ipamReserveText.js';
import { stripComments } from '../../test/_stripComments.js';

// 서버 reservedUntilIso 와 같은 식(포탈 오프셋 기준 다음 날 00:00) — 웹은 서버 소스를 import 할 수 없다(번들 경계).
function serverIso(day, off) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - off * 60_000).toISOString();
}

describe('reservedDayOf', () => {
  it('저장 → 되읽기 → 저장을 반복해도 날짜가 밀리지 않는다', () => {
    for (const off of [540, 0, -300, 330]) {
      let d = '2026-10-01';
      for (let i = 0; i < 4; i++) d = reservedDayOf(serverIso(d, off), off);
      expect(d).toBe('2026-10-01');
    }
  });
  it('오프셋이 없으면 서버 기본(540) — KST 저장값 2026-10-01T15:00Z 는 10월 1일', () => {
    expect(reservedDayOf('2026-10-01T15:00:00.000Z')).toBe('2026-10-01');
    expect(reservedDayOf('2026-10-01T15:00:00.000Z', null)).toBe('2026-10-01');
  });
  it('날짜만 온 값은 그대로 · 읽지 못하면 빈 값', () => {
    expect(reservedDayOf('2026-10-01', 0)).toBe('2026-10-01');
    expect(reservedDayOf('', 540)).toBe('');
    expect(reservedDayOf(null, 540)).toBe('');
    expect(reservedDayOf('xx', 540)).toBe('');
  });
  it('툴팁 문구는 포탈 날짜 · 없으면 빈 값', () => {
    expect(reservedUntilText('2026-10-01T15:00:00.000Z', 540)).toBe('2026-10-01 까지');
    expect(reservedUntilText(null, 540)).toBe('');
  });
});

describe('reservedFieldForSave', () => {
  it('바뀌지 않았으면 본문에서 뺀다 · 바뀌었거나 새/일괄이면 보낸다', () => {
    expect(reservedFieldForSave('2026-10-01', '2026-10-01')).toEqual({});
    expect(reservedFieldForSave('2026-10-02', '2026-10-01')).toEqual({ reservedUntil: '2026-10-02' });
    expect(reservedFieldForSave('', '2026-10-01')).toEqual({ reservedUntil: null });
    expect(reservedFieldForSave('2026-10-01', '2026-10-01', { always: true })).toEqual({ reservedUntil: '2026-10-01' });
    expect(reservedFieldForSave('', '', { always: true })).toEqual({ reservedUntil: null });
  });
});

describe('화면 소스', () => {
  const settings = stripComments(fs.readFileSync(new URL('./IpamSettings.jsx', import.meta.url), 'utf8'));
  const core = stripComments(fs.readFileSync(new URL('./IpamCore.jsx', import.meta.url), 'utf8'));
  it('폼은 만료 ISO 를 slice(0,10) 으로 되읽지 않는다', () => {
    expect(settings).not.toMatch(/reservedUntil\)\.slice\(0,\s*10\)/);
    expect(settings).toMatch(/reservedDayOf\(/);
    expect(settings).toMatch(/reservedFieldForSave\(/);
    expect(settings).toMatch(/r\.reservedUntilDay/);
  });
  it('목록 툴팁은 브라우저 시간대가 아니라 포탈 오프셋 날짜', () => {
    expect(core).not.toMatch(/new Date\(r\.reservedUntil\)/);
    expect(core).toMatch(/reservedUntilText\(r\.reservedUntil, data\.tzOffsetMin\)/);
    expect(core).toMatch(/tzOffsetMin=\{data\.tzOffsetMin\}/);
  });
});
