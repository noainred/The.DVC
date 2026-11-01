// 법인별 Bareos 설정 · 중앙 계정 통합 라우트(v2.845 · 사용자 요청 '설정에 bareos web login 계정 설정/추가/비밀번호 변경 · 백업 스토리지 추가/관리 ·
//   법인별로 bareos 설정관리 · 중앙에서 bareos 백업 계정 통합관리').
// 경로는 설정 탭 아래(/tools/bareos-backup/settings/corp · /settings/accounts — 데모 계정 READ_DENY 접두가 덮는다).
// 문지기: admin + 전체 조회 범위(fullScopeOnly) + (쓰기) 쓰기 범위 무제한(fullWriteOnly) + 데모 계정 403 + Director · 서버 잠금(setupLocks — 자동 설정 · 완전 설치와 공유) +
//   **SSH root 쓰기**는 본인 OTP(세션 보안 bareosSetupOtp — 기본 켬 · 꺼도 OTP 를 등록한 계정만 · 입력 판정 **뒤에** 검증 — 입력 실수가 1회용 OTP 를 태우지 않게).
//   디스크 읽기(SSH 읽기)는 OTP 없음 · 대상 다시 등록(Director 콘솔 configure — 대상 등록과 같은 등급)은 OTP 없음.
// 비밀: SSH 비밀번호(입력 — 저장하지 않음) · 계정 비밀번호(입력 또는 생성)는 응답 · 감사 · 로그에 싣지 않는다. **생성한** 계정 비밀번호만 그 응답에 한 번 싣는다(화면이 한 번 보여 준다).
import { requireRole, verifyUserOtp, getUser } from '../../auth/auth.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { writeScopedVcenterIds } from '../../auth/scope.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { bareosSetupOtpRequired } from '../../security/securitySettings.js';
import { isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { directorById } from '../../bareos/settings.js';
import { isDemoActive, effectiveSettings } from '../../bareos/service.js';
import { claimSetup, releaseSetupLock, setupBusyReason } from '../../bareos/setupLocks.js';
import { noteSetupStart, noteSetupEnd } from '../../bareos/inflight.js';
import { requestReconcile } from '../../bareos/poller.js';
import { planManage, newAccountPassword, passwordIssue } from '../../bareos/manage/apply.js';
import {
  sshSource, publicSsh, resolveSsh, readConfig, knownFor, planFor, runManage, forgetConfig, accountsMatrix, missingTargets, reregisterTargets,
} from '../../bareos/manage/service.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('법인별 Bareos 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
function fullWriteOnly(req, res, next) {
  let w = null;
  try { w = writeScopedVcenterIds(req.user, store.get()); } catch { w = new Set(); }   // 판정이 던지면 거부 기본값
  if (w) return res.status(403).json({ ok: false, error: 'forbidden', reason: '법인별 Bareos 설정 · 계정은 전 법인 공용 쓰기라 쓰기 범위(수정 가능 vCenter)가 지정되지 않은 계정만 바꿀 수 있습니다.' });
  next();
}
const P = '/tools/bareos-backup/settings/corp';
const PA = '/tools/bareos-backup/settings/accounts';
export const MANAGE_ACTIONS = Object.freeze(['storage.add', 'storage.edit', 'storage.delete', 'console.add', 'console.password', 'console.delete', 'pools.edit']);
export const ACCOUNT_ACTIONS = Object.freeze(['console.add', 'console.password', 'console.delete']);
const LABEL = Object.freeze({
  scan: '디스크 읽기', 'storage.add': '스토리지 추가', 'storage.edit': '스토리지 편집', 'storage.delete': '스토리지 삭제',
  'console.add': 'WebUI 계정 추가', 'console.password': 'WebUI 계정 비밀번호 변경', 'console.delete': 'WebUI 계정 삭제', 'pools.edit': '포탈 풀 · 스케줄 편집',
});
const audit = (req, action, target, detail) => logAudit({ user: req.user?.username, action, target, detail: req.bareosOtpOff ? `[본인 OTP 재확인 꺼짐] ${detail}` : detail, ip: req.ip || '' });
const auditReason = (e) => {
  const code = e?.code || '';
  const msg = String(e?.message || e);
  // 원격 출력이 실린 코드는 첫 마디만(감사에 원격 출력을 싣지 않는다 — v2.822.3 I2-10 과 같다)
  if (['config-test', 'remote', 'console-login'].includes(code)) return `${code} ${msg.split(/[:(]/)[0].slice(0, 80).trim()}(원격 출력은 감사에 싣지 않습니다)`;
  return `${code} ${msg.split('\n')[0].slice(0, 200)}`.trim();
};

/** 비밀 없는 요약(감사용) — 이름 · 권한 · 경로 · 개수만. */
export function planSummary(plan) {
  switch (plan.action) {
    case 'storage.add': return `스토리지 ${plan.name}(장치 ${plan.device} · ${plan.archiveDevice} · 동시 ${plan.count})`;
    case 'storage.edit': return `스토리지 ${plan.name}(동시 ${plan.count})`;
    case 'storage.delete': return `스토리지 ${plan.name}`;
    case 'console.add': return `계정 ${plan.name}(${plan.profile})`;
    case 'console.password': case 'console.delete': return `계정 ${plan.name}`;
    case 'pools.edit': return [plan.pools ? `풀 보존 Full ${plan.pools.fullDays}일 · Incr ${plan.pools.incrDays}일 · 볼륨 ${plan.pools.maxVolumeGB}GB` : '', plan.schedule ? `스케줄 ${plan.schedule.fullDay} ${plan.schedule.time}` : ''].filter(Boolean).join(' · ');
    default: return plan.action;
  }
}

function sendErr(res, e) {
  const code = e?.code || '';
  if (isSshHostKeyError(e)) return res.status(502).json({ ok: false, code: 'ssh-hostkey', reason: String(e.message).slice(0, 600) });
  if (isSshAuthError(e)) return res.status(502).json({ ok: false, code: 'ssh-auth', reason: 'SSH 인증 실패 — 계정 · 비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다). 비밀번호가 맞다면 그 서버의 sshd 가 root 비밀번호 로그인을 막고 있을 수 있습니다(Rocky · RHEL 9 기본값 PermitRootLogin prohibit-password).' });
  const status = code === 'invalid' ? 400 : code === 'conflict' ? 409 : code === 'config-test' ? 422 : code === 'not-sent' ? 503 : code === 'unknown' ? 504 : code === 'not-found' ? 404 : 502;
  res.status(status).json({ ok: false, code: code || 'error', reason: String(e?.message || e).slice(0, 1800), ...(e?.needSsh ? { needSsh: true } : {}), ...(e?.paths ? { paths: e.paths } : {}) });
}

function directorFor(req, res) {
  const d = directorById(String(req.params.directorId || ''), effectiveSettings());
  if (!d) { res.status(404).json({ ok: false, reason: 'Director 를 찾을 수 없습니다.' }); return null; }
  return d;
}

/** OTP 단계 공통 — 등록 확인(코드 입력 전) · 꺼짐 표시. @returns {{ needOtp: boolean } | null} null 이면 응답을 이미 보냈다 */
function otpPrecheck(req, res, write) {
  const writeStep = write && config.auth.enabled;
  const needOtp = writeStep && bareosSetupOtpRequired();
  if (writeStep && !needOtp) req.bareosOtpOff = true;
  if (writeStep && !getUser(req.user?.username || '')?.totpEnabled) {
    res.status(403).json({ ok: false, needEnroll: true, ...(needOtp ? { otpRequired: true } : {}), reason: 'Bareos 서버 설정 변경은 OTP 가 등록된 계정만 실행할 수 있습니다(본인 OTP 재확인을 꺼 두어도 같습니다). 사용자 관리에서 OTP 를 등록하세요.' });
    return null;
  }
  return { needOtp };
}
function otpVerify(req, res, needOtp) {
  if (!needOtp) return true;
  const v = verifyUserOtp(req.user?.username || '', req.body?.otp);
  if (!v.ok) { res.status(403).json({ ok: false, otpRequired: true, reason: `OTP 인증 실패 — ${v.reason}` }); return false; }
  return true;
}
const demoGuestDeny = (req, res) => { if (!isDemoGuest(req.user)) return false; res.status(403).json({ ok: false, demoGuest: true, reason: '데모 계정은 실제 서버에 접속할 수 없습니다.' }); return true; };

/** 계정 비밀번호 — 생성(generate) 또는 입력. 생성이면 응답에 한 번 싣는다. */
function accountPasswordOf(action, body) {
  if (action !== 'console.add' && action !== 'console.password') return { pw: '', generated: false };
  if (body?.generate === true) return { pw: newAccountPassword(), generated: true };
  const pw = typeof body?.accountPassword === 'string' ? body.accountPassword : '';
  const pi = passwordIssue(pw);
  if (pi) throw Object.assign(new Error(pi), { code: 'invalid' });
  return { pw, generated: false };
}

export function registerBareosManage(api) {

/** 법인 목록 — Director 마다 묶인 vCenter · 담당 엣지 · SSH 출처(비밀 없음) · 잠금. */
api.get(P, adminOnly, fullScopeOnly, (req, res) => {
  try {
    const s = effectiveSettings();
    const showAddr = isAdminDetailUser(req.user);
    const vcName = new Map((store.get()?.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const directors = (s.directors || []).map((d) => {
      const ssh = publicSsh(sshSource(d));
      return {
        id: d.id, name: d.name, agent: d.agent || '', consoleName: d.consoleName || '', ...(showAddr ? { host: d.host } : {}),
        vcenters: (s.sites || []).filter((x) => x.directorId === d.id).map((x) => ({ id: x.vcenterId, name: vcName.get(x.vcenterId) || x.vcserver || x.vcenterId, storage: x.storage || '' })),
        ssh: showAddr ? ssh : { ...ssh, host: '' }, busy: !!setupBusyReason(d.id),
      };
    });
    res.json({ ok: true, demo: isDemoActive(), otpRequired: config.auth.enabled && bareosSetupOtpRequired(), directors, actions: MANAGE_ACTIONS });
  } catch (e) { sendErr(res, e); }
});

/** 그 Director 의 설정(콘솔 조회 — SSH 없음 · 비밀번호 칸 없음). refresh=1 이면 기억을 건너뛴다. */
api.get(`${P}/:directorId/config`, adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  try {
    const cfg = await readConfig(d, { refresh: req.query.refresh === '1' });
    const k = knownFor(d, cfg);
    res.json({ ok: true, directorId: d.id, ...cfg, portalConsole: k.portalConsole, mappedStorages: k.mappedStorages, sdAddress: isAdminDetailUser(req.user) ? k.address : '' });
  } catch (e) { sendErr(res, e); }
});

/** 디스크 · 볼륨 · 표지 읽기(SSH 읽기 — 쓰기 없음 · OTP 없음). */
api.post(`${P}/:directorId/scan`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (demoGuestDeny(req, res)) return;
  let ssh; let plan;
  const input = req.body?.input && typeof req.body.input === 'object' ? { path: req.body.input.path } : {};
  try {
    plan = planManage('scan', input);
    ssh = isDemoActive() ? { host: '', password: '' } : resolveSsh(d, req.body?.ssh);
  } catch (e) { return sendErr(res, e); }
  if (!claimSetup(d.id, ssh.host)) return res.status(409).json({ ok: false, reason: setupBusyReason(d.id, ssh.host) || '진행 중인 작업이 있습니다.' });
  try {
    const r = await runManage(d, { plan, known: {}, input }, ssh);
    res.json({ ok: true, directorId: d.id, ...r });
  } catch (e) { sendErr(res, e); } finally { releaseSetupLock(d.id, ssh.host); }
});

/** 쓰기 — 스토리지 · WebUI 계정 · 포탈 풀(SSH root · 포탈 표지 파일만). */
api.post(`${P}/:directorId/manage`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (demoGuestDeny(req, res)) return;
  const action = String(req.body?.action || '');
  if (!MANAGE_ACTIONS.includes(action)) return res.status(400).json({ ok: false, code: 'invalid', reason: '알 수 없는 작업입니다.' });
  const pre = otpPrecheck(req, res, true); if (!pre) return;
  const input = req.body?.input && typeof req.body.input === 'object' ? req.body.input : {};
  let ssh; let planned; let acct;
  try {
    ssh = isDemoActive() ? { host: '', password: '' } : resolveSsh(d, req.body?.ssh);
    acct = accountPasswordOf(action, req.body);
    planned = await planFor(d, action, input);
  } catch (e) { return sendErr(res, e); }
  if (setupBusyReason(d.id, ssh.host)) return res.status(409).json({ ok: false, reason: setupBusyReason(d.id, ssh.host) });
  if (!otpVerify(req, res, pre.needOtp)) return;
  if (!claimSetup(d.id, ssh.host)) return res.status(409).json({ ok: false, reason: setupBusyReason(d.id, ssh.host) || '진행 중인 작업이 있습니다.' });
  noteSetupStart(d.id, d.name);
  const label = LABEL[action];
  const sum = planSummary(planned.plan);
  try {
    const r = await runManage(d, { ...planned, input }, ssh, { accountPassword: acct.pw });
    forgetConfig(d.id);
    audit(req, `Bareos 법인 설정(${label})`, d.name, `성공 — ${sum} · ${(r.files || []).map((f) => `${f.path}(${f.action})`).join(', ')}${r.restarted ? ' · SD 재시작' : ''}${ssh.registry ? ' · SSH 배포 등록부' : ''}${acct.generated ? ' · 비밀번호 생성(응답에 한 번 표시)' : ''}`);
    res.json({ ok: true, directorId: d.id, action, ...r, ...(acct.generated ? { generatedPassword: acct.pw } : {}) });
  } catch (e) {
    audit(req, `Bareos 법인 설정(${label})`, d.name, `실패 — ${sum} · ${auditReason(e)}`);
    sendErr(res, e);
  } finally {
    releaseSetupLock(d.id, ssh.host); noteSetupEnd(d.id);
    // reload(성공 · 되돌리기 모두)는 포탈이 꺼 둔 잡을 다시 켠다 — 다음 정기 대조를 기다리지 않고 지금 대조해 다시 끈다(자동 설정과 같다)
    requestReconcile(d.id);
  }
});

/** 재설치 뒤 Director 에 없어진 원장 대상(.jobs 대조). */
api.get(`${P}/:directorId/missing`, adminOnly, fullScopeOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  try { res.json({ ok: true, directorId: d.id, items: await missingTargets(d) }); } catch (e) { sendErr(res, e); }
});

/** 다시 등록(Director 콘솔 configure — 대상 등록과 같은 등급 · OTP 없음). 고른 id 중 지금 다시 읽은 빠진 목록에 있는 것만. */
api.post(`${P}/:directorId/reregister`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  const d = directorFor(req, res); if (!d) return;
  if (demoGuestDeny(req, res)) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 3000).map(String) : [];
  if (!ids.length) return res.status(400).json({ ok: false, code: 'invalid', reason: '다시 등록할 대상을 고르세요.' });
  if (setupBusyReason(d.id)) return res.status(409).json({ ok: false, reason: setupBusyReason(d.id) });
  try {
    const r = await reregisterTargets(d, ids);
    const ok = r.results.filter((x) => x.ok).length;
    audit(req, 'Bareos 대상 다시 등록', d.name, `요청 ${ids.length} · 대상 ${r.results.length} · 성공 ${ok} · 실패 ${r.results.length - ok}`);
    if (ok) requestReconcile(d.id);
    res.json({ ok: true, directorId: d.id, ...r });
  } catch (e) {
    audit(req, 'Bareos 대상 다시 등록', d.name, `실패 — ${auditReason(e)}`);
    sendErr(res, e);
  }
});

/** 중앙 계정 통합 — 법인마다 WebUI 계정(콘솔 조회 · 동시 4 · 실패 법인은 사유). */
api.get(PA, adminOnly, fullScopeOnly, async (req, res) => {
  try {
    const m = await accountsMatrix({ refresh: req.query.refresh === '1', showAddr: isAdminDetailUser(req.user) });
    res.json({ ok: true, demo: isDemoActive(), otpRequired: config.auth.enabled && bareosSetupOtpRequired(), ...m });
  } catch (e) { sendErr(res, e); }
});

/**
 * 일괄 — 같은 계정을 고른 법인마다(추가 · 비밀번호 · 삭제). OTP 는 한 번(입력 판정 뒤). 법인마다 잠금 · SSH(등록부 또는 그 법인 입력 — 없으면 '보내지 않음') ·
 * 판정(그 법인 설정으로) · 실행. 한 법인의 실패가 다른 법인을 막지 않는다. 비밀번호: 입력이면 모든 법인 같은 값 · 생성이면 **법인마다 다른 값**(결과 행에 한 번).
 */
api.post(`${PA}/bulk`, adminOnly, fullScopeOnly, fullWriteOnly, async (req, res) => {
  if (demoGuestDeny(req, res)) return;
  const action = String(req.body?.action || '');
  if (!ACCOUNT_ACTIONS.includes(action)) return res.status(400).json({ ok: false, code: 'invalid', reason: '알 수 없는 계정 작업입니다.' });
  const pre = otpPrecheck(req, res, true); if (!pre) return;
  const input = { name: String(req.body?.name ?? '').trim(), profile: String(req.body?.profile ?? '').trim() };
  const s = effectiveSettings();
  const ids = [...new Set((Array.isArray(req.body?.directorIds) ? req.body.directorIds : []).map(String))];
  const dirs = ids.map((id) => directorById(id, s)).filter(Boolean);
  if (!dirs.length) return res.status(400).json({ ok: false, code: 'invalid', reason: '법인(Director)을 하나 이상 고르세요.' });
  let acct;
  try {
    planManage(action, input, {});   // 이름 · 권한 모양(법인별 판정은 아래에서 그 법인 설정으로 다시)
    acct = accountPasswordOf(action, req.body);
  } catch (e) { return sendErr(res, e); }
  if (!otpVerify(req, res, pre.needOtp)) return;
  const sshIn = req.body?.ssh && typeof req.body.ssh === 'object' ? req.body.ssh : {};
  const label = LABEL[action];
  const results = new Array(dirs.length);
  let next = 0;
  const one = async (d) => {
    const row = { directorId: d.id, name: d.name, ok: false, status: 'failed' };
    let ssh;
    try { ssh = isDemoActive() ? { host: '', password: '' } : resolveSsh(d, sshIn[d.id]); } catch (e) {
      return { ...row, status: 'skipped', needSsh: !!e?.needSsh, reason: `보내지 않음 — ${String(e?.message || e).slice(0, 300)}` };
    }
    if (!claimSetup(d.id, ssh.host)) return { ...row, status: 'skipped', reason: `보내지 않음 — ${setupBusyReason(d.id, ssh.host) || '진행 중인 작업이 있습니다.'}` };
    noteSetupStart(d.id, d.name);
    let sum = `계정 ${input.name}`;
    try {
      const planned = await planFor(d, action, input);
      sum = planSummary(planned.plan);
      // 생성이면 **법인마다 다른** 비밀번호(사용자 시안 — 한 법인의 비밀번호가 새도 다른 법인은 그대로) · 결과 행에 한 번만
      const pw = acct.generated ? newAccountPassword() : acct.pw;
      const r = await runManage(d, { ...planned, input }, ssh, { accountPassword: pw });
      forgetConfig(d.id);
      audit(req, `Bareos 계정 통합(${label})`, d.name, `성공 — ${sum} · ${(r.files || []).map((f) => `${f.path}(${f.action})`).join(', ')}${acct.generated ? ' · 법인별 비밀번호 생성(응답에 한 번 표시)' : ''}`);
      return { ...row, ok: true, status: 'done', files: r.files || [], relay: r.relay || '', ...(acct.generated && pw ? { generatedPassword: pw } : {}) };
    } catch (e) {
      audit(req, `Bareos 계정 통합(${label})`, d.name, `실패 — ${sum} · ${auditReason(e)}`);
      const code = isSshAuthError(e) ? 'ssh-auth' : isSshHostKeyError(e) ? 'ssh-hostkey' : (e?.code || 'error');
      return { ...row, code, status: code === 'unknown' ? 'unknown' : 'failed', reason: code === 'ssh-auth' ? 'SSH 인증 실패 — 계정 · 비밀번호를 확인하세요(자동으로 다시 시도하지 않습니다).' : String(e?.message || e).slice(0, 600) };
    } finally {
      releaseSetupLock(d.id, ssh.host); noteSetupEnd(d.id);
      requestReconcile(d.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, dirs.length) }, async () => { while (next < dirs.length) { const k = next++; results[k] = await one(dirs[k]); } }));
  res.json({ ok: true, action, account: input.name, results, passwordMode: acct.generated ? 'per-corp-generated' : (acct.pw ? 'same-input' : 'none') });
});

}
