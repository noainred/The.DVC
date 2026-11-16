// 41회차 F7: B 시리즈 다중 디스플레이 프로파일(…-2b4) — 서버 gpu/vgpuProfile.js 와 같은 규칙(같은 입력으로 대조).
import { describe, it, expect } from 'vitest';
import * as T from './gpuAllocText.js';
import { vgpuProfileGB as serverProfileGB } from '../../../../server/src/gpu/vgpuProfile.js';

const webFn = T.vgpuProfileGB || T.profileGB;
describe('vGPU 프로파일 GB', () => {
  it('웹 · 서버가 같은 값', () => {
    for (const p of ['grid_m10-2b4', 'grid_m60-1b4', 'grid_m60-0b', 'grid_a40-24q', 'grid_a100-3-20c', 'nvidia_l4-4q', 'bad']) {
      expect(webFn(p)).toBe(serverProfileGB(p));
    }
    expect(webFn('grid_m10-2b4')).toBe(2);
  });
});
