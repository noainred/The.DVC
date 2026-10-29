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
 * VM 묶기(2026-10-29 반증 F1·F2 — 되돌리지 말 것): 이름만으로 고르지 않는다. 백업 개체의 moref(`objectId`)와 vCenter(hostName 또는 path 첫 마디 —
 *  모니터링 모듈이 실서버에서 확인한 필드)가 둘 다 맞아야 '이 VM' 이다. 그것을 확인하지 못하면 **이 vCenter 의 포탈 전용 잡**(이름에 vCenter id 해시 · 표지)의
 *  백업만 받는다 — 다른 vCenter·사람이 만든 잡의 같은 이름 VM 백업을 보이거나 복원·삭제하지 않는다.
 * 결과 원칙은 exec.js 와 같다 — 상태 변경 요청의 전송 오류·시한·408·5xx 는 unknown(다시 보내지 않는다) · 다음 후보는 '모양을 모른다' 일 때만.
 */
import * as P from './parse.js';
import { sameHost, hostFromPath } from '../parse.js';
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

/**
 * 백업 개체가 이 VM 인가 — 'verified'(moref + vCenter 일치) | 'mismatch'(다른 VM 이 분명) | 'unknown'(moref·vCenter 를 확인할 수 없음).
 * ref = { objectId(moref), hostName(Veeam 이 이 vCenter 를 부르는 이름) }. moref 는 vCenter 사이에 겹치므로 단독으로는 'verified' 가 아니다.
 */
export function objectBinding(o, ref) {
  const moref = String(o?.objectId || '');
  if (moref && moref !== String(ref?.objectId || '')) return 'mismatch';
  const h = String(o?.hostName || '') || hostFromPath(o?.path);
  if (moref && h && ref?.hostName) return sameHost(h, ref.hostName) ? 'verified' : 'mismatch';
  return 'unknown';
}

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
      return { variant, rows: rows.filter((x) => x && x.name === name), path, truncated: rows.length >= POINTS_MAX };
    } catch (e) {
      if (!shapeMiss(e)) throw e;
      notes.push(`${variant} 거절 — ${reasonOf(e).slice(0, 160)}`);
    }
  }
  return null;
}

/** 백업 id → { backup, job:{name,portal}, objects } (요청마다 같은 백업은 한 번만 읽는다). */
async function backupInfo(c, cache, bid, notes) {
  if (cache.has(bid)) return cache.get(bid);
  const info = { backup: null, job: { name: '', portal: false }, objects: null };
  try {
    info.backup = (await c.call('GET', `/api/v1/backups/${encodeURIComponent(bid)}`)).json || {};
    const jid = String(info.backup.jobId || '');
    if (jid) {
      try { const j = (await c.call('GET', `/api/v1/jobs/${encodeURIComponent(jid)}`)).json || {}; info.job = { id: jid, name: String(j.name || ''), portal: String(j.description || '').includes(PORTAL_MARKER) }; }
      catch { info.job = { id: jid, name: '', portal: false }; }   // 잡이 지워졌거나 못 읽음 — 포탈 잡으로 보지 않는다
    }
    info.objects = await c.list(`/api/v1/backups/${encodeURIComponent(bid)}/objects`, { max: 2000 });
  } catch (e) { notes.push(`백업 ${bid.slice(0, 12)} 읽기 실패 — ${reasonOf(e).slice(0, 120)}`); }
  cache.set(bid, info);
  return info;
}
/**
 * 복원 지점이 이 VM 의 것인가(목록·복원 공용 — 판정 한 벌). 'verified'(백업 개체 moref+vCenter) | 'portalJob'(확인 못 했지만 이 vCenter 의 포탈 잡 백업) | ''(받지 않음).
 */
function pointBinding(info, vm, jobName) {
  const objs = Array.isArray(info?.objects) ? info.objects.filter((o) => o && o.name === vm.name) : [];
  const b = objs.map((o) => objectBinding(o, vm));
  if (b.includes('verified')) return 'verified';
  if (objs.length && b.every((x) => x === 'mismatch')) return '';
  const portal = !!jobName && info?.job?.portal === true && info.job.name === jobName;
  return portal ? 'portalJob' : '';
}

/** 복원 지점 목록 + 백업·잡 이름 + 포탈 전용 잡 포함 여부(읽기). 이 VM 으로 묶이지 않는 지점은 숨기고 개수만 말한다. */
export async function opVmPoints(server, { vm = {}, jobName = '', signal, fetchImpl } = {}) {
  const name = String(vm?.name || '');
  const ref = { name, objectId: String(vm?.objectId || ''), hostName: String(vm?.hostName || '') };
  if (!name) return P.sanitizePoints({ ok: false, notSent: true, reason: 'VM 이름이 없습니다.' });
  const r = await withSession(server, { signal, fetchImpl }, async (c) => {
    const notes = [];
    const got = await pointsByName(c, name, notes);
    if (!got) return { ok: false, reason: `복원 지점 목록 경로를 이 VBR 이 받지 않았습니다 — ${notes.join(' · ').slice(0, 300)}`, notes };
    const cache = new Map();
    const bids = [...new Set(got.rows.map((x) => String(x.backupId || '')).filter(Boolean))];
    for (const bid of bids.slice(0, LOOKUP_MAX)) await backupInfo(c, cache, bid, notes);
    if (bids.length > LOOKUP_MAX) notes.push(`백업 ${bids.length}개 중 ${LOOKUP_MAX}개만 확인했습니다 — 나머지 백업의 지점은 숨깁니다.`);
    let hidden = 0;
    const points = [];
    for (const x of got.rows) {
      const info = cache.get(String(x.backupId || ''));
      const bind = info ? pointBinding(info, ref, jobName) : '';
      if (!bind) { hidden++; continue; }
      points.push({ id: x.id, name: x.name, creationTime: x.creationTime, backupId: x.backupId, backupName: info.backup?.name, jobId: info.job?.id, jobName: info.job?.name, portal: info.job?.portal === true, type: x.type || x.pointType, platformName: x.platformName, binding: bind });
    }
    points.sort((a, b) => String(b.creationTime || '').localeCompare(String(a.creationTime || '')));
    let job = null;
    if (jobName) {
      const pj = await portalJobOf(c, jobName);
      job = pj ? { id: pj.id, name: jobName, found: true, marker: pj.marker, included: pj.inc.some((x) => sameRef(P.inventoryObjectOf(x), ref)) } : { name: jobName, found: false, marker: false, included: false };
    }
    return { ok: true, variant: got.variant, points, job, notes, hidden, truncated: got.truncated };
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
export async function opRestoreVm(server, { restorePointId = '', vm = {}, newName = '', dest = {}, jobName = '', reason = '', deadlineAt = 0, signal, fetchImpl } = {}) {
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
    // 반증 F1: 이름만으로는 다른 vCenter·다른 VM 의 백업일 수 있다 — 목록과 같은 판정으로 다시 묶는다(보내기 직전, 서버에서).
    const info = pt.backupId ? await backupInfo(c, new Map(), String(pt.backupId), notes) : null;
    const bind = info ? pointBinding(info, { name: String(vm?.name || ''), objectId: String(vm?.objectId || ''), hostName: String(dest?.hostName || '') }, jobName) : '';
    if (!bind) return { ok: false, notSent: true, reason: '이 복원 지점이 이 vCenter 의 이 VM 것인지 확인하지 못했습니다(다른 vCenter 의 같은 이름 VM 일 수 있음) — 보내지 않았습니다.', notes };
    notes.push(bind === 'verified' ? '복원 지점 확인: 백업 개체의 moref·vCenter 일치' : '복원 지점 확인: 이 vCenter 의 포탈 전용 잡 백업(개체 moref·vCenter 는 응답에서 확인하지 못함)');
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
  if (!removed) {
    // 반증 F5(a): moref·이름 표기가 달라 못 찾았는데 같은 moref 나 이름이 잡에 남아 있으면 '없음' 이 아니다 — 확인하지 못한 것이다.
    const look = pj.inc.map((x) => P.inventoryObjectOf(x)).filter((o) => refs.some((v) => o.objectId === v.objectId || (v.name && o.name === v.name)));
    if (look.length) return { ok: false, notSent: true, reason: `포탈 전용 잡 '${pj.name}' 에 이 VM 으로 보이는 항목이 있지만 vCenter 이름 표기가 달라 확정하지 못했습니다 — 바꾸지 않았습니다(Veeam 콘솔에서 확인하세요).` };
    return { ok: true, removed: 0 };
  }
  if (!keep.length) return { ok: false, notSent: true, reason: `포탈 전용 잡 '${pj.name}' 의 마지막 VM 이라 빼지 않았습니다 — 잡을 끄거나 지우는 것은 Veeam 콘솔에서 하세요.` };
  if (expired(deadlineAt)) return NOT_SENT_LATE;
  const next = { ...pj.full, virtualMachines: { ...(pj.full.virtualMachines || {}), includes: keep } };
  try { await c.call('PUT', `/api/v1/jobs/${encodeURIComponent(pj.id)}`, { body: next }); return { ok: true, removed }; }
  catch (e) { return changeFail(e, `포탈 전용 잡 '${pj.name}' 에서 VM 빼기`); }
}

/** 포탈 전용 잡에서 VM 빼기. 표지가 없는 잡(사람이 만든 잡)은 고치지 않는다. */
export async function opJobExclude(server, { jobName = '', vms = [], deadlineAt = 0, signal, fetchImpl } = {}) {
  const refs = (Array.isArray(vms) ? vms : []).slice(0, 200).map((v) => ({ hostName: String(v?.hostName || ''), objectId: String(v?.objectId || ''), name: String(v?.name || '') })).filter((v) => v.hostName && v.objectId);
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
 * 백업 삭제(되돌릴 수 없음) — 포탈 전용 잡(표지)의 백업에서 **이 VM(moref)** 만. 순서: 잡에서 빼기(필수) → 백업 개체 찾기(moref) → 삭제.
 *  · 잡에서 빼지 못했으면(실패·모름·마지막 VM·확정 못 함) 지우지 않는다 — 남겨 두면 다음 실행이 다시 만든다(반증 F5).
 *  · 개체는 moref 로 고른다(이름 금지 — 반증 F2). moref 가 없거나 둘 이상이면 지우지 않는다.
 *  · 그 백업에 이 VM 하나뿐이면 백업째(DELETE /backups/{id} — 범위가 포탈 백업으로 정해진다)를 먼저. 다른 VM 이 함께 든 백업은
 *    개체 삭제(DELETE /backupObjects/{id})만이고, 그 개체의 복원 지점이 **전부 이 포탈 백업 안**인지 먼저 확인한다(개체 id 가 VM 단위일 수 있다 — 반증 F3).
 *  · 빼기 뒤 예외가 나도 excluded·deleted 를 돌려준다(기록·감사가 실제 변경을 놓치지 않게 — 반증 F6).
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
    // 1) 잡에서 빼기 — 성공(뺐거나 원래 없음)일 때만 다음으로.
    const ex = await excludeFrom(c, pj, [ref], deadlineAt);
    if (!ex.ok) return { ...ex, excluded: false, deleted: 0, reason: `${ex.reason} — 백업은 지우지 않았습니다.`, notes };
    const excluded = ex.removed > 0;
    let deleted = 0; let variant = '';
    try {
      // 2) 이 잡의 백업 → 이 VM(moref) 의 개체
      const backups = (await c.list('/api/v1/backups', { max: 200, query: { jobIdFilter: pj.id } })).filter((b) => b && String(b.jobId || '') === pj.id);
      const targets = [];
      for (const b of backups.slice(0, LOOKUP_MAX)) {
        const objs = await c.list(`/api/v1/backups/${encodeURIComponent(String(b.id))}/objects`, { max: 2000 });
        const same = objs.filter((o) => o && o.name === ref.name);
        const mine = same.filter((o) => String(o.objectId || '') === ref.objectId);
        if (same.some((o) => !o.objectId)) return { ok: false, notSent: true, excluded, deleted, reason: `백업 개체에 moref 가 없어 이 VM 의 것인지 확인할 수 없습니다 — 지우지 않았습니다${excluded ? '(잡에서는 뺐습니다)' : ''}.`, notes };
        if (mine.length > 1) return { ok: false, notSent: true, excluded, deleted, reason: `같은 moref 의 백업 개체가 ${mine.length}개라 어느 것인지 정할 수 없습니다 — 지우지 않았습니다.`, notes };
        if (mine.length) targets.push({ backupId: String(b.id), objectId: String(mine[0].id || ''), only: objs.length === 1 });
      }
      if (!targets.length) return { ok: true, excluded, deleted: 0, notes: [...notes, '포탈 전용 잡에 이 VM 의 백업이 없습니다 — 지울 것이 없습니다.'] };
      for (const t of targets) {
        if (expired(deadlineAt)) return { ...NOT_SENT_LATE, excluded, deleted, notes };
        const cands = [];
        if (t.only) cands.push(['backup(only-this-vm)', `/api/v1/backups/${encodeURIComponent(t.backupId)}`, false]);
        if (t.objectId) cands.push(['backupObject', `/api/v1/backupObjects/${encodeURIComponent(t.objectId)}`, true]);
        let done = false;
        for (const [v, path, needScope] of cands) {
          if (needScope) {
            // 개체 id 가 VM 단위(여러 잡의 백업을 아우름)일 수 있다 — 그 개체의 복원 지점이 전부 이 포탈 백업 안일 때만.
            let pts = null;
            try { pts = await c.list(`/api/v1/backupObjects/${encodeURIComponent(t.objectId)}/restorePoints`, { max: 2000 }); }
            catch (e) { notes.push(`개체 범위 확인 실패 — ${reasonOf(e).slice(0, 120)}`); }
            if (!pts || pts.some((p) => String(p?.backupId || '') !== t.backupId)) { notes.push(`${v} 건너뜀 — 그 개체가 이 포탈 백업 밖의 복원 지점도 가졌는지 확인하지 못했습니다.`); continue; }
          }
          try { await c.call('DELETE', path); deleted++; variant = v; done = true; break; }
          catch (e) {
            if (outcomeUnknown(e)) return { ok: false, unknown: true, excluded, deleted, variant: v, reason: `백업 삭제 요청의 응답을 받지 못했습니다 — 지워졌는지 알 수 없습니다(${reasonOf(e).slice(0, 200)}). 다시 보내지 않습니다. Veeam 콘솔에서 확인하세요.`, notes };
            if (!shapeMiss(e)) return { ok: false, excluded, deleted, variant: v, reason: `백업 삭제 실패 — ${reasonOf(e)}`, notes };
            notes.push(`${v} 거절 — ${reasonOf(e).slice(0, 160)}`);
          }
        }
        if (!done) {
          return { ok: false, excluded, deleted, reason: `이 VBR 의 REST 로 이 VM 의 백업만 안전하게 지울 경로를 찾지 못했습니다${excluded ? ' — 포탈 전용 잡에서는 뺐습니다' : ''}. 남은 복원 지점은 보존 기간이 지나면 지워지고, 지금 지우려면 Veeam 콘솔의 'Delete from disk' 를 쓰세요.`, notes };
        }
      }
      return { ok: true, excluded, deleted, variant, notes };
    } catch (e) {
      return { ok: false, excluded, deleted, reason: `${excluded ? '잡에서 뺀 뒤 ' : ''}백업 확인·삭제 중 오류 — ${reasonOf(e).slice(0, 300)}`, notes };
    }
  });
  return P.sanitizeManage(r);
}
