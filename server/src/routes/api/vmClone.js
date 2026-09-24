// VM 복제(백업식) 라우트 — 특수기능 'VM 복제(백업)' 화면용(v2.299).
// 전부 admin 전용: 복제는 vCenter 상태변경(스냅샷·클론·삭제)이고, 보존정책은 VM 을 지운다 —
// operator 개방은 운영 검증 후 별도 결정(서버가 진실의 원천 — server/CLAUDE.md RBAC 규칙).
// 예외: /badges 는 Platform 트리(전 사용자)가 'Clone' 아이콘 표시에 쓰는 조회라 로그인만 요구
// 하되, scope 제한 계정에는 범위 밖 vCenter 를 비운다(존재 자체도 안 흘림 — scope 규칙).
import { requireRole, requirePerm } from '../../auth/auth.js'; // v2.479(감사 S-4)
import { scopedVcenterIds, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { listJobs, saveJob, deleteJob, jobVmIds } from '../../vmclone/store.js';
import { enqueueRun } from '../../vmclone/runner.js';
import { schedulerStatus } from '../../vmclone/scheduler.js';
import { listMounts } from '../../system/nfsMounts.js';

const adminOnly = requireRole('admin');

export function registerVmClone(api) {

/** 잡 목록 + 실행 상태 + NFS 마운트 요약(대상 선택 드롭다운용). */
api.get('/tools/vm-clone', adminOnly, (req, res) => {
  // v2.599(AUTHZ-2599-05): 범위 제한 admin 에게 범위 밖 vCenter 잡(VM 이름·대상 DS)을 주지 않는다 —
  //   형제 /badges 와 쓰기 라우트는 이미 범위를 본다. 뺀 개수는 밝힌다(조용한 절단 금지).
  const allowed = scopedVcenterIds(req.user, store.get());
  const all = listJobs();
  const jobs = allowed ? all.filter((j) => allowed.has(String(j.vcenterId))) : all;
  res.json({
    jobs,
    ...(allowed ? { scoped: true, omittedOutOfScope: all.length - jobs.length } : {}),
    status: schedulerStatus(),
    mounts: listMounts().map((m) => ({ id: m.id, server: m.server, exportPath: m.exportPath, mounted: m.mounted, mountPoint: m.mountPoint })),
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
  }
  // v2.599(AUTHZ-2599-06): vmId 가 인벤토리에 있으면 그 VM 의 vCenter 가 잡의 vCenter 와 같아야 한다(입력 정합성).
  //   권한 문제는 아니다(moref 는 job.vcenterId 연결에서만 쓰인다) — 다른 vCenter 의 VM 이 잡에 붙어 엉뚱한 moref 로
  //   스냅샷을 시도하는 것을 막는다. 인벤토리에 없는 vmId(수집 전·삭제)는 판정할 근거가 없어 막지 않는다.
  const vmId = String(req.body?.vmId || '');
  const vm = vmId ? (snap?.vms || []).find((v) => v.id === vmId) : null;
  if (vm && String(vm.vcenterId) !== vcenterId) {
    return res.status(400).json({ ok: false, reason: '선택한 VM 이 이 vCenter 에 속하지 않습니다.' });
  }
  try {
    const job = saveJob(req.body || {});
    logAudit({ user: req.user?.username, action: 'VM 복제 잡 저장', target: `${job.vcenterId}/${job.vmName}`, detail: `${job.dest.type}${job.dest.datastoreName ? `→${job.dest.datastoreName}` : ''} · ${job.schedule.mode} · 보존 ${job.keep}` });
    res.status(201).json({ ok: true, job });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/vm-clone/jobs/:id', adminOnly, (req, res) => {
  const target = listJobs().find((j) => j.id === req.params.id);
  if (target && !inUserWriteScope(req.user, store.get(), target.vcenterId)) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  if (!deleteJob(req.params.id)) return res.status(404).json({ ok: false, reason: '잡을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'VM 복제 잡 삭제', target: req.params.id, detail: '잡 정의만 삭제(만든 클론/사본은 유지)' });
  res.json({ ok: true });
});

/** 지금 실행 — 스케줄과 같은 직렬 큐에 넣는다(중복이면 사유 반환). */
api.post('/tools/vm-clone/jobs/:id/run', adminOnly, (req, res) => {
  const target = listJobs().find((j) => j.id === req.params.id);
  if (target && !inUserWriteScope(req.user, store.get(), target.vcenterId)) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
  }
  const r = enqueueRun(req.params.id, 'manual');
  logAudit({ user: req.user?.username, action: 'VM 복제 수동 실행', target: req.params.id, detail: r.queued ? '큐 등록' : r.reason });
  res.status(r.queued ? 202 : 409).json({ ok: r.queued, reason: r.reason });
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
