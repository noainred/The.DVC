import { describe, it, expect } from 'vitest';
import { fmtAgo, num, fmtW, fmtWh, fmtKg, fmtBytes, dec1 } from './fmt.js';

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
  it('fmtBytes — falsy=0 B·GB 상한(PortalBackup/DavinciChecks 복붙 통합본 의미 보존)', () => {
    expect(fmtBytes(0)).toBe('0 B');           // PortalDb 변형('—')과 다른 의도된 의미
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fmtBytes(9 * 1024 ** 4)).toBe('9216.0 GB'); // GB 상한 — TB 미승급이 원본 동작
  });
  it('fmtAgo — 음수 clamp(서버-브라우저 시계 오차)', () => {
    expect(fmtAgo(Date.now() + 60_000)).toBe('0초 전'); // 미래 ts 도 음수로 안 내려감
    expect(fmtAgo(0)).toBe('—');
  });
  it('num/dec1 — null 안전·소수 1자리', () => {
    expect(num(null)).toBe('—');
    expect(num(1234567)).toBe((1234567).toLocaleString());
    expect(dec1(1.26)).toBe('1.3');
  });
});
