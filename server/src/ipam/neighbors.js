/**
 * 운영체제 이웃 표(ARP 캐시)에서 응답한 IP 의 MAC 을 읽는다(v2.999 — 설계 docs/design/ipam-alerts-mac-dns ②).
 *
 * 스캔이 TCP 연결 · ping 을 보낸 같은 서브넷 IP 는 커널이 ARP 로 MAC 을 알아내 이웃 표에 남긴다. 그 표를 **읽기만** 한다 —
 *   새 패킷 · 명령 실행 · 관리자 권한이 없다. 리눅스(`/proc/net/arp`)만 읽는다(Windows 의 `arp -a` 는 범위 밖 — 설계 §6 범위 밖).
 *
 * 한계(정직 기록 — 설계 §3):
 *  · 라우터 너머 IP 는 표에 오르지 않는다(게이트웨이 MAC 만 있다) — 표는 IP 로 찾으므로 남의 MAC 을 붙이는 일은 없다.
 *  · 표에는 상한이 있다(gc_thresh — 기본 128/512/1024). 큰 대역에서는 앞에서 본 항목이 밀려나므로 스캔 중 **주기적으로** 읽어 모은다.
 *  · 표의 값은 커널이 마지막으로 확인한 MAC 이다(오래된 항목이 남아 있을 수 있다) — 화면은 '스캐너 이웃 표' 라고 출처를 밝힌다.
 */
import fs from 'node:fs/promises';
import { isIpv4 } from '../util/ipv4.js';

export const ARP_FILE = '/proc/net/arp';
const ATF_COM = 0x2;   // 완성된 항목(MAC 을 안다)
const ATF_PUBL = 0x8;  // 이 장비가 대신 답하는 항목(proxy ARP 로 게시) — 그 MAC 은 이 장비 것이다
const TEXT_MAX = 4 * 1024 * 1024;   // 표 전체 상한(gc_thresh3 1024 줄이면 약 80KB — 넉넉히)
const LINE_MAX = 256;               // 한 줄 상한(정상 줄은 약 80자) — 넘는 줄은 읽지 않는다
const ROWS_MAX = 65_536;
const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

/**
 * `/proc/net/arp` 본문 → ip → MAC(대문자 AA:BB:CC:DD:EE:FF). 완성된 이더넷 항목만, 0 MAC · 게시 항목 · 깨진 줄은 버린다(순수 · 선형).
 *   같은 IP 가 여러 인터페이스에 있으면 처음 것.
 * @param {string} text
 * @param {Set<string>|null} [wanted] 이 IP 들만(없으면 전부)
 * @returns {Map<string,string>}
 */
export function parseProcArp(text, wanted = null) {
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  const t = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text;
  let start = 0; let rows = 0;
  while (start < t.length && rows < ROWS_MAX) {
    let end = t.indexOf('\n', start);
    if (end < 0) end = t.length;
    const line = t.slice(start, end);
    start = end + 1;
    rows += 1;
    if (rows === 1 || line.length > LINE_MAX) continue;   // 첫 줄은 머리글
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [ip, hwType, flagsHex, macRaw] = f;
    if (!isIpv4(ip) || (wanted && !wanted.has(ip)) || out.has(ip)) continue;
    if (hwType !== '0x1') continue;   // 이더넷만
    const flags = Number.parseInt(flagsHex, 16);
    if (!Number.isFinite(flags) || !(flags & ATF_COM) || (flags & ATF_PUBL)) continue;
    const mac = String(macRaw).toUpperCase();
    if (!MAC_RE.test(mac) || mac === '00:00:00:00:00:00') continue;
    out.set(ip, mac);
  }
  return out;
}

/**
 * 이웃 표를 한 번 읽는다. 리눅스가 아니면 읽지 않는다.
 * @returns {Promise<{ ok:boolean, map:Map<string,string>, reason:null|'unsupported'|'unreadable' }>}
 */
export async function readNeighborTable({ platform = process.platform, readFile = fs.readFile, wanted = null } = {}) {
  if (platform !== 'linux') return { ok: false, map: new Map(), reason: 'unsupported' };
  try {
    const text = await readFile(ARP_FILE, 'utf8');
    return { ok: true, map: parseProcArp(String(text), wanted), reason: null };
  } catch {
    return { ok: false, map: new Map(), reason: 'unreadable' };
  }
}

/**
 * 스캔 동안 이웃 표를 주기적으로 읽어 모은다(큰 대역에서 앞 항목이 밀려나기 전에). 대상 IP(wanted)만 모은다.
 *   같은 IP 가 다른 MAC 으로 다시 보이면 나중 값(스캔 중 바뀐 것 — 드물다).
 * @param {Set<string>} wanted
 * @param {{ read?: Function, intervalMs?: number }} [o] read 는 readNeighborTable 과 같은 모양(테스트 주입)
 */
export function createNeighborSampler(wanted, { read = readNeighborTable, intervalMs = 2_000 } = {}) {
  const map = new Map();
  let ok = false; let reason = null; let reads = 0; let timer = null; let busy = null;
  const sample = async () => {
    if (busy) return busy;   // 앞 읽기가 끝나지 않았으면 그것을 기다린다(겹쳐 읽지 않는다)
    busy = (async () => {
      try {
        const r = await read({ wanted });
        reads += 1;
        if (r && r.ok) { ok = true; reason = null; for (const [ip, mac] of r.map || []) map.set(ip, mac); }
        else if (!ok) reason = (r && r.reason) || 'unreadable';
      } catch { if (!ok) reason = 'unreadable'; }
    })();
    try { await busy; } finally { busy = null; }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { sample().catch(() => {}); }, Math.max(200, intervalMs));
      timer.unref?.();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    sample,
    /** { ok, reason, reads, map } — ok 는 한 번이라도 읽었는가 */
    result: () => ({ ok, reason: ok ? null : (reason || 'unreadable'), reads, map }),
  };
}
