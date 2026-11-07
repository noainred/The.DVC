/**
 * bareos/lateReplies.js — 엣지 대행의 '결과 모름' 뒤 늦은 회신을 원장에 반영한다(v2.938 · 제안 6번).
 *
 * 왜: v2.824 는 가져간 상태 변경 작업이 시한 안에 회신하지 않으면 '결과 모름' 으로 닫고, 등록(addJobs)만 늦은 회신을 받아 원장에 넣었다(onLate).
 *   실행(runJob·runJobs)·복원(restores)은 늦은 회신을 버려(audits.md 'runJob·restore 늦은 회신 미반영' — v2.824 부터 남긴 것), Director 에서는 실제로
 *   돌고 있는 백업·복원이 포탈 원장에 없었다 — 결과·실패 알림·보관 정리가 그 실행을 몰랐고, 사람이 Director 에서 직접 확인해야 했다.
 *
 * 규칙:
 *  - 늦은 회신이 **시작(jobid · rid)** 을 알릴 때만 원장에 넣는다. 실패·모름 회신은 아무것도 바꾸지 않는다(이미 '결과 모름' 으로 기록돼 있다).
 *  - 실행: 그 대상에 이미 다른 실행(pending)이 있으면 덮지 않는다(늦게 온 옛 회신이 새 실행을 가리지 않게) — 로그만.
 *  - 복원: 같은 묶음(batchId)의 '결과 모름' 행만 열린 복원으로 바꾼다(registry.lateResolveRestore — 이미 jobid 가 있으면 하지 않는다).
 *  - 받는 시간은 edgeOps.LATE_KEEP_MS(15분)이고 중앙 메모리에만 있다 — 재시작하면 받을 곳이 없다(inflight.js 가 자동 업그레이드를 그동안 미룬다).
 *  - 중앙 직접 Director 는 늦은 회신이 없다(세션이 시한으로 끊긴다) — onLate 는 엣지 대행에서만 쓰인다.
 *  - (반증 B-1) 여러 건은 inBatch 로 묶어 원장을 **한 번만** 쓴다 — 항목마다 쓰면 3,000건 원장에서 50건에 411ms(실측, 묶으면 8ms).
 *  - (반증 B-4) trigger 는 원래 값을 두고 pending.late 표지를 단다(화면의 실행 방식 문구가 바뀌지 않게).
 *  - (반증 B-5) 보낸 뒤 대상이 다시 묶였거나(runsEpoch — 재설치 · Director 변경) 다른 Director 로 옮겨졌으면 옛 카탈로그의 번호라 반영하지 않는다.
 *  - (반증 B-6) 시작을 알린 회신을 반영하지 못하면 콘솔에 jobid 와 대상을 남긴다(Director 에서는 돌고 있을 수 있다).
 */
import { getJob, markPending, lateResolveRestore, inBatch } from './registry.js';
import { logAudit } from '../audit.js';

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const note = (action, target, detail) => { try { logAudit({ user: 'central-portal', action, target, detail, ip: '' }); } catch { /* 감사 기록 실패는 반영을 막지 않는다 */ } };
const warn = (msg) => console.warn(`[bareos] ${msg}`);
const errText = (e) => String(e?.message || e).slice(0, 160);
/** 보낸 시점의 대상 상태(Director) — onLate 를 만들 때(= 보낼 때) 잡는다. */
const dirOf = (jobId) => getJob(jobId)?.directorId || '';

/** 한 대상에 늦게 온 실행 jobid 를 반영 — 반영했으면 true. */
export function applyLateRun(jobId, jobid, { level = '', by = '', trigger = 'manual', sentAt = 0, directorId = '' } = {}) {
  const id = posInt(jobid);
  if (!id) return false;
  const j = getJob(jobId);
  if (!j) { warn(`늦은 실행 회신 jobid ${id} — 대상 ${jobId} 이 원장에 없어 반영하지 않았습니다(Director 에서 확인하세요)`); return false; }
  const who = j.vmName || jobId;
  // directorId 비교는 방어다 — 지금은 대상의 Director 를 바꾸는 경로가 없다(지우고 다시 만들면 대상 id 가 바뀐다)
  if ((sentAt && Number(j.runsEpoch) > sentAt) || (directorId && j.directorId && j.directorId !== directorId)) {
    warn(`늦은 실행 회신 jobid ${id} — 대상 ${who} 가 보낸 뒤 다시 묶였거나 Director 가 바뀌어 반영하지 않았습니다(옛 카탈로그 번호)`);
    return false;
  }
  if (j.pending?.jobid) {
    if (j.pending.jobid !== id) warn(`늦은 실행 회신 jobid ${id} — 대상 ${who} 에 이미 다른 실행(jobid ${j.pending.jobid})이 있어 반영하지 않았습니다`);
    return false;
  }
  if (j.lastRun?.jobid && j.lastRun.jobid >= id) return false;   // 이미 그 실행(또는 더 새 실행)의 결과가 있다
  markPending(jobId, { jobid: id, level, by: by || '예약', trigger, late: true });
  note('Bareos 백업 실행(늦은 회신)', `${j.vcenterId || ''}/${who}`, `jobid ${id} — 시한 뒤 엣지 회신으로 시작을 확인했습니다`);
  return true;
}

function safeRun(jobId, jobid, opts) {
  try { return applyLateRun(jobId, jobid, opts); } catch (e) { warn(`늦은 실행 회신 jobid ${jobid} — 대상 ${jobId} 원장 반영 실패: ${errText(e)}`); return false; }
}

/** 단건 실행(runJob)의 onLate — 보낼 때 만든다(sentAt · Director 를 그때 잡는다). */
export function lateRunJob(jobId, opts = {}) {
  const ctx = { ...opts, sentAt: Date.now(), directorId: dirOf(jobId) };
  return (lr) => { if (lr?.ok) safeRun(jobId, lr.value, ctx); };
}

/** 그룹 실행 덩어리(runJobs)의 onLate — keys[k] = 그 항목의 대상 id. */
export function lateRunJobs(keys, opts = {}) {
  const sentAt = Date.now();
  const dirs = keys.map(dirOf);
  return (lr) => {
    if (!lr?.ok || !Array.isArray(lr.value)) return;
    try {
      inBatch(() => {
        for (const r of lr.value) {
          const jobId = keys[r?.key];
          if (jobId && r.ok) safeRun(jobId, r.jobid, { ...opts, sentAt, directorId: dirs[r.key] });
        }
      });
    } catch (e) { warn(`늦은 그룹 실행 회신 원장 저장 실패: ${errText(e)}`); }
  };
}

function resolveOne(k, r, sentAt) {
  try {
    const done = lateResolveRestore(k.jobId, k.batchId, { rid: r.rid, chain: r.chain }, Date.now(), { sentAt });
    if (done) note('Bareos 복원 실행(늦은 회신)', `${done.vcenterId || ''}/${done.vmName || k.jobId}`, `복원 jobid ${r.rid} — 시한 뒤 엣지 회신으로 시작을 확인했습니다`);
    else warn(`늦은 복원 회신 jobid ${r.rid} — 대상 ${k.jobId} 의 '결과 모름' 행을 찾지 못해(지워짐 · 다시 묶임 · 이미 반영) 반영하지 않았습니다(Director 에서 확인하세요)`);
  } catch (e) { warn(`늦은 복원 회신 jobid ${r.rid} — 대상 ${k.jobId} 원장 반영 실패: ${errText(e)}`); }
}

/** 묶음 복원(restores)의 onLate — keys[k] = { jobId, batchId }. */
export function lateRestores(keys) {
  const sentAt = Date.now();
  return (lr) => {
    if (!lr?.ok || !Array.isArray(lr.value)) return;
    try {
      inBatch(() => {
        for (const r of lr.value) {
          const k = keys[r?.key];
          if (k && r.ok && posInt(r.rid)) resolveOne(k, r, sentAt);
        }
      });
    } catch (e) { warn(`늦은 복원 회신 원장 저장 실패: ${errText(e)}`); }
  };
}

/** 단건 복원(restore)의 onLate — 회신 값은 { rid, chain }. key 는 결과 모름 행의 lateKey(묶음 화면에 끼지 않게 batchId 를 쓰지 않는다). */
export function lateRestoreOne(jobId, key) {
  const sentAt = Date.now();
  return (lr) => {
    if (!lr?.ok || !posInt(lr.value?.rid)) return;
    resolveOne({ jobId, batchId: key }, lr.value, sentAt);
  };
}
