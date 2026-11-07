/**
 * vmCvpLocText.js — VM 상세 ‘네트워크 위치(CVP)’ 카드 문구(순수, v2.929 SAN·CVP 설계 C-③). 서버 /vms/:id/endpoint-locations 응답을 글자로.
 *   판정은 서버(호스트 업링크 포트 집합과 비교)가 하고, 여기서는 이름 · 색 · 이유만 붙인다. 모르면 ‘판정 보류’ — ‘없음’ 으로 단정하지 않는다.
 */
import { epCycleText } from '../hostNetText.js';

export const VERDICT = Object.freeze({
  match: { label: '일치', tone: 'green', note: 'CVP 가 이 vNIC MAC 을 지금 호스트의 업링크 포트에서 배웠습니다' },
  mismatch: { label: '불일치', tone: 'amber', note: '다른 포트에서 배웠습니다 — vMotion 직후 옛 위치이거나(학습 시각 확인) 다른 경로입니다' },
  unknown: { label: '판정 보류', tone: 'gray', note: '이 호스트의 업링크 포트를 아직 모릅니다(LLDP · 호스트 NIC 위치 없음)' },
  none: { label: '위치 없음', tone: 'gray', note: 'CVP 가 이 MAC 을 MAC · ARP · DHCP · 인벤토리 표 어디에서도 찾지 못했습니다(꺼진 VM · 격리 포트그룹 등)' },
  error: { label: '조회 오류', tone: 'red', note: 'CVP 에 물었지만 오류가 났습니다' },
  unsupported: { label: 'CVP 미지원', tone: 'gray', note: '이 CVP 에 EndpointLocation API 가 없습니다(2021.1 이상 필요)' },
  'not-asked': { label: '아직 안 물음', tone: 'gray', note: '아직 물어보지 않았습니다 — 지금 조회 버튼으로 바로 물을 수 있습니다' },
});
export const verdictOf = (k) => VERDICT[k] || VERDICT.unknown;

const hm = (iso) => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const colonMac = (m) => (/^[0-9a-f]{12}$/.test(String(m || '')) ? m.replace(/(..)(?=.)/g, '$1:') : String(m || ''));

/** 표 행. */
export function locRows(d) {
  return (Array.isArray(d?.rows) ? d.rows : []).map((r) => ({
    key: r.mac, label: r.label || '—', mac: colonMac(r.mac), verdict: r.verdict, v: verdictOf(r.verdict),
    where: (r.locations || []).map((l) => `${l.hostname || '?'} ${l.port || ''}`.trim()).join(' · ') || '—',
    vlan: (r.locations || []).map((l) => l.vlan).filter((x) => x != null).join(', ') || '—',
    learned: (r.locations || []).map((l) => hm(l.learnedAt)).filter(Boolean)[0] || '—',
    reason: r.reason || '',
    note: r.note || '',   // 서버가 판정을 보류한 이유(LAG · 위치 모르는 업링크 NIC · DB 못 읽음)
  }));
}
/** 카드 머리 한 줄 — 일치 · 불일치 · 그 밖 개수. */
export function locSummary(d) {
  const rows = Array.isArray(d?.rows) ? d.rows : [];
  if (d?.unavailable) return 'CVP 위치 DB 를 읽지 못했습니다(물어본 적이 없다는 뜻이 아닙니다)';
  if (!rows.length) return d?.servers === 0 ? '이 VM 법인에 등록된 CVP 가 없습니다' : 'vNIC MAC 을 아직 읽지 않았습니다(VM 장치 정보)';
  const n = (k) => rows.filter((r) => r.verdict === k).length;
  const parts = [`vNIC ${rows.length}`, `일치 ${n('match')}`, `불일치 ${n('mismatch')}`];
  const other = rows.length - n('match') - n('mismatch');
  if (other) parts.push(`그 밖 ${other}`);
  if (!d.hostPortsKnown) parts.push('호스트 업링크 포트를 몰라 판정 보류');
  if (d.pending) parts.push('엣지 조회 요청 대기 중');
  if (n('not-asked')) parts.push(epCycleText(d));
  return parts.join(' · ');
}
