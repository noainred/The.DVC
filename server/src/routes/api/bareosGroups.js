// Bareos 백업 그룹 라우트(v2.830 · 사용자 요청 '전체 VM 트리에서 고른 VM 을 그룹으로 — 이름·스케줄·스토리지 지정, 나중에 수정').
// 도구 키 bareos-backup(관리자 전용 — 경로 첫 마디 규약)의 '백업 그룹' 탭. 범위: 그룹은 vCenter(= 법인) 귀속 — 조회 밖 404 → 쓰기 밖 403(bareosAccess 하나).
// 스케줄은 포탈이 돌린다(bareos/groupRunner.js — Bareos 에 잡 스케줄 수정 명령이 없어 '나중에 수정' 을 지키려면 이 방식뿐이다).
// 그룹 VM 중 잡이 없는 VM 은 저장 때 **Director 스케줄 없이** 등록한다(그룹 스케줄과 Director 스케줄이 겹쳐 두 번 돌지 않게).
import { requireRole, verifyUserOtp, getUser } from '../../auth/auth.js';
import { config } from '../../config.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { bareosAccess, sendBareosErr, MAX_BULK } from './bareosBackup.js';
import { effectiveSettings, isDemoActive, eligibility, createBackupTargets, onDirector } from '../../bareos/service.js';
import { relayLimits } from '../../bareos/edgeOps.js';
import { directorById, directorConn, siteMissing } from '../../bareos/settings.js';
import { jobDigests, MAX_JOBS, registryLoadError } from '../../bareos/registry.js';
import { listGroups, getGroup, addGroup, updateGroup, deleteGroup, checkGroupInput, groupsLoadError, MAX_MEMBERS, MAX_GROUPS, FIRES_KEEP } from '../../bareos/groups.js';
import { nextSlot, scheduleText, slotKey, CATCHUP_MS, LEVELS } from '../../bareos/groupSchedule.js';
import { queueGroupRun, groupRunning, groupPruning, previewPrune } from '../../bareos/groupRunner.js';
import { keepText, keepOtpReasons, normKeep, KEEP_MIN, KEEP_MAX, KEEP_PRESETS } from '../../bareos/groupRetention.js';
import { bareosVmView } from '../../bareos/vmView.js';
import { getMarks, marksUnreadable } from '../../veeam/backupMarks.js';
import { isSystemVm } from '../../veeam/backupStatus.js';
import { poolPolicyOf, jobPolicyResolver } from '../../bareos/policy.js';
import { pollerStatus } from '../../bareos/poller.js';
import { directorInfo } from './bareosViews.js';

const adminOnly = requireRole('admin');
/**
 * 조회(GET)용 Director 작업 — 데모 계정은 데모 Director 일 때만 접속한다(bareosBackup.js 와 같은 모양 — audit2719b 스윕이 대조).
 * v2.830 검토 H1(확인): 처음에는 카탈로그 헬퍼를 데모 필터 없이 불러 데모 계정이 사람이 등록한 Director 에 접속할 수 있었다.
 */
const readDirector = ({ demoOnly = false } = {}, directorId, kind, args) => onDirector(directorId, kind, args, { demoOnly });
const READ_ONLY = '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다(Bareos 백업 그룹은 쓰기 범위가 필요합니다).';
const NOT_FOUND = '백업 그룹을 찾을 수 없습니다.';
const gbOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);
const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail, ip: req.ip || '' });
/** 서버 현지 시간대 — 스케줄 시각의 기준(화면이 밝힌다). */
const serverTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

/** 그룹 → 응답(비밀 없음 — 원장에 비밀이 없다). 다음 회차·실행 중 여부를 덧붙인다. */
export function groupView(g, now = Date.now()) {
  const next = nextSlot(g.schedule, now);
  // 버그 점검 S6: 마지막으로 처리한 회차가 지금보다 미래 — 서버 시계가 앞섰다 돌아왔다. 그 사이 회차는 돌지 않는다(한 번 이하를 지키려고 열쇠를 내리지 않는다) — 화면이 알린다
  const clockAhead = !!g.lastKey && g.lastKey > slotKey(now);
  return {
    ...g, keep: g.keep ?? null, fires: Array.isArray(g.fires) ? g.fires : [], lastPrune: g.lastPrune ?? null, keepText: keepText(g.keep ?? null),
    scheduleText: scheduleText(g.schedule), next: next ? { at: next.at, key: next.key, level: next.level } : null, running: groupRunning(g.id),
    ...(groupPruning(g.id) ? { pruning: true } : {}), ...(clockAhead ? { clockAhead: true } : {}),
  };
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
  const vms = (store.get()?.vms || []).filter((v) => v.vcenterId === vcenterId);
  const inv = new Set(vms.map((v) => v.id));
  const system = new Set(vms.filter(isSystemVm).map((v) => v.id));   // v2.830 검토 L6: 화면 트리만 거르면 API 로 vCLS 를 넣을 수 있었다
  const jobs = new Set(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => j.vmId));
  const unknown = vmIds.filter((id) => !inv.has(id) && !jobs.has(id));
  const need = vmIds.filter((id) => !jobs.has(id) && inv.has(id));
  return { need, unknown, system: vmIds.filter((id) => system.has(id)) };
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

/**
 * v2.846 버그 점검(D-9): 그룹에서 빠지면(그룹 삭제 · 편집에서 VM 빼기) **어떤 예약에도 걸리지 않는** VM — 그룹 잡은 Director 스케줄 없이 등록했고(registerMissing),
 * 다른 그룹에도 없다. 확인 창은 '백업 대상과 데이터는 남는다' 만 말해 백업이 계속되는 것처럼 읽혔다(알아채는 것은 RPO '오래된 백업' 뒤) — 응답·감사·화면이 수를 밝힌다.
 * 웹 bareosGroupText.unscheduledAfter 와 같은 판정(잡 있음 · 켜짐 · Director 스케줄 없음 · 다른 그룹 아님 — 시험이 같은 입력으로 대조).
 * @returns {{ count: number, names: string[] }}
 */
function unscheduledAfter(vcenterId, vmIds, exceptGroupId) {
  const others = new Set();
  for (const g of listGroups()) if (g.id !== exceptGroupId && g.vcenterId === vcenterId) for (const id of g.vmIds || []) others.add(id);
  const jobs = new Map(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => [j.vmId, j]));
  const hit = [];
  for (const id of vmIds) { const j = jobs.get(id); if (j && j.enabled !== false && !j.schedule && !others.has(id)) hit.push(j.vmName || id); }
  return { count: hit.length, names: hit.slice(0, 20) };
}
/** 응답·감사 문구(웹 bareosGroupText.unscheduledText 와 같은 글자). */
export const unscheduledText = (n) => (n > 0 ? `스케줄 없는 잡 ${n}개 — 이후 예약 백업 없음` : '');

/** 저장 요청 판정 공통(범위·원장·입력). 실패면 응답을 보내고 null. */
function precheck(req, res, vcenterId, { selfId = '' } = {}) {
  const a = bareosAccess(req.user, vcenterId);
  if (a === 404) { res.status(404).json({ ok: false, reason: selfId ? NOT_FOUND : 'vCenter 를 찾을 수 없습니다.' }); return null; }
  if (a === 403) { res.status(403).json({ ok: false, reason: READ_ONLY }); return null; }
  if (groupsLoadError()) { res.status(503).json({ ok: false, reason: '백업 그룹 원장을 읽지 못한 상태라 저장하지 않습니다(손상본 보존 — 서비스 점검에서 확인).' }); return null; }
  if (registryLoadError()) { res.status(503).json({ ok: false, reason: '백업 대상 원장을 읽지 못한 상태라 저장하지 않습니다(손상본 보존).' }); return null; }
  let v;
  try { v = checkGroupInput({ ...(req.body || {}), vcenterId }, { selfId }); } catch (e) { sendBareosErr(res, e); return null; }
  const { unknown, need, system } = membersPlan(vcenterId, v.vmIds);
  if (system.length) { res.status(400).json({ ok: false, reason: `시스템 VM(템플릿·vCLS) ${system.length}대는 그룹에 넣을 수 없습니다.` }); return null; }
  if (unknown.length) { res.status(400).json({ ok: false, reason: `이 vCenter 의 인벤토리에 없는 VM 이 ${unknown.length}대 있습니다 — 화면을 새로 고친 뒤 다시 고르세요.` }); return null; }
  if (need.length > MAX_BULK) { res.status(400).json({ ok: false, reason: `새로 등록할 VM 이 ${need.length}대입니다 — 한 번에 ${MAX_BULK}대까지 등록할 수 있습니다.` }); return null; }
  const left = MAX_JOBS - jobDigests().length;
  if (need.length > left) { res.status(400).json({ ok: false, reason: `백업 대상은 ${MAX_JOBS}개까지입니다 — 지금 ${Math.max(0, left)}대만 더 등록할 수 있습니다(새로 등록할 VM ${need.length}대).` }); return null; }
  return v;
}

/**
 * v2.831.1 보관 개수 저장의 본인 OTP(사용자 결정) — 지워질 수 있는 범위가 넓어지는 저장만(groupRetention.keepOtpReasons).
 * 입력·범위·원장 검사(precheck)를 **통과한 뒤**, Director 에 닿기 전(잡 등록 전)에 본다 — 1회용 코드를 입력 실수로 태우지 않고,
 * OTP 가 틀리면 아무것도 등록·저장하지 않는다. 코드를 보내지 않았으면 검증을 부르지 않는다(실패 횟수를 올리지 않게 — 화면이 입력 칸을 연다).
 * @returns {{ ok: true, used: boolean } | null}  null = 응답을 이미 보냈다
 */
function keepOtpGate(req, res, prev, v, vcenterId) {
  const jobs = new Set(jobDigests().filter((j) => j.vcenterId === vcenterId).map((j) => j.vmId));
  const reasons = keepOtpReasons(prev, v, (id) => jobs.has(id));
  if (!reasons.length || !config.auth.enabled) return { ok: true, used: false };
  const name = req.user?.username || '';
  const why = reasons.join(' · ');
  if (!getUser(name)?.totpEnabled) { res.status(403).json({ ok: false, needOtp: true, needEnroll: true, reasons, reason: `이 저장(${why})은 본인 OTP 가 필요합니다 — OTP 가 등록된 계정만 할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.` }); return null; }
  const code = String(req.body?.otp ?? '').trim();
  if (!code) { res.status(403).json({ ok: false, needOtp: true, reasons, reason: `이 저장(${why})은 오래된 백업을 지울 수 있어 본인 OTP 가 필요합니다 — OTP 6자리를 입력하세요.` }); return null; }
  const r = verifyUserOtp(name, code);
  if (!r.ok) { res.status(403).json({ ok: false, needOtp: true, reasons, reason: `OTP 인증 실패 — ${r.reason}` }); return null; }
  return { ok: true, used: true };
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
  // v2.846 버그 점검(U-9): Director 상태(인증 정지 · 조회 실패 · 미설정)면 원장의 결과는 마지막으로 읽은 값이다 — 통합·법인별 현황과 같은 판정
  //   (bareosViews.directorInfo → vmView.directorState)으로 resultsKnown 을 실어 화면이 '성공 n/n'(초록) 대신 '모름' 으로 그리게 한다.
  let dirSt = null;
  try { const di = directorInfo(vcenterId, settings, pollerStatus(), isDemoActive()); dirSt = { state: di.state, resultsKnown: di.resultsKnown }; } catch { dirSt = { state: 'error', resultsKnown: false }; }
  res.json({
    ok: true, vcenterId, vcName: vc?.name || vcenterId, now, tz: serverTz(), catchupMs: CATCHUP_MS,
    director: si.view ? { ...si.view, ...dirSt } : null, directorState: dirSt, mapped: !!si.site && !si.mappingMissing?.length, mappingMissing: si.mappingMissing, siteDefaults: si.site ? { storage: si.site.storage, pool: si.site.pool, schedule: si.site.schedule || '' } : null,
    writable: bareosAccess(req.user, vcenterId) === 0, marksKnown,
    groupsLoadError: !!groupsLoadError(), registryLoadError: !!registryLoadError(),
    limits: { maxMembers: MAX_MEMBERS, maxGroups: MAX_GROUPS, firesKeep: FIRES_KEEP, maxBulk: MAX_BULK, jobsLeft: Math.max(0, MAX_JOBS - jobDigests().length) },
    levels: LEVELS, keepLimits: { min: KEEP_MIN, max: KEEP_MAX, presets: KEEP_PRESETS }, relayLimits: relayLimits(),   // 화면이 저장(등록)·실행을 기다리는 시간 — 숫자를 화면에 박지 않는다
    // v2.840 그룹 카드 '적용 풀 · 보존' — 그 Director 정책 수집본(접속하지 않는다 · 수집 전이면 null). 풀 = 그룹 풀 → 법인 매핑 풀(잡 기본값).
    //   dupVms = 그룹 예약이 켜져 있고 잡이 Director 스케줄(수집본)에도 든 멤버 수 — 두 곳에서 돌 수 있다(jobPolicyResolver.dup · 그 Director 수집본이 없으면 0 이 아니라 null)
    vms, groups: (() => {
      let resolve = null;
      try { resolve = jobPolicyResolver({ settings, groups, now }); } catch { resolve = null; }
      return groups.map((g) => {
        const poolName = g.pool || si.site?.pool || '';
        const dirId = g.directorId || si.site?.directorId || '';
        let pp = null; try { pp = poolPolicyOf(dirId, poolName); } catch { pp = null; }
        let dupVms = null;
        if (resolve) {
          let known = false; let n = 0;
          for (const id of g.vmIds) { const j = jobs.get(id); if (!j) continue; const r = resolve(j, null); if (r.collected) known = true; if (r.dup) n++; }
          dupVms = known ? n : null;
        }
        return { ...groupView(g, now), poolPolicy: pp ? { ...pp, from: g.pool ? 'group' : 'site' } : null, dupVms };
      });
    })(),
  });
});

/**
 * 그룹 편집 창의 스토리지·풀 목록 — 그 법인 Director 의 카탈로그. Director 에 접속한다(편집 창을 열 때 한 번 · 기억 없음).
 * 범위: 조회 범위 안 법인의 Director 만(1:1:1 — 그 법인의 이름들). 이름만 돌려주고 클라이언트·잡 목록은 싣지 않는다.
 */
api.get('/tools/bareos-backup/groups/options', adminOnly, async (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  if (bareosAccess(req.user, vcenterId, { write: false })) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const si = siteInfo(vcenterId, effectiveSettings());
  if (!si.site || !si.view) return res.status(409).json({ ok: false, reason: '이 vCenter 가 어느 법인 Director 에도 묶여 있지 않습니다 — 설정 › 법인별 Director 에서 먼저 묶으세요.' });
  try {
    const c = await readDirector({ demoOnly: isDemoGuest(req.user) }, si.view.id, 'catalog');
    res.json({ ok: true, storages: c.storages ?? null, pools: c.pools ?? null, errors: { ...(c.errors?.storages ? { storages: c.errors.storages } : {}), ...(c.errors?.pools ? { pools: c.errors.pools } : {}) } });
  } catch (e) { sendBareosErr(res, e); }
});

/** 새 그룹 — body { vcenterId, name, vmIds, schedule, storage?, pool?, keep? }(keep: 보관 개수 · 비우면 제한 없음). 잡 없는 VM 은 먼저 등록(Director 스케줄 없이)하고, 등록된 VM 만 그룹에 넣는다. */
api.post('/tools/bareos-backup/groups', adminOnly, async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '');
  const v = precheck(req, res, vcenterId); if (!v) return;
  const si = siteInfo(vcenterId, effectiveSettings());
  if (!si.site) return res.status(409).json({ ok: false, reason: '이 vCenter 가 어느 법인 Director 에도 묶여 있지 않습니다 — 설정 › 법인별 Director 에서 먼저 묶으세요.' });
  const og = keepOtpGate(req, res, null, v, vcenterId); if (!og) return;
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
  audit(req, 'Bareos 백업 그룹 만들기', `${vcenterId}/${g.name}`, `VM ${g.vmIds.length}대 · ${scheduleText(g.schedule)} · ${keepText(g.keep)}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''}${reg.excluded.length ? ` · 등록 실패로 뺀 VM ${reg.excluded.length}대` : ''}${og.used ? ' · 본인 OTP 확인' : ''}`);
  res.status(201).json({ ok: true, group: groupView(g), registered: reg.registered, excluded: reg.excluded, doubleScheduled: g.schedule.enabled ? doubleScheduled(vcenterId, g.vmIds) : [] });
});

/** 그룹 고치기 — body { name, vmIds, schedule, storage?, pool? }(전부 보낸다 — 화면이 편집 창의 값 전체를 보낸다). 새 VM 은 등록 뒤 넣는다. */
api.put('/tools/bareos-backup/groups/:id', adminOnly, async (req, res) => {
  const g0 = groupFor(req, res); if (!g0) return;
  const expect = req.body?.updatedAt != null && Number.isFinite(Number(req.body.updatedAt)) ? Number(req.body.updatedAt) : null;
  // 버그 점검 S10: 대조를 등록(Director 호출) **전에** — 예전에는 새 VM 을 Director 에 등록한 뒤 409 를 돌려 잡만 생기고 그룹에는 없었다
  if (expect != null && g0.updatedAt !== expect) {
    return res.status(409).json({ ok: false, reason: `그사이 다른 화면에서 ‘${g0.name}’ 그룹을 고쳤습니다(${g0.updatedBy || '?'}) — 새로 고친 뒤 다시 저장하세요(그대로 덮어쓰면 그쪽에서 넣은 VM 이 빠질 수 있습니다).`, conflict: true });
  }
  const v = precheck(req, res, g0.vcenterId, { selfId: g0.id }); if (!v) return;
  const og = keepOtpGate(req, res, g0, v, g0.vcenterId); if (!og) return;
  const reg = await registerMissing(req, g0.vcenterId, v.vmIds, v.schedule.level);
  if (!reg.members.length) return res.status(409).json({ ok: false, reason: '백업 대상으로 등록된 VM 이 하나도 없어 저장하지 않았습니다 — VM 별 사유를 보세요.', registered: reg.registered, excluded: reg.excluded });
  let g;
  try {
    const jobsNow = new Set(jobDigests().filter((j) => j.vcenterId === g0.vcenterId).map((j) => j.vmId));
    const check = (cur, nv) => (!og.used && config.auth.enabled && keepOtpReasons(cur, nv, (id) => jobsNow.has(id) && !reg.registered.some((r) => r.ok && r.vmId === id)).length
      ? '그사이 다른 화면에서 이 그룹의 보관 개수·VM 이 바뀌어 이 저장에는 본인 OTP 가 필요합니다 — 새로 고친 뒤 다시 저장하세요.' : '');
    g = updateGroup(g0.id, { ...v, vmIds: reg.members }, { by: req.user?.username || '', expectUpdatedAt: expect, check });
  } catch (e) {
    audit(req, 'Bareos 백업 그룹 고치기', `${g0.vcenterId}/${g0.name}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    return res.status(e?.code === 'conflict' ? 409 : e?.code === 'unavailable' ? 503 : 400).json({ ok: false, reason: String(e?.message || e).slice(0, 400), registered: reg.registered });
  }
  if (!g) {
    // 버그 점검 S9: 저장하는 사이 그룹이 지워졌다 — 이번에 등록한 백업 대상은 남는다(숨기지 않고 알린다)
    audit(req, 'Bareos 백업 그룹 고치기', `${g0.vcenterId}/${g0.name}`, '실패 — 저장하는 사이 그룹이 지워짐');
    return res.status(404).json({ ok: false, reason: `그사이 그룹이 지워졌습니다.${reg.registered.some((r) => r.ok) ? ' 이번에 등록한 백업 대상은 남아 있습니다(백업 대상 탭).' : ''}`, registered: reg.registered });
  }
  const added = g.vmIds.filter((id) => !g0.vmIds.includes(id)).length;
  const removedIds = g0.vmIds.filter((id) => !g.vmIds.includes(id));
  const removed = removedIds.length;
  const uns = unscheduledAfter(g.vcenterId, removedIds, g.id);   // D-9: 뺀 VM 중 이제 어떤 예약에도 없는 잡
  audit(req, 'Bareos 백업 그룹 고치기', `${g.vcenterId}/${g.name}`,
    `${g0.name !== g.name ? `이름 ${g0.name} → ${g.name} · ` : ''}VM ${g.vmIds.length}대(+${added} −${removed}) · ${scheduleText(g.schedule)} · ${(g0.keep ?? null) !== (g.keep ?? null) ? `보관 ${keepText(g0.keep ?? null)} → ${keepText(g.keep ?? null)}` : keepText(g.keep ?? null)}${g.storage ? ` · 스토리지 ${g.storage}` : ''}${g.pool ? ` · 풀 ${g.pool}` : ''}${og.used ? ' · 본인 OTP 확인' : ''}${uns.count ? ` · 뺀 VM 중 ${unscheduledText(uns.count)}` : ''}`);
  res.json({ ok: true, group: groupView(g), registered: reg.registered, excluded: reg.excluded, doubleScheduled: g.schedule.enabled ? doubleScheduled(g.vcenterId, g.vmIds) : [], unscheduled: uns });
});

/** 그룹 지우기 — 그룹만 지운다(백업 대상·Director 잡·백업 데이터는 그대로). 실행 중이면 409. */
api.delete('/tools/bareos-backup/groups/:id', adminOnly, (req, res) => {
  const g = groupFor(req, res); if (!g) return;
  if (groupRunning(g.id)) return res.status(409).json({ ok: false, reason: '이 그룹을 실행·정리하는 중입니다 — 끝난 뒤 지우세요.' });
  let ok;
  try { ok = deleteGroup(g.id); } catch (e) { return sendBareosErr(res, e); }
  if (!ok) return res.status(404).json({ ok: false, reason: NOT_FOUND });
  const uns = unscheduledAfter(g.vcenterId, g.vmIds, g.id);   // D-9: 지운 뒤(그룹은 이미 없다) 어떤 예약에도 없는 잡
  audit(req, 'Bareos 백업 그룹 지우기', `${g.vcenterId}/${g.name}`, `VM ${g.vmIds.length}대 — 백업 대상·Director 잡은 남김${uns.count ? ` · ${unscheduledText(uns.count)}` : ''}`);
  res.json({ ok: true, unscheduled: uns });
});

/**
 * v2.843 보관 정리 미리 보기 — body { keep? }(저장 전 화면 값 · 없으면 그룹 값). **읽기 전용**(지우지 않는다 · 감사 없음 · OTP 없음)이라 조회 범위로 보고,
 * 데모 계정은 데모 Director 에만(readDirector 와 같은 demoOnly). Director 일은 그 법인 쪽에서(엣지 대행이면 엣지가 로컬 Director 로 — 사용자 원칙 '백업은 법인 로컬').
 * 결과를 기다려 돌려준다(그룹 VM 수만큼 Director 조회 — 대행이면 엣지 인출·회신 대기 포함 · 화면은 relayLimits 만큼 기다린다).
 */
api.post('/tools/bareos-backup/groups/:id/prune-preview', adminOnly, async (req, res) => {
  const g = groupFor(req, res, { write: false }); if (!g) return;
  let keep;
  try { keep = req.body && Object.prototype.hasOwnProperty.call(req.body, 'keep') ? normKeep(req.body.keep) : undefined; } catch (e) { return sendBareosErr(res, e); }
  try {
    const r = await previewPrune(g.id, { keep, demoOnly: isDemoGuest(req.user) });
    res.json({ ok: true, groupId: g.id, at: Date.now(), ...r });
  } catch (e) { sendBareosErr(res, e); }
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
  // 같은 Director 의 다른 그룹(예약)과 같은 줄에 선다(버그 점검 S8 — 수동 실행이 줄 밖에서 같은 Director 에 세션을 동시에 열었다)
  queueGroupRun(g.id, { trigger: 'manual', by: req.user?.username || '', level }).catch((e) => console.warn(`[bareos] 백업 그룹 ‘${g.name}’ 수동 실행 실패: ${String(e?.message || e).slice(0, 200)}`));
  res.status(202).json({ ok: true, started: true, group: groupView(getGroup(g.id) || g) });
});

}
