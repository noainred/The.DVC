// gpu-guest/shared.jsx — GpuGuestSettings.jsx(구 891줄) 분리(v2.295, 1차 감사 확정 #4·#8)의
// 공용 소품. Field(라벨 폼 셀)는 셸의 전역 설정 폼과 PhysicalGpuManager 폼 양쪽이,
// fmtAgo(상대시각)는 셸 상태 카드와 VmCredManager 가 쓴다 — 복제하면 표기가 갈라지므로 1곳.
import React from 'react';

// v2.613 DEPS2613-11: fmtAgo 사본 제거 — 호출부가 util/fmt.fmtAgo(ts, { dash: '없음' }) 를 직접 쓴다.
export function Field({ label, children }) {
  return <div><label className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>{label}</label>{children}</div>;
}
