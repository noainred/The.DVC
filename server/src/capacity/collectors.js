/**
 * Capacity Advisor 수집기 레지스트리 — '무엇을 측정할지'를 데이터로 등록한다.
 *
 * 향후 모니터링 지표를 추가할 때 여기 `register()` 한 줄이면 샘플러·저장·평가·화면(게이지·추세·
 * 권고)에 자동 편입된다(코드 상수로 흩어 두면 새 지표를 넣을 때마다 4곳을 고쳐야 한다).
 * 수집기는 Node 내장(os/process/perf_hooks/fs)만 쓴다 — 외부 의존성을 새로 들이지 않는다.
 *
 * 수집기 계약:
 *   key        저장 metric 키(= capacity.db samples.metric). 고유·스네이크.
 *   label      화면 라벨.
 *   unit       'pct' | 'ms' | 'mb' | 'bps' | 'ratio' — 화면 포맷·임계 해석에 쓴다.
 *   group      'cpu' | 'memory' | 'network' | 'disk' | 'runtime' — 리소스 축(권고 묶음 단위).
 *   higherBad  값이 높을수록 나쁜가(대부분 true; 여유공간처럼 낮을수록 나쁜 지표는 별도 취급 안 함).
 *   warn/bad   임계값(unit 기준). 창 통계가 이 값을 넘으면 증설 신호. null 이면 정보 지표(권고 제외).
 *   scaleHint  넘었을 때의 증설 축(사람이 읽는 한 줄).
 *   sample(ctx)→ number|null  한 스냅샷의 값. null 이면 이 플랫폼에서 미측정(예: 리눅스 전용 net).
 *              ctx = { now, cores, prev } — prev 는 직전 호출의 원자료(델타 계산용, 수집기가 채운다).
 *
 * 델타형 수집기(cpu/net)는 ctx.prev 에 자기 원자료를 남겨 다음 호출과의 차분으로 값을 낸다.
 * 첫 호출은 기준선만 잡고 null 을 반환한다(가짜 스파이크 방지).
 */

import os from 'node:os';
import fs from 'node:fs';
import { config } from '../config.js';

/** 레지스트리(순서 보존). key 중복은 마지막 등록이 이긴다(테스트 대체 편의). */
const registry = new Map();

/** 수집기 등록/교체. 반환은 자기 자신(체이닝). */
export function registerCollector(def) {
  if (!def || typeof def.key !== 'string' || typeof def.sample !== 'function') {
    throw new Error('collector 는 { key:string, sample:function } 이 필수입니다.');
  }
  registry.set(def.key, {
    key: def.key,
    label: def.label || def.key,
    unit: def.unit || 'pct',
    group: def.group || 'runtime',
    higherBad: def.higherBad !== false,
    warn: def.warn === undefined ? null : def.warn,
    bad: def.bad === undefined ? null : def.bad,
    scaleHint: def.scaleHint || '',
    sample: def.sample,
  });
  return def;
}

/** 등록된 수집기 목록(정의만; sample 함수 제외한 메타는 meta()). */
export function collectors() { return [...registry.values()]; }
export function collectorMeta() {
  return collectors().map((c) => ({
    key: c.key, label: c.label, unit: c.unit, group: c.group,
    higherBad: c.higherBad, warn: c.warn, bad: c.bad, scaleHint: c.scaleHint,
  }));
}

/* ── CPU 총사용률(시스템 전체) — os.cpus() times 누적의 차분 ── */
function cpuTimesTotal() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

/* ── /proc/net/dev 합산(리눅스) — 루프백 제외 rx/tx 바이트 누적 ── */
function procNetBytes() {
  try {
    const txt = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0; let tx = 0;
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      const iface = m[1].trim();
      if (iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker') || iface.startsWith('br-')) continue;
      const cols = m[2].trim().split(/\s+/).map(Number);
      if (cols.length >= 9) { rx += cols[0] || 0; tx += cols[8] || 0; }
    }
    return { rx, tx };
  } catch { return null; }
}

/* ── 디스크 여유(%사용) — capacity.db 가 놓인 파일시스템 ── */
function diskUsedPct() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(config.capacity.dbPath.replace(/[^/]+$/, '') || '.');
    const total = s.blocks * s.bsize;
    const free = s.bfree * s.bsize;
    if (!total) return null;
    return ((total - free) / total) * 100;
  } catch { return null; }
}

/** 기본 수집기 등록 — 최초 import 시 1회. 임계값은 운영 규모(28→30+ vCenter·고RTT)를 감안한 보수적 기본. */
registerCollector({
  key: 'cpu_system', label: 'CPU 사용률(시스템)', unit: 'pct', group: 'cpu',
  warn: 70, bad: 85, scaleHint: 'CPU 코어 증설 또는 수집 분산(엣지 위임 확대)',
  sample: (ctx) => {
    const cur = cpuTimesTotal();
    const p = ctx.prev.cpu;
    ctx.prev.cpu = cur;
    if (!p) return null;                       // 첫 호출은 기준선만
    const dt = cur.total - p.total;
    const di = cur.idle - p.idle;
    if (dt <= 0) return null;
    return Math.max(0, Math.min(100, (1 - di / dt) * 100));
  },
});
registerCollector({
  key: 'cpu_process', label: 'CPU 사용률(포탈 프로세스)', unit: 'pct', group: 'cpu',
  warn: null, bad: null, scaleHint: '',        // 정보 지표(전체 CPU 대비 포탈 점유 파악용)
  sample: (ctx) => {
    const cur = process.cpuUsage();            // µs (user+system)
    const t = ctx.now;
    const p = ctx.prev.pcpu;
    ctx.prev.pcpu = { cur, t };
    if (!p) return null;
    const dtMs = t - p.t;
    if (dtMs <= 0) return null;
    const usedUs = (cur.user + cur.system) - (p.cur.user + p.cur.system);
    // 프로세스 CPU% = 소비 CPU시간 / (경과시간 × 코어수) — 단일코어 100% = 100/cores.
    return Math.max(0, Math.min(100, (usedUs / 1000) / dtMs / ctx.cores * 100));
  },
});
registerCollector({
  key: 'event_loop_lag', label: '이벤트 루프 지연(p99)', unit: 'ms', group: 'runtime',
  warn: 100, bad: 300, scaleHint: 'CPU 증설 또는 동기 작업(대량 SQLite/직렬화) 오프로딩 — 응답 지연의 직접 원인',
  sample: (ctx) => {
    const h = ctx.prev.eld;                    // sampler 가 monitorEventLoopDelay 히스토그램을 넣어 준다
    if (!h) return null;
    let p99 = 0;
    try { p99 = h.percentile(99) / 1e6; h.reset(); } catch { return null; }  // ns → ms, 창마다 리셋
    return Number.isFinite(p99) ? p99 : null;
  },
});
registerCollector({
  key: 'mem_system', label: '메모리 사용률(시스템)', unit: 'pct', group: 'memory',
  warn: 80, bad: 92, scaleHint: '메모리 증설 — 스왑 유발 시 폴링·SQLite 전반이 느려짐',
  sample: () => {
    const total = os.totalmem();
    if (!total) return null;
    // 리눅스: os.freemem()은 MemFree(버퍼/캐시 제외)라 캐시가 채워진 정상 서버도 90%+로 나와
    // 만성 거짓 '증설' 권고가 된다. 커널이 계산해 주는 MemAvailable(회수 가능 포함)이 진실.
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8');
      const m = mi.match(/^MemAvailable:\s+(\d+)\s*kB/m);
      if (m) {
        const availB = Number(m[1]) * 1024;
        return Math.max(0, Math.min(100, ((total - availB) / total) * 100));
      }
    } catch { /* 비리눅스 — 아래 폴백 */ }
    // macOS 등: freemem 은 파일캐시를 사용 중으로 세어 과대평가된다(개발 환경 참고치).
    return ((total - os.freemem()) / total) * 100;
  },
});
registerCollector({
  key: 'mem_rss', label: '포탈 RSS', unit: 'mb', group: 'memory',
  warn: null, bad: null, scaleHint: '',        // 정보 지표(누수·증가추세는 evaluate 가 추세로 판단)
  sample: () => {
    try { return process.memoryUsage().rss / (1024 * 1024); } catch { return null; }
  },
});
registerCollector({
  key: 'load_per_core', label: '부하평균/코어(1분)', unit: 'ratio', group: 'cpu',
  warn: 1.0, bad: 2.0, scaleHint: 'CPU 코어 증설 — 1.0 초과는 실행 대기가 코어 수를 넘는다는 신호',
  sample: (ctx) => {
    const la = os.loadavg()[0];
    if (ctx.cores <= 0) return null;
    return la / ctx.cores;                     // 윈도우는 0 을 반환(플랫폼 특성) — 그대로 정보로 둔다
  },
});
registerCollector({
  key: 'disk_used', label: '디스크 사용률(데이터)', unit: 'pct', group: 'disk',
  warn: 80, bad: 90, scaleHint: '디스크 증설 또는 보존기간 단축 — 가득 차면 시계열/로그 적재가 멈춘다',
  sample: () => diskUsedPct(),
});
registerCollector({
  key: 'net_rx', label: '수신 처리량', unit: 'bps', group: 'network',
  warn: null, bad: null, scaleHint: '',        // 정보 지표(대역 상한을 서버가 모르므로 추세만)
  sample: (ctx) => {
    const cur = procNetBytes();
    const p = ctx.prev.net;
    if (cur) ctx.prev.net = { ...(p || {}), rx: cur.rx, tx: cur.tx, t: ctx.now };
    if (!cur || !p || p.rx == null) return null;
    const dtMs = ctx.now - p.t;
    if (dtMs <= 0) return null;
    return Math.max(0, (cur.rx - p.rx) / (dtMs / 1000) * 8);   // bytes/s → bits/s
  },
});
registerCollector({
  key: 'net_tx', label: '송신 처리량', unit: 'bps', group: 'network',
  warn: null, bad: null, scaleHint: '',
  sample: (ctx) => {
    // net_rx 가 ctx.prev.net 을 이미 갱신했다면 그 값을, 아니면 자기부담으로 읽는다.
    const p = ctx.prev.netTxPrev;
    const cur = ctx.prev.net;                  // net_rx 가 채운 최신 원자료
    ctx.prev.netTxPrev = cur ? { tx: cur.tx, t: cur.t } : null;
    if (!cur || !p || p.tx == null) return null;
    const dtMs = cur.t - p.t;
    if (dtMs <= 0) return null;
    return Math.max(0, (cur.tx - p.tx) / (dtMs / 1000) * 8);
  },
});
