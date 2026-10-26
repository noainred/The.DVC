// v2.785(점검 GV) — 웹 쪽.
//  D-B2 VM 상세 이력: 서버가 '지연 없음' 을 판정했으면(lagging === false) 마지막 이벤트 2일 기준으로 대신 판단하지 않는다(조용한 vCenter 의 거짓 경고).
//       키가 없거나(옛 서버) null(판정 실패)이면 지금처럼 lastTs 로 대신 판단한다.
//  C-B4 백업 세부내용: 조회가 실패해도 머리(vCenter 선택·옵션·새로고침)는 늘 보인다 — 예전에는 조기 return 이 선택 상자보다 앞이라
//       실패하는 vCenter 에 갇혔다(그 id 가 저장돼 다시 들어와도 같은 vCenter). 403 은 오류 객체를 그대로 넘겨 ErrorBox 가 권한 안내로.
//  C-I1 세부내용 CSV 버튼 안내가 검색어를 반영하지 않는다는 사실을 말한다.
// 오류 상태는 effect(fetch) 뒤에만 생겨 정적 렌더로 닿지 않는다 — 소스 계약으로 고정하고 화면은 Chromium 으로 본다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { vmHistoryLagText, HISTORY_STALE_MS } from '../vmchanges/vmChangesText.js';

const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

describe('D-B2 VM 상세 이력 지연 문구', () => {
  const old = NOW - HISTORY_STALE_MS - 26 * H;   // 3일 전 2시간 전후 — 옛 대체 기준이면 경고
  it('서버가 지연 없음(false)을 판정했으면 마지막 이벤트가 오래돼도 경고하지 않는다', () => {
    expect(vmHistoryLagText({ lagging: false, lastTs: old, notCollected: null, items: [] }, NOW)).toBe(null);
  });
  it('판정 실패(null)·옛 서버(키 없음)는 지금처럼 lastTs 로 대신 판단한다', () => {
    expect(vmHistoryLagText({ lagging: null, lastTs: old, items: [] }, NOW)).toContain('수집 지연·정지');
    expect(vmHistoryLagText({ lastTs: old, items: [] }, NOW)).toContain('수집 지연·정지');
    expect(vmHistoryLagText({ lagging: null, lastTs: NOW - H, items: [] }, NOW)).toBe(null);
  });
  it('서버 지연 객체는 그대로 · 수집하지 않는 vCenter 는 다른 문장(null)', () => {
    expect(vmHistoryLagText({ lagging: { okAt: 1, lagMs: 94 * H }, items: [] }, NOW)).toContain('3일 22시간 뒤처져');
    expect(vmHistoryLagText({ lagging: false, notCollected: 'site', lastTs: old, items: [] }, NOW)).toBe(null);
  });
});

describe('C-B4 백업 화면 오류 처리', () => {
  const det = read('./BackupDetailTool.jsx');
  const sum = read('./BackupSummaryTool.jsx');
  it('세부내용 — 오류·로딩으로 조기 return 하지 않는다(머리의 vCenter 선택이 늘 보인다) · 본문에 오류 상자', () => {
    expect(det).not.toMatch(/return <ErrorBox/);
    expect(det).not.toMatch(/if \(!data && loading\) return/);
    const sel = det.indexOf('<Select className="input" value={vcId}');
    const eb = det.indexOf('<ErrorBox error={error} />');
    expect(sel).toBeGreaterThan(0);
    expect(eb, '선택 상자 뒤(같은 return 안)에 오류 상자').toBeGreaterThan(sel);
    // 첫 조기 return(볼 수 있는 vCenter 없음)이 마지막 return 보다 앞 · 머리와 같은 return 안에 오류·로딩
    const mainReturn = det.indexOf('\n  return (');
    expect(eb).toBeGreaterThan(mainReturn);
    expect(det.indexOf('<Loading />')).toBeGreaterThan(mainReturn);
  });
  it('두 화면 모두 403 을 문자열로 바꾸지 않고 오류 객체를 넘긴다(ErrorBox 가 권한 안내로)', () => {
    for (const s of [det, sum]) {
      expect(s).not.toMatch(/ErrorBox message=\{error\?\.status === 403/);
      expect(s).toMatch(/<ErrorBox error=\{error\} \/>/);
    }
  });
  it('C-I1 세부내용 CSV 버튼 안내 — 검색어는 반영하지 않는다고 밝힌다', () => {
    expect(det).toMatch(/title="[^"]*검색어는 반영하지 않음[^"]*"[^>]*>CSV</);
  });
});
