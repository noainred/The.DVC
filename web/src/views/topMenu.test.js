// topMenu.test.js — v2.725 상단 메뉴 재구성(시안 A '2단 탭')의 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MENU_GROUPS, BAREMETAL_SEG, hashOf, locate, visibleMenu, entryOf } from './topMenu.js';
import { TOOLS } from './specialToolsList.js';
import { stripComments } from '../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

const allItems = () => MENU_GROUPS.flatMap((g) => (g.children ? g.children.map((c) => ({ g, c })) : [{ g, c: null }]));
const tabsInMenu = () => new Set(allItems().map(({ g, c }) => (c ? c.tab : g.tab)).filter(Boolean));

describe('메뉴 구성', () => {
  it('대메뉴는 사용자가 정한 순서 10개다(업그레이드는 설정 아래)', () => {
    expect(MENU_GROUPS.map((g) => g.label)).toEqual(['Overview', 'Summary', '서버', '스토리지', '네트워크', '자원관리', '자원 최적화', '특수 기능', '게시판', '설정']);
    const settings = MENU_GROUPS.find((g) => g.id === 'settings');
    expect(settings.children.map((c) => c.tab)).toEqual(['settings', 'upgrade']);
  });

  it('App 의 탭은 전부 어느 메뉴엔가 있다(빠지면 그 화면으로 갈 메뉴가 없다)', () => {
    const app = read('../App.jsx');
    const block = app.slice(app.indexOf('const TABS = ['), app.indexOf('];', app.indexOf('const TABS = [')));
    const ids = [...block.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(14);
    const inMenu = tabsInMenu();
    for (const id of ids) expect(inMenu.has(id), id).toBe(true);
    for (const id of inMenu) expect(ids.includes(id), `메뉴의 탭 ${id} 가 App TABS 에 없다`).toBe(true);
  });

  it('메뉴가 가리키는 도구는 카탈로그에 실재하고 패널이 있는 도구다', () => {
    const keys = allItems().map(({ c }) => c?.tool).filter(Boolean);
    expect(keys.length).toBe(14);               // 서버 분석은 '물리 서버' 와 '서버 분석' 두 자리
    expect(new Set(keys).size).toBe(13);
    for (const k of keys) {
      const t = TOOLS.find((x) => x.k === k);
      expect(t, k).toBeTruthy();
      expect(!!t.external || !!t.topTab || !!t.comingSoon, k).toBe(false);
    }
  });

  it('하위 메뉴 이름은 사용자가 정한 것이다', () => {
    const labels = (id) => MENU_GROUPS.find((g) => g.id === id).children.map((c) => c.label);
    expect(labels('server')).toEqual(['가상화 서버', 'ESXi 호스트', 'vCenter', '물리 서버', '알람']);
    expect(labels('storage')).toEqual(['스토리지 현황', '데이터스토어', '스토리지 증가량 보고서', '스토리지 사용량 추이', '베어메탈 스토리지', 'SAN 스토리지 성능 측정']);
    expect(labels('network')).toEqual(['전체 네트워크 장비', '가상화 네트워크', '통신 지도', '글로벌 네트워크 점검', 'IP관리', 'Monitoring']);
    expect(labels('resource')).toEqual(['서버 분석', 'GPU 인벤토리', '전력 분석']);
    expect(labels('optimize')).toEqual(['Optimization', 'iDRAC 통합 추이']);
  });
});

describe('locate — 지금 화면이 어느 메뉴인가', () => {
  it('모든 메뉴 항목은 자기 주소로 자기 자신을 가리킨다', () => {
    for (const { g, c } of allItems()) {
      const item = c || g;
      const tab = item.tool ? 'tools' : item.tab;
      expect(locate(tab, hashOf(item)), `${g.id}/${c?.id}`).toEqual({ group: g.id, child: c ? c.id : null });
    }
  });
  it('물리 서버와 서버 분석은 같은 도구지만 주소 셋째 조각으로 가른다(하위 탭이 붙어도 같다)', () => {
    expect(locate('tools', `#/tools/serveranalysis/${BAREMETAL_SEG}`)).toEqual({ group: 'server', child: 'bm' });
    expect(locate('tools', `#/tools/serveranalysis/${BAREMETAL_SEG}/gpu`)).toEqual({ group: 'server', child: 'bm' });
    expect(locate('tools', '#/tools/serveranalysis')).toEqual({ group: 'resource', child: 'sa' });
    expect(locate('tools', '#/tools/serveranalysis/gpu')).toEqual({ group: 'resource', child: 'sa' });
  });
  it('특수 기능 카드로 연 메뉴 도구는 그 메뉴가, 메뉴에 없는 도구·목록은 특수 기능이 켜진다', () => {
    expect(locate('tools', '#/tools/storage-mon/faults')).toEqual({ group: 'storage', child: 'mon' });
    expect(locate('tools', '#/tools/pdu')).toEqual({ group: 'tools', child: null });
    expect(locate('tools', '#/tools')).toEqual({ group: 'tools', child: null });
  });
  it('옛 탭 주소는 새 메뉴 자리로 간다(#/hosts → 서버 › ESXi 호스트, #/upgrade → 설정 › 업그레이드)', () => {
    expect(locate('hosts', '#/hosts')).toEqual({ group: 'server', child: 'esxi' });
    expect(locate('vms', '#/vms')).toEqual({ group: 'server', child: 'vm' });
    expect(locate('vcenters', '#/vcenters')).toEqual({ group: 'server', child: 'vc' });
    expect(locate('datastores', '#/datastores')).toEqual({ group: 'storage', child: 'ds' });
    expect(locate('upgrade', '#/upgrade')).toEqual({ group: 'settings', child: 'upgrade' });
    expect(locate('settings', '#/settings/collectors')).toEqual({ group: 'settings', child: 'settings' });
  });
});

describe('visibleMenu · entryOf', () => {
  it('하위 메뉴가 모두 가려진 대메뉴는 빠지고, 특수 기능은 항상 보인다', () => {
    const m = visibleMenu({ tabOk: (t) => ['overview', 'vms'].includes(t), toolOk: () => false });
    expect(m.map((g) => g.id)).toEqual(['overview', 'server', 'tools']);
    expect(m.find((g) => g.id === 'server').children.map((c) => c.id)).toEqual(['vm']);
  });
  it('설정 소유자가 아니어도 업그레이드를 볼 수 있으면 설정 메뉴는 업그레이드 하나로 남는다', () => {
    const m = visibleMenu({ tabOk: (t) => t === 'upgrade', toolOk: () => false });
    expect(m.find((g) => g.id === 'settings').children.map((c) => c.id)).toEqual(['upgrade']);
  });
  it('관리자 전용 도구가 잠긴 계정에는 물리 서버·서버 분석·iDRAC 통합 추이가 보이지 않는다', () => {
    const adminOnly = new Set(TOOLS.filter((t) => t.adminOnly).map((t) => t.k));
    const m = visibleMenu({ tabOk: () => true, toolOk: (k) => !adminOnly.has(k) });
    const ids = m.flatMap((g) => (g.children || []).map((c) => `${g.id}/${c.id}`));
    expect(ids).not.toContain('server/bm');
    expect(ids).not.toContain('resource/sa');
    expect(ids).not.toContain('optimize/idrac');
    expect(ids).toContain('resource/gpu');
  });
  it('대메뉴를 누르면 마지막으로 본 하위 메뉴, 없거나 지금 안 보이면 첫 하위 메뉴', () => {
    const g = visibleMenu().find((x) => x.id === 'storage');
    expect(entryOf(g, {}).id).toBe('mon');
    expect(entryOf(g, { storage: 'san' }).id).toBe('san');
    expect(entryOf(g, { storage: 'gone' }).id).toBe('mon');
    const ov = visibleMenu().find((x) => x.id === 'overview');
    expect(entryOf(ov, {})).toBe(ov);
  });
});

describe('화면 배선(소스)', () => {
  const app = stripComments(read('../App.jsx'));
  it('v2.726: 메뉴는 좌측 사이드바(Sidebar)가 그리고, 상단 탭·하위 메뉴 줄은 없다', () => {
    expect(app).toMatch(/<Sidebar mode=\{sbMode\}/);
    expect(app).not.toMatch(/<nav className="tabs"/);
    expect(app).not.toMatch(/<nav className="subtabs"/);
    // 메뉴 해석(내 메뉴 > 배포 메뉴 > 기본)은 sideMenu.resolveMenu 하나 — App 은 그 결과를 visibleMenu·locate 에 넘긴다.
    expect(app).toMatch(/resolveMenu\(\{/);
    expect(app).toMatch(/visibleMenu\(\{[^}]*\},\s*resolvedMenu\.groups\)/);
    expect(app).toMatch(/locate\(tab, hashNow, resolvedMenu\.groups\)/);
    // 도구 노출은 특수 기능 카드와 같은 잠금 판정을 쓴다(규칙을 App 에 다시 쓰지 않는다).
    expect(app).toMatch(/lockReasonOf\(meta,/);
  });
  it('사이드바 CSS 는 .sb 아래로 한정하고 대문자 변환을 쓰지 않는다 · 옛 하위 메뉴 줄(.subtabs) 규칙은 없다', () => {
    const css = read('../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/\.subtabs/);
    const rules = css.match(/[^{}]*\.sb-(?:nav|item|sub|group|foot)[^{]*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) {
      const sel = r.slice(0, r.indexOf('{')).trim();
      expect(sel.split(',').every((x) => /^\.sb(\b|-)/.test(x.trim())), sel).toBe(true);
      expect(r).not.toMatch(/text-transform/);
    }
  });
  it('물리 서버 모드: 서버 분석이 주소로 Baremetal 을 고정하고, 모드가 바뀌면 화면을 새로 만든다', () => {
    const hw = stripComments(read('tools/HardwareTools.jsx'));
    expect(hw).toMatch(/<ServerAnalysisView key=\{bm \? 'bm' : 'all'\} bm=\{bm\} \/>/);
    expect(hw).toMatch(/useState\(bm \? 'baremetal' : ''\)/);
    expect(hw).toMatch(/disabled=\{bm\}/);
    expect(hw).toMatch(/base: bm \? \['tools', 'serveranalysis', BAREMETAL_SEG\]/);
  });
});
