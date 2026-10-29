/**
 * veeam/run/parse.js — 백업 실행 작업 결과의 **정제**(v2.818). 중앙 직접 실행·엣지 회신 둘 다 마지막에 이것을 지난다
 * (CLAUDE.md '엣지가 보낸 것은 정제한다' — 아는 필드만·상한·문자열 수치는 수로). 못 읽은 수치는 null(numOrNull).
 * Veeam 원문 → 표준 모양(sessionFrom·taskFrom)도 여기 둔다 — 필드 이름 일부는 추정이라 후보 이름을 차례로 본다(docs/VEEAM-BACKUP-RUN.md).
 */
import { numOrNull } from '../../util/numOrNull.js';

const str = (v, n = 256) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v).slice(0, n) : ''); // eslint-disable-line no-control-regex
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export function timeOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 946_684_800_000 ? v : null;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 946_684_800_000 ? t : null;   // 0001-01-01 같은 '없음' 표기는 null
}
const pct = (v) => { const n = numOrNull(v); return n == null ? null : Math.max(0, Math.min(100, Math.round(n))); };
const common = (r) => ({ ok: r.ok === true, reason: str(r.reason, 1000), authFailed: r.authFailed === true, notes: arr(r.notes).slice(0, 20).map((n) => str(n, 400)).filter(Boolean) });

/**
 * 백업 시작(Quick Backup · 포탈 전용 잡). unknown = 요청이 Veeam 에 닿았는지·시작됐는지 모른다(전송 오류·시한·5xx·엣지 미회신) —
 * 실패가 아니다(다시 보내면 이중 실행이 될 수 있다). notSent = 확실히 보내지 않았다(시한 지난 작업을 엣지가 건너뜀 등).
 */
export function sanitizeStart(s) {
  const r = obj(s);
  return {
    ...common(r),
    unknown: r.unknown === true, notSent: r.notSent === true,
    // 세션 id 가 없어도 VM 이 실린 원소는 남긴다(받았지만 id 를 모름 = 확인 불가). 둘 다 비면 버린다(엣지가 보낸 잡음).
    sessions: arr(r.sessions).slice(0, 200).map((x) => ({ id: str(obj(x).id, 64), objectIds: arr(obj(x).objectIds).slice(0, 200).map((v) => str(v, 128)).filter(Boolean), ...(obj(x).unknown === true ? { unknown: true } : {}) })).filter((x) => x.id || x.objectIds.length),
    jobId: str(r.jobId, 64), jobName: str(r.jobName, 128), variant: str(r.variant, 120), created: r.created === true, added: numOrNull(r.added),
  };
}

/** 용량(바이트) — 음수·숫자 아님은 null(엣지 회신도 지난다 — 0 을 만들지 않는다). */
const bytesNum = (v) => { const n = numOrNull(v); return n != null && n >= 0 ? Math.round(n) : null; };
const bytesOf = (o) => ({ processedBytes: bytesNum(o.processedBytes), readBytes: bytesNum(o.readBytes), transferredBytes: bytesNum(o.transferredBytes) });

function sanitizeOneSession(s) {
  const r = obj(s);
  return {
    id: str(r.id, 64), ok: r.ok === true, reason: str(r.reason, 500),
    state: str(r.state, 40), result: str(r.result, 40), message: str(r.message, 1000), progress: pct(r.progress), startedAt: timeOf(r.startedAt), endedAt: timeOf(r.endedAt), finished: r.finished === true,
    ...bytesOf(r),
    tasks: arr(r.tasks).slice(0, 500).map((t0) => {
      const t = obj(t0);
      return { name: str(t.name, 256), objectId: str(t.objectId, 128), state: str(t.state, 40), result: str(t.result, 40), message: str(t.message, 1000), progress: pct(t.progress),
        startedAt: timeOf(t.startedAt), endedAt: timeOf(t.endedAt), ...bytesOf(t) };
    }),
    tasksKnown: r.tasksKnown === true, tasksError: str(r.tasksError, 300),
  };
}
/** 세션 여러 개(한 로그인으로 읽은 묶음). */
export function sanitizeSessions(s) {
  const r = obj(s);
  return { ...common(r), sessions: arr(r.sessions).slice(0, 200).map(sanitizeOneSession).filter((x) => x.id) };
}

/** 저장소 목록(포탈 전용 잡 저장소 고르기). 용량 필드는 추정 — 없으면 null. */
export function sanitizeRepos(s) {
  const r = obj(s);
  return { ...common(r), repositories: arr(r.repositories).slice(0, 256).map((p) => ({ id: str(obj(p).id, 64), name: str(obj(p).name, 128), freeGB: numOrNull(obj(p).freeGB), capacityGB: numOrNull(obj(p).capacityGB) })).filter((p) => p.id) };
}

/** 복원 지점 목록(vmPoints — v2.819). VM 은 이름으로 찾았다(응답에 moref 가 있는지 미확인) — 화면이 그 사실을 말한다. */
export function sanitizePoints(s) {
  const r = obj(s);
  const j = obj(r.job);
  return {
    ...common(r), notSent: r.notSent === true, variant: str(r.variant, 60),
    points: arr(r.points).slice(0, 200).map((p0) => {
      const p = obj(p0);
      return { id: str(p.id, 64), name: str(p.name, 256), at: timeOf(p.creationTime ?? p.at), backupId: str(p.backupId, 64), backupName: str(p.backupName, 256),
        jobId: str(p.jobId, 64), jobName: str(p.jobName, 256), portal: p.portal === true, type: str(p.type, 40), platformName: str(p.platformName, 40),
        binding: p.binding === 'verified' || p.binding === 'portalJob' ? p.binding : '' };
    }).filter((p) => p.id && p.binding),   // 이 VM 으로 묶이지 않은 지점은 엣지가 보냈어도 버린다(반증 F1)
    hidden: numOrNull(r.hidden), truncated: r.truncated === true,
    job: r.job && typeof r.job === 'object' ? { id: str(j.id, 64), name: str(j.name, 128), found: j.found === true, marker: j.marker === true, included: j.included === true } : null,
  };
}
/** 잡에서 빼기·백업 삭제(v2.819). */
export function sanitizeManage(s) {
  const r = obj(s);
  return { ...common(r), unknown: r.unknown === true, notSent: r.notSent === true, variant: str(r.variant, 60),
    removed: numOrNull(r.removed), excluded: r.excluded === true, deleted: numOrNull(r.deleted) };
}
export const SANITIZERS = Object.freeze({ quickBackup: sanitizeStart, portalJob: sanitizeStart, sessions: sanitizeSessions, repos: sanitizeRepos,
  vmPoints: sanitizePoints, restoreVm: sanitizeStart, jobExclude: sanitizeManage, deleteBackup: sanitizeManage });

/* ── Veeam 원문 → 표준 모양(필드 일부 추정) ─────────────────────────────── */

/** 잡 includes 원소 → { type, hostName, name, objectId } — 리비전에 따라 `inventoryObject` 래퍼가 있거나 없다(둘 다 읽는다). */
export function inventoryObjectOf(x) {
  const o0 = obj(x);
  const o = obj(o0.inventoryObject && typeof o0.inventoryObject === 'object' ? o0.inventoryObject : o0);
  return { type: str(o.type, 40), hostName: str(o.hostName, 254), name: str(o.name, 256), objectId: str(o.objectId, 128) };
}

export function taskFrom(t) {
  const o = obj(t);
  const res = obj(o.result);
  return {
    name: str(o.name ?? o.objectName, 256), objectId: str(o.objectId, 128), state: str(o.state, 40),
    result: str(res.result ?? (typeof o.result === 'string' ? o.result : ''), 40), message: str(res.message ?? o.message, 1000),
    progress: pct(obj(o.progress).progressPercent ?? o.progressPercent),
    // v2.822.1 진행 상세 — 필드 이름은 모니터링 모듈(veeam/parse.js lastTasks)과 같은 **추정** 후보(실서버 미확인). 없으면 null.
    startedAt: timeOf(o.creationTime ?? o.startTime), endedAt: timeOf(o.endTime), ...rawBytes(o),
  };
}
/** Veeam 진행 용량(progress.processedSize·readSize·transferredSize — 추정 이름). */
function rawBytes(o) {
  const pr = obj(o.progress);
  return { processedBytes: numOrNull(pr.processedSize ?? o.processedSize), readBytes: numOrNull(pr.readSize ?? o.readSize), transferredBytes: numOrNull(pr.transferredSize ?? pr.transferedSize ?? o.transferredSize) };
}
/** 세션 원문(SessionModel 추정) → 표준. 끝남 = state 가 Stopped 류이거나 종료 시각이 있다. */
export function sessionFrom(s, tasks = null) {
  const o = obj(s);
  const res = obj(o.result);
  const state = str(o.state, 40);
  const endedAt = timeOf(o.endTime ?? o.endedAt);
  return {
    id: str(o.id, 64), ok: true, state, result: str(res.result ?? (typeof o.result === 'string' ? o.result : ''), 40),
    message: str(res.message ?? o.message, 1000), progress: pct(o.progressPercent ?? obj(o.progress).progressPercent), startedAt: timeOf(o.creationTime ?? o.startTime), endedAt, ...rawBytes(o),
    finished: /^(stopped|finished|completed)$/i.test(state) || endedAt != null,
    tasks: Array.isArray(tasks) ? tasks.map(taskFrom) : [], tasksKnown: Array.isArray(tasks),
  };
}
