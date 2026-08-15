// 스토리지 모니터링 라우트(v2.302) — 특수기능 '스토리지 모니터링(Isilon 등)' 화면용.
// 조회: 전체 범위 계정만(스토리지는 vCenter 귀속이 없는 인프라 장비 — 'vCenter 귀속 없는
// 데이터는 범위 계정에 노출 금지' 규칙, fleet 과 동일 403 패턴). 변경: adminOnly + 감사로그.
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { STORAGE_TYPES } from '../../storage/types.js';
import { listDevices, saveDevice, deleteDevice } from '../../storage/registry.js';
import { localSnapshots, dropSnapshot } from '../../storage/store.js';
import { collectDeviceNow, storagePollerStatus } from '../../storage/poller.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { listDatacenters } from '../../datacenter/store.js';
import { listAgentTokens } from '../../central/agentTokens.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '스토리지 모니터링은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

export function registerStorageMon(api) {

/**
 * 통합 조회 — 이 노드(중앙) 직접 수집분 + 전 엣지 push 분을 합쳐 장비별 최신 스냅샷을 반환.
 * 같은 deviceId 가 양쪽에 있으면 최신 collectedAt 우선. 법인/타입별 뷰는 프론트가 이 평탄
 * 목록을 그룹핑한다(뷰 추가가 서버 변경 없이 가능 — 확장 요구 반영).
 */
api.get('/tools/storage', fullScopeOnly, (_req, res) => {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgeStorageSnapshots()]) {
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const devices = listDevices().map((d) => ({ ...d, snap: byId.get(d.id) || null }));
  // 등록부에 없는데 스냅샷만 있는 항목(엣지 잔존 push 등)도 정직하게 노출(orphan 표기).
  const known = new Set(devices.map((d) => d.id));
  const orphans = [...byId.values()].filter((s) => !known.has(s.deviceId));
  res.json({
    devices, orphans,
    types: STORAGE_TYPES,
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    agents: (() => { try { return listAgentTokens().map((t) => t.agent); } catch { return []; } })(),
    poller: storagePollerStatus(),
  });
});

api.post('/tools/storage/devices', adminOnly, (req, res) => {
  try {
    const d = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: '스토리지 장비 저장', target: `${d.type}/${d.name}`, detail: `${d.host} · 수집=${d.agent || '중앙'}` });
    res.status(201).json({ ok: true, device: d });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/storage/devices/:id', adminOnly, (req, res) => {
  if (!deleteDevice(req.params.id)) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
  dropSnapshot(req.params.id); // 지운 장비의 낡은 스냅샷이 화면에 유령으로 남지 않게
  logAudit({ user: req.user?.username, action: '스토리지 장비 삭제', target: req.params.id });
  res.json({ ok: true });
});

/** 지금 수집(연결 테스트 겸) — 중앙 수집 장비만 즉시 가능. 엣지 몫은 다음 pull/폴링 주기 안내. */
api.post('/tools/storage/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
    if ((dev.agent || '').trim()) return res.status(202).json({ ok: false, reason: `이 장비는 엣지 '${dev.agent}' 가 수집합니다 — 엣지 pull(≤5분)·수집(≤10분) 주기 후 반영됩니다.` });
    await collectDeviceNow(req.params.id);
    logAudit({ user: req.user?.username, action: '스토리지 즉시 수집', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

}
