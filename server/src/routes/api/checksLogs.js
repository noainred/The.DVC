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
api.get('/tools/network-check', async (_req, res) => {
  try { res.json(await getNetworkCheck()); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 사이트 VMware 솔루션 구성 백업 — 수집 구성 스냅샷. ?vcenterId=로 사이트 한정, ?download=1로 gzip 파일.
api.get('/tools/vmware-config', (req, res) => {
  try {
    const data = buildVmwareConfigExport({ vcenterId: req.query.vcenterId || null });
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
    const rows = db.query(f, 100_000, 0);
    const esc = (v) => `"${guardCell(v).replace(/"/g, '""')}"`; // guardCell: 수식 인젝션 방어(로그 user/entity/message 는 외부 입력)
    const csv = ['time,vcenter,severity,type,user,entity,message',
      ...rows.map((r) => [new Date(r.ts).toISOString(), r.vcenterId, r.severity, r.type, r.user, r.entity, r.message].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vcenter-logs-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv); // BOM(엑셀 한글)
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
}
