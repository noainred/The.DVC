// 특수 기능(SpecialTools) — 카드 그리드 셸 + 도구 패널 디스패처.
// v2.282.0 대형 파일 분할(2026-08-12): 5,070줄 단일 파일에서 도구 구현을 views/tools/ 로 분리했다.
// 이 파일은 목록/권한 게이트/딥링크/최근검색 셸과 ToolPanel 라우팅만 가진다.
// App.jsx(IpamStandalone)·Summary.jsx(GuestOsVmsModal) 호환을 위해 아래에서 재export 한다.
import React, { useEffect, useState, useRef } from 'react';
import { fetchJson, postJson, usePolling, toolAllowed, can } from '../api.js';
import { SearchBox } from '../components/ui.jsx';
import { TOOLS } from './specialToolsList.js';
import Topology3D from './Topology3D.jsx';
import { ServiceCheck, NetworkCheck, VmwareConfigBackup } from './DavinciChecks.jsx';
import NetTrafficAnalysis from './NetTrafficAnalysis.jsx';
import DeepSearch from './DeepSearch.jsx';
import VmProvision from './VmProvision.jsx';
import AgentScans from './AgentScans.jsx';
import SvcMonConfig from './SvcMonConfig.jsx';
import NsxAdmin from './Nsx.jsx';
import Explore from './Explore.jsx';
import CapacityAdvisor from './CapacityAdvisor.jsx';
import LoginFails from './LoginFails.jsx';
import NetIssues from './NetIssues.jsx';
import { DailyHealth, SnapshotAge, ZombieVms, CertExpiry, Rightsizing, CapacityForecast, AlertChannels, ComplianceReport, ChangeHistory, UnprotectedVms } from './ToolsReports.jsx';
import { AiSearch } from './tools/AiSearch.jsx';
import { VmExport } from './tools/VmExport.jsx';
import { Insights, Threats } from './tools/InsightsThreats.jsx';
import { Esxi, Hardware, Hba, ServerAnalysis, VcVersion } from './tools/HardwareTools.jsx';
import SecretScanTool from './tools/SecretScanTool.jsx'; // 평문 자격증명 점검(v2.297, admin 전용)
import CodexCheck from './CodexCheck.jsx'; // 보안점검 — 상단 메뉴에서 특수기능으로 이동(v2.298)
import VmCloneTool from './tools/VmCloneTool.jsx'; // VM 복제(백업식, v2.299 — admin 전용)
import StorageMonTool from './tools/StorageMonTool.jsx'; // 스토리지 모니터링(Isilon 등, v2.302 — admin 전용)
import BmStorageTool from './tools/BmStorageTool.jsx'; // 베어메탈 스토리지(SSH df 합산, v2.340 — admin 전용)
import VmTrackTool from './tools/VmTrackTool.jsx'; // VM 수량 추이(00/12시 스냅샷 + 증감 상세, v2.345)
import { PortalDb } from './tools/PortalDb.jsx';
import { NicModels, NicSpeed } from './tools/NicTools.jsx';
import { Shutdown } from './tools/ShutdownTool.jsx';
import { FleetInventory } from './tools/FleetInventory.jsx';
import { Capacity, EsxiTemp, Forecast, ThinVms, Waste } from './tools/CapacityTools.jsx';
import { VmFinder } from './tools/VmFinderTool.jsx';
import { GuestOs, RealOs } from './tools/GuestOsTools.jsx';
import { PowerMap } from './tools/PowerMap.jsx';
import { DupIp, Snapshots, VmTools } from './tools/VmInfoTools.jsx';
import { DatastoreUsage } from './tools/DatastoreUsage.jsx';
import { LicenseExpiry, Licenses, Solutions } from './tools/LicenseTools.jsx';
import { Gpu } from './tools/GpuTool.jsx';


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
  const gridRef = useRef(null);               // 메뉴 그리드 너비 측정용
  const [favCount, setFavCount] = useState(4); // 한 줄에 들어가는 카드 수(화면폭 자동, 기본 4)
  const [recent, setRecent] = useState(loadRecent); // 최근 검색어(최신순, 1줄 표시)
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
    if (tool) return undefined;
    const el = gridRef.current;
    if (!el) return undefined;
    const calc = () => {
      const w = el.clientWidth || el.offsetWidth || 0;
      setFavCount(Math.max(1, Math.floor((w + 16) / (330 + 16))));
    };
    calc();
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(calc) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', calc);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [tool]);
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
  const ql = menuQ.trim().toLowerCase();
  const shown = ql
    ? base.filter((t) => t.label.toLowerCase().startsWith(ql) || t.label.toLowerCase().includes(ql) || (t.desc || '').toLowerCase().includes(ql))
    : base;
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
        📋 전체 메뉴 <span style={{ fontWeight: 400 }}>· 클릭(사용) 많은 순 정렬</span>
      </div>
      <div className="vc-grid" ref={gridRef}>
        {shown.length === 0 && <div className="muted" style={{ gridColumn: '1 / -1', padding: 24 }}>“{menuQ}”에 해당하는 메뉴가 없습니다.</div>}
        {shownSorted.map((t) => (
          <div key={t.k} className="card vc-card"
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
        ))}
      </div>
    </>
  );
}

function ToolPanel({ tool, onBack, isAdmin }) {
  const meta = TOOLS.find((t) => t.k === tool);
  const [scope, setScope] = useState('');
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const scoped = ['vm-export', 'dupip', 'vmtools', 'snapshots', 'hba', 'gpu', 'licenses', 'license-expiry', 'esxi', 'hardware', 'powermap', 'guestos', 'real-os', 'thinvms', 'capacity', 'waste', 'esxitemp', 'forecast', 'dsusage',
    'daily-health', 'snapshot-age', 'zombie-vms', 'rightsizing', 'capacity-forecast', 'compliance-report', 'change-history', 'unprotected-vms'].includes(tool);

  return (
    <>
      <div className="flex wrap" style={{ marginBottom: 12, alignItems: 'center', gap: 12 }}>
        <button className="tab" onClick={onBack}>← 특수 기능</button>
        <div className="section-title" style={{ margin: 0 }}>{meta.icon} {meta.label}</div>
        {scoped && (
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">범위</span>
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">전체 vCenter</option>
              {(vcList || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
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
      {tool === 'bm-storage' && <BmStorageTool />}
      {tool === 'vm-track' && <VmTrackTool />}
      {tool === 'vmfinder' && <VmFinder />}
      {tool === 'capacity' && <Capacity scope={scope} />}
      {tool === 'waste' && <Waste scope={scope} />}
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
      {tool === 'portaldb' && <PortalDb />}
      {tool === 'shutdown' && <Shutdown />}
      {tool === 'vmprovision' && (isAdmin ? <VmProvision /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'agent-scans' && (isAdmin ? <AgentScans /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'login-fails' && (isAdmin ? <LoginFails /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
      {tool === 'net-issues' && (isAdmin ? <NetIssues /> : <div className="card"><span className="muted">관리자 전용 기능입니다.</span></div>)}
    </>
  );
}

// 외부 파일 호환 재export(App.jsx lazy named import · Summary.jsx)
export { IpamStandalone } from './tools/IpamCore.jsx';
export { GuestOsVmsModal } from './tools/GuestOsTools.jsx';
