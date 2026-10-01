// v2.682 그룹 B(웹) — R3D-06: 카드 큰 숫자가 창 끝에서 멀어진 '마지막 값' 이면 그 사실을 말한다 · R3D-04 태그 불일치 문구.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { statsOf, staleCurText, kindBasisText } from './idracTrendText.js';

const H = 3_600_000;
const NOW = new Date(2026, 9, 1, 12, 0).getTime();

describe('R3D-06 통합 추이 카드의 마지막 값 시각', () => {
  it('statsOf 가 마지막 값의 시각(curT)을 함께 준다', () => {
    const pts = [{ t: NOW - 3 * H, cpuPct: 40 }, { t: NOW - 2 * H, cpuPct: 55 }, { t: NOW - H, cpuPct: null }];
    expect(statsOf(pts, 'cpuPct')).toEqual({ cur: 55, curT: NOW - 2 * H, avg: 47.5, max: 55 });
  });
  it('창 끝에서 2버킷 이상 떨어지면 마지막 값(… 전), 아니면 빈 문자열', () => {
    const end = NOW; const b = H;
    const stale = statsOf([{ t: NOW - 3 * 24 * H, cpuPct: 55 }, { t: NOW - H, cpuPct: null }], 'cpuPct');
    expect(staleCurText(stale, end, b, NOW)).toBe('마지막 값(3일 전)');
    const fresh = statsOf([{ t: NOW - H, cpuPct: 50 }], 'cpuPct');
    expect(staleCurText(fresh, end, b, NOW)).toBe('');
    expect(staleCurText({ ...fresh, curT: NOW - 2 * H }, end, b, NOW)).toBe('마지막 값(2시간 전)'); // 정확히 2버킷 = 표시
    expect(staleCurText({ cur: 1, curT: null }, end, b, NOW)).toBe(''); // 시각을 모르면 단정하지 않는다
    expect(staleCurText(stale, end, 0, NOW)).toBe('');
    expect(staleCurText(null, end, b, NOW)).toBe('');
  });
  it('카드가 그 표시를 그린다', () => {
    const src = fs.readFileSync(new URL('./IdracTrendTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\{x && staleCurText\(x, data\?\.end, data\?\.bucketMs\) && \(/);
    expect(src).toMatch(/>\{staleCurText\(x, data\?\.end, data\?\.bucketMs\)\}</);
  });
});

describe('R3D-04 태그 불일치 근거 문구', () => {
  it('같은 호스트네임이 있어도 서비스태그가 달라 연결하지 않았다고 말한다', () => {
    expect(kindBasisText({ kind: 'baremetal', serviceTag: 'ABC', hostTagMismatch: true })).toContain('서비스태그가 달라');
    expect(kindBasisText({ kind: 'baremetal', serviceTag: 'ABC' })).not.toContain('서비스태그가 달라');
  });
});

// v2.682 리드: 태그만 다른 서버가 있을 때 연결 실패 문구가 '후보에서 고르세요' 라고 거짓 안내하지 않는다.
import { resolveFailText as rft2682 } from './idracTrendText.js';
describe('R3D-04 화면 — 태그 불일치 문구', () => {
  it('후보가 없고 tagMismatch 만 있으면 태그 불일치를 말한다', () => {
    const t = rft2682({ reason: 'conflict', candidates: [], tagMismatch: [{ name: 'esx01', serviceTag: 'ABC1234', by: ['hostname'] }], rules: { serviceTag: { state: 'mismatch', value: 'DEF4567' } } });
    expect(t).toMatch(/서비스태그가 이 호스트\(DEF4567\)와 달라/);
    expect(t).toMatch(/태그 다름/);
    expect(t).not.toMatch(/아래 후보에서 고르세요/);
  });
});
