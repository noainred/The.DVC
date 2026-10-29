/**
 * veeam/run/manage.js — 포탈 백업 관리(v2.819): 복원 지점 보기 · **새 VM 으로** 복원 · 포탈 전용 잡에서 빼기 · 백업 삭제.
 * 중앙 직접 실행과 엣지 대행이 같은 함수를 쓴다(작업 표 run/ops.js).
 *
 *   vmPoints     VM 이름으로 복원 지점 목록 + 백업·잡 이름 + 포탈 전용 잡 포함 여부(읽기)
 *   restoreVm    복원 지점 → **새 이름의 VM**(원본은 그대로 · 전원 꺼짐). 원래 위치 복원(OriginalLocation)은 보내지 않는다(사용자 결정 2026-10-29).
 *   jobExclude   포탈 전용 잡(표지가 있는 잡)에서 VM 을 뺀다 — 이미 만든 복원 지점은 Veeam 보존 정책대로 남는다.
 *   deleteBackup 포탈 전용 잡의 그 VM 백업 데이터를 지운다(되돌릴 수 없음) — 먼저 잡에서 빼고(다음 실행이 다시 만들지 않게) 지운다.
 *
 * ⚠⚠ 정직 기록 — 실제 VBR 로 확인하지 못했다(2026-10-29 현장 확인은 잡 생성·시작·세션 읽기뿐 — docs/VEEAM-BACKUP-RUN.md).
 *  · 복원 지점 목록: v1.1 '/objectRestorePoints' → 옛 '/restorePoints' 후보. VM 은 **이름**으로 찾는다(응답에 moref 가 있는지 확인 못 함).
 *  · 새 VM 복원: '/restore/vmRestore/vSphere' + type 'Customized'(커뮤니티 예시 — 공식 문서는 개발 환경에서 열리지 않았다). 본문 후보 2개.
 *  · 백업 삭제: **REST 에 VM 단위 삭제가 없을 수 있다**(Veeam 포럼 답변 — 날짜 미상). 후보 'DELETE /backupObjects/{id}' →
 *    (그 백업에 이 VM 하나뿐일 때만) 'DELETE /backups/{id}'. 다른 VM 이 함께 든 백업을 통째로 지우는 일은 **하지 않는다**.
 * 결과 원칙은 exec.js 와 같다 — 상태 변경 요청의 전송 오류·시한·408·5xx 는 unknown(다시 보내지 않는다) · 다음 후보는 '모양을 모른다' 일 때만.
 */
import * as P from './parse.js';
import { withSession, shapeMiss, outcomeUnknown, reasonOf, expired, NOT_SENT_LATE, changeFail, sessionIdOf, PORTAL_MARKER, MAX_JOBS } from './exec.js';

/** 복원은 이 type 하나만 보낸다 — 원래 위치(덮어쓰기)는 만들지 않는다(사용자 결정). 테스트가 소스에 다른 type 이 없음을 고정한다. */
export const RESTORE_TYPE = 'Customized';
export const RESTORE_PATH = '/api/v1/restore/vmRestore/vSphere';
/** 새 VM 이름 — vSphere 이름으로 안전한 글자만(셸·경로 특수문자 없음). 원본 이름과 같으면 안 된다(라우트가 인벤토리와도 대조). */
export const NEW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const POINTS_MAX = 200;
const LOOKUP_MAX = 20;   // 복원 지점이 가리키는 백업·잡 조회 상한(서로 다른 것만)

const lc = (s) => String(s || '').toLowerCase();
const sameRef = (a, b) => lc(a.hostName) === lc(b.hostName) && String(a.objectId) === String(b.objectId);

/** 이름이 jobName 인 잡(표지 확인을 위해 전체를 읽는다). 없으면 null. */
async function portalJobOf(c, jobName) {
  if (!jobName) return null;
  const hit = (await c.list('/api/v1/jobs', { max: MAX_JOBS, query: { nameFilter: jobName } })).find((j) => j && j.name === jobName);
  if (!hit) return null;
  const id = String(hit.id || '');
  const full = (await c.call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`)).json || hit;
  const inc = Array.isArray(full?.virtualMachines?.includes) ? full.virtualMachines.includes : [];
  return { id, name: jobName, full, inc, marker: String(full?.description || '').includes(PORTAL_MARKER) };
}

/** 복원 지점 목록(후보 경로) — 이름 일치만 남긴다. */
async function pointsByName(c, name, notes) {
  for (const [variant, path] of [['objectRestorePoints', '/api/v1/objectRestorePoints'], ['restorePoints', '/api/v1/restorePoints']]) {
    try {
      const rows = await c.list(path, { max: POINTS_MAX, query: { nameFilter: name } });
      return { variant, rows: rows.filter((x) => x && x.name === name), path };
    } catch (e) {
      if (!shapeMiss(e)) throw e;
      notes.push(`${variant} 거절 — ${reasonOf(e).slice(0, 160)}`);
    }
  }
  return null;
}

/** 복원 지점 목록 + 백업·잡 이름 + 포탈 전용 잡 포함 여부(읽기). */
export async function opVmPoints(server, { vm = {}, jobName = '', signal, fetchImpl } = {}) {
  const name = String(vm?.name || '');
  if (!name) return P.sanitizePoints({ ok: false, notSent: true, reason: 'VM 이름이 없습니다.' });
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const notes = [];
    const got = await pointsByName(c, name, notes);
    if (!got) return { ok: false, reason: `복원 지점 목록 경로를 이 VBR 이 받지 않았습니다 — ${notes.join(' · ').slice(0, 300)}`, notes };
    // 백업 → 잡 이름·표지(서로 다른 것만, 상한)
    const backups = new Map(); const jobs = new Map();
    for (const bid of [...new Set(got.rows.map((x) => String(x.backupId || '')).filter(Boolean))].slice(0, LOOKUP_MAX)) {
      try { backups.set(bid, (await c.call('GET', `/api/v1/backups/${encodeURIComponent(bid)}`)).json || {}); } catch (e) { notes.push(`백업 ${bid.slice(0, 12)} 읽기 실패 — ${reasonOf(e).slice(0, 120)}`); }
    }
    for (const jid of [...new Set([...backups.values()].map((b) => String(b?.jobId || '')).filter(Boolean))].slice(0, LOOKUP_MAX)) {
      try { const j = (await c.call('GET', `/api/v1/jobs/${encodeURIComponent(jid)}`)).json || {}; jobs.set(jid, { name: String(j.name || ''), portal: String(j.description || '').includes(PORTAL_MARKER) }); }
      catch { jobs.set(jid, { name: '', portal: false }); }   // 잡이 지워졌거나 못 읽음 — 포탈 잡으로 보지 않는다(삭제 대상 아님)
    }
    const points = got.rows.map((x) => {
      const b = backups.get(String(x.backupId || '')) || {};
      const j = jobs.get(String(b.jobId || '')) || { name: '', portal: false };
      return { id: x.id, name: x.name, creationTime: x.creationTime, backupId: x.backupId, backupName: b.name, jobId: b.jobId, jobName: j.name, portal: j.portal, type: x.type || x.pointType, platformName: x.platformName };
    }).sort((a, b) => String(b.creationTime || '').localeCompare(String(a.creationTime || '')));
    let job = null;
    if (jobName) {
      const pj = await portalJobOf(c, jobName);
      job = pj ? { id: pj.id, name: jobName, found: true, marker: pj.marker, included: pj.inc.some((x) => sameRef(P.inventoryObjectOf(x), vm)) } : { name: jobName, found: false, marker: false, included: false };
    }
    return { ok: true, variant: got.variant, points, job, notes };
  });
  return P.sanitizePoints(r);
}

/** 복원 지점 1건 읽기(후보 경로) — 이 VM 의 것인지 확인용. */
async function readPoint(c, id) {
  let last = null;
  for (const path of [`/api/v1/objectRestorePoints/${encodeURIComponent(id)}`, `/api/v1/restorePoints/${encodeURIComponent(id)}`]) {
    try { return (await c.call('GET', path)).json; } catch (e) { last = e; if (!shapeMiss(e)) throw e; }
  }
  throw last;
}

/**
 * 새 VM 으로 복원. dest = { hostName(Veeam 이 vCenter 를 부르는 이름), host:{name, objectId} } — 원본 VM 이 있던 ESXi 호스트.
 * 복원 지점이 이 VM(이름)의 것이 아니면 보내지 않는다(다른 VM·다른 범위의 백업을 이 이름으로 복원하지 않게).
 */
export async function opRestoreVm(server, { restorePointId = '', vm = {}, newName = '', dest = {}, reason = '', deadlineAt = 0, signal, fetchImpl } = {}) {
  const pid = String(restorePointId || '');
  const nn = String(newName || '');
  const host = { name: String(dest?.host?.name || ''), objectId: String(dest?.host?.objectId || '') };
  if (!ID_RE.test(pid)) return P.sanitizeStart({ ok: false, notSent: true, reason: '복원 지점 id 형식이 아닙니다.' });
  if (!NEW_NAME_RE.test(nn) || lc(nn) === lc(vm?.name)) return P.sanitizeStart({ ok: false, notSent: true, reason: '새 VM 이름이 올바르지 않거나 원본 이름과 같습니다.' });
  if (!dest?.hostName || !host.name || !host.objectId) return P.sanitizeStart({ ok: false, notSent: true, reason: '복원할 ESXi 호스트를 모릅니다.' });
  if (expired(deadlineAt)) return P.sanitizeStart(NOT_SENT_LATE);
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const notes = [];
    const pt = await readPoint(c, pid);
    if (!pt || pt.name !== vm?.name) return { ok: false, notSent: true, reason: `복원 지점이 이 VM('${String(vm?.name || '')}')의 것이 아닙니다 — 보내지 않았습니다.` };
    const destinationHost = { type: 'Host', hostName: String(dest.hostName), name: host.name, objectId: host.objectId };
    const why = String(reason || '포탈 백업 관리 — 새 VM 으로 복원').slice(0, 200);
    for (const [variant, body] of [
      ['vmRestore:full', { restorePointId: pid, type: RESTORE_TYPE, vmName: nn, powerUp: false, reason: why, restoreProxies: { autoSelectEnabled: true }, destinationHost }],
      ['vmRestore:min', { restorePointId: pid, type: RESTORE_TYPE, vmName: nn, powerUp: false, destinationHost }],
    ]) {
      if (expired(deadlineAt)) return { ...NOT_SENT_LATE, notes };
      try {
        const { json } = await c.call('POST', RESTORE_PATH, { body });
        const sid = sessionIdOf(json);
        if (!sid) notes.push('Veeam 이 복원 요청을 받았지만 응답에서 세션 id 를 찾지 못했습니다 — 결과는 Veeam 콘솔에서 확인하세요.');
        return { ok: true, variant, sessions: [{ id: sid, objectIds: [String(vm?.objectId || '')] }], notes };
      } catch (e) {
        if (!shapeMiss(e)) return { ...changeFail(e, '복원 요청'), variant, notes };
        notes.push(`${variant} 거절 — ${reasonOf(e).slice(0, 200)}`);
      }
    }
    return { ok: false, reason: `복원 요청 모양을 서버가 받지 않았습니다(후보 2개) — ${notes.join(' · ').slice(0, 400)}`, notes };
  });
  return P.sanitizeStart(r);
}

/** 잡 includes 에서 VM 을 빼고 PUT. 반환 { removed } 또는 실패 객체. 잡의 마지막 VM 은 빼지 않는다(빈 잡은 Veeam 이 거절하거나 의미 없는 잡이 남는다). */
async function excludeFrom(c, pj, refs, deadlineAt) {
  const keep = pj.inc.filter((x) => !refs.some((v) => sameRef(P.inventoryObjectOf(x), v)));
  const removed = pj.inc.length - keep.length;
  if (!removed) return { ok: true, removed: 0 };
  if (!keep.length) return { ok: false, notSent: true, reason: `포탈 전용 잡 '${pj.name}' 의 마지막 VM 이라 빼지 않았습니다 — 잡을 끄거나 지우는 것은 Veeam 콘솔에서 하세요.` };
  if (expired(deadlineAt)) return NOT_SENT_LATE;
  const next = { ...pj.full, virtualMachines: { ...(pj.full.virtualMachines || {}), includes: keep } };
  try { await c.call('PUT', `/api/v1/jobs/${encodeURIComponent(pj.id)}`, { body: next }); return { ok: true, removed }; }
  catch (e) { return changeFail(e, `포탈 전용 잡 '${pj.name}' 에서 VM 빼기`); }
}

/** 포탈 전용 잡에서 VM 빼기. 표지가 없는 잡(사람이 만든 잡)은 고치지 않는다. */
export async function opJobExclude(server, { jobName = '', vms = [], deadlineAt = 0, signal, fetchImpl } = {}) {
  const refs = (Array.isArray(vms) ? vms : []).slice(0, 200).map((v) => ({ hostName: String(v?.hostName || ''), objectId: String(v?.objectId || '') })).filter((v) => v.hostName && v.objectId);
  if (!jobName || !refs.length) return P.sanitizeManage({ ok: false, notSent: true, reason: '잡 이름이나 VM 이 없습니다.' });
  if (expired(deadlineAt)) return P.sanitizeManage(NOT_SENT_LATE);
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const pj = await portalJobOf(c, jobName);
    if (!pj) return { ok: true, removed: 0, notes: [`포탈 전용 잡 '${jobName}' 이 Veeam 에 없습니다 — 뺄 것이 없습니다.`] };
    if (!pj.marker) return { ok: false, notSent: true, reason: `'${jobName}' 은 포탈이 만든 잡이 아닙니다(설명에 표지 없음) — 고치지 않습니다.` };
    return excludeFrom(c, pj, refs, deadlineAt);
  });
  return P.sanitizeManage(r);
}

/**
 * 백업 삭제(되돌릴 수 없음) — 포탈 전용 잡(표지)의 백업에서 이 VM 만. 순서: 잡에서 빼기 → 백업 개체 찾기 → 삭제 후보.
 * 다른 VM 이 함께 든 백업은 통째로 지우지 않는다. VM 단위 삭제 경로가 없으면 '빼기까지만 했다' 고 말한다.
 */
export async function opDeleteBackup(server, { jobName = '', vm = {}, deadlineAt = 0, signal, fetchImpl } = {}) {
  const ref = { hostName: String(vm?.hostName || ''), objectId: String(vm?.objectId || ''), name: String(vm?.name || '') };
  if (!jobName || !ref.name || !ref.objectId || !ref.hostName) return P.sanitizeManage({ ok: false, notSent: true, reason: '잡 이름이나 VM 정보가 없습니다.' });
  if (expired(deadlineAt)) return P.sanitizeManage(NOT_SENT_LATE);
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const notes = [];
    const pj = await portalJobOf(c, jobName);
    if (!pj) return { ok: false, notSent: true, reason: `포탈 전용 잡 '${jobName}' 이 Veeam 에 없습니다 — 포탈 잡의 백업만 지웁니다.` };
    if (!pj.marker) return { ok: false, notSent: true, reason: `'${jobName}' 은 포탈이 만든 잡이 아닙니다(설명에 표지 없음) — 지우지 않습니다.` };
    // 1) 잡에서 빼기(다음 실행이 다시 만들지 않게). 실패·모름이면 지우지 않는다.
    const ex = await excludeFrom(c, pj, [ref], deadlineAt);
    if (!ex.ok && !(ex.notSent && /마지막 VM/.test(ex.reason || ''))) return { ...ex, reason: `${ex.reason} — 백업은 지우지 않았습니다.`, notes };
    const excluded = ex.ok ? ex.removed > 0 : false;
    if (!ex.ok) notes.push(ex.reason);
    // 2) 이 잡의 백업 → 이 VM 의 개체
    const backups = (await c.list('/api/v1/backups', { max: 200, query: { jobIdFilter: pj.id } })).filter((b) => b && String(b.jobId || '') === pj.id);
    const targets = [];
    for (const b of backups.slice(0, LOOKUP_MAX)) {
      const objs = await c.list(`/api/v1/backups/${encodeURIComponent(String(b.id))}/objects`, { max: 2000 });
      const mine = objs.filter((o) => o && o.name === ref.name);
      for (const o of mine) targets.push({ backupId: String(b.id), objectId: String(o.id || ''), only: objs.length === 1 });
    }
    if (!targets.length) return { ok: true, excluded, deleted: 0, notes: [...notes, '포탈 전용 잡에 이 VM 의 백업이 없습니다 — 지울 것이 없습니다.'] };
    let deleted = 0; let variant = '';
    for (const t of targets) {
      if (expired(deadlineAt)) return { ...NOT_SENT_LATE, excluded, deleted, notes };
      let done = false;
      const cands = [['backupObject', `/api/v1/backupObjects/${encodeURIComponent(t.objectId)}`]];
      if (t.only) cands.push(['backup(only-this-vm)', `/api/v1/backups/${encodeURIComponent(t.backupId)}`]);   // 이 VM 하나뿐인 백업만
      for (const [v, path] of cands) {
        if (!t.objectId && v === 'backupObject') continue;
        try { await c.call('DELETE', path); deleted++; variant = v; done = true; break; }
        catch (e) {
          if (outcomeUnknown(e)) return { ok: false, unknown: true, excluded, deleted, variant: v, reason: `백업 삭제 요청의 응답을 받지 못했습니다 — 지워졌는지 알 수 없습니다(${reasonOf(e).slice(0, 200)}). 다시 보내지 않습니다. Veeam 콘솔에서 확인하세요.`, notes };
          if (!shapeMiss(e)) return { ok: false, excluded, deleted, variant: v, reason: `백업 삭제 실패 — ${reasonOf(e)}`, notes };
          notes.push(`${v} 거절 — ${reasonOf(e).slice(0, 160)}`);
        }
      }
      if (!done) {
        return { ok: false, excluded, deleted, reason: `이 VBR 의 REST 는 VM 단위 백업 삭제를 받지 않았습니다${excluded ? ' — 포탈 전용 잡에서는 뺐습니다' : ''}. 남은 복원 지점은 보존 기간이 지나면 지워지고, 지금 지우려면 Veeam 콘솔의 'Delete from disk' 를 쓰세요.`, notes };
      }
    }
    return { ok: true, excluded, deleted, variant, notes };
  });
  return P.sanitizeManage(r);
}
