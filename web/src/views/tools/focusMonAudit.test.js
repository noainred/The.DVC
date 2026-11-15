/**
 * focusMonAudit.test.js — v3.11.0 디스크 점검 탭의 글 · 표시 규칙(focusMonAuditText.js). 판정 · 집계는 서버 — 여기는 글자로 바꾸는 규칙만 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  DASH, AUDIT_VIEW_KEYS, READY_TEXT, rowStatus, canRunRow, lastCounts, rateText, chipCounts, chipFilter, scopeFilter, scopeText, notReadyText, installSteps, countText, durText,
} from './focusMonAuditText.js';
import { TABS, EDIT_FIELDS, editChanges } from './focusMonText.js';

const done = (counts, disks = []) => ({ id: 'r1', at: 1, outcome: 'done', summary: { counts, hit: counts.media + counts.io + counts.realloc > 0, disks, gaps: 1 } });
const row = (o = {}) => ({ id: 'fm-1', name: 's1', agent: '', group: '', corp: null, smodel: null, ready: null, lastError: null, job: null, last: null, ...o });

describe('디스크 점검 — 글 · 표시 규칙', () => {
  it('탭 · 묶어 보기 · 법인 칸', () => {
    expect(TABS.map((t) => t.key)).toContain('audit');
    expect(AUDIT_VIEW_KEYS).toEqual(['server', 'corp', 'disk', 'cross', 'smodel', 'group']);
    expect(EDIT_FIELDS).toContain('corp');
    const ch = editChanges({ corp: '' }, { corp: 'kr-hq' }, { corpName: () => '한국 본사' });
    expect(ch.changes.find((c) => c.k === 'corp')).toMatchObject({ from: '지정 안 함(담당 엣지의 법인)', to: '한국 본사' });
    expect(ch.endpoint).toBe(false); // 법인은 접속처가 아니다
  });

  it('상태 — 작업 > 연결 오류 > 준비 상태 > 최근 결과', () => {
    expect(rowStatus(row({ job: { state: 'running', mode: 'run', phase: '판정', startedAt: 1 } }), 65_001)).toMatchObject({ tone: 'live', sub: '지금 단계: 판정 · 1분 5초째' });
    expect(rowStatus(row({ job: { state: 'queued', node: 'PL', delivered: false } })).sub).toMatch(/받아 가기를 기다림/);
    expect(rowStatus(row({ lastError: { at: 5, kind: 'auth-stopped', error: 'x' }, ready: { state: 'ready', at: 1 } })).label).toMatch(/키 로그인 거부로 멈춤/);
    expect(rowStatus(row({ lastError: { at: 1, kind: 'lost' }, ready: { state: 'nosudo', at: 5, reason: 'r' } })).label).toBe(READY_TEXT.nosudo.label); // 더 새 준비 확인이 이긴다
    expect(rowStatus(row({ ready: { state: 'ready' }, last: done({ media: 0, io: 0, realloc: 0 }) })).label).toBe('점검함');
    expect(rowStatus(row({ ready: { state: 'ready' }, last: { outcome: 'timeout', summary: {} } })).label).toMatch(/시한 초과/);
    expect(rowStatus(row()).label).toBe('확인한 적 없음');
  });

  it('숫자 — 끝까지 돈 회차만 · 없으면 —(0 아님)', () => {
    expect(lastCounts(row({ last: { outcome: 'timeout', summary: { counts: { media: 99 } } } }))).toBe(null);
    expect(lastCounts(row({ last: done({ media: 3, io: 1, realloc: 0 }) })).media).toBe(3);
    expect(countText(null)).toBe(DASH); expect(countText(0)).toBe('0'); expect(countText(1234)).toBe('1,234');
    expect(durText(null)).toBe(DASH); expect(durText(221_000)).toBe('3분 41초');
    expect(rateText({ n: 12, bad: 1, rate: 8.3 })).toBe('8.3% (1/12)');
    expect(rateText({ n: 4, bad: 0, rate: null })).toBe('0 / 4 · 표본 적음');
    expect(rateText({ n: 0 })).toBe(DASH);
  });

  it('점검 단추 — 작업 중 · 알려진 준비 안 됨이면 닫는다', () => {
    expect(canRunRow(row())).toBe(true);
    expect(canRunRow(row({ ready: { state: 'ready' } }))).toBe(true);
    expect(canRunRow(row({ ready: { state: 'version' } }))).toBe(false);
    expect(canRunRow(row({ job: { state: 'queued' } }))).toBe(false);
  });

  it('거르기 · 묶음 거르기', () => {
    const rows = [
      row({ id: 'a', corp: { id: 'kr', name: 'KR' }, smodel: 'R740', last: done({ media: 1, io: 0, realloc: 0 }, [{ model: 'ST4000' }]) }),
      row({ id: 'b', corp: { id: 'kr', name: 'KR' }, ready: { state: 'nosudo' } }),
      row({ id: 'c', corp: null, last: done({ media: 0, io: 0, realloc: 0 }, [{ model: '' }]) }),
    ];
    expect(chipCounts(rows).map((c) => c[1])).toEqual(['전체 3', '기록 있음 1', '준비 안 됨 1', '점검 결과 없음 1']);
    expect(rows.filter(chipFilter('hit')).map((r) => r.id)).toEqual(['a']);
    expect(rows.filter(scopeFilter({ k: 'corp', key: 'kr' })).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.filter(scopeFilter({ k: 'corp', key: '' })).map((r) => r.id)).toEqual(['c']);
    expect(rows.filter(scopeFilter({ k: 'disk', key: '모델 모름' }, { noModel: '모델 모름' })).map((r) => r.id)).toEqual(['c']);
    expect(rows.filter(scopeFilter({ k: 'cross', corp: 'kr', model: 'ST4000' })).map((r) => r.id)).toEqual(['a']);
    expect(scopeText({ k: 'cross', corpName: 'KR', model: 'ST4000' })).toBe('법인 = KR · 디스크 모델 = ST4000');
    expect(notReadyText({ nosudo: 2, nopy: 1 })).toBe('sudo 규칙 없음 2 · python3 없음 1');
    expect(notReadyText({})).toBe('없음');
  });

  it('설치 안내 — 응답의 경로 · 판본으로(박지 않는다) · 백틱 없음', () => {
    const t = installSteps({ program: '/p.py', wrapper: '/w', sudoers: '/s', run: 'sudo -n /w' }, { program: 'abc', wrapper: 'def' });
    expect(t).toContain('sudo -n /w'); expect(t).toContain('rm -f /s /w /p.py'); expect(t).toContain('프로그램 abc');
    expect(t.includes('`')).toBe(false);
  });
});
