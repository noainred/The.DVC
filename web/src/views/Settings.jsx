import React, { lazy, Suspense } from 'react';
import { Loading } from '../components/ui.jsx';
import { isSuperAdminUser, toolAllowed } from '../api.js';
// v2.580(튜닝): 설정 하위 화면 42개가 **한 청크(605KB)** 로 묶여 있었다 — 어느 탭을 열든 전부 받는다.
// 큰 화면 12개(Collectors 1,012줄 …)를 lazy 로 떼어 탭을 열 때만 받는다. `SUB` 표·키·URL 은 그대로다.
import { useHashTab } from '../hooks/useHashTab.js';
const VCenterAdmin = lazy(() => import('./VCenterAdmin.jsx'));
const DatacenterAdmin = lazy(() => import('./DatacenterAdmin.jsx'));
import VCenterConnTest from './VCenterConnTest.jsx';
import NsxAdmin from './NsxAdmin.jsx';
import IdracAdmin from './IdracAdmin.jsx';
import IdracScanLog from './IdracScanLog.jsx';
const Collectors = lazy(() => import('./Collectors.jsx'));
const AgentDeploy = lazy(() => import('./AgentDeploy.jsx'));
import ProxySettings from './ProxySettings.jsx';
import RemoteAccess from './RemoteAccess.jsx';
import AdSettings from './AdSettings.jsx';
import LlmSettings from './LlmSettings.jsx';
const UserAdmin = lazy(() => import('./UserAdmin.jsx'));
import EdgeUserDeploy from './EdgeUserDeploy.jsx';
const Diagnostics = lazy(() => import('./Diagnostics.jsx'));
import Alerts2 from './Alerts2.jsx';
import Audit from './Audit.jsx';
import { RecentLogins, LoginCounts } from './LoginHistory.jsx'; // v2.912: 설정 › 로그 › 최근 로그인 · 로그인 횟수
const MetricsSettings = lazy(() => import('./MetricsSettings.jsx'));
import StorageIntervals from './StorageIntervals.jsx'; // 스토리지 수집 주기(중앙→엣지 배포, v2.409)
import PowerOffCheckSettings from './PowerOffCheckSettings.jsx'; // 전원 꺼짐 점검 주기(v2.484)
const VmSeriesSettings = lazy(() => import('./VmSeriesSettings.jsx')); // VM 실시간 스파이크 수집(20초 표본 · vCenter별 DB, v2.510)
const PerfMonitor = lazy(() => import('./PerfMonitor.jsx')); // 서버 성능 측정(요청 지연·루프 정체·hang 로그, v2.498)
const LogAnalysis = lazy(() => import('./LogAnalysis.jsx')); // 로그 분석 — 로그에서 개선점 도출(v2.583)
import HostAccessSettings from './HostAccessSettings.jsx'; // 호스트 접근 제어(SSH/웹/OS 방화벽, v2.485)
import SanSwitchPerf from './SanSwitchPerf.jsx';       // SAN 스위치 포트 사용량 수집(portperfshow, v2.411)
const GpuGuestSettings = lazy(() => import('./GpuGuestSettings.jsx'));
import GpuGuestDiag from './GpuGuestDiag.jsx';
import GpuSettings from './GpuSettings.jsx';
import NfsMounts from './NfsMounts.jsx'; // Edge NFS 마운트(백업 대상, v2.299)
import MailSettings from './MailSettings.jsx';          // 포탈 공용 메일(SMTP) 발송(v2.454)
import ToolCategories from './ToolCategories.jsx';      // 특수 기능 카테고리(v2.455)
import DirUsageSettings from './DirUsageSettings.jsx'; // 폴더 사용량 Top-N 리포트(v2.454)
import PortalBackup from './PortalBackup.jsx';
import VcenterLogs from './VcenterLogs.jsx';
import GuestAccount from './GuestAccount.jsx';
import AnomalyDetection from './AnomalyDetection.jsx';
import SessionSecurity from './SessionSecurity.jsx';
import SecretsSettings from './SecretsSettings.jsx'; // 자격증명 저장 방식(평문/암호화, v2.296)
const ApiKeys = lazy(() => import('./ApiKeys.jsx'));                 // 외부 포탈 조회 API 키(v2.562)
import SecuritySelfCheck from './SecuritySelfCheck.jsx'; // 보안 자가진단(지금 이 서버의 실측 상태, v2.500)
const Upgrade = lazy(() => import('./Upgrade.jsx'));
const PeerTrustSettings = lazy(() => import('./PeerTrustSettings.jsx')); // 장비 신뢰(SSH 호스트키·TLS 인증서 승인) — 2026-10-09 검토 S-01·S-02
import About from './About.jsx';
import HorizonAdmin from './HorizonAdmin.jsx'; // v2.685
const IsiduSettingsPage = lazy(() => import('./tools/IsiduSettingsPage.jsx')); // v2.740 아이실론 수집 대상 설정(슈퍼 관리자 전용)
const GuestPartSettings = lazy(() => import('./tools/GuestPartSettings.jsx')); // v2.749 게스트 파티션 사용률 — 조회 주기·임계·무시 규칙·메일
const VeeamSettings = lazy(() => import('./VeeamSettings.jsx')); // v2.751 Veeam 백업 서버(vCenter 별 · 중앙 또는 그 법인 엣지가 읽음)
const BareosSettingsPage = lazy(() => import('./BareosSettingsPage.jsx')); // v2.878 Bareos 설정(예전 Backup › Bareos › 설정 탭)
const FeatureUsage = lazy(() => import('./FeatureUsage.jsx')); // v2.912 기능 사용 현황(사용자별 기능 사용 추적 — 설정 소유자)

// 모든 하위 화면 정의(키→라벨→컴포넌트). 모든 항목은 group 키로 1단 묶음 하나에 속한다.
// v2.905(사용자 요청 '설정에 메뉴가 너무 많아져서 스크롤바가 생긴다 — 재배치'): 1단이 19개(단독 항목 12개 + 그룹 7개)라 1,600px 대에서도
//   가로 스크롤이 생겼다. 단독 항목을 없애고 1단을 9개 묶음(GROUP_ORDER)으로 줄였다 — 키(#/settings/<k>)는 하나도 바꾸지 않았다(딥링크 · 권한 문서).
//   묶음 순서는 이 배열의 첫 등장 순서이고 server/test/settingsMenu2905.test.js 가 GROUP_ORDER 와 대조한다(같은 묶음은 붙어 있어야 한다).
const SUB = [
  // --- 인프라 등록: 모니터링할 대상(법인 · vCenter · NSX · Horizon · iDRAC) ---
  { k: 'datacenter-admin', label: 'DataCenter(법인)', C: DatacenterAdmin, group: 'infra' },
  { k: 'vcenter-admin', label: 'vCenter 등록·관리', C: VCenterAdmin, group: 'infra' },
  { k: 'vcenter-test', label: 'vCenter 연결 테스트', C: VCenterConnTest, group: 'infra' },
  { k: 'nsx-admin', label: 'NSX 관리', C: NsxAdmin, group: 'infra' },
  { k: 'horizon-admin', label: 'Horizon 연결 서버', C: HorizonAdmin, group: 'infra' }, // v2.685: 라이선스 만료 도구 안에만 있던 등록을 설정에도
  { k: 'idrac-admin', label: 'iDRAC 서버 등록', C: IdracAdmin, group: 'infra' },
  { k: 'idrac-scan-log', label: 'iDRAC 스캔 로그', C: IdracScanLog, group: 'infra' }, // v2.905: '스캔 로그' → 묶음이 바뀌어 무엇의 로그인지 이름에 넣었다
  // --- 백업: VM 백업 서버(Veeam · Bareos) + 포탈 자체 백업 ---
  { k: 'veeam', label: 'Veeam 백업 서버', C: VeeamSettings, group: 'backups' }, // v2.751 — VM 및 폴더 'Veeam 백업 VM 표시' 의 출처
  // v2.878(사용자 요청 'Bareos 의 설정을 전체 메뉴 설정으로 — B안'): Backup › Bareos 탭 줄의 '설정' 을 여기로 옮겼다. 키 'bareos' 는 bareosViewText BAREOS_SETTINGS_KEY 와 같다.
  //   Bareos 도구 권한(bareos-backup)이 있는 계정에게만 보인다(서버 API 는 adminOnly · fullScopeOnly 로 따로 집행).
  { k: 'bareos', label: 'Bareos 백업 서버', C: BareosSettingsPage, group: 'backups', show: () => toolAllowed('bareos-backup') },
  { k: 'backup', label: '포탈 백업', C: PortalBackup, group: 'backups' },
  { k: 'nfs-mounts', label: 'NFS 마운트(백업 대상)', C: NfsMounts, group: 'backups' },
  // --- 수집: 수집 주기 · 대상 · 임계(GPU 포함) ---
  { k: 'metrics', label: '지표 수집', C: MetricsSettings, group: 'collect' },
  { k: 'storage-intervals', label: '스토리지 수집 주기', C: StorageIntervals, group: 'collect' },
  { k: 'power-off-check', label: '전원 꺼짐 점검', C: PowerOffCheckSettings, group: 'collect' },
  { k: 'vmseries', label: 'VM 실시간 스파이크 수집', C: VmSeriesSettings, group: 'collect' },
  { k: 'sansw-perf', label: 'SAN 스위치 포트 사용량', C: SanSwitchPerf, group: 'collect' },
  // v2.740(사용자 요청 "수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게"): 특수 기능 화면 안에 있던 수집 대상 설정.
  //   superOnly — 슈퍼 관리자에게만 메뉴가 보인다(표시 게이팅). 서버 설정 API 는 requireSuperAdmin 이 집행한다.
  { k: 'isilon-dirusage', label: '아이실론 디렉터리 사용량', C: IsiduSettingsPage, group: 'collect', superOnly: true },
  { k: 'guest-partition', label: '게스트 파티션 사용률', C: GuestPartSettings, group: 'collect' },
  { k: 'dir-usage', label: '폴더 사용량 리포트', C: DirUsageSettings, group: 'collect' },
  { k: 'gpu-collect', label: 'GPU 수집', C: GpuSettings, group: 'collect' },
  { k: 'gpu-guest', label: 'GPU 게스트 수집', C: GpuGuestSettings, group: 'collect' },
  { k: 'gpu-guest-diag', label: 'GPU 수집 진단', C: GpuGuestDiag, group: 'collect' },
  { k: 'guest-account', label: '게스트 계정 추가', C: GuestAccount, group: 'collect' },
  // --- 엣지·원격: 원격 수집 서버(엣지) · 엣지 설치 · 브라우저 원격접속 중계 ---
  { k: 'collectors', label: '수집 서버(원격)', C: Collectors, group: 'edge' },
  // v2.825 의 '엣지 토큰 맞추기'(edge-tokens) 하위 탭은 v2.827 에 독립 도구(#/tools/edge-tokens · 공통 메뉴 설정 › 엣지 토큰 맞추기)로 옮겼다 —
  //   옛 주소 #/settings/edge-tokens 는 hooks/hashTab.js MOVED_SUBS 가 새 주소로 보낸다.
  { k: 'agent-deploy', label: '원격 법인(DC)에 Edge 노드 포탈 설치', C: AgentDeploy, group: 'edge' },
  { k: 'proxy', label: '중계 서버', C: ProxySettings, group: 'edge' },
  { k: 'remote', label: '원격접속 설정', C: RemoteAccess, group: 'edge' },
  // --- 사용자 ---
  { k: 'users', label: '메인포탈 사용자 관리', C: UserAdmin, group: 'usercontrol' },
  { k: 'edge-users', label: '엣지 사용자 배포', C: EdgeUserDeploy, group: 'usercontrol' },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings, group: 'usercontrol' },
  // v2.912(사용자 요청 '사용자별로 어떤 기능을 사용하는지 트래킹 — UI 개선을 위해' · 설계 docs/design/feature-usage): 설정 소유자 게이트를 그대로 탄다(서버 requireSettingsOwner).
  { k: 'feature-usage', label: '기능 사용 현황', C: FeatureUsageEntry, group: 'usercontrol' },
  // --- 보안 ---
  { k: 'session-security', label: '세션 보안', C: SessionSecurity, group: 'security' },
  { k: 'secrets', label: '자격증명 저장 방식', C: SecretsSettings, group: 'security' },
  // 외부 포탈이 상시 조회하는 자격증명이라 '자격증명 저장 방식' 과 같은 묶음(보안)에 둔다.
  { k: 'api-keys', label: '연동 키(외부 포탈 조회 API)', C: ApiKeys, group: 'security' },
  { k: 'anomaly', label: '이상동작 탐지', C: AnomalyDetection, group: 'security' },
  { k: 'host-access', label: '호스트 접근 제어', C: HostAccessSettings, group: 'security' },
  { k: 'peer-trust', label: '장비 신뢰(SSH 호스트키·TLS 인증서)', C: PeerTrustSettings, group: 'security' },
  { k: 'security-self-check', label: '보안 자가진단', C: SecuritySelfCheck, group: 'security' },
  // --- 알림·연동 ---
  { k: 'alerts', label: '알림', C: Alerts2, group: 'notify' },
  { k: 'mail', label: '메일 발송', C: MailSettings, group: 'notify' },
  { k: 'ai-search', label: 'AI 검색', C: LlmSettings, group: 'notify' },
  { k: 'tool-categories', label: '특수 기능 카테고리', C: ToolCategories, group: 'notify' },
  // --- 로그 ---
  { k: 'vclogs', label: 'vCenter 로그 보관', C: VcenterLogs, group: 'log' },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics, group: 'log' },
  { k: 'perf-monitor', label: '서버 성능 측정', C: PerfMonitor, group: 'log' },
  { k: 'log-analysis', label: '로그 분석(개선점)', C: LogAnalysis, group: 'log' },
  { k: 'audit', label: '감사 로그', C: Audit, group: 'log' },
  // v2.912(사용자 요청 '전체 사용자가 최근에 로그인 한 정보 · 최근 1일/7일/1달/사용자 정의 기간에 몇 번 로그인했는지'): 같은 API 를 쓰는 두 화면.
  { k: 'recent-logins', label: '최근 로그인', C: RecentLogins, group: 'log' },
  { k: 'login-counts', label: '로그인 횟수', C: LoginCounts, group: 'log' },
  // --- 시스템 ---
  // 업그레이드: 상단 '업그레이드' 탭은 SHOW_UPGRADE_TAB로 숨겨져 있어도, 관리자 설정 안에서는
  // 항상 접근 가능하게 둔다(오프라인 업그레이드 번들 적용/원격 자동 업그레이드 설정).
  { k: 'upgrade', label: '⬆ 업그레이드', C: Upgrade, group: 'system' },
  { k: 'about', label: 'About', C: About, group: 'system' },
];

// 1단 묶음 9개(v2.905). 라벨에 이모지를 넣지 않는다(폭을 줄이고 1,440px 사이드바 펼침에서도 한 줄). 화면 문구 · 딥링크 안내의 메뉴 경로
// ('설정 › 수집 › …')는 이 라벨을 쓴다 — 라벨을 바꾸면 server/test/settingsMenu2905.test.js 가 옛 경로 문구를 찾아낸다.
const GROUP_ORDER = ['infra', 'backups', 'collect', 'edge', 'usercontrol', 'security', 'notify', 'log', 'system'];
const GROUPS = {
  infra: { label: '인프라 등록', desc: '모니터링할 대상을 등록하는 곳 — 법인(DataCenter) · vCenter 등록과 연결 테스트 · NSX · Horizon 연결 서버 · iDRAC 서버 등록과 스캔 로그.' },
  backups: { label: '백업', desc: 'vCenter 별 Veeam 백업 서버 · 법인별 Bareos(Director · 설치 · 계정) · 포탈 자체 백업과 백업 대상 NFS 마운트.' },
  collect: { label: '수집', desc: '수집 주기 · 대상 · 임계 — 지표 · 스토리지 · 전원 꺼짐 점검 · VM 실시간 스파이크 · SAN 스위치 포트 · 아이실론 · 게스트 파티션 · 폴더 사용량 · GPU(수집 · 게스트 · 진단) · 게스트 계정.' },
  edge: { label: '엣지·원격', desc: '원격 수집 서버(엣지) 등록 · 원격 법인에 Edge 노드 포탈 설치 · 브라우저 SSH/RDP 중계 서버와 원격접속 설정.' },
  usercontrol: { label: '사용자', desc: '사용자 계정(역할·2FA)·엣지 사용자 배포(중앙→엣지)·인증(AD/LDAP) 연동·기능 사용 현황(누가 어느 화면을 얼마나 — UI 개선 자료).' },
  security: { label: '보안', desc: '세션 보안·자격증명 저장 방식·연동 키(외부 포탈 조회 API)·이상동작 탐지·호스트 접근 제어(SSH/웹/OS 방화벽)·장비 신뢰(SSH 호스트키·TLS 인증서)·보안 자가진단.' },
  notify: { label: '알림·연동', desc: '알림 · 포탈 공용 메일(SMTP) 발송 · AI 검색 연동 · 특수 기능 카테고리.' },
  log: { label: '로그', desc: 'vCenter 로그 보관 · 진단·로그 · 서버 성능 측정 · 로그 분석(개선점) · 감사 로그 · 최근 로그인 · 로그인 횟수.' },
  system: { label: '시스템', desc: '업그레이드(온라인 · 오프라인 번들 · 자동 업그레이드)와 버전 정보(About).' },
};
/** v2.912 기능 사용 현황이 설정 하위 키의 이름 · 메뉴 경로를 쓰도록 넘기는 목록(FeatureUsage 가 Settings 를 import 하면 순환이 된다). */
function FeatureUsageEntry() { return <FeatureUsage settingsMeta={settingsMeta()} />; }
function settingsMeta() { return SUB.map((s) => ({ k: s.k, label: s.label, groupLabel: GROUPS[s.group]?.label || '', superOnly: !!s.superOnly })); }
/** 이 사용자에게 보이는 하위 항목(v2.740 — superOnly 는 슈퍼 관리자에게만). 주소로 직접 들어오면 그 화면이 권한 안내를 그린다. */
const visibleSubs = () => SUB.filter((s) => (!s.superOnly || isSuperAdminUser()) && (!s.show || s.show()));
const groupChildren = (g) => visibleSubs().filter((s) => s.group === g);

const DEFAULT_SUB = 'vcenter-admin';
const SUB_KEYS = SUB.map((s) => s.k);


/** 설정 — 관리자용 하위 메뉴. 1단 묶음 9개 → 2단 항목(v2.905). */
export default function Settings({ initialSub }) {
  // 하위 탭을 URL(#/settings/<키>)에 싣는다(v2.438) — 새로고침해도 보던 화면이 유지되고,
  // 하위 항목이 30개가 넘어 매번 다시 찾아 들어가야 했던 불편이 사라진다. 링크 공유도 된다.
  const [sub, setSub] = useHashTab({
    base: ['settings'], valid: SUB_KEYS,
    fallback: SUB_KEYS.includes(initialSub) ? initialSub : DEFAULT_SUB,
  });
  const cur = SUB.find((s) => s.k === sub) || SUB[0];
  const Cur = cur.C;
  const activeGroup = cur.group || null;

  // 상단 1단: 묶음 9개(GROUP_ORDER). 이 사용자에게 보이는 항목이 하나도 없는 묶음은 뺀다.
  const topItems = GROUP_ORDER.filter((g) => groupChildren(g).length > 0).map((g) => ({ key: g, label: GROUPS[g].label }));
  const selectGroup = (g) => { const first = groupChildren(g)[0]; if (first) setSub(first.k); };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>⚙️ 설정</div>
      {/* v2.905: 1단은 9개라 1,440px(사이드바 펼침)에서 한 줄이다. 좁은 화면은 가로 스크롤 대신 줄바꿈(.vcd-views 의 nowrap · overflow 를 여기서만 끈다). */}
      <div className="vcd-views" style={{ marginBottom: activeGroup ? 8 : 16, flexWrap: 'wrap', overflowX: 'visible' }}>
        {topItems.map((t) => {
          const active = activeGroup === t.key;
          return (
            <button key={t.key} className={active ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }}
              aria-pressed={active} onClick={() => selectGroup(t.key)}>{t.label}</button>
          );
        })}
      </div>
      {activeGroup && (
        <>
          {/* 2차(하위) 메뉴 — 들여쓰기 + 반투명 패널 + 좌측 강조바로 1차 메뉴와 계층 구분 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 14, marginBottom: 10,
            padding: '8px 12px', borderRadius: 10, background: 'rgba(37,99,235,.07)', borderLeft: '3px solid var(--accent,#2563eb)' }}>
            <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', opacity: .75, paddingRight: 2 }}>{GROUPS[activeGroup].label} ›</span>
            {groupChildren(activeGroup).map((s) => {
              const on = sub === s.k;
              return (
                <button key={s.k} onClick={() => setSub(s.k)}
                  style={{ flex: 'none', padding: '6px 12px', fontSize: 12.5, borderRadius: 7, cursor: 'pointer',
                    background: on ? 'rgba(37,99,235,.22)' : 'transparent',
                    color: on ? '#93c5fd' : 'var(--muted,#9aa4b2)',
                    border: on ? '1px solid rgba(37,99,235,.55)' : '1px solid transparent',
                    fontWeight: on ? 600 : 400 }}>{s.label}</button>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 14, marginLeft: 14 }}>{GROUPS[activeGroup].desc}</div>
        </>
      )}
      {/* lazy 화면의 첫 로드 동안만 잠깐 보인다 — 이미 받은 청크는 즉시 그려진다. */}
      <Suspense fallback={<Loading />}><Cur /></Suspense>
    </>
  );
}
