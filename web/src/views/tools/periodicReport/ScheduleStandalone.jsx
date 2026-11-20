/**
 * ScheduleStandalone — 설정 › 알림 · 메일 › 정기 점검 보고(v3.31). 특수 기능 › 정기 점검 보고 의 '일정 · 전달' 과 같은 화면(ScheduleTab)을 .prr 틀 안에 싣는다.
 */
import React from 'react';
import ScheduleTab from './ScheduleTab.jsx';
import './periodicReport.css';

export default function ScheduleStandalone() {
  return <div className="prr"><ScheduleTab standalone /></div>;
}
