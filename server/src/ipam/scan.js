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
let _pingPeak = 0; // 관측된 최대 동시 실행 수(검증/모니터링용) — 상한을 넘지 않음을 테스트로 박제.
const _pingWaiters = [];
// grant() 가 active 증가·peak 갱신을 전담한다(즉시 취득/대기 후 취득 두 경로가 동일하게 계수되도록).
function _pingGrant(res) { _pingActive++; if (_pingActive > _pingPeak) _pingPeak = _pingActive; res(); }
function _pingAcquire() {
  return new Promise((res) => { if (_pingActive < PING_MAX) _pingGrant(res); else _pingWaiters.push(() => _pingGrant(res)); });
}
function _pingRelease() {
  _pingActive--;
  const next = _pingWaiters.shift();
  if (next) next(); // 다음 대기자에게 슬롯 양도(active 증가는 grant 가)
}

/**
 * ping 슬롯 게이트 — 동시 실행을 PING_MAX 로 제한하는 공용 래퍼. pingHost 가 이걸 통해서만
 * 프로세스를 띄운다(⚠ 우회 금지 — 우회하면 v2.359 폭주 재발). task 는 실제 ping 프라미스.
 */
export async function withPingSlot(task) {
  await _pingAcquire();
  try { return await task(); } finally { _pingRelease(); }
}

/**
 * ICMP ping 1회(v2.359, 사용자 요구: "ping 으로 IP 체크") — 시스템 ping 바이너리 사용
 * (raw socket 권한 불필요). 응답=true. 바이너리 없음/타임아웃/무응답은 조용히 false.
 * 동시 실행은 PING_MAX(기본 8)로 제한된다(v2.360) — 프로세스/FD 폭주 방지.
 */
export async function pingHost(ip, timeoutMs = 700) {
  if (!isIpv4(ip)) return false; // execFile(셸 미사용)이지만 인자 오염도 차단 (슬롯 취득 전 조기 반환)
  return withPingSlot(() => new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = execFile('ping', pingArgs(ip, timeoutMs), { timeout: timeoutMs + 2_000, windowsHide: true }, (err) => done(!err));
      child.on('error', () => done(false)); // spawn 자체 실패(ping 미설치/EMFILE 등)
    } catch { done(false); }
  }));
}

/** 테스트용 — 현재 ping 동시성 상한(설정 확인). */
export function pingConcurrencyLimit() { return PING_MAX; }
/** 테스트/모니터링용 — 현재 동시 실행 수와 관측된 최대치. */
export function pingStats() { return { limit: PING_MAX, active: _pingActive, peak: _pingPeak }; }

/** 한 IP TCP 프로브 — 열린 포트 배열(없으면 []). ping/역DNS 는 2단계에서 일괄 처리. */
async function tcpPortsOf(ip, ports, timeoutMs) {
  const open = [];
  for (const p of ports) { if (await tcpProbe(ip, p, timeoutMs)) open.push(p); } // 순차(호스트당 부하 제한)
  return open;
}

// ── fping 배치 ping(v2.363) — IP마다 프로세스를 띄우는 대신 '한 프로세스로 다수 IP' 를
// 병렬 ping(내부 레이트리밋). 프로세스/FD 폭주가 구조적으로 불가능해 대량 스캔에 안전·고속.
// 미설치(에어갭 등)면 자동으로 per-IP capped ping 으로 폴백한다. IPAM_FPING=0 으로 강제 비활성.
let _fpingProbe = null;
export function fpingAvailable() {
  if (process.env.IPAM_FPING === '0') return Promise.resolve(false);
  if (!_fpingProbe) {
    _fpingProbe = new Promise((res) => {
      try { const c = execFile('fping', ['-v'], { timeout: 3_000, windowsHide: true }, (err) => res(!err)); c.on('error', () => res(false)); }
      catch { res(false); }
    });
  }
  return _fpingProbe;
}
/** fping 인자 — -a(생존만 출력) -q(호스트별 오류 억제) -r 0(재시도 없음) -t(대상별 타임아웃 ms). */
export function fpingArgs(ips, timeoutMs) {
  return ['-a', '-q', '-r', '0', '-t', String(Math.max(50, Math.round(timeoutMs))), ...ips];
}
/** 한 청크를 fping — 생존 IP Set. exit 1(일부 down)은 정상이므로 stdout 을 그대로 파싱한다. */
function fpingChunk(ips, timeoutMs) {
  return new Promise((resolve) => {
    const valid = ips.filter(isIpv4);
    if (!valid.length) return resolve(new Set());
    try {
      execFile('fping', fpingArgs(valid, timeoutMs), { timeout: timeoutMs * 2 + 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (_err, stdout) => {
        const set = new Set();
        String(stdout || '').split(/\r?\n/).forEach((l) => { const ip = l.trim(); if (isIpv4(ip)) set.add(ip); });
        resolve(set); // _err(exit 1=일부 미응답)는 무시 — 생존 목록은 stdout 이 진실
      });
    } catch { resolve(new Set()); }
  });
}
const FPING_CHUNK = 1000; // 한 fping 호출당 IP 수 상한(argv 폭주 방지)

/** 죽은(포트 무응답) IP 들 중 ICMP 응답이 있는 집합. fping 우선, 없으면 per-IP capped ping. */
async function pingAliveSet(deadIps, timeoutMs, ping) {
  const set = new Set();
  if (!ping || !deadIps.length) return set;
  if (await fpingAvailable()) {
    for (let i = 0; i < deadIps.length; i += FPING_CHUNK) {
      const got = await fpingChunk(deadIps.slice(i, i + FPING_CHUNK), timeoutMs);
      got.forEach((ip) => set.add(ip));
    }
  } else {
    // 폴백: per-IP `ping` — withPingSlot 이 동시 실행을 PING_MAX 로 제한(프로세스 폭주 방지).
    await Promise.all(deadIps.map((ip) => pingHost(ip, timeoutMs).then((ok) => { if (ok) set.add(ip); })));
  }
  return set;
}

/** 역DNS 일괄(동시성 제한) — 생존 IP 만 대상. */
async function reverseMany(ips, limit = 16) {
  const m = new Map();
  let i = 0;
  const worker = async () => {
    while (i < ips.length) {
      const ip = ips[i++];
      try { const names = await dnsp.reverse(ip); if (names?.[0]) m.set(ip, names[0]); } catch { /* no PTR */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ips.length || 1) }, worker));
  return m;
}

/**
 * 대역(여러 spec) 스캔 — 2단계(v2.363):
 *   1) 전 IP TCP 프로브(동시성 제한) → 열린 포트로 생존 판정.
 *   2) 포트가 전부 닫힌 IP만 ping(fping 배치 우선 / 폴백 capped per-IP) — 방화벽 서버 갭 보강.
 * 마지막에 생존 IP만 역DNS. onProgress(done,total,alive) 는 1단계(TCP) 기준으로 보고.
 * 반환·항목 형태는 이전과 동일: { scanned, alive:[{ip,openPorts,services,hostname}] }.
 */
export async function scanRanges(specs, { ports = DEFAULT_PORTS, concurrency = 128, timeoutMs = 700, reverseDns = true, ping = true, onAlive, onProgress } = {}) {
  const seen = new Set();
  const ips = [];
  for (const spec of (Array.isArray(specs) ? specs : [specs])) for (const ip of expandRange(spec)) if (!seen.has(ip)) { seen.add(ip); ips.push(ip); }
  const total = ips.length;
  onProgress?.(0, total, 0);

  // 1단계: TCP 전수.
  const tcp = new Map(); // ip -> openPorts[]
  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (idx < ips.length) {
      const ip = ips[idx++];
      const open = await tcpPortsOf(ip, ports, timeoutMs).catch(() => []);
      if (open.length) tcp.set(ip, open);
      done++;
      onProgress?.(done, total, tcp.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length || 1) }, worker));

  // 2단계: 포트 무응답 IP만 ping.
  const dead = ips.filter((ip) => !tcp.has(ip));
  const pinged = await pingAliveSet(dead, timeoutMs, ping);

  // 생존 IP = TCP 생존 ∪ ping 생존. 역DNS 일괄.
  const aliveIps = [...tcp.keys(), ...[...pinged]];
  const hostByIp = reverseDns ? await reverseMany(aliveIps) : new Map();
  const alive = aliveIps.map((ip) => {
    const open = tcp.get(ip);
    const row = { ip, openPorts: open || [], services: open ? open.map(portService) : ['ICMP(ping)'], hostname: hostByIp.get(ip) || '' };
    onAlive?.(row);
    return row;
  });
  onProgress?.(total, total, alive.length);
  return { scanned: ips.length, alive };
}
