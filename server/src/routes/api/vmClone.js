// VM 복제(백업식) 라우트 — 특수기능 'VM 복제(백업)' 화면용(v2.299).
// 전부 admin 전용: 복제는 vCenter 상태변경(스냅샷·클론·삭제)이고, 보존정책은 VM 을 지운다 —
// operator 개방은 운영 검증 후 별도 결정(서버가 진실의 원천 — server/CLAUDE.md RBAC 규칙).
// 예외: /badges 는 Platform 트리(전 사용자)가 'Clone' 아이콘 표시에 쓰는 조회라 로그인만 요구
// 하되, scope 제한 계정에는 범위 밖 vCenter 를 비운다(존재 자체도 안 흘림 — scope 규칙).
import { requireRole } from '../../auth/auth.js';
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
api.get('/tools/vm-clone', adminOnly, (_req, res) => {
  res.json({
    jobs: listJobs(),
    status: schedulerStatus(),
    mounts: listMounts().map((m) => ({ id: m.id, server: m.server, exportPath: m.exportPath, mounted: m.mounted, mountPoint: m.mountPoint })),
  });
});

/** 잡 생성/수정 — body: { id?, vcenterId, vmId, vmName, dest, schedule, keep, quiesce, enabled } */
api.post('/tools/vm-clone/jobs', adminOnly, (req, res) => {
  // 복제는 vCenter 상태변경 — 쓰기 범위(writeVcenters, v2.369) 강제. 미설정이면 조회 범위와 동일.
  if (!inUserWriteScope(req.user, store.get(), String(req.body?.vcenterId || ''))) {
    return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
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
api.get('/tools/vm-clone/badges', (req, res) => {
  const vcenterId = String(req.query.vcenterId || '');
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!vcenterId || (allowed && !allowed.has(vcenterId))) return res.json({ vmIds: [] });
  res.json({ vmIds: jobVmIds(vcenterId) });
});

}
