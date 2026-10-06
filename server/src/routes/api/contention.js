/**
 * routes/api/contention.js — 특수 기능 'CPU 경합·디스크 지연'(도구 키 `contention`, v2.706 — C2·C3) API.
 * 원천은 스냅샷의 vm.perfc·host.perfc(인벤토리 수집이 실시간 통계 최근 창을 읽어 싣는다) — 요청 경로의 vCenter 왕복 0.
 * 권한: tools + toolGate('contention') + vCenter 범위 · CSV data.csv + 감사 로그. 수집 상태(오류 원문)는 전체 범위 관리자에게만.
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { config } from '../../config.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { memoJson, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeContention } from '../../contention/analyze.js';
import { contentionStatus } from '../../contention/cache.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function scoped(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  const reqVc = qStr(req.query.vcenterId, 128);
  const keep = (x) => (!allowed || allowed.has(x.vcenterId)) && (!reqVc || x.vcenterId === reqVc);
  const vcenters = (snap.vcenters || []).filter((v) => (!allowed || allowed.has(v.id)) && (!reqVc || v.id === reqVc));
  return { vms: (snap.vms || []).filter(keep), hosts: (snap.hosts || []).filter(keep), datastores: (snap.datastores || []).filter(keep), vcenters, full: !allowed };
}

export function registerContention(api) {
  api.get('/tools/contention', toolsPerm, (req, res) => memoJson(req, res, 'contention', async (snap) => {
    const S = scoped(req, snap);
    const vcName = new Map(S.vcenters.map((v) => [v.id, v.name || v.id]));
    const out = analyzeContention(S, { refreshMs: config.contentionRefreshMs, q: qStr(req.query.q, 128), sev: qStr(req.query.sev, 16), vcName });
    const isFullAdmin = S.full && req.user?.role === 'admin';
    const st = contentionStatus();
    const ids = new Set(S.vcenters.map((v) => v.id));
    return {
      ...out,
      scan: { enabled: config.contentionScan, refreshMs: config.contentionRefreshMs, samples: config.contentionSamples, windowSec: config.contentionSamples * 20 },
      // 수집 상태 — 없는 카운터·잘림은 누구에게나(무엇을 못 읽었는지는 판정의 근거다), 오류 원문은 전체 범위 관리자에게만.
      status: st.vcenters.filter((v) => ids.has(v.vcenterId)).map((v) => ({
        vcenterId: v.vcenterId, name: vcName.get(v.vcenterId) || v.vcenterId, vms: v.vms, hosts: v.hosts, at: v.at ?? null,
        missingCounters: Array.isArray(v.missingCounters) ? v.missingCounters : [], cut: v.cut ?? 0, errors: v.errors ?? 0,
        error: isFullAdmin ? (v.error || null) : (v.error ? '(오류 — 관리자 화면에서 확인)' : null),
      })),
      initial: snap.initial === true,
    };
  }, { ttlMs: 30_000, extraKey: `${scopeKey(req.user, store.get())}|${req.user?.role === 'admin' ? 'a' : 'u'}` }));

  api.get('/tools/contention.csv', csvPerm, toolsPerm, (req, res) => {
    try {
      const snap = store.get();
      const S = scoped(req, snap);
      const vcName = new Map(S.vcenters.map((v) => [v.id, v.name || v.id]));
      const out = analyzeContention(S, { refreshMs: config.contentionRefreshMs, sev: qStr(req.query.sev, 16), vcName });
      const fmt = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString() : '');
      const n = (v) => (v == null ? '' : v);
      const lines = [CSV_BOM + csvLine(['vCenter', 'VM', '호스트', '클러스터', 'vCPU', 'Ready %(평균)', 'Ready %(최대)', 'Co-stop %', 'CPU Latency %', '디스크 읽기 ms', '디스크 쓰기 ms', '가장 느린 디스크', '판정', '측정 시각(UTC)'])];
      for (const r of out.vms) lines.push(csvLine([r.vcenterName, r.name, r.host, r.cluster, n(r.cpuCount), n(r.readyAvg), n(r.readyMax), n(r.costopAvg), n(r.latencyAvg), n(r.readAvg), n(r.writeAvg), r.disk || '', r.findings.map((f) => f.code).join(' '), fmt(r.at)]));
      logAudit({ user: req.user?.username, action: 'contention.csv', target: 'contention', detail: `${lines.length - 1} rows${out.omitted ? ` (omitted ${out.omitted})` : ''}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contention-${fileStamp()}.csv"`);
      if (out.omitted) res.setHeader('X-Omitted', String(out.omitted));
      res.send(lines.join('\r\n'));
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) });
    }
  });
}
