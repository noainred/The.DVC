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
  listJobs, getJob, patchJob, deleteJob, markPending, addRestore, registryLoadError, jobVmIds,
} from '../../bareos/registry.js';
import {
  probe, catalogLists, runJob, cancelJob, setJobEnabled, jobHistory, jobLog, jobStatus, restoreChain, runRestore,
} from '../../bareos/director.js';
import { openConsole } from '../../bareos/console.js';
import { secretProvided } from '../../util/secretCarry.js';
import {
  withDirector, isDemoActive, effectiveSettings, eligibility, createBackupTarget, bareosAuthGuard,
} from '../../bareos/service.js';
import { pollerStatus, pollOnce } from '../../bareos/poller.js';
import { restorePlan, chainFromHistory, chainIssue } from '../../bareos/restore.js';
import { normLevel, isFinalStatus } from '../../bareos/names.js';
import { authStopView } from '../../util/authGuard.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('Bareos Director 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
const READ_ONLY = '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다(Bareos 백업·복원은 쓰기 범위가 필요합니다).';
const MAX_CANDIDATES = 5000;

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
  const status = code === 'invalid' ? 400 : code === 'not-configured' ? 409
    : ['auth', 'pam', 'tls', 'connect', 'blocked', 'timeout', 'protocol', 'closed', 'too-large', 'jsonrpc', 'auth-stopped'].includes(code) ? 502 : 500;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 600) });
}

const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail, ip: req.ip || '' });

/** 원장 job → 응답(그대로 — 비밀 없음). 범위 밖은 호출부가 거른다. */
const viewJob = (j) => j;

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

let _testBusy = false;
let _catalogMemo = { key: '', at: 0, value: null };

export function registerBareosBackup(api) {

/** 목록 + 상태(폴러·설정 요약). */
api.get('/tools/bareos-backup', adminOnly, (req, res) => {
  const settings = effectiveSettings();
  const demo = isDemoActive();
  const { jobs, omitted, scoped } = scopedJobs(req.user);
  const d = settings.director;
  const stop = demo ? null : bareosAuthGuard.peekAuthStop(directorCred(loadSettings()));
  // Director 주소·콘솔 이름은 전 법인 설정(설정 탭과 같은 등급) — 범위 계정·데모 계정에는 가린다(v2.743 AUTHZ-02 와 같은 원칙).
  const showAddr = demo || (!scoped && isAdminDetailUser(req.user));
  res.json({
    demo,
    configured: demo || !!directorConn(loadSettings()).conn,
    director: showAddr ? { host: d.host, port: d.port, consoleName: d.consoleName, hasPassword: !!d.password } : { masked: true, hasPassword: !!d.password },
    defaults: { level: settings.defaults.level, pollIntervalSec: settings.defaults.pollIntervalSec },
    sitesCount: settings.sites.length,
    mappedVcenters: settings.sites.map((s) => s.vcenterId).filter((id) => !scoped || bareosAccess(req.user, id, { write: false }) === 0),
    jobs: jobs.map(viewJob),
    ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}),
    poller: showAddr ? pollerStatus() : maskedPoller(pollerStatus()),
    authStopped: showAddr ? authStopView(stop) : (stop ? { ...authStopView(stop), reason: '인증 실패' } : null),
    settingsLoadError: settingsLoadError(),
    registryLoadError: registryLoadError(),
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
    loadError: settingsLoadError(),
  });
});

api.put('/tools/bareos-backup/settings', adminOnly, fullScopeOnly, (req, res) => {
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
 * 연결 시험. 새 비밀번호를 주면 요청의 주소로, 아니면 **저장값(주소·포트·콘솔 이름)에 고정**한다(v2.480 — 저장 비밀번호를
 * 다른 주소로 보내지 않는다). 동시에 1건.
 */
api.post('/tools/bareos-backup/settings/test', adminOnly, fullScopeOnly, async (req, res) => {
  if (_testBusy) return res.status(409).json({ ok: false, reason: '다른 연결 시험이 진행 중입니다 — 잠시 뒤 다시 시도하세요.' });
  _testBusy = true;
  const b = req.body?.director || {};
  try {
    let result;
    if (isDemoActive() && !secretProvided(b.password)) {
      result = await withDirector((s) => probe(s));
    } else {
      const saved = loadSettings().director;
      const fresh = secretProvided(b.password);
      const conn = fresh
        ? { host: String(b.host ?? saved.host), port: b.port ?? saved.port, name: String(b.consoleName ?? saved.consoleName), password: String(b.password), timeoutMs: b.timeoutMs ?? saved.timeoutMs, tlsMaxVersion: b.tlsMax ?? saved.tlsMax }
        : { host: saved.host, port: saved.port, name: saved.consoleName, password: saved.password || '', timeoutMs: saved.timeoutMs, tlsMaxVersion: saved.tlsMax };
      if (!conn.host || !conn.name || !conn.password) return res.status(400).json({ ok: false, reason: '주소·콘솔 이름·비밀번호를 모두 채우세요(저장된 비밀번호로 시험하면 저장된 주소로만 접속합니다).' });
      const s = await openConsole(conn);
      try { result = await probe(s); } finally { s.close(); }
      if (!fresh) bareosAuthGuard.clearAuthStop('director');
    }
    audit(req, 'Bareos 연결 시험', b.host || loadSettings().director.host || '(데모)', `성공 — ${result.director || '?'} ${result.version || ''}`);
    res.json({ ok: true, ...result, demo: isDemoActive() });
  } catch (e) {
    audit(req, 'Bareos 연결 시험', b.host || loadSettings().director.host || '', `실패 — ${e?.code || ''} ${String(e?.message || '').slice(0, 120)}`);
    sendErr(res, e);
  } finally { _testBusy = false; }
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

/** 지금 실행 — body { level? }. 같은 대상이 실행 중이면 409. */
api.post('/tools/bareos-backup/jobs/:id/run', adminOnly, async (req, res) => {
  const job = jobFor(req, res); if (!job) return;
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
});

/** 실행 중 취소 — 포탈이 시작한 실행(pending) 또는 그 대상의 실행 중 jobid(body.jobid — 잡 이름이 맞을 때만). */
api.post('/tools/bareos-backup/jobs/:id/cancel', adminOnly, async (req, res) => {
  const job = jobFor(req, res); if (!job) return;
  const want = Number(req.body?.jobid || job.pending?.jobid || job.lastRun?.jobid || 0);
  if (!Number.isInteger(want) || want <= 0) return res.status(409).json({ ok: false, reason: '취소할 실행이 없습니다.' });
  try {
    await withDirector(async (s) => {
      const row = await jobStatus(s, want);
      if (!row || row.name !== job.bareosJob) { const e = new Error('이 대상의 실행이 아닙니다.'); e.code = 'invalid'; throw e; }
      if (isFinalStatus(row.status)) { const e = new Error('이미 끝난 실행입니다.'); e.code = 'invalid'; throw e; }
      await cancelJob(s, want);
    });
    audit(req, 'Bareos 백업 취소', `${job.vcenterId}/${job.vmName}`, `jobid ${want}`);
    res.json({ ok: true, jobid: want });
  } catch (e) { sendErr(res, e); }
});

/** 활성/비활성 — body { enabled }. Director 의 enable/disable job 과 원장을 함께 바꾼다. */
api.patch('/tools/bareos-backup/jobs/:id', adminOnly, async (req, res) => {
  const job = jobFor(req, res); if (!job) return;
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
  const job = jobFor(req, res); if (!job) return;
  if (job.pending?.jobid) return res.status(409).json({ ok: false, reason: '실행 중인 대상은 지울 수 없습니다 — 끝나거나 취소한 뒤 다시 시도하세요.' });
  let note = `Director 의 잡 정의 파일(bareos-dir.d/job/${job.bareosJob}.conf)은 남아 있습니다(비활성) — 필요하면 Director 호스트에서 지우고 reload 하세요. 백업 데이터(볼륨)는 지우지 않았습니다.`;
  try {
    await withDirector((s) => setJobEnabled(s, job.bareosJob, false));
  } catch (e) {
    if (!(e?.code === 'jsonrpc' && /not found|unknown|no job/i.test(e.message))) return sendErr(res, e);
    note = 'Director 에 이 잡이 이미 없습니다 — 원장에서만 지웠습니다.';
  }
  deleteJob(job.id);
  audit(req, 'Bareos 백업 대상 삭제', `${job.vcenterId}/${job.vmName}`, `잡 ${job.bareosJob} 비활성화 · 원장 삭제`);
  res.json({ ok: true, note });
});

/** 실행 이력(Director 카탈로그 — 최근 30건). */
api.get('/tools/bareos-backup/jobs/:id/history', adminOnly, async (req, res) => {
  const job = jobFor(req, res, { write: false }); if (!job) return;
  try { res.json({ ok: true, items: await readDirector({ demoOnly: isDemoGuest(req.user) }, (s) => jobHistory(s, job.bareosJob, 30)) }); } catch (e) { sendErr(res, e); }
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
    const rows = await readDirector({ demoOnly: isDemoGuest(req.user) }, (s) => jobHistory(s, job.bareosJob, 60));
    const items = rows.filter((r) => r.type === 'B' && (r.state === 'ok' || r.state === 'warning'));
    res.json({ ok: true, items, restorePending: (job.restores || []).some((r) => !isFinalStatus(r.status)) });
  } catch (e) { sendErr(res, e); }
});

/**
 * 복원 — body { jobid, mode:'original'|'newVm'|'localVmdk', newVm?:{name,datastore?,cluster?,esxHost?}, confirmName?, otp }.
 * 범위(404→403) → 본인 OTP → 복원 판정(restore.js) → jobid 가 이 대상의 성공 백업인지 → 체인(.bvfs_get_jobids, 안 되면 이력으로)
 * → restore … select all done yes. 원래 vCenter 로만(플러그인 제약).
 */
api.post('/tools/bareos-backup/jobs/:id/restore', adminOnly, async (req, res) => {
  const job = jobFor(req, res); if (!job) return;
  const b = req.body || {};
  const name = req.user?.username || '';
  if (config.auth.enabled && !getUser(name)?.totpEnabled) return res.status(403).json({ ok: false, reason: '복원은 OTP 가 등록된 계정만 실행할 수 있습니다. 사용자 관리에서 OTP 를 등록하세요.', needEnroll: true });
  if ((job.restores || []).some((r) => !isFinalStatus(r.status))) return res.status(409).json({ ok: false, reason: '이 대상의 다른 복원이 진행 중입니다.' });
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
      let chain = null;
      try { chain = await restoreChain(s, jobid); } catch { chain = null; }
      if (!chain || chainIssue(chain, jobid)) chain = chainFromHistory(await jobHistory(s, job.bareosJob, 200), jobid);
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
});

/** 지금 상태 조회(폴러와 같은 가드). */
api.post('/tools/bareos-backup/poll', adminOnly, async (req, res) => {
  res.json({ ok: true, poller: await pollOnce({ trigger: 'manual' }) });
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
