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

// 43회차 R2: 끊긴 GPU 호스트만 있는 법인을 골랐을 때 KPI · 빈 화면이 '0대 · 없음' 이라고 하지 않는다.
describe('끊긴 GPU 호스트 — 합계 · 빈 문구', () => {
  const tree = { vcenters: [], totals: { hosts: 0, gpus: 0 }, hostsDownByVc: { vc1: 1 } };
  it('고른 법인에 끊긴 호스트가 있으면 예비 · 할당률을 내지 않고 hostsDown 을 싣는다', () => {
    const t = T.sumTotals(tree, new Set(['vc1']));
    expect(t.hostsDown).toBe(1);
    expect(t.spareGB).toBeNull();
    expect(t.allocPct).toBeNull();
  });
  it('빈 문구는 없음이 아니라 못 읽음', () => {
    expect(T.allocEmptyText(tree, null)).toMatch(/끊겨 GPU 를 읽지 못했습니다/);
    expect(T.allocEmptyText(tree, new Set(['vc1']))).toMatch(/끊겨/);
    expect(T.allocEmptyText({ vcenters: [] }, null)).toBe('GPU 가 설치된 호스트가 없습니다');
  });
});
