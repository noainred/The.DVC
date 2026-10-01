/**
 * loginFailsText.js — 설정 › 로그인 실패 분석 화면 문구(v2.675, 순수 — vitest).
 *
 * 서버(security/loginFails.js)는 vCenter 이벤트를 1시간 조각으로 거슬러 훑고 그 결과를 scan 으로 싣는다(v2.673).
 * v2.673 까지 화면은 scan 을 표시하지 않아, 실패가 상한(rowsMax)을 넘어 잘려도 '총 실패' 가 전부인 것처럼 보였다.
 * 숫자(상한·기간)는 서버가 준 값만 쓴다(문구에 박지 않는다 — v2.509 규약). 백틱·별표 금지(BoldText 규약).
 */
import { numOrNull } from '../numOrNull.js';

const nf = new Intl.NumberFormat('ko-KR');
const num = numOrNull;   // 읽지 못한 값은 0 이 아니라 null(웹 numOrNull 하나 — v2.618 ARCH-6 사본 금지)

/**
 * 분석 범위·잘림 안내. scan 이 없으면(구버전 서버) 빈 문자열.
 * @returns {{text:string, warn:string}} warn 은 잘림·DB 못 읽음 같은 '집계가 전부가 아니다' 안내(없으면 '')
 */
export function scanNote(scan) {
  if (!scan || typeof scan !== 'object') return { text: '', warn: '' };
  if (scan.source === 'unavailable') {
    return { text: '', warn: 'vCenter 로그 DB 를 읽지 못해 vCenter 로그인 실패는 세지 않았습니다(포탈·게스트 OS 실패만 집계).' };
  }
  const days = num(scan.days);
  const chunks = num(scan.chunks);
  const cand = num(scan.candidates);
  const ms = num(scan.ms);
  const parts = [];
  if (days != null) parts.push(`vCenter 이벤트 ${nf.format(days)}일치`);
  if (chunks != null) parts.push(`1시간 조각 ${nf.format(chunks)}개`);
  if (cand != null) parts.push(`후보 ${nf.format(cand)}건`);
  if (ms != null) parts.push(`분석 ${nf.format(ms)}ms`);
  const max = num(scan.rowsMax);
  const warn = scan.truncated
    ? `실패가 많아 최근 ${max != null ? `${nf.format(max)}건` : '상한'}까지만 셌습니다 — 그보다 오래된 vCenter 실패는 집계에서 빠졌습니다(분석 기간을 줄이면 전부 볼 수 있습니다).`
    : '';
  return { text: parts.join(' · '), warn };
}

/** 분석 시각 — 서버 응답의 generatedAt(epoch ms). 화면은 같은 조건의 결과를 서버가 잠시 기억하므로 '언제 분석한 값인가' 를 밝힌다. */
export function analyzedAtText(generatedAt, nowMs = Date.now()) {
  const t = num(generatedAt);
  if (t == null || t <= 0) return '';
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  const ago = sec < 60 ? `${sec}초 전` : sec < 3600 ? `${Math.round(sec / 60)}분 전` : `${Math.round(sec / 3600)}시간 전`;
  return `분석 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} (${ago})`;
}

/** 분석 결과를 다시 부르는 간격 — 무거운 전 범위 분석이라 상태(30초)보다 길게 둔다. */
export const ANALYSIS_REFRESH_MS = 5 * 60_000;
