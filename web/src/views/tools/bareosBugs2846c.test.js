/**
 * bareosBugs2846c.test.js — v2.846 Bareos 확정 결함 묶음 C(웹) 회귀.
 *   U-5  공통 기본값 저장은 사람이 고친 칸만 · 다시 읽으면 고치지 않은 칸은 새 값(409 뒤 옛 값 되돌림 방지)
 *   U-8  통합 현황 — 서버가 우선 확인 목록을 싣지 않으면(priorityWithheld) 수는 '—' · 권한 안내
 *   U-9  그룹 카드·법인 줄 — Director 결과를 모르면 '모름'(성공 n/n 초록 아님)
 *   U-10 정리 미리 보기 — 한 대도 확인하지 못했으면 '지울 기록 없음' 이 아니라 '모름'
 *   U-11 관리 화면의 엣지 대행 판정(relayWaiting) — 'sent'·'pending' 둘 다
 *   U-13 법인별 현황 폴더 줄 '실패 N' 은 결과를 아는 법인에서만
 *   D-9  그룹 삭제·VM 빼기 확인 — '스케줄 없는 잡 N개 — 이후 예약 백업 없음'
 * 판정은 순수 함수로, 화면이 그 함수를 쓰는지는 소스로 본다(node 환경 — 렌더 불가). 주석은 먼저 지운다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { defaultsPatch, mergeDefaultsOnReload, relayWaiting, directorStatus } from './bareosText.js';
import { priorityChips, priorityEmptyText, PRIORITY_WITHHELD_TEXT } from './bareosViewText.js';
import { memberResults, resultBadge, prunePreviewText, unscheduledAfter, unscheduledText, groupDeleteConfirmText } from './bareosGroupText.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const code = (rel) => stripComments(fs.readFileSync(path.join(TOOLS, rel), 'utf8'));

describe('U-5 공통 기본값 — 고친 칸만 보낸다', () => {
  const base = { level: 'Incremental', pollIntervalSec: 60, jobDefs: 'PortalJD', policy: { enabled: true, time: '06:10' } };
  it('보낼 값은 원본과 다른 칸만', () => {
    expect(defaultsPatch(base, { ...base })).toEqual({});
    expect(defaultsPatch(base, { ...base, level: 'Full' })).toEqual({ level: 'Full' });
    expect(defaultsPatch(base, { ...base, policy: { enabled: true, time: '07:00' } })).toEqual({ policy: { enabled: true, time: '07:00' } });
  });
  it('409 뒤 다시 읽으면 — 사람이 고친 칸은 화면 값, 다른 화면이 바꾼 칸은 새 값(옛 값을 되돌리지 않는다)', () => {
    const draft = { ...base, level: 'Full' };                       // 이 화면에서 레벨만 고침
    const fresh = { ...base, jobDefs: 'OtherJD', pollIntervalSec: 120 };   // 다른 화면이 그사이 저장
    const merged = mergeDefaultsOnReload(base, draft, fresh);
    expect(merged).toEqual({ ...fresh, level: 'Full' });
    expect(defaultsPatch(fresh, merged)).toEqual({ level: 'Full' }, '다시 저장해도 다른 화면의 jobDefs·주기를 되돌리지 않는다');
    expect(mergeDefaultsOnReload(null, draft, fresh)).toEqual(fresh);
  });
  it('화면은 그 판정으로 보낸다(defs 전체를 보내지 않는다)', () => {
    const s = code('BareosSettings.jsx');
    expect(s).toMatch(/defaultsPatch\(defsBase\.current/);
    expect(s).toMatch(/mergeDefaultsOnReload\(prevBase, f, r\.defaults\)/);
    expect(s).not.toMatch(/defaults: \{ \.\.\.defs/);
  });
});

describe('U-8 통합 현황 — 우선 확인 목록을 받지 못한 계정', () => {
  it('수는 — · 빈 표는 권한 안내(확인할 VM 없음이 아니다)', () => {
    const held = { priority: [], priorityTotal: null, priorityByKind: {}, priorityWithheld: 'detail-tool' };
    expect(priorityChips(held).map(([, l]) => l)).toEqual(['전체 —', '실패 —', '미등록 —', '오래된 백업 —', '백업 없음 —']);
    expect(priorityEmptyText(held)).toBe(PRIORITY_WITHHELD_TEXT);
    expect(PRIORITY_WITHHELD_TEXT).not.toContain('`');
    const ok = { priorityTotal: 3, priorityByKind: { fail: 2, never: 1 } };
    expect(priorityChips(ok).map(([, l]) => l)).toEqual(['전체 3', '실패 2', '미등록 0', '오래된 백업 0', '백업 없음 1']);
    expect(priorityEmptyText(ok)).toBe('확인할 VM 이 없습니다.');
  });
  it('화면은 그 판정을 쓴다', () => {
    const s = code('BareosSummaryTool.jsx');
    expect(s).toMatch(/priorityChips\(data\)/);
    expect(s).toMatch(/priorityEmptyText\(data\)/);
    expect(s).not.toMatch(/`전체 \$\{data\.priorityTotal \|\| 0\}`/);
  });
});

describe('U-9 그룹 — Director 결과를 모르면 모름', () => {
  const rows = [{ b: { st: 'ok' } }, { b: { st: 'ok' } }, { b: { st: 'error' } }];
  it('resultsKnown=false 면 결과 수는 null · 배지는 결과 모름(초록 아님)', () => {
    const m = memberResults(rows, { resultsKnown: false });
    expect(m).toEqual({ n: 3, ok: null, warn: null, fail: null, run: null, never: null, unknown: 3 });
    expect(resultBadge(m)).toEqual({ text: '결과 모름 3대', tone: 'muted' });
    expect(resultBadge(memberResults([{ b: { st: 'ok' } }], { resultsKnown: true }))).toEqual({ text: '성공 1/1', tone: 'ok' });
  });
  it('화면은 트리의 Director 상태로 센다(카드 · 법인 줄 · 상세)', () => {
    const s = code('BareosGroupsTab.jsx');
    const calls = s.split('\n').filter((l) => l.includes('memberResults('));
    expect(calls.length).toBe(3);
    expect(calls.every((l) => l.includes('{ resultsKnown: resultsKnownOf(tree) }'))).toBe(true);
    expect(s).toMatch(/directorState\?\.resultsKnown !== false/);
  });
});

describe('U-10 정리 미리 보기 — 모두 확인하지 못하면 모름', () => {
  it('failed = jobs 면 지울 건수를 모른다', () => {
    const t = prunePreviewText({ keep: 3, jobs: 3, would: 0, vms: 0, failed: 3, errors: [] });
    expect(t.tone).toBe('bad');
    expect(t.text).toMatch(/한 대도 확인하지 못했습니다/);
    expect(t.text).toMatch(/지울 건수를 모릅니다/);
    expect(t.text).not.toMatch(/지울 실행 기록이 없습니다/);
  });
});

describe('U-11 엣지 대행 회신 대기 — sent 도', () => {
  it("보낸 틱('sent')과 다음 틱('pending') 모두 '엣지 대행 중' · 지난 결과가 있으면 그것", () => {
    expect(relayWaiting({ ok: null, relay: 'sent' })).toBe(true);
    expect(relayWaiting({ ok: null, relay: 'pending' })).toBe(true);
    expect(relayWaiting({ ok: true, relay: 'sent' })).toBe(false);
    expect(directorStatus({ configured: true, poll: { ok: null, relay: 'sent' } }).label).toBe('엣지 대행 중');
  });
});

describe('U-13 폴더 줄 실패 N — 결과를 아는 법인에서만', () => {
  it('known && a.fail', () => {
    const s = code('BareosDetailTool.jsx');
    expect(s).toMatch(/\{known && a\.fail \? <span/);
    expect(s).not.toMatch(/\{a\.fail \? <span/);
  });
});

describe('D-9 그룹 삭제·VM 빼기 — 스케줄 없는 잡', () => {
  const byId = new Map([
    ['v1', { id: 'v1', job: { schedule: '', enabled: true }, groupId: 'g1' }],
    ['v2', { id: 'v2', job: { schedule: 'WeeklyCycle', enabled: true }, groupId: 'g1' }],
    ['v3', { id: 'v3', job: { schedule: '', enabled: false }, groupId: 'g1' }],
    ['v4', { id: 'v4', job: null, groupId: 'g1' }],
    ['v5', { id: 'v5', job: { schedule: '', enabled: true }, groupId: 'g2' }],
  ]);
  it('잡 있음 · 켜짐 · Director 스케줄 없음 · 다른 그룹 아님만 센다', () => {
    expect(unscheduledAfter(['v1', 'v2', 'v3', 'v4', 'v5'], byId, 'g1')).toBe(1);
    expect(unscheduledText(0)).toBe('');
    expect(unscheduledText(2)).toBe('스케줄 없는 잡 2개 — 이후 예약 백업 없음');
  });
  it('삭제 확인 문구가 그 수를 밝힌다 · 0 이면 예전 문구', () => {
    expect(groupDeleteConfirmText({ name: 'g', vmIds: ['v1', 'v2'] }, 1)).toMatch(/주의: 스케줄 없는 잡 1개 — 이후 예약 백업 없음/);
    expect(groupDeleteConfirmText({ name: 'g', vmIds: ['v1'] }, 0)).not.toMatch(/주의/);
  });
  it('화면 — 삭제 확인 · 편집 저장 확인 · 저장 결과 문구', () => {
    const s = code('BareosGroupsTab.jsx');
    expect(s).toMatch(/window\.confirm\(groupDeleteConfirmText\(g, unscheduledAfter\(g\.vmIds, byId, g\.id\)\)\)/);
    expect(s).toMatch(/removedUnscheduled > 0 && !window\.confirm\(/);
    expect(s).toMatch(/r\.unscheduled\?\.count/);
  });
});
