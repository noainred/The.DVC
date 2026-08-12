// 백업(소유자 전용)·vc로그·네트워크 캡처/모니터·보안 조회 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import { listInventory } from '../../central/inventory.js';
import { listAgentConfigs } from '../../central/agentConfig.js';
import { createBackup, listBackups, backupPath, deleteBackup, readBackup, restoreCentral } from '../../backup/service.js';
import { loadBackupSettings, saveBackupSettings, backupStatus } from '../../backup/settings.js';
import { saveLogSettings } from '../../logs/settings.js';
import { logStatus, rescheduleLogPoller, pollLogsOnce } from '../../logs/poller.js';
import { resetLogsDb } from '../../logs/db.js';
import { runTrafficCapture, runDualCapture, runPcapCapture } from '../../net/tcpdump.js';
import { analyzeLogsForIssues } from '../../net/logIssues.js';
import { enqueueCapture, getCaptureResult } from '../../central/captureJobs.js';
import { getAllAgentConfigs } from '../../central/agentConfig.js';
import { recordCapture, listCaptures, getCapture, deleteCapture } from '../../net/captureHistory.js';
import { listMonitors, saveMonitor, removeMonitor, runMonitorNow } from '../../net/monitor.js';
import { addUsersToVms } from '../../guest/accountService.js';
import { snapshotFilter, slimVm, guestProbe } from '../../search/deepSearch.js';
import { analyzeLoginFails } from '../../security/loginFails.js';
import { loadLoginMonitor, saveLoginMonitor, loginMonitorStatus, runLoginAnalysisNow } from '../../security/loginMonitor.js';
import { listGuestScans, saveGuestScan, removeGuestScan, runGuestScanNow } from '../../security/guestScanScheduler.js';
import { analyzeNetIssues } from '../../security/netIssueStore.js';
import path from 'node:path';
import { adminOnly, requireSettingsOwner } from './shared.js';

export function registerBackupNetSec(adminRouter) {

// ───────────────────────── 포탈 백업 ─────────────────────────
// 중앙 + 엣지(에이전트 push) 설정 통합 백업. 정기/변경자동/수동 + 다운로드 + 복원.
adminRouter.get('/backup/status', adminOnly, requireSettingsOwner, (_req, res) => {
  res.json({ ...backupStatus(), backups: listBackups(), edges: listAgentConfigs() });
});
adminRouter.put('/backup/settings', adminOnly, requireSettingsOwner, (req, res) => res.json(saveBackupSettings(req.body || {})));
adminRouter.post('/backup/now', adminOnly, requireSettingsOwner, (_req, res) => {
  try { res.json({ ok: true, ...createBackup('manual', { retention: loadBackupSettings().retention }) }); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.get('/backup/download/:name', adminOnly, requireSettingsOwner, (req, res) => {
  const p = backupPath(req.params.name);
  if (!p) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
  // 아카이브에는 portal.env(AUTH_SECRET·CENTRAL_TOKEN)·users.json(TOTP 시크릿)·vCenter 자격증명이
  // 모두 들어 있다 → 인출은 반드시 감사 로그에 남긴다.
  logAudit({ user: req.user?.username, action: '포탈 백업 다운로드(자격증명 포함)', target: req.params.name, ip: req.ip || '' });
  res.download(p, path.basename(p));
});
adminRouter.get('/backup/view/:name', adminOnly, requireSettingsOwner, (req, res) => {
  const a = readBackup(req.params.name);
  if (!a) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
  res.json({ // 자격증명 내용은 빼고 요약만.
    createdAt: a.createdAt, reason: a.reason, centralVersion: a.central?.version,
    centralFiles: Object.keys(a.central?.files || {}),
    edges: Object.entries(a.edges || {}).map(([agent, e]) => ({ agent, at: e.at, files: Object.keys(e.files || {}) })),
  });
});
adminRouter.delete('/backup/:name', adminOnly, requireSettingsOwner, (req, res) => res.json({ ok: deleteBackup(req.params.name) }));
adminRouter.post('/backup/restore/:name', adminOnly, requireSettingsOwner, (req, res) => {
  try {
    const a = readBackup(req.params.name);
    if (!a) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
    const r = restoreCentral(a);
    logAudit({ user: req.user?.username, action: '포탈 설정 복원', target: req.params.name, detail: `${r.restored}개 파일`, ip: req.ip || '' });
    res.json({ ok: true, ...r, note: '중앙 설정 복원 완료 — 적용하려면 포탈 재시작. 복원 전 현재 설정은 자동 백업(pre-restore)됨.' });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── vCenter 로그 보관 ─────────────────────────
adminRouter.get('/vclogs/status', adminOnly, async (_req, res) => {
  try { res.json(await logStatus()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.put('/vclogs/settings', adminOnly, (req, res) => {
  const s = saveLogSettings(req.body || {});
  if (s._pathChanged) resetLogsDb(); // 저장 경로 변경 → 다음 접근 시 새 경로로 재오픈
  rescheduleLogPoller();
  delete s._pathChanged;
  res.json(s);
});
adminRouter.post('/vclogs/collect', adminOnly, async (_req, res) => {
  try { res.json({ ok: true, ...(await pollLogsOnce()) }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 네트워크 트래픽 분석 ─────────────────────────
// 위임 캡처용 에이전트 목록(엣지가 사설망 서버를 대신 캡처).
adminRouter.get('/net/agents', adminOnly, (_req, res) => {
  const agents = new Set([...Object.keys(getAllAgentConfigs() || {}), ...listInventory().map((x) => x.agent).filter(Boolean), ...getAllGpuGuestDiag().map((x) => x.agent).filter(Boolean)]);
  res.json({ agents: [...agents] });
});

// 두 서버 간 tcpdump 캡처/분석(관리자 전용, SSH+root). 단일/동시(dual) + 중앙직접/에이전트위임.
// Body: { via:'central'|'agent', agent?, dual?, hostA:{...}, hostB?:{...}, peer?, iface, seconds, maxPackets, useSudo }
adminRouter.post('/net/capture', adminOnly, async (req, res) => {
  const b = req.body || {};
  const dual = !!b.dual;
  if (!b.hostA?.host || !b.hostA?.username) return res.status(400).json({ ok: false, reason: 'A 서버 SSH 접속정보(host/username)가 필요합니다.' });
  if (dual ? (!b.hostB?.host || !b.hostB?.username) : !b.peer) return res.status(400).json({ ok: false, reason: dual ? 'B 서버 SSH 접속정보가 필요합니다.' : '대상 서버(B) IP가 필요합니다.' });
  const opts = { iface: b.iface || 'any', seconds: b.seconds, maxPackets: b.maxPackets, useSudo: b.useSudo !== false };

  // 에이전트 위임: 큐잉만 하고 reqId 반환(클라이언트가 폴링).
  if (b.via === 'agent') {
    if (!b.agent) return res.status(400).json({ ok: false, reason: '위임할 엣지 에이전트를 선택하세요.' });
    const spec = dual ? { dual: true, hostA: b.hostA, hostB: b.hostB, ...opts } : { host: b.hostA.host, port: b.hostA.port, username: b.hostA.username, password: b.hostA.password, privateKey: b.hostA.privateKey, peer: String(b.peer).trim(), ...opts };
    return res.json({ ok: true, delegated: true, reqId: enqueueCapture(String(b.agent), spec) });
  }

  // 중앙 직접 실행.
  try {
    const r = dual
      ? await runDualCapture({ hostA: b.hostA, hostB: b.hostB, ...opts })
      : await runTrafficCapture({ hostA: b.hostA, peer: String(b.peer).trim(), ...opts });
    try { recordCapture(r, { source: 'manual', via: 'central', hostA: b.hostA.host, peer: b.peer }); } catch { /* 이력 실패 무시 */ }
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 위임 캡처 결과 폴링.
adminRouter.get('/net/capture', adminOnly, (req, res) => {
  if (!req.query.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  res.json(getCaptureResult(String(req.query.reqId)));
});

// pcap 파일 캡처 + 다운로드(중앙 직접). tshark 심층 분석용.
adminRouter.post('/net/pcap', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.hostA?.host || !b.hostA?.username || !b.peer) return res.status(400).json({ ok: false, reason: 'A 접속정보·대상 B IP가 필요합니다.' });
  try {
    const r = await runPcapCapture({ hostA: b.hostA, peer: String(b.peer).trim(), iface: b.iface || 'any', seconds: b.seconds, maxPackets: b.maxPackets, useSudo: b.useSudo !== false });
    if (!r.pcapBase64) return res.json({ ok: false, reason: r.warn || 'pcap을 회수하지 못했습니다(권한/tcpdump 확인).' });
    res.json({ ok: true, fileName: r.fileName, captured: r.captured, size: r.size, summary: r.summary, pcapBase64: r.pcapBase64 });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 캡처 이력
adminRouter.get('/net/history', adminOnly, (req, res) => res.json({ captures: listCaptures({ limit: Number(req.query.limit) || 100 }) }));
adminRouter.get('/net/history/:id', adminOnly, (req, res) => { const c = getCapture(req.params.id); return c ? res.json(c) : res.status(404).json({ ok: false }); });
adminRouter.delete('/net/history/:id', adminOnly, (req, res) => res.json({ ok: deleteCapture(req.params.id) }));

// 연속 모니터링
adminRouter.get('/net/monitors', adminOnly, (_req, res) => res.json({ monitors: listMonitors() }));
adminRouter.put('/net/monitors', adminOnly, (req, res) => res.json(saveMonitor(req.body || {})));
adminRouter.delete('/net/monitors/:id', adminOnly, (req, res) => res.json({ ok: removeMonitor(req.params.id) }));
adminRouter.post('/net/monitors/:id/run', adminOnly, async (req, res) => { try { res.json(await runMonitorNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });
// 로그 자체 분석(장애/이슈 탐지).
adminRouter.get('/net/log-issues', adminOnly, async (req, res) => {
  try { res.json(await analyzeLogsForIssues({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || 7 })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 게스트 계정 추가 ─────────────────────────
// VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 추가. 관리자 전용 + 감사 로그.
// Body: { vcenterId, vmIds[], username, password, sudo, nopasswd, guestUser, guestPass }
adminRouter.post('/guest/add-user', adminOnly, async (req, res) => {
  const b = req.body || {};
  try { res.json(await addUsersToVms(b)); }
  catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// 심층 검색(게스트 탐침) — GPU 드라이버/프로세스 등 게스트 OS 조건. 관리자 전용(게스트 명령 실행).
// Body: { vcenterIds[], filters{}, probe:{type,pattern}, guestUser, guestPass, maxVms }
adminRouter.post('/deep-search/probe', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.probe?.type) return res.status(400).json({ ok: false, reason: 'probe.type이 필요합니다.' });
  try {
    const candidates = snapshotFilter(store.get(), { vcenterIds: b.vcenterIds || [], f: b.filters || {} }).map(slimVm);
    const r = await guestProbe(candidates, b.probe, { guestUser: b.guestUser || '', guestPass: b.guestPass || '', maxVms: Math.min(500, Number(b.maxVms) || 100) });
    res.json({ candidates: candidates.length, ...r });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 로그인 실패 분석 ─────────────────────────
adminRouter.get('/security/login-fails', adminOnly, async (req, res) => {
  try { res.json(await analyzeLoginFails({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || loadLoginMonitor().days, threshold: Number(req.query.threshold) || loadLoginMonitor().threshold, windowMin: Number(req.query.windowMin) || loadLoginMonitor().windowMin })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.get('/security/login-fails/status', adminOnly, (_req, res) => res.json(loginMonitorStatus()));
adminRouter.put('/security/login-fails/settings', adminOnly, (req, res) => res.json(saveLoginMonitor(req.body || {})));
adminRouter.post('/security/login-fails/run', adminOnly, async (_req, res) => { try { await runLoginAnalysisNow(); res.json({ ok: true, ...loginMonitorStatus() }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 네트워크 이슈(패킷드랍/에러) 분석.
adminRouter.get('/security/net-issues', adminOnly, (req, res) => { try { res.json(analyzeNetIssues({ vcenterId: req.query.vcenterId || '', days: Number(req.query.days) || 7 })); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 조사 스케줄(로그인 실패 / 네트워크 이슈) — vCenter별·OS별·주기.
adminRouter.get('/security/guest-scans', adminOnly, (_req, res) => res.json({ jobs: listGuestScans() }));
adminRouter.put('/security/guest-scans', adminOnly, (req, res) => res.json(saveGuestScan(req.body || {})));
adminRouter.delete('/security/guest-scans/:id', adminOnly, (req, res) => res.json({ ok: removeGuestScan(req.params.id) }));
adminRouter.post('/security/guest-scans/:id/run', adminOnly, async (req, res) => { try { res.json(await runGuestScanNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });
}
