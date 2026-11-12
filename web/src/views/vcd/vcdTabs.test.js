import { describe, it, expect } from 'vitest';
import {
  VCD_TABS, DEFAULT_TAB, normTab, loadTab, saveTab, TAB_STORE_KEY, MONITOR_SUBS, CONFIGURE_SUBS,
  alarmCounts, alarmsOf, maskLicenseKey, licenseUsePct, licenseExpiryText, groupByDatacenter,
  extensionVendor, extensionsState, fleetKeyStats, esxiVersionRows, versionNewer, permEvents, gbText, inventoryCounts,
  PORTAL_ALARM_RULE_TEXT, shortTs,
  HUB_ENTRY_TAB, entryTab, HOT_TABS, tabClass,
} from './vcdTabs.js';

describe('vCenter 탭 12개(v2.895) — 목록 · 옛 키 · 기억', () => {
  it('vSphere Client 순서 그대로 12개 · 이모지 없음', () => {
    expect(VCD_TABS.map((t) => t.label)).toEqual([
      '요약', '모니터', '구성', '사용 권한', '데이터 센터', '호스트 및 클러스터', 'VM', '데이터스토어', '네트워크',
      '연결된 vCenter Server 시스템', '확장 프로그램', '업데이트',
    ]);
    for (const t of VCD_TABS) expect(t.label).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it('기본 탭은 예전과 같은 호스트 및 클러스터 · 옛 trend 는 모니터 · 모르는 값은 기본', () => {
    expect(DEFAULT_TAB).toBe('hosts');
    expect(normTab('trend')).toBe('monitor');
    expect(normTab('nope')).toBe('hosts');
    expect(normTab('')).toBe('hosts');
    expect(normTab('extensions')).toBe('extensions');
  });
  it('저장소가 없거나 던져도 동작한다', () => {
    expect(loadTab(null)).toBe('hosts');
    const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadTab(boom)).toBe('hosts');
    expect(() => saveTab(boom, 'summary')).not.toThrow();
    const m = new Map();
    const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
    saveTab(st, 'trend');
    expect(m.get(TAB_STORE_KEY)).toBe('monitor');
    expect(loadTab(st)).toBe('monitor');
  });
  it('하위 칸 — 모니터 4개(성능 포함) · 구성은 도구 키로 권한을 본다 · 고급 설정은 수집하지 않음(tool 없음)', () => {
    expect(MONITOR_SUBS.map((s) => s.k)).toEqual(['alarms', 'events', 'tasks', 'perf']);
    expect(CONFIGURE_SUBS.find((s) => s.k === 'advanced').tool).toBeNull();
    expect(CONFIGURE_SUBS.filter((s) => s.tool).map((s) => s.tool)).toEqual(['licenses', 'cluster-check', 'vm-tags', 'cert-expiry', 'host-hygiene']);
  });
});

describe('알람 — 포탈 규칙', () => {
  it('문구가 vCenter 알람이 아니라고 말한다', () => {
    expect(PORTAL_ALARM_RULE_TEXT).toMatch(/포탈이 수집값으로 판정한 규칙/);
    expect(PORTAL_ALARM_RULE_TEXT).toMatch(/vCenter 자체 트리거 알람은 수집하지 않습니다/);
  });
  it('심각도별 개수 · 모르는 심각도는 정보로 세지 않는다 · 다른 vCenter 행은 뺀다', () => {
    const items = [{ vcenterId: 'a', severity: 'critical' }, { vcenterId: 'a', severity: 'warning' }, { vcenterId: 'a', severity: 'weird' }, { vcenterId: 'b', severity: 'info' }, null];
    const mine = alarmsOf(items, 'a');
    expect(mine.length).toBe(3);
    expect(alarmCounts(mine)).toEqual({ critical: 1, warning: 1, info: 0, other: 1, total: 3 });
    expect(alarmCounts(undefined).total).toBe(0);
  });
});

describe('라이선스', () => {
  it('키는 뒤 5자만 · 없으면 —', () => {
    expect(maskLicenseKey('ABCDE-12345-FGHIJ-67890-7K2QD')).toBe('…-7K2QD');
    expect(maskLicenseKey('')).toBe('—');
    expect(maskLicenseKey(null)).toBe('—');
  });
  it('사용률 — 못 읽은 값 · 총량 0 은 null(0% 로 지어내지 않는다)', () => {
    expect(licenseUsePct({ used: 24, total: 32 })).toBe(75);
    expect(licenseUsePct({ used: null, total: 32 })).toBeNull();
    expect(licenseUsePct({ used: '', total: 32 })).toBeNull();
    expect(licenseUsePct({ used: 0, total: 0 })).toBeNull();
    expect(licenseUsePct({ used: 0, total: 10 })).toBe(0);
  });
  it('만료 — 영구 · 지남 · 임박 · 해석 불가', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    expect(licenseExpiryText('never', now).text).toBe('영구');
    expect(licenseExpiryText('', now).text).toBe('—');
    expect(licenseExpiryText('2026-11-01', now)).toMatchObject({ sev: 'expired' });
    expect(licenseExpiryText('2026-11-20', now)).toMatchObject({ sev: 'crit', days: 15 });
    expect(licenseExpiryText('2027-01-20', now)).toMatchObject({ sev: 'warn' });
    expect(licenseExpiryText('2028-01-01', now)).toMatchObject({ sev: 'ok' });
    expect(licenseExpiryText('언젠가', now)).toMatchObject({ sev: null, days: null });
  });
});

describe('데이터 센터 묶음', () => {
  const hosts = [
    { id: '1', name: 'h1', vcDatacenter: 'DC-A', cluster: 'CL1', vmCount: 3 },
    { id: '2', name: 'h2', vcDatacenter: 'DC-A', cluster: 'CL2', vmCount: 2 },
    { id: '3', name: 'h3', vcDatacenter: 'DC-B', cluster: 'CL3', vmCount: null },
    { id: '4', name: 'h4', vcDatacenter: null, cluster: 'standalone', vmCount: 1 },
  ];
  it('vcDatacenter 로 묶고 · 못 따라간 호스트는 어느 데이터센터에도 더하지 않는다', () => {
    const g = groupByDatacenter(hosts);
    expect(g.datacenters.map((d) => d.name)).toEqual(['DC-A', 'DC-B']);
    expect(g.datacenters[0]).toMatchObject({ hostCount: 2, vmCount: 5 });
    expect(g.datacenters[0].clusters.map((c) => c.name)).toEqual(['CL1', 'CL2']);
    expect(g.datacenters[1].vmCount).toBeNull();               // VM 수를 못 읽으면 0 이 아니다
    expect(g.unknown).toMatchObject({ name: null, hostCount: 1, vmCount: 1 });
  });
  it('VM 수 판정은 호출부 것을 쓴다(Off VM 포함 설정)', () => {
    const g = groupByDatacenter(hosts, () => 10);
    expect(g.datacenters[0].vmCount).toBe(20);
  });
  it('빈 입력', () => {
    expect(groupByDatacenter(undefined)).toEqual({ datacenters: [], unknown: null });
  });
});

describe('확장 프로그램', () => {
  it('읽지 못함은 0개가 아니다 · 행 없음은 missing', () => {
    expect(extensionsState(null).state).toBe('missing');
    expect(extensionsState({ solutions: [], solutionsUnread: { why: 'error', text: '조회 실패' } })).toMatchObject({ state: 'unread', items: [], why: '조회 실패' });
    expect(extensionsState({ solutions: [{ key: 'a' }, 'x', null] })).toMatchObject({ state: 'ok', items: [{ key: 'a' }] });
  });
  it('회사로 VMware/타사 분류 · fleet 안 같은 key 수와 버전 종류', () => {
    expect(extensionVendor({ company: 'VMware, Inc.', key: 'com.vmware.vsan' })).toBe('vmware');
    expect(extensionVendor({ company: 'Broadcom', key: 'x' })).toBe('vmware');
    expect(extensionVendor({ company: 'Veeam Software', key: 'com.veeam.vbr' })).toBe('other');
    const f = fleetKeyStats([
      { vcenterId: 'a', solutions: [{ key: 'k1', version: '1' }, { key: 'k2', version: '1' }] },
      { vcenterId: 'b', solutions: [{ key: 'k1', version: '2' }] },
    ]);
    expect(f.get('k1')).toEqual({ vcenters: 2, versions: 2 });
    expect(f.get('k2')).toEqual({ vcenters: 1, versions: 1 });
  });
});

describe('업데이트 — 버전 · 빌드만', () => {
  it('버전+빌드 조합별 대수 · 버전 모름은 따로', () => {
    const r = esxiVersionRows([{ version: '8.0.3', build: '1' }, { version: '8.0.3', build: '1' }, { version: '7.0.3', build: '9' }, { version: '' }, { version: 'unknown' }]);
    expect(r.rows).toEqual([{ version: '8.0.3', build: '1', count: 2 }, { version: '7.0.3', build: '9', count: 1 }]);
    expect(r.unknown).toBe(2);
  });
  it('버전 비교 — 못 읽으면 null', () => {
    expect(versionNewer('8.0.3', '8.0.2')).toBe(true);
    expect(versionNewer('7.0.3', '8.0.2')).toBe(false);
    expect(versionNewer('8.0', '8.0.0')).toBe(false);
    expect(versionNewer('', '8.0')).toBeNull();
  });
});

describe('권한 변경 이벤트 · 크기 · 인벤토리', () => {
  it('권한 분류만', () => {
    expect(permEvents([{ category: '권한' }, { category: '전원' }, null]).length).toBe(1);
  });
  it('gbText — null 은 단위 없는 —', () => {
    expect(gbText(null)).toBe('—');
    expect(gbText('')).toBe('—');
    expect(gbText(512)).toBe('512 GB');
    expect(gbText(2048)).toBe('2.0 TB');
  });
  it('인벤토리 — 못 받은 목록은 null · 접근 불가/못 읽은 DS 는 용량 합에서 빼고 센다', () => {
    const inv = inventoryCounts({
      hosts: [{ connectionState: 'CONNECTED', vcDatacenter: 'D', cluster: 'C' }, { connectionState: 'DISCONNECTED', vcDatacenter: null, cluster: 'standalone' }],
      vms: [{ powerState: 'POWERED_ON' }, { powerState: 'POWERED_OFF' }, { powerState: 'POWERED_OFF', template: true }],
      datastores: [{ capacityGB: 100, usedGB: 50 }, { capacityGB: 100, usedGB: null }, { capacityGB: 100, usedGB: 10, accessible: false }],
      networks: [], hostsOk: true, vmsOk: true, dsOk: true, netOk: false,
    });
    expect(inv).toMatchObject({ datacenters: 1, dcUnknownHosts: 1, clusters: 1, hosts: 2, hostsDisconnected: 1, vms: 3, vmsOn: 1, vmsOff: 1, templates: 1, datastores: 3, dsInaccessible: 1, networks: null });
    expect(inv.storage).toEqual({ capGB: 100, usedGB: 50, pct: 50, unread: 2 });
    const none = inventoryCounts({ hostsOk: false, vmsOk: false, dsOk: false, netOk: false });
    expect(none).toMatchObject({ hosts: null, vms: null, datastores: null, storage: null });
  });
  it('shortTs — 못 읽으면 —', () => {
    expect(shortTs('nope')).toBe('—');
    expect(shortTs(null)).toBe('—');
    expect(shortTs(Date.UTC(2026, 10, 5, 3, 4))).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('CSS 이름 충돌 — 새 클래스가 기존 vCenter 트리 규칙과 겹치지 않는다(v2.895 회귀)', () => {
  it('.vcd-sub(트리 보조 문구) · .vcd-row(옛 표 행)는 한 번씩만 정의되고 하위 칸 목록은 .vcd-subnav', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../styles.css'), 'utf8');
    const defs = (sel) => (css.match(new RegExp(`(^|\\n)\\s*\\${sel}\\s*\\{`, 'g')) || []).length;
    expect(defs('.vcd-sub')).toBe(1);      // 트리 행 보조 문구 — 하위 칸 목록이 같은 이름을 쓰면 트리 행에 여백 · 세로 줄이 생긴다(실제 발생)
    expect(defs('.vcd-row')).toBe(1);
    expect(defs('.vcd-subnav')).toBeGreaterThanOrEqual(1);
    const parts = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), './VcdParts.jsx'), 'utf8');
    expect(parts).toMatch(/className="vcd-subnav"/);
    expect(parts).not.toMatch(/className="vcd-sub"/);
  });
});

describe('v2.901 정정 — 이미 수집하는 값을 화면이 수집하지 않는다고 말하지 않는다', () => {
  const src = async (f) => { const fs = await import('node:fs'); const path = await import('node:path'); return fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), f), 'utf8'); };
  it('성능 튜닝 구성 권장 — NIC 유형(VMXNET3 권장)은 VM 구성 점검이 판정한다(v2.901 nic-legacy)', async () => {
    const t = await src('./TuningTabs.jsx');
    expect(t).not.toMatch(/네트워크 어댑터 유형\(vmxnet3 여부\)은 수집하지 않습니다/);
    expect(t).toMatch(/VMXNET3 권장\)은 VM 구성 점검이 판정합니다/);
  });
  it('vCenter 요약 — 적용 가능 패치는 업데이트 탭(v2.898 부터 수집)', async () => {
    const s = await src('./SummaryTab.jsx');
    expect(s).not.toMatch(/\['적용 가능 패치', <span className="badge gray" key="p">수집하지 않음/);
    expect(s).not.toMatch(/패치 · vLCM 준수 상태는 수집하지 않습니다/);
    expect(s).toMatch(/onGo\('updates'\)/);
  });
});

// v2.958(사용자 요청 2026-11-10) — 허브(법인 카드 · 표)에서 들어오면 '요약' 부터 · '호스트 및 클러스터' · 'VM' 탭 강조.
describe('허브 진입 탭 · 강조 탭(v2.958)', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
  it('entryTab — 허브 진입은 요약이고 기억값으로도 남긴다 · 진입값이 없으면 마지막 본 탭 · 모르는 값은 기억값', () => {
    const st = mem();
    saveTab(st, 'vms');
    expect(entryTab(null, st)).toBe('vms');
    expect(entryTab(HUB_ENTRY_TAB, st)).toBe('summary');
    expect(loadTab(st)).toBe('summary');
    expect(entryTab('nope', st)).toBe('summary');
    expect(entryTab(undefined, null)).toBe(DEFAULT_TAB);
  });
  it('HOT_TABS 는 호스트 및 클러스터 · VM — 열려 있지 않을 때만 .vcd-tab-hot', () => {
    expect([...HOT_TABS]).toEqual(['hosts', 'vms']);
    expect(VCD_TABS.filter((t) => HOT_TABS.includes(t.k)).map((t) => t.label)).toEqual(['호스트 및 클러스터', 'VM']);
    expect(tabClass('hosts', false)).toBe('tab vcd-tab-hot');
    expect(tabClass('vms', false)).toBe('tab vcd-tab-hot');
    expect(tabClass('hosts', true)).toBe('login-btn');
    expect(tabClass('summary', false)).toBe('tab');
  });
  it('CSS — 펄스는 모션 줄임이면 멈춘다(정지 강조만)', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.vcd-views \.vcd-tab-hot \{[^}]*animation: vcd-tab-hot/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.vcd-views \.vcd-tab-hot \{ animation: none/);
  });
});
