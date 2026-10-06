// 백업(소유자 전용)·vc로그·네트워크 캡처/모니터·보안 조회 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { demoAgentNames } from '../../mock/demo/edge.js'; // v2.708 데모(mock)
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
import { inUserWriteScope, scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { denyScopedRun } from '../../auth/scopeMerge.js';   // v2.607 AUTHZ2607-06
import { snapshotFilter, slimVm, guestProbe } from '../../search/deepSearch.js';
import { analyzeLoginFails, clampLoginFailParams } from '../../security/loginFails.js';
import { snapMemo, snapCacheClear } from '../../util/snapCache.js';
import { loadLoginMonitor, saveLoginMonitor, loginMonitorStatus, runLoginAnalysisNow } from '../../security/loginMonitor.js';
import { listGuestScans, saveGuestScan, removeGuestScan, runGuestScanNow } from '../../security/guestScanScheduler.js';
import { analyzeNetIssues } from '../../security/netIssueStore.js';
import path from 'node:path';
import { dirPathIssue } from '../../util/dirPathGuard.js';
import { adminOnly, requireSettingsOwner, fullScopeOnlyWith } from './shared.js';

// v2.675: 로그인 실패 분석 화면 조회 기억 시간(같은 조건 · 동시 요청 합류). '지금 분석' 이 비운다.
export const LOGIN_FAILS_MEMO_MS = 60_000;

// v2.612 AUTHZ2612-07: 엣지 목록·네트워크 모니터·캡처·로그인 실패 상태는 전 법인 공용 — 범위 제한 admin 은 403.
const fleetOnly = fullScopeOnlyWith('엣지 네트워크 진단·로그인 실패 상태는 전 법인에 걸친 데이터라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');

/*
 * v2.607 AUTHZ2607-02·06 — 게스트 명령·게스트 조사·로그 분석은 vCenter 축이 있다. 예전에는 adminOnly 뿐이라 범위 제한
 * admin 이 범위 밖 vCenter 의 VM 에 게스트 명령을 돌리고(deep-search/probe — 형제 /tools/deep-search 는 범위 교집합),
 * 범위 밖 vCenter 에 게스트 조사 잡을 만들어 결과를 읽었다(같은 파일 /guest/add-user 는 쓰기 범위를 강제한다).
 */
/** 분석 GET 의 vcenterId 를 범위로 강제한다. 범위 밖이면 404, 미지정이면 범위가 하나일 때만 그것으로. 응답했으면 undefined. */
function scopedVcQuery(req, res) {
  const q = String(req.query.vcenterId || '');
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return q;
  if (q) {
    if (!allowed.has(q)) { res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); return undefined; }
    return q;
  }
  if (allowed.size === 1) return [...allowed][0];
  res.status(400).json({ ok: false, reason: '범위 제한 계정은 vCenter 를 하나 지정해야 합니다 — 전체 합계에는 범위 밖 법인이 섞입니다.', scoped: true });
  return undefined;
}
/** 게스트 조사 잡이 요청자의 쓰기 범위 안인가(vcenterId 비어 있는 잡은 범위 밖으로 본다). */
function guestScanInScope(user, vcenterId) {
  const w = writeScopedVcenterIds(user, store.get());
  return !w || (!!vcenterId && w.has(String(vcenterId)));
}

/**
 * v2.629 AUTHZ2629-05: vCenter 로그 보관 상태를 범위 계정에 맞게 좁힌다(형제 /admin/status 는 v2.611 에 범위 필터).
 * 예전에는 logStatus() 를 그대로 내보내 범위 관리자가 전 vCenter 별 로그 건수·인증 정지 vCenter id·DB 절대 경로를 봤다.
 * 화면(설정 › vCenter 로그 보관)을 범위 계정도 열므로 403 이 아니라 **거르고 밝힌다**(omittedOutOfScope·pathHidden).
 * 전 법인 합계(count·firstTs·collected)는 범위 안에서 다시 세거나(가능하면) null 로 둔다 — 전 함대 값을 싣지 않는다.
 * allowed === null(전체 범위)이면 원본 그대로.
 */
export function scopeVcLogStatus(st, allowed) {
  if (!allowed || !st || typeof st !== 'object') return st;
  const out = { ...st, scoped: true };
  const vcs = Array.isArray(st.store?.vcenters) ? st.store.vcenters : [];
  const kept = vcs.filter((v) => v && allowed.has(v.vcenterId));
  if (st.store && typeof st.store === 'object') {
    let lastTs = null;
    for (const v of kept) if (Number.isFinite(v.lastTs) && (lastTs == null || v.lastTs > lastTs)) lastTs = v.lastTs;
    out.store = {
      ...st.store,
      vcenters: kept,
      count: kept.reduce((a, v) => a + (Number.isFinite(v.count) ? v.count : 0), 0),
      firstTs: null,            // vCenter 별 첫 시각은 없다 — 전 함대 값을 싣지 않는다
      lastTs,
      omittedOutOfScope: vcs.length - kept.length,
    };
  }
  if (st.lastRun && typeof st.lastRun === 'object') {
    const lr = { ...st.lastRun, collected: null };   // 수집 건수는 전 vCenter 합계다
    if (Array.isArray(st.lastRun.authStopped)) {
      lr.authStopped = st.lastRun.authStopped.filter((id) => allowed.has(id));
      lr.authStoppedOmitted = st.lastRun.authStopped.length - lr.authStopped.length;
    }
    out.lastRun = lr;
  }
  if ('dbPath' in out) out.dbPath = null;
  if (out.settings && typeof out.settings === 'object' && out.settings.storagePath) out.settings = { ...out.settings, storagePath: '' };
  out.pathHidden = true;
  return out;
}

export function registerBackupNetSec(adminRouter) {

// ───────────────────────── 포탈 백업 ─────────────────────────
// 중앙 + 엣지(에이전트 push) 설정 통합 백업. 정기/변경자동/수동 + 다운로드 + 복원.
adminRouter.get('/backup/status', adminOnly, requireSettingsOwner, (_req, res) => {
  res.json({ ...backupStatus(), backups: listBackups(), edges: listAgentConfigs() });
});
adminRouter.put('/backup/settings', adminOnly, requireSettingsOwner, (req, res) => res.json(saveBackupSettings(req.body || {})));
adminRouter.post('/backup/now', adminOnly, requireSettingsOwner, async (_req, res) => {
  // v2.620(PERF2620-01): createBackup 은 비동기다(gzip 을 메인 루프 밖에서) — await 해야 실패가 catch 로 온다.
  try { res.json({ ok: true, ...(await createBackup('manual', { retention: loadBackupSettings().retention })) }); }
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
adminRouter.post('/backup/restore/:name', adminOnly, requireSettingsOwner, async (req, res) => {
  try {
    const a = readBackup(req.params.name);
    if (!a) return res.status(404).json({ ok: false, reason: '백업을 찾을 수 없습니다.' });
    const r = await restoreCentral(a, { retention: loadBackupSettings().retention });
    // v2.689(G2 B6): 파일별 복원 실패(`failed[]`)를 감사·응답 문구에 밝힌다 — 예전에는 성공 개수만 적어 일부 설정이 복원되지
    //   않았는데 '복원 완료' 로 보였다.
    const nFail = Array.isArray(r.failed) ? r.failed.length : 0;
    logAudit({ user: req.user?.username, action: '포탈 설정 복원', target: req.params.name, detail: `${r.restored}개 파일${nFail ? ` · 실패 ${nFail}개(${r.failed.map((f) => f.file).join(', ')})` : ''}`, ip: req.ip || '' });
    const note = nFail
      ? `중앙 설정 복원 — ${r.restored}개 성공 · ${nFail}개 실패(${r.failed.map((f) => `${f.file}: ${f.reason}`).join(' · ')}). 실패한 파일은 복원되지 않았습니다. 적용하려면 포탈 재시작. 복원 전 현재 설정은 자동 백업(pre-restore)됨.`
      : '중앙 설정 복원 완료 — 적용하려면 포탈 재시작. 복원 전 현재 설정은 자동 백업(pre-restore)됨.';
    res.json({ ok: true, ...r, note });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── vCenter 로그 보관 ─────────────────────────
adminRouter.get('/vclogs/status', adminOnly, async (req, res) => {
  try { res.json(scopeVcLogStatus(await logStatus(), scopedVcenterIds(req.user, store.get()))); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.put('/vclogs/settings', adminOnly, (req, res) => {
  if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: 'vCenter 로그 보관 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.' }); // v2.607
  // v2.480(3차 감사 S4): storagePath 무검증 → 임의 절대경로에 SQLite(+wal/shm) 생성. 절대경로·상위경로·제어문자·시스템 디렉터리 거부.
  const sp = typeof req.body?.storagePath === 'string' ? req.body.storagePath.trim() : '';
  if (sp) {
    const bad = dirPathIssue(sp);   // v2.629: 검사 본체는 util/dirPathGuard.js 하나(svcmon 로그 경로와 공유)
    if (bad) return res.status(400).json({ ok: false, reason: `로그 저장 경로: ${bad}` });
  }
  const s = saveLogSettings(req.body || {});
  if (s._pathChanged) resetLogsDb(); // 저장 경로 변경 → 다음 접근 시 새 경로로 재오픈
  rescheduleLogPoller();
  delete s._pathChanged;
  res.json(s);
});
adminRouter.post('/vclogs/collect', adminOnly, async (req, res) => {
  if (denyScopedRun(req, res, 'vCenter 로그 수동 수집')) return;   // v2.607 AUTHZ2607-06
  try { res.json({ ok: true, ...(await pollLogsOnce({ manual: true })) }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 네트워크 트래픽 분석 ─────────────────────────
// 위임 캡처용 에이전트 목록(엣지가 사설망 서버를 대신 캡처).
adminRouter.get('/net/agents', adminOnly, fleetOnly, (_req, res) => {
  const agents = new Set([...Object.keys(getAllAgentConfigs() || {}), ...listInventory().map((x) => x.agent).filter(Boolean), ...getAllGpuGuestDiag().map((x) => x.agent).filter(Boolean), ...demoAgentNames()]); // v2.708: mock 이면 데모 엣지(위임 캡처는 합성 결과)
  res.json({ agents: [...agents] });
});

// 두 서버 간 tcpdump 캡처/분석(관리자 전용, SSH+root). 단일/동시(dual) + 중앙직접/에이전트위임.
// Body: { via:'central'|'agent', agent?, dual?, hostA:{...}, hostB?:{...}, peer?, iface, seconds, maxPackets, useSudo }
adminRouter.post('/net/capture', adminOnly, fleetOnly, async (req, res) => {
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
adminRouter.get('/net/capture', adminOnly, fleetOnly, (req, res) => {
  if (!req.query.reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  res.json(getCaptureResult(String(req.query.reqId)));
});

// pcap 파일 캡처 + 다운로드(중앙 직접). tshark 심층 분석용.
adminRouter.post('/net/pcap', adminOnly, fleetOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.hostA?.host || !b.hostA?.username || !b.peer) return res.status(400).json({ ok: false, reason: 'A 접속정보·대상 B IP가 필요합니다.' });
  try {
    const r = await runPcapCapture({ hostA: b.hostA, peer: String(b.peer).trim(), iface: b.iface || 'any', seconds: b.seconds, maxPackets: b.maxPackets, useSudo: b.useSudo !== false });
    if (!r.pcapBase64) return res.json({ ok: false, reason: r.warn || 'pcap을 회수하지 못했습니다(권한/tcpdump 확인).' });
    res.json({ ok: true, fileName: r.fileName, captured: r.captured, size: r.size, summary: r.summary, pcapBase64: r.pcapBase64 });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 캡처 이력
adminRouter.get('/net/history', adminOnly, fleetOnly, (req, res) => res.json({ captures: listCaptures({ limit: Math.max(1, Math.min(1000, Number(req.query.limit) || 100)) }) })); // v2.480: limit 상한
adminRouter.get('/net/history/:id', adminOnly, fleetOnly, (req, res) => { const c = getCapture(req.params.id); return c ? res.json(c) : res.status(404).json({ ok: false }); });
adminRouter.delete('/net/history/:id', adminOnly, fleetOnly, (req, res) => res.json({ ok: deleteCapture(req.params.id) }));

// 연속 모니터링
adminRouter.get('/net/monitors', adminOnly, fleetOnly, (_req, res) => res.json({ monitors: listMonitors() }));
adminRouter.put('/net/monitors', adminOnly, fleetOnly, (req, res) => res.json(saveMonitor(req.body || {})));
adminRouter.delete('/net/monitors/:id', adminOnly, fleetOnly, (req, res) => res.json({ ok: removeMonitor(req.params.id) }));
adminRouter.post('/net/monitors/:id/run', adminOnly, fleetOnly, async (req, res) => { try { res.json(await runMonitorNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });
// 로그 자체 분석(장애/이슈 탐지).
adminRouter.get('/net/log-issues', adminOnly, async (req, res) => {
  const vcenterId = scopedVcQuery(req, res); if (vcenterId === undefined) return;   // v2.607 AUTHZ2607-06
  try { res.json(await analyzeLogsForIssues({ vcenterId, days: Number(req.query.days) || 7 })); }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 게스트 계정 추가 ─────────────────────────
// VMware Tools(게스트 작업)로 게스트 OS에 sudo 계정 추가. 관리자 전용 + 감사 로그.
// Body: { vcenterId, vmIds[], username, password, sudo, nopasswd, guestUser, guestPass }
adminRouter.post('/guest/add-user', adminOnly, async (req, res) => {
  const b = req.body || {};
  // 게스트 OS 계정 추가는 VM 상태변경 — 쓰기 범위(writeVcenters, v2.369) 강제. 미설정=조회 범위.
  if (!inUserWriteScope(req.user, store.get(), String(b.vcenterId || ''))) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  // v2.689(B7): 누가·어느 vCenter 의 몇 대에·어떤 계정을(sudo 여부) 만들었는지 남긴다 — 일반 미들웨어 한 줄
  //   ('POST /admin/guest/add-user')만으로는 사고 분석이 안 된다. 비밀번호·게스트 인증 계정 비밀번호는 싣지 않는다.
  const nVm = Array.isArray(b.vmIds) ? b.vmIds.length : 0;
  const acct = String(typeof b.username === 'string' ? b.username : '').slice(0, 64);
  const what = `VM ${nVm}대 · 계정 ${acct || '(없음)'} · sudo=${b.sudo === undefined ? true : !!b.sudo}${b.nopasswd ? ' · NOPASSWD' : ''}`;
  try {
    const r = await addUsersToVms(b);
    logAudit({ user: req.user?.username, action: '게스트 계정 추가', target: String(b.vcenterId || ''), detail: `${what} · 성공 ${r.ok} · 실패 ${r.fail}` });
    res.json(r);
  } catch (e) {
    logAudit({ user: req.user?.username, action: '게스트 계정 추가 실패', target: String(b.vcenterId || ''), detail: `${what} · ${String(e?.message || e).slice(0, 200)}` });
    res.status(400).json({ ok: false, reason: e.message });
  }
});

// 심층 검색(게스트 탐침) — GPU 드라이버/프로세스 등 게스트 OS 조건. 관리자 전용(게스트 명령 실행).
// Body: { vcenterIds[], filters{}, probe:{type,pattern}, guestUser, guestPass, maxVms }
adminRouter.post('/deep-search/probe', adminOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.probe?.type) return res.status(400).json({ ok: false, reason: 'probe.type이 필요합니다.' });
  // v2.607 AUTHZ2607-02: 범위 계정은 쓰기 범위와 교집합(게스트 명령 실행 = 상태 변경 등급). 빈 요청 = 범위 전체,
  //   범위 밖 지정은 거부(존재 은닉 404). 형제 /tools/deep-search 와 같은 판단.
  const wAllowed = writeScopedVcenterIds(req.user, store.get());
  let vcenterIds = Array.isArray(b.vcenterIds) ? b.vcenterIds.map(String) : [];
  if (wAllowed) {
    if (vcenterIds.some((id) => !wAllowed.has(id))) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    if (!vcenterIds.length) vcenterIds = [...wAllowed];
    if (!vcenterIds.length) return res.json({ candidates: 0, matched: [], checked: 0, errors: [], scoped: true });
  }
  try {
    const candidates = snapshotFilter(store.get(), { vcenterIds, f: b.filters || {} }).map(slimVm);
    const maxVms = Math.min(500, Number(b.maxVms) || 100);
    // v2.689(B7): 게스트 OS 에 명령을 실행하는 경로다 — 유형·대상 수를 남긴다(패턴·게스트 비밀번호는 싣지 않는다).
    logAudit({ user: req.user?.username, action: '심층 검색 게스트 탐침', target: vcenterIds.length ? vcenterIds.slice(0, 20).join(',') : '(전체)', detail: `유형 ${String(b.probe.type).slice(0, 40)} · 후보 ${candidates.length}대 · 상한 ${maxVms}대` });
    const r = await guestProbe(candidates, b.probe, { guestUser: b.guestUser || '', guestPass: b.guestPass || '', maxVms });
    res.json({ candidates: candidates.length, ...r });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ───────────────────────── 로그인 실패 분석 ─────────────────────────
adminRouter.get('/security/login-fails', adminOnly, async (req, res) => {
  // v2.607 AUTHZ2607-06: 이 분석에는 **포탈 로그인 실패**(전 사용자 계정명·출발 IP)가 vCenter 지정과 무관하게 섞인다 —
  //   법인 축으로 나눌 수 없으므로 범위 계정 403(v2.525 규약).
  if (scopedVcenterIds(req.user, store.get())) return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '로그인 실패 분석에는 포탈 전체 로그인 실패가 섞여 있어 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.' });
  try {
    const mon = loadLoginMonitor();
    // v2.680 C-01: 쿼리값을 설정과 같은 범위로 자른다(?days=Infinity 가 끝나지 않는 조각 루프였다 — 키도 잘린 값이라 합류된다).
    const p = { vcenterId: String(req.query.vcenterId || ''), ...clampLoginFailParams(req.query, mon) };
    // v2.675: 화면이 이 경로를 주기적으로 부른다 — 요청마다 7일치 전 범위 분석(v2.673 이후 조각으로 나눠 멈춤은 없지만 매번 같은
    //   일 — 이벤트 100만 행에 약 1.5초 CPU)을 하지 않게 같은 조건은 60초 기억하고 동시 요청은 한 계산에 합류시킨다.
    //   '지금 분석' 은 이 기억을 비운다(아래 /run). 응답의 generatedAt 이 분석 시각이다(화면이 밝힌다).
    const key = `loginfails|${p.vcenterId}|${p.days}|${p.threshold}|${p.windowMin}`;
    res.json(await snapMemo('loginFails', key, LOGIN_FAILS_MEMO_MS, () => analyzeLoginFails(p)));
  }
  catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
adminRouter.get('/security/login-fails/status', adminOnly, fleetOnly, (_req, res) => res.json(loginMonitorStatus()));
adminRouter.put('/security/login-fails/settings', adminOnly, (req, res) => (scopedVcenterIds(req.user, store.get()) ? res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true, reason: '로그인 실패 감시 설정은 전 법인 공용이라 전체 범위 계정만 바꿀 수 있습니다.' }) : res.json(saveLoginMonitor(req.body || {}))));
adminRouter.post('/security/login-fails/run', adminOnly, async (req, res) => { if (denyScopedRun(req, res, '로그인 실패 수동 분석')) return; try { await runLoginAnalysisNow(); snapCacheClear('loginFails'); res.json({ ok: true, ...loginMonitorStatus() }); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 네트워크 이슈(패킷드랍/에러) 분석.
adminRouter.get('/security/net-issues', adminOnly, (req, res) => { const vcenterId = scopedVcQuery(req, res); if (vcenterId === undefined) return; try { res.json(analyzeNetIssues({ vcenterId, days: Number(req.query.days) || 7 })); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });

// 게스트 조사 스케줄(로그인 실패 / 네트워크 이슈) — vCenter별·OS별·주기.
// v2.607 AUTHZ2607-06: 범위 계정은 자기 쓰기 범위 vCenter 의 잡만 보고·만들고·지우고·실행한다(그 밖은 404 — 존재 은닉).
adminRouter.get('/security/guest-scans', adminOnly, (req, res) => {
  const all = listGuestScans();
  if (!scopedVcenterIds(req.user, store.get())) return res.json({ jobs: all });
  const jobs = all.filter((j) => guestScanInScope(req.user, j.vcenterId));
  res.json({ jobs, scoped: true, omittedOutOfScope: all.length - jobs.length });
});
adminRouter.put('/security/guest-scans', adminOnly, (req, res) => {
  const b = req.body || {};
  if (scopedVcenterIds(req.user, store.get())) {
    const prev = b.id ? listGuestScans().find((j) => j.id === String(b.id)) : null;
    if (prev && !guestScanInScope(req.user, prev.vcenterId)) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
    if (!guestScanInScope(req.user, b.vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다(범위 제한 계정은 자기 범위 vCenter 를 지정해야 합니다).' });
  }
  res.json(saveGuestScan(b));
});
function denyGuestScanOutOfScope(req, res) {
  if (!scopedVcenterIds(req.user, store.get())) return false;
  const j = listGuestScans().find((x) => x.id === String(req.params.id));
  if (j && guestScanInScope(req.user, j.vcenterId)) return false;
  res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  return true;
}
adminRouter.delete('/security/guest-scans/:id', adminOnly, (req, res) => { if (denyGuestScanOutOfScope(req, res)) return; res.json({ ok: removeGuestScan(req.params.id) }); });
adminRouter.post('/security/guest-scans/:id/run', adminOnly, async (req, res) => { if (denyGuestScanOutOfScope(req, res)) return; try { res.json(await runGuestScanNow(req.params.id)); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); } });
}
