// 감사·알림·일일리포트·인증서·이상탐지·세션보안·OS스캔·프로비저닝 저장 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { verifyUserOtp } from '../../auth/auth.js';
import { saveSessionSecurity, loadConfiguredSecurity, managedAdminOwners } from '../../security/securitySettings.js';
import { loadSecretsPolicy, saveSecretsPolicy, migrateSecretFiles, SECRET_FILES } from '../../security/secretVault.js';
import { saveOsScanSettings, runOsScanNow, osScanStatus } from '../../inventory/osScanner.js';
import { getOsResults, osSummary } from '../../inventory/osStore.js';
import { listAudit, logAudit } from '../../audit.js';
import { alertStatus, saveAlertConfig, testAlert, getAnomalySettings, saveAnomalySettings } from '../../alerts.js';
import { createJob as createProvisionJob } from '../../provision/jobs.js';
import { updateSaved, removeSaved, getSaved } from '../../provision/saved.js';
import { store } from '../../store.js';
import { inUserWriteScope, scopedVcenterIds } from '../../auth/scope.js';
import { ssrfBlockReasonResolved } from '../../collector/registry.js';
import { dailyReportStatus, saveDailyReportSettings, runDailyReportNow } from '../../reports/dailyReport.js';
import { refreshCerts } from '../../security/certMonitor.js';
import { adminOnly, requireSettingsOwner } from './shared.js';
import { mergeScopedMap, filterScopedMap } from '../../auth/scopeMerge.js'; // v2.606 AUTHZ2606-07
import { todayStamp } from "../../util/dayKey.js";

/*
 * v2.604 AUTHZ-2604-05: 범위 제한 admin 에게 범위 밖 vCenter 의 발생 중·최근 알림(제목에 VM·호스트·DS 이름)을 주지 않는다 —
 *   같은 파일의 /os-scan(v2.599 AUTHZ-2599-05)·/tools/report/alerts 와 같은 기준. 귀속을 알 수 없는 항목
 *   (예: 해소 기록의 host:·ds: 키)은 **빼고 개수를 밝힌다**(범위 밖일 수 있다 — 추측으로 넣지 않는다).
 *   ⚠ 정직 기록: 전역 채널 설정(config — 웹훅 URL·vCenter별 임계)은 그대로 준다. 저장(PUT)이 전역이라 범위를
 *   나눌 축이 없고, 가리면 이 화면의 설정 폼이 빈 값으로 덮어쓴다 — 정책 결정 사항이다.
 */
export function alertVcenterOf(a, allowed) {
  if (!a || typeof a !== 'object') return null;
  if (typeof a.vcenterId === 'string' && a.vcenterId) return a.vcenterId;
  // vcenterId 필드가 없는 규칙(vc:·ramoc:·vcpuoc:·massoff:)은 키에 vCenter id 가 들어 있다.
  //   ⚠ 콜론으로 split 하지 않는다(vCenter id 에 콜론이 올 수 있다 — v2.598 VC2598 규약) — 허용 id 로 접두 대조.
  const key = typeof a.key === 'string' ? a.key : '';
  for (const pre of ['vc:', 'ramoc:', 'vcpuoc:', 'massoff:']) {
    if (!key.startsWith(pre)) continue;
    const rest = key.slice(pre.length);
    for (const id of allowed) {
      if (pre === 'vc:' || pre === 'massoff:' ? rest === id : rest.startsWith(`${id}:`)) return id;
    }
    return null;
  }
  return null;
}
export function scopeAlertStatus(st, allowed) {
  if (!allowed || !st) return st;
  const keep = (a) => { const vc = alertVcenterOf(a, allowed); return !!vc && allowed.has(vc); };
  const firing = (st.firing || []).filter(keep);
  const recent = (st.recent || []).filter(keep);
  return { ...st, firing, recent, scoped: true,
    omittedOutOfScope: { firing: (st.firing || []).length - firing.length, recent: (st.recent || []).length - recent.length } };
}

export function registerOpsSettings(adminRouter) {

// Audit log viewer (누가 언제 무엇을 했는지).
adminRouter.get('/audit', adminOnly, (req, res) => {
  res.json(listAudit({ limit: req.query.limit, offset: req.query.offset, user: req.query.user, q: req.query.q }));
});

// Alerting: config + current firing/recent, save config, send a test notification.
adminRouter.get('/alerts', adminOnly, (req, res) => res.json(scopeAlertStatus(alertStatus(), scopedVcenterIds(req.user, store.get()))));
adminRouter.put('/alerts', adminOnly, async (req, res) => {
  // 웹훅 URL은 서버가 대신 POST하는 주소 — SSRF resolved 가드(DNS 해석 결과까지)로 검증.
  // 루프백/링크로컬로 해석되는 이름을 저장해 두고 알림이 내부를 찌르는 우회를 차단한다.
  for (const key of ['slack', 'webhook', 'teams']) {
    const url = req.body?.channels?.[key]?.url;
    if (url) {
      const ssrf = await ssrfBlockReasonResolved(url);
      if (ssrf) return res.status(400).json({ ok: false, reason: `${key} 웹훅 URL: ${ssrf}` });
    }
  }
  res.json({ ok: true, config: saveAlertConfig(req.body || {}) });
});
adminRouter.post('/alerts/test', adminOnly, async (req, res) => res.json(await testAlert(req.user?.username)));

// 일일 헬스체크 리포트 — 스케줄 설정 + 즉시 발송(테스트).
adminRouter.get('/report/daily', adminOnly, (_req, res) => res.json(dailyReportStatus()));
adminRouter.put('/report/daily', adminOnly, (req, res) => {
  const s = saveDailyReportSettings(req.body || {});
  logAudit({ user: req.user?.username || 'unknown', action: '일일 리포트 설정 변경', detail: `enabled=${s.enabled} ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}` });
  res.json({ ok: true, settings: s });
});
adminRouter.post('/report/daily/run', adminOnly, async (req, res) => {
  const r = await runDailyReportNow();
  logAudit({ user: req.user?.username || 'unknown', action: '일일 리포트 수동 발송', detail: (r.results || []).join(', ') || r.reason || '' });
  res.json(r);
});

// TLS 인증서 만료 감시 — 온디맨드 새로고침(12시간 주기 외 즉시 재프로브).
adminRouter.post('/certs/refresh', adminOnly, async (req, res) => {
  const r = await refreshCerts();
  logAudit({ user: req.user?.username || 'unknown', action: '인증서 프로브 새로고침', detail: `${(r.items || []).length}건` });
  res.json({ ok: true, count: (r.items || []).length, at: r.at });
});

// 이상동작 탐지(동시 다운) — vCenter별 임계 설정.
// v2.606 AUTHZ2606-07 · LEFT2606-03: perVcenter 는 vCenter 축이 있으므로 범위 제한 admin 에게는 **범위 안 키만** 보이고,
//   PUT 은 범위 밖 키를 직전 값 그대로 보존한다(mergeScopedMap — v2.605 vmSeries·curUser 와 같은 규약). 예전에는 GET 이
//   전량을 주고 PUT 이 통째로 교체해 다른 법인 임계가 지워졌다. 전역 enabled·threshold(전 법인 공용)는 범위 계정이
//   보내도 **바꾸지 않고** 그 사실을 응답에 밝힌다(ignoredGlobal). 전체 범위 admin 은 예전 그대로.
function scopeAnomaly(st, allowed) {
  if (!allowed) return st;
  return { ...st, perVcenter: filterScopedMap(st.perVcenter || {}, allowed), scoped: true };
}
adminRouter.get('/anomaly', adminOnly, (req, res) => res.json(scopeAnomaly(getAnomalySettings(), scopedVcenterIds(req.user, store.get()))));
adminRouter.put('/anomaly', adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const body = req.body || {};
  if (!allowed) return res.json({ ok: true, settings: saveAnomalySettings(body) });
  const before = getAnomalySettings();
  const m = mergeScopedMap(before.perVcenter, body.perVcenter, allowed);
  const ignoredGlobal = [];
  if (body.enabled !== undefined && (body.enabled !== false) !== before.enabled) ignoredGlobal.push('enabled');
  if (body.threshold !== undefined && body.threshold !== '' && Number(body.threshold) !== before.threshold) ignoredGlobal.push('threshold');
  const settings = saveAnomalySettings({ enabled: before.enabled, threshold: before.threshold, perVcenter: m.merged });
  res.json({
    ok: true, settings: scopeAnomaly(settings, allowed),
    ...(m.ignored.length ? { ignoredOutOfScope: m.ignored.length } : {}),
    ...(ignoredGlobal.length ? { ignoredGlobal, ignoredReason: '전역 임계·사용 여부는 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다 — 적용하지 않았습니다.' } : {}),
  });
});

// 세션 보안(유휴 자동 로그아웃) — 조회는 자유, 변경은 OTP 재인증 + 감사 기록.
// 편집 UI에는 '설정된' 소유 계정만(자동 포함된 중앙 배포 admin은 별도 autoOwners로 읽기전용 안내).
// ── 자격증명 저장 방식(평문/암호화, v2.296) ─────────────────────────────────
// 설정 소유자 전용 + 변경 시 본인 OTP 재인증(세션 보안과 동일 게이트). GET 은 현재 정책과
// 마이그레이션 대상 파일 목록(커버리지 투명성)을 내려준다.
adminRouter.get('/secrets/policy', adminOnly, requireSettingsOwner, (_req, res) => {
  res.json({ ok: true, policy: loadSecretsPolicy(), files: SECRET_FILES, keySource: process.env.SECRETS_KEY ? 'env' : 'file' });
});
adminRouter.put('/secrets/policy', adminOnly, requireSettingsOwner, (req, res) => {
  const username = req.user?.username || 'unknown';
  if (config.auth.enabled) {
    // 재인증 실패는 403(401 이면 프론트 공통 처리가 '세션 만료'로 오인해 강제 로그아웃 — v2.277 컨벤션).
    const v = verifyUserOtp(username, req.body?.otp);
    if (!v.ok) return res.status(403).json({ ok: false, reason: v.reason, needEnroll: !!v.needEnroll });
  }
  const before = loadSecretsPolicy();
  let after;
  try {
    after = saveSecretsPolicy({ mode: req.body?.mode, level: req.body?.level, algorithm: req.body?.algorithm ?? '' });
  } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  // 정책 저장 직후 기존 저장분 일괄 전환(평문→암호화/암호화→평문/레벨·알고리즘 변경 재봉인).
  // 자기서술 암호문이라 부분 실패해도 혼재 상태로 정상 동작 — 실패 파일은 응답으로 보고.
  const mig = migrateSecretFiles(after);
  const lbl = (p) => (p.mode === 'encrypted' ? `암호화(L${p.level}${p.algorithm ? `·${p.algorithm}` : ''})` : '평문');
  logAudit({
    user: username, action: '자격증명 저장 방식 변경', target: 'secrets/policy',
    detail: `${lbl(before)} → ${lbl(after)} · 전환 파일 ${mig.files.filter((f) => f.changed).length}/${mig.files.length}${mig.errors.length ? ` · 실패 ${mig.errors.length}` : ''}`,
    ip: req.ip || '',
  });
  res.json({ ok: true, policy: after, migration: mig });
});

adminRouter.get('/security/session', adminOnly, requireSettingsOwner, (_req, res) => res.json({ ...loadConfiguredSecurity(), autoOwners: managedAdminOwners() }));
adminRouter.put('/security/session', adminOnly, requireSettingsOwner, (req, res) => {
  const username = req.user?.username || 'unknown';
  // 인증이 켜져 있으면 변경 시 본인 OTP 재인증을 강제(누가 바꿨는지 신원 확정 + 무단변경 방지).
  if (config.auth.enabled) {
    const v = verifyUserOtp(username, req.body?.otp);
    // 재인증 실패는 401 이 아니라 403(v2.277 확정 버그 수정) — 세션 토큰은 유효한데 재인증
    // OTP 만 틀린 상태다. 401 로 응답하면 프론트 공통 처리(api.js sendJson)가 '세션 만료'로
    // 판단해 setToken(null)+강제 로그아웃(다른 탭까지 연쇄)하고 실제 사유('OTP 코드가 일치하지
    // 않습니다')도 사라졌다. 로그인에 쓴 코드를 30초 안에 재사용하면 replay 방지로 흔히 발생.
    // 같은 파일의 다른 verifyUserOtp 재인증(중앙 배포 확인)도 403 컨벤션이다.
    if (!v.ok) return res.status(403).json({ ok: false, reason: v.reason, needEnroll: !!v.needEnroll });
  }
  const before = loadConfiguredSecurity();
  let after;
  try {
    after = saveSessionSecurity({ idleLogoutEnabled: req.body?.idleLogoutEnabled, idleLogoutMin: req.body?.idleLogoutMin, settingsOwners: req.body?.settingsOwners, loginPolicy: req.body?.loginPolicy, singleSession: req.body?.singleSession, demoSession: req.body?.demoSession,
      sessionWarnEnabled: req.body?.sessionWarnEnabled, sessionWarnMin: req.body?.sessionWarnMin, sessionExtendMin: req.body?.sessionExtendMin, sessionMaxHours: req.body?.sessionMaxHours });
  } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  const fmt = (s) => (s.idleLogoutEnabled ? `${s.idleLogoutMin}분` : '비활성');
  const polLabel = (p) => ({ otp_only: 'OTP 전용', otp_or_password: 'OTP+비밀번호(혼용)', password_only: '비밀번호 전용' }[p] || '기본(고권한 OTP 전용)');
  // Demo/Guest 중복 접속 모드 라벨(v2.294) — 감사 로그에 사람이 읽는 형태로 남긴다.
  const demoLabel = (m) => ({ allow: '중복 허용', single: '중복 차단(단일 세션)' }[m] || '전역 따름(기본)');
  const parts = [];
  if (fmt(before) !== fmt(after)) parts.push(`유휴 로그아웃 ${fmt(before)} → ${fmt(after)}`);
  if (before.settingsOwners.join(',') !== after.settingsOwners.join(',')) parts.push(`설정 소유 계정 [${before.settingsOwners.join(', ')}] → [${after.settingsOwners.join(', ')}]`);
  if ((before.loginPolicy || '') !== (after.loginPolicy || '')) parts.push(`로그인 방식 ${polLabel(before.loginPolicy)} → ${polLabel(after.loginPolicy)}`);
  if (!!before.singleSession !== !!after.singleSession) parts.push(`단일 세션 강제 ${before.singleSession ? 'ON' : 'OFF'} → ${after.singleSession ? 'ON' : 'OFF'}`);
  if ((before.demoSession || '') !== (after.demoSession || '')) parts.push(`Demo 중복 접속 ${demoLabel(before.demoSession)} → ${demoLabel(after.demoSession)}`);
  // 세션 만료 경고·연장(v2.428) — 무제한(0) 전환은 8시간 정책을 사실상 해제하므로 감사에 또렷이 남긴다.
  const warnLabel = (x) => (x.sessionWarnEnabled ? `${x.sessionWarnMin}분 전 경고 · ${x.sessionExtendMin}분 연장 · 총상한 ${x.sessionMaxHours ? `${x.sessionMaxHours}시간` : '무제한'}` : '비활성');
  if (warnLabel(before) !== warnLabel(after)) parts.push(`세션 만료 경고 ${warnLabel(before)} → ${warnLabel(after)}`);
  logAudit({ user: username, action: '세션 보안/설정 접근 변경', target: 'security/session', detail: parts.join(' · ') || '변경 없음', ip: req.ip || '' });
  res.json({ ok: true, settings: after });
});

// 실제 OS 인벤토리(게스트에서 읽은 실제 설치 OS) — 조회·설정·즉시 실행·결과·CSV.
// v2.599(AUTHZ-2599-05 후속): 범위 제한 admin 에게는 요약을 **그 범위 행으로** 다시 세고, 함대 전체 기준인
//   마지막 실행 결과(탐지 수·오류 문구·인증 정지 목록 — vCenter id 가 들어간다)는 null 로 두고 그 사실을 밝힌다.
// v2.606 AUTHZ2606-06: GET 과 PUT 응답이 **같은 함수**를 쓴다 — 예전 PUT 은 osScanStatus() 전체를 펼쳐 GET 이 가린
//   lastFound·lastErr(범위 밖 vCenter id·IP)·lastAuth·함대 summary 를 그대로 줬다.
function scopedOsScanStatus(req) {
  const st = osScanStatus();
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return st;
  return { ...st, summary: osSummary((r) => allowed.has(String(r.vcenterId))), lastFound: null, lastErr: null, lastAuth: null, scoped: true, fleetRunHidden: true };
}
adminRouter.get('/os-scan', adminOnly, (req, res) => res.json(scopedOsScanStatus(req)));
// v2.606 AUTHZ2606-06: 스캔 설정은 전역이다 — 범위 admin 이 켠 주기 스캔은 전 vCenter 게스트에 로그인한다(v2.599 가 수동
//   실행에서 막은 것을 설정으로 우회). 범위 계정의 변경은 403(Horizon settings PUT v2.605 와 같은 판단).
adminRouter.put('/os-scan/settings', adminOnly, (req, res) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '실제 OS 스캔 설정은 전 법인 공용이고 전 vCenter 게스트에 로그인합니다 — 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.' });
  }
  const status = scopedOsScanStatus(req);   // 예전과 같은 순서(저장 전 상태 + 저장 결과) — 전체 범위 admin 응답은 그대로
  res.json({ ok: true, ...status, settings: saveOsScanSettings(req.body || {}) });
});
// v2.599: 범위 제한 admin 의 즉시 스캔은 **범위 안 vCenter 하나**만 — 범위 밖 지정은 404(존재 은닉), 미지정은 400
//   (미지정이면 전 vCenter 를 돌아 범위 밖 게스트에 로그인한다).
adminRouter.post('/os-scan/run', adminOnly, async (req, res) => {
  const vcId = String(req.body?.vcenterId || '');
  const allowed = scopedVcenterIds(req.user, store.get());
  if (allowed) {
    if (!vcId) return res.status(400).json({ ok: false, reason: '범위가 제한된 계정은 스캔할 vCenter 를 지정해야 합니다.' });
    if (!allowed.has(vcId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  }
  res.json(await runOsScanNow(vcId));
});
// v2.599(AUTHZ-2599-05): 범위 제한 admin 에게 범위 밖 vCenter VM 의 실제 OS(이름·호스트·커널)를 주지 않는다 —
//   요청 필터(?vcenterId)보다 **먼저** 범위 교집합(server/CLAUDE.md 규칙). 뺀 개수는 밝힌다.
function scopedOsRows(req) {
  const rows = getOsResults({ vcenterId: req.query.vcenterId || '', mismatch: req.query.mismatch === '1' });
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return { rows, omitted: 0, scoped: false };
  const kept = rows.filter((r) => allowed.has(String(r.vcenterId)));
  return { rows: kept, omitted: rows.length - kept.length, scoped: true };
}
adminRouter.get('/os-scan/results', adminOnly, (req, res) => {
  const { rows, omitted, scoped } = scopedOsRows(req);
  res.json({ total: rows.length, items: rows.slice(0, 10000), ...(scoped ? { scoped: true, omittedOutOfScope: omitted } : {}) });
});
adminRouter.get('/os-scan/results.csv', adminOnly, (req, res) => {
  const { rows } = scopedOsRows(req);
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;        // 스프레드시트 수식 인젝션 무력화(=,+,-,@ 로 시작)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // 단독 CR도 quoting
  };
  const head = ['vm', 'vcenter', 'cluster', 'host', 'esxi_guest_os', 'real_os', 'real_version', 'family', 'kernel', 'mismatch', 'scanned_at', 'error'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.vmName, r.vcenterId, r.cluster, r.host, r.esxiGuestOS, r.os, r.osVersion, r.family, r.kernel, r.mismatch ? 'Y' : 'N', new Date(r.at).toISOString(), r.error].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="real-os-${todayStamp()}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// --- VM 프로비저닝: 대량 생성 작업 시작 (관리자) ---
adminRouter.post('/provision/jobs', adminOnly, (req, res) => {
  // VM 생성은 vCenter 상태변경 — 쓰기 범위(writeVcenters, v2.369) 강제. 미설정이면 조회 범위와 동일.
  if (!inUserWriteScope(req.user, store.get(), String(req.body?.vcenterId || ''))) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  const result = createProvisionJob(req.body || {}, { user: req.user });
  res.status(result.ok ? 201 : 400).json(result);
});
// 저장된 작업 메모/태그 수정·삭제 (관리자) — 대상 작업이 귀속된 vCenter 의 쓰기 범위 강제.
adminRouter.put('/provision/saved/:id', adminOnly, (req, res) => {
  const item = getSaved(req.params.id);
  if (item && !inUserWriteScope(req.user, store.get(), item.vcenterId || '')) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  const r = updateSaved(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.delete('/provision/saved/:id', adminOnly, (req, res) => {
  const item = getSaved(req.params.id);
  if (item && !inUserWriteScope(req.user, store.get(), item.vcenterId || '')) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  const r = removeSaved(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
});
}
