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
import { numToIp, isIpv4 } from '../util/ipv4.js';
import { checkRangeSpec } from './rangeSyntax.js'; // v2.639: 대역 문법 판정 코어 하나
import { poolRun } from '../util/pool.js'; // v2.575 IMP-08 — 동시성 풀 단일 소스

export const DEFAULT_PORTS = [22, 80, 443, 445, 3389, 623, 8006, 902, 5985, 5986];
const SERVICE = {
  22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 445: 'SMB', 3389: 'RDP', 623: 'IPMI/BMC',
  8006: 'Proxmox', 902: 'ESXi', 5985: 'WinRM', 5986: 'WinRM-S', 161: 'SNMP',
};
export const portService = (p) => SERVICE[p] || String(p);

// v2.586 — 예전 판본은 '10..1.1'·'10.1.1.' 을 유효로 받았다(빈 옥텟 → 0). 판정은 util/ipv4.js 하나.
export { isIpv4 };

export const RANGE_CAP = 4096; // spec 1개당 확장 IP 안전 상한

/*
 * v2.639: 대역 문법 판정은 `rangeSyntax.checkRangeSpec` 하나다. 예전에는 이 파일(`rangeSize`·`expandRange`)·
 * `rangePolicies.specToRange`·`rangeSyntax` 가 각자 `split('/')`·`split('-')` 로 읽어 **같은 줄을 다르게 판정**했다 —
 * `10.0.0.0/8/x`(rangeSize 16,777,214 · expandRange 4,096개 · checkRangeSpec 오류) · `10.0.0.250-300`(끝 옥텟 300 을
 * 그대로 더해 10.0.1.44 까지) · `10.0.0.0/24.5`(Number('24.5') → 179.019개) · `10.0.0.1-2-3`(첫 두 조각만). 그래서
 * PUT vc-ranges 는 거부하는 줄을 CSV 가져오기·PUT scan/settings 는 저장했고, 엣지는 그 줄을 스캔한 뒤 중앙
 * `/ip-scan-result` 가 `specToRange` null 로 전부 거부했다. 여기 두 함수는 그 판정 위에서 **스캔의 의미**(CIDR 의
 * 네트워크·브로드캐스트 제외, RANGE_CAP 상한)만 얹는 어댑터다. 뒤집힌 범위는 스캔에서는 오류다(`reversed:'error'`).
 */
const judge = (spec) => checkRangeSpec(spec, { reversed: 'error' });
/** 판정 결과 → 스캔 대상 [lo, hi](CIDR 은 /31·/32 만 전체, 그 외는 네트워크·브로드캐스트 제외). */
function scanBounds(r) {
  if (r.kind === 'cidr' && r.size > 2) return { lo: r.lo + 1, hi: r.hi - 1 };
  return { lo: r.lo, hi: r.hi };
}

/** spec의 '진짜' IP 개수(배열 생성 없이 계산, 4096 상한 미적용 — 표시용). 0이면 무효 spec. */
export function rangeSize(spec) {
  const r = judge(spec);
  if (!r.ok) return 0;
  const { lo, hi } = scanBounds(r);
  return hi - lo + 1;
}

/** "10.0.0.0/24" | "10.0.0.1-10.0.0.50" | "10.0.0.1-50" | "10.0.0.5" → IP 배열(스캔용, 4096 상한). */
export function expandRange(spec) {
  const r = judge(spec);
  if (!r.ok) return [];
  const { lo, hi } = scanBounds(r);
  const total = hi - lo + 1;
  // 상한을 '생성 후 slice'가 아니라 루프 종료조건으로 적용 — /8(1670만) 등은 slice 전에 이미
  // 전체 배열(~1GB)을 할당하며 이벤트 루프를 수 초 블로킹한다. 앞 RANGE_CAP개만 만든다.
  if (total > RANGE_CAP) console.warn(`[ipscan] 대역 ${String(spec).trim()}이(가) ${total}개로 ${RANGE_CAP} 상한 초과 — 앞 ${RANGE_CAP}개만 스캔합니다. /24 단위로 나눠 등록하세요.`);
  const end = lo + Math.min(total, RANGE_CAP);
  const out = [];
  for (let n = lo; n < end; n++) out.push(numToIp(n));
  return out; // 이미 상한 적용됨
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
  // v2.575 IMP-08: 동시성 풀은 `util/pool.js` 하나다. 여기는 항목별 실패(PTR 없음)를
  // 스스로 삼키므로 `poolRun`(첫 rejection 을 올리는 쪽) 이 맞다.
  await poolRun(ips, limit, async (ip) => {
    try { const names = await dnsp.reverse(ip); if (names?.[0]) m.set(ip, names[0]); } catch { /* no PTR */ }
  });
  return m;
}

/*
 * v2.991(설계 docs/design/bm-folders §13 ③ — 정방향 DNS): 물리서버 이름(iDRAC 이 읽은 호스트 이름 — 중앙이 배정과 함께 준다)을 DNS 에 물어 IP 를 받는다.
 *   **스캔 대역 안의 IP 만** 채택하고 그 IP 행에 `fwdName` 으로 단다(역방향 이름 `hostname` 과 따로 — 둘이 다르면 화면이 둘 다 보인다).
 *   계정 없이 OS 주소를 찾는 방법은 DNS 뿐이다. 접속은 하지 않는다.
 *   · getaddrinfo(`dns.lookup`)를 쓴다 — resolve4(c-ares)는 resolv.conf 의 search 도메인을 붙이지 않아 짧은 이름이 풀리지 않는다.
 *   · lookup 은 시한이 없다 → 이름마다 시한(Promise.race)을 건다. 시한이 지나도 libuv 스레드는 끝날 때까지 돈다 — 동시 4개(스레드풀 기본 크기)로
 *     묶어 다른 파일 · DNS 작업을 밀어내지 않게 한다. 스캔은 별도 자식 프로세스에서 돈다(scanWorker — 포탈 이벤트 루프와 무관).
 *   · 이름은 꼴(호스트 이름 문자 · 253자)만 받고 IPv4 꼴 이름은 버린다 · 상한 FWD_NAMES_MAX.
 */
export const FWD_NAMES_MAX = 3000;
export const FWD_TIMEOUT_MS = 2500;
const FWD_CONCURRENCY = 4;
/*
 * 정방향 단계 **전체 예산** · 차단기 — 이름 3,000개 × 2.5초 ÷ 4 = 최악 약 31분이 스캔에 더해지면 스캔 시한(scanDeadlineMs)을 넘겨 **기존 스캔까지**
 * 미완료가 된다(DNS 가 응답하지 않는 현장). 예산을 넘기면 남은 이름은 묻지 않고(skipped), 처음 FWD_BREAK_AFTER 개가 전부 시한 초과면 DNS 가 닿지 않는 것으로 보고 멈춘다.
 */
export const FWD_BUDGET_MS = 90_000;
export const FWD_BREAK_AFTER = 8;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** 정방향 조회 이름 정리(순수) — 꼴이 맞는 이름만 · 대소문자 무시 중복 제거 · 상한. */
export function cleanFwdNames(list) {
  const out = []; const seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (out.length >= FWD_NAMES_MAX) break;
    if (typeof v !== 'string') continue;
    const n = v.trim().replace(/\.$/, '');
    if (!n || n.length > 253 || isIpv4(n)) continue;
    if (!n.split('.').every((l) => HOST_LABEL.test(l))) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  return out;
}
/**
 * 이름 → IP(정방향) 일괄. 반환 Map<ip, name> — 대역 안(inScope)의 IP 만. 같은 IP 에 이름이 둘 이상이면 먼저 찾은 것(이름 순)을 쓰고 `conflicts` 를 센다.
 * `lookup` 은 시험 주입용(기본 dns.promises.lookup).
 */
export async function forwardMany(names, inScope, { lookup = dnsp.lookup, timeoutMs = FWD_TIMEOUT_MS, limit = FWD_CONCURRENCY, budgetMs = FWD_BUDGET_MS, breakAfter = FWD_BREAK_AFTER, now = Date.now } = {}) {
  const byIp = new Map(); let conflicts = 0; let failed = 0; let timedOut = 0; let skipped = 0; let answered = 0; let stop = '';
  const list = cleanFwdNames(names).sort((a, b) => a.localeCompare(b));
  const found = new Map();   // name → [ip...]
  const t0 = now();
  // 묻는 순서는 시각(시간 단위)마다 돌린다 — 예산에 늘 걸리는 현장에서 같은 꼬리 이름이 매번 빠지지 않게. 같은 IP 의 이름 고르기는 아래에서 이름 순(결정적).
  const off = list.length ? Math.floor(t0 / 3_600_000) % list.length : 0;
  const order = off ? [...list.slice(off), ...list.slice(0, off)] : list;
  await poolRun(order, limit, async (name) => {
    if (!stop && now() - t0 > budgetMs) stop = 'budget';
    if (!stop && !answered && timedOut >= breakAfter) stop = 'unreachable';
    if (stop) { skipped += 1; return; }
    let timer = null;
    try {
      const r = await Promise.race([
        lookup(name, { all: true, family: 4 }),
        // 시한 타이머는 unref 하지 않는다 — 조회만 남은 순간 이벤트 루프가 빠져나가 결과 없이 끝나지 않게(짧다 · finally 에서 지운다)
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), timeoutMs); }),
      ]);
      answered += 1;
      const ips = (Array.isArray(r) ? r : [r]).map((x) => (x && typeof x === 'object' ? x.address : x)).filter((ip) => typeof ip === 'string' && inScope.has(ip));
      if (ips.length) found.set(name, [...new Set(ips)]);
    } catch (e) { if (e?.code === 'ETIMEOUT') timedOut += 1; else { failed += 1; answered += 1; } } finally { if (timer) clearTimeout(timer); }
  });
  for (const name of list) for (const ip of found.get(name) || []) { if (byIp.has(ip)) { if (byIp.get(ip).toLowerCase() !== name.toLowerCase()) conflicts += 1; } else byIp.set(ip, name); }
  return { byIp, stats: { names: list.length, found: found.size, failed, timedOut, conflicts, skipped, ...(stop ? { stopped: stop } : {}) } };
}

/**
 * 대역(여러 spec) 스캔 — 2단계(v2.363):
 *   1) 전 IP TCP 프로브(동시성 제한) → 열린 포트로 생존 판정.
 *   2) 포트가 전부 닫힌 IP만 ping(fping 배치 우선 / 폴백 capped per-IP) — 방화벽 서버 갭 보강.
 * 마지막에 생존 IP만 역DNS. onProgress(done,total,alive) 는 1단계(TCP) 기준으로 보고.
 * onTcpAlive(row) 는 1단계에서 열린 포트를 찾을 때마다 부른다(v2.733 — 시한 초과 시 부분 결과. hostname 은 빈 값).
 * 반환·항목 형태는 이전과 동일: { scanned, alive:[{ip,openPorts,services,hostname}] }.
 */
export async function scanRanges(specs, { ports = DEFAULT_PORTS, concurrency = 128, timeoutMs = 700, reverseDns = true, ping = true, names = null, lookup = undefined, onAlive, onTcpAlive, onProgress } = {}) {
  const seen = new Set();
  const ips = [];
  for (const spec of (Array.isArray(specs) ? specs : [specs])) for (const ip of expandRange(spec)) if (!seen.has(ip)) { seen.add(ip); ips.push(ip); }
  const total = ips.length;
  onProgress?.(0, total, 0);

  // 1단계: TCP 전수.
  const tcp = new Map(); // ip -> openPorts[]
  let done = 0;
  // v2.575 IMP-08: 동시성 풀 단일 소스. `tcpPortsOf` 의 실패는 이미 `.catch` 로 삼킨다.
  await poolRun(ips, concurrency, async (ip) => {
    const open = await tcpPortsOf(ip, ports, timeoutMs).catch(() => []);
    if (open.length) {
      tcp.set(ip, open);
      // v2.733(점검 3회차 C1-02): 1단계에서 찾은 생존 IP 를 바로 알린다 — 워커가 시한에 걸려 죽어도 부모가 '부분 결과' 로
      //   마지막 확인 시각을 갱신할 수 있게(호스트명은 아직 없다 — 역DNS 는 마지막 단계다). 콜백 오류가 스캔을 깨지 않게.
      try { onTcpAlive?.({ ip, openPorts: open, services: open.map(portService), hostname: '' }); } catch { /* 부분 결과는 보조 */ }
    }
    done++;
    onProgress?.(done, total, tcp.size);
  });

  // 2단계: 포트 무응답 IP만 ping.
  const dead = ips.filter((ip) => !tcp.has(ip));
  const pinged = await pingAliveSet(dead, timeoutMs, ping);

  // 생존 IP = TCP 생존 ∪ ping 생존. 역DNS 일괄.
  const aliveIps = [...tcp.keys(), ...[...pinged]];
  const hostByIp = reverseDns ? await reverseMany(aliveIps) : new Map();
  // v2.991(③): 정방향 DNS — 이름을 받았을 때만(배정 · 설정이 준다). 채택은 **살아 있는 IP**(이 결과에 행이 있는 IP)만 — 대역 안이어도
  //   응답이 없는 IP 는 행이 없어 달 곳이 없다(스캔 결과 = 살아 있는 IP).
  const fwd = Array.isArray(names) && names.length ? await forwardMany(names, new Set(aliveIps), lookup ? { lookup } : {}) : null;
  const alive = aliveIps.map((ip) => {
    const open = tcp.get(ip);
    const row = { ip, openPorts: open || [], services: open ? open.map(portService) : ['ICMP(ping)'], hostname: hostByIp.get(ip) || '' };
    const fn = fwd?.byIp.get(ip);
    if (fn) row.fwdName = fn;
    onAlive?.(row);
    return row;
  });
  onProgress?.(total, total, alive.length);
  return { scanned: ips.length, alive, ...(fwd ? { fwd: fwd.stats } : {}) };
}
