// v2.707(C7) — VM 이전 준비도 문구. 판정은 서버 migration/analyze.js(코드 키 1:1 — 테스트 대조). 백틱·별표 금지.
export const MIG_CODES = Object.freeze({
  'rdm-physical': 'blocked', 'multi-writer': 'blocked', 'gpu-passthrough': 'blocked', question: 'blocked', consolidation: 'blocked',
  vgpu: 'caution', snapshots: 'caution', usb: 'caution', 'serial-parallel': 'caution', 'cdrom-connected': 'caution',
  'disk-independent': 'caution', 'disk-nonpersistent': 'caution', 'hw-old': 'caution', 'tools-missing': 'caution', 'tools-old': 'caution',
  managed: 'caution', reservation: 'caution',
});
export const MIG_TEXT = Object.freeze({
  'rdm-physical': { title: '물리 호환 RDM 디스크', fix: '디스크를 그대로 옮길 수 없습니다 · 가상 디스크로 바꾸거나 대상 호스트에 같은 LUN 을 다시 매핑하세요' },
  'multi-writer': { title: '다중 쓰기 공유 디스크', fix: '공유하는 VM 묶음을 함께 옮겨야 합니다 · 한 VM 만 옮기면 공유가 깨집니다' },
  'gpu-passthrough': { title: 'PCI 패스스루 GPU', fix: '실시간 이전이 안 됩니다 · 대상 호스트에 같은 장치가 있어야 하고 전원을 끄고 옮겨야 합니다' },
  question: { title: '응답 대기 질문', fix: 'VM 이 질문에 멈춰 있습니다 · vCenter 에서 먼저 응답하세요' },
  consolidation: { title: '디스크 통합 필요', fix: '스냅샷 정리 후 남은 델타가 있습니다 · 먼저 통합하세요' },
  vgpu: { title: 'vGPU', fix: '대상 호스트에 같은 GPU·프로파일 여유가 있어야 합니다' },
  snapshots: { title: '스냅샷 있음', fix: '옮기기 전에 정리하면 시간과 대상 공간이 줄어듭니다' },
  usb: { title: 'USB 장치', fix: '호스트 USB 장치면 옮긴 뒤 연결이 끊깁니다' },
  'serial-parallel': { title: '직렬·병렬 포트', fix: '호스트 장치·네트워크 백킹이 대상에도 있는지 확인하세요' },
  'cdrom-connected': { title: '연결된 CD/DVD', fix: '호스트 장치나 ISO 경로가 대상에 없을 수 있습니다 · 연결을 끊고 옮기세요' },
  'disk-independent': { title: '독립 디스크', fix: '스냅샷 기반 이전·백업 도구에서 빠질 수 있습니다' },
  'disk-nonpersistent': { title: '비영구 디스크', fix: '전원을 끄면 변경이 사라집니다 · 옮기는 방법에 주의하세요' },
  'hw-old': { title: '오래된 가상 하드웨어 버전', fix: '대상 플랫폼이 지원하는지 확인하고 필요하면 업그레이드하세요' },
  'tools-missing': { title: 'VMware Tools 없음·미실행', fix: '이전 뒤 게스트 상태 확인·정상 종료가 어렵습니다 · Tools 를 설치·실행하세요' },
  'tools-old': { title: 'VMware Tools 오래됨', fix: '이전 전에 업데이트를 권장합니다' },
  managed: { title: '솔루션이 관리하는 VM', fix: '복제·백업 어플라이언스 등 그 솔루션의 절차로 옮기세요' },
  reservation: { title: 'CPU·메모리 예약', fix: '대상 클러스터에 예약만큼 여유가 있어야 합니다' },
});
export const LEVEL_LABEL = Object.freeze({ blocked: '막힘', caution: '확인 필요', unknown: '판정 불가', ready: '준비됨' });
export const LEVEL_BADGE = Object.freeze({ blocked: 'red', caution: 'amber', unknown: 'gray', ready: 'green' });
export function readyPctText(v) { return v == null ? '—' : `${v}%`; }
export function unknownNote(data) {
  const n = data?.counts?.unknown || 0;
  if (!n) return null;
  return `구성·장치를 아직 읽지 않은 VM ${n.toLocaleString()}대는 '판정 불가' 입니다(막는 요인이 장치에 있을 수 있어 준비됨으로 세지 않습니다) — 수집 서버가 주기마다 나눠 읽습니다. 준비율은 판정한 VM 기준입니다.`;
}
export const SCOPE_NOTE = '다른 클러스터·vCenter·클라우드로 옮기는 일반 조건을 봅니다 — 대상 플랫폼의 세부 조건(지원 OS·하드웨어 버전·네트워크)은 따로 확인하세요.';
