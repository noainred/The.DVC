import React, { useState } from 'react';
import VCenterAdmin from './VCenterAdmin.jsx';
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
import About from './About.jsx';

const SUB = [
  { k: 'vcenter-admin', label: 'vCenter 관리', C: VCenterAdmin },
  { k: 'nsx-admin', label: 'NSX 관리', C: NsxAdmin },
  { k: 'idrac-admin', label: '전력 수집', C: IdracAdmin },
  { k: 'collectors', label: '수집 서버', C: Collectors },
  { k: 'agent-scans', label: '에이전트 작업', C: AgentScans },
  { k: 'agent-deploy', label: '에이전트 배포', C: AgentDeploy },
  { k: 'proxy', label: '중계 서버', C: ProxySettings },
  { k: 'remote', label: '원격접속 설정', C: RemoteAccess },
  { k: 'users', label: '사용자 관리', C: UserAdmin },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings },
  { k: 'ai-search', label: 'AI 검색', C: LlmSettings },
  { k: 'alerts', label: '알림', C: Alerts2 },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics },
  { k: 'audit', label: '감사 로그', C: Audit },
  { k: 'about', label: 'About', C: About },
];

/** 설정 — 관리자용 하위 메뉴(vCenter 관리/전력 수집/수집 서버/에이전트 작업/진단). */
export default function Settings({ initialSub }) {
  const [sub, setSub] = useState(SUB.some((s) => s.k === initialSub) ? initialSub : 'vcenter-admin');
  const Cur = (SUB.find((s) => s.k === sub) || SUB[0]).C;
  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>⚙️ 설정</div>
      <div className="vcd-views" style={{ marginBottom: 16 }}>
        {SUB.map((s) => (
          <button key={s.k} className={sub === s.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setSub(s.k)}>{s.label}</button>
        ))}
      </div>
      <Cur />
    </>
  );
}
