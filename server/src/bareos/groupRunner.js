/**
 * bareos/groupRunner.js — 백업 그룹 실행(수동 '지금 실행' · 예약 회차)과 예약 틱(v2.830 · 사용자 결정 '포탈이 실행').
 *
 * 한 그룹 실행 = 그룹 VM 들의 원장 잡을 그 잡의 Director 에 `runJobs`(세션 하나 · RUN_JOBS_MAX 씩)로 보낸다 → 성공한 잡은 pending(폴러가 결과를 반영).
 *   · 대상별 잠금(jobLocks)을 잡은 잡만 보낸다(같은 대상의 삭제·실행·복원과 겹치지 않게) — 잡힌 대상은 '건너뜀'(줄 세우지 않는다).
 *   · 이미 실행 중(pending)·비활성·Director 에 없음·데모/실제 섞임·잡 없음은 보내지 않고 사유를 남긴다(0 으로 섞지 않고 따로 센다).
 *   · 엣지 대행의 '결과 모름' 은 실패로 단정하지 않는다(unknown — 실행됐을 수 있다. pending 을 적지 않는다: jobid 를 모른다).
 * 예약 틱:
 *   · 30초마다 원장을 훑어 decideFire — 회차를 **보내기 전에** claimSlot 으로 파일에 남긴다(한 번 이하: 보낸 뒤 죽어도 같은 회차를 다시 보내지 않는다).
 *   · 훑기만 재진입 가드(동기 — 짧다). 실행은 그룹마다 비동기로 띄우고, 같은 그룹이 아직 돌면 그 회차를 차지하지 않는다(다음 틱에 다시 본다).
 *   · 원장(대상·그룹)을 못 읽으면 아무것도 보내지 않는다. 주기 실행은 trigger 'timer' — 인증 정지된 Director 에는 보내지 않는다(service.sessionOn·relayToEdge).
 *   · 엣지 노드는 돌리지 않는다(그룹 원장은 중앙에 있다 — 엣지는 대행 큐로 받는다).
 */
import { listGroups, getGroup, claimSlot, recordMiss, recordFire, groupsLoadError } from './groups.js';
import { decideFire, CATCHUP_MS } from './groupSchedule.js';
import { jobDigests, markPending, patchJob, registryLoadError } from './registry.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { jobDirectorId } from './settings.js';
import { RUN_JOBS_MAX } from './ops.js';
import { normLevel } from './names.js';
import { tryLockJob, unlockJob } from './jobLocks.js';
import { noteGroupRunStart, noteGroupRunEnd } from './inflight.js';
import { logAudit } from '../audit.js';
import { store } from '../store.js';
import { config } from '../config.js';

export const TICK_MS = 30_000;
/** 그룹 한 번 실행의 Director 호출 시한(덩어리마다) — 엣지 대행 회신 시한(edgeOps RESULT_MS.runJobs 330초)보다 길게(중앙이 먼저 끊지 않게). */
export const RUN_DEADLINE_MS = 6 * 60_000;

const fail = (code, msg) => Object.assign(new Error(msg), { code });
const _groupBusy = new Set();
export const groupRunning = (id) => _groupBusy.has(id);

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
  noteGroupRunStart(groupId, g.name);   // 업그레이드 자동 적용이 이 실행이 끝나기를 기다린다(inflight.js)
  const locked = [];
  const items = [];
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
          const unknown = e?.code === 'unknown';
          for (const s of chunk) {
            s.it.state = unknown ? 'unknown' : 'failed';
            s.it.reason = unknown ? `결과 모름 — ${reasonOf(e)} Director 에서 실행 여부를 확인하세요.` : reasonOf(e);
            if (!unknown) patchJob(s.job.id, { lastError: { at: Date.now(), message: `그룹 ‘${g.name}’ 실행 실패 — ${String(e?.message || e).slice(0, 240)}` } });
          }
          continue;
        }
        const byKey = new Map((Array.isArray(res) ? res : []).map((r) => [r.key, r]));
        chunk.forEach((s, k) => {
          const r = byKey.get(k);
          if (r?.ok && Number.isInteger(r.jobid) && r.jobid > 0) {
            markPending(s.job.id, { jobid: r.jobid, level: lvl, by: by || '예약', trigger: trigger === 'timer' ? 'group-schedule' : 'group' });
            Object.assign(s.it, { state: 'started', jobid: r.jobid });
          } else if (r?.code === 'unknown') {
            Object.assign(s.it, { state: 'unknown', reason: r.message || '결과 모름 — Director 에서 확인하세요.' });
          } else if (r?.code === 'skipped') {
            Object.assign(s.it, { state: 'skipped', reason: r.message || '건너뜀' });
          } else {
            const why = r?.message || (r ? '사유 미상' : 'Director 회신에 이 항목이 없습니다 — 실행됐는지 알 수 없습니다.');
            Object.assign(s.it, { state: r ? 'failed' : 'unknown', reason: why });
            if (r) patchJob(s.job.id, { lastError: { at: Date.now(), message: `그룹 ‘${g.name}’ 실행 실패 — ${why.slice(0, 240)}` } });
          }
        });
      }
    }
  } finally {
    for (const id of locked) unlockJob(id);
    _groupBusy.delete(groupId);
    noteGroupRunEnd(groupId);
  }
  const count = (st) => items.filter((x) => x.state === st).length;
  const fire = {
    key: slot?.key || '', at: Date.now(), trigger, by: String(by || ''), level: lvl, storage: g.storage || '', pool: g.pool || '',
    total: items.length, started: count('started'), skipped: count('skipped'), failed: count('failed'), unknown: count('unknown'), items,
  };
  recordFire(groupId, fire);
  logAudit({
    user: by || 'system', action: trigger === 'timer' ? 'Bareos 그룹 예약 실행' : 'Bareos 그룹 실행', target: `${g.vcenterId}/${g.name}`,
    detail: `${slot?.key ? `회차 ${slot.key} · ` : ''}${lvl}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''} · 시작 ${fire.started} · 건너뜀 ${fire.skipped} · 실패 ${fire.failed} · 결과 모름 ${fire.unknown} / ${fire.total}`,
    ip: '',
  });
  return fire;
}

let _scanning = false;
/**
 * 예약 틱 한 번 — 돌릴 회차를 차지하고 실행을 띄운다. 돌려주는 Promise 는 띄운 실행이 모두 끝난 뒤 끝난다(테스트가 기다린다 — 타이머는 기다리지 않는다).
 * @returns {Promise<{ scanned:boolean, fired:string[], missed:string[], done?: PromiseSettledResult[] }>}
 */
export async function groupTick(now = Date.now(), { catchupMs = CATCHUP_MS } = {}) {
  if (_scanning) return { scanned: false, fired: [], missed: [] };
  _scanning = true;
  const fired = []; const missed = []; const runs = [];
  try {
    if (groupsLoadError() || registryLoadError()) return { scanned: false, fired, missed };
    for (const g of listGroups()) {
      const d = decideFire(g, now, catchupMs);
      if (d.action === 'miss') {
        if (recordMiss(g.id, d.slot)) { missed.push(g.id); console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 의 ${d.slot.key} 회차를 놓쳤습니다(포탈이 꺼져 있었음 — 따라잡는 범위를 넘김).`); }
        continue;
      }
      if (d.action !== 'fire' || _groupBusy.has(g.id)) continue;
      if (!claimSlot(g.id, d.slot.key)) continue;
      fired.push(g.id);
      runs.push(runGroup(g.id, { trigger: 'timer', slot: d.slot }).catch((e) => {
        const reason = String(e?.message || e).slice(0, 300);
        console.warn(`[bareos] 백업 그룹 ‘${g.name}’ ${d.slot.key} 회차 실행 실패: ${reason}`);
        recordFire(g.id, { key: d.slot.key, at: Date.now(), trigger: 'timer', by: '', level: d.slot.level, total: g.vmIds.length, started: 0, skipped: 0, failed: g.vmIds.length, unknown: 0, error: reason, items: [] });
      }));
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

export function _resetGroupRunnerForTest() { _groupBusy.clear(); _scanning = false; if (_timer) { clearInterval(_timer); _timer = null; } }
