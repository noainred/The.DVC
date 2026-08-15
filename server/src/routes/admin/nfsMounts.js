// 설정 › NFS 마운트(Edge 노드) 라우트(v2.299) — VM 복제(백업)의 NFS 대상 관리.
// 웹 UI 에서 마운트/해제를 실행하고 결과·로그·트러블슈팅을 본다(사용자 요구사항).
// 전부 adminOnly + 감사로그: mount/umount 는 Edge 노드 OS 상태를 바꾸는 작업이다.
// (셸 인젝션 방어는 system/nfsMounts.js 가 소유 — 화이트리스트 검증 + execFile 배열 인자.)
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import {
  listMounts, addMount, deleteMount, mountNow, umountNow, mountLogs, troubleshooting,
} from '../../system/nfsMounts.js';

const adminOnly = requireRole('admin');

export function registerNfsMounts(adminRouter) {

adminRouter.get('/nfs-mounts', adminOnly, (_req, res) => {
  res.json({ mounts: listMounts(), logs: mountLogs().slice(0, 50), tips: troubleshooting(), platform: process.platform });
});

adminRouter.post('/nfs-mounts', adminOnly, (req, res) => {
  try {
    const m = addMount(req.body || {});
    logAudit({ user: req.user?.username, action: 'NFS 마운트 등록', target: m.id, detail: `${m.server}:${m.exportPath}` });
    res.status(201).json({ ok: true, mount: m });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

adminRouter.delete('/nfs-mounts/:id', adminOnly, (req, res) => {
  try {
    if (!deleteMount(req.params.id)) return res.status(404).json({ ok: false, reason: '항목이 없습니다.' });
    logAudit({ user: req.user?.username, action: 'NFS 마운트 삭제', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ ok: false, reason: e.message }); }
});

adminRouter.post('/nfs-mounts/:id/mount', adminOnly, async (req, res) => {
  try {
    const r = await mountNow(req.params.id);
    logAudit({ user: req.user?.username, action: 'NFS 마운트 실행', target: req.params.id, detail: r.ok ? (r.already ? '이미 마운트됨' : r.mountPoint) : r.reason });
    res.status(r.ok ? 200 : 502).json(r);
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

adminRouter.post('/nfs-mounts/:id/umount', adminOnly, async (req, res) => {
  const r = await umountNow(req.params.id);
  logAudit({ user: req.user?.username, action: 'NFS 마운트 해제', target: req.params.id, detail: r.ok ? '해제됨' : r.reason });
  res.status(r.ok ? 200 : 502).json(r);
});

}
