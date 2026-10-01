// v2.676 — GPU 카드 표지 · 호스트 상세 → 통합 추이 인계 · '서비스' 표기(사용자 요청).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gpuCardsText, parseTrendHandoff, linkBasisText, resolveFailText, TREND_HANDOFF } from './idracTrendText.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');

describe('GPU 카드 표지', () => {
  const g = (cards) => ({ cards, total: cards.reduce((a, c) => a + c.count, 0) });
  it('ESXi 먼저 · 모델 ×장수', () => {
    const t = gpuCardsText({ esxi: g([{ model: 'NVIDIA A40', count: 2, modes: ['vgpu'] }]), idrac: g([{ model: 'NVIDIA A40', count: 2, modes: [] }]) });
    expect(t.text).toBe('GPU NVIDIA A40 ×2'); expect(t.src).toBe('ESXi'); expect(t.differ).toBe(false);
    expect(t.title).toMatch(/vGPU/);
  });
  it('ESXi 0장이면 iDRAC · 장수가 다르면 말한다(단정하지 않음)', () => {
    const t = gpuCardsText({ esxi: g([]), idrac: g([{ model: 'L4', count: 1, modes: [] }]) });
    expect(t.src).toBe('iDRAC'); expect(t.differ).toBe(true); expect(t.title).toMatch(/단정하지 않습니다/);
  });
  it('둘 다 모름·0장이면 표지 없음', () => {
    expect(gpuCardsText(null)).toBeNull();
    expect(gpuCardsText({ esxi: null, idrac: null })).toBeNull();
    expect(gpuCardsText({ esxi: g([]), idrac: null })).toBeNull();
  });
});

describe('인계 · 연결 근거', () => {
  it('인계 문자열 왕복 · 잘못된 값은 null', () => {
    const h = parseTrendHandoff(JSON.stringify({ id: 's1', host: 'esx01', matchedBy: ['serviceTag', 'mac'], confidence: 'high', conflicts: [], reverseSame: true }));
    expect(h).toEqual({ id: 's1', host: 'esx01', matchedBy: ['serviceTag', 'mac'], confidence: 'high', conflicts: [], reverseSame: true });
    expect(parseTrendHandoff('')).toBeNull(); expect(parseTrendHandoff('{')).toBeNull(); expect(parseTrendHandoff('{"id":3}')).toBeNull();
    expect(TREND_HANDOFF).toBe('idrac-trend');
  });
  it('근거 문장 — 일치 규칙 · 충돌 · 역방향 불일치', () => {
    const s = linkBasisText({ id: 's', host: 'esx01', matchedBy: ['serviceTag', 'hostname'], confidence: 'high', conflicts: ['ip'], reverseSame: false });
    expect(s).toMatch(/서비스태그 · 호스트네임/); expect(s).toMatch(/확실/); expect(s).toMatch(/IP 은 다른 서버/); expect(s).toMatch(/거꾸로/);
    expect(s).not.toMatch(/`/);
  });
  it('실패 사유 — 판정 규칙마다 상태', () => {
    const t = resolveFailText({ reason: 'ambiguous', rules: { serviceTag: { state: 'no-key' }, hostname: { state: 'ambiguous', count: 2 }, ip: { state: 'none' }, mac: { state: 'none' } } });
    expect(t).toMatch(/여럿/); expect(t).toMatch(/호스트네임 여러 서버\(2대\)/); expect(t).toMatch(/서비스태그 값 없음/);
  });
});

describe('소스 — 버튼 위치 · 서비스 표기', () => {
  it('호스트 상세에 성능 그래프 보기 바로 뒤 통합 성능 모니터링', () => {
    const s = read('../../components/EntityDetail.jsx');
    const a = s.indexOf('<HostMetricButton'); const b = s.indexOf('<IdracTrendLinkButton');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(read('../../components/IdracTrendLinkButton.jsx')).toMatch(/통합 성능 모니터링/);
  });
  it('통합 추이 선택칸·표는 서비스', () => {
    expect(read('IdracTrendTool.jsx')).toMatch(/sel\('서비스'/);
    expect(read('IdracTrendTable.jsx')).toMatch(/<th>서비스<\/th>/);
    expect(read('IdracTrendTool.jsx')).not.toMatch(/sel\('데이터센터'/);
  });
});
