// 특수 기능(SpecialTools) — 카드 그리드 셸 + 도구 패널 디스패처.
// v2.282.0 대형 파일 분할(2026-08-12): 5,070줄 단일 파일에서 도구 구현을 views/tools/ 로 분리했다.
// 이 파일은 목록/권한 게이트/딥링크/최근검색 셸과 ToolPanel 라우팅만 가진다.
// Summary.jsx(GuestOsVmsModal) 호환을 위해 아래에서 재export 한다(IpamStandalone 재수출은 v2.613 WEB2613-08 에 삭제 — App 이 IpamCore 를 직접 lazy 한다).
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, usePolling, toolAllowed, can, getCurrentUser, hasRole } from '../api.js';
import BoldText from '../components/boldText.jsx';
import { TOOLS } from './specialToolsList.js';
import { visibleTools, lockReasonOf as lockReason } from './toolVisibility.js'; // v2.613 CATALOG2613-07: 잠금 사유도 한 모듈
import { buildSections, applyOverrides, buildStageSections, stagesOf, displayLabel, isNonDefaultStage, introLine } from './toolSections.js'; // 섹션·덮어쓰기·단계 계산(v2.455 · v2.679, 순수)
import { ToolNamesDrawer, StageDot, StageBadge } from './ToolNamesStages.jsx'; // 이름·설명·단계 편집(v2.679)
import { searchTools } from './toolSearch.js'; // 도구 검색 매칭(v2.508, 순수 · V4 팔레트와 공용)


/**
 * v2.447(감사 T13): 도구 전부(당시 48개)를 정적 import 하던 것을 **React.lazy** 로 바꿨다.
 * 실측으로 SpecialTools 청크가 893.8KB 단일 덩어리였고, 사용자는 '특수 기능' 탭을 열 때
 * 실제로 볼 도구 1개를 위해 48개 전부를 내려받았다. 이제 셸(카드 그리드·권한 게이트·딥링크)만
 * 즉시 로드하고 각 도구는 선택하는 순간 자기 청크를 받는다. ToolPanel 전체를 <Suspense> 로 감싼다.
 *
 * ⚠️ 파일 하단의 재export(GuestOsVmsModal)는 Summary.jsx 가 쓰므로
 * 정적으로 유지한다 — lazy 로 바꾸면 그 화면이 깨진다.
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
const BmUsage = React.lazy(() => import('./tools/BmUsage.jsx'));         // 베어메탈 사용률(v2.550)
const CorpUsage = React.lazy(() => import('./tools/CorpUsage.jsx'));
const PowerTotal = React.lazy(() => import('./tools/PowerTotal.jsx')); // v2.664 전체 소비 전력
const IdracTrend = React.lazy(() => import('./tools/IdracTrendTool.jsx')); // iDRAC 통합 추이(v2.660)     // 법인별 서버 사용량(v2.625)
const LinkCheck = React.lazy(() => import('./tools/LinkCheck.jsx'));     // 통신 점검(중앙↔엣지·vCenter, v2.552)
const PortalCheck = React.lazy(() => import('./tools/PortalCheck.jsx')); // 포탈 점검 › 토큰 점검(v2.560)
const CommMap = React.lazy(() => import('./tools/CommMap.jsx'));         // 통신 지도(중앙↔엣지 라디얼, v2.584)
const DataFlow = React.lazy(() => import('./tools/DataFlow.jsx'));       // 데이터 흐름 지도(포탈 사이 전 경로, v2.587)
const DeviceFlow = React.lazy(() => import('./tools/DeviceFlow.jsx'));   // 3단 지도(장비 → 엣지 → 메인, v2.588)
const BmStorageTool = React.lazy(() => import('./tools/BmStorageTool.jsx'));
const SanSwitchTool = React.lazy(() => import('./tools/SanSwitchTool.jsx'));
const CvpTool = React.lazy(() => import('./tools/CvpTool.jsx'));         // Arista CloudVision(v2.608)
const VmHygieneTool = React.lazy(() => import('./tools/VmHygieneTool.jsx')); // VM 구성 점검(v2.698)
const HostHygieneTool = React.lazy(() => import('./tools/HostHygieneTool.jsx')); // ESXi 호스트 구성 점검(v2.699)
const ClusterCheckTool = React.lazy(() => import('./tools/ClusterCheckTool.jsx')); // 클러스터 HA·DRS 점검(v2.701)
const VmChangesTool = React.lazy(() => import('./tools/VmChangesTool.jsx')); // VM 이동·구성 변경 이력(v2.702)
const VmLifecycleTool = React.lazy(() => import('./tools/VmLifecycleTool.jsx')); // VM 생성·삭제 이력(v2.706 C5)
const ContentionTool = React.lazy(() => import('./tools/ContentionTool.jsx')); // CPU 경합·디스크 지연(v2.706 C2·C3)
const VmAvailabilityTool = React.lazy(() => import('./tools/VmAvailabilityTool.jsx')); // VM 가용성 SLA(v2.707 C6)
const CostShowbackTool = React.lazy(() => import('./tools/CostShowbackTool.jsx')); // 비용 배분(v2.707 C11)
const MigrationReadinessTool = React.lazy(() => import('./tools/MigrationReadinessTool.jsx')); // VM 이전 준비도(v2.707 C7)
const CoreLicenseTool = React.lazy(() => import('./tools/CoreLicenseTool.jsx')); // 코어 라이선스 산정(v2.703)
const VmTagsTool = React.lazy(() => import('./tools/VmTagsTool.jsx')); // 태그·사용자 지정 속성 점검(v2.703)
const StoragePathsTool = React.lazy(() => import('./tools/StoragePathsTool.jsx')); // 데이터스토어·경로 점검(v2.700)
const VmDnsTool = React.lazy(() => import('./tools/VmDnsTool.jsx'));     // VM DNS 설정 확인(v2.696)
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
// v2.592: 상단 '인사이트' 탭(FinOps 등 7패널)을 특수 기능으로 옮겼다 — 위 운영 인사이트와 다른 화면.
const InsightsHub = React.lazy(() => import('./Insights.jsx'));
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
// v2.679: 탭 기준(업무 분류/개발 단계)은 브라우저에 기억한다 — 사람마다 보는 축이 다르다(서버 설정이 아니다).
const AXIS_KEY = 'tools.axis';
const FAV_MAX = 6;          // 자주 쓰는 기능 상위 N
const INDEX_ROWS = 6;       // '전체' 탭 분류 패널의 행 수
const KO = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' }); // 이름순 — 비교기를 한 번만 만든다(v2.503)
// 분류 바 sticky 기준 — 셸마다 머리(sticky) 요소가 다르다. 첫 번째로 찾은 것의 높이를 쓴다.
const STICKY_HEADS = '.v6 .v6-top, .v5 .v5-top, .v3-top, .topbar';
const loadRecent = () => { try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()) : []; } catch { return []; } };

export default function SpecialTools({ defaultScope = '' } = {}) {
  const [tool, setTool] = useState(() => toolFromHash());
  const [menuQ, setMenuQ] = useState(''); // 메뉴 빠른 찾기
  const [isAdmin, setIsAdmin] = useState(false); // 관리자 전용 도구(VM 생성 등) 노출 제어
  // 외부 포탈 주소(서버 env SERVICE_HUB_URL). 인증 후에만 내려오며, 없으면 카드도 숨긴다.
  const [externalUrls, setExternalUrls] = useState({});
  const [topKeys, setTopKeys] = useState([]); // 사용 횟수(전체 사용자 합산)
  const [recent, setRecent] = useState(loadRecent); // 최근 검색어(최신순, 1줄 표시)
  // 카테고리·이름·단계 설정(v2.455 · v2.679) — 미설정/실패면 업무 분류·단계 없이 '전체' 격자 하나.
  const [cats, setCats] = useState(null);
  const [catMeta, setCatMeta] = useState({ limits: {}, defaultStages: [] });
  // v2.680 D-01: 설정을 '읽었는가' 를 따로 든다 — 못 읽은 채(cats=null) 편집기를 열고 저장하면
  // overrides:{} · stages:null 이 PUT 되어 저장된 이름·설명·단계가 전부 지워진다(조회 실패 → 저장 = 소거).
  const [catsState, setCatsState] = useState('loading'); // 'loading' | 'ok' | 'error'
  const [catsErr, setCatsErr] = useState('');
  // v2.679(핸드오프 '특수 기능 화면 재구성'): 탭 기준(업무 분류/개발 단계) · 탭 · 필터 · 정렬 · 설정 드로어.
  const [axis, setAxis] = useState(() => { try { return localStorage.getItem(AXIS_KEY) === 'stage' ? 'stage' : 'cat'; } catch { return 'cat'; } });
  const [tabId, setTabId] = useState('all');
  const [filterId, setFilterId] = useState('all');
  const [sortMode, setSortMode] = useState('usage');
  const [drawer, setDrawer] = useState(false);
  const [qFocus, setQFocus] = useState(false);
  const [headH, setHeadH] = useState(0); // 셸 머리(sticky)의 실제 높이 — 분류 바의 top
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
  // 설정을 한 번만 읽는다(자주 바뀌지 않는다). 실패는 무시 — 분류·단계 없이 기존대로 그린다.
  useEffect(() => {
    let alive = true;
    fetchJson('/admin/tool-categories')
      .then((r) => {
        if (!alive) return;
        const ok = !!(r && r.settings && typeof r.settings === 'object');
        setCats(ok ? r.settings : null);
        setCatMeta({ limits: r?.limits || {}, defaultStages: r?.defaultStages || [] });
        setCatsState(ok ? 'ok' : 'error');
        setCatsErr(ok ? '' : (r?.reason || '설정 응답에 settings 가 없습니다'));
      })
      .catch((e) => {
        // 카테고리는 편의 기능이다 — 못 읽어도 화면은 동작해야 한다. 단 편집기는 열지 않는다(D-01).
        if (!alive) return;
        setCatsState('error');
        setCatsErr(e?.status === 403 ? '권한이 없습니다' : (e?.message || String(e)));
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onHash = () => setTool(toolFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    // v2.613 WEB2613-01: /auth/me 를 다시 부르지 않는다 — App 이 렌더 전에 채운 현재 사용자 객체 하나(api.js)에서 읽는다.
    setIsAdmin(hasRole('admin'));
    setExternalUrls({ serviceHubUrl: getCurrentUser()?.serviceHubUrl || '' });
  }, []);
  // 그리드(메뉴 목록)로 돌아올 때마다 사용 횟수를 갱신. 전체 메뉴를 클릭순으로 정렬하므로
  // 상위 몇 개가 아니라 전체 도구 수를 덮을 만큼 넉넉히 가져온다(→ 200).
  useEffect(() => {
    if (tool) return;
    fetchJson('/tool-usage/top', { n: 200 }).then((r) => setTopKeys(r.top || [])).catch(() => {});
  }, [tool]);
  // 분류 바 sticky top = 셸 머리(sticky) 실제 높이 + 8px. 좁은 화면에서 머리가 여러 줄로 늘어나므로 잰다.
  useEffect(() => {
    if (tool) return undefined;
    const el = document.querySelector(STICKY_HEADS);
    if (!el) { setHeadH(0); return undefined; }
    const calc = () => setHeadH(Math.round(el.getBoundingClientRect().height || 0));
    calc();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(calc) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', calc);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [tool]);
  // 도구 잠금 사유 — 접근 가능하면 null. 특수 기능은 항목이 많아 '숨김'보다 '회색 잠금'이 낫다:
  // 어떤 기능이 있는지는 보이고, 권한이 없으면 클릭만 막아 관리자에게 요청할 수 있게 한다.
  // v2.613(CATALOG2613-07): 판정은 views/toolVisibility.js lockReasonOf 하나 — V4 내비·기능 찾기·팔레트와 같은 답.
  //   (v2.555 의 '명시 허용은 adminOnly 표시 관례를 넘긴다' 도 그 안에 있다.) 여기서 규칙을 다시 쓰지 말 것.
  const lockReasonOf = (t) => lockReason(t, { isAdmin, toolsAllowed: getCurrentUser()?.toolsAllowed ?? null, can, toolAllowed });
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
  if (tool) return <ToolPanel tool={tool} isAdmin={isAdmin} defaultScope={defaultScope} cfg={cats} onBack={() => openTool(null)} />;
  // 전 도구를 노출하되, 권한이 없으면 disabled(회색·클릭불가)로 표시한다(숨기지 않음).
  // 외부 포탈 항목은 주소가 설정된 경우에만 노출한다(미설치 환경에 죽은 카드를 남기지 않음).
  // topTab(상단 메뉴로 승격) 항목은 카드로 노출하지 않는다(권한 매트릭스 편집용으로만 목록에 존재).
  // v2.555: **허용 목록 모드에서는 목록 밖 도구를 숨긴다**(사용자 선택 '아예 숨긴다').
  // 거부 목록 모드는 위 주석대로 회색 잠금을 유지한다 — 판정은 views/toolVisibility.js 하나.
  const toolsAllowedList = getCurrentUser()?.toolsAllowed || null;
  const raw = visibleTools(TOOLS, { isAdmin, toolsAllowed: toolsAllowedList })
    .filter((t) => !t.topTab).filter((t) => !t.external || externalUrls[t.external]).map((t) => {
    const lock = lockReasonOf(t);
    return lock ? { ...t, disabled: true, comingSoon: false, lockReason: lock } : t;
  });
  // v2.679: 관리자가 바꾼 이름·설명·단계를 입힌다(키는 그대로 — 원래 이름은 aka 로 검색된다).
  const base = applyOverrides(raw, cats);
  const ql = menuQ.trim().toLowerCase();
  // 검색 매칭은 공용 규칙(v2.508, toolSearch.js) — 라벨·설명뿐 아니라 **키**(gpu·ipam·rma)와
  // **분류명**, **구 명칭 별칭**(aka)까지 본다. V4 커맨드 팔레트가 같은 모듈을 쓴다. v2.679: 단계 이름도 본다.
  const catLabelsOf = (t) => (cats?.enabled ? (cats?.categories || []) : [])
    .filter((c) => c && c.enabled !== false && (c.tools || []).includes(t.k))
    .map((c) => c.label || '');
  const shown = searchTools(base, ql, { catsOf: (t) => [...catLabelsOf(t), t.stageLabel || ''] });
  const countOf = new Map(topKeys.map((u) => [u.k, u.count]));
  // 전체 메뉴를 클릭(사용) 많은 순으로 정렬한다. 동점·미사용(0회)은 원래 순서를 유지(안정 정렬).
  // 비활성(준비 중·권한 없음) 카드는 항상 맨 뒤로 보낸다.
  const shownSorted = shown.slice().sort((a, b) =>
    (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || (countOf.get(b.k) || 0) - (countOf.get(a.k) || 0));
  const byKey = new Map(shownSorted.map((t) => [t.k, t]));
  const keysShown = shownSorted.map((t) => t.k);

  // 두 축 — 업무 분류(카테고리 설정을 켰을 때) · 개발 단계(단계 목록이 있을 때). 없는 축은 나오지 않는다.
  const catSecs = buildSections(cats, keysShown);
  const stageSecs = buildStageSections(cats, keysShown);
  const hasCat = catSecs.length > 0;
  const hasStage = !!stagesOf(cats);
  const curAxis = axis === 'stage' && hasStage ? 'stage' : (hasCat ? 'cat' : (hasStage ? 'stage' : null));
  const primary = curAxis === 'stage' ? stageSecs : curAxis === 'cat' ? catSecs : [];
  const secondary = curAxis === 'stage' ? catSecs : curAxis === 'cat' ? stageSecs : [];
  const secMap = new Map(secondary.map((s) => [s.id, new Set(s.tools)]));
  const filterSet = filterId !== 'all' ? secMap.get(filterId) : null;
  const passFilter = (k) => !filterSet || filterSet.has(k);
  const curTab = tabId !== 'all' && primary.some((s) => s.id === tabId) ? tabId : 'all';
  const tabSec = curTab === 'all' ? null : primary.find((s) => s.id === curTab);
  const inTab = (k) => !tabSec || tabSec.tools.includes(k);
  const visibleKeys = keysShown.filter((k) => inTab(k) && passFilter(k));
  const pickAxis = (a) => { setAxis(a); setTabId('all'); setFilterId('all'); try { localStorage.setItem(AXIS_KEY, a); } catch { /* ignore */ } };
  const nameCmp = (a, b) => KO.compare(a.label || '', b.label || '');
  const listed = visibleKeys.map((k) => byKey.get(k)).filter(Boolean);
  const listedSorted = sortMode === 'name' ? listed.slice().sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || nameCmp(a, b)) : listed;

  // 자주 쓰는 기능 — '전체' 탭 · 필터 없음 · 검색 아님일 때만, 상위 6개.
  const favorites = (curTab === 'all' && filterId === 'all' && !ql) ? topKeys
    .map((u) => ({ ...(byKey.get(u.k) || {}), count: u.count }))
    .filter((t) => t && t.k && !t.disabled && (t.count || 0) > 0)
    .slice(0, FAV_MAX) : [];
  const catCount = (cats?.enabled ? (cats?.categories || []).filter((c) => c && c.enabled !== false).length : 0);
  const stageCount = (stagesOf(cats) || []).length;
  const intro = introLine({ isAdmin, toolsAllowed: toolsAllowedList, shownCount: base.length, catCount, stageCount });
  const curFilterLabel = filterId === 'all' ? '' : (secondary.find((s) => s.id === filterId)?.label || '');
  const card = (t) => renderToolCard(t, null, { countOf, externalUrls, openTool, cfg: cats, catLabelsOf, tabLabel: curAxis === 'cat' ? tabSec?.label : '' });
  const showIndex = curTab === 'all' && !ql && primary.length > 0;

  return (
    <div className="st-page">
      <section className="st-head">
        <div className="st-head-left">
          <div className="st-eyebrow">SPECIAL TOOLS</div>
          <div className="st-title-row">
            <h1 className="st-h1">특수 기능</h1>
            {isAdmin && (
              <button className="st-set-btn" onClick={() => setDrawer(true)} disabled={catsState !== 'ok'}
                title={catsState === 'ok' ? '기능별 표시 이름·설명·개발 단계를 바꿉니다(관리자)'
                  : catsState === 'loading' ? '저장된 이름·단계 설정을 불러오는 중입니다 — 불러온 뒤에 열 수 있습니다'
                    : `저장된 이름·단계 설정을 읽지 못해 열 수 없습니다(열고 저장하면 기존 설정이 지워집니다): ${catsErr}`}>
                ⚙ 이름·단계 설정<span className="st-admin-tag">관리자</span>
              </button>
            )}
            {isAdmin && catsState === 'error' && (
              <span className="st-err" style={{ fontSize: 12 }}>이름·단계 설정을 읽지 못했습니다: {catsErr}</span>
            )}
          </div>
          {/* v2.555: 허용 목록 모드에서는 회색 카드가 하나도 없으므로 그 안내가 **거짓**이 된다.
              판정·문구는 toolVisibility.gridIntro 하나가 소유한다(Chromium 판독에서 발견) — introLine 이 그 규칙을 따른다. */}
          <div className="st-intro"><BoldText text={intro} /></div>
        </div>
        <div className="st-head-right">
          <div className={`st-search${qFocus || menuQ ? ' on' : ''}`}>
            <span className="st-search-ico" aria-hidden>⌕</span>
            <input value={menuQ} onChange={(e) => setMenuQ(e.target.value)} onFocus={() => setQFocus(true)} onBlur={() => setQFocus(false)}
              placeholder="기능 찾기 — 이름·키·설명·단계 (예: GPU, 개발중)" aria-label="기능 찾기"
              onKeyDown={(e) => { if (e.key === 'Enter') addRecent(e.target.value); if (e.key === 'Escape') setMenuQ(''); }} />
            {menuQ && <button className="st-search-x" onClick={() => setMenuQ('')} title="검색어 지우기">✕</button>}
          </div>
          {recent.length > 0 && (
            <div className="st-recent">
              <span>최근</span>
              {recent.slice(0, 8).map((q) => (
                <button key={q} className={`st-recent-chip${menuQ === q ? ' on' : ''}`} onClick={() => setMenuQ(menuQ === q ? '' : q)}
                  title={`"${q}" 다시 검색 (다시 클릭하면 해제)`}>{q}</button>
              ))}
              <button className="st-recent-chip st-recent-clear" onClick={clearRecent} title="최근 검색어 전체 지우기">✕ 지우기</button>
            </div>
          )}
        </div>
      </section>

      {favorites.length > 0 && (
        <section className="st-block">
          <div className="st-label"><span className="st-label-mark">▸</span>자주 쓰는 기능<span className="st-label-sub">· 전체 사용자 누적 실행</span></div>
          <div className="st-fav-grid">
            {favorites.map((t, i) => (
              <button key={t.k} className={`st-fav${t.danger ? ' danger' : ''}`} onClick={() => openTool(t.k)} title={`바로가기: #/tools/${t.k}`}>
                <span className={`st-rank${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                <span className="st-ico st-ico-sm">{t.icon}</span>
                <span className="st-fav-text">
                  <span className="st-ellipsis" style={{ fontWeight: 600 }}>{displayLabel(cats, t)}</span>
                  <span className="st-fav-sub">{t.stageLabel && <><StageDot color={t.stageColor} size={6} />{t.stageLabel} · </>}{t.count}회</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {curAxis && (
        <div className="st-bar" style={{ top: headH + 8 }}>
          <div className="st-bar-row">
            {hasCat && hasStage && (
              <div className="st-seg" role="tablist" aria-label="분류 기준">
                <button className={curAxis === 'cat' ? 'on' : ''} onClick={() => pickAxis('cat')}>업무 분류</button>
                <button className={curAxis === 'stage' ? 'on' : ''} onClick={() => pickAxis('stage')}>개발 단계</button>
              </div>
            )}
            <nav className="st-tabs">
              {[{ id: 'all', label: '전체', icon: '▦', tools: keysShown }, ...primary].map((s) => {
                const n = s.tools.filter(passFilter).length;
                const on = curTab === s.id;
                return (
                  <button key={s.id} className={`st-tab${on ? ' on' : ''}`} onClick={() => setTabId(s.id)}>
                    {s.id !== 'all' && curAxis === 'stage' ? <StageDot color={s.color} /> : <span className="st-tab-ico">{s.icon}</span>}
                    {s.label}<span className="st-tab-n">{n}</span>
                  </button>
                );
              })}
            </nav>
          </div>
          {secondary.length > 0 && (
            <div className="st-bar-row st-bar-filter">
              <span className="st-filter-label">{curAxis === 'cat' ? '개발 단계' : '업무 분류'}</span>
              {[{ id: 'all', label: '전체', tools: keysShown }, ...secondary].map((s) => {
                const n = s.tools.filter(inTab).length;
                return (
                  <button key={s.id} className={`st-chip${filterId === s.id ? ' on' : ''}`} onClick={() => setFilterId(s.id)}>
                    {s.id !== 'all' && curAxis === 'cat' && <StageDot color={s.color} size={7} />}
                    {s.id !== 'all' && curAxis === 'stage' && s.icon && <span className="st-chip-ico">{s.icon}</span>}
                    {s.label}<span className="st-n">{n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showIndex ? (
        <div className="st-index">
          {primary.map((s) => {
            const keys = s.tools.filter(passFilter);
            if (!keys.length) return null;
            const runs = keys.reduce((n, k) => n + (countOf.get(k) || 0), 0);
            const top = keys.slice(0, INDEX_ROWS).map((k) => byKey.get(k)).filter(Boolean);
            return (
              <div key={s.id} className="st-panel">
                <div className="st-panel-head">
                  <span className="st-ico">{curAxis === 'stage' ? <StageDot color={s.color} size={12} /> : s.icon}</span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="st-panel-title">{s.label}</span>
                    <span className="st-panel-sub">{keys.length}개 기능 · 실행 {runs.toLocaleString()}회</span>
                  </span>
                  <button className="st-more" onClick={() => setTabId(s.id)}>모두 보기 →</button>
                </div>
                <div className="st-panel-body">
                  {top.map((t) => (
                    <button key={t.k} className={`st-row${t.disabled ? ' off' : ''}`} disabled={!!t.disabled}
                      onClick={t.disabled ? undefined : () => openTool(t.k)}
                      title={t.lockReason || (t.disabled ? '준비 중 (곧 제공)' : `바로가기: #/tools/${t.k}`)}>
                      <span className="st-row-ico">{t.icon}</span>
                      <span className="st-ellipsis st-row-name">{displayLabel(cats, t)}</span>
                      {cats?.stageDisplay !== 'suffix' && isNonDefaultStage(cats, t) && <StageBadge label={t.stageLabel} color={t.stageColor} />}
                      {t.lockReason && <span className="st-faint" title={t.lockReason}>🔒</span>}
                      <span className="st-row-n">{countOf.get(t.k) || 0}</span>
                    </button>
                  ))}
                  {keys.length > top.length && (
                    <button className="st-row st-row-more" onClick={() => setTabId(s.id)}>+ {keys.length - top.length}개 더 보기</button>
                  )}
                </div>
              </div>
            );
          })}
          {primary.every((s) => !s.tools.some(passFilter)) && <div className="st-empty">조건에 맞는 기능이 없습니다.</div>}
        </div>
      ) : (
        <section className="st-block">
          <div className="st-grid-head">
            <span className="st-ico st-ico-lg">{tabSec ? (curAxis === 'stage' ? <StageDot color={tabSec.color} size={14} /> : tabSec.icon) : (ql ? '⌕' : '▦')}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="st-grid-title">{ql ? `“${menuQ.trim()}” 검색 결과` : tabSec ? tabSec.label : '전체 기능'}</span>
              <span className="st-panel-sub">{listedSorted.length}개 기능{curFilterLabel ? ` · ${curFilterLabel}만` : ''}</span>
            </span>
            <div className="st-seg" aria-label="정렬">
              <button className={sortMode === 'usage' ? 'on' : ''} onClick={() => setSortMode('usage')}>많이 쓴 순</button>
              <button className={sortMode === 'name' ? 'on' : ''} onClick={() => setSortMode('name')}>이름순</button>
            </div>
          </div>
          <div className="st-card-grid">
            {listedSorted.length === 0 && <div className="st-empty" style={{ gridColumn: '1 / -1' }}>{ql ? `“${menuQ}”에 해당하는 메뉴가 없습니다.` : '조건에 맞는 기능이 없습니다.'}</div>}
            {listedSorted.map((t) => card(t))}
          </div>
        </section>
      )}

      {drawer && catsState === 'ok' && cats && (
        <ToolNamesDrawer settings={cats} limits={catMeta.limits} defaultStages={catMeta.defaultStages}
          onSaved={(s) => setCats(s)} onClose={() => setDrawer(false)} />
      )}
    </div>
  );
}

/**
 * 카드 1장 — 모든 격자가 같은 모양을 쓰도록 함수로 뽑았다(v2.508 — 예전에는 인라인 복제였다).
 * 중복 소속이면 같은 도구가 여러 섹션에 나오므로 key 에 섹션 id 를 섞는다(React key 충돌 방지).
 */
function renderToolCard(t, sectionId, { countOf, externalUrls, openTool, cfg, catLabelsOf, tabLabel }) {
  const n = countOf.get(t.k) || 0;
  const otherCats = catLabelsOf ? catLabelsOf(t).filter((l) => l && l !== tabLabel) : [];
  const showBadge = cfg?.stageDisplay !== 'suffix' && t.stageLabel;
  return (
    <div key={sectionId ? `${sectionId}:${t.k}` : t.k}
      className={`st-card${t.disabled ? ' off' : ''}${t.danger && !t.disabled ? ' danger' : ''}`}
      role={t.disabled ? undefined : 'button'} tabIndex={t.disabled ? -1 : 0}
      onClick={t.disabled ? undefined : () => openTool(t.k)}
      onKeyDown={t.disabled ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTool(t.k); } }}
      title={t.lockReason || (t.disabled ? (t.comingSoon ? '준비 중 (곧 제공)' : '비활성화됨')
        : t.external ? `새 탭으로 열기: ${externalUrls[t.external]}` : `바로가기: #/tools/${t.k}`)}>
      <div className="st-card-top">
        <span className="st-ico st-ico-card">{t.icon}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="st-card-name">{displayLabel(cfg, t)}</span>
          {t.renamed && <span className="st-card-orig">원래 이름 · {t.origLabel}</span>}
        </span>
        {t.lockReason
          ? <span className="st-count" title={t.lockReason}>🔒 {t.adminOnly ? '관리자 전용' : '권한 없음'}</span>
          : n > 0 && <span className={`st-count${n >= 50 ? ' hot' : ''}`} title="전체 사용자 누적 실행 횟수">{n}회</span>}
      </div>
      <div className="st-card-desc">{t.desc}</div>
      {(showBadge || otherCats.length > 0 || t.disabled || t.external) && (
        <div className="st-card-foot">
          {showBadge && <StageBadge label={t.stageLabel} color={t.stageColor} />}
          {otherCats.map((l) => <span key={l} className="st-cat-chip">{l}</span>)}
          {t.disabled && !t.lockReason && <span className="st-faint">{t.comingSoon ? '준비 중' : '비활성화됨'}</span>}
          {t.external && !t.disabled && <span className="st-faint">새 탭으로 열기 ↗</span>}
        </div>
      )}
    </div>
  );
}

function ToolPanel({ tool, onBack, isAdmin, defaultScope = '', cfg = null }) {
  // v2.679: 제목도 관리자가 바꾼 표시 이름을 쓴다(키·링크는 그대로).
  const meta = applyOverrides(TOOLS.filter((t) => t.k === tool), cfg)[0] || TOOLS.find((t) => t.k === tool);
  // v2.616: V5 틀의 법인 범위를 첫 값으로 받는다(바꾸면 따라간다). 개발 포탈은 넘기지 않아 예전 그대로('').
  const [scope, setScope] = useState(defaultScope);
  // v2.491: vCenter 아래 하위 범위 — 클러스터/폴더. vCenter 를 고른 뒤에만 쓴다(클러스터 이름은
  // vCenter 간 중복될 수 있어, 전체 범위에서 이름으로 거르면 다른 사이트 VM 까지 섞인다).
  const [cluster, setCluster] = useState('');
  const [folder, setFolder] = useState('');
  useEffect(() => { setScope(defaultScope); setCluster(''); setFolder(''); }, [defaultScope]);
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
        <div className="section-title" style={{ margin: 0 }}>{meta.icon} {displayLabel(cfg, meta)}</div>
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
      {/* v2.593(감사 UI-2593-01): '준비 중' 도구(diskadd·backup·massdeploy)를 주소로 열면 본문이 비어 있었다 — 무엇도
          말하지 않는 빈 화면은 '고장' 으로 읽힌다. 카드 목록과 같은 사실(아직 없다)을 말한다. */}
      {TOOLS.find((t) => t.k === tool)?.comingSoon && (
        <div className="card" style={{ padding: 20, fontSize: 14 }}>
          <b>{TOOLS.find((t) => t.k === tool).label}</b>은(는) 아직 준비 중인 기능입니다 — 이 화면에서 할 수 있는 작업이 없습니다.
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>특수 기능 목록에서 다른 기능을 고르세요.</div>
        </div>
      )}
      {tool === 'aisearch' && <AiSearch />}
      {tool === 'explore' && <Explore />}
      {tool === 'insights' && <Insights scope={scope} />}
      {tool === 'insights-hub' && <InsightsHub />}
      {tool === 'threats' && <Threats scope={scope} />}
      {tool === 'secret-scan' && <SecretScanTool />}
      {tool === 'codex-check' && <CodexCheck />}
      {tool === 'vm-clone' && <VmCloneTool />}
      {tool === 'storage-mon' && <StorageMonTool />}
      {tool === 'storage-growth' && <StorageGrowthTool />}
      {tool === 'part-faults' && <PartFaults />}
      {tool === 'edge-log' && <EdgeLog />}
      {tool === 'bm-usage' && <BmUsage />}
      {tool === 'corp-usage' && <CorpUsage scope={scope} />}
      {tool === 'power-total' && <PowerTotal />}
      {tool === 'idrac-trend' && <IdracTrend />}
      {tool === 'link-check' && <LinkCheck />}
      {tool === 'portal-check' && <PortalCheck />}
      {tool === 'comm-map' && <CommMap />}
      {tool === 'data-flow' && <DataFlow />}
      {tool === 'device-flow' && <DeviceFlow />}
      {tool === 'bm-storage' && <BmStorageTool />}
      {tool === 'san-switch' && <SanSwitchTool />}
      {tool === 'cvp' && <CvpTool />}
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
      {tool === 'vm-hygiene' && <VmHygieneTool scope={scope} />}
      {tool === 'host-hygiene' && <HostHygieneTool scope={scope} />}
      {tool === 'cluster-check' && <ClusterCheckTool scope={scope} />}
      {tool === 'vm-changes' && <VmChangesTool scope={scope} />}
      {tool === 'vm-lifecycle' && <VmLifecycleTool scope={scope} />}
      {tool === 'contention' && <ContentionTool scope={scope} />}
      {tool === 'vm-availability' && <VmAvailabilityTool scope={scope} />}
      {tool === 'cost-showback' && <CostShowbackTool scope={scope} />}
      {tool === 'migration-readiness' && <MigrationReadinessTool scope={scope} />}
      {tool === 'core-license' && <CoreLicenseTool scope={scope} />}
      {tool === 'vm-tags' && <VmTagsTool scope={scope} />}
      {tool === 'storage-paths' && <StoragePathsTool scope={scope} />}
      {tool === 'vm-dns' && <VmDnsTool scope={scope} />}
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
      {/* v2.613(CATALOG2613-08): 예전에 7개 분기(capacity-advisor·dir-usage·mail-diag·vmprovision·agent-scans·login-fails·net-issues)만
          `isAdmin ? … : '관리자 전용 기능입니다'` 인라인 가드를 달고 있었다. 셸의 lockReasonOf 가 adminOnly 를 먼저 막으므로 그 가드에
          닿는 것은 **허용 목록으로 명시 허용된 비관리자**뿐인데, 그때 나머지 21개 adminOnly 도구는 화면 → 서버 403 → AccessDenied 를
          보고 이 7개만 다른 문구를 봤다(같은 조건에 두 문구). vmprovision 은 조회가 requirePerm('vm.provision')(admin 아님)이라
          가드가 서버보다 좁기까지 했다. 관리자 판정은 **서버 게이트 + ErrorBox → AccessDenied 하나**로 통일한다(v2.555 규약).
          이 파일에 `isAdmin ?` 렌더 분기를 다시 만들지 말 것(audit2613a 웹 테스트가 0 을 고정). */}
      {tool === 'capacity-advisor' && <CapacityAdvisor />}
      {tool === 'net-check' && <NetworkCheck />}
      {tool === 'net-traffic' && <NetTrafficAnalysis />}
      {tool === 'deepsearch' && <DeepSearch />}
      {tool === 'vmware-backup' && <VmwareConfigBackup />}
      {tool === 'roomtemp' && <RoomTemp />}
      {tool === 'portaldb' && <PortalDb />}
      {tool === 'dir-usage' && <DirUsageReport />}
      {tool === 'mail-diag' && <MailDiag />}
      {tool === 'shutdown' && <Shutdown />}
      {tool === 'vmprovision' && <VmProvision />}
      {tool === 'agent-scans' && <AgentScans />}
      {tool === 'login-fails' && <LoginFails />}
      {tool === 'net-issues' && <NetIssues />}
    </>
    </React.Suspense>
  );
}

// 외부 파일 호환 재export(App.jsx lazy named import · Summary.jsx)
export { GuestOsVmsModal } from './tools/GuestOsTools.jsx';
