/**
 * components/worldMapText.js — 지도(WorldMap) 툴팁 · 상세 창의 VM · 알람 문구(순수 — vitest 고정).
 */
import { numOrNull } from '../numOrNull.js';
import { alarmsUnknown } from '../views/restFallbackText.js';

// 2차 공통 기능 점검 8회차: 연결 끊긴 vCenter(지표 없음)를 'VM - (0 on)' · '위험 0 · 경고 0' 으로 보였다 — 알람이 없다는 거짓이다. 못 읽은 값은 '—'.
export const vmOnText = (m) => { const v = numOrNull(m?.vms); const on = numOrNull(m?.vmsPoweredOn); return v == null ? '—' : `${v} (${on == null ? '—' : on} on)`; };
// 54회차(다른 세션 8회차 반증 — 재현): REST 폴백 vCenter 는 경보를 조회하지 않는다 — 서버 롤업의 0 을 '위험 0 · 경고 0' 으로 보이지 않는다(카드 · 표와 같은 판정 alarmsUnknown)
export const alarmText = (m, site = null) => { if (site && alarmsUnknown(site)) return '—(경보 미조회)'; const c = numOrNull(m?.alarmsCritical); const w = numOrNull(m?.alarmsWarning); return c == null && w == null ? '—' : `위험 ${c ?? '—'} · 경고 ${w ?? '—'}`; };
