// 38회차 R2 · R3 · R5(반증): 실패 본문 처리 · 손상 배너 · 요약 칸 — 소스 계약(화면 저장 경로는 컴포넌트 안이라 순수 함수로 떼지 않았다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('GPU 게스트 설정 · Horizon · 물리 GPU 화면', () => {
  it('GPU 게스트 저장은 setData 전에 실패 사유를 본다(409 → TypeError 금지)', () => {
    const s = read('./GpuGuestSettings.jsx');
    const save = s.slice(s.indexOf('const save = async'));
    expect(save.indexOf('changeFailText(r)')).toBeGreaterThan(0);
    expect(save.indexOf('changeFailText(r)')).toBeLessThan(save.indexOf('setData(r)'));
    expect(s).toMatch(/data\?\.loadError && <div className="banner warn"/);
  });
  it('Horizon 화면은 GET loadError 를 배너로 · 빈 목록 안내를 숨기고 · 저장을 잠근다', () => {
    const s = read('./HorizonAdmin.jsx');
    expect(s).toMatch(/setHzLoadErr\(r\.loadError \|\| null\)/);
    expect(s).toMatch(/hz\.length === 0 && !hzErr && !hzLoadErr/);
    expect(s).toMatch(/disabled=\{busy \|\| !hzForm\.host \|\| !!hzLoadErr\}/);
  });
  it("물리 GPU 요약은 'config'(주소 확인)를 세어 그린다", () => {
    const s = read('./gpu-guest/PhysicalGpuManager.jsx');
    expect(s).toMatch(/config: 0, error: 0/);
    expect(s).toMatch(/주소 확인 \{c\.config\}/);
  });
});
