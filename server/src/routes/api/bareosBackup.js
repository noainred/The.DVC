// Bareos VM 백업 라우트 — 특수 기능 'Bareos VM 백업'(v2.820, 도구 키 bareos-backup · v2.823 법인별 Director).
// 전부 admin 전용: Director 에 잡을 만들고 백업·복원을 실행하는 운영 작업이다(vm-clone 과 같은 등급 — server/CLAUDE.md RBAC).
// 범위: 백업 대상은 vCenter 귀속 — 조회 범위 밖 404(존재 은닉) → 쓰기 범위 밖 403. Director 설정·카탈로그·자동 설정은 전 법인 설정이라
//   전체 범위 전용(fullScopeOnly). 예외: /badges 는 트리(전 사용자) 표시용 — 로그인 + tools 권한, 범위 밖은 빈 목록.
// v2.823: 법인마다 Director 하나. 잡 라우트는 **원장에 고정된 그 잡의 Director**(settings.jobDirectorId)로만 명령을 보낸다(요청 값으로 고르지 않는다).
// 복원은 파괴적일 수 있어 **본인 OTP 재인증**을 더 건다(hostaccess 의 적용 경로와 같은 패턴).
import { requireRole, requirePerm, verifyUserOtp, getUser } from '../../auth/auth.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import {
  publicSettings, publicDirector, saveSettings, addDirector, updateDirector, deleteDirector, settingsLoadError, settingsRev,
  directorConn, directorCred, directorById, loadSettings, jobDirectorId, siteMissing, anyDirectorConfigured, LIMITS,
} from '../../bareos/settings.js';
import {
  listJobs, getJob, patchJob, deleteJob, markPending, addRestore, registryLoadError, jobVmIds, MAX_JOBS, restoreOpen, clearPending, applyRunRow, applyRestoreRow,
} from '../../bareos/registry.js';
import { parseBanner } from '../../bareos/director.js';
import { diagnoseConsole, DIAG_STAGES } from '../../bareos/console.js';
import { secretProvided } from '../../util/secretCarry.js';
import {
  onDirector, isDemoActive, effectiveSettings, eligibility, createBackupTarget, createBackupTargets, bareosAuthGuard,
} from '../../bareos/service.js';
import { pollerStatus, pollOnce, requestReconcile } from '../../bareos/poller.js';
import { restorePlan, placementDrift } from '../../bareos/restore.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { normLevel } from '../../bareos/names.js';
import { authStopView } from '../../util/authGuard.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import {
  planDirector, setupDirector, planFdIni, setupFdIni, readFdThumbprint, preflight, planFdPlugin, setupFdPlugin, VMWARE_POOL_FULL, VMWARE_SCHEDULE,
} from '../../bareos/autoSetup.js';
import { isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('Bareos Director 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
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

/** 오류 → HTTP 상태(사람이 읽는 사유는 그대로). */
function sendErr(res, e) {
  const code = e?.code || '';
  if (code === 'demo-only') return res.status(403).json({ ok: false, code, demoGuest: true, reason: String(e?.message || e) });
  const status = code === 'invalid' ? 400 : code === 'not-found' ? 404 : code === 'not-configured' || code === 'busy' || code === 'conflict' ? 409 : code === 'unavailable' ? 503
    : ['auth', 'pam', 'tls', 'connect', 'blocked', 'timeout', 'protocol', 'closed', 'too-large', 'jsonrpc', 'auth-stopped'].includes(code) ? 502 : 500;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 600) });
}

const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail, ip: req.ip || '' });

/**
 * 원장 job → 응답(비밀 없음). 범위 밖은 호출부가 거른다. directorId 는 풀어서 싣는다(옛 잡도 화면이 법인 열을 채우게).
 * v2.822(S3·I5): 등록 뒤 VM 의 이름·위치가 바뀌었으면 drift 를 단다.
 */
const viewJob = (j, vmById, settings) => {
  const drift = vmById ? placementDrift(j, vmById.get(j.vmId)) : null;
  return { ...j, directorId: jobDirectorId(j, settings), ...(drift ? { drift } : {}) };
};

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
const _busyJobs = new Set();
async function oneAtATime(job, res, fn) {
  if (_busyJobs.has(job.id)) return res.status(409).json({ ok: false, reason: '이 대상의 다른 요청을 처리하는 중입니다 — 잠시 뒤 다시 시도하세요.' });
  _busyJobs.add(job.id);
  try { return await fn(); } finally { _busyJobs.delete(job.id); }
}

/** 가린 판본의 폴러 상태 — 접속 오류 문구에는 Director 주소가 실릴 수 있어 코드만 남긴다(Director 별 상태도). */
const maskErr = (x) => (x?.error ? { ...x, error: `상태 조회 실패(${x.code || 'error'}) — 자세한 사유는 전체 범위 관리자 화면에 있습니다.` } : x);
function maskedPoller(p) {
  const out = maskErr(p);
  if (p?.directors) out.directors = Object.fromEntries(Object.entries(p.directors).map(([k, v]) => [k, maskErr(v)]));
  return out;
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
const _setupBusy = new Set();
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
  const status = code === 'invalid' ? 400 : code === 'conflict' ? 409 : code === 'config-test' ? 422 : 502;
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
  if (_setupBusy.has(dirId)) { res.status(409).json({ ok: false, reason: '이 Director 의 다른 자동 설정이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' }); return false; }
  // v2.822.3(I2-6 — 재현): 데모 Director 를 쓰는 동안은 화면 매핑이 데모 값이라 실제 서버 설정과 섞인다
  if (isDemoActive()) { res.status(409).json({ ok: false, reason: '데모 Director 를 쓰는 중입니다 — 자동 설정은 실제 Director 를 등록한 뒤(설정 › 법인별 Director 에서 추가) 쓸 수 있습니다.' }); return false; }
  const name = req.user?.username || '';
  if (otp && config.auth.enabled && !getUser(name)?.totpEnabled) { res.status(403).json({ ok: false, needEnroll: true, reason: '자동 설정은 OTP 가 등록된 계정만 실행할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.' }); return false; }
  try { plan({ ...(req.body || {}), directorId: dirId }); } catch (e) { sendSetupErr(res, e); return false; }
  if (otp && config.auth.enabled) {
    const v = verifyUserOtp(name, req.body?.otp);
    if (!v.ok) { res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` }); return false; }
  }
  _setupBusy.add(dirId);
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
    const l = Array.isArray(list) ? list : [];
    for (const p of prefer) if (l.includes(p)) return { value: p, why: p.startsWith('Portal') ? '포탈 자동 설정이 만든 이름' : '설치 기본 이름' };
    if (l.length === 1) return { value: l[0], why: '하나뿐' };
    return { value: '', why: l.length ? `후보 ${l.length}개 — 직접 고르세요` : 'Director 목록이 비어 있음', choices: l.slice(0, 20) };
  };
  const hostOf = (vc) => String(vc?.host || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vcenter';
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
        configFile: { value: `/etc/bareos/vmware/${slug(s.vcenterId)}.ini`, why: '포탈 기본 경로' },
      },
    };
  });
}

export function registerBareosBackup(api) {

/** 목록 + 상태(폴러·설정 요약·법인별 Director). */
api.get('/tools/bareos-backup', adminOnly, (req, res) => {
  const settings = effectiveSettings();
  const demo = isDemoActive();
  const { jobs, omitted, scoped } = scopedJobs(req.user);
  // Director 주소·콘솔 이름은 전 법인 설정(설정 탭과 같은 등급) — 범위 계정·데모 계정에는 가리고 법인 이름만 보인다(v2.743 AUTHZ-02 와 같은 원칙).
  const showAddr = addrVisible(req);
  const detail = !scopedVcenterIds(req.user, store.get()) && isAdminDetailUser(req.user);
  const vmById = new Map((store.get()?.vms || []).map((v) => [v.id, v]));
  const visibleSite = (s) => !scoped || bareosAccess(req.user, s.vcenterId, { write: false }) === 0;
  const mapped = settings.sites.filter(visibleSite).map((s) => s.vcenterId);
  const views = jobs.map((j) => viewJob(j, vmById, settings));
  const poller = showAddr ? pollerStatus() : maskedPoller(pollerStatus());
  const directors = settings.directors.map((d) => {
    const vcs = settings.sites.filter((s) => s.directorId === d.id && visibleSite(s)).map((s) => s.vcenterId);
    const n = views.filter((j) => j.directorId === d.id).length;
    return {
      id: d.id, name: d.name, ...(showAddr ? { host: d.host, port: d.port, consoleName: d.consoleName } : { masked: true }),
      hasPassword: !!d.password, configured: demo || !!directorConn(d).conn, vcenters: vcs, jobs: n,
      poll: poller.directors?.[d.id] || null, authStopped: authStopFor(d, demo, showAddr),
    };
  }).filter((d) => !scoped || d.vcenters.length || d.jobs);   // 범위 계정에는 자기 vCenter 의 법인만
  res.json({
    demo,
    configured: demo || anyDirectorConfigured(loadSettings()),
    directors,
    defaults: { level: settings.defaults.level, pollIntervalSec: settings.defaults.pollIntervalSec },
    sitesCount: mapped.length,   // v2.822(S5): 범위 계정에는 보이는 vCenter 의 매핑 수만
    mappedVcenters: mapped,
    jobs: views,
    ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}),
    poller,
    settingsLoadError: loadErrorView(settingsLoadError(), detail),
    registryLoadError: loadErrorView(registryLoadError(), detail),
  });
});

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
    directors: pub.directors.map((d) => ({ ...d, jobs: jobsByDir.get(d.id) || 0, busy: _setupBusy.has(d.id) })),
    limits: LIMITS,
    vcenters: (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, host: String(v.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') })),
    jobsByVcenter: Object.fromEntries([...listJobs().filter((j) => !j.demo).reduce((m, j) => m.set(j.vcenterId, (m.get(j.vcenterId) || 0) + 1), new Map())]),
    loadError: loadErrorView(settingsLoadError(), isAdminDetailUser(req.user)),
  });
});

/** 공통 기본값·매핑 저장(Director 접속값은 /settings/directors). 백업 대상이 있는 vCenter 의 Director 는 바꾸지 않는다. */
api.put('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.sites)) {
    const known = new Set((store.get()?.vcenters || []).map((v) => v.id));
    const unknown = body.sites.map((s) => String(s?.vcenterId || '')).filter((id) => id && !known.has(id));
    if (unknown.length) return res.status(400).json({ ok: false, reason: `인벤토리에 없는 vCenter 가 있습니다: ${unknown.slice(0, 5).join(', ')}` });
  }
  try {
    const r = saveSettings(body, { vcentersWithJobs: new Set(listJobs().filter((j) => !j.demo).map((j) => j.vcenterId)) });
    _catalogMemo.clear();
    audit(req, 'Bareos 설정 저장', '공통 기본값·매핑', `매핑 ${r.settings.sites.length}개 · Director ${r.settings.directors.length}개`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e?.code === 'conflict' ? 409 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** 법인 Director 추가 — body { name, host, port?, consoleName, password?, timeoutMs?, tlsMax? }. */
api.post('/tools/bareos-backup/settings/directors', adminOnly, fullScopeOnly, (req, res) => {
  const b = req.body || {};
  try {
    const r = addDirector(b);
    audit(req, 'Bareos Director 추가', r.director.name, `${r.director.host || '(주소 없음)'}:${r.director.port} · 콘솔 ${r.director.consoleName || '—'}${r.director.hasPassword ? ' · 비밀번호 있음' : ''}`);
    res.status(201).json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** Director 접속값 바꾸기 — 준 칸만. 주소·포트·콘솔 이름이 바뀌면 이 Director 의 저장 비밀번호를 폐기한다(새 비밀번호를 같이 주면 그것). */
api.put('/tools/bareos-backup/settings/directors/:directorId', adminOnly, fullScopeOnly, (req, res) => {
  const id = String(req.params.directorId || '');
  // v2.821: 자동 설정이 끝에 Director 연결을 저장한다 — 그 사이의 저장을 받으면 어느 한쪽이 조용히 덮인다.
  if (_setupBusy.has(id)) return res.status(409).json({ ok: false, reason: '이 Director 의 자동 설정이 진행 중입니다 — 끝난 뒤 저장하세요.' });
  const b = req.body || {};
  try {
    const r = updateDirector(id, b);
    for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${id}|`)) _catalogMemo.delete(k);
    audit(req, 'Bareos Director 저장', r.director.name, `${r.director.host || '(주소 없음)'}:${r.director.port} · 콘솔 ${r.director.consoleName || '—'}${secretProvided(b.password) ? ' · 비밀번호 변경' : ''}${r.droppedSecrets.length ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e?.code === 'not-found' ? 404 : 400).json({ ok: false, reason: String(e?.message || e) }); }
});

/** Director 지우기 — 매핑·백업 대상이 가리키면 409(잡은 그 Director 의 conf 에 있다). Bareos 서버 쪽은 건드리지 않는다. */
api.delete('/tools/bareos-backup/settings/directors/:directorId', adminOnly, fullScopeOnly, (req, res) => {
  const id = String(req.params.directorId || '');
  if (_setupBusy.has(id)) return res.status(409).json({ ok: false, reason: '이 Director 의 자동 설정이 진행 중입니다.' });
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
  try {
    if (isDemoActive() && !secretProvided(b.password)) {
      target = `${saved.name}(데모)`;
      const result = await onDirector(saved.id, 'probe');
      const stages = DIAG_STAGES.map(([key, label]) => ({ key, label, ok: true, ms: 0, detail: key === 'command' ? `클라이언트 ${(result.clients || []).length}개` : '데모 Director(합성 응답 — 접속하지 않습니다)' }));
      audit(req, 'Bareos 연결 시험', target, `성공 — ${result.director || '?'} ${result.version || ''}`);
      return res.json({ ok: true, ...result, stages, demo: true });
    }
    const fresh = secretProvided(b.password);
    const conn = fresh
      ? { host: String(b.host ?? saved.host), port: b.port ?? saved.port, name: String(b.consoleName ?? saved.consoleName), password: String(b.password), timeoutMs: b.timeoutMs ?? saved.timeoutMs, tlsMaxVersion: b.tlsMax ?? saved.tlsMax }
      : { host: saved.host, port: saved.port, name: saved.consoleName, password: saved.password || '', timeoutMs: saved.timeoutMs, tlsMaxVersion: saved.tlsMax };
    // v2.822(B4): 감사 대상은 **실제로 접속한 주소** — 저장 비밀번호로 시험하면 요청의 주소는 무시되므로 그것을 적으면 거짓 기록이다.
    target = `${saved.name} ${conn.host || '(미설정)'}:${conn.port || ''}`;
    if (!conn.host || !conn.name || !conn.password) return res.status(400).json({ ok: false, reason: '주소·콘솔 이름·비밀번호를 모두 채우세요(저장된 비밀번호로 시험하면 저장된 주소로만 접속합니다).' });
    const d = await diagnoseConsole(conn);
    if (!d.ok) {
      audit(req, 'Bareos 연결 시험', target, `실패 — ${d.failed?.key || '?'} ${d.failed?.code || ''} ${String(d.failed?.detail || '').slice(0, 120)}`);
      const f = d.stages.find((x) => x.ok === false);
      return res.status(502).json({ ok: false, code: d.failed?.code || 'error', reason: `${f?.label || '연결'} 단계에서 실패했습니다 — ${d.failed?.detail || ''}`.slice(0, 600), stages: d.stages });
    }
    if (!fresh) bareosAuthGuard.clearAuthStop(directorCred(saved).id);
    const { director, version } = parseBanner(d.banner);
    audit(req, 'Bareos 연결 시험', target, `성공 — ${director || '?'} ${version || ''}`);
    res.json({ ok: true, director, version, tls: d.tls, clients: d.clients, clientsError: '', stages: d.stages, demo: false });
  } catch (e) {
    audit(req, 'Bareos 연결 시험', target, `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 120)}`);
    sendErr(res, e);
  } finally { _testBusy.delete(saved.id); }
});

/** 매핑 드롭다운 원천(.clients·.storages·.pools·.schedules·.jobdefs·.filesets) — Director 마다 60초 기억(설정을 저장하면 새로 읽는다). */
async function catalogOf(d, refresh) {
  const key = `${isDemoActive()}|${d.id}|${settingsRev()}`;
  const m = _catalogMemo.get(key);
  if (!refresh && m && Date.now() - m.at < CATALOG_TTL_MS) return { cached: true, ...m.value };
  const value = await onDirector(d.id, 'catalog');
  for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${d.id}|`)) _catalogMemo.delete(k);
  _catalogMemo.set(key, { at: Date.now(), value });
  return value;
}
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
api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/preflight', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, () => {}, { otp: false })) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await preflight(b);
    const bad = r.items.filter((x) => x.status !== 'ok').length;
    audit(req, 'Bareos 자동 설정(사전 점검)', `${d.name} → ${String(b.host || '')}`, `점검 ${r.items.length}항목 · 확인 필요 ${bad}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(사전 점검)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy.delete(d.id); }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/director', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planDirector)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await setupDirector(b);
    for (const k of [..._catalogMemo.keys()]) if (k.includes(`|${d.id}|`)) _catalogMemo.delete(k);
    audit(req, 'Bareos 자동 설정(Director)', `${d.name} → ${String(b.host || '')}`, `성공 — 콘솔 ${r.director.consoleName} · ${r.files.map((f) => `${f.path}(${f.action})`).join(', ')}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(Director)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally {
    _setupBusy.delete(d.id);
    // v2.822.3(C2-3): reload(성공·되돌리기 모두)는 포탈이 꺼 둔 잡을 다시 켠다 — 다음 정기 대조를 기다리지 않고 지금 그 Director 를 대조해 다시 끈다
    requestReconcile(d.id);
  }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-plugin', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planFdPlugin)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await setupFdPlugin(b);
    audit(req, 'Bareos 자동 설정(FD 플러그인)', `${d.name} → ${String(b.host || '')}`, r.action === 'unchanged' ? '이미 켜져 있음(바꾸지 않음)' : `성공 — ${r.added.join(' · ')} · 사본 ${r.backup}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(FD 플러그인)', `${d.name} → ${String(b.host || '')}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy.delete(d.id); }
});

api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, planFdIni)) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await setupFdIni(b);
    audit(req, 'Bareos 자동 설정(FD INI)', `${d.name} · ${r.vcenterId} → ${b.host}`, `성공 — ${r.path}(${r.action}) · 플러그인 ${r.plugin === 'installed' ? '설치됨' : '미확인'}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(FD INI)', `${d.name} · ${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy.delete(d.id); }
});

/** FD 에서 vCenter 인증서 지문 읽기 — 쓰기 없음이라 OTP 는 걸지 않는다(SSH 접속은 하므로 동시 1건·데모 거부는 같다). */
api.post('/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-thumbprint', adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (!setupGate(req, res, d.id, () => {}, { otp: false })) return;
  const b = { ...(req.body || {}), directorId: d.id };
  try {
    const r = await readFdThumbprint(b);
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${d.name} · ${r.vcenterId} → ${b.host}`, `성공 — ${r.vcserver}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${d.name} · ${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${setupAuditReason(e)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy.delete(d.id); }
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
    return { id: v.id, name: v.name, powerState: v.powerState, template: !!v.template, dc: v.vcDcPath ?? null, folder: v.folderPath ?? null, eligible: el.ok, reason: el.ok ? '' : el.reason, registered: registered.has(v.id) };
  });
  const site = settings.sites.find((s) => s.vcenterId === vcenterId);
  const dir = site ? directorById(site.directorId, settings) : null;
  res.json({
    ok: true, vcenterId, total: all.length, returned: rows.length, items: rows,
    writable: bareosAccess(req.user, vcenterId) === 0, mapped: !!site && !siteMissing(site).length,
    director: dir ? { id: dir.id, name: dir.name } : null, mappingMissing: site ? siteMissing(site) : null,
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
  try {
    const out = await onDirector(jobDir(job), 'cancel', { jobid: want, name: job.bareosJob, pendingJobid: job.pending?.jobid ?? null });
    if (out.final) { applyRunRow(job.id, out.final); return res.status(400).json({ ok: false, code: 'invalid', reason: '이미 끝난 실행입니다 — 결과를 반영했습니다.' }); }
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
  deleteJob(job.id, { directorId: dir });
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
      else if (isRestore && (!row.type || row.type === 'R')) applyRestoreRow(job.id, row);
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
 * → restore … select all done yes. 원래 vCenter 로만(플러그인 제약).
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
  const plan = restorePlan({ mode: b.mode, job, snapshot: store.get(), newVm: b.newVm, confirmName: b.confirmName, pluginName: settings.defaults.pluginName });
  if (!plan.ok) return res.status(400).json({ ok: false, reason: plan.issue });
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

/** 지금 상태 조회(폴러와 같은 가드 — 모든 Director). */
api.post('/tools/bareos-backup/poll', adminOnly, async (req, res) => {
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
