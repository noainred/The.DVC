// v2.622 감사 그룹 F — 웹 화면 결함 회귀(WEB-01~08 · RECENT-04 · RECENT-05 · LEFT-05).
// 판정·문구는 각 화면이 export 한 순수 함수를 실제로 호출한다(node 환경 — DOM 없음). 경쟁(늦은 응답) 가드처럼
// 효과(useEffect) 안에서만 드러나는 부분은 소스를 주석 제거 후 검사해 가드의 존재를 함께 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { gpuTargetGate } from './GpuGuestSettings.jsx';
import { dsGbText, dsTotals } from './Datastores.jsx';
import { tb as entityTb } from '../components/EntityDetail.jsx';
import { tb as vcdTb } from './VCenterDetail.jsx';
import { edgeUsersView } from './EdgeUserDeploy.jsx';
import { vmCredRowsMatch } from './gpu-guest/VmCredManager.jsx';
import { proxyListEmptyText } from './ProxySettings.jsx';
import { v5SearchFootText } from '../version_5/V5Shell.jsx';
import { ipScanAccept } from './tools/IpamSettings.jsx';
import { detailServerOf, bmcLabel, serverVendorOf } from './tools/serverVendorText.js';
import { perfPartialNote, perfPartialMark } from './tools/sanSwitchPorts.js';
import { edgeConfigBadge } from './PortalBackup.jsx';

const src = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('WEB-01 — GPU 게스트 설정: 대상 전환 시 이전 대상 폼으로 저장하지 않는다', () => {
  it('폼이 지금 대상의 값일 때만 저장 가능', () => {
    expect(gpuTargetGate({ deployAgent: '', formFor: '' })).toMatchObject({ ready: true, canSave: true });
    expect(gpuTargetGate({ deployAgent: 'EDGE-B', formFor: 'EDGE-B' })).toMatchObject({ ready: true, canSave: true });
    // 로컬 폼이 남은 채 대상이 EDGE-B — 조회 대기/실패 모두 저장 불가
    expect(gpuTargetGate({ deployAgent: 'EDGE-B', formFor: '' })).toMatchObject({ ready: false, canSave: false, state: 'loading' });
    expect(gpuTargetGate({ deployAgent: 'EDGE-B', formFor: '', loadErr: 'HTTP 500' })).toMatchObject({ canSave: false, state: 'error' });
    expect(gpuTargetGate({ deployAgent: '', formFor: null })).toMatchObject({ canSave: false });
  });
  it('load 는 늦은 응답을 버리고, 전환 시 폼을 비우고, save 는 게이트를 본다', () => {
    const s = src('./GpuGuestSettings.jsx');
    expect(s).toMatch(/if \(stale\(\)\) return;/);
    expect(s).toMatch(/targetRef\.current = deployAgent;\s*setFormFor\(null\);\s*setForm\(null\);/);
    expect(s).toMatch(/if \(!gate\.canSave\) return;/);
  });
});

describe('WEB-02 — 데이터스토어: 사용량 결측은 "—" 이고 합계에서 뺀다', () => {
  it('세 화면의 용량 표기는 null 을 "—" 로', () => {
    for (const f of [dsGbText, entityTb, vcdTb]) {
      expect(f(null)).toBe('—');
      expect(f(undefined)).toBe('—');
      expect(f('')).toBe('—');
      expect(f(512)).toBe('512 GB');
      expect(f(2048)).toBe('2.0 TB');
      expect(f(0)).toBe('0 GB'); // 보고된 0 은 값이다
    }
  });
  it('합계는 사용량을 읽은 DS 만 — 뺀 개수를 밝힌다', () => {
    const rows = [
      { capacityGB: 100000, usedGB: null, freeGB: null, usagePct: null },
      { capacityGB: 1000, usedGB: 600, freeGB: 400 },
      { capacityGB: 1000, usedGB: 500, freeGB: 500 },
    ];
    const t = dsTotals(rows);
    expect(t).toMatchObject({ capGB: 2000, usedGB: 1100, freeGB: 900, usagePct: 55, known: 2, unknown: 1 });
    expect(t.capGB).toBe(t.usedGB + t.freeGB); // 용량 = 사용 + 여유
    const none = dsTotals([{ capacityGB: 10, usedGB: null }]);
    expect(none.usagePct).toBeNull(); // 읽은 DS 가 없으면 0% 가 아니라 null
    expect(none.unknown).toBe(1);
  });
});

describe('WEB-03 — 엣지 사용자 배포: 다른 대상의 목록을 새 대상 아래 그리지 않는다', () => {
  it('불러온 대상과 보기 대상이 다르면 행이 없다', () => {
    const loaded = { target: '*', users: [{ username: 'globaladmin' }], err: null };
    expect(edgeUsersView('EDGE-X', loaded)).toEqual({ state: 'loading', rows: [], err: null });
    expect(edgeUsersView('*', loaded).rows).toHaveLength(1);
    expect(edgeUsersView('EDGE-X', { target: 'EDGE-X', users: [], err: 'edge store read failed' }))
      .toEqual({ state: 'error', rows: [], err: 'edge store read failed' });
    expect(edgeUsersView('EDGE-X', null).state).toBe('loading');
  });
  it('제거·수정은 준비된 목록에서만, 요청 세대 가드가 있다', () => {
    const s = src('./EdgeUserDeploy.jsx');
    expect(s).toMatch(/const stale = \(\) => mySeq !== seqRef\.current \|\| t !== viewRef\.current;/);
    expect((s.match(/if \(view\.state !== 'ready'\) return;/g) || []).length).toBe(2);
    expect(s).not.toMatch(/setUsers\(/);
  });
});

describe('WEB-04 — VM별 계정: 다른 vCenter 의 행을 저장하지 않는다', () => {
  it('행을 불러온 vCenter·대상이 지금 값과 같을 때만', () => {
    expect(vmCredRowsMatch({ selVc: 'B', deployAgent: '', rowsFor: { vcId: 'A', agent: '' } })).toBe(false);
    expect(vmCredRowsMatch({ selVc: 'B', deployAgent: '', rowsFor: { vcId: 'B', agent: '' } })).toBe(true);
    expect(vmCredRowsMatch({ selVc: 'B', deployAgent: 'E1', rowsFor: { vcId: 'B', agent: '' } })).toBe(false);
    expect(vmCredRowsMatch({ selVc: 'B', deployAgent: 'E1', rowsFor: { vcId: 'B', agent: 'E1' } })).toBe(true);
    expect(vmCredRowsMatch({ selVc: '', deployAgent: '', rowsFor: null })).toBe(false);
  });
  it('loadVms 는 늦은 응답을 버리고 saveCreds·runTest 는 게이트를 본다', () => {
    const s = src('./gpu-guest/VmCredManager.jsx');
    expect(s).toMatch(/if \(stale\(\)\) return;\s*setRowsFor\(\{ vcId, agent \}\);/);
    expect((s.match(/if \(!rowsMatch\)/g) || []).length).toBe(2);
  });
});

describe('WEB-05 — DS 추이: 늦은 이전 범위 응답이 새 선택을 덮지 않는다', () => {
  it('refresh 는 useLatest 로 감싸고 범위 변경 시 데이터를 비운다', () => {
    const s = src('./tools/StorageTrackTool.jsx');
    expect(s).toMatch(/const runLatest = useLatest\(\);/);
    expect(s).toMatch(/const refresh = \(\) => runLatest\(fetchJson\('\/tools\/vm-track'/);
    expect(s).toMatch(/useEffect\(\(\) => \{ setData\(null\); setError\(null\); refresh\(\);/);
  });
});

describe('WEB-06 — 프록시 목록 조회 실패는 "없음" 이 아니다', () => {
  it('문구', () => {
    expect(proxyListEmptyText(null).text).toContain('추가 프록시가 없습니다');
    const e = proxyListEmptyText('HTTP 500');
    expect(e.tone).toBe('error');
    expect(e.text).toContain('불러오지 못했습니다');
    expect(e.text).not.toContain('추가 프록시가 없습니다');
    expect(e.text).not.toMatch(/`|\*\*/);
  });
  it('조회 catch 가 빈 목록만 만들고 끝나지 않는다', () => {
    const s = src('./ProxySettings.jsx');
    expect(s).not.toMatch(/\.catch\(\(\) => setProxies\(\[\]\)\)/);
    expect(s).toMatch(/setProxiesErr\(e\?\.message \|\| String\(e\)\)/);
  });
});

describe('WEB-07 — V5 검색 하단 안내가 🔒 행과 모순되지 않는다', () => {
  it('잠긴 결과가 있을 때만 그 사실을 말한다', () => {
    expect(v5SearchFootText([])).toBe('↑↓ 이동 · Enter 열기 · Esc 닫기');
    expect(v5SearchFootText([{ locked: false }, { locked: true }, { locked: true }])).toContain('🔒 표시 메뉴 2개는 권한이 없어 열 수 없습니다');
    expect(v5SearchFootText(null)).not.toContain('나오지 않습니다');
    expect(src('../version_5/V5Shell.jsx')).not.toContain('권한이 없는 메뉴는 목록에 나오지 않습니다');
  });
});

describe('WEB-08 — IP 스캔: 이전 에이전트 응답이 새 에이전트 폼을 채우지 않는다', () => {
  it('판정 + load·save 가드', () => {
    expect(ipScanAccept('A', 'B')).toBe(false);
    expect(ipScanAccept('B', 'B')).toBe(true);
    expect(ipScanAccept(null, 'B')).toBe(false);
    const s = src('./tools/IpamSettings.jsx');
    // v2.636: 폼은 편집 초안 훅(d.load)으로 채운다 — 가드(응답 에이전트 == 지금 에이전트)는 그대로 앞에 있어야 한다.
    expect(s).toMatch(/if \(!ipScanAccept\(ag, agentRef\.current\)\) return;\s*if \(first\) \{ (?:setS|d\.load)\(r\.settings\); setSFor\(ag\); \}/);
    expect(s).toMatch(/if \(!ipScanAccept\(sFor, agent\)\)/);
    expect(s).toMatch(/const switchAgent = \(a\) => \{ agentRef\.current = a;/);
  });
});

describe('RECENT-04 — 벤더를 모르는 행에서 연 상세는 iDRAC 이라 부르지 않는다', () => {
  const list = [{ id: 'h1', vendor: 'hpe' }, { id: 'd1', vendor: 'dell' }, { id: 'r1', vendor: '', remote: true }];
  it('행이 벤더를 말하면 그대로', () => {
    expect(bmcLabel(detailServerOf({ id: 'h1', name: 'x', vendor: 'hpe' }, null))).toBe('HPE iLO');
    expect(bmcLabel(detailServerOf({ id: 'o', type: 'ome' }, null))).toBe('OME');
  });
  it('온도·GPU 행(vendor 없음)은 목록에서 찾고, 없으면 BMC', () => {
    expect(bmcLabel(detailServerOf({ serverId: 'h1', server: 'srv-h' }, list))).toBe('HPE iLO');
    expect(detailServerOf({ serverId: 'h1', server: 'srv-h' }, list)).toMatchObject({ id: 'h1', name: 'srv-h' });
    expect(bmcLabel(detailServerOf({ id: 'd1' }, list))).toBe('iDRAC');
    expect(bmcLabel(detailServerOf({ id: 'r1' }, list))).toBe('BMC');
    expect(bmcLabel(detailServerOf({ id: 'zz' }, list))).toBe('BMC');
    expect(bmcLabel(detailServerOf({ id: 'h1' }, null))).toBe('BMC'); // 목록 전 — Dell 로 단정하지 않는다
  });
  it('vendorUnknown 표지 없는 중앙 행의 기존 규약(Dell)은 그대로', () => {
    expect(serverVendorOf({ id: 'x' })).toBe('dell');
    expect(serverVendorOf({ id: 'x', vendorUnknown: true })).toBe('unknown');
  });
  it('HardwareTools 의 두 진입점이 같은 열기 함수를 쓴다', () => {
    const s = src('./tools/HardwareTools.jsx');
    expect(s).not.toMatch(/setDetail\(\{ id: s\.id, name: s\.name \}\)/);
    expect((s.match(/= useDetailOpener\(setDetail\)/g) || []).length).toBe(2);
  });
});

describe('RECENT-05 — 팹 A/B 합산의 부분 합 구간을 화면이 말한다', () => {
  it('partialBuckets 합계와 표지', () => {
    expect(perfPartialNote([])).toBeNull();
    expect(perfPartialNote([{ partialBuckets: 0 }, {}])).toBeNull();
    const n = perfPartialNote([{ partialBuckets: 3 }, { partialBuckets: 0 }, { partialBuckets: 5 }]);
    expect(n).toMatchObject({ series: 2, buckets: 8 });
    expect(n.text).toContain('계열 2개 · 구간 8개');
    expect(n.text).not.toMatch(/`|\*\*/);
    expect(perfPartialMark({ partialBuckets: 4 })).toBe('부분 4구간');
    expect(perfPartialMark({ partialBuckets: null })).toBe('');
  });
  it('스토리지 사용량 분석 화면이 쓴다', () => {
    const s = src('./tools/SanSwitchTool.jsx');
    expect(s).toMatch(/perfPartialNote\(series\)/);
    expect(s).toMatch(/perfPartialMark\(s\)/);
  });
});

describe('LEFT-05 — 직전 사본을 유지한 엣지는 초록이 아니다', () => {
  it('retained>0 이면 호박색 + 문구', () => {
    expect(edgeConfigBadge({ agent: 'e', files: 10 })).toMatchObject({ cls: 'green', suffix: '' });
    expect(edgeConfigBadge({ agent: 'e', files: 10, retained: 0 }).cls).toBe('green');
    const b = edgeConfigBadge({ agent: 'e', files: 10, retained: 3 });
    expect(b.cls).toBe('amber');
    expect(b.suffix).toContain('직전 사본 유지 3개(낡은 값)');
    expect(b.title).not.toMatch(/`|\*\*/);
  });
});
