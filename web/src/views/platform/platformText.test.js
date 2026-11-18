// platformText.test.js — v2.915 '서버 › 가상화 플랫폼' 허브(설계 docs/design/virt-platform-menu 시안 A)의 순수 보조 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_TABS, PLATFORM_TAB_KEYS, scopeVcOptions, scopeVcPatch, scopeRegionOptions, regionText, isPlatformTab, scopeLabel, KPI_HANDOFF, handoffKpiVcenter, takeKpiVcenter, keywordsOf, vcMatches, filterChipSites, siblingSites, siblingScopeText, chipSites, chipRegionNote, regionsOf, vcInRegion, VC_TOOLS, HOST_TOOLS, PLATFORM_TOOL_KEYS, entityTabs, chipCount, chipLegend, signalSegments,
  VM_ITEM_TOOL_KEYS, HV_ITEM_TOOL_KEYS, platformMenuLabel,
  loadChipsCollapsed, saveChipsCollapsed, SCOPE_SEARCH_PLACEHOLDER, SCOPE_NOTE,
} from './platformText.js';
import * as PT from './platformText.js';
import { REGIONS } from '../../regions.js';   // v3.13.6 테스트 — 지역 목록 단일 소스
import { HUB_TOOL_KEYS } from '../vms/vmHubText.js';
import { TOOLS } from '../specialToolsList.js';
import { MENU_GROUPS, locate } from '../topMenu.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('탭 · 도구 · 메뉴 대조', () => {
  it('허브 탭 순서는 vCenter · Virtual Machine · Hypervisor(v3.19.0 — 사이드바와 같은 순서)이고 App 의 탭 id 그대로 · v2.994 메뉴 항목 둘이 나눠 맡는다', () => {
    expect(PLATFORM_TAB_KEYS).toEqual(['vcenters', 'vms', 'hosts']);
    expect(PLATFORM_TABS.map((t) => t.perm)).toEqual(['dashboard', 'inv.vms', 'inv.hosts']);
    expect(isPlatformTab('hosts')).toBe(true); expect(isPlatformTab('datastores')).toBe(false);
    const srv = MENU_GROUPS.find((g) => g.id === 'server').children;
    const virt = srv.find((c) => c.id === 'virt'); const hv = srv.find((c) => c.id === 'hv');
    // v2.994: Virtual Machine(VM) = vms(처음) + vcenters · Hypervisor = hosts — 두 항목의 탭을 합치면 허브 탭 셋 그대로(빠짐 · 겹침 없음)
    // v3.19.0: 이름 'Virtual Machine' · 처음 탭 vcenters(vCenter 카드 화면) + vms
    expect([virt.tab, ...virt.tabs]).toEqual(['vcenters', 'vms']);
    expect([hv.tab, ...(hv.tabs || [])]).toEqual(['hosts']);
    expect([virt.tab, ...virt.tabs, hv.tab].sort()).toEqual([...PLATFORM_TAB_KEYS].sort());
    // 도구도 두 항목으로 갈린다 — VM 6 + vCenter 6 → virt · 호스트 4 → hv · 합치면 16 그대로
    expect(virt.also).toEqual([...VM_ITEM_TOOL_KEYS]);
    expect(hv.also).toEqual([...HV_ITEM_TOOL_KEYS]);
    expect(HV_ITEM_TOOL_KEYS).toEqual(HOST_TOOLS.map(([k]) => k));
    expect([...virt.also, ...hv.also]).toEqual([...PLATFORM_TOOL_KEYS]);
    for (const k of HV_ITEM_TOOL_KEYS) expect(locate('tools', `#/tools/${k}`), k).toEqual({ group: 'server', child: 'hv' });
    for (const k of VM_ITEM_TOOL_KEYS) expect(locate('tools', `#/tools/${k}`), k).toEqual({ group: 'server', child: 'virt' });
  });
  it('v2.994 허브 제목 = 그 탭에서 켜지는 사이드바 항목 이름(MENU_GROUPS 라벨에서 읽는다 — 이름을 따로 적지 않는다)', () => {
    const srv = MENU_GROUPS.find((g) => g.id === 'server').children;
    const label = (id) => srv.find((c) => c.id === id).label;
    expect(platformMenuLabel('hosts')).toBe(label('hv'));
    expect(platformMenuLabel('vms')).toBe(label('virt'));
    expect(platformMenuLabel('vcenters')).toBe(label('virt'));
    expect([platformMenuLabel('hosts'), platformMenuLabel('vms')]).toEqual(['Hypervisor', 'Virtual Machine']);   // v3.19.0 메뉴 이름
    for (const t of PLATFORM_TAB_KEYS) {
      const at = locate(t, `#/${t}`);
      expect(platformMenuLabel(t), t).toBe(srv.find((c) => c.id === at.child).label);
    }
    expect(platformMenuLabel('datastores')).toBe('');
    expect(platformMenuLabel('')).toBe('');
    // 옛 상수 · 기억은 없다
    expect(PT.PLATFORM_MENU_LABEL).toBe(undefined);
    expect(PT.loadLastTab).toBe(undefined); expect(PT.saveLastTab).toBe(undefined); expect(PT.LS_TAB).toBe(undefined);
    // 허브 화면 · 경로 뿌리가 이 함수를 쓴다(글자를 박지 않는다) · '마지막으로 본 탭을 기억합니다' 문구는 없다
    const hub = stripComments(read('./PlatformHub.jsx'));
    expect(hub).toMatch(/platformMenuLabel\(tab\)/);
    expect(hub).toMatch(/<h1>\{title\}<\/h1>/);
    expect(hub).toMatch(/aria-label=\{title\}/);
    expect(hub).not.toMatch(/마지막으로 본 탭|가상화 플랫폼/);
    for (const f of ['../vcd/ObjectShell.jsx', '../VCenterDetail.jsx']) {
      const src = stripComments(read(f));
      expect(src, f).toMatch(/platformMenuLabel\('vcenters'\)/);
      expect(src, f).not.toMatch(/가상화 플랫폼/);
    }
  });
  it('v2.994 탭 줄 이름 — Hypervisor · ESXi 호스트 / Virtual Machine · VM(옛 이름은 작은 글자) · 엔티티 탭도 같은 이름', () => {
    expect(PLATFORM_TABS.map((t) => [t.k, t.label, t.sub])).toEqual([['vcenters', 'vCenter', '법인'], ['vms', 'Virtual Machine', 'VM'], ['hosts', 'Hypervisor', 'ESXi 호스트']]);
    expect(entityTabs(null).map((t) => [t.k, t.label, t.sub])).toEqual(PLATFORM_TABS.map((t) => [t.k, t.label, t.sub]));
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
    const [vc, v, h] = entityTabs(summary);   // v3.19.0 순서 — vCenter · VM · 호스트
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
  it('바로가기 접힘(v2.994: 마지막 본 탭 기억은 없앴다 · v3.19.0: vCenter 보기 카드 | 표 기억도 없앴다)', () => {
    const st = mem();
    expect(loadChipsCollapsed(st)).toBe(false); saveChipsCollapsed(st, true); expect(loadChipsCollapsed(st)).toBe(true);
    expect(loadChipsCollapsed(broken)).toBe(false);
    expect(PT.loadVcView).toBe(undefined); expect(PT.saveVcView).toBe(undefined); expect(PT.VC_VIEWS).toBe(undefined); expect(PT.LS_VC_VIEW).toBe(undefined);
  });
});

// v2.958(사용자 요청 2026-11-10) — vCenter 탭 KPI 줄은 허브 범위(리전 · vCenter) 안의 법인만 합한다.
describe('KPI 범위 문구(v2.958 — v3.19.0 부터 VM 이름 검색 제목이 쓴다)', () => {
  const sites = [{ id: 'vc-a', name: 'OC2Sandbox', location: { region: '아시아' } }, { id: 'vc-b', name: 'AZ', location: { region: '아시아' } }];
  it('scopeLabel — 전체 / vCenter 이름(없으면 id) / 리전 · N법인', () => {
    expect(scopeLabel({}, sites)).toBe('전체');
    expect(scopeLabel({ vcenterId: 'vc-a' }, sites)).toBe('OC2Sandbox');
    expect(scopeLabel({ vcenterId: 'vc-x' }, sites)).toBe('vc-x');
    expect(scopeLabel({ region: '아시아' }, sites)).toBe('리전 아시아 · 2법인');
    expect(scopeLabel(null, null)).toBe('전체');
  });
  it('bareosSumOf · handoffKpiScope 는 KPI 줄과 함께 지웠다(v3.19.0)', () => { expect(PT.bareosSumOf).toBe(undefined); expect(PT.handoffKpiScope).toBe(undefined); });
});

// v2.959(사용자 요청 2026-11-10) — KPI 카드 → 도구 화면에 고른 vCenter 인계(메모리 · 꺼내면 지운다).
describe('KPI 카드 → 도구 인계(v2.959)', () => {
  it('target 은 도구마다 하나 · 넘긴 id 를 그 target 에서만 한 번 꺼낸다 · 빈 id 는 넘기지 않는다', () => {
    expect(KPI_HANDOFF).toEqual({ vmTrack: 'vm-track:vcenter', storageTrack: 'storage-track:vcenter', vmTrackRegion: 'vm-track:region', storageTrackRegion: 'storage-track:region', backupSummaryRegion: 'backup-summary:region' });   // v3.10.17 +backupSummaryRegion
    expect(handoffKpiVcenter(KPI_HANDOFF.vmTrack, 'vc-a')).toBe(true);
    expect(takeKpiVcenter(KPI_HANDOFF.storageTrack)).toBe('');
    expect(takeKpiVcenter(KPI_HANDOFF.vmTrack)).toBe('vc-a');
    expect(takeKpiVcenter(KPI_HANDOFF.vmTrack)).toBe('');
    expect(handoffKpiVcenter(KPI_HANDOFF.storageTrack, '')).toBe(false);
    expect(handoffKpiVcenter(KPI_HANDOFF.storageTrack, null)).toBe(false);
    expect(takeKpiVcenter(KPI_HANDOFF.storageTrack)).toBe('');
  });
  it('받는 도구 두 곳이 마운트 초기값으로 꺼낸다(소스 계약) · ⌘K SCREEN 표의 target 과 겹치지 않는다', async () => {
    const fs = await import('node:fs');
    for (const f of ['../tools/VmTrackTool.jsx', '../tools/StorageTrackTool.jsx']) {
      const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(s).toMatch(/useState\(\(\) => takeKpiVcenter\(KPI_HANDOFF\.(vmTrack|storageTrack)\)\)/);
    }
    const q = fs.readFileSync(new URL('../../components/invSearchQuery.js', import.meta.url), 'utf8');
    expect(q).not.toMatch(/vm-track:vcenter|storage-track:vcenter/);
  });
});

// v3.10.13(점검 1회차) — 상세의 ‹ 이전 · 다음 › 이웃 목록 = 허브 범위(리전 · 검색어) 안 · 고른 법인 하나는 범위로 치지 않는다 · 검색 규칙은 카드 목록과 한 벌.
describe('이웃 목록 · 검색 규칙(v3.10.13)', () => {
  const sites = [
    { id: 'vc-a', name: 'VC-KR1', version: '8.0.2', location: { city: 'Seoul', country: 'Korea', region: '아시아' } },
    { id: 'vc-b', name: 'VC-KR2', version: '7.0.3', location: { city: 'Busan', country: 'Korea', region: '아시아' } },
    { id: 'vc-c', name: 'VC-DE1', version: '8.0.3', location: { city: 'Frankfurt', country: 'Germany', region: '유럽' } },
    null, 'x',
  ];
  it('keywordsOf · vcMatches — 공백 구분 AND · 이름 id 도시 국가 리전 버전 · 대소문자 무시 · 쓰레기 행 false', () => {
    expect(keywordsOf('  Kr1  seoul ')).toEqual(['kr1', 'seoul']);
    expect(vcMatches(sites[0], keywordsOf('kr1 seoul'))).toBe(true);
    expect(vcMatches(sites[0], keywordsOf('kr1 busan'))).toBe(false);
    expect(vcMatches(sites[2], keywordsOf('8.0.3'))).toBe(true);
    expect(vcMatches(sites[1], keywordsOf('유럽'))).toBe(false);
    expect(vcMatches(sites[1], [])).toBe(true);
    expect(vcMatches(null, [])).toBe(false);
  });
  it('siblingSites — 리전 · 검색어로만 거른다(vcenterId 는 무시) · 범위 없으면 전부', () => {
    expect(siblingSites(sites, {}).map((s) => s.id)).toEqual(['vc-a', 'vc-b', 'vc-c']);
    expect(siblingSites(sites, { region: '아시아', vcenterId: 'vc-a' }).map((s) => s.id)).toEqual(['vc-a', 'vc-b']);
    expect(siblingSites(sites, { q: 'de1' }).map((s) => s.id)).toEqual(['vc-c']);
    expect(siblingSites(sites, { region: '유럽', q: 'kr' })).toEqual([]);
    expect(siblingSites(null, { region: '유럽' })).toEqual([]);
  });
  it('siblingScopeText — 리전 · 검색어가 있을 때만', () => {
    expect(siblingScopeText({})).toBe('');
    expect(siblingScopeText({ vcenterId: 'vc-a' })).toBe('');
    expect(siblingScopeText({ region: '유럽' })).toBe('리전 유럽');
    expect(siblingScopeText({ region: '유럽', q: ' kr1 ' })).toBe('리전 유럽 · ‘kr1’');
  });
});

// v3.10.14(점검 2회차) — 바로가기 칩은 고른 리전 안의 법인만 · 칩을 눌러도 리전은 남는다(App 소스 계약).
describe('바로가기 칩 범위(v3.10.14)', () => {
  const vcs = [{ id: 'a', location: { region: '아시아' } }, { id: 'b', location: { region: '유럽' } }, { id: 'c' }, null];
  it('chipSites — 리전 없으면 전부(쓰레기 행 제외) · 리전이면 그 리전만 · 맞는 법인이 없으면 빈 목록', () => {
    expect(chipSites(vcs, '').map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(chipSites(vcs, '유럽').map((s) => s.id)).toEqual(['b']);
    expect(chipSites(vcs, '중동')).toEqual([]);
    expect(chipSites(null, '유럽')).toEqual([]);
  });
  it('chipRegionNote — 리전이 있을 때만 · 법인 수', () => {
    expect(chipRegionNote('', 3)).toBe('');
    expect(chipRegionNote('유럽', 5)).toBe('리전 유럽 · 5법인');
    expect(chipRegionNote('유럽', NaN)).toBe('리전 유럽 · 0법인');
  });
  it('App 은 칩에 region 을 넘기고 칩을 눌러도 region 을 지우지 않는다(소스 계약 — v3.20.0: 칩은 목록을 켜고 끈다 · region 은 patch 에 없다)', async () => {
    const fs = await import('node:fs');
    const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    expect(app).toMatch(/<PlatformHub[\s\S]*?region=\{region\}[\s\S]*?onToggleVcenter=\{\(id\) => patchFilter\(\{ vcenterIds: toggleScopeId\(vcenterIds, id\) \}\)\}/);
    const hub = fs.readFileSync(new URL('./PlatformHub.jsx', import.meta.url), 'utf8');
    expect(hub).toMatch(/const regionSites = chipSites\(vcenters, region\)/);
  });
});

// v3.10.15(점검 3회차) — KPI 카드가 리전도 넘긴다 · 도구의 리전 보조.
describe('도구의 리전 보조 · 받는 쪽(v3.10.15 — v3.19.0: 보내는 KPI 카드는 걷어냈다)', () => {
    it('regionsOf · vcInRegion — 빈 리전 제외 · 이름순 · 리전 없으면 전부', () => {
    const list = [{ id: 'a', region: '유럽' }, { id: 'b', region: '아시아' }, { id: 'c', region: '' }, { id: 'd', region: '유럽' }, null];
    expect(regionsOf(list)).toEqual(['아시아', '유럽']);
    expect(vcInRegion(list, '유럽').map((v) => v.id)).toEqual(['a', 'd']);
    expect(vcInRegion(list, '').map((v) => v.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(vcInRegion(null, '유럽')).toEqual([]);
  });
  it('도구 두 곳이 region 을 요청에 싣고(vcenterId 없을 때만) 서버 목록이 region 을 준다(소스 계약)', async () => {
    const fs = await import('node:fs');
    for (const f of ['../tools/VmTrackTool.jsx', '../tools/StorageTrackTool.jsx']) {
      const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(s).toMatch(/\.\.\.\(region && !vcenterId \? \{ region \} : \{\}\)/);
      expect(s).toMatch(/useState\(\(\) => takeKpiVcenter\(KPI_HANDOFF\.(vmTrackRegion|storageTrackRegion)\)\)/);
    }
    const srv = fs.readFileSync(new URL('../../../../server/src/routes/api/vmtrack.js', import.meta.url), 'utf8');
    expect(srv).toMatch(/region: String\(vc\.location\?\.region \|\| ''\)/);
    // 하위 구획(DS 목록 · 상위 · 변경 이력 · 피벗)과 상세 모달도 리전을 싣는다 — 제목이 '리전 X 합계' 인데 본문이 전 법인이면 안 된다
    const st = fs.readFileSync(new URL('../tools/StorageTrackTool.jsx', import.meta.url), 'utf8');
    expect((st.match(/\.\.\.\(region && !vcenterId \? \{ region \} : \{\}\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(st).toMatch(/<DsDetail \{\.\.\.detail\} region=\{vcenterId \? '' : region\}/);
    const vt = fs.readFileSync(new URL('../tools/VmTrackTool.jsx', import.meta.url), 'utf8');
    expect((vt.match(/region=\{vcenterId \? '' : region\}/g) || []).length).toBe(2);
    expect((vt.match(/\.\.\.\(region \? \{ region \} : \{\}\)/g) || []).length).toBe(2);
  });
});

describe('v3.10.17 — 점검 5회차: 리전만 고른 채 백업 KPI 카드 → Backup 현황 · Summary 가 그 리전만 센다', () => {
  it('KPI_HANDOFF 에 backupSummaryRegion 이 있다(받는 쪽 BackupSummaryTool 이 쓴다)', () => {
    expect(KPI_HANDOFF.backupSummaryRegion).toBe('backup-summary:region');
  });
  it('소스 계약 — Summary 가 받아 다섯 요청에 싣는다 · 하위 구획 셋이 region 을 받는다', () => {
    const t = fs.readFileSync(new URL('../tools/BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(t).toMatch(/takeKpiVcenter\(KPI_HANDOFF\.backupSummaryRegion\)/);
    expect((t.match(/\.\.\.\(region \? \{ region \} : \{\}\)/g) || []).length).toBe(2);   // 조회 · CSV
    expect(t).toMatch(/const scope = \{ power: opts\.power, excl: opts\.excl, region \}/);   // 찾기(stale)
    expect(t).toMatch(/<BackupSummaryCapSched [^\n]*region=\{region\}/); expect(t).toMatch(/<BackupSummaryErrors [^\n]*region=\{region\}/);
    expect(t).toMatch(/data-backup-region=""/);
    const st = fs.readFileSync(new URL('../tools/backupSummaryText.js', import.meta.url), 'utf8');
    expect(st).toMatch(/\.\.\.\(scope\.region \? \{ region: String\(scope\.region\) \} : \{\}\)/);
    for (const f of ['../tools/BackupSummaryCapSched.jsx', '../tools/BackupSummaryErrors.jsx']) expect(fs.readFileSync(new URL(f, import.meta.url), 'utf8')).toMatch(/region = ''/);
    expect(fs.readFileSync(new URL('../tools/BackupSummaryStale.jsx', import.meta.url), 'utf8')).toMatch(/scopeSig = `[^`]*scope\?\.region/);
  });
});

describe('v3.19.0 — 허브 머리의 설명 문구(‘서비스 = vCenter 1 + Bareos 1 …’)를 지웠다(사용자 지시 2026-11-18)', () => {
  it('세 탭이 같이 쓰는 머리에서 사라지고 .ph-sub 스타일도 없다 · 옛 가정 문구(법인 = vCenter = Bareos)도 없다(소스 계약)', () => {
    const s = fs.readFileSync(new URL('./PlatformHub.jsx', import.meta.url), 'utf8');
    expect(s).not.toMatch(/법인 = vCenter = Bareos/);
    expect(s).not.toMatch(/서비스 = vCenter 1 \+ Bareos 1/);
    expect(s).not.toMatch(/ph-sub/);
    expect(fs.readFileSync(new URL('./platform.css', import.meta.url), 'utf8')).not.toMatch(/\.ph-sub/);
    expect(s).not.toMatch(/Virtual Machine\(VM\)/);   // 기본 제목도 ‘Virtual Machine’
  });
});

describe('v3.10.21 — 점검 9회차: Summary 리전 보기에서 나눌 수 없는 EM 값은 전 법인 기준임을 밝힌다(소스 계약)', () => {
  it('Veeam 카드 — data.emFleetWide 면 안내 · 에러 로그 — emSkippedForRegion 문구', () => {
    const t = fs.readFileSync(new URL('../tools/BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(t).toMatch(/\{data\.emFleetWide && <span className="muted"[^\n]*data-em-fleet=""/);
    expect(t).toMatch(/EM · 저장소 · 라이선스는 전 법인 기준/);
    const e = fs.readFileSync(new URL('../tools/BackupSummaryErrors.jsx', import.meta.url), 'utf8');
    expect(e).toMatch(/data\.emSkippedForRegion \? '리전 보기에서는 뺐습니다/);
    expect(t).toMatch(/<BackupSummaryCapSched [^\n]*emFleetWide=\{!!data\.emFleetWide\}/);
    const c = fs.readFileSync(new URL('../tools/BackupSummaryCapSched.jsx', import.meta.url), 'utf8');
    expect(c).toMatch(/30일 추이\(EM\{emFleetWide \? ' · 전 법인 기준' : ''\}\)/);
  });
});

describe('v3.13.0 — 2차 루프 1회차: 공용 범위 바의 vCenter 선택지는 고른 리전 안만 · 리전 밖 vCenter 를 고르면 리전을 비운다', () => {
  const VCS = [{ id: 'a', name: 'A', location: { region: '유럽' } }, { id: 'b', name: 'B', location: { region: '북미' } }, { id: 'c', name: 'C', location: { region: '유럽' } }, { id: 'd', name: 'D' }];
  it('scopeVcOptions — 리전이 없으면 전부 · 있으면 그 리전만 · 지금 고른 리전 밖 vCenter 는 맨 앞에 outside', () => {
    expect(scopeVcOptions(VCS, '').map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(scopeVcOptions(VCS, '유럽').map((o) => o.id)).toEqual(['a', 'c']);
    expect(scopeVcOptions(VCS, '유럽', 'b')).toEqual([{ id: 'b', name: 'B', outside: true }, { id: 'a', name: 'A', outside: false }, { id: 'c', name: 'C', outside: false }]);
    expect(scopeVcOptions(VCS, '유럽', 'a').map((o) => o.id)).toEqual(['a', 'c']);
    expect(scopeVcOptions(VCS, '', 'zz')[0]).toEqual({ id: 'zz', name: 'zz', outside: false });   // 목록에 없는 id(지워진 vCenter) — 이름 대신 id
    expect(scopeVcOptions(null, '유럽')).toEqual([]);
  });
  it('scopeVcPatch — 리전 안이면 vCenter 만 · 리전 밖이면 리전을 비운다 · 리전이 없거나 모르는 id 면 vCenter 만', () => {
    expect(scopeVcPatch(VCS, '유럽', 'a')).toEqual({ vcenterId: 'a' });
    expect(scopeVcPatch(VCS, '유럽', 'b')).toEqual({ vcenterId: 'b', region: '' });
    expect(scopeVcPatch(VCS, '유럽', 'd')).toEqual({ vcenterId: 'd', region: '' });
    expect(scopeVcPatch(VCS, '', 'b')).toEqual({ vcenterId: 'b' });
    expect(scopeVcPatch(VCS, '유럽', '')).toEqual({ vcenterId: '' });
    expect(scopeVcPatch(VCS, '유럽', 'zz')).toEqual({ vcenterId: 'zz' });
  });
  it('소스 계약 — App 범위 바가 두 함수를 쓰고 · 리전이 있으면 첫 선택지가 ‘리전 X 전체’', () => {
    const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    // v3.20.0: ‘법인 N곳 선택’ option(MULTI_PICK_VALUE)을 고른 것은 무시하고, 그 밖은 지금처럼 scopeVcPatch 로
    expect(app).toMatch(/onChange=\{\(e\) => \{ if \(e\.target\.value !== MULTI_PICK_VALUE\) patchFilter\(scopeVcPatch\(vcenters, region, e\.target\.value\)\); \}\}/);
    expect(app).toMatch(/scopeVcOptions\(vcenters, region, vcenterId\)\.map/);
    expect(app).toMatch(/\{region \? `\$\{regionText\(region\)\} 전체` : '전체 vCenter'\}/);   // v3.13.6 부터 리전 글자는 regionText(Unknown → 리전 미지정)
    expect(app).not.toMatch(/\(vcenters \|\| \[\]\)\.map\(\(v\) => <option key=\{v\.id\} value=\{v\.id\}>\{v\.name\}<\/option>\)/);
  });
});

describe('v3.13.6 — 2차 루프 7회차: 범위 바 리전 선택지 = 정해진 4리전 + 등록 데이터에만 있는 리전', () => {
  const BASE = REGIONS;   // 지역 목록은 regions.js 단일 소스(인라인 사본 금지 — server/test/audit2575 IMP-10)
  const VCS = [{ location: { region: '유럽' } }, { location: { region: 'Unknown' } }, { location: { region: ' 중동 ' } }, { location: {} }, null, { location: { region: '중동' } }];
  it('정해진 순서 그대로 뒤에 데이터 리전(중복 · 빈 값 제외 · 이름순 · Unknown 은 맨 뒤) · Unknown 은 ‘리전 미지정(Unknown)’ 표시', () => {
    expect(scopeRegionOptions(BASE, VCS).map((o) => o.value)).toEqual([...REGIONS, '중동', 'Unknown']);
    expect(scopeRegionOptions(BASE, VCS).find((o) => o.value === 'Unknown').label).toBe('리전 미지정(Unknown)');
    expect(scopeRegionOptions(BASE, []).map((o) => o.value)).toEqual(BASE);
    expect(scopeRegionOptions(BASE, null).map((o) => o.value)).toEqual(BASE);
  });
  it('범위 계정(scope.regions)은 허용 리전만 — 데이터 리전도 허용 목록에 있어야', () => {
    expect(scopeRegionOptions(BASE, VCS, ['유럽', '중동']).map((o) => o.value)).toEqual(['유럽', '중동']);
    expect(scopeRegionOptions(BASE, VCS, []).length).toBe(6);   // 빈 목록 = 제한 없음(예전과 같다)
  });
  it('소스 계약 — App 범위 바가 scopeRegionOptions(REGIONS, vcenters, user.scope?.regions) 를 쓴다', () => {
    const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    expect(app).toMatch(/scopeRegionOptions\(REGIONS, vcenters, user\.scope\?\.regions\)\.map/);
    expect(app).toMatch(/\{region \? `\$\{regionText\(region\)\} 전체` : '전체 vCenter'\}/);
  });
  it('regionText — Unknown 은 ‘리전 미지정’ · 범위 글자 · 칩 안내가 같은 글자를 쓴다', () => {
    expect(regionText('유럽')).toBe('리전 유럽'); expect(regionText('Unknown')).toBe('리전 미지정');
    expect(scopeLabel({ region: 'Unknown' }, [{}, {}])).toBe('리전 미지정 · 2법인');
    expect(PT.chipRegionNote('Unknown', 1)).toBe('리전 미지정 · 1법인');
    expect(PT.siblingScopeText({ region: 'Unknown' })).toBe('리전 미지정');
  });
});

// v3.19.0(사용자 요청 2026-11-18) — 바로가기 글자로 찾기 · vCenter 탭 카드 위 걷어냄(A) · 400px 분해 한 번.
describe('v3.19.0 — 바로가기 찾기(filterChipSites)', () => {
  const V = [
    { id: 'AAA', name: 'AAA', version: '8.0.2', location: { city: 'Seoul', country: 'Korea', region: '아시아' } },
    { id: 'AAB', name: 'AAB', version: '7.0.3', location: { city: 'Busan', country: 'Korea', region: '아시아' } },
    { id: 'BBC', name: 'BBC-IRS', version: '8.0.3', location: { city: 'Frankfurt', country: 'Germany', region: '유럽' } },
    null,
  ];
  const ids = (l) => l.map((s) => s.id);
  it('부분 일치 — ‘AA’ 는 AAA · AAB 를 모두 찾는다', () => { expect(ids(filterChipSites(V, 'AA'))).toEqual(['AAA', 'AAB']); });
  it('대소문자 무시 · 공백 낱말은 AND(이름 · 도시 · 버전 어느 칸이든)', () => {
    expect(ids(filterChipSites(V, 'aa'))).toEqual(['AAA', 'AAB']);
    expect(ids(filterChipSites(V, 'aa busan'))).toEqual(['AAB']);
    expect(ids(filterChipSites(V, '  irs  8.0.3 '))).toEqual(['BBC']);
    expect(filterChipSites(V, 'aa germany')).toEqual([]);
  });
  it('빈 글자 · 공백만 = 전부(원본 그대로) · 목록이 아니면 빈 목록', () => {
    expect(filterChipSites(V, '')).toBe(V); expect(filterChipSites(V, '   ')).toBe(V); expect(filterChipSites(V, undefined)).toBe(V);
    expect(filterChipSites(null, 'aa')).toEqual([]);
  });
  it('고른 법인의 칩은 일치하지 않아도 남는다(배열 · 문자열 모두) — 맞는 법인이 없어도 고른 칩만은 보인다', () => {
    expect(ids(filterChipSites(V, 'aa', ['BBC']))).toEqual(['AAA', 'AAB', 'BBC']);
    expect(ids(filterChipSites(V, 'zzz', ['BBC']))).toEqual(['BBC']);
    expect(ids(filterChipSites(V, 'zzz', 'BBC'))).toEqual(['BBC']);
    expect(ids(filterChipSites(V, 'zzz', ['']))).toEqual([]);
  });
  it('카드와 같은 판정(vcMatches)을 쓰고 새 판정을 만들지 않는다 · 소스 계약 — 허브 칩 · 카드 · App 상태', () => {
    expect(stripComments(read('./platformText.js'))).toMatch(/vcMatches\(s, kws\)/);
    const hub = stripComments(read('./PlatformHub.jsx'));
    expect(hub).toMatch(/filterChipSites\(regionSites, chipQuery, picked\)/);   // v3.20.0: 켠 칩 목록 전부
    expect(hub).toMatch(/찾는 글자에 맞는 법인이 없습니다/);
    expect(hub).toMatch(/<SearchBox /);
    const vc = stripComments(read('../VCenters.jsx'));
    expect(vc).toMatch(/filterChipSites\(/);
    expect(vc).toMatch(/찾는 글자 ‘/);
    // 빈 결과의 원인을 가른다 — 공용 검색 안내는 q 로 거른 결과(byQuery)가 0일 때만, 찾기 글자 안내는 q 로는 남았는데 찾기 글자가 지웠을 때만
    expect(vc).toMatch(/keywords\.length > 0 && byQuery\.length === 0 &&/);
    expect(vc).toMatch(/chipKeywords\.length > 0 && shown\.length === 0 && byQuery\.length > 0 &&/);
    const app = stripComments(read('../../App.jsx'));
    expect(app).toMatch(/const \[chipQuery, setChipQuery\] = useState\(''\)/);   // 메모리만 — 저장하지 않는다
    expect(app).toMatch(/chipQuery=\{chipQuery\} onChipQuery=\{setChipQuery\}/);
    expect(app).not.toMatch(/localStorage[^\n]*chipQuery|chipQuery[^\n]*localStorage/);
  });
});

describe('v3.19.0 — vCenter 탭은 바로가기 아래에 카드만(설계 docs/design/vm-menu 시안 A)', () => {
  it('HubTabs 줄 · 요약 3장 · 표 보기 · 카드 기억 · 죽은 ref 가 없다(소스 계약)', () => {
    const vc = stripComments(read('../VCenters.jsx'));
    for (const bad of [/HubTabs/, /TrendKpis/, /VcTable/, /loadVcView|saveVcView|VC_VIEWS|platform\.vcView/, /cardRefs/, /data-kpi-backup/, /kpis-1row/, /localStorage/]) expect(vc).not.toMatch(bad);
    expect(vc).toMatch(/<VmNameSearch /);            // VM 이름 검색 안내는 남는다
    expect(vc).toMatch(/className="vc-grid"/);
    expect(fs.existsSync(path.resolve(HERE, './VcTable.jsx'))).toBe(false);
    expect(fs.existsSync(path.resolve(HERE, './HubTabs.jsx'))).toBe(true);   // Hosts · Vms 탭이 쓴다
    const css = fs.readFileSync(path.resolve(HERE, '../../styles.css'), 'utf8');
    expect(css).not.toMatch(/vcFlash|\.vc-card\.flash/);
  });
  it('400px 열린 탭의 분해는 탭 아래 한 줄(.ph-parts-narrow)뿐 — 탭 안에 다시 켜지 않는다(D3)', () => {
    const css = fs.readFileSync(path.resolve(HERE, './platform.css'), 'utf8');
    expect(css).not.toMatch(/\.ph-tab\.on \.parts/);
    expect(css).toMatch(/\.ph-tab \.parts \{ display: none; \}/);
  });
});
