import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './horizonUsageText.js';

const serverSrc = fs.readFileSync(new URL('../../../../server/src/horizon/appUsage.js', import.meta.url), 'utf8');

describe('horizonUsageText (v2.684)', () => {
  it('해석 근거 문구는 서버 BASES 와 1:1 이다(한쪽만 늘면 화면이 코드를 그대로 보여 준다)', () => {
    const m = serverSrc.match(/export const BASES = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(Object.keys(T.BASIS_TEXT).sort()).toEqual(keys);
  });

  it('지금 접속 중 — 최신 수집 서버가 0대면 모른다(0 이 아니다), 상태 미확인도 —', () => {
    expect(T.nowText({ connectedUsersNow: 3 }, 0)).toBe('—');
    expect(T.nowText(undefined, 2)).toBe('0');
    expect(T.nowText({ connectedUsersNow: null, sessionsNow: null }, 1)).toBe('0');
    expect(T.nowText({ connectedUsersNow: null, sessionsNow: 4 }, 1)).toBe('—');
    expect(T.nowText({ connectedUsersNow: 5, nowBySum: true }, 2)).toBe('5+');
  });

  it('수집이 없던 날은 0명이 아니라 수집 없음', () => {
    expect(T.dayCell({ users: null })).toBe('수집 없음');
    expect(T.dayCell({ users: 0 })).toBe('0명');
    expect(T.dayCell({ users: 7, partial: true })).toBe('7명 (일부 수집)');
    expect(T.dayCell({ users: 2, today: true })).toBe('2명 (진행 중)');
  });

  it('누적이 하한이라는 문장에 서버 주기를 쓴다(숫자를 박지 않는다)', () => {
    expect(T.lowerBoundNote(5 * 60_000)).toMatch(/5분/);
    expect(T.lowerBoundNote(10 * 60_000)).toMatch(/10분/);
    expect(T.lowerBoundNote(5 * 60_000)).toMatch(/하한/);
  });

  it('팜 단위로 센 세션이 있으면 그 사실과 이유를 말한다', () => {
    const b = T.basisSummary([{ usageMeta: { basisCounts: { 'app-pool': 3, farm: 2, unknown: 0 } } }, { usageMeta: { basisCounts: { 'farm-id': 1 } } }]);
    expect(b.farmOnly).toBe(3);
    expect(b.farmNote).toMatch(/팜 단위/);
    expect(b.text).toMatch(/6건/);
    expect(T.basisSummary([{ usageMeta: {} }])).toBe(null);
    expect(T.basisSummary([{ usageMeta: { basisCounts: { 'app-pool': 1 } } }]).farmNote).toBe(null);
  });

  it('빈 상태를 한 문구로 덮지 않는다', () => {
    expect(T.emptyNote({ available: false })).toMatch(/DB/);
    expect(T.emptyNote({ available: true, settings: { enabled: false }, services: [] })).toMatch(/꺼져/);
    expect(T.emptyNote({ available: true, settings: { enabled: true }, services: [] })).toMatch(/기록된 사용이 없/);
    expect(T.emptyNote({ available: true, settings: { enabled: true }, services: [{}] })).toBe('');
    // v2.686 HZ-08: 세션을 읽은 서버가 없으면 '다음 주기부터 쌓입니다'(기다리면 된다) 라고 말하지 않는다.
    const noEp = T.emptyNote({ available: true, settings: { enabled: true }, services: [], serverMeta: [{ ok: false, kind: 'no-endpoint' }] });
    expect(noEp).toMatch(/404/); expect(noEp).toMatch(/기다려도 채워지지 않습니다/); expect(noEp).not.toMatch(/다음 주기부터/);
    // 섞여 있으면(한 대는 404, 다른 한 대는 고칠 수 있는 실패) 원인을 404 로 단정하지 않는다(WEB2686-04).
    const mixed = T.emptyNote({ available: true, settings: { enabled: true }, services: [], serverMeta: [{ ok: false, kind: 'no-endpoint' }, { ok: false, kind: 'auth' }] });
    expect(mixed).not.toMatch(/기다려도 채워지지 않습니다/);
    expect(mixed).toMatch(/서버별 사유/); expect(mixed).toMatch(/그중 1대는 세션 API 가 없는 버전/);
    expect(T.emptyNote({ available: true, settings: { enabled: true }, services: [], serverMeta: [{ ok: false, kind: 'auth' }] })).toMatch(/서버별 사유/);
    expect(T.emptyNote({ available: true, settings: { enabled: true }, services: [], serverMeta: [{ ok: true, kind: 'ok' }] })).toMatch(/다음 주기부터/);
  });

  it('기간 요약 — 수집 없는 날·일부 수집·기록 시작일', () => {
    const n = T.coverageNote({ totals: { daysNoData: 2, daysPartial: 1 }, firstDay: '2026-10-01', fromDay: '2026-09-26' });
    expect(n).toMatch(/2일/);
    expect(n).toMatch(/일부만/);
    expect(n).toMatch(/2026-10-01부터/);
    expect(T.coverageNote({ totals: {} })).toBe('');
  });

  it('카탈로그 실패·절단을 서버별로 말한다', () => {
    const n = T.catalogNotes([{ name: 'HZ1', usageMeta: { catalog: { errors: { desktop: '/rest/x: HTTP 500' }, truncated: { app: true } } } }]);
    expect(n.length).toBe(2);
    expect(n[0]).toMatch(/HZ1/);
  });

  it('CSV 경로·기간 라벨', () => {
    expect(T.usageCsvPath(7, '')).toBe('/tools/horizon-sessions/usage.csv?days=7');
    expect(T.usageCsvPath(30, 'hz 1')).toBe('/tools/horizon-sessions/usage.csv?days=30&serverId=hz%201');
    expect(T.daysLabel(1)).toBe('오늘');
    expect(T.daysLabel(30)).toBe('30일');
  });

  it('화면 문구에 백틱이 없다(BoldText 는 별표 강조만 해석한다)', () => {
    const src = fs.readFileSync(new URL('./horizonUsageText.js', import.meta.url), 'utf8');
    const strings = [...Object.values(T.BASIS_TEXT), ...Object.values(T.KIND_TEXT), T.NOW_SUM_NOTE, T.lowerBoundNote(300000)];
    for (const s of strings) expect(s.includes('`')).toBe(false);
    expect(src.length).toBeGreaterThan(0);
  });
});
