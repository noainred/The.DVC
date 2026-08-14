// 감사·알림·일일리포트·인증서·이상탐지·세션보안·OS스캔·프로비저닝 저장 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { verifyUserOtp } from '../../auth/auth.js';
import { saveSessionSecurity, loadConfiguredSecurity, managedAdminOwners } from '../../security/securitySettings.js';
import { saveOsScanSettings, runOsScanNow, osScanStatus } from '../../inventory/osScanner.js';
import { getOsResults } from '../../inventory/osStore.js';
import { listAudit, logAudit } from '../../audit.js';
import { alertStatus, saveAlertConfig, testAlert, getAnomalySettings, saveAnomalySettings } from '../../alerts.js';
import { createJob as createProvisionJob } from '../../provision/jobs.js';
import { updateSaved, removeSaved } from '../../provision/saved.js';
import { ssrfBlockReasonResolved } from '../../collector/registry.js';
import { dailyReportStatus, saveDailyReportSettings, runDailyReportNow } from '../../reports/dailyReport.js';
import { refreshCerts } from '../../security/certMonitor.js';
import { adminOnly, requireSettingsOwner } from './shared.js';

export function registerOpsSettings(adminRouter) {

// Audit log viewer (누가 언제 무엇을 했는지).
adminRouter.get('/audit', adminOnly, (req, res) => {
  res.json(listAudit({ limit: req.query.limit, offset: req.query.offset, user: req.query.user, q: req.query.q }));
});

// Alerting: config + current firing/recent, save config, send a test notification.
adminRouter.get('/alerts', adminOnly, (_req, res) => res.json(alertStatus()));
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
adminRouter.get('/anomaly', adminOnly, (_req, res) => res.json(getAnomalySettings()));
adminRouter.put('/anomaly', adminOnly, (req, res) => res.json({ ok: true, settings: saveAnomalySettings(req.body || {}) }));

// 세션 보안(유휴 자동 로그아웃) — 조회는 자유, 변경은 OTP 재인증 + 감사 기록.
// 편집 UI에는 '설정된' 소유 계정만(자동 포함된 중앙 배포 admin은 별도 autoOwners로 읽기전용 안내).
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
    after = saveSessionSecurity({ idleLogoutEnabled: req.body?.idleLogoutEnabled, idleLogoutMin: req.body?.idleLogoutMin, settingsOwners: req.body?.settingsOwners, loginPolicy: req.body?.loginPolicy, singleSession: req.body?.singleSession, demoSession: req.body?.demoSession });
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
  logAudit({ user: username, action: '세션 보안/설정 접근 변경', target: 'security/session', detail: parts.join(' · ') || '변경 없음', ip: req.ip || '' });
  res.json({ ok: true, settings: after });
});

// 실제 OS 인벤토리(게스트에서 읽은 실제 설치 OS) — 조회·설정·즉시 실행·결과·CSV.
adminRouter.get('/os-scan', adminOnly, (_req, res) => res.json(osScanStatus()));
adminRouter.put('/os-scan/settings', adminOnly, (req, res) => res.json({ ok: true, ...osScanStatus(), settings: saveOsScanSettings(req.body || {}) }));
adminRouter.post('/os-scan/run', adminOnly, async (req, res) => res.json(await runOsScanNow(req.body?.vcenterId || '')));
adminRouter.get('/os-scan/results', adminOnly, (req, res) => {
  const rows = getOsResults({ vcenterId: req.query.vcenterId || '', mismatch: req.query.mismatch === '1' });
  res.json({ total: rows.length, items: rows.slice(0, 10000) });
});
adminRouter.get('/os-scan/results.csv', adminOnly, (req, res) => {
  const rows = getOsResults({ vcenterId: req.query.vcenterId || '', mismatch: req.query.mismatch === '1' });
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;        // 스프레드시트 수식 인젝션 무력화(=,+,-,@ 로 시작)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; // 단독 CR도 quoting
  };
  const head = ['vm', 'vcenter', 'cluster', 'host', 'esxi_guest_os', 'real_os', 'real_version', 'family', 'kernel', 'mismatch', 'scanned_at', 'error'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.vmName, r.vcenterId, r.cluster, r.host, r.esxiGuestOS, r.os, r.osVersion, r.family, r.kernel, r.mismatch ? 'Y' : 'N', new Date(r.at).toISOString(), r.error].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="real-os-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
});

// --- VM 프로비저닝: 대량 생성 작업 시작 (관리자) ---
adminRouter.post('/provision/jobs', adminOnly, (req, res) => {
  const result = createProvisionJob(req.body || {}, { user: req.user });
  res.status(result.ok ? 201 : 400).json(result);
});
// 저장된 작업 메모/태그 수정·삭제 (관리자)
adminRouter.put('/provision/saved/:id', adminOnly, (req, res) => {
  const r = updateSaved(req.params.id, req.body || {});
  res.status(r.ok ? 200 : 404).json(r);
});
adminRouter.delete('/provision/saved/:id', adminOnly, (req, res) => {
  const r = removeSaved(req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
});
}
