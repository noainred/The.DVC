/**
 * routes/api/hostHygiene.js — 특수 기능 'ESXi 호스트 구성 점검'(도구 키 `host-hygiene`, v2.699) API.
 * 판정은 `hostcfg/analyze.js`(순수) 하나 — 범위로 자른 스냅샷 호스트만 넘긴다. vCenter 왕복 0.
 * 권한: 조회 tools + toolGate 매핑('host-hygiene') + vCenter 범위(scopeSlice) · CSV data.csv + tools + 범위(감사 로그).
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeHostCfg } from '../../hostcfg/analyze.js';
import { HOST_CFG_CODES } from '../../hostcfg/parse.js';
import { hostCfgStatus } from '../../hostcfg/cache.js';
import { config } from '../../config.js';
import { analyzeReboots } from '../../hostcfg/reboots.js';
import { HOSTOPS_TYPES } from '../../vmchanges/eventDetail.js';
import { getLogsDb } from '../../logs/db.js';
import { loadLogSettings } from '../../logs/settings.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(snap, req) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
  return analyzeHostCfg(scoped.hosts, {
    vcName,
    code: qStr(req.query.code, 32) || undefined,
    sev: qStr(req.query.sev, 8) || undefined,
    q: qStr(req.query.q, 128) || undefined,
  });
}

export function registerHostHygiene(api) {
  api.get('/tools/host-hygiene', toolsPerm, (req, res) => memoJson(req, res, 'host-hygiene', (snap) => {
    const r = run(snap, req);
    const full = req.user?.role === 'admin' && scopeKey(req.user, snap) === 'all';
    return {
      ...r, codes: HOST_CFG_CODES, initial: snap.initial === true, generatedAt: snap.generatedAt || null,
      scan: { enabled: config.hostCfgScan, refreshMs: config.hostCfgRefreshMs, perCycle: config.hostCfgPerCycle },
      // 수집 상태(오류 문구에 vCenter 응답 원문이 들어갈 수 있다) — 전체 범위 관리자에게만.
      status: full ? hostCfgStatus() : null,
    };
  }, { extraKey: `${scopeKey(req.user, store.get())}|${req.user?.role || ''}` }));

  // v2.706(C4): 최근 재부팅 — bootTime(스냅샷) + 유지보수 모드·연결 끊김 이벤트(logs DB). vCenter 왕복 0.
  api.get('/tools/host-hygiene/reboots', toolsPerm, (req, res) => memoJson(req, res, 'host-hygiene-reboots', async (snap) => {
    const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
    const vcName = new Map((scoped.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const days = Math.min(90, Math.max(1, Math.trunc(Number(req.query.days)) || 30));
    const ids = (scoped.vcenters || []).map((v) => v.id);
    const db = await getLogsDb();
    const since = Date.now() - days * 86_400_000 - 86_400_000;
    // v2.719(감사 S1-04): 시간 조각 + 양보로 읽는다.
    const events = ids.length ? await db.opsEventsAsync({ vcenterIds: ids, since, types: [...HOSTOPS_TYPES] }, 20_000) : [];
    const cov = new Map(ids.map((id) => [id, { firstTs: db.firstTs(id) || null, lastTs: db.lastTs(id) || null }]));
    const s = loadLogSettings();
    return {
      ...analyzeReboots(scoped.hosts, events, { days, vcName, coverageOf: (id) => cov.get(id) || null }),
      logs: { enabled: s.enabled, retentionDays: s.retentionDays },
      initial: snap.initial === true,
    };
  }, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}` }));

  api.get('/tools/host-hygiene.csv', csvPerm, toolsPerm, (req, res) => {
    const r = run(store.get(), req);
    const head = ['vCenter', '호스트', '클러스터', '버전', '빌드', '가장 높은 심각도', '판정 코드', '드리프트 항목'];
    const lines = [CSV_BOM + csvLine(head)];
    for (const row of r.rows) {
      const drift = row.findings.filter((f) => f.code === 'drift').map((f) => `${f.facts.field}=${f.facts.value}`).join(' / ');
      lines.push(csvLine([row.vcenterName, row.name, row.cluster, row.version, row.build, row.sev, [...new Set(row.findings.map((f) => f.code))].join(' '), drift]));
    }
    logAudit({ user: req.user?.username, action: 'host-hygiene.csv', target: 'host-hygiene', detail: `${r.rows.length} rows${r.omitted ? ` (+${r.omitted} omitted)` : ''}`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="host-hygiene-${fileStamp()}.csv"`);
    if (r.omitted) res.setHeader('X-Omitted-Rows', String(r.omitted));
    res.send(lines.join('\r\n'));
  });
}
