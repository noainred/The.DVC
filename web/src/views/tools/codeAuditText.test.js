/**
 * codeAuditText.test.js — 포탈 점검 › 코드 감사 화면 문구 회귀(v2.636).
 *
 * 고정하는 것:
 *  ① 분류·앵커 상태·심각도·신뢰도·조치 상태 어휘가 서버 `portalcheck/codeAudit.js` 의 상수와 1:1 — 한쪽만 늘면 화면이 값을
 *     그대로 보여 준다(v2.553·v2.560 규약). 서버 파일은 fs 로 읽고 없으면 그 반쪽만 건너뛴다.
 *  ② 'gone' 은 '고침' 이 아니다 · 'no-source' 는 '발견 없음' 이 아니다 · 모르는 상태는 확인 안 함(초록 폴백 금지).
 *  ③ KPI 항등식 — 분류 합 = 전체 · 심각도 합 = 전체.
 *  ④ 필터는 AND · 정렬은 분류 순서 → rank · 문구에 백틱 0.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES, CATEGORY_LABEL, SEVERITY_LABEL, CONFIDENCE_LABEL, ANCHOR_LABEL, ANCHOR_TONE, STATUS_LABEL,
  anchorState, anchorLabel, anchorTone, anchorNote, statusOf, statusLabel, locationText, kpiOf, kpiMismatchNote,
  bannerText, filterFindings, sortFindings, metaLine, tableFootnotes, emptyText, categoryLabel, severityTone, confidenceLabel,
} from './codeAuditText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MOD = path.resolve(HERE, '../../../../server/src/portalcheck/codeAudit.js');
const hasServer = fs.existsSync(SERVER_MOD);
const serverArray = (name) => {
  const src = fs.readFileSync(SERVER_MOD, 'utf8');
  const m = src.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`));
  return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
};

const F = (over = {}) => ({ id: 'BUG-01', category: 'bug', rank: 1, severity: 'high', confidence: 'confirmed', title: 't', file: 'server/src/a.js', line: 10, anchor: 'x', status: 'open', check: { state: 'present', lineNow: 10 }, ...over });

describe('codeAuditText — 어휘 1:1', () => {
  (hasServer ? it : it.skip)('분류·심각도·신뢰도·앵커·상태가 서버 상수와 같다', () => {
    expect([...CATEGORIES]).toEqual(serverArray('CATEGORIES'));
    expect(Object.keys(SEVERITY_LABEL)).toEqual(serverArray('SEVERITIES'));
    expect(Object.keys(CONFIDENCE_LABEL)).toEqual(serverArray('CONFIDENCES'));
    expect(Object.keys(ANCHOR_LABEL)).toEqual(serverArray('ANCHOR_STATES'));
    expect(Object.keys(STATUS_LABEL)).toEqual(serverArray('FINDING_STATUS'));
    expect(Object.keys(ANCHOR_TONE)).toEqual(Object.keys(ANCHOR_LABEL));
    expect(Object.keys(CATEGORY_LABEL)).toEqual([...CATEGORIES]);
  });
});

describe('codeAuditText — 정직 규칙', () => {
  it('gone 은 고침이 아니고, no-source 는 발견 없음이 아니다, 모르는 상태는 확인 안 함', () => {
    expect(anchorNote(F({ check: { state: 'gone' } }))).toContain('고쳐졌을 수도');
    expect(anchorNote(F({ check: { state: 'gone' } }))).not.toMatch(/^고쳤/);
    expect(anchorTone(F({ check: { state: 'gone' } }))).not.toBe('green');
    const ns = anchorNote(F({ file: 'web/src/x.js', check: { state: 'no-source' } }), { webSrc: false });
    expect(ns).toContain('발견이 없다는 뜻이 아닙니다');
    expect(ns).toContain('web/dist');
    expect(anchorState(F({ check: { state: 'weird' } }))).toBe('unchecked');
    expect(anchorState(F({ check: null }))).toBe('unchecked');
    expect(anchorTone(F({ check: null }))).toBe('gray');
    expect(anchorLabel(F({ check: { state: 'present' } }))).toBe('소스에 있음');
  });

  it('상태는 카탈로그의 status 만 — fixed 는 버전을 붙인다', () => {
    expect(statusOf(F())).toBe('open');
    expect(statusOf(F({ status: 'fixed' }))).toBe('fixed');
    expect(statusLabel(F({ status: 'fixed', fixedIn: '2.640.0' }))).toBe('고침(v2.640.0)');
    expect(statusLabel(F({ status: 'anything' }))).toBe('미조치');
  });

  it('위치는 옮겨진 줄을 함께 말한다', () => {
    expect(locationText(F())).toBe('server/src/a.js:10');
    expect(locationText(F({ check: { state: 'moved', lineNow: 42 } }))).toBe('server/src/a.js:10 → 지금 42줄');
    expect(locationText({})).toBe('—');
  });

  it('KPI 항등식 — 분류 합 = 전체, 심각도 합 = 전체 · 서버 합계와 다르면 말한다', () => {
    const list = [F(), F({ id: 'A1', category: 'arch', severity: 'low' }), F({ id: 'T1', category: 'tuning', severity: 'medium', status: 'fixed' })];
    const k = kpiOf(list);
    expect(Object.values(k.byCategory).reduce((a, b) => a + b, 0)).toBe(k.total);
    expect(Object.values(k.bySeverity).reduce((a, b) => a + b, 0)).toBe(k.total);
    expect(k.open + k.fixed).toBe(k.total);
    expect(kpiMismatchNote({ total: 3 }, list)).toBe('');
    expect(kpiMismatchNote({ total: 40 }, list)).toContain('40건');
    expect(kpiMismatchNote(null, list)).toBe('');
  });

  it('배너 — 건수·목록임을 말하고, 서버 버전이 다르면 앵커 열을 안내하며, gone/no-source 를 따로 말한다', () => {
    const data = { ok: true, version: '2.636.0', base: 'b8027eb', date: '2026-09-28', serverVersion: '2.640.0', findings: [F(), F({ id: 'X', check: { state: 'gone' } }), F({ id: 'Y', file: 'web/src/x.js', check: { state: 'no-source' } })] };
    const b = bannerText(data);
    expect(b.tone).toBe('red');
    expect(b.text).toContain('합계 **3건**');
    expect(b.text).toContain('수정은 별도 요청');
    expect(b.text).toContain('v2.640.0');
    expect(b.text).toContain('**1건**은 고쳐졌다는 뜻이 아닙니다');
    expect(b.text).toContain('소스 미포함 **1건**');
    expect(bannerText({ ok: false, errors: ['깨짐'] }).tone).toBe('red');
    expect(bannerText(null).tone).toBe('gray');
    expect(bannerText({ ok: true, version: '1', base: 'b', date: 'd', findings: [F({ severity: 'low' })] }).tone).toBe('green');
  });

  it('필터는 AND · 정렬은 분류 순서 → rank', () => {
    const list = [F({ id: 'T2', category: 'tuning', rank: 2 }), F({ id: 'A1', category: 'arch', rank: 1, severity: 'low', evidence: 'needle here' }), F({ id: 'B1', category: 'bug', rank: 1, status: 'fixed' }), F({ id: 'T1', category: 'tuning', rank: 1 })];
    expect(sortFindings(list).map((f) => f.id)).toEqual(['A1', 'B1', 'T1', 'T2']);
    expect(filterFindings(list, { category: 'tuning' }).map((f) => f.id)).toEqual(['T2', 'T1']);
    expect(filterFindings(list, { severity: 'low' }).map((f) => f.id)).toEqual(['A1']);
    expect(filterFindings(list, { q: 'needle' }).map((f) => f.id)).toEqual(['A1']);
    expect(filterFindings(list, { onlyOpen: true }).map((f) => f.id)).toEqual(['T2', 'A1', 'T1']);
    expect(filterFindings(list, { category: 'tuning', severity: 'low' })).toEqual([]);
    expect(filterFindings(null, {})).toEqual([]);
  });

  it('각주는 표에 있는 앵커 상태만 · 빈 표 문구는 이유를 나눈다 · 메타 줄', () => {
    const foot = tableFootnotes([F(), F({ check: { state: 'moved', lineNow: 3 } })], {});
    expect(foot).toHaveLength(2);
    expect(foot[0]).toContain('**소스에 있음**');
    expect(tableFootnotes([], {})).toEqual([]);
    expect(emptyText({ total: 0 })).toContain('카탈로그');
    expect(emptyText({ total: 5, shown: 0 })).toContain('조건');
    expect(emptyText({ total: 5, shown: 5 })).toBe('');
    expect(metaLine({ at: 1, serverVersion: '2.636.0', doc: 'AUDIT-2026-09-28.md' }, () => '방금')).toBe('서버 확인 방금 · 서버 v2.636.0 · 문서 docs/AUDIT-2026-09-28.md');
    expect(metaLine(null)).toBe('');
  });

  it('라벨 폴백 · 문구에 백틱 0', () => {
    expect(categoryLabel('x')).toBe('x');
    expect(categoryLabel('')).toBe('분류 없음');
    expect(severityTone('nope')).toBe('gray');
    expect(confidenceLabel('nope')).toBe('확인 안 함');
    const texts = [
      ...Object.keys(ANCHOR_LABEL).map((s) => anchorNote(F({ check: { state: s }, file: 'web/src/x.js' }), { webSrc: false })),
      bannerText({ ok: true, version: '1', base: 'b', date: 'd', serverVersion: '2', findings: [F(), F({ id: 'g', check: { state: 'gone' } }), F({ id: 'n', check: { state: 'no-source' } })] }).text,
      bannerText({ ok: false, errors: ['e'] }).text, emptyText({ total: 0 }), emptyText({ total: 1, shown: 0 }),
      kpiMismatchNote({ total: 9 }, [F()]),
      ...tableFootnotes(Object.keys(ANCHOR_LABEL).map((s) => F({ check: { state: s } })), {}),
    ];
    for (const s of texts) expect(s).not.toContain('`');
  });
});
