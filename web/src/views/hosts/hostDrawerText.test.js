// v2.975 — 호스트 드로어 글자 · 배치(순수): 신호 줄은 호스트 표의 사유(reasonBadges)와 **같은 목록 · 같은 순서**(판정 한 벌 대조) ·
//   못 받은 점검 묶음은 '없음' 이 아니다 · 못 읽은 값은 '—' + 단위 없음 · 끊긴 호스트는 사용률이 없다.
import { describe, it, expect } from 'vitest';
import { hostDot, hostDown, hostSignalRows, checksGap, hostTiles, hostKvRows, shortTime } from './hostDrawerText.js';
import { reasonBadges, secCountsOf } from '../hostChecksText.js';
import { CPU_ATTENTION_PCT } from '../hostTriage.js';

// 기준 시각은 정시 경계로(docs/rules/common.md) — 업타임 일수가 실행 시각에 흔들리지 않게.
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const host = (o = {}) => ({
  id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a-01', cluster: 'CL-A', vcDatacenter: 'DC-A', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 76800, cpuUsageMhz: 76032, cpuUsagePct: 99, memTotalMB: 262144, memUsageMB: 154624, memUsagePct: 59,
  vmCount: 14, version: '8.0.3', build: '24022510', vendor: 'Dell Inc.', model: 'PowerEdge R760', serviceTag: 'ABC1234', cpuModel: 'AMD EPYC 9354 32-Core Processor',
  hbas: [{ name: 'vmhba1', type: 'FibreChannel' }], gpus: [], nics: [{ device: 'vmnic0', link: true }, { device: 'vmnic3', link: false }],
  powerWatts: 458, powerSource: 'idrac', tempC: 36.9, tempMaxC: 67.8, bootTime: NOW - 2 * 24 * HOUR - HOUR,
  hcfg: {
    ntpServers: ['10.0.0.1'], services: { ntpd: { running: true }, ssh: { running: false, policy: 'off' }, shell: { running: false } }, syslogHost: 'udp://log:514',
    acceptance: 'partner', lockFailures: 5, mob: false, lockdown: 'normal', shellTimeout: 900, diagPartition: true, bsodTimeout: 120,
    mp: { luns: 14, shared: 12, paths: 48, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [] },
    net: { switches: [{ name: 'DSwitch-Prod', kind: 'dvs', pgs: 2, uplinks: ['vmnic0', 'vmnic3'] }], pgs: [] },
  },
  ...o,
});
const CHECKS = { 'vc-a:host-1': { hw: { state: 'ok', bad: 0, health: 'OK' }, boot: null, vm: { n: 13, on: 12, templates: 1, vcpu: 50, memMB: 221184, vcpuUnknown: 0, memUnknown: 0 }, veeam: { y: 9, n: 4, unknown: 0, total: 13 } } };
const rowsOf = (h, checks = null) => hostSignalRows(h, { sec: secCountsOf(h, NOW), checks });

describe('머리 점 · 끊김', () => {
  it('상태마다 색 · 이름 — 모르는 상태는 색을 올리지 않는다', () => {
    expect(hostDot({ connectionState: 'CONNECTED' })).toEqual(['var(--green)', '연결됨']);
    expect(hostDot({ connectionState: 'MAINTENANCE' })[0]).toBe('var(--amber)');
    expect(hostDot({ connectionState: 'DISCONNECTED' })).toEqual(['var(--red)', '끊김']);
    expect(hostDot({ connectionState: 'NOT_RESPONDING' })).toEqual(['var(--red)', '무응답']);
    expect(hostDot({})).toEqual(['var(--text-faint)', '상태 모름']);
    expect(hostDot(null)[1]).toBe('상태 모름');
    expect(hostDown({ connectionState: 'DISCONNECTED' })).toBe(true);
    expect(hostDown({ connectionState: 'NOT_RESPONDING' })).toBe(true);
    expect(hostDown({ connectionState: 'MAINTENANCE' })).toBe(false);
    expect(hostDown(null)).toBe(false);
  });
});

describe('hostSignalRows — 호스트 표 사유와 같은 판정(한 벌)', () => {
  it('kind · 짧은 글자 · 순서가 reasonBadges 와 같다(여러 상태)', () => {
    const cases = [
      [host(), CHECKS], [host(), null],
      [host({ connectionState: 'MAINTENANCE', cpuUsagePct: 0 }), CHECKS],
      [host({ connectionState: 'DISCONNECTED', cpuUsagePct: 0 }), CHECKS],
      [host({ cpuUsagePct: 40, nics: [{ device: 'vmnic0', link: true }, { device: 'vmnic3', link: true }] }), { 'vc-a:host-1': { ...CHECKS['vc-a:host-1'], veeam: { y: 13, n: 0, unknown: 0, total: 13 } } }],
      [host({ cpuUsagePct: 40 }), { 'vc-a:host-1': { hw: { state: 'fault', bad: 2, health: 'Critical' }, boot: { kind: 'unexpected', bootTime: NOW - 5 * HOUR }, vm: CHECKS['vc-a:host-1'].vm, veeam: null } }],
    ];
    for (const [h, checks] of cases) {
      const sec = secCountsOf(h, NOW);
      expect(hostSignalRows(h, { sec, checks }).map((r) => [r.kind, r.badge])).toEqual(reasonBadges(h, { sec, checks }).map((b) => [b.kind, b.label]));
    }
  });
  it('CPU 초과 — 제목의 숫자는 CPU_ATTENTION_PCT · 사실 줄에 값과 MHz · 성능 바로가기', () => {
    const r = rowsOf(host()).find((x) => x.kind === 'cpu');
    expect(r.label).toBe(`CPU ${CPU_ATTENTION_PCT}% 초과`);
    expect(r.badge).toBe('CPU 99%');
    expect(r.fact).toBe('CPU 99% · 76,032 / 76,800 MHz');
    expect(r.tone).toBe('crit');
    expect(r.tab).toEqual(['monitor', '성능']);
    expect(rowsOf(host({ cpuUsageMhz: null })).find((x) => x.kind === 'cpu').fact).toBe('CPU 99%');   // 못 읽은 MHz 는 붙이지 않는다
    expect(rowsOf(host({ cpuUsagePct: CPU_ATTENTION_PCT })).some((x) => x.kind === 'cpu')).toBe(false);   // 초과만
  });
  it('업링크 끊김 — 사실 줄은 구성 점검의 findingDetail(스위치/NIC) · 네트워크 바로가기', () => {
    const r = rowsOf(host()).find((x) => x.kind === 'uplink');
    expect(r.fact).toBe('DSwitch-Prod/vmnic3');
    expect(r.desc).not.toBe('');
    expect(r.tab).toEqual(['network', '네트워크']);
  });
  it('점검 묶음 신호 — Veeam · 예기치 않은 재부팅 · iDRAC 부품은 받은 값으로만', () => {
    const v = rowsOf(host(), CHECKS).find((x) => x.kind === 'veeam-n');
    expect(v.fact).toBe('VM 13대 중 4대 · 있음 9');
    expect(v.tone).toBe('warn');
    expect(rowsOf(host(), null).some((x) => x.kind === 'veeam-n')).toBe(false);   // 묶음이 없으면 신호도 없다(없음으로 세지 않는 것은 checksGap 이 말한다)
    const c2 = { 'vc-a:host-1': { hw: { state: 'fault', bad: 2, health: 'Critical' }, boot: { kind: 'unexpected', bootTime: NOW - 5 * HOUR }, veeam: { y: 1, n: 2, unknown: 3, total: 6 } } };
    const rows = rowsOf(host({ cpuUsagePct: 10 }), c2);
    expect(rows.find((x) => x.kind === 'hw').fact).toBe('iDRAC 장애 2 · 시스템 상태 Critical');
    expect(rows.find((x) => x.kind === 'unexpected').fact).toMatch(/^부팅 \d{2}-\d{2} \d{2}:\d{2}$/);
    expect(rows.find((x) => x.kind === 'unexpected').tab).toEqual(['monitor', '이벤트']);
    expect(rows.find((x) => x.kind === 'veeam-n').fact).toBe('VM 6대 중 2대 · 있음 1 · 확인 불가 3');
  });
  it('점검 모드 · 끊김 — 제목 · 톤 · 바로가기 없음', () => {
    const m = rowsOf(host({ connectionState: 'MAINTENANCE', cpuUsagePct: 0 }))[0];
    expect([m.kind, m.label, m.tone, m.tab]).toEqual(['maint', '점검(Maintenance) 모드', 'warn', null]);
    const d = rowsOf(host({ connectionState: 'NOT_RESPONDING', cpuUsagePct: 0 }))[0];
    expect([d.kind, d.label, d.tone]).toEqual(['down', '무응답', 'crit']);
  });
  it('문구에 백틱 · 별표가 없다', () => {
    const c2 = { 'vc-a:host-1': { hw: { state: 'warn', bad: 1 }, boot: { kind: 'unexpected', bootTime: NOW }, veeam: { y: 0, n: 1, unknown: 0, total: 1 } } };
    for (const h of [host(), host({ connectionState: 'MAINTENANCE' }), host({ connectionState: 'DISCONNECTED' })]) {
      for (const r of rowsOf(h, c2)) expect(`${r.label}${r.fact}${r.desc}`).not.toMatch(/[`*]/);
    }
  });
});

describe('checksGap — 못 받은 묶음은 이상 없음이 아니다', () => {
  it('읽는 중은 [](따로 확인 중이라 말한다) · 실패 · 그 호스트가 없으면 셋 다', () => {
    expect(checksGap({ loading: true }, 'x')).toEqual([]);
    expect(checksGap(null, 'x')).toEqual([]);
    expect(checksGap({ error: 'boom' }, 'x')).toHaveLength(3);
    expect(checksGap({ byId: {} }, 'x')).toHaveLength(3);
  });
  it('권한으로 빠진 키(hw · boot) · 수집 안 된 Veeam(null)만 고른다 · 다 받았으면 []', () => {
    expect(checksGap({ byId: CHECKS }, 'vc-a:host-1')).toEqual([]);
    expect(checksGap({ byId: { h: { boot: null, veeam: { y: 0, n: 0, unknown: 0, total: 0 } } } }, 'h')).toEqual(['iDRAC 부품 상태(관리자 판본)']);
    expect(checksGap({ byId: { h: { hw: { state: 'none' }, veeam: null } } }, 'h')).toEqual(['재부팅 판정(구성 점검 도구 권한)', 'Veeam 대조(수집 안 됨)']);
    // boot:null 은 '판정 행 없음'(키는 있다) — 못 받은 것이 아니다
    expect(checksGap({ byId: { h: { hw: { state: 'ok' }, boot: null, veeam: { y: 1, n: 0, unknown: 0, total: 1 } } } }, 'h')).toEqual([]);
  });
});

describe('hostTiles — 못 읽은 값은 null(화면이 — 로 그린다)', () => {
  it('정상 호스트 · 점검 묶음이 있으면 VM 줄을 채운다', () => {
    const t = hostTiles(host(), CHECKS['vc-a:host-1']);
    expect(t.cpu).toEqual({ pct: 99, sub: '76.0 / 76.8 GHz' });   // 좁은 타일 — 한 줄에 한 가지(코어 수는 하드웨어 · 배치)
    expect(t.mem).toEqual({ pct: 59, sub: '151 / 256 GB' });
    expect(t.vm).toEqual({ n: 14, subs: ['켜짐 12 · 꺼짐 1', '템플릿 1', 'vCPU 50 할당', '코어 대비 1.6 : 1'] });
    expect(hostTiles(host(), { vm: { n: 3, on: 3, templates: 0, vcpu: 8 } }).vm.subs).toEqual(['켜짐 3 · 꺼짐 0', 'vCPU 8 할당', '코어 대비 0.3 : 1']);   // 템플릿이 없으면 그 줄이 없다
    expect(t.power).toEqual({ watts: 458, src: 'iDRAC 실측', temp: '36.9℃ · 최고 67.8℃' });
  });
  it('점검 묶음이 없으면 켜짐 · 할당 줄을 비운다(지어내지 않는다)', () => {
    const t = hostTiles(host(), null);
    expect(t.vm).toEqual({ n: 14, subs: [] });
  });
  it('끊긴 호스트 — 사용률 null · 사용량 글자 없음(코어 · 용량만) · 전력 0 은 값이 아니다', () => {
    const t = hostTiles(host({ connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0, powerWatts: 0, tempC: null, tempMaxC: null }), null);
    expect(t.cpu).toEqual({ pct: null, sub: '32코어' });
    expect(t.mem).toEqual({ pct: null, sub: '256 GB' });
    expect(t.power).toEqual({ watts: null, src: '', temp: '' });
  });
  it("빈 문자열 · null 은 0 이 아니다", () => {
    const t = hostTiles({ connectionState: 'CONNECTED', cpuUsagePct: '', memUsagePct: null, vmCount: '', cpuCores: null, powerWatts: '', tempC: '' }, null);
    expect(t.cpu.pct).toBe(null);
    expect(t.mem.pct).toBe(null);
    expect(t.vm.n).toBe(null);
    expect(t.cpu.sub).toBe('코어 수 모름');
    expect(t.mem.sub).toBe('용량 모름');
    expect(t.power.watts).toBe(null);
    expect(t.power.temp).toBe('');
  });
  it('전력 출처 — iDRAC 실측 · vCenter 추정(iDRAC 등록됨) · vCenter', () => {
    expect(hostTiles(host({ powerSource: '', idracBacked: true })).power.src).toBe('vCenter 추정');
    expect(hostTiles(host({ powerSource: '' })).power.src).toBe('vCenter');
  });
});

describe('hostKvRows — 하드웨어 · 배치', () => {
  const val = (rows, label) => rows.find((r) => r.label === label)?.value;
  it('모달의 기본 행이 빠지지 않는다 · 업타임 · NIC · 경로를 더한다', () => {
    const rows = hostKvRows(host(), NOW);
    expect(rows.map((r) => r.label)).toEqual(['제조사 / 모델', '서비스 태그', 'ESXi', '업타임', 'CPU', '메모리', 'CPU 모델', '물리 NIC', '스토리지 경로', 'HBA / GPU', '클러스터', 'vCenter', '데이터센터', 'vCenter ID']);
    expect(val(rows, '제조사 / 모델')).toBe('Dell Inc. / PowerEdge R760');
    expect(val(rows, 'ESXi')).toBe('8.0.3 (build 24022510)');
    expect(val(rows, '업타임')).toMatch(/^2일 · 부팅 \d{2}-\d{2} \d{2}:\d{2}$/);
    expect(val(rows, 'CPU')).toBe('2소켓 · 32코어 / 64스레드');
    expect(val(rows, '메모리')).toBe('256 GB · 사용 151 GB');
    expect(val(rows, '물리 NIC')).toBe('2개 · 링크 끊김 1');
    expect(val(rows, '스토리지 경로')).toBe('LUN 14 · 경로 48 · 죽은 경로 0');
    expect(val(rows, 'HBA / GPU')).toBe('1개 / 0개');
    expect(val(rows, 'vCenter ID')).toBe('vc-a:host-1');
    expect(rows.find((r) => r.label === 'CPU 모델').full).toBe(true);
  });
  it('iDRAC 실측 전력은 둘 다 있을 때만 한 줄', () => {
    expect(hostKvRows(host(), NOW).some((r) => r.label === 'iDRAC 실측 전력')).toBe(false);
    const rows = hostKvRows(host({ idracBacked: true, powerWattsIdrac: 471 }), NOW);
    expect(val(rows, 'iDRAC 실측 전력')).toBe('0.47 kW (471 W)');
  });
  it('못 읽은 값은 — 이고 단위를 붙이지 않는다 · 끊긴 호스트는 사용 메모리 · 업타임을 말하지 않는다', () => {
    const rows = hostKvRows({ id: 'x', connectionState: 'CONNECTED' }, NOW);
    for (const l of ['제조사 / 모델', '서비스 태그', 'ESXi', '업타임', 'CPU', '메모리', '물리 NIC', '스토리지 경로', '클러스터', 'vCenter', '데이터센터']) expect(val(rows, l)).toBe('—');
    const d = hostKvRows(host({ connectionState: 'DISCONNECTED' }), NOW);
    expect(val(d, '메모리')).toBe('256 GB');
    expect(val(d, '업타임')).toBe('—');
  });
});

describe('shortTime', () => {
  it('못 읽은 시각은 빈 문자열(0 · null · 빈 문자열을 1970 으로 그리지 않는다)', () => {
    for (const v of [null, undefined, '', 0, 'x']) expect(shortTime(v)).toBe('');
    expect(shortTime(NOW)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('v2.977 전체 점검 — vCPU 를 못 읽은 VM 이 있으면 할당 · 코어 대비는 부분 합이다', () => {
  it('‘이상’ 과 못 읽은 VM 수를 붙인다(HostDetail · Hosts 표와 같은 뜻)', async () => {
    const { hostTiles } = await import('./hostDrawerText.js');
    const host = { id: 'vc-a:host-1', cpuCores: 4, vmCount: 3, connectionState: 'connected', powerState: 'poweredOn' };
    const part = hostTiles(host, { vm: { n: 3, on: 2, templates: 0, vcpu: 8, memMB: 1024, vcpuUnknown: 2, memUnknown: 0 } }).vm.subs;
    expect(part).toContain('vCPU 8 할당 이상');
    expect(part.some((s) => /^코어 대비 .* 이상$/.test(s))).toBe(true);
    expect(part).toContain('vCPU 못 읽은 VM 2');
    const full = hostTiles(host, { vm: { n: 3, on: 2, templates: 0, vcpu: 12, memMB: 1024, vcpuUnknown: 0, memUnknown: 0 } }).vm.subs;
    expect(full).toContain('vCPU 12 할당');
    expect(full.some((s) => /이상|못 읽은/.test(s))).toBe(false);
  });
});
