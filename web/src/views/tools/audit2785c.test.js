import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idleSummary } from './sanPortUsageText.js';

// v2.785(점검 GI I-B1) — 스냅샷에 상태가 없는 포트(엣지가 문제 포트만 보낸 축약 등)는 '사용 중이 아닌 포트' 로 단정하지 않고
// '상태 모름' 으로 따로 센다. 서버 idleOf 의 unknown 과 짝.
const base = { days: 30, pct: 1, minDays: 7, idle: [], pending: [] };

describe('유휴 요약 — 상태 모름', () => {
  it('상태 모름 포트를 따로 밝히고, 사용 중이 아닌 포트 수에 섞지 않는다', () => {
    const t = idleSummary({ ...base, off: [{ port: 3 }], unknown: [{ port: 0 }, { port: 1 }, { port: 2 }] });
    expect(t).toContain('사용 중이 아닌 포트 1개');
    expect(t).toContain('상태 모름 3개');
    expect(t).toMatch(/유휴로 세지 않습니다\.$/);
    expect(t).not.toContain('`');
  });
  it('상태 모름이 없거나(0개) 옛 서버 응답(필드 없음)이면 전과 같은 문구', () => {
    const old = idleSummary({ ...base, off: [{ port: 3 }] });
    expect(old).not.toContain('상태 모름');
    expect(idleSummary({ ...base, off: [{ port: 3 }], unknown: [] })).toBe(old);
    expect(old).toContain('사용 중이 아닌 포트 1개(비어 있음·비활성 등)');
  });
});

// v2.785(GI I-B4) — 15분 집계 보관 일수는 env(SANSW_PERF_ROLLUP_15M_DAYS)로 바뀐다. 1일 차트가 1시간 칸으로 오는 날의 안내에 31일을 박지 않는다.
describe('1일 차트 칸 안내', () => {
  it('15분 집계 보관 일수를 화면에 숫자로 박지 않는다', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'SanPortUsage.jsx'), 'utf8');
    expect(src).toContain('1시간 칸(15분 집계 보관 기간이 지난 날)');
    expect(src).not.toMatch(/보관 \d+일이 지난 날/);
  });
});
