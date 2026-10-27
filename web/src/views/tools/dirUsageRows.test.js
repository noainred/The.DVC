// v2.767(점검 R2-B2-05): 폴더 사용량 화면은 서버 compareScans 결과(compare)로 증감·신규·순위 진입을 그린다 — 메일과 같은 판정.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { dirUsageRows, dirUsageNotes, dirUsageDeltaText } from './dirUsageRows.js';

const human = (b) => `${b}B`;
// 재현 입력(topN=2: a300·b200·c100 → a300·b50·c250)에 대해 서버 compareScansJson 이 내는 모양.
const detail = {
  scan: { total_bytes: 600, sum_bytes: 600, entries: [{ name: 'a', bytes: 300 }, { name: 'c', bytes: 250 }] },
  prev: { entries: [{ name: 'a', bytes: 300 }, { name: 'b', bytes: 200 }] },
  compare: {
    delta: { a: { deltaBytes: 0, isNew: false }, c: { deltaBytes: null, isNew: false, entered: true, existedBefore: true } },
    removed: [], rankedOut: [{ name: 'b', bytes: 200, confirmed: true }], enteredUnknown: 0, hasPrev: true,
  },
};

describe('dirUsageRows — 서버 compare 사용', () => {
  it('순위에 올라온 기존 폴더(c)는 신규가 아니라 순위 진입', () => {
    const rows = dirUsageRows(detail);
    const c = rows.find((r) => r.name === 'c');
    expect(c.isNew).toBe(false);
    expect(c.entered).toBe(true);
    expect(dirUsageDeltaText(c, human)).toBe('순위 진입');
    expect(dirUsageDeltaText(rows.find((r) => r.name === 'a'), human)).toBe('0');
  });
  it('순위 밖으로 밀린 폴더(b)는 안내에 지금도 있음으로 나온다', () => {
    const notes = dirUsageNotes(detail);
    expect(notes.some((n) => n.includes('순위 밖으로 밀린 폴더 1개') && n.includes('b'))).toBe(true);
    expect(notes.some((n) => n.includes('사라진 폴더'))).toBe(false);
  });
  it('compare 가 없으면(구버전 서버) 증감을 지어내지 않는다', () => {
    const rows = dirUsageRows({ scan: detail.scan, prev: detail.prev });
    expect(rows.every((r) => r.delta == null && !r.isNew && !r.entered)).toBe(true);
  });
  it('경로 변경 후 첫 수집은 그 사실을 말한다', () => {
    expect(dirUsageNotes({ scan: detail.scan, baseChanged: true, compare: { delta: {}, removed: [], rankedOut: [], enteredUnknown: 0 } })[0]).toContain('바뀐 뒤 첫 수집');
  });
  it('화면은 Top-N 끼리 다시 비교하지 않는다(prevMap 판정 제거)', () => {
    const src = fs.readFileSync(path.join(HERE, 'DirUsageReport.jsx'), 'utf8');
    expect(src).not.toMatch(/prevMap/);
    expect(src).toMatch(/dirUsageRows\(detail\)/);
  });
});
