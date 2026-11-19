/**
 * insights/hwExport/catalog.js — '서버 하드웨어 정보 내보내기' 의 값 카탈로그(순수 · v2.967 — 승인 시안 docs/design/baremetal-hw-xlsx).
 *
 * 사용자 요청(2026-11-11): "서버의 모든 인터페이스의 속도, 펌웨어 등 idrac 에서 수집하는 모든 정보를 선택해서 export" ·
 *   "서버 1대의 사양을 최대한 자세하게 볼 수 있는 정보를 sheet 1장에 서버 1대".
 *
 * 묶음(group) 13개 × 두 종류의 값:
 *   · 요약 열(`<묶음>.sum.<값>`) — '서버 요약'(서버 한 대 = 한 줄)의 열이 된다. get(ctx) → 수 | 글자 | null.
 *   · 상세(`<묶음>.det.<값>`)    — 부품 한 개 = 한 줄인 별도 시트(CSV 는 파일). items(inv) 의 원소마다 get(item, ctx).
 * key 는 **고정**이다(웹 창이 고른 값을 key 로 보내고, 계정별 기억도 key 로 저장한다) — 이름을 바꾸지 말 것.
 *
 * 값 규약(CLAUDE.md '못 읽은 값은 0 이 아니다'): 읽지 못한 값은 null(빈 칸). 수 칸은 util/numOrNull 로만 수로 만든다.
 * 출처는 iDRAC(Redfish) 인벤토리 저장값 하나다(idrac/redfish.js fetchInventory · 엣지는 collector/compactInv.js 축약본) —
 *   여기서 판정을 새로 만들지 않는다. 코어·메모리는 idrac/physicalCapacity.js capacityOfInventory 하나로 센다.
 *
 * ⚠ 넣지 않는 것(카탈로그에 없다 — 고를 수도 없다): 시리얼 번호 · iDRAC 사용자 계정 목록(idracUsers) · 이벤트 로그(events) · 접속 계정.
 * ⚠ adminOnly 값(iDRAC 주소 · MAC · UUID)은 관리자 판본(auth/demoGuest.js isAdminDetailUser)에만 — 라우트가 카탈로그를 거른다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { capacityOfInventory } from '../../idrac/physicalCapacity.js';
import { readInvArr } from '../../idrac/hwSummary.js'; // v3.3.0: 컬렉션 읽음 판정 하나(물리서버 폴더 하드웨어 요약과 공유)
import { dedupNics } from '../../idrac/nicPorts.js';
import { localStamp } from '../../util/dayKey.js';
import { partHealthRollup } from '../../idrac/invView.js'; // v2.973 B1: 하위 상태를 부품 원소 판정으로(화면 inventoryView 와 같은 판정)

const s = (v) => (v == null ? '' : String(v).trim());
const n = (v) => { const x = numOrNull(v); return x == null ? null : x; };
const pos = (v) => { const x = n(v); return x != null && x > 0 ? x : null; };
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
/*
 * 합(반증 F5 — '부분 합은 따로 센다'): 원소 하나라도 못 읽었으면 null(빈 칸)이다 — 읽은 것만 더해 전체 합처럼 보이지 않게.
 * 빈 목록은 0(읽었고 없음). 서버 사이의 합(띠 · 맨 위 칸)은 rows.js 가 '몇 대를 더했는가' 를 함께 싣는다.
 */
const strictSum = (xs) => { let t = 0; for (const x of xs) { if (x == null) return null; t += x; } return t; };
/*
 * 그 컬렉션을 읽었는가(반증 F3 — 못 읽은 값은 0 이 아니다): 판정은 idrac/hwSummary.js readInvArr 하나(v3.3.0 — 물리서버 폴더 하드웨어 요약과 같은 함수).
 * 배열이 없거나 collections.<키>='failed' 면 null · emptyUnknown 이면 빈 배열도 못 읽음(NIC).
 */
const readArr = readInvArr;
const countOf = (inv, key, o) => { const a = readArr(inv, key, o); return a ? a.length : null; };

/*
 * v2.973 B1: 하위 시스템 상태. 수집기(idrac/redfish.js)는 health.fan 을 채우지 않아 '팬 상태' 가 모든 서버에서 비었다 — 팬 목록(inv.fans)은 있다.
 * 화면(idrac/invView.js inventoryView)처럼 **부품 원소 판정으로 다시 만든다**(psu · storage(디스크) · fan). 원소를 못 읽었으면(컬렉션 failed · 배열 없음)
 * 저장된 롤업 글자를 쓴다. 판정은 partHealthRollup 하나(복제 금지) — 'OK' 는 읽은 원소가 있고 못 읽은 원소가 없을 때만.
 */
const PART_PICK = { fans: (x) => ({ health: x.health, state: x.state }) };
function healthOf(inv, word, arrKey) {
  // 반증 F2: 부품 배열이 있으면(컬렉션 failed 포함) **원소 판정만** 쓴다 — 화면 inventoryView 와 같다. 못 읽음 · 빈 슬롯만이면 '' (옛 롤업 'OK' 로 돌아가지 않는다).
  //   저장된 롤업 글자는 배열 자체가 없을 때(구버전 엣지 · 이 하위 시스템을 부품으로 읽지 않는 수집)만 쓴다.
  if (arrKey && Array.isArray(inv?.[arrKey])) {
    const a = readArr(inv, arrKey);
    return a ? partHealthRollup(a, PART_PICK[arrKey]).word : '';
  }
  return s(inv?.health?.[word]);
}

/*
 * NIC 포트 목록. 같은 물리 포트 중복은 idrac/nicPorts.js dedupNics 로 묶는다.
 * '(EthernetInterfaces)' 항목은 어댑터 응답에 속도가 하나도 없을 때만 redfish.js 가 덧붙이는 **포트 폴백**이라(어댑터 포트와 겹치지 않는다)
 * 포트 행에는 넣는다 — 그 서버의 링크 속도는 그 항목에만 있다. 어댑터 칸은 그 이름 그대로 둔다(지어내지 않는다).
 */
const realNics = (inv) => dedupNics(arr(inv?.nics));
const nicPorts = (inv) => realNics(inv).flatMap((a) => arr(a.ports).map((p) => ({ a, p })));
/** 포트 목록 — NIC 컬렉션을 못 읽었으면(빈 배열 포함) null. */
const portsRead = (inv) => (readArr(inv, 'nics', { emptyUnknown: true }) ? nicPorts(inv) : null);
const cap = (ctx) => (ctx.inv ? capacityOfInventory(ctx.inv) : null);

/** 메모리(GiB): 시스템 요약 → 없으면 DIMM 합. 둘 다 없으면 vCenter 값(가상화 호스트 · iDRAC 받침 없음). */
function memGiB(ctx) {
  const c = cap(ctx);
  if (c?.memGiB != null) return Math.round(c.memGiB);
  const dm = readArr(ctx.inv, 'memoryDimms');
  const d = dm && dm.length ? strictSum(dm.map((m) => pos(m.sizeGB))) : null;
  if (d != null) return d;
  return pos(ctx.vc?.memGiB);
}
function cores(ctx) {
  const c = cap(ctx);
  if (c?.cores != null) return c.cores;
  return pos(ctx.vc?.cores);
}
const disks = (inv) => arr(inv?.disks);
function diskMix(inv) {
  const list = readArr(inv, 'disks');
  if (!list) return '';
  const m = new Map();
  for (const d of list) {
    const k = `${s(d.media) || '미상'}${s(d.protocol) ? `(${s(d.protocol)})` : ''}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([k, c]) => `${k} ${c}`).join(' · ');
}
function gpuSummary(inv) {
  const list = readArr(inv, 'gpus');
  if (!list) return '';
  const m = new Map();
  for (const g of list) { const k = s(g.model || g.name) || 'GPU'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([k, c]) => `${k} × ${c}`).join(' · ');
}
const maxPortMbps = (inv) => { const v = (portsRead(inv) || []).map(({ p }) => pos(p.speedMbps)).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
const fwOf = (inv, type) => { const f = arr(inv?.firmware).find((x) => s(x.type) === type); return f ? s(f.version) : ''; };
const licenseText = (inv) => arr(inv?.licenses).map((l) => s(l.name)).filter(Boolean).join(' · ');
// 인벤토리 시각 — 포탈 오프셋(util/dayKey.js localStamp · 기본 KST). 못 읽으면 ''(시각을 지어내지 않는다).
const fmtTime = (ms) => { const t = numOrNull(ms); return t != null && t > 0 ? localStamp(t) : ''; };

const BIOS_LABEL = Object.freeze({
  BootMode: '부팅 모드', SysProfile: '시스템 프로파일', SystemProfile: '시스템 프로파일', ProcVirtualization: '가상화 기술',
  LogicalProc: '논리 프로세서', ProcCores: '활성 코어', SriovGlobalEnable: 'SR-IOV', MemFrequency: '메모리 주파수', MemOpMode: '메모리 동작 모드',
  NodeInterleave: '노드 인터리브', IntegratedRaid: '내장 RAID', SecureBoot: '보안 부팅', TpmSecurity: 'TPM 보안', ProcTurboMode: '터보 모드',
  EmbSata: '내장 SATA', InternalUsb: '내부 USB', PowerManagement: '전원 관리', SerialComm: '시리얼 통신', OsWatchdogTimer: 'OS 워치독',
});
const biosItems = (inv) => {
  const a = inv?.bios?.attributes;
  if (!a || typeof a !== 'object') return [];
  return Object.keys(a).slice(0, 64).map((k) => ({ k, v: a[k] }));
};

/*
 * 묶음 정의. 값 정의: { key, label, kind: 'text'|'num'|'mono', locked?, adminOnly?, basic?, get }.
 *   kind — 엑셀 칸 서식(num = 숫자 서식 · 오른쪽 정렬 / mono = 고정폭 글꼴).
 *   basic — 창의 '기본' 묶음(사용자 승인 기본값 2026-11-11)에 들어가는 값.
 */
export const HW_GROUPS = Object.freeze([
  {
    key: 'id', name: '기본 식별', hint: '잠긴 값은 항상 들어갑니다',
    sum: [
      { key: 'corp', label: '법인', kind: 'text', locked: true, get: (c) => c.corpName },
      { key: 'kind', label: '구분', kind: 'text', locked: true, get: (c) => (c.kind === 'vh' ? '가상화' : '물리') },
      { key: 'name', label: '서버', kind: 'text', locked: true, get: (c) => c.name },
      { key: 'hostName', label: 'Hostname(OS)', kind: 'text', locked: true, get: (c) => c.hostName },
      { key: 'serviceTag', label: '서비스태그', kind: 'mono', locked: true, get: (c) => c.serviceTag },
      // v2.968: 법인은 법인(DataCenter)이다 — vCenter 는 따로(가상화 서버 · vCenter 가 지정된 물리 서버만 값이 있다. 기본 묶음에는 넣지 않는다).
      { key: 'vcenter', label: 'vCenter', kind: 'text', get: (c) => s(c.vcenterName) },
      { key: 'manufacturer', label: '제조사', kind: 'text', basic: true, get: (c) => s(c.inv?.system?.manufacturer) },
      { key: 'model', label: '모델', kind: 'text', basic: true, get: (c) => s(c.inv?.system?.model) || s(c.model) },
      { key: 'powerState', label: '전원 상태', kind: 'text', get: (c) => s(c.inv?.system?.powerState || c.inv?.powerState) },
      { key: 'assetTag', label: '자산 태그', kind: 'text', get: (c) => s(c.inv?.system?.assetTag) },
      { key: 'uuid', label: 'UUID', kind: 'mono', adminOnly: true, get: (c) => s(c.inv?.system?.uuid) },
      { key: 'source', label: '수집원', kind: 'text', get: (c) => c.sourceText },
      { key: 'collectedAt', label: '인벤토리 시각', kind: 'mono', basic: true, get: (c) => fmtTime(c.inv?.collectedAt) },
    ],
  },
  {
    key: 'cpu', name: 'CPU', sheet: 'CPU', file: 'cpu',
    sum: [
      { key: 'model', label: 'CPU 모델', kind: 'text', basic: true, get: (c) => s(c.inv?.cpu?.model) || s(arr(c.inv?.cpus)[0]?.model) },
      { key: 'sockets', label: '소켓 수', kind: 'num', basic: true, get: (c) => cap(c)?.sockets ?? null },
      { key: 'cores', label: '코어(합계)', kind: 'num', basic: true, get: cores },
      { key: 'threads', label: '스레드(합계)', kind: 'num', get: (c) => { const t = cap(c)?.threads; if (t != null) return t; const cs = readArr(c.inv, 'cpus'); return cs && cs.length ? strictSum(cs.map((x) => pos(x.threads))) : null; } },
    ],
    det: {
      items: (inv) => arr(inv?.cpus),
      cols: [
        { key: 'socket', label: '소켓', kind: 'mono', get: (x) => s(x.socket) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'manufacturer', label: '제조사', kind: 'text', get: (x) => s(x.manufacturer) },
        { key: 'cores', label: '코어', kind: 'num', get: (x) => pos(x.cores) },
        { key: 'threads', label: '스레드', kind: 'num', get: (x) => pos(x.threads) },
        { key: 'maxSpeedMHz', label: '최대 클럭 MHz', kind: 'num', get: (x) => pos(x.maxSpeedMHz) },
      ],
    },
  },
  {
    key: 'mem', name: '메모리', sheet: '메모리', file: 'memory',
    sum: [
      { key: 'gib', label: '메모리 GiB', kind: 'num', basic: true, get: memGiB },
      { key: 'dimms', label: 'DIMM 수', kind: 'num', basic: true, get: (c) => countOf(c.inv, 'memoryDimms') },
    ],
    det: {
      items: (inv) => arr(inv?.memoryDimms),
      cols: [
        { key: 'locator', label: '슬롯', kind: 'mono', get: (x) => s(x.locator) },
        { key: 'sizeGB', label: '크기 GiB', kind: 'num', get: (x) => pos(x.sizeGB) },
        { key: 'type', label: '종류', kind: 'text', get: (x) => s(x.type) },
        { key: 'speedMHz', label: '속도 MHz', kind: 'num', get: (x) => pos(x.speedMHz) },
        { key: 'manufacturer', label: '제조사', kind: 'text', get: (x) => s(x.manufacturer) },
        { key: 'partNumber', label: '부품번호', kind: 'mono', get: (x) => s(x.partNumber) },
        { key: 'rank', label: '랭크', kind: 'num', get: (x) => pos(x.rank) },
      ],
    },
  },
  {
    key: 'disk', name: '디스크', hint: '물리 디스크 기준', sheet: '디스크', file: 'disk',
    sum: [
      { key: 'count', label: '디스크 수', kind: 'num', basic: true, get: (c) => countOf(c.inv, 'disks') },
      { key: 'gb', label: '디스크 합계 GB', kind: 'num', basic: true, get: (c) => { const d = readArr(c.inv, 'disks'); return d ? strictSum(d.map((x) => pos(x.capacityGB))) : null; } },
      { key: 'mix', label: '디스크 구성', kind: 'text', get: (c) => diskMix(c.inv) },
    ],
    det: {
      items: (inv) => disks(inv),
      cols: [
        { key: 'name', label: '디스크', kind: 'text', get: (x) => s(x.name) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'capacityGB', label: '용량 GB', kind: 'num', get: (x) => pos(x.capacityGB) },
        { key: 'media', label: '매체', kind: 'text', get: (x) => s(x.media) },
        { key: 'protocol', label: '인터페이스', kind: 'text', get: (x) => s(x.protocol) },
        { key: 'rpm', label: '회전수 RPM', kind: 'num', get: (x) => pos(x.rpm) },
      ],
    },
  },
  {
    key: 'ctrl', name: '스토리지 컨트롤러', sheet: '컨트롤러', file: 'storage-controller',
    sum: [],
    det: {
      items: (inv) => arr(inv?.storageControllers),
      cols: [
        { key: 'name', label: '이름', kind: 'text', get: (x) => s(x.name) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'firmware', label: '펌웨어', kind: 'mono', get: (x) => s(x.firmware) },
        { key: 'protocols', label: '프로토콜', kind: 'text', get: (x) => s(x.protocols) },
        { key: 'speedGbps', label: '속도 Gbps', kind: 'num', get: (x) => pos(x.speedGbps) },
      ],
    },
  },
  {
    key: 'nic', name: '네트워크 인터페이스', hint: '모든 포트의 링크 속도', sheet: 'NIC', file: 'nic',
    sum: [
      { key: 'ports', label: 'NIC 포트 수', kind: 'num', get: (c) => { const p = portsRead(c.inv); return p ? p.length : null; } },
      { key: 'maxGbps', label: '최고 링크 Gbps', kind: 'num', get: (c) => { const m = maxPortMbps(c.inv); return m == null ? null : m / 1000; } },
    ],
    det: {
      items: (inv) => nicPorts(inv),
      cols: [
        { key: 'adapter', label: '어댑터', kind: 'mono', get: (x) => s(x.a.name) },
        { key: 'model', label: '어댑터 모델', kind: 'text', get: (x) => s(x.a.model) },
        { key: 'firmware', label: '어댑터 펌웨어', kind: 'mono', get: (x) => s(x.a.firmware) },
        { key: 'port', label: '포트', kind: 'mono', get: (x) => s(x.p.id) },
        { key: 'link', label: '링크', kind: 'text', get: (x) => s(x.p.link) },
        { key: 'speedMbps', label: '속도 Mbps', kind: 'num', get: (x) => pos(x.p.speedMbps) },
        { key: 'mac', label: 'MAC', kind: 'mono', adminOnly: true, get: (x) => s(x.p.mac) },
      ],
    },
  },
  {
    key: 'fw', name: '펌웨어', sheet: '펌웨어', file: 'firmware',
    sum: [
      { key: 'bios', label: 'BIOS 버전', kind: 'mono', get: (c) => s(c.inv?.system?.biosVersion || c.inv?.bios?.version) || fwOf(c.inv, 'BIOS') },
      { key: 'bmc', label: 'BMC(iDRAC) 펌웨어', kind: 'mono', get: (c) => s(c.inv?.idrac?.firmwareVersion) || fwOf(c.inv, 'iDRAC') },
    ],
    det: {
      items: (inv) => arr(inv?.firmware),
      cols: [
        { key: 'type', label: '종류', kind: 'text', get: (x) => s(x.type) },
        { key: 'name', label: '구성요소', kind: 'text', get: (x) => s(x.name) },
        { key: 'version', label: '버전', kind: 'mono', get: (x) => s(x.version) },
      ],
    },
  },
  {
    key: 'gpu', name: 'GPU', sheet: 'GPU', file: 'gpu',
    sum: [{ key: 'summary', label: 'GPU(모델 × 수)', kind: 'text', get: (c) => gpuSummary(c.inv) }],
    det: {
      items: (inv) => arr(inv?.gpus),
      cols: [
        { key: 'name', label: '이름', kind: 'text', get: (x) => s(x.name) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'manufacturer', label: '제조사', kind: 'text', get: (x) => s(x.manufacturer) },
        { key: 'memoryMiB', label: '메모리 MiB', kind: 'num', get: (x) => pos(x.memoryMiB) },
      ],
    },
  },
  {
    key: 'psu', name: '전원(PSU)', sheet: '전원', file: 'psu',
    sum: [
      { key: 'count', label: 'PSU 수', kind: 'num', get: (c) => countOf(c.inv, 'psus') },
      { key: 'capacityW', label: 'PSU 용량 합계 W', kind: 'num', get: (c) => { const ps = readArr(c.inv, 'psus'); return ps ? strictSum(ps.map((p) => pos(p.capacityWatts))) : null; } },
      { key: 'capW', label: '전력 상한 W', kind: 'num', get: (c) => pos(c.inv?.powerCap?.limitWatts) },
    ],
    det: {
      items: (inv) => arr(inv?.psus),
      cols: [
        { key: 'name', label: '이름', kind: 'text', get: (x) => s(x.name) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'manufacturer', label: '제조사', kind: 'text', get: (x) => s(x.manufacturer) },
        { key: 'capacityWatts', label: '용량 W', kind: 'num', get: (x) => pos(x.capacityWatts) },
        { key: 'firmware', label: '펌웨어', kind: 'mono', get: (x) => s(x.firmware) },
      ],
    },
  },
  {
    key: 'pcie', name: 'PCIe 카드', hint: '구세대 iDRAC 은 미지원', sheet: 'PCIe', file: 'pcie',
    sum: [],
    det: {
      items: (inv) => arr(inv?.pcie),
      cols: [
        { key: 'name', label: '이름', kind: 'text', get: (x) => s(x.name) },
        { key: 'model', label: '모델', kind: 'text', get: (x) => s(x.model) },
        { key: 'manufacturer', label: '제조사', kind: 'text', get: (x) => s(x.manufacturer) },
        { key: 'deviceType', label: '종류', kind: 'text', get: (x) => s(x.deviceType) },
        { key: 'firmware', label: '펌웨어', kind: 'mono', get: (x) => s(x.firmware) },
      ],
    },
  },
  {
    key: 'bios', name: 'BIOS · 부팅 설정', hint: '수집기가 고른 주요 항목만', sheet: 'BIOS 설정', file: 'bios',
    sum: [{ key: 'bootMode', label: '부팅 모드', kind: 'text', get: (c) => s(c.inv?.bios?.attributes?.BootMode || c.inv?.boot?.mode) }],
    det: {
      items: (inv) => biosItems(inv),
      cols: [
        { key: 'key', label: '설정 항목', kind: 'mono', get: (x) => x.k },
        { key: 'label', label: '뜻', kind: 'text', get: (x) => BIOS_LABEL[x.k] || '' },
        { key: 'value', label: '값', kind: 'text', get: (x) => s(x.v) },
      ],
    },
  },
  {
    key: 'mgmt', name: 'iDRAC 관리', hint: '주소 · MAC 은 관리자만', sheet: 'iDRAC 관리', file: 'idrac',
    sum: [
      { key: 'model', label: 'iDRAC 모델', kind: 'text', get: (c) => s(c.inv?.idrac?.model) },
      { key: 'license', label: 'iDRAC 라이선스', kind: 'text', get: (c) => licenseText(c.inv) },
    ],
    det: {
      items: (inv) => arr(inv?.network),
      cols: [
        { key: 'iface', label: '인터페이스', kind: 'mono', adminOnly: true, get: (x) => s(x.name) },
        { key: 'hostName', label: 'iDRAC 호스트 이름', kind: 'text', adminOnly: true, get: (x) => s(x.hostName) },
        { key: 'fqdn', label: 'FQDN', kind: 'text', adminOnly: true, get: (x) => s(x.fqdn) },
        { key: 'mac', label: 'MAC', kind: 'mono', adminOnly: true, get: (x) => s(x.mac) },
        { key: 'ipv4', label: 'IPv4', kind: 'mono', adminOnly: true, get: (x) => s(x.ipv4) },
      ],
    },
  },
  {
    key: 'health', name: '상태', hint: '수집 시점의 Redfish 상태 글자',
    sum: [
      { key: 'overall', label: '전체 상태', kind: 'text', get: (c) => s(c.inv?.health?.overall || c.inv?.system?.health) },
      { key: 'processor', label: 'CPU 상태', kind: 'text', get: (c) => s(c.inv?.health?.processor) },
      { key: 'memory', label: '메모리 상태', kind: 'text', get: (c) => s(c.inv?.health?.memory) },
      { key: 'storage', label: '스토리지 상태', kind: 'text', get: (c) => healthOf(c.inv, 'storage', 'disks') },
      { key: 'psu', label: 'PSU 상태', kind: 'text', get: (c) => healthOf(c.inv, 'psu', 'psus') },
      { key: 'fan', label: '팬 상태', kind: 'text', get: (c) => healthOf(c.inv, 'fan', 'fans') },
    ],
  },
]);

/** 모든 값의 key → 정의(묶음 · 종류 포함). */
export const HW_FIELDS = (() => {
  const m = new Map();
  for (const g of HW_GROUPS) {
    for (const f of g.sum || []) m.set(`${g.key}.sum.${f.key}`, { ...f, group: g, part: 'sum' });
    for (const f of g.det?.cols || []) m.set(`${g.key}.det.${f.key}`, { ...f, group: g, part: 'det' });
  }
  return m;
})();
export const LOCKED_KEYS = Object.freeze([...HW_FIELDS].filter(([, f]) => f.locked).map(([k]) => k));
export const BASIC_KEYS = Object.freeze([...HW_FIELDS].filter(([, f]) => f.locked || f.basic).map(([k]) => k));

/** 이 계정이 고를 수 있는가(관리자 판본만 adminOnly). */
export const fieldAllowed = (f, admin) => !!f && (!f.adminOnly || !!admin);

/**
 * 요청의 값 목록 → 카탈로그 순서로 정렬된 허용 key 목록. 모르는 key · 권한 밖 key 는 버린다(화이트리스트). 잠긴 key 는 늘 넣는다.
 * @param {string[]|string} keys  배열 또는 쉼표 글자
 */
export function resolveFields(keys, { admin = false } = {}) {
  const want = new Set((Array.isArray(keys) ? keys : String(keys || '').split(',')).map((k) => String(k).trim()).filter(Boolean).slice(0, 400));
  for (const k of LOCKED_KEYS) want.add(k);
  return [...HW_FIELDS.keys()].filter((k) => want.has(k) && fieldAllowed(HW_FIELDS.get(k), admin));
}

/** 웹 창이 그릴 카탈로그(함수 없이) — 관리자가 아니면 adminOnly 값은 아예 싣지 않는다(칩이 보이지 않게). */
export function catalogForClient({ admin = false } = {}) {
  return HW_GROUPS.map((g) => ({
    key: g.key, name: g.name, hint: g.hint || '', sheet: g.sheet || '',
    sum: (g.sum || []).filter((f) => fieldAllowed(f, admin)).map((f) => ({ key: `${g.key}.sum.${f.key}`, label: f.label, locked: !!f.locked, basic: !!(f.locked || f.basic) })),
    det: (g.det?.cols || []).filter((f) => fieldAllowed(f, admin)).map((f) => ({ key: `${g.key}.det.${f.key}`, label: f.label })),
  }));
}
