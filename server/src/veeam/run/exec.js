/**
 * veeam/run/exec.js — VBR 에 보내는 **상태 변경 작업**(v2.818). 중앙 직접 실행과 엣지 대행(agent/veeamRunWorker.js)이 같은 함수를 쓴다.
 *
 *   quickBackup  기존 잡 설정으로 지정 VM 만 증분 백업(전체 복원 지점이 있는 VM 만 된다 — Veeam 사용자 가이드)
 *   portalJob    포탈 전용 잡(PORTAL-<vCenter>)을 만들거나 VM 을 넣고 시작 — 포탈은 **표지가 있는 자기 잡만** 고친다
 *   sessions     세션 여러 개의 상태 + VM 별 작업(task) — 한 번 로그인으로 묶어 읽는다(세션마다 로그인하지 않는다)
 *   repos        저장소 목록(포탈 전용 잡 저장소 고르기 — 읽기)
 *   (v2.819 백업 관리 — 복원 지점·새 VM 복원·잡에서 빼기·백업 삭제 — 는 run/manage.js · 작업 표는 run/ops.js)
 *
 * ⚠⚠ 정직 기록 — 실제 VBR 로 확인하지 못했다. Quick Backup 경로·본문, 세션·작업 세션 응답 필드는 추정이라 **후보 체인**이다.
 *   다음 후보로 넘어가는 것은 서버가 '이 모양을 모른다'(400·404·405·415·422) 고 답했을 때뿐이다. 어떤 후보를 썼는지 variant 로 남긴다.
 *
 * 결과 원칙(반증 검토 F2 — 되돌리지 말 것):
 *  · 상태를 바꾸는 요청(Quick Backup POST · 잡 생성 · 잡 시작)이 **전송 오류·시한·408·5xx** 면 '실패' 가 아니라 **결과 모름(unknown)** 이다 —
 *    Veeam 이 받아 시작했을 수 있다. 실패로 적으면 사람이 다시 눌러 같은 백업이 두 번 돈다. 다음 후보로도 넘어가지 않는다.
 *  · Veeam 이 분명히 거절한 것(401·403·409·429 등)은 실패(시작 안 됨).
 *  · 시한(deadlineAt)이 지났으면 상태 변경 요청을 **보내지 않는다**(notSent) — 중앙이 이미 '모름' 으로 닫은 뒤 늦게 시작하지 않게(F3).
 *  · 던지지 않는다 — 결과 객체로 돌려주고, 결과는 항상 parse.js 의 sanitize 를 지난다. 비밀번호·토큰은 사유에 싣지 않는다(client 가 가린다).
 */
import { makeRunClient, RunHttpError } from './client.js';
import * as P from './parse.js';

/** 포탈이 만든 잡의 표지 — 잡 설명(description)에 넣는다. 이름 접두 + 이 표지가 **둘 다** 있어야 포탈이 고친다. */
export const PORTAL_MARKER = '[vmware-portal:managed]';
export const QUICK_PATH = '/api/v1/jobs/quickBackup/vSphere';
const SHAPE_MISS = new Set([400, 404, 405, 415, 422]);
const statusOf = (e) => (e instanceof RunHttpError ? e.status : (e?.authFailed ? 401 : -1));
export const shapeMiss = (e) => SHAPE_MISS.has(statusOf(e));
/** 상태 변경 요청의 결과를 모르는가 — 전송 오류(0)·시한·408·5xx. */
export const outcomeUnknown = (e) => { const s = statusOf(e); return s === 0 || s === 408 || (s >= 500 && s <= 599); };
export const reasonOf = (e) => String(e?.message || e).slice(0, 1000);
export const vmRef = (v) => ({ type: 'VirtualMachine', hostName: String(v?.hostName || ''), name: String(v?.name || ''), objectId: String(v?.objectId || '') });
export const MAX_JOBS = 2000;

/** 세션 id — 시작 응답(SessionModel 추정)에서. 모양을 모르면 ''. */
export function sessionIdOf(json) {
  const j = Array.isArray(json) ? json[0] : json;
  if (!j || typeof j !== 'object') return '';
  if (typeof j.sessionId === 'string') return j.sessionId.slice(0, 64);
  if (typeof j.id === 'string' && (j.state !== undefined || j.sessionType !== undefined || j.creationTime !== undefined || j.jobId !== undefined)) return j.id.slice(0, 64);
  return '';
}

export async function withSession(server, { signal, fetchImpl }, fn) {
  const c = makeRunClient(server, { signal, fetchImpl });
  try { await c.login(); } catch (e) { return { ok: false, reason: reasonOf(e), authFailed: e?.authFailed === true }; }   // 로그인 단계 — 아무것도 보내지 않았다
  try { return await fn(c); } catch (e) { return { ok: false, reason: reasonOf(e) }; } finally { await c.logout(); }
}
export const expired = (deadlineAt) => Number.isFinite(deadlineAt) && deadlineAt > 0 && Date.now() >= deadlineAt;
export const NOT_SENT_LATE = { ok: false, notSent: true, reason: '요청 시한이 지나 Veeam 에 보내지 않았습니다(중앙이 이미 결과를 닫았습니다) — 필요하면 다시 요청하세요.' };
/** 상태 변경 요청 실패를 결과로 — 모름이면 unknown, 아니면 실패. */
export const changeFail = (e, what, extra = {}) => (outcomeUnknown(e)
  ? { ok: false, unknown: true, reason: `${what} — 응답을 받지 못해 Veeam 이 시작했는지 알 수 없습니다(${reasonOf(e).slice(0, 300)}). 포탈은 다시 보내지 않습니다 — Veeam 콘솔에서 확인하세요.`, ...extra }
  : { ok: false, reason: `${what} — ${reasonOf(e)}`, ...extra });

/**
 * Quick Backup — 후보 체인:
 *   A) POST /api/v1/jobs/quickBackup/vSphere `{ virtualMachines:[ref…] }` · B) 같은 경로 `{ objects:[ref…] }` · C) VM 마다 `ref` 하나
 */
export async function opQuickBackup(server, { vms = [], deadlineAt = 0, signal, fetchImpl } = {}) {
  const refs = (Array.isArray(vms) ? vms : []).slice(0, 200).map(vmRef).filter((v) => v.objectId && v.hostName);
  if (!refs.length) return P.sanitizeStart({ ok: false, notSent: true, reason: 'Quick Backup 대상 VM 이 없습니다.' });
  if (expired(deadlineAt)) return P.sanitizeStart(NOT_SENT_LATE);
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const ids = refs.map((v) => v.objectId);
    const notes = [];
    for (const [variant, body] of [['A:virtualMachines[]', { virtualMachines: refs }], ['B:objects[]', { objects: refs }]]) {
      if (expired(deadlineAt)) return { ...NOT_SENT_LATE, notes };
      try {
        const { json } = await c.call('POST', QUICK_PATH, { body });
        const sid = sessionIdOf(json);
        if (!sid) notes.push('Veeam 이 요청을 받았지만 응답에서 세션 id 를 찾지 못했습니다 — 결과는 Veeam 콘솔에서 확인하세요.');
        return { ok: true, variant, sessions: [{ id: sid, objectIds: ids }], notes };
      } catch (e) {
        if (!shapeMiss(e)) return { ...changeFail(e, 'Quick Backup 요청'), variant, notes };
        notes.push(`${variant} 거절 — ${reasonOf(e).slice(0, 200)}`);
      }
    }
    // C 는 VM 마다 독립 요청이다 — 한 VM 의 거절·모름이 다른 VM 의 요청이나 이미 받은 세션을 버리게 하지 않는다(2차 반증 N5·N8).
    //   400 은 '모양을 모른다' 와 'VM 사유(전체 복원 지점 없음 등)' 를 구별할 수 없다 — 전부 거절일 때 두 가능성을 함께 말한다.
    const sessions = []; const fails = []; let shapeFails = 0;
    for (const ref of refs) {
      const label = ref.name || ref.objectId;
      if (expired(deadlineAt)) { fails.push(`${label}: 시한이 지나 보내지 않음`); continue; }
      try {
        const { json } = await c.call('POST', QUICK_PATH, { body: ref });
        sessions.push({ id: sessionIdOf(json), objectIds: [ref.objectId] });
      } catch (e) {
        if (outcomeUnknown(e)) { sessions.push({ id: '', objectIds: [ref.objectId], unknown: true }); notes.push(`${label}: 응답을 받지 못했습니다(${reasonOf(e).slice(0, 160)}) — Veeam 이 시작했는지 알 수 없습니다.`); continue; }
        if (shapeMiss(e)) shapeFails++;
        fails.push(`${label}: ${reasonOf(e).slice(0, 200)}`);
      }
    }
    const reason = !sessions.length && shapeFails === refs.length
      ? `Quick Backup 요청을 서버가 모두 거절했습니다(후보 3개) — 요청 모양을 모르거나 VM 이 Quick Backup 조건(전체 복원 지점)을 갖추지 못했습니다: ${fails.join(' · ').slice(0, 400)}`
      : fails.join(' · ');
    return { ok: sessions.length > 0, variant: 'C:per-vm', sessions, notes: [...notes, ...fails], ...(sessions.length ? {} : { reason }) };
  });
  return P.sanitizeStart(r);
}

/** 포탈 전용 잡 생성 본문(순수). type·include 모양은 후보 — 리비전마다 다르다. */
export function portalJobBody({ name, repositoryId, retention = 7, refs, type = 'Backup', wrapped = true }) {
  return {
    name,
    description: `${PORTAL_MARKER} VMware Global Monitoring Portal 이 만든 잡입니다 — 포탈의 'Backup 현황 › 백업 실행' 이 VM 을 넣고 실행합니다. 이름·설명을 바꾸면 포탈이 더 이상 이 잡을 고치지 않습니다.`,
    type,
    isHighPriority: false,
    virtualMachines: { includes: refs.map((r) => (wrapped ? { inventoryObject: r } : r)) },
    storage: { backupRepositoryId: repositoryId, backupProxies: { autoSelection: true }, retentionPolicy: { type: 'RestorePoints', quantity: retention } },
    guestProcessing: { appAwareProcessing: { isEnabled: false }, guestFSIndexing: { isEnabled: false } },
    schedule: { runAutomatically: false },
  };
}

/**
 * 포탈 전용 잡 — 이름이 jobName 인 잡을 찾아(없으면 만들어) 빠진 VM 을 넣고 시작한다.
 * ⚠ 같은 이름의 잡이 있는데 표지가 없으면 **손대지 않는다**(사람이 만든 잡). ⚠ 잡을 시작하면 그 잡의 VM **전부**가 돈다(화면이 말한다).
 */
export async function opPortalJob(server, { jobName = '', repositoryId = '', retention = 7, vms = [], deadlineAt = 0, signal, fetchImpl } = {}) {
  const refs = (Array.isArray(vms) ? vms : []).slice(0, 200).map(vmRef).filter((v) => v.objectId && v.hostName);
  if (!jobName) return P.sanitizeStart({ ok: false, notSent: true, reason: '포탈 전용 잡 이름이 없습니다.' });
  if (!refs.length) return P.sanitizeStart({ ok: false, notSent: true, reason: '포탈 전용 잡에 넣을 VM 이 없습니다.' });
  if (expired(deadlineAt)) return P.sanitizeStart(NOT_SENT_LATE);
  const ret = Math.max(1, Math.min(999, Math.round(Number(retention) || 7)));
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const notes = [];
    const hit = (await c.list('/api/v1/jobs', { max: MAX_JOBS, query: { nameFilter: jobName } })).find((j) => j && j.name === jobName);
    let jobId = ''; let created = false; let added = 0; let variant = '';
    if (!hit) {
      if (!repositoryId) return { ok: false, notSent: true, reason: `포탈 전용 잡 '${jobName}' 이 아직 없고 저장소가 지정되지 않았습니다 — 백업 실행 설정에서 그 Veeam 서버의 저장소를 고르세요.` };
      let lastErr = null;
      // 순서: 현장 확인된 모양(type Backup + VM flat — 2026-10-29 실 VBR 'OC2' 에서 inventoryObject 래퍼는 400 'Name'·'Type'·'Host Name' must not be empty)부터.
      for (const [type, wrapped] of [['Backup', false], ['Backup', true], ['VSphereBackup', false], ['VSphereBackup', true]]) {
        if (expired(deadlineAt)) return { ...NOT_SENT_LATE, notes };
        try {
          const { json } = await c.call('POST', '/api/v1/jobs', { body: portalJobBody({ name: jobName, repositoryId, retention: ret, refs, type, wrapped }) });
          jobId = typeof json?.id === 'string' ? json.id : '';
          variant = `create:${type}:${wrapped ? 'inventoryObject' : 'flat'}`; created = true; added = refs.length;
          break;
        } catch (e) {
          lastErr = e;
          if (outcomeUnknown(e)) return { ok: false, reason: `잡 생성 요청의 응답을 받지 못했습니다 — 잡이 만들어졌는지 알 수 없습니다(${reasonOf(e).slice(0, 200)}). 백업은 시작하지 않았습니다. Veeam 콘솔에서 '${jobName}' 을 확인하세요.`, notes };
          if (!shapeMiss(e)) return { ok: false, reason: `잡 생성 실패 — ${reasonOf(e)}`, notes };
          notes.push(`잡 생성 ${type}/${wrapped ? 'inventoryObject' : 'flat'} 거절 — ${reasonOf(e).slice(0, 200)}`);
        }
      }
      if (!created) return { ok: false, reason: `잡 생성 요청 모양을 서버가 받지 않았습니다 — ${reasonOf(lastErr).slice(0, 300)}`, notes };
      if (!jobId) {
        const again = (await c.list('/api/v1/jobs', { max: MAX_JOBS, query: { nameFilter: jobName } })).find((j) => j && j.name === jobName);
        jobId = typeof again?.id === 'string' ? again.id : '';
      }
      if (!jobId) return { ok: false, reason: '잡을 만들었지만 id 를 확인하지 못했습니다 — 백업은 시작하지 않았습니다. Veeam 콘솔에서 확인하세요.', notes, created };
    } else {
      jobId = String(hit.id || '');
      const full = (await c.call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`)).json || hit;
      if (!String(full?.description || '').includes(PORTAL_MARKER)) {
        return { ok: false, notSent: true, reason: `Veeam 에 같은 이름의 잡 '${jobName}' 이 있지만 포탈이 만든 잡이 아닙니다(설명에 표지 없음) — 사람이 만든 잡은 고치지 않습니다. 잡 이름 접두를 바꾸세요.` };
      }
      const inc = Array.isArray(full?.virtualMachines?.includes) ? full.virtualMachines.includes : [];
      const wrapped = inc.length ? !!inc[0]?.inventoryObject : false;   // 빈 잡은 현장 확인된 flat 모양으로
      const have = new Set(inc.map((x) => { const o = P.inventoryObjectOf(x); return `${o.hostName.toLowerCase()}|${o.objectId}`; }));
      const missing = refs.filter((v) => !have.has(`${v.hostName.toLowerCase()}|${v.objectId}`));
      if (missing.length) {
        if (expired(deadlineAt)) return { ...NOT_SENT_LATE, notes };
        const next = { ...full, virtualMachines: { ...(full.virtualMachines || {}), includes: [...inc, ...missing.map((v) => (wrapped ? { inventoryObject: v } : v))] } };
        try { await c.call('PUT', `/api/v1/jobs/${encodeURIComponent(jobId)}`, { body: next }); }
        catch (e) { return { ok: false, reason: `잡에 VM 을 넣지 못했습니다 — ${reasonOf(e)}${outcomeUnknown(e) ? ' (잡 구성이 바뀌었는지 모릅니다 — 백업은 시작하지 않았습니다)' : ''}`, jobId, jobName }; }
        added = missing.length;
      }
      variant = `update:${wrapped ? 'inventoryObject' : 'flat'}`;
    }
    // 시작 — 본문 `{performActiveFull:false}`(추정) → 모양 거절이면 본문 없이.
    let started = null;
    for (const [v, body] of [['start:body', { performActiveFull: false }], ['start:empty', undefined]]) {
      if (expired(deadlineAt)) return { ...NOT_SENT_LATE, jobId, jobName, created, added, variant, notes };
      try { started = (await c.call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/start`, { body })).json; variant += `+${v}`; break; }
      catch (e) {
        if (!shapeMiss(e) || v === 'start:empty') return { ...changeFail(e, '잡 시작'), jobId, jobName, created, added, variant, notes };
        notes.push(`잡 시작(${v}) 거절 — ${reasonOf(e).slice(0, 200)}`);
      }
    }
    const sid = sessionIdOf(started);
    if (!sid) notes.push('Veeam 이 잡을 시작했지만 응답에서 세션 id 를 찾지 못했습니다 — 결과는 Veeam 콘솔에서 확인하세요.');
    return { ok: true, jobId, jobName, created, added, variant, sessions: [{ id: sid, objectIds: refs.map((v) => v.objectId) }], notes };
  });
  return P.sanitizeStart(r);
}

/** 세션 여러 개를 한 로그인으로 읽는다(반증 검토 F9 — 세션마다 로그인하지 않는다). 세션별 실패는 그 세션만 ok:false. */
export async function opSessions(server, { sessionIds = [], signal, fetchImpl } = {}) {
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((s) => typeof s === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(s)))].slice(0, 50);
  if (!ids.length) return P.sanitizeSessions({ ok: true, sessions: [] });
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const out = [];
    for (const sid of ids) {
      try {
        const s = (await c.call('GET', `/api/v1/sessions/${encodeURIComponent(sid)}`)).json;
        let tasks = null; let tasksError = '';
        // 작업 세션은 선택 — 없으면 세션 전체 결과로만. 실패 사유는 남긴다(2026-10-29 현장 기록: 사유 없이 '읽지 못함' 만 보여 원인을 알 수 없었다).
        try { tasks = await c.list(`/api/v1/sessions/${encodeURIComponent(sid)}/taskSessions`, { max: 500 }); } catch (e) { tasks = null; tasksError = reasonOf(e).slice(0, 300); }
        out.push({ ...P.sessionFrom(s, tasks), id: sid, ...(tasksError ? { tasksError } : {}) });
      } catch (e) { out.push({ id: sid, ok: false, reason: reasonOf(e).slice(0, 300) }); }
    }
    return { ok: true, sessions: out };
  });
  return P.sanitizeSessions(r);
}

export async function opRepos(server, { signal, fetchImpl } = {}) {
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const repos = await c.list('/api/v1/backupInfrastructure/repositories', { max: 256 });
    let states = new Map();
    try { states = new Map((await c.list('/api/v1/backupInfrastructure/repositories/states', { max: 256 })).map((s) => [s?.id, s])); } catch { /* 용량은 선택 */ }
    return { ok: true, repositories: repos.map((p) => { const st = states.get(p?.id) || {}; return { id: p?.id, name: p?.name, freeGB: st.freeGB ?? st.freeSpaceGB, capacityGB: st.capacityGB }; }) };
  });
  return P.sanitizeRepos(r);
}
// 작업 표(OPS·MUTATING·runOp)는 run/ops.js — 백업 관리 작업(run/manage.js)과 함께 한 곳에(v2.819).
