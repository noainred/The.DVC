// 메트릭 설정·GPU 게스트/물리·엣지 사용자 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { store } from '../../store.js';
import { loadMetricsSettings, saveMetricsSettings, METRICS_LIMITS } from '../../metrics/settings.js';
import { forceGpuUtilCollect, clearGpuUtilForce } from '../../vcenter/soapClient.js';
import { metricsSamplerStatus, rescheduleMetricsSampler } from '../../metrics/sampler.js';
import { loadGpuGuestSettings, saveGpuGuestSettings, redactGpuGuestSettings, resolveVmCreds, resolveCollectMethod } from '../../gpu/settings.js';
import { gpuGuestStatus, rescheduleGpuGuestPoller, gpuHostIds, vmUsesGpu, getGpuGuestDiag } from '../../gpu/poller.js';
import { testVmGuest, VimSoapClient } from '../../gpu/guestops.js';
import { testVmGuestSsh, detectPhysicalGpu, guestIps } from '../../gpu/sshCollect.js';
import { listPhysical, addPhysical, updatePhysical, removePhysical, getPhysicalRaw, findPhysicalByHost } from '../../gpu/physicalRegistry.js';
import { getAllPhysicalGpu } from '../../gpu/physicalStore.js';
import { physicalPollerStatus, pollPhysicalOnce } from '../../gpu/physicalPoller.js';
import { getGuestGpuVms } from '../../gpu/store.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import { getAssignedGpuGuest, setAssignedGpuGuest, listAssignedGpuGuestAgents, redactAssignedGpuGuest } from '../../central/agentGpuGuestConfig.js';
import { upsertAgentUser, upsertAgentUsersBulk, removeAgentUser, listAgentUsers, listAgentUserAgents, GLOBAL_AGENT } from '../../central/agentUsers.js';
import { loadVcenterConfig } from '../../config.js';
import { expandIpList } from '../../idrac/iprange.js';
import { listCollectors } from '../../collector/registry.js';
import { adminOnly, maskPw } from './shared.js';

export function registerGpuGuest(adminRouter) {

// Metrics sampler settings: 온도/용량/GPU 수집 주기 + 보존기간 (런타임 변경).
adminRouter.get('/metrics/settings', adminOnly, (_req, res) => {
  res.json({ settings: loadMetricsSettings(), limits: METRICS_LIMITS, status: metricsSamplerStatus() });
});
adminRouter.put('/metrics/settings', adminOnly, (req, res) => {
  const settings = saveMetricsSettings(req.body || {});
  rescheduleMetricsSampler(); // apply the new interval immediately
  res.json({ ok: true, settings, status: metricsSamplerStatus() });
});
// GPU 호스트 사용률 '지금 수집' — 주기를 무시하고 즉시 한 번 수집(다음 스냅샷 갱신에 반영).
adminRouter.post('/gpu/collect-util', adminOnly, async (_req, res) => {
  try {
    forceGpuUtilCollect();
    // collectAll — 진행 중 수집이 있어도 완료 후 1회 더 실행 + due(주기) 필터를 무시하고 전
    // vCenter를 수집한다. 방금 폴링된 vCenter가 due에서 빠져 강제 플래그가 소비되지 못한 채
    // 버려지던 문제까지 방지(동시성 제한은 그대로 적용돼 부하는 평탄).
    await store.refresh({ force: true, collectAll: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message });
  } finally { clearGpuUtilForce(); }
});

// GPU 게스트 수집: 어떤 법인을 게스트 OS 계정으로 GPU 모니터링할지 + 자격증명.
adminRouter.get('/gpu-guest/settings', adminOnly, (_req, res) => {
  res.json({ settings: redactGpuGuestSettings(loadGpuGuestSettings()), status: gpuGuestStatus() });
});
adminRouter.put('/gpu-guest/settings', adminOnly, (req, res) => {
  const settings = saveGpuGuestSettings(req.body || {});
  rescheduleGpuGuestPoller();
  res.json({ ok: true, settings: redactGpuGuestSettings(settings), status: gpuGuestStatus() });
});

// GPU 게스트 수집 진단 — 어느 단계에서 막혔는지(선별 깔때기 + VM별 성공/실패·에러).
// 중앙 본인이 직접 수집하면 local, agent들이 push한 건 agents 로 함께 반환.
adminRouter.get('/gpu-guest/diag', adminOnly, (_req, res) => {
  res.json({ local: getGpuGuestDiag(), agents: getAllGpuGuestDiag() });
});

// 선택한 법인(vCenter)에서 GPU를 패스쓰루로 쓰는 VM 목록 — VM별 자격증명 설정용.
// 패스쓰루 호스트 위의 VM(전원/Tools 무관)을 모두 보여주고, 현재 저장된 VM별 계정 여부도 함께.
adminRouter.get('/gpu-guest/vms', adminOnly, (req, res) => {
  const vcId = req.query.vcenterId;
  if (!vcId) return res.status(400).json({ error: 'vcenterId 필요' });
  const snap = store.get();
  const hostNames = gpuHostIds(snap, vcId);
  // agent 지정 시(중앙 UI에서 원격 엣지 설정 배포 편집) '이 엣지 앞으로 지정한 배포 설정' 기준으로
  // 저장 여부/공용계정/IP를 표시. 지정 없으면 로컬 설정 기준(기존 동작).
  const agent = String(req.query.agent || '').trim();
  const s = agent ? (getAssignedGpuGuest(agent) || { vcenters: {} }) : loadGpuGuestSettings();
  const saved = (s.vcenters[vcId]?.vms) || {};
  // 실제 수집 상태(게스트에서 읽어온 마지막 값) — vmId 기준.
  const collectedBy = new Map(getGuestGpuVms().map((x) => [x.vmId, x]));
  const vms = (snap.vms || [])
    // 해당 vCenter에서 GPU(패스쓰루·vGPU)를 할당받은 VM(템플릿 제외).
    .filter((v) => v.vcenterId === vcId && !v.template && hostNames.has(v.host) && vmUsesGpu(v))
    .map((v) => {
      const c = collectedBy.get(v.id);
      return {
        id: v.id, name: v.name, host: v.host, cluster: v.cluster || '',
        powerState: v.powerState, toolsStatus: v.toolsStatus || '', guestOS: v.guestOS || '',
        gpu: v.gpu || null,
        hasOwnCred: !!saved[v.id]?.username, ownUsername: saved[v.id]?.username || '', ownPwless: !!saved[v.id]?.passwordless,
        ipAddresses: guestIps(v), ipOverride: (s.vcenters[vcId]?.vmIps || {})[v.id] || '',
        collected: c ? { utilPct: c.utilPct, memUsedPct: c.memUsedPct ?? null, at: c.at } : null,
      };
    })
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  res.json({ vcenterId: vcId, vcShared: { username: s.vcenters[vcId]?.username || '', hasPassword: !!s.vcenters[vcId]?.password }, vms });
});

// ── 중앙→엣지 GPU 게스트 설정 배포 관리 ────────────────────────────────────────────
// 원격 엣지(agent) 앞으로 GPU 게스트 수집 설정을 지정 → 엣지가 pull해 로컬 적용.
// 배포 대상 후보 agent 목록(수집 서버 등록분 + gpu-guest push 이력 + 이미 배포 지정된 것).
adminRouter.get('/gpu-guest/deploy/agents', adminOnly, (_req, res) => {
  const assigned = new Map(listAssignedGpuGuestAgents().map((a) => [a.agent, a]));
  const names = new Set();
  for (const c of listCollectors()) if (c.name) names.add(c.name); // 수집 서버(원격) 이름 = agent 이름
  for (const x of getAllGpuGuestDiag()) if (x.agent) names.add(x.agent); // gpu-guest 수집을 push한 엣지
  for (const a of assigned.keys()) names.add(a);
  const agents = [...names].sort().map((agent) => ({ agent, ...(assigned.get(agent) || { at: 0, vcenters: 0, vmCreds: 0, vmIps: 0, enabled: false, assigned: false }), assigned: assigned.has(agent) }));
  res.json({ agents });
});
// 특정 엣지 앞 배포 설정 조회(비밀번호 가림).
adminRouter.get('/gpu-guest/deploy/:agent', adminOnly, (req, res) => {
  res.json(redactAssignedGpuGuest(req.params.agent));
});
// 특정 엣지 앞 배포 설정 저장(병합). 엣지가 다음 pull 주기에 가져가 적용.
adminRouter.put('/gpu-guest/deploy/:agent', adminOnly, (req, res) => {
  const agent = String(req.params.agent || '').trim();
  if (!agent) return res.status(400).json({ ok: false, reason: 'agent 필요' });
  setAssignedGpuGuest(agent, req.body || {});
  res.json({ ok: true, ...redactAssignedGpuGuest(agent) });
});

// ── 중앙→엣지 배포 사용자 관리 ──────────────────────────────────────────────────
// 원격 엣지 포탈에 접속(설정 열람 등)할 수 있는 사용자를 중앙에서 지정 → 엣지가 pull해 반영.
// 후보 agent 목록(수집 서버 등록분 + gpu-guest push 이력 + 이미 사용자 배포된 것).
adminRouter.get('/edge-users/agents', adminOnly, (_req, res) => {
  const withUsers = new Map(listAgentUserAgents().map((a) => [a.agent, a]));
  const names = new Set();
  for (const c of listCollectors()) if (c.name) names.add(c.name);
  for (const x of getAllGpuGuestDiag()) if (x.agent) names.add(x.agent);
  for (const a of withUsers.keys()) if (a !== GLOBAL_AGENT) names.add(a); // '*'(글로벌)은 개별 목록서 제외
  const agents = [...names].sort().map((agent) => ({ agent, users: withUsers.get(agent)?.users || 0, at: withUsers.get(agent)?.at || 0 }));
  const g = withUsers.get(GLOBAL_AGENT);
  res.json({ agents, global: { users: g?.users || 0, at: g?.at || 0 } }); // global = 모든 엣지(전체) 배포 목록
});
// 특정 엣지 앞 배포 사용자 목록(비밀번호 해시 가림).
adminRouter.get('/edge-users/:agent', adminOnly, (req, res) => {
  res.json({ agent: req.params.agent, users: listAgentUsers(req.params.agent) });
});
// 사용자 추가/수정(비밀번호 주면 해시로 변환 저장). Body { username, name, role, password }.
adminRouter.post('/edge-users/:agent', adminOnly, (req, res) => {
  const r = upsertAgentUser(req.params.agent, req.body || {});
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, users: listAgentUsers(req.params.agent) } : r);
});
// 여러 엣지(또는 '*'=모든 엣지)에 같은 사용자를 한 번에 배포. Body { targets:[...], username, name, role, password }.
adminRouter.post('/edge-users-bulk', adminOnly, (req, res) => {
  const { targets, ...spec } = req.body || {};
  const r = upsertAgentUsersBulk(targets, spec);
  res.status(r.ok ? 200 : 400).json(r);
});
// 사용자 제거(다음 pull에 엣지에서도 삭제).
adminRouter.delete('/edge-users/:agent/:username', adminOnly, (req, res) => {
  const r = removeAgentUser(req.params.agent, req.params.username);
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, users: listAgentUsers(req.params.agent) } : r);
});

// ── 물리(베어메탈) 서버 GPU 수집 — IP+계정으로 SSH nvidia-smi(가상화 안 한 서버) ──────
adminRouter.get('/gpu-physical', adminOnly, (_req, res) => {
  res.json({ servers: listPhysical(), results: getAllPhysicalGpu(), status: physicalPollerStatus() });
});
adminRouter.post('/gpu-physical', adminOnly, (req, res) => {
  const r = addPhysical(req.body || {});
  if (r.ok) pollPhysicalOnce().catch(() => {});
  res.status(r.ok ? 201 : 400).json(r);
});
adminRouter.put('/gpu-physical/:id', adminOnly, (req, res) => {
  const r = updatePhysical(req.params.id, req.body || {});
  if (r.ok) pollPhysicalOnce().catch(() => {});
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/gpu-physical/:id', adminOnly, (req, res) => {
  const r = removePhysical(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/gpu-physical/poll', adminOnly, async (_req, res) => {
  res.json({ ok: true, lastRun: await pollPhysicalOnce() });
});
// IP+ID+PW+소속 vCenter만 받아 SSH 로그인→GPU/OS/호스트명 자동 감지→자동 등록.
// 같은 host가 이미 있으면 갱신. Body { host, username, password, port?, vcenterId? }
adminRouter.post('/gpu-physical/auto-register', adminOnly, async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const username = String(b.username || '').trim();
  if (!host || !username) return res.status(400).json({ ok: false, reason: 'IP/호스트와 계정이 필요합니다.' });
  const st = loadGpuGuestSettings();
  const det = await detectPhysicalGpu(host, { username, password: b.password || '' }, { timeoutMs: st.timeoutMs, port: Number(b.port) || 22 });
  if (!det.reachable) return res.status(400).json({ ok: false, reason: `SSH 접속 실패 — ${det.error || '계정/네트워크 확인'}`, detected: det });
  // 로그인은 됐지만 GPU/드라이버 미발견: force가 아니면 등록하지 않고 확인을 유도(프론트가 재확인).
  if (!det.gpuModels.length && !b.force) {
    return res.json({ ok: false, reachable: true, noGpu: true, reason: '로그인은 되었지만 GPU/드라이버를 찾지 못했습니다(nvidia-smi 미설치).', detected: det });
  }
  const os = /microsoft|windows/i.test(det.os) ? 'windows' : 'linux';
  const fields = { name: det.hostname || host, host, port: Number(b.port) || 22, username, password: b.password || '', os, vcenterId: String(b.vcenterId || '').trim(), gpuModels: det.gpuModels, enabled: true };
  const exist = findPhysicalByHost(host);
  let id;
  if (exist) { updatePhysical(exist.id, fields); id = exist.id; }
  else { const r = addPhysical(fields); if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, detected: det }); id = r.id; }
  pollPhysicalOnce().catch(() => {});
  res.json({ ok: true, id, updated: !!exist, noGpu: !det.gpuModels.length, detected: det });
});

// 여러 IP 일괄 자동 등록 — 대역/CIDR을 펼쳐 각 IP에 SSH 로그인→감지→등록(동시성 제한).
// Body { ips, username, password?, port?, vcenterId?, force? }
adminRouter.post('/gpu-physical/bulk-auto-register', adminOnly, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (!b.ips || !username) return res.status(400).json({ ok: false, reason: 'IP 목록과 계정이 필요합니다.' });
  const { ips: list, errors, truncated } = expandIpList(b.ips);
  const MAX = 512;
  const targets = list.slice(0, MAX);
  if (!targets.length) return res.status(400).json({ ok: false, reason: '유효한 IP가 없습니다.', ipErrors: errors });
  const st = loadGpuGuestSettings();
  const port = Number(b.port) || 22; const password = b.password || ''; const vcenterId = String(b.vcenterId || '').trim(); const force = !!b.force;
  const results = new Array(targets.length);
  let idx = 0;
  const worker = async () => {
    while (idx < targets.length) {
      const i = idx++; const ip = targets[i];
      const det = await detectPhysicalGpu(ip, { username, password }, { timeoutMs: st.timeoutMs, port }).catch((e) => ({ reachable: false, error: e.message, gpuModels: [] }));
      if (!det.reachable) { results[i] = { ip, ok: false, reachable: false, error: det.error || '접속 실패' }; continue; }
      if (!det.gpuModels.length && !force) { results[i] = { ip, ok: false, reachable: true, noGpu: true, host: det.hostname || '' }; continue; }
      const os = /microsoft|windows/i.test(det.os) ? 'windows' : 'linux';
      const fields = { name: det.hostname || ip, host: ip, port, username, password, os, vcenterId, gpuModels: det.gpuModels, enabled: true };
      const exist = findPhysicalByHost(ip);
      if (exist) updatePhysical(exist.id, fields); else addPhysical(fields);
      results[i] = { ip, ok: true, updated: !!exist, noGpu: !det.gpuModels.length, gpuCount: det.gpuModels.length, host: det.hostname || ip };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  pollPhysicalOnce().catch(() => {});
  const registered = results.filter((r) => r && r.ok).length;
  res.json({ ok: true, total: targets.length, registered, results, ipErrors: errors, truncated: truncated || list.length > MAX });
});

// 단건 SSH 테스트(저장 전 검증 가능) — body { host, username, password?, port?, revealCreds? } 또는 { id }
adminRouter.post('/gpu-physical/test', adminOnly, async (req, res) => {
  const b = req.body || {};
  let host = String(b.host || '').trim(); let username = String(b.username || '').trim(); let password = String(b.password || ''); let port = Number(b.port) || 22;
  if (b.id) { const s = getPhysicalRaw(b.id); if (s) { host = s.host; username = s.username; password = b.password || s.password; port = s.port || 22; } }
  if (!host || !username) return res.status(400).json({ ok: false, reason: 'host, username이 필요합니다.' });
  const st = loadGpuGuestSettings();
  const seed = b.revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${username} · pw=${maskPw(password)} · 포트=${port}` }] : [];
  try {
    const r = await testVmGuestSsh({ ipAddresses: [host] }, { username, password }, { timeoutMs: st.timeoutMs, port, trace: seed });
    res.json({ ok: true, host, port, ...r });
  } catch (e) { res.json({ ok: false, host, port, login: false, read: false, error: e.message, trace: seed }); }
});


//   { vcenterId, items: [{ vmId, username, password, useShared }] }
// useShared=true 면 법인 공용 계정으로, 아니면 입력한(없으면 저장된 VM별) 계정으로 테스트.
adminRouter.post('/gpu-guest/test', adminOnly, async (req, res) => {
  const { vcenterId, items } = req.body || {};
  const revealCreds = !!req.body?.revealCreds; // 관리자 디버그: 실행 로그에 실제 id/pw 평문 표시(응답에만, 디스크/중앙 미기록)
  if (!vcenterId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'vcenterId + items 필요' });
  const snap = store.get();
  const vmById = new Map((snap.vms || []).filter((v) => v.vcenterId === vcenterId).map((v) => [v.id, v]));
  // 호스트명 → 다운로드 후보 호스트(vCenter 실제 IP → ESXi IP → ESXi FQDN).
  const dlByHost = new Map();
  for (const h of snap.hosts || []) if (h.vcenterId === vcenterId) dlByHost.set(h.name, [h.mgmtServerIp, h.mgmtIp, h.name].filter(Boolean));
  const s = loadGpuGuestSettings();

  // 데모(mock) 환경: 실제 게스트가 없으므로 합성 결과.
  if (snap.source === 'mock') {
    return res.json({ mock: true, results: items.map((it) => {
      const v = vmById.get(it.vmId);
      const ok = !!v && v.powerState === 'POWERED_ON' && v.toolsStatus === 'RUNNING';
      return { vmId: it.vmId, login: ok, read: ok, error: ok ? null : 'VM 전원/Tools 미동작(mock)', sample: ok ? { gpus: 1, utilPct: 42 } : null };
    }) });
  }

  const vc = (loadVcenterConfig().vcenters || []).find((x) => x.id === vcenterId);
  if (!vc) return res.status(404).json({ error: '등록된 vCenter 아님' });
  const limit = Math.min(Math.max(1, s.concurrency || 4), 8);
  const results = new Array(items.length);
  let c;
  try {
    c = new VimSoapClient(vc);
    await c.login();
    const q = items.map((it, i) => ({ it, i }));
    const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
      while (q.length) {
        const { it, i } = q.shift();
        const v = vmById.get(it.vmId);
        if (!v) { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM을 찾을 수 없음', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — VM을 스냅샷에서 찾을 수 없음' }] }; continue; }
        if (v.toolsStatus !== 'RUNNING') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VMware Tools 미실행', trace: [{ t: Date.now(), msg: `✗ 건너뜀 — VMware Tools 미실행(status=${v.toolsStatus || '?'}) · 게스트 작업 불가` }] }; continue; }
        if (v.powerState !== 'POWERED_ON') { results[i] = { vmId: it.vmId, login: false, read: false, error: 'VM 전원 꺼짐', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — VM 전원 꺼짐' }] }; continue; }
        const isWindows = /windows/i.test(v.guestOS || '');
        // 자격증명 결정: useShared면 법인 공용(OS별), 아니면 입력값(빈 비번은 저장값) → 없으면 해석값.
        const vcShared = s.vcenters[vcenterId] || {};
        const sharedForOs = (isWindows && vcShared.winUsername)
          ? { username: vcShared.winUsername, password: vcShared.winPassword || '' }
          : (vcShared.username ? { username: vcShared.username, password: vcShared.password || '' } : null);
        let creds;
        if (it.useShared) creds = sharedForOs;
        // passwordless = 비번 없는 계정 → 빈 비번으로 인증(저장값으로 폴백하지 않음).
        else if (it.username) creds = { username: it.username, password: it.passwordless ? '' : (it.password || (vcShared.vms?.[it.vmId]?.password || '')), passwordless: !!it.passwordless };
        else creds = resolveVmCreds(s, vcenterId, it.vmId, isWindows);
        if (!creds || !creds.username) { results[i] = { vmId: it.vmId, login: false, read: false, error: '계정 없음', trace: [{ t: Date.now(), msg: '✗ 건너뜀 — 사용할 계정 없음(공용/별도 계정 미설정)' }] }; continue; }
        const moref = String(v.id).split(':').slice(1).join(':');
        const dlHosts = dlByHost.get(v.host) || [];
        // SSH 접속 고정 IP: 요청에 실린 선택값(it.ip, 저장 전 실시간 테스트) 우선, 없으면 저장된 vmIps.
        const preferIp = it.ip !== undefined ? String(it.ip || '').trim() : ((s.vcenters[vcenterId]?.vmIps || {})[it.vmId] || '');
        const reqMethod = ['guestops', 'ssh', 'auto'].includes(req.body?.method) ? req.body.method : (s.collectMethod || 'guestops');
        // Windows는 기본적으로 sshd가 없어 SSH 단독이면 실패 → VMware Tools 게스트작업 우선(auto)으로 조정.
        const method = resolveCollectMethod(reqMethod, isWindows);
        const winMethodAdjusted = method !== reqMethod;
        // 디버그(revealCreds): 실제 전송되는 id/pw를 평문으로 trace에 기록(이 응답에만, 디스크/중앙 미기록).
        const seed = revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${creds.username} · pw=${maskPw(creds.password)} · 방식=${method} · 출처=${it.useShared ? '공용' : (it.passwordless ? '별도(비번없음)' : '별도입력')}` }] : [];
        if (winMethodAdjusted) seed.push({ t: Date.now(), msg: 'ℹ Windows VM — SSH 대신 VMware Tools 게스트작업 우선(auto)으로 수집' });
        let r;
        if (method === 'ssh') {
          r = await testVmGuestSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, trace: seed, preferIp }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) }));
        } else if (method === 'auto') {
          // 수집과 동일: VMware Tools 게스트작업 먼저 → 실패 시 SSH 폴백.
          r = await testVmGuest(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts, trace: seed }).catch(() => null);
          if (!r || !r.read) {
            const seed2 = (r?.trace || seed).concat({ t: Date.now(), msg: '게스트작업 미수집 → SSH로 폴백' });
            r = await testVmGuestSsh(v, creds, { timeoutMs: s.timeoutMs, port: s.sshPort, trace: seed2, preferIp }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed2 }));
          }
        } else {
          r = await testVmGuest(c, moref, creds, { isWindows, timeoutMs: s.timeoutMs, dlHosts, trace: seed }).catch((e) => ({ login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) }));
        }
        results[i] = { vmId: it.vmId, ...r };
      }
    });
    await Promise.all(workers);
  } catch (e) {
    return res.status(500).json({ error: `vCenter 로그인 실패: ${e.message}` });
  } finally { try { await c?.logout(); } catch { /* */ } }
  res.json({ results });
});

// 빠른 단일 테스트(SSH) — VM 목록 로딩/ vCenter 없이 IP+계정만으로 nvidia-smi 1대 테스트.
// Body: { ip, username, password?, port?, revealCreds? }
adminRouter.post('/gpu-guest/test-ssh', adminOnly, async (req, res) => {
  const b = req.body || {};
  const ip = String(b.ip || '').trim();
  const username = String(b.username || '').trim();
  if (!ip || !username) return res.status(400).json({ error: 'ip, username(계정)이 필요합니다.' });
  const s = loadGpuGuestSettings();
  const port = Number(b.port) || s.sshPort || 22;
  const creds = { username, password: String(b.password || ''), privateKey: b.privateKey || undefined };
  const seed = b.revealCreds ? [{ t: Date.now(), msg: `🔓 자격증명: id=${username} · pw=${maskPw(b.password)} · 포트=${port}` }] : [];
  try {
    const r = await testVmGuestSsh({ ipAddresses: [ip] }, creds, { timeoutMs: s.timeoutMs, port, trace: seed });
    res.json({ ip, port, ...r });
  } catch (e) {
    res.json({ ip, port, login: false, read: false, error: e.message, trace: seed.concat({ t: Date.now(), msg: `✗ 예외: ${e.message}` }) });
  }
});
}
