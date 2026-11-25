import { describe, it, expect } from 'vitest';
import { fmtAgo, num, fmtW, fmtWh, fmtKg, fmtBytes, dec1, fmtDate, fmtTime } from './fmt.js';

// v2.319 모듈화 #9 — 통합 이동한 포맷터의 의미를 고정(이동 중 동작이 바뀌지 않았음을 보증).
describe('util/fmt', () => {
  it('fmtW — 단위 승급(W→kW→MW→GW)·비수치 —', () => {
    expect(fmtW(950)).toBe('950 W');
    expect(fmtW(131133)).toBe('131.1 kW');   // Insights 주석의 실측 예시 그대로
    expect(fmtW(2.5e6)).toBe('2.5 MW');
    expect(fmtW(3e9)).toBe('3 GW');
    expect(fmtW(null)).toBe('—');
    expect(fmtW('abc')).toBe('—');
  });
  it('fmtWh — kWh→MWh→GWh', () => {
    expect(fmtWh(141623.6)).toBe('141.6 MWh'); // 주석 예시
    expect(fmtWh(500)).toBe('500 kWh');
    expect(fmtWh(2e6)).toBe('2 GWh');
  });
  it('fmtKg — kg→t', () => {
    expect(fmtKg(999)).toBe('999 kg');
    expect(fmtKg(1500)).toBe('1.5 t');
    expect(fmtKg(null)).toBe('—');
  });
  it('fmtBytes — 0 은 0 B · 결측은 —(v2.613 WEB2613-03) · GB 상한', () => {
    expect(fmtBytes(0)).toBe('0 B');           // 0 은 값이다
    expect(fmtBytes(null)).toBe('—');          // 읽지 못한 값을 0 B 로 둔갑시키지 않는다(numOrNull)
    expect(fmtBytes('abc')).toBe('—');         // 예전엔 throw(v.toFixed is not a function)
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fmtBytes(9 * 1024 ** 4)).toBe('9216.0 GB'); // GB 상한 — TB 미승급이 원본 동작
  });
  it('fmtAgo — relTime.agoText 의 껍데기(v2.613 DEPS2613-11): 미래는 방금 · 결측은 —', () => {
    expect(fmtAgo(Date.now() + 60_000)).toBe('방금'); // 미래 ts(시계 오차)도 음수로 안 내려감 — 코어 규칙은 '방금'
    expect(fmtAgo(0)).toBe('—');
    expect(fmtAgo(null, { dash: '없음' })).toBe('없음');
  });
  it('num/dec1 — null 안전·소수 1자리', () => {
    expect(num(null)).toBe('—');
    expect(num(1234567)).toBe((1234567).toLocaleString());
    expect(dec1(1.26)).toBe('1.3');
  });
  // v3.10.7(공통 기능 점검 5회차): `Number('') === 0` 이라 빈 문자열이 '0 W'·'0 kWh'·'0 kg'·'0' 으로 둔갑했다.
  it('못 읽은 값(빈 문자열 · 공백 · 배열)은 0 이 아니라 —', () => {
    for (const v of ['', '  ', [], {}]) {
      expect(fmtW(v)).toBe('—');
      expect(fmtWh(v)).toBe('—');
      expect(fmtKg(v)).toBe('—');
      expect(num(v)).toBe('—');
      expect(dec1(v)).toBe('—');
    }
    expect(num('abc')).toBe('—');       // 예전엔 'NaN'
    expect(fmtW(0)).toBe('0 W');         // 0 은 값이다
    expect(fmtW('1500')).toBe('1.5 kW'); // 숫자 문자열은 수로
    expect(num(0)).toBe('0');
  });
  it('fmtDate · fmtTime — 못 읽는 시각은 Invalid Date 가 아니라 —', () => {
    expect(fmtDate('abc')).toBe('—');
    expect(fmtTime('not-a-date')).toBe('—');
    expect(fmtTime(NaN)).toBe('—');
    expect(fmtTime(null)).toBe('—');
    expect(fmtTime(0)).toBe('—');        // 0(epoch)은 '기록 없음' 관례 그대로
    expect(fmtDate(new Date(Number.NaN))).toBe('—');
    expect(fmtTime(Date.UTC(2026, 10, 14))).not.toBe('—');
    expect(fmtDate('2026-11-14T00:00:00Z')).not.toBe('—');
  });
});
