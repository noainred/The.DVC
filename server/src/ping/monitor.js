/**
 * Ping 모니터 — 등록된 활성 대상을 재서(ICMP 또는 TCP 연결 지연) 시계열 DB에 기록한다.
 *
 * v2.964(사용자 요청 "화면에서 주기 설정 · ping 은 중단없이 계속 ping" — 선택: '1초 간격 연속 측정 + 주기 요약' · 표준 검증):
 *  · 예전: `setInterval` 로 1분마다 전 대상을 한 바퀴(동시 8) — 한 바퀴가 주기보다 길면 재진입 가드가 다음 회차를 **건너뛰어** 기록이 비었고,
 *    주기는 시작 때 env 로 굳어 바꾸려면 재시작해야 했다.
 *  · 지금: **대상마다 독립 루프**가 '재기 → 측정 간격(기본 1초)에서 걸린 시간을 뺀 만큼 쉼 → 다시' 를 쉬지 않고 돈다. 느린(시한에 걸리는) 대상이
 *    다른 대상을 막지 않고, 건너뛰는 회차가 없다. 잰 값은 대상별 누적기에 모았다가 **요약 주기(기본 1분)의 시계 경계마다** 대상당 한 줄
 *    (n·fail·rn·평균·최저·최고 — ping/db.js 요약 줄)로 한 트랜잭션에 쓴다. 저장 행 수는 예전(1분 1줄)과 같다.
 *  · 설정은 `ping/settings.js`(화면 '측정 설정' · 기본은 env). 바뀌면 재시작 없이 — 지금 창을 마감해 쓰고 새 요약 주기 경계로 다시 맞추며,
 *    쉬고 있는 루프를 깨워 새 측정 간격을 바로 쓴다.
 *
 * 성능/안정성(운영 환경 규칙):
 *  · DNS 는 대상 호스트마다 캐시(60초, 실패 10초, 조회 시한 3초) — 1초마다 조회하면 libuv 스레드 풀(4)을 DNS 가 차지한다.
 *    이름이 바뀌어도 1분 안에 따라간다. IP 대상은 조회하지 않는다.
 *  · ICMP 는 ping 프로세스를 띄우므로 동시 프로세스 수를 `config.ping.concurrency`(기본 8)로 묶는다(TCP 연결은 대상마다 1개라 상한 밖).
 *  · DB 쓰기는 요약 주기마다 1회(insertMany 트랜잭션) · prune 은 약 20분마다(첫 마감 제외 — 기동 첫 틱 금지).
 *  · 대상 목록은 10초마다 맞춘다(추가·삭제·끄기·주소 변경 — 파일 토큰 비교라 가볍다). 지운 대상의 남은 누적값은 다음 마감에 쓰고 루프를 정리한다.
 *  · 모든 타이머는 unref — 종료를 붙잡지 않는다. 데모(mock)는 합성 값을 요약 주기마다 1회 적재한다(예전과 같다 — 실제로 재지 않는다).
 */

import dns from 'node:dns';
import net from 'node:net';
import { config, loadVcenterConfig } from '../config.js';
import { getPingDb } from './db.js';
import { enabledTargets, seedVcenterTargets, seedEdgeTargets, syncVcPortTargets } from './store.js';
import { listCollectors } from '../collector/registry.js';
import { pingOne, tcpConnect } from '../util/ping.js';
import { isMockMode, mockPingPollTick } from '../mock/seed.js';
import { loadPingSettings, onPingSettingsChange } from './settings.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';

const PRUNE_EVERY_MS = 20 * 60_000;
const RECONCILE_MS = 10_000;
const DNS_TTL_MS = 60_000;
const DNS_FAIL_TTL_MS = 10_000;
const DNS_TIMEOUT_MS = 3_000;
const DNS_MAX = 2_000;

const round2 = (x) => Math.round(x * 100) / 100;
const unref = (t) => { t?.unref?.(); return t; };

/* ── DNS 캐시 ─────────────────────────────────────────────────────────── */
const _dns = new Map();   // host → { addr, at, p }
/**
 * 호스트 → 주소(캐시). 만료된 값이 있으면 그 값을 바로 돌려주고 뒤에서 새로 조회한다(측정이 DNS 를 기다리지 않게).
 * 조회 실패는 null(그 측정은 실패로 센다).
 */
export function resolveCached(host, { now = Date.now, lookup = (h) => dns.promises.lookup(h) } = {}) {
  const h = String(host || '').trim();
  if (!h) return Promise.resolve(null);
  if (net.isIP(h)) return Promise.resolve(h);
  const c = _dns.get(h);
  if (c && now() - c.at < (c.addr ? DNS_TTL_MS : DNS_FAIL_TTL_MS)) return Promise.resolve(c.addr);
  // 만료(또는 처음) — 같은 호스트의 조회는 하나만 띄워 함께 기다린다.
  if (!c?.p) {
    let to = null;
    const p = Promise.race([
      Promise.resolve().then(() => lookup(h)).then((r) => r?.address || null),
      new Promise((resolve) => { to = unref(setTimeout(() => resolve(null), DNS_TIMEOUT_MS)); }),
    ]).catch(() => null).then((addr) => {
      if (to) clearTimeout(to);
      const cur = _dns.get(h);
      const stale = cur?.addr ?? null;
      // 실패했는데 예전 주소가 있으면 그 주소를 실패 TTL(10초) 동안 더 쓴다 — 일시적 DNS 장애가 측정 실패로 번지지 않게.
      if (addr) _dns.set(h, { addr, at: now(), p: null });
      else _dns.set(h, { addr: stale, at: stale ? now() - (DNS_TTL_MS - DNS_FAIL_TTL_MS) : now(), p: null });
      return addr ?? stale;
    });
    if (!c && _dns.size >= DNS_MAX) _dns.delete(_dns.keys().next().value);
    _dns.set(h, { addr: c?.addr ?? null, at: c?.at ?? 0, p });
  }
  const cur = _dns.get(h);
  // 예전 주소가 있으면 기다리지 않고 그것으로 잰다(새 조회는 뒤에서) — 측정 간격이 DNS 지연에 끌려가지 않게.
  return cur.addr ? Promise.resolve(cur.addr) : cur.p;
}
export function _resetDnsCacheForTest() { _dns.clear(); }

/* ── ICMP 프로세스 상한 ─────────────────────────────────────────────────── */
/** 동시 슬롯 — 놓을 때 기다리는 쪽에 슬롯을 바로 넘긴다(넘치는 순간이 없다). */
export function createSlots(getMax) {
  let busy = 0; const q = [];
  return {
    acquire() {
      if (busy < Math.max(1, getMax())) { busy += 1; return Promise.resolve(); }
      return new Promise((r) => q.push(r));
    },
    release() { const next = q.shift(); if (next) next(); else busy = Math.max(0, busy - 1); },
    get busy() { return busy; },
    get waiting() { return q.length; },
  };
}

/** 대상 한 번 재기 — 실패·예외는 { ok:false, rtt:null }(0 이 아니다). */
export async function probeTarget(t, { timeoutMs, slots = null, resolve = resolveCached } = {}) {
  try {
    const addr = await resolve(t.host);
    if (!addr) return { ok: false, rtt: null };
    if (t.kind === 'tcp') {
      const r = await tcpConnect(addr, t.port || 443, timeoutMs);
      return { ok: !!r.alive, rtt: r.alive ? r.rttMs : null };
    }
    if (slots) await slots.acquire();
    try {
      const r = await pingOne(addr, { timeoutMs });
      return { ok: !!r.alive, rtt: r.alive ? r.rttMs : null };
    } finally { slots?.release(); }
  } catch {
    return { ok: false, rtt: null };
  }
}

/** live 측정 대상 — mock 데모 잔존 대상(id 'mock-')은 실제로 재지 않는다(가짜 주소 프로브 잡음 방지). */
const liveTargets = () => enabledTargets().filter((t) => !String(t.id).startsWith('mock-'));

/* ── 연속 측정 엔진(주입 가능 — 테스트가 가짜 측정·짧은 간격으로 돌린다) ─────────── */
export function createPingEngine({
  settings = loadPingSettings, targets = liveTargets, probe = probeTarget,
  write = () => {}, prune = null, subscribe = null,
  now = Date.now, random = Math.random, maxIcmp = () => config.ping.concurrency,
  onError = (e) => console.warn(`[ping] 기록 실패: ${e?.message || e}`),
} = {}) {
  const loops = new Map();   // id → { target, acc, stop, done, wake, timer, last }
  const slots = createSlots(maxIcmp);
  let stopped = true; let flushTimer = null; let reconcileTimer = null; let unsub = null;
  let windowStart = 0; let flushes = 0; let lastFlush = null;
  const accNew = () => ({ n: 0, fail: 0, rn: 0, sum: 0, mn: null, mx: null });

  function sleep(loop, ms) {
    return new Promise((res) => {
      const done = () => { if (loop.timer) clearTimeout(loop.timer); loop.timer = null; loop.wake = null; res(); };
      loop.wake = done;
      loop.timer = unref(setTimeout(done, Math.max(0, ms)));
    });
  }
  function add(acc, r) {
    acc.n += 1;
    if (!r?.ok) { acc.fail += 1; return; }
    const v = r.rtt == null ? null : Number(r.rtt);
    if (v == null || !Number.isFinite(v)) return;
    acc.rn += 1; acc.sum += v;
    acc.mn = acc.mn == null ? v : Math.min(acc.mn, v);
    acc.mx = acc.mx == null ? v : Math.max(acc.mx, v);
  }
  async function run(loop) {
    // 대상끼리 시작 시각을 흩는다 — 모든 대상이 같은 순간에 몰려 재지 않게.
    await sleep(loop, Math.floor(random() * settings().probeIntervalMs));
    while (!stopped && !loop.stop) {
      const s = settings();
      const t0 = now();
      let r;
      try { r = await probe(loop.target, { timeoutMs: s.timeoutMs, slots }); } catch { r = { ok: false, rtt: null }; }
      add(loop.acc, r);
      loop.last = { ok: !!r?.ok, rtt: r?.rtt ?? null, at: now() };
      if (stopped || loop.stop) break;
      const wait = s.probeIntervalMs - (now() - t0);
      if (wait > 0) await sleep(loop, wait);
    }
    loop.done = true;
  }
  function startLoop(t) {
    const loop = { target: t, acc: accNew(), stop: false, done: false, wake: null, timer: null, last: null };
    loops.set(t.id, loop);
    run(loop).catch((e) => { loop.done = true; onError(e); });
  }
  function reconcile() {
    if (stopped) return;
    let list = [];
    try { list = targets() || []; } catch (e) { onError(e); return; }
    const seen = new Set();
    for (const t of list) {
      if (!t?.id) continue;
      seen.add(t.id);
      const cur = loops.get(t.id);
      if (!cur) { startLoop(t); continue; }
      cur.target = t;   // 주소·포트·방식 변경은 다음 측정부터
      if (cur.stop) { cur.stop = false; if (cur.done) { cur.done = false; run(cur).catch((e) => { cur.done = true; onError(e); }); } }
    }
    for (const l of loops.values()) {
      if (!seen.has(l.target.id) && !l.stop) { l.stop = true; l.wake?.(); }
    }
  }
  /** 지금 창을 마감해 대상당 한 줄로 쓴다. 지운 대상은 남은 값을 쓴 뒤 정리한다. */
  function flush(reason = 'timer') {
    const end = now();
    const rows = [];
    for (const [id, l] of loops) {
      const a = l.acc;
      if (a.n > 0) {
        rows.push({
          target: id, ts: windowStart, rtt: a.rn ? round2(a.sum / a.rn) : null, ok: a.n - a.fail > 0,
          n: a.n, fail: a.fail, rn: a.rn, mn: a.mn, mx: a.mx,
        });
      }
      l.acc = accNew();
      if (l.stop && l.done) loops.delete(id);
    }
    windowStart = end;
    if (rows.length) {
      try { const p = write(rows); if (p && typeof p.catch === 'function') p.catch(onError); } catch (e) { onError(e); }
    }
    flushes += 1;
    lastFlush = { at: end, rows: rows.length, up: rows.filter((r) => r.ok).length, reason };
    // prune — 약 20분마다(요약 주기로 환산) · 첫 마감 제외(기동 첫 틱 금지).
    const everyN = Math.max(1, Math.round(PRUNE_EVERY_MS / Math.max(1, settings().summaryIntervalMs)));
    if (prune && flushes > 1 && flushes % everyN === 0) {
      try { const p = prune(); if (p && typeof p.catch === 'function') p.catch(onError); } catch (e) { onError(e); }
    }
    return lastFlush;
  }
  function armFlush() {
    if (stopped) return;
    const s = Math.max(1, settings().summaryIntervalMs);
    const t = now();
    // 시계 경계에 맞춘다(1분이면 매 분 0초) — 화면의 칸과 저장 줄이 같은 경계를 쓴다. 너무 가까우면(1초 미만) 다음 경계로.
    let delay = s - (t % s);
    if (delay < Math.min(1_000, s / 2)) delay += s;
    flushTimer = unref(setTimeout(() => { flushTimer = null; flush('timer'); reconcile(); armFlush(); }, delay));
  }
  function onSettings() {
    if (stopped) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flush('settings');
    reconcile();
    armFlush();
    for (const l of loops.values()) l.wake?.();   // 쉬고 있는 루프가 새 측정 간격을 바로 쓰게
  }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      windowStart = now();
      reconcile();
      armFlush();
      reconcileTimer = unref(setInterval(reconcile, RECONCILE_MS));
      if (subscribe) unsub = subscribe(onSettings);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      flushTimer = null; reconcileTimer = null;
      try { unsub?.(); } catch { /* */ }
      unsub = null;
      for (const l of loops.values()) { l.stop = true; l.wake?.(); }
      // 진행 중이던 창의 값은 버리지 않는다.
      const r = flush('stop');
      loops.clear();
      return r;
    },
    /** '지금 측정'(화면) — 지금 창을 바로 마감해 쓴다(새로 재지 않는다 — 루프가 이미 쉬지 않고 재고 있다). */
    flushNow() { if (stopped) return null; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } const r = flush('manual'); armFlush(); return r; },
    reconcile,
    status() {
      const s = settings();
      return {
        running: !stopped, mode: 'continuous', targets: [...loops.values()].filter((l) => !l.stop).length,
        probeIntervalMs: s.probeIntervalMs, summaryIntervalMs: s.summaryIntervalMs, timeoutMs: s.timeoutMs,
        windowStart: stopped ? null : windowStart, lastFlush, icmpBusy: slots.busy, icmpWaiting: slots.waiting,
        // 서비스 점검·엣지 로그(health/services.js pollerCheck) 공통 이름 — 마지막 저장 시각 · 주기(요약 주기).
        last: lastFlush ? { at: lastFlush.at } : null, intervalMs: s.summaryIntervalMs,
      };
    },
    /** 테스트·진단 — 대상별 지금 창 누적값. */
    _acc() { return Object.fromEntries([...loops].map(([id, l]) => [id, { ...l.acc, stop: l.stop, done: l.done }])); },
  };
}

/* ── 한 번 재기(엔진이 돌지 않을 때의 '지금 측정' — 모니터 꺼짐) ─────────────────── */
let running = false;      // 재진입 가드(한 번 재기끼리)
let lastOnceAt = null;    // 한 번 재기(데모·모니터 꺼짐의 '지금 측정')가 마지막으로 끝난 시각
export async function pollOnce() {
  if (running) return null;
  running = true;
  try {
    // mock 데모: 실제 프로브 대신 합성 RTT 적재(핑/네트워크·vCenter 포트 화면이 비지 않게).
    if (isMockMode()) { try { const { store } = await import('../store.js'); return await mockPingPollTick(store.get?.()); } catch { return { measured: 0 }; } }
    const targets = liveTargets();
    if (!targets.length) return { measured: 0 };
    const db = await getPingDb();
    const { timeoutMs } = loadPingSettings();
    const slots = createSlots(() => config.ping.concurrency);
    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const t = targets[i++];
        const ts = Date.now();
        const r = await probeTarget(t, { timeoutMs, slots });
        results.push({ target: t.id, ts, rtt: r.rtt, ok: r.ok });
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.ping.concurrency, targets.length) }, worker));
    if (results.length) db.insertMany(results);
    return { measured: results.length, up: results.filter((r) => r.ok).length };
  } finally {
    running = false;
    lastOnceAt = Date.now();
  }
}

/* ── 기동 ───────────────────────────────────────────────────────────────── */
let engine = null;
let mockTimer = null;

/** 화면 '지금 측정' — 연속 측정 중이면 지금 창을 마감해 쓰고, 아니면 한 번 잰다. */
export async function pingNow() {
  if (engine) {
    const r = engine.flushNow();
    return r ? { measured: r.rows, up: r.up, mode: 'continuous' } : { measured: 0, mode: 'continuous' };
  }
  const r = await pollOnce();
  return r ? { ...r, mode: 'once' } : null;
}

/** 모니터 상태(화면·API) — 연속 측정이면 엔진 상태, 데모·꺼짐이면 그 사실. */
export function pingMonitorStatus() {
  if (engine) return engine.status();
  const s = loadPingSettings();
  return {
    running: !!mockTimer, mode: mockTimer ? 'mock' : (config.ping.enabled ? 'not-started' : 'off'),
    enabled: !!config.ping.enabled,
    probeIntervalMs: s.probeIntervalMs, summaryIntervalMs: s.summaryIntervalMs, timeoutMs: s.timeoutMs,
    last: lastOnceAt ? { at: lastOnceAt } : null, intervalMs: s.summaryIntervalMs,
  };
}

export function startPingMonitor() {
  if (!config.ping.enabled) { console.log('[ping] 모니터 비활성(PING_MON_ENABLED=false)'); return; }
  // 기동 시 자동 시드/동기화: vCenter(기존 Ping 모니터링), 엣지 노드(네트워크 체크), vCenter 포트.
  try {
    const { vcenters } = loadVcenterConfig();
    const rv = seedVcenterTargets(vcenters); if (rv.added) console.log(`[ping] vCenter ${rv.added}개 자동 대상 등록`);
    const re = seedEdgeTargets(listCollectors()); if (re.added) console.log(`[ping] 엣지 노드 ${re.added}개 자동 대상 등록`);
    syncVcPortTargets(vcenters.map((v) => ({ id: v.id, name: v.name, host: v.host }))); // vcPorts가 있으면 vCenter×포트 재구성
  } catch (e) { console.warn('[ping] 자동 시드 실패:', e.message); }
  const s = loadPingSettings();
  if (isMockMode()) {
    // 데모는 실제로 재지 않는다 — 요약 주기마다 합성 값 1회(설정을 바꾸면 다음 주기부터).
    mockTimer = startAdaptiveTimer(() => loadPingSettings().summaryIntervalMs, () => pollOnce(), { name: 'ping-mock', subscribe: onPingSettingsChange, firstDelayMs: s.summaryIntervalMs });
    console.log(`[ping] 데모 모니터 시작 (요약 주기=${s.summaryIntervalMs}ms — 합성 값)`);
    return;
  }
  // DB 가 열린 뒤에는 동기로 쓴다 — 종료 경로(stopPingMonitor)가 process.exit 전에 마지막 창을 실제로 쓰게.
  let dbNow = null;
  getPingDb().then((d) => { dbNow = d; }).catch(() => {});
  engine = createPingEngine({
    write: (rows) => (dbNow ? dbNow.insertMany(rows) : getPingDb().then((db) => db.insertMany(rows))),
    prune: () => (config.ping.retentionDays > 0 ? getPingDb().then((db) => db.prune(Date.now() - config.ping.retentionDays * 86_400_000)) : null),
    subscribe: onPingSettingsChange,
  });
  engine.start();
  console.log(`[ping] 연속 측정 시작 (측정 간격=${s.probeIntervalMs}ms, 요약 주기=${s.summaryIntervalMs}ms, 시한=${s.timeoutMs}ms, ICMP 동시=${config.ping.concurrency})`);
}

/** 종료·테스트 — 엔진을 멈추고 진행 중이던 창을 쓴다. */
export function stopPingMonitor() {
  const r = engine ? engine.stop() : null;
  engine = null;
  if (mockTimer) { mockTimer.stop?.(); mockTimer = null; }
  return r;
}
