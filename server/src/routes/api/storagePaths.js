/**
 * routes/api/storagePaths.js — 특수 기능 '데이터스토어·경로 점검'(도구 키 `storage-paths`, v2.700 — A2·A17·A19) API.
 * 판정은 `dscfg/analyze.js`(순수) — 범위로 자른 스냅샷만 넘긴다. vCenter 왕복 0.
 * 권한: 조회 tools + toolGate 매핑 + vCenter 범위(scopeSlice) · CSV data.csv + tools + 범위(감사 로그). 화면은 폴링하지 않는다.
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeDatastores, analyzePaths, analyzeVsan, VSAN_CODES } from '../../dscfg/analyze.js';
import { DS_CFG_CODES, DS_OVERCOMMIT_PCT, DS_MANY_VMS } from '../../dscfg/parse.js';
import { config } from '../../config.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(snap, req) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const q = qStr(req.query.q, 128) || undefined;
  return {
    datastores: analyzeDatastores(scoped.datastores, { vcName, q, code: qStr(req.query.code, 32) || undefined }),
    paths: analyzePaths(scoped.hosts, { vcName, q, onlyIssues: req.query.onlyIssues === '1' }),
    vsan: analyzeVsan(scoped.hosts, scoped.datastores, { vcName }),
    vcenters: (scoped.vcenters || []).map((v) => ({ vcenterId: v.id, name: v.name || v.id })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function registerStoragePaths(api) {
  api.get('/tools/storage-paths', toolsPerm, (req, res) => memoJson(req, res, 'storage-paths', (snap) => ({
    ...run(snap, req),
    codes: { ...DS_CFG_CODES, ...VSAN_CODES },
    limits: { overcommitPct: DS_OVERCOMMIT_PCT, manyVms: DS_MANY_VMS },
    scan: { ds: config.dsCfgScan, host: config.hostCfgScan, dsRefreshMs: config.dsCfgRefreshMs, hostRefreshMs: config.hostCfgRefreshMs },
    initial: snap.initial === true, generatedAt: snap.generatedAt || null,
  }), { extraKey: scopeKey(req.user, store.get()) }));

  api.get('/tools/storage-paths.csv', csvPerm, toolsPerm, (req, res) => {
    const r = run(store.get(), req).datastores;
    const head = ['vCenter', '데이터스토어', '유형', '용량GB', '사용GB', '미할당 약정GB', 'VM 수', '가장 높은 심각도', '판정 코드'];
    const lines = [CSV_BOM + csvLine(head)];
    for (const x of r.rows) lines.push(csvLine([x.vcenterName, x.name, x.type, x.capacityGB ?? '', x.usedGB ?? '', x.uncommittedGB ?? '', x.vmCount ?? '', x.sev, x.findings.map((f) => f.code).join(' ')]));
    logAudit({ user: req.user?.username, action: 'storage-paths.csv', target: 'storage-paths', detail: `${r.rows.length} rows`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storage-paths-${fileStamp()}.csv"`);
    if (r.omitted) res.setHeader('X-Omitted-Rows', String(r.omitted));
    res.send(lines.join('\r\n'));
  });
}
