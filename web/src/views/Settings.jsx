import React, { useState } from 'react';
import VCenterAdmin from './VCenterAdmin.jsx';
import IdracAdmin from './IdracAdmin.jsx';
import Collectors from './Collectors.jsx';
import AgentScans from './AgentScans.jsx';
import AdSettings from './AdSettings.jsx';
import UserAdmin from './UserAdmin.jsx';
import Diagnostics from './Diagnostics.jsx';

const SUB = [
  { k: 'vcenter-admin', label: 'vCenter 관리', C: VCenterAdmin },
  { k: 'idrac-admin', label: '전력 수집', C: IdracAdmin },
  { k: 'collectors', label: '수집 서버', C: Collectors },
  { k: 'agent-scans', label: '에이전트 작업', C: AgentScans },
  { k: 'users', label: '사용자 관리', C: UserAdmin },
  { k: 'auth-ad', label: '인증(AD)', C: AdSettings },
  { k: 'diagnostics', label: '진단·로그', C: Diagnostics },
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
