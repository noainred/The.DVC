import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Loading } from '../components/ui.jsx';
import { fetchJson, isSuperAdminUser, toolAllowed } from '../api.js';
import { Icon } from './sidebar/sidebarIcons.jsx';
import { badgeOf, filterByGrade, groupTone, isSearchHotkey, pushRecent, readKeyList, searchItems, summarize, SUMMARY_LABEL, SUMMARY_ORDER, toggleFav } from './settingsMenu.js'; // v2.916 왼쪽 목록 순수 로직
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
const FeatureUsage = lazy(() => import('./FeatureUsage.jsx')); // v2.913 기능 사용 현황(사용자별 기능 사용 추적 — 설정 소유자)

// 모든 하위 화면 정의(키→라벨→컴포넌트→묶음→설명). 모든 항목은 group 키로 묶음 하나에 속한다.
// v2.905(사용자 요청 '설정에 메뉴가 너무 많아져서 스크롤바가 생긴다 — 재배치'): 1단을 9개 묶음으로 줄였다.
// v2.916(사용자 요청 '설정 메뉴를 클로드 디자인 사용해서 개편 — 효율적이고 직관적으로' · 시안 A안 + B의 상태 요약 — docs/design/settings-menu §4):
//   1단 탭 줄 → **설정 안의 왼쪽 목록**(묶음 접기 · 검색 · 즐겨찾기 · 최근) + 항목별 설명 한 줄(desc) + 서버 상태 배지(GET /admin/settings/status).
//   묶음 9 → 10: '수집' 12개를 '수집 주기·임계' 7 + '게스트·GPU' 5 로 나누고, '특수 기능 카테고리' 를 '알림·연동' 에서 '시스템' 으로 옮겨
//   '알림·연동' 을 '알림·메일' 로 바꿨다. 키(#/settings/<k>)는 하나도 바꾸지 않았다(딥링크 · 권한 문서).
//   ⚠ 한 줄 모양 '  { k: …, label: …, C: …, group: …' 을 유지한다 — server/test/settingsMenu2905.test.js 가 이 모양으로 읽는다(desc · show 는 그 뒤).
const SUB = [
  // --- 인프라 등록: 모니터링할 대상(법인 · vCenter · NSX · Horizon · iDRAC) ---
  { k: 'datacenter-admin', label: 'DataCenter(법인)', C: DatacenterAdmin, group: 'infra', desc: '법인을 만들고 vCenter · iDRAC 장비를 그 아래로 배정합니다. 화면 곳곳의 법인 필터 · 지도 배치 · 표시 순서가 이 정의를 따릅니다.' },
  { k: 'vcenter-admin', label: 'vCenter 등록·관리', C: VCenterAdmin, group: 'infra', desc: '수집할 vCenter 의 주소 · 계정 · 타임아웃 · 수집 켜기/끄기 · 지도 좌표를 등록하고 고칩니다.' },
  { k: 'vcenter-test', label: 'vCenter 연결 테스트', C: VCenterConnTest, group: 'infra', desc: '등록된 vCenter 로 TCP → TLS → API 로그인까지 차례로 시도해 어디서 막히는지 보여 줍니다.' },
  { k: 'nsx-admin', label: 'NSX 관리', C: NsxAdmin, group: 'infra', desc: 'NSX Manager 를 등록해 논리 스위치 · 라우터 · 방화벽 정보를 수집합니다.' },
  { k: 'horizon-admin', label: 'Horizon 연결 서버', C: HorizonAdmin, group: 'infra', desc: 'Horizon Connection Server 를 등록합니다 — 라이선스 만료 · 현재 사용자(VDI) · 앱 사용 현황이 함께 씁니다.' }, // v2.685: 라이선스 만료 도구 안에만 있던 등록을 설정에도
  { k: 'idrac-admin', label: 'iDRAC 서버 등록', C: IdracAdmin, group: 'infra', desc: 'Dell iDRAC 장비를 등록하거나 IP 대역 스캔으로 찾아 전력 · 온도 · 하드웨어 정보를 수집합니다.' },
  { k: 'idrac-scan-log', label: 'iDRAC 스캔 로그', C: IdracScanLog, group: 'infra', desc: 'iDRAC 대역 스캔의 실행 이력 — 법인별 발견 · 등록 · 스캔 수와 성공 · 실패 · 대기를 봅니다.' }, // v2.905: '스캔 로그' → 묶음이 바뀌어 무엇의 로그인지 이름에 넣었다
  // --- 백업: VM 백업 서버(Veeam · Bareos) + 포탈 자체 백업 ---
  { k: 'veeam', label: 'Veeam 백업 서버', C: VeeamSettings, group: 'backups', desc: 'vCenter 별 Veeam Backup & Replication 서버를 등록합니다 — VM 및 폴더의 Veeam 백업 VM 표시가 이 등록을 씁니다.' }, // v2.751
  // v2.878(사용자 요청 'Bareos 의 설정을 전체 메뉴 설정으로 — B안'): Backup › Bareos 탭 줄의 '설정' 을 여기로 옮겼다. 키 'bareos' 는 bareosViewText BAREOS_SETTINGS_KEY 와 같다.
  //   Bareos 도구 권한(bareos-backup)이 있는 계정에게만 보인다(서버 API 는 adminOnly · fullScopeOnly 로 따로 집행).
  { k: 'bareos', label: 'Bareos 백업 서버', C: BareosSettingsPage, group: 'backups', desc: '법인마다 Bareos Director 를 등록하고 vCenter 를 묶습니다 — 설치 · 법인별 설정 · 계정 통합도 여기서 합니다.', show: () => toolAllowed('bareos-backup') },
  { k: 'backup', label: '포탈 백업', C: PortalBackup, group: 'backups', desc: '포탈 설정 폴더 전체와 DB 를 묶어 백업합니다 — 스케줄 · 보존 개수 · 저장 위치 · 복원.' },
  { k: 'nfs-mounts', label: 'NFS 마운트(백업 대상)', C: NfsMounts, group: 'backups', desc: '백업을 저장할 NFS 마운트를 등록하고 확인합니다.' },
  // --- 수집 주기·임계: 얼마나 자주 · 무엇을 · 어느 값부터 ---
  { k: 'metrics', label: '지표 수집', C: MetricsSettings, group: 'collect', desc: '성능 지표 샘플 주기와 보존 기간, VM 성능 추적 대상 vCenter 를 정하고 vCenter 별 DB 사용량을 봅니다.' },
  { k: 'storage-intervals', label: '스토리지 수집 주기', C: StorageIntervals, group: 'collect', desc: '스토리지 장비 수집 · 보내기 · 설정 받기 주기를 중앙에서 정해 엣지에 내려보냅니다.' },
  { k: 'power-off-check', label: '전원 꺼짐 점검', C: PowerOffCheckSettings, group: 'collect', desc: '몇 시간마다 전원 꺼진 VM 을 기록할지 정합니다 — Optimization › 전원 꺼짐 표의 꺼진 지 N일 이 이 기록을 씁니다.' },
  { k: 'vmseries', label: 'VM 실시간 스파이크 수집', C: VmSeriesSettings, group: 'collect', desc: 'ESXi 의 20초 실시간 표본을 주기마다 받아 임계 이상인 순간만 남깁니다(기본 꺼짐).' },
  { k: 'sansw-perf', label: 'SAN 스위치 포트 사용량', C: SanSwitchPerf, group: 'collect', desc: 'SAN 스위치 포트 처리량의 수집 주기 · 보존 기간을 정하고 즉시 수집 · 정리를 실행합니다.' },
  // v2.740(사용자 요청 "수집 대상 설정은 설정 메뉴로 이동해서 일반 사용자, 관리자는 못 보게"): 특수 기능 화면 안에 있던 수집 대상 설정.
  //   superOnly — 슈퍼 관리자에게만 메뉴가 보인다(표시 게이팅). 서버 설정 API 는 requireSuperAdmin 이 집행한다.
  { k: 'isilon-dirusage', label: '아이실론 디렉터리 사용량', C: IsiduSettingsPage, group: 'collect', desc: '아이실론에서 조사할 디렉터리 · 주기 · 시한 · 실행 노드 · 결과 메일을 정합니다(슈퍼 관리자 전용).', superOnly: true },
  { k: 'dir-usage', label: '폴더 사용량 리포트', C: DirUsageSettings, group: 'collect', desc: '엣지에 마운트된 공유 폴더의 하위 폴더별 사용량 Top N 을 주기마다 모아 메일로 보냅니다.' },
  // --- 게스트·GPU: 게스트 OS 안을 보는 수집(v2.916 에 '수집' 에서 나눴다) ---
  { k: 'guest-partition', label: '게스트 파티션 사용률', C: GuestPartSettings, group: 'guestgpu', desc: '게스트 파티션 사용률의 조회 주기 · 판정 기준 · 무시 규칙 · 메일을 정합니다.' },
  { k: 'guest-account', label: '게스트 계정 추가', C: GuestAccount, group: 'guestgpu', desc: '여러 VM 의 게스트 OS 안에 수집용 계정을 한 번에 만듭니다.' },
  { k: 'gpu-collect', label: 'GPU 수집', C: GpuSettings, group: 'guestgpu', desc: 'ESXi 호스트의 물리 GPU 사용률 수집을 켜고 끕니다.' },
  { k: 'gpu-guest', label: 'GPU 게스트 수집', C: GpuGuestSettings, group: 'guestgpu', desc: '패스스루 GPU 는 호스트에서 보이지 않아 게스트 안에서 nvidia-smi 로 수집합니다 — 계정 · SSH · 배포.' },
  { k: 'gpu-guest-diag', label: 'GPU 수집 진단', C: GpuGuestDiag, group: 'guestgpu', desc: 'GPU 게스트 수집이 실패하는 VM 을 계정 → 로그인 → 명령 실행 → 해석 단계로 따라갑니다.' },
  // --- 엣지·원격: 원격 수집 서버(엣지) · 엣지 설치 · 브라우저 원격접속 중계 ---
  { k: 'collectors', label: '수집 서버(원격)', C: Collectors, group: 'edge', desc: '원격 법인의 엣지 포탈을 수집 서버로 등록해 중앙이 데이터를 받습니다 — 연결 상태 · 수신 통계 · 인증 거부.' },
  // v2.825 의 '엣지 토큰 맞추기'(edge-tokens) 하위 탭은 v2.827 에 독립 도구(#/tools/edge-tokens · 공통 메뉴 설정 › 엣지 토큰 맞추기)로 옮겼다 —
  //   옛 주소 #/settings/edge-tokens 는 hooks/hashTab.js MOVED_SUBS 가 새 주소로 보낸다.
  { k: 'agent-deploy', label: '원격 법인(DC)에 Edge 노드 포탈 설치', C: AgentDeploy, group: 'edge', desc: 'SSH 로 원격 서버에 포탈 설치본을 올려 엣지 노드를 만듭니다 — 현황 · 추가 · 대량 배포 · 패키지.' },
  { k: 'proxy', label: '중계 서버', C: ProxySettings, group: 'edge', desc: '브라우저 SSH/RDP 를 중계하는 프록시 서버를 등록하고 배포 · 테스트합니다.' },
  { k: 'remote', label: '원격접속 설정', C: RemoteAccess, group: 'edge', desc: '원격 접속 매핑(대상 호스트 ↔ 공개 포트)을 관리합니다.' },
  // --- 사용자 ---
  { k: 'users', label: '메인포탈 사용자 관리', C: UserAdmin, group: 'usercontrol', desc: '계정 · 역할 · 2FA(OTP) · 역할별 기능 권한 · 데이터 범위(vCenter 제한) · 특수 기능 도구별 접근.' },
  { k: 'edge-users', label: '엣지 사용자 배포', C: EdgeUserDeploy, group: 'usercontrol', desc: '중앙에서 만든 계정을 엣지 포탈들에 한 번에 배포합니다.' },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings, group: 'usercontrol', desc: 'Active Directory/LDAP 연동 — 서버 · 검색 필터 · 그룹과 역할 연결 · 연결 테스트.' },
  // v2.913(사용자 요청 '사용자별로 어떤 기능을 사용하는지 트래킹 — UI 개선을 위해' · 설계 docs/design/feature-usage): 설정 소유자 게이트를 그대로 탄다(서버 requireSettingsOwner).
  { k: 'feature-usage', label: '기능 사용 현황', C: FeatureUsageEntry, group: 'usercontrol', desc: '계정마다 어느 화면을 몇 번 열고 얼마나 봤는지 날짜별로 셉니다 — UI 개선 자료.' },
  // --- 보안 ---
  { k: 'session-security', label: '세션 보안', C: SessionSecurity, group: 'security', desc: '세션 만료 · 단일 세션 강제 · 로그인 실패 잠금 · 로그인 방식(OTP) · 설정 소유자를 정합니다.' },
  { k: 'secrets', label: '자격증명 저장 방식', C: SecretsSettings, group: 'security', desc: '장비 비밀번호를 평문으로 둘지 암호화(봉인)할지 정하고 전환을 실행합니다.' },
  // 외부 포탈이 상시 조회하는 자격증명이라 '자격증명 저장 방식' 과 같은 묶음(보안)에 둔다.
  { k: 'api-keys', label: '연동 키(외부 포탈 조회 API)', C: ApiKeys, group: 'security', desc: '다른 포탈이 이 포탈의 데이터를 읽는 전용 API 키를 발급 · 폐기합니다 — 분류 · vCenter 범위 · 만료.' },
  { k: 'anomaly', label: '이상동작 탐지', C: AnomalyDetection, group: 'security', desc: '사용량 · 이벤트의 이상 패턴을 찾을 임계와 대상 vCenter 를 정합니다.' },
  { k: 'host-access', label: '호스트 접근 제어', C: HostAccessSettings, group: 'security', desc: '포탈 서버에 누가 들어올 수 있는지 — SSH 허용 목록 · 웹 포트 · OS 방화벽을 포탈에서 통제합니다.' },
  { k: 'peer-trust', label: '장비 신뢰(SSH 호스트키·TLS 인증서)', C: PeerTrustSettings, group: 'security', desc: '장비에 접속할 때 받은 SSH 호스트키 · TLS 인증서 지문을 승인 · 거부합니다.' },
  { k: 'security-self-check', label: '보안 자가진단', C: SecuritySelfCheck, group: 'security', desc: '지금 이 서버의 보안 상태를 다시 읽어 항목별로 보여 줍니다 — 로그인 정책 · OTP 등록 · 비밀 저장 등.' },
  // --- 알림·메일 ---
  { k: 'alerts', label: '알림', C: Alerts2, group: 'notify', desc: '임계 규칙과 알림 채널(Slack · Teams · 메일 · 웹훅)을 정하고 테스트 발송합니다. 일일 리포트 시각도 여기서.' },
  { k: 'mail', label: '메일 발송', C: MailSettings, group: 'notify', desc: '포탈 모든 기능이 함께 쓰는 SMTP 설정 — 기능별 켜기/끄기와 수신자도 정합니다.' },
  { k: 'ai-search', label: 'AI 검색', C: LlmSettings, group: 'notify', desc: '자연어 검색에 쓸 LLM(로컬 Ollama 또는 외부 API)을 정하고, 에어갭 환경에 Ollama 를 배포합니다.' },
  // --- 로그 ---
  { k: 'vclogs', label: 'vCenter 로그 보관', C: VcenterLogs, group: 'log', desc: 'vCenter 이벤트를 주기적으로 모아 오래 보관합니다 — 최소 심각도 · 보존 기간 · 주기.' },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics, group: 'log', desc: '서버 상태(가동 시간 · 메모리 · 이벤트 루프 지연) · 최근 로그 · DB 용량 · 폴러 상태를 봅니다.' },
  { k: 'perf-monitor', label: '서버 성능 측정', C: PerfMonitor, group: 'log', desc: '라우트별 요청 지연 · 이벤트 루프 정체 추이 · 진행 중 요청 · hang 기록을 봅니다.' },
  { k: 'log-analysis', label: '로그 분석(개선점)', C: LogAnalysis, group: 'log', desc: '포탈 로그를 읽어 고칠 점을 뽑습니다 — 규칙 · HTTP 오류 · 반복 문장 · 엣지 로그.' },
  { k: 'audit', label: '감사 로그', C: Audit, group: 'log', desc: '누가 언제 무엇을 바꿨는지 기록을 조회합니다.' },
  // v2.912(사용자 요청 '전체 사용자가 최근에 로그인 한 정보 · 최근 1일/7일/1달/사용자 정의 기간에 몇 번 로그인했는지'): 같은 API 를 쓰는 두 화면.
  { k: 'recent-logins', label: '최근 로그인', C: RecentLogins, group: 'log', desc: '사용자별 마지막 로그인 시각 · 경과 · 접속 IP · 계정 종류 · 최근 1달 횟수를 봅니다.' },
  { k: 'login-counts', label: '로그인 횟수', C: LoginCounts, group: 'log', desc: '사용자별로 최근 1일 · 7일 · 1달 · 고른 기간에 몇 번 로그인했는지 셉니다.' },
  // --- 시스템 ---
  { k: 'tool-categories', label: '특수 기능 카테고리', C: ToolCategories, group: 'system', desc: '특수 기능을 직접 만든 카테고리로 묶어 섹션별로 보여 줍니다(기본 꺼짐).' }, // v2.916: '알림·연동' 에서 옮김(알림 성격이 아니다)
  // 업그레이드: 상단 '업그레이드' 탭은 SHOW_UPGRADE_TAB로 숨겨져 있어도, 관리자 설정 안에서는
  // 항상 접근 가능하게 둔다(오프라인 업그레이드 번들 적용/원격 자동 업그레이드 설정).
  { k: 'upgrade', label: '⬆ 업그레이드', C: Upgrade, group: 'system', desc: '새 버전을 확인 · 내려받아 적용하고 재시작합니다. 오프라인(에어갭) 번들 업로드 · 자동 업그레이드도 여기서.' },
  { k: 'about', label: 'About', C: About, group: 'system', desc: '현재 버전 · 릴리스 노트 · 라이선스 · 시스템 정보를 봅니다.' },
];

// 묶음 10개(v2.916 — v2.905 는 9개). 라벨에 이모지를 넣지 않는다. 화면 문구 · 딥링크 안내의 메뉴 경로('설정 › 수집 주기·임계 › …')는
// 이 라벨을 쓴다 — 라벨을 바꾸면 server/test/settingsMenu2905.test.js 가 옛 경로 문구를 찾아낸다.
const GROUP_ORDER = ['infra', 'backups', 'collect', 'guestgpu', 'edge', 'usercontrol', 'security', 'notify', 'log', 'system'];
const GROUPS = {
  infra: { label: '인프라 등록', desc: '모니터링할 대상을 등록하는 곳 — 법인 · vCenter · NSX · Horizon · iDRAC.' },
  backups: { label: '백업', desc: 'vCenter 별 Veeam · 법인별 Bareos · 포탈 자체 백업과 NFS 대상.' },
  collect: { label: '수집 주기·임계', desc: '얼마나 자주 · 무엇을 · 어느 값부터 — 지표 · 스토리지 · 전원 꺼짐 · 스파이크 · SAN 포트 · 아이실론 · 폴더 사용량.' },
  guestgpu: { label: '게스트·GPU', desc: '게스트 OS 안을 보는 수집 — 파티션 · 계정 · GPU.' },
  edge: { label: '엣지·원격', desc: '원격 수집 서버(엣지) · Edge 노드 설치 · 브라우저 SSH/RDP 중계.' },
  usercontrol: { label: '사용자', desc: '계정 · 역할 · 2FA · AD 연동 · 엣지 사용자 배포 · 기능 사용 현황.' },
  security: { label: '보안', desc: '세션 · 자격증명 · 연동 키 · 이상동작 · 호스트 접근 · 장비 신뢰 · 자가진단.' },
  notify: { label: '알림·메일', desc: '알림 규칙 · 공용 메일(SMTP) · AI 검색 연동.' },
  log: { label: '로그', desc: '보관 · 진단 · 성능 · 로그 분석 · 감사 · 로그인 기록.' },
  system: { label: '시스템', desc: '특수 기능 카테고리 · 업그레이드 · 버전 정보.' },
};
/** v2.913 기능 사용 현황이 설정 하위 키의 이름 · 메뉴 경로를 쓰도록 넘기는 목록(FeatureUsage 가 Settings 를 import 하면 순환이 된다). */
function FeatureUsageEntry() { return <FeatureUsage settingsMeta={settingsMeta()} />; }
function settingsMeta() { return SUB.map((s) => ({ k: s.k, label: s.label, groupLabel: GROUPS[s.group]?.label || '', superOnly: !!s.superOnly })); }
/** 이 사용자에게 보이는 하위 항목(v2.740 — superOnly 는 슈퍼 관리자에게만). 주소로 직접 들어오면 그 화면이 권한 안내를 그린다. */
const visibleSubs = () => SUB.filter((s) => (!s.superOnly || isSuperAdminUser()) && (!s.show || s.show()));

const DEFAULT_SUB = 'vcenter-admin';
const SUB_KEYS = SUB.map((s) => s.k);


const NAV_GROUP_LABEL = Object.fromEntries(Object.entries(GROUPS).map(([g, v]) => [g, v.label]));
const LS_RECENT = 'settings.recent.v1';
const LS_FAV = 'settings.fav.v1';
const STATUS_POLL_MS = 60_000;
// 링크는 진짜 a href 라 Ctrl/⌘/Shift 클릭 · 가운데 클릭은 브라우저에 맡긴다(새 탭) — 그냥 클릭만 이 화면에서 옮긴다.
const plainClick = (e) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); };
// 브라우저 저장소는 사생활 창 · 차단 · 미리보기에서 던질 수 있다 — 읽기 · 쓰기 모두 감싼다(최근 · 즐겨찾기는 편의일 뿐이다).
const lsRead = (key) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const lsWrite = (key, v) => { try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* 저장 못 해도 화면은 그대로 */ } };

/** 배지 하나 — 서버 등급(settingsStatus/grade.js)을 그대로 그린다. 정상(등급 없음)은 그리지 않는다. */
function StatusBadge({ st }) {
  const b = badgeOf(st);
  if (!b) return null;
  return <span className={`stg-badge tone-${b.tone}`} title={b.text}>{b.short}</span>;
}

/** 설정 — 관리자용 하위 메뉴. 왼쪽 목록(묶음 · 검색 · 즐겨찾기 · 최근 · 상태 요약) + 본문(v2.916 — A안 + 상태 요약). */
export default function Settings({ initialSub }) {
  // 하위 탭을 URL(#/settings/<키>)에 싣는다(v2.438) — 새로고침해도 보던 화면이 유지되고 링크 공유도 된다.
  const [sub, setSub] = useHashTab({
    base: ['settings'], valid: SUB_KEYS,
    fallback: SUB_KEYS.includes(initialSub) ? initialSub : DEFAULT_SUB,
  });
  const cur = SUB.find((s) => s.k === sub) || SUB[0];
  const Cur = cur.C;
  const visible = visibleSubs();

  const [query, setQuery] = useState('');
  const [gradeFilter, setGradeFilter] = useState(null);
  const [openGroups, setOpenGroups] = useState(() => new Set([cur.group]));
  const [navOpen, setNavOpen] = useState(false);          // 좁은 화면(목록이 접힌 상태)에서 목록 펼침
  const [recent, setRecent] = useState(() => readKeyList(lsRead(LS_RECENT), SUB_KEYS, 5));
  const [fav, setFav] = useState(() => readKeyList(lsRead(LS_FAV), SUB_KEYS, 12));
  const [status, setStatus] = useState({ items: null, state: 'loading', at: null });
  const [copied, setCopied] = useState(false);
  const searchRef = useRef(null);
  const seqRef = useRef(0);

  // 상태 배지 — 마운트 1회 · 60초마다 · 항목을 옮길 때(서버는 3초 single-flight · no-store — 저장 직후 옮기면 새 값). 늦게 온 이전 응답은 버린다.
  // '다시 읽기' 버튼은 fresh=1 — 서버의 3초 합치기도 건너뛴다(설정을 막 저장한 뒤 누르는 버튼이다).
  const loadStatus = useCallback(async (fresh = false) => {
    const seq = ++seqRef.current;
    try {
      const r = await fetchJson('/admin/settings/status', fresh === true ? { fresh: '1' } : {}, undefined, { retries: 0 });
      if (seq !== seqRef.current) return;
      setStatus({ items: r?.items && typeof r.items === 'object' ? r.items : null, state: r?.items ? 'ok' : 'error', at: r?.at || null });
    } catch (e) {
      if (seq !== seqRef.current) return;
      // 403 = 범위가 지정된 소유자 등(배지는 설정 소유자 ∧ 전체 범위만). 값이 없을 뿐 '정상' 이 아니다 — 목록 바닥에 이유를 적는다.
      // 다시 읽기만 실패했으면 직전 배지를 두되 '언제 기준인지' 를 함께 적는다(배지를 지워 정상처럼 보이게 하지 않는다).
      if (e?.status === 403) setStatus({ items: null, state: 'forbidden', at: null });
      else setStatus((prev) => ({ items: prev.items, state: 'error', at: prev.at }));
    }
  }, []);
  useEffect(() => { const t = setInterval(() => loadStatus(), STATUS_POLL_MS); return () => clearInterval(t); }, [loadStatus]);
  useEffect(() => { loadStatus(); }, [sub, loadStatus]);   // 마운트 때 한 번 + 항목을 옮길 때

  // 항목을 옮기면: 그 묶음을 펼치고 · 최근에 넣고 · 좁은 화면의 펼친 목록을 닫는다.
  useEffect(() => {
    setOpenGroups((prev) => (prev.has(cur.group) ? prev : new Set([...prev, cur.group])));
    setRecent((prev) => { const next = pushRecent(prev, sub, SUB_KEYS, 5); lsWrite(LS_RECENT, next); return next; });
    setNavOpen(false);
    setCopied(false);
  }, [sub, cur.group]);

  // '/' 로 검색 상자에 들어간다(입력 중 · 조합 키는 제외 — settingsMenu.isSearchHotkey).
  useEffect(() => {
    const onKey = (e) => { if (isSearchHotkey(e)) { e.preventDefault(); setNavOpen(true); searchRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const statusItems = status.items;
  const searching = query.trim().length > 0 || !!gradeFilter;
  const results = filterByGrade(searchItems(visible, query, NAV_GROUP_LABEL), statusItems, gradeFilter);
  const summary = summarize(visible, statusItems);
  const isFav = fav.includes(cur.k);
  const toggleGroup = (g) => setOpenGroups((prev) => { const n = new Set(prev); if (n.has(g)) n.delete(g); else n.add(g); return n; });
  const flipFav = () => setFav((prev) => { const next = toggleFav(prev, cur.k); lsWrite(LS_FAV, next); return next; });
  const pick = (k) => { setSub(k); setQuery(''); setGradeFilter(null); };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#/settings/${cur.k}`); setCopied(true); }
    catch { setCopied(false); }
  };
  const byKey = (k) => visible.find((s) => s.k === k);

  const itemRow = (s, { showGroup = false } = {}) => {
    const on = s.k === sub;
    return (
      <li key={s.k}>
        <a href={`#/settings/${s.k}`} className={`stg-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}
          onClick={(e) => { if (plainClick(e)) { e.preventDefault(); pick(s.k); } }}>
          <span className="stg-dot" aria-hidden="true" />
          <span className="stg-label">{s.label}{showGroup && <span className="stg-sub">{GROUPS[s.group]?.label}</span>}</span>
          {s.superOnly && <Icon name="lock" size={11} className="stg-lock" title="슈퍼 관리자 전용" />}
          <StatusBadge st={statusItems?.[s.k]} />
        </a>
      </li>
    );
  };

  const curSt = statusItems?.[cur.k];
  const curBadge = badgeOf(curSt);

  return (
    // 컨테이너 쿼리는 컨테이너의 **자손**에만 걸린다 — 폭을 재는 상자(.stg-cq)와 접히는 줄(.stg)을 나눈다(같은 요소면 400px 에서 접히지 않는다).
    <div className="stg-cq"><div className={`stg${navOpen ? ' nav-open' : ''}`}>
      <aside className="stg-nav" aria-label="설정 항목">
        <div className="stg-head">
          <div className="stg-title">설정</div>
          <label className="stg-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} type="search" value={query} placeholder={`설정 검색 — ${visible.length}개 항목`} aria-label="설정 검색"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results[0]) { e.preventDefault(); pick(results[0].k); }
                if (e.key === 'Escape') { setQuery(''); setGradeFilter(null); }
              }} />
            <kbd className="stg-kbd" aria-hidden="true">/</kbd>
          </label>
          {/* B안 상태 요약 — 누르면 그 상태 항목만 남긴다(다시 누르면 해제). 꺼짐은 장애가 아니라 맨 뒤에 흐리게. */}
          {statusItems && (
            <div className="stg-summary" role="group" aria-label="상태 요약">
              {SUMMARY_ORDER.filter((g) => summary[g] > 0).map((g) => (
                <button key={g} type="button" className={`stg-chip tone-${g}${gradeFilter === g ? ' on' : ''}`} aria-pressed={gradeFilter === g}
                  onClick={() => setGradeFilter((f) => (f === g ? null : g))}>{SUMMARY_LABEL[g]} {summary[g]}</button>
              ))}
              {SUMMARY_ORDER.every((g) => !summary[g]) && <span className="stg-allok">표시할 상태 없음</span>}
              <button type="button" className="stg-refresh" onClick={() => loadStatus(true)} aria-label="상태 다시 읽기" title="상태 다시 읽기"><Icon name="refresh" size={13} /></button>
            </div>
          )}
        </div>

        {/* 좁은 화면: 목록 대신 현재 위치 한 줄 — 누르면 목록이 펼쳐진다. 넓은 화면에서는 CSS 가 숨긴다. */}
        <button type="button" className="stg-cur" aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)}>
          <span className="stg-cur-g">{GROUPS[cur.group]?.label}</span>
          <span className="stg-sep" aria-hidden="true">›</span>
          <span className="stg-cur-k">{cur.label}</span>
          <Icon name="chevronDown" size={14} className="stg-cur-chev" />
        </button>

        <nav className="stg-list" aria-label="설정 목록">
          {searching ? (
            results.length ? <ul className="stg-items">{results.map((s) => itemRow(s, { showGroup: true }))}</ul>
              : <div className="stg-empty">맞는 항목이 없습니다.</div>
          ) : (
            <>
              {fav.some(byKey) && (
                <div className="stg-group">
                  <div className="stg-ghead static"><Icon name="star" size={12} />즐겨찾기</div>
                  <ul className="stg-items">{fav.map(byKey).filter(Boolean).map((s) => itemRow(s, { showGroup: true }))}</ul>
                </div>
              )}
              {GROUP_ORDER.map((g) => {
                const kids = visible.filter((s) => s.group === g);
                if (!kids.length) return null;
                const open = openGroups.has(g);
                const tone = groupTone(kids, statusItems);
                return (
                  <div className="stg-group" key={g}>
                    <button type="button" className={`stg-ghead${cur.group === g ? ' cur' : ''}`} aria-expanded={open} onClick={() => toggleGroup(g)}>
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                      <span className="stg-glabel">{GROUPS[g].label}</span>
                      {tone && <span className={`stg-gdot tone-${tone}`} role="img" aria-label={SUMMARY_LABEL[tone]} />}
                      <span className="stg-gcount">{kids.length}</span>
                    </button>
                    {open && <ul className="stg-items">{kids.map((s) => itemRow(s))}</ul>}
                  </div>
                );
              })}
            </>
          )}
        </nav>

        <div className="stg-foot">
          {recent.filter((k) => k !== sub && byKey(k)).length > 0 && (
            <div className="stg-recent">
              <Icon name="clock" size={12} />
              <span className="stg-recent-l">최근</span>
              {recent.filter((k) => k !== sub && byKey(k)).slice(0, 3).map((k) => (
                <a key={k} href={`#/settings/${k}`} onClick={(e) => { if (plainClick(e)) { e.preventDefault(); pick(k); } }}>{byKey(k).label}</a>
              ))}
            </div>
          )}
          {status.state === 'forbidden' && <div className="stg-note">상태 배지는 전체 범위 설정 소유자에게만 보입니다.</div>}
          {status.state === 'error' && (
            <div className="stg-note warn">
              {statusItems && status.at ? `상태를 다시 읽지 못했습니다 — 보이는 배지는 ${hhmm(status.at)} 기준입니다.` : '상태를 읽지 못했습니다 — 배지가 없다고 정상인 것은 아닙니다.'}
              {' '}<button type="button" className="stg-link" onClick={() => loadStatus(true)}>다시 읽기</button>
            </div>
          )}
        </div>
      </aside>

      <section className="stg-main" aria-label={cur.label}>
        {/* 좁은 화면: 같은 묶음의 다른 항목 — 한 줄 가로 칩(본문을 아래로 밀지 않게). 넓은 화면에서는 CSS 가 숨긴다. */}
        <div className="stg-sibs" role="group" aria-label={`${GROUPS[cur.group]?.label} 항목`}>
          {visible.filter((s) => s.group === cur.group).map((s) => (
            <a key={s.k} href={`#/settings/${s.k}`} className={`stg-sib${s.k === sub ? ' on' : ''}`} aria-current={s.k === sub ? 'page' : undefined}
              onClick={(e) => { if (plainClick(e)) { e.preventDefault(); pick(s.k); } }}>{s.label}</a>
          ))}
        </div>
        <div className="stg-crumb">
          <span>설정</span><span className="stg-sep" aria-hidden="true">›</span>
          <span>{GROUPS[cur.group]?.label}</span><span className="stg-sep" aria-hidden="true">›</span>
          <span className="stg-crumb-cur">{cur.label}</span>
          <span className="stg-actions">
            <button type="button" className="btn stg-act" aria-pressed={isFav} onClick={flipFav} title={isFav ? '즐겨찾기에서 빼기' : '즐겨찾기에 넣기'}>
              <Icon name="star" size={13} stroke={isFav ? 'var(--amber)' : 'currentColor'} />{isFav ? '즐겨찾기 됨' : '즐겨찾기'}
            </button>
            <button type="button" className="btn stg-act" onClick={copyLink} title="이 설정 화면의 주소를 복사합니다">
              <Icon name="link" size={13} />{copied ? '복사됨' : '링크 복사'}
            </button>
          </span>
        </div>
        <h2 className="stg-h">{cur.label}</h2>
        <div className="stg-desc">{cur.desc}</div>
        {curBadge && <div className={`stg-curst tone-${curBadge.tone}`}><StatusBadge st={curSt} /><span>{curBadge.text}</span></div>}
        {/* lazy 화면의 첫 로드 동안만 잠깐 보인다 — 이미 받은 청크는 즉시 그려진다. */}
        <div className="stg-body"><Suspense fallback={<Loading />}><Cur /></Suspense></div>
      </section>
    </div></div>
  );
}
