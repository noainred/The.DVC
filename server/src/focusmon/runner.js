/**
 * focusmon/runner.js — 한 노드(중앙 또는 엣지) 안의 수집기 묶음(v2.976). **원하는 대상 목록**과 맞춘다 — 중앙과 엣지가 같은 파일을 쓴다.
 *
 *  · reconcile(desired): 없던 대상은 시작 · 빠진 대상은 끝 · 주소/포트/계정이 바뀐 대상은 끊고 새로 · 주기만 바뀐 대상은 명령만 바꾼다.
 *  · 노드당 동시 세션 상한 `MAX_STREAMS`(기본 40) — 넘는 대상은 시작하지 않고 상태 `limit` 으로 말한다(조용히 빼지 않는다).
 *  · 데모(mock) 대상은 SSH 없이 mock.js 표본을 같은 주기로 낸다 — 화면 · 묶음 · DB 경로가 실데이터와 같은 길을 탄다.
 *  · ‘다시 연결’ 은 대상마다 60초에 한 번 — 연타가 로그인 시도를 늘리지 않게.
 *  · sink: { sample(id, ts, sample, hello), procs(id, ts, p), status(id, st), load?(id, load) } — 중앙은 store 로, 엣지는 보낼 묶음으로 간다.
 *  · v2.983: 원하는 대상의 procEvery(프로세스 표본 주기 — 설정)가 바뀌면 명령만 바꾼다(주기와 같은 길). 수집 부하 창은 sink.load 로.
 */
import { createCollector, testTarget, focusAuthGuard, authIdOf } from './collector.js';
import { normInterval, normProcEvery } from './script.js';
import { demoSample, demoProcs, demoHello, demoLoad, isDemoTarget } from './mock.js';
import { TOPO_EVERY_S } from './script.js';

export const MAX_STREAMS = Math.max(1, Math.min(200, Number(process.env.FOCUSMON_MAX_STREAMS) || 40));
export const RETRY_MIN_MS = 60_000;

const sameEndpoint = (a, b) => a.host === b.host && Number(a.port) === Number(b.port) && a.username === b.username;

function createDemoCollector(t, { interval, procEvery, sink }) {
  let iv = normInterval(interval); let pe = normProcEvery(procEvery); let timer = null; let ptimer = null; let ltimer = null; let st = { state: 'connecting', since: Date.now(), lastSampleAt: null, error: '', hello: demoHello(t.id), osVerified: true, interval: iv };
  const tick = () => {
    const ts = Date.now();
    const s = demoSample(t.id, ts, iv);
    if (s) { sink.sample(t.id, ts, s, st.hello); st = { ...st, state: 'ok', lastSampleAt: ts }; sink.status(t.id, { ...st }); }
  };
  const ptick = () => { const ts = Date.now(); const p = demoProcs(t.id, ts); if (p) sink.procs(t.id, ts, p); };
  // v2.983 데모 수집 부하 — 실수집과 같은 30초 창(값은 mock.js 모형 · 화면이 데모라고 밝힌다)
  const ltick = () => { const l = demoLoad(t.id, iv, pe, Date.now()); if (l) sink.load?.(t.id, l); };
  const arm = () => {
    clearInterval(timer); clearInterval(ptimer); clearInterval(ltimer);
    timer = setInterval(tick, iv * 1000); timer.unref?.();
    ptimer = setInterval(ptick, Math.max(pe, iv) * 1000); ptimer.unref?.();
    ltimer = setInterval(ltick, Math.max(TOPO_EVERY_S, iv) * 1000); ltimer.unref?.();
  };
  return {
    id: t.id, target: () => ({ ...t }), status: () => ({ ...st }),
    start() { arm(); setTimeout(tick, 200).unref?.(); setTimeout(ptick, 400).unref?.(); setTimeout(ltick, 600).unref?.(); },
    setInterval(n) { const v = normInterval(n); if (v === iv) return false; iv = v; st.interval = v; arm(); return true; },
    setProcEvery(n) { const v = normProcEvery(n); if (v === pe) return false; pe = v; arm(); return true; },
    procEvery: () => pe,
    retry() {}, stop() { clearInterval(timer); clearInterval(ptimer); clearInterval(ltimer); st = { ...st, state: 'stopped' }; },
  };
}

/**
 * @param {object} o
 * @param {object} o.keys   sshKeyStore 인스턴스
 * @param {object} o.sink
 * @param {Function} [o.connect] 테스트 주입
 */
export function createRunner({ keys, sink, connect } = {}) {
  const live = new Map(); // id → { col, t, interval }
  const limited = new Map(); // id → status(시작하지 못함)
  const lastRetry = new Map();

  const make = (t, interval, procEvery) => (t.demo || isDemoTarget(t.id)
    ? createDemoCollector(t, { interval, procEvery, sink })
    : createCollector(t, {
      interval, procEvery, keys, connect,
      onSample: (s, { ts, hello }) => sink.sample(t.id, ts, s, hello),
      onProcs: (p, { ts }) => sink.procs(t.id, ts, p),
      onStatus: (st) => sink.status(t.id, st),
      onLoad: (l) => sink.load?.(t.id, l),
    }));

  function reconcile(desired = []) {
    const want = new Map();
    for (const d of desired) if (d && d.id && !want.has(d.id)) want.set(d.id, d);
    for (const [id, x] of live) {
      if (!want.has(id)) { x.col.stop(); live.delete(id); continue; }
      const d = want.get(id);
      if (!sameEndpoint(x.t, d)) { x.col.stop(); live.delete(id); continue; }
      if (normInterval(d.interval) !== x.interval) { x.col.setInterval(d.interval); x.interval = normInterval(d.interval); }
      if (normProcEvery(d.procEvery) !== x.procEvery) { x.col.setProcEvery?.(d.procEvery); x.procEvery = normProcEvery(d.procEvery); }
    }
    limited.clear();
    for (const [id, d] of want) {
      if (live.has(id)) continue;
      if (live.size >= MAX_STREAMS) {
        limited.set(id, { state: 'limit', since: Date.now(), error: `이 노드의 동시 수집 상한(${MAX_STREAMS}대)을 넘어 시작하지 않았습니다.`, interval: normInterval(d.interval) });
        continue;
      }
      const t = { id, host: d.host, port: Number(d.port) || 22, username: d.username, demo: !!d.demo };
      const col = make(t, d.interval, d.procEvery);
      live.set(id, { col, t, interval: normInterval(d.interval), procEvery: normProcEvery(d.procEvery) });
      col.start();
    }
    return { running: live.size, limited: limited.size };
  }

  return {
    reconcile,
    /** 대상별 상태(실행 중 + 상한으로 못 띄운 것). */
    statuses() {
      const out = {};
      for (const [id, x] of live) out[id] = x.col.status();
      for (const [id, st] of limited) out[id] = st;
      return out;
    },
    running: () => [...live.keys()],
    /** ‘다시 연결’ — 60초에 한 번. */
    retry(id, target = null) {
      const x = live.get(String(id));
      const now = Date.now();
      // 60초 검사가 **먼저** — 예전 라우트는 정지를 먼저 지우고 429 를 돌려줘, '다시 연결 → 시험' 을 번갈아 누르면 로그인 시도가 무제한이었다(반증 6번).
      if ((lastRetry.get(id) || 0) + RETRY_MIN_MS > now) return { ok: false, code: 'too-soon', reason: '같은 대상은 60초에 한 번만 다시 연결합니다.' };
      lastRetry.set(id, now);
      if (!x) {
        if (target) { focusAuthGuard.clearAuthStop(authIdOf(target)); return { ok: true, running: false }; } // 수집 중이 아니면 정지만 푼다(다음 시험 · 시작이 한 번 시도)
        return { ok: false, code: 'not-running', reason: '지금 수집 중인 대상이 아닙니다.' };
      }
      x.col.retry();
      return { ok: true, running: true };
    },
    async test(t) {
      if (t.demo || isDemoTarget(t.id)) return { ok: true, kind: 'ok', hello: demoHello(t.id), ms: 12 };
      return testTarget(t, { keys, connect });
    },
    stopAll() { for (const x of live.values()) x.col.stop(); live.clear(); limited.clear(); },
  };
}
