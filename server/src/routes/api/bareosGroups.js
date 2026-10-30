// Bareos 백업 그룹 라우트(v2.830 · 사용자 요청 '전체 VM 트리에서 고른 VM 을 그룹으로 — 이름·스케줄·스토리지 지정, 나중에 수정').
// 도구 키 bareos-backup(관리자 전용 — 경로 첫 마디 규약)의 '백업 그룹' 탭. 범위: 그룹은 vCenter(= 법인) 귀속 — 조회 밖 404 → 쓰기 밖 403(bareosAccess 하나).
// 스케줄은 포탈이 돌린다(bareos/groupRunner.js — Bareos 에 잡 스케줄 수정 명령이 없어 '나중에 수정' 을 지키려면 이 방식뿐이다).
// 그룹 VM 중 잡이 없는 VM 은 저장 때 **Director 스케줄 없이** 등록한다(그룹 스케줄과 Director 스케줄이 겹쳐 두 번 돌지 않게).
import { requireRole } from '../../auth/auth.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { bareosAccess, sendBareosErr, bareosCatalogOf, MAX_BULK } from './bareosBackup.js';
import { effectiveSettings, isDemoActive, eligibility, createBackupTargets } from '../../bareos/service.js';
import { directorById, directorConn, siteMissing } from '../../bareos/settings.js';
import { jobDigests, MAX_JOBS, registryLoadError } from '../../bareos/registry.js';
import { listGroups, getGroup, addGroup, updateGroup, deleteGroup, checkGroupInput, groupsLoadError, MAX_MEMBERS, MAX_GROUPS } from '../../bareos/groups.js';
import { nextSlot, scheduleText, CATCHUP_MS, LEVELS } from '../../bareos/groupSchedule.js';
import { runGroup, groupRunning } from '../../bareos/groupRunner.js';
import { bareosVmView } from '../../bareos/vmView.js';
import { getMarks, marksUnreadable } from '../../veeam/backupMarks.js';
import { isSystemVm } from '../../veeam/backupStatus.js';

const adminOnly = requireRole('admin');
const READ_ONLY = '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다(Bareos 백업 그룹은 쓰기 범위가 필요합니다).';
const NOT_FOUND = '백업 그룹을 찾을 수 없습니다.';
const gbOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail, ip: req.ip || '' });
/** 서버 현지 시간대 — 스케줄 시각의 기준(화면이 밝힌다). */
const serverTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

/** 그룹 → 응답(비밀 없음 — 원장에 비밀이 없다). 다음 회차·실행 중 여부를 덧붙인다. */
export function groupView(g, now = Date.now()) {
  const next = nextSlot(g.schedule, now);
  return { ...g, scheduleText: scheduleText(g.schedule), next: next ? { at: next.at, key: next.key, level: next.level } : null, running: groupRunning(g.id) };
}

/** 법인(vCenter)의 Director 매핑 상태. */
function siteInfo(vcenterId, settings) {
  const site = settings.sites.find((s) => s.vcenterId === vcenterId) || null;
  const dir = site ? directorById(site.directorId, settings) : null;
  const demo = isDemoActive();
  return {
    site,
    view: dir ? { id: dir.id, name: dir.name, via: dir.agent ? 'edge' : 'central', ready: demo || !!directorConn(dir).conn, missing: demo ? [] : (directorConn(dir).missing || []) } : null,
    mappingMissing: site ? siteMissing(site) : null,
  };
}

/**
 * 저장 전 준비 — 그룹 VM 이 이 vCenter 의 VM(인벤토리 또는 원장)인지, 잡 없는 VM 을 몇 대 등록해야 하는지.
 * @returns {{ need: string[], unknown: string[] }}
 */
function membersPlan(vcenterId, vmIds) {
  const inv = new Set((store.get()?.vms || []).filter((v) => v.vcenterId === vcenterId).map((v) => v.id));
  const jobs = new Set(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => j.vmId));
  const unknown = vmIds.filter((id) => !inv.has(id) && !jobs.has(id));
  const need = vmIds.filter((id) => !jobs.has(id) && inv.has(id));
  return { need, unknown };
}

/**
 * 잡 없는 VM 등록(Director 스케줄 없이 — 그룹이 돌린다) → 그룹에 넣을 VM(잡이 있는 것) · 등록 결과.
 * 등록에 실패한 VM 은 그룹에서 뺀다(사유를 돌려준다 — 잡 없는 VM 을 그룹에 두면 회차마다 '잡 없음' 만 쌓인다).
 */
async function registerMissing(req, vcenterId, vmIds, level) {
  const { need } = membersPlan(vcenterId, vmIds);
  let registered = [];
  if (need.length) {
    try {
      registered = await createBackupTargets({ vcenterId, vmIds: need, level, schedule: '', by: req.user?.username || '', demo: isDemoActive() });
    } catch (e) {
      registered = Array.isArray(e?.results) ? e.results : need.map((vmId) => ({ vmId, vmName: '', ok: false, reason: String(e?.message || e).slice(0, 300) }));
    }
    const ok = registered.filter((r) => r.ok);
    const bad = registered.filter((r) => !r.ok);
    const names = (list) => list.slice(0, 20).map((r) => r.vmName || r.vmId).join(', ') + (list.length > 20 ? ` 외 ${list.length - 20}` : '');
    audit(req, 'Bareos 백업 대상 일괄 등록', vcenterId, `백업 그룹 저장 중 · 등록 ${ok.length}대${ok.length ? `(${names(ok)})` : ''} · 실패 ${bad.length}대${bad.length ? `(${names(bad)})` : ''} · Director 스케줄 없음(그룹이 실행)`);
  }
  const has = new Set(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => j.vmId));
  const members = vmIds.filter((id) => has.has(id));
  const excluded = vmIds.filter((id) => !has.has(id)).map((id) => ({ vmId: id, reason: registered.find((r) => r.vmId === id)?.reason || '백업 대상으로 등록하지 못했습니다.' }));
  return { members, registered: registered.map((r) => ({ vmId: r.vmId, vmName: r.vmName, ok: r.ok, ...(r.ok ? {} : { reason: r.reason || '사유 미상' }) })), excluded };
}

/** 그룹 VM 중 Director 스케줄이 있는 잡(그룹 스케줄과 함께면 두 번 돈다) — 사람이 알게 돌려준다(잡 스케줄은 콘솔로 바꿀 수 없다). */
function doubleScheduled(vcenterId, vmIds) {
  const set = new Set(vmIds);
  return jobDigests().filter((j) => j.vcenterId === vcenterId && set.has(j.vmId) && j.schedule).map((j) => ({ vmId: j.vmId, vmName: j.vmName, schedule: j.schedule }));
}

/** 저장 요청 판정 공통(범위·원장·입력). 실패면 응답을 보내고 null. */
function precheck(req, res, vcenterId, { selfId = '' } = {}) {
  const a = bareosAccess(req.user, vcenterId);
  if (a === 404) { res.status(404).json({ ok: false, reason: selfId ? NOT_FOUND : 'vCenter 를 찾을 수 없습니다.' }); return null; }
  if (a === 403) { res.status(403).json({ ok: false, reason: READ_ONLY }); return null; }
  if (groupsLoadError()) { res.status(503).json({ ok: false, reason: '백업 그룹 원장을 읽지 못한 상태라 저장하지 않습니다(손상본 보존 — 서비스 점검에서 확인).' }); return null; }
  if (registryLoadError()) { res.status(503).json({ ok: false, reason: '백업 대상 원장을 읽지 못한 상태라 저장하지 않습니다(손상본 보존).' }); return null; }
  let v;
  try { v = checkGroupInput({ ...(req.body || {}), vcenterId }, { selfId }); } catch (e) { sendBareosErr(res, e); return null; }
  const { unknown, need } = membersPlan(vcenterId, v.vmIds);
  if (unknown.length) { res.status(400).json({ ok: false, reason: `이 vCenter 의 인벤토리에 없는 VM 이 ${unknown.length}대 있습니다 — 화면을 새로 고친 뒤 다시 고르세요.` }); return null; }
  if (need.length > MAX_BULK) { res.status(400).json({ ok: false, reason: `새로 등록할 VM 이 ${need.length}대입니다 — 한 번에 ${MAX_BULK}대까지 등록할 수 있습니다.` }); return null; }
  const left = MAX_JOBS - jobDigests().length;
  if (need.length > left) { res.status(400).json({ ok: false, reason: `백업 대상은 ${MAX_JOBS}개까지입니다 — 지금 ${Math.max(0, left)}대만 더 등록할 수 있습니다(새로 등록할 VM ${need.length}대).` }); return null; }
  return v;
}

/** :id 로 그룹을 찾고 범위를 판정한다(조회 밖 404 → 쓰기 밖 403). 실패면 응답을 보내고 null. */
function groupFor(req, res, { write = true } = {}) {
  const g = getGroup(String(req.params.id || ''));
  if (!g) { res.status(404).json({ ok: false, reason: NOT_FOUND }); return null; }
  const a = bareosAccess(req.user, g.vcenterId, { write });
  if (a === 404) { res.status(404).json({ ok: false, reason: NOT_FOUND }); return null; }
  if (a === 403) { res.status(403).json({ ok: false, reason: READ_ONLY }); return null; }
  return g;
}

export function registerBareosGroups(api) {

/**
 * 법인 하나의 전체 VM 트리(시스템 VM 제외) + 그 법인의 그룹. Director 에 접속하지 않는다(원장·표시·인벤토리만).
 * 행: id·이름·폴더·전원·용량·백업 방식·등록 가능 여부·잡 요약(b — 법인별 현황과 같은 vmView 판정)·잡 스케줄·그룹.
 */
api.get('/tools/bareos-backup/groups/tree', adminOnly, (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vCenter 를 고르세요.' });
  if (bareosAccess(req.user, vcenterId, { write: false })) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const snap = store.get();
  const settings = effectiveSettings();
  const now = Date.now();
  const marksKnown = !marksUnreadable();
  const marks = marksKnown ? getMarks() : {};
  const jobs = new Map(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => [j.vmId, j]));
  const groups = listGroups().filter((g) => g.vcenterId === vcenterId);
  const groupOf = new Map();
  for (const g of groups) for (const id of g.vmIds) groupOf.set(id, g.id);
  const vms = [];
  const seen = new Set();
  for (const vm of snap?.vms || []) {
    if (vm.vcenterId !== vcenterId || isSystemVm(vm)) continue;
    seen.add(vm.id);
    const j = jobs.get(vm.id);
    const method = marksKnown ? String(marks[vm.id]?.method || '') : null;
    const el = j ? null : eligibility(vm, settings);
    vms.push({
      id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), power: vm.powerState || '', gb: gbOf(vm.storageGB),
      method, b: bareosVmView(j, method || '') ?? null,
      job: j ? { id: j.id, schedule: j.schedule || '', level: j.level || '', enabled: j.enabled !== false } : null,
      eligible: j ? true : el.ok, ...(j || el.ok ? {} : { reason: el.reason }),
      groupId: groupOf.get(vm.id) || '',
    });
  }
  // 잡은 있는데 인벤토리에 없는 VM(지워졌거나 옮겨짐) — 그룹에서 빼거나 원장을 정리할 수 있게 보인다
  for (const j of jobs.values()) {
    if (seen.has(j.vmId)) continue;
    const method = marksKnown ? String(marks[j.vmId]?.method || '') : null;
    vms.push({ id: j.vmId, name: String(j.vmName || ''), folder: String(j.folder || ''), power: '', gb: null, method, gone: true,
      b: bareosVmView(j, method || ''), job: { id: j.id, schedule: j.schedule || '', level: j.level || '', enabled: j.enabled !== false }, eligible: true, groupId: groupOf.get(j.vmId) || '' });
  }
  vms.sort((x, y) => x.folder.localeCompare(y.folder) || x.name.localeCompare(y.name));
  const si = siteInfo(vcenterId, settings);
  const vc = (snap?.vcenters || []).find((v) => v.id === vcenterId);
  res.json({
    ok: true, vcenterId, vcName: vc?.name || vcenterId, now, tz: serverTz(), catchupMs: CATCHUP_MS,
    director: si.view, mapped: !!si.site && !si.mappingMissing?.length, mappingMissing: si.mappingMissing, siteDefaults: si.site ? { storage: si.site.storage, pool: si.site.pool, schedule: si.site.schedule || '' } : null,
    writable: bareosAccess(req.user, vcenterId) === 0, marksKnown,
    groupsLoadError: !!groupsLoadError(), registryLoadError: !!registryLoadError(),
    limits: { maxMembers: MAX_MEMBERS, maxGroups: MAX_GROUPS, maxBulk: MAX_BULK, jobsLeft: Math.max(0, MAX_JOBS - jobDigests().length) },
    levels: LEVELS,
    vms, groups: groups.map((g) => groupView(g, now)),
  });
});

/** 그룹 편집 창의 스토리지·풀 목록 — 그 법인 Director 의 카탈로그(60초 기억). Director 에 접속한다(편집 창을 열 때 한 번). */
api.get('/tools/bareos-backup/groups/options', adminOnly, async (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  if (bareosAccess(req.user, vcenterId, { write: false })) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const si = siteInfo(vcenterId, effectiveSettings());
  if (!si.site || !si.view) return res.status(409).json({ ok: false, reason: '이 vCenter 가 어느 법인 Director 에도 묶여 있지 않습니다 — 설정 › 법인별 Director 에서 먼저 묶으세요.' });
  try {
    const c = await bareosCatalogOf(directorById(si.view.id, effectiveSettings()), req.query.refresh === '1');
    res.json({ ok: true, storages: c.storages ?? null, pools: c.pools ?? null, errors: { ...(c.errors?.storages ? { storages: c.errors.storages } : {}), ...(c.errors?.pools ? { pools: c.errors.pools } : {}) } });
  } catch (e) { sendBareosErr(res, e); }
});

/** 새 그룹 — body { vcenterId, name, vmIds, schedule, storage?, pool? }. 잡 없는 VM 은 먼저 등록(Director 스케줄 없이)하고, 등록된 VM 만 그룹에 넣는다. */
api.post('/tools/bareos-backup/groups', adminOnly, async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '');
  const v = precheck(req, res, vcenterId); if (!v) return;
  const si = siteInfo(vcenterId, effectiveSettings());
  if (!si.site) return res.status(409).json({ ok: false, reason: '이 vCenter 가 어느 법인 Director 에도 묶여 있지 않습니다 — 설정 › 법인별 Director 에서 먼저 묶으세요.' });
  const reg = await registerMissing(req, vcenterId, v.vmIds, v.schedule.level);
  if (!reg.members.length) return res.status(409).json({ ok: false, reason: '백업 대상으로 등록된 VM 이 하나도 없어 그룹을 만들지 않았습니다 — VM 별 사유를 보세요.', registered: reg.registered, excluded: reg.excluded });
  let g;
  try {
    g = addGroup({ ...v, vcenterId, vmIds: reg.members }, { by: req.user?.username || '', directorId: si.site.directorId });
  } catch (e) {
    // 등록한 잡은 남는다(백업 대상 탭에 보인다) — 숨기지 않고 알린다
    audit(req, 'Bareos 백업 그룹 만들기', `${vcenterId}/${v.name}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    return res.status(e?.code === 'conflict' ? 409 : e?.code === 'unavailable' ? 503 : 400).json({ ok: false, reason: `${String(e?.message || e).slice(0, 400)}${reg.registered.some((r) => r.ok) ? ' (이번에 등록한 백업 대상은 남아 있습니다 — 백업 대상 탭)' : ''}`, registered: reg.registered });
  }
  audit(req, 'Bareos 백업 그룹 만들기', `${vcenterId}/${g.name}`, `VM ${g.vmIds.length}대 · ${scheduleText(g.schedule)}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''}${reg.excluded.length ? ` · 등록 실패로 뺀 VM ${reg.excluded.length}대` : ''}`);
  res.status(201).json({ ok: true, group: groupView(g), registered: reg.registered, excluded: reg.excluded, doubleScheduled: g.schedule.enabled ? doubleScheduled(vcenterId, g.vmIds) : [] });
});

/** 그룹 고치기 — body { name, vmIds, schedule, storage?, pool? }(전부 보낸다 — 화면이 편집 창의 값 전체를 보낸다). 새 VM 은 등록 뒤 넣는다. */
api.put('/tools/bareos-backup/groups/:id', adminOnly, async (req, res) => {
  const g0 = groupFor(req, res); if (!g0) return;
  const v = precheck(req, res, g0.vcenterId, { selfId: g0.id }); if (!v) return;
  const reg = await registerMissing(req, g0.vcenterId, v.vmIds, v.schedule.level);
  if (!reg.members.length) return res.status(409).json({ ok: false, reason: '백업 대상으로 등록된 VM 이 하나도 없어 저장하지 않았습니다 — VM 별 사유를 보세요.', registered: reg.registered, excluded: reg.excluded });
  let g;
  try {
    g = updateGroup(g0.id, { ...v, vmIds: reg.members }, { by: req.user?.username || '' });
  } catch (e) {
    audit(req, 'Bareos 백업 그룹 고치기', `${g0.vcenterId}/${g0.name}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    return res.status(e?.code === 'conflict' ? 409 : e?.code === 'unavailable' ? 503 : 400).json({ ok: false, reason: String(e?.message || e).slice(0, 400), registered: reg.registered });
  }
  if (!g) return res.status(404).json({ ok: false, reason: '그사이 그룹이 지워졌습니다.' });
  const added = g.vmIds.filter((id) => !g0.vmIds.includes(id)).length;
  const removed = g0.vmIds.filter((id) => !g.vmIds.includes(id)).length;
  audit(req, 'Bareos 백업 그룹 고치기', `${g.vcenterId}/${g.name}`,
    `${g0.name !== g.name ? `이름 ${g0.name} → ${g.name} · ` : ''}VM ${g.vmIds.length}대(+${added} −${removed}) · ${scheduleText(g.schedule)}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''}`);
  res.json({ ok: true, group: groupView(g), registered: reg.registered, excluded: reg.excluded, doubleScheduled: g.schedule.enabled ? doubleScheduled(g.vcenterId, g.vmIds) : [] });
});

/** 그룹 지우기 — 그룹만 지운다(백업 대상·Director 잡·백업 데이터는 그대로). 실행 중이면 409. */
api.delete('/tools/bareos-backup/groups/:id', adminOnly, (req, res) => {
  const g = groupFor(req, res); if (!g) return;
  if (groupRunning(g.id)) return res.status(409).json({ ok: false, reason: '이 그룹을 실행하는 중입니다 — 끝난 뒤 지우세요.' });
  let ok;
  try { ok = deleteGroup(g.id); } catch (e) { return sendBareosErr(res, e); }
  if (!ok) return res.status(404).json({ ok: false, reason: NOT_FOUND });
  audit(req, 'Bareos 백업 그룹 지우기', `${g.vcenterId}/${g.name}`, `VM ${g.vmIds.length}대 — 백업 대상·Director 잡은 남김`);
  res.json({ ok: true });
});

/**
 * 지금 실행 — body { level? }. 고RTT·엣지 대행 법인은 몇 분 걸릴 수 있어 **바로 202** 를 돌려주고 뒤에서 보낸다
 * (결과는 그룹의 lastFire · 화면이 실행 중인 동안 다시 읽는다). 같은 그룹이 실행 중이면 409.
 */
api.post('/tools/bareos-backup/groups/:id/run', adminOnly, (req, res) => {
  const g = groupFor(req, res); if (!g) return;
  if (groupRunning(g.id)) return res.status(409).json({ ok: false, reason: `‘${g.name}’ 그룹을 실행하는 중입니다 — 끝난 뒤 다시 시도하세요.` });
  if (registryLoadError()) return res.status(503).json({ ok: false, reason: '백업 대상 원장을 읽지 못한 상태라 실행하지 않습니다(손상본 보존).' });
  const level = req.body?.level ? String(req.body.level) : null;
  if (level && !LEVELS.includes(level)) return res.status(400).json({ ok: false, reason: `레벨은 ${LEVELS.join('·')} 중 하나입니다.` });
  runGroup(g.id, { trigger: 'manual', by: req.user?.username || '', level }).catch((e) => console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 수동 실행 실패: ${String(e?.message || e).slice(0, 200)}`));
  res.status(202).json({ ok: true, started: true, group: groupView(getGroup(g.id) || g) });
});

}
