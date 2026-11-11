/**
 * focusmon/runner.js — 한 노드(중앙 또는 엣지) 안의 수집기 묶음(v2.976). **원하는 대상 목록**과 맞춘다 — 중앙과 엣지가 같은 파일을 쓴다.
 *
 *  · reconcile(desired): 없던 대상은 시작 · 빠진 대상은 끝 · 주소/포트/계정이 바뀐 대상은 끊고 새로 · 주기만 바뀐 대상은 명령만 바꾼다.
 *  · 노드당 동시 세션 상한 `MAX_STREAMS`(기본 40) — 넘는 대상은 시작하지 않고 상태 `limit` 으로 말한다(조용히 빼지 않는다).
 *  · 데모(mock) 대상은 SSH 없이 mock.js 표본을 같은 주기로 낸다 — 화면 · 묶음 · DB 경로가 실데이터와 같은 길을 탄다.
 *  · ‘다시 연결’ 은 대상마다 60초에 한 번 — 연타가 로그인 시도를 늘리지 않게.
 *  · sink: { sample(id, ts, sample, hello), procs(id, ts, p), status(id, st) } — 중앙은 store 로, 엣지는 보낼 묶음으로 간다.
 */
import { createCollector, testTarget } from './collector.js';
import { normInterval } from './script.js';
import { demoSample, demoProcs, demoHello, isDemoTarget } from './mock.js';
import { PROC_EVERY_S } from './script.js';

export const MAX_STREAMS = Math.max(1, Math.min(200, Number(process.env.FOCUSMON_MAX_STREAMS) || 40));
export const RETRY_MIN_MS = 60_000;

const sameEndpoint = (a, b) => a.host === b.host && Number(a.port) === Number(b.port) && a.username === b.username;

function createDemoCollector(t, { interval, sink }) {
  let iv = normInterval(interval); let timer = null; let ptimer = null; let st = { state: 'connecting', since: Date.now(), lastSampleAt: null, error: '', hello: demoHello(t.id), osVerified: true, interval: iv };
  const tick = () => {
    const ts = Date.now();
    const s = demoSample(t.id, ts, iv);
    if (s) { sink.sample(t.id, ts, s, st.hello); st = { ...st, state: 'ok', lastSampleAt: ts }; sink.status(t.id, { ...st }); }
  };
  const ptick = () => { const ts = Date.now(); const p = demoProcs(t.id, ts); if (p) sink.procs(t.id, ts, p); };
  const arm = () => {
    clearInterval(timer); clearInterval(ptimer);
    timer = setInterval(tick, iv * 1000); timer.unref?.();
    ptimer = setInterval(ptick, Math.max(PROC_EVERY_S, iv) * 1000); ptimer.unref?.();
  };
  return {
    id: t.id, target: () => ({ ...t }), status: () => ({ ...st }),
    start() { arm(); setTimeout(tick, 200).unref?.(); setTimeout(ptick, 400).unref?.(); },
    setInterval(n) { const v = normInterval(n); if (v === iv) return false; iv = v; st.interval = v; arm(); return true; },
    retry() {}, stop() { clearInterval(timer); clearInterval(ptimer); st = { ...st, state: 'stopped' }; },
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

  const make = (t, interval) => (t.demo || isDemoTarget(t.id)
    ? createDemoCollector(t, { interval, sink })
    : createCollector(t, {
      interval, keys, connect,
      onSample: (s, { ts, hello }) => sink.sample(t.id, ts, s, hello),
      onProcs: (p, { ts }) => sink.procs(t.id, ts, p),
      onStatus: (st) => sink.status(t.id, st),
    }));

  function reconcile(desired = []) {
    const want = new Map();
    for (const d of desired) if (d && d.id && !want.has(d.id)) want.set(d.id, d);
    for (const [id, x] of live) {
      if (!want.has(id)) { x.col.stop(); live.delete(id); continue; }
      const d = want.get(id);
      if (!sameEndpoint(x.t, d)) { x.col.stop(); live.delete(id); continue; }
      if (normInterval(d.interval) !== x.interval) { x.col.setInterval(d.interval); x.interval = normInterval(d.interval); }
    }
    limited.clear();
    for (const [id, d] of want) {
      if (live.has(id)) continue;
      if (live.size >= MAX_STREAMS) {
        limited.set(id, { state: 'limit', since: Date.now(), error: `이 노드의 동시 수집 상한(${MAX_STREAMS}대)을 넘어 시작하지 않았습니다.`, interval: normInterval(d.interval) });
        continue;
      }
      const t = { id, host: d.host, port: Number(d.port) || 22, username: d.username, demo: !!d.demo };
      const col = make(t, d.interval);
      live.set(id, { col, t, interval: normInterval(d.interval) });
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
    retry(id) {
      const x = live.get(String(id));
      const now = Date.now();
      if ((lastRetry.get(id) || 0) + RETRY_MIN_MS > now) return { ok: false, code: 'too-soon', reason: '같은 대상은 60초에 한 번만 다시 연결합니다.' };
      lastRetry.set(id, now);
      if (!x) return { ok: false, code: 'not-running', reason: '지금 수집 중인 대상이 아닙니다.' };
      x.col.retry();
      return { ok: true };
    },
    async test(t) {
      if (t.demo || isDemoTarget(t.id)) return { ok: true, kind: 'ok', hello: demoHello(t.id), ms: 12 };
      return testTarget(t, { keys, connect });
    },
    stopAll() { for (const x of live.values()) x.col.stop(); live.clear(); limited.clear(); },
  };
}
