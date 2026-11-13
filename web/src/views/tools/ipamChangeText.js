// ipamChangeText.js — IP관리 › IP 변화 페이지 · 대장 '충돌 · MAC 변경' 문구(순수 · v3.1.0, 시안 docs/design/ipam-alerts-mac-dns ② ③).
// 판정(변화 종류 · 알림 결과 · 충돌 의심)은 서버(ipam/changeNotify.js · conflict.js)가 하고 기록 · 행에 실어 보낸다 — 여기는 라벨 · 줄 문구만.

/** 종류(서버 CHANGE_TYPES 와 1:1) — 칩 순서도 이것. */
export const CHANGE_TYPE = Object.freeze({
  conflict: { label: '충돌 의심', tone: 'red' },
  'mac-change': { label: 'MAC 변경', tone: 'amber' },
  'new-ip': { label: '새 미등록 IP', tone: 'blue' },
  'reserved-up': { label: '예약 · 폐기 IP 사용 시작', tone: 'amber' },
  rename: { label: '호스트명 변경', tone: 'purple' },
  'conflict-resolved': { label: '충돌 의심 해소', tone: 'green' },
  baseline: { label: '기준선', tone: 'gray' },
});
export const CHANGE_ORDER = Object.freeze(Object.keys(CHANGE_TYPE));

/** 알림 결과(서버 NOTIFY_STATES 와 1:1). */
export const NOTIFY_TEXT = Object.freeze({
  sent: { text: '보냄', tone: 'green' },
  summary: { text: '요약으로 보냄', tone: 'green', title: '한 번의 스캔에서 묶음 상한을 넘어 요약 한 건만 보냈습니다' },
  failed: { text: '보내지 못함', tone: 'red', title: '채널이 거부했거나 응답하지 않았습니다 — 설정 › 알림의 최근 통지를 보세요' },
  skipped: { text: '보내지 않음', tone: 'gray', title: '켜진 채널이 없거나 같은 알림의 억제 창 안이었습니다' },
  off: { text: '기록만', tone: 'gray', title: '이 종류의 알림 규칙이 꺼져 있습니다(설정 › 알림)' },
  quiet: { text: '기록만', tone: 'gray', title: '알리지 않을 에이전트로 지정된 에이전트의 스캔입니다(설정 › 알림)' },
  excluded: { text: '기록만', tone: 'gray', title: '이 IP 는 관리상태에서 MAC 변경 알림을 제외했습니다' },
  flap: { text: '기록만', tone: 'gray', title: '예전에 본 MAC 으로 되돌아갔습니다(이중화 의심) — 처음 바뀐 때만 알립니다' },
  engine: { text: '알림 엔진', tone: 'blue', title: '상태형 알림 — 설정 › 알림의 현재 발생 중 · 최근 통지가 말합니다' },
  none: { text: '—', tone: '' },
});
export function notifyBadge(state) { return NOTIFY_TEXT[state] || NOTIFY_TEXT.none; }

const SRC = Object.freeze({ dns: '역DNS', mdns: 'mDNS', netbios: 'NetBIOS' });
const STATUS = Object.freeze({ reserved: '예약', deprecated: '폐기' });
const withVendor = (mac, v) => (mac ? `${mac}${v ? `(${v})` : ''}` : '—');

/** 기록 한 줄의 '내용' 칸(순수). */
export function changeDetail(e) {
  if (!e || typeof e !== 'object') return '';
  const svc = Array.isArray(e.services) && e.services.length ? e.services.join(',') : '';
  switch (e.type) {
    case 'mac-change': return `${withVendor(e.from, e.fromVendor)} → ${withVendor(e.to, e.vendor)}${e.flap ? ' · 예전 MAC 으로 되돌아감(이중화 의심)' : ''}`;
    case 'new-ip': return [svc || '응답', e.mac ? withVendor(e.mac, e.vendor) : ''].filter(Boolean).join(' · ');
    case 'reserved-up': return `관리상태 ${STATUS[e.status] || e.status || '—'} — ${svc || '응답'}`;
    case 'rename': return `${SRC[e.src] || e.src || ''} ${e.from || '—'} → ${e.to || '—'}`.trim();
    case 'conflict': return `${e.vm ? `VM ${e.vm} · ` : ''}${e.note || ''}`;
    case 'conflict-resolved': return 'VM 의 MAC 이 다시 응답했거나 VM 의 IP 가 바뀌었습니다';
    case 'baseline': return `대역 ${e.spec || '—'} 첫 완료 스캔 — 이 줄의 새 IP 는 다음 스캔부터 '새 미등록 IP' 로 셉니다`;
    default: return '';
  }
}

/** 대장 행의 MAC 변화 배지 — 충돌 의심이 먼저(서버 r.macConflict), 없으면 최근 MAC 변경(r.macChangedAt). 없으면 null. */
export function macAlertBadge(r) {
  if (r?.macConflict) {
    const c = r.macConflict;
    return { label: '충돌 의심', tone: 'red', title: `이 VM 의 NIC 이 아닌 MAC ${c.mac}${c.vendor ? `(${c.vendor})` : ''} 이 연속 ${c.seen}회 응답했습니다${c.otherVm ? ` — 다른 VM(${c.otherVm}) 의 NIC 입니다` : ''}. 같은 IP 를 두 장비가 쓰거나 VM 의 IP 보고가 오래됐을 수 있습니다` };
  }
  if (r?.macChangedAt) return { label: 'MAC 변경', tone: 'amber', title: `최근 7일 안에 MAC 이 바뀌었습니다 — 직전 ${r.macPrev || '—'}` };
  return null;
}
/** 대장 '충돌 · MAC 변경' 칩에 드는 행인가. */
export function hasMacAlert(r) { return !!(r && (r.macConflict || r.macChangedAt)); }
