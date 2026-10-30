/**
 * bareos/inflight.js — 재시작하면 결과를 잃는 Bareos 작업 목록(v2.824.1 버그 점검 G15 — 업그레이드 자동 적용이 기다린다).
 *
 * 엣지 대행 큐(edgeOps.js)와 '결과 모름' 뒤 늦은 회신 받기는 **중앙 메모리**에만 있다 — 중앙이 재시작하면(자동 업그레이드 포함) 엣지가 실행한
 * 등록·실행·복원·자동 설정의 회신을 받을 곳이 없어져 버려진다(등록이면 원장 밖 잡이 남고, 2단계면 새 콘솔 비밀번호를 잃는다). 중앙 직접 자동 설정도
 * SSH 세션·되돌리기가 이 프로세스 안에서 돈다. 그래서 upgrade/manager.js #deferDecision 이 이 목록이 빌 때까지(상한 안에서) 적용을 미룬다.
 * 비밀·인자는 싣지 않는다 — 종류·대상 이름·시작 시각만.
 */
import { pendingView, lateView, EDGE_MUTATING } from './edgeOps.js';

const _setups = new Map();   // Director id → { name, since } — 중앙 직접·대행 자동 설정(라우트 setupGate ~ releaseSetup)

/** 자동 설정 시작·끝(라우트 잠금과 같은 수명). */
export function noteSetupStart(dirId, name) { _setups.set(String(dirId), { name: String(name || dirId).slice(0, 80), since: Date.now() }); }
export function noteSetupEnd(dirId) { _setups.delete(String(dirId)); }

/**
 * 지금 도는(재시작하면 끊기는) Bareos 작업 — upgrade/manager.js 의 다른 대기 목록과 같은 모양.
 * 엣지 대행 상태 조회(poll)는 넣지 않는다(다음 주기에 다시 한다).
 * @returns {{ kind: 'bareos', key: string, label: string, since: number|null, resumable: false }[]}
 */
export function runningBareosWork(now = Date.now()) {
  const out = [];
  for (const [id, s] of _setups) out.push({ kind: 'bareos', key: `setup:${id}`, label: `Bareos 자동 설정(${s.name})`, since: s.since, resumable: false });
  let ops = [];
  try { ops = pendingView(); } catch { ops = []; }
  for (const o of ops) {
    if (o.kind === 'poll' || !EDGE_MUTATING.has(o.kind)) continue;
    out.push({ kind: 'bareos', key: `edge:${o.agent}:${o.directorId}:${o.kind}`, label: `Bareos 엣지 대행 ${o.kind}(${o.agent})`.slice(0, 120), since: now - (Number(o.ageMs) || 0), resumable: false });
  }
  // '결과 모름' 으로 닫은 등록의 늦은 회신 받기(onLate — 재시작하면 받을 곳이 없어 원장 밖 잡이 남는다)
  let late = [];
  try { late = lateView(now); } catch { late = []; }
  for (const l of late) out.push({ kind: 'bareos', key: `late:${l.agent}:${l.kind}:${l.ageMs}`, label: `Bareos 엣지 늦은 회신 대기 ${l.kind}(${l.agent})`.slice(0, 120), since: now - (Number(l.ageMs) || 0), resumable: false });
  return out;
}

export function _resetInflightForTest() { _setups.clear(); }
