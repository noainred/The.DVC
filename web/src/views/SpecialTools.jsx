// 특수 기능(SpecialTools) — 카드 그리드 셸 + 도구 패널 디스패처.
// v2.282.0 대형 파일 분할(2026-08-12): 5,070줄 단일 파일에서 도구 구현을 views/tools/ 로 분리했다.
// 이 파일은 목록/권한 게이트/딥링크/최근검색 셸과 ToolPanel 라우팅만 가진다.
// App.jsx(IpamStandalone)·Summary.jsx(GuestOsVmsModal) 호환을 위해 아래에서 재export 한다.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, usePolling, toolAllowed, can } from '../api.js';
import { SearchBox } from '../components/ui.jsx';
import { TOOLS } from './specialToolsList.js';
import { buildSections } from './toolSections.js'; // 카테고리 섹션 계산(v2.455, 순수)
import { searchTools } from './toolSearch.js'; // 도구 검색 매칭(v2.508, 순수 · V4 팔레트와 공용)


/**
 * v2.447(감사 T13): 도구 48개를 정적 import 하던 것을 **React.lazy** 로 바꿨다.
 * 실측으로 SpecialTools 청크가 893.8KB 단일 덩어리였고, 사용자는 '특수 기능' 탭을 열 때
 * 실제로 볼 도구 1개를 위해 48개 전부를 내려받았다. 이제 셸(카드 그리드·권한 게이트·딥링크)만
 * 즉시 로드하고 각 도구는 선택하는 순간 자기 청크를 받는다. ToolPanel 전체를 <Suspense> 로 감싼다.
 *
 * ⚠️ 파일 하단의 재export(IpamStandalone·GuestOsVmsModal)는 App.jsx·Summary.jsx 가 쓰므로
 * 정적으로 유지한다 — lazy 로 바꾸면 그 두 화면이 깨진다.
 */
const Topology3D = React.lazy(() => import('./Topology3D.jsx'));
const NetTrafficAnalysis = React.lazy(() => import('./NetTrafficAnalysis.jsx'));
const DeepSearch = React.lazy(() => import('./DeepSearch.jsx'));
const VmProvision = React.lazy(() => import('./VmProvision.jsx'));
const AgentScans = React.lazy(() => import('./AgentScans.jsx'));
const SvcMonConfig = React.lazy(() => import('./SvcMonConfig.jsx'));
const NsxAdmin = React.lazy(() => import('./Nsx.jsx'));
const Explore = React.lazy(() => import('./Explore.jsx'));
const CapacityAdvisor = React.lazy(() => import('./CapacityAdvisor.jsx'));
const LoginFails = React.lazy(() => import('./LoginFails.jsx'));
const NetIssues = React.lazy(() => import('./NetIssues.jsx'));
const SecretScanTool = React.lazy(() => import('./tools/SecretScanTool.jsx'));
const CodexCheck = React.lazy(() => import('./CodexCheck.jsx'));
const VmCloneTool = React.lazy(() => import('./tools/VmCloneTool.jsx'));
const StorageMonTool = React.lazy(() => import('./tools/StorageMonTool.jsx'));
const StorageGrowthTool = React.lazy(() => import('./tools/StorageGrowthTool.jsx'));
const PartFaults = React.lazy(() => import('./tools/PartFaults.jsx'));   // 파트 장애(v2.547)
const EdgeLog = React.lazy(() => import('./tools/EdgeLog.jsx'));         // 엣지 로그·진행상태(v2.549)
const BmStorageTool = React.lazy(() => import('./tools/BmStorageTool.jsx'));
const SanSwitchTool = React.lazy(() => import('./tools/SanSwitchTool.jsx'));
const PduTool = React.lazy(() => import('./tools/PduTool.jsx'));
const RemoteCommand = React.lazy(() => import('./tools/RemoteCommand.jsx'));
const CredentialManager = React.lazy(() => import('./tools/CredentialManager.jsx'));
const RelayCheckTool = React.lazy(() => import('./tools/RelayCheckTool.jsx'));
const RelayTopoTool = React.lazy(() => import('./tools/RelayTopoTool.jsx'));
const SerialLookup = React.lazy(() => import('./tools/SerialLookup.jsx'));
const VmTrackTool = React.lazy(() => import('./tools/VmTrackTool.jsx'));
const GuestDiskReport = React.lazy(() => import('./tools/GuestDiskReport.jsx'));
const StorageTrackTool = React.lazy(() => import('./tools/StorageTrackTool.jsx'));
const ServiceCheck = React.lazy(() => import('./DavinciChecks.jsx').then((m) => ({ default: m.ServiceCheck })));
const NetworkCheck = React.lazy(() => import('./DavinciChecks.jsx').then((m) => ({ default: m.NetworkCheck })));
const VmwareConfigBackup = React.lazy(() => import('./DavinciChecks.jsx').then((m) => ({ default: m.VmwareConfigBackup })));
const DailyHealth = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.DailyHealth })));
const SnapshotAge = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.SnapshotAge })));
const ZombieVms = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.ZombieVms })));
const CertExpiry = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.CertExpiry })));
const Rightsizing = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.Rightsizing })));
const CapacityForecast = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.CapacityForecast })));
const AlertChannels = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.AlertChannels })));
const ComplianceReport = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.ComplianceReport })));
const ChangeHistory = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.ChangeHistory })));
const UnprotectedVms = React.lazy(() => import('./ToolsReports.jsx').then((m) => ({ default: m.UnprotectedVms })));
const AiSearch = React.lazy(() => import('./tools/AiSearch.jsx').then((m) => ({ default: m.AiSearch })));
const VmExport = React.lazy(() => import('./tools/VmExport.jsx').then((m) => ({ default: m.VmExport })));
const Insights = React.lazy(() => import('./tools/InsightsThreats.jsx').then((m) => ({ default: m.Insights })));
const Threats = React.lazy(() => import('./tools/InsightsThreats.jsx').then((m) => ({ default: m.Threats })));
const Esxi = React.lazy(() => import('./tools/HardwareTools.jsx').then((m) => ({ default: m.Esxi })));
const Hardware = React.lazy(() => import('./tools/HardwareTools.jsx').then((m) => ({ default: m.Hardware })));
const Hba = React.lazy(() => import('./tools/HardwareTools.jsx').then((m) => ({ default: m.Hba })));
const ServerAnalysis = React.lazy(() => import('./tools/HardwareTools.jsx').then((m) => ({ default: m.ServerAnalysis })));
const VcVersion = React.lazy(() => import('./tools/HardwareTools.jsx').then((m) => ({ default: m.VcVersion })));
const PortalDb = React.lazy(() => import('./tools/PortalDb.jsx').then((m) => ({ default: m.PortalDb })));
const DirUsageReport = React.lazy(() => import('./tools/DirUsageReport.jsx').then((m) => ({ default: m.DirUsageReport })));
const MailDiag = React.lazy(() => import('./tools/MailDiag.jsx').then((m) => ({ default: m.MailDiag })));
const RoomTemp = React.lazy(() => import('./tools/RoomTemp.jsx').then((m) => ({ default: m.RoomTemp })));
const NicModels = React.lazy(() => import('./tools/NicTools.jsx').then((m) => ({ default: m.NicModels })));
const NicSpeed = React.lazy(() => import('./tools/NicTools.jsx').then((m) => ({ default: m.NicSpeed })));
const Shutdown = React.lazy(() => import('./tools/ShutdownTool.jsx').then((m) => ({ default: m.Shutdown })));
const FleetInventory = React.lazy(() => import('./tools/FleetInventory.jsx').then((m) => ({ default: m.FleetInventory })));
const Capacity = React.lazy(() => import('./tools/CapacityTools.jsx').then((m) => ({ default: m.Capacity })));
const EsxiTemp = React.lazy(() => import('./tools/CapacityTools.jsx').then((m) => ({ default: m.EsxiTemp })));
const Forecast = React.lazy(() => import('./tools/CapacityTools.jsx').then((m) => ({ default: m.Forecast })));
const ThinVms = React.lazy(() => import('./tools/CapacityTools.jsx').then((m) => ({ default: m.ThinVms })));
// v2.505 고아 VMDK 찾기 — 라이브 데이터스토어 탐색이라 전용 청크로 lazy 로드한다.
const OrphanVmdk = React.lazy(() => import('./tools/OrphanVmdk.jsx').then((m) => ({ default: m.OrphanVmdk })));
const CurrentUsers = React.lazy(() => import('./tools/CurrentUsers.jsx').then((m) => ({ default: m.CurrentUsers })));
const Waste = React.lazy(() => import('./tools/CapacityTools.jsx').then((m) => ({ default: m.Waste })));
const VmFinder = React.lazy(() => import('./tools/VmFinderTool.jsx').then((m) => ({ default: m.VmFinder })));
const GuestOs = React.lazy(() => import('./tools/GuestOsTools.jsx').then((m) => ({ default: m.GuestOs })));
const RealOs = React.lazy(() => import('./tools/GuestOsTools.jsx').then((m) => ({ default: m.RealOs })));
const PowerMap = React.lazy(() => import('./tools/PowerMap.jsx').then((m) => ({ default: m.PowerMap })));
const DupIp = React.lazy(() => import('./tools/VmInfoTools.jsx').then((m) => ({ default: m.DupIp })));
const Snapshots = React.lazy(() => import('./tools/VmInfoTools.jsx').then((m) => ({ default: m.Snapshots })));
const VmTools = React.lazy(() => import('./tools/VmInfoTools.jsx').then((m) => ({ default: m.VmTools })));
const DatastoreUsage = React.lazy(() => import('./tools/DatastoreUsage.jsx').then((m) => ({ default: m.DatastoreUsage })));
const LicenseExpiry = React.lazy(() => import('./tools/LicenseTools.jsx').then((m) => ({ default: m.LicenseExpiry })));
const Licenses = React.lazy(() => import('./tools/LicenseTools.jsx').then((m) => ({ default: m.Licenses })));
const Solutions = React.lazy(() => import('./tools/LicenseTools.jsx').then((m) => ({ default: m.Solutions })));
const Gpu = React.lazy(() => import('./tools/GpuTool.jsx').then((m) => ({ default: m.Gpu })));


// URL 해시(#/tools/<기능키>)에서 현재 도구 키를 읽는다(바로가기/북마크 지원).
const toolFromHash = () => {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const k = parts[0] === 'tools' ? parts[1] : '';
  // 외부 포탈 항목은 이 앱에 패널이 없다 — 딥링크로 들어와도 목록을 보여준다.
  // topTab(상단 메뉴로 승격된 항목)도 여기에는 패널이 없다(권한 매트릭스용으로만 목록에 남음).
  return TOOLS.some((t) => t.k === k && !t.external && !t.topTab) ? k : null;
};

// 최근 검색어(브라우저 로컬) — 특수 기능 '메뉴 빠른 찾기'에서 Enter 또는 검색 중 메뉴 클릭 시 기록.
const RECENT_KEY = 'tools.recentSearches';
const loadRecent = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()) : []; } catch { return []; } };

export default function SpecialTools() {
  const [tool, setTool] = useState(() => toolFromHash());
  const [menuQ, setMenuQ] = useState(''); // 메뉴 빠른 찾기
  const [isAdmin, setIsAdmin] = useState(false); // 관리자 전용 도구(VM 생성 등) 노출 제어
  // 외부 포탈 주소(서버 env SERVICE_HUB_URL). 인증 후에만 내려오며, 없으면 카드도 숨긴다.
  const [externalUrls, setExternalUrls] = useState({});
  const [topKeys, setTopKeys] = useState([]); // 자주 쓰는 기능(전체 사용자 합산 상위)
  // 메뉴 그리드 너비 측정용(v2.508) — ref 콜백으로 '지금 떠 있는' 그리드를 잡는다.
  // useRef 로 단일 그리드에만 달려 있던 동안에는 **카테고리 모드에서 측정 대상이 없어**
  // '자주 쓰는 기능' 칸 수(favCount)가 갱신되지 않았다. 상태로 두어야 그리드가 바뀔 때
  // 효과가 다시 돌아 ResizeObserver 를 새 노드에 붙인다.
  const [gridEl, setGridEl] = useState(null);
  const [favCount, setFavCount] = useState(4); // 한 줄에 들어가는 카드 수(화면폭 자동, 기본 4)
  const [recent, setRecent] = useState(loadRecent); // 최근 검색어(최신순, 1줄 표시)
  // 카테고리 설정(v2.455) — 카드(78장)를 섹션으로 나눈다. 미설정/실패면 기존 단일 그리드 그대로.
  const [cats, setCats] = useState(null);
  const [openCats, setOpenCats] = useState({});
  const addRecent = (q) => {
    const t = String(q || '').trim();
    if (!t) return;
    setRecent((prev) => {
      const next = [t, ...prev.filter((s) => s.toLowerCase() !== t.toLowerCase())].slice(0, 15);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 저장 실패 무시 */ }
      return next;
    });
  };
  const clearRecent = () => { setRecent([]); try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ } };
  // 기능 실행 시 사용 횟수를 중앙에 기록(자주 쓰는 메뉴 자동 추천용). 실패는 조용히 무시.
  const openTool = (k) => {
    const ext = TOOLS.find((t) => t.k === k && t.external);
    if (ext) {
      // 외부 포탈은 새 탭으로. noopener 로 원본 탭 참조를 넘기지 않는다.
      postJson('/tool-usage', { k }).catch(() => {});
      window.open(externalUrls[ext.external], '_blank', 'noopener,noreferrer');
      return;
    }
    if (k) postJson('/tool-usage', { k }).catch(() => {});
    if (k) addRecent(menuQ); // 검색 중에 메뉴를 열면 그 검색어를 최근 검색어로 기록
    setTool(k); window.location.hash = k ? `#/tools/${k}` : '#/tools';
  };
  // 뒤로/앞으로 가기 및 외부에서 바로가기로 진입할 때 동기화.
  // 카테고리 설정을 한 번만 읽는다(자주 바뀌지 않는다). 실패는 무시 — 섹션 없이 기존대로 그린다.
  useEffect(() => {
    let alive = true;
    fetchJson('/admin/tool-categories')
      .then((r) => {
        if (!alive) return;
        setCats(r?.settings || null);
        // '첫 카테고리만 펼치기' 설정이면 나머지를 접은 상태로 시작한다.
        if (r?.settings?.collapseOthers) {
          const o = {};
          (r.settings.categories || []).forEach((c, idx) => { o[c.id] = idx === 0; });
          o._uncategorized = false;
          setOpenCats(o);
        }
      })
      .catch(() => { /* 카테고리는 편의 기능이다 — 못 읽어도 화면은 동작해야 한다 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onHash = () => setTool(toolFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    fetchJson('/auth/me').then((r) => {
      setIsAdmin(r.user?.role === 'admin');
      setExternalUrls({ serviceHubUrl: r.user?.serviceHubUrl || '' });
    }).catch(() => {});
  }, []);
  // 그리드(메뉴 목록)로 돌아올 때마다 사용 횟수를 갱신. 전체 메뉴를 클릭순으로 정렬하므로
  // 상위 몇 개가 아니라 전체 도구 수를 덮을 만큼 넉넉히 가져온다(현재 42개 → 200).
  useEffect(() => {
    if (tool) return;
    fetchJson('/tool-usage/top', { n: 200 }).then((r) => setTopKeys(r.top || [])).catch(() => {});
  }, [tool]);
  // '자주 쓰는 기능' 카드 수를 메뉴 그리드 한 줄에 들어가는 칸 수에 맞춘다(화면폭 자동, vc-grid=minmax 330px·gap 16px).
  useEffect(() => {
    if (tool || !gridEl) return undefined;
    const calc = () => {
      const w = gridEl.clientWidth || gridEl.offsetWidth || 0;
      setFavCount(Math.max(1, Math.floor((w + 16) / (330 + 16))));
    };
    calc();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(calc) : null;
    if (ro) ro.observe(gridEl);
    window.addEventListener('resize', calc);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [tool, gridEl]);
  // 도구 잠금 사유 — 접근 가능하면 null. 특수 기능은 항목이 많아 '숨김'보다 '회색 잠금'이 낫다:
  // 어떤 기능이 있는지는 보이고, 권한이 없으면 클릭만 막아 관리자에게 요청할 수 있게 한다.
  const lockReasonOf = (t) => {
    if (!t) return '알 수 없는 기능입니다.';
    if (t.adminOnly && !isAdmin) return '관리자(admin) 전용 기능입니다.';
    // 기능별 권한(예: NSX=inv.nsx) — 상단 메뉴에서 이동한 도구의 접근 경계를 그대로 보존한다.
    if (t.perm && !can(t.perm)) return '이 기능에 대한 접근 권한이 없습니다 — 관리자에게 요청하세요(설정 › 사용자 관리 › 권한).';
    if (!toolAllowed(t.k)) return '이 기능에 대한 접근 권한이 없습니다 — 관리자에게 요청하세요(설정 › 사용자 관리 › 특수 기능 도구별 접근).';
    return null;
  };
  // 접근 가능 여부(딥링크 가드 공통).
  const canOpenTool = (k) => !lockReasonOf(TOOLS.find((x) => x.k === k));
  // 딥링크(#/tools/<k>)로 권한 없는 도구를 열면 접근 차단 안내(서버 엔드포인트도 별도 강제됨).
  if (tool && !canOpenTool(tool)) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>이 기능에 대한 접근 권한이 없습니다.</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>관리자에게 권한(설정 › 사용자 관리 › 기능 권한)을 요청하세요.</div>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => openTool(null)}>목록으로</button>
      </div>
    );
  }
  if (tool) return <ToolPanel tool={tool} isAdmin={isAdmin} onBack={() => openTool(null)} />;
  // 전 도구를 노출하되, 권한이 없으면 disabled(회색·클릭불가)로 표시한다(숨기지 않음).
  // 외부 포탈 항목은 주소가 설정된 경우에만 노출한다(미설치 환경에 죽은 카드를 남기지 않음).
  // topTab(상단 메뉴로 승격) 항목은 카드로 노출하지 않는다(권한 매트릭스 편집용으로만 목록에 존재).
  const base = TOOLS.filter((t) => !t.topTab).filter((t) => !t.external || externalUrls[t.external]).map((t) => {
    const lock = lockReasonOf(t);
    return lock ? { ...t, disabled: true, comingSoon: false, lockReason: lock } : t;
  });
  // 카테고리 설정(v2.455) — 카드(78장)를 섹션으로 나눈다. 실패해도 화면은 기존대로 그린다.
  // ⚠ 훅은 조기 return 위 최상단에 있어야 한다(React #310) — 이 컴포넌트는 아래에서 return 하므로 안전.
  const ql = menuQ.trim().toLowerCase();
  // 검색 매칭은 공용 규칙(v2.508, toolSearch.js) — 라벨·설명뿐 아니라 **키**(gpu·ipam·rma)와
  // **분류명**, **구 명칭 별칭**(aka)까지 본다. V4 커맨드 팔레트가 같은 모듈을 쓴다.
  const catLabelsOf = (t) => (cats?.categories || [])
    .filter((c) => c && c.enabled !== false && (c.tools || []).includes(t.k))
    .map((c) => c.label || '');
  const shown = searchTools(base, ql, { catsOf: catLabelsOf });
  // 상위 키를 실제 도구로 매핑(노출 불가/비활성은 제외). 검색 중에는 추천을 숨긴다.
  const countOf = new Map(topKeys.map((u) => [u.k, u.count]));
  const favorites = ql ? [] : topKeys
    .map((u) => ({ ...base.find((t) => t.k === u.k), count: u.count }))
    .filter((t) => t && t.k && !t.disabled)
    .slice(0, favCount); // 한 줄에 들어가는 만큼만(화면폭 자동)
  // 전체 메뉴를 클릭(사용) 많은 순으로 정렬한다. 동점·미사용(0회)은 원래 순서를 유지(안정 정렬).
  // 비활성(준비 중) 카드는 항상 맨 뒤로 보낸다.
  const shownSorted = shown.slice().sort((a, b) =>
    (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || (countOf.get(b.k) || 0) - (countOf.get(a.k) || 0));

  // 카테고리 섹션. 검색 중에는 섹션을 나누지 않는다 — 찾는 중에 여러 섹션에 흩어지면 오히려 느리다
  // (중복 소속이라 같은 카드가 두 번 나오기도 한다).
  const sections = ql ? [] : buildSections(cats, shownSorted.map((t) => t.k));
  const byKey = new Map(shownSorted.map((t) => [t.k, t]));
  const card = (t, sectionId) => renderToolCard(t, sectionId, { countOf, externalUrls, openTool });

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🛠️ 특수 기능</div>
      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: recent.length ? 6 : 14 }}>
        <div className="muted" style={{ fontSize: 13 }}>아래 기능을 클릭하면 해당 진단을 실행해 보여줍니다. <b>🔒 회색 카드</b>는 접근 권한이 없어 클릭할 수 없습니다.</div>
        <SearchBox className="input" style={{ maxWidth: 280 }} placeholder="메뉴 빠른 찾기 (예: G, GPU, IP)" value={menuQ} onChange={setMenuQ}
          onKeyDown={(e) => { if (e.key === 'Enter') addRecent(e.target.value); }} />
      </div>
      {recent.length > 0 && (
        // 최근 검색어 — 정확히 1줄만: nowrap + overflow hidden으로 화면 폭에 들어가는 만큼만 표시.
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexWrap: 'nowrap', minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>🕘 최근 검색:</span>
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {recent.map((q) => (
              <button key={q} className="tab" style={{ padding: '3px 10px', fontSize: 12, flexShrink: 0, background: menuQ === q ? 'rgba(34,211,238,.15)' : undefined }}
                onClick={() => setMenuQ(menuQ === q ? '' : q)} title={`"${q}" 다시 검색 (다시 클릭하면 해제)`}>
                {q}
              </button>
            ))}
          </div>
          <button className="tab" style={{ padding: '3px 8px', fontSize: 11, flexShrink: 0, opacity: 0.6 }} onClick={clearRecent} title="최근 검색어 전체 지우기">✕ 지우기</button>
        </div>
      )}
      {favorites.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            ⭐ 자주 쓰는 기능 <span style={{ fontWeight: 400 }}>· 전체 사용자가 가장 많이 연 메뉴</span>
          </div>
          <div className="vc-grid">
            {favorites.map((t, i) => (
              <div key={t.k} className="card vc-card"
                style={{ cursor: 'pointer', borderColor: 'var(--accent, #6aa9ff)', ...(t.danger ? { borderColor: 'var(--red)' } : {}) }}
                onClick={() => openTool(t.k)}
                title={`바로가기: #/tools/${t.k}`}>
                <div className="flex between" style={{ alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 30 }}>{t.icon}</div>
                  <span className="badge" style={{ fontSize: 11 }}>{['🥇', '🥈', '🥉'][i] || `#${i + 1}`} {t.count}회</span>
                </div>
                <div className="vc-name" style={{ marginTop: 8, ...(t.danger ? { color: 'var(--red)' } : {}) }}>{t.label}</div>
                <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.desc}</div>
                <div className="vc-foot"><span className="muted">클릭하여 실행</span><span className="muted">→</span></div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        📋 전체 메뉴 <span style={{ fontWeight: 400 }}>· {sections.length ? '카테고리별' : '클릭(사용) 많은 순 정렬'}</span>
      </div>

      {/* 카테고리 사용 시: 섹션별로 나눠 그린다. 같은 도구가 여러 섹션에 나오는 것은 정상이다(중복 소속). */}
      {sections.length > 0 && sections.map((sec, secIdx) => {
        const open = openCats[sec.id] !== false;
        return (
          <div key={sec.id} style={{ marginBottom: 18 }}>
            <button className="tab" onClick={() => setOpenCats((o) => ({ ...o, [sec.id]: !open }))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '7px 12px', marginBottom: open ? 10 : 0, fontSize: 13, fontWeight: 600,
                background: 'rgba(255,255,255,.04)' }}
              title={open ? '접기' : '펼치기'}>
              <span style={{ fontSize: 15 }}>{sec.icon}</span>
              <span>{sec.label}</span>
              <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{sec.tools.length}개</span>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div className="vc-grid" ref={secIdx === 0 ? setGridEl : undefined}>
                {sec.tools.map((k) => byKey.get(k)).filter(Boolean).map((t) => card(t, sec.id))}
              </div>
            )}
          </div>
        );
      })}

      {sections.length === 0 && (
      // 카드 1장의 모양은 renderToolCard 하나가 소유한다(v2.508) — 예전에는 이 자리에 같은 JSX 가
      // 인라인으로 복제돼 있어 한쪽만 고치면 두 모드의 카드가 어긋났다.
      <div className="vc-grid" ref={setGridEl}>
        {shown.length === 0 && <div className="muted" style={{ gridColumn: '1 / -1', padding: 24 }}>“{menuQ}”에 해당하는 메뉴가 없습니다.</div>}
        {shownSorted.map((t) => card(t, null))}
      </div>
      )}
    </>
  );
}

/**
 * 카드 1장 — 섹션 렌더와 기존 단일 그리드가 같은 모양을 쓰도록 함수로 뽑았다.
 * 중복 소속이면 같은 도구가 여러 섹션에 나오므로 key 에 섹션 id 를 섞는다(React key 충돌 방지).
 */
function renderToolCard(t, sectionId, { countOf, externalUrls, openTool }) {
  return (
    <div key={sectionId ? `${sectionId}:${t.k}` : t.k} className="card vc-card"
      style={{
        cursor: t.disabled ? 'not-allowed' : 'pointer',
        opacity: t.disabled ? 0.5 : 1,
        ...(t.danger && !t.disabled ? { borderColor: 'var(--red)' } : {}),
      }}
      onClick={t.disabled ? undefined : () => openTool(t.k)}
      title={t.lockReason || (t.disabled ? (t.comingSoon ? '준비 중 (곧 제공)' : '비활성화됨')
        : t.external ? `새 탭으로 열기: ${externalUrls[t.external]}` : `바로가기: #/tools/${t.k}`)}>
      <div className="flex between" style={{ alignItems: 'flex-start' }}>
        <div style={{ fontSize: 30, filter: t.disabled ? 'grayscale(1)' : 'none' }}>{t.icon}</div>
        {t.lockReason
          ? <span className="badge gray" style={{ fontSize: 11 }} title={t.lockReason}>🔒 권한 없음</span>
          : countOf.get(t.k) > 0 && <span className="badge gray" style={{ fontSize: 11 }} title="전체 사용자 누적 실행 횟수">{countOf.get(t.k)}회</span>}
      </div>
      <div className="vc-name" style={{ marginTop: 8, ...(t.danger && !t.disabled ? { color: 'var(--red)' } : {}) }}>{t.label}</div>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{t.desc}</div>
      <div className="vc-foot">
        <span className="muted">{t.lockReason ? (t.adminOnly ? '관리자 전용' : '접근 권한 없음') : t.disabled ? (t.comingSoon ? '준비 중' : '비활성화됨') : t.external ? '새 탭으로 열기' : '클릭하여 실행'}</span>
        <span className="muted">{t.disabled ? '' : t.external ? '↗' : '→'}</span>
      </div>
    </div>
  );
}

function ToolPanel({ tool, onBack, isAdmin }) {
  const meta = TOOLS.find((t) => t.k === tool);
  const [scope, setScope] = useState('');
  // v2.491: vCenter 아래 하위 범위 — 클러스터/폴더. vCenter 를 고른 뒤에만 쓴다(클러스터 이름은
  // vCenter 간 중복될 수 있어, 전체 범위에서 이름으로 거르면 다른 사이트 VM 까지 섞인다).
  const [cluster, setCluster] = useState('');
  const [folder, setFolder] = useState('');
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const scoped = ['vm-export', 'dupip', 'vmtools', 'snapshots', 'hba', 'gpu', 'licenses', 'license-expiry', 'esxi', 'hardware', 'powermap', 'guestos', 'real-os', 'thinvms', 'guest-disk', 'capacity', 'waste', 'esxitemp', 'forecast', 'dsusage', 'orphanvmdk', 'curuser',
    'daily-health', 'snapshot-age', 'zombie-vms', 'rightsizing', 'capacity-forecast', 'compliance-report', 'change-history', 'unprotected-vms'].includes(tool);

  // v2.491: 클러스터·폴더 콤보를 지원하는(= 서버가 cluster/folder 쿼리를 실제로 거르는) 도구만.
  // 여기에 도구를 추가하려면 그 라우트가 groupFilter.js 의 필터를 적용해야 한다 — 화면에만 콤보를
  // 띄우고 서버가 무시하면 '아무 일도 안 하는 필터' 가 된다.
  const groupScoped = ['waste'].includes(tool);
  // 목록은 선택한 vCenter 기준(전체에서는 조회하지 않는다). 5분 주기 — 인벤토리 구조는 자주 안 바뀐다.
  const { data: groups } = usePolling(groupScoped && scope ? '/tools/groups' : '', scope ? { vcenterId: scope } : {}, 300_000);
  const clusterList = groups?.clusters || [];
  const folderList = groups?.folders || [];

  // v2.447(감사 T13): 도구가 lazy 라 로딩 중 폴백이 필요하다. 셸(뒤로가기·스코프 선택)은 이미
  // 그려진 상태이므로 폴백은 패널 영역만 차지한다(화면 전체가 접히지 않게).
  return (
    <React.Suspense fallback={<div className="card" style={{ padding: 20, textAlign: 'center' }}><span className="muted">도구를 불러오는 중…</span></div>}>
    <>
      <div className="flex wrap" style={{ marginBottom: 12, alignItems: 'center', gap: 12 }}>
        <button className="tab" onClick={onBack}>← 특수 기능</button>
        <div className="section-title" style={{ margin: 0 }}>{meta.icon} {meta.label}</div>
        {scoped && (
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">범위</span>
            <select className="select" value={scope} onChange={(e) => { setScope(e.target.value); setCluster(''); setFolder(''); }}>
              <option value="">전체 vCenter</option>
              {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
        )}
        {scoped && groupScoped && (
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">클러스터</span>
            <select className="select" style={{ maxWidth: 230 }} value={cluster} disabled={!scope}
              title={!scope ? 'vCenter 를 먼저 선택하세요(클러스터 이름은 vCenter 간 중복될 수 있습니다).' : ''}
              onChange={(e) => setCluster(e.target.value)}>
              <option value="">{scope ? '전체 클러스터' : 'vCenter 선택 후'}</option>
              {clusterList.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.vms} VM · 호스트 {c.hosts})</option>)}
            </select>
          </label>
        )}
        {scoped && groupScoped && (
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">폴더</span>
            <select className="select" style={{ maxWidth: 230 }} value={folder} disabled={!scope || !folderList.length}
              title={!scope ? 'vCenter 를 먼저 선택하세요.' : !folderList.length ? '이 vCenter 는 폴더 정보가 수집되지 않았습니다(SOAP 수집 경로에서만 채워짐).' : ''}
              onChange={(e) => setFolder(e.target.value)}>
              <option value="">{!scope ? 'vCenter 선택 후' : !folderList.length ? '폴더 정보 없음' : '전체 폴더'}</option>
              {folderList.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.vms} VM)</option>)}
            </select>
          </label>
        )}
      </div>
      {tool === 'aisearch' && <AiSearch />}
      {tool === 'explore' && <Explore />}
      {tool === 'insights' && <Insights scope={scope} />}
      {tool === 'threats' && <Threats scope={scope} />}
      {tool === 'secret-scan' && <SecretScanTool />}
      {tool === 'codex-check' && <CodexCheck />}
      {tool === 'vm-clone' && <VmCloneTool />}
      {tool === 'storage-mon' && <StorageMonTool />}
      {tool === 'storage-growth' && <StorageGrowthTool />}
      {tool === 'part-faults' && <PartFaults />}
      {tool === 'edge-log' && <EdgeLog />}
      {tool === 'bm-storage' && <BmStorageTool />}
      {tool === 'san-switch' && <SanSwitchTool />}
      {tool === 'pdu' && <PduTool />}
      {tool === 'rma' && <RemoteCommand />}
      {tool === 'credentials' && <CredentialManager />}
      {tool === 'relaycheck' && <RelayCheckTool />}
      {tool === 'relaytopo' && <RelayTopoTool />}
      {tool === 'serial-lookup' && <SerialLookup />}
      {tool === 'vm-track' && <VmTrackTool />}
      {tool === 'guest-disk' && <GuestDiskReport scope={scope} />}
      {tool === 'storage-track' && <StorageTrackTool />}
      {tool === 'vmfinder' && <VmFinder />}
      {tool === 'capacity' && <Capacity scope={scope} />}
      {tool === 'waste' && <Waste scope={scope} cluster={scope ? cluster : ''} folder={scope ? folder : ''} />}
      {tool === 'esxitemp' && <EsxiTemp scope={scope} />}
      {tool === 'forecast' && <Forecast scope={scope} />}
      {tool === 'dsusage' && <DatastoreUsage scope={scope} />}
      {tool === 'guestos' && <GuestOs scope={scope} />}
      {tool === 'real-os' && <RealOs scope={scope} />}
      {tool === 'thinvms' && <ThinVms scope={scope} />}
      {tool === 'vm-export' && <VmExport scope={scope} />}
      {tool === 'dupip' && <DupIp scope={scope} />}
      {tool === 'vmtools' && <VmTools scope={scope} />}
      {tool === 'snapshots' && <Snapshots scope={scope} />}
      {tool === 'daily-health' && <DailyHealth scope={scope} isAdmin={isAdmin} />}
      {tool === 'snapshot-age' && <SnapshotAge scope={scope} />}
      {tool === 'zombie-vms' && <ZombieVms scope={scope} />}
      {tool === 'cert-expiry' && <CertExpiry isAdmin={isAdmin} />}
      {tool === 'rightsizing' && <Rightsizing scope={scope} />}
      {tool === 'capacity-forecast' && <CapacityForecast scope={scope} />}
      {tool === 'alert-channels' && <AlertChannels isAdmin={isAdmin} />}
      {/* scope(vCenter 필터)를 넘기지 않는다 — 성능점검 대상은 vCenter 인벤토리와 무관하다(cleanTarget 에 vcenterId 가 없다). */}
      {tool === 'svcmon-config' && <SvcMonConfig />}
      {tool === 'compliance-report' && <ComplianceReport scope={scope} />}
      {tool === 'change-history' && <ChangeHistory scope={scope} />}
      {tool === 'unprotected-vms' && <UnprotectedVms scope={scope} />}
      {tool === 'solutions' && <Solutions />}
      {tool === 'licenses' && <Licenses scope={scope} />}
      {tool === 'license-expiry' && <LicenseExpiry scope={scope} isAdmin={isAdmin} />}
      {tool === 'hba' && <Hba scope={scope} />}
      {tool === 'gpu' && <Gpu scope={scope} />}
      {tool === 'serveranalysis' && <ServerAnalysis />}
      {tool === 'orphanvmdk' && <OrphanVmdk scope={scope} />}
      {tool === 'curuser' && <CurrentUsers scope={scope} />}
      {tool === 'fleet' && <FleetInventory isAdmin={isAdmin} />}
      {tool === 'nic-speed' && <NicSpeed />}
      {tool === 'nic-models' && <NicModels />}
      {tool === 'hardware' && <Hardware scope={scope} />}
      {tool === 'powermap' && <PowerMap scope={scope} />}
      {tool === 'esxi' && <Esxi scope={scope} />}
      {tool === 'vcversion' && <VcVersion />}
      {tool === 'nsx' && <NsxAdmin />}
      {tool === 'topo3d' && <Topology3D />}
      {tool === 'davinci-svc' && <ServiceCheck />}
      {tool === 'capacity-advisor' && (isAdmin ? <CapacityAdvisor /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'net-check' && <NetworkCheck />}
      {tool === 'net-traffic' && <NetTrafficAnalysis />}
      {tool === 'deepsearch' && <DeepSearch />}
      {tool === 'vmware-backup' && <VmwareConfigBackup />}
      {tool === 'roomtemp' && <RoomTemp />}
      {tool === 'portaldb' && <PortalDb />}
      {tool === 'dir-usage' && (isAdmin ? <DirUsageReport /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'mail-diag' && (isAdmin ? <MailDiag /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'shutdown' && <Shutdown />}
      {tool === 'vmprovision' && (isAdmin ? <VmProvision /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'agent-scans' && (isAdmin ? <AgentScans /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'login-fails' && (isAdmin ? <LoginFails /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'net-issues' && (isAdmin ? <NetIssues /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
    </>
    </React.Suspense>
  );
}

// 외부 파일 호환 재export(App.jsx lazy named import · Summary.jsx)
export { IpamStandalone } from './tools/IpamCore.jsx';
export { GuestOsVmsModal } from './tools/GuestOsTools.jsx';
