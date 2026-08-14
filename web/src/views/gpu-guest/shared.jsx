// gpu-guest/shared.jsx — GpuGuestSettings.jsx(구 891줄) 분리(v2.295, 1차 감사 확정 #4·#8)의
// 공용 소품. Field(라벨 폼 셀)는 셸의 전역 설정 폼과 PhysicalGpuManager 폼 양쪽이,
// fmtAgo(상대시각)는 셸 상태 카드와 VmCredManager 가 쓴다 — 복제하면 표기가 갈라지므로 1곳.
import React from 'react';

export const fmtAgo = (ts) => {
  if (!ts) return '없음';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};
export function Field({ label, children }) {
  return <div><label className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{label}</label>{children}</div>;
}
