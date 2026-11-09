/**
 * mock/demo/storage.js — 데모(DATA_SOURCE=mock) 스토리지 그룹(v2.708).
 *
 * 담당 화면: 스토리지 모니터링(storage-mon) · 스토리지 증가량(storage-growth) · 베어메탈 스토리지(bm-storage) ·
 * 데이터스토어 추이(storage-track) · 전체 소비 전력의 스토리지 탭(power-total).
 *
 * 규칙(mock/demo/flags.js 머리말과 같다):
 *  · mock 모드에서만 동작한다 — live/auto 에서는 아무것도 하지 않는다(`ensureStorageDemo` 가 null).
 *  · 등록부 시드는 **비어 있을 때만**, id 는 `mock-` 접두(live 폴러는 `isDemoId` 로 건너뛴다).
 *  · 장비·엣지에 접속하지 않는다 — 값은 장비 id·이름(demoHash)에서 결정적으로 만들고 시간에 따라 조금 흔들린다.
 *  · 시계열은 백필한다: 스토리지 일 롤업 400일 + 최근 7일 시간당 원시, 베어메탈 12시간 이력 365일,
 *    데이터스토어 추이(vmtrack) 60일(00·12시 슬롯) — 각 화면의 가장 긴 기본 기간을 채울 만큼.
 *  · 정직 규칙은 그대로다 — 한 대는 수집 실패, 두 대는 노드 비정상, VPLEX·Metro Node 는 용량 없음, 전력은 경로가 있는
 *    일부만 읽고 한 대는 '응답에 전원 필드 없음' 으로 둔다. 모든 스냅샷은 extra.mock:true · extra.demo:true 를 싣는다
 *    (화면의 MOCK 배지·경고가 그대로 뜬다 — 가짜를 진짜처럼 보이지 않게).
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';
// v2.730(검토 I-03): 영역 요약 모양은 실제 수집기(storage/areasCollector.js)와 같은 순수 모듈 하나 — import 없는 잎 모듈이라 순환이 생기지 않는다.
import { triedAreaEntry, notTriedAreaEntry, disabledAreaEntry, areaTotals } from '../../storage/onefsAreaSummary.js';
import { sanDemoArraySerial } from './sanswitch.js';                       // v2.951 — SAN 데모 어레이와 같은 시리얼
import { buildFeSample, isFePerfType } from '../../storage/collectors/arrayPerf.js'; // v2.951 — 어레이 프런트엔드 표본 모양(수집기와 같은 조립)

export { isMockMode };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TB = 1e12;

export const DEMO_PREFIX = 'mock-';
/** live 폴러가 건너뛸 데모 항목인가(id 접두). */
export const isDemoId = (id) => String(id || '').startsWith(DEMO_PREFIX);

/* ───────────── 장비 정의(결정적) ───────────── */

/**
 * 장비 사양 — vc 는 메인 스냅샷(목 생성기)의 vCenter id. 용량은 TB(10진), pct 는 지금 사용률, grow 는 하루 증가(사용률 %p).
 * fail: 최근 몇 시간 수집 실패 · badNodes: 비정상 노드 수 · power: 'read'|'no-field' (경로가 있는 타입만 의미).
 * areasStop: OneFS 영역 수집이 도중에 멈춘 모습 — { area, after(그 영역에서 성공한 엔드포인트 수), reason('deadline'|'auth'|'transport') }.
 */
const SPECS = [
  { k: 'ps-sel-01', type: 'isilon', name: 'PS-SEL-01', vc: 'vc-ap-northeast', method: 'ssh', nodes: 6, tb: 1200, pct: 68, grow: 0.09, power: 'read' },
  { k: 'ps-fra-01', type: 'isilon', name: 'PS-FRA-01', vc: 'vc-eu-central', method: 'api', nodes: 8, tb: 2100, pct: 74, grow: 0.06, badNodes: 1, power: 'read' },
  { k: 'ps-ash-01', type: 'isilon', name: 'PS-ASH-01', vc: 'vc-us-east', method: 'ssh', nodes: 5, tb: 900, pct: 81, grow: 0.12, power: 'read',
    // v2.730(검토 I-03): OneFS 영역 수집이 capacity 영역 첫 엔드포인트 뒤 시한에 걸린 모습(부분 수집·이후 미시도 화면 확인용).
    areasStop: { area: 'capacity', after: 1, reason: 'deadline' } },
  { k: 'ps-sha-01', type: 'isilon', name: 'PS-SHA-01', vc: 'vc-cn-east', method: 'ssh', nodes: 4, tb: 600, pct: 55, grow: 0.04, power: 'no-field' },
  { k: 'unity-sel-02', type: 'unity480', name: 'UNITY-SEL-02', vc: 'vc-ap-northeast', method: 'ssh', nodes: 2, tb: 117.5, pct: 25, grow: 0.05, power: 'read' },
  { k: 'unity-sjc-01', type: 'unity480', name: 'UNITY-SJC-01', vc: 'vc-us-west', method: 'api', nodes: 2, tb: 160, pct: 63, grow: 0.08, power: 'read' },
  { k: 'unity-dxb-01', type: 'unity480', name: 'UNITY-DXB-01', vc: 'vc-me-uae', method: 'ssh', nodes: 2, tb: 85, pct: 58, grow: 0.07, fail: 6, power: 'read' },
  { k: 'pst-dub-01', type: 'powerstore', name: 'PST-DUB-01', vc: 'vc-eu-west', method: 'api', nodes: 2, tb: 95, pct: 71, grow: 0.1, power: 'read' },
  { k: 'pst-sin-01', type: 'powerstore', name: 'PST-SIN-01', vc: 'vc-ap-southeast', method: 'api', nodes: 4, tb: 120, pct: 48, grow: 0.06, badNodes: 1, power: 'read' },
  { k: 'pst-bom-01', type: 'powerstore', name: 'PST-BOM-01', vc: 'vc-ap-south', method: 'ssh', nodes: 2, tb: 70, pct: 62, grow: 0.09 },
  { k: 'pmax-ash-01', type: 'powermax', name: 'PMAX-ASH-01', vc: 'vc-us-east', method: 'api', nodes: 4, tb: 780, pct: 62, grow: 0.05, power: 'read' },
  { k: 'pmax-fra-01', type: 'powermax', name: 'PMAX-FRA-01', vc: 'vc-eu-central', method: 'api', nodes: 4, tb: 640, pct: 58, grow: 0.04, power: 'read' },
  { k: 'vmax-pek-01', type: 'vmax', name: 'VMAX-PEK-01', vc: 'vc-cn-north', method: 'api', nodes: 4, tb: 420, pct: 77, grow: 0.07, power: 'read' },
  { k: 'vmax-gru-01', type: 'vmax', name: 'VMAX-GRU-01', vc: 'vc-br-sao', method: 'api', nodes: 2, tb: 300, pct: 84, grow: 0.11, power: 'read' },
  { k: 'xio-sel-01', type: 'xtremio', name: 'XIO-SEL-01', vc: 'vc-ap-northeast', method: 'api', nodes: 4, tb: 80, pct: 66, grow: 0.05, power: 'read' },
  { k: 'vplex-sel-01', type: 'vplex', name: 'VPLEX-SEL-01', vc: 'vc-ap-northeast', method: 'api', nodes: 4, tb: 0 },
  { k: 'mn-fra-01', type: 'metronode', name: 'MN-FRA-01', vc: 'vc-eu-central', method: 'api', nodes: 2, tb: 0 },
];
const SPEC_BY_ID = new Map(SPECS.map((s) => [`${DEMO_PREFIX}st-${s.k}`, s]));
function fallbackSpec(dev) {
  const h = demoHash(String(dev.id));
  const virt = dev.type === 'vplex' || dev.type === 'metronode';
  return { k: String(dev.id), type: String(dev.type || 'isilon'), name: dev.name || String(dev.id), method: dev.collectMethod || 'api',
    nodes: 2 + (h % 5), tb: virt ? 0 : 100 + (h % 900), pct: 40 + (h % 45), grow: 0.03 + (h % 9) / 100 };
}

/**
 * 데모 장비 등록 항목(비밀번호는 'mock' — 접속하지 않는다).
 * @param {(vcId:string)=>string} dcOf vCenter → DataCenter id(할당이 없으면 vCenter id 그대로)
 */
export function demoStorageDevices(dcOf = (v) => v) {
  return SPECS.map((s) => ({
    id: `${DEMO_PREFIX}st-${s.k}`, type: s.type, name: s.name,
    host: demoIp(`storage:${s.k}`), username: s.type === 'isilon' ? 'root' : 'admin', password: 'mock',
    agent: '', datacenterId: dcOf(s.vc) || s.vc, collectMethod: s.method, enabled: true,
    note: '데모(mock) 장비 — 실제 장비가 아닙니다',
  }));
}

const r2 = (x) => Math.round(x * 10) / 10;
const VERSION = { isilon: 'OneFS 9.5.0.4', unity480: 'Unity OE 5.4.0.0.5.094', powerstore: 'PowerStoreOS 3.6.1.0', powermax: 'PowerMaxOS 10.1.0.2', vmax: 'HYPERMAX OS 5978.711', xtremio: 'XIOS 6.4.1-20', vplex: 'GeoSynchrony 6.2.0.05', metronode: 'Metro node 8.0.1.0' };
const POWER_SRC = {
  'isilon:ssh': 'isi statistics(전원 키 탐색)', 'isilon:api': 'OneFS statistics(전원 키 탐색)',
  'unity480:ssh': 'svc_diag -s spinfo (DPE 전원공급장치 입력 전력)', 'unity480:api': 'Unisphere REST system.currentPower',
  'powerstore:api': 'PowerStore REST hardware(Power_Supply).extra_details', 'xtremio:api': 'XMS REST storage-controller-psus',
  'powermax:api': 'Unisphere REST 어레이 상세 응답의 전원 필드', 'vmax:api': 'Unisphere REST 어레이 상세 응답의 전원 필드',
};
const POWER_SCOPE = { isilon: 'node', unity480: 'dpe', powerstore: 'psu', xtremio: 'psu', powermax: 'system', vmax: 'system' };

/** 그 시각의 사용률(%) — 지금 값에서 하루 증가분을 거꾸로 빼고 작은 물결을 얹는다(20% 아래로 내려가지 않는다). */
export function usedPctAt(spec, t, now = t) {
  const daysBack = Math.max(0, (now - t) / DAY);
  const wave = Math.sin((t / DAY + demoHash(spec.k) % 17) * 0.9) * 0.15;
  return Math.max(20, Math.min(97, spec.pct - spec.grow * daysBack + wave));
}

/**
 * 한 장비의 정규화 스냅샷(types.js 계약). t = 수집 시각, now = '지금'(백필 기준). 순수 — 같은 입력은 같은 출력.
 * @param {{id:string,type:string,name:string,collectMethod?:string}} dev
 */
export function demoStorageSnapshot(dev, t = Date.now(), now = t) {
  // 사양 표에 없는 장비(데모 중 사용자가 직접 등록한 장비)도 id 해시로 사양을 만들어 비우지 않는다.
  const spec = SPEC_BY_ID.get(String(dev?.id || '')) || (dev?.id ? fallbackSpec(dev) : null);
  const base = {
    deviceId: dev.id, type: dev.type, name: dev.name, collectedAt: t, ok: false, error: '', version: '', serial: '',
    capacity: { totalBytes: 0, usedBytes: 0, pct: null }, media: null,
    nodes: { count: 0, unhealthy: 0, list: [] }, pools: [], accounts: [], alerts: { unresolved: 0 },
    sections: { config: 'skip', capacity: 'skip', nodes: 'skip', accounts: 'skip', alerts: 'skip' },
    extra: { mock: true, demo: true, collectMethod: dev.collectMethod || 'api' },
  };
  if (!spec) { base.error = '데모 사양 없음'; return base; }
  // 최근 spec.fail 시간 동안 수집 실패(실패 스냅샷의 수치는 비워 둔다 — '0 TB' 라는 거짓 금지).
  if (spec.fail && now - t < spec.fail * HOUR) {
    base.error = `SSH 연결 실패: connect ETIMEDOUT ${demoIp(`storage:${spec.k}`)}:22 (데모 — 최근 ${spec.fail}시간 수집 실패를 흉내 냅니다)`;
    base.sections = { config: base.error, capacity: base.error, nodes: base.error, accounts: base.error, alerts: base.error };
    base.capacity = { totalBytes: null, usedBytes: null, pct: null };
    base.nodes = { count: null, unhealthy: null, list: [] };
    return base;
  }
  const h = demoHash(spec.k);
  const hour = Math.floor(t / HOUR);
  const jig = (seed, amp = 0.15) => 1 + (demoRand(`${spec.k}:${seed}:${hour}`) * 2 - 1) * amp;
  // v2.951: 어레이(PowerMax · VMAX · PowerStore · Unity)는 같은 법인의 SAN 데모 어레이 시리얼을 쓴다 — SAN 스토리지 성능 화면이 용량 · 알람 · 어레이 측 성능을 붙일 수 있게.
  const feKind = { powermax: 'powermax', vmax: 'powermax', powerstore: 'powerstore', unity480: 'unity' }[spec.type] || null;
  const sanSerial = feKind ? sanDemoArraySerial(spec.vc, feKind) : null;
  const snap = { ...base, ok: true, version: VERSION[spec.type] || '', serial: sanSerial || `DEMO${String(h).slice(0, 8)}` };
  snap.extra = { ...base.extra };
  // ── 용량(VPLEX·Metro Node 는 자체 용량이 없는 가상화 계층 — capacity 섹션 skip) ──
  const virt = spec.type === 'vplex' || spec.type === 'metronode';
  let total = 0; let used = 0;
  if (!virt) {
    total = spec.tb * TB;
    const pct = usedPctAt(spec, t, now);
    used = Math.round(total * pct / 100);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: r2(pct) };
    snap.sections.capacity = 'ok';
    const npools = spec.type === 'isilon' ? 2 : spec.type === 'unity480' || spec.type === 'powerstore' ? 1 : 1;
    if (npools === 2) {
      const a = Math.round(total * 0.7); const au = Math.round(used * 0.72);
      snap.pools = [
        { name: `${spec.name.toLowerCase()}_h500`, totalBytes: a, usedBytes: au, pct: r2(au / a * 100) },
        { name: `${spec.name.toLowerCase()}_a300`, totalBytes: total - a, usedBytes: used - au, pct: r2((used - au) / (total - a) * 100) },
      ];
    } else snap.pools = [{ name: spec.type === 'powermax' || spec.type === 'vmax' ? 'SRP_1' : 'pool_1', totalBytes: total, usedBytes: used, pct: r2(used / total * 100) }];
    if (spec.type === 'isilon' && spec.k === 'ps-sha-01') {
      // v2.791 데모: SSD 를 L3 캐시로만 쓰는 구성 — SSD 풀이 없다(media.ssd = null). 보고표가 'HDD 풀만' 으로 밝히는지 보이려고.
      snap.media = { hdd: { totalBytes: total, usedBytes: used, pct: r2(used / total * 100) }, ssd: null };
    } else if (spec.type === 'isilon') {
      const ssdT = Math.round(total * 0.08); const ssdU = Math.round(ssdT * 0.42);
      snap.media = { hdd: { totalBytes: total - ssdT, usedBytes: used - ssdU, pct: r2((used - ssdU) / (total - ssdT) * 100) }, ssd: { totalBytes: ssdT, usedBytes: ssdU, pct: r2(ssdU / ssdT * 100) } };
    }
    if (spec.type === 'unity480') {
      // v2.789 — 하위 항목(LUN·파일시스템) 데모. 사용자 캡처의 모양(SAN 큰 LUN 1개 + NAS 파일시스템 여럿)을 흉내 낸다.
      //   이름·크기는 합성이다. 사용량은 장비 사용률을 따라 완만히 늘어난다(증감 열이 비지 않게).
      const GiB = 1024 ** 3;
      const pctNow = usedPctAt(spec, t, now) / 100;
      const lunT = Math.round((total * 0.55) / GiB) * GiB;
      const fsDef = [['res_1', 'temp_share', 600, 0.014], ['res_2', 'spitforebackup', 500, 0.011], ['res_3', 'sandbox', 1024, 0.18],
        ['res_4', 'repo', 4096, 0.51], ['res_5', 'dvc_portal', 500, 0.2], ['res_6', 'dvc_datakey', 100, 0.047]];
      const grow = pctNow / Math.max(0.01, (spec.pct || 50) / 100);
      snap.extra.resources = [
        { kind: 'lun', id: 'sv_1', name: spec.k === 'unity-sjc-01' ? 'UNT_948_0' : 'Davinci_01', pool: 'pool_1', totalBytes: lunT,
          usedBytes: Math.round(lunT * Math.min(0.95, 0.37 * grow)), usedSource: 'allocation', health: 'OK' },
        ...fsDef.map(([id, name, gb, u]) => ({ kind: 'fs', id, name, pool: 'pool_1', totalBytes: gb * GiB,
          usedBytes: Math.round(gb * GiB * Math.min(0.95, u * grow)), usedSource: 'fs', health: 'OK', protocol: name === 'sandbox' ? 'cifs' : 'nfs' })),
      ];
      snap.extra.resourcesProbe = spec.method === 'ssh'
        ? { lun: { state: 'ok', source: 'uemcli /stor/prov/luns/lun show -detail', count: 1 }, fs: { state: 'ok', source: 'uemcli /stor/prov/fs show -detail', count: fsDef.length } }
        : { lun: { state: 'ok', source: 'Unisphere REST /api/types/lun/instances', count: 1 }, fs: { state: 'ok', source: 'Unisphere REST /api/types/filesystem/instances', count: fsDef.length } };
    }
    if (spec.type === 'powermax' || spec.type === 'vmax') {
      snap.extra.capacityBasis = 'system_capacity.usable';
      snap.extra.provisionedTb = r2(spec.tb * (1.6 + (h % 9) / 10));
    }
  } else {
    snap.sections.capacity = 'skip';
    snap.extra.capacityBasisNote = '가상화 계층(VPLEX/Metro Node)은 자체 용량이 없습니다 — 백엔드 어레이의 용량을 보세요.';
  }
  // ── 노드 ──
  const bad = new Set(); for (let i = 0; i < (spec.badNodes || 0); i++) bad.add((h + i) % spec.nodes);
  const nodeName = (i) => ({ unity480: `sp${'ab'[i]}`, powerstore: `Node${'AB'[i % 2]}-${Math.floor(i / 2) + 1}`, xtremio: `X${Math.floor(i / 2) + 1}-SC${(i % 2) + 1}`,
    powermax: `director-${1 + (i >> 1)}${'AB'[i % 2]}`, vmax: `director-${1 + (i >> 1)}${'AB'[i % 2]}`, vplex: `director-${1 + (i >> 1)}-${(i % 2) + 1}-${'AB'[i % 2]}`, metronode: `director-1-${i + 1}-A` }[spec.type]);
  // v2.926 — Isilon 노드 부하에 하루 주기(KST 오후가 바쁨)를 얹는다: 노드 부하 추이(히트맵)가 모양을 갖게. 다른 타입은 예전 그대로.
  const hourOfDay = new Date(t + 9 * HOUR).getUTCHours();
  const dayProf = spec.type === 'isilon' ? 0.62 + 0.38 * Math.sin(((hourOfDay - 7) / 24) * Math.PI * 2) : 1;
  // ps-fra-01 의 노드 7 은 매일 02~04시에 값을 읽지 못한 것으로 둔다 — 결측(빗금)·합계 생략 화면 확인용(0 이 아니라 null).
  const missAt = (i) => spec.k === 'ps-fra-01' && i === 6 && hourOfDay >= 2 && hourOfDay <= 4;
  const list = Array.from({ length: spec.nodes }, (_, i) => {
    const per = spec.type === 'isilon' && total ? total / spec.nodes : 0;
    const node = { id: i + 1, ip: demoIp(`storage:${spec.k}:node${i}`), health: bad.has(i) ? 'degraded' : 'ok',
      inBps: missAt(i) ? null : Math.round(2.5e8 * (0.5 + demoRand(`${spec.k}:n${i}`)) * dayProf * jig(`in${i}`, 0.3)),
      outBps: missAt(i) ? null : Math.round(4e8 * (0.5 + demoRand(`${spec.k}:o${i}`)) * dayProf * jig(`out${i}`, 0.3)) };
    if (spec.type === 'isilon' && !missAt(i)) {
      // v2.926 — 노드 디스크 쓰기·읽기(B/s)·CPU %(합성 — 실제 수집기 필드와 같은 이름·단위).
      node.diskInBytesPs = Math.round(9e7 * (0.5 + demoRand(`${spec.k}:di${i}`)) * dayProf * jig(`di${i}`, 0.3));
      node.diskOutBytesPs = Math.round(1.4e8 * (0.5 + demoRand(`${spec.k}:do${i}`)) * dayProf * jig(`do${i}`, 0.3));
      node.cpuPct = Math.round(Math.min(97, 12 + 60 * dayProf * (0.55 + 0.5 * demoRand(`${spec.k}:c${i}`)) * jig(`c${i}`, 0.2)) * 10) / 10;
    }
    if (spec.type === 'isilon') {
      node.hdd = { totalBytes: Math.round(per * 0.92), usedBytes: Math.round(per * 0.92 * used / total), pct: r2(used / total * 100) };
      node.ssd = { totalBytes: Math.round(per * 0.08), usedBytes: Math.round(per * 0.08 * 0.42), pct: 42 };
      // v2.735.2 — 노드 시리얼(합성). 마지막 노드는 읽지 못한 경우를 보이려고 비워 둔다(실제 수집기와 같은 모양).
      if (i < spec.nodes - 1) { node.serial = `DEMOSN${String(h).slice(0, 4)}${String(i + 1).padStart(3, '0')}`; node.model = 'H500-4U-Single-128GB-2x25GE SFP+-120TB-3200GB SSD'; }
      if (i < spec.nodes - 1 && i % 4 < 2) node.chassisSerial = `DEMOCH${String(h).slice(0, 4)}${Math.floor(i / 4) + 1}`;
    } else node.name = nodeName(i);
    return node;
  });
  snap.nodes = { count: spec.nodes, unhealthy: bad.size, unknown: 0, list };
  snap.sections.nodes = 'ok';
  // v2.735.2 — 시리얼 표시 계약(storageSerialText.js): 출처 종류와 노드 시리얼 근거.
  snap.extra.serialKind = spec.type === 'isilon' ? 'guid' : spec.type === 'xtremio' ? 'psnt' : 'serial';
  if (spec.type === 'isilon') {
    snap.extra.nodeSerials = { source: (dev.collectMethod || spec.method) === 'ssh' ? 'isi_for_array -s isi_hw_status -i' : 'REST /platform/N/cluster/nodes (hardware)',
      read: list.filter((n) => n.serial).length, total: list.length, at: t, cached: false };
  }
  snap.accounts = [{ name: 'root', enabled: true }, { name: 'admin', enabled: true, role: 'SecurityAdmin' }, { name: 'monitor', enabled: true, role: 'ReadOnly' }];
  snap.sections.accounts = 'ok';
  snap.alerts = { unresolved: bad.size ? 2 + (h % 3) : h % 3 };
  snap.sections.alerts = 'ok';
  snap.sections.config = 'ok';
  if (spec.type === 'isilon') {
    snap.extra.clusterHealth = bad.size ? 'ATTN' : 'OK';
    snap.extra.dataReduction = '1.00:1';
    // v2.926 — 노드 부하 읽은 수(실제 수집기의 nodeLoadProbe 와 같은 모양).
    const method = dev.collectMethod || spec.method;
    snap.extra.nodeLoadProbe = { source: method === 'ssh' ? 'isi statistics system' : 'REST node.disk.bytes.*.rate.sum · node.cpu.idle.avg',
      total: list.length, disk: list.filter((n) => n.diskInBytesPs != null).length, cpu: list.filter((n) => n.cpuPct != null).length };
    if (method === 'ssh') {
      // v2.926 — 잡 엔진(isi status 꼬리 — SSH 수집기만 읽는다). 합성: 매일 01~05시 SmartPools, 13~14시 MediaScan(Low).
      const running = [];
      if (hourOfDay >= 1 && hourOfDay <= 5) running.push({ job: 'SmartPools[118838]', impact: 'Low', pri: 6, policy: 'LOW', phase: '1/2', runTime: `${hourOfDay - 1}:12:40` });
      if (hourOfDay >= 13 && hourOfDay <= 14) running.push({ job: 'MediaScan[118901]', impact: 'Low', pri: 8, policy: 'LOW', phase: '3/7', runTime: `${hourOfDay - 13}:31:05` });
      snap.extra.jobs = { running, paused: [], failed: [], recent: [] };
    }
  }
  // ── 전력(storage/power.js 계약 — 경로가 있는 조합만) ──
  const pkey = `${spec.type}:${dev.collectMethod || spec.method}`;
  if (POWER_SRC[pkey] && spec.power) {
    if (spec.power === 'read') {
      const perNode = { isilon: 780, unity480: 430, powerstore: 610, xtremio: 520, powermax: 1450, vmax: 1300 }[spec.type] || 500;
      const watts = Math.round(perNode * spec.nodes * jig('pw', 0.05));
      snap.extra.power = { watts, source: POWER_SRC[pkey], basis: 'demo', scope: POWER_SCOPE[spec.type] || 'system', parts: spec.nodes, at: t };
    } else {
      snap.extra.powerProbe = { tried: true, reason: 'no-field', source: POWER_SRC[pkey], seenKeys: ['node.ifs.bytes.in.rate', 'node.cpu.user.avg', 'node.disk.busy.avg'] };
    }
  }
  return snap;
}

/* ───────────── 베어메탈 스토리지(bmstor) ───────────── */

const BM_SPECS = [
  { k: 'hpc-01', name: 'hpc-node-01', groups: ['HPC', '서울'], mounts: ['/', '/data', '/scratch'], tb: [0.5, 40, 20], pct: [42, 71, 55], grow: 0.08 },
  { k: 'hpc-02', name: 'hpc-node-02', groups: ['HPC', '서울'], mounts: ['/', '/data', '/scratch'], tb: [0.5, 40, 20], pct: [39, 66, 61], grow: 0.07 },
  { k: 'hpc-03', name: 'hpc-node-03', groups: ['HPC', '서울'], mounts: ['/', '/data'], tb: [0.5, 60], pct: [44, 79], grow: 0.1 },
  { k: 'db-01', name: 'oradb-prod-01', groups: ['DB', '서울'], mounts: ['/', '/u01', '/u02'], tb: [0.3, 8, 16], pct: [51, 64, 82], grow: 0.05 },
  { k: 'db-02', name: 'oradb-prod-02', groups: ['DB', '프랑크푸르트'], mounts: ['/', '/u01', '/u02'], tb: [0.3, 8, 16], pct: [47, 58, 77], grow: 0.06 },
  { k: 'bk-01', name: 'backup-media-01', groups: ['백업'], mounts: ['/', '/backup'], tb: [0.4, 120], pct: [33, 86], grow: 0.15 },
  { k: 'bk-02', name: 'backup-media-02', groups: ['백업'], mounts: ['/', '/backup'], tb: [0.4, 120], pct: [35, 73], grow: 0.12 },
  { k: 'ai-01', name: 'ai-train-01', groups: ['AI', '서울'], mounts: ['/', '/datasets', '/models'], tb: [1, 80, 30], pct: [28, 62, 48], grow: 0.2 },
  { k: 'ai-02', name: 'ai-train-02', groups: ['AI'], mounts: ['/', '/datasets'], tb: [1, 80], pct: [31, 57], grow: 0.18 },
  { k: 'log-01', name: 'log-archive-01', groups: ['로그'], mounts: ['/', '/var/log/archive'], tb: [0.3, 24], pct: [40, 69], grow: 0.09 },
  { k: 'old-01', name: 'legacy-nfs-01', groups: ['로그'], mounts: ['/', '/export'], tb: [0.2, 10], pct: [60, 91], grow: 0.02, enabled: false },
];
const BM_BY_ID = new Map(BM_SPECS.map((s) => [`${DEMO_PREFIX}bm-${s.k}`, s]));

export function demoBmServers() {
  return BM_SPECS.map((s) => ({ id: `${DEMO_PREFIX}bm-${s.k}`, name: s.name, host: demoIp(`bm:${s.k}`, 172), username: 'root', password: 'mock',
    groups: s.groups, mounts: s.mounts, enabled: s.enabled !== false }));
}

/** 한 서버의 df 결과(poller latest 행 모양 — collect.js parseDfOutput 의 행). */
export function demoBmResult(server, t = Date.now(), now = t) {
  const s = BM_BY_ID.get(String(server?.id || ''));
  if (!s) return { id: server?.id, ok: false, mounts: [], error: '데모 사양 없음' };
  const daysBack = Math.max(0, (now - t) / DAY);
  const mounts = s.mounts.map((m, i) => {
    const total = Math.round(s.tb[i] * TB);
    const wave = Math.sin(t / DAY * 1.3 + i + demoHash(s.k) % 7) * 0.2;
    const pct = Math.max(5, Math.min(98, s.pct[i] - (i === 0 ? 0.01 : s.grow) * daysBack + wave));
    const used = Math.round(total * pct / 100);
    return { mount: m, totalBytes: total, usedBytes: used, availBytes: total - used, usedPct: Math.round(pct) };
  });
  return { id: server.id, ok: true, mounts, missing: [] };
}

/** poller.bmCollectNow 의 mock 분기 — 접속하지 않고 결과를 만든다. */
export function demoBmResults(servers, t = Date.now()) {
  return (Array.isArray(servers) ? servers : []).map((s) => demoBmResult(s, t, t));
}

/* ───────────── 데이터스토어 추이(vmtrack) 백필 ───────────── */

/**
 * 지금 스냅샷의 데이터스토어에서 과거 슬롯의 vCenter 별 행을 만든다(순수). 사용량은 하루 증가분을 거꾸로 빼고,
 * VM 수는 아주 조금 적게 둔다. 로스터·변경 상세는 만들지 않는다(live: [] — 지금 로스터를 건드리지 않는다).
 * @returns {Array<{vcenterId,total,onCount,offCount,added,removed,poweredOn,poweredOff,live,baseline,ds}>}
 */
export function demoVmtrackPerVc(snap, slotTs, now, { first = false, prevUsed = new Map() } = {}) {
  const daysBack = Math.max(0, (now - slotTs) / DAY);
  const vmsByVc = new Map(); const dsByVc = new Map();
  for (const v of snap?.vms || []) { const k = String(v.vcenterId || ''); vmsByVc.set(k, (vmsByVc.get(k) || 0) + 1); }
  const onByVc = new Map();
  for (const v of snap?.vms || []) if (/on/i.test(String(v.powerState || ''))) { const k = String(v.vcenterId || ''); onByVc.set(k, (onByVc.get(k) || 0) + 1); }
  for (const d of snap?.datastores || []) { const k = String(d.vcenterId || ''); if (!dsByVc.has(k)) dsByVc.set(k, []); dsByVc.get(k).push(d); }
  const out = [];
  for (const vc of snap?.vcenters || []) {
    const id = String(vc.id || ''); if (!id) continue;
    const vmNow = vmsByVc.get(id) || 0;
    const total = Math.max(0, Math.round(vmNow * (1 - 0.0009 * daysBack)));
    const onCount = Math.min(total, Math.round((onByVc.get(id) || 0) * (1 - 0.0009 * daysBack)));
    let capGB = 0; let usedGB = 0; const series = [];
    for (const d of dsByVc.get(id) || []) {
      const cap = Number(d.capacityGB); const u = Number(d.usedGB);
      if (!(cap > 0) || !Number.isFinite(u)) continue;
      const rate = 0.0006 + (demoHash(`ds:${d.id}`) % 10) / 10000;          // 하루 0.06~0.15%(용량 대비)
      const wave = Math.sin(slotTs / DAY * 0.7 + demoHash(String(d.id)) % 11) * cap * 0.002;
      const used = Math.max(cap * 0.05, Math.min(cap, u - cap * rate * daysBack + wave));
      const usedR = Math.round(used * 10) / 10;
      capGB += cap; usedGB += usedR;
      const dsId = String(d.id || d.name || '');
      const prev = prevUsed.get(dsId);
      if (first || prev == null || Math.abs(prev - usedR) >= 1) { series.push({ dsId, capGB: cap, usedGB: usedR }); prevUsed.set(dsId, usedR); }
    }
    const count = (dsByVc.get(id) || []).length;
    out.push({ vcenterId: id, total, onCount, offCount: total - onCount, added: [], removed: [], poweredOn: [], poweredOff: [], live: [], baseline: first,
      ds: { count, capGB: r2(capGB), usedGB: r2(usedGB), usedUnknown: 0, added: [], removed: [], changed: [], live: [], series, baseline: first } });
  }
  return out;
}

/* ───────────── 시드·백필 진입점 ───────────── */

let _done = false;
let _inflight = null;
let _last = null;
export function demoStorageStatus() { return _last; }
export function _resetStorageDemoForTest() { _done = false; _inflight = null; _last = null; }

/**
 * vCenter → DataCenter(법인) id. 순서: 관리자 할당(datacenters.json assign) → 데모 법인(PDU 데모의 `demoCorps` 가 만드는
 * '<도시> 법인' — 다른 데모 화면과 같은 법인 축) → vCenter id 그대로(법인이 하나도 없을 때).
 */
async function vcenterIdsAndDc() {
  let snap = null;
  try { const { store } = await import('../../store.js'); snap = store.get?.() || null; } catch { /* */ }
  const byVcName = new Map();
  try {
    const { demoCorps } = await import('./pdu.js');
    await demoCorps(snap);                               // 법인이 하나도 없을 때만 만든다(PDU 데모와 같은 규칙·같은 id)
    const dcs = await import('../../datacenter/store.js');
    const list = dcs.listDatacenters();
    const assign = dcs.getDatacenterAssign() || {};
    for (const vc of snap?.vcenters || []) {
      const id = String(vc.id || '');
      if (typeof assign?.[id] === 'string' && assign[id]) { byVcName.set(id, assign[id]); continue; }
      const city = String(vc.location?.city || '').trim();
      const hit = city && list.find((d) => String(d.name || '').trim() === `${city} 법인`);
      if (hit) byVcName.set(id, String(hit.id));
    }
  } catch { /* 법인 축을 못 정하면 vCenter id 를 그대로 쓴다 */ }
  return { dcOf: (vc) => byVcName.get(vc) || vc };
}

/** 이미 시드된 데모 장비의 법인이 vCenter id 로 남아 있으면(시드 때 법인이 없었다) 지금 정해진 법인으로 옮긴다. */
async function relinkDemoDatacenters(reg, dcOf) {
  let moved = 0;
  for (const d of reg.listDevices()) {
    if (!isDemoId(d.id)) continue;
    const want = dcOf(d.datacenterId);
    if (!want || want === d.datacenterId) continue;
    try { reg.saveDevice({ ...d, datacenterId: want, password: '' }); moved += 1; } catch { /* */ }
  }
  return moved;
}

/** 스토리지 일 롤업 400일 + 최근 7일 시간당 — 이력이 거의 없는 데모 장비만(재기동마다 다시 쌓지 않는다). */
async function backfillStorage(devices, now) {
  const db = await import('../../storage/db.js');
  if (!(await db.dbAvailable())) return { devices: 0, points: 0, reason: 'db-unavailable' };
  const spans = await db.dailySpans();
  let nDev = 0; let points = 0;
  for (const d of devices) {
    if (!isDemoId(d.id) || d.type === 'vplex' || d.type === 'metronode' || (spans[d.id]?.observed || 0) >= 30) continue; // 가상화 계층은 용량 이력이 없다
    nDev += 1;
    for (let back = 400; back >= 8; back -= 1) {
      const t = now - back * DAY + (demoHash(d.id) % 600) * 60_000;
      const r = await db.saveCapacityPoint(demoStorageSnapshot(d, t, now)); if (r.saved) points += 1;
    }
    for (let back = 7 * 24; back >= 1; back -= 1) {
      const r = await db.saveCapacityPoint(demoStorageSnapshot(d, now - back * HOUR, now)); if (r.saved) points += 1;
    }
    await new Promise((res) => setImmediate(res)); // 장비 사이 양보(이벤트 루프를 길게 잡지 않는다)
  }
  // 작업 로그(최근 24시간 · 1시간 주기) — 새로 백필한 장비가 있을 때만(재기동마다 로그를 다시 채우지 않는다).
  let events = 0;
  if (nDev) {
    try {
      const { recordActivity } = await import('../../storage/activityLog.js');
      const list = devices.filter((d) => isDemoId(d.id));
      for (let back = 24; back >= 1; back -= 1) {
        for (const d of list) {
          const at = now - back * HOUR + (demoHash(d.id) % 900) * 1000;
          const snap = demoStorageSnapshot(d, at, now);
          recordActivity({ deviceId: d.id, name: snap.name || d.name, host: d.host || '', source: 'central', ok: !!snap.ok,
            nodes: snap.nodes?.count ?? null, usedBytes: snap.capacity?.usedBytes ?? null, totalBytes: snap.capacity?.totalBytes ?? null,
            durationMs: 2000 + (demoHash(`${d.id}:${back}`) % 40000), error: snap.ok ? null : (snap.error || null), at });
          events += 1;
        }
      }
    } catch { /* 로그 백필 실패가 시드를 막지 않게 */ }
  }
  return { devices: nDev, points, events };
}

/**
 * v2.932(2차) — 5분 표본(경량 폴러 · 데모 아이실론): 1시간 스냅샷의 노드 값 위에 **클라이언트 상위·프로토콜·드라이브 busy·IOPS** 를 합성해 얹는다.
 *  · 노드 2(두 번째) 가 쏠린다 — ops 약 2.6배 · 고정 클라이언트 여럿(재배치 보드가 후보를 내게). 노드 3 은 클라이언트 0(‘최근 작업한 클라이언트 없음’ 문구 확인용).
 *  · 모양은 실제 수집기(isilonNodeLoad.buildNodeLoadSample)와 같다 — 그대로 db.saveNodeLoadSample 에 넣는다. 실패 스냅샷(수집 실패 흉내)이면 null.
 */
/** v2.951 — 어레이 FE 단위(디렉터 · 노드 · SP + Unity · PowerStore 포트) 5분 표본 합성 — 수집기와 같은 조립(buildFeSample). 첫 단위가 쏠린다(SAN 데모 편중과 같은 방향). */
const FE_DEMO_UNITS = { powermax: ['FA-1D', 'FA-2D'], vmax: ['FA-1D', 'FA-2D'], powerstore: ['Node A', 'Node B'], unity480: ['SPA', 'SPB'] };
export function demoArrayPerfSample(spec, t = Date.now()) {
  const type = spec?.type; const names = FE_DEMO_UNITS[type];
  if (!names) return null;
  const slot = Math.floor(t / 300_000);
  const hourOfDay = new Date(t + 9 * HOUR).getUTCHours();
  const dayProf = 0.55 + 0.45 * Math.sin(((hourOfDay - 7) / 24) * Math.PI * 2);
  const jig = (seed, amp = 0.15) => 1 + (demoRand(`${spec.k}:fe:${seed}:${slot}`) * 2 - 1) * amp;
  const kind = type === 'powerstore' ? 'node' : type === 'unity480' ? 'sp' : 'fa';
  const units = names.map((name, i) => {
    const skew = i === 0 ? 1.35 : 0.85;
    const load = Math.min(1, Math.max(0.05, dayProf * skew * jig(`l${i}`, 0.2)));
    const u = { name, kind, iops: Math.round(4000 + 26000 * load), hbps: Math.round(60e6 + 420e6 * load), lat: type === 'unity480' ? null : Math.round((0.4 + 2.2 * load * load) * 10) / 10 };
    if (kind === 'fa') { u.busy = Math.round(Math.min(98, 15 + 62 * load) * 10) / 10; u.queue = Math.round(Math.min(95, 8 + 55 * load * load) * 10) / 10; }
    else u.cpu = Math.round(Math.min(97, 12 + 58 * load) * 10) / 10;
    return u;
  });
  if (kind !== 'fa') {
    for (const parent of names) {
      const base = units.find((u) => u.name === parent);
      for (let p = 0; p < 2; p++) units.push({ name: `${parent} FC${p}`, kind: 'port', parent, iops: Math.round(base.iops * (p === 0 ? 0.6 : 0.4)), hbps: Math.round(base.hbps * (p === 0 ? 0.6 : 0.4)), lat: base.lat });
    }
  }
  return buildFeSample({ ts: t, type, source: 'demo', units, probe: { demo: true } });
}

export function demoNodeLoadSample(dev, t = Date.now(), now = t) {
  if (isFePerfType(dev?.type)) return demoArrayPerfSample(SPEC_BY_ID.get(String(dev?.id || '')) || fallbackSpec(dev || {}), t);   // v2.951 어레이 FE 단위
  const snap = demoStorageSnapshot(dev, t, now);
  if (!snap.ok || !Array.isArray(snap.nodes?.list) || !snap.nodes.list.length) return null;
  const spec = SPEC_BY_ID.get(String(dev?.id || '')) || fallbackSpec(dev);
  const slot = Math.floor(t / 300_000);
  const jig = (seed, amp = 0.2) => 1 + (demoRand(`${spec.k}:${seed}:${slot}`) * 2 - 1) * amp;
  const hourOfDay = new Date(t + 9 * HOUR).getUTCHours();
  const dayProf = 0.62 + 0.38 * Math.sin(((hourOfDay - 7) / 24) * Math.PI * 2);
  const PROTOS = ['nfs', 'smb', 'nfs', 'nfs', 'smb', 'http'];
  const nodes = snap.nodes.list.map((n, i) => {
    const skew = i === 1 ? 2.6 : 1;
    const nClients = i === 2 ? 0 : 3 + (demoHash(`${spec.k}:nc${i}`) % 4);
    const clients = Array.from({ length: nClients }, (_, c) => {
      const seed = `${spec.k}:cl${i}:${c}`;
      const ops = Math.round((80 + demoRand(seed) * 900) * dayProf * skew * jig(`co${i}${c}`, 0.3));
      const proto = PROTOS[(demoHash(seed) >>> 3) % PROTOS.length];
      return { ip: demoIp(`client:${seed}`, 172), name: `demo-${proto}-${(demoHash(seed) % 90) + 10}`, proto, ops,
        in: ops * 12_000, out: ops * 40_000, lat: Math.round((0.4 + demoRand(`${seed}:l`) * 3) * 10) / 10 };
    }).sort((a, b) => b.ops - a.ops);
    const proto = {};
    for (const c of clients) {
      const p = proto[c.proto] || { ops: 0, lat: 0, in: 0, out: 0, n: 0 };
      p.ops += c.ops; p.in += c.in; p.out += c.out; p.lat += c.lat; p.n += 1; proto[c.proto] = p;
    }
    for (const k of Object.keys(proto)) { const p = proto[k]; proto[k] = { ops: p.ops, lat: Math.round((p.lat / p.n) * 10) / 10, in: p.in, out: p.out }; }
    const busy = n.diskInBytesPs == null ? null : Math.round(Math.min(98, 18 + 55 * dayProf * skew * jig(`b${i}`, 0.2)) * 10) / 10;
    return {
      id: n.id, in: n.inBps ?? null, out: n.outBps ?? null, din: n.diskInBytesPs ?? null, dout: n.diskOutBytesPs ?? null, cpu: n.cpuPct ?? null,
      ops: clients.length ? clients.reduce((a, c) => a + c.ops, 0) : (n.inBps == null ? null : 0),
      lat: clients.length ? Math.round((clients.reduce((a, c) => a + c.lat, 0) / clients.length) * 10) / 10 : null,
      busy, iops: busy == null ? null : Math.round(busy * 38 * jig(`io${i}`, 0.15)), ...(busy != null ? { busyMax: Math.min(100, Math.round(busy * 1.2 * 10) / 10) } : {}),
      proto: Object.keys(proto).length ? proto : null, clients: clients.slice(0, 10),
    };
  });
  return { ts: t, nodes, probe: { source: 'demo', total: nodes.length, clients: nodes.filter((n) => n.clients.length).length, proto: nodes.filter((n) => n.proto).length,
    drives: nodes.filter((n) => n.busy != null).length, latUnit: 'ms(합성)', clientsRead: 'ok', protocolsRead: 'ok', drivesRead: 'ok' } };
}

/**
 * v2.926 — 노드 부하(네트워크·디스크·CPU) 이력: 원시는 최근 30일 시간별, 그 앞 120일은 하루 4점(일 롤업이 차게). 데모 Isilon 만 ·
 * 그 장비에 노드 부하 기록이 하나도 없을 때만(재기동마다 다시 쌓지 않는다 — 용량 백필과 같은 멱등 규칙). 원시 보존(기본 30일)보다
 * 오래된 원시 행은 다음 정리에서 지워지고 일 롤업만 남는다 — 실제 운영과 같은 모양이다.
 */
async function backfillNodeLoad(devices, now) {
  const db = await import('../../storage/db.js');
  if (!(await db.dbAvailable())) return { devices: 0, points: 0, reason: 'db-unavailable' };
  let nDev = 0; let points = 0; let samples = 0; let sDev = 0; let feDev = 0; let feSamples = 0;
  for (const d of devices) {
    if (!isDemoId(d.id)) continue;
    // v2.951 — 어레이 FE 단위 표본(REST 수집 장비만 — 폴러의 대상 규칙과 같다): 기록이 하나도 없을 때만 30일(최근 48시간 5분 · 그 앞 1시간).
    if (isFePerfType(d.type) && (d.collectMethod || 'api') === 'api') {
      const o = await db.nodeLoadOldest(d.id);
      if (o.sampleTs == null && o.day == null) {
        feDev += 1;
        const base5 = Math.floor(now / 300_000) * 300_000;
        let first = true;
        for (let back = 30 * 24 * 12; back >= 1; back -= (back > 48 * 12 ? 12 : 1)) {
          const s = demoNodeLoadSample(d, base5 - back * 300_000, now);
          if (!s) break;
          if (first) { await db.saveNodeUnits(d.id, s.units, now); first = false; }
          const r = await db.saveNodeLoadSample(d.id, s); if (r.saved) feSamples += 1;
          if (feSamples % 24 === 0) await new Promise((res) => setImmediate(res));
        }
        await new Promise((res) => setImmediate(res));
      }
      continue;
    }
    if (d.type !== 'isilon') continue;
    const o = await db.nodeLoadOldest(d.id);
    if (o.sampleTs == null && o.day == null) {
      nDev += 1;
      const base = Math.floor(now / HOUR) * HOUR - (demoHash(d.id) % 50) * 60_000;
      for (let back = 150 * 24; back >= 1; back -= (back > 30 * 24 ? 6 : 1)) {
        const r = await db.saveNodeLoadPoint(demoStorageSnapshot(d, base - back * HOUR, now)); if (r.saved) points += 1;
        if (points % 100 === 0) await new Promise((res) => setImmediate(res)); // 100점마다 양보(이벤트 루프를 길게 잡지 않는다)
      }
      await new Promise((res) => setImmediate(res)); // 장비 사이 양보
    }
    // v2.932(2차) — 클라이언트·프로토콜 표본: 최근 48시간은 5분마다(원시 보존 2일과 같은 길이), 그 앞 5일은 1시간마다(시간 요약·7일 분포가 차게).
    //   노드 부하 백필과 따로 판정한다(v2.931 설치본은 노드 기록은 있고 클라이언트 기록은 없다).
    const c = await db.nodeClientOldest(d.id);
    if (c.sampleTs == null && c.hourTs == null) {
      sDev += 1;
      const base5 = Math.floor(now / 300_000) * 300_000;
      for (let back = 7 * 24 * 12; back >= 1; back -= (back > 48 * 12 ? 12 : 1)) {
        const s = demoNodeLoadSample(d, base5 - back * 300_000, now);
        if (!s) continue;
        const r = await db.saveNodeLoadSample(d.id, s); if (r.saved) samples += 1;
        if (samples % 24 === 0) await new Promise((res) => setImmediate(res));
      }
      await new Promise((res) => setImmediate(res));
    }
  }
  return { devices: nDev, points, sampleDevices: sDev, samples, feDevices: feDev, feSamples };
}

/** 베어메탈 12시간 이력 365일 — 그 슬롯에 합계가 없을 때만. */
async function backfillBm(now) {
  const { listBmServers } = await import('../../bmstor/registry.js');
  const { buildHistoryRows, slotOf, slotStart, historyIntervalHours } = await import('../../bmstor/history.js');
  const hdb = await import('../../bmstor/historyDb.js');
  const servers = listBmServers().filter((s) => isDemoId(s.id));
  if (!servers.length) return { slots: 0 };
  const hours = historyIntervalHours();
  const cur = slotOf(now, hours);
  const back = Math.ceil(365 * 24 / hours);
  let slots = 0;
  for (let s = cur - back; s < cur; s += 1) {
    const prev = await hdb.totalOfSlot(s);
    if (prev === null) return { slots, reason: 'db-unavailable' };
    if (prev.exists) continue;
    const ts = slotStart(s, hours) + 20 * 60_000;
    const latest = new Map(servers.map((sv) => [sv.id, { ...demoBmResult(sv, ts, now), at: ts }]));
    const { rows } = buildHistoryRows(servers, latest, { now: ts, freshMs: HOUR });
    if (!rows.length) continue;
    const r = await hdb.commitBmHistory({ slot: s, ts, rows });
    if (r.ok) slots += 1;
    if (slots % 60 === 0) await new Promise((res) => setImmediate(res));
  }
  return { slots };
}

/** 데이터스토어 추이(vmtrack) 60일 — 저장된 합계 슬롯이 1개 이하(새 설치)일 때만. */
async function backfillVmtrack(now) {
  const { store } = await import('../../store.js');
  const snap = store.get?.();
  if (!snap?.vcenters?.length || !snap?.datastores?.length) return { slots: 0, reason: 'no-snapshot' };
  const vdb = await import('../../vmtrack/db.js');
  if (!(await vdb.getDb())) return { slots: 0, reason: 'db-unavailable' };
  const meta = await vdb.vmtrackMeta();
  if ((meta?.n || 0) > 1) return { slots: 0, reason: 'has-history' };
  const { slotKey, slotStartMs, totalsOf } = await import('../../vmtrack/diff.js');
  const curSlot = slotKey(new Date(now));
  const prevUsed = new Map();
  let slots = 0; let first = true;
  for (let i = 120; i >= 1; i -= 1) {
    const slot = slotKey(new Date(now - i * 12 * HOUR));
    if (slot === curSlot) continue;
    const ts = (slotStartMs(slot) ?? (now - i * 12 * HOUR)) + 3 * 60_000;
    const perVc = demoVmtrackPerVc(snap, ts, now, { first, prevUsed });
    if (!perVc.length) break;
    const r = await vdb.commitSnapshot({ slot, ts, perVc, totalRow: { ...totalsOf(perVc), skipped: 0 } });
    if (r.ok) slots += 1;
    first = false;
  }
  return { slots };
}

/**
 * mock 모드 시드·백필(1회). mock 이 아니면 null — live/auto 에서는 아무것도 하지 않는다.
 * 스토리지 폴러가 mock 주기마다 부른다(첫 주기는 기동 15초 뒤). 진행 중이면 같은 프라미스를 공유한다.
 */
export async function ensureStorageDemo({ now = Date.now() } = {}) {
  if (!isMockMode()) return null;
  if (_done) return _last;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const out = { at: now, demo: true };
    const { dcOf } = await vcenterIdsAndDc();
    try {
      const reg = await import('../../storage/registry.js');
      out.storageSeed = reg.seedDevicesIfEmpty(demoStorageDevices(dcOf));
      out.storageRelinked = await relinkDemoDatacenters(reg, dcOf);
      // 방금 시드한 데모 장비는 v2.534 이후 기준(실제 기록량)으로만 쌓인다 — 그 1회 마이그레이션(VMAX/PowerMax 이력 삭제)의
      //   대상이 아니다. 표지만 세운다(장비별 '기준 변경' 기록은 남기지 않는다 — 빈 id 목록). 안 세우면 다음 기동에
      //   마이그레이션이 데모 이력을 지우고 증가량 화면에 '기준 변경' 배지를 띄운다(재기동 실측으로 확인).
      if (out.storageSeed?.seeded > 0) {
        try {
          const { MIGRATION_ID } = await import('../../storage/capacityBasisMigration.js');
          const db = await import('../../storage/db.js');
          await db.resetCapacityHistory([], { once: MIGRATION_ID, reason: '데모 시드 — 대상 아님' });
        } catch { /* 표지 실패는 시드를 막지 않는다 */ }
      }
      out.storageBackfill = await backfillStorage(reg.listDevices(), now);
      out.nodeLoadBackfill = await backfillNodeLoad(reg.listDevices(), now);
    } catch (e) { out.storageError = e.message; }
    try {
      const bm = await import('../../bmstor/registry.js');
      out.bmSeed = bm.seedBmServersIfEmpty(demoBmServers());
      out.bmBackfill = await backfillBm(now);
    } catch (e) { out.bmError = e.message; }
    try { out.vmtrackBackfill = await backfillVmtrack(now); } catch (e) { out.vmtrackError = e.message; }
    // vmtrack 은 스냅샷이 아직 없으면 다음 호출에서 다시 시도한다(나머지는 등록부·DB 기준 멱등).
    _done = out.vmtrackBackfill?.reason !== 'no-snapshot';
    _last = out;
    const seeded = (out.storageSeed?.seeded || 0) + (out.bmSeed?.seeded || 0);
    if (seeded || out.storageBackfill?.points || out.bmBackfill?.slots || out.vmtrackBackfill?.slots) {
      console.log(`[mock] 스토리지 데모 시드: 장비 ${out.storageSeed?.seeded || 0} · 베어메탈 ${out.bmSeed?.seeded || 0} · 용량 이력 ${out.storageBackfill?.points || 0}점 · 베어메탈 이력 ${out.bmBackfill?.slots || 0}슬롯 · DS 추이 ${out.vmtrackBackfill?.slots || 0}슬롯`);
    }
    return out;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/* ───────────── Isilon OneFS API 영역(v2.709) ───────────── */

/**
 * 데모 Isilon 의 OneFS API 영역 수집 결과 — 실제 수집기(storage/areasCollector.js collectAreasOnce)와 **같은 모양**
 * (`results` = DB 저장용 엔드포인트 단위, `summary` = 화면·push 용 영역 단위)을 장비 접속 없이 만든다.
 * v2.708 까지 mock 은 요약 2줄만 지어내고 DB 에는 아무것도 넣지 않아 '영역 상세' 창이 비어 있었다.
 * 원문은 엔드포인트 경로·장비 사양에서 결정적으로 만든 작은 JSON 이고 `demo:true` 를 싣는다(진짜 응답인 척하지 않는다).
 * 일부 엔드포인트는 버전별 경로 차이처럼 HTTP 404 로 실패시킨다(실패 요약 표시 경로가 보이게).
 */
export function demoIsilonAreas(dev, areas, disabled = []) {
  const spec = SPEC_BY_ID.get(String(dev?.id || '')) || fallbackSpec(dev || {});
  const results = []; const summary = [];
  const stopAt = spec.areasStop || null; // v2.730(검토 I-03): 영역 중간 멈춤 데모 — 실제 수집기와 같은 규칙으로 요약한다
  let stopped = null;
  for (const area of areas) {
    const expected = area.endpoints.length;
    if (stopped) { summary.push(notTriedAreaEntry(area.key, expected, stopped)); continue; }
    let okCnt = 0, failCnt = 0, firstErr = '';
    let stopHere = null;
    for (let i = 0; i < area.endpoints.length; i++) {
      if (stopAt && stopAt.area === area.key && okCnt + failCnt >= (Number(stopAt.after) || 0)) { stopHere = stopAt.reason || 'deadline'; break; }
      const ep = area.endpoints[i];
      // 둘째 이후 후보 경로 일부는 실패(구버전 경로) — 결정적.
      const fail = i > 0 && demoRand(`${spec.k}:area:${ep}`) < 0.25;
      if (fail) {
        const error = 'HTTP 404 (데모 — 이 OneFS 버전에 없는 경로를 흉내 냅니다)';
        results.push({ area: area.key, endpoint: ep, ok: false, error });
        failCnt++; if (!firstErr) firstErr = error;
        continue;
      }
      results.push({ area: area.key, endpoint: ep, ok: true, data: demoAreaBody(spec, area.key, ep) });
      okCnt++;
    }
    if (stopHere) stopped = stopHere;
    if (stopHere && okCnt + failCnt === 0) { summary.push(notTriedAreaEntry(area.key, expected, stopHere)); continue; }
    summary.push(triedAreaEntry(area.key, { expected, ok: okCnt, failed: failCnt, firstErr, stopReason: stopHere }));
  }
  for (const a of disabled) summary.push(disabledAreaEntry(a));
  const t = areaTotals(summary);
  return {
    summary, results, endpoints: results.length, stopped,
    notTried: t.notTried, notTriedEndpoints: t.notTriedEndpoints, partialAreas: t.partialAreas, expectedEndpoints: t.expectedEndpoints,
  };
}

function demoAreaBody(spec, area, ep) {
  const n = Math.max(1, Number(spec.nodes) || 1);
  const base = { demo: true, endpoint: ep, cluster: spec.name };
  if (area === 'node') return { ...base, nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, lnn: i + 1, status: { health: 'OK' } })) };
  if (area === 'cluster') return { ...base, name: spec.name, onefs_version: { release: VERSION.isilon }, guid: `demo-${demoHash(spec.k).toString(16)}` };
  if (area === 'capacity') return { ...base, storagepools: [{ name: `${String(spec.name).toLowerCase()}_h500`, usage: { total_bytes: String(Math.round((spec.tb || 0) * TB * 0.7)) } }] };
  if (area === 'quota') return { ...base, quotas: Array.from({ length: 3 + (demoHash(spec.k) % 4) }, (_, i) => ({ path: `/ifs/data/proj${i + 1}`, type: 'directory' })) };
  if (area === 'snapshot') return { ...base, snapshots: Array.from({ length: 2 + (demoHash(spec.k) % 3) }, (_, i) => ({ name: `daily_${i + 1}`, path: '/ifs/data' })) };
  return { ...base, items: [] };
}
