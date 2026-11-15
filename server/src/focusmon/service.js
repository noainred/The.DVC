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
import { listTargets, getTarget, getSettings } from './registry.js';
import { createNodeSampler } from './load.js';
import { DEMO_TARGETS, isDemoTarget } from './mock.js';
import { recordTick, flushOnExit, recorderStatus } from './recorder.js';
import { every } from '../util/longTimer.js';
import { startAuditService } from './audit/service.js';
import { tuneTick, procEveryFor } from './tune.js'; // v3.16.0 ⑯ C3 수집 부하 자동 조절
import { alertCycle } from './alerts.js'; // v3.16.0 ⑯ C1 지속 시간 조건 알림
import { maintStateForTarget } from './maintMatch.js'; // v3.16.0 ⑯ 반증 H2 — 법인(DataCenter) → vCenter 들로 정비 창 판정
import { corpResolver } from './audit/corp.js';
import { getDatacenterAssign } from '../datacenter/store.js';
import { startRollup, stopRollup } from './rollup.js'; // v3.13.0 ⑭ 요약 표 백필 · 1시간 요약 // v3.11.0 디스크 점검 — 중앙 실행기 키 · 재시작 전 작업 정리

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
    load: (id, l) => store.setLoad(id, l), // v2.983 수집 부하 창(30초)
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
  // v2.980: 읽을 때 겹침을 정리한 계속 수집(v2.979 전에 만든 것) — 실행 기록의 대상 · 끝을 고쳐 쓴다
  for (const s of store.drainLoadFixes()) db.writeRun({ id: s.id, started: s.startedAt, ended: s.ended, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  for (const s of store.expireSessions(now)) db.writeRun({ id: s.id, started: s.startedAt, ended: now, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  const procEvery = getSettings().procEvery; // v2.983 프로세스 표본 주기(설정) · v3.16.0 ⑯ C3 — 자동 조절이 켜져 있으면 서버마다(tune.procEveryFor)
  runner.reconcile(store.desiredFor('', resolveForRun, now).map((d) => ({ ...d, procEvery: procEveryFor(d.id, procEvery) })));
  store.closeMinutes(now, store.activeTargetIds());
}

/**
 * 1분 틱(v3.16.0 ⑯ — 중앙만: 엣지 서버의 표본 · 수집 부하도 중앙에 모인다). ① 수집 부하 자동 조절(C3 — 계속 수집 서버) ② 지속 시간 조건 알림(C1).
 * 엣지(CENTRAL_URL 이 있는 노드)는 하지 않는다 — 엣지 서버의 주기는 중앙의 동기화 응답(procEvery)으로 내려간다.
 */
export async function minuteTick(now = Date.now(), { send = null, maintJudge = null } = {}) {
  if (String(process.env.CENTRAL_URL || '').trim()) return { skipped: 'edge' };
  const settings = getSettings();
  const recordIds = new Set(store.listSessions(now).filter((x) => x.mode === 'record').flatMap((x) => x.targets));
  const targets = allTargets().filter((t) => recordIds.has(t.id));
  for (const c of tuneTick({ targets, loadOf: store.loadOf, settings, now })) {
    store.queueEvent(c.id, 'tune', `수집 조절 — 프로세스 표본 ${c.from}초 → ${c.to}초(${c.why})`.slice(0, 300), now, { scope: 'server' });
  }
  // 정비 창(베어메탈 사용률의 정비 창 — 같은 법인 · 같은 IP 의 서버를 덮는 창이 '알림' 을 켰으면 억제) · 판정기를 못 만들면 억제하지 않는다(알림이 나가는 쪽)
  //   반증 H2: 등록부 법인은 DataCenter id · 정비 창은 vCenter id — 법인의 vCenter 들로 풀어 묻는다(maintMatch.js).
  const J = maintJudge ? await maintJudge(now).catch(() => null) : null;
  let maintState = null;
  if (J) {
    let cr = null; let assign = {};
    try { cr = corpResolver(); } catch { cr = null; }
    try { assign = getDatacenterAssign(); } catch { assign = {}; }
    maintState = (t) => { try { return maintStateForTarget(J, t, cr?.of(t)?.id || null, assign, now); } catch { return null; } };
  }
  return alertCycle({ store, targets: allTargets(), recordIds, send, maintState, mock: isMockMode(), now });
}
let sendImpl = null; let maintImpl = null;
/** 발송 · 정비 창 판정 주입(central/focusMonEdge.js 가 등록 — 이 모듈이 alerts.js · bmusage 를 직접 import 하지 않게). */
export function setAlertDeps({ send = null, maintJudge = null } = {}) { sendImpl = send; maintImpl = maintJudge; }

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

/** 진행 중인 수집에 더하기 · 빼기(v2.979) — 실행 기록(fm_run)을 새 대상으로 고쳐 쓰고 바로 틱 · 엣지를 깨운다. */
export function addToCollection(id, targets) {
  const r = store.addToSession(id, targets);
  if (!r.ok) return r;
  const s = r.session;
  db.writeRun({ id: s.id, started: s.startedAt, ended: null, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  tick1();
  const agents = new Set(r.added.map((x) => resolveForRun(x)?.agent || '').filter(Boolean));
  for (const a of agents) wakeImpl?.(a);
  return r;
}
export function removeFromCollection(id, targetId) {
  const r = store.removeFromSession(id, targetId);
  if (!r.ok) return r;
  const s = r.session;
  db.writeRun({ id: s.id, started: s.startedAt, ended: r.ended ? Date.now() : null, by: s.by, mode: s.mode, interval: s.interval, targets: s.targets }).catch(() => {});
  tick1();
  return r;
}

/**
 * 등록 수정으로 접속처가 바뀐 대상(v2.980): 바로 틱(수집 중이면 러너가 끊고 새 접속처로 다시 연다) → 예전 접속처의 상태 · 시험 결과를 지운다
 * (틱 뒤에 지워야 옛 수집기가 끝나며 남긴 '멈춤' 상태도 지워진다) → 예전 · 새 담당 엣지를 깨운다(새 엣지는 키를 만들고 · 수집 중이면 바로 시작,
 * 예전 엣지는 다음 동기화에서 손을 뗀다 — 깨우지 않으면 쉬는 주기만큼 늦다).
 */
export function targetEndpointChanged(before, after) {
  if (!after?.id) return;
  tick1();
  store.forgetTargetState(after.id);
  const agents = new Set([before?.agent, after.agent].map((a) => String(a || '')).filter(Boolean).map((a) => a.toLowerCase()));
  const names = [...agents].map((k) => [before?.agent, after.agent].find((a) => String(a || '').toLowerCase() === k));
  for (const a of names) wakeImpl?.(a);
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

/**
 * v2.983 이 노드(중앙)의 수집 부하 — 30초마다 포탈 프로세스 CPU · 메모리 · 이벤트 루프 지연 · 받은 양 · 해석 시간 · DB 쓰기.
 * DB 쓰기는 **최근 10분 평균**(dbWindowS) — 묶음은 분마다 닫혀 30초 창 하나는 0 과 두 배 사이를 오갔다(2026-11-12 화면 확인 — '30일이면 13.6GB' 가 튀었다).
 */
const DB_RATE_WINDOW_MS = 10 * 60_000;
let nodeSampler = null; let dbHist = [];
export function nodeTick(now = Date.now()) {
  // 반증 F2: 이 노드에서 수집기가 돌 때만 — 수집이 없으면 틱만 돈다(표본기 · DB 쓰기 0). 엣지는 이 runner 가 비어 있다(엣지 수집은 워커 몫 — 워커가 따로 잰다).
  if (!runner.running().length) { try { nodeSampler?.stop(); } catch { /* */ } nodeSampler = null; dbHist = []; return null; }
  if (!nodeSampler) nodeSampler = createNodeSampler({ sessions: () => runner.running().length });
  const x = nodeSampler.sample();
  if (!x) return null;
  const rec = recorderStatus();
  dbHist.push({ at: now, bytes: rec.bytesWritten });
  dbHist = dbHist.filter((h) => now - h.at <= DB_RATE_WINDOW_MS);
  const h0 = dbHist[0];
  const span = now - h0.at;
  const dbBps = span >= 25_000 ? Math.max(0, (rec.bytesWritten - h0.bytes) / (span / 1000)) : null; // 창 하나(30초) 미만이면 모름
  const v = { ...x, dbWriteBps: dbBps == null ? null : Math.round(dbBps * 100) / 100, dbWindowS: dbBps == null ? null : Math.round(span / 1000), dbBytes: rec.dbBytes ?? null };
  store.setNodeLoad('', v, now);
  return v;
}

export function startFocusMon() {
  if (timers.length) return;
  try { startRollup({ paused: () => !!recorderStatus().paused }); } catch (e) { console.warn(`[focusmon] 요약 표 시작 실패: ${String(e?.message || e).slice(0, 160)}`); } // v3.13.0 ⑭
  try { startAuditService({ keys: focusKeys, spaceLow: () => { const r = recorderStatus(); return !!(r.paused && r.pauseReason === 'disk-low'); } }); } catch (e) { console.warn(`[focusmon] 디스크 점검 시작 실패: ${String(e?.message || e).slice(0, 160)}`); }
  timers = [
    every(() => { try { tick1(); } catch (e) { console.warn(`[focusmon] 틱 실패: ${String(e?.message || e).slice(0, 160)}`); } }, 1_000),
    every(() => { recordTick().catch((e) => console.warn(`[focusmon] 기록 실패: ${String(e?.message || e).slice(0, 160)}`)); }, 10_000),
    every(() => { try { nodeTick(); } catch (e) { console.warn(`[focusmon] 노드 부하 표본 실패: ${String(e?.message || e).slice(0, 160)}`); } }, 30_000),
    every(() => { minuteTick(Date.now(), { send: sendImpl, maintJudge: maintImpl }).catch((e) => console.warn(`[focusmon] 알림 · 자동 조절 실패: ${String(e?.message || e).slice(0, 160)}`)); }, 60_000), // v3.16.0 ⑯
  ];
  try { nodeTick(); } catch { /* 첫 창의 기준점 */ }
  // 계속 수집 정의가 남아 있으면(재시작) 곧바로 이어 받는다 — 첫 틱이 desiredFor 로 읽는다.
  const resumed = store.listSessions().filter((x) => x.resumed).length;
  if (resumed) console.log(`[focusmon] 계속 수집 ${resumed}건을 이어 받습니다.`);
}

export function stopFocusMon() {
  try { stopRollup(); } catch { /* */ }
  for (const t of timers) { try { t.clear(); } catch { /* */ } }
  timers = [];
  try { nodeSampler?.stop(); } catch { /* */ }
  nodeSampler = null; dbHist = [];
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
