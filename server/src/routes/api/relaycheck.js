/** HAProxy 경로 점검 라우트(v2.429) — 특수기능 'HAProxy 경로 점검'. 조회는 tools 권한, 설정/실행은 admin + 감사. */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { loadSettings, saveSettings, LIMITS, KINDS, DEFAULT_PROFILE } from '../../relaycheck/settings.js';
import { relayCheckStatus, runRelayChecks, buildTargets } from '../../relaycheck/poller.js';
import { loadCollectors } from '../../collector/registry.js';
import { loadTopology } from '../../relaytopo/store.js';
import { relayCheckView } from '../../relaycheck/view.js';   // v2.500(감사 M1): 역할별 축약을 순수 모듈로
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');

export function registerRelayCheck(api) {
api.get('/tools/relaycheck', toolsPerm, (_req, res) => {
  // v2.600 AUTHZ-2600-07: 점검 대상은 **엣지 사이트**라 vCenter 귀속이 없다 — 범위 제한 계정에는
  // 나눌 축이 없으므로 403(v2.525 규약 · 형제 엣지 화면 edge-log·link-check 와 같은 기준).
  // 역할별 주소 가림(v2.500 D/M1)은 전체 범위 operator 용으로 그대로 둔다. admin 은 설정 소유라 제외.
  if (_req.user?.role !== 'admin' && scopedVcenterIds(_req.user, store.get())) {
    return res.status(403).json({ ok: false, error: 'forbidden', requiredOwner: true,
      reason: 'HAProxy 경로 점검은 엣지 사이트 단위라 법인 범위로 나눌 수 없어 전체 범위 계정만 볼 수 있습니다.' });
  }
  const st = relayCheckStatus();
  // v2.478(감사 S9)은 targets[].host/port 만 가렸는데 `...st` 스프레드로 settings.hosts·
  // results[].target.host/port 가 그대로 나가고, key("host:port")로 복원까지 됐다(v2.500 감사 M1).
  // 축약은 relaycheck/view.js 가 한 곳에서 한다 — 여기서 필드를 다시 펼치지 말 것.
  const isAdmin = _req.user?.role === 'admin';
  const targets = buildTargets(st.settings, loadCollectors(), loadTopology())
    .map((t) => ({ key: t.key, host: t.host, port: t.port, kind: t.kind, label: t.label, site: t.site, collectorId: t.collectorId, expectAgent: t.expectAgent || '' }));
  res.json({ ok: true, ...relayCheckView(st, targets, isAdmin), limits: LIMITS, defaultProfile: DEFAULT_PROFILE, kinds: KINDS });
});
api.put('/tools/relaycheck/settings', adminOnly, (req, res) => {
  try {
    const saved = saveSettings(req.body || {});
    logAudit({ user: req.user?.username, action: 'HAProxy 경로 점검 설정 변경', detail: `enabled=${saved.enabled} interval=${Math.round(saved.intervalMs / 1000)}s profile=${saved.profile.map((p) => `${p.port}:${p.kind}`).join(',')} hosts=${saved.hosts.length}`, ip: req.ip });
    res.json({ ok: true, settings: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});
api.post('/tools/relaycheck/run', adminOnly, async (req, res) => {
  logAudit({ user: req.user?.username, action: 'HAProxy 경로 즉시 점검', ip: req.ip });
  res.json(await runRelayChecks({ force: true }));
});
}
