// v2.622 리드 통합분 — 그룹 수정 밖에서 화면에 연결한 것.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { undeterminedNote } from './unprotectedPatternText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('DATA-05 후속 · 미보호 VM 의 판정 불가 안내', () => {
  it('판정 불가가 없으면 빈 문자열', () => {
    expect(undeterminedNote({ undeterminedCount: 0 })).toBe('');
    expect(undeterminedNote(null)).toBe('');
  });
  it('개수·사유·vCenter 를 말하고, 보호됐다는 뜻이 아님을 밝힌다', () => {
    const t = undeterminedNote({ undeterminedCount: 5, undeterminedByReason: { 'no-events': 5 }, noEventVcenters: ['vc-a'] });
    expect(t).toMatch(/5대/);
    expect(t).toMatch(/이벤트가 0건/);
    expect(t).toMatch(/vc-a/);
    expect(t).toMatch(/보호됐다는 뜻도 아닙니다/);
    expect(t).not.toMatch(/`/);
  });
  it('미보호 VM 화면이 이 문구와 판정 불가 개수를 그린다', () => {
    const s = fs.readFileSync(path.join(HERE, 'ToolsReports.jsx'), 'utf8');
    expect(s).toMatch(/undeterminedNote\(s\)/);
    expect(s).toMatch(/판정 불가 \$\{s\.undeterminedCount\}대 제외/);
  });
  it('현재 사용자 합집합 카드는 하한이면 "최소" 를 붙이는 공용 함수를 쓴다(DATA-06)', () => {
    const s = fs.readFileSync(path.join(HERE, 'tools', 'CurrentUsers.jsx'), 'utf8');
    expect(s).toMatch(/value=\{unionValueText\(c\)\}/);
  });
});
