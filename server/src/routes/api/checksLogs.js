// 심층검색·서비스/네트워크 점검·vCenter 로그 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { guardCell } from '../../util/csv.js';
import { store } from '../../store.js';
import { config, loadVcenterConfig } from '../../config.js';
import { scanResultList, getIpHistoryMap } from '../../ipam/scanStore.js';
import { snapshotFilter, slimVm, filterScanResults } from '../../search/deepSearch.js';
import { getServiceCheck } from '../../health/services.js';
import { getNetworkCheck } from '../../health/network.js';
import { buildVmwareConfigExport } from '../../backup/vmwareExport.js';
import { getLogsDb } from '../../logs/db.js';
import { enqueueLogQuery, getLogQueryResult } from '../../central/logQueries.js';
import { listInventory } from '../../central/inventory.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import zlib from 'node:zlib';


// vClogs scope: 사용자 scope 를 f.vcenterIds 화이트리스트로 강제하고, meta 도 범위 내 vCenter 만 남긴다.
// null(무제한)이면 그대로. 반환값=allowed(Set|null) — meta 필터에 재사용.
function scopeLogFilter(req, f) {
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return null; // 무제한
  const req1 = f.vcenterId ? String(f.vcenterId) : '';
  f.vcenterIds = req1 ? (allowed.has(req1) ? [req1] : []) : [...allowed];
  return allowed;
}
function scopeLogMeta(meta, allowed) {
  if (!allowed || !meta) return meta;
  const vcs = (meta.vcenters || []).filter((v) => allowed.has(v.vcenterId));
  const count = vcs.reduce((a, v) => a + (v.count || 0), 0);
  return { ...meta, count, vcenters: vcs }; // 범위 밖 vCenter 존재/건수 미노출
}

export function registerChecksLogs(api) {

// 심층 검색(스냅샷 1차) — 다조건 + 범위(전체/특정/복수 vCenter). Body: { vcenterIds[], filters{} }.
api.post('/tools/deep-search', (req, res) => {
  const b = req.body || {};
  const f = b.filters || {};
  const snap = store.get();
  // 사용자 scope 를 요청 vcenterIds 와 교집합 강제 — 빈배열=전체 우회를 막는다.
  //  · 무제한(allowed=null): 요청값 그대로(빈=전체, 기존 동작).
  //  · 제한: 요청이 있으면 allowed 와 교집합, 없으면 allowed 전체. 교집합이 공집합이면 즉시 빈 결과.
  const allowed = scopedVcenterIds(req.user, snap);
  const reqIds = Array.isArray(b.vcenterIds) ? b.vcenterIds : [];
  const effIds = allowed ? (reqIds.length ? reqIds.filter((id) => allowed.has(id)) : [...allowed]) : reqIds;
  if (allowed && effIds.length === 0) return res.json({ total: 0, items: [], scanTotal: 0, scanItems: [] });
  const vms = snapshotFilter(snap, { vcenterIds: effIds, f });
  // 옵션: IP 스캔으로 발견된(=vCenter가 모르는) 항목도 함께 검색. IP/서브넷/검색어 조건이 있을 때만.
  // 스캔 발견물은 vCenter 귀속(vcenterId)이 없어 scope 로 거를 수 없다 → 범위 제한 계정에는 노출하지 않는다.
  let scanItems = [];
  if (!allowed && (f.includeScan || b.includeScan)) {
    try { scanItems = filterScanResults(scanResultList(), f, getIpHistoryMap()).slice(0, 2000); } catch { scanItems = []; }
  }
  res.json({ total: vms.length, items: vms.slice(0, 2000).map(slimVm), scanTotal: scanItems.length, scanItems });
});

// 다빈치 서비스 점검 — 포탈 내부 서비스/수집기 상태 통합.
api.get('/tools/service-check', (_req, res) => {
  try { res.json(getServiceCheck()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 글로벌 네트워크 점검 — 제어플레인(vCenter/NSX) 도달성·RTT + 네트워크 객체 요약.
// v2.322 보안 감사: 범위 제한 계정은 허용 vCenter·귀속 NSX 매니저만(범위 밖 host/이름/region/RTT 차단).
api.get('/tools/network-check', async (req, res) => {
  try { res.json(await getNetworkCheck(scopedVcenterIds(req.user, store.get()))); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 사이트 VMware 솔루션 구성 백업 — 수집 구성 스냅샷. ?vcenterId=로 사이트 한정, ?download=1로 gzip 파일.
// v2.322 보안 감사(HIGH): 범위 제한 계정은 허용 vCenter(및 귀속 NSX 매니저)로만 — 과거 이 라우트만
// scope 를 안 걸어 범위 밖 전 함대 ESXi 관리 IP·전 VM IP/메모·NSX DFW 규칙이 gzip 으로 새었다.
api.get('/tools/vmware-config', (req, res) => {
  try {
    const allowed = scopedVcenterIds(req.user, store.get());
    const reqVc = req.query.vcenterId ? String(req.query.vcenterId) : null;
    // 범위 밖 vCenter 를 명시 요청하면 존재를 흘리지 않게 404(형제 vclogs/federate 패턴).
    if (reqVc && allowed && !allowed.has(reqVc)) return res.status(404).json({ error: 'not found' });
    const data = buildVmwareConfigExport({ vcenterId: reqVc, allowed });
    if (req.query.download === '1') {
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data, null, 2)));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fn = `vmware-config-${data.meta.scope}-${stamp}.json.gz`;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
      return res.end(gz);
    }
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 로그 출처 — 이 포탈 로컬 보관(local) vs 엣지 보관(remote, 연합 조회 필요).
api.get('/tools/vclogs/sources', (_req, res) => {
  const localIds = new Set((loadVcenterConfig().vcenters || []).map((v) => v.id));
  const vcAgent = new Map();
  for (const inv of listInventory()) if (inv.agent) vcAgent.set(inv.vcenterId, inv.agent);
  for (const a of getAllGpuGuestDiag()) { if (!a.agent) continue; for (const vc of a.vcenters || []) if (vc.vcId) vcAgent.set(vc.vcId, a.agent); }
  const remote = [];
  for (const [vcenterId, agent] of vcAgent) if (!localIds.has(vcenterId)) remote.push({ vcenterId, agent });
  res.json({ local: [...localIds], remote });
});

// 엣지 로그 연합 조회 — 요청 큐잉(POST) / 결과 폴링(GET ?reqId=).
api.post('/tools/vclogs/federate', (req, res) => {
  const b = req.body || {};
  const vcenterId = String(b.vcenterId || '').trim();
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  // scope 강제: 범위 밖 vCenter 의 엣지 로그 연합 조회를 큐잉할 수 없다(범위 밖은 존재도 숨겨 404).
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter를 찾을 수 없습니다.' });
  const filter = { vcenterId, severity: b.severity || '', q: b.q || '', since: Number(b.since) || 0, until: Number(b.until) || 0, limit: Math.min(500, Number(b.limit) || 200) };
  res.json({ ok: true, reqId: enqueueLogQuery(vcenterId, filter) });
});
api.get('/tools/vclogs/federate', (req, res) => {
  const reqId = String(req.query.reqId || '');
  if (!reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  res.json({ ok: true, ...getLogQueryResult(reqId) });
});
// vCenter 장기 보관 로그 조회 — 필터: vcenterId·severity·q·since·until + 페이징.
api.get('/tools/vclogs', async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    const allowed = scopeLogFilter(req, f); // 사용자 scope 화이트리스트를 f.vcenterIds 로 강제(범위 밖 로그 열람 차단)
    const limit = Math.min(1000, Number(req.query.limit) || 200);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ total: db.count(f), rows: db.query(f, limit, offset), meta: scopeLogMeta(db.meta(), allowed), dbKind: db.kind });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
api.get('/tools/vclogs/export.csv', async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    scopeLogFilter(req, f); // scope 화이트리스트 강제(범위 밖 로그 CSV 유출 차단)
    const esc = (v) => `"${guardCell(v).replace(/"/g, '""')}"`; // guardCell: 수식 인젝션 방어(로그 user/entity/message 는 외부 입력)
    // 과거: 10만 행 1회 조회 + 전체 join → 수십 MB 문자열을 만드는 동안 이벤트 루프 정지.
    // gpuSeriesExport 패턴: 청크 조회 + res.write 스트리밍 + 청크 사이 setImmediate 양보 +
    // 행 상한(초과 시 잘림을 CSV 안에 명시 — 잘린 결과를 완전한 것처럼 주지 않는다).
    const MAX = Math.max(1000, Number(process.env.VCLOGS_EXPORT_MAX_ROWS) || 100_000);
    const CHUNK = 20_000;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vcenter-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write('﻿time,vcenter,severity,type,user,entity,message\n'); // BOM(엑셀 한글)
    let offset = 0;
    for (;;) {
      if (res.destroyed) return; // 클라이언트 중단 시 즉시 종료(불필요한 조회 방지)
      const take = Math.min(CHUNK, MAX - offset);
      if (take <= 0) { res.write(`"(행 상한 ${MAX.toLocaleString()}건에서 잘렸습니다 — 기간을 좁혀 다시 내보내세요)"\n`); break; }
      const rows = db.query(f, take, offset);
      if (rows.length) {
        const ok = res.write(rows.map((r) => [new Date(r.ts).toISOString(), r.vcenterId, r.severity, r.type, r.user, r.entity, r.message].map(esc).join(',')).join('\n') + '\n');
        if (!ok) await new Promise((resolve) => res.once('drain', resolve)); // 소켓 백프레셔(느린 클라이언트에 수십 MB 버퍼링 방지)
      }
      offset += rows.length;
      if (rows.length < take) break;
      await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보(다른 사용자 요청 처리)
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, reason: e.message });
    else try { res.destroy(e); } catch { /* 이미 종료 */ }
  }
});
}
