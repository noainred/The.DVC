/**
 * sanStorage2953.test.js — v2.953 SAN 스토리지 성능 2차(자기 기준선 표시 · 용량 × 성능 · 알림 · 월간 보고서)의 순수 계산 · 소스 규약.
 *  ① foldHeatmap 에 marks — 칸마다 '평소와 다름' 수(off) · 없으면 0 · ② capPerfQuadrant — 표시 규칙(80% · 20%) · 값 없으면 판정 없음 · tbText · daysText
 *  ③ 소스 규약 — 알림 · 보고서 모달은 PUT/POST 반환값을 보고 · 날 <table> 없음 · 미리보기는 downloadFile(토큰) · 현황의 보기 전환 훅은 조기 return 위
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './sanStorageText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const HOUR = 3_600_000;

describe('① foldHeatmap marks', () => {
  it('평소와 다름 칸을 센다 · marks 없으면 0', () => {
    const mon9 = Date.UTC(2026, 10, 9, 0, 0, 0);   // 월요일 09:00 KST
    const h = T.foldHeatmap([mon9, mon9 + HOUR, mon9 + 7 * 24 * HOUR], [8, 5, 9], 540, [{ off: true }, null, { off: true }]);
    expect(h.cells[0][9].off).toBe(2); expect(h.cells[0][10].off).toBe(0); expect(h.cells[0][9].n).toBe(2);
    expect(T.foldHeatmap([mon9], [8], 540).cells[0][9].off).toBe(0);
  });
});

describe('② 용량 × 성능', () => {
  it('사분면 · 표기', () => {
    expect(T.QUADRANT_RULE).toEqual({ fullPct: 80, busyUtilPct: 20 });
    expect(T.capPerfQuadrant({ capacity: { pct: 85 }, utilPct: 25 }).key).toBe('full-busy');
    expect(T.capPerfQuadrant({ capacity: { pct: 85 }, utilPct: 3 }).key).toBe('full-idle');
    expect(T.capPerfQuadrant({ capacity: { pct: 40 }, utilPct: 30 }).key).toBe('free-busy');
    expect(T.capPerfQuadrant({ capacity: { pct: 40 }, utilPct: 3 }).key).toBe('ok');
    expect(T.capPerfQuadrant({ capacity: null, growth: { pctUsed: 90 }, utilPct: 1 }).key).toBe('full-idle');
    expect(T.capPerfQuadrant({ capacity: null, utilPct: 1 })).toMatchObject({ key: 'unknown', label: '판정 없음' });
    expect(T.capPerfQuadrant({ capacity: { pct: 50 }, utilPct: null }).why).toMatch(/회선 사용률 없음/);
    expect(T.tbText(null)).toBe('—'); expect(T.tbText(2.34e12)).toBe('+2.3 TB'); expect(T.tbText(-5e11)).toBe('-0.5 TB');
    expect(T.daysText(null)).toBe('—'); expect(T.daysText(41.6)).toBe('42일'); expect(T.daysText(99_999)).toBe('10년 이상');
  });
});

describe('③ 소스 규약', () => {
  it('모달 · 보기 전환 · 표', () => {
    const check = strip(read('./SanStorageCheck.jsx'));
    expect(check).toMatch(/const r = await putJson\('\/tools\/san-storage\/notify-settings', form\); if \(r\?\.ok === false\)/);
    expect(check).toMatch(/const r = await putJson\('\/tools\/san-storage\/report-settings'[\s\S]{0,60}if \(r\?\.ok === false\)/);
    expect(check).toMatch(/postJson\('\/tools\/san-storage\/notify\/run-now'/); expect(check).toMatch(/postJson\('\/tools\/san-storage\/report\/send-now'/);
    expect(check).toMatch(/downloadFile\('\/tools\/san-storage\/report\/preview'/);
    expect(check).not.toMatch(/<table[\s>]/); expect(check).not.toMatch(/window\.open\(/);
    const tool = strip(read('./SanStorageTool.jsx'));
    expect(tool).toMatch(/function ListTab\([^)]*\) \{\n\s*const \[[^\n]+\n\s*const \[view, setView\] = useState\('table'\)/);
    expect(tool).toMatch(/view === 'cross' \? <CrossView rows=\{rows\} onOpen=\{onOpen\} \/>/);
    expect(tool).toMatch(/foldHeatmap\(week\.buckets, week\.sum, week\.offsetMin \?\? 540, week\.baseline\?\.applicable \? week\.baseline\.marks : null\)/);
    expect(tool).not.toMatch(/\bsetInterval\(/); expect(tool).not.toMatch(/<table[\s>]/);
  });
});
