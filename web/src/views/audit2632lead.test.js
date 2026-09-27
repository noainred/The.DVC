// v2.632 리드 통합분 회귀(웹).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { serverSegments } from '../version_6/v6Data.js';

describe('v2.632 리드', () => {
  it('V6 물리 서버 집계가 실패하면 0 이 아니라 null', () => {
    const r = serverSegments({ global: {}, physical: { error: 'boom', servers: 0 } });
    expect(r.phys.value).toBeNull();
    const ok = serverSegments({ global: {}, physical: { servers: 7 } });
    expect(ok.phys.value).toBe(7);
  });
  it('인시던트 타임라인은 시각 미상을 1970년으로 그리지 않는다', () => {
    const s = fs.readFileSync(new URL('./Insights.jsx', import.meta.url), 'utf8');
    expect(s).toMatch(/e\.ts == null \? '시각 미상'/);
    expect(s).toMatch(/summary\.timeUnknown/);
  });
  it('data-sort 빈 값은 0 이 아니라 빈 문자열(Horizon·SAN 점검)', () => {
    const h = fs.readFileSync(new URL('./tools/HorizonSessionsPanel.jsx', import.meta.url), 'utf8');
    const s = fs.readFileSync(new URL('./tools/SanHealthCheck.jsx', import.meta.url), 'utf8');
    expect(h).not.toMatch(/data-sort=\{String\(u\.(connected|sessions) \?\? 0\)\}/);
    expect(s).not.toMatch(/uncheckedCount \?\? 0/);
  });
});

import { distributionSummary } from './tools/bmUsageDistText.js';
describe('v2.632 리드 — 배포 현황 생략 개수', () => {
  it('등록부에 없는 미검증 이름·거절 인출 개수를 말한다', () => {
    const t = distributionSummary({ enabled: true, rows: [], unknownUnverifiedOmitted: 3, pullsOmitted: 5 });
    expect(t).toMatch(/미검증 이름 3곳/);
    expect(t).toMatch(/미검증 인출 5건/);
  });
});
