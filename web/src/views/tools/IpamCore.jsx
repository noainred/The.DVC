// IpamCore.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useHashTab } from '../../hooks/useHashTab.js';
import { takeSearch, onSearchHandoff } from '../../hooks/searchHandoff.js'; // v2.616 V5 통합 검색 · v2.617 열린 화면도 받는다
import { fetchJson, usePolling, hasRole, canCsv } from '../../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, EntityDetail, Modal, ResultCount, SearchBox, VmLink } from '../../components/ui.jsx';
import { VmRemoteButton } from '../../components/VmRemote.jsx';
import { agentLabel, DEVTYPE_LABEL, DiscoveryBadge, fmtDt, MGMT, MgmtBadge, periodText } from './ipamShared.jsx';
import { IpamNetMap, RangePolicies } from './IpamNet.jsx';
import { MemoEditor, OverrideEditor } from './IpamEditors.jsx';
import { IpmsSettings } from './IpmsSettings.jsx';
import { IpScanSettings } from './IpScanSettings.jsx';
import { ScanStatusModal } from './IpamScanStatus.jsx';
import { IPAM_DEFAULT_PAGE, IPAM_HASH_KEYS, IPAM_PAGE_ALIASES, ipamPage, pageDeniedNote, tabGroups, tabOfPage } from './ipamPages.js'; // v2.636 IP관리 서브메뉴
import { dirtyKeys, dirtyPages, onDraftChange } from './ipamDraft.js';
import { IpamScanLog } from './IpamScanLog.jsx';
import { IpamHome } from './IpamHome.jsx'; // v3.4.0 재설계 묶음 가 — 현황 탭
import { SubnetList, SubnetMap, SubnetPurposeEdit } from './IpamSubnets.jsx'; // v3.4.0 — 대역 목록 · 주소 맵 · v3.5.0 대역 용도
import { IpamExportModal } from './IpamExportModal.jsx'; // v3.5.0 — 엑셀 내보내기 창
import { RECON_OPTIONS, ROW_OPTIONS, reconLabel } from './ipamFilterText.js'; // v3.4.0 — 필터 한 줄
import { IpamChanges } from './IpamChanges.jsx'; // v3.1.0 IP 변화
import { IpamCsv } from './IpamCsv.jsx';
import { reservedUntilText } from './ipamReserveText.js';
import { Card, useTool } from './shared.jsx';
import { HostNameCell, HostNameBlock, NameSrcBadge } from './IpamHostName.jsx'; // v2.991 호스트명 칸 · IP 상세 창 호스트명 묶음
import { scanNameSummary, scanNameSummaryParts } from './ipamHostText.js';
import { MacCell, MacBlock } from './IpamMac.jsx'; // v2.999 제조사 · MAC 칸 · IP 상세 창 MAC 묶음
import { scanMacSummary, scanMacSummaryParts, isUnregisteredVirtual, macSortValue } from './ipamMacText.js';
import { hasMacAlert } from './ipamChangeText.js'; // v3.1.0 '충돌 · MAC 변경' 칩
import { dnsSummary, dnsSummaryParts, hasDnsMismatch, DNS_FWD } from './ipamDnsText.js'; // v3.2.0 DNS 정합성 — 요약 · 칩 'DNS 불일치'
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';


// 한 번에 그리는 IPAM 목록 행 상한(v2.596) — 정렬은 전체 기준, 그리기만 자른다.
const IPAM_ROW_LIMIT = 1000;

/**
 * 상단 'IP관리' 탭 진입용 단독 래퍼(v2.274 — 특수 기능 카드에서 승격). ToolPanel 밖이라
 * vCenter 범위 선택자를 자체 제공한다. App.jsx 가 lazy named import 로 가져간다
 * (Ipam 본체·하위 컴포넌트가 이 파일의 헬퍼들에 얽혀 있어 코드 이동 대신 래퍼 export).
 */

/**
 * v2.603(감사 WEB2603-01): 서브넷 대장 범위 인자 판정. 문자열(vCenter id)·null('전체 — 스캔 칩')은 그대로,
 * 없거나(undefined) 객체(React 클릭 이벤트가 onClick 에서 직접 넘어온 경우)면 현재 범위 scope 를 쓴다.
 * 예전에는 이벤트가 그대로 vc 가 되어 `?vcenterId=[object Object]` 로 대장이 통째로 비었다.
 */
export function sheetScopeArg(vc, scope) {
  if (vc === null) return null;
  if (typeof vc === 'string') return vc;
  return scope;
}

/**
 * v2.744(회귀 검토 GG-R2·GG-R3) — 대장·시트 행의 소유 자원(VM·호스트) 판정과 원격 접속 대상. 순수 함수(테스트 고정).
 *
 * · 목록·시트 응답은 VM(v2.253)·호스트(v2.744 GG-R3) 모두 owner 본문 없이 `hasOwner` 표지만 준다 — 상세는 클릭 때
 *   VM 은 `/vms/lookup`(inv.vms), 호스트는 `/hosts`(inv.hosts)로 1건만 가져온다. 권한이 없으면 서버가 403 이다(넓히지 않는다).
 * · ⚠ 호스트 행의 원격 접속 대상은 **행의 IP** 다. 스냅샷 호스트 객체에는 ipAddresses·ipAddress 가 없어(관리 IP 는 mgmtIp)
 *   owner 를 그대로 넘기면 '수집된 IP가 없습니다' 로 막혔다 — VC-01 로 FQDN 호스트의 관리 IP 가 스캔 행(owner 없음 → IP 로 접속)에서
 *   호스트 행이 되면서 생긴 회귀다. 접속 권한·대상 범위는 서버(/remote/probe·quick-connect)가 예전 그대로 판정한다.
 */
/** v3.4.0: 대역 탭을 열 때 고를 대역 — 원하는 대역이 목록에 있으면 그것, 아니면 대장 주소가 가장 많은 대역(대역 목록의 기본 정렬과 같다). */
export function firstBase(subnets, want) {
  const list = Array.isArray(subnets) ? subnets : [];
  if (want && list.some((x) => x?.base === want)) return want;
  let best = null;
  for (const x of list) if (x?.base && (!best || (Number(x.used) || 0) > (Number(best.used) || 0))) best = x;
  return best ? best.base : '';
}
export const hasOwnerRow = (r) => !!(r && (r.owner || (r.hasOwner && (r.ownerType === 'vm' || r.ownerType === 'host'))));
export function ipRemoteItem(row, owner, scope = '') {
  const ip = row?.ip || '';
  const vcenterId = row?.vcenterId || scope || '';
  if (row?.ownerType === 'host') {
    return { name: row.ownerName || owner?.name || row.hostname || ip, ipAddresses: ip ? [ip] : [], vcenterId, guestOS: row.guestOS || row.os || '' };
  }
  return owner || { name: row?.hostname || ip, ipAddresses: ip ? [ip] : [], vcenterId };
}
/** `/hosts?vcenterId=&q=` 결과에서 그 행의 호스트 하나 — id 가 있으면 id, 없으면 같은 vCenter 의 같은 이름(대소문자 무시). 모르면 null. */
export function pickHostOwner(items, row) {
  const list = Array.isArray(items) ? items : [];
  if (row?.ownerId) { const byId = list.find((h) => h?.id === row.ownerId); if (byId) return byId; }
  const nm = String(row?.ownerName || '').toLowerCase();
  if (!nm) return null;
  return list.find((h) => String(h?.name || '').toLowerCase() === nm && (!row?.vcenterId || h?.vcenterId === row.vcenterId)) || null;
}
/** 소유 자원 1건 지연 조회 — VM 은 /vms/lookup, 호스트는 /hosts. 못 찾으면 null, 403 은 그대로 던진다(호출부가 권한 안내). */
async function lookupOwner(row) {
  if (row.ownerType === 'host') {
    const name = row.ownerName || '';
    const r = await fetchJson('/hosts', { ...(row.vcenterId ? { vcenterId: row.vcenterId } : {}), ...(name ? { q: name } : {}) });
    return pickHostOwner(r?.items, row);
  }
  const nm = row.ownerName || row.label || '';
  const r = await fetchJson(`/vms/lookup?ip=${encodeURIComponent(row.ip || '')}${nm ? `&name=${encodeURIComponent(nm)}` : ''}${row.vcenterId ? `&vcenterId=${encodeURIComponent(row.vcenterId)}` : ''}`);
  return r?.vm || null;
}
const needsLookup = (row) => !row.owner && row.hasOwner && (row.ownerType === 'vm' || row.ownerType === 'host');
const deniedText = (row) => (row.ownerType === 'host'
  ? '호스트 상세는 인벤토리 › 호스트 조회 권한이 필요합니다(관리자에게 요청).'
  : 'VM 상세는 인벤토리 › 가상머신 조회 권한이 필요합니다(관리자에게 요청).');

export function IpamStandalone({ defaultScope = '' } = {}) {
  // v2.616: V5 틀의 법인 범위를 첫 값으로 받는다(바꾸면 따라간다). 개발 포탈은 넘기지 않아 예전 그대로('').
  const [scope, setScope] = useState(defaultScope);
  useEffect(() => { setScope(defaultScope); }, [defaultScope]);
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  return (
    <>
      <div className="flex wrap" style={{ marginBottom: 12, alignItems: 'center', gap: 12 }}>
        <div className="section-title" style={{ margin: 0 }}>📒 센터별 IP 관리대장</div>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <span className="muted">범위</span>
          <Select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">전체 vCenter</option>
            {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
        </label>
      </div>
      <Ipam scope={scope} onScope={setScope} />
    </>
  );
}

function Ipam({ scope, onScope }) {
  const [reload, setReload] = useState(0);
  const { loading, data: fresh, error } = useTool('/tools/ipam', { ...(scope ? { vcenterId: scope } : {}), _r: reload });
  const [q, setQ] = useState(() => takeSearch('ipam')); // v2.616: V5 통합 검색이 넘긴 검색어(없으면 '')
  const [sel, setSel] = useState(null);
  const [db, setDb] = useState(null);
  const [rowFilter, setRowFilter] = useState(''); // '' | duplicate | multihomed | public | private
  const [editMemo, setEditMemo] = useState(null); // { ip, memo, tags } for the editor
  const [histIp, setHistIp] = useState(null); // IP 사용 이력 모달 대상
  // 서브메뉴 페이지를 URL(#/ipam/<키>)에 싣는다(v2.438 · v2.636 에 전 페이지로 — 예전에는 list·sheet 만 유효해서
  //   '추천 기능 30선' 등을 누르면 해시가 바뀌는 순간 hashchange 가 목록으로 되돌렸다).
  const [hashView, setView] = useHashTab({ base: ['ipam'], valid: IPAM_HASH_KEYS, fallback: IPAM_DEFAULT_PAGE }); // v3.4.0: 첫 화면은 '현황'
  // v2.691: 옛 주소(#/ipam/ranges — '대역·스캔')는 합쳐진 페이지로 옮긴다. 옮기기 전 한 번의 렌더도 새 페이지로 그린다
  //   (옛 키로 그리면 아래 분기가 대장 목록으로 떨어져 대장을 읽기 전에 data.rows 를 읽는다 — Chromium 에서 실제로 화면이 죽었다).
  const view = IPAM_PAGE_ALIASES[hashView] || hashView;
  useEffect(() => { if (IPAM_PAGE_ALIASES[hashView]) setView(IPAM_PAGE_ALIASES[hashView]); }, [hashView]); // eslint-disable-line react-hooks/exhaustive-deps
  // v3.4.0: 첫 화면이 '현황' 이 됐다 — 통합 검색이 검색어를 넘기며 #/ipam 으로 열었으면(주소에 페이지 없음) 결과가 보이게 IP 주소 탭으로.
  useEffect(() => { if (q && hashView === IPAM_DEFAULT_PAGE) setView('list'); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // v2.617: 이미 열린 화면이면 주소가 같아 다시 마운트되지 않는다 — 구독으로 즉시 받는다(목록 보기로 옮겨 결과가 보이게).
  useEffect(() => onSearchHandoff((t) => {
    if (t !== 'ipam') return;
    const s = takeSearch('ipam');
    if (s) { setQ(s); setView('list'); }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [subnets, setSubnets] = useState([]);
  const [base, setBase] = useState('');
  const [sheet, setSheet] = useState(null);
  // v2.612 WEB2612-01: 조회 실패를 '서브넷 0개'·빈 시트로 삼키지 않는다 — 못 읽음은 없음이 아니다.
  const [subnetsErr, setSubnetsErr] = useState('');
  const [sheetErr, setSheetErr] = useState('');
  const [stFilter, setStFilter] = useState(''); // '' = 전체 | used | multihomed | duplicate | empty
  const [reconFilter, setReconFilter] = useState(''); // '' | vcenter | scan | both | manual | managed
  const [editOv, setEditOv] = useState(null);
  const [exportOpen, setExportOpen] = useState(false); // v3.5.0: 엑셀 내보내기 창 // IP 관리상태(override) 편집 대상 row
  const canManage = hasRole('admin', 'operator'); // operator/admin → 관리상태 편집 가능. // v2.613 WEB2613-01: 역할은 App 이 채운 현재 사용자 객체에서 읽는다(화면이 /auth/me 를 다시 부르지 않는다).
  useEffect(() => { fetchJson('/admin/ipam/db-info').then(setDb).catch(() => setDb(null)); }, []);

  const sheetGen = useRef(0); // 세대 가드 — 칩 A→B 연타 시 늦은 A 응답이 B 시트를 덮어쓰지 않게(고RTT)
  const pickBase = async (b, vc = scope) => {
    const gen = ++sheetGen.current;
    setBase(b);
    let r = null; let err = '';
    try { r = await fetchJson(`/tools/ipam/sheet?base=${b}${vc ? `&vcenterId=${encodeURIComponent(vc)}` : ''}`); }
    catch (e) { err = e?.message || String(e); }
    if (gen === sheetGen.current) { setSheet(r); setSheetErr(err); }
  };
  // v2.603(감사 WEB2603-01): '서브넷 대장' 버튼이 `onClick={openSheets}` 로 React 클릭 이벤트를 vc 로 넘겨
  //   `?vcenterId=[object Object]` → 대장이 통째로 비었다. 호출부를 고치고, 객체(이벤트)가 와도 현재 범위로 좁힌다
  //   (null 은 '전체' 라는 뜻이므로 그대로 둔다 — 스캔 칩이 그렇게 부른다).
  const subnetGen = useRef(0); // 늦게 온 이전 범위의 서브넷 목록이 새 목록을 덮지 않게(고RTT)
  const openSheets = async (vcArg, wantBase) => { // v3.4.0: wantBase — 현황의 대역을 눌렀을 때 그 대역으로
    const vc = sheetScopeArg(vcArg, scope);
    const gen = ++subnetGen.current;
    setView('sheet');
    const q = vc ? `?vcenterId=${encodeURIComponent(vc)}` : '';
    let r;
    try { r = await fetchJson(`/tools/ipam/subnets${q}`); }
    catch (e) { if (gen === subnetGen.current) setSubnetsErr(e?.message || String(e)); return; }
    if (gen !== subnetGen.current) return;
    setSubnetsErr('');
    setSubnets(r.subnets || []);
    const pick = firstBase(r.subnets, wantBase);
    if (pick) pickBase(pick, vc);
  };
  // v2.636: 대장 CSV·엑셀 내보내기는 'CSV 가져오기·내보내기' 페이지(IpamCsv.jsx)로 옮겼다(downloadFile 은 res.ok 를 본다 — v2.602).

  // 관리자 페이지 접근(v2.636): 'yes' | 'no'(403) | 'unknown'(아직 모름·네트워크 오류 — '없음' 으로 읽지 않는다. 권한은 서버가 집행한다).
  const [access, setAccess] = useState('unknown');
  useEffect(() => { fetchJson('/admin/ipam/settings').then(() => setAccess('yes')).catch((e) => setAccess(e?.status === 403 ? 'no' : 'unknown')); }, []);
  // 저장하지 않은 입력이 있는 페이지(서브메뉴 ● 표시) + 탭을 닫을 때 경고.
  const [dirty, setDirty] = useState(() => dirtyPages());
  useEffect(() => onDraftChange(() => setDirty(dirtyPages())), []);
  useEffect(() => {
    const onLeave = (e) => { if (dirtyKeys().length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);
  // 대장을 다시 읽는 동안(관리상태 저장 뒤 재조회 등) 직전 값을 계속 보여 준다 — 같은 범위일 때만(다른 범위의 값을 섞지 않는다).
  const lastRef = useRef({ scope: null, data: null });
  if (fresh && !loading) lastRef.current = { scope, data: fresh };
  const data = fresh || (lastRef.current.scope === scope ? lastRef.current.data : null);
  const refreshing = loading && !!data;

  // Always keep the subnet list in sync with the vCenter scope (for counts/chips).
  useEffect(() => {
    let active = true;   // v2.596(감사 WS-3): 늦게 온 이전 범위 응답이 pickBase 로 새 시트를 덮지 않게
    const gen = ++subnetGen.current; // v2.603: openSheets 와 같은 세대 — 둘 중 나중 요청만 목록을 쓴다
    const q = scope ? `?vcenterId=${encodeURIComponent(scope)}` : '';
    fetchJson(`/tools/ipam/subnets${q}`).then((r) => { if (!active || gen !== subnetGen.current) return; setSubnetsErr(''); setSubnets(r.subnets || []); if (view === 'sheet' && r.subnets?.[0]) pickBase(firstBase(r.subnets), scope); }).catch((e) => { if (active && gen === subnetGen.current) setSubnetsErr(e?.message || String(e)); });
    return () => { active = false; };
    // eslint-disable-next-line
  }, [scope]);
  // v3.4.0(TDZ — subnets · base · pickBase 선언 뒤에 둔다): 대역 탭을 주소(#/ipam/sheet)로 바로 열면 아무 대역도 고르지 않은 채 '불러오는 중' 에 머물렀다(Chromium 에서 확인) —
  //   대역 목록이 오면 대장 주소가 가장 많은 대역을 고른다(고른 대역이 있으면 그대로).
  useEffect(() => { if (view === 'sheet' && !base && subnets.length) pickBase(firstBase(subnets)); }, [view, subnets]); // eslint-disable-line react-hooks/exhaustive-deps


  // reconcile/관리 집계 + 행 필터를 메모이즈 — 수천 행에서 무관한 리렌더 시 재계산을 피한다(렌더 성능).
  const term = q.trim().toLowerCase();
  const recon = useMemo(() => {
    const c = { vcenter: 0, scan: 0, both: 0, manual: 0, conflict: 0, managed: 0, unmanaged: 0, reserved: 0, noname: 0 };
    for (const r of (data?.rows || [])) {
      if (c[r.reconcile] !== undefined) c[r.reconcile]++;
      if (r.managed) c.managed++; else c.unmanaged++;
      if (r.reservedExpired || r.reservedExpiringSoon) c.reserved++;
      if (r.ownerType === 'scanned' && !r.netName) c.noname++; // v2.991: 이름을 찾지 못한 스캔 IP(직접 넣을 대상)
    }
    c.names = scanNameSummary(data?.rows || []); // v2.991: 스캔 IP 호스트명 요약(목록 위 한 줄)
    c.macs = scanMacSummary(data?.rows || []); // v2.999: 스캔 IP MAC 요약(같은 줄) · '미등록 가상 NIC' 칩 수
    c.vnic = c.macs.virtualUnreg;
    c.macAlert = (data?.rows || []).filter(hasMacAlert).length; // v3.1.0: 충돌 의심 · 최근 MAC 변경
    c.dns = dnsSummary(data?.rows || []); // v3.2.0: 역DNS 이름의 정방향 확인(일치 · 불일치 · 확인 못 함)
    c.dnsBad = c.dns.other + c.dns.none;
    return c;
  }, [data]);
  const subnetNote = subnets.find((x) => x.base === base) || null; // v3.5.0: 고른 대역의 용도 · 설명(대역 목록 응답에 실린다)
  const rows = useMemo(() => (data?.rows || []).filter((r) => {
    if (rowFilter === 'duplicate' && !r.duplicate) return false;
    if (rowFilter === 'multihomed' && !r.multiHomed) return false;
    if (rowFilter === 'public' && r.scope !== 'public') return false;
    if (rowFilter === 'private' && r.scope !== 'private') return false;
    if (reconFilter === 'managed' && !r.managed) return false;
    if (reconFilter === 'unmanaged' && r.managed) return false;
    if (reconFilter === 'reserved' && !(r.reservedExpired || r.reservedExpiringSoon)) return false;
    if (reconFilter === 'noname' && !(r.ownerType === 'scanned' && !r.netName)) return false;
    if (reconFilter === 'vnic' && !isUnregisteredVirtual(r)) return false; // v2.999
    if (reconFilter === 'macalert' && !hasMacAlert(r)) return false; // v3.1.0
    if (reconFilter === 'dnsbad' && !hasDnsMismatch(r)) return false; // v3.2.0
    if (reconFilter && !['managed', 'unmanaged', 'reserved', 'noname', 'vnic', 'macalert', 'dnsbad'].includes(reconFilter) && r.reconcile !== reconFilter) return false;
    if (term && !(r.ip.includes(term) || (r.ownerName || '').toLowerCase().includes(term) || (r.hostName || '').toLowerCase().includes(term) || (r.netName || '').toLowerCase().includes(term) || (r.ipPurpose || '').toLowerCase().includes(term) || (r.requester || '').toLowerCase().includes(term) || (r.assigner || '').toLowerCase().includes(term) || (r.label || '').toLowerCase().includes(term) || (r.owner_ || '').toLowerCase().includes(term) || (r.note || '').toLowerCase().includes(term))) return false;
    return true;
  }), [data, term, rowFilter, reconFilter]);

  const ROWBG = { used: 'rgba(34,197,94,.12)', multihomed: 'rgba(59,130,246,.14)', duplicate: 'rgba(239,68,68,.14)', network: 'rgba(148,163,184,.14)', released: 'rgba(245,158,11,.13)', scanned: 'rgba(20,184,166,.14)', empty: 'transparent' };
  const STLAB = { used: '사용', multihomed: '복수IP', duplicate: '중복', network: 'Network ID', released: '해제(이력)', scanned: '스캔 확인', empty: '' };

  // v3.4.0: '현황' 탭의 숫자 → IP 주소 탭을 그 조건으로(예전 KPI 카드 클릭 · 출처 대조 버튼과 같은 키).
  const goFiltered = ({ recon: rk = '', row = '' } = {}) => { setReconFilter(rk); setRowFilter(row); setQ(''); setView('list'); };


  const link = { background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: 0, font: 'inherit' };
  const cols = [
    // v2.991: 소유 자원(VM·호스트)이 없는 행(스캔·수동)은 IP 를 누르면 IP 상세 창(사용 이력 + 호스트명 방식별 결과) — 예전 안내 창은
    //   '자원 상세를 열 수 없습니다' 만 말했다(시안 ⓪ 5).
    { key: 'ip', label: 'IP 주소', sortValue: (r) => r.ipNum ?? Infinity, render: (r) => (
      <button style={link} title="IP 상세 — 사용 이력 · 관리 정보 · 소유 자원 · 원격 접속" onClick={() => setHistIp(r)}>{/* v3.5.0: 모달 여러 개 대신 상세 창 하나 */}
        <b>{r.ip}</b>
        {r.reconcile === 'conflict' && <span className="badge red" style={{ marginLeft: 6 }} title={`교차 vCenter 충돌 — 같은 IP를 주장: ${(r.conflictVcenters || []).join(', ')}`}>⚠ 충돌</span>}
        {r.duplicate && <span className="badge red" style={{ marginLeft: 6 }}>중복</span>}
        {r.multiHomed && <span className="badge amber" style={{ marginLeft: 4 }} title="이 VM 은 주소를 둘 이상 갖고 있습니다(장애 아님 — 예전 표기 '멀티홈')">복수IP</span>}
        {r.reservedExpired && <span className="badge amber" style={{ marginLeft: 4 }} title="예약 만료일이 지났습니다">⏳ 예약만료</span>}
        {!r.reservedExpired && r.reservedExpiringSoon && <span className="badge amber" style={{ marginLeft: 4 }} title={`예약 만료 임박: ${reservedUntilText(r.reservedUntil, data.tzOffsetMin)}`}>⏳ 임박</span>}
      </button>
    ) },
    // v2.991: 호스트명 — 관리상태 이름 > 역DNS > mDNS > NetBIOS(서버 netName). IP 옆에 둔다(표가 가로로 넘겨도 IP 와 함께 보이게).
    { key: 'netName', label: '호스트명', sortValue: (r) => r.netName || null, render: (r) => <HostNameCell r={r} canManage={canManage} onAdd={() => setEditOv(r)} /> },
    // v3.5.0(재설계 묶음 나): 사람이 넣은 용도(관리상태 편집 · CSV) — 요청자 · 할당자는 상세 창 · 서브넷 대장 · 엑셀에.
    { key: 'ipPurpose', label: '용도', sortValue: (r) => r.ipPurpose || null, render: (r) => (r.ipPurpose ? <span title={[r.requester && `요청자 ${r.requester}`, r.assigner && `할당자 ${r.assigner}`].filter(Boolean).join(' · ') || undefined}>{r.ipPurpose}</span> : <span className="muted">—</span>) },
    // v2.999: 제조사 · MAC — 스캔이 본 MAC(스캐너 이웃 표 ARP > NetBIOS) · 제조사(서버 macVendor). VM · 호스트 행에도(스캔 대역 안일 때).
    { key: 'mac', label: '제조사 · MAC', sortValue: macSortValue, render: (r) => <MacCell r={r} /> },
    { key: 'scope', label: '분류', sortValue: (r) => r.scope || '', render: (r) => (
      <span className={`badge ${r.scope === 'public' ? 'amber' : 'green'}`}>{r.scope === 'public' ? '공인' : '사설'}</span>
    ) },
    // v2.638: 스캔으로만 확인된 IP 는 스캔한 에이전트의 데이터센터를 함께 보인다(귀속 못 한 행은 예전 그대로).
    { key: 'vcenterName', label: '센터(vCenter)', sortValue: (r) => `${r.vcenterName || ''} ${r.datacenterName || ''}`, render: (r) => (
      r.ownerType === 'scanned'
        ? <span>{r.vcenterName}{r.datacenterName
          ? <span className="badge teal" style={{ marginLeft: 4, fontSize: 10 }} title={`스캔한 에이전트 ${r.scanAgent ? agentLabel(r.scanAgent) : '—'} 의 데이터센터(${r.dcSource === 'manual' ? '직접 지정' : '자동 판정'})`}>{r.datacenterName}</span>
          : <span className="muted" style={{ marginLeft: 4, fontSize: 10 }} title="스캔한 에이전트의 데이터센터를 판정하지 못했습니다 — IP 스캔 설정에서 데이터센터를 고르세요">데이터센터 미정</span>}</span>
        : r.vcenterName
    ) },
    { key: 'serverType', label: '서버종류', sortValue: (r) => r.serverType || '', render: (r) => <span className={`badge ${r.serverType === 'BareMetal' ? 'amber' : r.serverType === 'Scanned' ? 'teal' : 'blue'}`} title={r.serverType === 'Scanned' ? 'vCenter가 모르는 IP를 능동 스캔으로 확인' : undefined}>{r.serverType === 'BareMetal' ? '베어메탈' : r.serverType === 'Scanned' ? '🛰 스캔 확인' : 'VM'}</span> },
    { key: 'discovery', label: '확인 방식', sortValue: (r) => r.discovery || '', render: (r) => <DiscoveryBadge d={r.discovery} /> },
    { key: 'mgmt', label: '관리상태', sortValue: (r) => r.mgmtStatus || (r.managed ? 'zz' : 'zzz'), render: (r) => (
      <span className="flex gap" style={{ alignItems: 'center', gap: 5 }}>
        {r.mgmtStatus ? <MgmtBadge s={r.mgmtStatus} /> : <span className="muted" style={{ fontSize: 11 }}>—</span>}
        {r.appliedBy === 'range-policy' && <span className="badge purple" style={{ fontSize: 9 }} title={`대역 정책 적용: ${r.rangePolicySpec || ''}`}>정책</span>}
        {r.appliedBy === 'override' && r.managed && <span className="badge teal" style={{ fontSize: 9 }} title="IP 단위 수동 지정">IP수동</span>}
        {r.deviceType && <span className="badge gray" style={{ fontSize: 10 }}>{DEVTYPE_LABEL[r.deviceType] || r.deviceType}</span>}
        {r.reservedUntil && <span className="muted" style={{ fontSize: 10 }} title={`예약 만료: ${reservedUntilText(r.reservedUntil, data.tzOffsetMin) || '—'}`}>⏳</span>}
        {canManage && <button className="tab" style={{ padding: '1px 7px', fontSize: 11 }} title="IP 관리상태 편집(담당자·예약·디바이스 종류 등)" onClick={() => setEditOv(r)}>{r.managed ? '✎' : '+'}</button>}
      </span>
    ) },
    // 소유 자원 — v2.253 응답 다이어트로 VM 행은 owner 본문 대신 hasOwner 플래그만 온다.
    // owner 가 있거나(hasOwner VM 행이면 IpOwnerDetail 이 지연 조회) 클릭 가능하게 한다(v2.277).
    { key: 'ownerName', label: '소유 자원', sortValue: (r) => r.displayName || r.ownerName || '', render: (r) => (hasOwnerRow(r) ? <button className="cell-link" onClick={() => setSel(r)}>{r.label || r.ownerName}</button> : <OwnerText r={r} />) },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
    { key: 'osName', label: 'OS 종류', sortValue: (r) => r.osName || '', render: (r) => r.osName || <span className="muted">—</span> },
    { key: 'osVersion', label: 'OS 버전', sortValue: (r) => r.osVersion || '', render: (r) => r.osVersion || <span className="muted">—</span> },
    // v2.991: 스캔·수동 행의 hostName 은 ESXi 호스트가 아니라 호스트명이다(대장 · ipam.db 열의 뜻은 그대로) — 이 칸에는 VM·호스트 행만.
    { key: 'hostName', label: 'ESXi 호스트', sortValue: (r) => ((r.ownerType === 'vm' || r.ownerType === 'host') && r.hostName) || null, render: (r) => ((r.ownerType === 'vm' || r.ownerType === 'host') && r.hostName ? r.hostName : <span className="muted">—</span>) },
  ];

  const denied = pageDeniedNote(view, access);
  const go = (k) => (k === 'sheet' ? openSheets() : setView(k));
  // 대장 데이터가 있어야 그릴 수 있는 페이지의 대기 표시 — 어느 페이지가 그런지는 ipamPages.needsLedger 하나가 정한다(v2.639 I2 —
  //   예전엔 여기서 'list'·'policies' 를 손으로 정해 needsLedger 를 읽는 곳이 0 이었다). 설정 페이지는 이것을 기다리지 않는다.
  const ledgerWait = data || !ipamPage(view)?.needsLedger ? null : (error ? <ErrorBox message={error} /> : <Loading />);
  return (
    <>
      {refreshing && <div className="muted" style={{ fontSize: 12, margin: '-6px 0 8px' }}>대장을 다시 읽는 중입니다 — 아래 값은 직전에 받은 것입니다.</div>}
      {error && data && <div className="banner warn" style={{ marginBottom: 8 }}>대장을 다시 읽지 못했습니다 — 아래 값은 직전에 받은 것입니다: {error}</div>}
      {/* v3.4.0(재설계 묶음 가): 위 탭 5개 + 그 탭의 보기 줄. 페이지 키 · 주소(#/ipam/<키>)는 그대로이고 탭은 묶음일 뿐이다(ipamPages.tabGroups).
          설정 페이지는 대장 로딩과 무관하게 그린다(v2.636 — 예전 모달은 대장을 다시 읽는 순간 사라져 입력이 날아갔다).
          ● = 저장하지 않은 입력이 있는 페이지(편집 초안 — 다른 탭으로 옮겨도 남는다). 예전 KPI 카드 9장은 '현황' 탭으로 옮겼다. */}
      {(() => {
        const groups = tabGroups(access, { csvOk: canCsv() });
        const curTab = tabOfPage(view);
        const cur = groups.find((g) => g.t === curTab);
        return (
          <>
            <nav className="ipam-tabs" aria-label="IP 관리 탭">
              {groups.map((g) => (
                <button key={g.t} type="button" className={`ipam-tab${g.t === curTab ? ' on' : ''}`} aria-current={g.t === curTab ? 'page' : undefined} onClick={() => go(g.first)}>
                  {g.label}
                  {g.t === 'addr' && data ? <span className="ipam-tab-n">{data.total.toLocaleString()}</span> : null}
                  {g.t === 'range' && !subnetsErr && subnets.length ? <span className="ipam-tab-n">{subnets.length.toLocaleString()}</span> : null}
                  {g.admin && <span className="ipam-tab-adm">관리자</span>}
                  {g.pages.some((p) => dirty.has(p.k)) && <span className="ipam-dirty-dot" title="저장하지 않은 입력이 있습니다"> ●</span>}
                </button>
              ))}
            </nav>
            {cur && cur.pages.length > 1 && (
              <div className="ipam-subtabs" role="group" aria-label={`${cur.label} 보기`}>
                {cur.pages.map((pg) => (
                  <button key={pg.k} type="button" className={`tab${view === pg.k ? ' active' : ''}`} title={pg.title} aria-current={view === pg.k ? 'page' : undefined} onClick={() => go(pg.k)}>
                    {pg.label}{dirty.has(pg.k) && <span className="ipam-dirty-dot" title="저장하지 않은 입력이 있습니다"> ●</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}
      {denied ? <div className="banner warn" role="status" style={{ marginBottom: 8 }}>{denied}</div>
      : view === 'home' ? <IpamHome data={data} error={error} recon={recon} subnets={subnetsErr ? null : subnets} subnetsErr={subnetsErr} db={db} access={access}
          onGo={go} onFilter={goFiltered} onPickSubnet={(b) => openSheets(undefined, b)} onPickVcenter={(id) => { onScope?.(id); openSheets(id); }} />
      : view === 'scan' ? <IpScanSettings asPage onSaved={() => setReload((n) => n + 1)} />
      : view === 'status' ? <ScanStatusModal asPage />
      : view === 'log' ? <IpamScanLog />
      : view === 'changes' ? <IpamChanges />
      : view === 'ipms' ? <IpmsSettings asPage access={access} />
      : view === 'csv' ? <IpamCsv scope={scope} access={access} canManage={canManage} onGoto={go} onApplied={() => setReload((n) => n + 1)} />
      : view === 'netmap' ? (
        <IpamNetMap />
      ) : view === 'policies' ? (
        ledgerWait || <RangePolicies scope={scope} canManage={canManage} vcenters={data.byVcenter} onChanged={() => setReload((n) => n + 1)} />
      ) : view === 'insights' ? (
        <IpamInsights scope={scope} />
      ) : view === 'sheet' ? (
        <div className="ipam-range">
          <SubnetList subnets={subnets} base={base} err={subnetsErr} onPick={(b) => pickBase(b)} />
          <div className="ipam-range-main">
          {sheetErr && (
            <div className="banner warn" style={{ marginBottom: 8 }}>서브넷 대장({base})을 읽지 못했습니다: {sheetErr}</div>
          )}
          {sheet && (() => {
            // '사용중'에는 스캔으로 확인된 IP(scanned)도 포함(실제 사용 중인 IP이므로).
            const USED = ['used', 'multihomed', 'duplicate', 'scanned'];
            const cnt = (st) => sheet.rows.filter((r) => (st === 'used' ? USED.includes(r.status) : r.status === st)).length;
            const FILTERS = [
              ['', `전체 (${sheet.rows.length})`, 'gray'],
              ['used', `사용중 (${cnt('used')})`, 'green'],
              ['multihomed', `복수IP (${cnt('multihomed')})`, 'blue'],
              ['duplicate', `중복 (${cnt('duplicate')})`, 'red'],
              ['scanned', `스캔 확인 (${cnt('scanned')})`, 'teal'],
              ['released', `해제(이력) (${cnt('released')})`, 'amber'],
              ['empty', `미사용 (${cnt('empty')})`, 'gray'],
            ];
            // '사용중' = 실제 점유(사용/멀티홈/중복/스캔확인) 전부, 나머지는 정확히 해당 상태.
            const shown = sheet.rows.filter((r) => {
              if (!stFilter) return true;
              if (stFilter === 'used') return USED.includes(r.status);
              return r.status === stFilter;
            });
            return (
              <>
                <div className="ipam-range-head">
                  {subnetNote?.purpose ? <span style={{ fontSize: 20, fontWeight: 800 }}>{subnetNote.purpose}</span> : null}
                  <span className="mono" style={{ fontSize: subnetNote?.purpose ? 14 : 19, fontWeight: 700 }}>{sheet.subnet || `${base}.0/24`}</span>
                  <span className="muted" style={{ fontSize: 12 }}>사용 중 {cnt('used').toLocaleString()} · 해제(이력) {cnt('released').toLocaleString()} · 빈 주소 {cnt('empty').toLocaleString()}{cnt('duplicate') ? ` · 중복 ${cnt('duplicate')}` : ''}</span>
                  {canCsv() && <button type="button" className="logout-btn" style={{ marginLeft: 'auto', padding: '5px 11px', fontSize: 12 }} onClick={() => setExportOpen(true)}>엑셀</button>}
                </div>
                {subnetNote?.desc ? <div className="muted" style={{ fontSize: 12.5, margin: '-4px 0 10px', overflowWrap: 'anywhere' }}>{subnetNote.desc}</div> : null}
                {canManage && <SubnetPurposeEdit base={base} note={subnetNote} onSaved={(b, n) => setSubnets((list) => list.map((x) => (x.base === b ? { ...x, purpose: n?.purpose || '', desc: n?.desc || '', noteAt: n?.updatedAt || null, noteBy: n?.updatedBy || '' } : x)))} />}
                <SubnetMap rows={sheet.rows} base={base} onPickRow={(r) => setHistIp(r)} />
                <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
                  {FILTERS.map(([k, label]) => (
                    <button key={k} className={stFilter === k ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => setStFilter(k)}>{label}</button>
                  ))}
                                  </div>
                {(sheet.policies || []).length > 0 && (
                  <div className="flex gap wrap" style={{ marginBottom: 8, alignItems: 'center' }}>
                    <span className="muted" style={{ fontSize: 12 }}>🧩 이 대역 적용 정책:</span>
                    {sheet.policies.map((p) => (
                      <span key={p.id} className="badge purple" style={{ fontSize: 11 }} title={`priority ${p.priority}`}>{p.spec} · {MGMT[p.status]?.[0] || p.status || '필드'}{p.label ? ` (${p.label})` : ''}</span>
                    ))}
                  </div>
                )}
                <div className="table-wrap" style={{ maxHeight: '62vh' }}>
                  <STable minWidth={1100} wrap={false}>
                    <thead><tr><th>{base}.X</th><th>용도</th><th>요청자</th><th>할당자</th><th>Hostname</th><th>서버종류</th><th>확인 방식</th><th>OS</th><th>메모(Notes)</th><th>전원</th><th>분류</th><th>상태</th><th>사용이력</th><th>메모 · 태그</th></tr></thead>
                    <tbody>
                      {shown.length === 0 && <tr><td colSpan={14} className="center muted" style={{ padding: 22 }}>해당 상태의 IP가 없습니다.</td></tr>}
                      {shown.map((r) => (
                        <tr key={r.ip} style={{ background: ROWBG[r.status] }}>
                          <td><button className="cell-link" title="클릭: 확인 시점·호스트명·사용/미사용 기간 + VM 정보/원격 접속" onClick={() => setHistIp(r)}><b>{r.ip}</b></button></td>
                          <td title={r.ipPurpose && r.purpose ? `포탈이 채운 값: ${r.purpose}` : undefined}>{r.ipPurpose ? <b>{r.ipPurpose}</b> : <span className="muted" style={{ fontSize: 12 }}>{r.purpose}</span>}</td>
                          <td style={{ fontSize: 12 }}>{r.requester || ''}</td>
                          <td style={{ fontSize: 12 }}>{r.assigner || ''}</td>
                          <td>{r.hostname ? <VmLink ip={r.ip} vcenterId={scope} label={r.hostname} /> : ''}<NameVia r={r} /></td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.serverType || ''}</td>
                          <td style={{ fontSize: 12 }}><DiscoveryBadge d={r.discovery} /></td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.os || ''}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.notes}</td>
                          <td>{r.power}</td>
                          <td className="muted" style={{ fontSize: 12 }}>{r.scope}</td>
                          <td className="muted" style={{ fontSize: 12 }}>
                            {r.status === 'released' ? <span className="badge amber">해제</span> : r.status === 'scanned' ? <span className="badge teal" title="vCenter가 모르는 IP를 능동 스캔으로 확인">🛰 스캔 확인</span> : STLAB[r.status]}
                            {r.mgmtStatus && <MgmtBadge s={r.mgmtStatus} />}
                            {r.appliedBy === 'range-policy' && <span className="badge purple" style={{ fontSize: 9, marginLeft: 3 }} title={`대역 정책: ${r.rangePolicySpec || ''}`}>정책</span>}
                          </td>
                          <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {/* 상시 배지(v2.359, 사용자 요구): 열만 봐도 '지금 사용중 / 과거 사용' 이 보이게.
                                클릭하면 기존 이력 모달(사용·미사용 구간 타임라인). */}
                            {r.usageStatus
                              ? <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} title={`최초 발견: ${fmtDt(r.firstSeen)}\n마지막 확인: ${fmtDt(r.lastSeen)}\n클릭: 사용/미사용 구간 이력`}
                                  onClick={() => setHistIp(r)}>
                                  {r.usageStatus === 'up'
                                    ? <span style={{ color: 'var(--green)' }}>🟢 사용중</span>
                                    : <span style={{ color: 'var(--amber)' }}>🟡 과거 사용{r.lastSeen ? ` · ${Math.max(1, Math.round((Date.now() - r.lastSeen) / 86_400_000))}일 전까지` : ''}</span>}
                                </button>
                              : <span className="muted" title="이 IP 는 스캔에서 한 번도 응답한 기록이 없습니다">—</span>}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {r.memo && <div style={{ marginBottom: 3 }}>{r.memo}</div>}
                            {(r.tags || []).map((t) => <span key={t} className="badge blue" style={{ marginRight: 4, fontSize: 10 }}>{t}</span>)}
                            <button className="tab" style={{ padding: '2px 8px', fontSize: 11, marginLeft: (r.tags || []).length ? 4 : 0 }}
                              onClick={() => setEditMemo({ ip: r.ip, memo: r.memo || '', tags: (r.tags || []).join(', ') })}>
                              {r.memo || (r.tags || []).length ? '✎ 편집' : '+ 추가'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </STable>
                </div>
              </>
            );
          })()}
          {!sheet && !sheetErr && (subnets.length > 0 ? <Loading /> : <div className="muted" style={{ padding: 16, fontSize: 13 }}>{subnetsErr ? '' : '대역이 없습니다.'}</div>)}
          </div>
        </div>
      ) : ledgerWait || (
        <>
          {(data?.scanByDatacenter || []).length > 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }} title="스캔으로만 확인된 IP 를, 스캔한 에이전트의 데이터센터로 나눈 개수입니다(IP 스캔 설정의 데이터센터 — 직접 지정 또는 자동).">
              🛰 스캔 IP 데이터센터별: {data.scanByDatacenter.map((x) => `${x.datacenterId ? x.datacenterName : '미정'} ${x.count}`).join(' · ')}
            </div>
          )}
          {/* v3.4.0(재설계 묶음 가): 필터 한 줄 — 예전 '출처 대조' 버튼(최대 13개) · KPI 카드 클릭 · 빨간 검색창을 대신한다.
              조건은 예전과 같은 recon/row 필터 키(ipamFilterText.RECON_OPTIONS · ROW_OPTIONS)이고 '현황' 탭의 숫자도 같은 키로 이 화면을 연다. */}
          <div className="ipam-filterbar" role="group" aria-label="IP 주소 필터">
            <SearchBox className="input" style={{ flex: '1 1 220px', maxWidth: 320 }} placeholder="IP · 호스트명 · VM · 담당 · 메모" value={q} onChange={setQ} />
            <label className="ipam-fsel"><span className="muted">상태 · 출처</span>
              <Select className="select" value={reconFilter} onChange={(e) => setReconFilter(e.target.value)}>
                {RECON_OPTIONS.filter((o) => !o.conditional || (recon[o.count] || 0) > 0 || reconFilter === o.k).map((o) => (
                  <option key={o.k} value={o.k}>{reconLabel(o, o.k ? recon[o.count] : data.rows.length)}</option>
                ))}
              </Select>
            </label>
            <label className="ipam-fsel"><span className="muted">분류</span>
              <Select className="select" value={rowFilter} onChange={(e) => setRowFilter(e.target.value)}>
                {ROW_OPTIONS.map((o) => <option key={o.k} value={o.k}>{reconLabel(o, o.count ? data[o.count] : null)}</option>)}
              </Select>
            </label>
            {(reconFilter || rowFilter || term) && <button type="button" className="tab" style={{ padding: '5px 10px' }} onClick={() => { setReconFilter(''); setRowFilter(''); setQ(''); }}>필터 지우기</button>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {canManage && <button className="logout-btn" style={{ padding: '6px 12px' }} title="수동으로 IP를 등록하거나 한 대역을 일괄 관리(예약 등)" onClick={() => setEditOv({ ip: '', __new: true })}>＋ IP 등록 · 예약</button>}
              {canCsv() && <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => setExportOpen(true)} title="요약 · 대역 목록 · 대장 · 조치 필요 · 안내 시트를 골라 엑셀로">엑셀</button>}
              <button className="logout-btn" style={{ padding: '6px 12px' }} onClick={() => setView('csv')} title="대장 CSV 내보내기 · IP 관리상태 CSV 가져오기">CSV</button>
            </span>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', columnGap: 12 }}>
            <ResultCount total={data.rows.length} shown={rows.length} label="IP" filtered={!!term || !!reconFilter || !!rowFilter} />
            {recon.names.total > 0 && (
              <span className="flex gap wrap" style={{ alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6 }}
                title="스캔으로만 확인한 IP 의 호스트명 — 직접 넣은 이름 · 역DNS · mDNS · NetBIOS 중 표시한 것의 출처별 개수입니다">
                <span className="muted">스캔 IP 호스트명</span> <b>{recon.names.named.toLocaleString()}</b><span className="muted">/ {recon.names.total.toLocaleString()}</span>
                {scanNameSummaryParts(recon.names).map((p) => <span key={p.key} className={`badge ${p.tone}`} style={{ fontSize: 10 }}>{p.label}</span>)}
              </span>
            )}
            {recon.dns.total > 0 && (
              <span className="flex gap wrap" style={{ alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6 }}
                title="역DNS 가 답한 이름을 정방향으로 다시 물어 그 IP 를 가리키는 수 / 확인한 수 — 확인 못 함(시한 · 예산)은 일치에도 불일치에도 넣지 않습니다. 묻는 곳은 스캔을 돌린 쪽의 DNS 입니다">
                <span className="muted">정방향 확인</span> <b>{recon.dns.match.toLocaleString()}</b><span className="muted">/ {(recon.dns.total - recon.dns.unknown).toLocaleString()}</span>
                {dnsSummaryParts(recon.dns).map((p) => <span key={p.key} className={`badge ${p.tone}`} style={{ fontSize: 10 }}>{p.label}</span>)}
              </span>
            )}
            {recon.macs.withMac > 0 && (
              <span className="flex gap wrap" style={{ alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6 }}
                title="스캔으로만 확인한 IP 중 MAC 을 아는 수 — 같은 서브넷은 스캐너 이웃 표(ARP), 다른 서브넷은 NetBIOS 가 답했을 때만 압니다">
                <span className="muted">MAC</span> <b>{recon.macs.withMac.toLocaleString()}</b><span className="muted">/ {recon.macs.total.toLocaleString()}</span>
                {scanMacSummaryParts(recon.macs).map((p) => <span key={p.key} className={`badge ${p.tone}`} style={{ fontSize: 10 }}>{p.label}</span>)}
              </span>
            )}
          </div>
          {/* v2.596(감사 PERFWEB-01 — 실측): 8,028행 전량을 DOM 에 그려 첫 로드에 메인 스레드가 12.5초 멈췄다. 정렬 뒤 상위 N행만
              그리고(DataTable limit — 정렬 뒤 자른다, v2.556 규약) 뺀 개수를 밝힌다. 검색·필터로 좁히면 전부 보인다. */}
          <DataTable columns={cols} rows={rows} initialSort={{ key: 'ip', dir: 'asc' }} limit={IPAM_ROW_LIMIT}
            footer={rows.length > IPAM_ROW_LIMIT ? `${rows.length.toLocaleString()}행 중 ${IPAM_ROW_LIMIT.toLocaleString()}행만 표시합니다 — 검색·필터로 좁히면 나머지도 보입니다(정렬은 전체 기준).` : null} />
        </>
      )}
      {db && (view === 'list' || view === 'sheet' || view === 'home') && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
          타 프로그램 공유용 DB: <code>{db.path}</code> ({db.kind === 'sqlite' ? 'SQLite · 테이블 ip_records' : 'NDJSON'})
          {' · '}갱신 {fmtDt(db.updatedAt)} · 수집 주기마다 자동 갱신됩니다.
        </div>
      )}
      {sel && <IpOwnerDetail row={sel} onClose={() => setSel(null)} />}
      {editMemo && <MemoEditor init={editMemo} onClose={() => setEditMemo(null)} onSaved={() => { setEditMemo(null); pickBase(base); }} />}
      {editOv && data && <OverrideEditor row={editOv} vcenters={data.byVcenter} tzOffsetMin={data.tzOffsetMin} onClose={() => setEditOv(null)} onSaved={() => { setEditOv(null); setReload((n) => n + 1); }} />}
      {exportOpen && <IpamExportModal scope={scope} scopeName={(data?.byVcenter || []).find((v) => v.vcenterId === scope)?.vcenterName || ''} subnetCount={subnetsErr ? NaN : subnets.length} onClose={() => setExportOpen(false)} />}
      {histIp && <IpHistoryModal row={histIp} scope={scope} onClose={() => setHistIp(null)}
        canManage={canManage} onEditName={data ? () => { const r = histIp; setHistIp(null); setEditOv(r); } : null}
        onEditMemo={() => { const r = histIp; setHistIp(null); setEditMemo({ ip: r.ip, memo: r.memo || '', tags: (r.tags || []).join(', ') }); }} />}
    </>
  );
}

/**
 * v2.991: 소유 자원(VM·호스트)이 없는 행의 '소유 자원' 칸. 스캔 행의 ownerName 은 호스트명(없으면 IP)이라 호스트명 칸과 겹친다 —
 *   스캔 행은 직접 넣은 라벨이 있을 때만 이름을 쓰고, 나머지는 담당자 · 열린 서비스만.
 */
function OwnerText({ r }) {
  const name = r.ownerType === 'scanned' ? (r.label || '') : (r.label || r.ownerName);
  const bits = [];
  if (r.owner_) bits.push(`👤${r.owner_}`);
  if ((r.services || []).length) bits.push((r.services || []).join(','));
  if (!name && !bits.length) return <span className="muted">—</span>;
  return <span>{name}{bits.length ? <span className="muted" style={{ fontSize: 11 }}>{name ? ' · ' : ''}{bits.join(' · ')}</span> : ''}</span>;
}

// v3.4.0: vCenter별 칩 줄(VcenterChips — 목록 · 서브넷 대장 위)은 지웠다 — 범위는 화면 위 고르기 하나, vCenter별 수는 '현황' 탭의 표.

/** IP 사용 이력 — 스캔으로 관측된 사용 시작(up)/해제(down) 전이 + 사용/미사용 구간. */
/**
 * IPAM 목록에서 IP/소유 자원 클릭 시 여는 상세 래퍼(v2.277 확정 버그 수정).
 * 배경: v2.253 목록 응답 다이어트로 /tools/ipam 의 VM 행은 owner 본문 없이 hasOwner 플래그만
 * 온다. 종전 코드는 <EntityDetail item={sel.owner}> 를 곧장 렌더해 item=undefined 로
 * ui.jsx `${item.name}` 에서 TypeError → ErrorBoundary 가 IP관리 탭 전체를 오류 화면으로
 * 갈아치웠다(스캔/수동 행의 owner=null 도 동일 크래시). IpHistoryModal 의 짝 수정과 같은
 * 패턴으로 — 모달을 연 시점에 /vms/lookup 으로 1건만 지연 조회한다(목록 비대화 방지 유지).
 */
function IpOwnerDetail({ row, onClose }) {
  const [owner, setOwner] = useState(row.owner || null);
  // ready=상세 표시 가능 · loading=지연 조회 중 · denied=권한 없음(403) · none=연결 자원 없음/조회 실패(크래시 대신 안내)
  const [state, setState] = useState(row.owner ? 'ready' : (needsLookup(row) ? 'loading' : 'none'));
  useEffect(() => {
    if (!needsLookup(row)) return undefined;
    let dead = false;
    // VM 이름(ownerName)도 함께 넘긴다(v2.287, 확정 버그 #16). 같은 vCenter 안에서 같은 IP 를
    // 여러 VM 이 주장하는 '중복 IP' 행은 ip 만으로 조회하면 스냅샷 순서상 첫 VM 이 와서, 클릭한
    // 행과 다른 VM 상세가 뜬다. 서버가 ip+name 을 함께 받으면 그 이름의 VM 을 우선 반환한다.
    // v2.744(GG-R3): 호스트 행도 owner 본문 없이 오므로 /hosts 로 1건을 가져온다(inv.hosts 게이트 — 없으면 403 → 권한 안내).
    lookupOwner(row)
      .then((o) => { if (!dead) { if (o) { setOwner(o); setState('ready'); } else setState('none'); } })
      .catch((e) => { if (!dead) setState(e?.status === 403 ? 'denied' : 'none'); });
    return () => { dead = true; };
  }, [row]);
  if (state === 'ready' && owner) return <EntityDetail type={row.ownerType || 'vm'} item={owner} onClose={onClose} />;
  return (
    <Modal title={`IP ${row.ip || ''} — 소유 자원`} onClose={onClose} width={440}>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
        {state === 'loading' ? '소유 자원 정보를 조회 중…' : state === 'denied' ? deniedText(row) : '이 IP에 연결된 자원 상세를 열 수 없습니다(미귀속 IP이거나 조회 실패).'}
        <div style={{ marginTop: 8 }}>
          {row.ownerName && <div>소유 자원: <b>{row.label || row.ownerName}</b></div>}
          {row.vcenterName && <div>센터: {row.vcenterName}</div>}
          {row.hostname && <div>호스트명: {row.hostname}</div>}
        </div>
      </div>
    </Modal>
  );
}

/**
 * v3.5.0(재설계 묶음 나 — 시안 ④ 상세 창): IP 상세 창의 '관리 정보' 묶음. 예전에는 관리상태 · 메모를 따로 여는 창이었다 — 여기서 값을 보고
 * 같은 창에서 편집으로 넘어간다(편집기 자체는 예전 것 — 저장 규칙 · 범위 판정은 서버가 그대로 한다).
 */
function MgmtBlock({ row, canManage, onEdit, onEditMemo }) {
  const kv = [
    ['관리상태', row.mgmtStatus ? <MgmtBadge s={row.mgmtStatus} /> : null],
    ['용도', row.ipPurpose], ['요청자', row.requester], ['할당자', row.assigner], ['담당', row.owner_],
    ['예약 만료', row.reservedUntil ? fmtDt(row.reservedUntil) : null], ['비고', row.note || row.notes],
    ['메모', row.memo], ['태그', (row.tags || []).length ? (row.tags || []).join(', ') : null],
  ].filter(([, v]) => v != null && v !== '');
  return (
    <div className="card" style={{ padding: 12, marginTop: 12, minWidth: 0 }}>
      <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: kv.length ? 8 : 0 }}>
        <b style={{ fontSize: 13 }}>관리 정보</b>
        {canManage && (
          <span className="flex gap" style={{ flexWrap: 'wrap' }}>
            {onEdit && <button className="logout-btn" style={{ padding: '5px 11px', fontSize: 12 }} onClick={onEdit}>관리 편집(용도 · 요청자 · 할당자 · 상태)</button>}
            {onEditMemo && <button className="logout-btn" style={{ padding: '5px 11px', fontSize: 12 }} onClick={onEditMemo}>메모 · 태그</button>}
          </span>
        )}
      </div>
      {kv.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>넣은 관리 정보가 없습니다{canManage ? ' — 관리 편집에서 용도 · 요청자 · 할당자를 넣을 수 있습니다' : ''}.</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', gap: '6px 10px', fontSize: 13 }}>
          {kv.map(([k, v]) => (
            <React.Fragment key={k}><span className="muted">{k}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span></React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function IpHistoryModal({ row, scope, onClose, canManage = false, onEditName = null, onEditMemo = null }) {
  const ip = row.ip;
  const [h, setH] = useState(undefined);
  const [scan, setScan] = useState(undefined); // v2.991: 그 IP 의 스캔 결과(방식별 호스트명) — undefined 조회 중 · null 없음
  const [showDetail, setShowDetail] = useState(false);
  // 목록(/tools/ipam) 응답 다이어트로 VM 행의 owner 는 목록에 실리지 않는다(hasOwner 플래그만).
  // 모달을 연 시점에 /vms/lookup 으로 1건만 지연 조회 — 목록이 수십 MB로 커지던 것의 짝 수정.
  const [owner, setOwner] = useState(row.owner || null);
  useEffect(() => {
    if (!needsLookup(row)) return undefined;
    let dead = false;
    // v2.744(GG-R3): 호스트 행도 지연 조회(/hosts). VM 은 예전처럼 ip(+vCenter)로 찾는다.
    const q = row.ownerType === 'vm' ? { ...row, ownerName: '', label: '' } : row;
    lookupOwner(q)
      .then((o) => { if (!dead && o) setOwner(o); })
      .catch(() => { /* 실패(403 포함) 시 상세 버튼만 미표시 — 원격 접속은 행의 IP 로 동작 */ });
    return () => { dead = true; };
  }, [ip]); // eslint-disable-line react-hooks/exhaustive-deps
  // VM 소유 IP면 그 VM 으로, 호스트·스캔 IP면 행의 IP 로 원격 접속 대상 구성(v2.744 GG-R2 — ipRemoteItem).
  const remoteItem = useMemo(() => ipRemoteItem(row, owner, scope), [row, owner, scope]);
  // v2.618(WEB-3): 조회 실패를 '이력 없음'(null)으로 삼키지 않는다 — 못 읽음은 없음이 아니다. 늦게 온 이전 IP 응답도 버린다.
  const [hErr, setHErr] = useState('');
  useEffect(() => {
    let active = true;
    setH(undefined); setHErr(''); setScan(undefined);
    fetchJson(`/tools/ipam/history?ip=${encodeURIComponent(ip)}`)
      .then((r) => { if (active) { setH(r.history || null); setScan(r.scan || null); } })
      .catch((e) => { if (active) { setHErr(e?.message || '조회 실패'); setH(null); setScan(null); } });
    return () => { active = false; };
  }, [ip]);
  const fmt = fmtDt; // v2.639(U7): 시각·소요는 ipamShared 한 벌(예전 이 모달만 브라우저 로케일 toLocaleString() · '분' 단위 소요)
  // v2.998.1: 기간은 periodText(ipamShared) — fmtDur 로 그리면 해제된 적 없는 IP 의 '총 미사용 기간' 이 '0ms' 였다(그런 구간이 없으면 '없음').
  const dur = (ms, count = 1) => periodText(Math.max(0, ms), count);
  // 이벤트(오래된→최신)로 사용(up)/미사용(down) 구간을 만든다. 마지막 구간은 현재까지.
  //   v2.991: 이름 변경(renames)은 events 와 따로 온다 — 구간 계산에는 넣지 않고 전이 기록 표에만 끼워 보인다.
  const evs = ((h?.events) || []).filter((e) => e && (e.type === 'up' || e.type === 'down'));
  const trans = [...evs, ...((h?.renames) || []).filter((x) => x && x.ts).map((x) => ({ ts: x.ts, type: 'rename', src: x.src, from: x.from, to: x.to }))]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const now = Date.now();
  const segs = evs.map((e, i) => ({ type: e.type, start: e.ts, end: i + 1 < evs.length ? evs[i + 1].ts : now, hostname: e.hostname }))
    .map((s) => ({ ...s, ms: Math.max(0, s.end - s.start) }));
  const usedMs = segs.filter((s) => s.type === 'up').reduce((a, s) => a + s.ms, 0);
  const idleMs = segs.filter((s) => s.type === 'down').reduce((a, s) => a + s.ms, 0);
  const upCount = segs.filter((s) => s.type === 'up').length;
  const downCount = segs.filter((s) => s.type === 'down').length;
  // v2.991: 호스트명은 위 '호스트명' 묶음(HostNameBlock — 방식별 결과)이 말한다(예전 '확인된 호스트명' 칸은 마지막 up 이벤트의 이름 하나였다).
  return (
    <Modal title={`IP 상세 — ${ip}`} onClose={onClose} width={640} resizable minWidth={440} minHeight={380}>
      {h !== undefined && !hErr && <HostNameBlock row={row} scan={scan} canManage={canManage} onEditName={onEditName} />}
      {h !== undefined && !hErr && <MacBlock scan={scan} />}
      {h === undefined ? <Loading /> : hErr ? <ErrorBox message={`IP 사용 이력을 읽지 못했습니다 — ${hErr}`} /> : !h ? (
        <div style={{ padding: 8 }}>
          <div className="muted" style={{ fontSize: 13 }}>이 IP의 스캔 이력이 아직 없습니다. IP 능동 스캔이 이 대역을 한 번 이상 관측하면, 확인 시점·호스트명·사용/미사용 기간이 여기에 쌓입니다.</div>
        </div>
      ) : (
        <>
          <div className="flex gap wrap" style={{ marginBottom: 12 }}>
            {[['현재 상태', h.status === 'up' ? <span className="badge green">사용 중</span> : <span className="badge amber">미사용(해제)</span>],
              ['확인 방식', <DiscoveryBadge d={row.discovery} />],
              ['최초 확인', fmt(h.firstSeen)], ['마지막 확인', fmt(h.lastSeen)],
              ['총 사용 기간', dur(usedMs, upCount)], ['총 미사용 기간', dur(idleMs, downCount)]].map(([k, v], i) => (
              <div key={i} style={{ minWidth: 150 }}><div className="muted" style={{ fontSize: 12 }}>{k}</div><div style={{ fontSize: 13, marginTop: 2 }}>{v}</div></div>
            ))}
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>사용 / 미사용 구간</div>
          <div className="table-wrap" style={{ marginBottom: 14 }}>
            <STable minWidth={480} wrap={false}>
              <thead><tr><th>구간</th><th>시작</th><th>종료</th><th style={{ textAlign: 'right' }}>기간</th></tr></thead>
              <tbody>
                {[...segs].reverse().map((s, i) => (
                  <tr key={i}>
                    <td>{s.type === 'up' ? <span className="badge green">사용</span> : <span className="badge amber">미사용</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.start)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{s.end >= now - 1000 ? '현재' : fmt(s.end)}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{dur(s.ms)}</td>
                  </tr>
                ))}
                {!segs.length && <tr><td colSpan={4} className="center muted" style={{ padding: 16 }}>구간 정보가 없습니다.</td></tr>}
              </tbody>
            </STable>
          </div>

          <div className="muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>전이 기록(확인 시점별)</div>
          <div className="table-wrap">
            <STable minWidth={480} wrap={false}>
              <thead><tr><th>시각</th><th>전이</th><th>호스트명</th><th>포트</th></tr></thead>
              <tbody>
                {[...trans].reverse().map((e, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }} data-sort={e.ts ?? ''}>{fmt(e.ts)}</td>
                    <td>{e.type === 'up' ? <span className="badge green">사용 시작</span> : e.type === 'rename' ? <span className="badge amber" title="같은 방식이 전과 다른 이름을 답했습니다">이름 변경</span> : <span className="badge amber">해제</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.type === 'rename'
                      ? <span><NameSrcBadge src={e.src} /> {e.from} → <b style={{ color: 'var(--text)' }}>{e.to}</b></span>
                      : (e.hostname || '—')}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{e.type === 'rename' ? '—' : ((e.ports || []).join(', ') || '—')}</td>
                  </tr>
                ))}
                {!trans.length && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>기록된 전이가 없습니다.</td></tr>}
              </tbody>
            </STable>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>※ 일정 시간(스캔 주기의 3배 또는 최소 3시간) 동안 응답이 없으면 '해제'로 기록됩니다.</div>
        </>
      )}
      {/* 하단: VM 정보 보기(소유 자원이 있을 때) + 원격 접속(SSH/RDP) — 기존 기능 재사용 */}
      <MgmtBlock row={row} canManage={canManage} onEdit={onEditName} onEditMemo={onEditMemo} />
      <div className="flex gap" style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {owner && <button className="logout-btn" style={{ padding: '8px 14px' }} onClick={() => setShowDetail(true)}>{row.ownerType === 'host' ? '🖥 호스트 정보 보기' : '🖥 VM 정보 보기'}</button>}
        <VmRemoteButton item={remoteItem} />
        {!owner && !row.hasOwner && <span className="muted" style={{ fontSize: 12 }}>스캔으로 확인된 IP — 원격 접속은 IP로 직접 연결합니다.</span>}
      </div>
      {showDetail && owner && <EntityDetail type={row.ownerType} item={owner} onClose={() => setShowDetail(false)} />}
    </Modal>
  );
}

/**
 * IPAM 추천 기능 30선 — 유명 IPAM 솔루션(phpIPAM·NetBox·SolarWinds·Infoblox 등)의 대표
 * 기능을 수집 데이터로 계산해 카드로 보여준다. 각 카드 클릭 시 상세 항목 펼침.
 */
function IpamInsights({ scope }) {
  const { loading, data, error } = useTool('/tools/ipam/insights', scope ? { vcenterId: scope } : {});
  const [open, setOpen] = useState(null); // 펼친 카드 key
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} />;
  const fmt = (n) => Number(n || 0).toLocaleString();
  const sevColor = { warn: 'var(--amber)', info: 'var(--accent-2, #38bdf8)' };
  const t = data.totals || {};
  const term = q.trim().toLowerCase();
  const feats = (data.features || []).filter((f) => !term || f.title.toLowerCase().includes(term) || (f.tool || '').toLowerCase().includes(term) || (f.detail || '').toLowerCase().includes(term));
  return (
    <>
      <div className="flex gap wrap" style={{ marginBottom: 12, alignItems: 'center' }}>
        <Card label="IP" value={fmt(t.ips)} meta={`서브넷 ${fmt(t.subnets)}개`} />
        <Card label="전체 사용률" value={`${t.overallUtil || 0}%`} meta={`사용 ${fmt(t.used)} / 용량 ${fmt(t.capacity)}`} accent="var(--amber)" />
        <Card label="스캔 커버리지" value={`${t.scannedCoverage || 0}%`} meta="vCenter 인식 중 스캔 확인" accent="var(--green)" />
        <SearchBox className="input" style={{ maxWidth: 240, alignSelf: 'center' }} placeholder="기능/솔루션 검색" value={q} onChange={setQ} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        업계 표준 IPAM 솔루션(phpIPAM · NetBox · SolarWinds IPAM · Infoblox · Device42 · ManageEngine OpUtils)의 대표 기능 <b>30선</b>을
        수집된 IP 대장으로 실시간 계산했습니다. 카드를 누르면 상세 항목이 펼쳐집니다.
      </div>
      <div className="vc-grid">
        {feats.map((f) => (
          <div key={f.key} className="card" style={{ cursor: (f.items?.length || f.dnsCheck?.rows?.length) ? 'pointer' : 'default', borderColor: f.severity === 'warn' ? 'var(--amber)' : undefined, minWidth: 0 }}
            onClick={() => (f.items?.length || f.dnsCheck?.rows?.length) && setOpen((o) => (o === f.key ? null : f.key))}>
            <div className="flex between" style={{ alignItems: 'baseline' }}>
              <b style={{ fontSize: 14 }}><span className="muted" style={{ fontSize: 12 }}>{String(f.n).padStart(2, '0')}.</span> {f.title}</b>
              <span style={{ fontSize: 15, fontWeight: 700, color: sevColor[f.severity] || 'var(--text)' }}>{f.value}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>{f.detail}</div>
            <div className="vc-foot"><span className="muted" style={{ fontSize: 11 }}>📚 {f.tool}</span>{(f.items?.length || f.dnsCheck?.rows?.length) ? <span className="muted" style={{ fontSize: 11 }}>{open === f.key ? '▲ 닫기' : `▼ 상세 ${(f.dnsCheck?.total || 0) + (f.items?.length || 0)}`}</span> : <span />}</div>
            {open === f.key && f.dnsCheck && <DnsCheckTable c={f.dnsCheck} />}
            {open === f.key && f.items?.length > 0 && (
              <div style={{ marginTop: 8, borderTop: '1px solid rgba(36,48,73,.5)', paddingTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {f.items.map((it, i) => (
                  <div key={i} className="flex between" style={{ fontSize: 12, padding: '3px 0' }}>
                    <span style={{ fontFamily: 'monospace' }}>{it.label}</span>
                    <span className="muted">{it.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * v3.2.0: 추천 › DNS 정합성 — 어긋난 IP(다른 IP · 정방향 없음)의 표. 카드 안에서 펼친다(클릭이 카드 접힘으로 새지 않게 막는다).
 *   대장이 아는 이름 = VM · 호스트 이름 또는 스캔 행이면 역DNS 가 아닌 방식(NetBIOS · mDNS · 수동)이 답한 이름.
 */
const KNOWN_SRC = { vm: 'VM', host: '호스트', netbios: 'NetBIOS', mdns: 'mDNS', manual: '수동' };
function DnsCheckTable({ c }) {
  const rows = Array.isArray(c?.rows) ? c.rows : [];
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid rgba(36,48,73,.5)', paddingTop: 8, cursor: 'default' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex gap wrap" style={{ gap: 6, marginBottom: 6 }}>
        {['match', 'other', 'none', 'unknown'].map((k) => <span key={k} className={`badge ${DNS_FWD[k].tone}`} style={{ fontSize: 10 }}>{DNS_FWD[k].label} {Number(c.counts?.[k] || 0).toLocaleString()}</span>)}
      </div>
      {rows.length > 0 && (
        // 표가 아니라 줄바꿈되는 행 — 카드는 격자 한 칸(1440px 에서도 약 370px)이라 6열 표는 정방향 주소 · 대장 이름이 가로 스크롤 밖으로 숨었다(Chromium 판독).
        <div role="list" aria-label="정방향 확인이 어긋난 IP" style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          {rows.map((x, i) => (
            <div role="listitem" key={x.ip} style={{ padding: '7px 10px', borderTop: i ? '1px solid rgba(36,48,73,.5)' : 'none', fontSize: 12, lineHeight: 1.55, minWidth: 0 }}>
              <div className="flex" style={{ flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2 }}>
                <span className={`badge ${DNS_FWD[x.v]?.tone || 'gray'}`} style={{ fontSize: 10, flex: 'none' }}>{DNS_FWD[x.v]?.label || x.v}</span>
                <b style={{ fontFamily: 'var(--mono)', flex: 'none' }}>{x.ip}</b>
                {x.known ? <span className="muted" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{x.known} ({KNOWN_SRC[x.knownSrc] || x.knownSrc})</span> : null}
              </div>
              <div style={{ overflowWrap: 'anywhere' }}>
                <span className="muted">역DNS</span> {x.ptr || '—'} <span className="muted">→ 정방향</span>{' '}
                {x.addrs?.length ? <span style={{ fontFamily: 'var(--mono)', color: 'var(--amber)' }}>{x.addrs.join(', ')}</span> : <span style={{ color: 'var(--amber)' }}>그런 이름 없음</span>}
                {x.at ? <span className="muted"> · {fmtDt(x.at)} 확인</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}
      {c.total > rows.length && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>어긋난 IP {Number(c.total).toLocaleString()}개 중 {rows.length.toLocaleString()}개 — 전부는 스캔 결과 CSV 의 dns_forward 열에 있습니다.</div>}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>스캐너가 쓰는 DNS 의 답입니다 — 안팎이 다른 DNS(분할 DNS)에서는 다른 곳의 답과 다를 수 있고, 운영체제 이름 풀이를 쓰므로 hosts 파일 항목도 섞입니다. 아래는 대장 이름으로 만든 레코드 초안입니다.</div>
    </div>
  );
}

/** v2.993(설계 bm-folders §13 ③): 스캔 이름을 어떻게 찾았나 — 역방향 DNS · 정방향 DNS(물리서버 이름으로 물어 이 IP) · 둘 다 · 서로 다름(둘 다 보인다). */
// 역방향 DNS 만으로 찾은 이름(예전부터의 기본)은 표지를 달지 않는다 — 스캔 행마다 같은 표지가 붙어 표가 시끄러워진다.
const NAME_VIA = { fwd: ['정방향 DNS', 'blue'], both: ['정방향 DNS 일치', 'gray'], differ: ['이름이 서로 다름', 'amber'] };
function NameVia({ r }) {
  const v = NAME_VIA[r?.nameVia];
  if (!v) return null;
  const title = r.nameVia === 'differ' ? `스캔이 찾은 이름 ${r.hostname} · 정방향 DNS 로 찾은 물리서버 이름 ${r.fwdName || ''} — 하나로 정하지 않습니다` : r.nameVia === 'fwd' ? '물리서버 이름(iDRAC 이 읽은 호스트 이름)을 DNS 에 물어 이 IP 가 나왔습니다' : r.nameVia === 'both' ? '스캔이 찾은 이름과 정방향 DNS 로 찾은 물리서버 이름이 같습니다' : undefined;
  return <span className={`badge ${v[1]}`} style={{ marginLeft: 6, fontSize: 10.5 }} title={title}>{v[0]}{r.nameVia === 'differ' && r.fwdName ? ` · ${r.fwdName}` : ''}</span>;
}

