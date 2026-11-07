// platformText.test.js — v2.915 '서버 › 가상화 플랫폼' 허브(설계 docs/design/virt-platform-menu 시안 A)의 순수 보조 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_TABS, PLATFORM_TAB_KEYS, isPlatformTab, VC_TOOLS, HOST_TOOLS, PLATFORM_TOOL_KEYS, entityTabs, chipCount, chipLegend, signalSegments,
  loadLastTab, saveLastTab, loadChipsCollapsed, saveChipsCollapsed, loadVcView, saveVcView, SCOPE_SEARCH_PLACEHOLDER, SCOPE_NOTE,
} from './platformText.js';
import { HUB_TOOL_KEYS } from '../vms/vmHubText.js';
import { TOOLS } from '../specialToolsList.js';
import { MENU_GROUPS } from '../topMenu.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('탭 · 도구 · 메뉴 대조', () => {
  it('허브 탭은 계층 순서(vCenter → 호스트 → VM)이고 App 의 탭 id 그대로 · 메뉴 항목 하나가 셋을 맡는다', () => {
    expect(PLATFORM_TAB_KEYS).toEqual(['vcenters', 'hosts', 'vms']);
    expect(PLATFORM_TABS.map((t) => t.perm)).toEqual(['dashboard', 'inv.hosts', 'inv.vms']);
    expect(isPlatformTab('hosts')).toBe(true); expect(isPlatformTab('datastores')).toBe(false);
    const virt = MENU_GROUPS.find((g) => g.id === 'server').children.find((c) => c.id === 'virt');
    expect([virt.tab, ...virt.tabs]).toEqual(PLATFORM_TAB_KEYS);
    expect(virt.also).toEqual(PLATFORM_TOOL_KEYS);
  });
  it('도구 키는 카탈로그에 실재하고 패널이 있는 도구 · VM 6 은 v2.909 그대로 · 겹치지 않는다', () => {
    expect(PLATFORM_TOOL_KEYS.slice(0, HUB_TOOL_KEYS.length)).toEqual([...HUB_TOOL_KEYS]);
    expect(new Set(PLATFORM_TOOL_KEYS).size).toBe(PLATFORM_TOOL_KEYS.length);
    for (const [k] of [...VC_TOOLS, ...HOST_TOOLS]) {
      const t = TOOLS.find((x) => x.k === k);
      expect(t, k).toBeTruthy();
      expect(!!t.external || !!t.topTab || !!t.comingSoon, k).toBe(false);
    }
  });
  it('공용 범위 바 문구(세 탭 공용) — App 이 글자 그대로 쓴다', () => {
    const app = stripComments(read('../../App.jsx'));
    expect(app).toMatch(/SCOPE_SEARCH_PLACEHOLDER/);
    expect(app).toMatch(/SCOPE_NOTE/);
    expect(SCOPE_SEARCH_PLACEHOLDER).toBe('vCenter · 호스트 · VM 이름 · IP');
    expect(SCOPE_NOTE).toContain('함께 적용');
    // 세 탭이 범위를 한 칸으로 공유한다 · vCenter 탭은 더 이상 필터 바 없는 탭이 아니다
    expect(app).toMatch(/PLATFORM_SCOPE_KEY/);
    expect(app).not.toMatch(/noFilterTabs = \[[^\]]*'vcenters'/);
  });
});

describe('엔티티 탭 글자 — 못 읽은 값은 — · 분해는 그 탭 고유 · 배지는 지금 볼 것', () => {
  const summary = { totals: {
    vcenters: { total: 28, connected: 27, stale: 1, unreachable: 0, rest: 2, site: 6 },
    alarms: { total: 58, critical: 7, warning: 51, unknownVcs: 2 },
    hosts: { total: 658, connected: 640, maint: 11, down: 5, unread: 2, attention: 52, clusters: 61, unknownVcs: 0 },
    vms: { total: 5850, on: 5120, off: 730, usageUnknown: 37, templates: 42, attention: 641, unknownVcs: 1 },
  } };
  it('값 · 배지 · 분해', () => {
    const [vc, h, v] = entityTabs(summary);
    expect([vc.k, vc.value, vc.badge]).toEqual(['vcenters', '28', { text: '낡은 값 1', tone: 'amber' }]);
    expect(vc.parts.map((p) => p.text)).toEqual(['연결 27', '불가 0', 'REST 폴백 2', '엣지 위임 6', '알람 58']);
    expect(vc.parts[4].note).toBe('(미조회 2곳 제외)');
    expect(vc.parts.some((p) => /호스트|VM/.test(p.text))).toBe(false); // 다른 탭의 수는 싣지 않는다(§4.0-2)
    expect([h.value, h.badge.text]).toEqual(['658', '확인 대상 52']);
    expect(h.parts.map((p) => p.text)).toEqual(['연결 640', '점검 11', '끊김 5', '미수집 2', '클러스터 61']);
    expect([v.value, v.badge.text, v.badge.tone]).toEqual(['5,850', '조치 필요 641', 'red']);
    expect(v.parts.map((p) => p.text)).toEqual(['구동 5,120', '정지 730', '사용률 미수집 37', '템플릿 42', '개수 모름 1곳']);
  });
  it('요약이 없거나 첫 수집 중이거나 권한이 없으면 — 이고 배지가 없다(0 을 지어내지 않는다)', () => {
    for (const s of [null, undefined, {}, { initial: true, totals: summary.totals }, { totals: { vcenters: null, hosts: null, vms: null, alarms: null } }]) {
      for (const t of entityTabs(s)) { expect(t.value).toBe('—'); expect(t.badge).toBe(null); expect(t.parts).toEqual([]); }
    }
    const [vc] = entityTabs({ totals: { ...summary.totals, vcenters: { total: 3, connected: 1, stale: 0, unreachable: 2 }, alarms: { total: 0, critical: 0, unknownVcs: 0 } } });
    expect(vc.badge).toEqual({ text: '불가 2', tone: 'red' });
    expect(vc.parts[4].note).toBe('');
  });
  it('칩 숫자 — 탭마다 다른 값 · 모르면 null · REST 폴백 알람은 모름', () => {
    const row = { alarms: { critical: 2, warning: 3, unknown: false }, hosts: { attention: 4 }, vms: { attention: 0 } };
    expect(chipCount(row, 'vcenters')).toMatchObject({ n: 5, tone: 'red' });
    expect(chipCount(row, 'hosts')).toMatchObject({ n: 4, tone: 'amber' });
    expect(chipCount(row, 'vms')).toMatchObject({ n: 0, tone: '' });
    expect(chipCount({ alarms: { unknown: true } }, 'vcenters').n).toBe(null);
    expect(chipCount({ hosts: null }, 'hosts').n).toBe(null);
    expect(chipCount(undefined, 'vms').n).toBe(null);
    expect(chipLegend('hosts')).toContain('확인 대상');
  });
  it('조치 필요 타일 분해 — 서버 signalCounts 키 순서 · 비율 · 없으면 null', () => {
    const seg = signalSegments({ any: 10, overload: 5, usageUnknown: 1, toolsOld: 2, snapOld: 2 });
    expect(seg.map((s) => [s.k, s.n, s.pct])).toEqual([['overload', 5, 50], ['usageUnknown', 1, 10], ['toolsOld', 2, 20], ['snapOld', 2, 20]]);
    expect(signalSegments(null).every((s) => s.n === null && s.pct === 0)).toBe(true);
  });
});

describe('브라우저 기억 — try/catch · 모르는 값은 기본', () => {
  it('마지막 본 탭(허용된 것만) · 바로가기 접힘 · vCenter 보기', () => {
    const st = mem();
    expect(loadLastTab(st)).toBe(null);
    saveLastTab(st, 'hosts'); expect(loadLastTab(st)).toBe('hosts');
    expect(loadLastTab(st, (t) => t !== 'hosts')).toBe(null);
    saveLastTab(st, 'datastores'); expect(loadLastTab(st)).toBe('hosts');
    expect(loadChipsCollapsed(st)).toBe(false); saveChipsCollapsed(st, true); expect(loadChipsCollapsed(st)).toBe(true);
    expect(loadVcView(st)).toBe('cards'); saveVcView(st, 'table'); expect(loadVcView(st)).toBe('table'); saveVcView(st, 'tree'); expect(loadVcView(st)).toBe('table');
    expect(loadLastTab(broken)).toBe(null); expect(() => saveLastTab(broken, 'vms')).not.toThrow();
    expect(loadChipsCollapsed(broken)).toBe(false); expect(loadVcView(broken)).toBe('cards');
    expect(loadLastTab(null)).toBe(null);
  });
});
