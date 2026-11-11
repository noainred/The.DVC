// v2.965 — PowerScale 장비 점검 화면: 글자 보조(psInspectText) · 서버 catalog 와 1:1 · 메뉴 · 도구 등록 · 보기 SSR(빈 · 값) · 소스 스윕(폴링 없음 · 백틱 없음).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import {
  STATUS_KO, GROUP_KO, GROUP_ORDER, VIEWS, numText, pctText, bpsText, metricText, kstText, agoText, sortDevices, stripOf, issuesOf, unknownReasons, diffText, mailList, scheduleText, distLayout,
} from './psInspectText.js';
import { MENU_GROUPS } from '../../topMenu.js';
import { TOOLS } from '../../specialToolsList.js';

vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), postJson: () => new Promise(() => {}), putJson: () => new Promise(() => {}), hasRole: () => true, canCsv: () => true, toolAllowed: () => true };
});

const raw = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRV = '../../../../../server/src/storage/inspect/';

describe('서버와 1:1', () => {
  it('상태 다섯 · 구분 다섯의 낱말이 서버 catalog 와 같다', () => {
    const cat = raw(`${SRV}catalog.js`);
    const st = /export const STATUS_KO = Object\.freeze\((\{[^}]+\})\)/.exec(cat);
    expect(st).toBeTruthy();
    const srv = Object.fromEntries([...st[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(srv).toEqual({ ...STATUS_KO });
    const groups = [...cat.matchAll(/\{ id: '(\w+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
    expect(groups).toEqual(GROUP_ORDER.map((g) => [g, GROUP_KO[g]]));
  });
  it('항목 20개 — 서버 ITEMS 의 group 은 전부 화면 GROUP_ORDER 안', () => {
    const cat = raw(`${SRV}catalog.js`);
    const groups = [...cat.matchAll(/group: '(\w+)'/g)].map((m) => m[1]);
    expect(groups.length).toBeGreaterThanOrEqual(20);
    for (const g of groups) expect(GROUP_ORDER).toContain(g);
  });
});

describe('메뉴 · 도구 등록', () => {
  it('스토리지 메뉴에 ps-inspect · 도구 목록(관리자 전용 표시) · SpecialTools 렌더', () => {
    const storage = MENU_GROUPS.flatMap((g) => g.children || []).filter((c) => c.tool === 'ps-inspect');
    expect(storage.length).toBe(1);
    const t = TOOLS.find((x) => x.k === 'ps-inspect');
    expect(t).toBeTruthy();
    expect(t.adminOnly).toBe(true);
    const st = stripComments(raw('../../SpecialTools.jsx'));
    expect(st).toMatch(/import\('\.\/tools\/PsInspectTool\.jsx'\)/);
    expect(st).toMatch(/tool === 'ps-inspect' && <PsInspectTool \/>/);
  });
  it('서버 도구 권한 매핑 · 카탈로그 배치', () => {
    expect(raw('../../../../../server/src/auth/toolAccess.js')).toMatch(/'ps-inspect': 'ps-inspect'/);
    expect(raw('../../../../../server/src/toolcats/catalog.js')).toMatch(/'ps-inspect'/);
  });
});

describe('글자 보조', () => {
  it('못 읽은 값은 — (0 이 아니다)', () => {
    for (const f of [numText, pctText, bpsText]) { expect(f(null)).toBe('—'); expect(f(undefined)).toBe('—'); expect(f('x')).toBe('—'); }
    expect(numText('')).toBe('—'); expect(pctText('')).toBe('—');
    expect(numText(0)).toBe('0'); expect(pctText(0)).toBe('0%');
    expect(numText(12345)).toBe('12,345');
    expect(bpsText(2.5e9)).toBe('2.5 Gb/s'); expect(bpsText(900)).toBe('900 b/s');
    expect(metricText('net', 1e6)).toBe('1.0 Mb/s'); expect(metricText('busy', 42.26)).toBe('42.3%'); expect(metricText('ops', 1200)).toBe('1,200');
  });
  it('시각은 KST(+9) · 경과', () => {
    const t = Date.UTC(2026, 10, 9, 0, 0); // 09:00 KST
    expect(kstText(t)).toBe('11-09 09:00');
    expect(kstText(t, { withYear: true })).toBe('2026-11-09 09:00');
    expect(kstText(null)).toBe('—'); expect(kstText(0)).toBe('—');
    expect(agoText(t - 30 * 60_000, t)).toBe('30분 전');
    expect(agoText(t - 5 * 3600_000, t)).toBe('5시간 전');
    expect(agoText(t - 3 * 86400_000, t)).toBe('3일 전');
  });
  const items = [
    { id: 'drives', no: 5, group: 'components', status: 'bad', label: '드라이브' },
    { id: 'cluster-health', no: 1, group: 'components', status: 'ok', label: '클러스터 상태' },
    { id: 'capacity', no: 12, group: 'capacity', status: 'warn', label: '용량' },
    { id: 'synciq', no: 20, group: 'protection', status: 'unknown', label: 'SyncIQ', why: '권한 없음(403)' },
  ];
  const devs = [
    { id: 'a', name: 'ps-b', corpName: '한국', summary: { overall: 'ok' }, items: [] },
    { id: 'b', name: 'ps-a', corpName: '독일', summary: { overall: 'bad' }, items },
    { id: 'c', name: 'ps-c', corpName: '미국', summary: { overall: 'unknown' }, items: [{ ...items[3] }] },
  ];
  it('정렬 — 나쁜 순 · 칸 띠는 구분 순서 · 번호 순', () => {
    expect(sortDevices(devs).map((d) => d.id)).toEqual(['b', 'c', 'a']);
    const s = stripOf(items);
    expect(s.map((g) => g.group)).toEqual(GROUP_ORDER);
    expect(s[0].cells.map((c) => c.no)).toEqual([1, 5]);
    expect(s[1].cells).toEqual([]);
  });
  it('이상 · 주의 목록과 확인 불가 사유 묶음', () => {
    const r = issuesOf(devs, 1);
    expect(r.total).toBe(2); expect(r.more).toBe(1); expect(r.list[0].item.status).toBe('bad');
    const u = unknownReasons(devs);
    expect(u).toEqual([{ why: '권한 없음', items: 2, devices: ['ps-a', 'ps-c'], labels: ['SyncIQ'] }]);
  });
  it('지난번 대비 · 메일 목록 · 일정 글자', () => {
    expect(diffText(null).text).toBe('지난 점검 없음');
    expect(diffText({ base: 1, worse: [1, 2], better: [3] })).toEqual({ text: '나빠짐 2 · 풀림 1', tone: 'bad' });
    expect(diffText({ base: 1, worse: [], better: [] }).text).toBe('변화 없음');
    expect(mailList('a@x.kr, b@x.kr\nb@x.kr;c@x.kr ')).toEqual(['a@x.kr', 'b@x.kr', 'c@x.kr']);
    expect(scheduleText(null)).toBe('—');
    expect(scheduleText({ settings: { enabled: false } })).toBe('주간 점검 꺼짐');
    expect(scheduleText({ settings: { enabled: true, weekday: 1, time: '09:00', mailEnabled: true, mailDelayMin: 30 }, nextRunAt: Date.UTC(2026, 10, 16, 0, 0) }))
      .toBe('매주 월요일 09:00 · 다음 11-16 09:00 · 메일 +30분');
  });
  it('분포 좌표 — 값 없는 노드는 그리지 않는다 · 상한에서 자른다', () => {
    const l = distLayout([{ name: 'c1', maxRatio: 2.1, skewed: true, maxLnn: 3, nodes: [{ lnn: 1, ratio: 0.5 }, { lnn: 2, ratio: null }, { lnn: 3, ratio: 9 }] }]);
    expect(l.rows[0].dots.map((d) => d.lnn)).toEqual([1, 3]);
    expect(l.rows[0].dots[1].hot).toBe(true);
    expect(l.rows[0].dots[1].x).toBe(l.ticks.find((t) => t.v === 3).x);
  });
});

describe('보기 SSR — 빈 값 · 값', async () => {
  const { default: InspectOverview } = await import('./InspectOverview.jsx');
  const { default: InspectDevice } = await import('./InspectDevice.jsx');
  const { default: InspectReport } = await import('./InspectReport.jsx');
  const { default: InspectTop } = await import('./InspectTop.jsx');
  const { default: InspectSources } = await import('./InspectSources.jsx');
  const { default: InspectSettings } = await import('./InspectSettings.jsx');
  const { default: PsInspectTool } = await import('../PsInspectTool.jsx');
  const noop = () => {};
  it('빈 응답에도 깨지지 않는다(불러오는 중 · 장비 0)', () => {
    const saved = globalThis.window;
    globalThis.window = { location: { hash: '#/tools/ps-inspect' }, history: { replaceState() {} }, addEventListener() {}, removeEventListener() {} };
    try { expect(renderToStaticMarkup(<PsInspectTool />)).toContain('PowerScale 점검 현황'); } finally { if (saved === undefined) delete globalThis.window; else globalThis.window = saved; }
    expect(renderToStaticMarkup(<InspectOverview data={{ devices: [], totals: {} }} onOpen={noop} />)).toContain('확인 불가');
    expect(renderToStaticMarkup(<InspectDevice devices={[]} id="" onPick={noop} onRun={noop} />)).toBeTruthy();
    expect(renderToStaticMarkup(<InspectReport rep={null} corps={[]} corp="" onCorp={noop} />)).toContain('PDF 저장(인쇄)');
    expect(renderToStaticMarkup(<InspectTop top={null} metric="ops" range="7d" onMetric={noop} onRange={noop} onOpen={noop} />)).toBeTruthy();
    expect(renderToStaticMarkup(<InspectSources cat={null} />)).toBeTruthy();
    expect(renderToStaticMarkup(<InspectSettings schedule={null} corps={[]} isAdmin={false} onSaved={noop} />)).toBeTruthy();
  });
  it('값이 있으면 장비 · 상태 낱말이 그려지고 별표 · 백틱이 새지 않는다', () => {
    const d = { id: 'storage:ps1', name: 'ps-fra-01', corpName: '독일', method: 'ssh', version: '9.5.0.4', nodeCount: 4, capacityPct: 83.2,
      summary: { overall: 'bad', ok: 15, warn: 2, bad: 1, unknown: 2, na: 0 }, run: { at: Date.UTC(2026, 10, 9, 0, 0) }, skew: { ratio: 1.7 },
      items: [{ id: 'drives', no: 5, group: 'components', status: 'bad', label: '드라이브', value: 'SMARTFAIL 1', basis: 'HEALTHY 아닌 드라이브 0', how: 'isi devices drive list', refs: [1] }] };
    const html = renderToStaticMarkup(<InspectOverview data={{ devices: [d], totals: { devices: 1, corps: 1, nodes: 4, total: 20, ok: 15, warn: 2, bad: 1, unknown: 2, na: 0 }, thresholds: { capWarnPct: 80, capBadPct: 90, skewFactor: 1.5 } }} onOpen={noop} />);
    expect(html).toContain('ps-fra-01'); expect(html).toContain('이상'); expect(html).toContain('1.7×');
    const dev = renderToStaticMarkup(<InspectDevice devices={[d]} id={d.id} detail={{ ...d, history: [] }} onPick={noop} onRun={noop} isAdmin />);
    expect(dev).toContain('SMARTFAIL 1');
    for (const h of [html, dev]) { expect(h).not.toMatch(/\*\*/); expect(h).not.toContain('`'); }
  });
});

describe('소스 스윕', () => {
  const files = ['../PsInspectTool.jsx', './InspectOverview.jsx', './InspectDevice.jsx', './InspectReport.jsx', './InspectTop.jsx', './InspectSources.jsx', './InspectSettings.jsx', './InspectParts.jsx'];
  it('폴링 없음(마운트 1회 + 버튼) · 화면 문구에 백틱 없음 · 대문자 변환 없음', () => {
    for (const f of files) {
      const s = stripComments(raw(f));
      expect(s, f).not.toMatch(/setInterval|usePolling/);
      // 템플릿 리터럴(JS)은 허용 — JSX 텍스트 안 백틱만 막는다: '>…`…<' 꼴
      expect(s, f).not.toMatch(/>[^<>{}]*`[^<>{}]*</);
    }
    expect(raw('./psInspect.css')).not.toMatch(/text-transform:\s*uppercase/);
  });
  it('보기 키 다섯 — 셸의 useHashTab valid 가 VIEWS 에서 온다', () => {
    expect(VIEWS.map((v) => v.key)).toEqual(['overview', 'device', 'report', 'top', 'sources']);
    expect(stripComments(raw('../PsInspectTool.jsx'))).toMatch(/VIEW_KEYS = VIEWS\.map/);
  });
});
