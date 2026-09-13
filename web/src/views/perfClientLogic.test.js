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

describe('로딩 문구 — 단계별로 정직해진다(v2.501: 문턱 3초)', () => {
  // 사용자 요구로 문턱이 15/30초에서 3초로 내려왔다 — 그 전 단계 단정은 더 이상 유효하지 않다.
  it('3초 미만에는 잡음을 더하지 않는다', () => {
    const t = loadingText({ elapsedSec: 2 });
    expect(t.text).toBe('불러오는 중…');
    expect(t.detail).toBe('');
    expect(t.tasks).toEqual([]);
    expect(t.suggestReload).toBe(false);
  });
  it('3초부터 경과 초와 **무슨 작업인지**를 함께 보여준다', () => {
    const t = loadingText({ elapsedSec: 4, inflight: [{ path: '/tools/waste?vcenterId=vc-1', ms: 4_000 }] });
    expect(t.text).toBe('불러오는 중… (4초째)');
    expect(t.tasks).toHaveLength(1);
    expect(t.tasks[0].label).toBe('낭비 리소스 분석');
    expect(t.detail).toContain('낭비 리소스 분석');
    expect(t.detail).not.toContain('vc-1');   // 쿼리스트링은 정규화로 사라진다
    expect(t.suggestReload).toBe(false);
  });
  it('여러 건이면 오래 기다린 것부터 보이고 나머지 건수를 알린다', () => {
    const t = loadingText({
      elapsedSec: 45,
      inflight: [{ path: '/insights/finops?x=1', ms: 42_000 }, { path: '/overview', ms: 1_000 }],
    });
    expect(t.tasks[0].ms).toBe(42_000);
    expect(t.detail).toContain('42초');
    expect(t.detail).toContain('외 1건');
    expect(t.detail).not.toContain('x=1');
  });
  it('설계상 오래 걸리는 작업은 그 사실을 표시할 수 있게 slow 를 준다', () => {
    const t = loadingText({ elapsedSec: 10, inflight: [{ path: '/tools/waste/export', ms: 10_000 }] });
    expect(t.tasks[0].slow).toBe(true);
  });
  it('3초에 대기 요청이 없다고 새로고침을 권하지 않는다(정상 렌더와 구분 불가)', () => {
    const t = loadingText({ elapsedSec: 5, inflight: [] });
    expect(t.suggestReload).toBe(false);
    expect(t.detail).toContain('화면을 그리는 중');
  });
  it('stuck 임계를 넘고도 대기 요청이 없으면 자백하고 새로고침을 권한다', () => {
    const t = loadingText({ elapsedSec: 200, inflight: [], stuckSec: 60 });
    expect(t.detail).toContain('대기 중인 요청이 없습니다');
    expect(t.suggestReload).toBe(true);
  });
  it('문턱은 주입값을 따른다(뷰가 3초를 하드코딩하지 않는다)', () => {
    expect(loadingText({ elapsedSec: 4, detailSec: 10 }).detail).toBe('');
    expect(loadingText({ elapsedSec: 4, detailSec: 10 }).text).toBe('불러오는 중…');
  });
  it('label 을 주면 무엇을 불러오는지 제목에 쓴다', () => {
    expect(loadingText({ elapsedSec: 1, label: '포탈 시작' }).text).toBe('포탈 시작…');
    expect(loadingText({ elapsedSec: 7, label: '포탈 시작' }).text).toBe('포탈 시작… (7초째)');
  });
  it('가장 오래 기다린 요청을 고른다(표에 없는 경로는 다듬어 그대로 — 지어내지 않는다)', () => {
    const t = loadingText({ elapsedSec: 60, inflight: [{ path: '/a', ms: 1_000 }, { path: '/b', ms: 50_000 }] });
    expect(t.tasks[0].ms).toBe(50_000);
    expect(t.tasks[0].known).toBe(false);
    expect(t.detail).toContain('50초');
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
