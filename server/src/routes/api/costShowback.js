/**
 * routes/api/costShowback.js — 특수 기능 '비용 배분(쇼백)'(도구 키 `cost-showback`, v2.707 — C11) API.
 * 할당량 × 설정 단가(cost-rates.json). 단가가 비면 할당량만. vCenter 왕복 0.
 * 권한: 조회 tools + toolGate + vCenter 범위 · 단가 저장 admin + 전체 범위(전 법인 공통 설정) + 감사 · CSV data.csv + 감사.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopeSlice, memoJson, scopeKey } from './shared.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeCost, tagCategories, GROUP_KINDS } from '../../cost/analyze.js';
import { loadCostSettings, saveCostSettings } from '../../cost/settings.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminOnly = requireRole('admin');
const fleetOnly = fullScopeOnlyWith('비용 단가 저장은 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다 — 단가는 전 법인 공통 설정입니다.');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(req, snap) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const by = GROUP_KINDS.includes(req.query.by) ? req.query.by : 'vcenter';
  const r = analyzeCost(scoped, loadCostSettings(), { by, category: qStr(req.query.category, 128), q: qStr(req.query.q, 128), vcName });
  return { ...r, categories: tagCategories(scoped.vcenters) };
}

export function registerCostShowback(api) {
  api.get('/tools/cost-showback', toolsPerm, (req, res) => memoJson(req, res, 'cost-showback', (snap) => ({
    ...run(req, snap), initial: snap.initial === true, generatedAt: snap.generatedAt || null,
  }), { extraKey: `${scopeKey(req.user, store.get())}|${loadCostSettings().rev}` }));

  api.get('/tools/cost-showback/settings', toolsPerm, (_req, res) => res.json({ ok: true, settings: loadCostSettings() }));

  api.put('/tools/cost-showback/settings', adminOnly, fleetOnly, (req, res) => {
    try {
      const before = loadCostSettings();
      const s = saveCostSettings(req.body || {}, req.user?.username);
      logAudit({ user: req.user?.username, action: 'cost-showback.settings', target: 'cost-rates.json', detail: `rev ${before.rev} → ${s.rev}`, ip: req.ip });
      res.json({ ok: true, settings: s });
    } catch (e) {
      res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });

  api.get('/tools/cost-showback.csv', csvPerm, toolsPerm, (req, res) => {
    try {
      const r = run(req, store.get());
      const n = (x) => (x == null ? '' : String(x));
      const lines = [CSV_BOM + csvLine([`그룹(${r.by})`, 'vCenter', 'VM', '켜진 VM', 'vCPU', '메모리(GB)', '스토리지(GB)', '스토리지 모름', `vCPU 비용(${r.currency})`, `메모리 비용(${r.currency})`, `스토리지 비용(${r.currency})`, `합계(${r.currency})`, '비중(%)'])];
      for (const g of r.groups) lines.push(csvLine([g.label, n(g.vcenterName), g.vms, g.on, g.vcpu, g.ramGB, g.storageGB, g.storageUnknown, n(g.cpu), n(g.ram), n(g.storage), n(g.total), n(g.share)]));
      logAudit({ user: req.user?.username, action: 'cost-showback.csv', target: 'cost-showback', detail: `${lines.length - 1} rows · by ${r.by}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cost-showback-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
