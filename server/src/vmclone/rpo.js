/**
 * vmclone/rpo.js — 백업이 '기대 주기 안에 성공하고 있는가'(RPO 초과) 판정(순수, v2.795).
 *
 * 사용자 요구(2026-10-26): "백업 실행 경로" 개선. 실패는 실패 메일이 알리지만, **아예 돌지 않는** 경우(엣지 중단·스케줄러 정지·
 * 매번 '건너뜀'·담당 미확정)는 실패 줄이 생기지 않아 조용했다. 마지막 성공이 기대 주기의 2배 + 1시간을 넘으면 'RPO 초과' 다.
 *  · 기대 주기: 매일 = 24시간, 간격 = N시간. 수동만·꺼진 잡·멈춘 위임 잡은 판정하지 않는다(null).
 *  · 마지막 성공: 이력의 백업 성공 줄(건너뜀 제외)과 lastRun(성공이면) 중 가장 늦은 것. 성공이 한 번도 없으면 잡을 만든 시각부터 센다.
 *    둘 다 모르면 판정하지 않는다(지어내지 않는다).
 * 화면(GET /tools/vm-clone 의 jobs[].rpo)과 실패 메일(vmclone/notify.js)이 이 함수 하나를 쓴다.
 */

export const RPO_FACTOR = 2;
export const RPO_GRACE_MS = 60 * 60_000;
const HOUR = 3_600_000;

/** 기대 주기(ms) — 수동·무효면 null. */
export function expectedIntervalMs(schedule) {
  if (schedule?.mode === 'daily') return 24 * HOUR;
  if (schedule?.mode === 'interval') { const h = Number(schedule.hours); return Number.isFinite(h) && h > 0 ? h * HOUR : null; }
  return null;
}

/** 마지막 성공 시각(ms) — 없으면 null. */
export function lastSuccessAt(job) {
  let best = null;
  const take = (r) => { const at = Number(r?.at); if (r && r.ok === true && !r.skipped && (r.kind || 'backup') === 'backup' && Number.isFinite(at) && at > 0 && (best == null || at > best)) best = at; };
  for (const h of Array.isArray(job?.history) ? job.history : []) take(h);
  take(job?.lastRun);
  return best;
}

/**
 * @returns {null | {overdue:boolean, limitMs:number, intervalMs:number, lastOkAt:number|null, sinceAt:number}}
 */
export function rpoOf(job, now = Date.now()) {
  if (!job || job.enabled === false || job.suspended) return null;
  const intervalMs = expectedIntervalMs(job.schedule);
  if (!intervalMs) return null;
  const lastOkAt = lastSuccessAt(job);
  const created = Number(job.createdAt);
  const sinceAt = lastOkAt ?? (Number.isFinite(created) && created > 0 ? created : null);
  if (sinceAt == null) return null;
  const limitMs = intervalMs * RPO_FACTOR + RPO_GRACE_MS;
  return { overdue: now - sinceAt > limitMs, limitMs, intervalMs, lastOkAt, sinceAt };
}
