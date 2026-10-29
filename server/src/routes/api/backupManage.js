/**
 * Backup 현황 › 포탈 백업 관리 라우트(v2.819, 도구 키 backup-run) — 포탈로 백업한 VM 목록 · 복원 지점 · **새 VM 으로** 복원 · 포탈 잡에서 빼기 · 백업 삭제.
 *
 * 접근 규약(server/CLAUDE.md — 되돌리지 말 것):
 *  · 전부 admin + 도구 권한. VM 단건은 '조회 밖 404 → 쓰기 밖 403'(ctxFor 한 함수). 목록은 조회 범위 교집합.
 *  · 복원·빼기·삭제는 재인증(OTP — reauth) + 감사 로그(실패·모름도 남긴다). 삭제는 VM 이름을 다시 입력해야 한다.
 *  · 복원은 **새 이름의 VM 으로만**(원본 덮어쓰기 없음 — run/manage.js RESTORE_TYPE). 새 이름은 그 vCenter 인벤토리의 VM 이름과 겹치면 거절.
 *  · 같은 Veeam 서버로 진행 중인 요청이 있으면 409(백업·복원·빼기·삭제 공통 — 진행 중인 잡을 고치지 않게). 인증 정지면 409.
 *  · Veeam 서버는 그 vCenter 를 맡는 등록 서버 중에서만(본문의 serverId 를 그대로 믿지 않는다).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { serversForVcenter, getServerWithSecret, registryLoadError } from '../../veeam/registry.js';
import { reauth } from './reauth.js';
import { vcentersOf, vcRunState, runVisible } from './backupRun.js';
import { portalJobName, morefOf } from '../../veeam/run/plan.js';
import { getRunSettings } from '../../veeam/run/settings.js';
import { startRun, listRuns, activeRunFor } from '../../veeam/run/runs.js';
import { dispatchOp, authStopOf } from '../../veeam/run/dispatch.js';
import { listPortalVms, getPortalVm, notePortalVm } from '../../veeam/run/portalVms.js';
import { NEW_NAME_RE } from '../../veeam/run/manage.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');

/**
 * VM 하나의 관리 맥락 — 판정은 이 함수 하나(조회 밖 404 → 쓰기 밖 403).
 * @returns {{error?:string, status?:number, vm?, vc?, servers?, hostName?, jobName?, dest?, record?, snap?}}
 */
export function ctxFor(req, vmId, { write = false } = {}) {
  const snap = store.get();
  const vm = (snap?.vms || []).find((v) => v.id === vmId);
  if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return { error: 'VM 을 찾을 수 없습니다.', status: 404 };
  if (write && !inUserWriteScope(req.user, snap, vm.vcenterId)) return { error: `조회 전용 범위 — '${vm.name}' 의 vCenter 는 수정 권한이 없습니다.`, status: 403 };
  if (registryLoadError()) return { error: 'Veeam 서버 등록부를 읽지 못했습니다 — 설정 › Veeam 백업 서버에서 확인하세요.', status: 503 };
  const vcId = String(vm.vcenterId);
  const vc = vcentersOf(snap).get(vcId) || { id: vcId, name: vcId, host: '' };
  const servers = serversForVcenter(vcId);
  const vms = (snap?.vms || []).filter((v) => v.vcenterId === vcId);
  const s = vcRunState(vc, vms, req);
  const record = getPortalVm(vmId);
  const hostObj = (snap?.hosts || []).find((h) => h.vcenterId === vcId && h.name === vm.host);
  const hostMoref = hostObj ? morefOf(hostObj) : '';
  // Veeam 이 이 vCenter 를 부르는 이름 — 복원 대상(dest)은 **지금 설정·대조** 기준(관리자가 이름을 고쳤으면 고친 이름), 없으면 지난 요청에 쓴 이름.
  //   잡에서 빼기·삭제는 잡 includes 와 맞춰야 하므로 **잡에 넣을 때 쓴 이름**(기록)을 먼저 쓴다(jobHostName).
  const hostName = s.hostName.name || record?.hostName || '';
  const hostHow = s.hostName.name ? s.hostName.how : (record?.hostName ? 'record' : '');
  const jobHostName = record?.hostName || s.hostName.name || '';
  const dest = hostName && vm.host && hostMoref ? { hostName, host: { name: String(vm.host), objectId: hostMoref } } : null;
  return { snap, vm, vc, servers, run: s.rows.get(vm.id)?.run || null, hostName, hostHow, jobHostName, jobName: portalJobName(getRunSettings().jobPrefix, vc), dest, record, vms };
}

/** 본문의 serverId 를 그 vCenter 의 서버 중에서만 받는다. 없으면 기록·대조가 가리키는 서버, 그다음 첫 서버. */
function serverOf(ctx, wanted) {
  const ids = ctx.servers.map((d) => d.id);
  const id = ids.includes(wanted) ? wanted : ids.includes(ctx.record?.serverId) ? ctx.record.serverId : ids.includes(ctx.run?.serverId) ? ctx.run.serverId : ids[0];
  return id ? getServerWithSecret(id) : null;
}
/** 보내기 전 공통 확인(진행 중·인증 정지). */
function busyIssue(server) {
  if (!server) return { error: '이 vCenter 를 맡는 Veeam B&R 서버가 등록돼 있지 않습니다.', status: 400 };
  const busy = activeRunFor(server.id);
  if (busy) return { error: `Veeam 서버 '${server.name}' 로 진행 중인 요청이 있습니다(${busy.id}) — 끝난 뒤 다시 하세요.`, status: 409 };
  if (authStopOf(server)) return { error: `Veeam 서버 '${server.name}' 은(는) 인증 실패로 정지 중입니다 — 설정 › Veeam 백업 서버에서 계정을 고치세요.`, status: 409 };
  return null;
}
const vmView = (ctx) => ({ id: ctx.vm.id, name: ctx.vm.name, vcenterId: ctx.vm.vcenterId, vcenterName: ctx.vc.name, folder: typeof ctx.vm.folder === 'string' ? ctx.vm.folder.slice(0, 200) : '', host: ctx.vm.host || '', powerState: ctx.vm.powerState || '' });

export function registerBackupManage(api) {

/** 포탈로 백업한 VM 목록(조회 범위 교집합). Query: vcenterId(선택). 폴더 트리 배지·'포탈 백업 VM' 표가 쓴다(가벼운 로컬 읽기). */
api.get('/tools/backup-run/portal-vms', toolsPerm, adminOnly, (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vcId = String(req.query.vcenterId || '').slice(0, 128);
  if (vcId && !inUserScope(req.user, snap, vcId)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const present = new Map((snap?.vms || []).map((v) => [v.id, v]));
  const vcs = vcentersOf(snap);
  const vms = listPortalVms({ allowed, vcenterId: vcId }).map((r) => {
    const live = present.get(r.vmId);
    return { vmId: r.vmId, name: live?.name || r.name, vcenterId: r.vcenterId, vcenterName: vcs.get(r.vcenterId)?.name || r.vcenterId, folder: typeof live?.folder === 'string' ? live.folder.slice(0, 200) : '',
      exists: !!live, serverName: r.serverName || '', how: r.how || '', jobName: r.jobName || '', lastAt: r.lastAt ?? null, lastState: r.lastState || '',
      excludedAt: r.excludedAt ?? null, deletedAt: r.deletedAt ?? null, restores: (r.restores || []).slice(0, 3) };
  });
  res.json({ ok: true, vms });
});

/** VM 하나의 관리 정보(로컬 — Veeam 에 묻지 않는다). */
api.get('/tools/backup-run/vm/:vmId', toolsPerm, adminOnly, (req, res) => {
  const ctx = ctxFor(req, String(req.params.vmId).slice(0, 300));
  if (ctx.error) return res.status(ctx.status).json({ ok: false, reason: ctx.error });
  const allowed = scopedVcenterIds(req.user, ctx.snap);
  const runs = listRuns().filter((r) => runVisible(r, allowed) && r.vms.some((v) => v.vmId === ctx.vm.id)).slice(0, 10).map((r) => {
    const v = r.vms.find((x) => x.vmId === ctx.vm.id);
    return { id: r.id, at: r.at, user: r.user, how: v.how, state: v.state, detail: v.detail, newName: v.restore?.newName || '' };
  });
  const names = new Set(ctx.vms.map((v) => String(v.name || '').toLowerCase()));
  res.json({
    ok: true, vm: vmView(ctx), record: ctx.record, jobName: ctx.record?.jobName || ctx.jobName, hostName: { name: ctx.hostName, how: ctx.hostHow }, canRestore: !!ctx.dest,
    servers: ctx.servers.map((d) => { const full = getServerWithSecret(d.id); return { id: d.id, name: d.name, authStopped: !!authStopOf(full), active: !!activeRunFor(d.id) }; }),
    serverId: serverOf(ctx, '')?.id || '', writable: inUserWriteScope(req.user, ctx.snap, ctx.vm.vcenterId), runs,
    suggestName: suggestName(ctx.vm.name, names),
  });
});

/** 복원 지점(Veeam 에 묻는다 — 읽기성 POST, 아무것도 바꾸지 않는다). Body: { serverId? } */
api.post('/tools/backup-run/vm/:vmId/points', toolsPerm, adminOnly, async (req, res) => {
  const ctx = ctxFor(req, String(req.params.vmId).slice(0, 300));
  if (ctx.error) return res.status(ctx.status).json({ ok: false, reason: ctx.error });
  const server = serverOf(ctx, String(req.body?.serverId || ''));
  if (!server) return res.status(400).json({ ok: false, reason: '이 vCenter 를 맡는 Veeam B&R 서버가 등록돼 있지 않습니다.' });
  res.locals.perfExpectSlow = true;   // 고RTT·엣지 대행
  const r = await dispatchOp(server, 'vmPoints', { vm: { name: ctx.vm.name, objectId: ctx.record?.objectId || morefOf(ctx.vm), hostName: ctx.jobHostName }, jobName: ctx.record?.jobName || ctx.jobName });
  res.json({ ...r, serverId: server.id, serverName: server.name });
});

/** 새 VM 으로 복원 — 재인증 + 감사. Body: { serverId, restorePointId, newName, pointAt?, otp } */
api.post('/tools/backup-run/vm/:vmId/restore', toolsPerm, adminOnly, reauth, (req, res) => {
  const ctx = ctxFor(req, String(req.params.vmId).slice(0, 300), { write: true });
  if (ctx.error) return res.status(ctx.status).json({ ok: false, reason: ctx.error });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const pid = typeof b.restorePointId === 'string' ? b.restorePointId : '';
  const newName = typeof b.newName === 'string' ? b.newName.trim() : '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(pid)) return res.status(400).json({ ok: false, reason: '복원 지점을 고르세요.' });
  if (!NEW_NAME_RE.test(newName)) return res.status(400).json({ ok: false, reason: '새 VM 이름은 영문·숫자로 시작하고 영문·숫자·. _ - 만 쓸 수 있습니다(80자까지).' });
  if (ctx.vms.some((v) => String(v.name || '').toLowerCase() === newName.toLowerCase())) return res.status(409).json({ ok: false, reason: `이 vCenter 에 '${newName}' VM 이 이미 있습니다 — 다른 이름을 쓰세요(원본을 덮어쓰지 않습니다).` });
  if (!ctx.dest) return res.status(400).json({ ok: false, reason: '복원할 ESXi 호스트나 Veeam 이 이 vCenter 를 부르는 이름을 모릅니다 — 백업 실행 설정의 vCenter 이름을 확인하세요.' });
  const server = serverOf(ctx, String(b.serverId || ''));
  const issue = busyIssue(server);
  if (issue) return res.status(issue.status).json({ ok: false, reason: issue.error });
  const pointAt = Number.isFinite(Number(b.pointAt)) ? Number(b.pointAt) : null;
  const vmRow = { vmId: ctx.vm.id, name: ctx.vm.name, vcenterId: ctx.vm.vcenterId, objectId: morefOf(ctx.vm), hostName: ctx.hostName, serverId: server.id, serverName: server.name, how: 'restore',
    restore: { restorePointId: pid, newName, dest: ctx.dest, pointAt } };
  const run = startRun({ vms: [vmRow], groups: [{ serverId: server.id, serverName: server.name, kind: 'restore', vcenterId: ctx.vm.vcenterId, refs: [vmRow] }] }, { user: req.user?.username || '', mode: 'restore' });
  logAudit({ user: req.user?.username, action: 'Veeam 새 VM 복원 요청', target: run.id, detail: `${ctx.vm.name} → ${newName} · 복원 지점 ${pid} · 서버 ${server.name} · 호스트 ${ctx.dest.host.name}`, ip: req.ip });
  res.json({ ok: true, run });
});

/** 포탈 전용 잡에서 빼기 — 재인증 + 감사. Body: { serverId, otp } */
api.post('/tools/backup-run/vm/:vmId/exclude', toolsPerm, adminOnly, reauth, async (req, res) => {
  const ctx = ctxFor(req, String(req.params.vmId).slice(0, 300), { write: true });
  if (ctx.error) return res.status(ctx.status).json({ ok: false, reason: ctx.error });
  const server = serverOf(ctx, String(req.body?.serverId || ''));
  const issue = busyIssue(server);
  if (issue) return res.status(issue.status).json({ ok: false, reason: issue.error });
  const jobName = ctx.record?.jobName || ctx.jobName;
  res.locals.perfExpectSlow = true;
  const r = await dispatchOp(server, 'jobExclude', { jobName, vms: [{ hostName: ctx.jobHostName, objectId: ctx.record?.objectId || morefOf(ctx.vm) }] });
  if (r.ok) notePortalVm(ctx.vm.id, { excludedAt: Date.now() });
  logAudit({ user: req.user?.username, action: 'Veeam 포탈 잡에서 VM 빼기', target: ctx.vm.name, detail: `잡 '${jobName}' · 서버 ${server.name} · ${r.ok ? `뺌 ${r.removed ?? 0}` : r.unknown ? '결과 모름' : `실패 — ${String(r.reason || '').slice(0, 200)}`}`, ip: req.ip });
  res.json({ ...r, jobName });
});

/** 백업 삭제(되돌릴 수 없음) — 재인증 + VM 이름 재입력 + 감사. Body: { serverId, confirmName, otp } */
api.post('/tools/backup-run/vm/:vmId/delete-backup', toolsPerm, adminOnly, reauth, async (req, res) => {
  const ctx = ctxFor(req, String(req.params.vmId).slice(0, 300), { write: true });
  if (ctx.error) return res.status(ctx.status).json({ ok: false, reason: ctx.error });
  if (String(req.body?.confirmName || '') !== String(ctx.vm.name)) return res.status(400).json({ ok: false, reason: `확인을 위해 VM 이름('${ctx.vm.name}')을 그대로 입력하세요.` });
  const server = serverOf(ctx, String(req.body?.serverId || ''));
  const issue = busyIssue(server);
  if (issue) return res.status(issue.status).json({ ok: false, reason: issue.error });
  const jobName = ctx.record?.jobName || ctx.jobName;
  res.locals.perfExpectSlow = true;
  const r = await dispatchOp(server, 'deleteBackup', { jobName, vm: { name: ctx.vm.name, hostName: ctx.jobHostName, objectId: ctx.record?.objectId || morefOf(ctx.vm) } });
  const now = Date.now();
  if (r.excluded || r.ok) notePortalVm(ctx.vm.id, { ...(r.excluded ? { excludedAt: now } : {}), ...(r.ok && r.deleted ? { deletedAt: now } : {}) });
  logAudit({ user: req.user?.username, action: 'Veeam 포탈 잡 백업 삭제', target: ctx.vm.name, detail: `잡 '${jobName}' · 서버 ${server.name} · ${r.ok ? `삭제 ${r.deleted ?? 0}건${r.excluded ? ' · 잡에서 뺌' : ''}` : r.unknown ? '결과 모름' : `실패 — ${String(r.reason || '').slice(0, 200)}`}`, ip: req.ip });
  res.json({ ...r, jobName });
});

}

/** 새 VM 이름 제안 — '<원본>-restored-YYYYMMDD-HHmm'(인벤토리와 겹치면 -2, -3 …). 원본 이름에 쓸 수 없는 글자는 '-' 로. */
export function suggestName(name, taken = new Set(), now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  let base = String(name || 'vm').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 50) || 'vm';
  base = `${base}-restored-${stamp}`;
  let n = base; let i = 2;
  while (taken.has(n.toLowerCase()) && i < 100) n = `${base}-${i++}`;
  return n;
}
