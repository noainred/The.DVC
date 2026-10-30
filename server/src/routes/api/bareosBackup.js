// Bareos VM 백업 라우트 — 특수 기능 'Bareos VM 백업'(v2.820, 도구 키 bareos-backup).
// 전부 admin 전용: Director 에 잡을 만들고 백업·복원을 실행하는 운영 작업이다(vm-clone 과 같은 등급 — server/CLAUDE.md RBAC).
// 범위: 백업 대상은 vCenter 귀속 — 조회 범위 밖 404(존재 은닉) → 쓰기 범위 밖 403. Director 설정·카탈로그는 법인 축이 없는
//   전 법인 설정이라 전체 범위 전용(fullScopeOnly). 예외: /badges 는 트리(전 사용자) 표시용 — 로그인 + tools 권한, 범위 밖은 빈 목록.
// 복원은 파괴적일 수 있어 **본인 OTP 재인증**을 더 건다(hostaccess 의 적용 경로와 같은 패턴).
import { requireRole, requirePerm, verifyUserOtp, getUser } from '../../auth/auth.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import {
  publicSettings, saveSettings, settingsLoadError, directorConn, directorCred, loadSettings, LIMITS,
} from '../../bareos/settings.js';
import {
  listJobs, getJob, patchJob, deleteJob, markPending, addRestore, registryLoadError, jobVmIds, MAX_JOBS, restoreOpen, clearPending, applyRunRow,
} from '../../bareos/registry.js';
import {
  probe, parseBanner, catalogLists, runJob, cancelJob, setJobEnabled, jobHistory, jobRuns, jobLog, jobStatus, runRestore,
} from '../../bareos/director.js';
import { diagnoseConsole, DIAG_STAGES } from '../../bareos/console.js';
import { secretProvided } from '../../util/secretCarry.js';
import {
  withDirector, isDemoActive, effectiveSettings, eligibility, createBackupTarget, createBackupTargets, bareosAuthGuard,
} from '../../bareos/service.js';
import { pollerStatus, pollOnce } from '../../bareos/poller.js';
import { restorePlan, chainFromHistory, chainIssue, placementDrift } from '../../bareos/restore.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { normLevel, isFinalStatus } from '../../bareos/names.js';
import { authStopView } from '../../util/authGuard.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { planDirector, setupDirector, planFdIni, setupFdIni, readFdThumbprint } from '../../bareos/autoSetup.js';
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
 * 조회(GET)용 Director 호출 — 데모 계정은 데모 Director 일 때만 접속한다(사람이 등록한 Director 에는 403 · demoGuest.js 머리말).
 * 조회 라우트는 이 함수만 쓴다: server/test/audit2719b.test.js 가 `readDirector({ demoOnly: isDemoGuest(req.user) }` 모양을 대조한다.
 */
const readDirector = ({ demoOnly = false } = {}, fn) => withDirector(fn, { demoOnly });

/** 오류 → HTTP 상태(사람이 읽는 사유는 그대로). */
function sendErr(res, e) {
  const code = e?.code || '';
  if (code === 'demo-only') return res.status(403).json({ ok: false, code, demoGuest: true, reason: String(e?.message || e) });
  const status = code === 'invalid' ? 400 : code === 'not-configured' || code === 'busy' ? 409 : code === 'unavailable' ? 503
    : ['auth', 'pam', 'tls', 'connect', 'blocked', 'timeout', 'protocol', 'closed', 'too-large', 'jsonrpc', 'auth-stopped'].includes(code) ? 502 : 500;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 600) });
}

const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail, ip: req.ip || '' });

/**
 * 원장 job → 응답(비밀 없음). 범위 밖은 호출부가 거른다.
 * v2.822(S3·I5): 등록 뒤 VM 의 이름·위치가 바뀌었으면 drift 를 단다 — 잡은 등록 때의 이름·위치를 가리키므로 백업이 실패하고 덮어쓰기 복원은 막힌다.
 */
const viewJob = (j, vmById) => {
  const drift = vmById ? placementDrift(j, vmById.get(j.vmId)) : null;
  return drift ? { ...j, drift } : j;
};

/**
 * v2.822(검토 S2 — 재현): 설정·원장 로드 오류는 JSON.parse 원문이라 손상된 비밀번호 조각이 실렸다(루트 불변조건 '로드 오류 원문을 응답에 싣지 않는다').
 * 분류 + 위치 숫자 요약만 — 전체 범위 관리자 판본에는 위치까지, 그 밖에는 분류 이름만(isilonDirUsage storageRegistryErrorView 와 같은 규칙).
 */
function loadErrorView(err, detail) {
  if (!err) return null;
  const sum = summarizeRegistryError(err) || summarizeRegistryError({ reason: '' });
  return { at: Number.isFinite(err.at) ? err.at : null, code: sum.code, reason: detail ? sum.text : sum.label, ...(detail ? {} : { reasonDetailHidden: true }) };
}

/**
 * Director 주소·콘솔 이름·접속 오류 원문을 그대로 보여 줄 요청인가 — 전 법인 설정이라 **전체 범위 관리자 판본**만(데모 Director 는 가릴 것이 없다).
 * 목록 GET 과 수동 조회(POST /poll)가 같은 판정을 쓴다(v2.822 B3 — /poll 이 가리지 않던 것).
 */
function addrVisible(req) {
  if (isDemoActive()) return true;
  return !scopedVcenterIds(req.user, store.get()) && isAdminDetailUser(req.user);
}

/**
 * v2.822(B2) 대상별 처리 중 표시 — 실행·복원·취소·활성 전환·삭제는 Director 호출(비동기)을 사이에 두고 원장을 바꾼다.
 * '진행 중' 검사(pending) → Director 호출 → markPending 사이에 같은 대상의 두 번째 요청이 들어오면 둘 다 검사를 통과해 실행이 두 번 나갔다.
 * 대상마다 한 번에 하나만 받고 나머지는 409(사람이 다시 누르면 된다 — 줄 세우지 않는다).
 */
const _busyJobs = new Set();
async function oneAtATime(job, res, fn) {
  if (_busyJobs.has(job.id)) return res.status(409).json({ ok: false, reason: '이 대상의 다른 요청을 처리하는 중입니다 — 잠시 뒤 다시 시도하세요.' });
  _busyJobs.add(job.id);
  try { return await fn(); } finally { _busyJobs.delete(job.id); }
}

/** 가린 판본의 폴러 상태 — 접속 오류 문구에는 Director 주소가 실릴 수 있어 코드만 남긴다. */
const maskedPoller = (p) => (p?.error ? { ...p, error: `상태 조회 실패(${p.code || 'error'}) — 자세한 사유는 전체 범위 관리자 화면에 있습니다.` } : p);

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
 * v2.822(검토 I8 — 확인): 데모 대상(demo:true)은 데모 Director 에만, 실제 대상은 실제 Director 에만 있다. 설치 예제가 mock 으로 시작하면
 *   데모 대상이 실제 원장에 남는다 — 그 상태로 실제 Director 에 run·enable 을 보내지 않는다(이름이 없거나, 같은 이름의 남의 잡일 수 있다).
 */
function modeMismatch(job) {
  const demo = isDemoActive();
  if (job.demo && !demo) return '데모 대상입니다 — 실제 Director 에는 이 잡이 없습니다(지우기만 할 수 있습니다).';
  if (!job.demo && demo) return '실제 Director 의 대상입니다 — 지금은 데모 Director 를 쓰는 중이라 실행할 수 없습니다.';
  return '';
}

let _testBusy = false;
let _setupBusy = false;
let _catalogMemo = { key: '', at: 0, value: null };

/**
 * 자동 설정 오류 → 응답(v2.821). SSH 인증 실패는 자동 재시도하지 않는다(계정 잠금) — 사람이 고쳐 다시 누른다.
 * 호스트키 거부는 인증 실패가 아니다(문구 그대로 — 장비 신뢰에서 승인).
 */
function sendSetupErr(res, e) {
  const code = e?.code || '';
  if (isSshHostKeyError(e)) return res.status(502).json({ ok: false, code: 'ssh-hostkey', reason: String(e.message).slice(0, 600) });
  if (isSshAuthError(e)) return res.status(502).json({ ok: false, code: 'ssh-auth', reason: 'SSH 인증 실패 — 계정·비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다).' });
  const status = code === 'invalid' ? 400 : code === 'conflict' ? 409 : code === 'config-test' ? 422 : 502;
  res.status(status).json({ ok: false, code: code || 'ssh', reason: String(e?.message || e).slice(0, 1800), ...(e?.paths ? { paths: e.paths } : {}), ...(e?.files ? { files: e.files } : {}) });
}

/**
 * 원격 root 로 파일을 쓰는 자동 설정의 공통 문지기 — 데모 계정 403 · 동시 1건 · 입력 판정(plan) · **그다음** 본인 OTP.
 * 통과하면 true(그때 _setupBusy 를 잡는다 — 호출부가 finally 에서 푼다).
 */
function setupGate(req, res, plan) {
  if (isDemoGuest(req.user)) { res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 실제 서버를 설정할 수 없습니다.' }); return false; }
  if (_setupBusy) { res.status(409).json({ ok: false, reason: '다른 자동 설정이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' }); return false; }
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) { res.status(403).json({ ok: false, needEnroll: true, reason: '자동 설정은 OTP 가 등록된 계정만 실행할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.' }); return false; }
  try { plan(req.body || {}); } catch (e) { sendSetupErr(res, e); return false; }
  if (config.auth.enabled) {
    const v = verifyUserOtp(name, req.body?.otp);
    if (!v.ok) { res.status(403).json({ ok: false, reason: `OTP 인증 실패 — ${v.reason}` }); return false; }
  }
  _setupBusy = true;
  return true;
}

export function registerBareosBackup(api) {

/** 목록 + 상태(폴러·설정 요약). */
api.get('/tools/bareos-backup', adminOnly, (req, res) => {
  const settings = effectiveSettings();
  const demo = isDemoActive();
  const { jobs, omitted, scoped } = scopedJobs(req.user);
  const d = settings.director;
  const stop = demo ? null : bareosAuthGuard.peekAuthStop(directorCred(loadSettings()));
  // Director 주소·콘솔 이름은 전 법인 설정(설정 탭과 같은 등급) — 범위 계정·데모 계정에는 가린다(v2.743 AUTHZ-02 와 같은 원칙).
  const showAddr = addrVisible(req);
  const detail = !scopedVcenterIds(req.user, store.get()) && isAdminDetailUser(req.user);
  const vmById = new Map((store.get()?.vms || []).map((v) => [v.id, v]));
  const mapped = settings.sites.map((s) => s.vcenterId).filter((id) => !scoped || bareosAccess(req.user, id, { write: false }) === 0);
  res.json({
    demo,
    configured: demo || !!directorConn(loadSettings()).conn,
    director: showAddr ? { host: d.host, port: d.port, consoleName: d.consoleName, hasPassword: !!d.password } : { masked: true, hasPassword: !!d.password },
    defaults: { level: settings.defaults.level, pollIntervalSec: settings.defaults.pollIntervalSec },
    sitesCount: mapped.length,   // v2.822(S5): 범위 계정에는 보이는 vCenter 의 매핑 수만
    mappedVcenters: mapped,
    jobs: jobs.map((j) => viewJob(j, vmById)),
    ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}),
    poller: showAddr ? pollerStatus() : maskedPoller(pollerStatus()),
    authStopped: showAddr ? authStopView(stop) : (stop ? { ...authStopView(stop), reason: '인증 실패' } : null),
    settingsLoadError: loadErrorView(settingsLoadError(), detail),
    registryLoadError: loadErrorView(registryLoadError(), detail),
  });
});

/** Director 설정(전체 범위 관리자). */
api.get('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, (req, res) => {
  const snap = store.get();
  const demo = isDemoActive();
  const pub = demo ? (() => { const s = effectiveSettings(); const { password, ...dir } = s.director; return { director: { ...dir, password: '', hasPassword: !!password }, defaults: s.defaults, sites: s.sites }; })() : publicSettings();
  res.json({
    demo,
    ...pub,
    limits: LIMITS,
    vcenters: (snap?.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id, host: String(v.host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') })),
    loadError: loadErrorView(settingsLoadError(), isAdminDetailUser(req.user)),
  });
});

api.put('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, (req, res) => {
  // v2.821: 자동 설정이 끝에 Director 연결을 저장한다 — 그 사이의 저장을 받으면 어느 한쪽이 조용히 덮인다.
  if (_setupBusy) return res.status(409).json({ ok: false, reason: '자동 설정이 진행 중입니다 — 끝난 뒤 저장하세요.' });
  const body = req.body || {};
  if (Array.isArray(body.sites)) {
    const known = new Set((store.get()?.vcenters || []).map((v) => v.id));
    const unknown = body.sites.map((s) => String(s?.vcenterId || '')).filter((id) => id && !known.has(id));
    if (unknown.length) return res.status(400).json({ ok: false, reason: `인벤토리에 없는 vCenter 가 있습니다: ${unknown.slice(0, 5).join(', ')}` });
  }
  try {
    const r = saveSettings(body);
    _catalogMemo = { key: '', at: 0, value: null };
    audit(req, 'Bareos 설정 저장', r.settings.director.host || '(미설정)',
      `콘솔 ${r.settings.director.consoleName || '—'} · 사이트 매핑 ${r.settings.sites.length}개${secretProvided(body?.director?.password) ? ' · 비밀번호 변경' : ''}${r.droppedSecrets.length ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, reason: String(e?.message || e) }); }
});

/**
 * 연결 시험(v2.822 단계별 진단). 새 비밀번호를 주면 요청의 주소로, 아니면 **저장값(주소·포트·콘솔 이름)에 고정**한다
 * (v2.480 — 저장 비밀번호를 다른 주소로 보내지 않는다). 동시에 1건.
 * 응답: 성공 200 { ok, director, version, tls, clients, stages } · 실패 502 { ok:false, code, reason, stages } — stages 는
 * 주소 → DNS → TCP → TLS-PSK → 인증 → JSON 모드 → .clients 의 단계별 { ok|skipped, ms, detail, hint }(console.diagnoseConsole).
 */
api.post('/tools/bareos-backup/settings/test', adminOnly, fullScopeOnly, async (req, res) => {
  if (_testBusy) return res.status(409).json({ ok: false, reason: '다른 연결 시험이 진행 중입니다 — 잠시 뒤 다시 시도하세요.' });
  _testBusy = true;
  const b = req.body?.director || {};
  let target = '';
  try {
    if (isDemoActive() && !secretProvided(b.password)) {
      target = '(데모)';
      const result = await withDirector((s) => probe(s));
      const stages = DIAG_STAGES.map(([key, label]) => ({ key, label, ok: true, ms: 0, detail: key === 'command' ? `클라이언트 ${(result.clients || []).length}개` : '데모 Director(합성 응답 — 접속하지 않습니다)' }));
      audit(req, 'Bareos 연결 시험', target, `성공 — ${result.director || '?'} ${result.version || ''}`);
      return res.json({ ok: true, ...result, stages, demo: true });
    }
    const saved = loadSettings().director;
    const fresh = secretProvided(b.password);
    const conn = fresh
      ? { host: String(b.host ?? saved.host), port: b.port ?? saved.port, name: String(b.consoleName ?? saved.consoleName), password: String(b.password), timeoutMs: b.timeoutMs ?? saved.timeoutMs, tlsMaxVersion: b.tlsMax ?? saved.tlsMax }
      : { host: saved.host, port: saved.port, name: saved.consoleName, password: saved.password || '', timeoutMs: saved.timeoutMs, tlsMaxVersion: saved.tlsMax };
    // v2.822(B4): 감사 대상은 **실제로 접속한 주소** — 저장 비밀번호로 시험하면 요청의 주소는 무시되므로 그것을 적으면 거짓 기록이다.
    target = `${conn.host || '(미설정)'}:${conn.port || ''}`;
    if (!conn.host || !conn.name || !conn.password) return res.status(400).json({ ok: false, reason: '주소·콘솔 이름·비밀번호를 모두 채우세요(저장된 비밀번호로 시험하면 저장된 주소로만 접속합니다).' });
    const d = await diagnoseConsole(conn);
    if (!d.ok) {
      audit(req, 'Bareos 연결 시험', target, `실패 — ${d.failed?.key || '?'} ${d.failed?.code || ''} ${String(d.failed?.detail || '').slice(0, 120)}`);
      const f = d.stages.find((x) => x.ok === false);
      return res.status(502).json({ ok: false, code: d.failed?.code || 'error', reason: `${f?.label || '연결'} 단계에서 실패했습니다 — ${d.failed?.detail || ''}`.slice(0, 600), stages: d.stages });
    }
    if (!fresh) bareosAuthGuard.clearAuthStop('director');
    const { director, version } = parseBanner(d.banner);
    audit(req, 'Bareos 연결 시험', target, `성공 — ${director || '?'} ${version || ''}`);
    res.json({ ok: true, director, version, tls: d.tls, clients: d.clients, clientsError: '', stages: d.stages, demo: false });
  } catch (e) {
    audit(req, 'Bareos 연결 시험', target, `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 120)}`);
    sendErr(res, e);
  } finally { _testBusy = false; }
});

/**
 * 자동 설정(v2.821 — bareos/autoSetup.js). 전부 admin + 전체 범위 + 데모 계정 거부 + 동시 1건.
 * 쓰기(Director·FD INI)는 본인 OTP 를 더 건다(원격 root 로 설정 파일을 쓴다). SSH·vCenter 비밀번호는 저장하지 않는다.
 */
api.post('/tools/bareos-backup/settings/auto-setup/director', adminOnly, fullScopeOnly, async (req, res) => {
  if (!setupGate(req, res, planDirector)) return;
  const b = req.body || {};
  try {
    const r = await setupDirector(b);
    _catalogMemo = { key: '', at: 0, value: null };
    audit(req, 'Bareos 자동 설정(Director)', String(b.host || ''), `성공 — 콘솔 ${r.settings.director.consoleName} · ${r.files.map((f) => `${f.path}(${f.action})`).join(', ')}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(Director)', String(b.host || ''), `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 200)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy = false; }
});

api.post('/tools/bareos-backup/settings/auto-setup/fd', adminOnly, fullScopeOnly, async (req, res) => {
  if (!setupGate(req, res, planFdIni)) return;
  const b = req.body || {};
  try {
    const r = await setupFdIni(b);
    audit(req, 'Bareos 자동 설정(FD INI)', `${r.vcenterId} → ${b.host}`, `성공 — ${r.path}(${r.action}) · 플러그인 ${r.plugin === 'installed' ? '설치됨' : '미확인'}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(FD INI)', `${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 200)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy = false; }
});

/** FD 에서 vCenter 인증서 지문 읽기 — 쓰기 없음이라 OTP 는 걸지 않는다(SSH 접속은 하므로 동시 1건·데모 거부는 같다). */
api.post('/tools/bareos-backup/settings/auto-setup/fd-thumbprint', adminOnly, fullScopeOnly, async (req, res) => {
  if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 실제 서버에 접속할 수 없습니다.' });
  if (_setupBusy) return res.status(409).json({ ok: false, reason: '다른 자동 설정이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' });
  _setupBusy = true;
  const b = req.body || {};
  try {
    const r = await readFdThumbprint(b);
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${r.vcenterId} → ${b.host}`, `성공 — ${r.vcserver}`);
    res.json(r);
  } catch (e) {
    audit(req, 'Bareos 자동 설정(지문 읽기)', `${b.vcenterId || ''} → ${b.host || ''}`, `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 160)}`);
    sendSetupErr(res, e);
  } finally { _setupBusy = false; }
});

/** 사이트 매핑 드롭다운 원천(.clients·.storages·.pools·.schedules·.jobdefs·.filesets) — 60초 기억. */
api.get('/tools/bareos-backup/catalog', adminOnly, fullScopeOnly, async (req, res) => {
  const key = `${isDemoActive()}|${loadSettings().director.host}|${loadSettings().director.consoleName}`;
  if (req.query.refresh !== '1' && _catalogMemo.key === key && Date.now() - _catalogMemo.at < 60_000) return res.json({ ok: true, cached: true, ..._catalogMemo.value });
  try {
    const value = await withDirector((s) => catalogLists(s));
    _catalogMemo = { key, at: Date.now(), value };
    res.json({ ok: true, ...value });
  } catch (e) { sendErr(res, e); }
});

/** 등록 후보 VM — 조회 범위(밖 404). 등록 가능 여부와 사유를 함께. */
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
  res.json({
    ok: true, vcenterId, total: all.length, returned: rows.length, items: rows,
    writable: bareosAccess(req.user, vcenterId) === 0, mapped: settings.sites.some((s) => s.vcenterId === vcenterId),
    maxBulk: MAX_BULK, jobsLeft: Math.max(0, MAX_JOBS - listJobs().length),
  });
});

/** 백업 대상 등록 — body { vcenterId, vmId, level?, schedule? }. */
api.post('/tools/bareos-backup/jobs', adminOnly, async (req, res) => {
  const b = req.body || {};
  const a = bareosAccess(req.user, b.vcenterId);
  if (a === 404) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  if (a === 403) return res.status(403).json({ ok: false, reason: READ_ONLY });
  try {
    const job = await createBackupTarget({ vcenterId: String(b.vcenterId), vmId: String(b.vmId || ''), level: b.level, schedule: b.schedule, by: req.user?.username || '', demo: isDemoActive() });
    audit(req, 'Bareos 백업 대상 등록', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} · FD ${job.client} · ${job.level}${job.schedule ? ` · ${job.schedule}` : ' · 스케줄 없음'}`);
    res.status(201).json({ ok: true, job });
  } catch (e) {
    audit(req, 'Bareos 백업 대상 등록', `${b.vcenterId}/${b.vmId}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    sendErr(res, e);
  }
});

/**
 * v2.822 여러 VM 한 번에 등록 — body { vcenterId, vmIds[], level?, schedule? }. vCenter 하나 · 한 번에 MAX_BULK 대까지.
 * 범위(조회 밖 404 → 쓰기 밖 403)는 vCenter 단위로 한 번(모든 VM 이 그 vCenter 의 인벤토리인지는 service.prepareTarget 이 VM 마다 본다).
 * 원장 여유(MAX_JOBS)를 Director 에 닿기 전에 확인한다 — 중간에 넘쳐 Director 잡만 생기는 일을 막는다.
 * 응답 200 { ok: 하나라도 등록, created, failed, results[{vmId, vmName, ok, jobId?, bareosJob?, reason?}], maxBulk } — 한 대의 실패가 나머지를 막지 않는다.
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
    const jobid = await withDirector((s) => runJob(s, { job: job.bareosJob, level }));
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
  const job = jobFor(req, res); if (!job) return;
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  const want = Number(req.body?.jobid || job.pending?.jobid || job.lastRun?.jobid || 0);
  if (!Number.isInteger(want) || want <= 0) return res.status(409).json({ ok: false, reason: '취소할 실행이 없습니다.' });
  try {
    const out = await withDirector(async (s) => {
      const row = await jobStatus(s, want);
      // 포탈이 추적 중인 실행을 Director 가 모르면(재시작·다른 Director — P5) 추적만 내린다 — 그대로 두면 실행·삭제·복원이 계속 409 다.
      if (!row && want === job.pending?.jobid) return { cleared: true };
      if (!row || row.name !== job.bareosJob) { const e = new Error('이 대상의 실행이 아닙니다.'); e.code = 'invalid'; throw e; }
      if (isFinalStatus(row.status)) { applyRunRow(job.id, row); const e = new Error('이미 끝난 실행입니다 — 결과를 반영했습니다.'); e.code = 'invalid'; throw e; }
      await cancelJob(s, want);
      return { cleared: false };
    });
    if (out.cleared) {
      const note = `Director 카탈로그에 jobid ${want} 가 없어 포탈의 추적만 내렸습니다 — 실제 결과는 Director 에서 확인하세요.`;
      clearPending(job.id, note);
      audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want} · Director 에 없음 — 포탈 추적 해제`);
      return res.json({ ok: true, jobid: want, cleared: true, note });
    }
    audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want}`);
    res.json({ ok: true, jobid: want });
  } catch (e) { sendErr(res, e); }
});

/** 활성/비활성 — body { enabled }. Director 의 enable/disable job 과 원장을 함께 바꾼다. */
api.patch('/tools/bareos-backup/jobs/:id', adminOnly, async (req, res) => {
  const job = jobFor(req, res); if (!job) return;
  const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm });
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ ok: false, reason: 'enabled(true/false) 만 바꿀 수 있습니다 — 레벨·스케줄은 대상을 지우고 다시 등록하세요(Bareos 에 잡 수정 명령이 없습니다).' });
  try {
    await withDirector((s) => setJobEnabled(s, job.bareosJob, req.body.enabled));
    const j = patchJob(job.id, { enabled: req.body.enabled });
    audit(req, req.body.enabled ? 'Bareos 백업 대상 활성화' : 'Bareos 백업 대상 비활성화', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob}`);
    res.json({ ok: true, job: j });
  } catch (e) { sendErr(res, e); }
});

/**
 * 삭제 = Director 잡 비활성화 + 원장에서 제거. Bareos 에는 리소스 삭제 명령이 없어 conf 파일은 남는다(경로를 알려 준다).
 * Director 가 그 잡을 모르면(이미 지워짐) 원장만 지운다. 백업 데이터(볼륨)는 지우지 않는다.
 */
api.delete('/tools/bareos-backup/jobs/:id', adminOnly, async (req, res) => {
  const found = jobFor(req, res); if (!found) return;
  await oneAtATime(found, res, () => deleteRoute(req, res, getJob(found.id) || found));
});
async function deleteRoute(req, res, job) {
  if (job.pending?.jobid) return res.status(409).json({ ok: false, reason: '실행 중인 대상은 지울 수 없습니다 — 끝나거나 취소한 뒤 다시 시도하세요.' });
  // 복원이 진행 중이면 지우지 않는다(P4) — 지우면 폴러가 그 복원을 더 추적하지 않아 결과를 영영 모른다.
  if ((job.restores || []).some(restoreOpen)) return res.status(409).json({ ok: false, reason: '복원이 진행 중인 대상은 지울 수 없습니다 — 복원이 끝난 뒤 다시 시도하세요.' });
  // disable 은 Director 메모리 값이라 reload·재시작이면 conf 값(활성)으로 돌아간다(I3 — Bareos 도 그렇게 경고한다). 포탈이 대조 때마다 다시 끄지만
  //   그 사이 스케줄이 돌 수 있으니 영구히 멈추려면 conf 를 지워야 한다 — 문구가 '비활성으로 남는다' 고 단정하지 않는다.
  if (job.demo && !isDemoActive()) {   // I8 — 데모 대상은 실제 Director 에 없다: 원장에서만
    deleteJob(job.id);
    audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `데모 대상 ${job.bareosJob} · 원장에서만 삭제`);
    return res.json({ ok: true, note: '데모 대상이라 원장에서만 지웠습니다(실제 Director 에는 이 잡이 없습니다).' });
  }
  { const mm = modeMismatch(job); if (mm) return res.status(409).json({ ok: false, reason: mm }); }
  let note = `Director 의 잡을 비활성화했습니다. 다만 Bareos 의 비활성화는 Director 를 reload·재시작하면 풀립니다(포탈이 상태 대조 때마다 다시 끕니다). 영구히 멈추려면 Director 호스트에서 잡 정의 파일(bareos-dir.d/job/${job.bareosJob}.conf)을 지우고 reload 하세요. 백업 데이터(볼륨)는 지우지 않았습니다.`;
  try {
    await withDirector((s) => setJobEnabled(s, job.bareosJob, false));
  } catch (e) {
    if (!(e?.code === 'jsonrpc' && /not found|unknown|no job/i.test(e.message))) return sendErr(res, e);
    note = 'Director 에 이 잡이 이미 없습니다 — 원장에서만 지웠습니다.';
  }
  deleteJob(job.id);
  audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} 비활성화 · 원장 삭제`);
  res.json({ ok: true, note });
}

/** 실행 이력(Director 카탈로그 — 최근 30건). */
api.get('/tools/bareos-backup/jobs/:id/history', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  try { res.json({ ok: true, limit: HISTORY_LIMIT, items: await readDirector({ demoOnly: isDemoGuest(req.user) }, (s) => jobHistory(s, job.bareosJob, HISTORY_LIMIT)) }); } catch (e) { sendErr(res, e); }
});

/** 작업 로그 — jobid 가 이 대상의 실행(잡 이름 일치)이거나 이 대상의 복원일 때만(범위 계정이 다른 잡 로그를 읽지 못하게). */
api.get('/tools/bareos-backup/jobs/:id/log', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  const jobid = Number(req.query.jobid);
  if (!Number.isInteger(jobid) || jobid <= 0) return res.status(400).json({ ok: false, reason: 'jobid 가 올바르지 않습니다.' });
  const isRestore = (job.restores || []).some((r) => r.jobid === jobid);
  try {
    const out = await readDirector({ demoOnly: isDemoGuest(req.user) }, async (s) => {
      if (!isRestore) {
        const row = await jobStatus(s, jobid);
        if (!row || row.name !== job.bareosJob) { const e = new Error('이 대상의 실행이 아닙니다.'); e.code = 'invalid'; throw e; }
      }
      return jobLog(s, jobid);
    });
    res.json({ ok: true, jobid, ...out });
  } catch (e) { sendErr(res, e); }
});

/** 복원 지점 — 성공(T·W)한 백업 실행. */
api.get('/tools/bareos-backup/jobs/:id/restore-points', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  try {
    const rows = await readDirector({ demoOnly: isDemoGuest(req.user) }, (s) => jobHistory(s, job.bareosJob, RESTORE_POINTS_SCAN));
    const items = rows.filter((r) => r.type === 'B' && (r.state === 'ok' || r.state === 'warning'));
    const site = effectiveSettings().sites.find((x) => x.vcenterId === job.vcenterId);
    // W7: 복원은 지금의 사이트 매핑 FD 로 실행한다(등록 때 FD 와 다를 수 있다) — 화면이 실제 값을 보이게
    res.json({ ok: true, items, restorePending: (job.restores || []).some(restoreOpen), restoreClient: site?.client || job.client, scanned: rows.length, limit: RESTORE_POINTS_SCAN });   // W2-6: 실제로 본 실행 수(상수가 아니다)
  } catch (e) { sendErr(res, e); }
});

/**
 * 복원 — body { jobid, mode:'original'|'newVm'|'localVmdk', newVm?:{name,datastore?,cluster?,esxHost?}, confirmName?, otp }.
 * 범위(404→403) → 복원 판정(restore.js) → 본인 OTP → jobid 가 이 대상의 성공 백업인지 → 체인(이 잡의 이력으로만 — S1)
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
    const out = await withDirector(async (s) => {
      const row = await jobStatus(s, jobid);
      if (!row || row.name !== job.bareosJob || row.type !== 'B' || !(row.state === 'ok' || row.state === 'warning')) {
        const e = new Error('고른 jobid 는 이 대상의 성공한 백업이 아닙니다.'); e.code = 'invalid'; throw e;
      }
      // 체인은 이 잡의 이력으로만(v2.822 S1) — .bvfs_get_jobids 는 FD + FileSet 으로만 골라 같은 FD 의 다른 VM 이 섞인다.
      const runs = (await jobRuns(s, job.bareosJob)).filter((r) => !r.name || r.name === job.bareosJob);
      const chain = chainFromHistory(runs, jobid);
      const ci = chainIssue(chain, jobid);
      if (ci) { const e = new Error(ci); e.code = 'invalid'; throw e; }
      const rid = await runRestore(s, { client, jobids: chain, restoreJob: settings.defaults.restoreJob, pluginOptions: plan.pluginOptions });
      return { rid, chain };
    });
    addRestore(job.id, { jobid: out.rid, fromJobids: out.chain, mode: b.mode, target: plan.target, by: req.user?.username || '', client });
    audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `복원 jobid ${out.rid} · 방식 ${b.mode} · 원본 ${out.chain.join(',')}${plan.target?.name && b.mode === 'newVm' ? ` · 새 VM ${plan.target.name}` : ''}`);
    res.status(202).json({ ok: true, jobid: out.rid, fromJobids: out.chain, target: plan.target });
  } catch (e) {
    audit(req, 'Bareos 복원 실행', `${job.vcenterId}/${job.vmName}`, `실패 — ${String(e?.message || e).slice(0, 160)}`);
    sendErr(res, e);
  }
}

/** 지금 상태 조회(폴러와 같은 가드). */
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
