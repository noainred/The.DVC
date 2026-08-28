// codex 점검·비상정지·로그·상태·포탈DB — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { verifyUserOtp, getUser } from '../../auth/auth.js';
import { getEmergencyStatus, setEmergencyStop } from '../../security/emergencyStop.js';
import { store } from '../../store.js';
import { getLogs } from '../../logbuffer.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { probeRelayPath } from '../../vcenter/relayProbe.js';
import { portalDbReport, enumerateDbFiles } from '../../insights/portalDb.js';
import { inspectMany } from '../../insights/dbHealth.js';
import { dbDir, defaultDbDir, preflight, migrationInventory } from '../../insights/dbLocation.js';
import { writeMigrationScript, listMigrationScripts, migrationsDir } from '../../insights/migrateScript.js';
import { getCodexCheckReport, renderCodexCheckMarkdown, writeCodexCheckReport } from '../../security/codexCheck.js';
import { getMetricsDb } from '../../metrics/db.js';
import { memtrackReport } from '../../system/memtrack.js';
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

// 포탈 DB 인벤토리 — 사용 중 모든 데이터 파일의 경로·파일명·용도·크기·증가 추이·용량 예측.
adminRouter.get('/portal-db', adminOnly, (_req, res) => res.json(portalDbReport()));

/**
 * DB 정합성·일관성 점검(v2.378) — SQLite 파일을 **읽기 전용**으로 진단한다.
 * ?mode=full 이면 integrity_check(전 페이지 스캔 — 큰 DB 는 수 초 이상), 기본은 quick_check.
 * ?file=<파일명> 으로 한 개만 점검할 수 있다(전체 점검이 부담스러운 운영 시간대 대비).
 * 쓰기·VACUUM 을 수행하지 않으므로 서비스 중단 없이 안전하다.
 */
adminRouter.get('/portal-db/health', adminOnly, async (req, res) => {
  try {
    const full = req.query.mode === 'full';
    const only = String(req.query.file || '').trim();
    let targets = enumerateDbFiles().filter((f) => f.type === 'sqlite' && f.exists);
    if (only) targets = targets.filter((f) => f.file === only);
    if (only && !targets.length) return res.status(404).json({ ok: false, reason: `SQLite 파일을 찾지 못했습니다: ${only}` });
    const report = await inspectMany(targets.map((f) => f.path), { full });
    res.json({ ok: true, ...report });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

/**
 * DB 저장 경로 현황(v2.379) — 현재 경로·이전 대상·용량·생성된 마이그레이션 스크립트 목록.
 * 대용량 시계열 DB 를 CONFIG_DIR 밖의 큰 볼륨으로 옮길 때 쓴다.
 */
adminRouter.get('/portal-db/location', adminOnly, (_req, res) => {
  try {
    const cur = dbDir();
    res.json({
      ok: true,
      currentDir: cur || defaultDbDir(),
      isCustom: !!cur,
      defaultDir: defaultDbDir(),
      migrationsDir: migrationsDir(),
      inventory: migrationInventory(),
      scripts: listMigrationScripts(),
    });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

/** 사전 점검 — 실제로 디렉터리를 만들고 쓰기/여유공간을 실측한다(복사는 하지 않음). */
adminRouter.post('/portal-db/location/preflight', adminOnly, (req, res) => {
  try { res.json({ ok: true, ...preflight(String(req.body?.targetDir || '')) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

/**
 * 마이그레이션 **스크립트 생성**(v2.379) — 포탈이 직접 복사하지 않는다.
 * 서비스 정지·복사·검증·경로기록을 담은 bash 스크립트와 설명(README)을 만들고 경로를 알려준다.
 * 실제 실행은 관리자가 root 로 수행한다(서비스 정지·기동은 systemd 관할).
 */
adminRouter.post('/portal-db/location/script', adminOnly, (req, res) => {
  try {
    const targetDir = String(req.body?.targetDir || '').trim();
    const pf = preflight(targetDir);
    if (!pf.ok) return res.status(400).json({ ok: false, reason: pf.reasons.join(' / '), preflight: pf });
    const out = writeMigrationScript({
      targetDir,
      service: String(req.body?.service || 'vmware-portal'),
      user: String(req.body?.user || 'vmware-portal'),
    });
    logAudit({
      user: req.user?.username, action: 'DB 마이그레이션 스크립트 생성',
      target: `${out.sourceDir} → ${targetDir}`,
      detail: `${out.scriptName} (대상 ${(out.inventory.totalBytes / 1048576).toFixed(1)}MB)`, ip: req.ip || '',
    });
    res.json({ ok: true, ...out, preflight: pf });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 포탈 프로세스 메모리 추적(누수 관찰) — metrics DB 의 mem_* 시계열 + 현재값 + 기동 이후
// 추세 판정. ?window=6h|24h|7d|30d. 서버 전역 자기진단 데이터라 vCenter scope 비대상(admin 전용).
adminRouter.get('/memtrack', adminOnly, async (req, res) => {
  try { res.json(memtrackReport(await getMetricsDb(), String(req.query.window || '24h'))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
