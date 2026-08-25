/**
 * IP 능동 스캔 엔진 — TCP 커넥트 스캔(루트 불필요). 지정한 대역의 각 IP에 공통
 * 포트로 접속을 시도해 "생존" 여부와 열린 포트(서비스 추정)를 파악한다. 역DNS로
 * 호스트명을 보강한다. 동시성 제한 + per-host 타임아웃으로 비차단 동작.
 *
 * ⚠️ 포트 스캔은 침투성 행위입니다. 사내 승인된 대역에만, 레이트리밋을 두고 사용.
 */

import net from 'node:net';
import dnsp from 'node:dns/promises';
import { execFile } from 'node:child_process';

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
    // & 는 int32라 첫 옥텟 ≥128(192.168.x 등)이면 음수가 됨 — >>>0 으로 부호 제거 필수.
    if (bn == null && /^\d{1,3}$/.test(bRaw) && an != null) bn = ((an & 0xffffff00) >>> 0) + Number(bRaw);
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
    const fullEnd = bits >= 31 ? size : size - 1;
    // 상한을 '생성 후 slice'가 아니라 루프 종료조건으로 적용 — /8(1670만) 등은 slice 전에 이미
    // 전체 배열(~1GB)을 할당하며 이벤트 루프를 수 초 블로킹한다. 앞 RANGE_CAP개만 만든다.
    const end = Math.min(fullEnd, start + RANGE_CAP);
    for (let i = start; i < end; i++) out.push(numToIp((net0 + i) >>> 0));
    if (fullEnd - start > RANGE_CAP) console.warn(`[ipscan] 대역 ${s}이(가) ${fullEnd - start}개로 ${RANGE_CAP} 상한 초과 — 앞 ${RANGE_CAP}개만 스캔합니다. /24 단위로 나눠 등록하세요.`);
    return out; // 이미 상한 적용됨
  }
  if (s.includes('-')) {
    const [a, bRaw] = s.split('-').map((x) => x.trim());
    const an = ipToNum(a);
    let bn = ipToNum(bRaw);
    if (bn == null && /^\d{1,3}$/.test(bRaw) && an != null) bn = ((an & 0xffffff00) >>> 0) + Number(bRaw); // a.b.c.d-e (>>>0: 192.168.x 부호 버그 방지)
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

/** 플랫폼별 ping 인자(1회 송신 + 타임아웃) — 테스트를 위해 분리. */
export function pingArgs(ip, timeoutMs, platform = process.platform) {
  if (platform === 'win32') return ['-n', '1', '-w', String(Math.max(100, Math.round(timeoutMs))), ip];
  // linux/mac ping -W 는 초 단위(정수만 받는 배포판이 있어 올림) — 최소 1초.
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];
}

/**
 * ping 전용 동시성 상한(v2.360, 장애 수습) — ⚠ 회귀 방지(치명):
 * ping 은 IP마다 `ping` **자식 프로세스**를 띄운다(execFile = 파이프 3개/프로세스). v2.359 는
 * 이를 스캔 동시성(기본 128, 최대 1024)만큼 동시에 뿌려서, 죽은 IP가 많은 큰 대역을 스캔하면
 * 프로세스·FD 가 폭주해 **메인 HTTP 서버가 새 연결을 accept 하지 못하고 포탈 전체가 먹통**이
 * 됐다(운영 장애 실제 발생 — accept 큐 포화 + 메모리 폭증). TCP 소켓 스캔과 달리 프로세스
 * 생성은 훨씬 무겁고 FD 를 잠식하므로, **스캔 동시성과 완전히 분리된 낮은 상한**으로 ping 을
 * 게이팅한다. 이 상한을 없애거나 크게 올리면 같은 장애가 재발한다.
 */
const PING_MAX = Math.max(1, Math.min(32, Number(process.env.IPAM_PING_CONCURRENCY) || 8));
let _pingActive = 0;
const _pingWaiters = [];
function _pingAcquire() {
  if (_pingActive < PING_MAX) { _pingActive++; return Promise.resolve(); }
  return new Promise((res) => _pingWaiters.push(res));
}
function _pingRelease() {
  _pingActive--;
  const next = _pingWaiters.shift();
  if (next) { _pingActive++; next(); }
}

/**
 * ICMP ping 1회(v2.359, 사용자 요구: "ping 으로 IP 체크") — 시스템 ping 바이너리 사용
 * (raw socket 권한 불필요). 응답=true. 바이너리 없음/타임아웃/무응답은 조용히 false.
 * 동시 실행은 PING_MAX(기본 8)로 제한된다(v2.360) — 프로세스/FD 폭주 방지.
 */
export async function pingHost(ip, timeoutMs = 700) {
  if (!isIpv4(ip)) return false; // execFile(셸 미사용)이지만 인자 오염도 차단
  await _pingAcquire();
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const child = execFile('ping', pingArgs(ip, timeoutMs), { timeout: timeoutMs + 2_000, windowsHide: true }, (err) => done(!err));
        child.on('error', () => done(false)); // spawn 자체 실패(ping 미설치/EMFILE 등)
      } catch { done(false); }
    });
  } finally { _pingRelease(); }
}

/** 테스트용 — 현재 ping 동시성 상한(설정 확인). */
export function pingConcurrencyLimit() { return PING_MAX; }

async function scanOneHost(ip, ports, timeoutMs, reverseDns, ping) {
  const open = [];
  // 포트는 순차(호스트당 부하 제한). 첫 포트만 빠르게 죽으면 나머지도 대개 닫힘.
  for (const p of ports) { if (await tcpProbe(ip, p, timeoutMs)) open.push(p); }
  // 포트가 전부 닫혀도 ICMP ping 이 응답하면 '사용 중'(v2.359) — 방화벽으로 포트를 다 막은
  // 서버가 미사용으로 오판되는 갭을 메운다. ping 은 포트 무응답일 때만 1회(스캔 시간 최소화).
  let icmpOnly = false;
  if (!open.length) {
    if (!ping || !(await pingHost(ip, timeoutMs))) return null;
    icmpOnly = true;
  }
  let hostname = '';
  if (reverseDns) { try { const names = await dnsp.reverse(ip); hostname = names?.[0] || ''; } catch { /* no PTR */ } }
  return { ip, openPorts: open, services: icmpOnly ? ['ICMP(ping)'] : open.map(portService), hostname };
}

/** 대역(여러 spec) 스캔. 진행 콜백 onAlive(host)/onProgress(done,total,alive) 가능. 생존 호스트 배열 반환. */
export async function scanRanges(specs, { ports = DEFAULT_PORTS, concurrency = 128, timeoutMs = 700, reverseDns = true, ping = true, onAlive, onProgress } = {}) {
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
      const r = await scanOneHost(ip, ports, timeoutMs, reverseDns, ping).catch(() => null);
      done++;
      if (r) { alive.push(r); onAlive?.(r); }
      onProgress?.(done, total, alive.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length || 1) }, worker));
  return { scanned: ips.length, alive };
}
