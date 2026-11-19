// routes/api/ipamServer.js — IP 관리 '서버 보기'(서비스 태그) · '호스트명 대조'(v3.6.0 재설계 묶음 다 — 설계 docs/design/ipam-redesign ⑤ · ⑮).
// 장비 왕복 0 — 스냅샷 · iDRAC 등록부(+ 엣지 원격) · 물리서버 OS 주소 등록 · 스캔 결과만 읽는다. 판정 코어는 ipam/serverView.js 하나.
//
// 가림(형제 화면과 같은 경계):
//  · 범위 계정 — 자기 vCenter 의 호스트 · VM 만. 호스트와 잇지 못한 물리 서버(전 법인 iDRAC 등록부)는 싣지 않고, 스캔이 찾은 이름(역DNS · NetBIOS)도
//    싣지 않는다(대장 ledger 의 v2.991 규칙 — 스캔 결과는 vCenter 귀속이 없다). 관리상태(override)는 그 IP 가 범위 안일 때만.
//  · 관리자 판본이 아닌 계정(auth/demoGuest isAdminDetailUser) — iDRAC 등록부(BMC 주소 · 등록 이름)와 서비스 태그를 싣지 않는다
//    (물리서버 폴더 · /admin/idrac 와 같은 판본 경계). 키도 태그가 아니라 호스트 id 로 만든다(키로 태그가 새지 않게).
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { ipVcenterOwners, ipInWriteScope } from '../../ipam/ledger.js';
import { getOverride } from '../../ipam/overrides.js';
import { getSubnetNote } from '../../ipam/subnetNotes.js';
import { getScanResults } from '../../ipam/scanStore.js';
import { buildServerIndex, serverViewFor, hostNameRows, hostNameSummary, NAME_SOURCES } from '../../ipam/serverView.js';
import { allPhysicalServers } from '../../idrac/corpAttribution.js';
import { invForServer } from '../../insights/analysisServers.js';
import { listBmServersRaw, registryLoadError as bmRegistryLoadError } from '../../bmstor/registry.js';
import { indexOsHosts, pickOsEntry } from '../../bmusage/targets.js';
import { strictIpv4Num } from '../../util/ipv4.js';

export const HOSTNAME_ROWS_DEFAULT = 300;
export const HOSTNAME_ROWS_MAX = 2000;
const VERDICT_ORDER = { diff: 0, 'cmp-none': 1, same: 2 };

/**
 * 요청 하나의 입력(시험 주입 D). 반환: { index, scanOf, admin, scoped, notes }
 */
export function serverInputs(req, D = {}) {
  const snap = (D.snap || (() => store.get()))();
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const inScope = (x) => !allowed || allowed.has(String(x?.vcenterId || ''));
  let hosts = (snap.hosts || []).filter(inScope);
  if (!admin) hosts = hosts.map((h) => ({ ...h, serviceTag: '' }));
  const vms = (snap.vms || []).filter(inScope);
  const notes = [];
  let servers = [];
  if (admin) {
    try { servers = (D.servers || allPhysicalServers)() || []; } catch { servers = []; notes.push('iDRAC 등록부를 읽지 못했습니다 — iDRAC 칸은 비어 있을 수 있습니다(없다는 뜻이 아닙니다).'); }
  }
  let osIndex = null;
  if (admin && !allowed) {
    try { if (!(D.bmRegistryLoadError || bmRegistryLoadError)()) osIndex = indexOsHosts((D.listBmServersRaw || listBmServersRaw)() || [], { includeAddrOnly: true }); else notes.push('물리서버 OS 주소 등록을 읽지 못했습니다 — OS 주소 칸은 비어 있을 수 있습니다.'); } catch { osIndex = null; }
  }
  const vcName = {};
  for (const v of snap.vcenters || []) vcName[v.id] = v.name || v.id;
  const index = buildServerIndex({
    hosts, vms, servers, invOf: D.invOf || invForServer, vcName, bareMetal: admin && !allowed,
    osEntryOf: (s) => (osIndex ? pickOsEntry(osIndex, { regHost: s.host, name: s.name, vc: s.vcenterId }).entry : null),
  });
  const results = allowed ? null : ((D.getScanResults || getScanResults)() || {});
  const scanOf = (ip) => (results && typeof ip === 'string' && Object.prototype.hasOwnProperty.call(results, ip) ? results[ip] : null);
  const owners = allowed ? ipVcenterOwners(snap) : null;
  const overrideOf = (ip) => {
    const ov = (D.getOverride || getOverride)(ip);
    if (!ov) return null;
    return !allowed || ipInWriteScope(allowed, owners, ip, ov.claimedVcenterId || '') ? ov : null;
  };
  const purposeOf = (ip) => (getSubnetNote(String(ip).split('.').slice(0, 3).join('.'))?.purpose || ''); // 대역 키는 /24 의 앞 세 마디
  return { snap, index, scanOf, overrideOf, purposeOf, admin, scoped: !!allowed, notes };
}

export function registerIpamServer(api, { D = {} } = {}) {
  // 서버 보기 — ?ip= (그 IP 를 쓰는 서버) 또는 ?key= (서버 키). 못 찾으면 found:false(404 아님 — 화면이 이유를 말한다).
  api.get('/tools/ipam/server', requirePerm('tools'), (req, res) => {
    const ip = String(req.query.ip || '').trim().slice(0, 64);
    const key = String(req.query.key || '').trim().slice(0, 200);
    if (!ip && !key) return res.status(400).json({ ok: false, error: 'ip 또는 key 가 필요합니다.' });
    if (ip && typeof strictIpv4Num(ip) !== 'number') return res.status(400).json({ ok: false, error: 'IPv4 주소 형식이 아닙니다.' });
    const x = serverInputs(req, D);
    const v = serverViewFor(x.index, { ip, key, scanOf: x.scanOf, overrideOf: x.overrideOf, purposeOf: x.purposeOf });
    res.json({ ok: true, ...v, admin: x.admin, scoped: x.scoped, notes: x.notes });
  });

  // 호스트명 대조 — 장비 한 대가 한 행. ?kind=esxi|vm|bm · ?verdict=diff|same|cmp-none · ?q= · ?limit=(정렬 뒤 자른다).
  api.get('/tools/ipam/hostnames', requirePerm('tools'), (req, res) => {
    const x = serverInputs(req, D);
    const all = hostNameRows(x.index, { admin: x.admin, scoped: x.scoped, scanOf: x.scanOf });
    const summary = hostNameSummary(all);
    const kind = ['esxi', 'vm', 'bm'].includes(req.query.kind) ? req.query.kind : '';
    const verdict = ['diff', 'same', 'cmp-none'].includes(req.query.verdict) ? req.query.verdict : '';
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    const hay = (r) => [r.name, r.ip, r.host, r.vcenterName, ...NAME_SOURCES.map((k) => r.cells?.[k]?.v)].filter(Boolean).join(' ').toLowerCase();
    const list = all.filter((r) => (!kind || r.kind === kind) && (!verdict || r.verdict === verdict) && (!q || hay(r).includes(q)))
      .sort((a, b) => (VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]) || String(a.name).localeCompare(String(b.name)));
    const limit = Math.max(1, Math.min(HOSTNAME_ROWS_MAX, Number(req.query.limit) || HOSTNAME_ROWS_DEFAULT));
    res.json({ ok: true, summary, rows: list.slice(0, limit), matched: list.length, truncated: list.length > limit, limit,
      admin: x.admin, scoped: x.scoped, bareMetal: x.admin && !x.scoped, notes: x.notes, generatedAt: x.snap?.generatedAt || null });
  });
}
