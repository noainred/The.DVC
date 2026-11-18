// v3.20.0 — 가상화 허브 ‘바로가기 복수 선택’(사용자 요청 2026-11-18 · 설계 docs/design/vm-menu §5 ③ 기본값 ‘복수 선택 · 세 탭 공용’ · 시안 ② Picked).
//   판정 코어(platformText — 목록 정리 · 토글 · 리전 밖 제거 · API 쿼리 · 카드 범위 · 이웃)와 소스 계약(칩 aria-pressed · ‘✕ 전체 법인’ · ‘법인 N곳 선택’ · API 조립 한 함수).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  normScopeIds, scopeIdsOf, singleScopeId, toggleScopeId, idsInRegion, hubScopeQuery, sitesInHubScope, hubScopePatch, multiPickText, MULTI_PICK_VALUE,
  siblingSites, siblingScopeText, scopeLabel, chipLegend, SCOPE_IDS_MAX,
} from './platformText.js';
import { stripComments } from '../../test/_stripComments.js';

vi.mock('../../api.js', async (orig) => ({ ...(await orig()), usePolling: () => ({ data: null, error: null, loading: false }), fetchJson: () => new Promise(() => {}) }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => stripComments(fs.readFileSync(path.resolve(HERE, rel), 'utf8'));
const h = React.createElement;

const VCS = [
  { id: 'kr1', name: 'KR1', location: { region: '아시아', city: 'Seoul' } },
  { id: 'kr2', name: 'KR2', location: { region: '아시아', city: 'Busan' } },
  { id: 'pl1', name: 'PL1', location: { region: '유럽', city: 'Warsaw' } },
  { id: 'us1', name: 'US1', location: { region: '북미', city: 'Ashburn' } },
];
const ids = (l) => l.map((s) => s.id);

describe('v3.20.0 판정 코어 — 목록 정리 · 단일 변환', () => {
  it('normScopeIds — 배열 · 쉼표 글자 모두 · 공백 제거 · 빈 값 · 중복 · 객체 제외 · 고른 차례 유지', () => {
    expect(normScopeIds([' a ', 'b', '', 'a', null, {}, 'c'])).toEqual(['a', 'b', 'c']);
    expect(normScopeIds('a, b,,a')).toEqual(['a', 'b']);
    expect(normScopeIds(undefined)).toEqual([]); expect(normScopeIds('')).toEqual([]);
  });
  it('normScopeIds — 상한(SCOPE_IDS_MAX = 200)에서 앞에서 자른다', () => {
    const many = Array.from({ length: 250 }, (_, i) => `v${i}`);
    const out = normScopeIds(many);
    expect(SCOPE_IDS_MAX).toBe(200); expect(out.length).toBe(200); expect(out[0]).toBe('v0'); expect(out[199]).toBe('v199');
  });
  it('scopeIdsOf — 목록이 우선 · 없으면 옛 단일 vcenterId · 쓰레기는 빈 목록', () => {
    expect(scopeIdsOf({ vcenterIds: ['a', 'b'], vcenterId: 'z' })).toEqual(['a', 'b']);
    expect(scopeIdsOf({ vcenterId: 'z' })).toEqual(['z']);
    expect(scopeIdsOf({ vcenterIds: [], vcenterId: '' })).toEqual([]);
    expect(scopeIdsOf(null)).toEqual([]); expect(scopeIdsOf('a')).toEqual([]);
  });
  it('singleScopeId — 정확히 1곳일 때만 그 id', () => {
    expect(singleScopeId(['a'])).toBe('a'); expect(singleScopeId(['a', 'b'])).toBe(''); expect(singleScopeId([])).toBe('');
  });
});

describe('v3.20.0 판정 코어 — 토글 · 전체 해제 · 리전 밖 제거', () => {
  it('toggleScopeId — 없으면 뒤에 더하고 있으면 뺀다(새 배열) · 빈 id 는 그대로', () => {
    const a = ['kr1'];
    const b = toggleScopeId(a, 'pl1');
    expect(b).toEqual(['kr1', 'pl1']); expect(a).toEqual(['kr1']);
    expect(toggleScopeId(b, 'kr1')).toEqual(['pl1']);
    expect(toggleScopeId(['kr1'], 'kr1')).toEqual([]);
    expect(toggleScopeId(['kr1'], '')).toEqual(['kr1']);
  });
  it('전체 해제 — hubScopePatch({ vcenterIds: [] }) 는 빈 목록', () => {
    expect(hubScopePatch({ vcenterIds: [] })).toEqual({ vcenterIds: [] });
  });
  it('idsInRegion — 그 리전 밖 선택만 푼다 · 전체 리전이면 그대로 · 목록에 없는 id 는 남긴다(못 읽은 것을 리전 밖으로 단정하지 않는다)', () => {
    expect(idsInRegion(['kr1', 'pl1', 'kr2'], VCS, '아시아')).toEqual(['kr1', 'kr2']);
    expect(idsInRegion(['kr1', 'pl1'], VCS, '')).toEqual(['kr1', 'pl1']);
    expect(idsInRegion(['kr1', 'gone'], VCS, '유럽')).toEqual(['gone']);
    expect(idsInRegion(['kr1'], null, '유럽')).toEqual(['kr1']);
  });
  it('hubScopePatch — 옛 단일 patch({ vcenterId })는 한 곳 목록 · 빈 값은 빈 목록 · 허브 칸에 vcenterId 를 남기지 않는다', () => {
    expect(hubScopePatch({ vcenterId: 'kr1', region: '' })).toEqual({ vcenterIds: ['kr1'], region: '' });
    expect(hubScopePatch({ vcenterId: '', q: 'x' })).toEqual({ vcenterIds: [], q: 'x' });
    expect(hubScopePatch({ region: '유럽' })).toEqual({ region: '유럽' });
    expect(hubScopePatch({ vcenterIds: ['a', 'a', ' b '] })).toEqual({ vcenterIds: ['a', 'b'] });
    expect(hubScopePatch(null)).toEqual({});
  });
});

describe('v3.20.0 API 계약 — hubScopeQuery(1곳 vcenterId · 2곳 이상 vcenterIds · 둘을 함께 보내지 않는다)', () => {
  it('0곳 = 리전이 있으면 region · 아니면 빈 객체', () => {
    expect(hubScopeQuery({})).toEqual({}); expect(hubScopeQuery(null)).toEqual({});
    expect(hubScopeQuery({ vcenterIds: [], region: '유럽' })).toEqual({ region: '유럽' });
  });
  it('1곳 = 지금처럼 vcenterId · 리전은 싣지 않는다', () => {
    expect(hubScopeQuery({ vcenterIds: ['kr1'], region: '아시아' })).toEqual({ vcenterId: 'kr1' });
    expect(hubScopeQuery({ vcenterId: 'kr1' })).toEqual({ vcenterId: 'kr1' });   // 허브 밖 탭(옛 단일 값)도 같은 함수
  });
  it('2곳 이상 = vcenterIds 쉼표 목록(날 글자 — 인코딩은 URLSearchParams 가 한다) · vcenterId 는 없다', () => {
    const q = hubScopeQuery({ vcenterIds: ['kr1', 'pl 1'], region: '아시아' });
    expect(q).toEqual({ vcenterIds: 'kr1,pl 1' });
    expect('vcenterId' in q).toBe(false);
    expect(new URLSearchParams(q).toString()).toBe('vcenterIds=kr1%2Cpl+1');   // 서버(express) 가 'kr1,pl 1' 로 푼다
  });
});

describe('v3.20.0 카드 범위 · 이웃 · 글자', () => {
  it('sitesInHubScope — 고른 법인들만(목록 순서) · 0곳이면 리전 · 둘 다 없으면 전부', () => {
    expect(ids(sitesInHubScope(VCS, { vcenterIds: ['us1', 'kr1'] }))).toEqual(['kr1', 'us1']);
    expect(ids(sitesInHubScope(VCS, { region: '아시아' }))).toEqual(['kr1', 'kr2']);
    expect(ids(sitesInHubScope(VCS, {}))).toEqual(['kr1', 'kr2', 'pl1', 'us1']);
    expect(sitesInHubScope(null, { vcenterIds: ['kr1'] })).toEqual([]);
  });
  it('siblingSites — 2곳 이상이면 고른 법인들 안에서(검색어는 그대로) · 0 · 1곳이면 지금 규칙(리전 · 검색어)', () => {
    expect(ids(siblingSites(VCS, { vcenterIds: ['pl1', 'kr1'] }))).toEqual(['kr1', 'pl1']);
    expect(ids(siblingSites(VCS, { vcenterIds: ['pl1', 'kr1', 'kr2'], q: 'kr' }))).toEqual(['kr1', 'kr2']);
    expect(ids(siblingSites(VCS, { vcenterIds: ['kr1'], region: '아시아' }))).toEqual(['kr1', 'kr2']);
    expect(ids(siblingSites(VCS, { vcenterIds: ['kr1'] }))).toEqual(['kr1', 'kr2', 'pl1', 'us1']);
  });
  it('siblingScopeText · scopeLabel · multiPickText — 2곳 이상이면 ‘법인 N곳’', () => {
    expect(siblingScopeText({ vcenterIds: ['a', 'b', 'c'], q: ' kr ' })).toBe('법인 3곳 · ‘kr’');
    expect(siblingScopeText({ vcenterIds: ['a'], region: '유럽' })).toBe('리전 유럽');
    expect(scopeLabel({ vcenterIds: ['kr1', 'pl1'] }, VCS)).toBe('법인 2곳');
    expect(scopeLabel({ vcenterIds: ['kr1'] }, VCS)).toBe('KR1');
    expect(multiPickText(['a', 'b'])).toBe('법인 2곳 선택'); expect(multiPickText(['a'])).toBe(''); expect(multiPickText([])).toBe('');
    expect(MULTI_PICK_VALUE.startsWith('__')).toBe(true);   // selectSort 가 맨 위에 고정한다(값이 '__' 로 시작)
  });
  it('chipLegend — 세 탭 모두 ‘여러 곳을 함께 고를 수 있습니다’', () => {
    for (const t of ['vcenters', 'hosts', 'vms']) expect(chipLegend(t)).toContain('여러 곳을 함께 고를 수 있습니다');
  });
});

describe('v3.20.0 허브 칩 — 켜고 끄는 단추 · ‘✕ 전체 법인’ · 켜지 않은 칩도 숫자 유지(렌더)', () => {
  const summary = {
    totals: { vcenters: { total: 2, connected: 2 }, hosts: { total: 5 }, vms: { total: 50 } },
    byVc: [{ id: 'kr1', alarms: { critical: 1, warning: 2 } }, { id: 'kr2', alarms: { critical: 0, warning: 4 } }, { id: 'pl1', alarms: { critical: 0, warning: 7 } }],
  };
  const render = async (props) => {
    const { default: PlatformHub } = await import('./PlatformHub.jsx');
    return renderToStaticMarkup(h(PlatformHub, { tab: 'vcenters', tabs: ['vcenters', 'hosts', 'vms'], onTab() {}, summary, vcenters: VCS, ...props }));
  };
  it('켠 칩은 aria-pressed="true" · 켜지 않은 칩은 "false" 이고 둘 다 자기 숫자를 그린다', async () => {
    const html = await render({ vcenterIds: ['kr1', 'pl1'] });
    expect((html.match(/aria-pressed="true"/g) || []).length).toBe(2);
    expect((html.match(/aria-pressed="false"/g) || []).length).toBe(2);
    expect(html).toMatch(/aria-pressed="false"[^>]*>[\s\S]*?kr2<b class="qn-n amber">4<\/b>/);   // 켜지 않은 kr2 도 숫자 4
    expect(html).toMatch(/kr1<b class="qn-n red">3<\/b>/);
    expect(html).toContain('✕ 전체 법인');
  });
  it('하나도 켜지 않으면 ‘✕ 전체 법인’ 이 없다', async () => {
    const html = await render({ vcenterIds: [] });
    expect(html).not.toContain('✕ 전체 법인');
    expect(html).not.toMatch(/aria-pressed="true"/);
  });
  it('켠 칩은 찾기 글자와 무관하게 항상 보인다', async () => {
    const html = await render({ vcenterIds: ['pl1', 'us1'], chipQuery: 'kr' });
    for (const id of ['kr1', 'kr2', 'pl1', 'us1']) expect(html).toContain(`>${id}`);
  });
});

describe('v3.20.0 소스 계약 — App · 허브 · 카드 · 상세 이웃', () => {
  const app = read('../../App.jsx');
  const hub = read('./PlatformHub.jsx');
  const vc = read('../VCenters.jsx');
  it('허브 칸 공유 키에 vcenterIds · 허브 칸 patch 는 hubScopePatch 로 정규화 · 다른 탭 칸은 그대로', () => {
    expect(app).toMatch(/const SHARED_FILTER_KEYS = \['region', 'vcenterId', 'vcenterIds', 'q'\]/);
    expect(app).toMatch(/sk === PLATFORM_SCOPE_KEY \? hubScopePatch\(pickKeys\(patch, SHARED_FILTER_KEYS\)\) : pickKeys\(patch, SHARED_FILTER_KEYS\)/);
    expect(app).toMatch(/const vcenterIds = isPlatformTab\(tab\) \? normScopeIds\(cur\.vcenterIds\) : normScopeIds\(cur\.vcenterId \? \[cur\.vcenterId\] : \[\]\)/);
    expect(app).not.toMatch(/localStorage[^\n]*vcenterIds|vcenterIds[^\n]*localStorage/);   // 고른 법인은 저장하지 않는다(메모리만)
  });
  it('API 범위 조립은 hubScopeQuery 한 함수 — filters · scope 두 곳 · 손으로 vcenterId 를 싣는 옛 조립이 없다', () => {
    expect((app.match(/hubScopeQuery\(\{ vcenterIds: JSON\.parse\(vcenterIdsKey\), region \}\)/g) || []).length).toBe(2);
    expect(app).not.toMatch(/if \(vcenterId\) [fs]\.vcenterId = vcenterId/);
    expect(app).toMatch(/usePolling\(isPlatformTab\(tab\) \? '\/platform\/summary' : null, scope, 30_000\)/);
    for (const v of ['Hosts', 'Vms']) expect(app).toMatch(new RegExp(`<${v} filters=\\{filters\\}`));
  });
  it('리전을 바꾸면 허브는 그 리전 밖 선택만 푼다(idsInRegion) · 범위 바 선택 칸은 ‘법인 N곳 선택’ 고를 수 없는 option', () => {
    expect(app).toMatch(/isPlatformTab\(tab\) \? \{ region: v, vcenterIds: idsInRegion\(vcenterIds, vcenters, v\) \}/);
    expect(app).toMatch(/\{multiPickText\(vcenterIds\) && <option value=\{MULTI_PICK_VALUE\} disabled>\{multiPickText\(vcenterIds\)\}<\/option>\}/);
    expect(app).toMatch(/value=\{multiPickText\(vcenterIds\) \? MULTI_PICK_VALUE : vcenterId\}/);
  });
  it('칩은 토글 · 전체 해제 · VM 표 · 카드의 법인 누름은 목록을 그 한 곳으로(옛 단일 patch → hubScopePatch)', () => {
    expect(app).toMatch(/onToggleVcenter=\{\(id\) => patchFilter\(\{ vcenterIds: toggleScopeId\(vcenterIds, id\) \}\)\}/);
    expect(app).toMatch(/onClearVcenters=\{\(\) => patchFilter\(\{ vcenterIds: \[\] \}\)\}/);
    expect(app).toMatch(/onPickVcenter=\{\(id\) => patchFilter\(\{ vcenterId: id, region: '' \}, 'vms'\)\}/);
    expect(hub).toMatch(/aria-pressed=\{on\}/);
    expect(hub).toMatch(/const on = picked\.includes\(String\(s\.id\)\)/);
    expect(hub).toMatch(/onClick=\{\(\) => onToggleVcenter\(s\.id\)\}/);
    expect(hub).toMatch(/picked\.length > 0 && \(\s*<button type="button" className="qn-btn ph-clear" onClick=\{onClearVcenters\}/);
    expect(hub).not.toMatch(/onPickVcenter/);
  });
  it('카드 · VM 이름 검색 · 상세 이웃이 같은 목록을 쓴다', () => {
    expect(app).toMatch(/scope=\{\{ region, vcenterIds, q \}\}/);
    expect(vc).toMatch(/const inScope = sitesInHubScope\(sites, scope\)/);
    expect(vc).toMatch(/filterChipSites\(byQuery, chipQuery, vcSel\)/);
    expect(vc).toMatch(/siblingsOf\(siblingSites\(sites, scope\), openId\)/);
  });
  it('접어도 ‘✕ 전체 법인’ 은 남고 범례는 줄바꿈된다(400px 가로 넘침 방지)', () => {
    const css = fs.readFileSync(path.resolve(HERE, './platform.css'), 'utf8');
    expect(css).toMatch(/\.ph-chips\.folded \.qn-btn\.ph-clear \{ display: inline-flex; \}/);
    expect(css).toMatch(/\.ph-chips \.ph-legend \{[^}]*white-space: normal;[^}]*min-width: 0;/);
  });
});
