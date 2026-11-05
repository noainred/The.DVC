/**
 * components/VmMetrics.jsx — '📈 성능 그래프 보기' 단추(VM · ESXi 호스트). v2.911(시안 docs/design/vm-perf ② · 사용자 컨펌 '개선'):
 *   예전에는 여기의 MetricModal(900px 모달 · recharts · 지표마다 vCenter 로그인)을 띄웠다. 이제 성능은 **개체 보기 › 모니터 탭의 첫 섹션**
 *   (components/vmperf/VmPerfView.jsx · 주소 #/vcenters/<vc>/vm|host/<id>/monitor)이고, 이 단추는 그 주소로 **이동**한다 — 새로고침 · 공유 · 뒤로 가기가 된다.
 *   vcenterId 를 모르면 그리지 않는다(id 를 콜론에서 잘라 vCenter 를 지어내지 않는다 — v2.598 VC2598-06). onBefore 는 드로어 · 모달이 자기를 닫는 데 쓴다.
 *   이름(VmMetricButton · HostMetricButton)은 그대로다 — 호출처 7곳 · idracLink2676 테스트(버튼 순서)가 이 이름을 본다.
 */
import React from 'react';
import { vcHash } from '../views/vcd/vcdRoute.js';

function MetricLink({ type, id, label, vcenterId, onBefore }) {
  if (!id || !vcenterId) return null;
  const href = vcHash(vcenterId, { type, id, tab: 'monitor' });
  return (
    <a className="login-btn" style={{ flex: 'none', padding: '8px 14px', whiteSpace: 'nowrap', textDecoration: 'none' }} href={href}
      title={`${label || id} 의 성능(CPU · 메모리 · 디스크 · 네트워크)을 개체 보기 › 모니터에서 봅니다`}
      onClick={() => { if (typeof onBefore === 'function') onBefore(); }}>📈 성능 그래프 보기</a>
  );
}

/** VM 성능 — 개체 보기 › 모니터 › 성능으로. */
export function VmMetricButton({ vmId, vmName, vcenterId, onBefore }) {
  return <MetricLink type="vm" id={vmId} label={vmName} vcenterId={vcenterId} onBefore={onBefore} />;
}

/** ESXi 호스트 성능 — 호스트 개체 보기 › 모니터 › 성능으로. */
export function HostMetricButton({ hostId, hostName, vcenterId, onBefore }) {
  return <MetricLink type="host" id={hostId} label={hostName} vcenterId={vcenterId} onBefore={onBefore} />;
}
