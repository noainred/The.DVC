/**
 * routes/api/clusterCheck.js — 특수 기능 '클러스터 HA·DRS 점검'(도구 키 `cluster-check`, v2.701 — A6) API.
 * 판정은 `clustercfg/analyze.js`(순수) 하나 — 범위로 자른 스냅샷 vCenter·호스트만 넘긴다. vCenter 왕복 0.
 * 권한: 조회 tools + toolGate 매핑('cluster-check') + vCenter 범위(scopeSlice) · CSV data.csv + tools + 범위(감사 로그).
 * `/tools/cluster-check/of` 는 VM·호스트 상세 창이 그 클러스터 하나를 묻는 경로다(범위 밖 vCenter 는 404 — 존재 은닉).
 * 화면은 폴링하지 않는다(마운트 1회 + 새로고침).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';
import { capStr } from '../../util/capStr.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeClusters, clusterOf } from '../../clustercfg/analyze.js';
import { CLUSTER_CFG_CODES } from '../../clustercfg/parse.js';
import { clusterCfgStatus } from '../../clustercfg/collect.js';
import { config } from '../../config.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const qStr = (v, n) => (typeof v === 'string' ? capStr(v.trim(), n) : '');

function run(snap, req) {
  const scoped = scopeSlice(snap, req.user, qStr(req.query.vcenterId, 128) || undefined);
  return analyzeClusters(scoped.vcenters, scoped.hosts, {
    code: qStr(req.query.code, 32) || undefined,
    sev: qStr(req.query.sev, 8) || undefined,
    q: qStr(req.query.q, 128) || undefined,
  });
}

export function registerClusterCheck(api) {
  api.get('/tools/cluster-check', toolsPerm, (req, res) => memoJson(req, res, 'cluster-check', (snap) => {
    const r = run(snap, req);
    // v2.744(감사 AUTHZ-01): 판정은 isAdminDetailUser — 데모 계정(요청 문맥 admin + demoGuest)은 operator 와 같은 판본이고, memo 키도 역할 문자열이 아니라
    //   판정 결과(a/u)로 만든다(역할 문자열이면 데모와 진짜 관리자가 같은 캐시 칸을 써 한쪽 판본이 다른 쪽에 나간다).
    const full = isAdminDetailUser(req.user) && scopeKey(req.user, snap) === 'all';
    return {
      ...r, codes: CLUSTER_CFG_CODES, initial: snap.initial === true, generatedAt: snap.generatedAt || null,
      scan: { enabled: config.clusterCfgScan, refreshMs: config.clusterCfgRefreshMs, perCycle: config.clusterCfgPerCycle },
      // 수집 상태(오류 문구에 vCenter 응답 원문이 들어갈 수 있다) — 전체 범위 관리자에게만.
      status: full ? clusterCfgStatus() : null,
    };
  }, { extraKey: `${scopeKey(req.user, store.get())}|${isAdminDetailUser(req.user) ? 'a' : 'u'}` }));

  api.get('/tools/cluster-check/of', toolsPerm, (req, res) => {
    const snap = store.get();
    const vcenterId = qStr(req.query.vcenterId, 128);
    const cluster = qStr(req.query.cluster, 128);
    const vmId = qStr(req.query.vmId, 256) || null;
    // v2.742(VC-05): 같은 이름 클러스터가 다른 데이터센터에 있을 수 있어 ref 로 고른다 — 클러스터 moref · 호스트 id · VM 의 clusterRef 순서.
    const opt = { clusterRef: qStr(req.query.clusterRef, 64) || null, hostId: qStr(req.query.hostId, 256) || null, vms: snap.vms };
    if (!vcenterId || !cluster) return res.status(400).json({ ok: false, reason: 'vcenterId 와 cluster 가 필요합니다.' });
    const allowed = scopedVcenterIds(req.user, snap);
    if (allowed && !allowed.has(vcenterId)) return res.status(404).json({ ok: false, reason: 'not-found' });
    res.json({ ok: true, ...clusterOf(snap.vcenters, snap.hosts, vcenterId, cluster, vmId, opt), codes: CLUSTER_CFG_CODES });
  });

  api.get('/tools/cluster-check.csv', csvPerm, toolsPerm, (req, res) => {
    const r = run(store.get(), req);
    const yn = (v) => (v === true ? '켜짐' : v === false ? '꺼짐' : '');
    const head = ['vCenter', '클러스터', '데이터센터', '클러스터 ref', '호스트', '구성 읽음', 'HA', '수용 제어', '호스트 모니터링', 'DRS', 'DRS 자동화', 'EVC', '규칙 수', '규칙 위반', '가장 높은 심각도', '판정 코드'];
    const lines = [CSV_BOM + csvLine(head)];
    for (const row of r.rows) {
      lines.push(csvLine([
        row.vcenterName, row.name, row.vcDatacenter ?? '', row.ref ?? '', row.hosts ?? '', row.collected ? '예' : '아니오',
        yn(row.ha?.enabled), yn(row.ha?.admission), row.ha?.hostMon || '', yn(row.drs?.enabled), row.drs?.behavior || '',
        row.evc == null ? '' : row.evc || '꺼짐', row.rulesTotal ?? '',
        row.rules.filter((x) => x.enabled === true && x.inCompliance === false).length, row.sev || '', row.findings.map((f) => f.code).join(' '),
      ]));
    }
    logAudit({ user: req.user?.username, action: 'cluster-check.csv', target: 'cluster-check', detail: `${r.rows.length} rows${r.omitted ? ` (+${r.omitted} omitted)` : ''}`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cluster-check-${fileStamp()}.csv"`);
    if (r.omitted) res.setHeader('X-Omitted-Rows', String(r.omitted));
    res.send(lines.join('\r\n'));
  });
}
