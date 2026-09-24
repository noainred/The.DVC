// 일일 리포트(헬스·스냅샷 나이·좀비·인증서·라이트사이징 등) — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { pageArgs } from '../../util/pageArgs.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { requirePerm } from '../../auth/auth.js'; // v2.479(감사 S-4): /tools 조회 tools 권한
import { store } from '../../store.js';
import { config } from '../../config.js';
import { getLogsDb } from '../../logs/db.js';
import { computeHealthReport } from '../../reports/healthReport.js';
import { computeZombies } from '../../reports/zombies.js';
import { computeRightsizing } from '../../reports/rightsizing.js';
import { computeCompliance } from '../../reports/compliance.js';
import { filterChangeEvents, CHANGE_CATEGORIES } from '../../reports/changes.js';
import { computeUnprotected } from '../../reports/unprotected.js';
import { vmStatsFor, vmStatsMeta } from '../../reports/vmStats.js';
import { certStatus } from '../../security/certMonitor.js';
import { dailyReportStatus } from '../../reports/dailyReport.js';
import { forecastCapacity } from '../../insights/forecast.js';
import { alertStatus } from '../../alerts.js';
import { memoJson, scopeSlice, scopeKey } from './shared.js';

// 인증서 목록도 scope 적용 — vCenter 항목은 허용 집합으로 거르고, NSX는 범위 제한 계정에는 숨긴다.
function scopedCerts(user, snap, vcenterId) {
  const c = certStatus();
  const allowed = scopedVcenterIds(user, snap);
  const items = (c.items || []).filter((it) => {
    if (it.kind === 'vcenter') return (!allowed || allowed.has(it.id)) && (!vcenterId || it.id === vcenterId);
    return !allowed && !vcenterId; // nsx: 전체 범위 조회에서만
  });
  return { ...c, items };
}

export function registerReports(api) {

// ① 일일 헬스체크 리포트(vCheck 스타일) — 화면 조회용(발송은 /admin/report/daily).
api.get('/tools/report/health', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-health', (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  return computeHealthReport(scoped, {
    snapshotAgeDays: Number(req.query.snapshotAgeDays) || undefined,
    dsWarnPct: Number(req.query.dsWarnPct) || undefined,
    certs: scopedCerts(req.user, snap, req.query.vcenterId),
  });
}, { extraKey: scopeKey(req.user, store.get()) }));

// ② 스냅샷 나이 감시 — 생성일 기준 오래된 스냅샷(수집 확장으로 snapshotOldestTs 사용 가능).
api.get('/tools/report/snapshot-age', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-snapage', (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  const minAgeDays = Math.max(0, Number(req.query.minAgeDays) || 0);
  const minSizeGB = Math.max(0, Number(req.query.minSizeGB) || 0);
  const now = Date.now();
  const items = scoped.vms.filter((v) => (v.snapshotCount || 0) > 0)
    .map((v) => ({
      id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster,
      powerState: v.powerState, snapshotCount: v.snapshotCount, snapshotSizeGB: v.snapshotSizeGB || 0,
      snapshotNames: v.snapshotNames || [],
      oldestTs: v.snapshotOldestTs || null, newestTs: v.snapshotNewestTs || null,
      ageDays: v.snapshotOldestTs ? Math.floor((now - v.snapshotOldestTs) / 86_400_000) : null,
    }))
    .filter((v) => (minAgeDays ? (v.ageDays ?? -1) >= minAgeDays : true) && v.snapshotSizeGB >= minSizeGB)
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return {
    count: items.length,
    totalSizeGB: Math.round(items.reduce((a, v) => a + v.snapshotSizeGB, 0) * 10) / 10,
    withAge: items.filter((v) => v.ageDays != null).length,
    items: items.slice(0, 1000),
  };
}, { extraKey: scopeKey(req.user, store.get()) }));

// ③ 좀비/방치 리소스(RVTools 스타일).
api.get('/tools/report/zombies', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-zombies', (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  return computeZombies(scoped, { snapshotMinGB: Number(req.query.snapshotMinGB) || undefined, snapshotAgeDays: Number(req.query.snapshotAgeDays) || undefined });
}, { extraKey: scopeKey(req.user, store.get()) }));

// ④ 인증서 만료 감시 — certMonitor 캐시(12시간 주기 + 관리자 새로고침).
api.get('/tools/report/certs', requirePerm('tools'), (req, res) => {
  res.json(scopedCerts(req.user, store.get(), req.query.vcenterId));
});

// ⑤ VM 라이트사이징 — 관측 평균/피크(vmStats 누적) 기반 축소 추천.
api.get('/tools/report/rightsizing', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-rightsizing', (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  return { ...computeRightsizing(scoped.vms, vmStatsFor), stats: vmStatsMeta() };
}, { extraKey: scopeKey(req.user, store.get()), ttlMs: 30_000 }));

// ⑥ 용량 고갈 예측 — 기존 forecastCapacity(선형회귀) 재사용(특수기능 진입점).
/**
 * ⑥ 용량 예측 — v2.503 성능 수정: `forecastCapacity` 는 **데이터스토어 1대당 시계열 조회**를 돈다
 * (`insights/forecast.js fit()`). `node:sqlite` 는 동기 API 뿐이라 DS 1,100대면 그 루프 전체가
 * 이벤트 루프를 잡는다. 형제 라우트는 전부 memoJson 을 쓰는데 이것만 빠져 있었고, 화면은 이
 * 리포트를 60초마다 폴링한다. `/api/insights/forecast` 는 이미 같은 계산을 60초 snapMemo 로
 * 감싸고 있었다 — 같은 계산의 캐시 유무가 라우트마다 갈려 있던 상태다.
 * 캐시 라우트이므로 `extraKey: scopeKey(...)` 는 필수다(빠지면 무제한 계정 결과가 범위 계정에 샌다).
 */
api.get('/tools/report/capacity', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-capacity', async (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  // allowed 를 함께 넘겨 GPU 예측(스냅샷 밖 metrics DB gpu_vc 키)도 범위로 제한(v2.288 확정 버그).
  return forecastCapacity(scoped, { days: Number(req.query.days) || 14, vcenterId: req.query.vcenterId || '', allowed: scopedVcenterIds(req.user, snap) });
}, { ttlMs: 30_000, extraKey: scopeKey(req.user, store.get()) }));

// ⑦ 알림 채널·이력 — 웹훅 URL(시크릿)은 절대 내리지 않는다(설정 여부만).
api.get('/tools/report/alerts', requirePerm('tools'), (req, res) => {
  const st = alertStatus();
  // v2.479(감사 S-3): 범위 제한 계정에는 자기 vCenter 귀속 알림만(귀속 없는 항목은 미노출 — 규약). 전체 범위는 그대로.
  const allowed = scopedVcenterIds(req.user, store.get());
  const slice = (arr) => (allowed ? (arr || []).filter((a) => a && a.vcenterId && allowed.has(a.vcenterId)) : arr);
  const ch = st.config?.channels || {};
  const chan = (c) => ({ enabled: !!c?.enabled, configured: !!c?.url });
  res.json({
    channels: { slack: chan(ch.slack), webhook: chan(ch.webhook), teams: chan(ch.teams) },
    cooldownMin: st.config?.cooldownMin, suppressWindowMin: st.config?.suppressWindowMin,
    engineOn: st.engineOn, firing: slice(st.firing), recent: slice(st.recent),
    daily: (() => { const d = dailyReportStatus(); return { enabled: d.enabled, hour: d.hour, minute: d.minute, lastRunTs: d.lastRunTs }; })(),
  });
});

// ⑧ 버전/패치 준수 리포트.
api.get('/tools/report/compliance', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-compliance', (snap) => {
  const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
  return computeCompliance(scoped);
}, { extraKey: scopeKey(req.user, store.get()) }));

// ⑨ 구성 변경 이력 — vcenter-logs.db에서 변경성 이벤트만. SQL 선필터(기간/vCenter/검색어) 후
// JS 정규식 분류. 창 내 최대 2만 행 스캔(스캔 상한·잘림 여부를 응답에 명시).
api.get('/tools/report/changes', requirePerm('tools'), async (req, res) => {
  try {
    const db = await getLogsDb();
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const vcParam = req.query.vcenterId || '';
    if (vcParam && allowed && !allowed.has(vcParam)) return res.json({ total: 0, rows: [], categories: CHANGE_CATEGORIES });
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const f = { vcenterId: vcParam, q: req.query.q || '', since: Date.now() - days * 86_400_000 };
    // scope 는 SQL 로 밀어넣는다(post-filter 금지) — 그래야 scanned/truncated 가 in-scope 스캔 기준으로
    // 정확해진다. 과거엔 post-filter라 raw가 20k에 걸려도 필터 후 truncated=false 로 조용히 오보됐고,
    // 범위 밖 vCenter가 최신 20k 창을 채우면 scope 계정이 빈 보고를 받았다(감사 지적).
    if (allowed) f.vcenterIds = vcParam ? [vcParam] : [...allowed];
    const SCAN_MAX = 20_000;
    const rows = db.query(f, SCAN_MAX, 0);
    const changes = filterChangeEvents(rows, { category: req.query.category || '', user: req.query.user || '', entity: req.query.entity || '' });
    const { limit, offset } = pageArgs(req.query, { def: 300, max: 1000 });   // v2.594: limit=-1 → slice(o, o-1) 전량이었다
    res.json({
      total: changes.length, scanned: rows.length, truncated: rows.length >= SCAN_MAX,
      days, categories: CHANGE_CATEGORIES,
      rows: changes.slice(offset, offset + limit),
    });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// ⑩ 미보호 VM(백업 공백) — 백업 계정 패턴의 스냅샷 이벤트가 관측되지 않은 가동 VM.
// v2.503 성능: 이 라우트는 로그 DB 에서 **2만 행을 동기로** 읽어 VM 전량과 대조하는데 memo 가
// 없었다(형제 리포트는 전부 memoJson). 화면은 60초마다 폴링한다 — 사용자 수만큼 그대로 반복됐다.
api.get('/tools/report/unprotected', requirePerm('tools'), (req, res) => memoJson(req, res, 'report-unprotected', async (snap) => {
  const db = await getLogsDb();
  {
    const scoped = scopeSlice(snap, req.user, req.query.vcenterId);
    const lookbackDays = Math.min(90, Math.max(1, Number(req.query.lookbackDays) || 7));
    const patterns = String(req.query.patterns || ''); // v2.606 SEC2606-02: computeUnprotected 가 최대 32개·64자로 자르고 버린 개수를 config.patternsOmitted 로 밝힌다
    // 'Snapshot' 선필터(type LIKE)로 창 내 스냅샷 이벤트만 가져온다. scope 는 post-filter 대신 SQL 로
    // 밀어넣어, 범위 밖 vCenter 스냅샷이 20k 창을 밀어내 in-scope VM 이 '미보호'로 오탐되지 않게 한다.
    const vcParam = req.query.vcenterId || '';
    const allowed = scopedVcenterIds(req.user, snap);
    const lf = { vcenterId: vcParam, q: 'Snapshot', since: Date.now() - lookbackDays * 86_400_000 };
    if (allowed) lf.vcenterIds = vcParam ? (allowed.has(vcParam) ? [vcParam] : []) : [...allowed];
    const ROW_LIMIT = 20_000;
    const rows = db.query(lf, ROW_LIMIT, 0);
    return computeUnprotected(scoped.vms, rows, { patterns, lookbackDays, rowLimit: ROW_LIMIT });
  }
}, { ttlMs: 30_000, extraKey: scopeKey(req.user, store.get()) }));
}
