import React, { useState } from 'react';
import VCenterAdmin from './VCenterAdmin.jsx';
import DatacenterAdmin from './DatacenterAdmin.jsx';
import VCenterConnTest from './VCenterConnTest.jsx';
import NsxAdmin from './NsxAdmin.jsx';
import IdracAdmin from './IdracAdmin.jsx';
import Collectors from './Collectors.jsx';
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
import AnomalyDetection from './AnomalyDetection.jsx';
import SessionSecurity from './SessionSecurity.jsx';
import Upgrade from './Upgrade.jsx';
import About from './About.jsx';

// 모든 하위 화면 정의(키→라벨→컴포넌트). 그룹에 속한 항목은 group 키로 묶는다.
const SUB = [
  { k: 'datacenter-admin', label: 'DataCenter(법인)', C: DatacenterAdmin },
  // --- vCenter 관리 그룹 ---
  { k: 'vcenter-admin', label: 'vCenter 등록·관리', C: VCenterAdmin, group: 'vcenter' },
  { k: 'vcenter-test', label: 'vCenter 연결 테스트', C: VCenterConnTest, group: 'vcenter' },
  { k: 'nsx-admin', label: 'NSX 관리', C: NsxAdmin },
  // --- 수집 서버 그룹 ---
  { k: 'idrac-admin', label: 'iDRAC 서버 등록', C: IdracAdmin, group: 'collect' },
  { k: 'metrics', label: '지표 수집', C: MetricsSettings, group: 'collect' },
  // --- GPU 사용량 수집 그룹 ---
  { k: 'gpu-collect', label: 'GPU 수집', C: GpuSettings, group: 'gpu' },
  { k: 'gpu-guest', label: 'GPU 게스트 수집', C: GpuGuestSettings, group: 'gpu' },
  { k: 'gpu-guest-diag', label: 'GPU 수집 진단', C: GpuGuestDiag, group: 'gpu' },
  { k: 'guest-account', label: '게스트 계정 추가', C: GuestAccount, group: 'collect' },
  { k: 'collectors', label: '수집 서버(원격)', C: Collectors, group: 'collect' },
  { k: 'agent-deploy', label: '원격 법인(DC)에 Edge 노드 포탈 설치', C: AgentDeploy, group: 'collect' },
  // --- 원격 접속 서버 그룹 ---
  { k: 'proxy', label: '중계 서버', C: ProxySettings, group: 'remote-srv' },
  { k: 'remote', label: '원격접속 설정', C: RemoteAccess, group: 'remote-srv' },
  // --- User Control 그룹 ---
  { k: 'users', label: '사용자 관리', C: UserAdmin, group: 'usercontrol' },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings, group: 'usercontrol' },
  // --- Security 그룹 ---
  { k: 'session-security', label: '세션 보안', C: SessionSecurity, group: 'security' },
  { k: 'anomaly', label: '이상동작 탐지', C: AnomalyDetection, group: 'security' },
  { k: 'ai-search', label: 'AI 검색', C: LlmSettings },
  { k: 'alerts', label: '알림', C: Alerts2 },
  { k: 'backup', label: '포탈 백업', C: PortalBackup },
  { k: 'vclogs', label: 'vCenter 로그 보관', C: VcenterLogs, group: 'log' },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics, group: 'log' },
  { k: 'audit', label: '감사 로그', C: Audit, group: 'log' },
  // 업그레이드: 상단 '업그레이드' 탭은 SHOW_UPGRADE_TAB로 숨겨져 있어도, 관리자 설정 안에서는
  // 항상 접근 가능하게 둔다(오프라인 업그레이드 번들 적용/원격 자동 업그레이드 설정).
  { k: 'upgrade', label: '⬆ 업그레이드', C: Upgrade },
  { k: 'about', label: 'About', C: About },
];

// 수집/원격접속 관련 화면을 2개 그룹으로 묶어 상단을 단순화(서버가 많아 보이지 않게).
const GROUPS = {
  vcenter: { label: '🖥️ vCenter 관리', desc: 'vCenter 등록·관리와 연결 테스트를 한 곳에서.' },
  collect: { label: '🗄 수집 서버', desc: 'iDRAC 전력·지표 수집 + 게스트 계정 + 원격 수집 서버 등록 + 분산 에이전트 배포를 한 곳에서.' },
  gpu: { label: '🎮 GPU 사용량 수집', desc: 'GPU 수집(ESXi vGPU/사용률) · GPU 게스트 수집(패스쓰루, 게스트 OS 내부) · GPU 수집 진단을 한 곳에서.' },
  'remote-srv': { label: '🔌 원격 접속 서버', desc: '브라우저 SSH/RDP 중계 서버(프록시)와 원격접속 설정을 한 곳에서.' },
  usercontrol: { label: '👤 User Control', desc: '사용자 계정(역할·2FA)과 인증(AD/LDAP) 연동을 한 곳에서.' },
  security: { label: '🛡️ Security', desc: '세션 보안과 이상동작 탐지를 한 곳에서.' },
  log: { label: '📋 Log', desc: 'vCenter 로그 보관 · 진단·로그 · 감사 로그를 한 곳에서.' },
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
      <Cur />
    </>
  );
}
