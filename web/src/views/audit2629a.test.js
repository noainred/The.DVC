// v2.629 감사 그룹 a — WEB2629-01: VM 목록 평균 사용률 KPI 는 값이 없으면(null) '—'(단위 없음)이고,
//   사용률 미수집으로 뺀 구동 VM 수를 메타로 밝힌다. 예전 `{t.avgCpuUsagePct}%` 는 null 이면 'null%'·0 이면 '0%' 로 거짓을 말했다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { unitText } from './unitText.js';

const SRC = stripComments(fs.readFileSync(new URL('./Vms.jsx', import.meta.url), 'utf8'));

describe('WEB2629-01 Vms 평균 사용률 KPI', () => {
  it('평균 사용률 3종을 단위 붙인 날값으로 그리지 않는다', () => {
    expect(SRC).not.toMatch(/\{t\.avg(Cpu|Mem|Disk)UsagePct[^}]*\}%/);
    expect(SRC).toMatch(/unitText\(t\.avgCpuUsagePct, '%'\)/);
    expect(SRC).toMatch(/unitText\(t\.avgMemUsagePct, '%'\)/);
    expect(SRC).toMatch(/unitText\(t\.avgDiskUsagePct, '%'\)/);
  });
  it('미수집 VM 수를 메타로 밝힌다', () => {
    expect(SRC).toMatch(/t\.usageUnknown\?\.cpu/);
    expect(SRC).toMatch(/사용률 미수집/);
  });
  it('null 은 —, 0 은 0%', () => {
    expect(unitText(null, '%')).toBe('—');
    expect(unitText(0, '%')).toBe('0%');
  });
});
