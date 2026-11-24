// dbg3221 6회차 — ‘확인할 것’ 줄의 꺼진 VM · 정지 VM 칸: 디스크 합은 용량을 읽은 정지 VM 만의 부분 합이다.
//   못 읽은 VM 이 있으면 ‘이상’ 과 모름 수를 붙인다(아래 패널 · VmInsight 정지 VM 카드가 이미 밝히는 사실 — 칸만 전체처럼 보였다).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), toolAllowed: () => true, hasRole: () => true };
});

const { buildToolChecks } = await import('./insight-tools/vmToolChecks.js');
const { checkBase, sumVmRows } = await import('./vmInsightText.js');

const wasteOf = (o = {}) => ({ data: { rows: [{ vcenterId: 'A', vms: 20, poweredOff: 10, poweredOffGB: 50, poweredOffStorageUnknown: 9, ...o }] } });
const offCell = (waste) => buildToolChecks({ vcIds: [], canTool: (k) => k === 'waste', waste }).find((x) => x.key === 'powered-off');

describe('도구 칸(꺼진 VM) — 부분 합 표지', () => {
  it('10대 중 9대를 못 읽었으면 ‘50 GB 이상 · 모름 9대’(예전: ‘디스크 50 GB 점유’ 로 전체처럼)', () => {
    const c = offCell(wasteOf());
    expect(c.value).toBe('10');
    expect(c.sub).toBe('디스크 50 GB 이상 점유 · 모름 9대');
  });
  it('못 읽은 VM 이 없으면 예전 문구 그대로', () => {
    expect(offCell(wasteOf({ poweredOffStorageUnknown: 0 })).sub).toBe('디스크 50 GB 점유');
    expect(offCell(wasteOf({ poweredOffStorageUnknown: undefined })).sub).toBe('디스크 50 GB 점유');
  });
});

describe('VM 집계 칸(정지 VM · checkBase) — 서버 reclaim.offDiskUnknown', () => {
  const offOf = (reclaim) => checkBase({ signals: {}, reclaim }).tail.find((x) => x.key === 'off');
  it('못 읽은 VM 이 있으면 ‘이상’ 과 디스크 모름 수', () => {
    expect(offOf({ offCount: 10, offDiskGB: 50, offDiskUnknown: 9 }).sub).toBe('디스크 50 GB 이상(템플릿 제외 · 디스크 모름 9대)');
  });
  it('없으면 예전 문구 그대로', () => {
    expect(offOf({ offCount: 10, offDiskGB: 50, offDiskUnknown: 0 }).sub).toBe('디스크 50 GB(템플릿 제외)');
    expect(offOf({ offCount: 10, offDiskGB: 50 }).sub).toBe('디스크 50 GB(템플릿 제외)');
  });
  it('법인 합(sumVmRows)도 offDiskUnknown 을 더해 칸까지 온다', () => {
    const s = sumVmRows([{ signals: {}, reclaim: { offCount: 4, offDiskGB: 20, offDiskUnknown: 1 } }, { signals: {}, reclaim: { offCount: 6, offDiskGB: 30, offDiskUnknown: 8 } }]);
    expect(checkBase(s).tail.find((x) => x.key === 'off').sub).toBe('디스크 50 GB 이상(템플릿 제외 · 디스크 모름 9대)');
  });
});
