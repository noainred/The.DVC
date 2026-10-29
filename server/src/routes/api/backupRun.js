/**
 * Backup 현황 › 백업 실행 라우트(v2.818, 도구 키 backup-run) — 포탈에서 고른 VM 을 Veeam B&R REST 로 백업한다.
 *
 * 접근 규약(server/CLAUDE.md — 되돌리지 말 것):
 *  · 전부 admin(+ 도구 권한). 백업 실행은 Veeam 의 상태를 바꾼다(잡 생성·수정·시작) — operator 개방은 운영 검증 뒤 별도 결정.
 *  · VM 목록: 조회 범위 밖 vCenter 404. 행마다 writable(쓰기 범위).
 *  · 미리보기·실행: 같은 판정 한 함수(planFor) — VM 마다 '조회 밖 404 → 쓰기 밖 403'. 실행은 재인증(OTP — reauth) + 감사로그.
 *  · 실행 기록: 범위 계정에는 VM 이 전부 자기 범위인 실행만(뺀 개수는 밝힌다). 단건은 범위 밖이면 404.
 *  · 설정(잡 접두·서버별 저장소·보존·vCenter 이름 지정)과 저장소 목록 조회: 전 법인 공용이라 전체 범위만. 설정 저장은 재인증.
 *  · Veeam 서버 등록·비밀번호는 모니터링 등록부(설정 › Veeam 백업 서버) 하나다 — 이 라우트는 비밀을 다루지도 돌려주지도 않는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope, inUserWriteScope } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { serversForVcenter, listServers, getServerWithSecret, registryLoadError } from '../../veeam/registry.js';
import { reauth } from './reauth.js';
import { veeamMatchFor } from './veeam.js';
import { runStatusOf, planBackup, portalJobName, veeamHostFor, vmSizeOf } from '../../veeam/run/plan.js';
import { getRunSettings, saveRunSettings, settingsLoadError, serverRunSettings } from '../../veeam/run/settings.js';
import { startRun, listRuns, getRun, activeRunFor, closeRun, serverBusy } from '../../veeam/run/runs.js';
import { dispatchOp, authStopOf } from '../../veeam/run/dispatch.js';
import { pendingView } from '../../veeam/run/edgeOps.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('백업 실행 설정은 전 법인 공용이라 전체 범위(vCenter 제한 없는) 계정만 쓸 수 있습니다.');
export const MAX_BACKUP_VMS = 200;
export const RUN_STATUSES = Object.freeze(['protected', 'in-job', 'unprotected', 'agent', 'elsewhere', 'unknown', 'unmapped']);

/** vCenter id → { id, name, host } — 이름은 스냅샷, 주소는 등록부(스냅샷에는 접속 주소가 없을 수 있다). */
export function vcentersOf(snap) {
  let reg = [];
  try { reg = listVcenters() || []; } catch { reg = []; }
  const host = new Map(reg.map((v) => [String(v.id), String(v.host || '')]));
  const out = new Map();
  for (const v of snap?.vcenters || []) out.set(String(v.id), { id: String(v.id), name: String(v.name || v.id), host: host.get(String(v.id)) || '' });
  return out;
}

/**
 * 한 vCenter 의 VM 별 실행 상태(+ Veeam 이 그 vCenter 를 부르는 이름). 순서: 대조(모니터링 코어) → runStatusOf → hostName.
 * @returns {{ vc, servers, known, hostName:{name,how}, rows:Map<vmId,{vm,run}> }}
 */
export function vcRunState(vc, vms, req) {
  const servers = serversForVcenter(vc.id);   // enabled · 등록 순서 · 비밀 없음
  const m = servers.length ? veeamMatchFor(vc, vms, req) : { known: false, match: null };
  const st = getRunSettings();
  const hostName = veeamHostFor(vc, { manual: st.hosts[vc.id] || '', aliasHosts: m.match?.aliasHosts || [] });
  const rows = new Map();
  for (const vm of vms) rows.set(vm.id, { vm, run: runStatusOf(vm, { servers, known: !!m.known, entry: m.match?.byVm?.[vm.id] }) });
  return { vc, servers, known: !!m.known, hostName, rows };
}

/**
 * 백업 요청 → 계획(실행·미리보기 공용 — 판정은 한 벌). VM 마다 조회 밖 404 → 쓰기 밖 403.
 * 같은 서버에 진행 중 실행이 있거나 인증 정지·저장소 없음이면 막는다(요청 전체 — 일부만 보내지 않는다).
 * @returns {{plan?:object, vcs?:Map, mode?:string, error?:string, status?:number, runId?:string}}
 */
export function planFor(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ids = Array.isArray(b.vmIds) ? [...new Set(b.vmIds.filter((x) => typeof x === 'string' && x.length <= 300))] : [];
  if (!ids.length) return { error: '백업할 VM 을 고르세요.', status: 400 };
  if (ids.length > MAX_BACKUP_VMS) return { error: `한 번에 ${MAX_BACKUP_VMS}대까지 요청할 수 있습니다.`, status: 400 };
  const mode = b.mode === 'portal' ? 'portal' : 'quick';
  const unprotected = b.unprotected === 'skip' ? 'skip' : 'portal';
  if (registryLoadError()) return { error: 'Veeam 서버 등록부를 읽지 못해 보낼 곳을 정할 수 없습니다 — 설정 › Veeam 백업 서버에서 확인하세요.', status: 503 };
  if (settingsLoadError()) return { error: '백업 실행 설정 파일을 읽지 못했습니다 — 백업 실행 설정을 다시 저장하세요.', status: 503 };
  const snap = store.get();
  const byId = new Map((snap?.vms || []).map((v) => [v.id, v]));
  const picked = [];
  for (const id of ids) {
    const vm = byId.get(id);
    if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return { error: `VM 을 찾을 수 없습니다(${id.slice(0, 80)}).`, status: 404 };
    if (!inUserWriteScope(req.user, snap, vm.vcenterId)) return { error: `조회 전용 범위 — '${vm.name}' 의 vCenter 는 수정(백업 실행) 권한이 없습니다.`, status: 403 };
    picked.push(vm);
  }
  const vcs = vcentersOf(snap);
  const allVmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = allVmsBy.get(vm.vcenterId); if (a) a.push(vm); else allVmsBy.set(vm.vcenterId, [vm]); }
  const states = new Map();
  const items = picked.map((vm) => {
    const vcId = String(vm.vcenterId);
    if (!states.has(vcId)) states.set(vcId, vcRunState(vcs.get(vcId) || { id: vcId, name: vcId, host: '' }, allVmsBy.get(vcId) || [], req));
    const s = states.get(vcId);
    return { vm, run: s.rows.get(vm.id)?.run, hostName: s.hostName.name };
  });
  const plan = planBackup(items, { mode, unprotected });
  if (!plan.groups.length) return { plan, vcs, mode, error: '보낼 VM 이 없습니다 — 고른 VM 이 전부 건너뜀입니다(아래 사유).', status: 400 };
  for (const g of plan.groups) {
    const busy = serverBusy(g.serverId);   // 실행 기록 + 관리 작업(빼기·삭제 — v2.819)
    if (busy) return { plan, vcs, mode, error: `Veeam 서버 '${g.serverName}' 로 진행 중인 요청이 있습니다(${busy.id}) — 끝난 뒤 다시 요청하세요.`, status: 409, runId: busy.id };
    const srv = getServerWithSecret(g.serverId);
    const stop = authStopOf(srv);
    if (stop) return { plan, vcs, mode, error: `Veeam 서버 '${g.serverName}' 은(는) 인증 실패로 정지 중입니다 — 설정 › Veeam 백업 서버에서 계정을 고치세요(틀린 계정으로 반복하면 계정이 잠깁니다).`, status: 409 };
    if (g.kind === 'portal' && !serverRunSettings(g.serverId).repositoryId) {
      return { plan, vcs, mode, error: `포탈 전용 잡으로 보낼 VM 이 있는데 Veeam 서버 '${g.serverName}' 의 저장소가 지정되지 않았습니다 — 백업 실행 설정에서 저장소를 고르세요(또는 '미보호 VM 건너뛰기').`, status: 400 };
    }
  }
  return { plan, vcs, mode };
}

/** 보낼 VM(Quick·포탈 잡)의 크기 합계 — 모르는 VM 은 더하지 않고 개수만 센다(부분 합을 전체처럼 말하지 않게). */
export function sizeTotal(vms) {
  const send = (Array.isArray(vms) ? vms : []).filter((v) => v.how === 'quick' || v.how === 'portal');
  const known = send.filter((v) => typeof v.sizeGB === 'number');
  const prov = send.filter((v) => typeof v.provisionedGB === 'number');
  const sum = (a, k) => Math.round(a.reduce((x, v) => x + v[k], 0) * 100) / 100;
  return { totalSizeGB: known.length ? sum(known, 'sizeGB') : null, totalProvisionedGB: prov.length ? sum(prov, 'provisionedGB') : null, sizeUnknown: send.length - known.length, sendCount: send.length };
}

/** 범위 계정에 보일 실행인가 — VM 이 전부 허용 vCenter 에 있을 때만. */
export const runVisible = (run, allowed) => !allowed || (run.vms || []).every((v) => allowed.has(String(v.vcenterId)));

export function registerBackupRun(api) {

/** VM 목록 + 실행 상태(한 vCenter). Query: vcenterId(필수). */
api.get('/tools/backup-run/vms', toolsPerm, adminOnly, (req, res) => {
  const snap = store.get();
  const vcId = String(req.query.vcenterId || '').slice(0, 128);
  const vcs = vcentersOf(snap);
  const allowed = scopedVcenterIds(req.user, snap);
  const list = [...vcs.values()].filter((v) => !allowed || allowed.has(v.id)).map((v) => ({ id: v.id, name: v.name, linked: serversForVcenter(v.id).length > 0 }));
  if (!vcId) return res.json({ ok: true, vcenters: list, rows: [] });
  if (!vcs.has(vcId) || !inUserScope(req.user, snap, vcId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const vms = (snap?.vms || []).filter((v) => v.vcenterId === vcId);
  const s = vcRunState(vcs.get(vcId), vms, req);
  const admin = isAdminDetailUser(req.user);
  const writable = inUserWriteScope(req.user, snap, vcId);
  const counts = Object.fromEntries(RUN_STATUSES.map((k) => [k, 0]));
  const rows = [];
  for (const { vm, run } of s.rows.values()) {
    if (vm.template === true || /^vcls/i.test(String(vm.name || ''))) continue;   // 백업 대상이 아니다(backupStatus.isSystemVm 과 같은 기준)
    counts[run.status] = (counts[run.status] || 0) + 1;
    rows.push({ id: vm.id, name: vm.name || vm.id, powerState: vm.powerState || '', folder: typeof vm.folder === 'string' ? vm.folder.slice(0, 200) : '', run, ...vmSizeOf(vm) });
  }
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const servers = s.servers.map((d) => {
    const full = getServerWithSecret(d.id);
    const stop = authStopOf(full);
    return { id: d.id, name: d.name, via: d.agent ? 'edge' : 'central', ...(admin ? { agent: d.agent || '' } : {}), authStopped: !!stop, active: !!serverBusy(d.id),
      repositorySet: !!serverRunSettings(d.id).repositoryId };
  });
  res.json({ ok: true, vcenters: list, vcenter: { id: vcId, name: s.vc.name }, known: s.known, hostName: s.hostName, jobName: portalJobName(getRunSettings().jobPrefix, s.vc),
    servers, rows, counts, writable, maxVms: MAX_BACKUP_VMS, ...(registryLoadError() ? { registryUnreadable: true } : {}), ...(settingsLoadError() ? { settingsUnreadable: true } : {}) });
});

/** 실행 전 미리보기(읽기성 POST — 아무것도 보내지 않는다). 실행과 같은 판정(planFor). 막히는 사유도 미리 말한다. */
api.post('/tools/backup-run/plan', toolsPerm, adminOnly, (req, res) => {
  const p = planFor(req);
  if (p.error && !p.plan) return res.status(p.status).json({ ok: false, reason: p.error });
  res.json({ ok: true, vms: p.plan.vms, groups: p.plan.groups.map((g) => ({ serverId: g.serverId, serverName: g.serverName, kind: g.kind, vcenterId: g.vcenterId || '', count: g.refs.length,
    jobName: g.kind === 'portal' ? portalJobName(getRunSettings().jobPrefix, p.vcs.get(g.vcenterId) || { id: g.vcenterId }) : '' })), ...sizeTotal(p.plan.vms), ...(p.error ? { blocked: p.error } : {}) });
});

/** 실행 — 재인증(OTP) + 감사. */
api.post('/tools/backup-run/backup', toolsPerm, adminOnly, reauth, (req, res) => {
  const p = planFor(req);
  if (p.error) return res.status(p.status).json({ ok: false, reason: p.error, ...(p.runId ? { runId: p.runId } : {}) });
  const run = startRun(p.plan, { user: req.user?.username || '', vcById: p.vcs, mode: p.mode });
  const n = (h) => p.plan.vms.filter((v) => v.how === h).length;
  logAudit({ user: req.user?.username, action: 'Veeam 백업 실행 요청', target: run.id, detail: `Quick ${n('quick')} · 포탈 전용 잡 ${n('portal')} · 건너뜀 ${n('skip')} — ${p.plan.vms.slice(0, 20).map((v) => v.name).join(', ')}${p.plan.vms.length > 20 ? ` 외 ${p.plan.vms.length - 20}` : ''}`, ip: req.ip });
  res.json({ ok: true, run });
});

api.get('/tools/backup-run/runs', toolsPerm, adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const all = listRuns();
  const runs = all.filter((r) => runVisible(r, allowed));
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
  res.json({ ok: true, runs: runs.slice(0, limit), total: runs.length, ...(allowed ? { scoped: true, omittedOutOfScope: all.length - runs.length } : {}) });
});

api.get('/tools/backup-run/runs/:id', toolsPerm, adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const run = getRun(String(req.params.id));
  if (!run || !runVisible(run, allowed)) return res.status(404).json({ ok: false, reason: '실행 기록을 찾을 수 없습니다.' });
  res.json({ ok: true, run });
});

/**
 * 실행 기록 닫기(재인증 + 감사) — 세션 추적이 계속 실패해 그 서버의 새 실행이 시한까지 막힐 때의 탈출구(2차 반증 N3).
 * 포탈 기록만 닫는다(끝나지 않은 VM 은 확인 불가) — Veeam 의 세션·잡은 멈추지 않는다. 조회 밖 404 → 쓰기 밖 403.
 */
api.post('/tools/backup-run/runs/:id/close', toolsPerm, adminOnly, reauth, (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const run = getRun(String(req.params.id));
  if (!run || !runVisible(run, allowed)) return res.status(404).json({ ok: false, reason: '실행 기록을 찾을 수 없습니다.' });
  if (run.vms.some((v) => !inUserWriteScope(req.user, snap, v.vcenterId))) return res.status(403).json({ ok: false, reason: '조회 전용 범위의 VM 이 들어 있는 실행은 닫을 수 없습니다.' });
  const r = closeRun(run.id, { user: req.user?.username || '' });
  if (!r.ok) return res.status(r.status).json({ ok: false, reason: r.reason || '닫지 못했습니다.' });
  logAudit({ user: req.user?.username, action: 'Veeam 백업 실행 기록 닫기', target: run.id, detail: `VM ${run.vms.length} — 확인 불가 ${r.run.summary?.unknown ?? 0}`, ip: req.ip });
  res.json({ ok: true, run: r.run });
});

/** 설정 — 잡 접두·서버별 저장소·보존·vCenter 이름. 서버·vCenter 목록(비밀 없음)과 엣지 대기 작업 수를 함께. */
api.get('/tools/backup-run/settings', toolsPerm, adminOnly, fullScopeOnly, (_req, res) => {
  const snap = store.get();
  const vcs = vcentersOf(snap);
  const st = getRunSettings();
  res.json({
    ok: true, settings: st,
    servers: listServers().map((d) => ({ id: d.id, name: d.name, host: d.host, agent: d.agent || '', enabled: d.enabled !== false, vcenterIds: d.vcenterIds || [], ...serverRunSettings(d.id) })),
    vcenters: [...vcs.values()].map((vc) => ({ id: vc.id, name: vc.name, host: vc.host, manualHost: st.hosts[vc.id] || '', jobName: portalJobName(st.jobPrefix, vc) })),
    pendingEdgeOps: pendingView(),
    ...(settingsLoadError() ? { settingsUnreadable: true } : {}), ...(registryLoadError() ? { registryUnreadable: true } : {}),
  });
});

api.put('/tools/backup-run/settings', toolsPerm, adminOnly, fullScopeOnly, reauth, (req, res) => {
  const { otp, ...input } = req.body && typeof req.body === 'object' ? req.body : {};
  void otp;
  // 등록부를 못 읽으면 화면의 서버 목록이 비어 servers:{} 가 온다(v2.820.1 B3) — 서버별 값은 받지 않고(잡 접두·vCenter 이름만 저장),
  //   그렇지 않아도 saveRunSettings 가 서버별 값을 **합친다**(입력에 없는 서버 id 는 유지 — 재시작 뒤 '파일 없음' 으로 보이는 경우까지).
  if (registryLoadError()) delete input.servers;
  const r = saveRunSettings(input);
  if (!r.ok) return res.status(400).json(r);
  logAudit({ user: req.user?.username, action: 'Veeam 백업 실행 설정 변경', target: 'backup-run', detail: `잡 접두 '${r.settings.jobPrefix}' · 저장소 지정 서버 ${Object.values(r.settings.servers).filter((x) => x.repositoryId).length} · vCenter 이름 지정 ${Object.keys(r.settings.hosts).length}`, ip: req.ip });
  res.json(r);
});

/** 저장소 목록(그 Veeam 서버에 직접 또는 담당 엣지로 — 읽기). 등록부의 서버만(본문의 주소를 받지 않는다). */
api.post('/tools/backup-run/servers/:id/repos', toolsPerm, adminOnly, fullScopeOnly, async (req, res) => {
  const s = getServerWithSecret(String(req.params.id));
  if (!s) return res.status(404).json({ ok: false, reason: 'Veeam 서버를 찾을 수 없습니다.' });
  res.locals.perfExpectSlow = true;   // 고RTT·엣지 대행은 수십 초가 정상
  const r = await dispatchOp(s, 'repos', {});
  res.json(r);
});

}
