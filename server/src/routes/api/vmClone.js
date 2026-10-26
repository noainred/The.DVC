// VM 복제(백업식) 라우트 — 특수기능 'VM 복제(백업)' 화면용(v2.299).
// 전부 admin 전용: 복제는 vCenter 상태변경(스냅샷·클론·삭제)이고, 보존정책은 VM 을 지운다 —
// operator 개방은 운영 검증 후 별도 결정(서버가 진실의 원천 — server/CLAUDE.md RBAC 규칙).
// 예외: /badges 는 Platform 트리(전 사용자)가 'Clone' 아이콘 표시에 쓰는 조회라 로그인만 요구
// 하되, scope 제한 계정에는 범위 밖 vCenter 를 비운다(존재 자체도 안 흘림 — scope 규칙).
// v2.793 'VM 백업 센터' — 법인(수집 엣지)별 현황 · 실행 이력 · 복원 지점 · 검증 · 새 VM 으로 복구 · 법인 저장소(ESXi NFS 데이터스토어 ·
//   엣지 NFS 마운트). 엣지 위임 vCenter 의 작업은 담당 엣지로 보낸다(vmclone/dispatch.js). 새 단건 쓰기도 cloneJobDenied·accessOf 의
//   '조회 밖 404 → 쓰기 밖 403' 하나로 판정한다.
import { requireRole, requirePerm } from '../../auth/auth.js'; // v2.479(감사 S-4)
import { scopedVcenterIds, inUserWriteScope, inUserScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { getDataSource } from '../../runtime-settings.js';
import { listInventory } from '../../central/inventory.js';
import { listJobs, saveJob, deleteJob, jobVmIds, getJob, isDelegatedJob } from '../../vmclone/store.js';
import { enqueueRun } from '../../vmclone/runner.js';
import { schedulerStatus } from '../../vmclone/scheduler.js';
import { listMounts } from '../../system/nfsMounts.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { demoSiteVcenters } from '../../mock/demo/edge.js'; // v2.793: 데모 법인 묶음(mock 전용 — live 는 빈 배열)
import { listNfsDs, getNfsDs, createNfsDs, deleteNfsDs } from '../../vmclone/nfsDs.js';
import { executeOp } from '../../vmclone/execOp.js';
import { mountUseView, mountUseDenied, setMountUse, corpMountsLoadError } from '../../vmclone/corpMounts.js';
import { validateRestoreSpec, VERIFY_TIMEOUT_MIN } from '../../vmclone/vsOps.js';
import {
  execTargets, corpsOf, corpKeyOfTarget, edgeStateOf, createOp, finishOp, listOpsView, pendingOpFor, PENDING_TTL_MS, CLAIM_MS,
} from '../../vmclone/dispatch.js';

const adminOnly = requireRole('admin');

/**
 * v2.599(AUTHZ-2599-05 후속): 실행 상태의 running·queued 잡 id 도 목록과 같은 범위로 — 보이는 잡만 남기고
 * 범위 밖 실행 중이면 id·단계 대신 `runningOutOfScope: true` 로 '다른 잡이 도는 중' 만 밝힌다(직렬 큐라 대기 이유가 된다).
 */
export function scopeCloneStatus(st, visibleJobs, allJobs) {
  if (visibleJobs === allJobs || !st) return st;
  const ids = new Set(visibleJobs.map((j) => j.id));
  const queued = (st.queued || []).filter((id) => ids.has(id));
  const run = st.running && !ids.has(st.running.jobId) ? null : st.running;
  // v2.793: 검증·복구 등 작업 대기열(queuedOps)도 같은 범위로 — NFS 데이터스토어 연결(잡 없음)은 범위 계정에 싣지 않는다.
  const queuedOps = (st.queuedOps || []).filter((o) => ids.has(o.jobId));
  return { ...st, running: run, queued, ...(st.queuedOps ? { queuedOps } : {}), runningOutOfScope: !!(st.running && !run), queuedOutOfScope: (st.queued || []).length - queued.length };
}

/**
 * v2.743(감사 AUTHZ-02): NFS 마운트 요약 — 대상 선택 드롭다운·잡 배지의 원천.
 * 형제 GET /admin/nfs-mounts 는 전체 범위 전용(403)인데 이 경로는 범위 관리자에게도 NFS 서버 주소·export 경로·포탈 마운트
 * 절대 경로를 그대로 줬다. NFS 마운트에는 법인(vCenter) 귀속 필드가 없다 — '귀속 없는 데이터는 범위 계정에 노출하지 않는다'.
 * 범위 계정(전체 범위 아님)과 관리자가 아닌 문맥(mock 데모 계정 — isAdminReq 판정 하나)에는 {id, label, mounted} 만 주고
 * `masked:true` 로 밝힌다. label 은 서버 주소·경로 없이 마운트 id 로 만든다(마운트에는 이름 필드가 없다 — 지어내지 않는다).
 * 잡 저장(NFS 대상)은 막지 않는다(정책 — 범위 관리자가 공용 NFS 를 쓸 수 있는지는 운영 판단).
 * @returns {{ mounts: object[], masked: boolean }}
 */
export function mountsView(mounts, { full }) {
  const list = Array.isArray(mounts) ? mounts : [];
  if (full) {
    return { masked: false, mounts: list.map((m) => ({ id: m.id, label: `${m.server}:${m.exportPath}`, server: m.server, exportPath: m.exportPath, mounted: m.mounted, mountPoint: m.mountPoint })) };
  }
  return { masked: true, mounts: list.map((m) => ({ id: m.id, label: `NFS 마운트 ${m.id}`, mounted: m.mounted })) };
}

/**
 * v2.793: 엣지가 보고한 NFS 마운트 — 같은 가림 규칙(AUTHZ-02). 엣지 보고에는 서버:경로가 label 하나로 온다.
 * 여유·전체 바이트는 가리지 않는다(주소가 아니다).
 */
export function edgeMountsView(mounts, { full }) {
  return (Array.isArray(mounts) ? mounts : []).map((m) => ({
    id: m.id, label: full ? m.label : `NFS 마운트 ${m.id}`, mounted: !!m.mounted,
    ...(m.freeBytes != null ? { freeBytes: m.freeBytes } : {}), ...(m.totalBytes != null ? { totalBytes: m.totalBytes } : {}),
  }));
}

/** 잡 + 실행 위치 → 화면용 잡(엣지 위임 잡은 엣지가 보고한 실행 상태를 싣는다 — 중앙 정의에는 실행 상태가 없다). */
export function mergeJobView(job, target, edge) {
  const tg = target || { where: 'none', reason: '이 vCenter 의 등록 정보를 찾을 수 없습니다' };
  if (tg.where === 'local') return { ...job, history: job.history || [], exec: { where: 'local' } };
  const st = tg.where === 'edge' ? edge?.jobs?.get?.(job.id) : null;
  const run = edge?.runner?.running;
  return {
    ...job,
    lastRun: st?.lastRun || null, history: st?.history || [], clones: st?.clones || [],
    ...(st?.running ? { running: { at: 0 } } : {}),
    ...(st?.verifying ? { verifying: { at: 0 } } : {}),
    exec: {
      where: tg.where, agent: tg.agent || '', ...(tg.reason ? { reason: tg.reason } : {}),
      reportedAt: edge?.at || null, reported: !!st, ...(st?.problem ? { problem: st.problem } : {}),
      ...(run && run.jobId === job.id ? { runningPhase: run.phase, runningKind: run.kind, runningSince: run.startedAt } : {}),
    },
  };
}

/** vCenter 단위 접근(잡이 없는 쓰기 — NFS 데이터스토어) — 조회 밖 404 → 쓰기 밖 403. 통과하면 null. */
function accessOf(req, vcenterId) {
  const snap = store.get();
  if (!inUserScope(req.user, snap, String(vcenterId))) return { status: 404, body: { ok: false, reason: '찾을 수 없습니다.' } };
  if (!inUserWriteScope(req.user, snap, String(vcenterId))) return { status: 403, body: { ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' } };
  return null;
}

const mockNow = () => { try { return getDataSource() === 'mock'; } catch { return false; } };
/**
 * 등록부 vCenter + 실행 위치. 데모(mock)는 등록부 파일이 비어 있으므로 수집 스냅샷의 vCenter 로 채우고, 데모 엣지가 맡는 vCenter 는
 * 위임(site)·담당 엣지로 표시한다(portalCheck 의 demoSiteVcenters 와 같은 판정 — 실행은 이 노드가 시뮬레이션한다).
 */
function targetsNow() {
  const cfg = loadVcenterConfig();
  let vcenters = cfg.vcenters || [];
  const mock = mockNow();
  if (mock) {
    const snapVcs = store.get()?.vcenters || [];
    const have = new Set(vcenters.map((v) => String(v.id)));
    const site = new Map(demoSiteVcenters(snapVcs).map((v) => [String(v.id), v]));
    vcenters = [...vcenters, ...snapVcs.filter((v) => !have.has(String(v.id))).map((v) => site.get(String(v.id)) || { id: v.id, name: v.name || v.id, collectMode: 'direct', demo: true })];
  }
  return { vcenters, targets: execTargets(vcenters, listInventory(), { mock }) };
}

/** 실행 위치에 작업을 보낸다 — 중앙(직접)이면 바로 실행, 엣지면 대기(엣지가 인출). conflict·none 이면 409 를 쓰고 null. */
function dispatchOp(res, { kind, job = null, vcenterId, vmName = '', spec = {}, by }) {
  const tg = targetsNow().targets.get(String(vcenterId));
  if (!tg || tg.where === 'conflict' || tg.where === 'none') {
    res.status(409).json({ ok: false, reason: tg?.reason || '이 vCenter 의 실행 위치를 정할 수 없습니다.' });
    return null;
  }
  const op = createOp({ kind, jobId: job?.id || '', vcenterId, vmName: vmName || job?.vmName || '', spec, by, target: tg });
  if (tg.where === 'local') {
    op.state = 'running'; op.claimedAt = Date.now();
    executeOp({ id: op.id, kind, jobId: op.jobId, vcenterId, spec, by })
      .then((r) => finishOp(op, r))
      .catch((e) => finishOp(op, { ok: false, detail: String(e?.message || e) }));
  }
  return op;
}

/** 잡의 원장 — 엣지 위임 잡은 엣지가 보고한 원장(중앙 정의에는 원장이 없다). */
function clonesOf(job) {
  const tg = targetsNow().targets.get(String(job.vcenterId));
  return tg?.where === 'edge' ? (edgeStateOf(tg.agent)?.jobs?.get(job.id)?.clones || []) : (job.clones || []);
}

/** hostIds 정규화 — 그 vCenter 의 인벤토리 호스트만(다른 vCenter·지어낸 id 는 버린다). */
function hostIdsIn(vcenterId, ids) {
  const own = new Set((store.get()?.hosts || []).filter((h) => String(h.vcenterId) === String(vcenterId)).map((h) => h.id));
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => own.has(id)).slice(0, 500);
}

export function registerVmClone(api) {

/** 잡 목록 + 실행 상태 + NFS 마운트 요약(대상 선택 드롭다운용) + v2.793 법인 현황·작업 기록·법인 저장소. */
api.get('/tools/vm-clone', adminOnly, (req, res) => {
  // v2.599(AUTHZ-2599-05): 범위 제한 admin 에게 범위 밖 vCenter 잡(VM 이름·대상 DS)을 주지 않는다 —
  //   형제 /badges 와 쓰기 라우트는 이미 범위를 본다. 뺀 개수는 밝힌다(조용한 절단 금지).
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const all = listJobs();
  const jobs = allowed ? all.filter((j) => allowed.has(String(j.vcenterId))) : all;
  const full = !allowed && isAdminReq(req);
  const mv = mountsView(listMounts(), { full });
  const { vcenters, targets } = targetsNow();
  const visibleVcs = vcenters.filter((v) => !allowed || allowed.has(String(v.id)));
  const corps = corpsOf(visibleVcs, targets).map((c) => {
    const edge = c.agent ? edgeStateOf(c.agent) : null;
    const corpJobs = jobs.filter((j) => c.vcenterIds.includes(String(j.vcenterId)));
    return {
      ...c,
      ...(edge ? { edge: {
        // 동기화 상세(받지 않은 잡의 VM 이름·id)는 그 엣지의 **모든** vCenter 를 담는다 — 범위 계정에는 개수만(반증 검토 F5).
        at: edge.at, version: edge.version, proto: edge.proto,
        sync: allowed && edge.sync ? { at: edge.sync.at, added: edge.sync.added, updated: edge.sync.updated, removed: edge.sync.removed, conflicts: (edge.sync.conflicts || []).length, invalid: (edge.sync.invalid || []).length, ...(edge.sync.error ? { error: edge.sync.error } : {}) } : edge.sync,
        runner: scopeCloneStatus({ ...edge.runner }, corpJobs, allowed ? all : corpJobs),
        mounts: edgeMountsView(edge.mounts, { full }),
      } } : {}),
      writable: c.vcenterIds.filter((id) => inUserWriteScope(req.user, snap, id)),
      mountUse: mountUseView(c.key),   // v2.794: 백업에 쓸 마운트 지정(null = 전부)
    };
  });
  const vcName = new Map((snap?.vcenters || []).map((v) => [String(v.id), v.name || v.id]));
  const nfsDatastores = listNfsDs().filter((d) => !allowed || allowed.has(String(d.vcenterId))).map((d) => {
    const inv = (snap?.datastores || []).find((x) => String(x.vcenterId) === String(d.vcenterId) && x.name === d.name);
    const hostIds = (snap?.hosts || []).filter((h) => String(h.vcenterId) === String(d.vcenterId)).map((h) => h.id);
    return {
      ...d,
      // 데모 계정(관리자 판본이 아닌 문맥)에는 NFS 주소를 가린다. 범위 관리자는 자기 vCenter 의 정의라 그대로 본다(귀속이 있다).
      ...(isAdminReq(req) ? {} : { server: '(가림)', exportPath: '(가림)' }),
      hostsTotal: hostIds.length,
      hostsOk: hostIds.filter((id) => d.hosts?.[id]?.ok).length,
      ...(inv ? { capacityGB: inv.capacityGB ?? null, freeGB: inv.freeGB ?? null } : {}),
    };
  });
  res.json({
    jobs: jobs.map((j) => { const tg = targets.get(String(j.vcenterId)); return mergeJobView(j, tg, tg?.where === 'edge' ? edgeStateOf(tg.agent) : null); }),
    ...(allowed ? { scoped: true, omittedOutOfScope: all.length - jobs.length } : {}),
    status: scopeCloneStatus(schedulerStatus(), jobs, all),
    mounts: mv.mounts,
    ...(mv.masked ? { mountsMasked: true } : {}),
    corps,
    vcenterNames: Object.fromEntries(visibleVcs.map((v) => [String(v.id), vcName.get(String(v.id)) || v.name || v.id])),
    nfsDatastores,
    ops: listOpsView({ allowed }),
    ...(corpMountsLoadError() ? { corpMountsError: corpMountsLoadError().reason } : {}),
    limits: { verifyTimeoutMin: VERIFY_TIMEOUT_MIN, opPendingMin: Math.round(PENDING_TTL_MS / 60_000), opClaimMin: Math.round(CLAIM_MS / 60_000) },
  });
});

/** 잡 생성/수정 — body: { id?, vcenterId, vmId, vmName, dest, schedule, keep, quiesce, enabled } */
api.post('/tools/vm-clone/jobs', adminOnly, (req, res) => {
  // 복제는 vCenter 상태변경 — 쓰기 범위(writeVcenters, v2.369) 강제. 미설정이면 조회 범위와 동일.
  const snap = store.get();
  const vcenterId = String(req.body?.vcenterId || '');
  if (!inUserWriteScope(req.user, snap, vcenterId)) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  // v2.599(AUTHZ-2599-01): 수정(body.id)이면 **기존 잡의 vCenter** 도 쓰기 범위여야 한다(DELETE·run 과 같은 규칙).
  //   예전에는 body.vcenterId 만 봐서 범위 제한 admin 이 범위 밖 잡을 자기 vCenter 로 덮어써 가로챌 수 있었다.
  //   그리고 기존 잡의 vCenter 는 바꾸지 않는다 — clones 원장의 ref 는 옛 vCenter 의 것이라 새 vCenter 에서
  //   보존정책이 엉뚱한 VM 을 지울 수 있다(화면도 수정 시 vCenter 선택을 잠근다).
  const existingId = req.body?.id ? String(req.body.id) : '';
  const existing = existingId ? listJobs().find((j) => j.id === existingId) : null;
  if (existing) {
    if (!inUserWriteScope(req.user, snap, existing.vcenterId)) {
      return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
    }
    if (String(existing.vcenterId) !== vcenterId) {
      return res.status(400).json({ ok: false, reason: '기존 복제 잡의 vCenter 는 바꿀 수 없습니다 — 잡을 삭제하고 새로 만드세요.' });
    }
    // v2.767(점검 R2-B3-7): 대상 VM(vmId)도 바꾸지 않는다 — 바꾸면 '같은 VM 잡 중복 금지'(store.saveJob — 새 잡에만 검사)를 우회해 한 VM 에
    //   잡 두 개가 붙고, 옛 VM 의 클론 원장(clones)이 새 VM 의 보존 개수로 지워진다. 화면도 수정 때 VM 을 잠근다.
    if (String(existing.vmId) !== String(req.body?.vmId || '')) {
      return res.status(400).json({ ok: false, reason: '기존 복제 잡의 대상 VM 은 바꿀 수 없습니다 — 잡을 삭제하고 새로 만드세요.' });
    }
  }
  // v2.599(AUTHZ-2599-06): vmId 가 인벤토리에 있으면 그 VM 의 vCenter 가 잡의 vCenter 와 같아야 한다(입력 정합성).
  //   권한 문제는 아니다(moref 는 job.vcenterId 연결에서만 쓰인다) — 다른 vCenter 의 VM 이 잡에 붙어 엉뚱한 moref 로
  //   스냅샷을 시도하는 것을 막는다. 인벤토리에 없는 vmId(수집 전·삭제)는 판정할 근거가 없어 막지 않는다.
  const vmId = String(req.body?.vmId || '');
  const vm = vmId ? (snap?.vms || []).find((v) => v.id === vmId) : null;
  if (vm && String(vm.vcenterId) !== vcenterId) {
    return res.status(400).json({ ok: false, reason: '선택한 VM 이 이 vCenter 에 속하지 않습니다.' });
  }
  // v2.793: 법인 NFS 데이터스토어를 골랐으면 그 정의가 같은 vCenter 의 것이어야 한다(데이터스토어 이름은 정의에서 가져온다).
  const body = { ...(req.body || {}) };
  if (body.dest && typeof body.dest === 'object' && typeof body.dest.nfsDsId === 'string' && body.dest.nfsDsId) {
    const d = getNfsDs(body.dest.nfsDsId);
    if (!d || String(d.vcenterId) !== vcenterId) return res.status(400).json({ ok: false, reason: '고른 NFS 데이터스토어가 이 vCenter 의 법인 저장소가 아닙니다.' });
    body.dest = { type: 'datastore', datastoreName: d.name, nfsDsId: d.id };
  }
  // v2.794: 엣지 NFS 대상은 그 법인이 '사용' 으로 지정한 마운트만(지정이 없으면 전부). 기존 잡이 같은 마운트를 그대로 두는 수정은 막지 않는다.
  if (body.dest?.type === 'nfs' && !(existing?.dest?.type === 'nfs' && String(existing.dest.mountId) === String(body.dest.mountId || ''))) {
    const tg = targetsNow().targets.get(vcenterId);
    const why = mountUseDenied(body.dest, corpKeyOfTarget(tg));
    if (why) return res.status(400).json({ ok: false, reason: why });
  }
  try {
    const job = saveJob(body);
    logAudit({ user: req.user?.username, action: 'VM 복제 잡 저장', target: `${job.vcenterId}/${job.vmName}`, detail: `${job.dest.type}${job.dest.datastoreName ? `→${job.dest.datastoreName}` : ''} · ${job.schedule.mode} · 보존 ${job.keep}${job.keepDays ? `개·${job.keepDays}일` : ''}${job.verifyAfter ? ' · 자동 검증' : ''}` });
    res.status(201).json({ ok: true, job });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

// v2.767(점검 R2-B3-8): 단건 쓰기는 '조회 밖 404 → 쓰기 밖 403'(server/CLAUDE.md writeVcenters 규약). 예전엔 조회 범위 밖 잡에도 403 을 줘
//   존재를 흘렸고, 없는 잡 id 로 run 하면 큐에 넣고 202 '큐 등록' 이라고 답했다.
function cloneJobDenied(req, res, target) {
  const snap = store.get();
  if (!target || !inUserScope(req.user, snap, String(target.vcenterId || ''))) {
    res.status(404).json({ ok: false, reason: '잡을 찾을 수 없습니다.' });
    return true;
  }
  if (!inUserWriteScope(req.user, snap, target.vcenterId)) {
    res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
    return true;
  }
  return false;
}

api.delete('/tools/vm-clone/jobs/:id', adminOnly, (req, res) => {
  const target = listJobs().find((j) => j.id === req.params.id);
  if (cloneJobDenied(req, res, target)) return;
  let removed;
  try { removed = deleteJob(req.params.id); } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }   // v2.793: 엣지의 위임 잡
  if (!removed) return res.status(404).json({ ok: false, reason: '잡을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'VM 복제 잡 삭제', target: req.params.id, detail: '잡 정의만 삭제(만든 클론/사본은 유지)' });
  res.json({ ok: true });
});

/**
 * 지금 실행 — 스케줄과 같은 직렬 큐에 넣는다(중복이면 사유 반환).
 * v2.793: 엣지 위임 vCenter 면 담당 엣지로 보낸다(202 + where:'edge' — 엣지가 다음 동기화(기본 30초)에 가져간다).
 */
api.post('/tools/vm-clone/jobs/:id/run', adminOnly, (req, res) => {
  const target = listJobs().find((j) => j.id === req.params.id);
  if (cloneJobDenied(req, res, target)) return;
  // v2.767(R2-B3-9): 꺼진 잡은 runner 가 실행하지 않고 바로 끝낸다 — 큐 등록(202)이라고 답하지 않는다.
  if (!target.enabled) return res.status(409).json({ ok: false, reason: '꺼진 잡은 실행하지 않습니다 — 잡을 켠 뒤 실행하세요.' });
  if (!isDelegatedJob(target)) {
    const tg = targetsNow().targets.get(String(target.vcenterId));
    if (tg && tg.where !== 'local') {
      if (pendingOpFor(target.id, 'run')) return res.status(409).json({ ok: false, reason: '이미 담당 엣지로 보낸 실행이 있습니다.' });
      const op = dispatchOp(res, { kind: 'run', job: target, vcenterId: target.vcenterId, by: req.user?.username });
      if (!op) return;
      logAudit({ user: req.user?.username, action: 'VM 복제 수동 실행', target: `${target.vcenterId}/${target.vmName}`, detail: `담당 엣지 ${op.agent} 로 보냄` });
      return res.status(202).json({ ok: true, where: 'edge', agent: op.agent, opId: op.id });
    }
  }
  const r = enqueueRun(req.params.id, 'manual');
  logAudit({ user: req.user?.username, action: 'VM 복제 수동 실행', target: req.params.id, detail: r.queued ? '큐 등록' : r.reason });
  res.status(r.queued ? 202 : 409).json({ ok: r.queued, reason: r.reason });
});

/** 복원 지점 검증 — body: { ref } */
api.post('/tools/vm-clone/jobs/:id/verify', adminOnly, (req, res) => {
  const job = getJob(String(req.params.id));
  if (cloneJobDenied(req, res, job)) return;
  if (job.dest?.type !== 'datastore') return res.status(400).json({ ok: false, reason: 'NFS 파일 사본은 vCenter 에 등록된 VM 이 아니라 켜서 검증할 수 없습니다.' });
  const ref = String(req.body?.ref || '');
  if (!ref || !clonesOf(job).some((c) => c.ref === ref)) return res.status(400).json({ ok: false, reason: '이 잡의 복원 지점이 아닙니다(원장에 없음).' });
  if (pendingOpFor(job.id, 'verify', ref)) return res.status(409).json({ ok: false, reason: '이 복원 지점의 검증이 이미 진행 중입니다.' });
  const op = dispatchOp(res, { kind: 'verify', job, vcenterId: job.vcenterId, spec: { ref }, by: req.user?.username });
  if (!op) return;
  logAudit({ user: req.user?.username, action: 'VM 백업 검증 요청', target: `${job.vcenterId}/${job.vmName}`, detail: `${ref}${op.where === 'edge' ? ` · 담당 엣지 ${op.agent}` : ''}` });
  res.status(202).json({ ok: true, opId: op.id, where: op.where, agent: op.agent });
});

/** 새 VM 으로 복구 — body: { ref, newName, datastoreName, nicDisconnect, powerOn } */
api.post('/tools/vm-clone/jobs/:id/restore', adminOnly, (req, res) => {
  const job = getJob(String(req.params.id));
  if (cloneJobDenied(req, res, job)) return;
  if (job.dest?.type !== 'datastore') return res.status(400).json({ ok: false, reason: 'NFS 파일 사본은 이 화면에서 복구할 수 없습니다 — manifest.json 의 안내대로 데이터스토어에 올린 뒤 vmx 를 등록하세요.' });
  const ref = String(req.body?.ref || '');
  if (!ref || !clonesOf(job).some((c) => c.ref === ref)) return res.status(400).json({ ok: false, reason: '이 잡의 복원 지점이 아닙니다(원장에 없음).' });
  let spec;
  try { spec = validateRestoreSpec(job, req.body || {}, store.get() || {}); } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  if (pendingOpFor(job.id, 'restore')) return res.status(409).json({ ok: false, reason: '이 잡의 복구가 이미 진행 중입니다 — 끝난 뒤 다시 하세요.' });
  const op = dispatchOp(res, { kind: 'restore', job, vcenterId: job.vcenterId, spec: { ref, ...spec }, by: req.user?.username });
  if (!op) return;
  logAudit({ user: req.user?.username, action: 'VM 백업 복구 요청', target: `${job.vcenterId}/${job.vmName}`, detail: `${ref} → ${spec.newName} [${spec.datastoreName}]${spec.nicDisconnect ? ' · NIC 끊김' : ''}${spec.powerOn ? ' · 켜기' : ''}${op.where === 'edge' ? ` · 담당 엣지 ${op.agent}` : ''}` });
  res.status(202).json({ ok: true, opId: op.id, where: op.where, agent: op.agent });
});

/** 법인 저장소: ESXi NFS 데이터스토어 추가 + 호스트 연결 — body: { vcenterId, name, server, exportPath, nfsVersion, hostIds } */
api.post('/tools/vm-clone/nfs-datastores', adminOnly, (req, res) => {
  const vcenterId = String(req.body?.vcenterId || '');
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vCenter 를 고르세요.' });
  const deny = accessOf(req, vcenterId); if (deny) return res.status(deny.status).json(deny.body);
  const hostIds = hostIdsIn(vcenterId, req.body?.hostIds);
  if (!hostIds.length) return res.status(400).json({ ok: false, reason: '연결할 호스트를 고르세요(이 vCenter 의 호스트만).' });
  const tg = targetsNow().targets.get(vcenterId);
  if (!tg || tg.where === 'conflict' || tg.where === 'none') return res.status(409).json({ ok: false, reason: tg?.reason || '이 vCenter 의 실행 위치를 정할 수 없습니다.' });
  let item;
  try { item = createNfsDs({ vcenterId, ...(req.body || {}) }, req.user?.username); } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  const op = dispatchOp(res, { kind: 'nfsds-attach', vcenterId, spec: { nfsDsId: item.id, name: item.name, server: item.server, exportPath: item.exportPath, nfsVersion: item.nfsVersion, hostIds }, by: req.user?.username });
  if (!op) return;
  logAudit({ user: req.user?.username, action: 'NFS 데이터스토어 추가', target: `${vcenterId}/${item.name}`, detail: `${item.server}:${item.exportPath} · NFS ${item.nfsVersion} · 호스트 ${hostIds.length}대${op.where === 'edge' ? ` · 담당 엣지 ${op.agent}` : ''}` });
  res.status(202).json({ ok: true, item, opId: op.id, where: op.where, agent: op.agent });
});

/** 연결 다시 시도(실패·새 호스트) — body: { hostIds } */
api.post('/tools/vm-clone/nfs-datastores/:id/attach', adminOnly, (req, res) => {
  const item = getNfsDs(String(req.params.id));
  if (!item) return res.status(404).json({ ok: false, reason: '찾을 수 없습니다.' });
  const deny = accessOf(req, item.vcenterId); if (deny) return res.status(deny.status).json(deny.body);
  const hostIds = hostIdsIn(item.vcenterId, req.body?.hostIds);
  if (!hostIds.length) return res.status(400).json({ ok: false, reason: '연결할 호스트를 고르세요(이 vCenter 의 호스트만).' });
  const op = dispatchOp(res, { kind: 'nfsds-attach', vcenterId: item.vcenterId, spec: { nfsDsId: item.id, name: item.name, server: item.server, exportPath: item.exportPath, nfsVersion: item.nfsVersion, hostIds }, by: req.user?.username });
  if (!op) return;
  logAudit({ user: req.user?.username, action: 'NFS 데이터스토어 연결', target: `${item.vcenterId}/${item.name}`, detail: `호스트 ${hostIds.length}대${op.where === 'edge' ? ` · 담당 엣지 ${op.agent}` : ''}` });
  res.status(202).json({ ok: true, opId: op.id, where: op.where, agent: op.agent });
});

/**
 * v2.794 — 법인의 '백업에 쓸 마운트' 지정 — body: { corpKey: 'central' | 'edge:<이름>', mountIds: string[] | null(지정 해제) }.
 * 그 법인의 vCenter 를 **모두** 쓸 수 있는 계정만(조회 밖 404 → 쓰기 밖 403) — 한 법인 설정이 여러 vCenter 의 잡 대상을 좁힌다.
 */
api.put('/tools/vm-clone/corps/mounts', adminOnly, (req, res) => {
  const corpKey = String(req.body?.corpKey ?? '').trim().slice(0, 70);
  const snap = store.get();
  const { vcenters, targets } = targetsNow();
  const corp = corpKey === 'unassigned' ? null : corpsOf(vcenters, targets).find((c) => c.key === corpKey);
  const allowed = scopedVcenterIds(req.user, snap);
  if (!corp || (allowed && !corp.vcenterIds.some((id) => allowed.has(String(id))))) return res.status(404).json({ ok: false, reason: '법인을 찾을 수 없습니다.' });
  if (!corp.vcenterIds.every((id) => inUserWriteScope(req.user, snap, id))) return res.status(403).json({ ok: false, reason: '이 법인의 vCenter 를 모두 수정할 수 있는 계정만 바꿀 수 있습니다.' });
  const ids = req.body?.mountIds;
  if (ids != null && !Array.isArray(ids)) return res.status(400).json({ ok: false, reason: 'mountIds 는 배열 또는 null 이어야 합니다.' });
  let view;
  try { view = setMountUse(corp.key, ids, req.user?.username); } catch (e) { return res.status(400).json({ ok: false, reason: e.message }); }
  logAudit({ user: req.user?.username, action: 'VM 백업 법인 마운트 지정', target: corp.label || corp.key, detail: view ? `사용 ${view.mountIds.length}개(${view.mountIds.join(', ').slice(0, 150)})` : '지정 해제(전부 사용)' });
  res.json({ ok: true, mountUse: view });
});

/**
 * v2.794 — 떼어 내기(호스트에서 NFS 데이터스토어 제거) — body: { hostIds? } (없으면 연결 기록이 있는 호스트 전부).
 * 이 데이터스토어를 대상으로 쓰는 잡이 있으면 409 — 다음 백업이 '데이터스토어 없음' 으로 실패한다. 호스트의 VM 이 쓰면 그 호스트는 실행 노드가 거부한다.
 */
api.post('/tools/vm-clone/nfs-datastores/:id/detach', adminOnly, (req, res) => {
  const item = getNfsDs(String(req.params.id));
  if (!item) return res.status(404).json({ ok: false, reason: '찾을 수 없습니다.' });
  const deny = accessOf(req, item.vcenterId); if (deny) return res.status(deny.status).json(deny.body);
  const users = listJobs().filter((j) => j.dest?.type === 'datastore' && (j.dest.nfsDsId === item.id || (String(j.vcenterId) === String(item.vcenterId) && j.dest.datastoreName === item.name)));
  if (users.length) return res.status(409).json({ ok: false, reason: `이 데이터스토어를 대상으로 쓰는 백업 잡 ${users.length}개가 있습니다(${users.slice(0, 3).map((j) => j.vmName).join(', ')}${users.length > 3 ? ' 외' : ''}) — 잡의 대상을 바꾸거나 지운 뒤 떼어 내세요.` });
  const asked = Array.isArray(req.body?.hostIds) && req.body.hostIds.length ? req.body.hostIds : Object.keys(item.hosts || {});
  const hostIds = hostIdsIn(item.vcenterId, asked);
  if (!hostIds.length) return res.status(400).json({ ok: false, reason: '떼어 낼 호스트가 없습니다(연결 기록이 있는 이 vCenter 의 호스트만).' });
  const op = dispatchOp(res, { kind: 'nfsds-detach', vcenterId: item.vcenterId, spec: { nfsDsId: item.id, name: item.name, server: item.server, exportPath: item.exportPath, nfsVersion: item.nfsVersion, hostIds }, by: req.user?.username });
  if (!op) return;
  logAudit({ user: req.user?.username, action: 'NFS 데이터스토어 떼어 내기 요청', target: `${item.vcenterId}/${item.name}`, detail: `호스트 ${hostIds.length}대${op.where === 'edge' ? ` · 담당 엣지 ${op.agent}` : ''}` });
  res.status(202).json({ ok: true, opId: op.id, where: op.where, agent: op.agent });
});

/** 목록에서만 지운다 — ESXi 의 데이터스토어는 그대로다(사본이 남아 있을 수 있다 — vCenter 에서 직접). */
api.delete('/tools/vm-clone/nfs-datastores/:id', adminOnly, (req, res) => {
  const item = getNfsDs(String(req.params.id));
  if (!item) return res.status(404).json({ ok: false, reason: '찾을 수 없습니다.' });
  const deny = accessOf(req, item.vcenterId); if (deny) return res.status(deny.status).json(deny.body);
  deleteNfsDs(item.id);
  logAudit({ user: req.user?.username, action: 'NFS 데이터스토어 정의 삭제', target: `${item.vcenterId}/${item.name}`, detail: '목록에서만 삭제(ESXi 데이터스토어는 유지)' });
  res.json({ ok: true });
});

/**
 * 트리 배지 — 이 vCenter 에서 복제 잡이 걸린 vmId 목록(Platform 'VM 및 폴더'의 Clone 아이콘).
 * 로그인 사용자 전체 허용(민감정보 아님 — 어떤 VM 이 백업 대상인지 뿐), scope 는 강제:
 * 범위 밖 vCenter 요청은 빈 목록(404 아님 — 트리 폴링 경로라 오류 소음을 만들지 않는다).
 */
api.get('/tools/vm-clone/badges', requirePerm('tools'), (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!vcenterId || (allowed && !allowed.has(vcenterId))) return res.json({ vmIds: [] });
  res.json({ vmIds: jobVmIds(vcenterId) });
});

}
