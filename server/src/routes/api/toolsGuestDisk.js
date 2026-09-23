/**
 * routes/api/toolsGuestDisk.js — 게스트 디스크 회수 리포트 API(v2.459).
 *
 * 조회는 scope(scopedVcenterIds) 를 요청 필터보다 먼저 적용해 범위 밖 vCenter 의 VM 을 흘리지
 * 않는다(보안 불변조건). 상태변경(설정 저장·수동 수집)은 requireRole('admin').
 */
import { scopedVcenterIds } from '../../auth/scope.js';
import { scopePollerStatus, scopeDbStatus } from '../../auth/scopeStatus.js'; // v2.583
import { requireRole, requirePerm } from '../../auth/auth.js'; // v2.478(감사 S5): 조회는 tools 권한
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { reclaimReport, vmDetail, reclaimCsv } from '../../guestdisk/service.js';
import { guestDiskDbStatus } from '../../guestdisk/db.js';
import { guestDiskPollerStatus, runGuestDiskNow } from '../../guestdisk/poller.js';
import { load as loadSettings, save as saveSettings } from '../../guestdisk/settings.js';
import { todayStamp } from "../../util/dayKey.js";

export function registerToolsGuestDisk(api) {
  // 회수 목록(VM별 할당/사용/여유/비율) — scope 적용.
  api.get('/tools/guest-disk', requirePerm('tools'), async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const minReclaimGB = req.query.minReclaimGB != null ? Number(req.query.minReclaimGB) : loadSettings().minReclaimGB;
    const maxRatioPct = req.query.maxRatioPct != null && req.query.maxRatioPct !== '' ? Number(req.query.maxRatioPct) : null;
    const vcenterId = req.query.vcenterId ? String(req.query.vcenterId) : null;
    const usageFactor = req.query.usageFactor != null ? Number(req.query.usageFactor) : 1; // v2.482: 회수 = 할당 − 사용×배율(정규화는 service)
    const report = await reclaimReport({ allowed, minReclaimGB: Number.isFinite(minReclaimGB) ? minReclaimGB : 5, maxRatioPct, vcenterId, usageFactor });
    // v2.583: 폴러 상태의 전 vCenter 합계·오류(범위 밖 id)·DB 경로를 범위 계정에 싣지 않는다(auth/scopeStatus.js).
    res.json({ ...report, db: scopeDbStatus(guestDiskDbStatus(), req.user), poller: scopePollerStatus(guestDiskPollerStatus(), allowed), settings: loadSettings() });
  });

  // 한 VM 의 파티션별 최신값 + 추이 — scope 단건 검사(범위 밖은 404 존재 은닉).
  api.get('/tools/guest-disk/vm/:id', requirePerm('tools'), async (req, res) => {
    const days = req.query.days != null ? Number(req.query.days) : 0;
    const usageFactor = req.query.usageFactor != null ? Number(req.query.usageFactor) : 1;
    const detail = await vmDetail(req.params.id, { days: Number.isFinite(days) && days > 0 ? days : 0, usageFactor });
    if (!detail) return res.status(404).json({ error: 'not found' });
    const allowed = scopedVcenterIds(req.user, store.get());
    if (allowed && !allowed.has(detail.vcenterId)) return res.status(404).json({ error: 'not found' });
    res.json(detail);
  });

  // CSV — 회수 목록. scope 적용, 수식 인젝션 가드 + BOM 은 service 에서.
  api.get('/tools/guest-disk/export.csv', requirePerm('tools'), async (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    const minReclaimGB = req.query.minReclaimGB != null ? Number(req.query.minReclaimGB) : loadSettings().minReclaimGB;
    const maxRatioPct = req.query.maxRatioPct != null && req.query.maxRatioPct !== '' ? Number(req.query.maxRatioPct) : null;
    const vcenterId = req.query.vcenterId ? String(req.query.vcenterId) : null;
    const usageFactor = req.query.usageFactor != null ? Number(req.query.usageFactor) : 1;
    const report = await reclaimReport({ allowed, minReclaimGB: Number.isFinite(minReclaimGB) ? minReclaimGB : 5, maxRatioPct, vcenterId, usageFactor });
    const csv = reclaimCsv(report.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="guest-disk-reclaim-${todayStamp()}.csv"`);
    res.send(csv);
  });

  // 상태 — DB/폴러/설정.
  api.get('/tools/guest-disk/status', requirePerm('tools'), (req, res) => {
    const allowed = scopedVcenterIds(req.user, store.get());
    res.json({ db: scopeDbStatus(guestDiskDbStatus(), req.user), poller: scopePollerStatus(guestDiskPollerStatus(), allowed), settings: loadSettings() });
  });

  // 설정 저장(주기·임계·보존) — admin.
  api.put('/tools/guest-disk/settings', requireRole('admin'), (req, res) => {
    const next = saveSettings(req.body || {});
    logAudit({ user: req.user?.username, action: '게스트 디스크 리포트 설정 변경', detail: `enabled=${next.enabled} interval=${next.intervalHours}h`, ip: req.ip || '' });
    res.json({ ok: true, settings: next });
  });

  // 수동 수집 1회 — admin. 재진입 가드 공유(진행 중이면 skipped).
  api.post('/tools/guest-disk/run', requireRole('admin'), async (req, res) => {
    logAudit({ user: req.user?.username, action: '게스트 디스크 수동 수집', ip: req.ip || '' });
    const r = await runGuestDiskNow('manual');
    res.json(r);
  });
}
