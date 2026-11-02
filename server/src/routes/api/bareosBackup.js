// Bareos VM 백업 라우트 — 특수 기능 'Bareos VM 백업'(v2.820, 도구 키 bareos-backup · v2.823 법인별 Director).
// 전부 admin 전용: Director 에 잡을 만들고 백업·복원을 실행하는 운영 작업이다(vm-clone 과 같은 등급 — server/CLAUDE.md RBAC).
// 범위: 백업 대상은 vCenter 귀속 — 조회 범위 밖 404(존재 은닉) → 쓰기 범위 밖 403. Director 설정·카탈로그·자동 설정은 전 법인 설정이라
//   전체 범위 전용(fullScopeOnly) · 그중 쓰기(Director·매핑·자동 설정)는 쓰기 범위도 무제한(fullWriteOnly — v2.823 검토 S2). 예외: /badges 는 트리(전 사용자) 표시용 — 로그인 + tools 권한, 범위 밖은 빈 목록.
// v2.823: 법인마다 Director 하나. 잡 라우트는 **원장에 고정된 그 잡의 Director**(settings.jobDirectorId)로만 명령을 보낸다(요청 값으로 고르지 않는다).
// 복원은 파괴적일 수 있어 **본인 OTP 재인증**을 더 건다(hostaccess 의 적용 경로와 같은 패턴).
import crypto from 'node:crypto';
import { requireRole, requirePerm, verifyUserOtp, getUser } from '../../auth/auth.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { memoJson, scopeKey } from './shared.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import {
  publicSettings, publicDirector, saveSettings, addDirector, updateDirector, checkDirectorUpdate, deleteDirector, settingsLoadError, settingsRev,
  directorConn, directorCred, directorById, loadSettings, jobDirectorId, siteMissing, anyDirectorConfigured, LIMITS,
} from '../../bareos/settings.js';
import {
  listJobs, getJob, patchJob, deleteJob, markPending, addRestore, registryLoadError, jobVmIds, MAX_JOBS, restoreOpen, clearPending, applyRunRow, applyRestoreRow, registryRev, inBatch,
} from '../../bareos/registry.js';
import { parseBanner } from '../../bareos/director.js';
import { diagnoseConsole, DIAG_STAGES } from '../../bareos/console.js';
import { secretProvided } from '../../util/secretCarry.js';
import {
  onDirector, relayToEdge, isDemoActive, effectiveSettings, eligibility, createBackupTarget, createBackupTargets, bareosAuthGuard, clearAuthStopIfSame,
} from '../../bareos/service.js';
import { pendingView, relayLimits } from '../../bareos/edgeOps.js';
import { noteSetupStart, noteSetupEnd, noteRestoreBatchStart, noteRestoreBatchEnd } from '../../bareos/inflight.js';
import { claimSetup, releaseSetupLock, isSetupBusy, setupBusyReason } from '../../bareos/setupLocks.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { listInventory } from '../../central/inventory.js';
import { pickAgent } from '../../cvp/formChoices.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { pollerStatus, pollOnce, requestReconcile } from '../../bareos/poller.js';
import { restorePlan, placementDrift, bulkRestorePlan, BULK_RESTORE_MAX } from '../../bareos/restore.js';
import { finishRestores } from '../../bareos/restoreFinish.js';
import { savePolicy, policyLoadError, rehearsalStatus, runNow as runRehearsalNow, normPolicy, rehearsalBusy } from '../../bareos/rehearsal.js';
import { loadDigest, saveDigest, digestLoadError, digestStatus, sendDigestNow, normDigest } from '../../bareos/digest.js';
import { osFields } from '../../inventory/osKind.js';
import { numOrNull } from '../../util/numOrNull.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { normLevel } from '../../bareos/names.js';
import { authStopView } from '../../util/authGuard.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { bareosSetupOtpRequired } from '../../security/securitySettings.js';
import {
  planDirector, setupDirector, planFdIni, setupFdIni, readFdThumbprint, preflight, planFdPlugin, setupFdPlugin, VMWARE_POOL_FULL, VMWARE_SCHEDULE, newConsolePassword,
} from '../../bareos/autoSetup.js';
import { isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { tryLockJob, unlockJob } from '../../bareos/jobLocks.js';
import { jobPolicyResolver, policyRev } from '../../bareos/policy.js';
import { listGroups, groupsLoadError, groupsRev } from '../../bareos/groups.js';
import { getMarks, marksUnreadable, marksRev } from '../../veeam/backupMarks.js';
import { registryHosts, vcHostOf } from '../../bareos/vcHost.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('Bareos Director 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
/**
 * v2.823 검토(S2 — 재현): fullScopeOnly 는 조회 범위만 본다 — 조회 무제한 + writeVcenters(쓰기 범위 지정) 계정이 다른 법인 Director 의 주소를
 * 바꿔 비밀번호를 폐기하거나(백업 정지) 쓰기 범위 밖 vCenter 매핑의 client·configFile 을 바꾸고 자동 설정까지 할 수 있었다(같은 계정의 잡 실행은 403).
 * Director 설정·매핑·자동 설정은 전 법인 공용 쓰기라 **쓰기 범위도 무제한**인 계정만 받는다(server/CLAUDE.md v2.733 — 바깥 조건을 조회 범위로만 두지 않는다).
 */
function fullWriteOnly(req, res, next) {
  let w = null;
  try { w = writeScopedVcenterIds(req.user, store.get()); } catch { w = new Set(); }   // 판정이 던지면 거부 기본값
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: 'Bareos Director 설정·매핑·자동 설정은 전 법인 공용 쓰기라 쓰기 범위(수정 가능 vCenter)가 지정되지 않은 계정만 바꿀 수 있습니다.' });
  next();
}
/** 설정 세대 표지 — 프로세스마다 다른 접두(재시작 뒤 우연히 같은 번호로 옛 화면의 저장이 통과하지 않게). */
const REV_BOOT = crypto.randomBytes(4).toString('hex');
const revToken = () => `${REV_BOOT}.${settingsRev()}`;
const READ_ONLY = '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다(Bareos 백업·복원은 쓰기 범위가 필요합니다).';
const MAX_CANDIDATES = 5000;
/** v2.822 일괄 등록 한 번의 상한 — Veeam 백업 실행(backupRun MAX_BACKUP_VMS)과 같은 값. 화면은 응답의 maxBulk 를 쓴다(숫자를 박지 않는다). */
export const MAX_BULK = 200;
/** 실행 이력·복원 지점 — 화면은 응답의 limit 를 쓴다(숫자를 박지 않는다 — W16). */
export const HISTORY_LIMIT = 30;
export const RESTORE_POINTS_SCAN = 60;
/** 카탈로그 기억 시간 — 키는 Director id + 설정 세대(설정을 저장하면 새로 읽는다 — P9). */
const CATALOG_TTL_MS = 60_000;

/** 조회 밖 404 → 쓰기 밖 403 → 0(허용). 대상 vCenter 가 없으면 범위 계정에는 밖이다(server/CLAUDE.md v2.733). */
export function bareosAccess(user, vcenterId, { write = true } = {}) {
  const snap = store.get();
  const id = String(vcenterId || '');
  const read = scopedVcenterIds(user, snap);
  if (read && (!id || !read.has(id))) return 404;
  if (!write) return 0;
  const w = writeScopedVcenterIds(user, snap);
  if (w && (!id || !w.has(id))) return 403;
  return 0;
}

/**
 * 조회(GET)용 Director 작업 — 데모 계정은 데모 Director 일 때만 접속한다(사람이 등록한 Director 에는 403 · demoGuest.js 머리말).
 * 조회 라우트는 이 함수만 쓴다: server/test/audit2719b.test.js 가 `readDirector({ demoOnly: isDemoGuest(req.user) }` 모양을 대조한다.
 */
const readDirector = ({ demoOnly = false } = {}, directorId, kind, args) => onDirector(directorId, kind, args, { demoOnly });

/** 원장 잡의 Director id(등록 때 고정 — 옛 잡은 매핑에서 푼다). 데모 Director 를 쓰는 동안은 데모 설정에서 푼다. */
const jobDir = (job) => jobDirectorId(job, effectiveSettings());
/**
 * v2.823 검토(C3·C4 — 재현): 잡이 가리키는 Director 가 설정에 **없다**(덜 된 것이 아니라 없음 — 설정 손상·옛 bareos.json 복원·구버전에서 저장한 뒤 다시 올림).
 * 그 잡은 Director 에 명령을 보낼 길이 없어 삭제·취소가 409 로 막히고 매핑 해제도 막혀 손편집만 남았다 — 원장에서만 정리하는 경로를 연다.
 */
const orphanOf = (job) => !job.demo && !isDemoActive() && !directorById(jobDir(job), loadSettings());

/** 오류 → HTTP 상태(사람이 읽는 사유는 그대로). v2.830: 백업 그룹 라우트(bareosGroups.js)도 같은 표를 쓴다. */
export function sendBareosErr(res, e) { return sendErr(res, e); }
function sendErr(res, e) {
  const code = e?.code || '';
  if (code === 'demo-only') return res.status(403).json({ ok: false, code, demoGuest: true, reason: String(e?.message || e) });
  const status = code === 'invalid' ? 400 : code === 'not-found' ? 404 : code === 'not-configured' || code === 'busy' || code === 'conflict' || code === 'edge-relay' ? 409 : code === 'unavailable' || code === 'not-sent' ? 503 : code === 'unknown' ? 504
    : ['auth', 'pam', 'tls', 'connect', 'blocked', 'timeout', 'protocol', 'closed', 'too-large', 'jsonrpc', 'auth-stopped'].includes(code) ? 502 : 500;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 600) });
}

// v2.842: 본인 OTP 재확인을 설정으로 끈 채 실행한 자동 설정 쓰기 단계는 감사에 그 사실을 붙인다(setupGate 가 req.bareosOtpOff 를 단다).
//   반증 F5: 앞에 붙인다 — 감사 detail 은 1000자에서 잘리고(auditClip) 엣지 회신의 파일 목록은 길 수 있다
const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail: req.bareosOtpOff ? `[본인 OTP 재확인 꺼짐] ${detail}` : detail, ip: req.ip || '' });

/**
 * 원장 job → 응답(비밀 없음). 범위 밖은 호출부가 거른다. directorId 는 풀어서 싣는다(옛 잡도 화면이 법인 열을 채우게).
 * v2.822(S3·I5): 등록 뒤 VM 의 이름·위치가 바뀌었으면 drift 를 단다.
 */
const viewJob = (j, vmById, settings) => {
  const vm = vmById ? vmById.get(j.vmId) : undefined;
  const drift = vmById ? placementDrift(j, vm) : null;
  // v2.834: 게스트 OS(인벤토리 기준 — 인벤토리에 없는 VM 은 모름)
  // v2.861 남은 스냅샷(인벤토리 — 못 읽으면 null · 0 이 아니다): 백업 실패 뒤 남은 스냅샷이 다음 백업을 막는다(bareos-users · PR #1484)
  // v2.866 복원 › 폴더 표: 전원 · 용량(인벤토리 — 인벤토리에 없거나 못 읽으면 null · 0 이 아니다)
  return {
    ...j, directorId: jobDirectorId(j, settings), ...osFields(vm), snapshotCount: vm ? numOrNull(vm.snapshotCount) : null,
    powerState: vm && typeof vm.powerState === 'string' ? vm.powerState.slice(0, 32) : null, storageGB: vm ? numOrNull(vm.storageGB) : null,
    ...(drift ? { drift } : {}),
  };
};

/**
 * v2.866 마지막 성공 백업(복원 › 폴더 표) — 원장의 lastRun · finishedRuns 중 성공(T·W) · 백업(type 없거나 B) 실행의 가장 늦은 끝(없으면 시작) 시각.
 * 포탈이 본 실행만 안다(등록 전 · 기록 밖 백업은 모른다) — 없으면 null('성공 없음' 이 아니라 '포탈 기록에 없음').
 */
/** v2.866 복원 명령의 기본 키 값(사이트 매핑 — vCenter 주소 · FD INI 경로). 매핑이 없으면 빈 값(restoreBaseKv 가 거부한다). */
export const restoreBaseOf = (settings) => (job) => {
  const site = (settings?.sites || []).find((x) => String(x.vcenterId) === String(job?.vcenterId));
  return { vcserver: site?.vcserver || '', configFile: site?.configFile || '' };
};

export function lastOkOf(lastRun, finishedRuns) {
  let best = null;
  for (const r of [lastRun, ...(Array.isArray(finishedRuns) ? finishedRuns : [])]) {
    if (!r || !(r.state === 'ok' || r.state === 'warning')) continue;
    const at = numOrNull(r.endedAt) ?? numOrNull(r.startedAt);
    if (at === null || at <= 0) continue;
    if (!best || at > best.at) best = { at, level: typeof r.level === 'string' ? r.level.slice(0, 1) : '', jobid: numOrNull(r.jobid) };
  }
  return best;
}

/**
 * v2.866 복원 › 폴더 표 — 백업 대상이 있는 vCenter 의 폴더마다 VM 수(인벤토리 · 템플릿 제외). 폴더 칸의 '대상 / 전체' 막대에 쓴다.
 *   조회 범위 안 vCenter 만(요청 필터보다 먼저) · 대상이 없는 vCenter 는 싣지 않는다 · Director 에 닿지 않는다.
 *   화면은 폴더 표를 열 때 한 번 읽는다(폴링하지 않는다). 상시 폴링 라우트가 아니어도 같은 열쇠 규칙(scopeKey)으로 기억한다.
 */
export function restoreFolderCounts(jobs, vms) {
  const vcs = new Set(jobs.map((j) => String(j.vcenterId)));
  const counts = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || v.template || !vcs.has(String(v.vcenterId))) continue;
    const dc = typeof v.vcDcPath === 'string' ? v.vcDcPath : '';
    const folder = typeof v.folderPath === 'string' ? v.folderPath : '';
    const key = `${v.vcenterId}\u0000${dc}\u0000${folder}`;
    const c = counts.get(key) || { vcenterId: String(v.vcenterId), dc, folder, vms: 0 };
    c.vms += 1;
    counts.set(key, c);
  }
  return [...counts.values()];
}

/**
 * v2.822(검토 S2 — 재현): 설정·원장 로드 오류는 JSON.parse 원문이라 손상된 비밀번호 조각이 실렸다(루트 불변조건 '로드 오류 원문을 응답에 싣지 않는다').
 * 분류 + 위치 숫자 요약만 — 전체 범위 관리자 판본에는 위치까지, 그 밖에는 분류 이름만.
 */
function loadErrorView(err, detail) {
  if (!err) return null;
  const sum = summarizeRegistryError(err) || summarizeRegistryError({ reason: '' });
  return { at: Number.isFinite(err.at) ? err.at : null, code: sum.code, reason: detail ? sum.text : sum.label, ...(detail ? {} : { reasonDetailHidden: true }) };
}

/**
 * Director 주소·콘솔 이름·접속 오류 원문을 그대로 보여 줄 요청인가 — 전 법인 설정이라 **전체 범위 관리자 판본**만(데모 Director 는 가릴 것이 없다).
 * 목록 GET 과 수동 조회(POST /poll)가 같은 판정을 쓴다(v2.822 B3).
 */
function addrVisible(req) {
  if (isDemoActive()) return true;
  return !scopedVcenterIds(req.user, store.get()) && isAdminDetailUser(req.user);
}

/**
 * v2.822(B2) 대상별 처리 중 표시 — 실행·복원·취소·활성 전환·삭제는 Director 호출(비동기)을 사이에 두고 원장을 바꾼다.
 * 대상마다 한 번에 하나만 받고 나머지는 409(사람이 다시 누르면 된다 — 줄 세우지 않는다).
 */
// v2.830: 잠금은 bareos/jobLocks.js 공용 — 백업 그룹 실행(groupRunner)도 같은 잠금을 잡는다(그룹이 보내는 사이 같은 대상을 지우지 못하게).
async function oneAtATime(job, res, fn) {
  if (!tryLockJob(job.id)) return res.status(409).json({ ok: false, reason: '이 대상의 다른 요청을 처리하는 중입니다 — 잠시 뒤 다시 시도하세요.' });
  try { return await fn(); } finally { unlockJob(job.id); }
}

/** 가린 판본의 폴러 상태 — 접속 오류 문구에는 Director 주소가 실릴 수 있어 코드만 남긴다(Director 별 상태도). */
const maskErr = (x) => (x?.error ? { ...x, error: `상태 조회 실패(${x.code || 'error'}) — 자세한 사유는 전체 범위 관리자 화면에 있습니다.` } : x);
function maskedPoller(p) {
  const out = maskErr(p);
  if (p?.directors) out.directors = Object.fromEntries(Object.entries(p.directors).map(([k, v]) => [k, maskErr(v)]));
  return out;
}

/**
 * 범위 계정의 폴러 상태 — **보이는 법인 Director 만**(v2.823 검토 S1·I3 — 재현: 전 법인 Director 의 id·이름·성공 여부가 실렸다).
 * 합계(성공 여부·idle)는 보이는 것으로 다시 세고, 다른 법인을 합친 건수(checked·updated·directorsFailed …)는 싣지 않는다.
 */
function scopedPoller(p, visible) {
  const dirs = Object.fromEntries(Object.entries(p?.directors || {}).filter(([k]) => visible.has(k)).map(([k, v]) => [k, maskErr(v)]));
  const vals = Object.values(dirs);
  const bad = vals.filter((x) => x.ok === false);
  return {
    at: p?.at ?? null, trigger: p?.trigger ?? null, busy: !!p?.busy, running: !!p?.running, enabled: p?.enabled, intervalMs: p?.intervalMs ?? null,
    configured: p?.configured ?? null, ...(p?.demo ? { demo: true } : {}),
    ok: p?.at ? bad.length === 0 : (p?.ok ?? null), idle: vals.every((x) => x.idle),
    error: bad.length ? `상태 조회 실패(${bad[0].code || 'error'}) — 자세한 사유는 전체 범위 관리자 화면에 있습니다.` : '', code: bad[0]?.code || '',
    directors: dirs,
  };
}
/** 이 사용자에게 보이는 Director id(조회 범위 vCenter 의 매핑 + 범위 안 대상의 Director). 전체 범위면 null. */
function visibleDirectorIds(user, settings) {
  const read = scopedVcenterIds(user, store.get());
  if (!read) return null;
  const ids = new Set(settings.sites.filter((x) => read.has(x.vcenterId)).map((x) => x.directorId));
  for (const j of listJobs()) if (read.has(j.vcenterId)) ids.add(jobDirectorId(j, settings));
  return ids;
}

/** 범위 필터(조회 범위) — 뺀 개수는 밝힌다. */
function scopedJobs(user) {
  const all = listJobs();
  const allowed = scopedVcenterIds(user, store.get());
  const jobs = allowed ? all.filter((j) => allowed.has(String(j.vcenterId))) : all;
  return { jobs, omitted: all.length - jobs.length, scoped: !!allowed };
}

/** :id 로 원장 job 을 찾고 범위를 판정한다. 실패 시 응답을 보내고 null. */
function jobFor(req, res, { write = true } = {}) {
  const job = getJob(String(req.params.id || ''));
  if (!job) { res.status(404).json({ ok: false, reason: '백업 대상을 찾을 수 없습니다.' }); return null; }
  const a = bareosAccess(req.user, job.vcenterId, { write });
  if (a === 404) { res.status(404).json({ ok: false, reason: '백업 대상을 찾을 수 없습니다.' }); return null; }
  if (a === 403) { res.status(403).json({ ok: false, reason: READ_ONLY }); return null; }
  return job;
}

/**
 * v2.822(검토 I8 — 확인): 데모 대상(demo:true)은 데모 Director 에만, 실제 대상은 실제 Director 에만 있다 — 섞어 보내지 않는다.
 */
function modeMismatch(job) {
  const demo = isDemoActive();
  if (job.demo && !demo) return '데모 대상입니다 — 실제 Director 에는 이 잡이 없습니다(지우기만 할 수 있습니다).';
  if (!job.demo && demo) return '실제 Director 의 대상입니다 — 지금은 데모 Director 를 쓰는 중이라 실행할 수 없습니다.';
  return '';
}

/** Director 마다 한 번에 하나(연결 시험 · 자동 설정) — 다른 법인 Director 의 작업은 막지 않는다. */
const _testBusy = new Set();
// v2.823 검토(S6·P10): 잠금이 Director 마다라, 서로 다른 Director 편집에서 **같은 서버**(myself.conf·공용 리소스)를 동시에 고칠 수 있었다 —
//   원격 대상 주소로도 한 번에 하나(되돌리기가 서로의 파일을 지우거나 덮지 않게). v2.845: 표는 bareos/setupLocks.js 하나(법인별 설정·완전 설치와 공유).
const releaseSetup = (dirId) => { releaseSetupLock(dirId); noteSetupEnd(dirId); };
const _catalogMemo = new Map();   // `${demo}|${directorId}|${settingsRev}` → { at, value }

/**
 * 자동 설정 오류 → 응답(v2.821). SSH 인증 실패는 자동 재시도하지 않는다(계정 잠금) — 사람이 고쳐 다시 누른다.
 * 호스트키 거부는 인증 실패가 아니다(문구 그대로 — 장비 신뢰에서 승인).
 */
function sendSetupErr(res, e) {
  const code = e?.code || '';
  if (isSshHostKeyError(e)) return res.status(502).json({ ok: false, code: 'ssh-hostkey', reason: String(e.message).slice(0, 600) });
  // v2.822.3(I2-3): Rocky·RHEL 9 의 sshd 기본값(PermitRootLogin prohibit-password)은 root 비밀번호 로그인을 막는다(추정 — 배포판 기본값)
  if (isSshAuthError(e)) return res.status(502).json({ ok: false, code: 'ssh-auth', reason: 'SSH 인증 실패 — 계정·비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다). 비밀번호가 맞다면 그 서버의 sshd 가 root 비밀번호 로그인을 막고 있을 수 있습니다(Rocky·RHEL 9 기본값 PermitRootLogin prohibit-password).' });
  // v2.824 엣지 대행: 보내지 않음(엣지가 가져가지 않음) 503 · 결과 모름(가져갔지만 미회신) 504
  const status = code === 'invalid' ? 400 : code === 'conflict' ? 409 : code === 'config-test' ? 422 : code === 'not-sent' ? 503 : code === 'unknown' ? 504 : 502;
  res.status(status).json({ ok: false, code: code || 'ssh', reason: String(e?.message || e).slice(0, 1800), ...(e?.paths ? { paths: e.paths } : {}), ...(e?.files ? { files: e.files } : {}) });
}

/**
 * v2.822.3(I2-10·W2-11): 감사에는 원격 출력을 싣지 않는다 — 원격 출력이 실린 코드는 코드·첫 마디만, 나머지는 사유 앞부분.
 */
export function setupAuditReason(e) {
  const code = e?.code || '';
  const msg = String(e?.message || '');
  if (['config-test', 'remote', 'console-login', 'save'].includes(code)) return `${code} ${msg.split(/[:(]/)[0].slice(0, 80).trim()}(원격 출력은 감사에 싣지 않습니다)`;
  return `${code} ${msg.slice(0, 200)}`.trim();
}

/** 이 Director 를 찾는다(없으면 404 응답 후 null). 데모 Director 를 쓰는 동안은 데모 설정에서. */
function directorFor(req, res) {
  const id = String(req.params.directorId || '');
  const d = directorById(id, effectiveSettings());
  if (!d) { res.status(404).json({ ok: false, reason: 'Director 를 찾을 수 없습니다.' }); return null; }
  return d;
}

/**
 * 원격 root 로 접속하는 자동 설정의 공통 문지기 — 데모 계정 403 · Director 마다 동시 1건 · (쓰기면) 입력 판정 · **그다음** 본인 OTP.
 * 통과하면 true(그때 그 Director 의 busy 를 잡는다 — 호출부가 finally 에서 푼다).
 * @param {{ otp?: boolean }} [o] otp:false = 쓰기 없음(사전 점검·지문 읽기) — OTP 를 걸지 않는다
 */
function setupGate(req, res, dirId, plan, { otp = true } = {}) {
  if (isDemoGuest(req.user)) { res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 실제 서버에 접속할 수 없습니다.' }); return false; }
  if (isSetupBusy(dirId)) { res.status(409).json({ ok: false, reason: '이 Director 의 다른 자동 설정이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' }); return false; }
  const hostKey = String(req.body?.host || '').trim().toLowerCase();
  if (hostKey && setupBusyReason(dirId, hostKey)) { res.status(409).json({ ok: false, reason: '같은 서버에 다른 Director 의 자동 설정(또는 설정 변경 · 설치)이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' }); return false; }
  // v2.822.3(I2-6 — 재현): 데모 Director 를 쓰는 동안은 화면 매핑이 데모 값이라 실제 서버 설정과 섞인다
  if (isDemoActive()) { res.status(409).json({ ok: false, reason: '데모 Director 를 쓰는 중입니다 — 자동 설정은 실제 Director 를 등록한 뒤(설정 › 법인별 Director 에서 추가) 쓸 수 있습니다.' }); return false; }
  const name = req.user?.username || '';
  // v2.842: 쓰기 단계의 본인 OTP 재확인은 '설정 › Security › 세션 보안' 값(기본 켬 · 소유자 + OTP 로만 끔)을 따른다 — 요청마다 지금 값을 읽는다.
  //   끈 상태로 지난 요청은 감사에 표시한다(req.bareosOtpOff). 인증이 꺼진 설치(AUTH_ENABLED=false)는 예전처럼 OTP 를 보지 않는다.
  //   ⚠ 반증 F2(재현): 끄더라도 **OTP 를 등록한 로컬 계정만** 실행한다 — 끄는 것은 코드 입력만 건너뛰는 것이고, 실행할 수 있는 계정을 넓히지 않는다
  //   (등록 검사까지 끄면 users.json 레코드 없는 AD 매핑 관리자·비밀번호 전용 관리자도 root 쓰기 단계를 실행하게 됐다).
  const writeStep = otp && config.auth.enabled;
  const needOtp = writeStep && bareosSetupOtpRequired();
  if (writeStep && !needOtp) req.bareosOtpOff = true;
  if (writeStep && !getUser(name)?.totpEnabled) { res.status(403).json({ ok: false, needEnroll: true, ...(needOtp ? { otpRequired: true } : {}), reason: '자동 설정은 OTP 가 등록된 계정만 실행할 수 있습니다(본인 OTP 재확인을 꺼 두어도 같습니다). 사용자 관리에서 OTP 를 등록하세요.' }); return false; }
  try { plan({ ...(req.body || {}), directorId: dirId }); } catch (e) { sendSetupErr(res, e); return false; }
  if (needOtp) {
    const v = verifyUserOtp(name, req.body?.otp);
    // otpRequired: 화면이 '꺼짐' 으로 알고 OTP 칸을 숨겼는데 그사이 다시 켜졌으면 칸을 다시 보이게 한다
    if (!v.ok) { res.status(403).json({ ok: false, otpRequired: true, reason: `OTP 인증 실패 — ${v.reason}` }); return false; }
  }
  claimSetup(dirId, hostKey);
  noteSetupStart(dirId, directorById(dirId, effectiveSettings())?.name || dirId);   // G15: 업그레이드 자동 적용이 기다린다(bareos/inflight.js)
  return true;
}

/** 지금 이 Director 의 인증 정지(가림 판본 포함). */
function authStopFor(d, demo, showAddr) {
  const stop = demo || !d ? null : bareosAuthGuard.peekAuthStop(directorCred(d));
  return showAddr ? authStopView(stop) : (stop ? { ...authStopView(stop), reason: '인증 실패' } : null);
}

/**
 * 매핑 제안(순수에 가까움 — 카탈로그 + vCenter 등록부만). 이 Director 에 묶인 vCenter 마다 칸별 제안과 근거를 낸다.
 * 고르기 규칙: 목록이 하나면 그것 · 포탈이 만든 이름(PortalVmwareFull·PortalVmwareNightly)이 있으면 그것 · 설치 기본 이름(bareos-fd·File)이 있으면 그것 ·
 * 그 밖에는 비워 두고 후보만(지어내지 않는다). 화면은 빈 칸만 채운다.
 */
export function suggestMapping({ director, sites, catalog, vcenters }) {
  const pick = (list, prefer) => {
    // v2.841: 목록을 **못 읽은**(null) 것과 빈 목록을 가른다 — 예전에는 둘 다 'Director 목록이 비어 있음' 이었다(못 읽음은 0 이 아니다)
    if (!Array.isArray(list)) return { value: '', why: '이 목록을 Director 에서 읽지 못함 — 직접 적으세요', unread: true };
    const l = list;
    for (const p of prefer) if (l.includes(p)) return { value: p, why: p.startsWith('Portal') ? '포탈 자동 설정이 만든 이름' : '설치 기본 이름' };
    if (l.length === 1) return { value: l[0], why: '하나뿐' };
    return { value: '', why: l.length ? `후보 ${l.length}개 — 직접 고르세요` : 'Director 목록이 비어 있음', choices: l.slice(0, 20) };
  };
  const hostOf = (vc) => String(vc?.host || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vcenter';
  // v2.823 검토(C7 — 재현): 'KR_VC01'·'kr-vc01' 처럼 조각이 같은 vCenter 는 같은 INI 경로를 받아 나중 FD INI 설정이 먼저 것을 덮었다 —
  //   다른 vCenter 가 이미 쓰는(또는 이번에 먼저 제안한) 경로면 vCenter id 의 짧은 해시를 붙인다.
  const used = new Map(sites.filter((x) => x.configFile).map((x) => [x.configFile, x.vcenterId]));
  const iniFor = (vcId) => {
    const base = `/etc/bareos/vmware/${slug(vcId)}`;
    let p = `${base}.ini`;
    if (used.has(p) && used.get(p) !== vcId) p = `${base}-${crypto.createHash('sha1').update(String(vcId)).digest('hex').slice(0, 6)}.ini`;
    used.set(p, vcId);
    return p;
  };
  return sites.filter((s) => s.directorId === director.id).map((s) => {
    const vc = vcenters.find((v) => v.id === s.vcenterId);
    const h = hostOf(vc);
    return {
      vcenterId: s.vcenterId,
      fields: {
        vcserver: h && /^[A-Za-z0-9.-]{1,253}$/.test(h) ? { value: h, why: 'vCenter 등록부 주소' } : { value: '', why: 'vCenter 등록부 주소를 쓸 수 없음 — 직접 적으세요' },
        client: pick(catalog?.clients, ['bareos-fd']),
        storage: pick(catalog?.storages, ['File']),
        pool: pick(catalog?.pools, [VMWARE_POOL_FULL, 'Full']),
        schedule: pick(catalog?.schedules, [VMWARE_SCHEDULE]),
        configFile: { value: iniFor(s.vcenterId), why: '포탈 기본 경로' },
      },
    };
  });
}

/** 매핑 드롭다운 원천(.clients·.storages·.pools·.schedule·.jobdefs·.filesets) — Director 마다 60초 기억(설정을 저장하면 새로 읽는다). */
async function catalogOf(d, refresh) {
  const key = `${isDemoActive()}|${d.id}|${settingsRev()}`;
  const m = _catalogMemo.get(key);
  if (!refresh && m && Date.now() - m.at < CATALOG_TTL_MS) return { cached: true, ...m.value };
  const value = await onDirector(d.id, 'catalog');
  for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${d.id}|`)) _catalogMemo.delete(k);
  _catalogMemo.set(key, { at: Date.now(), value });
  return value;
}

export function registerBareosBackup(api) {

/**
 * 목록 + 상태(폴러·설정 요약·법인별 Director).
 * v2.846 버그 점검(C-5 — 측정): 관리 화면이 어느 탭이든 10초마다 부른다 — 3,000 대상이면 원장 깊은 복사·정책 판정·직렬화가 매번 100ms 넘게 돌았다.
 * memoJson(스냅샷 세대 + 아래 열쇠)으로 같은 열쇠의 다시 부르기는 기억 시한(기본 12초) 안에서만 계산하지 않는다(ETag 는 열쇠로 — 다시 계산해도 304).
 *   v2.847 C2-3 정정: 화면이 10초마다 부르므로 약 두 번에 한 번은 다시 계산한다(예전 문구 '같은 세대는 계산하지 않고' 는 과장). 화면이 쓰지 않는 끝난 실행 원문(finishedRuns)은 싣지 않는다.
 */
api.get('/tools/bareos-backup', adminOnly, (req, res) => memoJson(req, res, 'bareos-backup-list', () => bareosListView(req), { extraKey: bareosListKey(req) }));

/**
 * 목록 캐시 열쇠 — '세대가 바뀌면 무엇이 지워지는가'(루트 CLAUDE.md 캐시 규칙)에 대한 답:
 *  · 사람마다 다른 칸: 조회 범위(scopeKey — 범위 계정이 전체 범위 관리자의 캐시를 받지 않게) · 쓰기 범위(대상별 writable · settingsWritable) ·
 *    역할 · 관리자 판본(isAdminDetailUser — Director 주소·콘솔·오류 원문을 보이는가) · 데모 모드.
 *  · 원장 rev(대상 추가·삭제·실행 결과·대기 — 폴러·엣지 회신이 반영할 때마다 오른다) · 설정 rev(Director·매핑·기본값) · 그룹 rev · 정책 수집 rev · 백업 표시 rev ·
 *    손상 표지(원장·설정·그룹·표시) · 폴러 at·busy 와 Director 별 상태(엣지 회신은 at 없이 ok·relay 만 바꾼다) · 인증 정지(수동 연결 시험이 폴러 없이 바꾼다).
 *  · 스냅샷 세대(memoJson 이 앞에 붙인다 — VM 이름·위치 drift · 게스트 OS · 그룹 다음 회차 시각). 이 밖의 값이 바뀌어도 늦어야 스냅샷 한 주기다.
 */
function bareosListKey(req) {
  const snap = store.get();
  let w = 'err';
  try { const ws = writeScopedVcenterIds(req.user, snap); w = ws ? [...ws].sort().join(',') : 'all'; } catch { w = 'err'; }
  const p = pollerStatus();
  const dirs = Object.entries(p.directors || {}).map(([k, v]) => `${k}:${v?.at ?? ''}:${v?.ok}:${v?.relay || ''}:${v?.code || ''}`).join(',');
  let auth = '';
  try {
    const demo = isDemoActive();
    auth = effectiveSettings().directors.map((d) => { const s = demo ? null : bareosAuthGuard.peekAuthStop(directorCred(d)); return s ? `${d.id}:${s.at}` : ''; }).filter(Boolean).join(',');
  } catch { auth = 'err'; }
  const bad = (f) => { try { return f() ? 1 : 0; } catch { return 1; } };
  return [
    `s=${scopeKey(req.user, snap)}`, `w=${w}`, `r=${req.user?.role || ''}`, `a=${isAdminDetailUser(req.user) ? 1 : 0}`, `d=${isDemoActive() ? 1 : 0}`,
    `g=${registryRev()}`, `c=${settingsRev()}`, `gr=${groupsRev()}`, `po=${policyRev()}`, `m=${marksRev()}`,
    `e=${bad(registryLoadError)}${bad(settingsLoadError)}${bad(groupsLoadError)}${bad(marksUnreadable)}`,
    `p=${p.at || 0}:${p.busy ? 1 : 0}`, `pd=${dirs}`, `as=${auth}`,
  ].join('|');
}

function bareosListView(req) {
  const settings = effectiveSettings();
  const demo = isDemoActive();
  const { jobs, omitted, scoped } = scopedJobs(req.user);
  // Director 주소·콘솔 이름은 전 법인 설정(설정 탭과 같은 등급) — 범위 계정·데모 계정에는 가리고 법인 이름만 보인다(v2.743 AUTHZ-02 와 같은 원칙).
  const showAddr = addrVisible(req);
  const detail = !scopedVcenterIds(req.user, store.get()) && isAdminDetailUser(req.user);
  const vmById = new Map((store.get()?.vms || []).map((v) => [v.id, v]));
  const visibleSite = (s) => !scoped || bareosAccess(req.user, s.vcenterId, { write: false }) === 0;
  const mapped = settings.sites.filter(visibleSite).map((s) => s.vcenterId);
  // v2.825.1 버그 점검(G12): 쓰기 범위(writeVcenters)가 지정된 계정 — 대상마다 쓸 수 있는지 싣는다(화면이 버튼을 잠근다 · 서버는 그대로 403)
  // v2.840 '적용 정책' 한 줄(정책 수집본 · 그룹 · 표시 — Director 에 접속하지 않는다). 그룹 · 수집본을 못 읽으면 그 칸은 모름으로(행은 그대로).
  let resolve = null;
  try {
    const groups = groupsLoadError() ? null : listGroups();
    if (groups) resolve = jobPolicyResolver({ settings, groups });
  } catch { resolve = null; }
  const marksBad = (() => { try { return marksUnreadable(); } catch { return true; } })();
  const marks = marksBad ? {} : getMarks();
  const policyOf = (j) => {
    if (!resolve) return null;
    try {
      const r = resolve(j, marksBad ? null : (marks[j.vmId]?.method || ''));
      return { verdict: r.verdict, src: r.src, next: r.next, ...(r.dup ? { dup: r.dup } : {}), pool: r.pool, poolFrom: r.poolFrom, retentionSec: r.retentionSec, keep: r.keep, collected: r.collected };
    } catch { return null; }
  };
  // C-5: 끝난 실행 원문(finishedRuns — 실패 메일·RPO 용 · 최근 10건)은 화면이 쓰지 않는다(웹 grep 0건) — 싣지 않는다. 복원 이력(restores)은 '실행 현황 · 이력' 탭이 쓴다.
  // v2.866: finishedRuns 원문은 싣지 않고 마지막 성공(lastOk — 복원 › 폴더 표)만 계산해 싣는다
  const views = jobs.map(({ finishedRuns, ...j }) => ({ ...viewJob(j, vmById, settings), lastOk: lastOkOf(j.lastRun, finishedRuns), writable: bareosAccess(req.user, j.vcenterId) === 0, policy: policyOf(j) }));
  let settingsWritable = false;
  try { settingsWritable = !scopedVcenterIds(req.user, store.get()) && !writeScopedVcenterIds(req.user, store.get()); } catch { settingsWritable = false; }
  const rawPoller = pollerStatus();
  const directors = settings.directors.map((d) => {
    const vcs = settings.sites.filter((s) => s.directorId === d.id && visibleSite(s)).map((s) => s.vcenterId);
    const n = views.filter((j) => j.directorId === d.id).length;
    return {
      id: d.id, name: d.name, ...(showAddr ? { host: d.host, port: d.port, consoleName: d.consoleName, agent: d.agent || '' } : { masked: true, relay: !!d.agent }),
      hasPassword: !!d.password, configured: demo || !!directorConn(d).conn, vcenters: vcs, jobs: n,
      poll: (showAddr ? rawPoller.directors?.[d.id] : maskErr(rawPoller.directors?.[d.id])) || null, authStopped: authStopFor(d, demo, showAddr),
    };
  }).filter((d) => !scoped || d.vcenters.length || d.jobs);   // 범위 계정에는 자기 vCenter 의 법인만
  const poller = scoped ? scopedPoller(rawPoller, new Set(directors.map((d) => d.id))) : (showAddr ? rawPoller : maskedPoller(rawPoller));
  return {
    demo,
    configured: demo || anyDirectorConfigured(loadSettings()),
    directors,
    defaults: { level: settings.defaults.level, pollIntervalSec: settings.defaults.pollIntervalSec },
    sitesCount: mapped.length,   // v2.822(S5): 범위 계정에는 보이는 vCenter 의 매핑 수만
    mappedVcenters: mapped,
    jobs: views,
    ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}),
    poller,
    relayLimits: relayLimits(),   // v2.824 엣지 대행 Director 의 화면 시한(서버 대기 시간 — 숫자를 화면에 박지 않는다)
    settingsWritable,   // G12: 설정(전 법인 공용 쓰기 — fullWriteOnly)을 바꿀 수 있는 계정인가
    settingsLoadError: loadErrorView(settingsLoadError(), detail),
    registryLoadError: loadErrorView(registryLoadError(), detail),
  };
}

/** 설정 전체(전체 범위 관리자) — 법인별 Director(비밀번호 없음)·공통 기본값·매핑·vCenter 목록. */
api.get('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, (req, res) => {
  const snap = store.get();
  const demo = isDemoActive();
  const pub = demo ? (() => { const s = effectiveSettings(); return { directors: s.directors.map(publicDirector), defaults: s.defaults, sites: s.sites }; })() : publicSettings();
  const jobsByDir = new Map();
  const st = effectiveSettings();
  for (const j of listJobs()) { const id = jobDirectorId(j, st); jobsByDir.set(id, (jobsByDir.get(id) || 0) + 1); }
  res.json({
    demo,
    ...pub,
    directors: pub.directors.map((d) => ({ ...d, jobs: jobsByDir.get(d.id) || 0, busy: isSetupBusy(d.id) })),
    rev: revToken(),   // 매핑·기본값 저장 때 돌려보낸다(P4 — 다른 화면의 저장을 덮지 않게)
    agents: (() => { try { return knownAgentNames(); } catch { return []; } })(),   // v2.824 담당 엣지 고르기(중앙이 아는 엣지)
    // v2.824 검토(W11·I3): 대행 작업 인출은 엣지별 개별 토큰 전용 — 토큰이 있는 엣지 이름(화면이 없는 이름을 '대행 불가' 로 표시)
    agentsWithToken: (() => { try { return listAgentTokens().map((t) => t.agent); } catch { return []; } })(),
    relayPending: pendingView(),   // v2.824 엣지 대행 대기·진행 작업(인자·비밀 없음)
    relayLimits: relayLimits(),
    // v2.842: 자동 설정 쓰기 단계에 본인 OTP 를 묻는가(인증이 꺼진 설치는 묻지 않는다 — 화면이 OTP 칸을 숨긴다)
    setupOtp: !!config.auth.enabled && bareosSetupOtpRequired(),
    setupOtpOff: !config.auth.enabled ? 'auth-off' : bareosSetupOtpRequired() ? null : 'setting',   // 묻지 않는 이유(화면이 단정하지 않게)
    limits: LIMITS,
    // v2.843(사용자 원칙 '백업은 법인 로컬'): 그 vCenter 의 인벤토리를 올리는 법인 엣지(siteAgent — Veeam 서버 화면과 같은 출처 listInventory) —
    //   화면이 Director 담당(접속 주체)을 그 엣지로 두라고 권한다. 모르면 ''(단정하지 않는다).
    vcenters: (() => {
      let owners = new Map();
      try { owners = new Map(listInventory().map((i) => [i.vcenterId, i.agent || ''])); } catch { owners = new Map(); }
      // v2.851.1: 매핑 미리 채우기의 주소는 등록부에서(vcHost.js) — 스냅샷 vCenter 항목에는 host 가 없어 늘 비어 있었다
      const hosts = registryHosts();
      return (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, host: hosts.get(String(v.id)) || vcHostOf(v.host), siteAgent: owners.get(v.id) || '' }));
    })(),
    jobsByVcenter: Object.fromEntries([...listJobs().filter((j) => !j.demo).reduce((m, j) => m.set(j.vcenterId, (m.get(j.vcenterId) || 0) + 1), new Map())]),
    loadError: loadErrorView(settingsLoadError(), isAdminDetailUser(req.user)),
  });
});

/** 공통 기본값·매핑 저장(Director 접속값은 /settings/directors). 백업 대상이 있는 vCenter 의 Director 는 바꾸지 않는다. */
api.put('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const body = req.body || {};
  // v2.823 검토(P4·W17 — 재현): 두 화면(다른 Director 편집)이 각자 마지막에 읽은 매핑 전체를 보내 먼저 저장한 쪽이 조용히 사라졌다 —
  //   화면이 읽은 설정 세대(rev)를 함께 보내면 그 뒤 다른 저장이 있었을 때 409 로 다시 읽게 한다.
  if (body.rev !== undefined && String(body.rev) !== revToken()) return res.status(409).json({ ok: false, code: 'stale', reason: '그사이 다른 화면에서 Bareos 설정이 바뀌었습니다 — 다시 읽은 뒤 저장하세요.' });
  // v2.846 버그 점검(D-7): 매핑 저장은 '백업 대상이 있는 vCenter 의 Director 는 바꾸지 않는다'(jobDirs)를 원장으로 본다 — 원장을 못 읽었으면
  //   대상 0 으로 보고 다른 Director 로 옮겨 버렸다(그 잡들은 옛 Director 의 conf 에 있다). 못 읽었으면 매핑 저장을 받지 않는다(공통 기본값만은 받는다).
  if (body.sites !== undefined && registryLoadError()) return res.status(503).json({ ok: false, code: 'registry-unreadable', reason: '백업 대상 원장을 읽지 못한 상태라 매핑을 저장하지 않습니다(어느 vCenter 에 대상이 있는지 모릅니다 — 손상본 보존 · 서비스 점검에서 확인).' });
  if (Array.isArray(body.sites)) {
    // v2.823 검토(W1 — 재현): 인벤토리에서 빠진 vCenter 의 **이미 저장된** 매핑은 그대로 다시 보내도 받는다(다른 Director 편집의 저장이
    //   전부 400 이던 막다른 길). 새로 묶는 vCenter 만 인벤토리에 있어야 한다.
    const known = new Set((store.get()?.vcenters || []).map((v) => v.id));
    const saved = new Set(loadSettings().sites.map((x) => x.vcenterId));
    const unknown = body.sites.map((s) => String(s?.vcenterId || '')).filter((id) => id && !known.has(id) && !saved.has(id));
    if (unknown.length) return res.status(400).json({ ok: false, reason: `인벤토리에 없는 vCenter 가 있습니다: ${unknown.slice(0, 5).join(', ')}` });
  }
  try {
    const st = loadSettings();
    const jobDirs = new Map();
    for (const j of listJobs()) { if (j.demo) continue; const set = jobDirs.get(j.vcenterId) || new Set(); set.add(jobDirectorId(j, st)); jobDirs.set(j.vcenterId, set); }
    const r = saveSettings(body, { jobDirs });
    _catalogMemo.clear();
    audit(req, 'Bareos 설정 저장', '공통 기본값·매핑', `매핑 ${r.settings.sites.length}개 · Director ${r.settings.directors.length}개`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e?.code === 'conflict' ? 409 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** 법인 Director 추가 — body { name, host, port?, consoleName, password?, timeoutMs?, tlsMax? }. */
api.post('/tools/bareos-backup/settings/directors', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const b = { ...(req.body || {}) };
  // v2.824 담당 엣지 — 중앙이 아는 엣지 이름만(pickAgent — 오타·대소문자 차이 방지). 빈 값 = 중앙 직접.
  const ag = pickAgent(b.agent, knownAgentNames(), '');
  if (ag.error) return res.status(400).json({ ok: false, field: 'agent', reason: ag.error });
  b.agent = ag.value;
  try {
    const r = addDirector(b);
    audit(req, 'Bareos Director 추가', r.director.name, `${r.director.host || '(주소 없음)'}:${r.director.port} · 콘솔 ${r.director.consoleName || '—'}${r.director.hasPassword ? ' · 비밀번호 있음' : ''} · 담당 ${r.director.agent ? `엣지 ${r.director.agent}` : '중앙 직접'}`);
    res.status(201).json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** Director 접속값 바꾸기 — 준 칸만. 주소·포트·콘솔 이름이 바뀌면 이 Director 의 저장 비밀번호를 폐기한다(새 비밀번호를 같이 주면 그것). */
api.put('/tools/bareos-backup/settings/directors/:directorId', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const id = String(req.params.directorId || '');
  // v2.821: 자동 설정이 끝에 Director 연결을 저장한다 — 그 사이의 저장을 받으면 어느 한쪽이 조용히 덮인다.
  if (isSetupBusy(id)) return res.status(409).json({ ok: false, reason: '이 Director 의 자동 설정이 진행 중입니다 — 끝난 뒤 저장하세요.' });
  const b = { ...(req.body || {}) };
  if (b.agent !== undefined) {
    const prev = directorById(id, loadSettings());
    const ag = pickAgent(b.agent, knownAgentNames(), prev?.agent || '');
    if (ag.error) return res.status(400).json({ ok: false, field: 'agent', reason: ag.error });
    b.agent = ag.value;
  }
  try {
    const r = updateDirector(id, b);
    for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${id}|`)) _catalogMemo.delete(k);
    audit(req, 'Bareos Director 저장', r.director.name, `${r.director.host || '(주소 없음)'}:${r.director.port} · 콘솔 ${r.director.consoleName || '—'} · 담당 ${r.director.agent ? `엣지 ${r.director.agent}` : '중앙 직접'}${secretProvided(b.password) ? ' · 비밀번호 변경' : ''}${r.droppedSecrets.length ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e?.code === 'not-found' ? 404 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** Director 지우기 — 매핑·백업 대상이 가리키면 409(잡은 그 Director 의 conf 에 있다). Bareos 서버 쪽은 건드리지 않는다. */
api.delete('/tools/bareos-backup/settings/directors/:directorId', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const id = String(req.params.directorId || '');
  if (isSetupBusy(id)) return res.status(409).json({ ok: false, reason: '이 Director 의 자동 설정이 진행 중입니다.' });
  // v2.846 버그 점검(D-7): 원장을 못 읽었으면 '이 Director 를 쓰는 대상 0' 으로 보지 않는다(지우면 그 잡들이 갈 Director 가 사라진다)
  if (registryLoadError()) return res.status(503).json({ ok: false, code: 'registry-unreadable', reason: '백업 대상 원장을 읽지 못한 상태라 Director 를 지우지 않습니다(이 Director 를 쓰는 대상이 있는지 모릅니다 — 손상본 보존 · 서비스 점검에서 확인).' });
  const st = loadSettings();
  const inUseByJobs = listJobs().filter((j) => !j.demo && jobDirectorId(j, st) === id).length;
  try {
    const r = deleteDirector(id, { inUseByJobs });
    audit(req, 'Bareos Director 삭제', r.name, '포탈 설정에서만 지웠습니다(Bareos 서버는 그대로)');
    res.json({ ok: true });
  } catch (e) { res.status(e?.code === 'not-found' ? 404 : e?.code === 'conflict' ? 409 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});

/**
 * 연결 시험(v2.822 단계별 진단) — Director 하나. 새 비밀번호를 주면 요청의 주소로, 아니면 **그 Director 의 저장값(주소·포트·콘솔 이름)에 고정**한다
 * (v2.480 — 저장 비밀번호를 다른 주소로 보내지 않는다). Director 마다 동시에 1건.
 * 응답: 성공 200 { ok, director, version, tls, clients, stages } · 실패 502 { ok:false, code, reason, stages }.
 */
api.post('/tools/bareos-backup/settings/directors/:directorId/test', adminOnly, fullScopeOnly, async (req, res) => {
  const saved = directorFor(req, res); if (!saved) return;
  if (_testBusy.has(saved.id)) return res.status(409).json({ ok: false, reason: '이 Director 의 다른 연결 시험이 진행 중입니다 — 잠시 뒤 다시 시도하세요.' });
  _testBusy.add(saved.id);
  const b = req.body?.director || req.body || {};
  let target = '';
  // v2.849: 포탈 리소스 점검에 쓸 공통 기본값 이름(잡이 참조하는 JobDefs · FileSet · 복원 잡)
  const dfl = effectiveSettings().defaults || {};
  const expect = { jobDefs: dfl.jobDefs, fileSet: dfl.fileSet, restoreJob: dfl.restoreJob };
  try {
    if (isDemoActive() && !secretProvided(b.password)) {
      target = `${saved.name}(데모)`;
      const result = await onDirector(saved.id, 'probe');
      const stages = DIAG_STAGES.map(([key, label]) => ({ key, label, ok: true, ms: 0, detail: key === 'command' ? `클라이언트 ${(result.clients || []).length}개` : '데모 Director(합성 응답 — 접속하지 않습니다)' }));
      audit(req, 'Bareos 연결 시험', target, `성공 — ${result.director || '?'} ${result.version || ''}`);
      return res.json({ ok: true, ...result, stages, demo: true });
    }
    const fresh = secretProvided(b.password);
    // v2.824 엣지 대행 Director: 중앙이 접속하지 않는다 — 그 엣지가 자기 사본으로 시험한다(작업의 접속값 표지가 다르면 엣지가 배정을 먼저 다시 받는다 — 검토 I1).
    //   입력한 새 비밀번호를 시험용으로 엣지에 보내지 않는다(저장한 뒤 시험 — 비밀은 자동 설정 대행에만 싣는다).
    if (saved.agent && !isDemoActive()) {
      if (fresh) return res.status(400).json({ ok: false, reason: `이 Director 는 법인 엣지 '${saved.agent}' 가 대행합니다 — 새 비밀번호는 먼저 저장한 뒤 시험하세요(엣지가 저장된 값으로 시험합니다).` });
      target = `${saved.name} (엣지 ${saved.agent} 대행)`;
      // 정지 해제는 relayToEdge 가 접속값이 그대로일 때만 한다(sameNow) — 여기서 다시 지우지 않는다(G1 — 그 가드를 무력화했다)
      const result = await relayToEdge(saved, 'probe', { expect });
      audit(req, 'Bareos 연결 시험', target, `성공 — ${result.director || '?'} ${result.version || ''}`);
      return res.json({ ok: true, ...result, stages: null, relay: saved.agent, demo: false });
    }
    const conn = fresh
      ? { host: String(b.host ?? saved.host), port: b.port ?? saved.port, name: String(b.consoleName ?? saved.consoleName), password: String(b.password), timeoutMs: b.timeoutMs ?? saved.timeoutMs, tlsMaxVersion: b.tlsMax ?? saved.tlsMax }
      : { host: saved.host, port: saved.port, name: saved.consoleName, password: saved.password || '', timeoutMs: saved.timeoutMs, tlsMaxVersion: saved.tlsMax };
    // v2.822(B4): 감사 대상은 **실제로 접속한 주소** — 저장 비밀번호로 시험하면 요청의 주소는 무시되므로 그것을 적으면 거짓 기록이다.
    target = `${saved.name} ${conn.host || '(미설정)'}:${conn.port || ''}`;
    if (!conn.host || !conn.name || !conn.password) return res.status(400).json({ ok: false, reason: '주소·콘솔 이름·비밀번호를 모두 채우세요(저장된 비밀번호로 시험하면 저장된 주소로만 접속합니다).' });
    const d = await diagnoseConsole(conn, { expect });
    if (!d.ok) {
      audit(req, 'Bareos 연결 시험', target, `실패 — ${d.failed?.key || '?'} ${d.failed?.code || ''} ${String(d.failed?.detail || '').slice(0, 120)}`);
      const f = d.stages.find((x) => x.ok === false);
      return res.status(502).json({ ok: false, code: d.failed?.code || 'error', reason: `${f?.label || '연결'} 단계에서 실패했습니다 — ${d.failed?.detail || ''}`.slice(0, 600), stages: d.stages });
    }
    // G1: 시험하는 사이 접속값이 바뀌었으면(다른 화면의 저장) 그 값의 정지를 풀지 않는다
    if (!fresh) clearAuthStopIfSame(saved);
    const { director, version } = parseBanner(d.banner);
    audit(req, 'Bareos 연결 시험', target, `성공 — ${director || '?'} ${version || ''}`);
    res.json({ ok: true, director, version, tls: d.tls, clients: d.clients, clientsError: '', configure: d.configure, resources: d.resources, stages: d.stages, demo: false });   // v2.848 configure: 잡 만들기 권한
  } catch (e) {
    audit(req, 'Bareos 연결 시험', target, `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 120)}`);
    sendErr(res, e);
  } finally { _testBusy.delete(saved.id); }
});

api.get('/tools/bareos-backup/settings/directors/:directorId/catalog', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  try { res.json({ ok: true, directorId: d.id, ...(await catalogOf(d, req.query.refresh === '1')) }); } catch (e) { sendErr(res, e); }
});

/**
 * 매핑 자동 채움(v2.823 — 쓰기 없음): 이 Director 의 카탈로그 + vCenter 등록부 주소로 그 Director 에 묶인 vCenter 마다 칸별 제안.
 * 화면은 **빈 칸만** 채우고 저장은 사람이 누른다(새 쓰기 경로 없음).
 */
api.get('/tools/bareos-backup/settings/directors/:directorId/suggest', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  try {
    const catalog = await catalogOf(d, req.query.refresh === '1');
    const settings = effectiveSettings();
    res.json({ ok: true, directorId: d.id, suggestions: suggestMapping({ director: d, sites: settings.sites, catalog, vcenters: store.get()?.vcenters || [] }) });
  } catch (e) { sendErr(res, e); }
});

/**
 * 자동 설정(v2.821 · v2.823 Director 마다 — bareos/autoSetup.js). 전부 admin + 전체 범위 + 데모 계정 거부 + Director 마다 동시 1건.
 * 쓰기(Director 리소스·FD 플러그인·FD INI)는 본인 OTP 를 더 건다(원격 root 로 설정 파일을 쓴다). SSH·vCenter 비밀번호는 저장하지 않는다.
 */
/**
 * 자동 설정 한 단계 — 중앙 직접(local) 또는 담당 엣지 대행(v2.824 · 사용자 결정 '입력한 SSH·vCenter 비밀번호를 그 작업에만 실어 엣지로 1회 전달').
 * 엣지 대행이면: 비밀(SSH·vCenter 비밀번호 · 2단계의 새 콘솔 비밀번호 — **중앙이 만든다**)은 secretArgs 로 따로(엣지 인출 즉시 중앙 큐에서 지운다 ·
 * 인출 전 시한 SECRET_TTL_MS) · args 에는 비밀이 아닌 입력과 그 단계가 쓰는 중앙 값(공통 기본값 · 매핑 한 줄)만.
 * 2단계 회신이 ok 면 중앙이 그 콘솔 값으로 저장한다(실패하면 사실대로 — 재실행하면 MARKER 파일을 덮는다).
 */
async function runSetup(d, kind, b, local) {
  if (!d.agent || isDemoActive()) return local(b);
  const { password, vcpass, otp, directorId, ...body } = b;   // eslint-disable-line no-unused-vars
  const settings = loadSettings();
  const args = { body };
  let site = null;
  if (kind === 'setup.director') args.defaults = { ...settings.defaults };
  if (kind === 'setup.fdIni' || kind === 'setup.thumbprint') {
    site = settings.sites.find((x) => x.vcenterId === String(b.vcenterId || '') && x.directorId === d.id) || null;
    if (!site) throw Object.assign(new Error('이 vCenter 는 이 Director 에 묶여 있지 않습니다.'), { code: 'invalid' });
    args.site = { ...site };
  }
  const consolePassword = kind === 'setup.director' ? newConsolePassword() : '';
  // v2.824 검토(S3·C7·I9 — 재현): 2단계는 엣지가 원격·엣지 사본을 바꾼 **뒤에** 중앙이 저장한다 — 중앙 판정과 저장 가능 여부를 **보내기 전에** 본다
  //   (보낸 뒤 planDirector 가 던지거나 같은 콘솔 충돌·비밀 정책 잠금으로 저장이 실패하면 Director 만 새 비밀번호가 된다).
  let conn = null;
  if (kind === 'setup.director') {
    const pl = planDirector(b);
    conn = { host: pl.ssh.host, port: pl.directorPort, consoleName: pl.consoleName, password: consolePassword };
    checkDirectorUpdate(d.id, conn);
  }
  const secretArgs = { password: String(password ?? ''), ...(kind === 'setup.fdIni' ? { vcpass: String(vcpass ?? '') } : {}), ...(consolePassword ? { consolePassword } : {}) };
  let value;
  try { value = await relayToEdge(d, kind, args, { secretArgs }); }
  catch (e) {
    // 엣지가 되돌렸다(새 콘솔 접속 실패·저장 실패) — 그사이 주기 조회가 남긴 인증 정지는 사실이 아니다(직접 경로 P2-12 와 같다 · C10)
    if (kind === 'setup.director' && (e?.code === 'console-login' || e?.code === 'save')) bareosAuthGuard.clearAuthStop(directorCred(d).id);
    throw e;
  }
  if (kind === 'setup.director') {
    let saved;
    try { saved = updateDirector(d.id, conn); }
    catch (se) {
      // 미리 본 판정을 지났는데도 실패(그사이 다른 저장·디스크) — 원격은 이미 새 콘솔이다. 사실대로 알린다(엣지에는 되돌릴 SSH 비밀번호가 남아 있지 않다).
      throw Object.assign(new Error(`법인 엣지 '${d.agent}' 가 Director 자동 설정을 끝냈지만(새 콘솔 접속 확인까지) 중앙 설정을 저장하지 못했습니다(${se?.code || '저장 오류'}) — 법인 Director 와 엣지 사본은 새 콘솔 비밀번호로 바뀌었고 중앙은 옛 값입니다. 이 Director 조회가 인증 실패로 멈출 수 있습니다. 원인을 고친 뒤 이 단계를 다시 실행하세요(포탈이 만든 파일을 덮어 새 콘솔로 맞춥니다).`), { code: 'save', files: value.files });
    }
    bareosAuthGuard.clearAuthStop(directorCred(d).id);
    return { ok: true, directorId: d.id, ...value, director: saved.director, droppedSecrets: saved.droppedSecrets, relay: d.agent };
  }
  return { ok: true, directorId: d.id, ...value, relay: d.agent, ...(site ? { vcenterId: site.vcenterId, vcserver: site.vcserver } : {}) };
}

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/preflight', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, () => {}, { otp: false })) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await runSetup(d, 'setup.preflight', b, (x) => preflight(x));
    const bad = r.items.filter((x) => x.status !== 'ok').length;
    audit(req, 'Bareos 자동 설정(사전 점검)', `${d.name} → ${String(b.host || '')}`, `점검 ${r.items.length}항목 · 확인 필요 ${bad}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(사전 점검)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { releaseSetup(d.id); }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/director', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planDirector)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await runSetup(d, 'setup.director', b, (x) => setupDirector(x));
    for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${d.id}|`)) _catalogMemo.delete(k);
    audit(req, 'Bareos 자동 설정(Director)', `${d.name} → ${String(b.host || '')}`, `성공 — 콘솔 ${r.director.consoleName} · ${r.files.map((f) => `${f.path}(${f.action})`).join(', ')}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(Director)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally {
    releaseSetup(d.id);
    // v2.822.3(C2-3): reload(성공·되돌리기 모두)는 포탈이 꺼 둔 잡을 다시 켠다 — 다음 정기 대조를 기다리지 않고 지금 그 Director 를 대조해 다시 끈다
    requestReconcile(d.id);
  }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-plugin', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planFdPlugin)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await runSetup(d, 'setup.fdPlugin', b, (x) => setupFdPlugin(x));
    audit(req, 'Bareos 자동 설정(FD 플러그인)', `${d.name} → ${String(b.host || '')}`, r.action === 'unchanged' ? '이미 켜져 있음(바꾸지 않음)' : `성공 — ${r.added.join(' · ')} · 사본 ${r.backup}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(FD 플러그인)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { releaseSetup(d.id); }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planFdIni)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await runSetup(d, 'setup.fdIni', b, (x) => setupFdIni(x));
    audit(req, 'Bareos 자동 설정(FD INI)', `${d.name} · ${r.vcenterId} → ${b.host}`, `성공 — ${r.path}(${r.action}) · 플러그인 ${r.plugin === 'installed' ? '설치됨' : '미확인'}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(FD INI)', `${d.name} · ${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { releaseSetup(d.id); }
});

/** FD 에서 vCenter 인증서 지문 읽기 — 쓰기 없음이라 OTP 는 걸지 않는다(SSH 접속은 하므로 동시 1건·데모 거부는 같다). */
api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-thumbprint', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, () => {}, { otp: false })) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await runSetup(d, 'setup.thumbprint', b, (x) => readFdThumbprint(x));
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${d.name} · ${r.vcenterId} → ${b.host}`, `성공 — ${r.vcserver}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${d.name} · ${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { releaseSetup(d.id); }
});

/** 등록 후보 VM — 조회 범위(밖 404). 등록 가능 여부와 사유, 그 vCenter 의 법인 Director 를 함께. */
api.get('/tools/bareos-backup/vm-candidates', adminOnly, (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vCenter 를 고르세요.' });
  const a = bareosAccess(req.user, vcenterId, { write: false });
  if (a) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const settings = effectiveSettings();
  const registered = new Set(listJobs().filter((j) => j.vcenterId === vcenterId).map((j) => j.vmId));
  const all = (store.get()?.vms || []).filter((v) => String(v.vcenterId) === vcenterId);
  const rows = all.slice().sort((x, y) => String(x.name).localeCompare(String(y.name))).slice(0, MAX_CANDIDATES).map((v) => {
    const el = eligibility(v, settings);
    return { id: v.id, name: v.name, powerState: v.powerState, template: !!v.template, dc: v.vcDcPath ?? null, folder: v.folderPath ?? null, ...osFields(v), eligible: el.ok, reason: el.ok ? '' : el.reason, registered: registered.has(v.id) };
  });
  const site = settings.sites.find((s) => s.vcenterId === vcenterId);
  const dir = site ? directorById(site.directorId, settings) : null;
  res.json({
    ok: true, vcenterId, total: all.length, returned: rows.length, items: rows,
    writable: bareosAccess(req.user, vcenterId) === 0, mapped: !!site && !siteMissing(site).length,
    // v2.825.1 버그 점검(G10): Director 콘솔 접속값이 덜 됐으면(주소 변경으로 비밀번호 폐기 등) 등록은 409 not-configured 로 끝난다 — 화면이 미리 알리고 잠근다
    director: dir ? { id: dir.id, name: dir.name, ready: isDemoActive() || !!directorConn(dir).conn, missing: isDemoActive() ? [] : (directorConn(dir).missing || []) } : null,
    mappingMissing: site ? siteMissing(site) : null,
    maxBulk: MAX_BULK, jobsLeft: Math.max(0, MAX_JOBS - listJobs().length),
  });
});

/** 백업 대상 등록 — body { vcenterId, vmId, level?, schedule? }. 잡은 그 vCenter 의 법인 Director 에 만든다. */
api.post('/tools/bareos-backup/jobs', adminOnly, async (req, res) => {
  const b = req.body || {};
  const a = bareosAccess(req.user, b.vcenterId);
  if (a === 404) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  if (a === 403) return res.status(403).json({ ok: false, reason: READ_ONLY });
  try {
    const job = await createBackupTarget({ vcenterId: String(b.vcenterId), vmId: String(b.vmId || ''), level: b.level, schedule: b.schedule, by: req.user?.username || '', demo: isDemoActive() });
    audit(req, 'Bareos 백업 대상 등록', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} · Director ${job.directorId} · FD ${job.client} · ${job.level}${job.schedule ? ` · ${job.schedule}` : ' · 스케줄 없음'}`);
    res.status(201).json({ ok: true, job });
  } catch (e) {
    audit(req, 'Bareos 백업 대상 등록', `${b.vcenterId}/${b.vmId}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    sendErr(res, e);
  }
});

/**
 * v2.822 여러 VM 한 번에 등록 — body { vcenterId, vmIds[], level?, schedule? }. vCenter 하나(= 법인 Director 하나) · 한 번에 MAX_BULK 대까지.
 * 범위(조회 밖 404 → 쓰기 밖 403)는 vCenter 단위로 한 번. 원장 여유(MAX_JOBS)를 Director 에 닿기 전에 확인한다.
 * 응답 200 { ok: 하나라도 등록, created, failed, results[{vmId, vmName, ok, jobId?, bareosJob?, reason?}], maxBulk }.
 */
api.post('/tools/bareos-backup/jobs/bulk', adminOnly, async (req, res) => {
  const b = req.body || {};
  const a = bareosAccess(req.user, b.vcenterId);
  if (a === 404) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  if (a === 403) return res.status(403).json({ ok: false, reason: READ_ONLY });
  if (!Array.isArray(b.vmIds)) return res.status(400).json({ ok: false, reason: 'vmIds(배열)를 보내세요.' });
  const vmIds = [...new Set(b.vmIds.filter((x) => typeof x === 'string' && x && x.length <= 300))];
  if (!vmIds.length) return res.status(400).json({ ok: false, reason: '등록할 VM 을 고르세요.' });
  if (vmIds.length > MAX_BULK) return res.status(400).json({ ok: false, reason: `한 번에 ${MAX_BULK}대까지 등록할 수 있습니다(${vmIds.length}대를 골랐습니다).`, maxBulk: MAX_BULK });
  if (registryLoadError()) return res.status(503).json({ ok: false, reason: '백업 대상 원장을 읽지 못한 상태라 새 대상을 추가하지 않습니다(손상본 보존).' });
  const left = MAX_JOBS - listJobs().length;
  if (vmIds.length > left) return res.status(400).json({ ok: false, reason: `백업 대상은 ${MAX_JOBS}개까지입니다 — 지금 ${Math.max(0, left)}대만 더 등록할 수 있습니다.` });
  const vcenterId = String(b.vcenterId);
  let results;
  try {
    results = await createBackupTargets({ vcenterId, vmIds, level: b.level, schedule: b.schedule, by: req.user?.username || '', demo: isDemoActive() });
  } catch (e) {
    audit(req, 'Bareos 백업 대상 일괄 등록', vcenterId, `실패 — ${vmIds.length}대 · ${String(e?.message || e).slice(0, 160)}`);
    return sendErr(res, e);
  }
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const names = (list) => list.slice(0, 20).map((r) => r.vmName || r.vmId).join(', ') + (list.length > 20 ? ` 외 ${list.length - 20}` : '');
  audit(req, 'Bareos 백업 대상 일괄 등록', vcenterId, `등록 ${ok.length}대${ok.length ? `(${names(ok)})` : ''} · 실패 ${bad.length}대${bad.length ? `(${names(bad)})` : ''}`);
  res.json({
    ok: ok.length > 0, ...(ok.length ? {} : { reason: '한 대도 등록하지 못했습니다 — 대상별 사유를 보세요.' }),
    created: ok.length, failed: bad.length, maxBulk: MAX_BULK,
    results: results.map((r) => ({ vmId: r.vmId, vmName: r.vmName, ok: r.ok, ...(r.ok ? { jobId: r.job.id, bareosJob: r.job.bareosJob } : { reason: r.reason || '사유 미상' }) })),
  });
});

/** 지금 실행 — body { level? }. 같은 대상이 실행 중이면 409. */
api.post('/tools/bareos-backup/jobs/:id/run', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  await oneAtATime(found, res, () => runRoute(req, res, getJob(found.id) || found));
});
async function runRoute(req, res, job) {
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  if (job.pending?.jobid) return res.status(409).json({ ok: false, reason: `이미 실행 중입니다(jobid ${job.pending.jobid}).` });
  if (!job.enabled) return res.status(409).json({ ok: false, reason: '비활성 대상입니다 — 먼저 활성화하세요.' });
  const level = normLevel(req.body?.level || job.level);
  try {
    const jobid = await onDirector(jobDir(job), 'runJob', { job: job.bareosJob, level });
    markPending(job.id, { jobid, level, by: req.user?.username, trigger: 'manual' });
    audit(req, 'Bareos 백업 실행', `${job.vcenterId}/${job.vmName}`, `jobid ${jobid} · ${level}`);
    res.status(202).json({ ok: true, jobid });
  } catch (e) {
    patchJob(job.id, { lastError: { at: Date.now(), message: String(e?.message || e).slice(0, 300) } });
    audit(req, 'Bareos 백업 실행', `${job.vcenterId}/${job.vmName}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    sendErr(res, e);
  }
}

/** 실행 중 취소 — 포탈이 시작한 실행(pending) 또는 그 대상의 실행 중 jobid(body.jobid — 잡 이름이 맞을 때만). */
api.post('/tools/bareos-backup/jobs/:id/cancel', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  // v2.822.3(C2-14·P2-6): 취소·활성 전환도 대상마다 한 번에 하나(삭제와 겹치면 Director 잡은 켜진 채 원장에서 사라졌다)
  await oneAtATime(found, res, () => cancelRoute(req, res, getJob(found.id)));
});
async function cancelRoute(req, res, job) {
  if (!job) return res.status(404).json({ ok: false, reason: '백업 대상을 찾을 수 없습니다.' });
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  const want = Number(req.body?.jobid || job.pending?.jobid || job.lastRun?.jobid || 0);
  if (!Number.isInteger(want) || want <= 0) return res.status(409).json({ ok: false, reason: '취소할 실행이 없습니다.' });
  if (orphanOf(job) && job.pending?.jobid) {   // C3: 물어볼 Director 가 없다 — 포탈의 추적만 내린다
    const note = `이 대상의 Director(${jobDir(job)})가 설정에 없어 포탈의 추적만 내렸습니다 — 실제 실행 결과는 그 Bareos 서버에서 확인하세요.`;
    clearPending(job.id, note);
    audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want} · Director 없음 — 포탈 추적 해제`);
    return res.json({ ok: true, jobid: want, cleared: true, note });
  }
  try {
    const out = await onDirector(jobDir(job), 'cancel', { jobid: want, name: job.bareosJob, pendingJobid: job.pending?.jobid ?? null });
    if (out.final) {
      // v2.825.1 버그 점검(G6): 백업 행(type B)만 실행 결과로 반영한다 — 같은 이름의 Copy·Migration 행을 lastRun·실패 메일에 넣지 않는다(폴러·로그 라우트와 같은 규칙)
      const isBackup = !out.final.type || out.final.type === 'B';
      if (isBackup) applyRunRow(job.id, out.final);
      return res.status(400).json({ ok: false, code: 'finished', reason: isBackup ? '이미 끝난 실행입니다 — 결과를 반영했습니다.' : '이미 끝난 실행입니다(백업 실행이 아니라 반영하지 않았습니다).' });
    }
    if (out.cleared) {
      // 포탈이 추적 중인 실행을 Director 가 모르면(재시작·다른 Director — P5) 추적만 내린다 — 그대로 두면 실행·삭제·복원이 계속 409 다.
      const note = `Director 카탈로그에 jobid ${want} 가 없어 포탈의 추적만 내렸습니다 — 실제 결과는 Director 에서 확인하세요.`;
      clearPending(job.id, note);
      audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want} · Director 에 없음 — 포탈 추적 해제`);
      return res.json({ ok: true, jobid: want, cleared: true, note });
    }
    audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want}`);
    res.json({ ok: true, jobid: want });
  } catch (e) { sendErr(res, e); }
}

/** 활성/비활성 — body { enabled }. Director 의 enable/disable job 과 원장을 함께 바꾼다. */
api.patch('/tools/bareos-backup/jobs/:id', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  await oneAtATime(found, res, () => patchRoute(req, res, getJob(found.id)));
});
async function patchRoute(req, res, job) {
  if (!job) return res.status(404).json({ ok: false, reason: '백업 대상을 찾을 수 없습니다.' });
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, reason: 'enabled(true/false) 만 바꿀 수 있습니다 — 레벨·스케줄은 대상을 지우고 다시 등록하세요(Bareos 에 잡 수정 명령이 없습니다).' });
  try {
    await onDirector(jobDir(job), 'setEnabled', { name: job.bareosJob, enabled: req.body.enabled });
    const j = patchJob(job.id, { enabled: req.body.enabled });
    if (!j) return res.status(409).json({ ok: false, reason: '그사이 대상이 지워졌습니다 — Director 잡 상태는 다음 대조 때 맞춥니다.' });
    audit(req, req.body.enabled ? 'Bareos 백업 대상 활성화' : 'Bareos 백업 대상 비활성화', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob}`);
    res.json({ ok: true, job: j });
  } catch (e) { sendErr(res, e); }
}

/**
 * 삭제 = Director 잡 비활성화 + 원장에서 제거. Bareos 에는 리소스 삭제 명령이 없어 conf 파일은 남는다(경로를 알려 준다).
 * Director 가 그 잡을 모르면(이미 지워짐) 원장만 지운다. 백업 데이터(볼륨)는 지우지 않는다.
 * 지운 잡 이름은 **그 잡의 Director** 로 기록한다(대조 틱이 다시 켜졌으면 그 Director 에서 다시 끈다).
 */
api.delete('/tools/bareos-backup/jobs/:id', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  await oneAtATime(found, res, () => deleteRoute(req, res, getJob(found.id) || found));
});
async function deleteRoute(req, res, job) {
  if (job.pending?.jobid) return res.status(409).json({ ok: false, reason: '실행 중인 대상은 지울 수 없습니다 — 끝나거나 취소한 뒤 다시 시도하세요.' });
  const dir0 = jobDir(job);
  if (orphanOf(job)) {   // C3(진행 중 복원도 물어볼 Director 가 없어 끝나지 않는다 — 함께 정리): 원장에서만 — Director 쪽 잡은 그대로라는 사실을 문구·감사에 남긴다
    deleteJob(job.id, { directorId: dir0 });
    audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} · Director(${dir0}) 설정 없음 — 원장에서만 삭제`);
    return res.json({ ok: true, note: `이 대상의 Director(${dir0})가 포탈 설정에 없어 원장에서만 지웠습니다. 그 Bareos 서버의 잡(bareos-dir.d/job/${job.bareosJob}.conf)은 그대로이고 스케줄이 있으면 계속 돕니다 — 그 서버에서 직접 정리하세요.` });
  }
  // 복원이 진행 중이면 지우지 않는다(P4) — 지우면 폴러가 그 복원을 더 추적하지 않아 결과를 영영 모른다.
  if ((job.restores || []).some(restoreOpen)) return res.status(409).json({ ok: false, reason: '복원이 진행 중인 대상은 지울 수 없습니다 — 복원이 끝난 뒤 다시 시도하세요.' });
  const dir = jobDir(job);
  if (job.demo && !isDemoActive()) {   // I8 — 데모 대상은 실제 Director 에 없다: 원장에서만
    deleteJob(job.id, { directorId: dir });
    audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `데모 대상 ${job.bareosJob} · 원장에서만 삭제`);
    return res.json({ ok: true, note: '데모 대상이라 원장에서만 지웠습니다(실제 Director 에는 이 잡이 없습니다).' });
  }
  { const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm }); }
  // disable 은 Director 메모리 값이라 reload·재시작이면 conf 값(활성)으로 돌아간다(I3) — 문구가 '비활성으로 남는다' 고 단정하지 않는다.
  let note = `Director 의 잡을 비활성화했습니다. 다만 Bareos 의 비활성화는 Director 를 reload·재시작하면 풀립니다(포탈이 상태 대조 때마다 다시 끕니다). 영구히 멈추려면 Director 호스트에서 잡 정의 파일(bareos-dir.d/job/${job.bareosJob}.conf)을 지우고 reload 하세요. 백업 데이터(볼륨)는 지우지 않았습니다.`;
  try {
    await onDirector(dir, 'setEnabled', { name: job.bareosJob, enabled: false });
  } catch (e) {
    if (!(e?.code === 'jsonrpc' && /not found|unknown|no job/i.test(e.message))) return sendErr(res, e);
    note = 'Director 에 이 잡이 이미 없습니다 — 원장에서만 지웠습니다.';
  }
  try { deleteJob(job.id, { directorId: dir }); } catch (e) {
    // v2.847 D2-7: 원장 쓰기 실패 — 원장은 그대로(되돌림)라 화면이 '삭제됨' 으로 보이지 않게 사실대로 말한다(Director 잡은 이미 껐다)
    audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} 비활성화 · 원장 쓰기 실패 — 원장에 남음`);
    return res.status(500).json({ ok: false, code: 'registry-write', reason: `Director 의 잡은 비활성화했지만 포탈 원장 파일에 쓰지 못해 대상은 원장에 그대로 남았습니다(${String(e?.message || e).slice(0, 200)}). 디스크 · 권한을 확인한 뒤 다시 지우세요 — 그때까지 이 대상은 백업되지 않습니다.` });
  }
  audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} 비활성화 · 원장 삭제`);
  res.json({ ok: true, note });
}

/** 실행 이력(그 잡의 Director 카탈로그 — 최근 30건). */
api.get('/tools/bareos-backup/jobs/:id/history', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  try { res.json({ ok: true, limit: HISTORY_LIMIT, items: await readDirector({ demoOnly: isDemoGuest(req.user) }, jobDir(job), 'history', { name: job.bareosJob, limit: HISTORY_LIMIT }) }); } catch (e) { sendErr(res, e); }
});

/** 작업 로그 — jobid 가 이 대상의 실행(잡 이름 일치)이거나 이 대상의 복원일 때만(범위 계정이 다른 잡 로그를 읽지 못하게). */
api.get('/tools/bareos-backup/jobs/:id/log', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  const jobid = Number(req.query.jobid);
  if (!Number.isInteger(jobid) || jobid <= 0) return res.status(400).json({ ok: false, reason: 'jobid 가 올바르지 않습니다.' });
  const isRestore = (job.restores || []).some((r) => r.jobid === jobid);
  try {
    const { log, row } = await readDirector({ demoOnly: isDemoGuest(req.user) }, jobDir(job), 'log', { jobid, name: job.bareosJob, isRestore });
    // v2.822.5: 로그를 연 김에 그 실행의 상태를 원장에 반영한다 — 폴러 주기(기본 60초)를 기다리지 않게(사용자 보고 '완료됐는데 실행 중').
    //   Director 호출은 늘지 않는다(위 'log' 작업의 상태 행은 원래 하던 이 대상 확인). 폴러와 같은 규칙만: 백업은 이 잡 이름의 백업 행(type B)만,
    //   복원은 복원 행(type R)만(W15). 반영 결과가 바뀌었으면 stateChanged 로 알린다(화면이 목록을 다시 읽는다).
    let stateChanged = false;
    if (row) {
      // 확인 시각(checkedAt)은 매번 바뀌므로 비교에서 뺀다 — 화면에 보이는 값(추적 중·최근 실행·복원 상태)만
      const sig = (j) => JSON.stringify([j?.pending?.jobid ?? null, j?.pending?.status ?? null,
        ...['jobid', 'status', 'bytes', 'files', 'endedAt'].map((k) => j?.lastRun?.[k] ?? null),
        (j?.restores || []).map((x) => [x.jobid, x.status, x.endedAt ?? null])]);
      const before = sig(getJob(job.id));
      if (!isRestore && row.name === job.bareosJob && (!row.type || row.type === 'B')) applyRunRow(job.id, row);
      else if (isRestore && (!row.type || row.type === 'R')) { if (applyRestoreRow(job.id, row)) finishRestores(); }   // v2.861 끝났으면 NIC 끊기
      stateChanged = sig(getJob(job.id)) !== before;
    }
    res.json({ ok: true, jobid, ...log, ...(row ? { state: row.state ?? null, status: row.status ?? null } : {}), stateChanged });
  } catch (e) { sendErr(res, e); }
});

/** 복원 지점 — 성공(T·W)한 백업 실행. */
api.get('/tools/bareos-backup/jobs/:id/restore-points', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  try {
    const rows = await readDirector({ demoOnly: isDemoGuest(req.user) }, jobDir(job), 'history', { name: job.bareosJob, limit: RESTORE_POINTS_SCAN });
    const items = rows.filter((r) => r.type === 'B' && (r.state === 'ok' || r.state === 'warning'));
    const site = effectiveSettings().sites.find((x) => x.vcenterId === job.vcenterId);
    // W7: 복원은 지금의 사이트 매핑 FD 로 실행한다(등록 때 FD 와 다를 수 있다) — 화면이 실제 값을 보이게
    res.json({ ok: true, items, restorePending: (job.restores || []).some(restoreOpen), restoreClient: site?.client || job.client, scanned: rows.length, limit: RESTORE_POINTS_SCAN });   // W2-6: 실제로 본 실행 수(상수가 아니다)
  } catch (e) { sendErr(res, e); }
});

/**
 * 복원 — body { jobid, mode:'original'|'newVm'|'localVmdk', newVm?:{name,datastore?,cluster?,esxHost?}, confirmName?, otp }.
 * 범위(404→403) → 복원 판정(restore.js) → 본인 OTP → (그 잡의 Director 에서) jobid 가 이 대상의 성공 백업인지 → 체인(이 잡의 이력으로만 — S1)
 * → restore … jobid=… all done yes(`select` 금지 — director.js runRestore). 원래 vCenter 로만(플러그인 제약).
 */
api.post('/tools/bareos-backup/jobs/:id/restore', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  await oneAtATime(found, res, () => restoreRoute(req, res, getJob(found.id) || found));
});
async function restoreRoute(req, res, job) {
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  const b = req.body || {};
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) return res.status(403).json({ ok: false, reason: '복원은 OTP 가 등록된 계정만 실행할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.', needEnroll: true });
  if ((job.restores || []).some(restoreOpen)) return res.status(409).json({ ok: false, reason: '이 대상의 다른 복원이 진행 중입니다.' });
  const jobid = Number(b.jobid);
  if (!Number.isInteger(jobid) || jobid <= 0) return res.status(400).json({ ok: false, reason: '복원할 백업(jobid)을 고르세요.' });
  const settings = effectiveSettings();
  const plan = restorePlan({ mode: b.mode, job, snapshot: store.get(), newVm: b.newVm, confirmName: b.confirmName, pluginName: settings.defaults.pluginName, jobid, base: restoreBaseOf(settings)(job) });   // v2.847 D2-1: 그 지점의 백업 때 위치로 판정
  if (!plan.ok) return res.status(400).json({ ok: false, reason: plan.issue });
  // v2.825.1 버그 점검(G2 — 재현): 설정만 보면 아는 전제(그 잡의 Director 가 있고 접속값이 갖춰졌는가)도 OTP **앞에서** 본다 —
  //   뒤에서 'not-configured' 로 실패하면 1회용 코드가 이미 쓰여, 설정을 고친 뒤 같은 코드는 '이미 사용됨' 이었다.
  if (!isDemoActive()) {
    const jd = directorById(jobDir(job), settings);
    if (!jd) return res.status(409).json({ ok: false, code: 'not-configured', reason: '이 백업 대상의 법인 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 확인하세요.' });
    const miss = directorConn(jd).missing;
    if (miss?.length) return res.status(409).json({ ok: false, code: 'not-configured', reason: `‘${jd.name}’ Director 설정이 덜 됐습니다(${miss.join('·')}) — 설정 › 법인별 Director 에서 먼저 채우세요.` });
  }
  // OTP 는 입력·전제 검사를 통과한 뒤에 쓴다(1회용 코드를 입력 실수로 태우지 않게). Director 에 닿기 전이다.
  if (config.auth.enabled) {
    const v = verifyUserOtp(name, b.otp);
    if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` });
  }
  const site = settings.sites.find((s) => s.vcenterId === job.vcenterId);
  const client = site?.client || job.client;
  try {
    const out = await onDirector(jobDir(job), 'restore', { jobid, name: job.bareosJob, client, restoreJob: settings.defaults.restoreJob, pluginOptions: plan.pluginOptions });
    addRestore(job.id, { jobid: out.rid, fromJobids: out.chain, mode: b.mode, target: plan.target, by: req.user?.username || '', client });
    audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `복원 jobid ${out.rid} · 방식 ${b.mode} · 원본 ${out.chain.join(',')}${plan.target?.name && b.mode === 'newVm' ? ` · 새 VM ${plan.target.name}` : ''}`);
    res.status(202).json({ ok: true, jobid: out.rid, fromJobids: out.chain, target: plan.target });
  } catch (e) {
    audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    sendErr(res, e);
  }
}

/* ───────────────────────── v2.861 묶음 복원(폴더에서 고른 VM 여러 대 — 사용자 요청 '백업처럼 폴더에서 선택해서 복원') ───────────────────────── */

const RESTORE_POINTS_KEEP = 30;   // 화면에 보이는 복원 지점(VM 마다) — 단건 화면과 같은 수
/** 옛 엣지는 새 작업 종류(restorePoints · restores)를 '알 수 없는 작업' 으로 거절한다 — 사람이 할 일을 덧붙인다(groupRunner.reasonOf 와 같은 뜻). */
const oldEdgeHint = (msg) => (/알 수 없는 (Director )?작업/.test(msg) ? `${msg} — 법인 엣지가 묶음 복원(v2.861)보다 오래된 판일 수 있습니다. 엣지를 업그레이드한 뒤 다시 하세요(엣지는 보내지 않았습니다).` : msg);
const idsOf = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x ?? '')).filter(Boolean))];

/**
 * 묶음 복원 지점 — body { ids:[원장 job id] } (1~50). 조회(범위 밖 항목은 '찾을 수 없음' — 존재를 흘리지 않는다).
 *   Director 마다 세션 하나(ops.restorePoints — 잡마다 list jobs 한 번 · 지점마다 체인 길이). 법인이 여럿이면 Director 끼리는 나란히.
 */
// v2.866 폴더별 VM 수 — restoreFolderCounts(모듈 위쪽) · 폴더 표를 열 때 한 번 읽는다(폴링 없음 · 조회 범위 안 vCenter 만)
api.get('/tools/bareos-backup/restore-folders', adminOnly, (req, res) => memoJson(req, res, 'bareos-restore-folders', (snap) => {
  const { jobs } = scopedJobs(req.user);
  const allowed = scopedVcenterIds(req.user, snap);
  const vms = allowed ? (snap?.vms || []).filter((v) => allowed.has(String(v.vcenterId))) : (snap?.vms || []);
  const vcNames = Object.fromEntries((snap?.vcenters || []).filter((v) => !allowed || allowed.has(String(v.id))).map((v) => [v.id, v.name || v.id]));
  return { ok: true, folders: restoreFolderCounts(jobs, vms), vcNames, inventoryAt: snap?.generatedAt ?? null };
}, { extraKey: scopeKey(req.user, store.get()) }));
api.post('/tools/bareos-backup/restore-points/bulk', adminOnly, async (req, res) => {
  const ids = idsOf(req.body?.ids);
  if (!ids.length) return res.status(400).json({ ok: false, reason: '복원 지점을 볼 VM 을 고르세요.' });
  if (ids.length > BULK_RESTORE_MAX) return res.status(400).json({ ok: false, reason: `한 번에 ${BULK_RESTORE_MAX}대까지 볼 수 있습니다.` });
  const settings = effectiveSettings();
  const items = new Map();
  const byDir = new Map();
  for (const id of ids) {
    const job = getJob(id);
    if (!job || bareosAccess(req.user, job.vcenterId, { write: false }) === 404) { items.set(id, { id, ok: false, reason: '백업 대상을 찾을 수 없습니다.' }); continue; }
    const site = settings.sites.find((x) => x.vcenterId === job.vcenterId);
    items.set(id, { id, vmName: job.vmName, vcenterId: job.vcenterId, restorePending: (job.restores || []).some(restoreOpen), restoreClient: site?.client || job.client });
    const d = jobDir(job);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push({ id, name: job.bareosJob });
  }
  await Promise.all([...byDir.entries()].map(async ([dir, list]) => {
    try {
      const out = await readDirector({ demoOnly: isDemoGuest(req.user) }, dir, 'restorePoints', { items: list.map((x, i) => ({ key: i, name: x.name })), scan: RESTORE_POINTS_SCAN, keep: RESTORE_POINTS_KEEP });
      const byKey = new Map((Array.isArray(out) ? out : []).map((r) => [r.key, r]));
      list.forEach((x, i) => {
        const r = byKey.get(i);
        const base = items.get(x.id);
        if (!r) items.set(x.id, { ...base, ok: false, code: 'unknown', reason: 'Director 회신에 이 VM 이 없습니다 — 다시 읽으세요.' });
        else if (!r.ok) items.set(x.id, { ...base, ok: false, code: r.code || 'error', reason: r.message || '복원 지점을 읽지 못했습니다.' });
        else items.set(x.id, { ...base, ok: true, points: r.points || [], scanned: r.scanned ?? null });
      });
    } catch (e) {
      const why = oldEdgeHint(String(e?.message || e).slice(0, 300));
      for (const x of list) items.set(x.id, { ...items.get(x.id), ok: false, code: e?.code || 'error', reason: why });
    }
  }));
  res.json({ ok: true, items: ids.map((id) => items.get(id)), limit: RESTORE_POINTS_SCAN, keep: RESTORE_POINTS_KEEP });
});

/**
 * 묶음 복원 판정 · 접근 · 진행 중 — 미리 보기(check)와 실행이 같은 함수를 쓴다(판정을 두 벌 두지 않는다).
 * @returns {{ status?:number, reason?:string, plan?:object, jobs?:Map }}
 */
const RESERVE_MS = 24 * 3600_000;   // 새 VM 복원 이름을 예약해 두는 시간(진행 중 + 끝난 뒤 하루 — 다음 인벤토리 수집 전 같은 이름을 막는다)
function bulkRestoreGate(req, items) {
  const raw = Array.isArray(items) ? items : [];
  // 상한을 먼저 — 항목마다 원장 조회(깊은 복사)를 돌기 전에(반증 검토 L2: 큰 본문 하나가 요청 경로를 1초 넘게 막았다). 판정은 bulkRestorePlan 이 같은 상한으로 한다.
  const list = raw.length > BULK_RESTORE_MAX ? raw.slice(0, BULK_RESTORE_MAX + 1) : raw;
  const jobs = new Map();
  const denied = new Map();
  let missing = 0; let readOnly = 0;
  for (const it of list) {
    const id = String(it?.id ?? '');
    const job = id ? getJob(id) : null;
    if (!job) { missing += 1; continue; }
    const a = bareosAccess(req.user, job.vcenterId, { write: true });
    if (a === 404) { missing += 1; continue; }   // 범위 밖 = 없는 것과 같다(존재를 흘리지 않는다)
    if (a === 403) { readOnly += 1; denied.set(id, READ_ONLY); jobs.set(id, job); continue; }
    const mm = modeMismatch(job);
    if (mm) { denied.set(id, mm); jobs.set(id, job); continue; }
    if ((job.restores || []).some(restoreOpen)) { denied.set(id, '이 VM 의 다른 복원이 진행 중입니다 — 끝난 뒤 다시 시도하세요.'); jobs.set(id, job); continue; }
    jobs.set(id, job);
  }
  const settings = effectiveSettings();
  // 최근 · 진행 중 새 VM 복원이 쓰는 이름(아직 인벤토리에 없다 — 반증 검토: 같은 이름 VM 이 둘이 되면 NIC 끊기도 손대지 못한다)
  const reservedNames = new Set();
  const since = Date.now() - RESERVE_MS;
  for (const j of listJobs()) {
    for (const r of j.restores || []) {
      if (r.mode === 'newVm' && r.target?.name && (restoreOpen(r) || (Number(r.at) || 0) >= since)) reservedNames.add(`${j.vcenterId}\u0000${String(r.target.name).toLowerCase()}`);
    }
  }
  const plan = bulkRestorePlan({ items: list, jobOf: (id) => jobs.get(id) || null, dirOf: jobDir, snapshot: store.get(), pluginName: settings.defaults.pluginName, reservedNames, baseOf: restoreBaseOf(settings) });
  for (const r of plan.items) if (denied.has(r.id)) { r.ok = false; r.issue = denied.get(r.id); }   // 접근 · 진행 중 사유가 판정 사유보다 앞선다(더 근본적)
  const bad = plan.items.filter((r) => !r.ok).length;
  if (bad && plan.ok) { plan.ok = false; plan.issue = `${bad}대를 복원할 수 없습니다 — 항목별 사유를 확인하세요(묶음 전체를 보내지 않았습니다).`; }
  // 실행 응답 코드: 조회 범위 밖(없음) 404 → 쓰기 범위 밖 403 → 그 밖의 판정 400(규약 — 조회 밖 404 · 쓰기 밖 403)
  const status = missing ? 404 : readOnly ? 403 : plan.ok ? 200 : 400;
  return { plan, jobs, settings, status };
}
/** 응답용 판정(플러그인 옵션 문자열은 싣지 않는다 — 내부 값). */
const planView = (plan) => ({
  ok: plan.ok, ...(plan.issue ? { issue: plan.issue } : {}), capacity: plan.capacity,
  items: plan.items.map((r) => ({ id: r.id, vmName: r.vmName || '', ok: r.ok, mode: r.mode, ...(r.issue ? { issue: r.issue } : {}), ...(r.ok ? { jobid: r.jobid, nic: r.nic, target: r.plan.target } : {}) })),
});

/** 묶음 복원 미리 보기 — body { items } · Director 에 닿지 않고 OTP 를 쓰지 않는다(판정 · 데이터스토어 여유만). */
api.post('/tools/bareos-backup/restore-check/bulk', adminOnly, (req, res) => {
  const { plan } = bulkRestoreGate(req, req.body?.items);
  res.json({ ok: true, plan: planView(plan), needEnroll: !!(config.auth.enabled && !getUser(req.user?.username || '')?.totpEnabled) });
});

/**
 * 묶음 복원 실행 — body { items:[{ id, jobid, mode, newVm?, confirmName?, nic?, allowDisksMismatch? }], otp }.
 * 단건 복원과 같은 순서: OTP 등록 → 접근 · 진행 중 · 판정(bulkRestoreGate — 하나라도 막히면 아무것도 보내지 않는다) → 대상 잠금 → Director 전제
 * → **그다음에** 본인 OTP 한 번 → (그 법인 Director 에서 세션 하나로 차례로) ops.restores → 항목마다 원장 · 감사.
 * 다른 법인 VM 을 섞을 수 없다(법인:vCenter:Bareos 1:1:1). 2대 이상이면 덮어쓰기 금지(bulkRestorePlan).
 */
api.post('/tools/bareos-backup/restore/bulk', adminOnly, async (req, res) => {
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) return res.status(403).json({ ok: false, reason: '복원은 OTP 가 등록된 계정만 실행할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.', needEnroll: true });
  const { plan, jobs, settings, status } = bulkRestoreGate(req, req.body?.items);
  if (status === 404) return res.status(404).json({ ok: false, reason: '백업 대상을 찾을 수 없습니다.' });
  if (status === 403) return res.status(403).json({ ok: false, reason: READ_ONLY });
  if (!plan.ok) return res.status(400).json({ ok: false, reason: plan.issue, plan: planView(plan) });
  const locked = [];
  for (const r of plan.items) {
    if (!tryLockJob(r.id)) { for (const id of locked) unlockJob(id); return res.status(409).json({ ok: false, reason: `‘${r.vmName}’ 의 다른 요청을 처리하는 중입니다 — 잠시 뒤 다시 시도하세요.` }); }
    locked.push(r.id);
  }
  const batchId = `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let noted = false;
  try {
    const dir = plan.directorId;
    if (!isDemoActive()) {
      const jd = directorById(dir, settings);
      if (!jd) return res.status(409).json({ ok: false, code: 'not-configured', reason: '이 법인의 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 확인하세요.' });
      const miss = directorConn(jd).missing;
      if (miss?.length) return res.status(409).json({ ok: false, code: 'not-configured', reason: `‘${jd.name}’ Director 설정이 덜 됐습니다(${miss.join('·')}) — 설정 › 법인별 Director 에서 먼저 채우세요.` });
    }
    // OTP 는 입력 · 전제 검사를 통과한 뒤에 한 번(1회용 코드를 입력 실수로 태우지 않게). Director 에 닿기 전이다.
    if (config.auth.enabled) {
      const v = verifyUserOtp(name, req.body?.otp);
      if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` });
    }
    noteRestoreBatchStart(batchId, `${plan.items.length}대 · ${directorById(dir, settings)?.name || dir}`);
    noted = true;
    const sendItems = plan.items.map((r, i) => {
      const job = jobs.get(r.id);
      const site = settings.sites.find((x) => x.vcenterId === job.vcenterId);
      return { key: i, jobid: r.jobid, name: job.bareosJob, client: site?.client || job.client, restoreJob: settings.defaults.restoreJob, pluginOptions: r.plan.pluginOptions };
    });
    let out;
    try {
      out = await onDirector(dir, 'restores', { items: sendItems });
    } catch (e) {
      // 엣지가 가져간 뒤 회신이 없으면 결과 모름 — 시작됐을 수 있다(다시 보내면 두 번 돈다)
      const unknown = !!e?.unknown || e?.code === 'unknown';
      for (const r of plan.items) audit(req, 'Bareos 복원 실행', `${r.vcenterId}/${r.vmName}`, `${unknown ? '결과 모름' : '실패'} — 묶음 ${batchId} · ${String(e?.message || e).slice(0, 160)}`);
      return sendErr(res, Object.assign(new Error(oldEdgeHint(String(e?.message || e))), { code: e?.code || '' }));
    }
    const byKey = new Map((Array.isArray(out) ? out : []).map((x) => [x.key, x]));
    const results = [];
    let saveErr = '';
    try {
    inBatch(() => {
      plan.items.forEach((r, i) => {
        const x = byKey.get(i);
        const job = jobs.get(r.id);
        if (x?.ok) {
          addRestore(job.id, { jobid: x.rid, fromJobids: x.chain, mode: r.mode, target: r.plan.target, by: name, client: sendItems[i].client, batchId, ...(r.nic ? { nic: r.nic } : {}) });
          results.push({ id: r.id, vmName: r.vmName, ok: true, jobid: x.rid });
          audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `복원 jobid ${x.rid} · 묶음 ${batchId} · 방식 ${r.mode} · 원본 ${(x.chain || []).join(',')}${r.mode === 'newVm' ? ` · 새 VM ${r.plan.target.name}` : ''}${r.nic === 'disconnect' ? ' · 네트워크 끊기' : ''}${r.plan.target?.allowDisksMismatch ? ' · 디스크 불일치 허용' : ''}`);
        } else {
          const code = x?.code || 'unknown';
          const reason = x?.message || 'Director 회신에 이 VM 이 없습니다 — 시작됐는지 알 수 없습니다. Director 에서 확인하세요.';
          results.push({ id: r.id, vmName: r.vmName, ok: false, code, reason });
          audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `${code === 'unknown' ? '결과 모름' : code === 'skipped' ? '건너뜀' : '실패'} — 묶음 ${batchId} · ${String(reason).slice(0, 160)}`);
        }
      });
    });
    } catch (e) {
      // 반증 검토 L5: 원장 저장(inBatch 끝)이 실패해도 복원은 이미 시작됐다 — 응답은 돌려준다(진행 추적이 안 될 수 있다고 밝힌다)
      saveErr = String(e?.message || e).slice(0, 200);
      console.warn(`[bareos] 묶음 복원 ${batchId} 원장 저장 실패: ${saveErr}`);
      audit(req, 'Bareos 묶음 복원', batchId, `원장 저장 실패 — 시작한 복원의 진행이 화면에 없을 수 있습니다(${saveErr})`);
    }
    const started = results.filter((x) => x.ok).length;
    audit(req, 'Bareos 묶음 복원', `${plan.items[0].vcenterId}/${plan.items[0].vmName}${plan.items.length > 1 ? ` 외 ${plan.items.length - 1}대` : ''}`, `묶음 ${batchId} · 시작 ${started} / ${results.length}대`);
    res.status(started ? 202 : 502).json({ ok: started > 0, batchId, started, total: results.length, items: results, ...(started ? {} : { reason: '한 대도 시작하지 못했습니다 — 항목별 사유를 확인하세요.' }),
      ...(saveErr ? { saveError: '복원은 시작했지만 원장에 남기지 못했습니다 — 진행 · 네트워크 끊기가 화면에 나오지 않을 수 있습니다. Director 와 vCenter 에서 확인하세요.' } : {}) });
  } finally {
    for (const id of locked) unlockJob(id);
    if (noted) noteRestoreBatchEnd(batchId);
  }
});

/* ───────────────────────── v2.862 복원 검증(리허설) · 일일 요약 메일 ───────────────────────── */

/**
 * 복원 검증 — 정책 · 최근 회차 · 결과(검증용 복원의 끝맺음). 정책은 전 법인 공용이라 저장 · 지금 검증은 전체 범위 관리자 + 본인 OTP(검증은 VM 을 만들고 데이터스토어를 쓴다).
 * 결과 목록은 조회 범위 안 대상만(범위 계정은 자기 법인 검증만 본다).
 */
api.get('/tools/bareos-backup/rehearsal', adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const st = rehearsalStatus();
  const results = [];
  for (const j of listJobs()) {
    if (allowed && !allowed.has(j.vcenterId)) continue;
    for (const r of j.restores || []) if (r.verify) results.push({ jobId: j.id, vmName: j.vmName, vcenterId: j.vcenterId, directorId: jobDir(j), rid: r.jobid, at: r.at ?? null, state: r.state, name: r.target?.name || '', finish: r.finish || null, run: r.rehearsal || '' });
  }
  results.sort((a, b) => (b.at || 0) - (a.at || 0));
  // 반증 F1(재현): Director 하나에 vCenter 가 여럿이면 회차 항목 · 정책 데이터스토어에 범위 밖 vCenter 의 VM 이름 · 사유 · DS 이름이 실렸다 —
  //   범위 계정에는 회차 항목을 자기 vCenter 대상만 · 정책 DS 는 자기 vCenter 만 · 저장한 계정은 싣지 않는다(restore-points 와 같은 규칙)
  const allJobs = listJobs();
  const vcOfJob = new Map(allJobs.map((j) => [j.id, j.vcenterId]));
  const visDirs = allowed ? new Set(allJobs.filter((j) => allowed.has(j.vcenterId)).map(jobDir)) : null;
  const policy = allowed
    ? { ...st.policy, savedBy: '', datastores: Object.fromEntries(Object.entries(st.policy.datastores || {}).filter(([vc]) => allowed.has(vc))) }
    : st.policy;
  const runs = st.runs.filter((x) => !visDirs || visDirs.has(x.directorId)).slice(0, 20)
    .map((x) => (allowed ? { ...x, items: (x.items || []).filter((it) => allowed.has(vcOfJob.get(it.jobId))) } : x));
  // v2.863 정책 화면의 vCenter 별 데이터스토어 칸 — 활성 대상이 있는 vCenter(정책 편집은 전체 범위 전용이라 범위 계정에는 싣지 않는다)
  let vcenters;
  if (!allowed) {
    const cnt = new Map();
    for (const j of allJobs) if (j.enabled !== false) cnt.set(j.vcenterId, (cnt.get(j.vcenterId) || 0) + 1);
    const vcName = new Map((store.get()?.vcenters || []).map((v) => [v.id, v.name || v.id]));
    vcenters = [...cnt].map(([id, jobs]) => ({ id, name: vcName.get(id) || id, jobs })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  res.json({
    ok: true, policy, loadError: st.loadError, fullScope: !allowed,
    ...(vcenters ? { vcenters } : {}),
    runs, results: results.slice(0, 100),
    weeks: Object.fromEntries(Object.entries(st.weeks).filter(([k]) => !visDirs || visDirs.has(k))),   // 법인별 마지막 회차 날짜(포탈 시각)
  });
});
api.put('/tools/bareos-backup/rehearsal', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) return res.status(403).json({ ok: false, needEnroll: true, reason: '복원 검증 정책은 OTP 가 등록된 계정만 저장할 수 있습니다.' });
  let next;
  try { next = normPolicy(req.body || {}); } catch (e) { return res.status(400).json({ ok: false, reason: String(e?.message || e) }); }   // 입력 확인을 OTP 앞에서
  if (policyLoadError()) return res.status(503).json({ ok: false, code: 'settingsUnreadable', reason: '복원 검증 정책 파일을 읽지 못해 저장하지 않습니다 — 손상본을 확인하세요.' });
  if (config.auth.enabled) { const v = verifyUserOtp(name, req.body?.otp); if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` }); }
  try {
    const saved = savePolicy(next, { by: name });
    audit(req, 'Bareos 복원 검증 정책', '전 법인', `${saved.enabled ? '켬' : '끔'} · 요일 ${saved.weekday} ${saved.time} · 법인마다 ${saved.perCorp}대 · 성공 ${saved.deleteOnOk ? '지움' : '남김'} · 데이터스토어 지정 ${Object.keys(saved.datastores || {}).length}곳`);
    res.json({ ok: true, policy: saved });
  } catch (e) { res.status(e?.code === 'unreadable' ? 503 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});
api.post('/tools/bareos-backup/rehearsal/run', adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) return res.status(403).json({ ok: false, needEnroll: true, reason: '복원 검증은 OTP 가 등록된 계정만 실행할 수 있습니다.' });
  const dirId = String(req.body?.directorId || '');
  const settings = effectiveSettings();
  if (!directorById(dirId, settings)) return res.status(404).json({ ok: false, reason: '그 Director 를 찾을 수 없습니다.' });
  if (policyLoadError()) return res.status(503).json({ ok: false, code: 'settingsUnreadable', reason: '복원 검증 정책 파일을 읽지 못했습니다.' });
  // 반증 F9: 설정만 보면 아는 전제(돌고 있음 · Director 접속값)는 OTP 앞에서 — 1회용 코드를 태우지 않게(단건 복원과 같은 규칙)
  if (rehearsalBusy()) return res.status(409).json({ ok: false, code: 'busy', reason: '다른 복원 검증이 진행 중입니다 — 끝난 뒤 다시 누르세요.' });
  if (!isDemoActive()) {
    const miss = directorConn(directorById(dirId, settings)).missing;
    if (miss?.length) return res.status(409).json({ ok: false, code: 'not-configured', reason: `그 Director 설정이 덜 됐습니다(${miss.join('·')}) — 설정 › 법인별 Director 에서 먼저 채우세요.` });
  }
  if (config.auth.enabled) { const v = verifyUserOtp(name, req.body?.otp); if (!v.ok) return res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` }); }
  try {
    const r = await runRehearsalNow(dirId, { by: name });
    res.status(r.started ? 202 : 200).json({ ok: r.ok, ...r });
  } catch (e) { sendErr(res, e); }
});

/** 일일 요약 메일 — 설정 · 마지막 발송 · 지금 보내 보기(전 법인 요약이라 전체 범위 관리자). */
api.get('/tools/bareos-backup/digest', adminOnly, fullScopeOnly, (req, res) => {
  res.json({ ok: true, config: loadDigest(), loadError: !!digestLoadError(), status: digestStatus() });
});
api.put('/tools/bareos-backup/digest', adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  try {
    normDigest(req.body || {});
    const saved = saveDigest(req.body || {}, { by: req.user?.username || '' });
    audit(req, 'Bareos 일일 요약 메일 설정', '전 법인', `${saved.enabled ? '켬' : '끔'} · ${saved.time}`);
    res.json({ ok: true, config: saved });
  } catch (e) { res.status(e?.code === 'unreadable' ? 503 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});
let _digestSentAt = 0;   // '지금 보내 보기' 는 1분에 한 번(반증 F10 — 메일 폭주 방지)
api.post('/tools/bareos-backup/digest/send', adminOnly, fullScopeOnly, async (req, res) => {
  if (Date.now() - _digestSentAt < 60_000) return res.status(429).json({ ok: false, reason: '방금 보냈습니다 — 1분 뒤 다시 누르세요.' });
  _digestSentAt = Date.now();
  const r = await sendDigestNow({ by: req.user?.username || '' });
  audit(req, 'Bareos 일일 요약 메일 보내 보기', '전 법인', r.ok ? (r.skipped ? '대상 없음' : '보냄') : `실패 — ${r.reason}`);
  res.status(r.ok ? 200 : 502).json(r);
});

/** 지금 상태 조회(폴러와 같은 가드 — 모든 Director). */
api.post('/tools/bareos-backup/poll', adminOnly, async (req, res) => {
  // v2.823 검토(S1): 범위 계정의 '지금 조회' 는 자기 법인 Director 만 조회한다(다른 법인 Director 에 접속·대조를 일으키지 않는다)
  const vis = visibleDirectorIds(req.user, effectiveSettings());
  if (vis) {
    const p = vis.size ? await pollOnce({ trigger: 'manual', directorIds: [...vis] }) : pollerStatus();
    return res.json({ ok: true, poller: scopedPoller(p, vis) });
  }
  const p = await pollOnce({ trigger: 'manual' });
  res.json({ ok: true, poller: addrVisible(req) ? p : maskedPoller(p) });
});

/**
 * 트리 배지 — 이 vCenter 의 활성 백업 대상 vmId. 로그인 + tools 권한, 범위 밖은 빈 목록(트리 폴링 경로라 404 소음을 만들지 않는다).
 */
api.get('/tools/bareos-backup/badges', requirePerm('tools'), (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!vcenterId || (allowed && !allowed.has(vcenterId))) return res.json({ vmIds: [] });
  res.json({ vmIds: jobVmIds(vcenterId) });
});

}
