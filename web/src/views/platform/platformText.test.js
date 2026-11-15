// platformText.test.js — v2.915 '서버 › 가상화 플랫폼' 허브(설계 docs/design/virt-platform-menu 시안 A)의 순수 보조 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_TABS, PLATFORM_TAB_KEYS, isPlatformTab, scopeLabel, bareosSumOf, KPI_HANDOFF, handoffKpiVcenter, takeKpiVcenter, keywordsOf, vcMatches, siblingSites, siblingScopeText, chipSites, chipRegionNote, handoffKpiScope, regionsOf, vcInRegion, VC_TOOLS, HOST_TOOLS, PLATFORM_TOOL_KEYS, entityTabs, chipCount, chipLegend, signalSegments,
  VM_ITEM_TOOL_KEYS, HV_ITEM_TOOL_KEYS, platformMenuLabel,
  loadChipsCollapsed, saveChipsCollapsed, loadVcView, saveVcView, SCOPE_SEARCH_PLACEHOLDER, SCOPE_NOTE,
} from './platformText.js';
import * as PT from './platformText.js';
import { HUB_TOOL_KEYS } from '../vms/vmHubText.js';
import { TOOLS } from '../specialToolsList.js';
import { MENU_GROUPS, locate } from '../topMenu.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

describe('탭 · 도구 · 메뉴 대조', () => {
  it('허브 탭은 계층 순서(vCenter → 호스트 → VM)이고 App 의 탭 id 그대로 · v2.994 메뉴 항목 둘이 나눠 맡는다', () => {
    expect(PLATFORM_TAB_KEYS).toEqual(['vcenters', 'hosts', 'vms']);
    expect(PLATFORM_TABS.map((t) => t.perm)).toEqual(['dashboard', 'inv.hosts', 'inv.vms']);
    expect(isPlatformTab('hosts')).toBe(true); expect(isPlatformTab('datastores')).toBe(false);
    const srv = MENU_GROUPS.find((g) => g.id === 'server').children;
    const virt = srv.find((c) => c.id === 'virt'); const hv = srv.find((c) => c.id === 'hv');
    // v2.994: Virtual Machine(VM) = vms(처음) + vcenters · Hypervisor = hosts — 두 항목의 탭을 합치면 허브 탭 셋 그대로(빠짐 · 겹침 없음)
    expect([virt.tab, ...virt.tabs]).toEqual(['vms', 'vcenters']);
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
    expect([platformMenuLabel('hosts'), platformMenuLabel('vms')]).toEqual(['Hypervisor', 'Virtual Machine(VM)']);
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
    expect(PLATFORM_TABS.map((t) => [t.k, t.label, t.sub])).toEqual([['vcenters', 'vCenter', '법인'], ['hosts', 'Hypervisor', 'ESXi 호스트'], ['vms', 'Virtual Machine', 'VM']]);
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
  it('바로가기 접힘 · vCenter 보기(v2.994: 마지막 본 탭 기억은 없앴다)', () => {
    const st = mem();
    expect(loadChipsCollapsed(st)).toBe(false); saveChipsCollapsed(st, true); expect(loadChipsCollapsed(st)).toBe(true);
    expect(loadVcView(st)).toBe('cards'); saveVcView(st, 'table'); expect(loadVcView(st)).toBe('table'); saveVcView(st, 'tree'); expect(loadVcView(st)).toBe('table');
    expect(loadChipsCollapsed(broken)).toBe(false); expect(loadVcView(broken)).toBe('cards');
  });
});

// v2.958(사용자 요청 2026-11-10) — vCenter 탭 KPI 줄은 허브 범위(리전 · vCenter) 안의 법인만 합한다.
describe('KPI 범위 문구 · Bareos 범위 합(v2.958)', () => {
  const sites = [{ id: 'vc-a', name: 'OC2Sandbox', location: { region: '아시아' } }, { id: 'vc-b', name: 'AZ', location: { region: '아시아' } }];
  it('scopeLabel — 전체 / vCenter 이름(없으면 id) / 리전 · N법인', () => {
    expect(scopeLabel({}, sites)).toBe('전체');
    expect(scopeLabel({ vcenterId: 'vc-a' }, sites)).toBe('OC2Sandbox');
    expect(scopeLabel({ vcenterId: 'vc-x' }, sites)).toBe('vc-x');
    expect(scopeLabel({ region: '아시아' }, sites)).toBe('리전 아시아 · 2법인');
    expect(scopeLabel(null, null)).toBe('전체');
  });
  it('bareosSumOf — 범위 안 법인의 counts.jobs 합 · 못 읽은 법인은 0 이 아니라 unknown · 전부 못 읽으면 null', () => {
    const rows = [{ id: 'vc-a', counts: { jobs: 11 } }, { id: 'vc-b', counts: { jobs: '7' } }, { id: 'vc-c', counts: {} }, null];
    expect(bareosSumOf(rows, ['vc-a', 'vc-b'])).toEqual({ jobs: 18, known: 2, unknown: 0, partial: false });
    expect(bareosSumOf(rows, ['vc-a', 'vc-c'])).toEqual({ jobs: 11, known: 1, unknown: 1, partial: true });
    expect(bareosSumOf(rows, ['vc-c', 'vc-zzz'])).toEqual({ jobs: null, known: 0, unknown: 2, partial: false });
    expect(bareosSumOf(null, ['vc-a'])).toEqual({ jobs: null, known: 0, unknown: 1, partial: false });
    expect(bareosSumOf(rows, [])).toEqual({ jobs: null, known: 0, unknown: 0, partial: false });
  });
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
  it('App 은 칩에 region 을 넘기고 칩을 눌러도 region 을 지우지 않는다(소스 계약)', async () => {
    const fs = await import('node:fs');
    const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    expect(app).toMatch(/<PlatformHub[\s\S]*?region=\{region\}[\s\S]*?onPickVcenter=\{\(id\) => patchFilter\(\{ vcenterId: id \}\)\}/);
    const hub = fs.readFileSync(new URL('./PlatformHub.jsx', import.meta.url), 'utf8');
    expect(hub).toMatch(/const sites = chipSites\(vcenters, region\)/);
  });
});

// v3.10.15(점검 3회차) — KPI 카드가 리전도 넘긴다 · 도구의 리전 보조.
describe('KPI 카드 → 도구 리전 인계(v3.10.15)', () => {
  const T = { vc: KPI_HANDOFF.vmTrack, region: KPI_HANDOFF.vmTrackRegion };
  it('handoffKpiScope — vCenter 가 있으면 vCenter 만, 없고 리전만 있으면 리전, 둘 다 없으면 false(남기지 않음)', () => {
    expect(handoffKpiScope(T, { vcenterId: 'vc-a', region: '유럽' })).toBe(true);
    expect(takeKpiVcenter(T.region)).toBe('');
    expect(takeKpiVcenter(T.vc)).toBe('vc-a');
    expect(handoffKpiScope(T, { region: '유럽' })).toBe(true);
    expect(takeKpiVcenter(T.vc)).toBe('');
    expect(takeKpiVcenter(T.region)).toBe('유럽');
    expect(handoffKpiScope(T, {})).toBe(false);
    expect(takeKpiVcenter(T.region)).toBe('');
  });
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
  it('KPI_HANDOFF 에 backupSummaryRegion · handoffKpiScope 는 리전 대상만 있어도 리전을 남긴다(vCenter 대상이 없으면 vCenter 는 남기지 않는다)', () => {
    expect(KPI_HANDOFF.backupSummaryRegion).toBe('backup-summary:region');
    expect(handoffKpiScope({ region: KPI_HANDOFF.backupSummaryRegion }, { region: '유럽' })).toBe(true);
    expect(takeKpiVcenter(KPI_HANDOFF.backupSummaryRegion)).toBe('유럽');
    expect(takeKpiVcenter(KPI_HANDOFF.backupSummaryRegion)).toBe('');   // 한 번 읽으면 비운다
    // vCenter 대상이 없는 호출(백업 카드는 법인을 골랐으면 Detail 로 가므로 Summary 쪽은 리전 대상만 준다) — vCenter 가 있어도 리전을 남긴다(대상이 리전뿐이라)
    expect(handoffKpiScope({ region: KPI_HANDOFF.backupSummaryRegion }, { vcenterId: 'vc-1', region: '유럽' })).toBe(true);
    expect(takeKpiVcenter(KPI_HANDOFF.backupSummaryRegion)).toBe('유럽');
    expect(handoffKpiScope({ region: KPI_HANDOFF.backupSummaryRegion }, {})).toBe(false);
  });
  it('소스 계약 — 허브 백업 카드가 리전을 넘기고 · Summary 가 받아 다섯 요청에 싣는다 · 하위 구획 셋이 region 을 받는다', () => {
    const vc = fs.readFileSync(new URL('../VCenters.jsx', import.meta.url), 'utf8');
    expect(vc).toMatch(/handoffKpiScope\(\{ region: KPI_HANDOFF\.backupSummaryRegion \}, \{ region: regSel \}\); window\.location\.hash = '#\/tools\/backup-summary'/);
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
