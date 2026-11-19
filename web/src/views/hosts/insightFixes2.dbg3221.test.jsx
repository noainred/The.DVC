// dbg3221 — VM · 호스트 분석 화면 결함 회귀(2회차):
//   ① 도구 칸 · 도구 패널도 본체 합과 같은 법인 집합 — 오래됨 · 모름 법인을 빼고, 모두 빠지면 도구 쪽을 그리지 않는다(toolIdsOf)
//   ② Hypervisor 분석 → 목록 · 법인별 전환 첫 렌더(loading=false · data=null)에서 data.summary 를 읽지 않는다
//   ③ 탭 줄 오른쪽 조건(전원 · 메모 · IPMS)은 스크롤되는 탭 줄 밖 — 넘치면 아래 줄(1440 VM 분석에서 IPMS 가 잘렸다)
//   ④ 하드웨어 칸 — iDRAC 수집 대기(pending)를 ‘수집 대기 N대’ 로 밝힌다(장애 0 · 경고 0 만 보여 정상처럼 읽혔다)
//   ⑤ 수 + 단위 — 값이 없으면 ‘—대’ 가 아니라 ‘—’(fmtU) · 고른 법인의 줄이 도구 응답에 없으면 패널은 그 사실만
//   ⑥ ESXi 버전 · 서버 모델 종류 수 — 입력이 없으면 0 이 아니라 모름(null)
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), toolAllowed: () => true, hasRole: () => true };
});

const { pickRows, toolIdsOf, fmtU } = await import('../insight/insightCore.js');
const { sumVmRows } = await import('../vms/vmInsightText.js');
const { offView } = await import('../vms/insight-tools/vmToolPanelsText.js');
const { checkItems, esxiView, modelView, sumHostRows } = await import('./hostInsightText.js');
const { contentionHostView, hostHygieneView } = await import('./insight-tools/hostToolPanelsText.js');
const { emptyViewText } = await import('../vms/insight-tools/toolSumText.js');
const { PanelState } = await import('../vms/insight-tools/ToolParts.jsx');
const { default: HubTabs } = await import('../platform/HubTabs.jsx');

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../..');
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

describe('① 도구 칸 · 패널 = 본체 합과 같은 법인(오래됨 · 모름 제외)', () => {
  const row = (id, o = {}) => ({ id, name: id, stale: false, unknown: false, total: 10, on: 7, off: 3, templates: 0, attention: 0,
    signals: {}, reclaim: { offCount: 3, offDiskGB: 30 }, ...o });
  const waste = { rows: [{ vcenterId: 'A', vms: 17, poweredOff: 7, poweredOffGB: 700 }, { vcenterId: 'B', vms: 13, poweredOff: 3, poweredOffGB: 30 }] };

  it('오래됨 법인 A 가 있으면 도구 칸도 B 만 — 정지 VM(본체) 3 = 꺼진 VM(도구 칸) 3(예전: 10대 / 730 GB)', () => {
    const rows = [row('A', { stale: true, off: 7, reclaim: { offCount: 7, offDiskGB: 700 } }), row('B')];
    const picked = pickRows(rows, []);
    const ids = toolIdsOf({ ids: [], region: '', rows, picked });
    expect(ids).toEqual(['B']);
    const s = sumVmRows(picked.used);
    const v = offView(waste, null, ids);
    expect(v.count).toBe(s.reclaim.offCount);
    expect(v.count).toBe(3);
    expect(v.diskGB).toBe(30);
  });
  it('고른 법인 중 오래됨 · 모름은 빼고 나머지만', () => {
    const rows = [row('A', { stale: true }), row('B'), row('C', { unknown: true }), row('D')];
    expect(toolIdsOf({ ids: ['A', 'B', 'C'], region: '', rows, picked: pickRows(rows, ['A', 'B', 'C']) })).toEqual(['B']);
  });
  it('모두 오래됨 · 모름이면 null(도구 쪽 [] 는 ‘전부’ 라 쓰면 안 된다)', () => {
    const rows = [row('A', { stale: true }), row('B', { unknown: true })];
    expect(toolIdsOf({ ids: [], region: '', rows, picked: pickRows(rows, []) })).toBeNull();
  });
  it('오래됨 · 모름이 없으면 이전 규칙 그대로 — ids · 리전이면 응답 줄 · 둘 다 없으면 []', () => {
    const rows = [row('A'), row('B')];
    expect(toolIdsOf({ ids: [], region: '', rows, picked: pickRows(rows, []) })).toEqual([]);
    expect(toolIdsOf({ ids: [], region: 'EU', rows, picked: pickRows(rows, []) })).toEqual(['A', 'B']);
    expect(toolIdsOf({ ids: ['B'], region: 'EU', rows, picked: pickRows(rows, ['B']) })).toEqual(['B']);
    expect(toolIdsOf({ ids: ['B'], region: '', rows: [], picked: pickRows([], ['B']) })).toEqual(['B']);   // 응답 전
  });
  it('소스: VmInsight · HostInsight 는 toolIdsOf 로 정하고, 패널 · 도구 칸에 toolCan 을 넘긴다', () => {
    for (const f of ['views/vms/VmInsight.jsx', 'views/hosts/HostInsight.jsx']) {
      const src = read(f);
      expect(src).toMatch(/const toolIdsRaw = toolIdsOf\(\{ ids, region, rows, picked, loaded: !!data \}\)/);
      expect(src).not.toMatch(/const toolIds = ids\.length \|\|/);
      expect(src).not.toMatch(/ToolPanels vcIds=\{toolIds\}[^>]*canTool=\{canTool\}/);
      expect(src).toMatch(/ToolPanels vcIds=\{toolIds\}[^>]*canTool=\{toolCan\}/);
    }
    expect(read('views/vms/VmInsight.jsx')).toMatch(/checkItems\(\{ vcIds: toolIds, canTool: insightOn \? toolCan/);
    expect(read('views/hosts/HostInsight.jsx')).toMatch(/groupShownOf\(toolCan\)/);
  });
});

describe('② Hypervisor 분석 → 목록 · 법인별 전환 첫 렌더', () => {
  it('data 가 없으면 loading 과 무관하게 불러오는 중 — data.summary 보다 먼저', () => {
    const src = read('views/Hosts.jsx');
    const guard = src.indexOf('if (!data) return <Loading />;');
    const use = src.indexOf('data.summary');
    expect(guard).toBeGreaterThan(0);
    expect(use).toBeGreaterThan(guard);
    expect(src).not.toMatch(/if \(loading && !data\) return <Loading \/>;/);
  });
});

describe('③ 탭 줄 오른쪽 조건은 스크롤되는 탭 줄 밖', () => {
  const views = [{ k: 'insight', label: '분석' }, { k: 'list', label: '목록' }];
  it('right 가 있으면 .vmh-tabbar 안에 탭 줄과 형제 · role=tablist 안에 조건이 없다', () => {
    const html = renderToStaticMarkup(React.createElement(HubTabs, { label: 'x', views, active: 'insight', right: React.createElement('label', null, 'IPMS') }));
    expect(html.startsWith('<div class="vmh-tabbar">')).toBe(true);
    const list = html.match(/<div[^>]*role="tablist"[^>]*>([\s\S]*?)<\/div>/);
    expect(list).toBeTruthy();
    expect(list[1]).not.toMatch(/ph-right|IPMS/);
    expect(html).toMatch(/<span class="ph-right"><label>IPMS<\/label><\/span><\/div>$/);
  });
  it('right 가 없으면 예전 모양(탭 줄 하나)', () => {
    const html = renderToStaticMarkup(React.createElement(HubTabs, { label: 'x', views, active: 'insight' }));
    expect(html).toMatch(/^<div role="tablist"[^>]*class="vmh-tabs tabstrip-noscroll"/);
    expect(html).not.toMatch(/vmh-tabbar|ph-right/);
  });
  it('CSS — 묶음은 줄바꿈(flex-wrap) · 탭 줄은 남는 폭을 채우고 폭을 넘지 않는다', () => {
    const css = fs.readFileSync(path.join(SRC, 'views/vms/vmHub.css'), 'utf8');
    expect(css).toMatch(/\.vmh-tabbar \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.vmh-tabbar > \.vmh-tabs \{[^}]*flex: 1 1 auto;[^}]*max-width: 100%;/);
    expect(css).toMatch(/\.vmh-tabbar > \.ph-right \{[^}]*min-width: 0;[^}]*flex-wrap: wrap;/);
  });
});

describe('④ 하드웨어 칸 — 수집 대기', () => {
  const hwOf = (hw) => checkItems({ hosts: {}, hw }, { hw: true }, {}).find((x) => x.key === 'hw');
  it('pending 만 있으면 ‘수집 대기 5대’ 를 밝힌다(예전: 장애 0 · 경고 0)', () => {
    const it0 = hwOf({ ok: 0, warn: 0, fault: 0, unknown: 0, none: 0, pending: 5, error: 0 });
    expect(it0.sub).toContain('수집 대기 5대');
    expect(it0.value).toBe(0);
  });
  it('모름(unknown + error)과 수집 대기는 따로', () => {
    const it1 = hwOf({ ok: 3, warn: 1, fault: 0, unknown: 1, none: 0, pending: 2, error: 1 });
    expect(it1.sub).toBe('장애 0 · 경고 1 · 모름 2대 · 수집 대기 2대');
  });
  it('pending 0 이면 꼬리 없음', () => {
    expect(hwOf({ ok: 3, warn: 0, fault: 0, unknown: 0, none: 0, pending: 0, error: 0 }).sub).toBe('장애 0 · 경고 0');
  });
});

describe('⑤ 수 + 단위 — 값이 없으면 단위 없는 ‘—’', () => {
  it('fmtU', () => {
    expect(fmtU(null, '대')).toBe('—');
    expect(fmtU(undefined, '개')).toBe('—');
    expect(fmtU('', '대')).toBe('—');
    expect(fmtU(0, '대')).toBe('0대');
    expect(fmtU(1234, '대')).toBe('1,234대');
  });
  it('고른 법인이 도구 응답에 없으면 view.empty → 패널은 그 사실만(수 칸을 그리지 않는다)', () => {
    const resp = { rows: [{ vcenterId: 'a', hostsMeasured: 3 }] };
    const v = contentionHostView(resp, ['b']);
    expect(v.empty).toBe(true);
    expect(v.missing).toEqual(['b']);
    expect(emptyViewText(v)).toBe('고른 법인은 이 도구에 값이 없습니다.');
    const hv = hostHygieneView(resp, ['b']);
    expect(emptyViewText(hv)).not.toBe('');
    const html = renderToStaticMarkup(React.createElement(PanelState, { q: { data: resp }, view: v }, React.createElement('b', null, 'NUMBERS')));
    expect(html).toContain('고른 법인은 이 도구에 값이 없습니다.');
    expect(html).not.toContain('NUMBERS');
    const ok = renderToStaticMarkup(React.createElement(PanelState, { q: { data: resp }, view: contentionHostView(resp, ['a']) }, React.createElement('b', null, 'NUMBERS')));
    expect(ok).toContain('NUMBERS');
  });
  it('응답이 비면(고른 법인 없음) ‘이 범위에는 …’ · 비지 않으면 빈 글', () => {
    expect(emptyViewText({ empty: true, missing: [] })).toBe('이 범위에는 이 도구의 값이 없습니다.');
    expect(emptyViewText({ empty: false, missing: [] })).toBe('');
    expect(emptyViewText(null)).toBe('');
  });
  it('소스 스윕 — 분석 화면 파일에 ‘fmtN(…)}단위’ 꼴이 없다(BUG-20 의 ‘?? ‘—’}단위’ 스윕이 놓친 꼴)', () => {
    const files = ['views/hosts/HostInsight.jsx', 'views/hosts/hostInsightText.js', 'views/hosts/insight-tools/HostToolPanels.jsx', 'views/hosts/insight-tools/hostToolPanelsText.js',
      'views/insight/InsightParts.jsx', 'views/insight/insightCore.js', 'views/vms/VmInsight.jsx', 'views/vms/vmInsightText.js',
      'views/vms/insight-tools/VmOverView.jsx', 'views/vms/insight-tools/VmToolPanels.jsx', 'views/vms/insight-tools/vmToolPanelsText.js',
      'views/vms/insight-tools/vmToolChecks.js', 'views/vms/insight-tools/vmOverText.js', 'views/vms/insight-tools/toolSumText.js', 'views/vms/insight-tools/ToolParts.jsx'];
    const bad = [];
    for (const f of files) {
      read(f).split('\n').forEach((l, i) => { if (/fmtN\((?:[^()]|\([^()]*\))*\)\}\s*(?:대|개|곳|건|종|일|칸|점)/.test(l)) bad.push(`${f}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });
  it('모두 오래됨 · 모름(sumHostRows([])) — 분포 아래 글 · 클러스터 머리에 ‘—대’ · ‘—개’ 가 없다', () => {
    const s = sumHostRows([]);
    const t = `CPU ${fmtU(s.over90?.cpu, '대')} · 메모리 ${fmtU(s.over90?.mem, '대')} · 클러스터 ${fmtU(s.clusters?.total, '개')}`;
    expect(t).toBe('CPU — · 메모리 — · 클러스터 —');
  });
});

describe('⑥ ESXi 버전 · 서버 모델 종류 수', () => {
  it('입력이 없으면 null(예전: 0개 버전 · 0종)', () => {
    const s = sumHostRows([]);
    expect(esxiView(s.esxi).kinds).toBeNull();
    expect(modelView(s.model, s.vendor, 8).kinds).toBeNull();
    expect(fmtU(esxiView(s.esxi).kinds, '개')).toBe('—');
  });
  it('읽었으면 수 그대로(0 은 ‘읽었는데 없음’)', () => {
    expect(esxiView({ versions: { '8.0.2': 3, '7.0.3': 1 }, rest: 0, unread: 0 }).kinds).toBe(2);
    expect(esxiView({ versions: {}, rest: 0, unread: 4 }).kinds).toBe(0);
    expect(modelView({ models: { R750: 2 }, rest: 0, unread: 0 }, null, 8).kinds).toBe(1);
  });
});
