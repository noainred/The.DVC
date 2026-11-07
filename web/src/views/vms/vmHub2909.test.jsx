// v2.909 — 가상화 서버 허브(시안 docs/design/vm-screen 시안 1): 글자·판정 보조(vmHubText) · 서버와 대조 · 메뉴 also · 드로어 렌더(예전 모달 기능 보존) · 소스 스윕.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';
import {
  HUB_VIEW_KEYS, HUB_TOOL_KEYS, SIGNAL_ORDER, signalText, neighborOf, sparkPath, peakOf, usageTone, corpVmsSort, barW, corpCollectText, attentionCards, fmtN, pctText,
} from './vmHubText.js';
import { MENU_GROUPS, locate } from '../topMenu.js';
import { TOOLS } from '../specialToolsList.js';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: () => ({ data: null, error: null, loading: true }), toolAllowed: () => true, hasRole: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const raw = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('vmHubText — 서버와 같은 신호 키 · 메뉴 · 도구', () => {
  it('신호 키는 서버 inventory/vmSignals.js SIGNAL_KEYS 와 같은 순서', () => {
    const srv = raw('../../../../server/src/inventory/vmSignals.js');
    const m = /export const SIGNAL_KEYS = Object\.freeze\(\[([^\]]+)\]\)/.exec(srv);
    expect(m).toBeTruthy();
    const keys = [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]);
    expect(keys).toEqual([...SIGNAL_ORDER]);
  });
  it('허브 도구는 카탈로그에 실재하고 메뉴 서버 › 가상화 서버 의 also 와 같다 → 그 도구를 열어도 이 메뉴가 켜진다', () => {
    // v2.915: '가상화 서버' 항목은 '가상화 플랫폼'(virt — vcenters · hosts · vms) 한 항목이 됐다 — VM 도구 6은 그 also 의 앞 여섯 그대로(뒤에 vCenter · 호스트 도구)
    const vm = MENU_GROUPS.find((g) => g.id === 'server').children.find((c) => c.id === 'virt');
    expect(vm.tabs).toContain('vms');
    expect(vm.also.slice(0, HUB_TOOL_KEYS.length)).toEqual([...HUB_TOOL_KEYS]);
    for (const k of HUB_TOOL_KEYS) {
      const t = TOOLS.find((x) => x.k === k);
      expect(t, k).toBeTruthy();
      expect(!!t.external || !!t.comingSoon, k).toBe(false);
      expect(locate('tools', `#/tools/${k}`)).toEqual({ group: 'server', child: 'virt' });
    }
    expect(locate('vms', '#/vms/corp')).toEqual({ group: 'server', child: 'virt' });
    expect([...HUB_VIEW_KEYS]).toEqual(['list', 'corp', 'attention']);
  });
});

describe('vmHubText — 순수 판정 보조', () => {
  it('신호 문구 — 스냅샷은 응답의 기준 일수(없으면 오래됨) · 모르는 키는 그대로', () => {
    expect(signalText('snapOld', { days: 7 }).short).toBe('스냅샷 7일↑');
    expect(signalText('snapOld').short).toBe('스냅샷 오래됨');
    expect(signalText('overload').badge).toBe('red');
    expect(signalText('usageUnknown').tone).toBe('none');
    expect(signalText('nope').label).toBe('nope');
    for (const k of SIGNAL_ORDER) expect(signalText(k).desc).not.toMatch(/`/);   // 문구에 백틱 금지(BoldText 규칙과 같은 문구 규약)
    expect(attentionCards(null).map((c) => c.count)).toEqual([null, null, null, null]);
    expect(attentionCards({ overload: 3, usageUnknown: 0, toolsOld: 5, snapOld: 1, snapAgeDays: 9 }).map((c) => [c.key, c.count, c.short])).toEqual([
      ['overload', 3, 'CPU·메모리 90%↑'], ['usageUnknown', 0, '사용률 미수집'], ['toolsOld', 5, 'Tools 구버전'], ['snapOld', 1, '스냅샷 9일↑']]);
  });
  it('못 읽은 값은 — · 0 폭 · 정렬 키는 빈 값(표지값 -1 금지)', () => {
    expect(fmtN(null)).toBe('—');
    expect(fmtN('')).toBe('—');
    expect(pctText(undefined)).toBe('—');
    expect(usageTone(null)).toBe('none');
    expect(usageTone(-1)).toBe('none');
    expect([usageTone(74.9), usageTone(75), usageTone(89.9), usageTone(90)]).toEqual(['ok', 'warn', 'warn', 'crit']);
    expect(barW(null)).toBe(0);
    expect(barW(150)).toBe(100);
    expect(corpVmsSort({ vms: null })).toBe('');
    expect(corpVmsSort({ vms: 0 })).toBe(0);
  });
  it('이웃 — 목록 순서대로 · 목록에 없으면 둘 다 null', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(neighborOf(rows, 'b')).toMatchObject({ prev: { id: 'a' }, next: { id: 'c' }, index: 1, total: 3 });
    expect(neighborOf(rows, 'a').prev).toBe(null);
    expect(neighborOf(rows, 'zz')).toMatchObject({ prev: null, next: null, index: -1 });
    expect(neighborOf(null, 'a').total).toBe(0);
  });
  it('스파크라인 — 못 읽은 점은 잇지 않는다(펜을 든다) · 점 2개 미만은 null · 최대값', () => {
    expect(sparkPath([{ v: 10 }])).toBe(null);
    expect(sparkPath([{ v: null }, { v: '' }])).toBe(null);
    const d = sparkPath([{ v: 0 }, { v: 50 }, { v: null }, { v: 100 }, { v: 100 }], { w: 100, h: 26, max: 100 });
    expect(d.match(/M/g).length).toBe(2);   // 끊긴 자리에서 새로 시작
    expect(d.startsWith('M0,25')).toBe(true);
    expect(peakOf([{ v: 3 }, { v: null }, { v: 9 }])).toBe(9);
    expect(peakOf([])).toBe(null);
  });
  it('수집 칸 — 엣지는 받은 지 얼마인지, 직접은 그대로', () => {
    const now = 10 * 3_600_000;
    expect(corpCollectText({ collect: 'direct' }, now)).toBe('직접');
    expect(corpCollectText({ collect: 'site', receivedAt: now - 12 * 60_000 }, now)).toBe('엣지 · 12분 전');
    expect(corpCollectText({ collect: 'site', receivedAt: now - 3 * 3_600_000 }, now)).toBe('엣지 · 3시간 전');
    expect(corpCollectText({ collect: 'site' }, now)).toBe('엣지');
  });
});

describe('VmDrawer — 예전 VM 상세 모달의 기능을 빠짐없이(렌더)', () => {
  it('머리 · 버튼 6개 · 신호 · 구성 KV(예전 17항목) · 섹션 · 개체 보기 바로가기', async () => {
    const { default: VmDrawer } = await import('./VmDrawer.jsx');
    const vm = {
      id: 'vc1:vm-1', vcenterId: 'vc1', name: 'web-01', powerState: 'POWERED_ON', host: 'esx-1', cluster: 'CL-A', resourcePool: 'prod', folder: '/web',
      guestOS: 'Linux A 9', ipAddresses: ['10.0.0.1', '10.0.0.2'], toolsStatus: 'RUNNING', toolsVersion: '12345', toolsVersionStatus: 'guestToolsNeedUpgrade',
      cpuCount: 4, memMB: 8192, storageGB: 100, uncommittedGB: 50, cpuUsagePct: 95, memUsagePct: 40, snapshotCount: 1, snapshotSizeGB: 3, snapshotOldestTs: Date.now() - 20 * 86_400_000,
      tags: ['tier:web'], notes: '메모 줄', signals: ['overload', 'toolsOld', 'snapOld'],
    };
    const rows = [{ id: 'vc1:vm-0' }, vm, { id: 'vc1:vm-2' }];
    const html = renderToStaticMarkup(React.createElement(VmDrawer, { vm, rows, onClose: () => {}, onMove: () => {}, days: 7 }));
    expect(html).toContain('web-01');
    expect(html).toContain('목록 2/3');
    for (const lab of ['이전 VM', '다음 VM', '닫기']) expect(html).toContain(`aria-label="${lab}"`);
    expect(html).toContain('개체 보기');
    expect(html).toContain('축소 근거 리포트');
    for (const s of ['CPU·메모리 90%↑', 'Tools 구버전', '스냅샷 7일↑', '과부하', 'VMware Tools 업그레이드 필요', '오래된 스냅샷']) expect(html).toContain(s);
    // 예전 모달 KV 17항목: 이름·전원(머리) · vCenter · 호스트 · 클러스터 · Guest OS · IP · VMware Tools · vCPU · RAM · 디스크 · CPU·메모리 사용률(타일) · Tools 버전 · 스냅샷 · GPU · vCenter ID · 태그 · 메모
    for (const lab of ['vCenter', '호스트', '클러스터', 'Guest OS', 'VMware Tools', 'vCPU', 'RAM', '디스크', 'Tools 버전', '스냅샷', 'GPU', 'vCenter ID', '태그', '메모', 'CPU', '메모리', 'IP']) {
      expect(html, lab).toContain(lab);
    }
    expect(html).toContain('vc1:vm-1');
    expect(html).toContain('메모 줄');
    expect(html).toContain('8 GB (8,192 MB)');
    expect(html).toContain('67<small>%</small>');   // 디스크 = 100 / (100 + 50)
    expect(html).toContain('리소스 풀 prod');
    for (const t of ['요약', '모니터', '구성', '데이터스토어', '네트워크', '스냅샷', '업데이트']) expect(html).toContain(`>${t}</a>`);
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
  });
  it('꺼진 VM — 사용률은 — · 24시간 추이를 조회하지 않는다 · 신호가 없으면 없다고 말한다', async () => {
    const { default: VmDrawer } = await import('./VmDrawer.jsx');
    const vm = { id: 'vc1:off', vcenterId: 'vc1', name: 'off-01', powerState: 'POWERED_OFF', cpuUsagePct: 0, memUsagePct: 0, signals: [] };
    const html = renderToStaticMarkup(React.createElement(VmDrawer, { vm, rows: [vm], onClose: () => {}, onMove: () => {} }));
    expect(html).toContain('꺼진 VM 은 사용률이 없습니다');
    expect(html).not.toContain('24시간 추이 조회 중');
    expect(html).toContain('신호 없음');
    expect(html).not.toMatch(/0<small>%<\/small>/);   // 꺼진 VM 의 0% 를 사용률로 보이지 않는다
  });
});

describe('소스 스윕', () => {
  it('Vms.jsx 는 예전 모달(EntityDetail)을 열지 않고 드로어를 연다 · 신호를 함께 받는다 · 훅은 조기 return 위', () => {
    const s = read('../Vms.jsx');
    expect(s).not.toMatch(/<EntityDetail/);
    expect(s).toMatch(/<VmDrawer /);
    expect(s).toMatch(/signals: '1'/);
    const body = s.slice(s.indexOf('function VmsList('));
    const firstReturn = body.indexOf('if (reset) return');
    expect(firstReturn).toBeGreaterThan(0);
    expect(body.slice(firstReturn).match(/\buse(State|Ref|Effect|Memo|Callback)\(/g)).toBe(null);
  });
  it('드로어 섹션은 EntityDetail 에서 꺼내 쓴다(복제 금지) · 법인별·조치 필요는 15초 폴링하지 않는다', () => {
    const d = read('./VmDrawer.jsx');
    for (const n of ['VmIpPing', 'VmPartitionsSection', 'VmCfgSection', 'PerfcSection', 'ClusterCfgSection', 'VmTagsSection', 'VmChangesSection', 'ObjectViewButton']) {
      expect(d, n).toMatch(new RegExp(`<${n}[ >]`));
    }
    for (const n of ['VmConsoleButton', 'VmRemoteButton', 'VmReconfigButton', 'VmMetricButton', 'RightsizeReport']) expect(d, n).toMatch(new RegExp(`<${n}[ >]`));
    for (const f of ['./VmsByCorp.jsx', './VmsAttention.jsx']) expect(read(f), f).not.toMatch(/usePolling\(/);
  });
  it('CSS — 선택자는 전부 .vmh · .vmo 로 시작 · uppercase 금지 · 새 색은 토큰 블록에서만', () => {
    const css = raw('./vmHub.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    const sels = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((x) => x && !/^(from|to|\d+%)$/.test(x));
    for (const sel of sels) for (const one of sel.split(',')) expect(one.trim(), one).toMatch(/^\.(vmh|vmo)/);
  });
  it('VCenterDetail 의 VM 목록도 신호를 받는다(개체 보기 요약 탭) · 특수 기능 패널은 허브 도구에 탭 줄을 둔다', () => {
    expect(read('../VCenterDetail.jsx')).toMatch(/usePolling\('\/vms', \{ vcenterId, limit: 5000, signals: '1' \}/);
    const st = read('../SpecialTools.jsx');
    expect(st).toMatch(/HUB_TOOL_KEYS\.includes\(tool\) && .*<VmHubTabs active=\{tool\} \/>/);
  });
});
