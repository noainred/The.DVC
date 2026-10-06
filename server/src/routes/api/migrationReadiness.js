/**
 * routes/api/migrationReadiness.js — 특수 기능 'VM 이전 준비도'(도구 키 `migration-readiness`, v2.707 — C7) API.
 * 판정은 migration/analyze.js(순수) — 스냅샷 VM + B10 구성·장치 캐시. vCenter 왕복 0.
 * 권한: tools + toolGate + vCenter 범위 · CSV data.csv + 감사. 화면은 폴링하지 않는다.
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopeSlice, memoJson, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeMigration } from '../../migration/analyze.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(req, snap) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  return analyzeMigration(scoped.vms, {
    vcName, q: qStr(req.query.q, 128), level: qStr(req.query.level, 16), code: qStr(req.query.code, 32),
    by: req.query.by === 'cluster' ? 'cluster' : 'vcenter',
  });
}

export function registerMigrationReadiness(api) {
  api.get('/tools/migration-readiness', toolsPerm, (req, res) => memoJson(req, res, 'migration-readiness', (snap) => ({
    ...run(req, snap), initial: snap.initial === true, generatedAt: snap.generatedAt || null,
  }), { extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/migration-readiness.csv', csvPerm, toolsPerm, (req, res) => {
    try {
      const r = run(req, store.get());
      const lines = [CSV_BOM + csvLine(['VM', 'vCenter', '클러스터', '전원', 'vCPU', '메모리(MB)', '스토리지(GB)', '하드웨어 버전', '등급', '근거 코드', '구성 읽음', '장치 읽음'])];
      for (const v of r.vms) {
        lines.push(csvLine([v.name, v.vcenterName, v.cluster, v.powerState, v.cpuCount ?? '', v.memMB ?? '', v.storageGB ?? '', v.hwVersion || '', v.level,
          v.findings.map((f) => f.code).join(' '), v.collected.cfg ? 'Y' : '', v.collected.dev ? 'Y' : '']));
      }
      logAudit({ user: req.user?.username, action: 'migration-readiness.csv', target: 'migration-readiness', detail: `${lines.length - 1} rows`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="migration-readiness-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
