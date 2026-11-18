// v3.21.0 — VM 탭 ‘분석’ 보기 렌더(서버 vmInsightOf 로 만든 실제 응답 모양) · 보기 줄의 ‘과할당’ 권한 · 소스 규약.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';

const { vmInsightOf } = await import('../../../../server/src/inventory/vmInsight.js');
const { signalContext } = await import('../../../../server/src/inventory/vmSignals.js');

const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
const VMS = [
  vm('va', 'a1', { cpuUsagePct: 95 }), vm('va', 'a2'), vm('va', 'a3', { powerState: 'POWERED_OFF' }),
  vm('vb', 'b1', { cpuUsagePct: 60 }), vm('vb', 'b2'), vm('vb', 'b3', { connectionState: 'orphaned' }),
  vm('vs', 's1', { cpuUsagePct: 77 }),
];
const vcOf = (id, region, o = {}) => ({ id, name: `법인-${id}`, status: 'connected', location: { region, city: `${id}-city` }, ...o });
const RESP = { ok: true, generatedAt: '2026-11-18T00:00:00Z', initial: false, region: null,
  ...(await vmInsightOf({ vcenters: [vcOf('va', '유럽'), vcOf('vb', '아시아'), vcOf('vs', '아시아')], vms: VMS, ctx: signalContext({ snapAgeDays: 7 }, Date.now()) })) };
// vs 법인은 값이 오래됨 — 합에 섞지 않는다
RESP.rows = RESP.rows.map((r) => (r.id === 'vs' ? { ...r, stale: true } : r));

const perm = { tools: true };
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/vms/insight' ? { data: RESP, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => perm.tools, hasRole: () => perm.tools };
});
const { default: VmInsight } = await import('./VmInsight.jsx');
const { default: VmHubTabs } = await import('./VmHubTabs.jsx');

const render = (p) => renderToStaticMarkup(React.createElement(VmInsight, { filters: {}, onScopeIds: () => {}, ...p }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('분석 보기 렌더', () => {
  it('시안 순서 — 요약 6장 · 확인할 것 · VM 현황 · 지역별 분포 · 지금 볼 VM · 묶음 머리줄', () => {
    perm.tools = true;
    const t = text(render({}));
    const order = ['전체 VM', '확인할 것', 'VM 현황', '지역별 분포', '지금 볼 VM', '용량과 정리', '오래된 스냅샷', '성능', '구성 점검', '분포'];
    let at = -1;
    for (const w of order) { const i = t.indexOf(w, at + 1); expect(i, w).toBeGreaterThan(at); at = i; }
    expect(t).toMatch(/오래됨 1곳\(법인-vs\)/);       // 오래됨은 합에 넣지 않고 따로
    expect(t).toMatch(/전체 VM 6 /);                  // 7대 중 오래된 법인의 1대 제외
    expect(t).toMatch(/설정 · 520px ▾/);              // 처음 크기 = 크게 520 · 설정 상자는 닫힘
    expect(t).not.toMatch(/지도 크기 설정/);
    expect(t).not.toMatch(/아주 크게/);                // v3.22.1: 크기 칸(자동 · 보통 · 크게 · 아주 크게)도 상자 안에만 — 닫힌 동안은 안 보인다
  });
  it('고른 법인만 합 — vb 하나', () => {
    const t = text(render({ scopeIds: ['vb'] }));
    expect(t).toMatch(/전체 VM 3 /);
    expect(t).toMatch(/법인 1곳을 골랐습니다/);
  });
  it('지도 칸은 단추(aria-pressed) — 고른 칸만 눌림', () => {
    const html = render({ scopeIds: ['va'] });
    expect(html).toMatch(/aria-pressed="true"[^>]*title="법인-va/);
    expect((html.match(/class="ins-tl /g) || []).length).toBe(3);
  });
  it('리뷰 정정 — 용량과 정리 묶음의 패널 순서는 시안대로 디스크 → 오래된 스냅샷 → 꺼진 VM → 추이', () => {
    perm.tools = true;
    const html = render({});
    const at = (label) => html.indexOf(`aria-label="${label}"`);
    const order = ['디스크가 차 가는 VM', '오래된 스냅샷', '꺼진 VM', 'VM 수 추이와 생성 · 삭제'];
    for (let i = 0; i < order.length; i += 1) expect(at(order[i]), order[i]).toBeGreaterThan(i ? at(order[i - 1]) : -1);
  });
  it('도구 권한이 없으면 성능 · 구성 점검 묶음 · 과할당 보기가 없다', () => {
    perm.tools = false;
    const t = text(render({}));
    expect(t).not.toMatch(/구성 점검/);
    expect(t).not.toMatch(/CPU · 메모리 과할당 후보/);
    expect(text(render({ mode: 'over' }))).toMatch(/도구 권한이 없어/);
    expect(text(renderToStaticMarkup(React.createElement(VmHubTabs, { active: 'insight' })))).not.toMatch(/과할당/);
    perm.tools = true;
    expect(text(renderToStaticMarkup(React.createElement(VmHubTabs, { active: 'insight' })))).toMatch(/분석 목록 법인별 조치 필요 과할당/);
  });
});

describe('소스 규약', () => {
  const files = ['./VmInsight.jsx', './vmInsightText.js', '../insight/InsightParts.jsx', '../insight/Treemap.jsx', '../insight/MapSize.jsx', '../insight/insightCore.js', '../insight/treemap.js', '../insight/insightPrefs.js', '../insight/useInsight.js'];
  it('화면 문구에 백틱 없음 · uppercase 없음 · 날 table 없음 · localStorage 는 insightPrefs 한 곳(try/catch)', () => {
    for (const f of files) {
      const src = stripComments(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
      expect(src, f).not.toMatch(/text-transform/);
      expect(src, f).not.toMatch(/<table/);
      if (!f.endsWith('insightPrefs.js')) expect(src, f).not.toMatch(/localStorage/);
    }
    const css = fs.readFileSync(new URL('../insight/insight.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/text-transform/);
    // JSX 문구 안 백틱 — 템플릿 리터럴은 코드이므로 따옴표 안 글자만 본다
    const jsx = stripComments(fs.readFileSync(new URL('./VmInsight.jsx', import.meta.url), 'utf8'));
    for (const m of jsx.matchAll(/'([^'\n]*)'/g)) expect(m[1]).not.toMatch(/`/);
  });
  it('리뷰 정정 — 리전만 고른 범위에서는 도구 패널 · 확인할 것 도구 칸도 그 리전의 법인(이 응답의 줄)만 더한다', () => {
    const src = stripComments(fs.readFileSync(new URL('./VmInsight.jsx', import.meta.url), 'utf8'));
    // dbg3221 2회차: 규칙은 insightCore.toolIdsOf 하나(오래됨 · 모름 법인도 뺀다 — 순수 시험은 views/hosts/insightFixes2.dbg3221.test.jsx)
    expect(src).toMatch(/const toolIdsRaw = toolIdsOf\(\{ ids, region, rows, picked, loaded: !!data \}\)/);
    expect(src).not.toMatch(/vcIds=\{ids\}/);                       // 도구 패널 · 과할당에 ids 를 그대로 넘기지 않는다
    expect(src).toMatch(/checkItems\(\{ vcIds: toolIds/);
  });
  it('/vms/insight 는 30초 폴링 · 고른 법인을 싣지 않는다(리전만)', () => {
    const src = stripComments(fs.readFileSync(new URL('./VmInsight.jsx', import.meta.url), 'utf8'));
    expect(src).toMatch(/usePolling\('\/vms\/insight', region \? \{ region \} : \{\}, 30_000\)/);
  });
});
