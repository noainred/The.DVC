import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as M from './cvpMoreText.js';
import * as T from './cvpText.js';

describe('v2.641 CVP 개요·CPU·이벤트·포트 사용량 문구', () => {
  it('업타임 — 부팅 시각을 모르면 —, 미래 시각도 —', () => {
    const now = Date.UTC(2026, 8, 28, 0, 0, 0);
    expect(M.uptimeText(null, now)).toBe('—');
    expect(M.uptimeText(now + 1000, now)).toBe('—');
    expect(M.uptimeText(now - (3 * 24 + 5) * 3600_000, now)).toBe('3일 5시간');
    expect(M.uptimeText(now - 2 * 3600_000, now)).toBe('2시간');
  });
  it('사용률 셀 — 못 읽으면 —(0% 아님) · 80% 주의 · 90% 이상 위험', () => {
    expect(M.sysCell(null).text).toBe('—');
    expect(M.sysCell('').text).toBe('—');
    expect(M.sysCell(79).tone).toBe('ok');
    expect(M.sysCell(80).tone).toBe('warn');
    expect(M.sysCell(95).tone).toBe('bad');
  });
  it('개요 행 — 읽지 못한 묶음은 비고가 그 사실을 말한다', () => {
    const rows = M.overviewRows({ hostname: 'a', info: { readKinds: ['enrich'], status: 'Registered', complianceIndication: 'NONE' } });
    const byLabel = Object.fromEntries(rows.map(([l, v, n]) => [l, { v, n }]));
    expect(byLabel['설정 컴플라이언스'].v).toBe('준수');
    expect(byLabel['소프트웨어 지원 종료'].n).toMatch(/읽지 못함/);
    expect(byLabel['버그 노출'].n).toMatch(/읽지 못함/);
    expect(byLabel['업타임'].v).toBe('—');
  });
  it('이벤트 — 못 읽은 CVP 와 보고 없는 CVP 를 구분해 말한다', () => {
    const notes = M.eventReadNotes([{ name: 'OC2', events: null, missing: '404' }, { name: 'WA', events: undefined }, { name: 'NJ', events: { capped: true } }]);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/읽지 못한 CVP 1대/);
    expect(M.severityCounts({ critical: 2 })).toEqual([{ key: 'critical', label: 'Critical', tone: 'bad', count: 2 }]);
  });
  it('포트 사용량 KPI — 계산할 수 없는 포트를 사유별로(0% 로 세지 않는다)', () => {
    const k = M.portUsageKpis({ total: 10, measured: 3, notUp: 4, noSpeed: 1, noRate: 1, stale: 1, over80: 1, over50: 0 }, { staleMs: 15 * 60_000 });
    const by = Object.fromEntries(k.map((x) => [x.key, x]));
    expect(by.noRate.value).toBe('1');
    expect(by.over80.accent).toBe('var(--red)');
    expect(by.over50.accent).toBeNull();
    expect(by.stale.meta).toMatch(/15분/);
  });
  it('경로 탐색 표본 — 빈 응답·포인터·값·실패를 구분한다', () => {
    const r = M.probeRows([{ path: '/a', ok: true, empty: true }, { path: '/b', ok: true, empty: false, ptrs: 2, ptrKeys: ['E1', 'E2'] }, { path: '/c', ok: true, empty: false, ptrs: 0, updates: 5 }, { path: '/d', ok: false, status: 404 }]);
    expect(r.map((x) => x.shape)).toEqual(['빈 응답(값 없음)', '포인터 2개 (E1, E2)', '값 5개', '실패 HTTP 404']);
  });
  it('서버·웹 SYS_HIGH_PCT 가 같다 · 문구에 백틱 없음', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/routes/api/cvp.js', import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp(`SYS_HIGH_PCT = ${T.SYS_HIGH_PCT};`));
    const mine = fs.readFileSync(new URL('./cvpMoreText.js', import.meta.url), 'utf8');
    expect(mine.includes('`\\`')).toBe(false);
  });
  it('빈 응답 셀 — 포트 0/0 이 아니라 읽지 못함, BGP 는 값 없음', () => {
    expect(T.portsCell(null, { empty: true }).text).toBe('읽지 못함');
    expect(T.bgpCell(null, { empty: true }).text).toBe('값 없음');
    expect(T.sampleBadge({ empty: true }).label).toBe('빈 응답');
    expect(T.sampleBadge({ unread: true }).label).toBe('못 읽음');
  });
});
