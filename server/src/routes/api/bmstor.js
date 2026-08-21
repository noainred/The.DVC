// 베어메탈 스토리지(v2.340, 사용자 요구) — 서버 SSH(df)로 로컬 디스크 마운트 용량을 주기 수집해
// 서버/그룹/전체 합산(총·사용·가용)을 보여준다. 전부 adminOnly(SSH 자격증명·호스트 구성).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { listBmServers, saveBmServer, removeBmServer, getBmSettings, saveBmSettings } from '../../bmstor/registry.js';
import { getBmLatest, bmCollectNow, bmPollerStatus } from '../../bmstor/poller.js';
import { aggregate } from '../../bmstor/agg.js';
import { listCollectors } from '../../collector/registry.js';

const adminOnly = requireRole('admin');

export function registerBmStorage(api) {
  // 현황 — 서버 목록(비밀 redact) + 최신 수집을 합산(서버/그룹/전체)해 반환. 엣지 콤보용 목록 포함.
  api.get('/tools/bm-storage', adminOnly, (_req, res) => {
    const servers = listBmServers();
    const { total, groups, perServer } = aggregate(servers, getBmLatest());
    res.json({
      ok: true, total, groups, servers: perServer,
      config: servers, // 편집 폼용 원본(마운트 목록 포함, 비밀번호는 hasPassword 만)
      settings: getBmSettings(), status: bmPollerStatus(),
      agents: listCollectors().map((c) => c.id), // 위임 가능한 엣지(수집 서버) 이름 목록
    });
  });

  // 서버 추가/수정 — body { id?, name, host, port, username, password?, agent, group, mounts, enabled }
  api.post('/tools/bm-storage/servers', adminOnly, (req, res) => {
    const r = saveBmServer(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 저장', target: r.server?.host || '', detail: `mounts ${(r.server?.mounts || []).length}개${r.server?.agent ? ` · 엣지 ${r.server.agent}` : ''}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  api.delete('/tools/bm-storage/servers/:id', adminOnly, (req, res) => {
    const r = removeBmServer(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 삭제', target: req.params.id, ip: req.ip || '' });
    res.status(r.ok ? 200 : 404).json(r);
  });

  // 수집 주기 저장(분) — 폴러가 30초 틱마다 설정을 다시 읽으므로 재기동 없이 반영된다.
  api.put('/tools/bm-storage/settings', adminOnly, (req, res) => {
    const r = saveBmSettings(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 주기 변경', target: `${r.settings.intervalMinutes}분`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  // 지금 수집 — 진행 중이면 skipped(재진입 가드 공유, net/monitor.runMonitorNow 패턴).
  api.post('/tools/bm-storage/collect', adminOnly, async (req, res) => {
    const r = await bmCollectNow('manual');
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 수동 수집', detail: `서버 ${r.servers} · 성공 ${r.okCount} · 오류 ${r.errors}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json(r);
  });
}
