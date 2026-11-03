/**
 * bareos/cancelState.js — 실행 취소(중단)의 **판정 하나**(v2.865 · 사용자 요청 '단일 백업 중단 · 그룹 백업 중단' — 시안 docs/design/bareos-cancel/).
 *
 * 순수 함수만 둔다(파일·타이머·Director 없음) — 백업 대상 화면 · 진행 현황판 · 그룹 카드 · 폴러가 같은 판정을 쓴다(판정 코어 하나).
 *
 *  · 지금 도는 실행(runningRunOf): 포탈이 시작한 실행(pending)이 먼저, 없으면 Bareos 스케줄이 돌린 실행(lastRun 이 끝나지 않음).
 *    v2.833 진행 현황판(liveStatus.js)에서 옮겼다 — liveStatus 는 여기서 다시 내보낸다.
 *  · 취소 요청 기록: 원장 잡의 cancelReq = { jobid, at, by, via:'single'|'group' } — **그 jobid 가 지금 도는 실행일 때만** 유효하다
 *    (다른 실행이 시작됐거나 끝났으면 지난 기록이다 — 화면에 '멈추는 중' 으로 남기지 않는다).
 *  · 멈추지 않음(stuck): 취소를 보내고 CANCEL_WAIT_MS 가 지나도 아직 돈다 — 화면이 'Director 에서 확인' 을 안내하고 다시 보내기를 연다.
 *  · 폴러는 취소를 보낸 실행을 CANCEL_TRACK_MS 동안 따로 묻는다(포탈이 시작하지 않은 실행은 pending 이 없어 대조 틱까지 결과가 늦다).
 */
import { isFinalStatus } from './names.js';

/** 취소를 보낸 뒤 이만큼 지나도 아직 돌면 '멈추지 않음'(FD 가 멈추기까지 보통 수 초~수 분 — 실환경 미확인 · 추정). */
export const CANCEL_WAIT_MS = 10 * 60_000;
/** 포탈이 시작하지 않은 실행의 취소 결과를 폴러가 따로 묻는 기간. 지나면 대조 틱(그 Director 의 최근 실행)에 맡긴다. */
export const CANCEL_TRACK_MS = 60 * 60_000;

/**
 * 지금 도는 실행 — 포탈이 시작한 실행(pending)이 먼저, 없으면 Bareos 스케줄이 돌린 실행(lastRun 이 끝나지 않음). 없으면 null.
 * @param {object} j  registry.jobDigests() 한 줄(또는 listJobs 한 줄)
 * @returns {{ jobid:number, state:string, level:string, since:number|null, trigger:string, by:string }|null}
 */
export function runningRunOf(j) {
  if (j?.pending?.jobid) return { jobid: j.pending.jobid, state: j.pending.state || 'queued', level: j.pending.level || '', since: j.pending.since || null, trigger: j.pending.trigger || '', by: j.pending.by || '' };
  const L = j?.lastRun;
  if (L?.jobid && L.status && !isFinalStatus(L.status) && ['running', 'queued', 'waiting'].includes(L.state)) {
    return { jobid: L.jobid, state: L.state, level: L.level || '', since: L.startedAt ?? null, trigger: 'schedule', by: '' };
  }
  return null;
}

/**
 * 이 잡의 취소 진행 — 지금 도는 실행에 취소를 보냈으면 { jobid, at, by, via, stuck }, 아니면 null.
 * @param {object} j  원장 잡(cancelReq 를 실은 것) · @param {number} [now]
 */
export function cancelInfo(j, now = Date.now()) {
  const c = j?.cancelReq;
  if (!c || !Number.isInteger(c.jobid) || !Number.isFinite(c.at)) return null;
  const run = runningRunOf(j);
  if (!run || run.jobid !== c.jobid) return null;
  return { jobid: c.jobid, at: c.at, by: String(c.by || ''), via: c.via === 'group' ? 'group' : 'single', stuck: now - c.at >= CANCEL_WAIT_MS };
}

/**
 * 취소를 (다시) 보낼 수 있나 — 도는 실행이 있고, 아직 보내지 않았거나 보낸 뒤 멈추지 않았을 때. 사유 문구는 화면 · 라우트 공용.
 * @returns {{ ok: true } | { ok: false, code: 'idle'|'sent', reason: string }}
 */
export function cancelGate(j, now = Date.now()) {
  if (!runningRunOf(j)) return { ok: false, code: 'idle', reason: '취소할 실행이 없습니다.' };
  const c = cancelInfo(j, now);
  if (c && !c.stuck) return { ok: false, code: 'sent', reason: `취소를 이미 보냈습니다(${c.by || '?'}) — Director 가 멈추기를 기다리는 중입니다.` };
  return { ok: true };
}

/** 폴러가 따로 물을 취소 실행인가(포탈이 시작한 실행은 pending 으로 이미 묻는다). */
export function cancelTracked(j, now = Date.now()) {
  const c = j?.cancelReq;
  return !!c && Number.isInteger(c.jobid) && Number.isFinite(c.at) && now - c.at < CANCEL_TRACK_MS && j.pending?.jobid !== c.jobid;
}
