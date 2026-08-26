// IPAM 조회/쓰기 + VM 전체 export — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds, writeScopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { guardCell } from '../../util/csv.js';
import { store } from '../../store.js';
import { loadVcenterConfig } from '../../config.js';
import { buildVmExport, vmExportCsv } from '../../vcenter/vmExport.js';
import { buildIpamRows, buildSubnetSheets, listSubnets, ipVcenterOwners } from '../../ipam/ledger.js';
import { buildIpamInsights } from '../../ipam/insights.js';
import { buildNetmap } from '../../ipam/netmap.js';
import { listVcRanges } from '../../ipam/rangeStore.js';
import { vcRangesToCsv } from '../../ipam/vcRangesCsv.js';
import { rangeSize } from '../../ipam/scan.js';
import { getAnnotation, setAnnotation } from '../../ipam/annotations.js';
import { getOverride, setOverride, clearOverride, setOverrideBatch, overridesSummary, STATUSES, DEVICE_TYPES } from '../../ipam/overrides.js';
import { getPolicies, getPolicy, setPolicy, deletePolicy, policiesSummary, findPolicy, specToRange, POLICY_STATUSES } from '../../ipam/rangePolicies.js';
import { ipToNum } from '../../ipam/ledger.js';
import { logAudit } from '../../audit.js';
import { getIpHistory, scanResultList, getIpHistoryMap } from '../../ipam/scanStore.js';
import { buildWorkbook } from '../../ipam/excel.js';


// VM 전체 정보 export (특수 기능) — 선택 vCenter 의 모든 VM 을 '획득 가능한 최대 필드'로.
// vCenter 단위 사용자 scope 를 먼저 강제하고, 범위 밖은 404(존재 여부 미노출 — v2.207 규칙).
function vmExportGuard(req, res) {
  const vcenterId = String(req.query.vcenterId || '');
  const snap = store.get();
  if (!vcenterId || !(snap.vcenters || []).some((v) => v.id === vcenterId) || !inUserScope(req.user, snap, vcenterId)) {
    res.status(404).json({ error: 'vCenter를 찾을 수 없습니다.' });
    return null;
  }
  return vcenterId;
}
// vCenter 귀속 값 검증 — 알 수 없는 vCenter id를 붙이면 거부(오타·고아 참조 방지). 빈값=전역=허용.
// 설정 읽기 실패 시엔 막지 않는다(fail-open).
const isKnownVcenter = (id) => { if (!id) return true; try { return (loadVcenterConfig().vcenters || []).some((v) => v.id === id); } catch { return true; } };
/**
 * IPAM 쓰기(override/정책)의 사용자 scope 판정 — 범위 제한 계정이 범위 밖 IP·vCenter 에 쓰지 못하게.
 *  · allowed=null(무제한/admin): 항상 허용(기존 동작 완전 보존).
 *  · IP 가 vCenter 에 귀속(owners): 그 vCenter 중 하나라도 allowed 면 허용.
 *  · 미귀속 IP(스캔/예약): claimedVcenterId 가 있고 allowed 에 있을 때만 허용(전역 예약은 범위 계정이 못 만듦).
 */
const ipInWriteScope = (allowed, owners, ip, claimed) => {
  if (!allowed) return true;
  const own = owners.get(ip);
  if (own && own.size) return [...own].some((v) => allowed.has(v));
  return claimed ? allowed.has(claimed) : false;
};
/**
 * 쓰기 라우트 전용 2차 검사(v2.369) — 조회 범위(기존 404 은닉 검사) 통과 후, 쓰기 범위
 * (writeVcenters ∩ 조회)로 다시 판정한다. 조회는 되지만 수정이 막힌 vCenter 는 존재가 이미
 * 보이므로 404 가 아니라 403. writeVcenters 미설정이면 쓰기=조회 범위라 이 검사는 무변화.
 */
const writeScopeDenied = (req, snap, owners, ip, claimed) => {
  const w = writeScopedVcenterIds(req.user, snap);
  return !!w && !ipInWriteScope(w, owners, ip, claimed);
};
const WRITE_DENIED_MSG = '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.';

export function registerIpamExport(api) {

// Per-center IP ledger (IP 관리대장): every IPv4 collected from vCenter (VM
// guest IPs, multi-homed NICs, and hosts registered by management IP), grouped
// by center, with the owning entity embedded so the UI can show details on click.
// 응답 다이어트(v2.253): VM 행의 owner(스냅샷 VM 객체 통째 — 행당 수 KB)가 응답을 수십 MB 로
// 만들어 JSON.stringify + SHA-1(ETag)이 요청마다 이벤트 루프를 세웠다. 목록에선 hasOwner
// 플래그만 내리고, 상세 팝업은 /vms/lookup?ip= 로 클릭 시 1건만 가져온다(프론트 지연 조회).
// 호스트/스캔 행은 원래 작아 유지. buildIpamRows 결과는 캐시 공유 객체라 여기서 변형하지 않는다.
api.get('/tools/ipam', (req, res) => {
  const snap = store.get();
  const data = buildIpamRows(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  res.json({ ...data, rows: data.rows.map((r) => (r.ownerType === 'vm' && r.owner ? { ...r, owner: undefined, hasOwner: true } : r)) });
});
api.get('/tools/vm-export', async (req, res) => {
  const vcenterId = vmExportGuard(req, res);
  if (!vcenterId) return;
  try {
    const r = await buildVmExport(vcenterId);
    // 미리보기는 100행까지 — 전체는 CSV 다운로드로(total 로 전체 행 수 표시).
    res.json({ ...r, rows: r.rows.slice(0, 100) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
api.get('/tools/vm-export.csv', async (req, res) => {
  const vcenterId = vmExportGuard(req, res);
  if (!vcenterId) return;
  try {
    const r = await buildVmExport(vcenterId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vm-export-${encodeURIComponent(vcenterId)}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(vmExportCsv(r));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// IPAM 추천 기능 30선 — 유명 IPAM 솔루션 대표 기능을 수집 데이터로 계산.
api.get('/tools/ipam/insights', (req, res) => {
  const snap = store.get();
  res.json(buildIpamInsights(snap, req.query.vcenterId || '', scopedVcenterIds(req.user, snap)));
});

// Per-/24 subnet ledger (Excel-style): subnet list, one subnet's rows, or full .xlsx.
api.get('/tools/ipam/subnets', (req, res) => {
  const snap = store.get();
  res.json({ subnets: listSubnets(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap)) });
});
api.get('/tools/ipam/sheet', (req, res) => {
  const snap = store.get();
  const sheets = buildSubnetSheets(snap, { vcenterId: req.query.vcenterId, onlyBase: req.query.base, allowed: scopedVcenterIds(req.user, snap) });
  res.json(sheets[0] || { subnet: '', rows: [] });
});

// Per-IP usage history (scan-derived online/offline transitions over time).
api.get('/tools/ipam/history', (req, res) => {
  // 스캔 이력은 vCenter 귀속이 없어 scope 판정 불가 → 범위 제한 계정에는 노출하지 않는다
  // (ledger.js 스캔 행 차단·deep-search scanItems 미노출과 같은 정책. 임의 IP 프로빙 차단).
  if (scopedVcenterIds(req.user, store.get())) return res.json({ ip: req.query.ip, history: null });
  res.json({ ip: req.query.ip, history: getIpHistory(String(req.query.ip || '')) });
});

// vCenter별 등록 스캔 대역 목록(+vCenter 이름·IP 수 추정).
api.get('/tools/ipam/vc-ranges', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);   // 범위 밖 vCenter id·name 열거 차단
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const list = listVcRanges().filter((e) => !allowed || allowed.has(e.vcenterId)).map((e) => ({
    ...e, vcenterName: vcName[e.vcenterId] || e.vcenterId,
    ipCount: e.ranges.reduce((a, s) => a + rangeSize(s), 0),
  }));
  // 등록 안 된 vCenter도 선택할 수 있게 (허용 범위 내) vCenter 목록을 함께 내려준다.
  res.json({ ranges: list, vcenters: (snap.vcenters || []).filter((v) => !allowed || allowed.has(v.id)).map((v) => ({ id: v.id, name: v.name })) });
});

// 스캔 대역 목록 CSV 내보내기 — JSON 라우트(/tools/ipam/vc-ranges)와 같은 scope 교집합.
// vCenter 는 표시명으로 내보낸다(가져오기가 이름/ID 둘 다 해석). 재가져오기 가능한 형식.
api.get('/tools/ipam/vc-ranges.csv', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;
  const list = listVcRanges().filter((e) => !allowed || allowed.has(e.vcenterId));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ipam-vc-ranges-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(vcRangesToCsv(list, (id) => vcName[id] || id));
});

// 네트워크 맵 — 대역(/24) 선택 시 OS별·시간대별 사용/미사용 격자.
api.get('/tools/ipam/netmap', (req, res) => {
  const snap = store.get();
  res.json(buildNetmap(snap, {
    vcenterId: req.query.vcenterId || '', base: req.query.base || '',
    days: req.query.days, buckets: req.query.buckets, allowed: scopedVcenterIds(req.user, snap),
  }));
});

// 스캔 결과를 '첨부파일'처럼 내려받기(CSV). 현재 결과 + 이력(상태/최초관측) 조인.
api.get('/tools/ipam/scan-report.csv', (req, res) => {
  const head = 'ip,hostname,status,open_ports,services,first_seen,last_seen,agent';
  // 스캔 결과 전량(전 사이트 IP/포트/서비스/수집엣지)은 vCenter 귀속이 없어 scope 판정 불가 →
  // 범위 제한 계정에는 헤더만 반환한다(ledger.js 스캔 행 차단과 일관 — 이 경로로 새면 하드닝 무의미).
  if (scopedVcenterIds(req.user, store.get())) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ip-scan-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(`${head}\n`);
  }
  const histMap = getIpHistoryMap();
  const rows = scanResultList();
  const esc = (v) => { const s = guardCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // guardCell: 수식 인젝션 방어(= + - @)
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  const lines = rows.map((r) => {
    const h = histMap[r.ip] || {};
    return [r.ip, r.hostname || '', h.status || '', (r.openPorts || []).join(' '), (r.services || []).join(' '),
      iso(h.firstSeen), iso(r.lastSeen || h.lastSeen), r.agent || ''].map(esc).join(',');
  });
  const csv = `${head}\n${lines.join('\n')}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ip-scan-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// Per-IP user annotation (custom memo + tags), separate from vCenter notes.
api.get('/tools/ipam/annotation', (req, res) => {
  const ip = req.query.ip;
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  // annotation(메모/태그)은 vCenter 귀속이 없지만, 범위 제한 계정이 IP 프로빙으로 전 함대 운영자
  // 메모를 수집하지 못하게 쓰기 경로와 같은 소유권 게이트를 건다(GET /ip/:ip 와 동일 정책).
  if (allowed && !ipInWriteScope(allowed, ipVcenterOwners(snap), ip, getOverride(ip)?.claimedVcenterId || '')) {
    return res.json({ ip, annotation: null });
  }
  res.json({ ip, annotation: getAnnotation(ip) });
});
api.put('/tools/ipam/annotation', requirePerm('tools'), (req, res) => {
  const { ip, memo, tags } = req.body || {};
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const owners = ipVcenterOwners(snap);
  const claimed = getOverride(ip)?.claimedVcenterId || '';
  if (allowed && !ipInWriteScope(allowed, owners, ip, claimed)) {
    return res.status(404).json({ ok: false, reason: '범위 밖 IP 입니다.' });
  }
  if (writeScopeDenied(req, snap, owners, ip, claimed)) return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
  const r = setAnnotation(ip, { memo, tags }, req.user);
  res.status(r.ok ? 200 : 400).json(r);
});

// ---- IP 수동 관리(override) — vCenter/스캔 자동발견과 별개의 운영자 관리상태 -------------
// 선택지(상태/디바이스종류)와 현재 관리 요약을 함께 내려준다(프론트 폼 구성용).
api.get('/tools/ipam/manage-meta', (req, res) => {
  // 요약(정책·override)을 범위 제한 계정에는 스코프해 집계 — policiesSummary 는 byVcenter 로 타
  // vCenter id 를, overridesSummary 는 함대 전체 override 규모를 흘리므로 둘 다 스코프(대칭).
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const polList = allowed ? getPolicies().filter((p) => p.claimedVcenterId && allowed.has(p.claimedVcenterId)) : null;
  const owners = allowed ? ipVcenterOwners(snap) : null;
  const ovInclude = allowed ? (ip, rec) => ipInWriteScope(allowed, owners, ip, rec?.claimedVcenterId || '') : null;
  res.json({ statuses: STATUSES, deviceTypes: DEVICE_TYPES, summary: overridesSummary(ovInclude),
    policyStatuses: POLICY_STATUSES, policiesSummary: policiesSummary(polList) });
});
// 한 IP의 override 조회.
api.get('/tools/ipam/ip/:ip', (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const ov = getOverride(req.params.ip);
  // 범위 밖 IP 의 override(담당자·라벨·예약·claimedVcenterId 등)를 범위 제한 계정에 노출하지 않는다
  // (쓰기 경로·policies/ip GET 과 동일 경계 — 형제 read 로 우회되던 갭).
  if (allowed && !ipInWriteScope(allowed, ipVcenterOwners(snap), req.params.ip, ov?.claimedVcenterId || '')) {
    return res.status(404).json({ ip: req.params.ip, override: null });
  }
  res.json({ ip: req.params.ip, override: ov });
});
// 한 IP의 override 생성/수정(부분). 변경은 운영자/관리자만.
api.put('/tools/ipam/ip/:ip', requirePerm('tools'), (req, res) => {
  if (req.body?.claimedVcenterId && !isKnownVcenter(req.body.claimedVcenterId)) return res.status(400).json({ ok: false, reason: '알 수 없는 vCenter입니다.' });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const owners = ipVcenterOwners(snap);
  const existing = getOverride(req.params.ip);
  // ① 기존 레코드가 있으면 그 **기존 소유권**(owners 또는 기존 claimedVcenterId)으로 접근 가능 여부를 먼저 판정.
  //    body.claimedVcenterId 를 앞세우면 범위 밖 vCenter 가 claim 한 예약을 scope 계정이 자기 vCenter 로
  //    덮어써 탈취할 수 있다(감사 지적) — 볼 수 없는 레코드는 만질 수도 없게 404.
  if (allowed && existing && !ipInWriteScope(allowed, owners, req.params.ip, existing.claimedVcenterId || '')) {
    return res.status(404).json({ ok: false, reason: '범위 밖 IP 입니다.' });
  }
  // ② 새로 지정하려는 claim(또는 신규 생성)도 scope 안이어야 한다.
  const claimed = req.body?.claimedVcenterId || existing?.claimedVcenterId || '';
  if (allowed && !ipInWriteScope(allowed, owners, req.params.ip, claimed)) {
    return res.status(404).json({ ok: false, reason: '범위 밖 IP 입니다.' });
  }
  // ③ 쓰기 범위(writeVcenters) — 기존·신규 claim 모두 수정 가능 범위여야 한다.
  if (writeScopeDenied(req, snap, owners, req.params.ip, existing?.claimedVcenterId || '') ||
      writeScopeDenied(req, snap, owners, req.params.ip, claimed)) {
    return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
  }
  const r = setOverride(req.params.ip, req.body || {}, req.user);
  if (r.ok) logAudit({ user: req.user?.username, action: 'IP 관리상태 저장', target: `IP ${req.params.ip}`, detail: JSON.stringify(r.override || {}).slice(0, 500) });
  res.status(r.ok ? 200 : 400).json(r);
});
// 한 IP의 override 삭제(자동발견 상태로 되돌림).
api.delete('/tools/ipam/ip/:ip', requirePerm('tools'), (req, res) => {
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const owners = ipVcenterOwners(snap);
  const claimed = getOverride(req.params.ip)?.claimedVcenterId || '';
  if (allowed && !ipInWriteScope(allowed, owners, req.params.ip, claimed)) {
    return res.status(404).json({ ok: false, reason: '범위 밖 IP 입니다.' });
  }
  if (writeScopeDenied(req, snap, owners, req.params.ip, claimed)) return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
  const r = clearOverride(req.params.ip);
  logAudit({ user: req.user?.username, action: 'IP 관리상태 삭제', target: `IP ${req.params.ip}` });
  res.json(r);
});
// 여러 IP 일괄 관리(예: 한 대역 전체를 'reserved'로). body: { ips:[...], ...fields }.
api.post('/tools/ipam/bulk', requirePerm('tools'), (req, res) => {
  const { ips, ...fields } = req.body || {};
  if (fields.claimedVcenterId && !isKnownVcenter(fields.claimedVcenterId)) return res.status(400).json({ ok: false, reason: '알 수 없는 vCenter입니다.' });
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const allowedW = writeScopedVcenterIds(req.user, snap);
  if (allowed || allowedW) {
    const owners = ipVcenterOwners(snap);   // 라우트당 1회(O(N_vm)) — IP별 재스캔 금지(CLAUDE.md O(N))
    const claimed = fields.claimedVcenterId || '';
    const bad = (Array.isArray(ips) ? ips : []).find((ip) => !ipInWriteScope(allowed, owners, String(ip), claimed));
    if (bad !== undefined) return res.status(403).json({ ok: false, reason: `범위 밖 IP 가 포함됐습니다(${bad}). 전체를 적용하지 않았습니다.` });
    // 쓰기 범위(writeVcenters) — 조회는 되지만 수정이 막힌 vCenter 의 IP 가 섞이면 전체 거부.
    const badW = (Array.isArray(ips) ? ips : []).find((ip) => !ipInWriteScope(allowedW, owners, String(ip), claimed));
    if (badW !== undefined) return res.status(403).json({ ok: false, reason: `수정 권한이 없는 vCenter 의 IP 가 포함됐습니다(${badW}). 전체를 적용하지 않았습니다.` });
  }
  const r = setOverrideBatch(ips, fields, req.user);
  if (r.ok) logAudit({ user: req.user?.username, action: 'IP 관리상태 일괄 적용', target: `${r.changed}개 IP`, detail: JSON.stringify(fields).slice(0, 500) });
  res.status(r.ok ? 200 : 400).json(r);
});

// ---- 대역(subnet/range) 단위 정책 — IP override와 평행. 대역 기본 관리상태를 한 항목으로. -------
// 정책 목록 + 요약 + 상태 enum.
api.get('/tools/ipam/policies', (req, res) => {
  // 범위 제한 계정에는 자기 vCenter 에 귀속된 정책만(전역 정책·타 vCenter 정책 id·claimedVcenterId 미노출).
  const allowed = scopedVcenterIds(req.user, store.get());
  let policies = getPolicies();
  if (allowed) policies = policies.filter((p) => p.claimedVcenterId && allowed.has(p.claimedVcenterId));
  // summary 도 스코프된 목록으로 재계산 — 전체로 계산하면 byVcenter 로 타 vCenter id·전역 정책 수가 샌다.
  res.json({ policies, summary: policiesSummary(allowed ? policies : null), statuses: POLICY_STATUSES });
});
// 특정 IP에 무엇이 적용되는지 미리보기(정책 + override). 대역 입력 시 size 미리보기 겸용.
api.get('/tools/ipam/policies/ip/:ip', (req, res) => {
  const ip = req.params.ip;
  const n = ipToNum(ip);
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  let applied = n == null ? null : findPolicy(n, req.query.vcenterId || '');
  let override = getOverride(ip);
  // 범위 밖 vCenter 에 귀속된 정책/override 는 범위 제한 계정에 노출하지 않는다.
  // override 는 형제 GET /ip/:ip 와 동일한 소유권 기반 검사 — claimedVcenterId 만 보면 빈 claimed 의
  // owner/label/note 가 새므로 ipInWriteScope(소유 vCenter + claimed)로 판정한다.
  if (allowed) {
    if (applied && !(applied.claimedVcenterId && allowed.has(applied.claimedVcenterId))) applied = null;
    if (override && !ipInWriteScope(allowed, ipVcenterOwners(snap), ip, override.claimedVcenterId || '')) override = null;
  }
  res.json({ ip, vcenterId: req.query.vcenterId || '', applied: applied || null, override, size: specToRange(ip)?.size ?? null });
});
// 대역 spec 미리보기(IP 개수) — 폼 입력 검증용(조회).
api.get('/tools/ipam/policies/preview', (req, res) => {
  const r = specToRange(String(req.query.spec || ''));
  res.json({ spec: req.query.spec || '', valid: !!r, size: r?.size ?? 0, lo: r?.lo ?? null, hi: r?.hi ?? null });
});
// 정책 생성. body: { spec, status?, priority?, claimedVcenterId?, owner?, label?, deviceType?, note?, enabled? }.
api.post('/tools/ipam/policies', requirePerm('tools'), (req, res) => {
  if (req.body?.claimedVcenterId && !isKnownVcenter(req.body.claimedVcenterId)) return res.status(400).json({ ok: false, reason: '알 수 없는 vCenter입니다.' });
  // 범위 제한 계정은 자기 vCenter 에 귀속된 정책만 만들 수 있다(전역 정책은 전 vCenter 뷰에 영향).
  const allowedP = scopedVcenterIds(req.user, store.get());
  if (allowedP && !(req.body?.claimedVcenterId && allowedP.has(req.body.claimedVcenterId))) {
    return res.status(403).json({ ok: false, reason: '범위 제한 계정은 자신의 vCenter 에 귀속된 정책만 만들 수 있습니다(전역 정책 불가).' });
  }
  // 쓰기 범위(writeVcenters, v2.369) — 수정 가능 vCenter 에 귀속된 정책만 생성 가능(전역 정책 불가).
  const allowedWc = writeScopedVcenterIds(req.user, store.get());
  if (allowedWc && !(req.body?.claimedVcenterId && allowedWc.has(req.body.claimedVcenterId))) {
    return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
  }
  const r = setPolicy(req.body || {}, req.user);
  if (r.ok) { logAudit({ user: req.user?.username, action: '대역정책 저장', target: `정책 ${r.policy.spec}`, detail: JSON.stringify(r.policy).slice(0, 800) }); try { store.syncLedger(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
// 정책 수정(부분). :id.
api.put('/tools/ipam/policies/:id', requirePerm('tools'), (req, res) => {
  if (req.body?.claimedVcenterId && !isKnownVcenter(req.body.claimedVcenterId)) return res.status(400).json({ ok: false, reason: '알 수 없는 vCenter입니다.' });
  // 범위 제한 계정: 기존 정책·변경 후 귀속 모두 자기 범위여야 한다(범위 밖 정책 탈취·전역화 차단).
  const allowedP = scopedVcenterIds(req.user, store.get());
  if (allowedP) {
    const ex = getPolicy(req.params.id);
    const eff = req.body?.claimedVcenterId ?? ex?.claimedVcenterId ?? '';
    if (!ex || !allowedP.has(ex.claimedVcenterId) || !allowedP.has(eff)) {
      return res.status(404).json({ ok: false, reason: '범위 밖 정책입니다.' });
    }
  }
  // 쓰기 범위(writeVcenters) — 기존 귀속·변경 후 귀속 모두 수정 가능 vCenter 여야 한다.
  {
    const allowedWc = writeScopedVcenterIds(req.user, store.get());
    if (allowedWc) {
      const ex = getPolicy(req.params.id);
      const eff = req.body?.claimedVcenterId ?? ex?.claimedVcenterId ?? '';
      if (ex && (!allowedWc.has(ex.claimedVcenterId || '') || !allowedWc.has(eff))) {
        return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
      }
    }
  }
  const r = setPolicy({ ...(req.body || {}), id: req.params.id }, req.user);
  if (r.ok) { logAudit({ user: req.user?.username, action: '대역정책 수정', target: `정책 ${r.policy.spec}`, detail: JSON.stringify(r.policy).slice(0, 800) }); try { store.syncLedger(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
// 정책 삭제. :id. (적용 IP는 자동발견 상태로 복귀)
api.delete('/tools/ipam/policies/:id', requirePerm('tools'), (req, res) => {
  const pol = getPolicy(req.params.id);
  const allowedP = scopedVcenterIds(req.user, store.get());
  if (allowedP && !(pol && allowedP.has(pol.claimedVcenterId))) {
    return res.status(404).json({ ok: false, reason: '범위 밖 정책입니다.' });
  }
  // 쓰기 범위(writeVcenters) — 수정 가능 vCenter 에 귀속된 정책만 삭제 가능.
  const allowedWc = writeScopedVcenterIds(req.user, store.get());
  if (allowedWc && pol && !allowedWc.has(pol.claimedVcenterId || '')) {
    return res.status(403).json({ ok: false, reason: WRITE_DENIED_MSG });
  }
  const r = deletePolicy(req.params.id);
  if (r.ok) { logAudit({ user: req.user?.username, action: '대역정책 삭제', target: `정책 ${pol?.spec || req.params.id}`, detail: pol ? JSON.stringify(pol).slice(0, 800) : '' }); try { store.syncLedger(); } catch { /* */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
api.get('/tools/ipam.xlsx', async (req, res) => {
  try {
    const snap = store.get();
    const sheets = buildSubnetSheets(snap, { vcenterId: req.query.vcenterId, allowed: scopedVcenterIds(req.user, snap) });
    const wb = await buildWorkbook(sheets);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ip-ledger-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV export of the IP ledger for sharing with other tools/spreadsheets.
api.get('/tools/ipam.csv', (req, res) => {
  const snap = store.get();
  const { rows } = buildIpamRows(snap, req.query.vcenterId, scopedVcenterIds(req.user, snap));
  const head = ['ip', 'vcenter_id', 'vcenter_name', 'owner_type', 'owner_name', 'power_state', 'guest_os', 'host_name', 'cluster', 'scope', 'multi_homed', 'duplicate',
    'discovery', 'reconcile', 'mgmt_status', 'mgmt_owner', 'label', 'device_type', 'applied_by', 'range_policy_spec', 'reserved_until', 'first_seen', 'last_seen', 'usage_status'];
  const esc = (v) => { const s = guardCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // guardCell: 수식 인젝션 방어(= + - @)
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  const lines = [head.join(',')];
  for (const r of rows) lines.push([r.ip, r.vcenterId, r.vcenterName, r.ownerType, r.ownerName, r.powerState, r.guestOS, r.hostName, r.cluster, r.scope, r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0,
    r.discovery || '', r.reconcile || '', r.mgmtStatus || '', r.owner_ || '', r.label || '', r.deviceType || '', r.appliedBy || '', r.rangePolicySpec || '', iso(r.reservedUntil), iso(r.firstSeen), iso(r.lastSeen), r.usageStatus || ''].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ipam-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n')); // BOM for Excel
});
}
