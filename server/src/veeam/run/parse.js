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

function sanitizeOneSession(s) {
  const r = obj(s);
  return {
    id: str(r.id, 64), ok: r.ok === true, reason: str(r.reason, 500),
    state: str(r.state, 40), result: str(r.result, 40), message: str(r.message, 1000), progress: pct(r.progress), endedAt: timeOf(r.endedAt), finished: r.finished === true,
    tasks: arr(r.tasks).slice(0, 500).map((t0) => {
      const t = obj(t0);
      return { name: str(t.name, 256), objectId: str(t.objectId, 128), state: str(t.state, 40), result: str(t.result, 40), message: str(t.message, 1000), progress: pct(t.progress) };
    }),
    tasksKnown: r.tasksKnown === true,
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

export const SANITIZERS = Object.freeze({ quickBackup: sanitizeStart, portalJob: sanitizeStart, sessions: sanitizeSessions, repos: sanitizeRepos });

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
  };
}
/** 세션 원문(SessionModel 추정) → 표준. 끝남 = state 가 Stopped 류이거나 종료 시각이 있다. */
export function sessionFrom(s, tasks = null) {
  const o = obj(s);
  const res = obj(o.result);
  const state = str(o.state, 40);
  const endedAt = timeOf(o.endTime ?? o.endedAt);
  return {
    id: str(o.id, 64), ok: true, state, result: str(res.result ?? (typeof o.result === 'string' ? o.result : ''), 40),
    message: str(res.message ?? o.message, 1000), progress: pct(o.progressPercent ?? obj(o.progress).progressPercent), endedAt,
    finished: /^(stopped|finished|completed)$/i.test(state) || endedAt != null,
    tasks: Array.isArray(tasks) ? tasks.map(taskFrom) : [], tasksKnown: Array.isArray(tasks),
  };
}
