// Bareos 완전 설치 라우트(v2.844 · 사용자 요청 '엣지 노드의 ip/id/pw 를 알고 있으니 bareos 를 완전히 자동으로 설치').
// 경로는 설정 탭 아래(/tools/bareos-backup/settings/install — 데모 계정 READ_DENY 접두가 덮는다 · 사용자 결정 '설치 기능은 설정에 넣어 일반 유저는 못 보게').
// 문지기(installGate): admin + 전체 조회 범위(fullScopeOnly) + 쓰기 범위 무제한(fullWriteOnly) + 데모 계정 403 + **OTP 를 등록한 계정만(코드 입력 없음)**
//   — 사용자 결정 '설치할 때 OTP 넣지 않고 설치' · '실행 계정 = OTP 를 등록한 관리자만'. 감사에는 '[OTP 없이 실행]' 을 붙인다.
// 데모(mock + 실제 Director 미등록) 모드는 install/demo.js 가 시간에 따라 진행하는 합성 작업을 돌려준다(장비·엣지에 닿지 않는다).
import { requireRole, getUser } from '../../auth/auth.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { writeScopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { isDemoActive } from '../../bareos/service.js';
import { isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { setupFdIni, readFdThumbprint } from '../../bareos/autoSetup.js';
import { directorById } from '../../bareos/settings.js';
import { claimSetup, releaseSetupLock, setupBusyReason } from '../../bareos/setupLocks.js';
import { setupAuditReason } from './bareosBackup.js';
import { STEPS } from '../../bareos/install/plan.js';
import { bundleBaseUrl, listBundles, fetchLatestBundle, bundleFetchStatus, deleteBundle } from '../../bareos/install/bundle.js';
import { listInstallTargets } from '../../bareos/install/targets.js';
import {
  runPrecheck, startInstall, retryInstall, stopInstall, rollbackAllInstall, installJob, listInstallJobs, knownHostAddrs, lastJobFor, finishContext,
} from '../../bareos/install/job.js';
import * as demo from '../../bareos/install/demo.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('Bareos 완전 설치는 전 법인 공용 설정이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
function fullWriteOnly(req, res, next) {
  let w = null;
  try { w = writeScopedVcenterIds(req.user, store.get()); } catch { w = new Set(); }
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: 'Bareos 완전 설치는 쓰기 범위(수정 가능 vCenter)가 지정되지 않은 계정만 실행할 수 있습니다.' });
  next();
}
const P = '/tools/bareos-backup/settings/install';
const OTP_OFF = '[OTP 없이 실행] ';
const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail: `${OTP_OFF}${detail}`, ip: req.ip || '' });

/** 쓰기 문지기 — 데모 계정 403 · 인증이 켜진 설치면 OTP 를 등록한 로컬 계정만(코드는 묻지 않는다). */
function installGate(req, res) {
  if (isDemoGuest(req.user)) { res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 실제 서버에 접속할 수 없습니다.' }); return false; }
  if (config.auth.enabled && !getUser(req.user?.username || '')?.totpEnabled) {
    res.status(403).json({ ok: false, needEnroll: true, reason: '완전 설치는 OTP 를 등록한 계정만 실행할 수 있습니다(코드는 묻지 않습니다 — 사용자 결정). 사용자 관리에서 OTP 를 등록하세요.' });
    return false;
  }
  return true;
}

function sendErr(res, e) {
  const code = e?.code || '';
  if (isSshHostKeyError(e)) return res.status(502).json({ ok: false, code: 'ssh-hostkey', reason: String(e.message).slice(0, 600) });
  if (code === 'ssh-auth' || isSshAuthError(e)) return res.status(502).json({ ok: false, code: 'ssh-auth', reason: '저장된 SSH 계정으로 로그인하지 못했습니다 — 배포 등록부의 비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다).' });
  const status = code === 'invalid' ? 400 : code === 'not-found' ? 404 : code === 'conflict' || code === 'precheck' ? 409 : 502;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 1800), ...(e?.precheck ? { precheck: e.precheck } : {}) });
}

// v2.846 S-2: 원격 출력이 실린 실패(remote · config-test …)는 자동 설정과 같은 함수로 자른다(감사에 원격 출력 원문을 싣지 않는다)
const auditReason = (e) => setupAuditReason(e);
/** 마무리 원격 작업 — 판정(가장 새 작업 · M5) → Director · 서버 잠금(자동 설정 · 법인별 설정과 공유 — C-3) → 실행 → 풀기. */
async function finishOp(req, res, label, fn) {
  let ctx;
  try { ctx = finishContext(req.params.id); } catch (e) { return sendErr(res, e); }
  const { j, c } = ctx;
  if (!claimSetup(j.directorId || `install:${j.id}`, c.host)) return res.status(409).json({ ok: false, reason: setupBusyReason(j.directorId, c.host) || '같은 Director · 서버에 다른 작업이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' });
  try {
    const r = await fn(j, c);
    audit(req, label, `${j.vcenterName} · ${j.id}`, `성공 — ${r.okText}`);
    res.json({ ok: true, ...r.body });
  } catch (e) { audit(req, label, `${j.vcenterName} · ${j.id}`, `실패 — ${auditReason(e)}`); sendErr(res, e); } finally { releaseSetupLock(j.directorId || `install:${j.id}`, c.host); }
}
const vcName = (id) => (store.get()?.vcenters || []).find((v) => v.id === id)?.name || id;

export function registerBareosInstall(api) {

/** 개요 — 대상 표 · 번들 · 받기 상태 · 최근 작업(비밀 없음). */
api.get(P, adminOnly, fullScopeOnly, async (req, res) => {
  if (isDemoActive()) return res.json(demo.overview());
  try {
    const known = knownHostAddrs();
    const targets = listInstallTargets({ knownHostAddrs: known }).map((t) => {
      const j = lastJobFor(t.vcenterId);
      return { ...t, lastJob: j ? { id: j.id, status: j.status, mode: j.mode, updatedAt: j.updatedAt, currentStep: j.currentStep ?? null } : null };
    });
    res.json({
      ok: true, demo: false, targets, bundles: await listBundles({ verify: false }), fetch: bundleFetchStatus(), bundleBaseUrl: bundleBaseUrl(),
      jobs: listInstallJobs().slice(0, 20).map((j) => ({ id: j.id, vcenterId: j.vcenterId, vcenterName: j.vcenterName, mode: j.mode, status: j.status, by: j.by, createdAt: j.createdAt, updatedAt: j.updatedAt })),
      steps: STEPS, otpOff: true,
    });
  } catch (e) { sendErr(res, e); }
});

/** 번들 받기(GitHub 릴리스 또는 BAREOS_BUNDLE_BASE_URL) — 백그라운드. 상태는 개요의 fetch. */
api.post(`${P}/bundle/fetch`, adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  if (isDemoActive()) return res.json(demo.fetchBundle());
  if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 쓸 수 없습니다.' });
  const st = bundleFetchStatus();
  if (st && !st.doneAt) return res.status(409).json({ ok: false, reason: '번들을 받는 중입니다.' });
  fetchLatestBundle().then((r) => audit(req, 'Bareos 완전 설치 번들 받기', r.version || '', r.ok ? (r.already ? '이미 최신(받지 않음)' : '성공 — 서명·해시 확인') : `실패 — ${String(r.reason || '').slice(0, 200)}`)).catch(() => {});
  res.status(202).json({ ok: true, started: true });
});

/** 폴더 다시 읽기(손으로 넣은 번들 검증 — 해시는 스트림). */
api.post(`${P}/bundle/rescan`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  if (isDemoActive()) return res.json(demo.overview());
  try { res.json({ ok: true, bundles: await listBundles({ verify: true }) }); } catch (e) { sendErr(res, e); }
});

api.delete(`${P}/bundle/:version`, adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  if (isDemoActive()) return res.json({ ok: true, demo: true });
  if (!installGate(req, res)) return;
  const v = String(req.params.version || '');
  const ok = deleteBundle(v);
  audit(req, 'Bareos 완전 설치 번들 삭제', v, ok ? '삭제' : '없음');
  res.json({ ok });
});

/** 사전 점검(쓰기 없음). */
api.post(`${P}/precheck`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '');
  if (isDemoActive()) return res.json(demo.precheck(vcenterId, req.body || {}));
  if (!installGate(req, res)) return;
  try {
    const r = await runPrecheck({ vcenterId, body: req.body || {} });
    audit(req, 'Bareos 완전 설치(사전 점검)', vcName(vcenterId), `정상 ${r.counts.ok} · 확인 ${r.counts.warn} · 불가 ${r.counts.bad} · 확인 불가 ${r.counts.unknown}`);
    res.json({ ok: true, ...r });
  } catch (e) { audit(req, 'Bareos 완전 설치(사전 점검)', vcName(vcenterId), `실패 — ${auditReason(e)}`); sendErr(res, e); }
});

/** 시작 — 계획 판정 → 시작 직전 점검 → 작업 생성(진행은 백그라운드). */
api.post(`${P}/start`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '');
  if (isDemoActive()) return res.json(demo.start(vcenterId, req.body || {}, req.user?.username || ''));
  if (!installGate(req, res)) return;
  try {
    const j = await startInstall({ vcenterId, body: req.body || {}, by: req.user?.username || '' });
    audit(req, j.mode === 'reinstall' ? 'Bareos 완전 초기화 후 재설치 시작' : 'Bareos 완전 설치 시작', `${j.vcenterName} · ${j.agent} (${j.sshHost})`, `${j.id} · 번들 ${j.bundle.version} · ${j.planText}`);
    res.json({ ok: true, job: j });
  } catch (e) { audit(req, 'Bareos 완전 설치 시작', vcName(vcenterId), `실패 — ${auditReason(e)}`); sendErr(res, e); }
});

api.get(`${P}/jobs/:id`, adminOnly, fullScopeOnly, (req, res) => {
  if (isDemoActive()) { const j = demo.job(String(req.params.id)); return j ? res.json({ ok: true, job: j }) : res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' }); }
  const j = installJob(String(req.params.id || ''));
  if (!j) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  res.json({ ok: true, job: j });
});

/** 다시 시도 — 실패한 단계부터(계획 값을 바꿀 수 있다 · 포탈에서 고치기). */
api.post(`${P}/jobs/:id/retry`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const id = String(req.params.id || '');
  if (isDemoActive()) { const j = demo.retry(id, req.body || {}, req.user?.username || ''); return j ? res.json({ ok: true, job: j }) : res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' }); }
  if (!installGate(req, res)) return;
  try {
    const j = await retryInstall(id, { body: req.body || {}, by: req.user?.username || '' });
    const a = j.attempts[j.attempts.length - 1];
    audit(req, 'Bareos 완전 설치 다시 시도', `${j.vcenterName} · ${j.id}`, `${a.n}회차 · ${a.fromStep}단계부터${a.fix ? ` · 고치기 ${a.fix}` : ''}${a.change ? ` · 바뀐 값 ${a.change}` : ''}`);
    res.json({ ok: true, job: j });
  } catch (e) { audit(req, 'Bareos 완전 설치 다시 시도', id, `실패 — ${auditReason(e)}`); sendErr(res, e); }
});

api.post(`${P}/jobs/:id/stop`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const id = String(req.params.id || '');
  if (isDemoActive()) { const j = demo.stop(id); return j ? res.json({ ok: true, job: j }) : res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' }); }
  if (!installGate(req, res)) return;
  try {
    const j = await stopInstall(id);
    audit(req, 'Bareos 완전 설치 중단 요청', `${j.vcenterName} · ${j.id}`, `${j.currentStep ?? '—'}단계가 끝나면 멈춤`);
    res.json({ ok: true, job: j });
  } catch (e) { sendErr(res, e); }
});

/** 전부 되돌리기 — 확인 표시(ack) 필요. */
api.post(`${P}/jobs/:id/rollback`, adminOnly, fullScopeOnly, fullWriteOnly, (req, res) => {
  const id = String(req.params.id || '');
  if (isDemoActive()) { const j = demo.rollback(id, req.body || {}); return j ? res.json({ ok: true, job: j }) : res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' }); }
  if (!installGate(req, res)) return;
  try {
    const j = rollbackAllInstall(id, { ack: req.body?.ack === true, by: req.user?.username || '' });
    audit(req, 'Bareos 완전 설치 전부 되돌리기', `${j.vcenterName} · ${j.id}`, '시작');
    res.json({ ok: true, job: j });
  } catch (e) { sendErr(res, e); }
});

/** 마무리 — FD 가 vCenter 지문을 읽는다(쓰기 없음). */
api.post(`${P}/jobs/:id/fd-thumbprint`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const id = String(req.params.id || '');
  if (isDemoActive()) return res.json(demo.thumbprint(id));
  if (!installGate(req, res)) return;
  await finishOp(req, res, 'Bareos 완전 설치(지문 읽기)', async (j, c) => {
    const r = await readFdThumbprint({ host: c.host, sshPort: c.port, username: c.username, password: c.password, vcenterId: j.vcenterId, directorId: j.directorId });
    return { okText: r.vcserver, body: r };
  });
});

/** 마무리 — vCenter 계정·비밀번호를 FD INI 로 한 번(저장하지 않는다 · 감사·응답에 없음). */
api.post(`${P}/jobs/:id/fd-ini`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const id = String(req.params.id || '');
  if (isDemoActive()) return res.json(demo.fdIni(id, req.body || {}));
  if (!installGate(req, res)) return;
  const j0 = installJob(id);
  if (j0 && !directorById(j0.directorId)) return res.status(409).json({ ok: false, reason: '이 설치의 Director 등록을 찾지 못했습니다.' });
  await finishOp(req, res, 'Bareos 완전 설치(FD INI)', async (j, c) => {
    const b = req.body || {};
    const r = await setupFdIni({ host: c.host, sshPort: c.port, username: c.username, password: c.password, vcenterId: j.vcenterId, directorId: j.directorId, vcuser: b.vcuser, vcpass: b.vcpass, vcthumbprint: b.vcthumbprint });
    return { okText: `${r.path}(${r.action})`, body: r };
  });
});
}
