/**
 * focusmon/load.js — 수집 부하(v2.983 — 사용자 2026-11-12 "이렇게 데이터를 수집하는게 엣지노드와 수집 대상 서버에 부하를 얼마나 주는지 확인하는 방법,
 * 서버에서 상태 수집해서 수집방법에 따른 분석해서 보여주는 기능" → 시안 ⑪ `docs/design/focus-mon/README.md` §17 · 컨펌 '구현해줘' + 구획 비용 '늘 잼 · 세 묶음').
 *
 * ── 계산 코어는 이 파일 하나 ────────────────────────────────────────────────────────────────────────
 *  · loadWindow: 원격 `##SELF` 두 번(보통 30초 간격)의 차이 → 대상 서버의 수집 CPU(코어 1개 = 100%) · sshd 몫 · 세 묶음 · 보내는 양 · 메모리.
 *    tick 은 원격 셸의 utime + stime + cutime + cstime(끝난 자식 포함 — grep · awk · cut · sleep …). 반복문이 새로 열리면(tick 감소) 창을 버린다(null).
 *  · judgeLoad: 문턱(설정 loadWarnPct · loadCritPct — 코어 1개 기준 %) → 'light' | 'mid' | 'heavy' · 값이 없으면 null(가벼움이 아니다).
 *  · estimateLoad: 묶음별 1회 비용(ms) × 횟수로 '주기를 바꾸면' 추정 — 화면이 추정이라고 밝힌다.
 *  · createNodeSampler: 이 포탈 프로세스(중앙 또는 엣지)의 CPU · 메모리 · 이벤트 루프 지연 p99 · 받은 양 · 해석 시간.
 *
 * ── 지키는 것 ────────────────────────────────────────────────────────────────────────────────────────
 *  · 못 읽은 값은 null(0 아님) — 창이 짧거나(5초 미만) 길거나(10분 초과) tick 이 줄면 창 전체를 버린다.
 *  · 원격 값은 정수만(parse.parseSelf) · 여기서는 음수 차이를 받지 않는다.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const LOAD_WINDOW_MIN_S = 5;
export const LOAD_WINDOW_MAX_S = 600;
/** 묶음 이름(원격 스크립트의 CB · CC · CP 순서). */
export const LOAD_GROUPS = Object.freeze(['base', 'topo', 'proc']);
/** 구성 묶음 주기(초) — script.js TOPO_EVERY_S 와 같다(테스트가 대조). */
const TOPO_S = 30;

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/**
 * 창 하나 계산.
 * @param {{up:number, self:{ticks:number, rssPages:number|null}|null, sshd:{ticks:number, rssPages:number|null}|null, groups:{base:number, topo:number, proc:number}|null}} prev
 * @param {typeof prev} cur
 * @param {{tck?:number, page?:number, ncpu?:number, bytes?:{base?:number, topo?:number, proc?:number, self?:number}, frames?:number, topoRuns?:number, procRuns?:number}} ctx
 * @returns {object|null}
 */
export function loadWindow(prev, cur, ctx = {}) {
  if (!prev || !cur) return null;
  const up0 = fin(prev.up); const up1 = fin(cur.up);
  if (up0 == null || up1 == null) return null;
  const dt = up1 - up0;
  if (!(dt >= LOAD_WINDOW_MIN_S && dt <= LOAD_WINDOW_MAX_S)) return null;
  const tck = fin(ctx.tck) && ctx.tck > 0 ? ctx.tck : null;
  if (!tck) return null;
  const pctOf = (d) => (d == null ? null : r2((d / (dt * tck)) * 100));
  const diff = (a, b) => { const x = fin(a); const y = fin(b); if (x == null || y == null || y < x) return null; return y - x; };
  const dSelf = diff(prev.self?.ticks, cur.self?.ticks);
  if (dSelf == null) return null; // 셸이 바뀌었다(새 반복문) · 못 읽음 — 창을 버린다
  const dSshd = diff(prev.sshd?.ticks, cur.sshd?.ticks);
  const page = fin(ctx.page) && ctx.page > 0 ? ctx.page : 4096;
  const runs = { base: Math.max(0, ctx.frames | 0), topo: Math.max(0, ctx.topoRuns | 0), proc: Math.max(0, ctx.procRuns | 0) };
  const groups = {};
  for (const g of LOAD_GROUPS) {
    const d = diff(prev.groups?.[g], cur.groups?.[g]);
    groups[g] = { pct: pctOf(d), runs: runs[g], msPerRun: d == null || !runs[g] ? null : r2((d / runs[g]) * (1000 / tck)) };
  }
  const b = ctx.bytes || {};
  const bytes = { base: Math.max(0, fin(b.base) ?? 0), topo: Math.max(0, fin(b.topo) ?? 0), proc: Math.max(0, fin(b.proc) ?? 0), self: Math.max(0, fin(b.self) ?? 0) };
  const total = bytes.base + bytes.topo + bytes.proc + bytes.self;
  const cpuPct = pctOf(dSelf);
  const ncpu = fin(ctx.ncpu) && ctx.ncpu > 0 ? ctx.ncpu : null;
  return {
    windowS: r2(dt),
    cpuPct,
    serverPct: cpuPct == null || !ncpu ? null : r2(cpuPct / ncpu), // 서버 전체(코어 수 × 100%) 대비
    sshdPct: pctOf(dSshd),
    groups,
    bps: r2(total / dt),
    bpsBy: { base: r2(bytes.base / dt), topo: r2(bytes.topo / dt), proc: r2(bytes.proc / dt), self: r2(bytes.self / dt) },
    bytesPerRun: { base: runs.base ? Math.round(bytes.base / runs.base) : null, topo: runs.topo ? Math.round(bytes.topo / runs.topo) : null, proc: runs.proc ? Math.round(bytes.proc / runs.proc) : null },
    rssBytes: fin(cur.self?.rssPages) == null ? null : cur.self.rssPages * page,
    sshdRssBytes: fin(cur.sshd?.rssPages) == null ? null : cur.sshd.rssPages * page,
    ncpu,
  };
}

/** 판정 — 문턱은 코어 1개 기준 %(설정). 값이 없으면 null. */
export function judgeLoad(pct, { loadWarnPct = 1, loadCritPct = 3 } = {}) {
  const v = fin(pct);
  if (v == null) return null;
  return v >= loadCritPct ? 'heavy' : v >= loadWarnPct ? 'mid' : 'light';
}

/**
 * '주기를 바꾸면' 추정 — 묶음별 1회 비용(ms) · 1회 바이트 × 초당 횟수. 1회 비용을 모르는 묶음은 null(그 묶음을 0 으로 치지 않는다 → 합도 null).
 * 프로세스 묶음은 max(프로세스 표본 주기, 주기)마다, 구성은 30초마다(주기가 더 길면 주기마다), 기본은 주기마다.
 * @returns {{cpuPct:number|null, bps:number|null, by:{base:number|null, topo:number|null, proc:number|null}}}
 */
export function estimateLoad(load, { interval, procEvery }) {
  const I = fin(interval) && interval > 0 ? interval : null;
  const P = fin(procEvery) && procEvery > 0 ? procEvery : null;
  if (!load || !I || !P) return { cpuPct: null, bps: null, by: { base: null, topo: null, proc: null } };
  const every = { base: I, topo: Math.max(TOPO_S, I), proc: Math.max(P, I) };
  const by = {}; let sum = 0; let ok = true; let bsum = 0; let bok = true;
  for (const g of LOAD_GROUPS) {
    const ms = fin(load.groups?.[g]?.msPerRun);
    by[g] = ms == null ? null : r2(ms / every[g] / 10); // ms/초 → % (1000ms = 100%)
    if (by[g] == null) ok = false; else sum += by[g];
    const bpr = fin(load.bytesPerRun?.[g]);
    if (bpr == null) bok = false; else bsum += bpr / every[g];
  }
  return { cpuPct: ok ? r2(sum) : null, bps: bok ? Math.round(bsum) : null, by };
}

/** 노드 카운터(이 프로세스 전체 — collector.js 가 더한다): 받은 바이트 · 해석에 쓴 시간. */
export const nodeCounters = { rxBytes: 0, parseMs: 0 };

/**
 * 노드 표본기 — 부를 때마다 앞 부름과의 차이로 한 창을 만든다(보통 30초). 이벤트 루프 지연은 창마다 새로 잰다(p99 · ms).
 * @param {{now?:()=>number, sessions?:()=>number}} o
 */
export function createNodeSampler({ now = () => Date.now(), sessions = () => 0 } = {}) {
  let h = null;
  try { h = monitorEventLoopDelay({ resolution: 20 }); h.enable(); } catch { h = null; }
  let prev = { at: now(), cpu: process.cpuUsage(), rx: nodeCounters.rxBytes, parse: nodeCounters.parseMs };
  let last = null;
  return {
    sample() {
      const at = now(); const cpu = process.cpuUsage(); const rx = nodeCounters.rxBytes; const parse = nodeCounters.parseMs;
      const ms = at - prev.at;
      if (ms >= 1000) {
        const used = (cpu.user - prev.cpu.user + cpu.system - prev.cpu.system) / 1000; // ms
        const p99 = h ? h.percentile(99) / 1e6 : null;
        last = {
          at, windowS: r2(ms / 1000),
          cpuPct: r2((used / ms) * 100), // 이 포탈 프로세스 전체(코어 1개 = 100%)
          fmPct: r2(((parse - prev.parse) / ms) * 100), // 그중 집중 모니터링 해석(줄 받기 · 프레임 계산) — SSH 복호 · 기록은 빠진다(추정의 아래쪽)
          rssBytes: process.memoryUsage().rss,
          elP99Ms: p99 == null || !Number.isFinite(p99) ? null : r2(p99),
          rxBps: r2((rx - prev.rx) / (ms / 1000)),
          sessions: sessions(),
        };
        if (h) h.reset();
        prev = { at, cpu, rx, parse };
      }
      return last;
    },
    last: () => last,
    stop() { try { h?.disable(); } catch { /* */ } },
  };
}

/**
 * 창 여러 개 → 평균(과거 구간 — DB 의 분당 한 줄). 수 칸은 null 을 빼고 평균(모두 null 이면 null) · 주기 · 코어 · 프로세스 수 · 메모리는 마지막 값.
 * @param {object[]} list  loadWindow 모양(시각 순)
 */
export function averageLoads(list = []) {
  const xs = (list || []).filter((x) => x && typeof x === 'object');
  if (!xs.length) return null;
  const avg = (get) => { let s = 0; let k = 0; for (const x of xs) { const v = fin(get(x)); if (v != null) { s += v; k += 1; } } return k ? r2(s / k) : null; };
  const last = xs[xs.length - 1];
  const groups = {};
  for (const g of LOAD_GROUPS) groups[g] = { pct: avg((x) => x.groups?.[g]?.pct), runs: Math.round(avg((x) => x.groups?.[g]?.runs) ?? 0) || null, msPerRun: avg((x) => x.groups?.[g]?.msPerRun) };
  const by = (k) => avg((x) => x.bpsBy?.[k]);
  const per = (k) => { const v = avg((x) => x.bytesPerRun?.[k]); return v == null ? null : Math.round(v); };
  return {
    windowS: r2(xs.reduce((a, x) => a + (fin(x.windowS) ?? 0), 0)), windows: xs.length,
    cpuPct: avg((x) => x.cpuPct), serverPct: avg((x) => x.serverPct), sshdPct: avg((x) => x.sshdPct), groups,
    bps: avg((x) => x.bps), bpsBy: { base: by('base'), topo: by('topo'), proc: by('proc'), self: by('self') },
    bytesPerRun: { base: per('base'), topo: per('topo'), proc: per('proc') },
    rssBytes: fin(last.rssBytes), sshdRssBytes: fin(last.sshdRssBytes), ncpu: fin(last.ncpu), interval: fin(last.interval), procEvery: fin(last.procEvery), procs: fin(last.procs),
    at: fin(last.at), via: last.via === 'edge' ? 'edge' : undefined, demo: last.demo === true ? true : undefined,
  };
}
/** 노드 표본 여러 개 → 평균(수 칸 · null 제외) · 세션 수는 마지막. */
export function averageNodes(list = []) {
  const xs = (list || []).filter((x) => x && typeof x === 'object');
  if (!xs.length) return null;
  const avg = (k) => { let s = 0; let n = 0; for (const x of xs) { const v = fin(x[k]); if (v != null) { s += v; n += 1; } } return n ? r2(s / n) : null; };
  const last = xs[xs.length - 1];
  return { windowS: r2(xs.reduce((a, x) => a + (fin(x.windowS) ?? 0), 0)), windows: xs.length, cpuPct: avg('cpuPct'), fmPct: avg('fmPct'), rssBytes: fin(last.rssBytes), elP99Ms: avg('elP99Ms'),
    rxBps: avg('rxBps'), txBps: avg('txBps'), dbWriteBps: avg('dbWriteBps'), dbBytes: fin(last.dbBytes), sessions: fin(last.sessions), at: fin(last.at) };
}

/**
 * 요약 4칸(화면 KPI) — 대상 서버 수집 CPU(평균 · 최고) · 보내는 양(경로별) · 기록 DB 쓰기(보관 기간 추정). 값이 있는 대상만 센다(없는 대상은 따로 — missing).
 * @param {{id:string, name:string, agent:string, load:object|null}[]} rows
 * @param {object[]} nodes  [{kind:'central'|'edge', load}]
 */
export function loadTotals(rows = [], nodes = [], { retentionDays = 30 } = {}) {
  const has = rows.filter((x) => fin(x.load?.cpuPct) != null);
  const top = has.reduce((a, x) => (a == null || x.load.cpuPct > a.load.cpuPct ? x : a), null);
  const sum = (xs, get) => { let s = 0; let k = 0; for (const x of xs) { const v = fin(get(x)); if (v != null) { s += v; k += 1; } } return k ? r2(s) : null; };
  const central = nodes.find((x) => x.kind === 'central');
  const dbBps = fin(central?.load?.dbWriteBps);
  return {
    servers: rows.length, measured: has.length, missing: rows.length - has.length,
    cpuAvg: has.length ? r2(has.reduce((a, x) => a + x.load.cpuPct, 0) / has.length) : null,
    cpuMax: top ? { id: top.id, name: top.name, pct: top.load.cpuPct } : null,
    bps: sum(has, (x) => x.load.bps),
    centralDirectBps: sum(has.filter((x) => !x.agent), (x) => x.load.bps), // 원문이 중앙까지 오는 경로(중앙이 직접 수집)
    edgeLocalBps: sum(has.filter((x) => x.agent), (x) => x.load.bps), // 원문은 법인 안(엣지) — 중앙에는 계산된 값만
    edgeToCentralBps: sum(nodes.filter((x) => x.kind === 'edge'), (x) => x.load?.txBps),
    dbWriteBps: dbBps,
    dbRetentionBytes: dbBps == null ? null : Math.round(dbBps * 86_400 * retentionDays), // 지금 쓰는 속도로 보관 기간을 채우면(추정 — 압축 · 색인 · 정리 시점은 빠진다)
  };
}
