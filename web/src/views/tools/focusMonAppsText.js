/**
 * views/tools/focusMonAppsText.js — 서버 집중 모니터링 ‘앱 단위 묶음’(v3.14.0 ⑮ — 시안 Apps)의 순수 함수(문구 · 색).
 * 묶음은 서버가 만든다(rates.appGroups) — 여기는 글자 · 색 자리만. 값이 없으면 ‘—’(0 아님) · 문구에 백틱을 쓰지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { DASH } from './focusMonText.js';

const n = numOrNull;
/** 범주 색 5개(시안 Apps — dataviz 검증기로 어두운 바탕 #141b2d 에서 확인) + 나머지 회색. 색은 서버가 고른 위 5개의 **이름 순** 자리를 따른다. */
export const APP_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']);
export const APP_REST_COLOR = '#5b6b86';
export const APP_BY_TEXT = Object.freeze({ sv: '서비스(systemd)', cm: '프로그램 이름' });
/** 묶음 이름의 색(위 5개면 그 자리 색 · 아니면 나머지 회색). */
export function appColor(key, seriesKeys) { const i = (seriesKeys || []).indexOf(key); return i >= 0 ? APP_COLORS[i % APP_COLORS.length] : APP_REST_COLOR; }
/** 디스크 읽기 · 쓰기 글 — 읽은 프로세스가 없으면 ‘—’ · 일부만이면 ‘(부분)’. */
export function appIoText(a) {
  if (!a || a.io === 'none' || n(a.rb) == null) return DASH;
  const t = `${fmt(a.rb)} · ${fmt(a.wb)} MB/s`;
  return a.io === 'part' ? `${t}(부분)` : t;
}
const fmt = (v) => { const x = n(v); return x == null ? DASH : x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10); };
/** 디스크 칸의 풀이(마우스를 올리면). */
export function appIoTitle(a) {
  if (!a || a.io === 'none') return '이 묶음의 프로세스는 /proc/<pid>/io 를 읽지 못했습니다(다른 계정 · root 가 아님) — 0 이 아니라 모름입니다';
  if (a.io === 'part') return '이 묶음의 프로세스 가운데 일부만 읽었습니다(수집 계정 · root 만) — 읽은 것만 더한 값입니다';
  return '이 묶음의 프로세스를 모두 읽었습니다';
}
/** 메모리(MB) 글. */
export function appMemText(mb) { const x = n(mb); if (x == null) return DASH; return x >= 1024 ? `${Math.round((x / 1024) * 10) / 10} GB` : `${Math.round(x)} MB`; }
/** 계정 글 — 가장 많은 계정 + 나머지 수. */
export function appUserText(a) { if (!a?.u) return DASH; return a.un > 1 ? `${a.u} 외 ${a.un - 1}` : a.u; }
/** 펼침 아래 줄 — 상위 30 밖의 수. */
export function appMembersNote(a, shown) {
  const rest = (n(a?.n) ?? 0) - (shown ?? 0);
  return rest > 0 ? `프로세스 상위 30 밖에 ${rest}개가 더 있습니다(합에는 모두 들어 있습니다).` : '';
}
