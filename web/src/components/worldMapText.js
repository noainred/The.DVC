/**
 * components/worldMapText.js — 지도(WorldMap) 툴팁 · 상세 창의 VM · 알람 문구(순수 — vitest 고정).
 */
import { numOrNull } from '../numOrNull.js';

// 2차 공통 기능 점검 8회차: 연결 끊긴 vCenter(지표 없음)를 'VM - (0 on)' · '위험 0 · 경고 0' 으로 보였다 — 알람이 없다는 거짓이다. 못 읽은 값은 '—'.
export const vmOnText = (m) => { const v = numOrNull(m?.vms); const on = numOrNull(m?.vmsPoweredOn); return v == null ? '—' : `${v} (${on == null ? '—' : on} on)`; };
export const alarmText = (m) => { const c = numOrNull(m?.alarmsCritical); const w = numOrNull(m?.alarmsWarning); return c == null && w == null ? '—' : `위험 ${c ?? '—'} · 경고 ${w ?? '—'}`; };
