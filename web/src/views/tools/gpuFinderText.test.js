import { describe, it, expect } from 'vitest';
import { gpuFinderNote } from './gpuFinderText.js';
import { gpuCardMeta, gpuCardValue } from '../overviewCardsText.js';

describe('v2.683 GPU 찾기 ↔ Overview GPU 카드 같은 기준', () => {
  it('SSH 물리 서버 GPU 는 합계에 넣지 않았다고 말한다', () => {
    const t = gpuFinderNote({ physicalServers: 3, physicalGpus: 8, inventoryStale: 2, gpusStale: 4, gpusUnnamed: 1, disabledServers: 1 });
    expect(t).toMatch(/오래된 인벤토리 2대의 4장 포함/);
    expect(t).toMatch(/모델 미상 1장 포함/);
    expect(t).toMatch(/비활성 1대 제외/);
    expect(t).toMatch(/SSH 등록 GPU 물리 서버 3대 8장은 합계에 넣지 않음/);
    expect(gpuFinderNote({})).toBe('');
  });
  it('오래된 인벤토리 카드가 합계에 들어가므로 수집 대수에도 들어간다(최소값 아님)', () => {
    const g = { count: 463, inventoryRead: 1134, inventoryStale: 2, gpusStale: 8, servers: 1136 };
    expect(gpuCardValue(g)).toEqual({ value: 463, partial: false, unknown: false });
    expect(gpuCardMeta(g)).toMatch(/수집 1,136\/1,136대/);
    expect(gpuCardMeta(g)).toMatch(/오래된 인벤토리 2대의 8장 포함/);
  });
});
