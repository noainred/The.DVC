/**
 * IP 능동 스캔 엔진 — TCP 커넥트 스캔(루트 불필요). 지정한 대역의 각 IP에 공통
 * 포트로 접속을 시도해 "생존" 여부와 열린 포트(서비스 추정)를 파악한다. 역DNS로
 * 호스트명을 보강한다. 동시성 제한 + per-host 타임아웃으로 비차단 동작.
 *
 * ⚠️ 포트 스캔은 침투성 행위입니다. 사내 승인된 대역에만, 레이트리밋을 두고 사용.
 */

import net from 'node:net';
import dnsp from 'node:dns/promises';

export const DEFAULT_PORTS = [22, 80, 443, 445, 3389, 623, 8006, 902, 5985, 5986];
const SERVICE = {
  22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 445: 'SMB', 3389: 'RDP', 623: 'IPMI/BMC',
  8006: 'Proxmox', 902: 'ESXi', 5985: 'WinRM', 5986: 'WinRM-S', 161: 'SNMP',
};
export const portService = (p) => SERVICE[p] || String(p);

const ipToNum = (s) => { const p = String(s).split('.').map(Number); return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) : null; };
/** 유효한 IPv4 점표기인지(키 오염·잘못된 입력 차단용 공용 검증기). */
export const isIpv4 = (s) => ipToNum(s) != null;
const numToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export const RANGE_CAP = 4096; // spec 1개당 확장 IP 안전 상한

/** spec의 '진짜' IP 개수(배열 생성 없이 계산, 4096 상한 미적용 — 표시용). 0이면 무효 spec. */
export function rangeSize(spec) {
  const s = String(spec || '').trim();
  if (!s) return 0;
  if (s.includes('/')) {
    const [base, bitsStr] = s.split('/');
    const bits = Number(bitsStr); const b = ipToNum(base);
    if (b == null || !(bits >= 8 && bits <= 32)) return 0;
    const size = 2 ** (32 - bits);
    return bits >= 31 ? size : Math.max(0, size - 2);
  }
  if (s.includes('-')) {
    const [a, bRaw] = s.split('-').map((x) => x.trim());
    const an = ipToNum(a);
    let bn = ipToNum(bRaw);
    if (bn == null && /^\d{1,3}$/.test(bRaw) && an != null) bn = (an & 0xffffff00) + Number(bRaw);
    if (an == null || bn == null || bn < an) return 0;
    return bn - an + 1;
  }
  return ipToNum(s) != null ? 1 : 0;
}

/** "10.0.0.0/24" | "10.0.0.1-10.0.0.50" | "10.0.0.1-50" | "10.0.0.5" → IP 배열(스캔용, 4096 상한). */
export function expandRange(spec) {
  const s = String(spec || '').trim();
  if (!s) return [];
  if (s.includes('/')) {
    const [base, bitsStr] = s.split('/');
    const bits = Number(bitsStr); const b = ipToNum(base);
    if (b == null || !(bits >= 8 && bits <= 32)) return [];
    const size = 2 ** (32 - bits);
    const net0 = b & (size === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
    const out = [];
    // /31·/32는 전체, 그 외는 네트워크/브로드캐스트 제외.
    const start = bits >= 31 ? 0 : 1;
    const end = bits >= 31 ? size : size - 1;
    for (let i = start; i < end; i++) out.push(numToIp((net0 + i) >>> 0));
    if (out.length > RANGE_CAP) console.warn(`[ipscan] 대역 ${s}이(가) ${out.length}개로 ${RANGE_CAP} 상한 초과 — 앞 ${RANGE_CAP}개만 스캔합니다. /24 단위로 나눠 등록하세요.`);
    return out.slice(0, RANGE_CAP); // 안전 상한
  }
  if (s.includes('-')) {
    const [a, bRaw] = s.split('-').map((x) => x.trim());
    const an = ipToNum(a);
    let bn = ipToNum(bRaw);
    if (bn == null && /^\d{1,3}$/.test(bRaw) && an != null) bn = (an & 0xffffff00) + Number(bRaw); // a.b.c.d-e
    if (an == null || bn == null || bn < an) return [];
    const total = bn - an + 1;
    if (total > RANGE_CAP) console.warn(`[ipscan] 범위 ${s}이(가) ${total}개로 ${RANGE_CAP} 상한 초과 — 앞 ${RANGE_CAP}개만 스캔합니다.`);
    const out = []; for (let n = an; n <= bn && out.length < RANGE_CAP; n++) out.push(numToIp(n >>> 0));
    return out;
  }
  return ipToNum(s) != null ? [s] : [];
}

function tcpProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (open) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve(open); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    try { sock.connect(port, ip); } catch { fin(false); }
  });
}

async function scanOneHost(ip, ports, timeoutMs, reverseDns) {
  const open = [];
  // 포트는 순차(호스트당 부하 제한). 첫 포트만 빠르게 죽으면 나머지도 대개 닫힘.
  for (const p of ports) { if (await tcpProbe(ip, p, timeoutMs)) open.push(p); }
  if (!open.length) return null;
  let hostname = '';
  if (reverseDns) { try { const names = await dnsp.reverse(ip); hostname = names?.[0] || ''; } catch { /* no PTR */ } }
  return { ip, openPorts: open, services: open.map(portService), hostname };
}

/** 대역(여러 spec) 스캔. 진행 콜백 onAlive(host)/onProgress(done,total,alive) 가능. 생존 호스트 배열 반환. */
export async function scanRanges(specs, { ports = DEFAULT_PORTS, concurrency = 128, timeoutMs = 700, reverseDns = true, onAlive, onProgress } = {}) {
  const seen = new Set();
  const ips = [];
  for (const spec of (Array.isArray(specs) ? specs : [specs])) for (const ip of expandRange(spec)) if (!seen.has(ip)) { seen.add(ip); ips.push(ip); }
  const alive = [];
  const total = ips.length;
  let idx = 0;
  let done = 0;
  onProgress?.(0, total, 0);
  const worker = async () => {
    while (idx < ips.length) {
      const ip = ips[idx++];
      const r = await scanOneHost(ip, ports, timeoutMs, reverseDns).catch(() => null);
      done++;
      if (r) { alive.push(r); onAlive?.(r); }
      onProgress?.(done, total, alive.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length || 1) }, worker));
  return { scanned: ips.length, alive };
}
