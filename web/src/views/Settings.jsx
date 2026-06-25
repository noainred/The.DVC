import React, { useState } from 'react';
import VCenterAdmin from './VCenterAdmin.jsx';
import VCenterConnTest from './VCenterConnTest.jsx';
import NsxAdmin from './NsxAdmin.jsx';
import IdracAdmin from './IdracAdmin.jsx';
import Collectors from './Collectors.jsx';
import AgentScans from './AgentScans.jsx';
import AgentDeploy from './AgentDeploy.jsx';
import ProxySettings from './ProxySettings.jsx';
import RemoteAccess from './RemoteAccess.jsx';
import AdSettings from './AdSettings.jsx';
import LlmSettings from './LlmSettings.jsx';
import UserAdmin from './UserAdmin.jsx';
import Diagnostics from './Diagnostics.jsx';
import Alerts2 from './Alerts2.jsx';
import Audit from './Audit.jsx';
import MetricsSettings from './MetricsSettings.jsx';
import GpuGuestSettings from './GpuGuestSettings.jsx';
import GpuGuestDiag from './GpuGuestDiag.jsx';
import GpuSettings from './GpuSettings.jsx';
import PortalBackup from './PortalBackup.jsx';
import VcenterLogs from './VcenterLogs.jsx';
import GuestAccount from './GuestAccount.jsx';
import LoginFails from './LoginFails.jsx';
import NetIssues from './NetIssues.jsx';
import AnomalyDetection from './AnomalyDetection.jsx';
import SessionSecurity from './SessionSecurity.jsx';
import About from './About.jsx';

// 모든 하위 화면 정의(키→라벨→컴포넌트). 그룹에 속한 항목은 group 키로 묶는다.
const SUB = [
  { k: 'vcenter-admin', label: 'vCenter 관리', C: VCenterAdmin },
  { k: 'vcenter-test', label: 'vCenter 연결 테스트', C: VCenterConnTest },
  { k: 'nsx-admin', label: 'NSX 관리', C: NsxAdmin },
  // --- 수집 서버 그룹 ---
  { k: 'idrac-admin', label: '전력 수집', C: IdracAdmin, group: 'collect' },
  { k: 'metrics', label: '지표 수집', C: MetricsSettings, group: 'collect' },
  { k: 'gpu-collect', label: 'GPU 수집', C: GpuSettings, group: 'collect' },
  { k: 'gpu-guest', label: 'GPU 게스트 수집', C: GpuGuestSettings, group: 'collect' },
  { k: 'gpu-guest-diag', label: 'GPU 수집 진단', C: GpuGuestDiag, group: 'collect' },
  { k: 'guest-account', label: '게스트 계정 추가', C: GuestAccount, group: 'collect' },
  { k: 'collectors', label: '수집 서버(원격)', C: Collectors, group: 'collect' },
  { k: 'agent-scans', label: '에이전트 작업', C: AgentScans, group: 'collect' },
  { k: 'agent-deploy', label: '에이전트 배포', C: AgentDeploy, group: 'collect' },
  // --- 원격 접속 서버 그룹 ---
  { k: 'proxy', label: '중계 서버', C: ProxySettings, group: 'remote-srv' },
  { k: 'remote', label: '원격접속 설정', C: RemoteAccess, group: 'remote-srv' },
  { k: 'users', label: '사용자 관리', C: UserAdmin },
  { k: 'session-security', label: '세션 보안', C: SessionSecurity },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings },
  { k: 'ai-search', label: 'AI 검색', C: LlmSettings },
  { k: 'alerts', label: '알림', C: Alerts2 },
  { k: 'anomaly', label: '이상동작 탐지', C: AnomalyDetection },
  { k: 'backup', label: '포탈 백업', C: PortalBackup },
  { k: 'vclogs', label: 'vCenter 로그 보관', C: VcenterLogs },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics },
  { k: 'audit', label: '감사 로그', C: Audit },
  { k: 'login-fails', label: '로그인 실패 분석', C: LoginFails },
  { k: 'net-issues', label: '네트워크 이슈 분석', C: NetIssues },
  { k: 'about', label: 'About', C: About },
];

// 수집/원격접속 관련 화면을 2개 그룹으로 묶어 상단을 단순화(서버가 많아 보이지 않게).
const GROUPS = {
  collect: { label: '🗄 수집 서버', desc: '전력·지표·GPU 게스트 수집 + 원격 수집 서버 등록 + 분산 에이전트 작업/배포를 한 곳에서.' },
  'remote-srv': { label: '🔌 원격 접속 서버', desc: '브라우저 SSH/RDP 중계 서버(프록시)와 원격접속 설정을 한 곳에서.' },
};
const groupChildren = (g) => SUB.filter((s) => s.group === g);

/** 설정 — 관리자용 하위 메뉴. 수집/원격접속은 2개 그룹으로 묶어 2단 탭으로 표시. */
export default function Settings({ initialSub }) {
  const [sub, setSub] = useState(SUB.some((s) => s.k === initialSub) ? initialSub : 'vcenter-admin');
  const cur = SUB.find((s) => s.k === sub) || SUB[0];
  const Cur = cur.C;
  const activeGroup = cur.group || null;

  // 상단 1단 탭: 그룹에 속하지 않은 항목 + 각 그룹 대표 버튼(순서 유지).
  const topItems = [];
  const seen = new Set();
  for (const s of SUB) {
    if (s.group) { if (!seen.has(s.group)) { seen.add(s.group); topItems.push({ type: 'group', key: s.group, label: GROUPS[s.group].label }); } }
    else topItems.push({ type: 'leaf', key: s.k, label: s.label });
  }
  const selectGroup = (g) => { const first = groupChildren(g)[0]; if (first) setSub(first.k); };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>⚙️ 설정</div>
      <div className="vcd-views" style={{ marginBottom: activeGroup ? 8 : 16 }}>
        {topItems.map((t) => {
          const active = t.type === 'group' ? activeGroup === t.key : sub === t.key;
          return (
            <button key={t.key} className={active ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }}
              onClick={() => (t.type === 'group' ? selectGroup(t.key) : setSub(t.key))}>{t.label}</button>
          );
        })}
      </div>
      {activeGroup && (
        <>
          <div className="vcd-views" style={{ marginBottom: 8, paddingLeft: 6, borderLeft: '2px solid var(--accent,#2563eb)' }}>
            {groupChildren(activeGroup).map((s) => (
              <button key={s.k} className={sub === s.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 13px', fontSize: 13 }} onClick={() => setSub(s.k)}>{s.label}</button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>{GROUPS[activeGroup].desc}</div>
        </>
      )}
      <Cur />
    </>
  );
}
