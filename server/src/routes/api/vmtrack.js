// VM 수량 추이(v2.345, 사용자 요구) — vCenter별 매일 00/12시 스냅샷을 전용 DB(vm-track.db)로
// 추적하고 차트·표로 보여준다. 증감 숫자를 누르면 그 슬롯에 생성/삭제된 VM 과 위치
// (클러스터·호스트·데이터스토어)를 조회한다.
//
// 권한: 조회는 requirePerm('tools') + **사용자 데이터 범위(scope) 강제**(CLAUDE.md 보안 불변조건 —
// 범위 제한 계정이 전 사이트 수량·VM 목록을 보지 못하게). 수동 스냅샷은 상태 변경이라 admin.
import { requirePerm, requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { vmtrackSeries, vmtrackChanges, vmtrackInfo } from '../../vmtrack/service.js';
import { runVmtrackNow, vmtrackPollerStatus } from '../../vmtrack/poller.js';
import { getDb } from '../../vmtrack/db.js';

export function registerVmTrack(api) {
  // 차트 데이터 + 상태. ?days=30&vcenterId=<특정 vCenter|빈값=전체>
  api.get('/tools/vm-track', requirePerm('tools'), async (req, res) => {
    try {
      await getDb(); // 최초 요청 시 DB 준비(상태 available 반영)
      const snap = store.get();
      const allowed = scopedVcenterIds(req.user, snap); // null = 전체 허용
      const vcenterId = String(req.query.vcenterId || '').trim();
      const days = Number(req.query.days) || 30;
      const [series, info] = await Promise.all([
        vmtrackSeries({ days, vcenterId, scopeIds: allowed }),
        vmtrackInfo(),
      ]);
      // 화면 콤보용 vCenter 목록(스냅샷 기준 — 아직 추적 이력이 없는 vCenter 도 선택 가능).
      const vcenters = (snap.vcenters || [])
        .filter((vc) => !allowed || allowed.has(vc.id))
        .map((vc) => ({ id: vc.id, name: vc.name || vc.id }));
      res.json({ ok: true, ...series, vcenterList: vcenters, ...info, poller: vmtrackPollerStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  // 증감 상세 — ?snapId=<vCenter 스냅샷 id> 또는 ?slot=YYYY-MM-DDT00(그 시각 전체)
  api.get('/tools/vm-track/changes', requirePerm('tools'), async (req, res) => {
    try {
      const allowed = scopedVcenterIds(req.user, store.get());
      const snapId = req.query.snapId ? Number(req.query.snapId) : null;
      const slot = req.query.slot ? String(req.query.slot) : null;
      if (snapId == null && !slot) return res.status(400).json({ ok: false, reason: 'snapId 또는 slot 이 필요합니다.' });
      const items = await vmtrackChanges({ snapId, slot, scopeIds: allowed });
      res.json({ ok: true, items, total: items.length });
    } catch (e) {
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  // 지금 스냅샷(관리자) — 폴러와 재진입 가드를 공유한다(진행 중이면 409).
  api.post('/tools/vm-track/snapshot', requireRole('admin'), async (req, res) => {
    try {
      await getDb();
      const r = await runVmtrackNow('manual');
      if (r.ok) logAudit({ user: req.user?.username, action: 'VM 수량 스냅샷(수동)', detail: `${r.slot} · vCenter ${r.vcenters} · 총 ${r.total} (+${r.added}/-${r.removed})`, ip: req.ip || '' });
      res.status(r.ok ? 200 : (r.skipped ? 409 : 400)).json(r);
    } catch (e) {
      res.status(500).json({ ok: false, reason: e.message });
    }
  });
}
