import { describe, it, expect } from 'vitest';
import { gbText, bytesText, elapsedText, avgRate, progressLine, portalMark, pointSource, rpText, rpSort, pickHandoff, RUN_STATUS, RUN_STATUS_ORDER, VM_STATE, powerText, runSummary, ago, saveHandoff, takeHandoff, HANDOFF_KEY } from './backupRunText.js';
import { visibleTabs, VEEAM_TABS, veeamSubTabs, topTabOf } from './VeeamHeader.jsx';

// v2.818 Backup 현황 › 백업 실행 — 서버 판정을 글자로만 바꾼다(판정 복제 금지). 못 읽은 값은 '—'.
const memStore = () => { const m = new Map(); return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k), m }; };

describe('VeeamHeader 탭 줄(v2.825.1 — 스크롤바)', () => {
  it('세로로 넘치지 않는다(음수 아래 여백 없음 · 세로 숨김) · 스크롤바를 그리지 않는다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./VeeamHeader.jsx', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    expect(src).not.toMatch(/marginBottom:\s*-1/);   // 테두리 겹치기 1px 가 overflow-y:auto 의 세로 스크롤바를 만들었다
    expect(src).toMatch(/role="tablist"[^>]*className="tabstrip-noscroll"/);
    expect(src).toMatch(/overflowY: 'hidden'/);
    expect(css).toMatch(/\.tabstrip-noscroll \{ scrollbar-width: none; \}/);
    expect(css).toMatch(/\.tabstrip-noscroll::-webkit-scrollbar \{ display: none; \}/);
  });
});

describe('backupRunText', () => {
  it('실행 상태 6종 문구 · 확인 불가·보내지 않음은 회색(성공도 실패도 아님)', () => {
    expect(RUN_STATUS_ORDER).toEqual(['protected', 'in-job', 'unprotected', 'agent', 'elsewhere', 'unknown', 'unmapped']);
    for (const k of RUN_STATUS_ORDER) expect(RUN_STATUS[k].label).toBeTruthy();
    expect(VM_STATE.unknown.cls).toBe('gray'); expect(VM_STATE.skipped.cls).toBe('gray'); expect(VM_STATE.failed.cls).toBe('red');
  });
  it('전원·요약·상대 시각', () => {
    expect(powerText('POWERED_ON')).toBe('켜짐'); expect(powerText('')).toBe('—');
    expect(runSummary({ vms: [{ state: 'running' }, { state: 'success' }, { state: 'unknown' }] })).toBe('진행 1 · 성공 1 · 확인 불가 1');
    expect(runSummary({ vms: [] })).toBe('—');
    expect(ago(null)).toBe('—');
  });
  it('Detail → 백업 실행 넘김: 한 번만 읽힌다 · 10분 지나면 버린다 · 모양이 틀리면 버린다', () => {
    const s = memStore();
    expect(saveHandoff('vc1', ['vc1:vm-1', 'vc1:vm-2'], s)).toBe(true);
    expect(takeHandoff(s)).toEqual({ vcenterId: 'vc1', vmIds: ['vc1:vm-1', 'vc1:vm-2'] });
    expect(takeHandoff(s)).toBe(null);
    saveHandoff('vc1', ['a'], s);
    expect(takeHandoff(s, Date.now() + 11 * 60_000)).toBe(null);
    s.setItem(HANDOFF_KEY, '{"vcenterId":1}');
    expect(takeHandoff(s)).toBe(null);
  });
  it('백업 실행 탭은 관리자 + 도구 허용일 때만 — v2.835 위 탭 4개(Summary · Detail · Veeam · Bareos) · 백업 실행은 Veeam 하위 탭', () => {
    expect(visibleTabs({ admin: false })).toEqual(VEEAM_TABS);
    expect(VEEAM_TABS.map((t) => t[0])).toEqual(['summary', 'detail', 'veeam']);
    expect(visibleTabs({ admin: true, bareosOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'veeam', 'bareos']);
    expect(visibleTabs({ admin: false, bareosOk: true })).toEqual(VEEAM_TABS);
    expect(visibleTabs({ admin: false, bareosViewOk: true }).map((t) => t[0])).toEqual(['summary', 'detail', 'veeam', 'bareos']);
    expect(veeamSubTabs({ admin: false, runOk: true }).map((t) => t[0])).toEqual(['em']);
    expect(veeamSubTabs({ admin: true, runOk: false }).map((t) => t[0])).toEqual(['em']);
    expect(veeamSubTabs({ admin: true, runOk: true }).map((t) => t[0])).toEqual(['em', 'run']);
    expect(['summary', 'detail', 'em', 'run', 'bareos'].map(topTabOf)).toEqual(['summary', 'detail', 'veeam', 'veeam', 'bareos']);
  });
});

describe('v2.819 portalMark · pointSource', () => {
  it('상태별 배지 — 삭제·빼냄이 우선 · 진행 중 · 결과 기호 · 값 없으면 null', () => {
    expect(portalMark(null)).toBe(null);
    const t = new Date(2026, 9, 29, 21, 27).getTime();
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success' })).toMatchObject({ label: 'Portal ✓ 10-29', cls: 'green' });
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'failed' }).label).toBe('Portal ✕ 10-29');
    expect(portalMark({ how: 'quick', lastAt: t, lastState: 'running' }).label).toBe('Portal 백업 중');
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success', excludedAt: t }).label).toBe('Portal 잡에서 뺌');
    expect(portalMark({ how: 'portal', lastAt: t, lastState: 'success', excludedAt: t, deletedAt: t }).label).toBe('Portal 백업 삭제됨');
    expect(portalMark({ lastState: 'unknown' }).label).toBe('Portal ?');   // 시각이 없으면 붙이지 않는다
  });
  it('복원 지점 출처', () => {
    expect(pointSource({ jobName: 'PORTAL-x', portal: true })).toEqual({ name: 'PORTAL-x', portal: true });
    expect(pointSource({ backupName: 'Daily' })).toEqual({ name: 'Daily', portal: false });
    expect(pointSource({})).toEqual({ name: '—', portal: false });
  });
});

describe('v2.820.1 B2·B4', () => {
  it('B2 복원 지점 수 — -1 은 \'있음(개수 모름)\'(모니터링 코어 표기) · 없으면 —', () => {
    expect(rpText(-1)).toBe('있음(개수 모름)');
    expect(rpText(12)).toBe('12');
    expect(rpText(0)).toBe('0');
    expect(rpText(null)).toBe('—');
    expect(rpText(undefined)).toBe('—');
    expect([3, -1, 0, null].map(rpSort)).toEqual([3, 0.5, 0, '']);
  });
  it('B4 넘겨받은 VM — 고를 수 있는 행만(연결 서버 없음·조회 전용 제외)', () => {
    const rows = [{ id: 'a', name: 'A', run: { status: 'protected' } }, { id: 'b', name: 'B', run: { status: 'unmapped' } }, { id: 'c', name: 'C', run: { status: 'unknown' } }];
    expect([...pickHandoff(rows, ['a', 'b', 'c', 'zz'], true).keys()]).toEqual(['a', 'c']);
    expect(pickHandoff(rows, ['a'], false).size).toBe(0);
    expect(pickHandoff(rows, [], true).size).toBe(0);
  });
});

describe('v2.822.2 진행 상세 · VM 크기', () => {
  it('용량 — GB/TB · 없으면 — (단위 없음)', () => {
    expect(gbText(120.46)).toBe('120 GB'); expect(gbText(12.34)).toBe('12.3 GB'); expect(gbText(2048)).toBe('2.0 TB'); expect(gbText(null)).toBe('—');
    expect(bytesText(120 * 1024 ** 3)).toBe('120 GB'); expect(bytesText(undefined)).toBe('—');
  });
  it('경과·평균 속도(계산값)', () => {
    expect(elapsedText(45_000)).toBe('45초'); expect(elapsedText(15 * 60_000)).toBe('15분'); expect(elapsedText(125 * 60_000)).toBe('2시간 5분'); expect(elapsedText(null)).toBe('');
    expect(avgRate(100 * 1024 ** 2, 1000)).toBe(100 * 1024 ** 2); expect(avgRate(null, 5000)).toBe(null); expect(avgRate(10, 500)).toBe(null);
  });
  it('진행 한 줄 — 있는 값만 · 진행 중이면 \'째\' · 끝나면 \'걸림\' · 세션 전체 값은 그렇게 말한다', () => {
    const now = 1_000_000_000_000;
    const live = { state: 'running', progress: 37, metrics: { scope: 'vm', startedAt: now - 15 * 60_000, processedBytes: 120 * 1024 ** 3 } };
    expect(progressLine(live, { provisionedGB: 150, now })).toBe('37% · 처리 120 GB / 할당 150 GB · 15분째 · 평균 137 MB/s(계산)');
    expect(progressLine({ state: 'success', progress: 100, metrics: { scope: 'session', startedAt: now - 60_000, endedAt: now, processedBytes: 1024 ** 3 } }, { now }))
      .toBe('100% · 처리 1 GB(세션 전체) · 1분 걸림 · 평균 17 MB/s(계산)');
    expect(progressLine({ state: 'running', progress: null, metrics: null }, { now })).toBe('');
    expect(progressLine(null)).toBe('');
  });
});
