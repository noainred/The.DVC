/**
 * bareos/groupRunner.js — 백업 그룹 실행(수동 '지금 실행' · 예약 회차)과 예약 틱(v2.830 · 사용자 결정 '포탈이 실행').
 *
 * 한 그룹 실행 = 그룹 VM 들의 원장 잡을 그 잡의 Director 에 `runJobs`(세션 하나 · RUN_JOBS_MAX 씩)로 보낸다 → 성공한 잡은 pending(폴러가 결과를 반영).
 *   · 대상별 잠금(jobLocks)을 잡은 잡만 보낸다(같은 대상의 삭제·실행·복원과 겹치지 않게) — 잡힌 대상은 '건너뜀'(줄 세우지 않는다).
 *   · 이미 실행 중(pending)·비활성·Director 에 없음·데모/실제 섞임·잡 없음은 보내지 않고 사유를 남긴다(0 으로 섞지 않고 따로 센다).
 *   · 엣지 대행의 '결과 모름' 은 실패로 단정하지 않는다(unknown — 실행됐을 수 있다. pending 을 적지 않는다: jobid 를 모른다).
 * 예약 틱:
 *   · 30초마다 원장을 훑어 decideFire — 회차를 **보내기 전에** claimSlots 로(한 틱에 쓰기 한 번) 파일에 남긴다(한 번 이하: 보낸 뒤 죽어도 같은 회차를 다시 보내지 않는다).
 *   · 훑기만 재진입 가드(동기 — 짧다). 실행은 그룹마다 비동기로 띄우고, 같은 그룹이 아직 돌면 그 회차를 차지하지 않는다(다음 틱에 다시 본다).
 *   · 원장(대상·그룹)을 못 읽으면 아무것도 보내지 않는다. 주기 실행은 trigger 'timer' — 인증 정지된 Director 에는 보내지 않는다(service.sessionOn·relayToEdge).
 *   · 엣지 노드는 돌리지 않는다(그룹 원장은 중앙에 있다 — 엣지는 대행 큐로 받는다).
 */
import { listGroups, getGroup, claimSlots, recordMisses, recordFire, recordPrune, markSending, groupsLoadError, setSkipKey, recordFireCancel } from './groups.js';
import { PRUNE_WAIT_MAX_MS } from './groupRetention.js';
import { decideFire, CATCHUP_MS, slotKey, nextSlot } from './groupSchedule.js';
import { jobDigests, markPending, patchJob, registryLoadError, inBatch, markCancelReq, applyRunRow, clearPending } from './registry.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { lateRunJobs } from './lateReplies.js'; // v2.938: 엣지 대행 늦은 회신 반영(제안 6번)
import { jobDirectorId } from './settings.js';
import { RUN_JOBS_MAX, MID_COMMAND_CODES } from './ops.js';
import { PICKUP_MS, RESULT_MS } from './edgeOps.js';
import { normLevel } from './names.js';
import { tryLockJob, unlockJob } from './jobLocks.js';
import { runningRunOf, cancelInfo } from './cancelState.js';
import { noteGroupRunStart, noteGroupRunEnd } from './inflight.js';
import { logAudit } from '../audit.js';
import { store } from '../store.js';
import { config } from '../config.js';

export const TICK_MS = 30_000;
/**
 * 그룹 한 번 실행의 Director 호출 시한(덩어리마다) — 엣지 대행의 **인출 대기 + 회신 시한**보다 길게(중앙이 먼저 끊지 않게).
 * v2.830 검토 M3: 회신 시한(330초)만 보고 360초로 잡았다 — 인출 대기(기본 120초)가 길면 엣지가 이미 시작한 잡의 jobid 를 잃었다.
 */
export const RUN_DEADLINE_MS = PICKUP_MS + RESULT_MS.runJobs + 60_000;

/** Director 에 명령을 **보내기 전에** 멈추는 오류(세션을 못 열었거나 보내지 않기로 함) — 실패가 아니라 '보내지 못함'(v2.830 검토 L3). */
const NOT_SENT_CODES = new Set(['auth-stopped', 'not-sent', 'not-configured', 'demo-only', 'edge-relay', 'connect', 'tls', 'auth', 'pam', 'blocked', 'invalid', 'busy']);
/**
 * 명령을 보낸 **도중** 끊김 — Director 가 받았을 수 있다(결과 모름 — v2.830 검토 L4).
 * 'jsonrpc' 는 넣지 않는다 — Director 가 오류 객체로 **거부**한 것이다(실행되지 않았다 — 실패). 시험 ④ 가 잡았다.
 */
// v2.847 E2-1: 판정은 ops.js MID_COMMAND_CODES 하나(등록 경로와 같은 표)

/**
 * Director 호출 자체가 던진 오류 → 그 덩어리 VM 들의 상태(순수). unknown(엣지 결과 모름·명령 도중 끊김) · notsent(보내기 전) · failed(그 밖).
 */
export function chunkErrorState(e) {
  const code = e?.code || '';
  if (code === 'unknown' || e?.unknown) return 'unknown';
  if (e?.notSent || NOT_SENT_CODES.has(code)) return 'notsent';
  if (MID_COMMAND_CODES.has(code)) return 'unknown';
  return 'failed';
}
/** runJobs 회신 한 줄 → 상태(순수). 회신에 그 항목이 없으면 결과 모름. */
export function itemState(r) {
  if (!r) return 'unknown';
  if (r.ok && Number.isInteger(r.jobid) && r.jobid > 0) return 'started';
  if (r.code === 'unknown' || MID_COMMAND_CODES.has(r.code)) return 'unknown';
  if (r.code === 'skipped') return 'notsent';
  return 'failed';
}

const fail = (code, msg) => Object.assign(new Error(msg), { code });
const _groupBusy = new Set();
const _queued = new Map();   // 그룹 id → 실행 표(_runs 와 같은 객체) — Director 차례를 기다리는 중(v2.830 버그 점검 S4: 대기 중이 '재시작' 으로 보였다)
const _pruning = new Set();  // v2.831 보관 개수 정리 중(대기 포함) — 실행과 같은 줄에 서고, 그동안 그 그룹의 실행·삭제는 409
/**
 * v2.867 그룹 실행 표 — 줄을 선 순간부터 실행이 끝날 때까지. { since, dir, ctrl: AbortController(회차 중단 — Director 호출에는 넘기지 않는다),
 * cancel: 중단 요청(at·by·includeScheduled) | null, halted: 줄 대기 중 중단(차례가 와도 아무것도 하지 않는다), progress: { total, toSend, sent, started } }
 */
const _runs = new Map();
/** v2.867 회차 중단을 처리하는 중(취소 명령을 보내는 동안) — 그룹 id → { at, by, phase, includeScheduled, entry? }. */
const _cancelling = new Map();
/** 실행·정리·중단 중이거나 차례를 기다리는 중 — 화면 '실행 중' · 삭제 409 · 같은 그룹 다시 실행 409 가 같은 판정을 쓴다. */
export const groupRunning = (id) => _groupBusy.has(id) || _queued.has(id) || _pruning.has(id) || _cancelling.has(id);
export const groupPruning = (id) => _pruning.has(id);
/** v2.867 회차 중단 처리 중이면 그 요청(화면 '멈추는 중'), 아니면 null. */
/** v2.870 감사 A5-02: 지금 멈추는 중인 그룹 · 단계 — 진행 현황 응답 캐시 키에 넣는다(바뀌면 ETag 도 바뀌게). */
export const cancellingKey = () => [..._cancelling.entries()].map(([id, c]) => `${id}:${c.phase || ''}`).join(',');
export function groupCanceling(id) { const c = _cancelling.get(id); return c ? { at: c.at, by: c.by, phase: c.phase, includeScheduled: !!c.includeScheduled } : null; }
/** v2.867 실행 진행(화면 '보냄 n / N') — 줄 대기 중이면 { queued:true } · 실행 중이 아니면 null. */
export function groupProgress(id) {
  const e = _runs.get(id);
  if (!e) return null;
  if (_queued.get(id) === e) return { queued: true, since: e.since };
  return e.progress ? { ...e.progress } : null;
}
/**
 * Director 마다 하나의 줄(모듈 수준 — v2.830 버그 점검 S8: 틱 안에서만 차례를 지켜 다음 틱의 그룹·수동 실행이 같은 Director 에 세션을 동시에 열었다).
 * 예약·수동 실행 모두 이 줄로 들어간다. 줄 사이에 한 번 양보한다(S11 — 세션 전에 거부되는 그룹이 연달아 와도 이벤트 루프를 붙잡지 않게).
 */
const _dirTail = new Map();   // Director id → 마지막 실행 Promise
export function queueGroupRun(groupId, opts = {}) {
  const g = getGroup(groupId);
  if (!g) return Promise.reject(fail('not-found', '백업 그룹을 찾을 수 없습니다.'));
  if (groupRunning(groupId)) return Promise.reject(fail('busy', `‘${g.name}’ 그룹을 실행하는 중입니다 — 끝난 뒤 다시 시도하세요.`));
  const dir = g.directorId || '';
  const entry = {
    since: Date.now(), dir, ctrl: new AbortController(), cancel: null, halted: false, progress: null,
    trigger: opts.trigger === 'timer' ? 'timer' : 'manual', key: opts.slot?.key || '', level: opts.level || opts.slot?.level || '', by: String(opts.by || ''),
  };
  _queued.set(groupId, entry);
  _runs.set(groupId, entry);
  noteGroupRunStart(groupId, g.name);   // 줄을 선 순간부터 업그레이드 자동 적용이 기다린다
  // v2.867: 표는 객체로 맞춰 지운다 — 줄 대기 중 중단한 뒤 같은 그룹을 다시 실행하면 새 표가 생긴다(옛 줄 자리는 차례가 와도 아무것도 하지 않는다)
  return onDirLine(dir, () => {
    if (_queued.get(groupId) === entry) _queued.delete(groupId);
    return entry.halted ? null : runGroup(groupId, { ...opts, ctl: entry });
  }).finally(() => {
    if (_queued.get(groupId) === entry) _queued.delete(groupId);
    if (_runs.get(groupId) === entry) { _runs.delete(groupId); noteGroupRunEnd(groupId); }
  });
}
/** Director 줄 끝에 일 하나를 붙인다(실행·정리 공용). */
function onDirLine(dir, fn) {
  const prev = _dirTail.get(dir) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => new Promise((r) => setImmediate(r))).then(fn);
  const tail = run.catch(() => {});
  _dirTail.set(dir, tail);
  tail.then(() => { if (_dirTail.get(dir) === tail) _dirTail.delete(dir); });
  return run;
}

/** 옛 엣지가 runJobs(·cancelJobs)를 모르면 '알 수 없는 작업' 으로 거절한다 — 사람이 할 일을 덧붙인다. */
function reasonOf(e, what = '그룹 일괄 실행') {
  const msg = String(e?.message || e).slice(0, 300);
  return /알 수 없는 작업/.test(msg) ? `${msg} — 법인 엣지가 이 기능(${what})보다 오래된 판일 수 있습니다. 엣지를 업그레이드한 뒤 다시 시도하세요.` : msg;
}

/**
 * 그룹 하나 실행.
 * @param {string} groupId
 * @param {{ trigger?: 'manual'|'timer', by?: string, level?: string|null, slot?: {key,at,level}|null, signal?: AbortSignal|null, ctl?: object|null }} o
 *   ctl = 실행 표(queueGroupRun) — v2.867 회차 중단 신호(ctl.ctrl)는 **덩어리 사이에서만** 본다(보내는 중인 덩어리를 끊으면 결과 모름 — v2.830 L4).
 *   signal = Director 호출 시한(덩어리마다) — 중단 신호와 다르다.
 * @returns {Promise<object>} 실행 기록(groups.lastFire 와 같은 모양)
 */
export async function runGroup(groupId, { trigger = 'manual', by = '', level = null, slot = null, signal = null, ctl = null } = {}) {
  const g = getGroup(groupId);
  if (!g) throw fail('not-found', '백업 그룹을 찾을 수 없습니다.');
  if (_groupBusy.has(groupId)) throw fail('busy', `‘${g.name}’ 그룹을 실행하는 중입니다 — 끝난 뒤 다시 시도하세요.`);
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 실행하지 않습니다(손상본 보존).');
  _groupBusy.add(groupId);
  // 수동 실행은 보내는 중 표지를 여기서(예약은 회차를 차지할 때 함께 썼다) — 보내는 도중 재시작하면 화면이 그 사실을 보인다(v2.830 검토 L2)
  if (trigger !== 'timer') markSending(groupId, { key: '', at: Date.now(), trigger });
  noteGroupRunStart(groupId, g.name);   // 업그레이드 자동 적용이 이 실행이 끝나기를 기다린다(inflight.js)
  const locked = [];
  const items = [];
  let ledgerError = '';
  let unexpected = '';
  const lvl = level ? normLevel(level) : (slot?.level || g.schedule?.level || 'Incremental');
  const stopped = () => !!ctl?.ctrl?.signal?.aborted;
  let canceled = null;
  let jobs = new Map();
  try {
    const demo = isDemoActive();
    const settings = effectiveSettings();
    const vmName = new Map((store.get()?.vms || []).filter((v) => v.vcenterId === g.vcenterId).map((v) => [v.id, String(v.name || '')]));
    jobs = new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j]));
    const send = [];
    for (const vmId of g.vmIds) {
      const j = jobs.get(vmId);
      const it = { vmId, vmName: j?.vmName || vmName.get(vmId) || vmId, state: 'skipped' };
      items.push(it);
      if (!j) { it.reason = '백업 대상(잡)이 없습니다 — 그룹을 다시 저장하면 등록합니다.'; continue; }
      if (!!j.demo !== demo) { it.reason = j.demo ? '데모 대상입니다 — 실제 Director 에는 이 잡이 없습니다.' : '실제 Director 의 대상입니다 — 지금은 데모 Director 를 쓰는 중입니다.'; continue; }
      if (!j.enabled) { it.reason = '비활성 대상입니다 — 백업 대상 탭에서 활성화하세요.'; continue; }
      if (j.missingInDirector) { it.reason = 'Director 에 이 잡이 없습니다(누가 설정을 지웠을 수 있음).'; continue; }
      if (j.pending?.jobid) { it.reason = `이미 실행 중입니다(jobid ${j.pending.jobid}).`; continue; }
      if (!tryLockJob(j.id)) { it.reason = '이 대상의 다른 요청을 처리하는 중입니다.'; continue; }
      locked.push(j.id);
      send.push({ it, job: j, dir: jobDirectorId(j, settings) });
    }
    // Director 마다 차례로(법인 하나 = 보통 Director 하나), RUN_JOBS_MAX 씩
    const byDir = new Map();
    for (const s of send) { if (!byDir.has(s.dir)) byDir.set(s.dir, []); byDir.get(s.dir).push(s); }
    if (ctl) {
      ctl.progress = { total: items.length, toSend: send.length, sent: 0, started: 0, inflight: 0 };
      // v2.867 반증 F3: 중단 계획이 '이번 회차' 와 '그 밖 실행' 을 가르는 근거(보내는 중에는 lastFire 가 아직 이번 회차가 아니다)
      ctl.sendJobIds = new Set(send.map((s) => s.job.id));
      ctl.startedJobids = new Set();
    }
    for (const [dir, list] of byDir) {
      for (let i = 0; i < list.length; i += RUN_JOBS_MAX) {
        const chunk = list.slice(i, i + RUN_JOBS_MAX);
        // v2.867 회차 중단 — 다음 덩어리를 보내지 않는다(보내는 중이던 덩어리는 회신을 받았다 — 그 실행은 아래에서 취소)
        if (stopped()) { for (const s of chunk) Object.assign(s.it, { state: 'halted', reason: HALT_REASON }); continue; }
        let res;
        if (ctl?.progress) ctl.progress.inflight = chunk.length;   // 회신을 기다리는 덩어리(중단해도 끊지 않는다 — 시작한 뒤 취소)
        try {
          const sig = signal || AbortSignal.timeout(RUN_DEADLINE_MS);
          res = await onDirector(dir, 'runJobs', {
            items: chunk.map((s, k) => ({ key: k, job: s.job.bareosJob, level: lvl, ...(g.storage ? { storage: g.storage } : {}), ...(g.pool ? { pool: g.pool } : {}) })),
          }, { trigger: trigger === 'timer' ? 'timer' : 'manual', signal: sig, onLate: lateRunJobs(chunk.map((s) => s.job.id), { level: lvl, by: by || '예약', trigger: trigger === 'timer' ? 'group-schedule' : 'group' }) });   // v2.938 늦은 회신
        } catch (e) {
          // Director 호출이 통째로 실패 — 잡마다 lastError 를 덮지 않는다(잡이 아니라 Director·전달의 문제다 · v2.830 검토 L3)
          const st = chunkErrorState(e);
          if (ctl?.progress) { ctl.progress.inflight = 0; ctl.progress.sent += chunk.length; }
          for (const s of chunk) {
            s.it.state = st;
            s.it.reason = st === 'unknown' ? `결과 모름 — ${reasonOf(e)} Director 에서 실행 여부를 확인하세요.` : st === 'notsent' ? `보내지 못함 — ${reasonOf(e)}` : reasonOf(e);
          }
          continue;
        }
        const byKey = new Map((Array.isArray(res) ? res : []).map((r) => [r.key, r]));
        // v2.830 버그 점검 S1(실측): VM 마다 대상 원장 전체(3,000건 5MB)를 동기로 써 50건 덩어리에 1.4초 정지 — 덩어리 반영은 쓰기 한 번
        // S3: 그 쓰기가 실패해도(디스크) Director 는 이미 받았다 — 상태는 '시작' 그대로 두고 원장 기록 실패를 실행 기록에 밝힌다(반대로 적지 않는다)
        try { inBatch(() => chunk.forEach((s, k) => {
          const r = byKey.get(k);
          const st = itemState(r);
          if (st === 'started') {
            markPending(s.job.id, { jobid: r.jobid, level: lvl, by: by || '예약', trigger: trigger === 'timer' ? 'group-schedule' : 'group' });
            Object.assign(s.it, { state: 'started', jobid: r.jobid });
          } else if (st === 'unknown') {
            Object.assign(s.it, { state: 'unknown', reason: r ? `결과 모름 — ${r.message || '명령 도중 연결이 끊겼습니다'} — Director 가 받았는지 알 수 없습니다. Director 에서 확인하세요.` : 'Director 회신에 이 항목이 없습니다 — 실행됐는지 알 수 없습니다.' });
          } else if (st === 'notsent') {
            Object.assign(s.it, { state: 'notsent', reason: r.message || '보내지 못함' });
          } else {
            const why = r.message || '사유 미상';
            Object.assign(s.it, { state: 'failed', reason: why });
            patchJob(s.job.id, { lastError: { at: Date.now(), message: `그룹 ‘${g.name}’ 실행 실패 — ${why.slice(0, 240)}` } });
          }
        })); } catch (e) {
          ledgerError = `백업 대상 원장에 실행 기록을 쓰지 못했습니다(${String(e?.message || e).slice(0, 160)}) — 시작한 실행의 결과가 목록에 늦게 반영되거나 반영되지 않을 수 있습니다. Director 에서 확인하세요.`;
          console.warn(`[bareos] 그룹 ‘${g.name}’ ${ledgerError}`);
        }
        if (ctl?.progress) {
          ctl.progress.inflight = 0;
          ctl.progress.sent += chunk.length;
          ctl.progress.started = items.filter((x) => x.state === 'started').length;
          for (const x of chunk) if (x.it.state === 'started' && Number.isInteger(x.it.jobid)) ctl.startedJobids.add(x.it.jobid);
        }
      }
    }
    // v2.867 회차 중단 — 이번 회차가 시작한 실행을 법인 쪽에서 한 번에 취소한다(잠금은 이 실행이 이미 잡고 있다). 마지막 덩어리 회신 뒤
    //   이 검사부터 _groupBusy 를 지우기까지 중단 요청이 빠지지 않는다(그사이 await 은 취소뿐이고, 그동안은 _cancelling 이 두 번째 요청을 막는다).
    if (stopped()) {
      const c = ctl.cancel || { at: Date.now(), by: '', includeScheduled: false };
      const mine = send.filter((s) => s.it.state === 'started' && Number.isInteger(s.it.jobid));
      const r = await cancelLive(mine.map((s) => ({ job: s.job, jobid: s.it.jobid, it: s.it })), { by: c.by, held: true });
      // 반증 F5: 그 밖 실행은 지금 원장으로 다시 고른다(시작 때 사본은 그사이 단건 취소 · 새 실행을 모른다)
      const fresh = c.includeScheduled ? new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j])) : null;
      const extra = c.includeScheduled ? await cancelLive(extraTargets(g, new Set(send.map((s) => s.job.id)), fresh), { by: c.by }) : null;
      canceled = cancelSummary(c, 'sending', r, extra, items.filter((x) => x.state === 'halted').length, items.filter((x) => x.state === 'unknown').length);
    }
  } catch (e) {
    // 예상하지 못한 오류 — 여기까지 보낸 것은 그대로 두고 실행 기록은 남긴다(보내는 중 표지만 남아 '재시작' 으로 보이지 않게 — S3)
    unexpected = String(e?.message || e).slice(0, 300);
    console.warn(`[bareos] 그룹 ‘${g.name}’ 실행 중 오류: ${unexpected}`);
  } finally {
    for (const id of locked) unlockJob(id);
    _groupBusy.delete(groupId);
    if (ctl && _cancelling.get(groupId)?.entry === ctl) _cancelling.delete(groupId);
    noteGroupRunEnd(groupId);
  }
  const count = (st) => items.filter((x) => x.state === st).length;
  // started 는 '시작한' 실행 수 — 취소를 보낸 실행(canceled)도 시작은 했다(보관 정리 · 화면 합계가 같은 뜻으로 센다)
  const fire = {
    key: slot?.key || '', at: Date.now(), trigger, by: String(by || ''), level: lvl, storage: g.storage || '', pool: g.pool || '',
    total: items.length, started: count('started') + count('canceled'), skipped: count('skipped'), notSent: count('notsent'), failed: count('failed'), unknown: count('unknown'),
    ...(count('halted') ? { halted: count('halted') } : {}), ...(canceled ? { canceled } : {}), items,
    ...(ledgerError || unexpected ? { error: [unexpected, ledgerError].filter(Boolean).join(' · ') } : {}),
  };
  recordFire(groupId, fire);
  logAudit({
    user: by || 'system', action: trigger === 'timer' ? 'Bareos 그룹 예약 실행' : 'Bareos 그룹 실행', target: `${g.vcenterId}/${g.name}`,
    detail: `${slot?.key ? `회차 ${slot.key} · ` : ''}${lvl}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''} · 시작 ${fire.started} · 건너뜀 ${fire.skipped} · 보내지 못함 ${fire.notSent} · 실패 ${fire.failed} · 결과 모름 ${fire.unknown} / ${fire.total}${canceled ? ` · ${cancelAuditText(canceled)}` : ''}`,
    ip: '',
  });
  if (canceled) logAudit({ user: canceled.by || 'system', action: 'Bareos 그룹 회차 중단', target: `${g.vcenterId}/${g.name}`, detail: `${slot?.key ? `회차 ${slot.key} · ` : ''}${cancelAuditText(canceled)}`, ip: '' });
  return fire;
}

/* ───────── v2.867 회차 중단(시안 docs/design/bareos-cancel/ §4.2) ───────── */

export const HALT_REASON = '회차 중단으로 보내지 않았습니다.';
/** 묶음 취소 한 번의 Director 호출 시한(덩어리마다) — 실행과 같은 관계(엣지 인출 대기 + 회신 시한보다 길게). */
export const CANCEL_DEADLINE_MS = PICKUP_MS + RESULT_MS.cancelJobs + 60_000;
const PHASE_TEXT = Object.freeze({ queued: '줄 대기', sending: '보내는 중', running: 'Director 실행 중', extra: '그 밖 실행만' });

/** 감사 · 회차 기록 한 줄(사람이 읽는다). */
export function cancelAuditText(c) {
  const parts = [`${c.effective === false ? '회차 중단 못 함' : '회차 중단'}(${PHASE_TEXT[c.phase] || c.phase} · ${c.scope === 'all' ? '그룹 VM 의 실행 중 전부' : '이번 회차만'}${c.by ? ` · ${c.by}` : ''})`];
  for (const [k, t] of [['canceled', '취소 보냄'], ['finished', '이미 끝남'], ['cleared', '추적만 해제'], ['halted', '시작 전 멈춤'], ['failed', '취소 실패'], ['unknown', '결과 모름'], ['busy', '다른 요청 중']]) if (c[k] > 0) parts.push(`${t} ${c[k]}`);
  if (c.extra) {
    const bad = c.extra.failed + c.extra.unknown + c.extra.busy;
    parts.push(`그 밖 실행 취소 ${c.extra.canceled}${bad ? `(실패·모름 ${bad})` : ''}`);
  }
  if (c.startUnknown > 0) parts.push(`시작 결과 모름 ${c.startUnknown}(취소 못 함)`);
  if (c.dueKey) parts.push(`차례였던 회차 ${c.dueKey} 돌리지 않음`);
  if (c.skipKey) parts.push(`다음 회차 ${c.skipKey} 건너뜀`);
  if (c.effective === false && c.reason) parts.push(`사유 ${c.reason}`);
  return parts.join(' · ');
}

const ZERO = Object.freeze({ canceled: 0, finished: 0, cleared: 0, failed: 0, unknown: 0, busy: 0, vms: {} });
/** 실패 · 다른 요청 중 · 결과 모름 항목의 첫 사유(화면이 '중단하지 못함' 의 까닭으로 보인다 — 옛 엣지면 업그레이드 안내). */
const firstReason = (...rs) => {
  for (const r of rs) for (const v of Object.values(r?.vms || {})) if (['failed', 'busy', 'unknown'].includes(v.state) && v.reason) return String(v.reason).slice(0, 300);
  return '';
};
/**
 * 결과 합(순수) — 중단 기록 lastFire.canceled 의 모양.
 * effective = 실제로 무언가 멈췄거나 멈췄을 수 있다(취소 보냄 · 시작 전 멈춤 · 결과 모름) — 반증 F2: 취소가 한 건도 가지 않은 시도(옛 엣지 · 전부 실패)를
 *   '중단됨' 으로 보이거나 보관 정리를 막지 않게. 보관 정리는 effective 일 때만 건너뛴다(pruneDue).
 */
export function cancelSummary(c, phase, r, extra, halted = 0, startUnknown = 0) {
  const x = r || ZERO;
  const effective = x.canceled + halted + x.unknown + (extra ? extra.canceled + extra.unknown : 0) > 0;
  const reason = effective ? '' : firstReason(x, extra);
  return {
    at: c.at, by: String(c.by || ''), phase, scope: c.includeScheduled ? 'all' : 'fire',
    canceled: x.canceled, finished: x.finished, cleared: x.cleared, failed: x.failed, unknown: x.unknown, busy: x.busy, halted,
    extra: extra ? { canceled: extra.canceled, finished: extra.finished, cleared: extra.cleared, failed: extra.failed, unknown: extra.unknown, busy: extra.busy } : null,
    effective, ...(reason ? { reason } : {}),
    ...(c.skipKey ? { skipKey: c.skipKey } : {}), ...(c.dueKey ? { dueKey: c.dueKey } : {}),
    // v2.870 감사 A1-05: 시작 결과를 모르는 항목(jobid 없음)은 취소를 보낼 수 없다 — 중단 요약에 수를 남겨 사람이 Director 에서 확인하게(예전에는 회차 기록에만)
    ...(startUnknown > 0 ? { startUnknown } : {}),
  };
}

/** 회차 기록 항목(started·canceled 이고 jobid 가 있는 것)의 jobid 집합. */
const fireJobids = (lf) => new Set((lf?.items || []).filter((it) => (it.state === 'started' || it.state === 'canceled') && Number.isInteger(it.jobid)).map((it) => it.jobid));

/**
 * 그룹 VM 중 지금 도는 실행 — 취소를 보낼 수 있는 것만(이미 보냈고 아직 '멈추지 않음' 이 아니면 뺀다).
 * @param {Set<string>} exceptJobIds 빼고 볼 잡(원장 id — 러너가 이번에 다룬 잡)
 * @param {Set<number>|null} onlyJobids 이 jobid 들만(이번 회차 실행) · null = 전부
 * @param {Set<number>|null} skipJobids 이 jobid 들은 빼고(그 밖 실행만)
 */
function liveTargets(g, jobsByVm, { exceptJobIds = new Set(), onlyJobids = null, skipJobids = null, now = Date.now() } = {}) {
  const out = [];
  const demo = isDemoActive();
  for (const vmId of targetVmIds(g, !!onlyJobids)) {
    const j = jobsByVm.get(vmId);
    if (!j || exceptJobIds.has(j.id)) continue;
    if (!!j.demo !== demo) continue;   // 반증 F6: 데모/실제가 섞인 잡은 다루지 않는다(runGroup · 단건 modeMismatch 와 같은 규칙)
    const run = runningRunOf(j);
    if (!run) continue;
    if (onlyJobids && !onlyJobids.has(run.jobid)) continue;
    if (skipJobids && skipJobids.has(run.jobid)) continue;
    const ci = cancelInfo(j, now);
    if (ci && !ci.stuck) continue;
    out.push({ job: j, jobid: run.jobid });
  }
  return out;
}
/**
 * 볼 VM — 지금 그룹 VM, 이번 회차 실행을 고를 때는 회차 기록의 VM 도(반증 F7: 회차 뒤 그룹에서 뺀 VM 의 이번 회차 실행을 놓치지 않게).
 */
function targetVmIds(g, withFire) {
  if (!withFire) return g.vmIds;
  return [...new Set([...g.vmIds, ...(g.lastFire?.items || []).map((it) => it.vmId).filter(Boolean)])];
}
/** 그 밖 실행(Bareos 스케줄 · 수동) — 러너가 이번에 다룬 잡을 뺀 나머지. */
const extraTargets = (g, exceptJobIds, jobsByVm, now = Date.now()) => liveTargets(g, jobsByVm, { exceptJobIds, now });

/**
 * 실행 중 취소(묶음) — Director 마다 RUN_JOBS_MAX 씩 `cancelJobs` 한 번(엣지 대행이면 법인 쪽에서 한 번에 — WAN 왕복은 덩어리마다 한 번).
 * held=false 면 대상 잠금을 여기서 잡는다(다른 요청이 그 대상을 다루는 중이면 busy 로 남기고 넘어간다 — 줄 세우지 않는다).
 * 결과 반영: 취소를 보냄 → 원장 cancelReq · 이미 끝남 → 결과 반영(백업 행만) · Director 가 모름 → 추적만 해제. 반영은 덩어리마다 쓰기 한 번(inBatch — v2.830 S1).
 * @param {{ job: object, jobid: number, it?: object }[]} targets  it = 회차 기록 항목(있으면 상태·사유를 바꾼다)
 * @returns {Promise<{ canceled, finished, cleared, failed, unknown, busy, vms: { [vmId: string]: { state: string, reason: string } } }>}
 */
export async function cancelLive(targets, { by = '', held = false } = {}) {
  const out = { canceled: 0, finished: 0, cleared: 0, failed: 0, unknown: 0, busy: 0, vms: {} };
  if (!targets.length) return out;
  const settings = effectiveSettings();
  const locked = [];
  const note = (t, st, reason) => {
    out.vms[t.job.vmId] = { state: st, reason };
    if (t.it) Object.assign(t.it, st === 'canceled' ? { state: 'canceled', reason } : { reason });
  };
  try {
    const send = [];
    for (const t of targets) {
      if (!held) {
        if (!tryLockJob(t.job.id)) { out.busy += 1; note(t, 'busy', '이 대상의 다른 요청을 처리하는 중이라 취소하지 못했습니다 — 백업 대상 탭에서 다시 취소하세요.'); continue; }
        locked.push(t.job.id);
      }
      send.push({ ...t, dir: jobDirectorId(t.job, settings) });
    }
    const byDir = new Map();
    for (const x of send) { if (!byDir.has(x.dir)) byDir.set(x.dir, []); byDir.get(x.dir).push(x); }
    for (const [dir, list] of byDir) {
      for (let i = 0; i < list.length; i += RUN_JOBS_MAX) {
        const chunk = list.slice(i, i + RUN_JOBS_MAX);
        let res;
        try {
          res = await onDirector(dir, 'cancelJobs', { items: chunk.map((t, k) => ({ key: k, jobid: t.jobid, name: t.job.bareosJob, pendingJobid: t.job.pending?.jobid ?? null })) },
            { trigger: 'manual', signal: AbortSignal.timeout(CANCEL_DEADLINE_MS) });
        } catch (e) {
          const st = chunkErrorState(e);
          for (const t of chunk) {
            if (st === 'unknown') { out.unknown += 1; note(t, 'unknown', `취소 결과 모름 — ${reasonOf(e, '그룹 회차 중단')} Director 에서 확인하세요.`); }
            else { out.failed += 1; note(t, 'failed', `취소 ${st === 'notsent' ? '보내지 못함' : '실패'} — ${reasonOf(e, '그룹 회차 중단')}`); }
          }
          continue;
        }
        const byKey = new Map((Array.isArray(res) ? res : []).map((r) => [r.key, r]));
        try {
          inBatch(() => chunk.forEach((t, k) => {
            const r = byKey.get(k);
            if (!r) { out.unknown += 1; note(t, 'unknown', '취소 결과 모름 — Director 회신에 이 항목이 없습니다. Director 에서 확인하세요.'); return; }
            if (!r.ok) {
              const unk = r.code === 'unknown' || MID_COMMAND_CODES.has(r.code);
              if (unk) out.unknown += 1; else out.failed += 1;
              note(t, unk ? 'unknown' : 'failed', `${unk ? '취소 결과 모름' : '취소 실패'} — ${String(r.message || '사유 미상').slice(0, 240)}`);
              return;
            }
            if (r.canceled) {
              markCancelReq(t.job.id, { jobid: t.jobid, by, via: 'group' });
              out.canceled += 1; note(t, 'canceled', `취소를 보냈습니다(${by || '?'}) — Director 가 멈추면 결과가 ‘취소’ 로 남습니다.`);
              return;
            }
            if (r.final) {
              // 단건 취소와 같은 규칙(v2.825.1 G6) — 백업 행(type B)만 실행 결과로 반영
              if (!r.final.type || r.final.type === 'B') applyRunRow(t.job.id, r.final);
              out.finished += 1; note(t, 'finished', '취소를 보내기 전에 이미 끝났습니다.');
              return;
            }
            if (r.cleared) {
              clearPending(t.job.id, `Director 카탈로그에 jobid ${t.jobid} 가 없어 포탈의 추적만 내렸습니다(그룹 회차 중단) — 실제 결과는 Director 에서 확인하세요.`);
              out.cleared += 1; note(t, 'cleared', 'Director 가 이 실행을 몰라 포탈의 추적만 내렸습니다.');
              return;
            }
            out.unknown += 1; note(t, 'unknown', '취소 결과 모름 — 회신에 결과가 없습니다. Director 에서 확인하세요.');
          }));
        } catch (e) {
          console.warn(`[bareos] 회차 중단 결과를 원장에 쓰지 못했습니다(${String(e?.message || e).slice(0, 160)}) — 취소는 Director 에 갔습니다.`);
        }
      }
    }
  } finally {
    for (const id of locked) unlockJob(id);
  }
  return out;
}

/**
 * 회차 중단 계획(지금 원장 · 실행 표만 본다 — Director 에 접속하지 않는다). 화면 확인 창의 수와 라우트 판정이 같은 함수를 쓴다.
 *  · phase: queued(줄 대기) · sending(보내는 중) · running(보낸 뒤 Director 에서 도는 이번 회차 실행) · null(멈출 이번 회차 실행이 없음)
 *  · fire: 이번 회차(lastFire)가 시작해 아직 도는 실행 중 취소를 보낼 수 있는 것 · extra: 그룹 VM 의 그 밖 실행(Bareos 스케줄 · 수동)
 *  · sent: 이미 취소를 보내 멈추는 중인 실행 · stuck: 그중 '멈추지 않음'
 *  · sentFire · stuckFire: sent · stuck 중 **이번 회차** 실행(v2.906 — 회차 중단 없이 행마다 '취소…' 로 멈춘 회차를 화면이 구분하게. v2.870 A1-04 남김)
 * @returns {{ phase: 'queued'|'sending'|'running'|null, fire: number, extra: number, sent: number, stuck: number, sentFire: number, stuckFire: number, progress: object|null, pruning: boolean }}
 */
export function cancelPlan(g, jobsByVm, now = Date.now()) {
  const e = _runs.get(g.id);
  const queued = !!e && _queued.get(g.id) === e;
  const sending = !queued && !!e && _groupBusy.has(g.id);
  // 반증 F3: 보내는 중에는 이번 회차 실행 = 러너가 시작한 jobid · 이번에 보내는 잡은 '그 밖' 이 아니다(시작 전이거나 회신 대기)
  const mine = queued ? new Set() : sending ? (e.startedJobids || new Set()) : fireJobids(g.lastFire);
  const sendIds = sending ? (e.sendJobIds || new Set()) : new Set();
  const members = new Set(g.vmIds);
  const demo = isDemoActive();
  let fire = 0; let extra = 0; let sent = 0; let stuck = 0; let sentFire = 0; let stuckFire = 0;
  for (const vmId of targetVmIds(g, true)) {
    const j = jobsByVm.get(vmId);
    const run = j && !!j.demo === demo ? runningRunOf(j) : null;
    if (!run) continue;
    const isFire = mine.has(run.jobid);
    if (!isFire && !members.has(vmId)) continue;   // 그룹에서 뺀 VM 의 그 밖 실행은 이 그룹 일이 아니다
    const ci = cancelInfo(j, now);
    if (ci) { sent += 1; if (isFire) sentFire += 1; if (ci.stuck) { stuck += 1; if (isFire) stuckFire += 1; } else continue; }
    if (isFire) fire += 1; else if (!sendIds.has(j.id)) extra += 1;
  }
  const phase = queued ? 'queued' : sending ? 'sending' : fire > 0 ? 'running' : null;
  return { phase, fire, extra, sent, stuck, sentFire, stuckFire, progress: groupProgress(g.id), pruning: _pruning.has(g.id) };
}

/**
 * 회차 중단 요청 — 단계마다 다르게:
 *  · queued : 줄에서 뺀다(차례가 와도 아무것도 보내지 않는다) — 회차 기록은 바로(전부 '시작 전 멈춤')
 *  · sending: 다음 덩어리를 보내지 않게 신호만(러너가 덩어리 사이에서 보고, 보낸 실행을 취소하고 기록한다)
 *  · running: 이번 회차가 시작해 아직 도는 실행을 묶음 취소(뒤에서 — 응답은 바로)
 * includeScheduled 면 그룹 VM 의 그 밖 실행(Bareos 스케줄 · 수동)도 함께 취소한다. skipNext 면 다음 예약 회차 하나를 건너뛴다.
 * @returns {{ phase, fire, extra, halted, skipKey, done: Promise<object|null> }}  done = 뒤에서 도는 취소가 끝나면 풀린다(시험이 기다린다)
 */
export function cancelGroupRun(groupId, { by = '', includeScheduled = false, skipNext = false, now = Date.now() } = {}) {
  const g = getGroup(groupId);
  if (!g) throw fail('not-found', '백업 그룹을 찾을 수 없습니다.');
  if (_cancelling.has(groupId)) throw fail('busy', `‘${g.name}’ 그룹의 회차를 이미 멈추는 중입니다.`);
  if (_pruning.has(groupId)) throw fail('busy', `‘${g.name}’ 그룹의 보관 정리 중입니다 — 정리는 끝난 실행만 지웁니다. 끝난 뒤 다시 보세요.`);
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 멈추지 않습니다(손상본 보존 — Director 에서 직접 취소하세요).');
  const jobs = new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j]));
  const plan = cancelPlan(g, jobs, now);
  const e = _runs.get(groupId);   // queued · sending 이면 반드시 있다(cancelPlan 이 그 표로 판정했다)
  const mine = plan.phase === 'running' ? fireJobids(g.lastFire) : new Set();
  // 그 밖 실행 — 보내는 중이면 러너가 끝에서 따로 고른다(러너가 이번에 다룬 잡을 빼야 한다)
  const extraList = includeScheduled && plan.phase !== 'sending' ? liveTargets(g, jobs, { skipJobids: mine, now }) : [];
  if (!plan.phase && !extraList.length) {
    throw fail('idle', plan.sent ? `‘${g.name}’ 그룹의 실행에는 이미 취소를 보냈습니다 — Director 가 멈추기를 기다리는 중입니다.` : `‘${g.name}’ 그룹에서 멈출 실행이 없습니다 — 회차가 이미 끝났습니다.`);
  }
  const c = { at: now, by: String(by || ''), includeScheduled: !!includeScheduled };
  // 반증 F1: 실행 중이라 틱이 차지하지 못한 예약 회차(지금 차례 — 따라잡는 범위 안)가 있으면, 중단이 끝나자마자 그 회차가 다시 출발했다.
  //   멈추라고 했으므로 그 회차는 '중단으로 돌리지 않음' 으로 남긴다(건너뛰기를 고르면 그다음 회차를 건너뛴다).
  const due = decideFire(g, now);
  if (due.action === 'fire' && recordMisses([{ id: groupId, slot: due.slot, reason: 'stopped' }]).includes(groupId)) c.dueKey = due.slot.key;
  if (skipNext) {
    const nx = nextSlot(g.schedule, now);
    if (nx) {
      try { c.skipKey = setSkipKey(groupId, nx.key); } catch (err) { console.warn(`[bareos] 그룹 ‘${g.name}’ 다음 회차 건너뛰기를 기록하지 못했습니다: ${String(err?.message || err).slice(0, 160)}`); }
    }
  }
  if (plan.phase === 'sending') {
    e.cancel = c; e.ctrl.abort();
    _cancelling.set(groupId, { ...c, phase: 'sending', entry: e });
    const p = e.progress;
    // 반증 F3: 회신을 기다리는 덩어리(inflight)는 시작한 뒤 취소된다 — 시작 전 멈춤에 넣지 않는다
    return { phase: 'sending', fire: p ? (p.started || 0) + (p.inflight || 0) : 0, extra: includeScheduled ? plan.extra : 0, halted: p ? Math.max(0, p.toSend - p.sent - (p.inflight || 0)) : 0,
      skipKey: c.skipKey || '', dueKey: c.dueKey || '', done: Promise.resolve(null) };
  }
  const phase = plan.phase || 'extra';
  if (phase === 'queued') {
    // 줄에서 뺀다 — 차례가 와도 아무것도 하지 않는다. 회차 기록은 지금(전부 시작 전 멈춤)
    e.halted = true; e.cancel = c; e.ctrl.abort();
    if (_queued.get(groupId) === e) _queued.delete(groupId);
    const items = g.vmIds.map((vmId) => ({ vmId, vmName: jobs.get(vmId)?.vmName || vmId, state: 'halted', reason: HALT_REASON }));
    _cancelling.set(groupId, { ...c, phase });
    noteGroupRunStart(`${groupId}#cancel`, `${g.name} 회차 중단`);   // 반증 F4: 뒤에서 도는 중단도 업그레이드 자동 적용이 기다린다
    const done = (async () => {
      const extra = extraList.length ? await cancelLive(extraList, { by: c.by }) : null;
      const canceled = cancelSummary(c, 'queued', null, extra, items.length);
      recordFire(groupId, {
        key: e.key || '', at: Date.now(), trigger: e.trigger || 'manual', by: e.by || '', level: e.level || g.schedule?.level || 'Incremental', storage: g.storage || '', pool: g.pool || '',
        total: items.length, started: 0, skipped: 0, notSent: 0, failed: 0, unknown: 0, halted: items.length, canceled, items,
      });
      logAudit({ user: c.by || 'system', action: 'Bareos 그룹 회차 중단', target: `${g.vcenterId}/${g.name}`, detail: `${e.key ? `회차 ${e.key} · ` : ''}${cancelAuditText(canceled)}`, ip: '' });
      return canceled;
    })().finally(() => { if (_cancelling.get(groupId)?.at === c.at) _cancelling.delete(groupId); noteGroupRunEnd(`${groupId}#cancel`); });
    return { phase, fire: 0, extra: extraList.length, halted: items.length, skipKey: c.skipKey || '', dueKey: c.dueKey || '', done };
  }
  // running — 이번 회차가 시작해 아직 도는 실행(+ 고르면 그 밖 실행) · extra — 그 밖 실행만(이번 회차 실행은 없다)
  const fireAt = g.lastFire?.at ?? null;
  const fireTargets = phase === 'running' ? liveTargets(g, jobs, { onlyJobids: mine, now }) : [];
  _cancelling.set(groupId, { ...c, phase });
  noteGroupRunStart(`${groupId}#cancel`, `${g.name} 회차 중단`);   // 반증 F4
  const done = (async () => {
    const r = await cancelLive(fireTargets, { by: c.by });
    const extra = extraList.length ? await cancelLive(extraList, { by: c.by }) : null;
    const canceled = cancelSummary(c, phase, r, extra, 0, phase === 'running' ? (g.lastFire?.items || []).filter((it) => it?.state === 'unknown').length : 0);
    if (fireAt != null && fireTargets.length) {
      const patch = {};
      for (const [vmId, v] of Object.entries(r.vms)) patch[vmId] = v.state === 'canceled' ? { state: 'canceled', reason: v.reason } : { reason: v.reason };
      recordFireCancel(groupId, fireAt, canceled, patch);
    }
    logAudit({ user: c.by || 'system', action: 'Bareos 그룹 회차 중단', target: `${g.vcenterId}/${g.name}`, detail: `${g.lastFire?.key ? `회차 ${g.lastFire.key} · ` : ''}${cancelAuditText(canceled)}`, ip: '' });
    return canceled;
  })().finally(() => { if (_cancelling.get(groupId)?.at === c.at) _cancelling.delete(groupId); noteGroupRunEnd(`${groupId}#cancel`); });
  return { phase, fire: fireTargets.length, extra: extraList.length, halted: 0, skipKey: c.skipKey || '', dueKey: c.dueKey || '', done };
}


/** 정리 한 번의 Director 호출 시한(덩어리마다) — 실행과 같은 관계(엣지 인출 대기 + 회신 시한보다 길게). */
export const PRUNE_DEADLINE_MS = PICKUP_MS + RESULT_MS.pruneJobs + 60_000;

/**
 * v2.831 이 그룹을 지금 정리할 차례인가(순수). 보관 개수가 있고 · 마지막 실행이 무언가를 시작했고 · 그 실행으로 아직 정리하지 않았고 ·
 * 그 실행이 시작한 백업이 모두 끝났을 때(끝나지 않은 실행은 어차피 지우지 않지만, 끝난 뒤에 세어야 '최근 N개' 에 이번 백업이 들어간다).
 * 실행 뒤 PRUNE_WAIT_MAX_MS 가 지나면 끝나지 않은 VM 이 있어도 정리한다(사라진 실행이 정리를 영원히 막지 않게).
 * @param {object} g 그룹 · @param {Map<string,object>} jobsByVm 원장 잡(vmId →) · @param {number} now
 */
export function pruneDue(g, jobsByVm, now = Date.now()) {
  if (g.keep == null || !g.lastFire || !(g.lastFire.started > 0)) return false;
  // v2.867 중단된 회차로는 정리하지 않는다(사용자 결정 ④ — 성공이 덜 쌓인 회차를 기준으로 오래된 실행을 지우지 않게). 다음 정상 회차가 끝난 뒤 돈다
  if (g.lastFire.canceled && g.lastFire.canceled.effective !== false) return false;   // 반증 F2: 아무것도 멈추지 못한 시도는 막지 않는다
  // 반증 F5: 그 실행으로 이미 정리했으면 다시 하지 않는다 — 보관 개수를 바꾸기만 해서는 돌지 않는다(다음 그룹 실행이 끝난 뒤 · 화면 안내와 같게)
  if (g.lastPrune && g.lastPrune.fireAt === g.lastFire.at) return false;
  if (now - g.lastFire.at >= PRUNE_WAIT_MAX_MS) return true;
  return !g.vmIds.some((id) => jobsByVm.get(id)?.pending?.jobid);
}

/** 미리 보기 동시 1건(그룹마다 — 버튼 연타가 같은 Director 에 같은 조회를 겹쳐 보내지 않게). */
const _previewing = new Set();
export const groupPreviewing = (id) => _previewing.has(id);
/** 미리 보기 결과 행 상한(화면 표) — 합계는 전부 센다. */
export const PREVIEW_ROWS_MAX = 300;

/**
 * v2.843 보관 정리 **미리 보기**(읽기 전용 — 지우지 않는다 · 잠금·기록·감사 없음). 사용자 원칙 '백업은 법인 로컬':
 * 엣지 대행 법인은 그 엣지가 로컬 Director 에서 `ops.prunePreview` 를 돌린다(VM 수만큼 WAN 을 왕복하지 않는다 — 요약만 올라온다).
 * 대상 VM 은 pruneGroup 과 **같은 판정**(원장에 잡이 있고 · 데모 모드 일치 · Director 에 있는 잡) · 같은 입력(keep · since = 잡 등록 시각).
 * @param {string} groupId
 * @param {{ keep?: number|null, demoOnly?: boolean, signal?: AbortSignal }} [o] keep 을 주면 그 값으로(저장 전 화면 값) · 없으면 그룹의 값
 * @returns {Promise<{ keep, jobs, would, vms, noBase, failed, notSent, errors: {vmName, reason}[], rows: {vmName, would, more?, kept, good, reason?}[] }>}
 */
export async function previewPrune(groupId, { keep: keepIn, demoOnly = false, signal = null } = {}) {
  const g = getGroup(groupId);
  if (!g) throw fail('not-found', '백업 그룹을 찾을 수 없습니다.');
  const keep = keepIn === undefined ? (g.keep ?? null) : keepIn;
  if (keep == null) throw fail('invalid', '보관 개수가 없습니다(제한 없음) — 정리하지 않으므로 미리 볼 것이 없습니다.');
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 미리 보지 않습니다(손상본 보존).');
  if (_previewing.has(groupId)) throw fail('busy', `‘${g.name}’ 그룹의 미리 보기가 진행 중입니다 — 끝난 뒤 다시 시도하세요.`);
  _previewing.add(groupId);
  const out = { keep, jobs: 0, would: 0, vms: 0, noBase: 0, failed: 0, notSent: 0, errors: [], rows: [] };
  try {
    const demo = isDemoActive();
    const settings = effectiveSettings();
    const jobs = new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j]));
    const byDir = new Map();
    for (const vmId of g.vmIds) {
      const j = jobs.get(vmId);
      if (!j || !!j.demo !== demo || j.missingInDirector) continue;
      const dir = jobDirectorId(j, settings);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(j);
      out.jobs += 1;
    }
    for (const [dir, list] of byDir) {
      for (let i = 0; i < list.length; i += RUN_JOBS_MAX) {
        const chunk = list.slice(i, i + RUN_JOBS_MAX);
        let res;
        try {
          res = await onDirector(dir, 'prunePreview', { items: chunk.map((j, k) => ({ key: k, job: j.bareosJob, keep, ...(Number.isFinite(j.createdAt) ? { since: j.createdAt } : {}) })) },
            { demoOnly, signal: signal || AbortSignal.timeout(PRUNE_DEADLINE_MS) });
        } catch (e) {
          out.failed += chunk.length;
          if (chunkErrorState(e) === 'notsent') out.notSent += chunk.length;
          if (out.errors.length < 20) out.errors.push({ vmName: `${chunk.length}대`, reason: /알 수 없는 작업/.test(String(e?.message || '')) ? `${String(e.message).slice(0, 200)} — 법인 엣지가 이 기능(정리 미리 보기)보다 오래된 판입니다. 엣지를 업그레이드한 뒤 다시 보세요.` : String(e?.message || e).slice(0, 300) });
          continue;
        }
        const byKey = new Map((Array.isArray(res) ? res : []).map((r) => [r.key, r]));
        chunk.forEach((j, k) => {
          const r = byKey.get(k);
          const vmName = j.vmName || j.vmId;
          if (!r || !r.ok) { out.failed += 1; if (out.errors.length < 20) out.errors.push({ vmName, reason: r?.message || 'Director 회신에 이 항목이 없습니다.' }); return; }
          const would = Number.isInteger(r.would) && r.would >= 0 ? r.would : 0;
          out.would += would + (Number.isInteger(r.more) ? r.more : 0);
          if (would > 0) out.vms += 1;
          if (r.reason && !would && r.baseJobid == null && r.good > keep) out.noBase += 1;
          if (out.rows.length < PREVIEW_ROWS_MAX) out.rows.push({ vmName, would, ...(r.more ? { more: r.more } : {}), kept: r.kept ?? null, good: r.good ?? null, ...(r.reason ? { reason: r.reason } : {}) });
        });
      }
    }
  } finally { _previewing.delete(groupId); }
  out.rows.sort((a, b) => (b.would + (b.more || 0)) - (a.would + (a.more || 0)) || String(a.vmName).localeCompare(String(b.vmName)));
  return out;
}

/**
 * 그룹 하나 정리 — 그룹 VM 의 잡마다 Director 에서 이력을 읽고 보관 개수 밖의 오래된 실행을 지운다(ops.pruneJobs · groupRetention 규칙).
 * 잡 잠금(jobLocks)을 잡은 잡만(복원·실행 중인 대상과 겹치지 않게 — 잡힌 대상은 다음 정리로). 결과는 groups.lastPrune · 지운 것이 있으면 감사.
 */
export async function pruneGroup(groupId, { trigger = 'timer', signal = null } = {}) {
  const g = getGroup(groupId);
  if (!g) throw fail('not-found', '백업 그룹을 찾을 수 없습니다.');
  if (g.keep == null) return null;
  if (registryLoadError()) throw fail('unavailable', '백업 대상 원장을 읽지 못한 상태라 정리하지 않습니다(손상본 보존).');
  noteGroupRunStart(groupId, g.name);
  const locked = [];
  const out = { at: 0, fireAt: g.lastFire?.at ?? null, keep: g.keep, jobs: 0, deleted: 0, failed: 0, skipped: 0, notDeleted: 0, unknownDeleted: 0, noBase: 0, keptMin: null, keptMax: null, baseMin: null, baseMax: null, errors: [] };
  const deletedIds = [];
  const unknownIds = [];   // delete 를 보냈지만 결과를 모르는 jobid(반증 F4)
  try {
    const demo = isDemoActive();
    const settings = effectiveSettings();
    const jobs = new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j]));
    const send = [];
    for (const vmId of g.vmIds) {
      const j = jobs.get(vmId);
      if (!j || !!j.demo !== demo || j.missingInDirector) continue;
      if (!tryLockJob(j.id)) { out.skipped += 1; continue; }
      locked.push(j.id);
      send.push({ job: j, dir: jobDirectorId(j, settings) });
    }
    out.jobs = send.length;
    const byDir = new Map();
    for (const x of send) { if (!byDir.has(x.dir)) byDir.set(x.dir, []); byDir.get(x.dir).push(x); }
    for (const [dir, list] of byDir) {
      for (let i = 0; i < list.length; i += RUN_JOBS_MAX) {
        const chunk = list.slice(i, i + RUN_JOBS_MAX);
        let res;
        try {
          res = await onDirector(dir, 'pruneJobs', { items: chunk.map((x, k) => ({ key: k, job: x.job.bareosJob, keep: g.keep, ...(Number.isFinite(x.job.createdAt) ? { since: x.job.createdAt } : {}) })) },
            { trigger: trigger === 'timer' ? 'timer' : 'manual', signal: signal || AbortSignal.timeout(PRUNE_DEADLINE_MS) });
        } catch (e) {
          out.failed += chunk.length;
          const st = chunkErrorState(e);
          if (out.errors.length < 20) out.errors.push({ vmName: `${chunk.length}대`, reason: st === 'unknown' ? `결과 모름 — ${reasonOf(e)} 지웠는지 알 수 없습니다(Director 에서 확인).` : reasonOf(e) });
          if (st === 'unknown') out.unknownChunks = (out.unknownChunks || 0) + 1;
          continue;
        }
        const byKey = new Map((Array.isArray(res) ? res : []).map((r) => [r.key, r]));
        chunk.forEach((x, k) => {
          const r = byKey.get(k);
          if (!r || !r.ok) {
            out.failed += 1;
            if (Array.isArray(r?.sent) && r.sent.length) { out.unknownDeleted += r.sent.length; for (const id of r.sent) if (unknownIds.length < 500) unknownIds.push(id); }
            if (out.errors.length < 20) out.errors.push({ vmName: x.job.vmName || x.job.vmId, reason: r?.message || 'Director 회신에 이 항목이 없습니다 — 지웠는지 알 수 없습니다.' });
            return;
          }
          const del = Array.isArray(r.deleted) ? r.deleted : [];
          out.deleted += del.length;
          for (const id of del) if (deletedIds.length < 500) deletedIds.push(id);
          out.notDeleted += Number(r.notDeleted) || 0;
          if (r.reason && !del.length && r.baseJobid == null && r.good > g.keep) out.noBase += 1;
          if (Number.isInteger(r.kept)) { out.keptMin = out.keptMin == null ? r.kept : Math.min(out.keptMin, r.kept); out.keptMax = out.keptMax == null ? r.kept : Math.max(out.keptMax, r.kept); }
          if (Number.isFinite(r.baseAt)) { out.baseMin = out.baseMin == null ? r.baseAt : Math.min(out.baseMin, r.baseAt); out.baseMax = out.baseMax == null ? r.baseAt : Math.max(out.baseMax, r.baseAt); }
        });
      }
    }
  } catch (e) {
    out.errors.push({ vmName: '', reason: String(e?.message || e).slice(0, 300) });
    console.warn(`[bareos] 그룹 ‘${g.name}’ 보관 정리 중 오류: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    for (const id of locked) unlockJob(id);
    noteGroupRunEnd(groupId);
  }
  out.at = Date.now();
  recordPrune(groupId, out);
  if (out.deleted || out.failed || out.notDeleted || out.unknownDeleted) {
    logAudit({
      user: 'system', action: 'Bareos 그룹 보관 정리', target: `${g.vcenterId}/${g.name}`,
      detail: `최근 ${g.keep}회 보관 · 잡 ${out.jobs}개 · 카탈로그에서 지운 실행 ${out.deleted}건${deletedIds.length ? `(jobid ${deletedIds.slice(0, 60).join(',')}${deletedIds.length > 60 ? ' …' : ''})` : ''} · 실패 ${out.failed}${out.notDeleted ? ` · 지우지 못함 ${out.notDeleted}` : ''}${unknownIds.length ? ` · 보냈지만 결과 모름 ${out.unknownDeleted}건(jobid ${unknownIds.slice(0, 60).join(',')}${unknownIds.length > 60 ? ' …' : ''})` : ''}${out.unknownChunks ? ` · 결과 모름 묶음 ${out.unknownChunks}` : ''}`,
      ip: '',
    });
  }
  return out;
}

/** 정리를 그 Director 의 줄에 세운다(실행과 같은 줄 — 같은 Director 에 세션을 동시에 열지 않는다). */
export function queueGroupPrune(groupId, opts = {}) {
  const g = getGroup(groupId);
  if (!g) return Promise.reject(fail('not-found', '백업 그룹을 찾을 수 없습니다.'));
  if (groupRunning(groupId)) return Promise.reject(fail('busy', `‘${g.name}’ 그룹을 실행·정리하는 중입니다.`));
  _pruning.add(groupId);
  return onDirLine(g.directorId || '', () => pruneGroup(groupId, opts)).finally(() => { _pruning.delete(groupId); });
}

let _scanning = false;
const _clockWarned = new Set();
/**
 * 예약 틱 한 번 — 돌릴 회차를 **한 번의 쓰기로** 차지하고(놓친 회차도 한 번에) 실행을 띄운다.
 * 같은 Director 의 그룹은 **차례로**, 다른 Director 끼리는 동시에(v2.830 검토 L10 — 같은 분에 그룹 수십 개가 한 Director 에 세션을 동시에 열면
 * Director 의 콘솔 동시 접속 상한에 걸린다 — 상한 값은 실환경 미확인). 돌려주는 Promise 는 띄운 실행이 모두 끝난 뒤 끝난다(테스트가 기다린다 — 타이머는 기다리지 않는다).
 * @returns {Promise<{ scanned:boolean, fired:string[], missed:string[], done?: PromiseSettledResult[] }>}
 */
export async function groupTick(now = Date.now(), { catchupMs = CATCHUP_MS } = {}) {
  if (_scanning) return { scanned: false, fired: [], missed: [] };
  _scanning = true;
  let fired = []; let missed = []; const runs = [];
  try {
    if (groupsLoadError() || registryLoadError()) return { scanned: false, fired, missed };
    const due = []; const miss = []; const byId = new Map();
    for (const g of listGroups()) {
      const nowKey = slotKey(now, g.schedule);   // v2.901: 그 그룹의 기준 시계로
      // 버그 점검 S6: 처리한 회차가 지금보다 미래면(시계가 앞섰다 돌아옴) 그 열쇠까지 회차가 돌지 않는다 — 조용히 넘기지 않고 한 번 알린다
      if (g.lastKey && g.lastKey > nowKey && !_clockWarned.has(g.id)) { _clockWarned.add(g.id); console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 의 마지막 처리 회차(${g.lastKey})가 지금(${nowKey})보다 미래입니다 — 서버 시계를 확인하세요. 그 회차까지는 예약 실행이 돌지 않습니다.`); }
      const d = decideFire(g, now, catchupMs);
      if (d.action === 'miss') miss.push({ id: g.id, slot: d.slot, reason: d.reason || 'down' });
      else if (d.action === 'fire' && !groupRunning(g.id)) { due.push({ id: g.id, key: d.slot.key, trigger: 'timer' }); byId.set(g.id, { g, slot: d.slot }); }
    }
    missed = recordMisses(miss);
    for (const id of missed) {
      const m = miss.find((x) => x.id === id);
      if (m.reason === 'skipped') console.log(`[bareos] 백업 그룹 ${id} 의 ${m.slot.key} 회차를 건너뛰었습니다(회차 중단 때 고름).`);
      else console.warn(`[bareos] 백업 그룹 ${id} 의 ${m.slot.key} 회차를 놓쳤습니다(포탈이 꺼져 있었음 — 따라잡는 범위를 넘김).`);
    }
    fired = claimSlots(due, now);
    for (const id of fired) {
      const { g, slot } = byId.get(id);
      // Director 마다 하나의 줄(queueGroupRun — 틱을 넘어서도·수동 실행과도 차례를 지킨다 · 버그 점검 S8)
      runs.push(queueGroupRun(id, { trigger: 'timer', slot }).catch((e) => {
        const reason = String(e?.message || e).slice(0, 300);
        console.warn(`[bareos] 백업 그룹 ‘${g.name}’ ${slot.key} 회차 실행 실패: ${reason}`);
        recordFire(id, { key: slot.key, at: Date.now(), trigger: 'timer', by: '', level: slot.level, total: g.vmIds.length, started: 0, skipped: 0, notSent: g.vmIds.length, failed: 0, unknown: 0, error: reason, items: [] });
      }));
    }
    // v2.831 보관 개수 정리 — 실행이 끝난 그룹(이번 틱에 띄운 그룹은 빼고)
    const firedSet = new Set(fired);
    // v2.847 C2-4(2회차 점검 — 실측 28 vCenter × 약 7ms): 원장 요약은 **틱마다 한 번만**, 그것도 싼 조건(보관 개수 · 실행 기록 · 이미 정리함)을 지난 그룹이 있을 때만 만든다
    let jobsByVc = null;
    for (const g of listGroups()) {
      if (firedSet.has(g.id) || groupRunning(g.id) || g.keep == null) continue;
      if (!g.lastFire || !(g.lastFire.started > 0) || (g.lastPrune && g.lastPrune.fireAt === g.lastFire.at)) continue;   // pruneDue 의 앞 조건(싸다)
      if (!jobsByVc) {
        jobsByVc = new Map();
        for (const j of jobDigests()) { if (!jobsByVc.has(j.vcenterId)) jobsByVc.set(j.vcenterId, new Map()); jobsByVc.get(j.vcenterId).set(j.vmId, j); }
      }
      if (!jobsByVc.has(g.vcenterId)) jobsByVc.set(g.vcenterId, new Map());
      if (!pruneDue(g, jobsByVc.get(g.vcenterId), now)) continue;
      runs.push(queueGroupPrune(g.id, { trigger: 'timer' }).catch((e) => console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 보관 정리 실패: ${String(e?.message || e).slice(0, 200)}`)));
    }
  } finally { _scanning = false; }
  return { scanned: true, fired, missed, done: await Promise.allSettled(runs) };
}

let _timer = null;
/** 중앙에서만(엣지는 CENTRAL_URL 이 있다). 첫 틱은 기동 30초 뒤(기동 직후 이벤트 루프를 붙잡지 않게). */
export function startBareosGroupScheduler() {
  if (_timer || config.agent?.centralUrl) return;
  _timer = setInterval(() => { groupTick().catch((e) => console.warn(`[bareos] 백업 그룹 예약 틱 오류: ${String(e?.message || e).slice(0, 200)}`)); }, TICK_MS);
  _timer.unref?.();
}

export function _resetGroupRunnerForTest() { _groupBusy.clear(); _queued.clear(); _pruning.clear(); _dirTail.clear(); _runs.clear(); _cancelling.clear(); _scanning = false; if (_timer) { clearInterval(_timer); _timer = null; } }
