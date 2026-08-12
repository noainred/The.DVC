// codex 점검·비상정지·로그·상태·포탈DB — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { verifyUserOtp, getUser } from '../../auth/auth.js';
import { getEmergencyStatus, setEmergencyStop } from '../../security/emergencyStop.js';
import { store } from '../../store.js';
import { getLogs } from '../../logbuffer.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { probeRelayPath } from '../../vcenter/relayProbe.js';
import { portalDbReport } from '../../insights/portalDb.js';
import { getCodexCheckReport, renderCodexCheckMarkdown, writeCodexCheckReport } from '../../security/codexCheck.js';
import { adminOnly } from './shared.js';

export function registerStatusTools(adminRouter) {

// Codex 정적 보안·완성도 점검 보고서 — 관리자 화면과 날짜별 Markdown 기록을 동일한
// 서버 모듈에서 생성해 화면과 파일 내용이 어긋나지 않게 한다.
adminRouter.get('/codex-check', adminOnly, (_req, res) => {
  res.json(getCodexCheckReport());
});
adminRouter.get('/codex-check/file', adminOnly, (_req, res) => {
  res.type('text/markdown; charset=utf-8').send(renderCodexCheckMarkdown());
});
adminRouter.post('/codex-check/write', adminOnly, (req, res) => {
  try {
    const result = writeCodexCheckReport();
    logAudit({ user: req.user?.username, action: 'codex.check.write', target: result.fileName, detail: `${result.bytes} bytes` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: `점검 파일 기록 실패: ${err.message}` });
  }
});

// ── 긴급중단(Emergency Stop) — 관리자 2명 OTP(2인 승인)로만 켜고/끈다 ──────────
adminRouter.get('/emergency-stop', adminOnly, (_req, res) => res.json(getEmergencyStatus()));

// Body: { action:'stop'|'resume', approvals:[{username,code},{username,code}] }
// 검증: 정확히 2명 · 서로 다른 계정 · 둘 다 admin · 둘 다 현재 OTP 일치.
adminRouter.post('/emergency-stop', adminOnly, (req, res) => {
  const b = req.body || {};
  const action = b.action === 'resume' ? 'resume' : 'stop';
  const approvals = Array.isArray(b.approvals) ? b.approvals : [];
  if (!config.auth.enabled) return res.status(400).json({ ok: false, reason: '인증이 비활성화되어 2인 OTP 승인을 사용할 수 없습니다(AUTH_ENABLED).' });
  if (approvals.length !== 2) return res.status(400).json({ ok: false, reason: '관리자 2명의 OTP 인증이 필요합니다.' });
  const names = approvals.map((a) => String(a?.username || '').trim());
  if (!names[0] || !names[1]) return res.status(400).json({ ok: false, reason: '두 계정의 ID를 모두 입력하세요.' });
  if (names[0].toLowerCase() === names[1].toLowerCase()) return res.status(400).json({ ok: false, reason: '서로 다른 관리자 2명이어야 합니다.' });
  for (const a of approvals) {
    const name = String(a?.username || '').trim();
    const u = getUser(name);
    if (!u) return res.status(400).json({ ok: false, reason: `사용자 '${name}'를 찾을 수 없습니다.` });
    if ((u.role || '') !== 'admin') return res.status(403).json({ ok: false, reason: `'${name}'는 관리자(admin)가 아닙니다.` });
    const v = verifyUserOtp(name, a?.code);
    if (!v.ok) return res.status(403).json({ ok: false, reason: `'${name}' OTP 인증 실패 — ${v.reason}`, needEnroll: v.needEnroll });
  }
  const status = setEmergencyStop(action === 'stop', names);
  logAudit({ user: `${names[0]} + ${names[1]}`, action: action === 'stop' ? '긴급중단 실행(2인 승인)' : '긴급중단 해제(2인 승인)', target: 'emergency-stop', detail: `승인자 ${names.join(', ')}`, ip: req.ip || '' });
  res.json({ ok: true, ...status });
});

// Server operational logs (ring buffer). ?since=<id>&level=info|warn|error
adminRouter.get('/logs', adminOnly, (req, res) => {
  res.json(getLogs({ since: req.query.since, level: req.query.level }));
});

// Data-source + per-vCenter collection errors (why a vCenter won't connect).
// vCenter 중계 경로 단계별 진단 — TCP→TLS→HTTP 어디서 막혔는지. ?vcenterId= 또는 ?host=
adminRouter.get('/vcenter/relay-test', adminOnly, async (req, res) => {
  let host = String(req.query.host || '').trim();
  if (!host && req.query.vcenterId) {
    const vc = (loadVcenterConfig().vcenters || []).find((x) => x.id === req.query.vcenterId);
    if (!vc) return res.status(404).json({ ok: false, reason: '등록된 vCenter가 아닙니다.' });
    host = vc.host;
  }
  if (!host) return res.status(400).json({ ok: false, reason: 'vcenterId 또는 host가 필요합니다.' });
  try { res.json({ ok: true, ...(await probeRelayPath(host, { timeoutMs: 6000 })) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 포탈 DB 인벤토리 — 사용 중 모든 데이터 파일의 경로·파일명·용도·크기·증가 추이.
adminRouter.get('/portal-db', adminOnly, (_req, res) => res.json(portalDbReport()));

adminRouter.get('/status', adminOnly, (_req, res) => {
  const snap = store.get();
  res.json({
    dataSource: snap.source,
    generatedAt: snap.generatedAt,
    vcenters: snap.vcenters.length,
    collectionErrors: snap.collectionErrors || [],
  });
});
}
