/** HAProxy 경로 점검 라우트(v2.429) — 특수기능 'HAProxy 경로 점검'. 조회는 tools 권한, 설정/실행은 admin + 감사. */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { loadSettings, saveSettings, LIMITS, KINDS, DEFAULT_PROFILE } from '../../relaycheck/settings.js';
import { relayCheckStatus, runRelayChecks, buildTargets } from '../../relaycheck/poller.js';
import { loadCollectors } from '../../collector/registry.js';
import { loadTopology } from '../../relaytopo/store.js';
import { relayCheckView } from '../../relaycheck/view.js';   // v2.500(감사 M1): 역할별 축약을 순수 모듈로

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');

export function registerRelayCheck(api) {
api.get('/tools/relaycheck', toolsPerm, (_req, res) => {
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
