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
import { listGroups, getGroup, claimSlots, recordMisses, recordFire, recordPrune, markSending, groupsLoadError } from './groups.js';
import { PRUNE_WAIT_MAX_MS } from './groupRetention.js';
import { decideFire, CATCHUP_MS, slotKey } from './groupSchedule.js';
import { jobDigests, markPending, patchJob, registryLoadError, inBatch } from './registry.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { jobDirectorId } from './settings.js';
import { RUN_JOBS_MAX } from './ops.js';
import { PICKUP_MS, RESULT_MS } from './edgeOps.js';
import { normLevel } from './names.js';
import { tryLockJob, unlockJob } from './jobLocks.js';
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
const MID_COMMAND_CODES = new Set(['timeout', 'closed', 'aborted', 'protocol', 'too-large']);

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
const _queued = new Map();   // 그룹 id → { since, dir } — Director 차례를 기다리는 중(v2.830 버그 점검 S4: 대기 중이 '재시작' 으로 보였다)
const _pruning = new Set();  // v2.831 보관 개수 정리 중(대기 포함) — 실행과 같은 줄에 서고, 그동안 그 그룹의 실행·삭제는 409
/** 실행·정리 중이거나 차례를 기다리는 중 — 화면 '실행 중' · 삭제 409 · 같은 그룹 다시 실행 409 가 같은 판정을 쓴다. */
export const groupRunning = (id) => _groupBusy.has(id) || _queued.has(id) || _pruning.has(id);
export const groupPruning = (id) => _pruning.has(id);
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
  _queued.set(groupId, { since: Date.now(), dir });
  noteGroupRunStart(groupId, g.name);   // 줄을 선 순간부터 업그레이드 자동 적용이 기다린다
  return onDirLine(dir, () => { _queued.delete(groupId); return runGroup(groupId, opts); }).finally(() => { _queued.delete(groupId); noteGroupRunEnd(groupId); });
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

/** 옛 엣지가 runJobs 를 모르면 '알 수 없는 작업' 으로 거절한다 — 사람이 할 일을 덧붙인다. */
function reasonOf(e) {
  const msg = String(e?.message || e).slice(0, 300);
  return /알 수 없는 작업/.test(msg) ? `${msg} — 법인 엣지가 이 기능(그룹 일괄 실행)보다 오래된 판일 수 있습니다. 엣지를 업그레이드한 뒤 다시 실행하세요.` : msg;
}

/**
 * 그룹 하나 실행.
 * @param {string} groupId
 * @param {{ trigger?: 'manual'|'timer', by?: string, level?: string|null, slot?: {key,at,level}|null, signal?: AbortSignal|null }} o
 * @returns {Promise<object>} 실행 기록(groups.lastFire 와 같은 모양)
 */
export async function runGroup(groupId, { trigger = 'manual', by = '', level = null, slot = null, signal = null } = {}) {
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
  try {
    const demo = isDemoActive();
    const settings = effectiveSettings();
    const vmName = new Map((store.get()?.vms || []).filter((v) => v.vcenterId === g.vcenterId).map((v) => [v.id, String(v.name || '')]));
    const jobs = new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j]));
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
    for (const [dir, list] of byDir) {
      for (let i = 0; i < list.length; i += RUN_JOBS_MAX) {
        const chunk = list.slice(i, i + RUN_JOBS_MAX);
        let res;
        try {
          const sig = signal || AbortSignal.timeout(RUN_DEADLINE_MS);
          res = await onDirector(dir, 'runJobs', {
            items: chunk.map((s, k) => ({ key: k, job: s.job.bareosJob, level: lvl, ...(g.storage ? { storage: g.storage } : {}), ...(g.pool ? { pool: g.pool } : {}) })),
          }, { trigger: trigger === 'timer' ? 'timer' : 'manual', signal: sig });
        } catch (e) {
          // Director 호출이 통째로 실패 — 잡마다 lastError 를 덮지 않는다(잡이 아니라 Director·전달의 문제다 · v2.830 검토 L3)
          const st = chunkErrorState(e);
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
      }
    }
  } catch (e) {
    // 예상하지 못한 오류 — 여기까지 보낸 것은 그대로 두고 실행 기록은 남긴다(보내는 중 표지만 남아 '재시작' 으로 보이지 않게 — S3)
    unexpected = String(e?.message || e).slice(0, 300);
    console.warn(`[bareos] 그룹 ‘${g.name}’ 실행 중 오류: ${unexpected}`);
  } finally {
    for (const id of locked) unlockJob(id);
    _groupBusy.delete(groupId);
    noteGroupRunEnd(groupId);
  }
  const count = (st) => items.filter((x) => x.state === st).length;
  const fire = {
    key: slot?.key || '', at: Date.now(), trigger, by: String(by || ''), level: lvl, storage: g.storage || '', pool: g.pool || '',
    total: items.length, started: count('started'), skipped: count('skipped'), notSent: count('notsent'), failed: count('failed'), unknown: count('unknown'), items,
    ...(ledgerError || unexpected ? { error: [unexpected, ledgerError].filter(Boolean).join(' · ') } : {}),
  };
  recordFire(groupId, fire);
  logAudit({
    user: by || 'system', action: trigger === 'timer' ? 'Bareos 그룹 예약 실행' : 'Bareos 그룹 실행', target: `${g.vcenterId}/${g.name}`,
    detail: `${slot?.key ? `회차 ${slot.key} · ` : ''}${lvl}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''} · 시작 ${fire.started} · 건너뜀 ${fire.skipped} · 보내지 못함 ${fire.notSent} · 실패 ${fire.failed} · 결과 모름 ${fire.unknown} / ${fire.total}`,
    ip: '',
  });
  return fire;
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
  // 반증 F5: 그 실행으로 이미 정리했으면 다시 하지 않는다 — 보관 개수를 바꾸기만 해서는 돌지 않는다(다음 그룹 실행이 끝난 뒤 · 화면 안내와 같게)
  if (g.lastPrune && g.lastPrune.fireAt === g.lastFire.at) return false;
  if (now - g.lastFire.at >= PRUNE_WAIT_MAX_MS) return true;
  return !g.vmIds.some((id) => jobsByVm.get(id)?.pending?.jobid);
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
          res = await onDirector(dir, 'pruneJobs', { items: chunk.map((x, k) => ({ key: k, job: x.job.bareosJob, keep: g.keep })) },
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
    const nowKey = slotKey(now);
    for (const g of listGroups()) {
      // 버그 점검 S6: 처리한 회차가 지금보다 미래면(시계가 앞섰다 돌아옴) 그 열쇠까지 회차가 돌지 않는다 — 조용히 넘기지 않고 한 번 알린다
      if (g.lastKey && g.lastKey > nowKey && !_clockWarned.has(g.id)) { _clockWarned.add(g.id); console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 의 마지막 처리 회차(${g.lastKey})가 지금(${nowKey})보다 미래입니다 — 서버 시계를 확인하세요. 그 회차까지는 예약 실행이 돌지 않습니다.`); }
      const d = decideFire(g, now, catchupMs);
      if (d.action === 'miss') miss.push({ id: g.id, slot: d.slot, reason: 'down' });
      else if (d.action === 'fire' && !groupRunning(g.id)) { due.push({ id: g.id, key: d.slot.key, trigger: 'timer' }); byId.set(g.id, { g, slot: d.slot }); }
    }
    missed = recordMisses(miss);
    for (const id of missed) { const m = miss.find((x) => x.id === id); console.warn(`[bareos] 백업 그룹 ${id} 의 ${m.slot.key} 회차를 놓쳤습니다(포탈이 꺼져 있었음 — 따라잡는 범위를 넘김).`); }
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
    const jobsByVc = new Map();
    for (const g of listGroups()) {
      if (firedSet.has(g.id) || groupRunning(g.id) || g.keep == null) continue;
      if (!jobsByVc.has(g.vcenterId)) jobsByVc.set(g.vcenterId, new Map(jobDigests().filter((j) => j.vcenterId === g.vcenterId).map((j) => [j.vmId, j])));
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

export function _resetGroupRunnerForTest() { _groupBusy.clear(); _queued.clear(); _pruning.clear(); _dirTail.clear(); _scanning = false; if (_timer) { clearInterval(_timer); _timer = null; } }
