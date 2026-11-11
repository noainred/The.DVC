/**
 * focusmon/service.js — 이 노드의 집중 모니터링을 묶는다(v2.976): 키 · 중앙 직접 수집기 · 1초/10초 틱 · 수집 시작/끝 · 엣지 깨우기.
 *
 *  · 중앙 직접 대상(agent '')은 이 노드의 runner 가 수집한다. 엣지 대상은 그 엣지가 수집해 `/api/central/focus-mon/sync` 로 올린다(central/focusMonEdge.js).
 *  · 1초 틱: 잠깐 보기 시한 · 보는 화면 없음 → 끝 · 원하는 대상과 수집기 맞추기 · 분 닫기. 10초 틱: DB 적재 · 정리(recorder).
 *  · 수집을 시작하면 그 수집에 든 엣지를 한 번 깨운다(수집 URL · 토큰 — 기존 엣지 대행과 같은 길 · 재전송 0). 닿지 않으면 엣지의 30초 조회가 받는다.
 *  · 데모(mock) 모드면 데모 대상 20대가 등록부에 더해지고 SSH 없이 같은 모양의 표본을 낸다.
 */
import { createSshKeyStore } from '../util/sshKeyStore.js';
import { getDataSource } from '../runtime-settings.js';
import * as store from './store.js';
import * as db from './db.js';
import { createRunner } from './runner.js';
import { listTargets, getTarget } from './registry.js';
import { DEMO_TARGETS, isDemoTarget } from './mock.js';
import { recordTick, flushOnExit } from './recorder.js';
import { every } from '../util/longTimer.js';

export const focusKeys = createSshKeyStore({
  name: 'focusmon_key', envVar: 'FOCUSMON_SSH_KEY', comment: 'dvc-focusmon', tag: '[focusmon]',
  purpose: '집중 모니터링 접속용', where: '대상 서버 계정의 authorized_keys',
});

export const isMockMode = () => { try { return getDataSource() === 'mock'; } catch { return false; } };

/** 이 노드가 아는 대상 전부(등록부 + 데모 모드면 데모 20대). 데모 대상의 agent 는 표시용 이름이다. */
export function allTargets() { return isMockMode() ? [...listTargets(), ...DEMO_TARGETS.map((t) => ({ ...t }))] : listTargets(); }
export function findTarget(id) {
  const s = String(id || '');
  if (isDemoTarget(s)) return isMockMode() ? { ...DEMO_TARGETS.find((t) => t.id === s) } : null;
  return getTarget(s);
}
/** 수집 계획용 — 데모 대상은 담당 표시와 무관하게 이 노드가 만든다(agent ''). */
const resolveForRun = (id) => { const t = findTarget(id); return t && t.demo ? { ...t, agent: '' } : t; };

const runner = createRunner({
  keys: focusKeys,
  sink: {
    sample: (id, ts, s, hello) => store.ingestSample(id, ts, s, hello),
    procs: (id, ts, p) => store.ingestProcs(id, ts, p),
    status: (id, st) => store.setStatus(id, st),
  },
});
export const localRunner = runner;

let timers = [];
let wakeImpl = null;
/** 엣지 깨우기 구현 주입(central/focusMonEdge.js 가 등록 — 이 모듈이 central 을 import 하지 않게). */
export function setWakeImpl(fn) { wakeImpl = typeof fn === 'function' ? fn : null; }

let lastTickAt = null;
export function tick1(now = Date.now()) {
  lastTickAt = now;
  for (const s of store.expireSessions(now)) db.writeRun({ id: s.id, started: s.startedAt, ended: now, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  runner.reconcile(store.desiredFor('', resolveForRun, now));
  store.closeMinutes(now, store.activeTargetIds());
}

/** 수집 시작 — 대상 확인은 라우트, 상한 · 방식 검사는 store. 시작 기록(fm_run) · 엣지 깨우기. */
export function startCollection({ targets, interval, mode, by }) {
  const r = store.startSession({ targets, interval, mode, by });
  if (!r.ok) return r;
  const s = r.session;
  db.writeRun({ id: s.id, started: s.startedAt, ended: null, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  tick1();
  const agents = new Set(s.targets.map((id) => resolveForRun(id)?.agent || '').filter(Boolean));
  for (const a of agents) wakeImpl?.(a);
  return r;
}

export function stopCollection(id, why = 'stopped') {
  const r = store.stopSession(id, why);
  if (r.ok) {
    const s = r.session;
    db.writeRun({ id: s.id, started: s.startedAt, ended: Date.now(), by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
    tick1();
  }
  return r;
}

export function startFocusMon() {
  if (timers.length) return;
  timers = [
    every(() => { try { tick1(); } catch (e) { console.warn(`[focusmon] 틱 실패: ${String(e?.message || e).slice(0, 160)}`); } }, 1_000),
    every(() => { recordTick().catch((e) => console.warn(`[focusmon] 기록 실패: ${String(e?.message || e).slice(0, 160)}`)); }, 10_000),
  ];
  // 계속 수집 정의가 남아 있으면(재시작) 곧바로 이어 받는다 — 첫 틱이 desiredFor 로 읽는다.
  const resumed = store.listSessions().filter((x) => x.resumed).length;
  if (resumed) console.log(`[focusmon] 계속 수집 ${resumed}건을 이어 받습니다.`);
}

export function stopFocusMon() {
  for (const t of timers) { try { t.clear(); } catch { /* */ } }
  timers = [];
  runner.stopAll();
  return flushOnExit();
}

/**
 * 상태(엣지 로그 collect.focusMon · 서비스 점검 공용). 사람이 시작한 수집만 돌므로 대상 0대도 정상이다 —
 * 서비스 점검(`health/services.js pollerCheck`)이 읽는 이름으로 마지막 틱 시각 · 틱 주기를 싣는다(틱이 멈추면 경고가 된다).
 */
export function serviceStatus() {
  return { enabled: timers.length > 0, running: runner.running().length, lastTickAt, tickMs: 1_000, sessions: store.listSessions().length, statuses: runner.statuses() };
}
