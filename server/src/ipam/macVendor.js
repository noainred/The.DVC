/**
 * MAC → 제조사 · 종류(v2.999 — 설계 docs/design/ipam-alerts-mac-dns ② · 보드 ⑥). 판정은 이 파일 하나다(대장 · IP 상세 · CSV).
 *
 * 제조사 표 `vendor/oui.tsv.gz` 는 `scripts/oui-build.mjs` 가 npm `oui-data`(BSD-2-Clause · IEEE 공개 등록부)에서 만든다 — 실행 중 내려받지 않는다.
 *   처음 찾을 때 한 번 읽는다(동기 · 약 560KB 압축 → 5만 4천 줄). 읽지 못하면 제조사는 모두 null 이고 콘솔에 한 번 남긴다(종류 판정은 그대로).
 *
 * 종류(kind):
 *   'gateway' — 게이트웨이 이중화의 가상 MAC(VRRP · HSRP · GLBP — 정해진 대역). 장비 하나의 MAC 이 아니다.
 *   'virtual' — 가상 NIC 대역(VMware · Hyper-V · Xen · VirtualBox · Parallels · Proxmox · QEMU/KVM). ESXi vmkernel 포트도 VMware 대역을 쓴다.
 *   'random'  — 둘째 비트가 선 MAC(로컬 관리) — 장비 · 운영체제가 정한 값이라 제조사를 추정하지 않는다(위 가상 대역의 QEMU 는 예외).
 *   null      — 제조사가 받은 대역(표에 없으면 vendor null = '제조사 미상').
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const FILE = new URL('./vendor/oui.tsv.gz', import.meta.url);
const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

let _table = null;      // Map<접두(6|7|9 hex), 이름>
let _meta = null;       // { source, count } — 첫 줄
let _loadError = null;

function parseTable(text) {
  const m = new Map();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line) continue;
    if (line.startsWith('#')) { if (!_meta) _meta = { source: line.slice(1).trim() }; continue; }
    const tab = line.indexOf('\t');
    if (tab !== 6 && tab !== 7 && tab !== 9) continue;
    m.set(line.slice(0, tab), line.slice(tab + 1));
  }
  _table = m;
  _meta = { ...(_meta || {}), count: m.size };
}
function loadFailed(e) {
  _loadError = e?.code || e?.message || String(e);
  console.warn(`[ipam] 제조사 표(vendor/oui.tsv.gz)를 읽지 못했습니다 — 제조사는 비워 둡니다: ${_loadError}`);
}
/** 동기 적재(처음 찾을 때 — 미리 읽기가 아직이면). 실측 약 45ms 한 번. */
function loadTable() {
  if (_table || _loadError) return _table;
  try { parseTable(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8')); } catch (e) { loadFailed(e); }
  return _table;
}
/**
 * 미리 읽기(비동기 — 파일 읽기 · 압축 풀기를 이벤트 루프 밖에서). 남는 동기 구간은 줄 나누기(약 20ms) 한 번.
 *   대장을 처음 만들 때 45ms 를 요청 경로에서 쓰지 않으려고 기동 뒤 한 번 부른다(index.js). 실패하면 동기 적재가 다시 시도하지 않는다(같은 오류).
 */
let _warming = null;
export function warmOui() {
  if (_table || _loadError) return Promise.resolve(!!_table);
  if (!_warming) {
    _warming = (async () => {
      try {
        const buf = await fs.promises.readFile(FILE);
        const raw = await new Promise((res, rej) => zlib.gunzip(buf, (e, out) => (e ? rej(e) : res(out))));
        if (!_table && !_loadError) parseTable(raw.toString('utf8'));
      } catch (e) { if (!_table && !_loadError) loadFailed(e); }
      return !!_table;
    })();
  }
  return _warming;
}

/** 표 상태(설정 화면 · 진단). 처음 부르면 읽는다. */
export function ouiStatus() {
  loadTable();
  return { loaded: !!_table, count: _table ? _table.size : 0, source: _meta?.source || null, error: _loadError };
}

// 게이트웨이 이중화 가상 MAC — 정해진 대역(RFC 5798 VRRP · Cisco HSRP v1/v2 · GLBP).
const GATEWAY = [
  { re: /^00:00:5E:00:0[12]:/, label: 'VRRP' },
  { re: /^00:00:0C:07:AC:/, label: 'HSRP' },
  { re: /^00:00:0C:9F:F[0-9A-F]:/, label: 'HSRP' },
  { re: /^00:07:B4:00:/, label: 'GLBP' },
];
// 가상 NIC 대역(앞 3바이트) → 가상화 이름. QEMU/KVM 의 52:54:00 은 로컬 관리 비트가 서 있다(표에 없다) — 그래도 가상 NIC 로 본다.
const VIRTUAL = new Map([
  ['005056', 'VMware'], ['000C29', 'VMware'], ['000569', 'VMware'], ['001C14', 'VMware'],
  ['00155D', 'Hyper-V'], ['00163E', 'Xen'], ['080027', 'VirtualBox'], ['001C42', 'Parallels'],
  ['BC2411', 'Proxmox'], ['525400', 'QEMU/KVM'],
]);

/** 대문자 콜론 꼴로(아니면 ''). 엣지 정제(scanStore.cleanMac)와 같은 모양. */
export function normMac(v) {
  if (typeof v !== 'string' || v.length > 32) return '';
  const m = v.trim().toUpperCase().replace(/-/g, ':');
  return MAC_RE.test(m) && m !== '00:00:00:00:00:00' ? m : '';
}

/**
 * @param {string} mac
 * @returns {{ vendor: string|null, kind: null|'gateway'|'virtual'|'random', platform?: string } | null} MAC 꼴이 아니면 null
 */
export function macInfo(mac) {
  const m = normMac(mac);
  if (!m) return null;
  const hex = m.replace(/:/g, '');
  for (const g of GATEWAY) if (g.re.test(m)) return { vendor: null, kind: 'gateway', platform: g.label };
  const first = Number.parseInt(hex.slice(0, 2), 16);
  const virt = VIRTUAL.get(hex.slice(0, 6));
  const t = loadTable();
  const vendor = t ? (t.get(hex.slice(0, 9)) || t.get(hex.slice(0, 7)) || t.get(hex.slice(0, 6)) || null) : null;
  if (virt) return { vendor, kind: 'virtual', platform: virt };
  if (first & 0x02) return { vendor: null, kind: 'random' };
  return { vendor, kind: null };
}

/** 스캔 저장 항목의 표시 MAC — ARP(스캐너 이웃 표 — 직접 본 값)가 먼저, 없으면 NetBIOS 가 답한 MAC. */
export function entryMac(e) {
  if (!e || typeof e !== 'object') return { mac: '', src: null };
  if (e.arp && typeof e.arp === 'object' && e.arp.v) return { mac: e.arp.v, src: 'arp' };
  if (e.mac) return { mac: e.mac, src: 'netbios' };
  return { mac: '', src: null };
}

/**
 * 대장 행에 싣는 MAC 칸(순수 · 값이 있을 때만). 확인 시각 · NetBIOS MAC · 같은 MAC 의 IP 목록은 IP 상세 창이 따로 읽는다(응답 다이어트).
 * @param {object|null} sc 그 IP 의 스캔 결과(저장 모양) — 없으면(또는 범위 계정이면) null
 * @param {(mac:string)=>number} [ipCount] 그 MAC 을 표시 MAC 으로 가진 IP 수(scanStore.macIpCount)
 * @returns {object} { mac, macSrc:'arp'|'netbios', macVendor?, macKind?, macPlatform?, macStale?, macShared? }
 */
export const MAC_CHANGE_RECENT_MS = 7 * 86_400_000;   // vNEXT: 'MAC 변경' 배지를 보이는 기간(MAC 이력의 마지막 줄이 이 안에 시작)
export function netMacFields(sc, ipCount = null, hist = null) {
  const em = entryMac(sc);
  if (!em.mac) return {};
  const out = { mac: em.mac, macSrc: em.src };
  const info = macInfo(em.mac);
  if (info?.vendor) out.macVendor = info.vendor;
  if (info?.kind) out.macKind = info.kind;
  if (info?.platform) out.macPlatform = info.platform;
  const arp = em.src === 'arp' ? sc.arp : null;
  if (arp && ((arp.miss || 0) > 0 || (arp.at || 0) < (sc.lastSeen || 0))) out.macStale = true;
  const n = typeof ipCount === 'function' ? ipCount(em.mac) : 0;
  if (n > 1) out.macShared = n;
  // vNEXT: 최근 MAC 이 바뀌었다(이력 두 줄 이상 · 마지막 줄이 MAC_CHANGE_RECENT_MS 안에 시작 · 지금 표시 MAC 과 같다) — 직전 MAC 과 함께.
  const list = Array.isArray(hist?.macs) ? hist.macs : [];
  if (em.src === 'arp' && list.length >= 2) {
    const last = list[list.length - 1]; const prev = list[list.length - 2];
    if (last?.mac === em.mac && Number(last.first) > Date.now() - MAC_CHANGE_RECENT_MS) { out.macChangedAt = Number(last.first); out.macPrev = String(prev?.mac || ''); }
  }
  return out;
}

/** 테스트용 — 표를 다시 읽게 한다. */
export function _resetOuiForTest() { _table = null; _meta = null; _loadError = null; _warming = null; }
