// v2.498 — 브라우저 성능 보고 순수 로직 회귀 고정(node 환경).
// 핵심: (1) 경로에서 쿼리·식별자가 빠진다(검색어·id 유출 방지), (2) 로딩 문구가 단계별로 정직해지고
// 대기 요청이 없으면 그 사실을 자백한다, (3) 쿨다운·시간당 상한으로 보고가 폭주하지 않는다.
import { describe, it, expect } from 'vitest';
import { normPath, normView, loadingText, allowReport, newReportState, stallPayload } from '../perfClientLogic.js';

describe('경로·화면 정규화', () => {
  it('쿼리·해시를 버리고 식별자 세그먼트를 마스킹한다', () => {
    expect(normPath('/tools/waste?vcenterId=vc-1&q=secret')).toBe('/tools/waste');
    expect(normPath('/vms/12345/spark')).toBe('/vms/:id/spark');
    expect(normPath('/idrac/550e8400-e29b-41d4-a716-446655440000/sensors')).toBe('/idrac/:id/sensors');
    expect(normPath('/vms/vc1:vm-42')).toBe('/vms/:id');
    expect(normPath('')).toBe('/');
  });
  it('화면 해시도 쿼리를 버린다', () => {
    expect(normView('#/insights/finops?tab=x')).toBe('#/insights/finops');
    expect(normView(undefined)).toBe('');
  });
});

describe('로딩 문구 — 단계별로 정직해진다', () => {
  it('짧은 대기에는 잡음을 더하지 않는다', () => {
    const t = loadingText({ elapsedSec: 3 });
    expect(t.text).toBe('불러오는 중…');
    expect(t.detail).toBe('');
    expect(t.suggestReload).toBe(false);
  });
  it('15초 뒤 경과 초를 보여준다', () => {
    expect(loadingText({ elapsedSec: 18 }).text).toBe('불러오는 중… (18초째)');
    expect(loadingText({ elapsedSec: 18 }).detail).toBe('');
  });
  it('30초 뒤에는 무엇을 몇 초째 기다리는지 말한다(경로는 정규화)', () => {
    const t = loadingText({ elapsedSec: 45, inflight: [{ path: '/insights/finops?x=1', ms: 42_000 }, { path: '/overview', ms: 1_000 }] });
    expect(t.detail).toContain('/insights/finops');
    expect(t.detail).not.toContain('x=1');
    expect(t.detail).toContain('42초');
    expect(t.detail).toContain('외 1건');
    expect(t.suggestReload).toBe(false);
  });
  it('대기 중인 요청이 없으면 화면 상태 문제일 수 있다고 자백하고 새로고침을 권한다', () => {
    const t = loadingText({ elapsedSec: 200, inflight: [] });
    expect(t.detail).toContain('대기 중인 요청이 없습니다');
    expect(t.suggestReload).toBe(true);
  });
  it('가장 오래 기다린 요청을 고른다', () => {
    const t = loadingText({ elapsedSec: 60, inflight: [{ path: '/a', ms: 1_000 }, { path: '/b', ms: 50_000 }] });
    expect(t.detail).toContain('/b');
  });
});

describe('보고 폭주 방지', () => {
  it('같은 키는 쿨다운 동안 다시 보내지 않는다', () => {
    const s = newReportState();
    const t0 = 1_700_000_000_000;
    expect(allowReport(s, 'k', t0)).toBe(true);
    expect(allowReport(s, 'k', t0 + 1_000)).toBe(false);
    expect(allowReport(s, 'k', t0 + 300_001)).toBe(true);
    expect(allowReport(s, 'other', t0 + 1_000)).toBe(true);
  });
  it('시간당 상한을 넘으면 버리고 버린 수를 센다(조용히 삼키지 않는다)', () => {
    const s = newReportState();
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 50; i++) expect(allowReport(s, `k${i}`, t0, { maxPerHour: 50 })).toBe(true);
    expect(allowReport(s, 'k99', t0, { maxPerHour: 50 })).toBe(false);
    expect(s.dropped).toBe(1);
    // 다음 시간 버킷에서는 다시 허용
    expect(allowReport(s, 'k99', t0 + 3_600_000, { maxPerHour: 50 })).toBe(true);
  });
  it('키 맵이 상한을 넘지 않는다', () => {
    const s = newReportState();
    for (let i = 0; i < 400; i++) allowReport(s, `k${i}`, 1_700_000_000_000 + i, { maxPerHour: 10_000, maxKeys: 50 });
    expect(s.keys.size).toBeLessThanOrEqual(50);
  });
});

describe('보고 본문', () => {
  it('사용자·IP 를 담지 않고 경로는 정규화·목록은 10건으로 제한한다', () => {
    const p = stallPayload({
      view: '#/insights/finops?a=1', path: '/insights/finops?b=2', ms: 187_000.7,
      inflight: Array.from({ length: 20 }, (_, i) => ({ path: `/x/${i}`, ms: i })),
    });
    expect(p.view).toBe('#/insights/finops');
    expect(p.path).toBe('/insights/finops');
    expect(p.ms).toBe(187_001);
    expect(p.inflight.length).toBe(10);
    expect(p.inflight[0].path).toBe('/x/:id');
    expect(JSON.stringify(p)).not.toContain('a=1');
    expect(Object.keys(p).sort()).toEqual(['inflight', 'ms', 'path', 'view']);
  });
  it('빈 입력도 안전하다', () => {
    const p = stallPayload({});
    expect(p.ms).toBe(0);
    expect(p.inflight).toEqual([]);
  });
});
