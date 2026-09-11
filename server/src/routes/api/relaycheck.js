/** HAProxy 경로 점검 라우트(v2.429) — 특수기능 'HAProxy 경로 점검'. 조회는 tools 권한, 설정/실행은 admin + 감사. */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { loadSettings, saveSettings, LIMITS, KINDS, DEFAULT_PROFILE } from '../../relaycheck/settings.js';
import { relayCheckStatus, runRelayChecks, buildTargets } from '../../relaycheck/poller.js';
import { loadCollectors } from '../../collector/registry.js';
import { loadTopology } from '../../relaytopo/store.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');

export function registerRelayCheck(api) {
api.get('/tools/relaycheck', toolsPerm, (_req, res) => {
  const st = relayCheckStatus();
  // v2.478(감사 S9): operator(tools 권한)에게 전 사이트 중계 엣지 IP·포트가 노출되던 것을 admin 전용으로 —
  // 비-admin 은 라벨·사이트·종류만 받는다(relaytopo stripCfg 와 같은 '거부 기본값' 규칙).
  const isAdmin = _req.user?.role === 'admin';
  const targets = buildTargets(st.settings, loadCollectors(), loadTopology()).map((t) => ({ key: t.key, host: isAdmin ? t.host : '', port: isAdmin ? t.port : null, kind: t.kind, label: t.label, site: t.site, collectorId: t.collectorId, expectAgent: t.expectAgent || '' }));
  res.json({ ok: true, ...st, targets, limits: LIMITS, defaultProfile: DEFAULT_PROFILE, kinds: KINDS });
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
