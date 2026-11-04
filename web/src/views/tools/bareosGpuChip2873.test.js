import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { gpuChip } from './bareosText.js';

// v2.873 Bareos 백업 대상 GPU 표지 — 서버 gpuDev(gpu/vgpuProfile.js vmGpuMark)를 글자로만 바꾼다(장치 판정은 서버 하나).
describe('gpuChip', () => {
  it('gpuDev 가 없거나 장치 0 이면 표지 없음(장치가 없다고 단정하지 않는다)', () => {
    for (const x of [undefined, null, {}, { gpuDev: null }, { gpuDev: {} }, { gpuDev: { vgpu: 0, passthrough: 0 } }, { gpuDev: { vgpu: -1, passthrough: '2' } }, { gpuDev: { vgpu: 1.5 } }]) {
      expect(gpuChip(x)).toBeNull();
    }
  });

  it('vGPU · 패스스루 · 혼합 이름표', () => {
    expect(gpuChip({ gpuDev: { vgpu: 1, passthrough: 0, profile: 'grid_a100-10c' } }).label).toBe('vGPU');
    expect(gpuChip({ gpuDev: { vgpu: 0, passthrough: 2, profile: '' } }).label).toBe('PCI 패스스루');
    expect(gpuChip({ gpuDev: { vgpu: 1, passthrough: 1, profile: '' } }).label).toBe('vGPU · 패스스루');
  });

  it('설명은 장치 수 · 프로파일(vGPU 일 때만) · 스냅샷 제약 · 대안을 말한다', () => {
    const v = gpuChip({ gpuDev: { vgpu: 2, passthrough: 0, profile: 'grid_a100-10c' } });
    expect(v.title).toContain('vGPU 2개(프로파일 ‘grid_a100-10c’)');
    expect(v.title).toContain('KB 394566');
    expect(v.title).toContain('전원을 끈 상태로 백업');
    const p = gpuChip({ gpuDev: { vgpu: 0, passthrough: 1, profile: 'grid_a100-10c' } });
    expect(p.title).not.toContain('프로파일');
    expect(p.title).toContain('NIC·HBA 일 수도');   // 패스스루 수는 GPU 아닌 DirectPath 도 센다(v2.871) — GPU 라고 단정하지 않는다
    expect(p.note).toMatch(/^\*\*켜진 상태에서는 스냅샷을 만들 수 없는 VM\*\* 입니다/);
  });

  it('문구에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
    const g = gpuChip({ gpuDev: { vgpu: 1, passthrough: 1, profile: 'nvidia_l40s-48q' } });
    for (const s of [g.label, g.title, g.note]) expect(s).not.toContain('`');
  });

  it('대상 표 · 상세 패널 · 등록 후보 세 곳이 같은 함수를 쓴다', () => {
    const src = fs.readFileSync(new URL('./BareosBackupTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const g = gpuChip\(j\); return g \? <span className="badge amber" data-bareos-gpu=""/);   // 대상 표 VM 칸 칩
    expect(src).toMatch(/const g = gpuChip\(x\); return g \? <span className="badge amber" data-bareos-gpu=""/);   // 등록 후보 칩
    expect(src).toMatch(/data-bareos-gpu-note=""><BoldText text=\{gpuChip\(j\)\.note\}/);                          // 상세 패널 안내 한 줄
    // 패널 머리 줄에는 칩을 두지 않는다 — 1440 에서 머리 줄은 이미 닫기를 둘째 줄로 내린다(변경 전부터 · A/B) — 더 늘리지 않는다
    const head = src.slice(src.indexOf('<b style={{ fontSize: 16, overflowWrap'), src.indexOf('aria-label="닫기" onClick={() => setSel'));
    expect(head).not.toContain('gpuChip');
  });
});
